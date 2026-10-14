// CPA 凭据调度（routing）的读改写。
//
// CPA 面板把这组配置放在 chapters.networks，字段与 yaml 路径的对应关系为：
//   路由策略      routing.strategy              round-robin / weighted-round-robin / fill-first / smart / pace
//   会话粘性路由  routing.session-affinity      bool
//   会话粘性 TTL  routing.session-affinity-ttl  秒数字字符串
//
// 写入走 PATCH /v0/management/config，且**只提交 routing 子树**。
// 绝不能复用 config-yaml 的 PUT：那条路径整体替换 YAML，一次手滑就会抹掉
// api-keys / claude / vertex 等全部 49 个配置键。
import { requestCpaJson } from './management.mjs';

export const ROUTING_STRATEGIES = [
  { value: 'round-robin', label: '轮询 (Round Robin)' },
  { value: 'weighted-round-robin', label: '加权轮询 (Weighted Round Robin)' },
  { value: 'fill-first', label: '填充优先 (Fill First)' },
  { value: 'smart', label: '临期优先 (Smart Quota)' },
  { value: 'pace', label: '步调均衡 (Pace Quota)' }
];

export const DEFAULT_ROUTING_STRATEGY = 'round-robin';

// 策略别名归一化：对齐 CPA 后端 normalizeRoutingStrategy 与 CPAMC kB(e) 规则，
// 接受常见缩写与别名，返回规范策略值，非法值返回 null。
export function normalizeRoutingStrategy(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case '':
    case 'round-robin':
    case 'roundrobin':
    case 'rr':
      return 'round-robin';
    case 'weighted-round-robin':
    case 'weightedroundrobin':
    case 'wrr':
      return 'weighted-round-robin';
    case 'fill-first':
    case 'fillfirst':
    case 'ff':
      return 'fill-first';
    case 'smart':
    case 'smart-routing':
      return 'smart';
    case 'pace':
    case 'pace-routing':
      return 'pace';
    default:
      return null;
  }
}

// 生产当前配置里只有 { strategy }，粘性字段是缺省的。读的时候按缺省补齐，
// 写的时候只提交调用方真正改动的字段，避免无意清空另一项。
export function isValidStrategy(value) {
  return normalizeRoutingStrategy(value) !== null;
}

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

// TTL 只接受秒数字或空串。空串在 CPA 面板里的语义是「清掉这个键」，
// 而非写一个 0 —— 所以不能把空串静默转成 0。
export function normalizeTtl(value) {
  if (value === '' || value === null || value === undefined) return '';
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return null;
  const seconds = Number.parseInt(text, 10);
  if (!Number.isSafeInteger(seconds) || seconds < 0) return null;
  return String(seconds);
}

// CPA v7.3.x 没有 GET /v0/management/routing（实测 404），只有 /routing/strategy。
// 会话粘性与 TTL 只在 /config 的 routing 子树里，所以整棵子树从 /config 读。
export async function readRoutingConfig() {
  const config = await requestCpaJson('GET', '/config');
  const routing = config?.routing && typeof config.routing === 'object' ? config.routing : {};
  const normalized = normalizeRoutingStrategy(routing.strategy);
  const strategy = normalized || DEFAULT_ROUTING_STRATEGY;
  const ttlRaw = routing['session-affinity-ttl'] ?? routing.sessionAffinityTTL ?? routing.sessionAffinityTtl ?? '';
  const ttl = normalizeTtl(ttlRaw) ?? '';
  return {
    strategy,
    session_affinity: routing['session-affinity'] === true,
    session_affinity_ttl: ttl
  };
}

// 只接受三个白名单字段，其余键一律拒绝。
// 没有这道闸，一个透传任意 JSON 的接口就等于把整份 config 当 routing 提交。
export function validateRoutingPatch(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw badRequest('路由配置必须是对象');
  }
  const allowed = new Set(['strategy', 'session_affinity', 'session_affinity_ttl']);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw badRequest(`不支持的路由字段：${key}`);
  }
  if (!Object.keys(payload).length) throw badRequest('没有需要保存的路由字段');

  const patch = {};
  if (payload.strategy !== undefined) {
    const normalized = normalizeRoutingStrategy(payload.strategy);
    if (!normalized) {
      throw badRequest(`路由策略必须是 ${ROUTING_STRATEGIES.map(s => s.value).join(' / ')} 之一`);
    }
    patch.strategy = normalized;
  }
  if (payload.session_affinity !== undefined) {
    if (typeof payload.session_affinity !== 'boolean') throw badRequest('会话粘性路由必须是布尔值');
    patch['session-affinity'] = payload.session_affinity;
  }
  if (payload.session_affinity_ttl !== undefined) {
    const ttl = normalizeTtl(payload.session_affinity_ttl);
    if (ttl === null) throw badRequest('会话粘性 TTL 必须是非负整数秒，或留空表示关闭');
    patch['session-affinity-ttl'] = ttl;
  }
  return patch;
}

export async function writeRoutingConfig(payload) {
  const patch = validateRoutingPatch(payload);
  // 只带 routing 这一个键，其余配置键 CPA 侧原样保留
  await requestCpaJson('PATCH', '/config', { routing: patch });

  // 写后回读校验：PATCH 返回 200 不等于值真的落到了配置里。
  // 不做这一步就会出现「界面显示已保存，实际没生效」。
  const after = await readRoutingConfig();
  for (const [key, expected] of Object.entries(patch)) {
    if (key === 'session-affinity-ttl') {
      // 空串表示清空该键，回读也应当是空
      if ((after.session_affinity_ttl || '') !== (expected || '')) {
        throw new Error(`路由配置写入校验失败：session-affinity-ttl 期望「${expected}」，实际「${after.session_affinity_ttl}」`);
      }
      continue;
    }
    const actual = key === 'strategy' ? after.strategy : after.session_affinity;
    if (actual !== expected) {
      throw new Error(`路由配置写入校验失败：${key} 期望「${expected}」，实际「${actual}」`);
    }
  }
  return after;
}

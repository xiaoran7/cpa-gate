import {
  quotaDb,
  stmtProviderRegistryAll,
  stmtProviderRegistryByKey,
  stmtProviderRegistryUpsert,
  stmtProviderRegistryDelete
} from '../db/sqlite.mjs';

// -------------------------------------------------------------
// 提供商注册表：AI 提供商身份的唯一真相源。
//
// 存在以前，provider 推断硬编码散落在 11 个文件 46 处，口径互不一致
// （同一家提供商在不同模块叫 codex / openai / 'OpenAI Codex' / 'Codex 官方'），
// 更严重的是把真实生产账号的 auth_index 写死在源码里做特判——
// 账号重登后哈希即变，特判立刻失效，账号随即掉进「未知上游」。
//
// 现在所有推断统一走 inferProvider()，数据来自 provider_registry 表：
//   builtin  — 首次播种的内置规则，可被覆盖，删除后重启会重新播种
//   cpa      — CPA 同步下发时自动 upsert，上游新增提供商零改代码
//   manual   — 管理台人工登记
//
// 三条不可动的口径约束：
// 1. sort_order 显式排序，绝不按 provider_key 字母序——匹配是「先中先得」，
//    字母序会让 opencode 抢先匹配到本属于 codex 的模型。
// 2. auth_patterns 只放通用前缀（如 step），绝不放具体账号的 auth_index——
//    那是运行数据，不是代码；账号级映射由 upstream_auth_baselines 提供。
// 3. 匹配优先级固定 auth_patterns 先于 model_patterns，与旧实现一致。
//
// 关于 label：旧代码两套命名（audit-logs 用 'StepFun 阶跃星辰'，
// status-summary 用 '阶跃星辰 StepFun'）。单一真相源只能有一个名字，
// 此处统一取 audit-logs 的写法——它是模型维度统计的展示面，
// 用户看得最多。status-summary 侧随之统一，属本次有意的口径收敛。
// -------------------------------------------------------------

// 内置播种规则。导出以便测试重放内置口径（开发机上可能残留旧版播种结果）。
//
// anchor 约定（与旧实现的 startsWith/includes 语义逐条对齐，防口径漂移）：
//   '^'  前缀锚定 —— 对应旧的 m.startsWith(...)
//   ''   包含匹配 —— 对应旧的 m.includes(...)
// codex 一组必须前缀锚定：否则非锚定的 'gpt-' 会把 'opencode-zen/gpt-5'
// 抢走，而旧实现里这个模型归 OpenCode Zen。
export const INITIAL_PROVIDER_REGISTRY = [
  {
    provider_key: 'antigravity',
    label: '反重力 Antigravity',
    // 注意：antigravity 渠道实际跑的是 gemini 系列模型，账号维度由 CPA 的
    // provider 字段给出；这里只兜住「模型名本身含 antigravity」的情形。
    model_patterns: [{ p: 'antigravity', anchor: '^' }],
    auth_patterns: ['antigravity'],
    sort_order: 10
  },
  {
    provider_key: 'codex',
    label: 'OpenAI Codex',
    model_patterns: [
      { p: 'gpt-', anchor: '^' },
      { p: 'chatgpt', anchor: '' },
      { p: 'o1', anchor: '^' },
      { p: 'o3', anchor: '^' },
      { p: 'o4', anchor: '^' },
      { p: 'text-embedding', anchor: '^' }
    ],
    auth_patterns: ['codex', 'openai'],
    sort_order: 20
  },
  {
    provider_key: 'gemini',
    label: 'Google Gemini',
    model_patterns: [{ p: 'gemini', anchor: '' }],
    auth_patterns: ['gemini'],
    sort_order: 30
  },
  {
    provider_key: 'claude',
    label: 'Anthropic Claude',
    model_patterns: [{ p: 'claude', anchor: '' }, { p: 'anthropic', anchor: '' }],
    auth_patterns: ['claude', 'anthropic'],
    sort_order: 40
  },
  {
    provider_key: 'stepfun',
    label: 'StepFun 阶跃星辰',
    model_patterns: [{ p: 'step', anchor: '' }, { p: 'stepfun', anchor: '' }],
    auth_patterns: ['step', 'stepfun'],
    sort_order: 50
  },
  {
    provider_key: 'opencode',
    label: 'OpenCode Zen',
    // '-free' 是历史口径：免费额度模型（longcat-*-free / mimo-*-free 等）
    // 一向归到 OpenCode Zen。收拢时必须原样保留，否则计费与看板静默改口径。
    // 非锚定，所以能命中 'longcat-2.5-preview-free' 中段的 -free。
    model_patterns: [{ p: 'opencode', anchor: '' }, { p: '-free', anchor: '' }],
    auth_patterns: ['opencode'],
    sort_order: 60
  },
  {
    provider_key: 'stealth',
    // label 用原名，不译不美化：stealth 是上游自己的命名，Gate 不知道它的
    // 中文名，编一个反而是假信息。生产有 8 个账号跑 stealth/space-bunny-alpha，
    // 累计 1 万多次请求，未登记时它们会掉进「其他上游」并显示成裸哈希。
    label: 'stealth',
    model_patterns: [{ p: 'stealth/', anchor: '' }],
    auth_patterns: ['stealth'],
    sort_order: 65
  },
  {
    provider_key: 'workbuddy-cn',
    label: 'WorkBuddy (CodeBuddy)',
    model_patterns: [
      { p: 'workbuddy-cn', anchor: '' },
      { p: 'codebuddy', anchor: '' }
    ],
    auth_patterns: ['workbuddy-cn', 'codebuddy'],
    sort_order: 68
  },
  {
    provider_key: 'workbuddy',
    label: '腾讯 WorkBuddy',
    model_patterns: [
      { p: 'workbuddy', anchor: '' },
      { p: 'copilot.tencent', anchor: '' }
    ],
    auth_patterns: ['workbuddy'],
    sort_order: 69
  },
  {
    provider_key: 'deepseek',
    label: 'DeepSeek',
    model_patterns: [{ p: 'deepseek', anchor: '' }],
    auth_patterns: ['deepseek'],
    sort_order: 70
  },
  {
    provider_key: 'openrouter',
    label: 'OpenRouter',
    model_patterns: [{ p: 'openrouter', anchor: '' }],
    auth_patterns: ['openrouter'],
    sort_order: 80
  },
  {
    provider_key: 'qwen',
    label: 'Qwen 通义千问',
    model_patterns: [{ p: 'qwen', anchor: '' }, { p: 'qianwen', anchor: '' }],
    auth_patterns: ['qwen'],
    sort_order: 90
  },
  {
    provider_key: 'moonshot',
    label: 'Moonshot Kimi',
    model_patterns: [{ p: 'kimi', anchor: '' }, { p: 'moonshot', anchor: '' }],
    auth_patterns: ['kimi', 'moonshot'],
    sort_order: 100
  },
  {
    provider_key: 'zhipu',
    label: 'Zhipu GLM',
    model_patterns: [{ p: 'glm', anchor: '' }, { p: 'zhipu', anchor: '' }],
    auth_patterns: ['zhipu'],
    sort_order: 110
  }
];

// 兜底文案集中在此，避免每个调用方各写一份「其他/未知上游」
export const UNKNOWN_PROVIDER_KEY = 'other';
export const UNKNOWN_PROVIDER_LABEL = '其他上游';
export const UNREGISTERED_PROVIDER_LABEL = '未登记提供商';
export const OTHER_MODEL_LABEL = '其他模型';

// 内存中编译后的规则，避免每次推断都碰 DB
let compiledRegistry = [];

function compilePattern(raw) {
  const p = String(raw || '').trim();
  if (!p) return null;
  // anchor 是元字符，必须保留在正则里，不能一起被转义成字面量。
  // 其余字符按字面量转义；若转义后仍不是合法正则（用户手写了正则语法），
  // 才退回按原样编译，与 pricing.mjs 同口径。
  const anchor = p.startsWith('^') ? '^' : '';
  const body = anchor ? p.slice(1) : p;
  if (!body) return null;
  const escaped = body.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    return new RegExp(anchor + escaped, 'i');
  } catch {
    try { return new RegExp(p, 'i'); } catch { return null; }
  }
}

function parsePatternList(raw) {
  let list = [];
  try { list = JSON.parse(raw || '[]'); } catch { list = []; }
  if (!Array.isArray(list)) return [];
  return list
    .map(item => {
      if (typeof item === 'string') return { p: item.trim(), anchor: '' };
      if (item && typeof item === 'object') {
        return { p: String(item.p ?? item.pattern ?? item.value ?? '').trim(), anchor: item.anchor === '^' ? '^' : '' };
      }
      return null;
    })
    .filter(item => item && item.p)
    .map(item => ({ ...item, regex: compilePattern(item.anchor + item.p) }))
    .filter(item => item.regex);
}

function toStoredPatternList(raw, defaultAnchor = '') {
  const list = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === 'string' && item.trim()) list.push({ p: item.trim(), anchor: defaultAnchor });
      else if (item && typeof item === 'object') {
        const p = String(item.p ?? item.pattern ?? item.value ?? '').trim();
        if (p) list.push({ p, anchor: item.anchor === '^' ? '^' : '' });
      }
    }
  } else if (typeof raw === 'string' && raw.trim()) {
    // 允许直接粘一段 JSON，或逗号分隔的纯文本
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return toStoredPatternList(parsed, defaultAnchor);
    } catch { /* 走逗号分隔 */ }
    for (const p of raw.split(',').map(v => v.trim()).filter(Boolean)) list.push({ p, anchor: defaultAnchor });
  }
  return list;
}

export function reloadProviderRegistry() {
  let rows = [];
  try {
    rows = stmtProviderRegistryAll.all();
  } catch {
    rows = [];
  }
  compiledRegistry = rows
    .filter(r => Number(r.enabled) !== 0)
    .map(r => ({
      provider_key: r.provider_key,
      label: r.label,
      source: r.source,
      sort_order: Number(r.sort_order) || 100,
      modelRegexes: parsePatternList(r.model_patterns),
      authRegexes: parsePatternList(r.auth_patterns)
    }));
  return compiledRegistry;
}

export function initProviderRegistry() {
  let existing = [];
  try {
    existing = stmtProviderRegistryAll.all();
  } catch (e) {
    // 表不存在（旧库首次升级）：不应阻塞启动，让后续 reload 自然得到空规则
    console.error('[provider-registry] 读取注册表失败:', e.message);
    existing = [];
  }
  // 仅在表空时播种，与 initModelPrices() 同口径：用户改过的规则永不被覆盖
  if (existing.length === 0) {
    try {
      const tx = quotaDb.transaction(() => {
        for (const p of INITIAL_PROVIDER_REGISTRY) {
          stmtProviderRegistryUpsert.run({
            provider_key: p.provider_key,
            label: p.label,
            model_patterns: JSON.stringify(p.model_patterns),
            auth_patterns: JSON.stringify(p.auth_patterns),
            source: 'builtin',
            enabled: 1,
            sort_order: p.sort_order
          });
        }
      });
      tx();
    } catch (e) {
      console.error('[provider-registry] 内置规则播种失败:', e.message);
    }
  } else {
    // 增量补种：对于后续版本在 INITIAL_PROVIDER_REGISTRY 新增的 builtin 提供商（如 workbuddy / workbuddy-cn），
    // 若当前数据库中尚不存在对应 provider_key，或者该 key 仅存在 CPA 自动生成的无 pattern 空壳占位，
    // 自动补种/升级为官方内置权威规则，且绝不覆盖用户已有的 manual 规则或已有 pattern 的自定义配置
    try {
      const existingMap = new Map(existing.map(r => [r.provider_key, r]));
      const candidatesToSeed = INITIAL_PROVIDER_REGISTRY.filter(p => {
        const current = existingMap.get(p.provider_key);
        if (!current) return true;
        const isCpaSkeleton = current.source === 'cpa'
          && (!current.model_patterns || current.model_patterns === '[]')
          && (!current.auth_patterns || current.auth_patterns === '[]');
        return isCpaSkeleton;
      });

      if (candidatesToSeed.length > 0) {
        const tx = quotaDb.transaction(() => {
          for (const p of candidatesToSeed) {
            stmtProviderRegistryUpsert.run({
              provider_key: p.provider_key,
              label: p.label,
              model_patterns: JSON.stringify(p.model_patterns),
              auth_patterns: JSON.stringify(p.auth_patterns),
              source: 'builtin',
              enabled: 1,
              sort_order: p.sort_order
            });
          }
        });
        tx();
      }
    } catch (e) {
      console.error('[provider-registry] 增量内置规则补种失败:', e.message);
    }
  }
  return reloadProviderRegistry();
}

/**
 * 统一推断入口。按 auth_patterns → model_patterns 顺序，组内按 sort_order。
 *
 * 无匹配时返回 key 为空、label 为空，绝不猜：宁可显示「未登记」让人来补，
 * 也不要制造一个看似合理其实错误的归属——错误认知比缺失更有害。
 */
export function inferProvider({ model = '', authIndex = '' } = {}) {
  const modelStr = String(model || '').trim().toLowerCase();
  const authStr = String(authIndex || '').trim().toLowerCase();

  for (const entry of compiledRegistry) {
    for (const re of entry.authRegexes) {
      if (authStr && re.regex.test(authStr)) {
        return { key: entry.provider_key, label: entry.label, matched_by: 'auth', source: entry.source };
      }
    }
  }
  for (const entry of compiledRegistry) {
    for (const re of entry.modelRegexes) {
      if (modelStr && re.regex.test(modelStr)) {
        return { key: entry.provider_key, label: entry.label, matched_by: 'model', source: entry.source };
      }
    }
  }
  return { key: '', label: '', matched_by: 'none', source: '' };
}

/**
 * 按模型名推断，用于模型维度的统计（无 auth_index 可用时）。
 * 未命中返回 '其他模型'——保持与旧 inferModelProvider 完全一致的口径。
 */
export function inferModelProviderLabel(model) {
  const r = inferProvider({ model });
  return r.label || OTHER_MODEL_LABEL;
}

/** 供展示层取中文名；未登记返回空串，由调用方决定兜底文案 */
export function getProviderLabel(key) {
  if (!key) return '';
  const k = String(key).toLowerCase();
  const hit = compiledRegistry.find(e => e.provider_key === k);
  return hit ? hit.label : '';
}

/**
 * 服务状态分组用的展示名。
 *
 * 两个非注册表键有固定文案，与旧 PROVIDER_GROUP_LABELS 逐条对齐：
 *   unknown        未知上游 —— provider 缺失，连上游都没告诉我们是谁
 *   other          其他上游 —— 上游知道是谁，但注册表没登记
 * 其余键查注册表；查不到再用上游原始名兜底。
 */
export function getProviderGroupLabel(key, fallbackName = '') {
  const k = String(key || '').toLowerCase();
  if (!k || k === 'unknown') return '未知上游';
  if (k === 'other') return '其他上游';
  const hit = compiledRegistry.find(e => e.provider_key === k);
  if (hit) return hit.label;
  return String(fallbackName || '').trim() || UNKNOWN_PROVIDER_LABEL;
}

export function listProviderRegistry() {
  try {
    return stmtProviderRegistryAll.all().map(r => ({
      provider_key: r.provider_key,
      label: r.label,
      model_patterns: parsePatternList(r.model_patterns).map(x => ({ p: x.p, anchor: x.anchor })),
      auth_patterns: parsePatternList(r.auth_patterns).map(x => ({ p: x.p, anchor: x.anchor })),
      source: r.source,
      enabled: Number(r.enabled) !== 0,
      sort_order: Number(r.sort_order) || 100,
      created_at: r.created_at,
      updated_at: r.updated_at
    }));
  } catch {
    return [];
  }
}

export function upsertProviderRegistry(payload = {}) {
  const key = String(payload.provider_key || '').trim().toLowerCase();
  const label = String(payload.label || '').trim();
  if (!key || !label) {
    throw Object.assign(new Error('provider_key 与 label 均为必填项'), { statusCode: 400 });
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(key)) {
    throw Object.assign(new Error('provider_key 只能包含小写字母、数字、下划线与连字符'), { statusCode: 400 });
  }

  const existing = stmtProviderRegistryByKey.get(key);
  const authPatterns = toStoredPatternList(payload.auth_patterns, '^');
  // 守卫：禁止把具体账号的 auth_index 当 pattern 写进注册表。
  // 形如账号哈希的长串十六进制一律拒绝——那正是曾经泄露进源码的东西。
  for (const p of authPatterns) {
    if (/^[0-9a-f]{12,}$/i.test(p.p)) {
      throw Object.assign(
        new Error(`auth_patterns 不接受账号身份哈希 "${p.p}"：账号级映射请交给 CPA 同步或 upstream_auth_baselines`),
        { statusCode: 400 }
      );
    }
  }

  stmtProviderRegistryUpsert.run({
    provider_key: key,
    label,
    model_patterns: JSON.stringify(toStoredPatternList(payload.model_patterns)),
    auth_patterns: JSON.stringify(authPatterns),
    source: existing ? (String(payload.source || existing.source)) : String(payload.source || 'manual'),
    enabled: payload.enabled === false ? 0 : 1,
    sort_order: Number(payload.sort_order) || (existing ? (Number(existing.sort_order) || 100) : 500)
  });
  reloadProviderRegistry();
  return { success: true, provider_key: key };
}

export function deleteProviderRegistry(key) {
  const k = String(key || '').trim().toLowerCase();
  const existing = stmtProviderRegistryByKey.get(k);
  if (!existing) {
    throw Object.assign(new Error('该提供商不存在'), { statusCode: 404 });
  }
  // 内置项删掉也会在下次重启被重新播种，给了删除按钮只会误导用户
  if (existing.source === 'builtin') {
    throw Object.assign(new Error('内置提供商不可删除，可修改其匹配规则'), { statusCode: 400 });
  }
  stmtProviderRegistryDelete.run(k);
  reloadProviderRegistry();
  return { success: true, provider_key: k };
}

/**
 * CPA 同步成功后调用：把 CPA 下发的 provider 名登记进注册表，
 * 让上游新增提供商时无需改一行代码。
 * 只登记键与展示名，并以其自身名作为 auth 前缀——
 * CPA 直连账号的 auth_index 由 CPA 分配，不是这个 provider 名，
 * 所以这里的 auth_patterns 不参与账号匹配，仅作身份标记。
 */
/**
 * CPA 会在 auth-files 里吐出一些不是「AI 提供商」的 type 值（实测出现过
 * 字面量 'meta'，无流水、无 baseline、无配额快照）。这类值登记进注册表只会
 * 把管理台列表搅乱，且对推断毫无贡献——没有 pattern 就永远匹配不到。
 * 因此 CPA 通道只接受像样的提供商名，其余一律不登记。
 */
const CPA_NON_PROVIDER_TYPES = new Set([
  'meta', 'unknown', 'other', 'none', 'null', 'undefined', 'api_key', 'apikey',
  'oauth', 'token', 'file', 'auth', 'credential', 'credentials', 'test', 'default'
]);

/**
 * 判断一个上游 provider 值是不是「像样的 AI 提供商」。
 * 注册表写入与服务状态分组必须共用这一把尺子：CPA 侧混进 auth-files 的
 * 非提供商 type（实测有 label 为 meta 的凭证文件，disabled、无流水、无 baseline）
 * 既不能登记进注册表，也不能在看板上单独占一个组——否则用户会看到一个
 * 名为「meta」的假提供商，误以为上游接了什么新服务。
 */
export function isCpaProviderKey(providerRaw) {
  const key = String(providerRaw || '').trim().toLowerCase();
  if (!key || CPA_NON_PROVIDER_TYPES.has(key)) return false;
  // 允许 Unicode 字母数字开头：支持各种语言字符的 provider 名称（如「某某中转」），
  // 早期只认 ASCII 的正则会把它误判成非提供商，导致账号掉进「其他上游」。
  return /^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u.test(key);
}

export function registerCpaProvider(providerRaw, labelFallback = '') {
  if (!isCpaProviderKey(providerRaw)) return null;
  const key = String(providerRaw || '').trim().toLowerCase();

  const existing = stmtProviderRegistryByKey.get(key);
  if (existing) {
    // 已登记则只保证启用，不覆盖用户可能改过的 label 与 pattern
    if (Number(existing.enabled) === 0) {
      stmtProviderRegistryUpsert.run({
        provider_key: key,
        label: existing.label,
        model_patterns: existing.model_patterns,
        auth_patterns: existing.auth_patterns,
        source: existing.source,
        enabled: 1,
        sort_order: Number(existing.sort_order) || 100
      });
      reloadProviderRegistry();
    }
    return { provider_key: key, created: false };
  }

  stmtProviderRegistryUpsert.run({
    provider_key: key,
    label: String(labelFallback || '').trim() || key,
    model_patterns: JSON.stringify([]),
    auth_patterns: JSON.stringify([]),
    source: 'cpa',
    enabled: 1,
    sort_order: 500
  });
  reloadProviderRegistry();
  return { provider_key: key, created: true };
}

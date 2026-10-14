import crypto from 'crypto';

export const UPSTREAM_FAILURE_THRESHOLD = Number(process.env.GATE_UPSTREAM_FAILURE_THRESHOLD || process.env.CPA_UPSTREAM_FAILURE_THRESHOLD || 5);
export const UPSTREAM_COOLDOWN_MS = Number(process.env.GATE_UPSTREAM_COOLDOWN_MS || process.env.CPA_UPSTREAM_COOLDOWN_MS || 15000);

export const upstreamState = new Map();
export const metrics = new Map();

export function metric(name, labels = {}, value = 1) {
  const key = `${name}{${Object.entries(labels).sort().map(([k, v]) => `${k}="${String(v).replace(/[^a-zA-Z0-9_.:-]/g, '_')}"`).join(',')}}`;
  metrics.set(key, (metrics.get(key) || 0) + value);
  // 兼容别名：旧 cpa_guard_* 指标并行输出一个版本，便于外部抓取平滑切换
  if (name.startsWith('gate_')) {
    const aliasKey = `cpa_guard_${name.slice(5)}{${Object.entries(labels).sort().map(([k, v]) => `${k}="${String(v).replace(/[^a-zA-Z0-9_.:-]/g, '_')}"`).join(',')}}`;
    metrics.set(aliasKey, (metrics.get(aliasKey) || 0) + value);
  }
}

export function upstreamAvailable(port) {
  const state = upstreamState.get(port) || { failures: 0, openedAt: 0 };
  if (state.openedAt && Date.now() - state.openedAt < UPSTREAM_COOLDOWN_MS) return false;
  if (state.openedAt) { state.openedAt = 0; state.failures = 0; upstreamState.set(port, state); }
  return true;
}

export function markUpstreamFailure(port) {
  const state = upstreamState.get(port) || { failures: 0, openedAt: 0 };
  state.failures += 1;
  if (state.failures >= UPSTREAM_FAILURE_THRESHOLD) state.openedAt = Date.now();
  upstreamState.set(port, state);
  metric('gate_upstream_failures_total', { port });
}

export function markUpstreamSuccess(port) {
  upstreamState.set(port, { failures: 0, openedAt: 0 });
}

// 30 秒 Negative Cache，防止同一 payload 短时间内被客户端（如 ZCode 10/10 重试）无限放大轰炸
export const NEGATIVE_CACHE_TTL_MS = 30000;
export const negativeCache = new Map(); // key: sha256, value: expireTimestamp

export function cleanExpiredNegativeCache() {
  const now = Date.now();
  for (const [key, expireTime] of negativeCache.entries()) {
    if (now > expireTime) {
      negativeCache.delete(key);
    }
  }
}
setInterval(cleanExpiredNegativeCache, 15000).unref();

export function computePayloadFingerprint(rawBuf) {
  return crypto.createHash('sha256').update(rawBuf).digest('hex');
}

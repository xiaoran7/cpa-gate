// CPA's runtime auth status is authoritative for whether a quota can be used.

// 冷却原因分类。CPA 的 cooldowns[].reason 是固定 slug 而非自由文本，这里按同一套
// 编码映射为中文；未识别的 slug 归为「其他」，不猜测语义。
const COOLDOWN_REASON_LABELS = {
  quota: '额度限制',
  credential_quota: '凭证额度限制',
  cloudflare_challenge: 'Cloudflare 验证',
  invalid_grant: '授权无效',
  unauthorized: '未获授权',
  payment_required: '访问受限',
  not_found: '资源未找到',
  model_not_supported: '模型不受支持',
  transient_error: '上游暂时出错'
};

const COOLDOWN_SCOPES = new Set(['model', 'credential']);

// CPA 观察冷却的时点；用它与 remaining_seconds 合成实际剩余，避免把快照当成实时值。
let cooldownObservedAt = null;

export function setCooldownObservedAt(value) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) cooldownObservedAt = n;
  else if (value instanceof Date && !Number.isNaN(value.getTime())) cooldownObservedAt = value.getTime();
  else if (typeof value === 'string' && value.trim()) {
    const t = Date.parse(value);
    if (Number.isFinite(t)) cooldownObservedAt = t;
  } else {
    cooldownObservedAt = null;
  }
  return cooldownObservedAt;
}

function toInt(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

/**
 * 归一单条 CPA 冷却记录，字段契约：
 *   { scope: 'model'|'credential', model_key?, reason, retry_at (ISO8601), remaining_seconds, backoff_level?, http_status? }
 * 非法记录返回 null——宁可少展示，不可臆造。
 */
function normalizeCooldownRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const scope = String(raw.scope || '').trim();
  if (!COOLDOWN_SCOPES.has(scope)) return null;

  const modelKey = typeof raw.model_key === 'string' ? raw.model_key.trim() : '';
  if (scope === 'model' && !modelKey) return null;

  const remainingSeconds = toInt(raw.remaining_seconds);
  if (remainingSeconds === null || remainingSeconds <= 0) return null;

  const retryAtRaw = raw.retry_at;
  const retryAt = typeof retryAtRaw === 'string' && retryAtRaw.trim() ? Date.parse(retryAtRaw) : NaN;
  const retryAtMs = Number.isFinite(retryAt) ? retryAt : null;

  const backoffLevel = toInt(raw.backoff_level);
  const httpStatus = toInt(raw.http_status);
  return {
    scope,
    model_key: modelKey,
    reason: String(raw.reason || '').trim() || 'unknown',
    retry_at: retryAtMs,
    remaining_seconds: remainingSeconds,
    backoff_level: backoffLevel !== null && backoffLevel >= 0 ? backoffLevel : null,
    http_status: httpStatus !== null && httpStatus >= 400 && httpStatus <= 599 ? httpStatus : null
  };
}

/**
 * 剩余秒数随时间衰减：快照是 CPA 观察冷却时的值，Gate 读取时已经过去一段时间。
 * 与 CPA 面板的 sA() 同口径——按 elapsed 扣减，最小为 0。
 */
function liveRemainingSeconds(record, receivedAtMs, nowMs) {
  const elapsed = Math.max(0, nowMs - receivedAtMs) / 1000;
  return Math.max(0, Math.ceil(record.remaining_seconds - elapsed));
}

export function formatCooldownRemaining(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '计时已到期';
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return `${days} 天 ${hours % 24} 小时`;
  }
  return restMinutes ? `${hours} 小时 ${restMinutes} 分钟` : `${hours} 小时`;
}

/**
 * 把 CPA 的 cooldowns[] 归一为可展示的冷却摘要；无有效冷却时返回 null。
 *
 * 口径与 CPA 面板一致：这是 CPA 调度侧的本地快照，剩余时间为估算；冷却到期不代表
 * 凭证一定恢复、额度一定回来或会自动重试。Gate 不因为到期就自行放行。
 */
export function interpretCooldowns(file = {}, nowMs = Date.now()) {
  const rawList = Array.isArray(file.cooldowns) ? file.cooldowns : [];
  if (rawList.length === 0) return null;

  const receivedAtMs = cooldownObservedAt ?? nowMs;
  const rows = rawList
    .map(normalizeCooldownRecord)
    .filter(Boolean)
    .map(record => ({ record, remainingSeconds: liveRemainingSeconds(record, receivedAtMs, nowMs) }));

  // 只统计仍在冷却中的记录；已到期的记录不算阻塞。
  const active = rows.filter(row => row.remainingSeconds > 0);
  if (active.length === 0) return null;

  const modelCount = active.filter(row => row.record.scope === 'model').length;
  const credentialWide = active.some(row => row.record.scope === 'credential');

  const scope = credentialWide && modelCount > 0
    ? 'credential_and_models'
    : credentialWide ? 'credential' : 'models';
  const scopeLabel = credentialWide
    ? (modelCount > 0 ? `凭证及 ${modelCount} 个模型冷却` : '整个凭证')
    : `${modelCount} 个模型冷却`;

  // 原因取最严重的一条：按 slug 编码顺序，额度类优先于暂时性错误。
  const SEVERITY = ['quota', 'credential_quota', 'payment_required', 'cloudflare_challenge',
    'invalid_grant', 'unauthorized', 'model_not_supported', 'not_found', 'transient_error'];
  const reasons = [...new Set(active.map(row => row.record.reason))];
  const primary = reasons
    .slice()
    .sort((a, b) => {
      const ia = SEVERITY.indexOf(a);
      const ib = SEVERITY.indexOf(b);
      return (ia === -1 ? SEVERITY.length : ia) - (ib === -1 ? SEVERITY.length : ib);
    })[0];

  const earliestSeconds = Math.min(...active.map(row => row.remainingSeconds));
  const withRetryAt = active.filter(row => row.record.retry_at).map(row => row.record.retry_at);
  const httpStatuses = active.map(row => row.record.http_status).filter(Boolean);
  const backoffLevels = active.map(row => row.record.backoff_level).filter(v => v !== null);

  return {
    scope,
    scope_label: scopeLabel,
    model_count: modelCount,
    reason: primary,
    reason_label: COOLDOWN_REASON_LABELS[primary] || '其他或未知原因',
    remaining_seconds: earliestSeconds,
    remaining_text: formatCooldownRemaining(earliestSeconds),
    earliest_retry_at: withRetryAt.length ? Math.min(...withRetryAt) : null,
    http_status: httpStatuses.length ? httpStatuses[0] : null,
    backoff_level: backoffLevels.length ? Math.max(...backoffLevels) : null,
    observed_at: receivedAtMs,
    reasons,
    model_keys: [...new Set(active.filter(row => row.record.scope === 'model').map(row => row.record.model_key))]
  };
}

export function getAuthHealth(file = {}, nowMs = Date.now()) {
  // 冷却优先于一切：处于冷却的调度对象不能按 status 判为可用。
  const cooldown = interpretCooldowns(file, nowMs);
  if (cooldown) {
    return {
      state: 'cooldown',
      label: '冷却中',
      detail: `${cooldown.reason_label} · ${cooldown.scope_label} · 最早结束约 ${cooldown.remaining_text}`,
      blocked: true,
      cooldown
    };
  }

  const status = String(file.status || '').trim().toLowerCase();
  const message = String(file.status_message || file.statusMessage || '').trim();
  if (/\b(?:token|credential|credentials)\s+(?:has\s+)?expired\b|\bexpired\s+(?:token|credential|credentials)\b|令牌.{0,6}过期|凭据.{0,6}过期/i.test(message) || status === 'expired') {
    return { state: 'expired', label: 'Token 已过期', detail: 'CPA 报告 token expired，请重新授权或刷新凭据', blocked: true, cooldown: null };
  }
  if (file.disabled === true || status === 'disabled') {
    return { state: 'disabled', label: '已停用', detail: 'CPA 已停用此凭据', blocked: true, cooldown: null };
  }
  if (['error', 'invalid', 'failed'].includes(status)) {
    return { state: 'error', label: '凭据异常', detail: 'CPA 报告凭据错误，请检查认证状态', blocked: true, cooldown: null };
  }
  if (file.unavailable === true || status === 'unavailable') {
    return { state: 'unavailable', label: '暂不可用', detail: 'CPA 当前标记此凭据不可用', blocked: true, cooldown: null };
  }
  return { state: 'ready', label: '可用', detail: '', blocked: false, cooldown: null };
}

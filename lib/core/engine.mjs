import {
  stmtSelectRules,
  stmtUpsertRule,
  stmtDeleteRule
} from '../db/sqlite.mjs';
import { notifyEvent } from '../../notify.mjs';
import {
  rawKeyToId,
  keyMetaMap,
  extractRawKey
} from './key-registry.mjs';
import {
  usageDate,
  liveUsage,
  preloadedToday,
  preloadedTodayRequests,
  liveTodayTokensByKeyId,
  liveTodayRequestsByKeyId
} from './outbox.mjs';

export const quotaRules = new Map();      // key_id -> rule
export const keyModelRules = new Map();   // key_id -> Set(lowercase model) | null
export const rpmWindows = new Map();      // key_id -> number[]（60s 滑动窗口内请求 ts）
export let quotaRulesVersion = 1;

export function parseModelWhitelist(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === '*' || trimmed === '["*"]') return null;

  let items = [];
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) items = parsed;
    } catch (e) {
      items = trimmed.slice(1, -1).split(',');
    }
  } else {
    items = trimmed.split(',');
  }

  const modelSet = new Set();
  for (let item of items) {
    if (typeof item === 'string') {
      const m = item.trim().toLowerCase();
      if (m === '*') return null;
      if (m) modelSet.add(m);
    }
  }
  return modelSet.size > 0 ? modelSet : null;
}

export function loadQuotaRules() {
  quotaRulesVersion++;
  const rows = stmtSelectRules.all();
  quotaRules.clear();
  keyModelRules.clear();

  for (const r of rows) {
    const parsedModels = parseModelWhitelist(r.model_whitelist);
    quotaRules.set(r.key_id, {
      key_id: r.key_id,
      enabled: Boolean(r.enabled),
      daily_limit: r.daily_limit,
      hard_ratio: r.hard_ratio || 1.2,
      rpm_limit: r.rpm_limit || 0,
      model_whitelist: r.model_whitelist || '',
      model_group: r.model_group || ''
    });

    if (parsedModels) {
      keyModelRules.set(r.key_id, parsedModels);
    }
  }
}

export function getTodayUsageForKey(keyId) {
  return (preloadedToday.get(keyId) || 0) + (liveTodayTokensByKeyId.get(keyId) || 0);
}

export function getTodayRequestsForKey(keyId) {
  return (preloadedTodayRequests.get(keyId) || 0) + (liveTodayRequestsByKeyId.get(keyId) || 0);
}

/**
 * 纳秒级热路径：检查请求是否满足每日额度限制
 */
export function checkQuota(authHeader) {
  const rawKey = extractRawKey(authHeader);
  if (!rawKey) return { allowed: true };

  const keyId = rawKeyToId.get(rawKey);
  if (!keyId) return { allowed: true };

  const rule = quotaRules.get(keyId);
  if (!rule || !rule.enabled || !rule.daily_limit || rule.daily_limit <= 0) {
    return { allowed: true };
  }

  const used = getTodayUsageForKey(keyId);
  const hardRatio = rule.hard_ratio || 1.2;
  const hardLimit = Math.floor(rule.daily_limit * hardRatio);

  if (used >= hardLimit) {
    const meta = keyMetaMap.get(keyId);
    notifyEvent('quota_exceeded', `key:${keyId}`, `Key ${meta?.alias || meta?.display_key || keyId} 触达日额度硬顶：${used.toLocaleString()} / ${rule.daily_limit.toLocaleString()}（硬顶 ${hardLimit.toLocaleString()}），请求已开始被 429 拒绝`).catch(() => {});
    return {
      allowed: false,
      reason: `Daily token limit exceeded. Used: ${used.toLocaleString()}, Limit: ${rule.daily_limit.toLocaleString()}, Hard limit: ${hardLimit.toLocaleString()}`,
      usage: used,
      limit: rule.daily_limit,
      hardLimit: hardLimit
    };
  }

  return { allowed: true };
}

/**
 * 纳秒级热路径：Key 级 RPM 限速（60s 滑动窗口，内存态，重启清零）
 */
export function checkRateLimit(authHeader) {
  const rawKey = extractRawKey(authHeader);
  if (!rawKey) return { allowed: true };

  const keyId = rawKeyToId.get(rawKey);
  if (!keyId) return { allowed: true };

  const rule = quotaRules.get(keyId);
  const rpmLimit = rule?.rpm_limit || 0;
  if (rpmLimit <= 0) return { allowed: true };

  const now = Date.now();
  const windowStart = now - 60000;
  let stamps = rpmWindows.get(keyId);
  if (!stamps) {
    stamps = [];
    rpmWindows.set(keyId, stamps);
  }
  while (stamps.length > 0 && stamps[0] <= windowStart) stamps.shift();
  if (stamps.length >= rpmLimit) {
    return {
      allowed: false,
      reason: `Rate limit exceeded for this key. ${stamps.length} requests in the last 60s, limit: ${rpmLimit} RPM.`,
      rpm_limit: rpmLimit
    };
  }
  stamps.push(now);
  return { allowed: true };
}

/**
 * 纳秒级热路径：检查请求的模型是否在此 Key 的允许范围内
 */
export function checkModelAllowed(authHeader, requestedModel) {
  if (!requestedModel || typeof requestedModel !== 'string') {
    return { allowed: true };
  }

  const rawKey = extractRawKey(authHeader);
  if (!rawKey) return { allowed: true };

  const keyId = rawKeyToId.get(rawKey);
  if (!keyId) return { allowed: true };

  const allowedSet = keyModelRules.get(keyId);
  if (!allowedSet || allowedSet.size === 0) {
    return { allowed: true };
  }

  const modelLower = requestedModel.trim().toLowerCase();
  if (allowedSet.has(modelLower)) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: `Model '${requestedModel}' is not permitted for this API key. Permitted models: ${Array.from(allowedSet).join(', ')}`
  };
}

/**
 * 根据 Key 过滤 /v1/models 返回的模型列表
 */
export function filterModelsForKey(authHeader, modelsList) {
  if (!Array.isArray(modelsList)) return modelsList;

  const rawKey = extractRawKey(authHeader);
  if (!rawKey) return modelsList;

  const keyId = rawKeyToId.get(rawKey);
  if (!keyId) return modelsList;

  const allowedSet = keyModelRules.get(keyId);
  if (!allowedSet || allowedSet.size === 0) {
    return modelsList;
  }

  return modelsList.filter(item => {
    const id = (item && item.id ? String(item.id) : '').trim().toLowerCase();
    return allowedSet.has(id);
  });
}

export function updateQuotaRule(keyId, { enabled, daily_limit, hard_ratio, rpm_limit, model_whitelist, model_group }) {
  const hr = hard_ratio !== undefined ? Number(hard_ratio) : 1.2;
  const rl = rpm_limit !== undefined ? Math.max(0, parseInt(rpm_limit, 10) || 0) : 0;
  const mw = model_whitelist !== undefined ? String(model_whitelist).trim() : '';
  const mg = model_group !== undefined ? String(model_group).trim() : '';

  stmtUpsertRule.run(
    Number(keyId),
    enabled ? 1 : 0,
    daily_limit != null && daily_limit > 0 ? Number(daily_limit) : null,
    hr,
    rl,
    mw,
    mg
  );
  loadQuotaRules();
  return { success: true };
}

export function deleteQuotaRule(keyId) {
  stmtDeleteRule.run(Number(keyId));
  loadQuotaRules();
  return { success: true };
}

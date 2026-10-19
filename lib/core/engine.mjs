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

/**
 * 规范化模型白名单存储（保证统一落库为规范的 JSON 数组字符串或空字符串）
 * 支持 Array、JSON 数组字符串、逗号/空白分隔字符串
 */
export function normalizeModelWhitelist(raw) {
  if (!raw) return '';
  let items = [];
  if (Array.isArray(raw)) {
    items = raw;
  } else if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed || trimmed === '*' || trimmed === '["*"]') return '';
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) items = parsed;
        else items = [parsed];
      } catch (e) {
        items = trimmed.slice(1, -1).split(',');
      }
    } else {
      items = trimmed.split(',');
    }
  } else {
    return '';
  }

  const result = [];
  for (const item of items) {
    if (typeof item === 'string') {
      const parts = item.split(/[\s,]+/);
      for (const p of parts) {
        const m = p.trim().toLowerCase();
        if (m === '*') return ''; // 通配符 '*' 代表允许全部模型
        if (m && !result.includes(m)) {
          result.push(m);
        }
      }
    }
  }
  return result.length > 0 ? JSON.stringify(result) : '';
}

/**
 * 将模型白名单配置（JSON 字符串、逗号分隔串或数组）安全解析为 Set(lowercase model)
 */
export function parseModelWhitelist(raw) {
  if (!raw) return null;
  let items = [];
  if (Array.isArray(raw)) {
    items = raw;
  } else if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed || trimmed === '*' || trimmed === '["*"]') return null;
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) items = parsed;
        else items = [parsed];
      } catch (e) {
        items = trimmed.slice(1, -1).split(',');
      }
    } else {
      items = trimmed.split(',');
    }
  } else {
    return null;
  }

  const modelSet = new Set();
  for (const item of items) {
    if (typeof item === 'string') {
      const parts = item.split(/[\s,]+/);
      for (const p of parts) {
        const m = p.trim().toLowerCase();
        if (m === '*') return null;
        if (m) modelSet.add(m);
      }
    }
  }
  return modelSet.size > 0 ? modelSet : null;
}

/**
 * 校验请求模型是否被白名单集合允许
 * 智能支持：
 * 1. 精确匹配（大小写不敏感）
 * 2. 提供商/路径前缀自动剥离（如 anthropic/claude-3-7-sonnet 或 models/gemini-2.5-flash 与 claude-3-7-sonnet 互通）
 * 3. 通配符模式匹配（如 gpt-4o* 匹配 gpt-4o-mini，claude* 匹配 claude-3-7-sonnet）
 * 4. 版本与日期后缀匹配（如 claude-3-7-sonnet-20250219 匹配 claude-3-7-sonnet）
 */
export function isModelPermitted(requestedModel, allowedSet) {
  if (!allowedSet || allowedSet.size === 0) return true;
  if (!requestedModel || typeof requestedModel !== 'string') return false;

  const reqLower = requestedModel.trim().toLowerCase();
  if (allowedSet.has(reqLower) || allowedSet.has('*')) {
    return true;
  }

  // 提取剥离命名空间/厂商前缀后的裸模型名（如 anthropic/claude-3-7-sonnet -> claude-3-7-sonnet）
  const slashIdx = reqLower.lastIndexOf('/');
  const reqStripped = slashIdx !== -1 ? reqLower.slice(slashIdx + 1) : reqLower;
  if (reqStripped !== reqLower && allowedSet.has(reqStripped)) {
    return true;
  }

  // 遍历白名单规则（白名单通常仅有几个到十几个模型，O(N) 极速匹配）
  for (const pattern of allowedSet) {
    if (pattern === reqLower || pattern === reqStripped) {
      return true;
    }

    // 模式如果带有命名空间前缀，也做双向裸名比对
    const patSlashIdx = pattern.lastIndexOf('/');
    const patStripped = patSlashIdx !== -1 ? pattern.slice(patSlashIdx + 1) : pattern;
    if (patStripped === reqLower || patStripped === reqStripped) {
      return true;
    }

    // 通配符匹配 (如 gpt-4o*, claude-3*)
    if (pattern.includes('*')) {
      const regexStr = '^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$';
      try {
        const re = new RegExp(regexStr);
        if (re.test(reqLower) || re.test(reqStripped)) {
          return true;
        }
      } catch {}
    }

    // 日期/版本后缀自动匹配 (如 claude-3-7-sonnet 匹配 claude-3-7-sonnet-20250219, claude-3-7-sonnet@20250219)
    if (reqLower.startsWith(pattern + '-') || reqLower.startsWith(pattern + '@') ||
        reqStripped.startsWith(patStripped + '-') || reqStripped.startsWith(patStripped + '@')) {
      return true;
    }
  }

  return false;
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
export function checkModelAllowed(authOrReq, requestedModel) {
  if (!requestedModel || typeof requestedModel !== 'string') {
    return { allowed: true };
  }

  const rawKey = extractRawKey(authOrReq);
  if (!rawKey) return { allowed: true };

  const keyId = rawKeyToId.get(rawKey);
  if (!keyId) return { allowed: true };

  const allowedSet = keyModelRules.get(keyId);
  if (!allowedSet || allowedSet.size === 0) {
    return { allowed: true };
  }

  if (isModelPermitted(requestedModel, allowedSet)) {
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
export function filterModelsForKey(authOrReq, modelsList) {
  if (!Array.isArray(modelsList)) return modelsList;

  const rawKey = extractRawKey(authOrReq);
  if (!rawKey) return modelsList;

  const keyId = rawKeyToId.get(rawKey);
  if (!keyId) return modelsList;

  const allowedSet = keyModelRules.get(keyId);
  if (!allowedSet || allowedSet.size === 0) {
    return modelsList;
  }

  return modelsList.filter(item => {
    const id = (item && item.id ? String(item.id) : '').trim();
    return isModelPermitted(id, allowedSet);
  });
}

export function updateQuotaRule(keyId, { enabled, daily_limit, hard_ratio, rpm_limit, model_whitelist, model_group }) {
  const hr = hard_ratio !== undefined ? Number(hard_ratio) : 1.2;
  const rl = rpm_limit !== undefined ? Math.max(0, parseInt(rpm_limit, 10) || 0) : 0;
  const mw = normalizeModelWhitelist(model_whitelist);
  const mg = model_group !== undefined ? String(model_group).trim() : '';

  stmtUpsertRule.run(
    Number(keyId),
    enabled ? 1 : 0,
    daily_limit != null && Number(daily_limit) > 0 ? Number(daily_limit) : null,
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

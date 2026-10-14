import {
  stmtDailyForDateKey,
  stmtDailyAllTimeByKey,
  stmtDailyAllTimeByAllKeys,
  stmtOutboxCount
} from '../db/sqlite.mjs';
import {
  keyMetaMap,
  keyRegistryVersion,
  lastSyncTimestamp,
  lastSyncError,
  syncFailureCount
} from '../core/key-registry.mjs';
import { quotaRules, quotaRulesVersion } from '../core/engine.mjs';
import {
  usageDate,
  liveUsage,
  lastFlushTimestamp,
  lastFlushError,
  flushFailureCount
} from '../core/outbox.mjs';
import { calculateModelCost } from '../core/pricing.mjs';
import { getNotifyHealth } from '../../notify.mjs';

export function getTodayDetailsForKey(keyId) {
  let prompt = 0, completion = 0, cached = 0, total = 0, reqs = 0;
  const row = stmtDailyForDateKey.get(usageDate, Number(keyId));
  if (row) {
    prompt += row.prompt_tokens || 0;
    completion += row.completion_tokens || 0;
    cached += row.cached_tokens || 0;
    total += row.total_tokens || 0;
    reqs += row.requests || 0;
  }
  for (const [bucket, agg] of liveUsage) {
    if (bucket.startsWith(`${usageDate}|${keyId}|`)) {
      prompt += agg.prompt_tokens || 0;
      completion += agg.completion_tokens || 0;
      cached += agg.cached_tokens || 0;
      total += agg.total_tokens || 0;
      reqs += agg.requests || 0;
    }
  }
  return { prompt, completion, cached, total, requests: reqs };
}

export function getAllTimeDetailsForKey(keyId) {
  let prompt = 0, completion = 0, cached = 0, total = 0, reqs = 0;
  const numId = Number(keyId);
  try {
    const row = stmtDailyAllTimeByKey.get(numId);
    if (row) {
      prompt += row.prompt_tokens || 0;
      completion += row.completion_tokens || 0;
      cached += row.cached_tokens || 0;
      total += row.total_tokens || 0;
      reqs += row.requests || 0;
    }
  } catch {}
  for (const [bucket, agg] of liveUsage) {
    const parts = bucket.split('|');
    if (Number(parts[1]) === numId) {
      prompt += agg.prompt_tokens || 0;
      completion += agg.completion_tokens || 0;
      cached += agg.cached_tokens || 0;
      total += agg.total_tokens || 0;
      reqs += agg.requests || 0;
    }
  }
  return { prompt, completion, cached, total, requests: reqs };
}

let adminDataCache = null;
let adminDataCacheTs = 0;
let adminDataCacheVersion = '';
const ADMIN_DATA_CACHE_TTL_MS = 2500;

export function invalidateAdminDataCache() {
  adminDataCache = null;
  adminDataCacheTs = 0;
  adminDataCacheVersion = '';
}

export function getAdminData(force = false) {
  const currentVersion = `${keyRegistryVersion}:${quotaRulesVersion}:${liveUsage.size}`;
  const now = Date.now();
  if (!force && adminDataCache && adminDataCacheVersion === currentVersion && (now - adminDataCacheTs) < ADMIN_DATA_CACHE_TTL_MS) {
    return adminDataCache;
  }

  const result = [];
  const allTimeMap = new Map();
  try {
    for (const r of stmtDailyAllTimeByAllKeys.all()) {
      allTimeMap.set(r.key_id, r);
    }
  } catch {}

  for (const [id, meta] of keyMetaMap) {
    const rule = quotaRules.get(id) || { enabled: false, daily_limit: 0, hard_ratio: 1.2, rpm_limit: 0, model_whitelist: '', model_group: '' };
    const details = getTodayDetailsForKey(id);
    const used = details.total;
    const hardLimit = rule.daily_limit ? Math.floor(rule.daily_limit * (rule.hard_ratio || 1.2)) : 0;
    const isBlocked = rule.enabled && rule.daily_limit > 0 && used >= hardLimit;
    const percent = rule.enabled && rule.daily_limit > 0 ? Math.round((used / rule.daily_limit) * 1000) / 10 : 0;
    const promptBase = Math.max(details.prompt, details.cached);
    const cacheHitRate = promptBase > 0 ? Math.round((details.cached / promptBase) * 1000) / 10 : 0;
    const costEstimate = calculateModelCost('default', details.prompt, details.completion, details.cached);

    const atRow = allTimeMap.get(id);
    let allTimeUsage = atRow ? atRow.total_tokens : 0;
    let allTimeRequests = atRow ? atRow.requests : 0;
    for (const [bucket, agg] of liveUsage) {
      const parts = bucket.split('|');
      if (Number(parts[1]) === id) {
        allTimeUsage += agg.total_tokens || 0;
        allTimeRequests += agg.requests || 0;
      }
    }

    result.push({
      key_id: id,
      display_key: meta.display_key,
      key_alias: meta.alias,
      today_usage: used,
      today_requests: details.requests,
      all_time_usage: allTimeUsage,
      all_time_requests: allTimeRequests,
      prompt_tokens: details.prompt,
      completion_tokens: details.completion,
      cached_tokens: details.cached,
      cache_hit_rate: cacheHitRate,
      cost_usd: costEstimate.costUsd,
      savings_usd: costEstimate.savingsUsd,
      enabled: rule.enabled,
      daily_limit: rule.daily_limit || 0,
      hard_ratio: rule.hard_ratio || 1.2,
      rpm_limit: rule.rpm_limit || 0,
      hard_limit: hardLimit,
      usage_percent: percent,
      model_whitelist: rule.model_whitelist || '',
      model_group: rule.model_group || '',
      is_blocked: isBlocked
    });
  }
  result.sort((a, b) => b.today_usage - a.today_usage);

  adminDataCache = {
    keys: result,
    last_sync: lastSyncTimestamp,
    last_error: lastSyncError,
    now: Date.now()
  };
  adminDataCacheTs = now;
  adminDataCacheVersion = currentVersion;
  return adminDataCache;
}

export function getQuotaStatusSummary() {
  const adminSnapshot = getAdminData();
  const keys = adminSnapshot.keys;
  const blockedKeys = [];
  const warningKeys = [];
  let totalUsage = 0;
  let totalRequests = 0;
  let totalPrompt = 0;
  let totalCompletion = 0;
  let totalCached = 0;

  for (const k of keys) {
    totalUsage += k.today_usage;
    totalRequests += k.today_requests;
    totalPrompt += k.prompt_tokens || 0;
    totalCompletion += k.completion_tokens || 0;
    totalCached += k.cached_tokens || 0;

    if (k.is_blocked) {
      blockedKeys.push({ id: k.key_id, alias: k.key_alias || k.display_key, used: k.today_usage, limit: k.daily_limit, hard_limit: k.hard_limit });
    } else if (k.enabled && k.daily_limit > 0 && k.usage_percent >= 85) {
      warningKeys.push({ id: k.key_id, alias: k.key_alias || k.display_key, used: k.today_usage, limit: k.daily_limit, percent: k.usage_percent });
    }
  }

  const outboxCount = stmtOutboxCount.get().count;
  const isDegraded = outboxCount > 1000 || flushFailureCount >= 5;
  const isBlocked = blockedKeys.length > 0;
  const isWarning = warningKeys.length > 0;

  let status = 'ok';
  let httpCode = 200;
  let message = 'All quotas and gateway operations healthy';

  if (isDegraded) {
    status = 'degraded';
    httpCode = 503;
    message = `Gateway storage degraded: outbox queue ${outboxCount}, flush errors: ${flushFailureCount}`;
  } else if (isBlocked) {
    status = 'blocked';
    httpCode = 429;
    message = `${blockedKeys.length} key(s) blocked by daily token limit`;
  } else if (isWarning) {
    status = 'warning';
    httpCode = 200;
    message = `${warningKeys.length} key(s) exceeded 85% warning threshold`;
  }

  const pBase = Math.max(totalPrompt, totalCached);
  const overallCacheHitRate = pBase > 0 ? Math.round((totalCached / pBase) * 1000) / 10 : 0;

  return {
    status,
    httpCode,
    http_code: httpCode,
    message,
    summary: {
      total_keys: keys.length,
      blocked_keys: blockedKeys.length,
      keys_blocked: blockedKeys.length,
      warning_keys: warningKeys.length,
      keys_warning: warningKeys.length,
      today_total_usage: totalUsage,
      today_total_requests: totalRequests,
      today_total_cached: totalCached,
      today_cache_hit_rate: overallCacheHitRate,
      outbox_queue_depth: outboxCount
    },
    blocked_details: blockedKeys,
    warning_details: warningKeys,
    check_time: Date.now()
  };
}

export function getQuotaHealth() {
  const now = Date.now();
  const flushLagMs = lastFlushTimestamp ? now - lastFlushTimestamp : null;
  const syncLagMs = lastSyncTimestamp ? now - lastSyncTimestamp : null;
  const outboxCount = stmtOutboxCount.get().count;

  return {
    ready: (syncLagMs !== null && syncLagMs < 30000) && (flushLagMs !== null && flushLagMs < 30000) && flushFailureCount === 0,
    outbox_count: outboxCount,
    last_flush_ago_ms: flushLagMs,
    last_sync_ago_ms: syncLagMs,
    flush_failure_count: flushFailureCount,
    sync_failure_count: syncFailureCount,
    last_flush_error: lastFlushError,
    last_sync_error: lastSyncError,
    flush: {
      pending_outbox: outboxCount,
      last_flush_ago_ms: flushLagMs,
      failure_count: flushFailureCount,
      last_error: lastFlushError
    },
    sync: {
      last_sync_ago_ms: syncLagMs,
      failure_count: syncFailureCount,
      last_error: lastSyncError
    },
    notify: getNotifyHealth()
  };
}

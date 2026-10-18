import {
  stmtEventsRecent,
  stmtEventsRecentByKey,
  stmtErrorsRecent,
  stmtErrorInsert,
  stmtDailyRange,
  stmtDailyRangeByKey,
  stmtModelRange,
  stmtModelRangeByKey,
  stmtDailyForDate,
  stmtDailyAllTime,
  stmtDailyAllTimeByKey,
  stmtModelAllTime,
  stmtModelAllTimeByKey,
  stmtDailyAllTimeGrouped,
  stmtDailyAllTimeGroupedByKey,
  stmtModelAllTimeDetailed,
  stmtModelAllTimeDetailedByKey,
  stmtDailyModelsRange,
  stmtDailyModelsRangeByKey,
  stmtDailyModelsAllTime,
  stmtDailyModelsAllTimeByKey,
  stmtBaselinesAll,
  stmtAuthEventsModelAgg,
  stmtAuthEventsModelAggByKey,
  stmtAuthEventsModelAggSince,
  stmtAuthEventsModelAggSinceByKey,
  quotaDb
} from '../db/sqlite.mjs';
import { keyMetaMap } from '../core/key-registry.mjs';
import { calculateModelCost } from '../core/pricing.mjs';
import {
  inferModelProviderLabel,
  inferProvider,
  getProviderLabel,
  getProviderGroupLabel,
  UNKNOWN_PROVIDER_KEY,
  OTHER_MODEL_LABEL
} from '../core/provider-registry.mjs';
import { calculateTokensPerSec } from '../proxy/token-estimator.mjs';
import {
  pendingEvents,
  flushUsage,
  shanghaiDate,
  usageDate,
  liveUsage,
  getOutboxSnapshot
} from '../core/outbox.mjs';
import { getAdminData } from './quota-health.mjs';
import { cachedUpstreamQuotas } from '../upstream/sync.mjs';

let baselinesCacheMap = null;
let baselinesCacheTs = 0;
const BASELINES_CACHE_TTL_MS = 10000;

function getBaselinesMap() {
  const now = Date.now();
  if (baselinesCacheMap && (now - baselinesCacheTs) < BASELINES_CACHE_TTL_MS) {
    return baselinesCacheMap;
  }
  const map = new Map();
  try {
    const baselines = stmtBaselinesAll.all();
    for (const b of baselines) {
      if (b.auth_index) map.set(b.auth_index, b);
    }
  } catch {}
  baselinesCacheMap = map;
  baselinesCacheTs = now;
  return map;
}

const authInfoCache = new Map();
const AUTH_INFO_CACHE_TTL_MS = 10000;

const pagedRequestsCache = new Map();
const pagedErrorsCache = new Map();
const PAGED_CACHE_TTL_MS = 2500;

export function clearAuditLogsCache() {
  authInfoCache.clear();
  baselinesCacheMap = null;
  pagedRequestsCache.clear();
  pagedErrorsCache.clear();
}

/**
 * 将 16 位十六进制 auth_index 快速解析为用户可辨识的账号邮箱或凭据名
 */
export function resolveAuthAccountInfo(authIndex) {
  if (!authIndex) return { auth_index: '', auth_name: '', auth_email: '', provider: '' };
  const str = String(authIndex).trim();
  const now = Date.now();
  const cached = authInfoCache.get(str);
  if (cached && (now - cached.ts) < AUTH_INFO_CACHE_TTL_MS) {
    return cached.data;
  }

  // 1. 优先查实时内存中的同步凭据列表
  let info = null;
  const accounts = Array.isArray(cachedUpstreamQuotas?.accounts) ? cachedUpstreamQuotas.accounts : [];
  const acc = accounts.find(a => a.auth_index === str);
  if (acc) {
    const rawName = acc.display_name || acc.nickname || acc.email || acc.filename || str;
    const resolvedName = String(rawName).replace(/\.json$/i, '');
    info = {
      auth_index: str,
      auth_name: resolvedName,
      auth_email: acc.email || '',
      provider: acc.provider || ''
    };
  } else {
    // 2. 查本地基线表 (基于短时缓存 Map，避免在列表循环中执行 N 次 stmtBaselinesAll.all())
    const baselinesMap = getBaselinesMap();
    const b = baselinesMap.get(str);
    if (b) {
      info = {
        auth_index: str,
        auth_name: String(b.name || str).replace(/\.json$/i, ''),
        auth_email: '',
        provider: b.provider || ''
      };
    } else {
      info = {
        auth_index: str,
        auth_name: str,
        auth_email: '',
        provider: ''
      };
    }
  }

  if (authInfoCache.size > 2000) authInfoCache.clear();
  authInfoCache.set(str, { ts: now, data: info });
  return info;
}

/**
 * 综合静态凭证与全局注册表推断事件的上游身份。
 * 解决 API 渠道凭证（如 OpenCode）在 auth-files 里无显式文件时掉入「其他上游」与裸哈希的问题。
 */
export function resolveEventAuthInfo(authIndex, model = '', explicitProvider = '') {
  const base = resolveAuthAccountInfo(authIndex);
  let provider = String(explicitProvider || base.provider || '').trim().toLowerCase();
  let authName = (base.auth_name ? String(base.auth_name).replace(/\.json$/i, '') : '') || '';
  const cleanIdx = String(authIndex || '').trim();

  // 若无提供商或提供商未登记，通过模型名与 authIndex 走注册表推断兜底
  if (!provider || provider === 'unknown' || provider === 'other') {
    const inferred = inferProvider({ model, authIndex: cleanIdx });
    if (inferred.key) {
      provider = inferred.key;
      // 若凭证名只是裸哈希，赋予友好的渠道别名
      if (!authName || authName === cleanIdx) {
        authName = `${inferred.label || inferred.key} 渠道 ${cleanIdx.slice(0, 8)}`;
      }
    }
  }

  // 兜底：若仍为裸哈希且未能推断出提供商，与 status-summary 同口径标为「已删除账号」
  if (cleanIdx && (!authName || authName === cleanIdx)) {
    authName = `已删除账号 ${cleanIdx.slice(0, 8)}`;
  }

  return {
    auth_index: cleanIdx,
    auth_name: authName,
    auth_email: base.auth_email || '',
    provider
  };
}

try {
  quotaDb.function('resolve_event_provider', (authIndex, model) => {
    return resolveEventAuthInfo(authIndex, model).provider || 'other';
  });
} catch (e) {
  // 防止在某些上下文中重复声明报错
}

export function recordErrorEvent({ keyId, authIndex, provider, model, status, errorType, errorBody, retryAfterMs }) {
  pagedErrorsCache.clear();
  const rMs = Math.max(0, Math.round(retryAfterMs) || 0);
  const recoverAt = rMs > 0 ? Date.now() + rMs : 0;
  try {
    stmtErrorInsert.run({
      ts: Math.floor(Date.now() / 1000),
      key_id: keyId == null ? null : keyId,
      auth_index: String(authIndex || '').trim().slice(0, 64),
      provider: String(provider || '').trim().slice(0, 64),
      model: String(model || 'unknown').trim().slice(0, 120),
      status: Number(status) || 500,
      error_type: String(errorType || 'error').trim().slice(0, 80),
      error_body: String(errorBody || '').trim().slice(0, 2000),
      retry_after_ms: rMs,
      recover_at: recoverAt
    });
  } catch (e) {
    console.error('[Gate-Quota] Error event insert failed:', e.message);
  }
}

export function getRecentErrorEvents(limit = 100) {
  const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const rows = stmtErrorsRecent.all(n);
  const now = Date.now();
  return {
    errors: rows.map(r => {
      const authInfo = resolveEventAuthInfo(r.auth_index, r.model, r.provider);
      return {
        id: r.id,
        ts: r.ts * 1000,
        key_id: r.key_id,
        key_alias: r.key_id != null ? (keyMetaMap.get(r.key_id)?.alias || '') : '',
        display_key: r.key_id != null ? (keyMetaMap.get(r.key_id)?.display_key || '') : '未知 Key',
        auth_index: r.auth_index || '',
        auth_name: authInfo.auth_name,
        auth_email: authInfo.auth_email,
        provider: authInfo.provider || '',
        model: r.model,
        status: r.status,
        error_type: r.error_type,
        error_body: r.error_body,
        retry_after_ms: r.retry_after_ms,
        recover_at: r.recover_at,
        is_active: r.recover_at > now,
        remaining_recover_sec: r.recover_at > now ? Math.ceil((r.recover_at - now) / 1000) : 0
      };
    })
  };
}

function resolveTimeRangeClauses(timeRange, since, until) {
  const clauses = [];
  const args = [];
  const nowSec = Math.floor(Date.now() / 1000);
  let resolvedSince = null;
  let resolvedUntil = null;

  if (since != null && since !== '') {
    const s = Number(since);
    if (Number.isFinite(s)) {
      resolvedSince = s > 1e11 ? Math.floor(s / 1000) : Math.floor(s);
    }
  }
  if (until != null && until !== '') {
    const u = Number(until);
    if (Number.isFinite(u)) {
      resolvedUntil = u > 1e11 ? Math.floor(u / 1000) : Math.floor(u);
    }
  }

  if (resolvedSince == null && timeRange && timeRange !== 'all') {
    if (timeRange === '1h') resolvedSince = nowSec - 3600;
    else if (timeRange === 'today') {
      const todayStr = shanghaiDate(new Date());
      resolvedSince = Math.floor(new Date(`${todayStr}T00:00:00+08:00`).getTime() / 1000);
    } else if (timeRange === '24h') resolvedSince = nowSec - 86400;
    else if (timeRange === '3d') resolvedSince = nowSec - 3 * 86400;
    else if (timeRange === '7d') resolvedSince = nowSec - 7 * 86400;
    else if (timeRange === '30d') resolvedSince = nowSec - 30 * 86400;
  }

  if (resolvedSince != null) {
    clauses.push('ts >= ?');
    args.push(resolvedSince);
  }
  if (resolvedUntil != null) {
    clauses.push('ts <= ?');
    args.push(resolvedUntil);
  }
  return { clauses, args };
}

const stmtTodayRequestsCount = quotaDb.prepare('SELECT COUNT(*) AS n FROM request_events WHERE ts >= ?');
const stmtTodayRequestsCountByKey = quotaDb.prepare('SELECT COUNT(*) AS n FROM request_events WHERE ts >= ? AND key_id = ?');
const stmtTodayErrorsCount = quotaDb.prepare('SELECT COUNT(*) AS n FROM error_events WHERE ts >= ?');
const stmtTodayErrorsCountByKey = quotaDb.prepare('SELECT COUNT(*) AS n FROM error_events WHERE ts >= ? AND key_id = ?');

export function getTodayStartTimestamp() {
  const todayStr = shanghaiDate(new Date());
  return Math.floor(new Date(`${todayStr}T00:00:00+08:00`).getTime() / 1000);
}

export function getTodayRequestsCount(keyId = null) {
  if (pendingEvents.length > 0) {
    flushUsage();
    pagedRequestsCache.clear();
  }
  const sinceTs = getTodayStartTimestamp();
  if (keyId != null) {
    const numericKeyId = Number(keyId);
    if (!Number.isSafeInteger(numericKeyId) || numericKeyId < 0) return 0;
    return stmtTodayRequestsCountByKey.get(sinceTs, numericKeyId)?.n || 0;
  }
  return stmtTodayRequestsCount.get(sinceTs)?.n || 0;
}

export function getTodayErrorsCount(keyId = null) {
  const sinceTs = getTodayStartTimestamp();
  if (keyId != null) {
    const numericKeyId = Number(keyId);
    if (!Number.isSafeInteger(numericKeyId) || numericKeyId < 0) return 0;
    return stmtTodayErrorsCountByKey.get(sinceTs, numericKeyId)?.n || 0;
  }
  return stmtTodayErrorsCount.get(sinceTs)?.n || 0;
}

export function getPagedErrorEvents({ page = 1, pageSize = 25, timeRange = 'all', since = null, until = null, beforeId = null } = {}) {
  const size = Math.min(Math.max(Math.floor(Number(pageSize)) || 25, 1), 100);
  const requestedPage = Math.max(Math.floor(Number(page)) || 1, 1);
  let maxId = 0;
  try {
    maxId = quotaDb.prepare('SELECT MAX(id) AS m FROM error_events').get()?.m || 0;
  } catch {}
  const cacheKey = JSON.stringify({ page: requestedPage, pageSize: size, timeRange, since, until, beforeId, maxId });
  const now = Date.now();
  const hit = pagedErrorsCache.get(cacheKey);
  if (hit && (now - hit.ts) < PAGED_CACHE_TTL_MS) {
    return hit.data;
  }

  const clauses = [];
  const args = [];

  const timeFilter = resolveTimeRangeClauses(timeRange, since, until);
  clauses.push(...timeFilter.clauses);
  args.push(...timeFilter.args);

  if (beforeId != null && beforeId !== '') {
    const bId = Number(beforeId);
    if (Number.isSafeInteger(bId) && bId > 0) {
      clauses.push('id < ?');
      args.push(bId);
    }
  }

  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  const total = quotaDb.prepare(`SELECT COUNT(*) AS n FROM error_events${where}`).get(...args).n;
  const safePage = Math.min(requestedPage, Math.max(1, Math.ceil(total / size)));
  const offset = (safePage - 1) * size;

  // 延迟关联：通过子查询利用覆盖索引获取 id，再回表连接提取完整字段
  const querySql = `
    SELECT e.* FROM error_events e
    JOIN (
      SELECT id FROM error_events${where}
      ORDER BY ts DESC, id DESC
      LIMIT ? OFFSET ?
    ) p ON e.id = p.id
    ORDER BY e.ts DESC, e.id DESC
  `;
  const rows = quotaDb.prepare(querySql).all(...args, size, offset);
  const result = {
    total, page: safePage, page_size: size,
    today_total: getTodayErrorsCount(),
    errors: rows.map(r => {
      const authInfo = resolveEventAuthInfo(r.auth_index, r.model, r.provider);
      return {
        id: r.id,
        ts: r.ts * 1000,
        key_id: r.key_id,
        key_alias: r.key_id != null ? (keyMetaMap.get(r.key_id)?.alias || '') : '',
        display_key: r.key_id != null ? (keyMetaMap.get(r.key_id)?.display_key || '') : '未知 Key',
        auth_index: r.auth_index || '',
        auth_name: authInfo.auth_name,
        auth_email: authInfo.auth_email,
        provider: authInfo.provider || '',
        model: r.model,
        status: r.status,
        error_type: r.error_type,
        error_body: r.error_body,
        retry_after_ms: r.retry_after_ms,
        recover_at: r.recover_at,
        is_active: r.recover_at > now,
        remaining_recover_sec: r.recover_at > now ? Math.ceil((r.recover_at - now) / 1000) : 0
      };
    })
  };
  if (pagedErrorsCache.size > 200) pagedErrorsCache.clear();
  pagedErrorsCache.set(cacheKey, { ts: now, data: result });
  return result;
}

function resolveEventTps(r, completion) {
  let tps = Number(r.tokens_per_sec);
  if (!Number.isFinite(tps) || tps <= 0) {
    tps = calculateTokensPerSec(completion, r.latency_ms, r.ttft_ms, Boolean(r.stream));
  }
  return tps > 0 ? Math.round(tps * 10) / 10 : 0;
}

function resolveEventReasoningEffort(r) {
  const effort = String(r.reasoning_effort || '').trim();
  if (effort) return effort;
  if (typeof r.model === 'string' && r.model.trim()) {
    const match = r.model.trim().toLowerCase().match(/[-_:](high|medium|low|max)$/i);
    if (match) return match[1].toLowerCase();
  }
  return '';
}

export function getRecentRequests(limit = 100) {
  if (pendingEvents.length > 0) flushUsage();
  const n = Math.min(Math.max(Number(limit) || 100, 1), 5000);
  const rows = stmtEventsRecent.all(n);
  return {
    events: rows.map(r => {
      const prompt = r.prompt_tokens || 0;
      const completion = r.completion_tokens || 0;
      const cached = r.cached_tokens || 0;
      const total = r.total_tokens || 0;
      const pBase = Math.max(prompt, cached);
      const hitRate = pBase > 0 ? Math.round((cached / pBase) * 1000) / 10 : 0;
      const cost = calculateModelCost(r.model, prompt, completion, cached);
      const authInfo = resolveEventAuthInfo(r.auth_index, r.model);

      return {
        ts: r.ts * 1000,
        key_id: r.key_id,
        key_alias: r.key_id != null ? (keyMetaMap.get(r.key_id)?.alias || '') : '',
        display_key: r.key_id != null ? (keyMetaMap.get(r.key_id)?.display_key || '') : '未知 Key',
        model: r.model,
        status: r.status,
        prompt_tokens: prompt,
        completion_tokens: completion,
        cached_tokens: cached,
        total_tokens: total,
        cache_hit_rate: hitRate,
        cost_usd: cost.costUsd,
        savings_usd: cost.savingsUsd,
        latency_ms: r.latency_ms,
        ttft_ms: r.ttft_ms || 0,
        stream: Boolean(r.stream),
        estimated: Boolean(r.estimated),
        error_type: r.error_type,
        auth_index: r.auth_index || '',
        auth_name: authInfo.auth_name,
        auth_email: authInfo.auth_email,
        provider: authInfo.provider || '',
        reasoning_effort: resolveEventReasoningEffort(r),
        tokens_per_sec: resolveEventTps(r, completion)
      };
    })
  };
}

export function getRecentRequestsForKey(keyId, limit = 100) {
  if (keyId == null) return { events: [] };
  if (pendingEvents.length > 0) flushUsage();
  const n = Math.min(Math.max(Number(limit) || 100, 1), 5000);
  const rows = stmtEventsRecentByKey.all(Number(keyId), n);
  return {
    events: rows.map(r => {
      const prompt = r.prompt_tokens || 0;
      const completion = r.completion_tokens || 0;
      const cached = r.cached_tokens || 0;
      const total = r.total_tokens || 0;
      const pBase = Math.max(prompt, cached);
      const hitRate = pBase > 0 ? Math.round((cached / pBase) * 1000) / 10 : 0;
      const cost = calculateModelCost(r.model, prompt, completion, cached);
      const authInfo = resolveEventAuthInfo(r.auth_index, r.model);

      return {
        ts: r.ts * 1000,
        key_id: r.key_id,
        key_alias: r.key_id != null ? (keyMetaMap.get(r.key_id)?.alias || '') : '',
        display_key: r.key_id != null ? (keyMetaMap.get(r.key_id)?.display_key || '') : '未知 Key',
        model: r.model,
        status: r.status,
        prompt_tokens: prompt,
        completion_tokens: completion,
        cached_tokens: cached,
        total_tokens: total,
        cache_hit_rate: hitRate,
        cost_usd: cost.costUsd,
        savings_usd: cost.savingsUsd,
        latency_ms: r.latency_ms,
        ttft_ms: r.ttft_ms || 0,
        stream: Boolean(r.stream),
        estimated: Boolean(r.estimated),
        error_type: r.error_type,
        auth_index: r.auth_index || '',
        auth_name: authInfo.auth_name,
        auth_email: authInfo.auth_email,
        provider: authInfo.provider || '',
        reasoning_effort: resolveEventReasoningEffort(r),
        tokens_per_sec: resolveEventTps(r, completion)
      };
    })
  };
}

export function getPagedRequests({ page = 1, pageSize = 25, keyId = null, authIndex = null, provider = null, filter = 'all', search = '', timeRange = 'all', since = null, until = null, beforeId = null } = {}) {
  if (pendingEvents.length > 0) {
    flushUsage();
    pagedRequestsCache.clear();
  }
  const size = Math.min(Math.max(Math.floor(Number(pageSize)) || 25, 1), 100);
  const requestedPage = Math.max(Math.floor(Number(page)) || 1, 1);
  const term = String(search || '').trim().slice(0, 120);
  const cleanProvider = String(provider || '').trim().toLowerCase();
  const effectiveProvider = (cleanProvider && cleanProvider !== 'all') ? cleanProvider : null;

  let maxId = 0;
  try {
    maxId = quotaDb.prepare('SELECT MAX(id) AS m FROM request_events').get()?.m || 0;
  } catch {}
  const cacheKey = JSON.stringify({ page: requestedPage, pageSize: size, keyId, authIndex, provider: effectiveProvider, filter, search: term, timeRange, since, until, beforeId, maxId, keyMetaSize: keyMetaMap.size });
  const now = Date.now();
  const hit = pagedRequestsCache.get(cacheKey);
  if (hit && (now - hit.ts) < PAGED_CACHE_TTL_MS) {
    return hit.data;
  }

  const clauses = [];
  const args = [];
  if (keyId != null) {
    const numericKeyId = Number(keyId);
    if (!Number.isSafeInteger(numericKeyId) || numericKeyId < 0) return { total: 0, page: 1, page_size: size, events: [] };
    clauses.push('key_id = ?'); args.push(numericKeyId);
  }
  if (authIndex != null && typeof authIndex === 'string' && authIndex.trim()) {
    clauses.push('auth_index = ?'); args.push(authIndex.trim());
  }
  if (effectiveProvider) {
    clauses.push('resolve_event_provider(auth_index, model) = ?');
    args.push(effectiveProvider);
  }
  if (filter === 'cached') clauses.push('cached_tokens > 0');
  else if (filter === '2xx') clauses.push('status BETWEEN 200 AND 299');
  else if (filter === '4xx') clauses.push('status BETWEEN 400 AND 499');
  else if (filter === '5xx') clauses.push('status BETWEEN 500 AND 599');
  else if (filter === 'blocked') clauses.push("error_type IN ('quota_exceeded', 'rate_limited', 'model_forbidden')");
  else if (filter === 'errors') clauses.push('(status >= 400 OR error_type IS NOT NULL)');
  // term 已在函数开头为缓存 key 声明过，这里直接复用，不得重复声明
  if (term) {
    const pattern = `%${term}%`;
    const termLower = term.toLowerCase();
    const matchedAuths = new Set();
    const accounts = Array.isArray(cachedUpstreamQuotas?.accounts) ? cachedUpstreamQuotas.accounts : [];
    for (const a of accounts) {
      if (!a?.auth_index) continue;
      const candidates = [a.display_name, a.nickname, a.email, a.filename, a.label];
      if (candidates.some(c => typeof c === 'string' && c.toLowerCase().includes(termLower))) {
        matchedAuths.add(a.auth_index);
      }
    }

    let authSubClause = '';
    const authArgs = [];
    if (matchedAuths.size > 0) {
      const placeholders = Array.from(matchedAuths, () => '?').join(',');
      authSubClause = ` OR auth_index IN (${placeholders})`;
      authArgs.push(...matchedAuths);
    }

    clauses.push(`(model LIKE ? OR error_type LIKE ? OR auth_index LIKE ? OR reasoning_effort LIKE ? OR CAST(key_id AS TEXT) LIKE ? OR EXISTS (SELECT 1 FROM keys WHERE keys.id = request_events.key_id AND (keys.alias LIKE ? OR keys.api_key LIKE ?)) OR EXISTS (SELECT 1 FROM upstream_auth_baselines WHERE upstream_auth_baselines.auth_index = request_events.auth_index AND upstream_auth_baselines.name LIKE ?)${authSubClause})`);
    args.push(pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern, ...authArgs);
  }

  const timeFilter = resolveTimeRangeClauses(timeRange, since, until);
  clauses.push(...timeFilter.clauses);
  args.push(...timeFilter.args);

  if (beforeId != null && beforeId !== '') {
    const bId = Number(beforeId);
    if (Number.isSafeInteger(bId) && bId > 0) {
      clauses.push('id < ?');
      args.push(bId);
    }
  }

  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  const total = quotaDb.prepare(`SELECT COUNT(*) AS n FROM request_events${where}`).get(...args).n;
  const safePage = Math.min(requestedPage, Math.max(1, Math.ceil(total / size)));
  const offset = (safePage - 1) * size;

  // 延迟关联：先通过覆盖索引子查询获取 id，再回表连接提取完整字段，彻底消除大 offset 深度分页性能瓶颈
  const querySql = `
    SELECT r.* FROM request_events r
    JOIN (
      SELECT id FROM request_events${where}
      ORDER BY id DESC
      LIMIT ? OFFSET ?
    ) p ON r.id = p.id
    ORDER BY r.id DESC
  `;
  const rows = quotaDb.prepare(querySql).all(...args, size, offset);
  const result = {
    total, page: safePage, page_size: size,
    today_total: getTodayRequestsCount(keyId),
    events: rows.map(r => {
      const prompt = r.prompt_tokens || 0;
      const completion = r.completion_tokens || 0;
      const cached = r.cached_tokens || 0;
      const cost = calculateModelCost(r.model, prompt, completion, cached);
      const authInfo = resolveEventAuthInfo(r.auth_index, r.model);
      return {
        id: r.id, ts: r.ts * 1000, key_id: r.key_id,
        key_alias: r.key_id != null ? (keyMetaMap.get(r.key_id)?.alias || '') : '',
        display_key: r.key_id != null ? (keyMetaMap.get(r.key_id)?.display_key || '') : '未知 Key',
        model: r.model, status: r.status, prompt_tokens: prompt,
        completion_tokens: completion, cached_tokens: cached, total_tokens: r.total_tokens || 0,
        cache_hit_rate: Math.max(prompt, cached) > 0 ? Math.round(cached / Math.max(prompt, cached) * 1000) / 10 : 0,
        cost_usd: cost.costUsd, savings_usd: cost.savingsUsd,
        latency_ms: r.latency_ms, ttft_ms: r.ttft_ms || 0,
        stream: Boolean(r.stream), estimated: Boolean(r.estimated),
        error_type: r.error_type,
        auth_index: r.auth_index || '',
        auth_name: authInfo.auth_name,
        auth_email: authInfo.auth_email,
        provider: authInfo.provider || '',
        reasoning_effort: resolveEventReasoningEffort(r),
        tokens_per_sec: resolveEventTps(r, completion)
      };
    })
  };
  if (pagedRequestsCache.size > 200) pagedRequestsCache.clear();
  pagedRequestsCache.set(cacheKey, { ts: now, data: result });
  return result;
}

/**
 * 根据模型名称推断所属 AI 提供商。
 * 唯一真相源是 lib/core/provider-registry.mjs，此处不再维护分支链。
 */
export function inferModelProvider(modelName) {
  if (!modelName) return '其他';
  return inferModelProviderLabel(modelName);
}

export function getUsageStats(days = 7, filterKeyId = null) {
  const isAllTime = String(days).toLowerCase() === 'all' || days === 0 || days === '0';
  const dayCount = isAllTime ? 0 : Math.min(Math.max(Number(days) || 7, 1), 365);
  const targetKeyId = (filterKeyId !== null && filterKeyId !== undefined && filterKeyId !== '') ? Number(filterKeyId) : null;
  const isKeyFiltered = targetKeyId !== null && !isNaN(targetKeyId);
  const since = isAllTime ? '' : shanghaiDate(new Date(Date.now() - (dayCount - 1) * 86400000));
  const sinceTimestamp = isAllTime ? 0 : Math.floor(new Date(`${since}T00:00:00+08:00`).getTime() / 1000);

  let rawDaily = [];
  let rawModels = [];
  let rawDailyModels = [];

  if (isAllTime) {
    rawDaily = isKeyFiltered
      ? stmtDailyAllTimeGroupedByKey.all(targetKeyId)
      : stmtDailyAllTimeGrouped.all();
    rawModels = isKeyFiltered
      ? stmtModelAllTimeDetailedByKey.all(targetKeyId)
      : stmtModelAllTimeDetailed.all();
    rawDailyModels = isKeyFiltered
      ? stmtDailyModelsAllTimeByKey.all(targetKeyId)
      : stmtDailyModelsAllTime.all();
  } else {
    rawDaily = isKeyFiltered
      ? stmtDailyRangeByKey.all(since, targetKeyId)
      : stmtDailyRange.all(since);
    rawModels = isKeyFiltered
      ? stmtModelRangeByKey.all(since, targetKeyId)
      : stmtModelRange.all(since);
    rawDailyModels = isKeyFiltered
      ? stmtDailyModelsRangeByKey.all(since, targetKeyId)
      : stmtDailyModelsRange.all(since);
  }

  // 1. 基于每日各模型真实用量，精确计算每日真实花费与节省
  const dailyCostMap = new Map();
  const dailySavingsMap = new Map();
  for (const r of rawDailyModels) {
    const costObj = calculateModelCost(r.model, r.prompt_tokens || 0, r.completion_tokens || 0, r.cached_tokens || 0);
    dailyCostMap.set(r.date, (dailyCostMap.get(r.date) || 0) + costObj.costUsd);
    dailySavingsMap.set(r.date, (dailySavingsMap.get(r.date) || 0) + costObj.savingsUsd);
  }

  const dailyMap = new Map();
  for (const r of rawDaily) {
    const prompt = r.prompt_tokens || 0;
    const completion = r.completion_tokens || 0;
    const cached = r.cached_tokens || 0;
    const total = r.total_tokens || 0;
    const pBase = Math.max(prompt, cached);
    const hitRate = pBase > 0 ? Math.round((cached / pBase) * 1000) / 10 : 0;
    const costUsd = Math.round((dailyCostMap.get(r.date) || 0) * 10000) / 10000;
    const savingsUsd = Math.round((dailySavingsMap.get(r.date) || 0) * 10000) / 10000;
    const reqs = r.requests || 0;
    const succ = r.success_count || 0;
    const fail = r.failure_count || 0;
    const successRate = reqs > 0 ? Math.round((succ / reqs) * 1000) / 10 : 100;
    dailyMap.set(r.date, {
      date: r.date,
      requests: reqs,
      success_count: succ,
      failure_count: fail,
      success_rate: successRate,
      prompt_tokens: prompt,
      completion_tokens: completion,
      cached_tokens: cached,
      total_tokens: total,
      cache_hit_rate: hitRate,
      cost_usd: costUsd,
      savings_usd: savingsUsd
    });
  }

  // 2. 汇总今日落盘与内存实时 liveUsage，确保最新请求零延迟直观体现
  let todayTokens = 0;
  let todayRequests = 0;
  let todayPrompt = 0;
  let todayCompletion = 0;
  let todayCached = 0;
  let todaySuccess = 0;
  let todayFailure = 0;
  let todayCost = 0;
  let todaySavings = 0;

  for (const row of stmtDailyForDate.all(usageDate)) {
    if (isKeyFiltered && row.key_id !== targetKeyId) continue;
    todayTokens += row.total_tokens || 0;
    todayRequests += row.requests || 0;
    todayPrompt += row.prompt_tokens || 0;
    todayCompletion += row.completion_tokens || 0;
    todayCached += row.cached_tokens || 0;
    todaySuccess += row.success_count || 0;
    todayFailure += row.failure_count || 0;
    const costObj = calculateModelCost(row.model, row.prompt_tokens || 0, row.completion_tokens || 0, row.cached_tokens || 0);
    todayCost += costObj.costUsd;
    todaySavings += costObj.savingsUsd;
  }

  // 整理内存中尚未落盘的 liveUsage 今日增量
  const liveUsageTodayModels = new Map();
  for (const [bucket, agg] of liveUsage) {
    if (bucket.startsWith(`${usageDate}|`)) {
      const parts = bucket.split('|');
      const bKeyId = Number(parts[1]);
      const bModel = parts[2] || 'default';
      if (isKeyFiltered && bKeyId !== targetKeyId) continue;
      todayTokens += agg.total_tokens || 0;
      todayRequests += agg.requests || 0;
      todayPrompt += agg.prompt_tokens || 0;
      todayCompletion += agg.completion_tokens || 0;
      todayCached += agg.cached_tokens || 0;
      todaySuccess += agg.requests || 0;
      const costObj = calculateModelCost(bModel, agg.prompt_tokens || 0, agg.completion_tokens || 0, agg.cached_tokens || 0);
      todayCost += costObj.costUsd;
      todaySavings += costObj.savingsUsd;

      if (!liveUsageTodayModels.has(bModel)) {
        liveUsageTodayModels.set(bModel, { prompt: 0, completion: 0, cached: 0, total: 0, requests: 0 });
      }
      const lm = liveUsageTodayModels.get(bModel);
      lm.prompt += agg.prompt_tokens || 0;
      lm.completion += agg.completion_tokens || 0;
      lm.cached += agg.cached_tokens || 0;
      lm.total += agg.total_tokens || 0;
      lm.requests += agg.requests || 0;
    }
  }

  todayCost = Math.round(todayCost * 10000) / 10000;
  todaySavings = Math.round(todaySavings * 10000) / 10000;
  const todayPBase = Math.max(todayPrompt, todayCached);
  const todayHitRate = todayPBase > 0 ? Math.round((todayCached / todayPBase) * 1000) / 10 : 0;
  const todaySuccessRate = todayRequests > 0 ? Math.round((todaySuccess / todayRequests) * 1000) / 10 : 100;

  // 将今日完整用量（落盘+内存增量）同步更新至 dailyMap[usageDate]
  if (todayTokens > 0 || todayRequests > 0) {
    dailyMap.set(usageDate, {
      date: usageDate,
      requests: todayRequests,
      success_count: todaySuccess,
      failure_count: todayFailure,
      success_rate: todaySuccessRate,
      prompt_tokens: todayPrompt,
      completion_tokens: todayCompletion,
      cached_tokens: todayCached,
      total_tokens: todayTokens,
      cache_hit_rate: todayHitRate,
      cost_usd: todayCost,
      savings_usd: todaySavings
    });
  }

  const daily = Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));

  // 3. 构建全量模型矩阵（合并今日 liveUsage 增量，不设截断限制）
  const modelMap = new Map();
  for (const r of rawModels) {
    modelMap.set(r.model, {
      model: r.model,
      requests: r.requests || 0,
      success_count: r.success_count || 0,
      failure_count: r.failure_count || 0,
      prompt_tokens: r.prompt_tokens || 0,
      completion_tokens: r.completion_tokens || 0,
      cached_tokens: r.cached_tokens || 0,
      total_tokens: r.total_tokens || 0
    });
  }
  for (const [mName, mStats] of liveUsageTodayModels) {
    if (!modelMap.has(mName)) {
      modelMap.set(mName, {
        model: mName,
        requests: mStats.requests,
        success_count: mStats.requests,
        failure_count: 0,
        prompt_tokens: mStats.prompt,
        completion_tokens: mStats.completion,
        cached_tokens: mStats.cached,
        total_tokens: mStats.total
      });
    } else {
      const existing = modelMap.get(mName);
      existing.requests += mStats.requests;
      existing.success_count += mStats.requests;
      existing.prompt_tokens += mStats.prompt;
      existing.completion_tokens += mStats.completion;
      existing.cached_tokens += mStats.cached;
      existing.total_tokens += mStats.total;
    }
  }

  // 4. 基于真实请求凭证 (auth_index -> resolveEventAuthInfo) 权威聚合 AI 提供商分布
  // 杜绝使用模型名正则浅层猜测，彻底避免带有 -free 等特化模型被 OpenCode Zen 抢夺冒领
  let rawEventAggs = [];
  if (isAllTime) {
    rawEventAggs = isKeyFiltered
      ? stmtAuthEventsModelAggByKey.all(targetKeyId)
      : stmtAuthEventsModelAgg.all();
  } else {
    rawEventAggs = isKeyFiltered
      ? stmtAuthEventsModelAggSinceByKey.all(sinceTimestamp, targetKeyId)
      : stmtAuthEventsModelAggSince.all(sinceTimestamp);
  }

  // 聚合内存与 outbox 中尚未落入 request_events 的实时事件
  const inflightAggMap = new Map(); // key: `${auth_index}|${model}`
  const outboxRows = getOutboxSnapshot() || [];
  const unwrittenEvents = [...outboxRows, ...pendingEvents];

  for (const ev of unwrittenEvents) {
    if (isKeyFiltered && ev.key_id !== targetKeyId) continue;
    if (!isAllTime && ev.ts < sinceTimestamp) continue;
    const authIdx = String(ev.auth_index || '').trim();
    const mdl = String(ev.model || 'unknown').toLowerCase();
    const aggKey = `${authIdx}|${mdl}`;
    let item = inflightAggMap.get(aggKey);
    if (!item) {
      item = {
        auth_index: authIdx,
        model: mdl,
        requests: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
        cached_tokens: 0,
        total_tokens: 0
      };
      inflightAggMap.set(aggKey, item);
    }
    item.requests += 1;
    item.prompt_tokens += ev.prompt_tokens || 0;
    item.completion_tokens += ev.completion_tokens || 0;
    item.cached_tokens += ev.cached_tokens || 0;
    item.total_tokens += ev.total_tokens || 0;
  }

  // 合并 DB request_events 统计与实时未落盘事件
  const combinedEventMap = new Map(); // key: `${auth_index}|${model}`
  for (const r of rawEventAggs) {
    const authIdx = String(r.auth_index || '').trim();
    const mdl = String(r.model || 'unknown').toLowerCase();
    const key = `${authIdx}|${mdl}`;
    combinedEventMap.set(key, {
      auth_index: authIdx,
      model: mdl,
      requests: Number(r.requests) || 0,
      prompt_tokens: Number(r.prompt_tokens) || 0,
      completion_tokens: Number(r.completion_tokens) || 0,
      cached_tokens: Number(r.cached_tokens) || 0,
      total_tokens: Number(r.total_tokens) || 0
    });
  }
  for (const [key, inflight] of inflightAggMap) {
    const existing = combinedEventMap.get(key);
    if (existing) {
      existing.requests += inflight.requests;
      existing.prompt_tokens += inflight.prompt_tokens;
      existing.completion_tokens += inflight.completion_tokens;
      existing.cached_tokens += inflight.cached_tokens;
      existing.total_tokens += inflight.total_tokens;
    } else {
      combinedEventMap.set(key, { ...inflight });
    }
  }

  let eventsTotalTokens = 0;
  const modelEventTotals = new Map();
  const modelDominantProvider = new Map(); // model -> { provKey, provLabel, tokens }

  for (const item of combinedEventMap.values()) {
    eventsTotalTokens += item.total_tokens;
    modelEventTotals.set(item.model, (modelEventTotals.get(item.model) || 0) + item.total_tokens);

    // 计算各模型对应的优势提供商（以最高 token 贡献为准）
    const authInfo = resolveEventAuthInfo(item.auth_index, item.model);
    const provKey = authInfo.provider || inferProvider({ model: item.model, authIndex: item.auth_index }).key || UNKNOWN_PROVIDER_KEY;
    const provLabel = getProviderLabel(provKey) || (provKey === UNKNOWN_PROVIDER_KEY ? '其他上游' : provKey);
    const prevDominant = modelDominantProvider.get(item.model);
    if (!prevDominant || item.total_tokens > prevDominant.tokens) {
      modelDominantProvider.set(item.model, { provKey, provLabel, tokens: item.total_tokens });
    }
  }

  // 计算区间总 tokens 用于计算占比
  const rawModelList = Array.from(modelMap.values()).filter(m => m.total_tokens > 0 || m.requests > 0);
  const periodTotalTokens = rawModelList.reduce((acc, m) => acc + (m.total_tokens || 0), 0);

  const models = rawModelList
    .sort((a, b) => (b.total_tokens || 0) - (a.total_tokens || 0))
    .map(m => {
      const costObj = calculateModelCost(m.model, m.prompt_tokens, m.completion_tokens, m.cached_tokens);
      const pBase = Math.max(m.prompt_tokens, m.cached_tokens);
      const hitRate = pBase > 0 ? Math.round((m.cached_tokens / pBase) * 1000) / 10 : 0;
      const successRate = m.requests > 0 ? Math.round((m.success_count / m.requests) * 1000) / 10 : 100;
      const pct = periodTotalTokens > 0 ? Math.round((m.total_tokens / periodTotalTokens) * 1000) / 10 : 0;
      const dominant = modelDominantProvider.get(m.model);
      return {
        model: m.model,
        provider: dominant ? dominant.provLabel : inferModelProvider(m.model),
        requests: m.requests,
        success_count: m.success_count,
        failure_count: m.failure_count,
        success_rate: successRate,
        prompt_tokens: m.prompt_tokens,
        completion_tokens: m.completion_tokens,
        cached_tokens: m.cached_tokens,
        total_tokens: m.total_tokens,
        tokens_percent: pct,
        cache_hit_rate: hitRate,
        cost_usd: costObj.costUsd,
        savings_usd: costObj.savingsUsd
      };
    });

  // 构建提供商聚合分布 (Provider Breakdown)
  const providerMap = new Map();

  function getOrCreateProviderStat(provKey, provLabel) {
    if (!providerMap.has(provKey)) {
      providerMap.set(provKey, {
        provider: provKey,
        display_name: provLabel,
        requests: 0,
        total_tokens: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
        cached_tokens: 0,
        cost_usd: 0,
        savings_usd: 0,
        models_set: new Set()
      });
    }
    return providerMap.get(provKey);
  }

  if (eventsTotalTokens === 0) {
    // 降级兜底路径：测试环境或历史无 request_events 记录时，基于 models 推断聚合
    for (const m of models) {
      const inferred = inferProvider({ model: m.model });
      const provKey = inferred.key || UNKNOWN_PROVIDER_KEY;
      const provLabel = inferred.label || getProviderLabel(provKey) || '其他模型';
      const pStat = getOrCreateProviderStat(provKey, provLabel);
      pStat.requests += m.requests;
      pStat.total_tokens += m.total_tokens;
      pStat.prompt_tokens += m.prompt_tokens;
      pStat.completion_tokens += m.completion_tokens;
      pStat.cached_tokens += m.cached_tokens;
      pStat.cost_usd += m.cost_usd;
      pStat.savings_usd += m.savings_usd;
      pStat.models_set.add(m.model);
    }
  } else {
    // 权威凭证路径：逐条基于真实 (auth_index, model) 对应提供商进行精准累加
    for (const item of combinedEventMap.values()) {
      const authInfo = resolveEventAuthInfo(item.auth_index, item.model);
      const provKey = authInfo.provider || inferProvider({ model: item.model, authIndex: item.auth_index }).key || UNKNOWN_PROVIDER_KEY;
      const provLabel = getProviderLabel(provKey) || (provKey === UNKNOWN_PROVIDER_KEY ? '其他上游' : provKey);
      const pStat = getOrCreateProviderStat(provKey, provLabel);

      pStat.requests += item.requests;
      pStat.total_tokens += item.total_tokens;
      pStat.prompt_tokens += item.prompt_tokens;
      pStat.completion_tokens += item.completion_tokens;
      pStat.cached_tokens += item.cached_tokens;

      const costObj = calculateModelCost(item.model, item.prompt_tokens, item.completion_tokens, item.cached_tokens);
      pStat.cost_usd += costObj.costUsd;
      pStat.savings_usd += costObj.savingsUsd;
      pStat.models_set.add(item.model);
    }

    // 对账补差 (Reconciliation): 若部分历史 tokens 在 request_events 中被 prune 裁决或未记录，
    // 补齐差额，确保提供商分布的 tokens 综合完全等于 periodTotalTokens
    for (const m of models) {
      const accountedTokens = modelEventTotals.get(m.model) || 0;
      if (m.total_tokens > accountedTokens) {
        const diffTokens = m.total_tokens - accountedTokens;
        const ratio = accountedTokens > 0 ? (accountedTokens / m.total_tokens) : 0;
        const diffPrompt = Math.max(0, m.prompt_tokens - Math.round(m.prompt_tokens * ratio));
        const diffCompletion = Math.max(0, m.completion_tokens - Math.round(m.completion_tokens * ratio));
        const diffCached = Math.max(0, m.cached_tokens - Math.round(m.cached_tokens * ratio));
        const diffRequests = Math.max(0, m.requests - Math.round(m.requests * ratio));

        const dominant = modelDominantProvider.get(m.model);
        let provKey, provLabel;
        if (dominant) {
          provKey = dominant.provKey;
          provLabel = dominant.provLabel;
        } else {
          const inferred = inferProvider({ model: m.model });
          provKey = inferred.key || UNKNOWN_PROVIDER_KEY;
          provLabel = inferred.label || getProviderLabel(provKey) || '其他模型';
        }

        const pStat = getOrCreateProviderStat(provKey, provLabel);
        pStat.requests += diffRequests;
        pStat.total_tokens += diffTokens;
        pStat.prompt_tokens += diffPrompt;
        pStat.completion_tokens += diffCompletion;
        pStat.cached_tokens += diffCached;

        const costObj = calculateModelCost(m.model, diffPrompt, diffCompletion, diffCached);
        pStat.cost_usd += costObj.costUsd;
        pStat.savings_usd += costObj.savingsUsd;
        pStat.models_set.add(m.model);
      }
    }
  }

  const providers = Array.from(providerMap.values())
    .sort((a, b) => b.total_tokens - a.total_tokens)
    .map(p => {
      const pBase = Math.max(p.prompt_tokens, p.cached_tokens);
      const hitRate = pBase > 0 ? Math.round((p.cached_tokens / pBase) * 1000) / 10 : 0;
      return {
        provider: p.provider,
        display_name: p.display_name,
        requests: p.requests,
        total_tokens: p.total_tokens,
        prompt_tokens: p.prompt_tokens,
        completion_tokens: p.completion_tokens,
        cached_tokens: p.cached_tokens,
        models_count: p.models_set ? p.models_set.size : (p.models_count || 0),
        cost_usd: Math.round(p.cost_usd * 10000) / 10000,
        savings_usd: Math.round(p.savings_usd * 10000) / 10000,
        cache_hit_rate: hitRate,
        tokens_percent: periodTotalTokens > 0 ? Math.round((p.total_tokens / periodTotalTokens) * 1000) / 10 : 0,
        avg_tokens_per_request: p.requests > 0 ? Math.round(p.total_tokens / p.requests) : 0
      };
    });

  // 4.1 汇总选定区间指标 (根据 7D/14D/30D/全部 动态聚合)
  let periodTokens = 0;
  let periodRequests = 0;
  let periodPrompt = 0;
  let periodCompletion = 0;
  let periodCached = 0;
  let periodSuccess = 0;
  let periodFailure = 0;
  let periodCost = 0;
  let periodSavings = 0;

  for (const day of dailyMap.values()) {
    periodTokens += day.total_tokens || 0;
    periodRequests += day.requests || 0;
    periodPrompt += day.prompt_tokens || 0;
    periodCompletion += day.completion_tokens || 0;
    periodCached += day.cached_tokens || 0;
    periodSuccess += day.success_count || 0;
    periodFailure += day.failure_count || 0;
    periodCost += day.cost_usd || 0;
    periodSavings += day.savings_usd || 0;
  }
  periodCost = Math.round(periodCost * 10000) / 10000;
  periodSavings = Math.round(periodSavings * 10000) / 10000;
  const periodPBase = Math.max(periodPrompt, periodCached);
  const periodHitRate = periodPBase > 0 ? Math.round((periodCached / periodPBase) * 1000) / 10 : 0;
  const periodSuccessRate = periodRequests > 0 ? Math.round((periodSuccess / periodRequests) * 1000) / 10 : 100;

  // 4.2 当选择「今日 (1D)」时，精确聚合 24 小时每小时时段用量 (00:00 - 23:00)
  const hourly = [];
  if (dayCount === 1 && !isAllTime) {
    if (pendingEvents.length > 0) {
      try { flushUsage(); } catch {}
    }
    const todayStartTs = Math.floor(new Date(`${usageDate}T00:00:00+08:00`).getTime() / 1000);
    const todayEndTs = todayStartTs + 86400;

    const hourlyQuery = isKeyFiltered
      ? `SELECT strftime('%H', datetime(ts, 'unixepoch', '+8 hours')) AS hr, model,
           SUM(prompt_tokens) AS prompt_tokens,
           SUM(completion_tokens) AS completion_tokens,
           SUM(cached_tokens) AS cached_tokens,
           SUM(total_tokens) AS total_tokens,
           COUNT(*) AS requests,
           SUM(CASE WHEN status >= 200 AND status < 400 THEN 1 ELSE 0 END) AS success_count,
           SUM(CASE WHEN status >= 400 OR status = 0 THEN 1 ELSE 0 END) AS failure_count
         FROM request_events
         WHERE ts >= ? AND ts < ? AND key_id = ?
         GROUP BY hr, model`
      : `SELECT strftime('%H', datetime(ts, 'unixepoch', '+8 hours')) AS hr, model,
           SUM(prompt_tokens) AS prompt_tokens,
           SUM(completion_tokens) AS completion_tokens,
           SUM(cached_tokens) AS cached_tokens,
           SUM(total_tokens) AS total_tokens,
           COUNT(*) AS requests,
           SUM(CASE WHEN status >= 200 AND status < 400 THEN 1 ELSE 0 END) AS success_count,
           SUM(CASE WHEN status >= 400 OR status = 0 THEN 1 ELSE 0 END) AS failure_count
         FROM request_events
         WHERE ts >= ? AND ts < ?
         GROUP BY hr, model`;

    const args = isKeyFiltered ? [todayStartTs, todayEndTs, targetKeyId] : [todayStartTs, todayEndTs];
    const rows = quotaDb.prepare(hourlyQuery).all(...args);

    const hourMap = new Map();
    for (let h = 0; h < 24; h++) {
      const hStr = String(h).padStart(2, '0');
      hourMap.set(hStr, {
        hour: `${hStr}:00`,
        date: `${hStr}:00`,
        requests: 0,
        success_count: 0,
        failure_count: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
        cached_tokens: 0,
        total_tokens: 0,
        cost_usd: 0,
        savings_usd: 0,
        cache_hit_rate: 0
      });
    }

    for (const r of rows) {
      const bucket = hourMap.get(r.hr);
      if (bucket) {
        bucket.requests += r.requests || 0;
        bucket.success_count += r.success_count || 0;
        bucket.failure_count += r.failure_count || 0;
        bucket.prompt_tokens += r.prompt_tokens || 0;
        bucket.completion_tokens += r.completion_tokens || 0;
        bucket.cached_tokens += r.cached_tokens || 0;
        bucket.total_tokens += r.total_tokens || 0;
        const costObj = calculateModelCost(r.model, r.prompt_tokens || 0, r.completion_tokens || 0, r.cached_tokens || 0);
        bucket.cost_usd += costObj.costUsd;
        bucket.savings_usd += costObj.savingsUsd;
      }
    }

    // 累加内存 liveUsage 中今日未落盘增量（若有）
    const nowHr = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false }).format(new Date()).padStart(2, '0').slice(0, 2);
    for (const [bucketKey, agg] of liveUsage) {
      if (bucketKey.startsWith(`${usageDate}|`)) {
        const parts = bucketKey.split('|');
        const bKeyId = Number(parts[1]);
        const bModel = parts[2] || 'default';
        if (isKeyFiltered && bKeyId !== targetKeyId) continue;
        const curBucket = hourMap.get(nowHr);
        if (curBucket) {
          curBucket.requests += agg.requests || 0;
          curBucket.success_count += agg.requests || 0;
          curBucket.prompt_tokens += agg.prompt_tokens || 0;
          curBucket.completion_tokens += agg.completion_tokens || 0;
          curBucket.cached_tokens += agg.cached_tokens || 0;
          curBucket.total_tokens += agg.total_tokens || 0;
          const costObj = calculateModelCost(bModel, agg.prompt_tokens || 0, agg.completion_tokens || 0, agg.cached_tokens || 0);
          curBucket.cost_usd += costObj.costUsd;
          curBucket.savings_usd += costObj.savingsUsd;
        }
      }
    }

    for (let h = 0; h < 24; h++) {
      const hStr = String(h).padStart(2, '0');
      const b = hourMap.get(hStr);
      b.cost_usd = Math.round(b.cost_usd * 10000) / 10000;
      b.savings_usd = Math.round(b.savings_usd * 10000) / 10000;
      const pBase = Math.max(b.prompt_tokens, b.cached_tokens);
      b.cache_hit_rate = pBase > 0 ? Math.round((b.cached_tokens / pBase) * 1000) / 10 : 0;
      hourly.push(b);
    }
  }

  // 5. 全量历史总计 (All-time metrics)
  const allTimeRow = isKeyFiltered
    ? stmtDailyAllTimeByKey.get(targetKeyId)
    : stmtDailyAllTime.get();

  let allTimeTokens = (allTimeRow?.total_tokens || 0);
  let allTimeRequests = (allTimeRow?.requests || 0);
  let allTimePrompt = (allTimeRow?.prompt_tokens || 0);
  let allTimeCompletion = (allTimeRow?.completion_tokens || 0);
  let allTimeCached = (allTimeRow?.cached_tokens || 0);
  let allTimeSuccess = (allTimeRow?.success_count || 0);
  let allTimeFailure = (allTimeRow?.failure_count || 0);

  // 累加今日内存未落盘用量
  for (const [bucket, agg] of liveUsage) {
    const parts = bucket.split('|');
    const bKeyId = Number(parts[1]);
    if (isKeyFiltered && bKeyId !== targetKeyId) continue;
    allTimeTokens += agg.total_tokens || 0;
    allTimeRequests += agg.requests || 0;
    allTimePrompt += agg.prompt_tokens || 0;
    allTimeCompletion += agg.completion_tokens || 0;
    allTimeCached += agg.cached_tokens || 0;
    allTimeSuccess += agg.requests || 0;
  }

  // 按模型精确折算全量历史成本与节省
  const modelAllTimeRows = isKeyFiltered
    ? stmtModelAllTimeByKey.all(targetKeyId)
    : stmtModelAllTime.all();
  let allTimeCost = 0;
  let allTimeSavings = 0;
  for (const r of modelAllTimeRows) {
    const costObj = calculateModelCost(r.model, r.prompt_tokens || 0, r.completion_tokens || 0, r.cached_tokens || 0);
    allTimeCost += costObj.costUsd;
    allTimeSavings += costObj.savingsUsd;
  }
  for (const [bucket, agg] of liveUsage) {
    const parts = bucket.split('|');
    const bKeyId = Number(parts[1]);
    const bModel = parts[2] || 'default';
    if (isKeyFiltered && bKeyId !== targetKeyId) continue;
    const costObj = calculateModelCost(bModel, agg.prompt_tokens || 0, agg.completion_tokens || 0, agg.cached_tokens || 0);
    allTimeCost += costObj.costUsd;
    allTimeSavings += costObj.savingsUsd;
  }
  allTimeCost = Math.round(allTimeCost * 10000) / 10000;
  allTimeSavings = Math.round(allTimeSavings * 10000) / 10000;

  const allTimePBase = Math.max(allTimePrompt, allTimeCached);
  const allTimeHitRate = allTimePBase > 0 ? Math.round((allTimeCached / allTimePBase) * 1000) / 10 : 0;
  const allTimeSuccessRate = allTimeRequests > 0 ? Math.round((allTimeSuccess / allTimeRequests) * 1000) / 10 : 100;

  const adminSnapshot = getAdminData();
  const blocked = adminSnapshot.keys.filter(k => k.is_blocked).length;
  const warned = adminSnapshot.keys.filter(k => !k.is_blocked && k.enabled && k.daily_limit > 0 && k.usage_percent >= 85).length;
  const activeKeys = adminSnapshot.keys.filter(k => k.active !== false).length;

  const summary = {
    // 选定区间指标 (根据 7D/14D/30D/全部 动态聚合变化)
    period_days: days,
    period_tokens: isAllTime ? allTimeTokens : periodTokens,
    period_total_tokens: isAllTime ? allTimeTokens : periodTokens,
    period_requests: isAllTime ? allTimeRequests : periodRequests,
    period_prompt_tokens: isAllTime ? allTimePrompt : periodPrompt,
    period_completion_tokens: isAllTime ? allTimeCompletion : periodCompletion,
    period_cached_tokens: isAllTime ? allTimeCached : periodCached,
    period_cache_hit_rate: isAllTime ? allTimeHitRate : periodHitRate,
    period_cost_usd: isAllTime ? allTimeCost : periodCost,
    period_savings_usd: isAllTime ? allTimeSavings : periodSavings,
    period_success_count: isAllTime ? allTimeSuccess : periodSuccess,
    period_failure_count: isAllTime ? allTimeFailure : periodFailure,
    period_success_rate: isAllTime ? allTimeSuccessRate : periodSuccessRate,
    period_tokens_per_req: (isAllTime ? allTimeRequests : periodRequests) > 0
      ? Math.round((isAllTime ? allTimeTokens : periodTokens) / (isAllTime ? allTimeRequests : periodRequests))
      : 0,

    // 今日指标 (保持兼容)
    today_tokens: todayTokens,
    today_requests: todayRequests,
    today_success_count: todaySuccess,
    today_failure_count: todayFailure,
    today_success_rate: todaySuccessRate,
    today_prompt_tokens: todayPrompt,
    today_completion_tokens: todayCompletion,
    today_cached_tokens: todayCached,
    today_cache_hit_rate: todayHitRate,
    today_cost_usd: todayCost,
    today_savings_usd: todaySavings,
    today_tokens_per_req: todayRequests > 0 ? Math.round(todayTokens / todayRequests) : 0,

    // 全量历史指标
    all_time_tokens: allTimeTokens,
    all_time_requests: allTimeRequests,
    all_time_prompt_tokens: allTimePrompt,
    all_time_completion_tokens: allTimeCompletion,
    all_time_cached_tokens: allTimeCached,
    all_time_success_count: allTimeSuccess,
    all_time_failure_count: allTimeFailure,
    all_time_cost_usd: allTimeCost,
    all_time_savings_usd: allTimeSavings,
    all_time_cache_hit_rate: allTimeHitRate,
    all_time_success_rate: allTimeSuccessRate,
    all_time_tokens_per_req: allTimeRequests > 0 ? Math.round(allTimeTokens / allTimeRequests) : 0,

    blocked_keys: blocked,
    warned_keys: warned,
    active_keys: activeKeys,

    // 默认对外统计值：如果是区间查询，则对应区间统计；向前兼容
    total_tokens: isAllTime ? allTimeTokens : periodTokens,
    requests: isAllTime ? allTimeRequests : periodRequests,
    cost_usd: isAllTime ? allTimeCost : periodCost,
    savings_usd: isAllTime ? allTimeSavings : periodSavings,
    prompt_tokens: isAllTime ? allTimePrompt : periodPrompt,
    completion_tokens: isAllTime ? allTimeCompletion : periodCompletion,
    cached_tokens: isAllTime ? allTimeCached : periodCached,
    cache_hit_rate: isAllTime ? allTimeHitRate : periodHitRate,
    success_rate: isAllTime ? allTimeSuccessRate : periodSuccessRate
  };

  return {
    daily,
    hourly,
    models,
    providers,
    today: summary,
    summary
  };
}

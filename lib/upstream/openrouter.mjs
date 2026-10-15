import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_AUTH_PRIORITY,
  DEFAULT_AUTH_WEIGHT
} from '../config.mjs';

export const OPENROUTER_DAILY_LIMIT = 800;
const FETCH_TIMEOUT_MS = 15_000;

function toNum(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

export function formatResetCountdown(targetTime) {
  if (!targetTime) return '';
  const now = Date.now();
  const target = typeof targetTime === 'number' ? targetTime : new Date(targetTime).getTime();
  const diff = target - now;
  if (diff <= 0) return '刚刚重置';
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  if (hours > 24) {
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return `${days}天${remHours}小时`;
  }
  return `${hours}小时${mins}分`;
}

export function getNextUtcMidnight(nowDate = new Date()) {
  const nextMidnightMs = Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), nowDate.getUTCDate() + 1);
  return {
    ms: nextMidnightMs,
    iso: new Date(nextMidnightMs).toISOString(),
    countdown: formatResetCountdown(nextMidnightMs)
  };
}

export function getOpenRouterAccountsPath() {
  if (process.env.GATE_OPENROUTER_ACCOUNTS_PATH) return process.env.GATE_OPENROUTER_ACCOUNTS_PATH;
  if (process.env.OPENROUTER_ACCOUNTS_PATH) return process.env.OPENROUTER_ACCOUNTS_PATH;

  const candidates = [
    path.resolve(process.cwd(), '../openrouter-monitor/data/accounts.json'),
    path.resolve(process.cwd(), './data/openrouter-accounts.json'),
    path.resolve(process.cwd(), './data/accounts.json')
  ];

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
}

export function loadOpenRouterAccountsConfig() {
  const filePath = getOpenRouterAccountsPath();
  if (!fs.existsSync(filePath)) {
    return { version: 1, accounts: [] };
  }
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(content);
    return {
      version: data.version || 1,
      accounts: Array.isArray(data.accounts) ? data.accounts : []
    };
  } catch (err) {
    console.error('[OpenRouter] Failed to load accounts file:', err.message);
    return { version: 1, accounts: [] };
  }
}

export async function fetchTodayRequestCount(mgmtKey, nowDate = new Date(), fetchImpl = globalThis.fetch) {
  if (!mgmtKey) return 0;
  const doFetch = fetchImpl || globalThis.fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);

  const startMs = Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), nowDate.getUTCDate());
  const endMs = startMs + 86_400_000;

  try {
    const res = await doFetch('https://openrouter.ai/api/v1/analytics/query', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${mgmtKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        metrics: ['request_count'],
        granularity: 'day',
        time_range: { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() },
        limit: 10
      }),
      signal: ctrl.signal
    });

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) throw new Error('管理密钥无效或无权限');
      if (res.status === 429) throw new Error('触发限流，稍后重试');
      throw new Error(`OpenRouter 返回 HTTP ${res.status}`);
    }

    const body = await res.json();
    const rows = body?.data?.data || [];
    if (!Array.isArray(rows) || rows.length === 0) return 0;

    let total = 0;
    for (const r of rows) {
      const n = Number(r?.request_count);
      if (Number.isFinite(n) && n >= 0) total += n;
    }
    return Math.round(total);
  } catch (err) {
    if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      throw new Error('OpenRouter 请求超时 (15 秒无响应)');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchKeyInfo(apiKey, fetchImpl = globalThis.fetch) {
  if (!apiKey) return null;
  const doFetch = fetchImpl || globalThis.fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await doFetch('https://openrouter.ai/api/v1/key', {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: ctrl.signal
    });

    if (!res.ok) {
      if (res.status === 401) throw new Error('API key 无效或已撤销');
      if (res.status === 429) throw new Error('触发限流，稍后重试');
      throw new Error(`OpenRouter 返回 HTTP ${res.status}`);
    }

    const body = await res.json();
    const d = body?.data || body || {};
    return {
      usageDaily: toNum(d.usage_daily),
      usageWeekly: toNum(d.usage_weekly),
      usageMonthly: toNum(d.usage_monthly),
      usageTotal: toNum(d.usage_total) ?? toNum(d.usage),
      limitRemaining: toNum(d.limit_remaining),
      limit: toNum(d.limit),
      limitReset: d.limit_reset || null,
      isFreeTier: Boolean(d.is_free_tier)
    };
  } catch (err) {
    if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      throw new Error('OpenRouter Key 查询超时');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// 内存缓存每个账号的最新额度数据
const openrouterMemoryCache = new Map();
let lastSyncTimestamp = 0;
const CACHE_TTL_MS = 30_000;

export async function syncOpenRouterAccounts({ force = false, fetchImpl = globalThis.fetch } = {}) {
  const now = Date.now();
  const config = loadOpenRouterAccountsConfig();
  const accounts = config.accounts || [];
  if (accounts.length === 0) return [];

  const shouldPoll = force || (now - lastSyncTimestamp > CACHE_TTL_MS);
  const nextMidnight = getNextUtcMidnight();

  const results = [];
  for (const acc of accounts) {
    const accId = String(acc.id || acc.name);
    const cached = openrouterMemoryCache.get(accId);

    let todayRequests = cached?.today_requests ?? 0;
    let rawError = cached?.raw_error ?? null;
    let lastChecked = cached?.updated_at ?? null;

    if (shouldPoll && acc.mgmtKey) {
      try {
        todayRequests = await fetchTodayRequestCount(acc.mgmtKey, new Date(), fetchImpl);
        rawError = null;
        lastChecked = Date.now();
      } catch (err) {
        console.warn(`[OpenRouter] Failed to poll today count for ${acc.name || accId}:`, err.message);
        rawError = err.message;
      }
    }

    const remainingRequests = Math.max(0, OPENROUTER_DAILY_LIMIT - todayRequests);

    const memoryItem = {
      id: accId,
      name: acc.name || accId,
      today_requests: todayRequests,
      daily_limit: OPENROUTER_DAILY_LIMIT,
      remaining_requests: remainingRequests,
      reset_time: nextMidnight.iso,
      reset_countdown: nextMidnight.countdown,
      raw_error: rawError,
      updated_at: lastChecked || Date.now()
    };
    openrouterMemoryCache.set(accId, memoryItem);

    const safeEmail = acc.name || `OpenRouter #${accId}`;
    const filename = `openrouter-${acc.name || accId}.json`;
    const authIndex = `openrouter-${accId}`;

    results.push({
      id: accId,
      filename,
      email: safeEmail,
      provider: 'openrouter',
      status: 'active',
      disabled: false,
      health: { blocked: false, label: '正常', detail: '正常可用' },
      priority: acc.priority != null ? Number(acc.priority) : DEFAULT_AUTH_PRIORITY,
      weight: acc.weight != null ? Number(acc.weight) : DEFAULT_AUTH_WEIGHT,
      note: typeof acc.note === 'string' ? acc.note : '',
      auth_index: authIndex,
      plan_type: 'free',
      plan_name: 'Free',
      subscription_until: null,
      groups: [],
      today_requests: todayRequests,
      daily_limit: OPENROUTER_DAILY_LIMIT,
      remaining_requests: remainingRequests,
      reset_time: nextMidnight.iso,
      reset_countdown: nextMidnight.countdown,
      raw_error: rawError,
      updated_at: memoryItem.updated_at
    });
  }

  if (shouldPoll) {
    lastSyncTimestamp = Date.now();
  }

  return results;
}

export async function probeOpenRouterAccount(identifier, { fetchImpl = globalThis.fetch } = {}) {
  const config = loadOpenRouterAccountsConfig();
  const targetId = String(identifier || '').trim();
  const target = (config.accounts || []).find(a =>
    String(a.id) === targetId ||
    a.name === targetId ||
    `openrouter-${a.id}` === targetId ||
    `openrouter-${a.name}` === targetId ||
    `openrouter-${a.name}.json` === targetId ||
    `openrouter-${a.id}.json` === targetId
  );

  if (!target) {
    throw Object.assign(new Error(`未找到 OpenRouter 凭证 [${identifier}]`), { statusCode: 404 });
  }

  const nextMidnight = getNextUtcMidnight();
  let todayCount = 0;
  if (target.mgmtKey) {
    todayCount = await fetchTodayRequestCount(target.mgmtKey, new Date(), fetchImpl);
  }

  const remaining = Math.max(0, OPENROUTER_DAILY_LIMIT - todayCount);
  const data = {
    today_requests: todayCount,
    daily_limit: OPENROUTER_DAILY_LIMIT,
    remaining_requests: remaining,
    reset_time: nextMidnight.iso,
    reset_countdown: nextMidnight.countdown
  };

  openrouterMemoryCache.set(String(target.id || target.name), {
    ...data,
    raw_error: null,
    updated_at: Date.now()
  });

  return {
    status_code: 200,
    data
  };
}

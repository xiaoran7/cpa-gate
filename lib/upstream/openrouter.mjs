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

  // 优先级 1: Gate 自身独立持久化数据文件
  const localPrimary = path.resolve(process.cwd(), './data/openrouter-accounts.json');
  if (fs.existsSync(localPrimary)) return localPrimary;

  // 优先级 2: 如果本地主文件不存在，检查是否有 openrouter-monitor 历史外部项目，执行一次性平滑迁移
  const externalLegacy = path.resolve(process.cwd(), '../openrouter-monitor/data/accounts.json');
  if (fs.existsSync(externalLegacy)) {
    try {
      const dir = path.dirname(localPrimary);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(externalLegacy, localPrimary);
      console.log('[OpenRouter] 成功自动将 openrouter-monitor 账号数据迁移至 Gate 本地 data/openrouter-accounts.json');
      return localPrimary;
    } catch (e) {
      console.warn('[OpenRouter] 自动迁移 openrouter-monitor 账号失败，临时回退读取:', e.message);
      return externalLegacy;
    }
  }

  return localPrimary;
}

export function saveOpenRouterAccountsConfig(configData) {
  const filePath = getOpenRouterAccountsPath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const tempPath = `${filePath}.tmp.${Date.now()}`;
  fs.writeFileSync(tempPath, JSON.stringify(configData, null, 2), 'utf8');
  fs.renameSync(tempPath, filePath);

  lastSyncTimestamp = 0;
  return true;
}

export function maskSecret(str) {
  if (!str || typeof str !== 'string') return '';
  const s = str.trim();
  if (s.length <= 10) return '***';
  return `${s.slice(0, 8)}...${s.slice(-4)}`;
}

export function getOpenRouterAccountList() {
  const config = loadOpenRouterAccountsConfig();
  const accounts = config.accounts || [];
  return accounts.map(a => {
    const accId = String(a.id || a.name);
    const cached = openrouterMemoryCache.get(accId);
    return {
      id: accId,
      name: a.name || `OpenRouter #${accId}`,
      note: typeof a.note === 'string' ? a.note : '',
      enabled: a.enabled !== false,
      priority: a.priority != null ? Number(a.priority) : DEFAULT_AUTH_PRIORITY,
      weight: a.weight != null ? Number(a.weight) : DEFAULT_AUTH_WEIGHT,
      hasApiKey: Boolean(a.apiKey && a.apiKey.trim()),
      apiKeyMasked: maskSecret(a.apiKey),
      hasMgmtKey: Boolean(a.mgmtKey && a.mgmtKey.trim()),
      mgmtKeyMasked: maskSecret(a.mgmtKey),
      today_requests: cached?.today_requests ?? null,
      raw_error: cached?.raw_error ?? null,
      updated_at: cached?.updated_at ?? null,
      createdAt: a.createdAt || null
    };
  });
}

export function addOpenRouterAccount({ name, note = '', apiKey = '', mgmtKey = '', priority = DEFAULT_AUTH_PRIORITY, weight = DEFAULT_AUTH_WEIGHT, enabled = true }) {
  const cleanName = String(name || '').trim();
  if (!cleanName) {
    throw Object.assign(new Error('账号名称不能为空'), { statusCode: 400 });
  }

  const config = loadOpenRouterAccountsConfig();
  const accounts = config.accounts || [];

  if (accounts.some(a => String(a.name).toLowerCase() === cleanName.toLowerCase())) {
    throw Object.assign(new Error(`账号名称 [${cleanName}] 已存在`), { statusCode: 409 });
  }

  let maxId = 0;
  for (const a of accounts) {
    const n = Number(a.id);
    if (Number.isFinite(n) && n > maxId) maxId = n;
  }
  const newId = String(maxId + 1);

  const newAcc = {
    id: newId,
    name: cleanName,
    note: String(note || ''),
    enabled: Boolean(enabled),
    priority: Number.isFinite(Number(priority)) ? Number(priority) : DEFAULT_AUTH_PRIORITY,
    weight: Number.isFinite(Number(weight)) ? Number(weight) : DEFAULT_AUTH_WEIGHT,
    apiKey: String(apiKey || '').trim(),
    mgmtKey: String(mgmtKey || '').trim(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  accounts.push(newAcc);
  config.seq = (config.seq || 0) + 1;
  config.accounts = accounts;
  saveOpenRouterAccountsConfig(config);

  return { success: true, account: newAcc };
}

export function updateOpenRouterAccount(id, updates = {}) {
  const targetId = String(id || '').trim();
  const config = loadOpenRouterAccountsConfig();
  const accounts = config.accounts || [];
  const idx = accounts.findIndex(a => String(a.id) === targetId || a.name === targetId);
  if (idx === -1) {
    throw Object.assign(new Error(`未找到 ID 为 [${id}] 的 OpenRouter 账号`), { statusCode: 404 });
  }

  const current = accounts[idx];
  if (updates.name && String(updates.name).trim()) {
    const cleanName = String(updates.name).trim();
    if (accounts.some((a, i) => i !== idx && String(a.name).toLowerCase() === cleanName.toLowerCase())) {
      throw Object.assign(new Error(`账号名称 [${cleanName}] 已存在`), { statusCode: 409 });
    }
    current.name = cleanName;
  }

  if (updates.note !== undefined) current.note = String(updates.note || '');
  if (updates.enabled !== undefined) current.enabled = Boolean(updates.enabled);
  if (updates.priority !== undefined) current.priority = Number(updates.priority);
  if (updates.weight !== undefined) current.weight = Number(updates.weight);

  // 仅在明确传入非空字符串时更新密钥，否则保留原密钥
  if (typeof updates.apiKey === 'string' && updates.apiKey.trim() !== '') {
    current.apiKey = updates.apiKey.trim();
  }
  if (typeof updates.mgmtKey === 'string' && updates.mgmtKey.trim() !== '') {
    current.mgmtKey = updates.mgmtKey.trim();
  }

  current.updatedAt = new Date().toISOString();
  accounts[idx] = current;
  config.accounts = accounts;
  saveOpenRouterAccountsConfig(config);

  // 刷新该账号的内存缓存
  openrouterMemoryCache.delete(targetId);
  openrouterMemoryCache.delete(current.name);

  return { success: true, account: current };
}

export function deleteOpenRouterAccount(id) {
  const targetId = String(id || '').trim();
  const config = loadOpenRouterAccountsConfig();
  const accounts = config.accounts || [];
  const idx = accounts.findIndex(a => String(a.id) === targetId || a.name === targetId);
  if (idx === -1) {
    throw Object.assign(new Error(`未找到 ID 为 [${id}] 的 OpenRouter 账号`), { statusCode: 404 });
  }

  const removed = accounts.splice(idx, 1)[0];
  config.accounts = accounts;
  saveOpenRouterAccountsConfig(config);

  openrouterMemoryCache.delete(targetId);
  openrouterMemoryCache.delete(removed.name);

  return { success: true, removed_id: targetId };
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
      apiKey: acc.apiKey || '',
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

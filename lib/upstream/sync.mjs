import { cpaRequest } from '../core/key-registry.mjs';
import { extractValidationUrl } from '../../validation-url.mjs';
import {
  recordUpstreamValidation,
  resolveUpstreamValidationByAuth,
  getPendingUpstreamValidations
} from './validation-store.mjs';
import { stmtQuotaSnapshotInsert, stmtQuotaSnapshotsByAuth, stmtUpstreamDailyAggSince } from '../db/sqlite.mjs';
import { getAuthHealth, setCooldownObservedAt } from './auth-health.mjs';
import { registerCpaProvider } from '../core/provider-registry.mjs';
import { syncOpenRouterAccounts, probeOpenRouterAccount } from './openrouter.mjs';
import {
  DEFAULT_AUTH_PRIORITY,
  DEFAULT_AUTH_WEIGHT,
  AUTH_PRIORITY_MIN,
  AUTH_PRIORITY_MAX,
  AUTH_WEIGHT_MIN,
  AUTH_WEIGHT_MAX
} from '../config.mjs';
import { clearAuditLogsCache } from '../analytics/audit-logs.mjs';

// Google Antigravity 官方客户端 User-Agent（与官方 CLI 1.3.6 对齐，服务端要求 >= 1.2.0 方返回 Gemini 模型组）
export const ANTIGRAVITY_USER_AGENT = 'antigravity/cli/1.3.6 (aidev_client; os_type=darwin; arch=arm64)';

// Antigravity 配额查询多端点容灾列表（优先请求包含完整 Gemini 与 Claude 模型的端点）
export const ANTIGRAVITY_QUOTA_URLS = [
  'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
  'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
  'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary'
];

export const ANTIGRAVITY_BASE_URL = 'https://daily-cloudcode-pa.googleapis.com';

/**
 * 依据官方最佳实践，向上游查询 Antigravity 配额汇总，自动完成多端点容灾与 Gemini 组兜底
 */
export async function requestAntigravityQuotaSummary(authIndex, projectId = 'aicode-consumers') {
  const data = JSON.stringify({ project: projectId || 'aicode-consumers' });
  const header = {
    Authorization: 'Bearer $TOKEN$',
    'Content-Type': 'application/json',
    'User-Agent': ANTIGRAVITY_USER_AGENT
  };

  let lastResp = null;
  for (const url of ANTIGRAVITY_QUOTA_URLS) {
    try {
      const resp = await cpaRequest('POST', '/v0/management/api-call', {
        authIndex,
        method: 'POST',
        url,
        header,
        data
      });
      lastResp = resp;
      if (resp && resp.status_code === 200 && resp.body) {
        const body = typeof resp.body === 'string' ? JSON.parse(resp.body) : resp.body;
        const groups = parseAntigravityGroups(body);
        if (groups.length > 0) {
          const hasGemini = groups.some(g => (g.name || '').toLowerCase().includes('gemini'));
          // 只要端点返回了完整的 Gemini 组，或已是最后一个备用端点，直接返回该结果
          if (hasGemini || url === ANTIGRAVITY_QUOTA_URLS[ANTIGRAVITY_QUOTA_URLS.length - 1]) {
            return { resp, groups, body };
          }
        }
      } else if (resp && (resp.status_code === 401 || resp.status_code === 403)) {
        // 鉴权失败或需安全验证，无需轮询其他端点，立即返回外层拦截
        return { resp, groups: [], body: null };
      }
    } catch (err) {
      // 网络抖动时平滑尝试下一个备选端点
      continue;
    }
  }
  return { resp: lastResp, groups: [], body: null };
}

/**
 * 把 CPA 返回的 priority / weight 归一化到合法区间。
 * 关键点：0 是合法的 priority（管理台「P0 · 兜底」预设），因此必须先做 null/undefined
 * 与空串判空再取数值，绝不能用 `|| default`——那会在字符串形态下把显式的 "0" 吞成默认值。
 * CPA 当前以 JSON number 返回 priority，但归一化不依赖该假设。
 */
export function normalizeAuthPriority(value) {
  if (value === null || value === undefined || value === '') {
    return DEFAULT_AUTH_PRIORITY;
  }
  const n = typeof value === 'number' ? value : Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return DEFAULT_AUTH_PRIORITY;
  if (n < AUTH_PRIORITY_MIN || n > AUTH_PRIORITY_MAX) return DEFAULT_AUTH_PRIORITY;
  return Math.trunc(n);
}

export function normalizeAuthWeight(value) {
  if (value === null || value === undefined || value === '') {
    return DEFAULT_AUTH_WEIGHT;
  }
  const n = typeof value === 'number' ? value : Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return DEFAULT_AUTH_WEIGHT;
  if (n < AUTH_WEIGHT_MIN || n > AUTH_WEIGHT_MAX) return DEFAULT_AUTH_WEIGHT;
  return Math.trunc(n);
}

/**
 * 凭据排序：优先级降序；同优先级时按 auth_index 升序。
 * 生产 auth_index 是 16 进制串（如 11b5ad3947814b5f），数值分支不适用、退化为字典序，
 * 与旧行为等价；若 CPA 改用纯数字索引，则走数值比较避免 "1", "10", "2" 的错序。
 */
export function compareAuthAccounts(a, b) {
  const pDiff = normalizeAuthPriority(b.priority) - normalizeAuthPriority(a.priority);
  if (pDiff !== 0) return pDiff;
  return compareAuthIndex(a.auth_index, b.auth_index);
}

function compareAuthIndex(a, b) {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return String(a ?? '').localeCompare(String(b ?? ''));
}

export const cachedUpstreamQuotas = {
  accounts: [],
  last_updated: null,
  is_loading: false,
  error: null
};

export function recordQuotaSnapshot({ authIndex, provider, accountEmail, windowName, remainingPercent, resetAt }) {
  try {
    stmtQuotaSnapshotInsert.run({
      ts: Math.floor(Date.now() / 1000),
      auth_index: String(authIndex || '').trim().slice(0, 64),
      provider: String(provider || '').trim().slice(0, 64),
      account_email: String(accountEmail || '').trim().slice(0, 120),
      window_name: String(windowName || '').trim().slice(0, 80),
      remaining_percent: Math.max(0, Math.min(100, Number(remainingPercent) || 0)),
      reset_at: resetAt ? (typeof resetAt === 'number' ? Math.floor(resetAt / 1000) : Math.floor(new Date(resetAt).getTime() / 1000)) : null
    });
  } catch (err) {
    console.error('[Gate-Quota] Record quota snapshot error:', err.message);
  }
}

export function getQuotaSnapshots(authIndex, hours = 24) {
  const h = Math.min(Math.max(Number(hours) || 24, 1), 168);
  const minTs = Math.floor((Date.now() - h * 3600000) / 1000);
  const rows = stmtQuotaSnapshotsByAuth.all(String(authIndex), minTs);
  return {
    auth_index: authIndex,
    snapshots: rows.map(r => ({
      ts: r.ts * 1000,
      window_name: r.window_name,
      remaining_percent: r.remaining_percent,
      reset_at: r.reset_at ? r.reset_at * 1000 : null
    }))
  };
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

export function parseAntigravityGroups(body) {
  if (!body || !Array.isArray(body.groups)) return [];
  return body.groups.map(g => {
    const buckets = Array.isArray(g.buckets) ? g.buckets.map(b => {
      const remFrac = b.remainingFraction ?? b.remaining_fraction;
      if (typeof remFrac !== 'number' || !Number.isFinite(remFrac)) return null;
      const remPct = Math.floor(Math.max(0, Math.min(1, remFrac)) * 1000) / 10;
      const resetIso = b.resetTime || b.reset_time || '';
      const bucketId = b.bucketId || b.bucket_id || '';
      const is5h = bucketId.includes('5h') || b.window === '5h';
      const isFull5h = is5h && remPct >= 100;
      return {
        bucket_id: bucketId,
        window: b.window || (is5h ? '5h' : 'weekly'),
        name: b.displayName || b.display_name || '',
        remaining_percent: remPct,
        used_percent: Math.max(0, Math.round((100 - remPct) * 10) / 10),
        reset_time: isFull5h ? '' : resetIso,
        reset_countdown: isFull5h ? '满额就绪' : formatResetCountdown(resetIso)
      };
    }).filter(Boolean) : [];

    return {
      name: g.displayName || 'Model Group',
      description: g.description || '',
      buckets
    };
  });
}

export function parseCodexGroups(ubody) {
  if (!ubody) return [];
  const rl = ubody.rate_limit || {};
  const pw = rl.primary_window || {};
  const sw = rl.secondary_window || {};

  const pwUsed = Number.isFinite(pw.used_percent) ? pw.used_percent : null;
  const swUsed = Number.isFinite(sw.used_percent) ? sw.used_percent : null;
  const pwRem = pwUsed === null ? null : Math.max(0, 100 - pwUsed);
  const swRem = swUsed === null ? null : Math.max(0, 100 - swUsed);
  const pwResetMs = pw.reset_at ? pw.reset_at * 1000 : (pw.reset_after_seconds ? Date.now() + pw.reset_after_seconds * 1000 : null);
  const swResetMs = sw.reset_at ? sw.reset_at * 1000 : (sw.secondary_reset_after_seconds ? Date.now() + sw.secondary_reset_after_seconds * 1000 : null);

  const isFull5h = pwRem !== null && pwRem >= 100 && !pw.reset_at && !pw.reset_after_seconds;

  return [
    {
      name: 'Codex 限额窗口',
      description: 'OpenAI 官方速率限制窗口 (5小时与每周)',
      buckets: [
        ...(pwRem === null ? [] : [{
          bucket_id: 'codex-5h',
          window: '5h',
          name: '5 小时限额',
          remaining_percent: pwRem,
          used_percent: pwUsed,
          reset_time: isFull5h ? '' : (pwResetMs ? new Date(pwResetMs).toISOString() : ''),
          reset_countdown: isFull5h ? '满额就绪' : formatResetCountdown(pwResetMs)
        }]),
        ...(swRem === null ? [] : [{
          bucket_id: 'codex-weekly',
          window: 'weekly',
          name: '周限额',
          remaining_percent: swRem,
          used_percent: swUsed,
          reset_time: swResetMs ? new Date(swResetMs).toISOString() : '',
          reset_countdown: formatResetCountdown(swResetMs)
        }])
      ]
    }
  ];
}

/**
 * 防御性归一化东八区时间字符串：若无时区后缀，则追加 +08:00，杜绝跨时区容器解析漂移
 */
export function normalizeCstTimeString(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return '';
  const s = timeStr.trim();
  if (/(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(s)) {
    return s;
  }
  return s.replace(' ', 'T') + '+08:00';
}

/**
 * 将东八区时间字符串安全解析为毫秒时间戳
 */
export function parseCstDateToTimestamp(timeStr) {
  if (!timeStr) return null;
  try {
    const norm = normalizeCstTimeString(String(timeStr));
    const d = new Date(norm);
    return isNaN(d.getTime()) ? null : d.getTime();
  } catch (_) {
    return null;
  }
}

export function parseWorkBuddyGroups(summaryBody, options = {}) {
  if (!summaryBody) return [];
  const dataObj = summaryBody.data || summaryBody;
  const pkgs = Array.isArray(dataObj.Packages)
    ? dataObj.Packages
    : (Array.isArray(summaryBody.Packages) ? summaryBody.Packages : []);
  if (pkgs.length === 0) return [];

  const defaultResetTime = options.reset_time || '';
  const defaultExpiresAt = options.expires_at || '';
  const packageExpirations = Array.isArray(options.packages) ? options.packages : [];

  const buckets = pkgs.map((pkg, idx) => {
    const total = Number(pkg.CycleTotalCapacity) || 0;
    const remain = Number(pkg.CycleRemainCapacity) || 0;
    const used = Number(pkg.CycleUsedCapacity) || 0;
    const remPct = total > 0 ? Math.max(0, Math.min(100, Math.round((remain / total) * 1000) / 10)) : (remain > 0 ? 100 : 0);
    const usedPct = total > 0 ? Math.max(0, Math.min(100, Math.round((used / total) * 1000) / 10)) : 0;
    const pkgName = pkg.PackageName || pkg.PackageCode || '标准积分包';

    const matchedExp = packageExpirations.find(p => p.package_code === pkg.PackageCode);

    // 提取单个资源包的截至到期时间（优先包自身，其次匹配明细包，最后兜底顶层 options）
    let pkgExpiresAt = pkg.CycleEndTime || pkg.ExpiredTime || matchedExp?.expires_at || defaultExpiresAt || '';
    let pkgResetTime = pkg.reset_time || matchedExp?.reset_time || '';
    if (!pkgResetTime && (pkg.DeductionEndTime || matchedExp?.end_ms)) {
      try {
        const d = new Date(Number(pkg.DeductionEndTime || matchedExp?.end_ms));
        if (!isNaN(d.getTime())) pkgResetTime = d.toISOString();
      } catch (_) {}
    }
    if (!pkgResetTime && pkgExpiresAt) {
      const ts = parseCstDateToTimestamp(pkgExpiresAt);
      if (ts) pkgResetTime = new Date(ts).toISOString();
    }
    if (!pkgResetTime) pkgResetTime = defaultResetTime;

    let countdownText = options.reset_countdown || '';
    if (!countdownText) {
      if (pkgExpiresAt) {
        countdownText = `截至 ${pkgExpiresAt.slice(5, 16)}`;
      } else {
        countdownText = `剩余 ${remain.toLocaleString()} 积分`;
      }
    }

    return {
      bucket_id: `workbuddy-pkg-${idx}`,
      package_code: pkg.PackageCode || '',
      window: 'cycle',
      name: pkgName,
      unit: pkg.CapacityUnit || 'credits',
      total_capacity: total,
      remain_capacity: remain,
      used_capacity: used,
      remaining_percent: remPct,
      used_percent: usedPct,
      reset_time: pkgResetTime,
      expires_at: pkgExpiresAt,
      reset_countdown: countdownText
    };
  });

  return [
    {
      name: 'WorkBuddy 资源包额度',
      description: '腾讯 WorkBuddy 周期资源包与剩余积分汇总',
      buckets
    }
  ];
}

/**
 * 查询腾讯 WorkBuddy / CodeBuddy 资源包准确截至到期时间（分页查询 get-user-resource-free-packages）
 * 支持多资源包不同到期时间与分批到期汇总导出
 */
export async function queryWorkBuddyFreePackages(cpaRequest, authIndex, baseUrl, domain, pkgs) {
  if (!Array.isArray(pkgs) || pkgs.length === 0) return null;
  const pkgCodes = pkgs.map(p => p.PackageCode).filter(Boolean);
  if (pkgCodes.length === 0) return null;

  try {
    const freePkgResp = await cpaRequest('POST', '/v0/management/api-call', {
      authIndex,
      method: 'POST',
      url: `${baseUrl}/billing/meter/get-user-resource-free-packages`,
      header: {
        Authorization: 'Bearer $TOKEN$',
        'Content-Type': 'application/json',
        'User-Agent': 'WorkBuddy/5.5.6 WorkBuddy AI/5.5.6 CLI/5.5.6',
        'X-Domain': domain,
        'X-Product': 'SaaS',
        'X-IDE-Type': 'WorkBuddy'
      },
      data: JSON.stringify({
        PageNumber: 1,
        PageSize: 50,
        PackageCodes: pkgCodes
      })
    });
    if (freePkgResp && freePkgResp.status_code === 200 && freePkgResp.body) {
      const freeBody = typeof freePkgResp.body === 'string' ? JSON.parse(freePkgResp.body) : freePkgResp.body;
      const accountsList = freeBody?.data?.Accounts || freeBody?.Accounts || [];
      let earliestEndMs = Infinity;
      let earliestEndCst = '';
      let earliestPoints = 0;
      const packageList = [];
      const seenPkgCodes = new Set();

      for (const accItem of accountsList) {
        if (!accItem?.PackageCode) continue;
        seenPkgCodes.add(accItem.PackageCode);
        const matchedPkg = pkgs.find(p => p.PackageCode === accItem.PackageCode);
        if (matchedPkg) {
          matchedPkg.CycleEndTime = accItem.CycleEndTime || matchedPkg.CycleEndTime;
          matchedPkg.DeductionEndTime = accItem.DeductionEndTime || matchedPkg.DeductionEndTime;
        }
        let endMs = null;
        if (accItem.DeductionEndTime) {
          endMs = Number(accItem.DeductionEndTime);
        } else if (accItem.CycleEndTime) {
          endMs = parseCstDateToTimestamp(accItem.CycleEndTime);
        }
        const rawRemCap = accItem.CycleCapacityRemain != null && accItem.CycleCapacityRemain !== ''
          ? Number(accItem.CycleCapacityRemain)
          : (accItem.CapacityRemain != null && accItem.CapacityRemain !== ''
              ? Number(accItem.CapacityRemain)
              : (matchedPkg?.CycleRemainCapacity != null && matchedPkg.CycleRemainCapacity !== '' ? Number(matchedPkg.CycleRemainCapacity) : null));
        const remCap = (rawRemCap != null && !isNaN(rawRemCap)) ? rawRemCap : 0;
        const rawTotalCap = matchedPkg?.CycleTotalCapacity != null && matchedPkg.CycleTotalCapacity !== ''
          ? Number(matchedPkg.CycleTotalCapacity)
          : (accItem.CycleCapacityTotal != null && accItem.CycleCapacityTotal !== ''
              ? Number(accItem.CycleCapacityTotal)
              : (accItem.CapacityTotal != null && accItem.CapacityTotal !== '' ? Number(accItem.CapacityTotal) : remCap));
        const totalCap = (rawTotalCap != null && !isNaN(rawTotalCap)) ? rawTotalCap : remCap;
        const pkgName = matchedPkg?.PackageName || accItem.PackageName || accItem.PackageCode || '标准积分包';

        if (endMs && !isNaN(endMs) && endMs < earliestEndMs && remCap > 0) {
          earliestEndMs = endMs;
          earliestEndCst = accItem.CycleEndTime || '';
          earliestPoints = remCap;
        }

        packageList.push({
          package_code: accItem.PackageCode,
          package_name: pkgName,
          remain_points: remCap,
          total_points: totalCap,
          expires_at: accItem.CycleEndTime || '',
          reset_time: endMs && !isNaN(endMs) ? new Date(endMs).toISOString() : null,
          end_ms: endMs && !isNaN(endMs) ? endMs : null
        });
      }

      // 补充可能未在 Accounts 列表中返回的汇总包
      for (const p of pkgs) {
        if (!p?.PackageCode || seenPkgCodes.has(p.PackageCode)) continue;
        const remCap = Number(p.CycleRemainCapacity) || 0;
        const totalCap = Number(p.CycleTotalCapacity) || 0;
        let endMs = null;
        if (p.DeductionEndTime) {
          endMs = Number(p.DeductionEndTime);
        } else if (p.CycleEndTime) {
          endMs = parseCstDateToTimestamp(p.CycleEndTime);
        }
        if (endMs && !isNaN(endMs) && endMs < earliestEndMs && remCap > 0) {
          earliestEndMs = endMs;
          earliestEndCst = p.CycleEndTime || '';
          earliestPoints = remCap;
        }
        packageList.push({
          package_code: p.PackageCode,
          package_name: p.PackageName || p.PackageCode || '标准积分包',
          remain_points: remCap,
          total_points: totalCap,
          expires_at: p.CycleEndTime || '',
          reset_time: endMs && !isNaN(endMs) ? new Date(endMs).toISOString() : null,
          end_ms: endMs && !isNaN(endMs) ? endMs : null
        });
      }

      // 按到期时间由近及远升序排列（无到期时间的排末尾）
      packageList.sort((a, b) => {
        if (a.end_ms && b.end_ms) return a.end_ms - b.end_ms;
        if (a.end_ms) return -1;
        if (b.end_ms) return 1;
        return 0;
      });

      // 如果全部包 remCap 为 0，但有 endMs，也可兜底最早到期时间
      if (earliestEndMs === Infinity && packageList.length > 0) {
        const firstWithEnd = packageList.find(p => p.end_ms != null);
        if (firstWithEnd) {
          earliestEndMs = firstWithEnd.end_ms;
          earliestEndCst = firstWithEnd.expires_at;
          earliestPoints = firstWithEnd.remain_points;
        }
      }

      if (packageList.length > 0) {
        return {
          expiresAt: earliestEndCst,
          runsOutAt: earliestEndMs < Infinity ? new Date(earliestEndMs).toISOString() : null,
          runsOutPoints: earliestPoints,
          packages: packageList
        };
      }
    }
  } catch (_) {
    // 明细包查询静默降级，不阻断主汇总数据
  }
  return null;
}

/**
 * 判断字符串是否为通用提供商名称或占位符（如 workbuddy-cn、antigravity、other 等）
 */
export function isGenericProviderIdentifier(str, provider = '') {
  if (!str) return true;
  const s = String(str).toLowerCase().trim().replace(/[-_.\s()]/g, '');
  if (!s) return true;
  const prov = String(provider || '').toLowerCase().trim().replace(/[-_.\s()]/g, '');
  if (prov && (s === prov || s === `${prov}cn` || s === `${prov}intl` || s === `${prov}global` || s === `${prov}default` || s === `${prov}api`)) {
    return true;
  }
  const genericBases = [
    'workbuddy',
    'codebuddy',
    'copilottencent',
    'tencent',
    'antigravity',
    'codex',
    'openai',
    'claude',
    'anthropic',
    'openrouter',
    'opencode',
    'gemini',
    'google',
    'stepfun',
    'unknown',
    'other'
  ];
  for (const base of genericBases) {
    if (s === base || s === `${base}cn` || s === `${base}intl` || s === `${base}global` || s === `${base}default` || s === `${base}api`) {
      return true;
    }
  }
  return false;
}

/**
 * 将 CPA 凭证文件对象解析为直观可读的账号展示名（友好别名优先）
 * 解决流水/管理面板中将 WorkBuddy 或重命名账号误显为原始磁盘 JSON 文件名的问题
 */
export function resolveAuthAccountDisplayName(file, provider = '') {
  if (!file || typeof file !== 'object') return '';
  const nickname = typeof file.nickname === 'string'
    ? file.nickname.trim()
    : (typeof file.nick_name === 'string' ? file.nick_name.trim() : '');
  const rawEmail = typeof file.email === 'string' ? file.email.trim() : '';
  const rawLabel = typeof file.label === 'string' ? file.label.trim() : '';
  const filename = typeof file.name === 'string'
    ? file.name.trim()
    : (typeof file.id === 'string' ? file.id.trim() : '');
  const authIndex = file.auth_index || file.authIndex || '';

  let extractedLabelNick = '';
  if (rawLabel) {
    const m = rawLabel.match(/\(([^()]+)\)\s*$/);
    if (m && !['cn', 'intl', 'global', 'default', 'api'].includes(m[1].toLowerCase().trim())) {
      extractedLabelNick = m[1].trim();
    }
  }

  const effectiveNick = nickname || extractedLabelNick;
  const cleanFilename = filename.replace(/\.json$/i, '');
  const validEmail = (!isGenericProviderIdentifier(rawEmail, provider) && rawEmail !== cleanFilename) ? rawEmail : '';
  const customLabel = (!isGenericProviderIdentifier(rawLabel, provider) && rawLabel !== cleanFilename) ? rawLabel : '';

  if (effectiveNick) return effectiveNick;
  if (validEmail) return validEmail;
  if (customLabel) return customLabel;
  if (cleanFilename) return cleanFilename;
  return String(authIndex || '');
}

let inFlightSyncPromise = null;

export async function syncUpstreamQuotas(force = false) {
  const now = Date.now();
  // 缓存 30 秒，避免频繁请求上游封控
  if (!force && cachedUpstreamQuotas.last_updated && now - cachedUpstreamQuotas.last_updated < 30000) {
    return cachedUpstreamQuotas;
  }
  if (inFlightSyncPromise) {
    return inFlightSyncPromise;
  }

  inFlightSyncPromise = (async () => {
    cachedUpstreamQuotas.is_loading = true;
    try {
      let files = [];
      try {
        const authFilesResp = await cpaRequest('GET', '/v0/management/auth-files');
        files = Array.isArray(authFilesResp?.files) ? authFilesResp.files : [];
        // 本次响应就是 CPA 观察冷却的时刻，auth-files 的冷却剩余需以此为基准衰减。
        setCooldownObservedAt(Date.now());
      } catch (cpaErr) {
        console.warn('[Gate-Quota] CPA auth-files warning:', cpaErr.message);
      }

      let compatProviders = [];
      try {
        const compatResp = await cpaRequest('GET', '/v0/management/openai-compatibility');
        compatProviders = Array.isArray(compatResp?.['openai-compatibility'])
          ? compatResp['openai-compatibility']
          : (Array.isArray(compatResp) ? compatResp : []);
      } catch (cpaCompatErr) {
        console.warn('[Gate-Quota] CPA openai-compatibility warning:', cpaCompatErr.message);
      }
      const accounts = [];

    for (const f of files) {
      const authIndex = f.auth_index || f.authIndex;
      const provider = (f.provider || f.type || 'unknown').toLowerCase();
      const filename = f.name || f.id || '';
      const nickname = typeof f.nickname === 'string'
        ? f.nickname.trim()
        : (typeof f.nick_name === 'string' ? f.nick_name.trim() : '');
      const displayName = resolveAuthAccountDisplayName(f, provider);
      const rawEmail = typeof f.email === 'string' ? f.email.trim() : '';
      const isGenericEmail = !rawEmail || isGenericProviderIdentifier(rawEmail, provider);
      const effectiveEmail = isGenericEmail
        ? (displayName || rawEmail || f.label || filename)
        : rawEmail;
      const disabled = Boolean(f.disabled || f.status === 'disabled');
      const status = f.status || (disabled ? 'disabled' : 'active');
      const health = getAuthHealth(f);
      const priority = normalizeAuthPriority(f.priority);
      const weight = normalizeAuthWeight(f.weight);
      const note = typeof f.note === 'string' ? f.note : '';

      const acc = {
        id: filename,
        filename,
        display_name: displayName,
        nickname,
        email: effectiveEmail,
        provider,
        status,
        disabled,
        health,
        priority,
        weight,
        note,
        auth_index: String(authIndex || ''),
        plan_type: 'free',
        plan_name: '免费版',
        subscription_until: null,
        groups: [],
        raw_error: null,
        updated_at: Date.now()
      };

      if (health.blocked) {
        accounts.push(acc);
        continue;
      }

      if (provider === 'antigravity') {
        const projectId = f.project_id || 'aicode-consumers';
        try {
          // 1. Quota Summary（通过官方 1.3.6 UA 与多端点容灾获取 Gemini 与 Claude 配额）
          const { resp: quotaResp, groups: parsedGroups } = await requestAntigravityQuotaSummary(authIndex, projectId);

          if (parsedGroups.length > 0) {
            acc.groups = parsedGroups;
            // 验证成功恢复：若之前有 pending 验证记录，自动标记为已解决
            resolveUpstreamValidationByAuth(authIndex);
            acc.raw_error = null;
          } else if (quotaResp && quotaResp.status_code === 401) {
            acc.raw_error = 'Google 认证失败 (HTTP 401)：凭据未授权或 Token 已失效，请重新生成授权文件';
          } else if (quotaResp && (quotaResp.status_code === 403 || String(quotaResp.body).includes('VALIDATION_REQUIRED') || String(quotaResp.body).includes('Verify your account'))) {
            // 自动拦截 Antigravity 403 账号验证
            const rawBodyStr = typeof quotaResp.body === 'string' ? quotaResp.body : JSON.stringify(quotaResp.body || {});
            const valUrl = extractValidationUrl(rawBodyStr);
            console.warn(`[Gate-Quota] Intercepted 403 validation during quota inspection for ${acc.email || authIndex}`);
            recordUpstreamValidation({
              authIndex,
              provider: 'antigravity',
              accountName: acc.email || '',
              validationUrl: valUrl,
              errorMessage: 'Verify your account to continue.',
              rawError: rawBodyStr,
              allowMissingUrl: true
            });
            acc.raw_error = 'Google Antigravity 安全验证要求：需在浏览器打开验证链接';
          } else if (quotaResp && quotaResp.status_code !== 200) {
            acc.raw_error = `上游额度查询异常 (HTTP ${quotaResp?.status_code || '未知'})`;
          }

          // 2. Plan / Tier
          const tierResp = await cpaRequest('POST', '/v0/management/api-call', {
            authIndex,
            method: 'POST',
            url: `${ANTIGRAVITY_BASE_URL}/v1internal:loadCodeAssist`,
            header: {
              Authorization: 'Bearer $TOKEN$',
              'Content-Type': 'application/json',
              'User-Agent': ANTIGRAVITY_USER_AGENT
            },
            data: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } })
          });

          if (tierResp && tierResp.status_code === 200 && tierResp.body) {
            const tbody = typeof tierResp.body === 'string' ? JSON.parse(tierResp.body) : tierResp.body;
            const paid = tbody.paidTier || {};
            const curr = tbody.currentTier || {};
            const tierId = paid.id || curr.id || '';
            const tierName = paid.name || curr.name || 'Free';
            acc.plan_name = tierName;
            if (tierId.includes('pro')) acc.plan_type = 'pro';
            else if (tierId.includes('ultra')) acc.plan_type = 'ultra';
            else acc.plan_type = 'free';
          } else if (tierResp && (tierResp.status_code === 403 || String(tierResp.body).includes('VALIDATION_REQUIRED') || String(tierResp.body).includes('Verify your account'))) {
            const rawBodyStr = typeof tierResp.body === 'string' ? tierResp.body : JSON.stringify(tierResp.body || {});
            const valUrl = extractValidationUrl(rawBodyStr);
            console.warn(`[Gate-Quota] Intercepted 403 validation during tier inspection for ${acc.email || authIndex}`);
            recordUpstreamValidation({
              authIndex,
              provider: 'antigravity',
              accountName: acc.email || '',
              validationUrl: valUrl,
              errorMessage: 'Verify your account to continue.',
              rawError: rawBodyStr,
              allowMissingUrl: true
            });
            acc.raw_error = 'Google Antigravity 安全验证要求：需在浏览器打开验证链接';
          }
        } catch (err) {
          acc.raw_error = err.message;
        }
      } else if (provider === 'codex') {
        try {
          const accId = (f.id_token || {})['chatgpt_account_id'];
          const reqHeaders = {
            Authorization: 'Bearer $TOKEN$',
            'Content-Type': 'application/json',
            'User-Agent': 'codex-tui/0.149.1 (Mac OS 24.1.0; arm64)'
          };
          if (accId) reqHeaders['Chatgpt-Account-Id'] = accId;

          const usageResp = await cpaRequest('POST', '/v0/management/api-call', {
            authIndex,
            method: 'GET',
            url: 'https://chatgpt.com/backend-api/wham/usage',
            header: reqHeaders
          });

          if (usageResp && usageResp.status_code === 200 && usageResp.body) {
            const ubody = typeof usageResp.body === 'string' ? JSON.parse(usageResp.body) : usageResp.body;
            acc.plan_type = ubody.plan_type || 'plus';
            acc.plan_name = (acc.plan_type || 'Plus').toUpperCase();
            acc.subscription_until = (f.id_token || {})['chatgpt_subscription_active_until'] || null;
            acc.groups = parseCodexGroups(ubody);
          }
        } catch (err) {
          acc.raw_error = err.message;
        }
      } else if (provider === 'workbuddy' || provider === 'workbuddy-cn') {
        try {
          const isCN = provider === 'workbuddy-cn' || f.realm === 'cn';
          const baseUrl = isCN ? 'https://copilot.tencent.com' : 'https://www.workbuddy.ai';
          const domain = isCN ? 'www.codebuddy.cn' : 'www.workbuddy.ai';

          let quotaFetched = false;
          let expiresAt = null;
          let runsOutAt = null;
          let runsOutPoints = null;

          // 1. 优先尝试向 CPA /v0/management/quota/fetch 请求原生已计算的配额与到期时间
          try {
            const fetchResp = await cpaRequest('POST', '/v0/management/quota/fetch', { authIndex });
            if (fetchResp && (Array.isArray(fetchResp.summary) || Array.isArray(fetchResp.groups))) {
              const sumMap = new Map();
              if (Array.isArray(fetchResp.summary)) {
                for (const item of fetchResp.summary) {
                  if (item?.key) sumMap.set(item.key, item);
                }
              }
              const pRemain = sumMap.get('points_remain')?.value;
              const pTotal = sumMap.get('points_total')?.value;
              const pUsed = sumMap.get('points_used')?.value;
              const rPoints = sumMap.get('runs_out_points')?.value;
              const expAt = sumMap.get('expires_at')?.unit;
              const rOutAt = sumMap.get('runs_out_at')?.unit;

              if (pTotal != null || pRemain != null || expAt || rOutAt) {
                quotaFetched = true;
                acc.total_credits = pTotal != null ? Number(pTotal) : null;
                acc.remaining_credits = pRemain != null ? Number(pRemain) : null;
                acc.used_credits = pUsed != null ? Number(pUsed) : 0;
                acc.runs_out_points = rPoints != null ? Number(rPoints) : null;
                acc.expires_at = expAt || null;
                let normalizedResetTime = rOutAt || null;
                if (!normalizedResetTime && expAt) {
                  try {
                    const norm = String(expAt).includes('T') ? expAt : String(expAt).replace(' ', 'T') + '+08:00';
                    const d = new Date(norm);
                    if (!isNaN(d.getTime())) normalizedResetTime = d.toISOString();
                  } catch (_) {}
                }
                acc.reset_time = normalizedResetTime;
                expiresAt = acc.expires_at;
                runsOutAt = acc.reset_time;
                runsOutPoints = acc.runs_out_points;

                acc.credits_unit = 'credits';
                acc.plan_type = 'standard';
                acc.plan_name = provider === 'workbuddy-cn' ? 'CodeBuddy' : 'WorkBuddy';
                acc.raw_error = null;

                if (Array.isArray(fetchResp.groups) && fetchResp.groups.length > 0) {
                  acc.groups = fetchResp.groups.map(grp => ({
                    name: grp.displayName || 'WorkBuddy 资源包额度',
                    description: '腾讯 WorkBuddy 周期资源包与剩余积分汇总',
                    buckets: (grp.buckets || []).map((b, bIdx) => ({
                      bucket_id: `workbuddy-pkg-${bIdx}`,
                      window: b.window || 'cycle',
                      name: b.description || '标准积分包',
                      unit: 'credits',
                      total_capacity: acc.total_credits || 0,
                      remain_capacity: acc.remaining_credits || 0,
                      used_capacity: acc.used_credits || 0,
                      remaining_percent: Math.round((b.remainingFraction ?? 1) * 100),
                      used_percent: Math.round((1 - (b.remainingFraction ?? 1)) * 100),
                      reset_time: b.resetTime || runsOutAt || '',
                      expires_at: expiresAt || '',
                      reset_countdown: expiresAt ? `截至 ${expiresAt.slice(5, 16)}` : ''
                    }))
                  }));
                }
              }
            }
          } catch (_) {
            // CPA 原生 fetch 失败或未实现时，平滑回退至直连腾讯官方计费网关
          }

          // 2. 无论 CPA fetch 是否调用，查询 /billing/meter/get-user-resource-summary 以获取明细包列表
          const quotaResp = await cpaRequest('POST', '/v0/management/api-call', {
            authIndex,
            method: 'POST',
            url: `${baseUrl}/billing/meter/get-user-resource-summary`,
            header: {
              Authorization: 'Bearer $TOKEN$',
              'Content-Type': 'application/json',
              'User-Agent': 'WorkBuddy/5.5.6 WorkBuddy AI/5.5.6 CLI/5.5.6',
              'X-User-Id': f.user_id || '',
              'X-Domain': domain,
              'X-Product': 'SaaS',
              'X-IDE-Type': 'WorkBuddy'
            },
            data: JSON.stringify({})
          });

          if (quotaResp && quotaResp.status_code === 200 && quotaResp.body) {
            const qbody = typeof quotaResp.body === 'string' ? JSON.parse(quotaResp.body) : quotaResp.body;
            const dataObj = qbody?.data || qbody;
            const pkgs = Array.isArray(dataObj?.Packages)
              ? dataObj.Packages
              : (Array.isArray(qbody?.Packages) ? qbody.Packages : []);

            // 只要存在明细包，均查询 free-packages 以补充各明细包的精准到期时间与分批到期信息
            let freeInfo = null;
            if (pkgs.length > 0) {
              freeInfo = await queryWorkBuddyFreePackages(cpaRequest, authIndex, baseUrl, domain, pkgs);
              if (freeInfo) {
                if (freeInfo.expiresAt) expiresAt = freeInfo.expiresAt;
                if (freeInfo.runsOutAt) runsOutAt = freeInfo.runsOutAt;
                if (freeInfo.runsOutPoints != null) runsOutPoints = freeInfo.runsOutPoints;
                acc.expires_at = expiresAt;
                acc.reset_time = runsOutAt;
                acc.runs_out_points = runsOutPoints;
                if (Array.isArray(freeInfo.packages)) {
                  acc.expiration_packages = freeInfo.packages;
                }
              }
            }

            acc.groups = parseWorkBuddyGroups(qbody, {
              reset_time: runsOutAt || acc.reset_time,
              expires_at: expiresAt || acc.expires_at,
              runs_out_points: runsOutPoints || acc.runs_out_points,
              packages: freeInfo?.packages || acc.expiration_packages
            });

            // 汇总计算当前账号的总积分与剩余积分
            let totalCredits = 0;
            let remainCredits = 0;
            let usedCredits = 0;
            for (const p of pkgs) {
              totalCredits += Number(p.CycleTotalCapacity) || 0;
              remainCredits += Number(p.CycleRemainCapacity) || 0;
              usedCredits += Number(p.CycleUsedCapacity) || 0;
            }
            if (!quotaFetched) {
              acc.total_credits = totalCredits;
              acc.remaining_credits = remainCredits;
              acc.used_credits = usedCredits;
            }
            acc.credits_unit = 'credits';
            acc.plan_type = 'standard';
            acc.plan_name = provider === 'workbuddy-cn' ? 'CodeBuddy' : 'WorkBuddy';
            acc.raw_error = null;
          } else if (quotaResp && quotaResp.status_code !== 200 && !quotaFetched) {
            acc.plan_type = 'standard';
            acc.plan_name = provider === 'workbuddy-cn' ? 'CodeBuddy' : 'WorkBuddy';
            acc.raw_error = `WorkBuddy 配额查询异常 (HTTP ${quotaResp?.status_code || '未知'})`;
          }
        } catch (wbErr) {
          acc.plan_type = 'standard';
          acc.plan_name = provider === 'workbuddy-cn' ? 'CodeBuddy' : 'WorkBuddy';
          acc.raw_error = wbErr.message;
        }
      } else {
        // 其他 Provider（如 Claude 等）
        acc.plan_type = 'standard';
        acc.plan_name = '标准版';
      }

      // 采样配额时序快照至 quota_snapshots
      if (Array.isArray(acc.groups)) {
        for (const grp of acc.groups) {
          for (const bkt of grp.buckets || []) {
            if (typeof bkt.remaining_percent === 'number') {
              recordQuotaSnapshot({
                authIndex,
                provider,
                accountEmail: acc.email || acc.filename,
                windowName: `${grp.name} - ${bkt.name}`,
                remainingPercent: bkt.remaining_percent,
                resetAt: bkt.reset_time ? new Date(bkt.reset_time).getTime() : null
              });
            }
          }
        }
      }

      accounts.push(acc);
    }

    // 提取 CPA 原生 openai-compatibility 凭据（如 OpenCode、OpenRouter、StepFun 等）
    // CPA 为每个配置项生成了标准 16 位 16 进制 auth-index（例如 d4555aac3173ea13），
    // 必须完整纳入 accounts 目录，彻底杜绝被误判为「已删除账号」进入抽屉
    const compatKeyIndexMap = new Map();
    const openRouterEntriesFromCpa = [];

    for (const p of compatProviders) {
      const pName = (p.name || '').toLowerCase();
      const pDisabled = Boolean(p.disabled);
      const entries = Array.isArray(p['api-key-entries']) ? p['api-key-entries'] : [];

      for (const entry of entries) {
        const authIndex = String(entry['auth-index'] || entry.auth_index || '').trim();
        if (!authIndex) continue;
        const rawKey = String(entry['api-key'] || entry.apiKey || '').trim();
        if (rawKey) {
          compatKeyIndexMap.set(`${pName}:${rawKey}`, authIndex);
        }

        if (pName === 'openrouter') {
          openRouterEntriesFromCpa.push({ authIndex, rawKey, entry, p });
          continue;
        }

        const maskedKey = rawKey.length > 14
          ? `${rawKey.slice(0, 8)}...${rawKey.slice(-4)}`
          : (rawKey ? `${rawKey.slice(0, 4)}...` : authIndex.slice(0, 8));
        const filename = `${pName}-${maskedKey}.json`;
        const email = `${pName}-${maskedKey}`;
        const nick = typeof entry.nickname === 'string' ? entry.nickname.trim() : (typeof entry.nick_name === 'string' ? entry.nick_name.trim() : '');
        const customDisplayName = nick || (typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim() : email);
        const disabled = Boolean(pDisabled || entry.disabled);
        const status = disabled ? 'disabled' : 'active';
        const priority = normalizeAuthPriority(entry.priority ?? p.priority);
        const weight = normalizeAuthWeight(entry.weight ?? p.weight);
        const note = typeof entry.note === 'string' ? entry.note : (p.note || '');

        accounts.push({
          id: filename,
          filename,
          display_name: customDisplayName,
          nickname: nick,
          email,
          provider: pName,
          status,
          disabled,
          health: { blocked: false, label: disabled ? '已禁用' : '正常', detail: disabled ? '已在 CPA 禁用' : '正常可用' },
          priority,
          weight,
          note,
          auth_index: authIndex,
          plan_type: 'free',
          plan_name: pName === 'opencode' ? 'OpenCode' : (p.name || 'OpenAI-Compatible'),
          subscription_until: null,
          groups: [],
          today_requests: 0,
          today_tokens: 0,
          raw_error: null,
          updated_at: Date.now()
        });
      }
    }

    // 注入 OpenRouter 账号列表与今日调用次数（基于 openrouter-monitor 事实，每日 800 次纯数字呈现）
    try {
      const orAccounts = await syncOpenRouterAccounts({ force });
      const mergedCpaAuthIndexes = new Set();

      for (const orAcc of orAccounts) {
        // 关联 CPA 的 16 位真实 auth-index
        const cpaAuthIdx = compatKeyIndexMap.get(`openrouter:${orAcc.apiKey}`) ||
                           openRouterEntriesFromCpa.find(e => e.rawKey === orAcc.apiKey)?.authIndex;
        if (cpaAuthIdx) {
          mergedCpaAuthIndexes.add(cpaAuthIdx);
          orAcc.cpa_auth_index = cpaAuthIdx;
          orAcc.legacy_auth_index = orAcc.auth_index;
          orAcc.auth_index = cpaAuthIdx;
        }

        const existingIdx = accounts.findIndex(a =>
          a.auth_index === orAcc.auth_index ||
          a.filename === orAcc.filename ||
          (a.provider === 'openrouter' && (a.id === orAcc.id || a.email === orAcc.email))
        );
        if (existingIdx >= 0) {
          accounts[existingIdx] = {
            ...accounts[existingIdx],
            today_requests: orAcc.today_requests,
            daily_limit: orAcc.daily_limit,
            remaining_requests: orAcc.remaining_requests,
            reset_time: orAcc.reset_time,
            reset_countdown: orAcc.reset_countdown,
            plan_type: 'free',
            plan_name: 'Free (800次/日)',
            cpa_auth_index: orAcc.cpa_auth_index,
            legacy_auth_index: orAcc.legacy_auth_index
          };
        } else {
          accounts.push(orAcc);
        }
      }

      // 如果 CPA 中有额外配置但未纳入 openrouter-accounts.json 的 OpenRouter 凭证，也作为活跃账号纳入
      for (const extra of openRouterEntriesFromCpa) {
        if (!mergedCpaAuthIndexes.has(extra.authIndex)) {
          const maskedKey = extra.rawKey.length > 14
            ? `${extra.rawKey.slice(0, 8)}...${extra.rawKey.slice(-4)}`
            : (extra.rawKey ? `${extra.rawKey.slice(0, 4)}...` : extra.authIndex.slice(0, 8));
          const filename = `openrouter-${maskedKey}.json`;
          const email = `openrouter-${maskedKey}`;
          const nick = typeof extra.entry.nickname === 'string' ? extra.entry.nickname.trim() : (typeof extra.entry.nick_name === 'string' ? extra.entry.nick_name.trim() : '');
          const customDisplayName = nick || (typeof extra.entry.label === 'string' && extra.entry.label.trim() ? extra.entry.label.trim() : email);
          accounts.push({
            id: filename,
            filename,
            display_name: customDisplayName,
            nickname: nick,
            email,
            provider: 'openrouter',
            status: extra.p.disabled ? 'disabled' : 'active',
            disabled: Boolean(extra.p.disabled || extra.entry.disabled),
            health: { blocked: false, label: '正常', detail: '正常可用' },
            priority: normalizeAuthPriority(extra.entry.priority ?? extra.p.priority),
            weight: normalizeAuthWeight(extra.entry.weight ?? extra.p.weight),
            note: typeof extra.entry.note === 'string' ? extra.entry.note : '',
            auth_index: extra.authIndex,
            cpa_auth_index: extra.authIndex,
            plan_type: 'free',
            plan_name: 'OpenRouter',
            subscription_until: null,
            groups: [],
            today_requests: 0,
            today_tokens: 0,
            raw_error: null,
            updated_at: Date.now()
          });
        }
      }
    } catch (orErr) {
      console.warn('[Gate-Quota] syncOpenRouterAccounts warning:', orErr.message);
    }

    // 默认排序：优先级降序 (priority DESC)，相同时按 auth_index 升序
    accounts.sort(compareAuthAccounts);

    // 绑定 Gate 本地今日实时 Token 消耗与请求次数，使 OpenCode 等无官方 Quota API 的提供商具备实时用量展示
    const shanghaiToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
    let todayStatsMap = new Map();
    try {
      const todayRows = stmtUpstreamDailyAggSince.all(shanghaiToday);
      for (const r of todayRows) todayStatsMap.set(r.auth_index, r);
    } catch {}

    for (const acc of accounts) {
      const tStat = todayStatsMap.get(acc.auth_index);
      acc.today_tokens = tStat?.total_tokens || 0;
      // 如果账号本身已有确切来源的请求数（如 OpenRouter 同步返回的今日请求次数），优先保留；
      // 否则以 Gate 聚合的 todayStats requests 为准
      if (acc.provider === 'openrouter' && acc.today_requests != null && acc.today_requests > 0) {
        acc.today_requests = Number(acc.today_requests);
      } else {
        acc.today_requests = tStat?.requests || 0;
      }
    }

    // 把本次 CPA 观察到的 provider 登记进注册表：上游新增提供商时零改代码。
    // 只登记键与展示名，不据此推断任何账号归属。
    try {
      for (const acc of accounts) {
        if (acc.provider && acc.provider !== 'unknown') registerCpaProvider(acc.provider, acc.provider);
      }
    } catch (e) {
      console.error('[Gate-Quota] registerCpaProvider failed:', e.message);
    }

    cachedUpstreamQuotas.accounts = accounts;
    cachedUpstreamQuotas.last_updated = Date.now();
    cachedUpstreamQuotas.error = null;
    clearAuditLogsCache();
  } catch (err) {
    cachedUpstreamQuotas.error = err.message;
    console.error('[Gate-Quota] syncUpstreamQuotas error:', err.message);
  } finally {
    cachedUpstreamQuotas.is_loading = false;
    inFlightSyncPromise = null;
  }

  return cachedUpstreamQuotas;
  })();

  return inFlightSyncPromise;
}

export async function activateUpstreamQuotaWindow({ authIndex, filename, provider }) {
  const accounts = Array.isArray(cachedUpstreamQuotas.accounts) ? cachedUpstreamQuotas.accounts : [];
  let targetAcc = null;
  if (authIndex) {
    targetAcc = accounts.find(a => a.auth_index === authIndex);
  }
  if (!targetAcc && filename) {
    targetAcc = accounts.find(a => a.filename === filename || a.id === filename);
  }
  if (targetAcc?.health?.blocked) throw Object.assign(new Error(targetAcc.health.detail), { statusCode: 409 });

  const actAuthIndex = targetAcc?.auth_index || authIndex || '';
  const actProvider = (targetAcc?.provider || provider || '').toLowerCase();
  const actFilename = targetAcc?.filename || filename || '';

  if (!actAuthIndex && !actFilename) {
    const err = new Error('必须指定上游凭证 auth_index 或 filename');
    err.statusCode = 400;
    throw err;
  }

  let probeResult = null;
  try {
    if (actProvider === 'codex') {
      probeResult = await cpaRequest('POST', '/v0/management/api-call', {
        authIndex: actAuthIndex,
        method: 'GET',
        url: 'https://chatgpt.com/backend-api/wham/usage',
        header: {
          Authorization: 'Bearer $TOKEN$',
          'Content-Type': 'application/json',
          'User-Agent': 'codex-tui/0.149.1 (Mac OS 24.1.0; arm64)'
        }
      });
    } else if (actProvider === 'antigravity') {
      const authFilesResp = await cpaRequest('GET', '/v0/management/auth-files');
      const authFile = (authFilesResp?.files || []).find(file =>
        String(file.auth_index || file.authIndex || '') === actAuthIndex || file.name === actFilename);
      const projectId = authFile?.project_id || 'aicode-consumers';
      const quotaSummary = await requestAntigravityQuotaSummary(actAuthIndex, projectId);
      probeResult = quotaSummary.resp;
      if (quotaSummary.groups && quotaSummary.groups.length > 0) {
        probeResult = { ...(probeResult || {}), status_code: 200, body: quotaSummary.body, parsedGroups: quotaSummary.groups };
      }
    } else if (actProvider === 'openrouter') {
      const orProbe = await probeOpenRouterAccount(actAuthIndex || actFilename);
      probeResult = { status_code: 200, body: orProbe.data, message: 'OpenRouter 额度查询完成' };
    } else if (actProvider === 'workbuddy' || actProvider === 'workbuddy-cn') {
      const isCN = actProvider === 'workbuddy-cn';
      const baseUrl = isCN ? 'https://copilot.tencent.com' : 'https://www.workbuddy.ai';
      const domain = isCN ? 'www.codebuddy.cn' : 'www.workbuddy.ai';

      const [cpaQuotaResult, directProbeResult] = await Promise.allSettled([
        cpaRequest('POST', '/v0/management/quota/fetch', { authIndex: actAuthIndex }),
        cpaRequest('POST', '/v0/management/api-call', {
          authIndex: actAuthIndex,
          method: 'POST',
          url: `${baseUrl}/billing/meter/get-user-resource-summary`,
          header: {
            Authorization: 'Bearer $TOKEN$',
            'Content-Type': 'application/json',
            'User-Agent': 'WorkBuddy/5.5.6 WorkBuddy AI/5.5.6 CLI/5.5.6',
            'X-User-Id': '',
            'X-Domain': domain,
            'X-Product': 'SaaS',
            'X-IDE-Type': 'WorkBuddy'
          },
          data: JSON.stringify({})
        })
      ]);

      const cpaQuota = cpaQuotaResult.status === 'fulfilled' ? cpaQuotaResult.value : null;
      let rawProbe = directProbeResult.status === 'fulfilled' ? directProbeResult.value : null;

      if (!rawProbe || rawProbe.status_code !== 200) {
        if (cpaQuota && (Array.isArray(cpaQuota.summary) || Array.isArray(cpaQuota.groups))) {
          // CPA 配额获取成功，即使直连腾讯计费失败也可安全降级使用
          probeResult = {
            status_code: 200,
            body: { Packages: [] },
            cpaQuota,
            message: 'CPA 原生配额获取成功'
          };
        } else {
          probeResult = rawProbe || { status_code: 502, message: '上游接口请求失败' };
        }
      } else {
        probeResult = rawProbe;
        probeResult.cpaQuota = cpaQuota;
      }
    } else {
      probeResult = { status_code: 200, message: 'generic provider probe sent' };
    }
    if (!probeResult || probeResult.status_code !== 200) throw new Error(`上游额度查询失败（HTTP ${probeResult?.status_code || '未知'}）`);

    // 就地更新目标账号在内存缓存中的配额数据，避免等待慢速全局全量轮询
    if (probeResult.body && targetAcc) {
      try {
        const bodyObj = typeof probeResult.body === 'string' ? JSON.parse(probeResult.body) : probeResult.body;
        if (actProvider === 'antigravity') {
          const parsedGroups = parseAntigravityGroups(bodyObj);
          if (parsedGroups.length > 0) {
            targetAcc.groups = parsedGroups;
            targetAcc.updated_at = Date.now();
            targetAcc.raw_error = null;
            resolveUpstreamValidationByAuth(actAuthIndex);
            for (const grp of parsedGroups) {
              for (const bkt of grp.buckets || []) {
                if (typeof bkt.remaining_percent === 'number') {
                  recordQuotaSnapshot({
                    authIndex: actAuthIndex,
                    provider: 'antigravity',
                    accountEmail: targetAcc.email || targetAcc.filename,
                    windowName: `${grp.name} - ${bkt.name}`,
                    remainingPercent: bkt.remaining_percent,
                    resetAt: bkt.reset_time ? new Date(bkt.reset_time).getTime() : null
                  });
                }
              }
            }
          }
        } else if (actProvider === 'codex') {
          const parsedGroups = parseCodexGroups(bodyObj);
          if (parsedGroups.length > 0) {
            targetAcc.groups = parsedGroups;
            targetAcc.plan_type = bodyObj.plan_type || targetAcc.plan_type || 'plus';
            targetAcc.plan_name = (targetAcc.plan_type || 'Plus').toUpperCase();
            targetAcc.updated_at = Date.now();
            targetAcc.raw_error = null;
            for (const grp of parsedGroups) {
              for (const bkt of grp.buckets || []) {
                if (typeof bkt.remaining_percent === 'number') {
                  recordQuotaSnapshot({
                    authIndex: actAuthIndex,
                    provider: 'codex',
                    accountEmail: targetAcc.email || targetAcc.filename,
                    windowName: `${grp.name} - ${bkt.name}`,
                    remainingPercent: bkt.remaining_percent,
                    resetAt: bkt.reset_time ? new Date(bkt.reset_time).getTime() : null
                  });
                }
              }
            }
          }
        } else if (actProvider === 'openrouter') {
          const bodyObj = typeof probeResult.body === 'string' ? JSON.parse(probeResult.body) : (probeResult.body || probeResult.data);
          if (bodyObj) {
            targetAcc.today_requests = bodyObj.today_requests ?? targetAcc.today_requests;
            targetAcc.daily_limit = bodyObj.daily_limit ?? targetAcc.daily_limit;
            targetAcc.remaining_requests = bodyObj.remaining_requests ?? targetAcc.remaining_requests;
            targetAcc.reset_time = bodyObj.reset_time ?? targetAcc.reset_time;
            targetAcc.reset_countdown = bodyObj.reset_countdown ?? targetAcc.reset_countdown;
            targetAcc.updated_at = Date.now();
            targetAcc.raw_error = null;
          }
        } else if (actProvider === 'workbuddy' || actProvider === 'workbuddy-cn') {
          const bodyObj = typeof probeResult.body === 'string' ? JSON.parse(probeResult.body) : probeResult.body;
          const dataObj = bodyObj?.data || bodyObj;
          const pkgs = Array.isArray(dataObj?.Packages)
            ? dataObj.Packages
            : (Array.isArray(bodyObj?.Packages) ? bodyObj.Packages : []);

          let expiresAt = null;
          let runsOutAt = null;
          let runsOutPoints = null;

          if (probeResult.cpaQuota && Array.isArray(probeResult.cpaQuota.summary)) {
            const sumMap = new Map();
            for (const item of probeResult.cpaQuota.summary) {
              if (item?.key) sumMap.set(item.key, item);
            }
            expiresAt = sumMap.get('expires_at')?.unit || null;
            runsOutAt = sumMap.get('runs_out_at')?.unit || null;
            runsOutPoints = sumMap.get('runs_out_points')?.value != null ? Number(sumMap.get('runs_out_points').value) : null;
            if (!runsOutAt && expiresAt) {
              try {
                const norm = String(expiresAt).includes('T') ? expiresAt : String(expiresAt).replace(' ', 'T') + '+08:00';
                const d = new Date(norm);
                if (!isNaN(d.getTime())) runsOutAt = d.toISOString();
              } catch (_) {}
            }
          }

          let freeInfo = null;
          if (pkgs.length > 0) {
            const isCN = actProvider === 'workbuddy-cn';
            const baseUrl = isCN ? 'https://copilot.tencent.com' : 'https://www.workbuddy.ai';
            const domain = isCN ? 'www.codebuddy.cn' : 'www.workbuddy.ai';
            freeInfo = await queryWorkBuddyFreePackages(cpaRequest, actAuthIndex, baseUrl, domain, pkgs);
            if (freeInfo) {
              if (freeInfo.expiresAt) expiresAt = freeInfo.expiresAt;
              if (freeInfo.runsOutAt) runsOutAt = freeInfo.runsOutAt;
              if (freeInfo.runsOutPoints != null) runsOutPoints = freeInfo.runsOutPoints;
            }
          }

          if (pkgs.length > 0 || probeResult.cpaQuota) {
            targetAcc.groups = parseWorkBuddyGroups(bodyObj, {
              reset_time: runsOutAt,
              expires_at: expiresAt,
              runs_out_points: runsOutPoints,
              packages: freeInfo?.packages
            });
            if (freeInfo?.packages) {
              targetAcc.expiration_packages = freeInfo.packages;
            }
            let totalCredits = 0;
            let remainCredits = 0;
            let usedCredits = 0;
            for (const p of pkgs) {
              totalCredits += Number(p.CycleTotalCapacity) || 0;
              remainCredits += Number(p.CycleRemainCapacity) || 0;
              usedCredits += Number(p.CycleUsedCapacity) || 0;
            }
            if (totalCredits === 0 && probeResult.cpaQuota) {
              const sumMap = new Map((probeResult.cpaQuota.summary || []).map(s => [s.key, s]));
              totalCredits = Number(sumMap.get('points_total')?.value) || 0;
              remainCredits = Number(sumMap.get('points_remain')?.value) || 0;
              usedCredits = Number(sumMap.get('points_used')?.value) || 0;
            }
            targetAcc.total_credits = totalCredits;
            targetAcc.remaining_credits = remainCredits;
            targetAcc.used_credits = usedCredits;
            targetAcc.runs_out_points = runsOutPoints;
            targetAcc.expires_at = expiresAt;
            targetAcc.reset_time = runsOutAt;
            targetAcc.credits_unit = 'credits';
            targetAcc.updated_at = Date.now();
            targetAcc.raw_error = null;
          }
        }
      } catch (parseErr) {
        console.warn(`[Gate-Quota] In-place cache update parse warning for ${actFilename || actAuthIndex}:`, parseErr.message);
      }
    }
  } catch (err) {
    console.warn(`[Gate-Quota] Activate probe error for ${actFilename || actAuthIndex}:`, err.message);
    throw Object.assign(new Error(`额度查询失败：${err.message}`), { statusCode: 502 });
  }

  return {
    success: true,
    message: '已向上游查询额度；5 小时窗口由实际模型请求决定',
    auth_index: actAuthIndex,
    filename: actFilename,
    provider: actProvider,
    probe_response: probeResult
  };
}

export function getCachedUpstreamQuotas() {
  const pending = getPendingUpstreamValidations();
  const pendingMap = new Map();
  for (const p of pending) {
    if (p.auth_index) pendingMap.set(p.auth_index, p);
  }
  const accountsWithValidations = (cachedUpstreamQuotas?.accounts || []).map(acc => {
    const val = pendingMap.get(acc.auth_index);
    return val ? { ...acc, validation: val } : acc;
  });
  return {
    ...cachedUpstreamQuotas,
    accounts: accountsWithValidations,
    pending_validations: pending,
    default_priority: DEFAULT_AUTH_PRIORITY
  };
}

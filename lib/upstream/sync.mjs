import { cpaRequest } from '../core/key-registry.mjs';
import { extractValidationUrl } from '../../validation-url.mjs';
import {
  recordUpstreamValidation,
  resolveUpstreamValidationByAuth,
  getPendingUpstreamValidations
} from './validation-store.mjs';
import { stmtQuotaSnapshotInsert, stmtQuotaSnapshotsByAuth } from '../db/sqlite.mjs';
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

// Antigravity consumer credentials use the daily Cloud Code backend. The
// production host can return an unrelated 100% Gemini quota for the same token.
const ANTIGRAVITY_BASE_URL = 'https://daily-cloudcode-pa.googleapis.com';

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

export function parseWorkBuddyGroups(summaryBody) {
  if (!summaryBody) return [];
  const pkgs = Array.isArray(summaryBody.Packages) ? summaryBody.Packages : [];
  if (pkgs.length === 0) return [];

  const buckets = pkgs.map((pkg, idx) => {
    const total = Number(pkg.CycleTotalCapacity) || 0;
    const remain = Number(pkg.CycleRemainCapacity) || 0;
    const used = Number(pkg.CycleUsedCapacity) || 0;
    const remPct = total > 0 ? Math.max(0, Math.min(100, Math.round((remain / total) * 1000) / 10)) : (remain > 0 ? 100 : 0);
    const usedPct = total > 0 ? Math.max(0, Math.min(100, Math.round((used / total) * 1000) / 10)) : 0;
    const pkgName = pkg.PackageName || '标准积分包';

    return {
      bucket_id: `workbuddy-pkg-${idx}`,
      window: 'cycle',
      name: pkgName,
      unit: pkg.CapacityUnit || 'credits',
      total_capacity: total,
      remain_capacity: remain,
      used_capacity: used,
      remaining_percent: remPct,
      used_percent: usedPct,
      reset_time: '',
      reset_countdown: `剩余 ${remain.toLocaleString()} 积分`
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

export async function syncUpstreamQuotas(force = false) {
  const now = Date.now();
  // 缓存 30 秒，避免频繁请求上游封控
  if (!force && cachedUpstreamQuotas.last_updated && now - cachedUpstreamQuotas.last_updated < 30000) {
    return cachedUpstreamQuotas;
  }
  if (cachedUpstreamQuotas.is_loading) {
    return cachedUpstreamQuotas;
  }

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
    const accounts = [];

    for (const f of files) {
      const authIndex = f.auth_index || f.authIndex;
      const provider = (f.provider || f.type || 'unknown').toLowerCase();
      const filename = f.name || f.id || '';
      const email = f.email || f.label || filename;
      const disabled = Boolean(f.disabled || f.status === 'disabled');
      const status = f.status || (disabled ? 'disabled' : 'active');
      const health = getAuthHealth(f);
      const priority = normalizeAuthPriority(f.priority);
      const weight = normalizeAuthWeight(f.weight);
      const note = typeof f.note === 'string' ? f.note : '';

      const acc = {
        id: filename,
        filename,
        email,
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
          // 1. Quota Summary
          const quotaResp = await cpaRequest('POST', '/v0/management/api-call', {
            authIndex,
            method: 'POST',
            url: `${ANTIGRAVITY_BASE_URL}/v1internal:retrieveUserQuotaSummary`,
            header: {
              Authorization: 'Bearer $TOKEN$',
              'Content-Type': 'application/json',
              'User-Agent': 'antigravity/cli/1.0.13 (aidev_client; os_type=darwin; arch=arm64)'
            },
            data: JSON.stringify({ project: projectId })
          });

          if (quotaResp && quotaResp.status_code === 200 && quotaResp.body) {
            const body = typeof quotaResp.body === 'string' ? JSON.parse(quotaResp.body) : quotaResp.body;
            const parsedGroups = parseAntigravityGroups(body);
            if (parsedGroups.length > 0) {
              acc.groups = parsedGroups;
              // 验证成功恢复：若之前有 pending 验证记录，自动标记为已解决
              resolveUpstreamValidationByAuth(authIndex);
              acc.raw_error = null;
            }
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
              'User-Agent': 'antigravity/cli/1.0.13 (aidev_client; os_type=darwin; arch=arm64)'
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
            acc.groups = parseWorkBuddyGroups(qbody);
            // 汇总计算当前账号的总积分与剩余积分
            let totalCredits = 0;
            let remainCredits = 0;
            let usedCredits = 0;
            const pkgs = Array.isArray(qbody.Packages) ? qbody.Packages : [];
            for (const p of pkgs) {
              totalCredits += Number(p.CycleTotalCapacity) || 0;
              remainCredits += Number(p.CycleRemainCapacity) || 0;
              usedCredits += Number(p.CycleUsedCapacity) || 0;
            }
            acc.total_credits = totalCredits;
            acc.remaining_credits = remainCredits;
            acc.used_credits = usedCredits;
            acc.credits_unit = 'credits';
            acc.plan_type = 'standard';
            acc.plan_name = provider === 'workbuddy-cn' ? 'CodeBuddy' : 'WorkBuddy';
            acc.raw_error = null;
          } else if (quotaResp && quotaResp.status_code !== 200) {
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

    // 注入 OpenRouter 账号列表与今日调用次数（基于 openrouter-monitor 事实，每日 800 次纯数字呈现）
    try {
      const orAccounts = await syncOpenRouterAccounts({ force });
      for (const orAcc of orAccounts) {
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
            plan_name: 'Free (800次/日)'
          };
        } else {
          accounts.push(orAcc);
        }
      }
    } catch (orErr) {
      console.warn('[Gate-Quota] syncOpenRouterAccounts warning:', orErr.message);
    }

    // 默认排序：优先级降序 (priority DESC)，相同时按 auth_index 升序
    accounts.sort(compareAuthAccounts);

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
  } catch (err) {
    cachedUpstreamQuotas.error = err.message;
    console.error('[Gate-Quota] syncUpstreamQuotas error:', err.message);
  } finally {
    cachedUpstreamQuotas.is_loading = false;
  }

  return cachedUpstreamQuotas;
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
      probeResult = await cpaRequest('POST', '/v0/management/api-call', {
        authIndex: actAuthIndex,
        method: 'POST',
        url: `${ANTIGRAVITY_BASE_URL}/v1internal:retrieveUserQuotaSummary`,
        header: {
          Authorization: 'Bearer $TOKEN$',
          'Content-Type': 'application/json',
          'User-Agent': 'antigravity/cli/1.0.13 (aidev_client; os_type=darwin; arch=arm64)'
        },
        data: JSON.stringify({ project: projectId })
      });
    } else if (actProvider === 'openrouter') {
      const orProbe = await probeOpenRouterAccount(actAuthIndex || actFilename);
      probeResult = { status_code: 200, body: orProbe.data, message: 'OpenRouter 额度查询完成' };
    } else if (actProvider === 'workbuddy' || actProvider === 'workbuddy-cn') {
      const isCN = actProvider === 'workbuddy-cn';
      const baseUrl = isCN ? 'https://copilot.tencent.com' : 'https://www.workbuddy.ai';
      const domain = isCN ? 'www.codebuddy.cn' : 'www.workbuddy.ai';
      probeResult = await cpaRequest('POST', '/v0/management/api-call', {
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
      });
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
          if (bodyObj && Array.isArray(bodyObj.Packages)) {
            targetAcc.groups = parseWorkBuddyGroups(bodyObj);
            let totalCredits = 0;
            let remainCredits = 0;
            let usedCredits = 0;
            for (const p of bodyObj.Packages) {
              totalCredits += Number(p.CycleTotalCapacity) || 0;
              remainCredits += Number(p.CycleRemainCapacity) || 0;
              usedCredits += Number(p.CycleUsedCapacity) || 0;
            }
            targetAcc.total_credits = totalCredits;
            targetAcc.remaining_credits = remainCredits;
            targetAcc.used_credits = usedCredits;
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

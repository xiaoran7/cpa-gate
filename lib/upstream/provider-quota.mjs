import { cpaRequest } from '../core/key-registry.mjs';
import { requestCpaManagement } from './management.mjs';
import { getAuthHealth } from './auth-health.mjs';
import { probeOpenRouterAccount } from './openrouter.mjs';

const SOURCES = {
  claude: [
    ['usage', 'https://api.anthropic.com/api/oauth/usage'],
    ['profile', 'https://api.anthropic.com/api/oauth/profile']
  ],
  kimi: [['usage', 'https://api.kimi.com/coding/v1/usages']],
  xai: [
    ['weekly', 'https://cli-chat-proxy.grok.com/v1/billing?format=credits'],
    ['monthly', 'https://cli-chat-proxy.grok.com/v1/billing']
  ]
};

function requestHeaders(provider, file) {
  if (provider === 'claude') return { Authorization: 'Bearer $TOKEN$', 'Content-Type': 'application/json', 'anthropic-beta': 'oauth-2025-04-20' };
  if (provider === 'kimi') return { Authorization: 'Bearer $TOKEN$' };
  const headers = { Authorization: 'Bearer $TOKEN$', 'x-xai-token-auth': 'xai-grok-cli', 'x-grok-client-version': '0.2.91', accept: '*/*', 'user-agent': 'grok-pager/0.2.91 grok-shell/0.2.91 (macos; aarch64)' };
  const userId = file.user_id || file.userId || file.metadata?.user_id;
  if (userId) headers['x-userid'] = String(userId);
  return headers;
}

function safeNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function getDevinQuota(authIndex, account) {
  const response = await cpaRequest('POST', '/v0/management/api-call', {
    authIndex, method: 'POST', url: 'https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus',
    header: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' },
    data: JSON.stringify({ metadata: { ideName: 'chisel', ideVersion: '3000.10.21', apiKey: '$TOKEN$', locale: 'en', os: 'darwin', extensionVersion: '3000.10.21', clientName: 'chisel' } })
  });
  const statusCode = Number(response.status_code);
  if (statusCode < 200 || statusCode >= 300) return { provider: 'devin', account, results: { quota: { status_code: statusCode, error: 'Devin 额度请求失败' } } };
  let body;
  try { body = typeof response.body === 'string' ? JSON.parse(response.body) : response.body; } catch { body = null; }
  const plan = body?.userStatus?.planStatus || {};
  return { provider: 'devin', account, results: { quota: { status_code: statusCode, data: {
    plan: typeof plan.planInfo?.planName === 'string' ? plan.planInfo.planName : null,
    daily_remaining_percent: safeNumber(plan.dailyQuotaRemainingPercent),
    weekly_remaining_percent: safeNumber(plan.weeklyQuotaRemainingPercent),
    daily_reset_at_unix: safeNumber(plan.dailyQuotaResetAtUnix),
    weekly_reset_at_unix: safeNumber(plan.weeklyQuotaResetAtUnix)
  } } } };
}

async function getMetaQuota(file, authIndex, account) {
  if (file.runtime_only || file.source === 'memory' || !/^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}\.json$/.test(file.name || '')) {
    throw Object.assign(new Error('Meta 额度查询需要磁盘认证文件'), { statusCode: 400 });
  }
  let credential;
  try { credential = await requestCpaManagement('GET', `/auth-files/download?name=${encodeURIComponent(file.name)}`); }
  catch { throw Object.assign(new Error('无法读取 Meta 凭据文件'), { statusCode: 502 }); }
  let token;
  try { token = JSON.parse(credential.bytes.toString('utf8')).dca_token; } catch { token = null; }
  if (typeof token !== 'string' || !/^dca:[^\s]+$/.test(token)) throw Object.assign(new Error('Meta 凭据缺少 DCA token'), { statusCode: 400 });
  let response;
  try {
    response = await cpaRequest('POST', '/v0/management/api-call', {
      authIndex, method: 'POST', url: 'https://api.meta.ai/muse-code/key',
      header: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'x-api-version': '1.0.0' },
      data: '{}'
    });
  } catch {
    throw Object.assign(new Error('Meta 额度请求失败'), { statusCode: 502 });
  }
  const statusCode = Number(response.status_code);
  if (statusCode < 200 || statusCode >= 300) return { provider: 'meta', account, results: { quota: { status_code: statusCode, error: 'Meta 额度请求失败' } } };
  let body;
  try { body = typeof response.body === 'string' ? JSON.parse(response.body) : response.body; } catch { body = null; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('Meta 额度响应格式无效'), { statusCode: 502 });
  const usage = body.subs_usage || {};
  const window = raw => ({ used_percent: safeNumber(raw?.used_percent), resets_at: safeNumber(raw?.resets_at), window_duration_mins: safeNumber(raw?.window_duration_mins) });
  return { provider: 'meta', account, results: { quota: { status_code: statusCode, data: {
    plan: typeof body.subs_tier_name === 'string' ? body.subs_tier_name : typeof usage.tier === 'string' ? usage.tier : null,
    active: typeof body.is_subs_active === 'boolean' ? body.is_subs_active : null,
    window: window(usage.window), weekly: window(usage.weekly)
  } } } };
}

export async function getProviderQuota(authIndex) {
  let file = null;
  try {
    const authFiles = await cpaRequest('GET', '/v0/management/auth-files');
    file = (authFiles?.files || []).find(item => String(item.auth_index || item.authIndex || '') === String(authIndex));
  } catch {}

  // 支持来自 openrouter-monitor 注册的 OpenRouter 独立凭据
  if (!file && String(authIndex).startsWith('openrouter-')) {
    const probe = await probeOpenRouterAccount(authIndex);
    return {
      provider: 'openrouter',
      account: String(authIndex).replace('openrouter-', ''),
      results: {
        quota: {
          status_code: 200,
          data: probe.data
        }
      }
    };
  }

  if (!file) throw Object.assign(new Error('未找到 CPA 凭据'), { statusCode: 404 });
  const health = getAuthHealth(file);
  if (health.blocked) throw Object.assign(new Error(health.detail), { statusCode: 409 });
  const rawProvider = String(file.provider || file.type || '').toLowerCase();
  const provider = rawProvider === 'anthropic' ? 'claude' : rawProvider === 'grok' ? 'xai' : rawProvider;
  const account = file.email || file.name || '';
  if (provider === 'devin') return getDevinQuota(String(authIndex), account);
  if (provider === 'meta') return getMetaQuota(file, String(authIndex), account);
  if (provider === 'openrouter') {
    const probe = await probeOpenRouterAccount(authIndex);
    return {
      provider: 'openrouter',
      account,
      results: {
        quota: {
          status_code: 200,
          data: probe.data
        }
      }
    };
  }
  const sources = SOURCES[provider];
  if (!sources) throw Object.assign(new Error('此提供商已有 Gate 配额卡，或暂不支持独立额度查询'), { statusCode: 400 });
  const values = await Promise.all(sources.map(async ([name, url]) => {
    try {
      const response = await cpaRequest('POST', '/v0/management/api-call', {
        authIndex: String(authIndex), method: 'GET', url, header: requestHeaders(provider, file)
      });
      const body = typeof response.body === 'string' ? JSON.parse(response.body) : response.body;
      return [name, { status_code: response.status_code, data: body }];
    } catch (error) { return [name, { error: error.message }]; }
  }));
  return { provider, account, results: Object.fromEntries(values) };
}

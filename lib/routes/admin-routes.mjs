import crypto from 'crypto';
import { UPSTREAM_HOST, UPSTREAM_PORT } from '../config.mjs';
import { requestCpaJson, requestCpaManagement } from '../upstream/management.mjs';
import { getProviderQuota } from '../upstream/provider-quota.mjs';
import { getAuthHealth } from '../upstream/auth-health.mjs';
import { probeOpenAiProvider } from '../upstream/provider-probe.mjs';
import {
  getAdminData,
  createCpaKey,
  rotateCpaKey,
  deleteCpaKey,
  updateKeyAlias,
  getRawKeyById,
  updateQuotaRule,
  deleteQuotaRule,
  getUsageStats,
  getPagedRequests,
  getRecentRequests,
  getPagedErrorEvents,
  getRecentErrorEvents,
  getGateStatusSummary,
  getAllModelPrices,
  upsertModelPrice,
  deleteModelPrice,
  getQuotaSnapshots,
  syncUpstreamQuotas,
  getCachedUpstreamQuotas,
  getUpstreamAuthStats,
  updateUpstreamAuthPriority,
  updateUpstreamAuthStatus,
  activateUpstreamQuotaWindow,
  getPendingUpstreamValidations,
  getUpstreamValidations,
  resolveUpstreamValidation,
  dismissUpstreamValidation,
  deleteUpstreamValidation,
  recordUpstreamValidation
} from '../../quota-manager.mjs';
import { extractValidationUrl, isActionableValidationUrl, completeGoogleValidationUrl } from '../../validation-url.mjs';
import { inferProvider, listProviderRegistry, upsertProviderRegistry, deleteProviderRegistry } from '../core/provider-registry.mjs';
import { getRuntimeFacts, resetRuntimeFactsCache } from '../upstream/runtime-stats.mjs';
import { readRoutingConfig, writeRoutingConfig } from '../upstream/routing.mjs';
import { applyBatchAction } from '../upstream/batch.mjs';

export function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      req.resume();
      reject(err);
    };
    req.on('data', chunk => {
      total += chunk.length;
      if (total > maxBytes) {
        fail(Object.assign(new Error('request body too large'), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!settled) { settled = true; resolve(Buffer.concat(chunks)); }
    });
    req.on('close', () => {
      if (!settled && !req.readableEnded) {
        fail(Object.assign(new Error('request connection closed'), { statusCode: 499 }));
      }
    });
    req.on('error', err => fail(err));
  });
}

export function writeJson(res, status, payload, extra = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extra
  });
  res.end(JSON.stringify(payload));
}

export function verifyAdminAuth(req, ADMIN_SECRET) {
  const auth = req.headers['authorization'] || '';
  let token = auth;
  if (token.startsWith('Bearer ') || token.startsWith('bearer ')) {
    token = token.slice(7).trim();
  }
  if (!token) return false;
  const bufA = Buffer.from(token);
  const bufB = Buffer.from(ADMIN_SECRET);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

const CPA_PROVIDER_RESOURCES = new Set([
  'gemini-api-key', 'interactions-api-key', 'codex-api-key', 'claude-api-key',
  'vertex-api-key', 'meta-api-key', 'xai-api-key', 'openai-compatibility', 'oauth-excluded-models'
]);
const CPA_SETTING_RESOURCES = new Set([
  'debug', 'proxy-url', 'request-retry', 'max-retry-interval', 'request-log',
  'logging-to-file', 'ws-auth', 'usage-statistics-enabled',
  'quota-exceeded/switch-project', 'quota-exceeded/switch-preview-model',
  'error-logs-max-files'
]);
const CPA_OAUTH_RESOURCES = {
  codex: 'codex-auth-url',
  claude: 'anthropic-auth-url',
  antigravity: 'antigravity-auth-url',
  kimi: 'kimi-auth-url',
  'kimi-ai': 'kimi-ai-auth-url',
  xai: 'xai-auth-url',
  devin: 'devin-auth-url',
  meta: 'meta-auth-url',
  workbuddy: 'workbuddy-auth-url',
  'workbuddy-cn': 'workbuddy-cn-auth-url'
};
const CPA_WEBUI_OAUTH = new Set(['codex', 'claude', 'antigravity', 'xai', 'devin', 'workbuddy', 'workbuddy-cn']);

// CPA 只读运行时端点：面板的仪表盘数据全部来自这里，Gate 以服务端代理方式放行，
// 管理密钥永远不落浏览器。
const CPA_READONLY_RESOURCES = new Set(['api-key-usage', 'usage-statistics-enabled', 'routing/strategy', 'routing']);

function safeAuthFilename(name) {
  return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}\.json$/.test(name) && !name.includes('..');
}

function cpaError(res, err) {
  const code = err instanceof SyntaxError ? 400 : err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 502;
  writeJson(res, code, { error: err.message });
}

// 运行总览的「运行时一览」区块：把 CPA 的散点配置收敛成一份只读快照。
// 单项失败降级为 null，不让整块面板因一个端点不可用而空白。
async function getRuntimeConfigSnapshot() {
  const pick = async (fn) => {
    try { return { ok: true, value: await fn() }; }
    catch (err) { return { ok: false, value: null, error: err.message }; }
  };
  const [config, routing, version, usageStats] = await Promise.all([
    pick(() => requestCpaJson('GET', '/config')),
    // 取完整 routing 子树而非 /routing/strategy：策略、会话粘性、粘性 TTL
    // 三项一次到手，前端不必再发第二个请求
    pick(() => readRoutingConfig()),
    pick(() => requestCpaJson('GET', '/latest-version')),
    pick(() => requestCpaJson('GET', '/usage-statistics-enabled'))
  ]);
  return { config, routing, version, usage_statistics: usageStats };
}

async function handleCpaManagementRoutes(req, res, urlPath, MAX_ADMIN_BODY_BYTES) {
  if (!urlPath.startsWith('/admin/api/cpa/')) return false;
  const suffix = urlPath.slice('/admin/api/cpa/'.length);
  const params = new URL(req.url, 'http://localhost').searchParams;
  const bodyLimit = Math.max(MAX_ADMIN_BODY_BYTES, 2 * 1024 * 1024);
  try {
    if (suffix === 'config-yaml' && (req.method === 'GET' || req.method === 'PUT')) {
      if (req.method === 'GET') {
        const upstream = await requestCpaManagement('GET', '/config.yaml');
        const etag = crypto.createHash('sha256').update(upstream.bytes).digest('hex');
        res.writeHead(200, { 'Content-Type': 'application/yaml; charset=utf-8', ETag: `"${etag}"`, 'Cache-Control': 'no-store' });
        res.end(upstream.bytes);
      } else {
        const body = await readBody(req, bodyLimit);
        const expected = String(req.headers['if-match'] || '').replace(/^"|"$/g, '');
        if (!expected) return writeJson(res, 428, { error: '请先加载当前配置，再保存' });
        const current = await requestCpaManagement('GET', '/config.yaml');
        const actual = crypto.createHash('sha256').update(current.bytes).digest('hex');
        if (expected !== actual) return writeJson(res, 409, { error: 'CPA 配置已变化，请重新加载后合并修改' });
        const saved = await requestCpaManagement('PUT', '/config.yaml', body, 'application/yaml');
        writeJson(res, 200, JSON.parse(saved.bytes.toString('utf8') || '{}'));
      }
      return true;
    }

    if (suffix === 'config' && req.method === 'GET') {
      writeJson(res, 200, await requestCpaJson('GET', '/config'));
      return true;
    }
    if (suffix === 'latest-version' && req.method === 'GET') {
      writeJson(res, 200, await requestCpaJson('GET', '/latest-version'));
      return true;
    }

    if (suffix === 'auth-files' && ['GET', 'POST', 'DELETE'].includes(req.method)) {
      if (req.method === 'GET') {
        const response = await requestCpaJson('GET', '/auth-files');
        writeJson(res, 200, { ...response, files: Array.isArray(response.files) ? response.files.map(file => ({ ...file, gate_health: getAuthHealth(file) })) : [] });
        return true;
      }
      const name = req.method === 'POST' ? null : params.get('name');
      if (req.method === 'DELETE') {
        if (!safeAuthFilename(name)) return writeJson(res, 400, { error: '无效的认证文件名' }) || true;
        writeJson(res, 200, await requestCpaJson('DELETE', `/auth-files?name=${encodeURIComponent(name)}`));
      } else {
        const payload = JSON.parse((await readBody(req, bodyLimit)).toString('utf8') || '{}');
        if (!safeAuthFilename(payload.name)) return writeJson(res, 400, { error: '无效的认证文件名' }) || true;
        const content = typeof payload.content === 'string' ? payload.content : '';
        JSON.parse(content);
        writeJson(res, 200, await requestCpaJson('POST', `/auth-files?name=${encodeURIComponent(payload.name)}`, JSON.parse(content)));
      }
      return true;
    }

    if (suffix === 'auth-files/download' && req.method === 'GET') {
      const name = params.get('name');
      if (!safeAuthFilename(name)) return writeJson(res, 400, { error: '无效的认证文件名' }) || true;
      const upstream = await requestCpaManagement('GET', `/auth-files/download?name=${encodeURIComponent(name)}`);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(upstream.bytes);
      return true;
    }
    if (suffix === 'auth-files/models' && req.method === 'GET') {
      const name = params.get('name');
      if (!safeAuthFilename(name)) return writeJson(res, 400, { error: '无效的认证文件名' }) || true;
      writeJson(res, 200, await requestCpaJson('GET', `/auth-files/models?name=${encodeURIComponent(name)}`));
      return true;
    }
    if (suffix === 'auth-files/refresh' && req.method === 'POST') {
      const payload = JSON.parse((await readBody(req, MAX_ADMIN_BODY_BYTES)).toString('utf8') || '{}');
      if (!safeAuthFilename(payload.name)) return writeJson(res, 400, { error: '无效的认证文件名' }) || true;
      await requestCpaJson('POST', '/auth-files/refresh', { name: payload.name, ...(payload.auth_index ? { auth_index: String(payload.auth_index) } : {}) });
      writeJson(res, 200, { success: true });
      return true;
    }
    if (suffix === 'auth-files/fields' && req.method === 'PATCH') {
      const payload = JSON.parse((await readBody(req, MAX_ADMIN_BODY_BYTES)).toString('utf8') || '{}');
      if (!safeAuthFilename(payload.name)) return writeJson(res, 400, { error: '无效的认证文件名' }) || true;
      const allowed = new Set(['prefix', 'proxy_url', 'headers', 'priority', 'weight', 'note', 'excluded_models', 'excluded-models', 'disable_cooling', 'disable-cooling', 'websockets', 'using_api', 'expired']);
      const fields = Object.fromEntries(Object.entries(payload).filter(([key]) => allowed.has(key)));
      if (!Object.keys(fields).length) return writeJson(res, 400, { error: '没有可保存的字段' }) || true;
      writeJson(res, 200, await requestCpaJson('PATCH', '/auth-files/fields', { name: payload.name, ...fields }));
      return true;
    }
    if (suffix === 'auth-files/status' && req.method === 'PATCH') {
      const payload = JSON.parse((await readBody(req, MAX_ADMIN_BODY_BYTES)).toString('utf8') || '{}');
      if (typeof payload.name !== 'string' || !payload.name || payload.name.length > 256 || typeof payload.disabled !== 'boolean') return writeJson(res, 400, { error: '无效的认证文件状态' }) || true;
      writeJson(res, 200, await requestCpaJson('PATCH', '/auth-files/status', { name: payload.name, disabled: payload.disabled }));
      return true;
    }
    if (suffix === 'vertex/import' && req.method === 'POST') {
      const payload = JSON.parse((await readBody(req, bodyLimit)).toString('utf8') || '{}');
      if (typeof payload.content !== 'string' || payload.content.length > 2 * 1024 * 1024 ||
          typeof payload.name !== 'string' || !safeAuthFilename(payload.name) ||
          (payload.location !== undefined && (typeof payload.location !== 'string' || !/^[a-z0-9-]{1,64}$/.test(payload.location)))) {
        return writeJson(res, 400, { error: '无效的 Vertex 凭据文件或区域' }) || true;
      }
      const credential = JSON.parse(payload.content);
      if (!credential || typeof credential !== 'object' || Array.isArray(credential)) return writeJson(res, 400, { error: 'Vertex 凭据必须是 JSON 对象' }) || true;
      const boundary = `gate-${crypto.randomBytes(12).toString('hex')}`;
      const field = (name, value, filename) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"${filename ? `; filename="${filename}"` : ''}\r\n${filename ? 'Content-Type: application/json\r\n' : ''}\r\n${value}\r\n`;
      const multipart = Buffer.from(field('file', payload.content, payload.name) + (payload.location ? field('location', payload.location) : '') + `--${boundary}--\r\n`);
      const upstream = await requestCpaManagement('POST', '/vertex/import', multipart, `multipart/form-data; boundary=${boundary}`);
      writeJson(res, 200, JSON.parse(upstream.bytes.toString('utf8') || '{}'));
      return true;
    }

    const oauthStart = suffix.match(/^oauth\/([a-z-]+)\/start$/);
    if (oauthStart && req.method === 'POST' && CPA_OAUTH_RESOURCES[oauthStart[1]]) {
      const webui = CPA_WEBUI_OAUTH.has(oauthStart[1]) ? '?is_webui=true' : '';
      writeJson(res, 200, await requestCpaJson('GET', `/${CPA_OAUTH_RESOURCES[oauthStart[1]]}${webui}`));
      return true;
    }
    if (suffix === 'oauth/status' && req.method === 'GET') {
      const state = params.get('state');
      if (!state || state.length > 256) return writeJson(res, 400, { error: '无效的 OAuth state' }) || true;
      writeJson(res, 200, await requestCpaJson('GET', `/get-auth-status?state=${encodeURIComponent(state)}`));
      return true;
    }
    if (suffix === 'oauth/callback' && req.method === 'POST') {
      const payload = JSON.parse((await readBody(req, MAX_ADMIN_BODY_BYTES)).toString('utf8') || '{}');
      if (!CPA_OAUTH_RESOURCES[payload.provider] || typeof payload.redirect_url !== 'string' || !payload.redirect_url || payload.redirect_url.length > 4096) {
        return writeJson(res, 400, { error: '无效的 OAuth 回调' }) || true;
      }
      const provider = payload.provider === 'claude' ? 'anthropic' : payload.provider;
      writeJson(res, 200, await requestCpaJson('POST', '/oauth-callback', { provider, redirect_url: payload.redirect_url }));
      return true;
    }
    if (suffix === 'oauth/cancel' && req.method === 'POST') {
      const payload = JSON.parse((await readBody(req, MAX_ADMIN_BODY_BYTES)).toString('utf8') || '{}');
      if (typeof payload.state !== 'string' || !payload.state || payload.state.length > 256) return writeJson(res, 400, { error: '无效的 OAuth state' }) || true;
      writeJson(res, 200, await requestCpaJson('DELETE', `/oauth-session?state=${encodeURIComponent(payload.state)}`));
      return true;
    }

    if (suffix.startsWith('v8/')) {
      const v8Path = '/' + suffix.slice('v8/'.length);
      const isRead = req.method === 'GET';
      const body = isRead ? undefined : JSON.parse((await readBody(req, bodyLimit)).toString('utf8') || '{}');
      writeJson(res, 200, await requestCpaJson(req.method, v8Path, body, 'v8'));
      return true;
    }

    if (suffix === 'logs' && ['GET', 'DELETE'].includes(req.method)) {
      const hasAfter = params.has('after');
      const requestedAfter = Number(params.get('after'));
      const after = hasAfter && Number.isFinite(requestedAfter) && requestedAfter >= 0
        ? requestedAfter
        : Math.max(0, Math.floor(Date.now() / 1000) - 3600);
      if (req.method === 'DELETE') {
        writeJson(res, 200, await requestCpaJson('DELETE', '/logs'));
        return true;
      }
      // CPA 的 /logs 只有 after 游标、没有 limit，响应体积只由回溯时长决定。
      // 超 8MB 时 management.mjs 会保留已收到的部分并把 truncated 置真，
      // 这里必须把这个标志原样透出，否则前端会把残缺数据当成完整数据展示。
      const { bytes, truncated } = await requestCpaManagement('GET', `/logs?after=${after}`);
      const payload = bytes.length ? JSON.parse(bytes.toString('utf8')) : {};
      writeJson(res, 200, truncated ? { ...payload, truncated: true } : payload);
      return true;
    }
    if (suffix === 'request-error-logs' && req.method === 'GET') {
      writeJson(res, 200, await requestCpaJson('GET', '/request-error-logs'));
      return true;
    }
    if (suffix === 'request-error-logs/preview' && req.method === 'GET') {
      const name = params.get('name');
      if (typeof name !== 'string' || !/^error-[A-Za-z0-9._-]+\.log$/.test(name) || name.includes('..')) return writeJson(res, 400, { error: '无效的日志文件名' }) || true;
      const upstream = await requestCpaManagement('GET', `/request-error-logs/${encodeURIComponent(name)}`);
      if (upstream.bytes.length > 2 * 1024 * 1024) {
        return writeJson(res, 413, {
          error: '日志体积超过 2 MiB 预览上限，请使用“下载”功能在本地查看',
          size: upstream.bytes.length,
          name
        }) || true;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(upstream.bytes);
      return true;
    }
    if (suffix === 'request-error-logs/download' && req.method === 'GET') {
      const name = params.get('name');
      if (typeof name !== 'string' || !/^error-[A-Za-z0-9._-]+\.log$/.test(name) || name.includes('..')) return writeJson(res, 400, { error: '无效的日志文件名' }) || true;
      const upstream = await requestCpaManagement('GET', `/request-error-logs/${encodeURIComponent(name)}`);
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(upstream.bytes);
      return true;
    }
    if (suffix === 'reset-quota' && req.method === 'POST') {
      const payload = JSON.parse((await readBody(req, MAX_ADMIN_BODY_BYTES)).toString('utf8') || '{}');
      if (typeof payload.auth_index !== 'string' || !payload.auth_index || payload.auth_index.length > 256) return writeJson(res, 400, { error: '无效的 auth_index' }) || true;
      writeJson(res, 200, await requestCpaJson('POST', '/reset-quota', { auth_index: payload.auth_index }));
      return true;
    }
    if (suffix === 'provider-quota' && req.method === 'GET') {
      const authIndex = params.get('auth_index');
      if (!authIndex || authIndex.length > 256) return writeJson(res, 400, { error: '无效的 auth_index' }) || true;
      writeJson(res, 200, await getProviderQuota(authIndex));
      return true;
    }

    if (suffix === 'providers/openai-compatibility/probe' && req.method === 'POST') {
      const payload = JSON.parse((await readBody(req, MAX_ADMIN_BODY_BYTES)).toString('utf8') || '{}');
      writeJson(res, 200, await probeOpenAiProvider(payload));
      return true;
    }

    const provider = suffix.match(/^providers\/([a-z-]+)$/)?.[1];
    if (provider && CPA_PROVIDER_RESOURCES.has(provider) && ['GET', 'PUT'].includes(req.method)) {
      const payload = req.method === 'PUT' ? JSON.parse((await readBody(req, bodyLimit)).toString('utf8')) : undefined;
      writeJson(res, 200, await requestCpaJson(req.method, `/${provider}`, payload));
      return true;
    }
    if (suffix === 'oauth-model-alias' && ['GET', 'PATCH'].includes(req.method)) {
      const payload = req.method === 'PATCH' ? JSON.parse((await readBody(req, MAX_ADMIN_BODY_BYTES)).toString('utf8') || '{}') : undefined;
      if (payload && (typeof payload.channel !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(payload.channel) || !Array.isArray(payload.aliases) || payload.aliases.length > 200)) {
        return writeJson(res, 400, { error: '无效的 OAuth 模型别名配置' }) || true;
      }
      writeJson(res, 200, await requestCpaJson(req.method, '/oauth-model-alias', payload));
      return true;
    }
    const setting = suffix.startsWith('settings/') ? suffix.slice('settings/'.length) : '';
    if (setting && CPA_SETTING_RESOURCES.has(setting) && ['GET', 'PATCH'].includes(req.method)) {
      const payload = req.method === 'PATCH' ? JSON.parse((await readBody(req, MAX_ADMIN_BODY_BYTES)).toString('utf8')) : undefined;
      writeJson(res, 200, await requestCpaJson(req.method, `/${setting}`, payload));
      return true;
    }

    if (CPA_READONLY_RESOURCES.has(suffix) && req.method === 'GET') {
      writeJson(res, 200, await requestCpaJson('GET', `/${suffix}`));
      return true;
    }

    if (suffix === 'cooldown/reset' && req.method === 'POST') {
      const payload = JSON.parse((await readBody(req, MAX_ADMIN_BODY_BYTES)).toString('utf8') || '{}');
      const authIndex = payload.auth_index;
      if (!authIndex || typeof authIndex !== 'string' || authIndex.length > 256) {
        return writeJson(res, 400, { error: '无效的 auth_index' }) || true;
      }
      try {
        await requestCpaJson('POST', '/routing/cooldown/reset', { auth_index: authIndex });
      } catch {
        await requestCpaJson('POST', '/reset-quota', { auth_index: authIndex });
      }
      resetRuntimeFactsCache();
      writeJson(res, 200, { success: true, message: '凭据冷却状态已成功重置' });
      return true;
    }

    if (suffix === 'cooldown/reset-all' && req.method === 'POST') {
      try {
        let directSuccess = false;
        try {
          await requestCpaJson('POST', '/routing/cooldown/reset', {});
          directSuccess = true;
        } catch {}

        if (!directSuccess) {
          const authFilesResp = await requestCpaJson('GET', '/auth-files');
          const files = Array.isArray(authFilesResp?.files) ? authFilesResp.files : Array.isArray(authFilesResp) ? authFilesResp : [];
          for (const file of files) {
            if (file?.auth_index) {
              await requestCpaJson('POST', '/reset-quota', { auth_index: String(file.auth_index) }).catch(() => {});
            }
          }
        }
        resetRuntimeFactsCache();
        writeJson(res, 200, { success: true, message: '全部凭据冷却状态已成功解除' });
      } catch (err) {
        cpaError(res, err);
      }
      return true;
    }

    if (suffix === 'credentials/refresh-all' && req.method === 'POST') {
      try {
        const authFilesResp = await requestCpaJson('GET', '/auth-files');
        const files = Array.isArray(authFilesResp?.files) ? authFilesResp.files : Array.isArray(authFilesResp) ? authFilesResp : [];
        const results = [];
        for (const file of files) {
          if (!file?.name || !safeAuthFilename(file.name)) continue;
          try {
            await requestCpaJson('POST', '/auth-files/refresh', {
              name: file.name,
              ...(file.auth_index ? { auth_index: String(file.auth_index) } : {})
            });
            results.push({ name: file.name, ok: true });
          } catch (err) {
            results.push({ name: file.name, ok: false, error: err.message });
          }
        }
        resetRuntimeFactsCache();
        writeJson(res, 200, {
          total: results.length,
          succeeded: results.filter(r => r.ok).length,
          failed: results.filter(r => !r.ok).length,
          results
        });
      } catch (err) {
        cpaError(res, err);
      }
      return true;
    }

    if ((suffix === 'models' || suffix === 'models/catalog') && req.method === 'GET') {
      try {
        const priceList = getAllModelPrices() || [];
        const catalogMap = new Map();
        for (const item of priceList) {
          const modelId = item?.pattern;
          if (!modelId || typeof modelId !== 'string') continue;
          catalogMap.set(modelId, {
            id: modelId,
            name: modelId,
            provider: inferProvider({ model: modelId }).key || 'general',
            available: true,
            source: 'system-catalog'
          });
        }
        // 补充 CPA OAuth 凭据所挂载的可用模型
        try {
          const authFilesResp = await requestCpaJson('GET', '/auth-files');
          const files = Array.isArray(authFilesResp?.files) ? authFilesResp.files : Array.isArray(authFilesResp) ? authFilesResp : [];
          for (const f of files.slice(0, 15)) {
            if (f?.name && safeAuthFilename(f.name)) {
              try {
                const mResp = await requestCpaJson('GET', `/auth-files/models?name=${encodeURIComponent(f.name)}`);
                const list = Array.isArray(mResp?.models) ? mResp.models : [];
                for (const m of list) {
                  const mId = typeof m === 'string' ? m : m?.id || m?.name;
                  if (mId && typeof mId === 'string' && !catalogMap.has(mId)) {
                    catalogMap.set(mId, {
                      id: mId,
                      name: mId,
                      provider: f.provider || 'upstream',
                      available: !f.disabled,
                      source: f.name
                    });
                  }
                }
              } catch {}
            }
          }
        } catch {}
        // 补充 CPA 配置的 openai-compatibility 兼容渠道模型（如阶跃星辰等）
        try {
          const compatResp = await requestCpaJson('GET', '/openai-compatibility');
          const compatList = Array.isArray(compatResp?.['openai-compatibility']) ? compatResp['openai-compatibility'] : [];
          for (const c of compatList) {
            const cName = c?.name || 'custom';
            const cModels = Array.isArray(c?.models) ? c.models : [];
            for (const m of cModels) {
              const mName = typeof m === 'string' ? m : m?.name || m?.id;
              if (mName && typeof mName === 'string' && !catalogMap.has(mName)) {
                catalogMap.set(mName, {
                  id: mName,
                  name: mName,
                  provider: cName,
                  available: !c?.disabled,
                  source: `compat:${cName}`
                });
              }
            }
          }
        } catch {}
        writeJson(res, 200, { models: Array.from(catalogMap.values()) });
      } catch (err) {
        cpaError(res, err);
      }
      return true;
    }

    if (suffix === 'model-probe' && req.method === 'POST') {
      const payload = JSON.parse((await readBody(req, bodyLimit)).toString('utf8') || '{}');
      const { model, prompt, max_tokens, provider_type } = payload;
      if (!model || typeof model !== 'string' || model.length > 128) {
        return writeJson(res, 400, { error: '缺少或无效的目标模型 ID' }) || true;
      }
      const testPrompt = typeof prompt === 'string' && prompt ? prompt.slice(0, 1000) : 'Reply with "pong" and nothing else.';
      const maxTokens = Math.min(Math.max(Number(max_tokens) || 8, 1), 256);

      const startTime = Date.now();
      try {
        if (provider_type === 'openai-compatibility') {
          const probeRes = await probeOpenAiProvider({
            index: Number(payload.provider_index) || 0,
            key_index: Number(payload.key_index) || 0,
            operation: 'test',
            model
          });
          const latencyMs = Date.now() - startTime;
          writeJson(res, 200, {
            status_code: probeRes.status_code || 200,
            ok: probeRes.ok,
            latency_ms: latencyMs,
            model,
            content: probeRes.message || 'OK',
            usage: { total_tokens: 8 }
          });
          return true;
        }

        const apiCallPayload = {
          url: `http://${UPSTREAM_HOST}:${UPSTREAM_PORT}/v1/chat/completions`,
          header: { 'Content-Type': 'application/json' },
          data: JSON.stringify({
            model,
            messages: [{ role: 'user', content: testPrompt }],
            max_tokens: maxTokens,
            stream: false
          })
        };
        const cpaRes = await requestCpaJson('POST', '/api-call', apiCallPayload);
        const latencyMs = Date.now() - startTime;
        let content = '';
        const ok = cpaRes.status_code >= 200 && cpaRes.status_code < 300;
        try {
          const parsed = typeof cpaRes.body === 'string' ? JSON.parse(cpaRes.body) : cpaRes.body;
          content = parsed?.choices?.[0]?.message?.content || parsed?.error?.message || cpaRes.body;
        } catch {
          content = cpaRes.body || '';
        }
        writeJson(res, 200, {
          status_code: cpaRes.status_code,
          ok,
          latency_ms: latencyMs,
          model,
          content: typeof content === 'string' ? content : JSON.stringify(content),
          message: ok ? '探针响应正常' : `探针返回异常 HTTP ${cpaRes.status_code}`
        });
      } catch (err) {
        const latencyMs = Date.now() - startTime;
        writeJson(res, 200, {
          status_code: err.statusCode || 500,
          ok: false,
          latency_ms: latencyMs,
          model,
          content: err.message,
          message: `探针执行失败：${err.message}`
        });
      }
      return true;
    }

    if (suffix === 'global-model-aliases' && ['GET', 'PUT', 'POST'].includes(req.method)) {
      if (req.method === 'GET') {
        const config = await requestCpaJson('GET', '/config');
        const rawAliases = config?.['model-aliases'] || config?.model_aliases || config?.['model-alias'] || {};
        let aliases = [];
        if (Array.isArray(rawAliases)) {
          aliases = rawAliases.map(item => {
            if (!item || typeof item !== 'object') return null;
            const from = item.from || item.name || item.pattern || '';
            const to = item.to || item.alias || item.target || '';
            return from && to ? { from: String(from), to: String(to) } : null;
          }).filter(Boolean);
        } else if (typeof rawAliases === 'object' && rawAliases !== null) {
          aliases = Object.entries(rawAliases).map(([from, to]) => ({ from, to: typeof to === 'string' ? to : (to?.to || to?.alias || String(to)) }));
        }
        writeJson(res, 200, { aliases });
      } else {
        const payload = JSON.parse((await readBody(req, bodyLimit)).toString('utf8') || '{}');
        if (!Array.isArray(payload.aliases)) {
          return writeJson(res, 400, { error: 'aliases 必须为数组' }) || true;
        }
        const dict = {};
        for (const item of payload.aliases) {
          if (!item || typeof item !== 'object' || !item.from || !item.to) continue;
          dict[String(item.from).trim()] = String(item.to).trim();
        }
        await requestCpaJson('PATCH', '/config', { 'model-aliases': dict });
        writeJson(res, 200, { success: true, aliases: Object.entries(dict).map(([from, to]) => ({ from, to })) });
      }
      return true;
    }

    if (suffix === 'runtime-config' && req.method === 'GET') {
      writeJson(res, 200, await getRuntimeConfigSnapshot());
      return true;
    }

    if ((suffix === 'upstream-routing' || suffix === 'routing') && req.method === 'PUT') {
      try {
        const payload = JSON.parse((await readBody(req, bodyLimit)).toString('utf8') || '{}');
        writeJson(res, 200, { routing: await writeRoutingConfig(payload) });
      } catch (err) {
        writeJson(res, err.statusCode || 502, { error: err.message });
      }
      return true;
    }
  } catch (err) {
    cpaError(res, err);
    return true;
  }
  writeJson(res, 404, { error: 'Unsupported CPA management operation' });
  return true;
}

export async function handleAdminRoutes(req, res, urlPath, ADMIN_SECRET, MAX_ADMIN_BODY_BYTES) {
  if (!urlPath.startsWith('/admin/api/')) return false;

  if (!verifyAdminAuth(req, ADMIN_SECRET)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized: invalid or missing management secret' }));
    return true;
  }

  if (await handleCpaManagementRoutes(req, res, urlPath, MAX_ADMIN_BODY_BYTES)) return true;

  if (urlPath === '/admin/api/keys' && req.method === 'GET') {
    writeJson(res, 200, getAdminData());
    return true;
  }

  // 完整 API Key 仅在此按需下发一次：列表接口只给 display_key，
  // 避免完整明文随列表落到前端缓存与 localStorage。
  const revealKeyMatch = urlPath.match(/^\/admin\/api\/keys\/(\d+)\/reveal$/);
  if (revealKeyMatch && req.method === 'GET') {
    const raw = getRawKeyById(revealKeyMatch[1]);
    if (!raw) {
      writeJson(res, 404, { error: 'Key 不存在' });
      return true;
    }
    writeJson(res, 200, { key_id: Number(revealKeyMatch[1]), api_key: raw });
    return true;
  }

  if (urlPath === '/admin/api/keys' && req.method === 'POST') {
    try {
      const body = await readBody(req, MAX_ADMIN_BODY_BYTES);
      const payload = JSON.parse(body.toString('utf8') || '{}');
      const result = await createCpaKey(payload);
      writeJson(res, 200, result);
    } catch (err) {
      writeJson(res, err.statusCode || (err.message.includes('CPA mgmt') ? 502 : 400), { error: err.message });
    }
    return true;
  }

  if (urlPath === '/admin/api/stats' && req.method === 'GET') {
    const url = new URL(req.url, 'http://localhost');
    writeJson(res, 200, getUsageStats(url.searchParams.get('days'), url.searchParams.get('key_id')));
    return true;
  }

  if (urlPath === '/admin/api/requests' && req.method === 'GET') {
    const url = new URL(req.url, 'http://localhost');
    writeJson(res, 200, url.searchParams.has('page') ? getPagedRequests({
      page: url.searchParams.get('page'),
      pageSize: url.searchParams.get('page_size'),
      keyId: url.searchParams.get('key_id') || null,
      authIndex: url.searchParams.get('auth_index') || null,
      filter: url.searchParams.get('filter'),
      search: url.searchParams.get('search'),
      timeRange: url.searchParams.get('time_range'),
      since: url.searchParams.get('since'),
      until: url.searchParams.get('until'),
      beforeId: url.searchParams.get('before_id')
    }) : getRecentRequests(url.searchParams.get('limit')));
    return true;
  }

  if (urlPath === '/admin/api/errors' && req.method === 'GET') {
    const url = new URL(req.url, 'http://localhost');
    writeJson(res, 200, url.searchParams.has('page') ? getPagedErrorEvents({
      page: url.searchParams.get('page'),
      pageSize: url.searchParams.get('page_size'),
      timeRange: url.searchParams.get('time_range'),
      since: url.searchParams.get('since'),
      until: url.searchParams.get('until'),
      beforeId: url.searchParams.get('before_id')
    }) : getRecentErrorEvents(url.searchParams.get('limit')));
    return true;
  }

  if (urlPath === '/admin/api/runtime-facts' && req.method === 'GET') {
    const url = new URL(req.url, 'http://localhost');
    writeJson(res, 200, await getRuntimeFacts({ force: url.searchParams.get('refresh') === '1' }));
    return true;
  }

  // 运行总览的「运行时一览」区块：把 CPA 的散点配置收敛成一份只读快照。
  // 单项失败降级为 null，不让整块面板因一个端点不可用而空白。
  if (urlPath === '/admin/api/runtime-config' && req.method === 'GET') {
    writeJson(res, 200, await getRuntimeConfigSnapshot());
    return true;
  }

  // 路由策略写入。只接受三个白名单字段，服务端只向 CPA 提交 routing 子树，
  // 其余 48 个配置键一律不碰 —— config-yaml 的 PUT 是整体替换，绝不能走那条路。
  if (urlPath === '/admin/api/upstream-routing' && req.method === 'PUT') {
    try {
      const payload = JSON.parse((await readBody(req, MAX_ADMIN_BODY_BYTES)).toString('utf8') || '{}');
      writeJson(res, 200, { routing: await writeRoutingConfig(payload) });
    } catch (err) {
      writeJson(res, err.statusCode || 502, { error: err.message });
    }
    return true;
  }

  // 认证文件批量操作。逐条执行、逐条汇报，部分失败不阻断其余条目。
  // 单文件端点（/upstream-auth/priority、/upstream-auth/status、cpa/auth-files/*）全部保留。
  if (urlPath === '/admin/api/upstream-auth/batch' && req.method === 'PUT') {
    try {
      const payload = JSON.parse((await readBody(req, MAX_ADMIN_BODY_BYTES)).toString('utf8') || '{}');
      // 只有重置冷却认 auth_index；其余 action 不该被 auth-files 拉取失败拖累
      let authIndexByName;
      if (payload?.action === 'reset-cooldown') {
        try {
          const authFiles = await requestCpaJson('GET', '/auth-files');
          authIndexByName = new Map();
          for (const file of (Array.isArray(authFiles) ? authFiles : authFiles?.files) || []) {
            if (file?.name && file?.auth_index) authIndexByName.set(file.name, file.auth_index);
          }
        } catch (err) {
          cpaError(res, err);
          return true;
        }
      }
      writeJson(res, 200, await applyBatchAction(payload, { authIndexByName }));
    } catch (err) {
      writeJson(res, err.statusCode || 400, { error: err.message });
    }
    return true;
  }

  if (urlPath === '/admin/api/status-summary' && req.method === 'GET') {
    writeJson(res, 200, getGateStatusSummary());
    return true;
  }

  if (urlPath === '/admin/api/model-prices') {
    if (req.method === 'GET') {
      writeJson(res, 200, { prices: getAllModelPrices() });
      return true;
    } else if (req.method === 'POST') {
      try {
        const body = await readBody(req, MAX_ADMIN_BODY_BYTES);
        const payload = JSON.parse(body.toString('utf8') || '{}');
        writeJson(res, 200, upsertModelPrice(payload));
      } catch (err) {
        writeJson(res, err.statusCode || 400, { error: err.message });
      }
      return true;
    }
  }

  const priceIdMatch = urlPath.match(/^\/admin\/api\/model-prices\/(\d+)$/);
  if (priceIdMatch && req.method === 'DELETE') {
    try {
      writeJson(res, 200, deleteModelPrice(priceIdMatch[1]));
    } catch (err) {
      writeJson(res, 400, { error: err.message });
    }
    return true;
  }

  // 提供商注册表：补登记新上游提供商，改一次规则全站生效，无需重启。
  if (urlPath === '/admin/api/provider-registry') {
    if (req.method === 'GET') {
      writeJson(res, 200, { providers: listProviderRegistry() });
      return true;
    } else if (req.method === 'POST') {
      try {
        const body = await readBody(req, MAX_ADMIN_BODY_BYTES);
        const payload = JSON.parse(body.toString('utf8') || '{}');
        writeJson(res, 200, upsertProviderRegistry(payload));
      } catch (err) {
        writeJson(res, err.statusCode || 400, { error: err.message });
      }
      return true;
    }
  }

  const providerKeyMatch = urlPath.match(/^\/admin\/api\/provider-registry\/([A-Za-z0-9_-]+)$/);
  if (providerKeyMatch && req.method === 'DELETE') {
    try {
      writeJson(res, 200, deleteProviderRegistry(providerKeyMatch[1]));
    } catch (err) {
      writeJson(res, err.statusCode || 400, { error: err.message });
    }
    return true;
  }

  if (urlPath.startsWith('/admin/api/quota-snapshots')) {
    const url = new URL(req.url, 'http://localhost');
    const authIndex = url.searchParams.get('auth_index') || '';
    const hours = url.searchParams.get('hours') || 24;
    writeJson(res, 200, getQuotaSnapshots(authIndex, hours));
    return true;
  }

  if (urlPath === '/admin/api/upstream-quotas') {
    if (req.method === 'GET') {
      const url = new URL(req.url, 'http://localhost');
      const refresh = url.searchParams.get('refresh') === '1';
      if (refresh) {
        // 走 getCachedUpstreamQuotas 而非直接返回 syncUpstreamQuotas 的裸缓存，
        // 否则刷新路径会丢掉 default_priority 与 pending_validations，与非刷新路径响应不一致。
        syncUpstreamQuotas(true).then(() => writeJson(res, 200, getCachedUpstreamQuotas())).catch(err => writeJson(res, 500, { error: err.message }));
      } else {
        writeJson(res, 200, getCachedUpstreamQuotas());
      }
      return true;
    } else if (req.method === 'POST') {
      syncUpstreamQuotas(true).then(() => writeJson(res, 200, getCachedUpstreamQuotas())).catch(err => writeJson(res, 500, { error: err.message }));
      return true;
    }
  }

  if (urlPath === '/admin/api/upstream-auth-stats' && req.method === 'GET') {
    const parsedUrl = new URL(req.url, 'http://localhost');
    const timeRange = parsedUrl.searchParams.get('range') || parsedUrl.searchParams.get('time_range') || 'all';
    // 运行时事实用于替换「全部历史」以外的请求量口径；取不到也不阻塞本地推算。
    const runtime = await getRuntimeFacts();
    writeJson(res, 200, getUpstreamAuthStats(timeRange, runtime));
    return true;
  }

  if (urlPath === '/admin/api/upstream-auth/priority' && req.method === 'PUT') {
    try {
      const body = await readBody(req, MAX_ADMIN_BODY_BYTES);
      const payload = JSON.parse(body.toString('utf8') || '{}');
      const result = await updateUpstreamAuthPriority(payload);
      writeJson(res, 200, result);
    } catch (err) {
      writeJson(res, err.statusCode || 400, { error: err.message });
    }
    return true;
  }

  if (urlPath === '/admin/api/upstream-auth/status' && req.method === 'PUT') {
    try {
      const body = await readBody(req, MAX_ADMIN_BODY_BYTES);
      const payload = JSON.parse(body.toString('utf8') || '{}');
      const result = await updateUpstreamAuthStatus(payload);
      writeJson(res, 200, result);
    } catch (err) {
      writeJson(res, err.statusCode || 400, { error: err.message });
    }
    return true;
  }

  if (urlPath === '/admin/api/upstream-auth/activate-window' && req.method === 'POST') {
    try {
      const body = await readBody(req, MAX_ADMIN_BODY_BYTES);
      const payload = JSON.parse(body.toString('utf8') || '{}');
      const result = await activateUpstreamQuotaWindow(payload);
      writeJson(res, 200, result);
    } catch (err) {
      writeJson(res, err.statusCode || 400, { error: err.message });
    }
    return true;
  }

  if (urlPath === '/admin/api/upstream-validations' && req.method === 'GET') {
    const url = new URL(req.url, 'http://localhost');
    const limit = Number(url.searchParams.get('limit')) || 100;
    const pending = getPendingUpstreamValidations();
    const history = getUpstreamValidations(limit);
    const pendingIds = new Set(pending.map(item => item.id));
    writeJson(res, 200, {
      validations: [...pending, ...history.filter(item => !pendingIds.has(item.id))],
      pending_count: pending.length
    });
    return true;
  }

  const valResolveMatch = urlPath.match(/^\/admin\/api\/upstream-validations\/(\d+)\/resolve$/);
  if (valResolveMatch && req.method === 'POST') {
    const ok = resolveUpstreamValidation(valResolveMatch[1]);
    writeJson(res, ok ? 200 : 404, { success: ok });
    return true;
  }

  const valDismissMatch = urlPath.match(/^\/admin\/api\/upstream-validations\/(\d+)\/dismiss$/);
  if (valDismissMatch && req.method === 'POST') {
    const ok = dismissUpstreamValidation(valDismissMatch[1]);
    writeJson(res, ok ? 200 : 404, { success: ok });
    return true;
  }

  const valDeleteMatch = urlPath.match(/^\/admin\/api\/upstream-validations\/(\d+)$/);
  if (valDeleteMatch && req.method === 'DELETE') {
    const ok = deleteUpstreamValidation(valDeleteMatch[1]);
    writeJson(res, ok ? 200 : 404, { success: ok });
    return true;
  }

  if (urlPath === '/admin/api/upstream-validations/manual' && req.method === 'POST') {
    try {
      const body = await readBody(req, MAX_ADMIN_BODY_BYTES);
      const payload = JSON.parse(body.toString('utf8') || '{}');
      if (!payload.validation_url) {
        writeJson(res, 400, { error: 'validation_url is required' });
        return true;
      }
      let validatedUrl = extractValidationUrl(payload.validation_url);
      if (validatedUrl && !isActionableValidationUrl(validatedUrl)) {
        validatedUrl = completeGoogleValidationUrl(validatedUrl, payload.account_name);
      }
      if (!validatedUrl || !isActionableValidationUrl(validatedUrl)) {
        return writeJson(res, 400, { error: '请提供有效的 Google 账号认证链接 (需包含 accounts.google.com)' });
      }
      const rec = recordUpstreamValidation({
        authIndex: payload.auth_index || 'manual',
        provider: 'antigravity',
        accountName: payload.account_name || '手动录入账号',
        validationUrl: validatedUrl,
        errorMessage: payload.error_message || '人工录入 Google 验证链接',
        rawError: ''
      });
      if (!rec) return writeJson(res, 400, { error: '请提供有效的 Google 账号认证链接' });
      writeJson(res, 200, { success: true, record: rec, validation_url: validatedUrl });
    } catch (err) {
      writeJson(res, err.statusCode || 400, { error: err.message });
    }
    return true;
  }

  const rotateMatch = urlPath.match(/^\/admin\/api\/keys\/(\d+)\/rotate$/);
  if (rotateMatch && req.method === 'POST') {
    try { writeJson(res, 200, await rotateCpaKey(rotateMatch[1])); }
    catch (err) { writeJson(res, err.statusCode || 400, { error: err.message }); }
    return true;
  }

  const aliasMatch = urlPath.match(/^\/admin\/api\/keys\/(\d+)\/alias$/);
  if (aliasMatch && req.method === 'PUT') {
    try {
      const body = await readBody(req, MAX_ADMIN_BODY_BYTES);
      const payload = JSON.parse(body.toString('utf8') || '{}');
      writeJson(res, 200, updateKeyAlias(aliasMatch[1], payload.alias));
    } catch (err) {
      writeJson(res, err.statusCode || 400, { error: err.message });
    }
    return true;
  }

  const keyIdMatch = urlPath.match(/^\/admin\/api\/keys\/(\d+)$/);
  if (keyIdMatch && req.method === 'DELETE') {
    deleteCpaKey(keyIdMatch[1])
      .then(result => writeJson(res, 200, result))
      .catch(err => {
        const code = err.message.includes('拒绝删除') ? 403 : (err.message.includes('CPA mgmt') ? 502 : 400);
        writeJson(res, code, { error: err.message });
      });
    return true;
  }

  const quotaMatch = urlPath.match(/^\/admin\/api\/keys\/(\d+)\/quota$/);
  if (quotaMatch) {
    const keyId = quotaMatch[1];
    if (req.method === 'PUT') {
      try {
        const body = await readBody(req, MAX_ADMIN_BODY_BYTES);
        writeJson(res, 200, updateQuotaRule(keyId, JSON.parse(body.toString('utf8') || '{}')));
      } catch (err) {
        writeJson(res, err.statusCode || 400, { error: err.message });
      }
      return true;
    } else if (req.method === 'DELETE') {
      writeJson(res, 200, deleteQuotaRule(keyId));
      return true;
    }
  }

  // -------------------------------------------------------------
  return false;
}

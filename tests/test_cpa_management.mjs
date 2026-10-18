import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const screenshotDir = path.resolve(root, '../../_scratch/cpa-gate');
fs.mkdirSync(screenshotDir, { recursive: true });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-cpa-admin-'));
const adminSecret = 'gate-admin-test-secret-1234567890';
const mgmtSecret = 'gate-mgmt-test-secret-1234567890';
let yaml = 'debug: false\nrequest-retry: 3\n';
let providerItems = [];
let claudeProviderItems = [{ 'api-key': 'sk-mock-claude', prefix: 'old-prefix', 'base-url': 'https://claude.example.com', cloak: { mode: 'auto' }, models: [{ name: 'claude-up', alias: 'claude-public', extra: 'preserve' }], headers: { 'X-Trace': 'trace' }, 'excluded-models': ['claude-old-*'] }];
let oauthAliases = { codex: [{ name: 'gpt-upstream', alias: 'gpt-public', fork: true, 'display-name': 'Preserve title' }], openai: [] };
let oauthExcludedModels = { codex: ['gpt-old-*'], antigravity: ['gemini-old-*'] };
let apiKeys = [];
let lastOAuthCallback;
let lastOAuthQuery;
let lastLogsAfter = 0;
let expiredProbeCalls = 0;
let antigravityQuotaCalls = [];
let files = [{ name: 'codex-test.json', provider: 'codex', email: 'test@example.com', status: 'ready', source: 'file', auth_index: 'auth-1' }];

// 运行总览的运行时事实样本：字段严格对齐 CPA v7.3.x 的 auth-files / api-key-usage 契约。
const bucket = (time, success, failed) => ({ time, success, failed });
const futureIso = seconds => new Date(Date.now() + seconds * 1000).toISOString();
let mockApiKeyUsage = {
  openrouter: {
    'https://openrouter.ai/api/v1|sk-or-v1-aaa': {
      success: 100, failed: 2,
      recent_requests: [bucket('10:00-10:10', 10, 0), bucket('10:10-10:20', 12, 1)]
    },
    'https://openrouter.ai/api/v1|sk-or-v1-bbb': {
      success: 50, failed: 0,
      recent_requests: [bucket('10:00-10:10', 5, 0), bucket('10:10-10:20', 6, 0)]
    }
  },
  stepfun: { 'https://api.stepfun.com/v1|sk-sf': { success: 0, failed: 0, recent_requests: [] } }
};
let gate;

// 路由配置与整份 config 分离存放，这样「只提交 routing 子树」的断言才有意义：
// 写完 routing 后再去比对 cpaConfig 的其余键是否分毫未动。
let cpaRouting = { strategy: 'round-robin' };
let cpaConfig = {
  debug: false, 'request-retry': 3, 'proxy-url': '', 'logging-to-file': true,
  'request-log': false, 'ws-auth': true, 'force-model-prefix': false,
  'usage-statistics-enabled': true, 'api-keys': ['sk-mock-1', 'sk-mock-2'],
  claude: { 'api-key': 'sk-claude-mock' }, vertex: { 'api-key': 'sk-vertex-mock' },
  codex: { base_url: 'https://codex.example.com' },
  'openai-compatibility': [{ 'api-key': 'sk-compat-mock', 'base-url': 'https://compat.example.com' }],
  routing: { strategy: 'round-robin' }, 'quota-exceeded': { 'switch-project': false },
  'trusted-proxies': [], plugins: {}
};

// 路由写入前后的 config 快照比对：mock 的 /config 直接回传 cpaConfig
const cpaConfigSnapshot = () => JSON.parse(JSON.stringify(cpaConfig));

const mock = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const body = await new Promise(resolve => { const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))); });
  const send = (code, value, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type }); res.end(type === 'application/json' ? JSON.stringify(value) : value); };
  if (req.headers.authorization !== `Bearer ${mgmtSecret}` && url.pathname.startsWith('/v0/management')) return send(401, { error: 'mock unauthorized' });
  const p = url.pathname.replace('/v0/management', '');
  if (p === '/api-keys') {
    if (req.method === 'GET') return send(200, { 'api-keys': apiKeys });
    if (req.method === 'PUT') apiKeys = JSON.parse(body);
    if (req.method === 'PATCH') { const patch = JSON.parse(body); apiKeys = apiKeys.map(key => key === patch.old ? patch.new : key); }
    if (req.method === 'DELETE') apiKeys = apiKeys.filter(key => key !== url.searchParams.get('value'));
    return send(200, { status: 'ok' });
  }
  if (p === '/auth-files') {
    if (req.method === 'GET') return send(200, { files });
    if (req.method === 'POST') { files.push({ name: url.searchParams.get('name'), provider: 'codex', source: 'file', status: 'ready' }); return send(200, { status: 'ok' }); }
    if (req.method === 'DELETE') { files = files.filter(f => f.name !== url.searchParams.get('name')); return send(200, { status: 'ok' }); }
  }
  if (p === '/auth-files/download') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(url.searchParams.get('name') === 'meta-test.json' ? '{"dca_token":"dca:mock-meta-token"}' : '{"token":"mock"}'); return; }
  if (p === '/auth-files/models') return send(200, { models: [{ id: 'gpt-test' }] });
  if (p === '/auth-files/refresh') return send(200, { status: 'ok', access_token: 'never-return-this' });
  if (p === '/auth-files/fields') return send(200, { status: 'ok' });
  // 不存在的文件返回 404：真实 CPA 就是这样，mock 若一律 200 就测不出批量部分失败
  if (p === '/auth-files/status') { const payload = JSON.parse(body); const file = files.find(item => item.name === payload.name); if (!file) return send(404, { error: 'auth file not found' }); file.disabled = payload.disabled; return send(200, { status: 'ok', disabled: payload.disabled }); }
  if (p === '/vertex/import') {
    assert.match(req.headers['content-type'], /^multipart\/form-data; boundary=gate-/);
    assert.match(body, /name="file"; filename="vertex-test.json"/);
    assert.match(body, /name="location"/);
    return send(200, { status: 'ok', project_id: 'test-project' });
  }
  if (p === '/config.yaml') {
    if (req.method === 'GET') return send(200, yaml, 'application/yaml');
    yaml = body; return send(200, { ok: true, changed: ['config'] });
  }
  if (p === '/config') {
    // 尽量贴近生产：真实 CPA 的 config 有 49 个顶层键。路由写入必须只动
    // routing 子树，其余键原样保留 —— 这是本批次最关键的回归断言。
    if (req.method === 'GET') return send(200, { ...cpaConfig });
    if (req.method === 'PATCH') {
      const patch = JSON.parse(body || '{}');
      // 深合并：真实 CPA 是按路径 setIn，PATCH routing.session-affinity 不会清掉 routing.strategy。
      // 用 Object.assign 的浅合并会把这层语义做错，测出来的结论是假的。
      for (const [key, value] of Object.entries(patch)) {
        cpaConfig[key] = (value && typeof value === 'object' && !Array.isArray(value)
          && cpaConfig[key] && typeof cpaConfig[key] === 'object' && !Array.isArray(cpaConfig[key]))
          ? { ...cpaConfig[key], ...value }
          : value;
      }
      // cpaRouting 仅供 /routing/strategy 断言用；整棵子树以 cpaConfig.routing 为准
      if (patch.routing) cpaRouting = { ...cpaRouting, ...patch.routing };
      return send(200, { status: 'ok' });
    }
  }
  if (p === '/routing') return send(404, { error: 'not found' });   // CPA v7.3.x 确实没有这个端点
  if (p === '/routing/strategy') return send(200, { strategy: cpaRouting.strategy });
  if (p === '/routing/cooldown/reset') return send(200, { status: 'ok' });
  if (p === '/api-key-usage') return send(200, mockApiKeyUsage);
  if (p === '/openai-compatibility') {
    if (req.method === 'GET') return send(200, { 'openai-compatibility': providerItems });
    providerItems = JSON.parse(body); return send(200, { status: 'ok' });
  }
  if (p === '/claude-api-key') {
    if (req.method === 'GET') return send(200, { 'claude-api-key': claudeProviderItems });
    claudeProviderItems = JSON.parse(body); return send(200, { status: 'ok' });
  }
  if (p === '/oauth-excluded-models') {
    if (req.method === 'GET') return send(200, { 'oauth-excluded-models': oauthExcludedModels });
    oauthExcludedModels = JSON.parse(body); return send(200, { status: 'ok' });
  }
  if (p === '/oauth-model-alias') {
    if (req.method === 'GET') return send(200, { 'oauth-model-alias': oauthAliases });
    const patch = JSON.parse(body); oauthAliases[patch.channel] = patch.aliases; return send(200, { status: 'ok' });
  }
  if (p === '/latest-version') return send(200, { 'latest-version': 'v7.3.0' });
  if (p === '/api-call') {
    const payload = JSON.parse(body);
    if (payload.url.endsWith('/v1internal:retrieveUserQuotaSummary')) {
      antigravityQuotaCalls.push({ url: payload.url, project: JSON.parse(payload.data).project });
      return send(200, { status_code: 200, body: JSON.stringify({ groups: [
        { displayName: 'Gemini Models', buckets: [
          { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.1617909 },
          { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.9999821 }
        ] }
      ] }) });
    }
    if (payload.url.endsWith('/v1internal:loadCodeAssist')) {
      antigravityQuotaCalls.push({ url: payload.url });
      return send(200, { status_code: 200, body: JSON.stringify({ paidTier: { id: 'pro', name: 'Pro' } }) });
    }
    if (payload.authIndex === 'auth-codex-expired') { expiredProbeCalls++; return send(200, { status_code: 200, body: '{"rate_limit":{"primary_window":{"used_percent":0}}}' }); }
    if (payload.url === 'https://example.com/v1/models') {
      assert.equal(payload.header.Authorization, 'Bearer sk-mock-provider-key');
      return send(200, { status_code: 200, body: JSON.stringify({ data: [{ id: 'mock-model-a' }, { id: 'mock-model-b' }] }) });
    }
    if (payload.url === 'https://example.com/v1/chat/completions') {
      assert.equal(JSON.parse(payload.data).max_tokens, 8);
      return send(200, { status_code: 200, body: JSON.stringify({ choices: [{ message: { content: 'OK' } }] }) });
    }
    if (payload.url === 'https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus') {
      return send(200, { status_code: 200, body: JSON.stringify({ userStatus: { planStatus: { planInfo: { planName: 'Test plan' }, dailyQuotaRemainingPercent: 62, weeklyQuotaRemainingPercent: 48, dailyQuotaResetAtUnix: 1790300000 } } }) });
    }
    if (payload.url === 'https://api.meta.ai/muse-code/key') {
      assert.equal(payload.header.Authorization, 'Bearer dca:mock-meta-token');
      return send(200, { status_code: 200, body: JSON.stringify({ api_key: 'must-never-reach-browser', subs_tier_name: 'Test tier', is_subs_active: true, subs_usage: { window: { used_percent: 20, resets_at: 1790300000 }, weekly: { used_percent: 45 } } }) });
    }
    return send(200, { status_code: 200, body: JSON.stringify({ five_hour: { utilization: 14, resets_at: '2026-09-25T00:00:00Z' } }) });
  }
  if (p === '/codex-auth-url') { lastOAuthQuery = url.search; return send(200, { status: 'ok', url: 'https://example.com/auth', state: 'codex-test-state' }); }
  if (p === '/kimi-auth-url') { lastOAuthQuery = url.search; return send(200, { status: 'ok', url: 'https://example.com/device', user_code: 'ABCD-1234', flow: 'device', expires_in: 300 }); }
  if (p === '/oauth-callback') { lastOAuthCallback = JSON.parse(body); return send(200, { status: 'ok' }); }
  if (p === '/oauth-session') return send(200, { status: 'ok' });
  if (p === '/get-auth-status') return send(200, { status: 'ok' });
  if (p === '/logs') { lastLogsAfter = Number(url.searchParams.get('after')); return send(200, req.method === 'DELETE' ? { success: true } : { lines: ['mock cpa log'], 'latest-timestamp': 42 }); }
  if (p === '/request-error-logs') return send(200, { files: [{ name: 'error-test.log', size: 4, modified: 42 }] });
  if (p === '/request-error-logs/error-test.log') return send(200, 'oops', 'text/plain');
  if (p === '/request-error-logs/error-huge.log') return send(200, Buffer.alloc(2 * 1024 * 1024 + 10, 'x').toString(), 'text/plain');
  if (p === '/request-retry') return send(200, req.method === 'GET' ? { 'request-retry': 3 } : { status: 'ok' });
  if (['/logging-to-file', '/max-retry-interval', '/proxy-url', '/request-log', '/ws-auth', '/usage-statistics-enabled', '/quota-exceeded/switch-project', '/quota-exceeded/switch-preview-model', '/error-logs-max-files'].includes(p)) {
    return send(200, req.method === 'GET' ? { [p.split('/').at(-1)]: p === '/proxy-url' ? '' : p === '/max-retry-interval' ? 30 : p === '/error-logs-max-files' ? 100 : true } : { status: 'ok' });
  }
  if (p === '/reset-quota') return send(200, { status: 'ok' });
  return send(404, { error: `mock unhandled ${p}` });
});

function listen(server) { return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port))); }
async function freePort() { const server = net.createServer(); const port = await listen(server); await new Promise(resolve => server.close(resolve)); return port; }
async function call(port, route, init = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { ...init, headers: { Authorization: `Bearer ${adminSecret}`, ...(init.headers || {}) } });
  const content = response.headers.get('content-type') || '';
  return { status: response.status, etag: response.headers.get('etag'), body: content.includes('json') ? await response.json() : await response.text() };
}

try {
  const mockPort = await listen(mock);
  const gatePort = await freePort();
  gate = spawn(process.execPath, [path.join(root, 'server.mjs')], {
    cwd: root,
    env: { ...process.env, GATE_DIR: root, GATE_DB: path.join(temp, 'gate.db'), GATE_KEEPER_DB: path.join(temp, 'missing.db'), GATE_MGMT_HOST: '127.0.0.1', GATE_MGMT_PORT: String(mockPort), GATE_MGMT_SECRET: mgmtSecret, GATE_ADMIN_SECRET: adminSecret, GATE_UPSTREAM_HOST: '127.0.0.1', GATE_UPSTREAM_PORT: String(mockPort), GATE_BIND_TARGETS: `127.0.0.1:${gatePort}:test` },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  gate.stderr.on('data', chunk => stderr += chunk.toString());
  let ready = false;
  for (let i = 0; i < 80; i++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    try { const response = await fetch(`http://127.0.0.1:${gatePort}/healthz`); if (response.ok) { ready = true; break; } } catch {}
  }
  assert.ok(ready, `Gate did not start: ${stderr}`);
  assert.equal((await fetch(`http://127.0.0.1:${gatePort}/admin/api/cpa/auth-files`)).status, 401);
  assert.equal((await call(gatePort, '/admin/api/cpa/auth-files')).body.files.length, 1);
  assert.equal((await call(gatePort, '/admin/api/cpa/auth-files/models?name=codex-test.json')).body.models[0].id, 'gpt-test');
  assert.equal((await call(gatePort, '/admin/api/cpa/auth-files/status', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'codex-test.json', disabled: true }) })).body.disabled, true);
  assert.deepEqual((await call(gatePort, '/admin/api/cpa/auth-files/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'codex-test.json' }) })).body, { success: true });
  assert.equal((await call(gatePort, '/admin/api/cpa/auth-files', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'new.json', content: '{"token":"safe-test"}' }) })).status, 200);
  assert.equal((await call(gatePort, '/admin/api/cpa/auth-files')).body.files.length, 2);
  assert.equal((await call(gatePort, '/admin/api/cpa/auth-files/download?name=new.json')).body.token, 'mock');
  assert.equal((await call(gatePort, '/admin/api/cpa/auth-files?name=..%2Fbad.json', { method: 'DELETE' })).status, 400);
  assert.equal((await call(gatePort, '/admin/api/cpa/auth-files?name=new.json', { method: 'DELETE' })).status, 200);
  assert.equal((await call(gatePort, '/admin/api/cpa/vertex/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'vertex-test.json', content: '{"project_id":"test-project","private_key":"test"}', location: 'us-central1' }) })).body.project_id, 'test-project');
  files.push({ name: 'claude-test.json', provider: 'claude', email: 'claude@example.com', auth_index: 'auth-claude', source: 'file' });
  assert.equal((await call(gatePort, '/admin/api/cpa/provider-quota?auth_index=auth-claude')).body.results.usage.data.five_hour.utilization, 14);
  files.push({ name: 'devin-test.json', provider: 'devin', email: 'devin@example.com', auth_index: 'auth-devin', source: 'file' });
  assert.equal((await call(gatePort, '/admin/api/cpa/provider-quota?auth_index=auth-devin')).body.results.quota.data.daily_remaining_percent, 62);
  files.push({ name: 'meta-test.json', provider: 'meta', email: 'meta@example.com', auth_index: 'auth-meta', source: 'file' });
  const metaQuota = await call(gatePort, '/admin/api/cpa/provider-quota?auth_index=auth-meta');
  assert.equal(metaQuota.status, 200, JSON.stringify(metaQuota.body));
  assert.equal(metaQuota.body.results.quota.data.window.used_percent, 20);
  assert.ok(!JSON.stringify(metaQuota.body).includes('must-never-reach-browser'));
  assert.ok(!JSON.stringify(metaQuota.body).includes('dca:mock-meta-token'));
  files.push({ name: 'antigravity-test.json', provider: 'antigravity', email: 'antigravity@example.com', auth_index: 'auth-antigravity', project_id: 'test-antigravity-project', source: 'file' });
  const antigravity = (await call(gatePort, '/admin/api/upstream-quotas?refresh=1')).body.accounts.find(account => account.auth_index === 'auth-antigravity');
  const geminiBuckets = antigravity.groups.find(group => group.name === 'Gemini Models').buckets;
  assert.equal(geminiBuckets.find(bucket => bucket.bucket_id === 'gemini-weekly').remaining_percent, 16.1);
  assert.equal(geminiBuckets.find(bucket => bucket.bucket_id === 'gemini-5h').remaining_percent, 99.9);
  assert.ok(antigravityQuotaCalls.every(call => call.url.startsWith('https://daily-cloudcode-pa.googleapis.com/')));
  assert.equal(antigravityQuotaCalls[0].project, 'test-antigravity-project');
  const antigravityProbe = await call(gatePort, '/admin/api/upstream-auth/activate-window', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ authIndex: 'auth-antigravity', provider: 'antigravity' }) });
  assert.equal(antigravityProbe.status, 200);
  assert.equal(antigravityQuotaCalls.at(-1).url, 'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary');
  assert.equal(antigravityQuotaCalls.at(-1).project, 'test-antigravity-project');
  // 验证未刷新整体时，就地缓存中的 targetAcc 已直接更新
  const cachedAccounts = (await call(gatePort, '/admin/api/upstream-quotas')).body.accounts;
  const inPlaceAcc = cachedAccounts.find(a => a.auth_index === 'auth-antigravity');
  assert.ok(inPlaceAcc.groups.length > 0);
  files.push({ name: 'claude-expired.json', provider: 'claude', email: 'claude-expired@example.com', auth_index: 'auth-claude-expired', source: 'file', status: 'error', status_message: 'token expired', unavailable: true });
  files.push({ name: 'codex-expired.json', provider: 'codex', email: 'codex-expired@example.com', auth_index: 'auth-codex-expired', source: 'file', status: 'error', status_message: 'token expired', unavailable: true });
  const expiredFiles = (await call(gatePort, '/admin/api/cpa/auth-files')).body.files;
  assert.equal(expiredFiles.find(file => file.auth_index === 'auth-claude-expired').gate_health.state, 'expired');
  assert.equal((await call(gatePort, '/admin/api/cpa/provider-quota?auth_index=auth-claude-expired')).status, 409);
  const expiredUpstream = (await call(gatePort, '/admin/api/upstream-quotas?refresh=1')).body.accounts.find(account => account.auth_index === 'auth-codex-expired');
  assert.equal(expiredUpstream.health.state, 'expired');
  assert.deepEqual(expiredUpstream.groups, []);
  assert.equal(expiredProbeCalls, 0);
  assert.equal((await call(gatePort, '/admin/api/upstream-auth/activate-window', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ authIndex: 'auth-codex-expired', provider: 'codex' }) })).status, 409);
  assert.equal(expiredProbeCalls, 0);
  const current = await call(gatePort, '/admin/api/cpa/config-yaml');
  assert.ok(current.etag);
  assert.equal((await call(gatePort, '/admin/api/cpa/config-yaml', { method: 'PUT', headers: { 'Content-Type': 'application/yaml', 'If-Match': '"stale"' }, body: 'debug: true\n' })).status, 409);
  assert.equal((await call(gatePort, '/admin/api/cpa/config-yaml', { method: 'PUT', headers: { 'Content-Type': 'application/yaml', 'If-Match': current.etag }, body: 'debug: true\n' })).status, 200);
  assert.equal(yaml, 'debug: true\n');
  assert.equal((await call(gatePort, '/admin/api/cpa/providers/openai-compatibility', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '[{"name":"mock","base-url":"https://example.com/v1","api-key-entries":[{"api-key":"sk-mock-provider-key"}]}]' })).status, 200);
  assert.equal((await call(gatePort, '/admin/api/cpa/providers/openai-compatibility')).body['openai-compatibility'].length, 1);
  assert.equal((await call(gatePort, '/admin/api/cpa/providers/claude-api-key')).body['claude-api-key'][0].cloak.mode, 'auto');
  assert.deepEqual((await call(gatePort, '/admin/api/cpa/providers/oauth-excluded-models')).body['oauth-excluded-models'].codex, ['gpt-old-*']);
  assert.deepEqual((await call(gatePort, '/admin/api/cpa/providers/openai-compatibility/probe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ index: 0, key_index: 0, operation: 'discover' }) })).body.models, ['mock-model-a', 'mock-model-b']);
  assert.equal((await call(gatePort, '/admin/api/cpa/providers/openai-compatibility/probe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ index: 0, key_index: 0, operation: 'test', model: 'mock-model-a' }) })).body.ok, true);
  assert.equal((await call(gatePort, '/admin/api/cpa/providers/openai-compatibility/probe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ index: 8, key_index: 0, operation: 'discover' }) })).status, 404);
  assert.equal((await call(gatePort, '/admin/api/cpa/oauth-model-alias', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: 'openai', aliases: [{ name: 'gpt-test', alias: 'test' }] }) })).status, 200);
  assert.equal((await call(gatePort, '/admin/api/cpa/oauth-model-alias')).body['oauth-model-alias'].openai[0].alias, 'test');
  assert.equal((await call(gatePort, '/admin/api/cpa/latest-version')).body['latest-version'], 'v7.3.0');
  assert.equal((await call(gatePort, '/admin/api/cpa/oauth/codex/start', { method: 'POST' })).body.state, 'codex-test-state');
  assert.equal(lastOAuthQuery, '?is_webui=true');
  assert.equal((await call(gatePort, '/admin/api/cpa/oauth/kimi/start', { method: 'POST' })).body.user_code, 'ABCD-1234');
  assert.equal(lastOAuthQuery, '');
  assert.equal((await call(gatePort, '/admin/api/cpa/oauth/callback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'claude', redirect_url: 'http://localhost/callback?code=test&state=codex-test-state' }) })).status, 200);
  assert.deepEqual(lastOAuthCallback, { provider: 'anthropic', redirect_url: 'http://localhost/callback?code=test&state=codex-test-state' });
  assert.equal((await call(gatePort, '/admin/api/cpa/oauth/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: 'codex-test-state' }) })).status, 200);
  assert.equal((await call(gatePort, '/admin/api/cpa/logs')).body.lines[0], 'mock cpa log');
  assert.ok(lastLogsAfter >= Math.floor(Date.now() / 1000) - 3660, `logs after=${lastLogsAfter} should be limited to the last hour`);
  assert.equal((await call(gatePort, '/admin/api/cpa/settings/request-retry')).body['request-retry'], 3);
  assert.equal((await call(gatePort, '/admin/api/cpa/settings/error-logs-max-files')).body['error-logs-max-files'], 100);
  assert.equal((await call(gatePort, '/admin/api/cpa/request-error-logs/download?name=error-test.log')).body, 'oops');
  // 错误日志在线预览与安全防御
  assert.equal((await call(gatePort, '/admin/api/cpa/request-error-logs/preview?name=error-test.log')).body, 'oops');
  assert.equal((await call(gatePort, '/admin/api/cpa/request-error-logs/preview?name=../invalid.log')).status, 400);
  const hugeLogResp = await call(gatePort, '/admin/api/cpa/request-error-logs/preview?name=error-huge.log');
  assert.equal(hugeLogResp.status, 413);
  assert.match(hugeLogResp.body.error, /2 MiB/);
  assert.equal((await fetch(`http://127.0.0.1:${gatePort}/admin/cpa-management.js`)).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${gatePort}/admin/cpa-management.css`)).status, 200);
  const created = await call(gatePort, '/admin/api/keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ alias: 'imported', api_key: 'sk-imported-existing-1234567890' }) });
  assert.equal(created.status, 200);
  assert.equal(created.body.key.api_key, 'sk-imported-existing-1234567890');
  const rotated = await call(gatePort, `/admin/api/keys/${created.body.key.id}/rotate`, { method: 'POST' });
  assert.equal(rotated.status, 200);
  assert.equal(rotated.body.key.id, created.body.key.id);
  assert.ok(rotated.body.key.api_key.startsWith('sk-cpa-'));
  assert.deepEqual(apiKeys, [rotated.body.key.api_key]);

  // ---- 运行总览：运行时事实与冷却诊断 ----
  // 样本在此处注入，避免干扰上方依赖调用顺序的额度探针断言。
  files.push(
    {
      name: 'antigravity-a.json', provider: 'antigravity', email: 'a@example.com', status: 'active',
      disabled: false, auth_index: 'idx-a', priority: 10, source: 'file',
      success: 300, failed: 12,
      recent_requests: [bucket('10:00-10:10', 5, 0), bucket('10:10-10:20', 8, 1), bucket('10:20-10:30', 6, 0)],
      cooldowns: []
    },
    {
      // 整凭证冷却：额度限制 + 429，应判为不可调度
      name: 'antigravity-b.json', provider: 'antigravity', email: 'b@example.com', status: 'active',
      disabled: false, auth_index: 'idx-b', priority: 10, source: 'file',
      success: 90, failed: 40,
      recent_requests: [bucket('10:00-10:10', 2, 3), bucket('10:10-10:20', 1, 5)],
      cooldowns: [{ scope: 'credential', reason: 'quota', retry_at: futureIso(600), remaining_seconds: 600, http_status: 429, backoff_level: 2 }]
    },
    {
      // 模型级冷却 ×2：Cloudflare 验证 + 上游暂时出错
      name: 'antigravity-c.json', provider: 'antigravity', email: 'c@example.com', status: 'active',
      disabled: false, auth_index: 'idx-c', priority: 5, source: 'file',
      success: 150, failed: 3,
      recent_requests: [bucket('10:00-10:10', 4, 0), bucket('10:10-10:20', 3, 1)],
      cooldowns: [
        { scope: 'model', model_key: 'gemini-3-pro', reason: 'cloudflare_challenge', retry_at: futureIso(300), remaining_seconds: 300 },
        { scope: 'model', model_key: 'gemini-3-flash', reason: 'transient_error', retry_at: futureIso(120), remaining_seconds: 120 }
      ]
    },
    {
      name: 'antigravity-d.json', provider: 'antigravity', email: 'd@example.com', status: 'active',
      disabled: true, auth_index: 'idx-d', priority: 10, source: 'file',
      success: 10, failed: 0, recent_requests: [bucket('10:00-10:10', 1, 0)], cooldowns: []
    }
  );
  assert.equal((await fetch(`http://127.0.0.1:${gatePort}/admin/overview.js`)).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${gatePort}/admin/overview.css`)).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${gatePort}/admin/style.css`)).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${gatePort}/admin/quotas.js`)).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${gatePort}/admin/keys.js`)).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${gatePort}/admin/stats.js`)).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${gatePort}/admin/logs.js`)).status, 200);
  // 回归：静态资源缺失必须返回 404 而不是二次 writeHead 崩掉整个网关进程
  assert.equal((await fetch(`http://127.0.0.1:${gatePort}/admin/assets/routing-header.png`)).status, 200);
  // 回归：资源文件缺失必须返回 404 而不是在 catch 里二次 writeHead，
  // 触发 ERR_HTTP_HEADERS_SENT 让整个网关进程退出。直接调处理器以命中「读文件失败」分支
  // ——走 URL 的 fetch 已被 WHATWG URL 归一化，永远摸不到这一支。
  {
    const { handleStaticRoutes } = await import('../lib/routes/static-routes.mjs');
    const emptyGuardDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-assets-404-'));
    const capture = (targetPath) => {
      const seen = [];
      const res = {
        writeHead: (code) => { seen.push(code); if (seen.length > 1) throw new Error('ERR_HTTP_HEADERS_SENT: 二次 writeHead'); },
        end: () => {}
      };
      handleStaticRoutes({ url: targetPath }, res, targetPath, emptyGuardDir);
      return seen;
    };
    // 映射里存在但磁盘上没有 -> 恰好一次 404
    assert.deepEqual(capture('/admin/overview.js'), [404], '外置脚本缺失应返回单个 404');
    assert.deepEqual(capture('/admin/overview.css'), [404], '外置样式缺失应返回单个 404');
    assert.deepEqual(capture('/admin/style.css'), [404], '外置主样式缺失应返回单个 404');
    assert.deepEqual(capture('/admin/quotas.js'), [404], '外置配额脚本缺失应返回单个 404');
    assert.deepEqual(capture('/admin/keys.js'), [404], '外置密钥脚本缺失应返回单个 404');
    assert.deepEqual(capture('/admin/stats.js'), [404], '外置统计脚本缺失应返回单个 404');
    assert.deepEqual(capture('/admin/logs.js'), [404], '外置流水脚本缺失应返回单个 404');
    assert.deepEqual(capture('/admin/assets/sakura-observatory-v3.webp'), [404], '图片资源缺失应返回单个 404');
    // 映射里不存在的路径应放行给后续路由，而不是在这里 404
    assert.deepEqual(capture('/admin/does-not-exist.js'), [], '未登记的路径应交还主路由处理');
    assert.deepEqual(capture('/admin/assets/not-registered.png'), [], '未登记的图片路径应交还主路由处理');
    fs.rmSync(emptyGuardDir, { recursive: true, force: true });
  }
  assert.equal((await fetch(`http://127.0.0.1:${gatePort}/healthz`)).status, 200, '静态资源 404 后网关仍须存活');
  assert.equal((await fetch(`http://127.0.0.1:${gatePort}/admin/api/runtime-facts`)).status, 401, '运行总览必须要求管理密钥');

  const facts = (await call(gatePort, '/admin/api/runtime-facts')).body;
  assert.equal(facts.degraded, false, 'mock CPA 可用时不应降级');
  assert.equal(facts.source, 'cpa_runtime');
  assert.equal(facts.window_minutes, 200);
  assert.equal(facts.window, '3h20m');
  assert.ok(Array.isArray(facts.available_windows) && facts.available_windows.length === 6, '应提供 6 个可选时间窗口 (含 30d)');

  // 多窗口参数测试：5h 与 1d 动态计算与分桶切片
  const facts5h = (await call(gatePort, '/admin/api/runtime-facts?window=5h')).body;
  assert.equal(facts5h.window, '5h');
  assert.equal(facts5h.window_minutes, 300);
  assert.equal(facts5h.bucket_count, 30);
  assert.equal(facts5h.totals.buckets.length, 30);

  const facts1d = (await call(gatePort, '/admin/api/runtime-facts?window=1d')).body;
  assert.equal(facts1d.window, '1d');
  assert.equal(facts1d.window_minutes, 1440);
  assert.equal(facts1d.bucket_minutes, 60);
  assert.equal(facts1d.bucket_count, 24);
  assert.equal(facts1d.totals.buckets.length, 24);

  const facts30d = (await call(gatePort, '/admin/api/runtime-facts?window=30d')).body;
  assert.equal(facts30d.window, '30d');
  assert.equal(facts30d.window_minutes, 43200);
  assert.equal(facts30d.bucket_minutes, 1440);
  assert.equal(facts30d.bucket_count, 30);
  assert.equal(facts30d.totals.buckets.length, 30);

  assert.ok(facts.credentials.length >= 4, '应聚合出全部凭据');
  assert.equal(facts.providers_derived, false);
  const byIndex = Object.fromEntries(facts.credentials.map(c => [c.auth_index, c]));

  // 整凭证冷却：额度限制，判为不可调度
  assert.equal(byIndex['idx-b'].health.state, 'cooldown');
  assert.equal(byIndex['idx-b'].health.blocked, true);
  assert.equal(byIndex['idx-b'].health.cooldown.scope, 'credential');
  assert.equal(byIndex['idx-b'].health.cooldown.reason_label, '额度限制');
  assert.equal(byIndex['idx-b'].health.cooldown.http_status, 429);
  assert.equal(byIndex['idx-b'].health.cooldown.backoff_level, 2);
  assert.ok(byIndex['idx-b'].health.cooldown.remaining_seconds > 0);

  // 模型级冷却：作用域为 models，2 个模型，按严重度取 Cloudflare 验证
  assert.equal(byIndex['idx-c'].health.state, 'cooldown');
  assert.equal(byIndex['idx-c'].health.cooldown.scope, 'models');
  assert.equal(byIndex['idx-c'].health.cooldown.model_count, 2);
  assert.equal(byIndex['idx-c'].health.cooldown.reason_label, 'Cloudflare 验证');

  // 无冷却且未停用 → 可用；已停用 → 停用
  assert.equal(byIndex['idx-a'].health.state, 'ready');
  assert.equal(byIndex['idx-a'].health.blocked, false);
  assert.equal(byIndex['idx-d'].health.state, 'disabled');

  // 供应商维度来自 api-key-usage，成功率必须落在 0-100% 且与分子分母自洽
  const openrouter = facts.providers.find(p => p.provider === 'openrouter');
  assert.ok(openrouter, '应聚合出 openrouter 供应商');
  assert.equal(openrouter.key_count, 2);
  assert.equal(openrouter.total_success, 150);
  assert.equal(openrouter.total_failed, 2);
  assert.equal(openrouter.success_rate, 98.68);
  assert.ok(facts.providers.every(p => p.success_rate == null || (p.success_rate >= 0 && p.success_rate <= 100)),
    '成功率不得越界');
  const stepfun = facts.providers.find(p => p.provider === 'stepfun');
  assert.equal(stepfun.success_rate, null, '无流量时成功率为 null 而非 0');
  // 桶按位置对齐后右贴窗口末端
  const orBuckets = openrouter.buckets.filter(b => b.success || b.failed);
  assert.equal(orBuckets.at(-1).success, 18, '两把 key 的末桶应相加');
  assert.equal(orBuckets.at(-1).failed, 1);

  // 凭证统计：非 all 档取 CPA 运行时事实，all 档退回本地推算
  const stats24h = (await call(gatePort, '/admin/api/upstream-auth-stats?range=24h')).body;
  assert.equal(stats24h.source.requests, 'cpa_runtime');
  assert.equal(stats24h.source.tokens, 'local_metered');
  const statB = stats24h.items.find(i => i.auth_index === 'idx-b');
  assert.equal(statB.runtime_source, 'cpa_runtime');
  assert.equal(statB.total_requests, 130, '请求数应取 CPA 运行时累计值');
  assert.equal(statB.failure_count, 40);
  const statsAll = (await call(gatePort, '/admin/api/upstream-auth-stats?range=all')).body;
  assert.equal(statsAll.source.requests, 'local_estimate', '「全部历史」撑不起 CPA 200 分钟窗口，必须标为本地推算');
  assert.equal(statsAll.source.runtime_window_minutes, null);
  assert.ok(statsAll.source.note.includes('本地基线推算'));

  // 运行时一览：单项失败不阻断整块
  const config = (await call(gatePort, '/admin/api/runtime-config')).body;
  assert.equal(config.config.ok, true);
  assert.equal(config.config.value['request-retry'], 3);
  assert.equal(config.routing.ok, true);
  assert.equal(config.routing.value.strategy, 'round-robin');
  assert.equal(config.version.value['latest-version'], 'v7.3.0');
  assert.equal(config.usage_statistics.ok, true);

  // 关键兼容：/admin/api/cpa/runtime-config 代理端点必须等价返回，杜绝面板报 Unsupported CPA management operation
  const cpaRuntimeConfig = (await call(gatePort, '/admin/api/cpa/runtime-config')).body;
  assert.equal(cpaRuntimeConfig.config.ok, true);
  assert.equal(cpaRuntimeConfig.routing.value.strategy, 'round-robin');

  // CPA 只读端点经 Gate 桥转发，管理密钥不外泄
  const bridgedUsage = (await call(gatePort, '/admin/api/cpa/api-key-usage')).body;
  assert.equal(bridgedUsage.openrouter['https://openrouter.ai/api/v1|sk-or-v1-aaa'].success, 100);

  // ---- P1：路由策略写入 ----
  // 生产 CPA 的 config 有 49 个顶层键，而 Gate 原先只有 config-yaml PUT（整体替换）。
  // 路由写入绝不能误伤其余键，所以这里逐键比对写入前后的 config 快照。
  // 必须在写入前捕获快照。写成「写入后再取一份」的话就是拿被改后的状态跟它自己比，
  // 断言会永远通过 —— 这正是下面那条变异测试要防的坑。
  const configBefore = cpaConfigSnapshot();
  const putRouting = (payload) => call(gatePort, '/admin/api/upstream-routing', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });

  const weighted = await putRouting({ strategy: 'weighted-round-robin' });
  assert.equal(weighted.status, 200, JSON.stringify(weighted.body));
  assert.equal(weighted.body.routing.strategy, 'weighted-round-robin');
  const afterWeighted = cpaConfigSnapshot();
  assert.equal(afterWeighted.routing.strategy, 'weighted-round-robin', 'routing 子树应被更新');
  // 关键回归：除 routing 外，其余配置键必须原样保留
  for (const key of Object.keys(configBefore)) {
    if (key === 'routing') continue;
    assert.deepEqual(afterWeighted[key], configBefore[key], `路由写入误改了配置键 ${key}`);
  }
  assert.deepEqual(Object.keys(afterWeighted).sort(), Object.keys(configBefore).sort(), '路由写入不得增删配置键');

  const affinity = await putRouting({ session_affinity: true, session_affinity_ttl: '900' });
  assert.equal(affinity.status, 200);
  assert.equal(affinity.body.routing.session_affinity, true);
  assert.equal(affinity.body.routing.session_affinity_ttl, '900');
  assert.equal(affinity.body.routing.strategy, 'weighted-round-robin', '只提交部分字段时不得清掉策略');

  // TTL 留空 = 清掉该键（与 CPA 面板 DR() 语义一致），而不是写成 0
  const cleared = await putRouting({ session_affinity_ttl: '' });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.routing.session_affinity_ttl, '');
  assert.equal(cleared.body.routing.session_affinity, true, '清空 TTL 不得顺带关掉粘性');

  // 非法输入一律 400，且不产生任何 CPA 写入
  const beforeInvalid = JSON.stringify(cpaConfigSnapshot());
  for (const bad of [
    { strategy: 'random' },
    { session_affinity: 'yes' },
    { session_affinity_ttl: 'abc' },
    { session_affinity_ttl: '-5' },
    { strategy: 'round-robin', api_keys: ['sk-evil'] },   // 白名单外的键必须被拒
    {}
  ]) {
    const rejected = await putRouting(bad);
    assert.equal(rejected.status, 400, `非法路由入参应被拒: ${JSON.stringify(bad)}`);
    assert.ok(rejected.body.error, '400 响应应带错误说明');
  }
  assert.equal(JSON.stringify(cpaConfigSnapshot()), beforeInvalid, '被拒的写入不得改动 CPA 配置');
  // 路由写入必须要求管理密钥（PUT 无 Authorization 头）
  const routingBeforeUnauth = cpaRouting.strategy;
  const noAuthRouting = await fetch(`http://127.0.0.1:${gatePort}/admin/api/upstream-routing`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ strategy: 'fill-first' })
  });
  assert.equal(noAuthRouting.status, 401, '路由写入必须要求管理密钥');
  assert.equal(cpaRouting.strategy, routingBeforeUnauth, '未鉴权的写入请求不得改动 CPA 配置');

  // 验证对齐 CPA 最新支持的 smart (临期优先) 与 pace (步调均衡) 路由调度策略
  const smartRes = await putRouting({ strategy: 'smart' });
  assert.equal(smartRes.status, 200);
  assert.equal(smartRes.body.routing.strategy, 'smart');
  assert.equal(cpaConfigSnapshot().routing.strategy, 'smart');

  const paceRes = await putRouting({ strategy: 'pace' });
  assert.equal(paceRes.status, 200);
  assert.equal(paceRes.body.routing.strategy, 'pace');
  assert.equal(cpaConfigSnapshot().routing.strategy, 'pace');

  // 验证别名兼容归一化（如 smart-routing、pace-routing）
  const smartAliasRes = await putRouting({ strategy: 'smart-routing' });
  assert.equal(smartAliasRes.status, 200);
  assert.equal(smartAliasRes.body.routing.strategy, 'smart');

  const paceAliasRes = await putRouting({ strategy: 'pace-routing' });
  assert.equal(paceAliasRes.status, 200);
  assert.equal(paceAliasRes.body.routing.strategy, 'pace');

  // 恢复默认策略，避免影响后续 UI 用例
  assert.equal((await putRouting({ strategy: 'round-robin', session_affinity: false })).status, 200);

  // 关键兼容：/admin/api/cpa/upstream-routing 代理写入也必须正常放行
  const cpaPutRes = await call(gatePort, '/admin/api/cpa/upstream-routing', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ strategy: 'round-robin' })
  });
  assert.equal(cpaPutRes.status, 200);

  // ---- P1：认证文件批量操作 ----
  const batch = (payload) => call(gatePort, '/admin/api/upstream-auth/batch', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
  // 批量用例需要真实存在的凭据：mock 对不存在的文件会回 404
  const batchNames = ['batch-1.json', 'batch-2.json', 'batch-3.json'];
  for (const name of batchNames) {
    files.push({ name, provider: 'codex', email: `${name}@example.com`, auth_index: `idx-${name}`, source: 'file', status: 'active' });
  }
  const disabled = await batch({ names: batchNames, action: 'disable' });
  assert.equal(disabled.status, 200, JSON.stringify(disabled.body));
  assert.equal(disabled.body.total, 3);
  assert.equal(disabled.body.succeeded, 3);
  assert.equal(disabled.body.failed, 0);
  assert.ok(disabled.body.results.every(r => r.ok && r.name));

  assert.equal((await batch({ names: batchNames, action: 'enable' })).body.succeeded, 3);
  assert.equal((await batch({ names: batchNames, action: 'priority', value: 42 })).body.succeeded, 3);

  // 逐条执行：中间那条失败不得阻断后面的条目
  const partial = await batch({ names: ['batch-1.json', 'nonexistent-file.json', 'batch-3.json'], action: 'disable' });
  assert.equal(partial.body.total, 3);
  assert.equal(partial.body.succeeded, 2, '第 3 条应在第 2 条失败后照常成功');
  assert.equal(partial.body.failed, 1);
  const failedRow = partial.body.results.find(r => !r.ok);
  assert.equal(failedRow.name, 'nonexistent-file.json');
  assert.ok(failedRow.error, '失败条目必须带原因');
  assert.ok(partial.body.results.filter(r => r.ok).length === 2);

  // 入参校验
  for (const bad of [
    { names: [], action: 'disable' },
    { names: ['ok.json'], action: 'explode' },
    { names: ['../escape.json'], action: 'disable' },
    { names: ['ok.json'], action: 'priority', value: 99999 },
    { names: ['ok.json'], action: 'priority', value: 'high' }
  ]) {
    const rejected = await batch(bad);
    assert.equal(rejected.status, 400, `非法批量入参应被拒: ${JSON.stringify(bad)}`);
  }
  const tooMany = await batch({ names: Array.from({ length: 201 }, (_, i) => `f${i}.json`), action: 'disable' });
  assert.equal(tooMany.status, 400, '超批量上限应被拒');

  // 去重但保序：同一个文件选中两次只处理一次
  const dedup = await batch({ names: ['batch-1.json', 'batch-1.json'], action: 'disable' });
  assert.equal(dedup.body.total, 1, '重复文件名应被去重');

  // 批量响应不得回显任何凭据材料
  const batchBody = JSON.stringify(partial.body);
  assert.ok(!batchBody.includes('sk-mock'), '批量响应绝不可回显 API Key');
  assert.ok(!batchBody.toLowerCase().includes('access_token'), '批量响应绝不可回显令牌');

  // 单文件端点回归：批量上线后旧接口必须照常可用
  assert.equal((await call(gatePort, '/admin/api/upstream-auth/status', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'batch-2.json', disabled: true })
  })).status, 200, '单文件 status 端点必须保持可用');

  // ---- 路径 B 终极阶段：冷却重置、全量刷新、模型目录、在线探针与全局别名 ----
  const resetOneResp = await call(gatePort, '/admin/api/cpa/cooldown/reset', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ auth_index: 'idx-b' })
  });
  assert.equal(resetOneResp.status, 200);
  assert.equal(resetOneResp.body.success, true);

  const resetAllResp = await call(gatePort, '/admin/api/cpa/cooldown/reset-all', { method: 'POST' });
  assert.equal(resetAllResp.status, 200);
  assert.equal(resetAllResp.body.success, true);

  const refreshAllResp = await call(gatePort, '/admin/api/cpa/credentials/refresh-all', { method: 'POST' });
  assert.equal(refreshAllResp.status, 200);
  assert.ok(refreshAllResp.body.total >= 1);

  const modelsResp = await call(gatePort, '/admin/api/cpa/models');
  assert.equal(modelsResp.status, 200);
  assert.ok(Array.isArray(modelsResp.body.models));
  assert.ok(modelsResp.body.models.length > 0);

  const probeResp = await call(gatePort, '/admin/api/cpa/model-probe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'mock-model-a', prompt: 'ping', provider_type: 'openai-compatibility', provider_index: 0, key_index: 0 })
  });
  assert.equal(probeResp.status, 200);
  assert.equal(probeResp.body.ok, true);
  assert.equal(probeResp.body.model, 'mock-model-a');

  const putAliasResp = await call(gatePort, '/admin/api/cpa/global-model-aliases', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ aliases: [{ from: 'gpt-4-custom', to: 'gemini-2.5-pro' }] })
  });
  assert.equal(putAliasResp.status, 200);
  assert.equal(putAliasResp.body.success, true);

  const getAliasResp = await call(gatePort, '/admin/api/cpa/global-model-aliases');
  assert.equal(getAliasResp.status, 200);
  assert.deepEqual(getAliasResp.body.aliases, [{ from: 'gpt-4-custom', to: 'gemini-2.5-pro' }]);

  if (process.argv.includes('--browser')) {
    const ui = spawn('python', [path.join(root, 'tests/test_cpa_ui.py')], {
      cwd: root,
      env: { ...process.env, GATE_TEST_URL: `http://127.0.0.1:${gatePort}`, GATE_TEST_ADMIN_SECRET: adminSecret, GATE_TEST_SCREENSHOT_DIR: screenshotDir },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let uiOutput = '';
    ui.stdout.on('data', chunk => uiOutput += chunk.toString());
    ui.stderr.on('data', chunk => uiOutput += chunk.toString());
    const uiCode = await new Promise(resolve => ui.once('exit', resolve));
    assert.equal(uiCode, 0, uiOutput);
    console.log(uiOutput.trim());
  }
  console.log(`PASS Gate CPA management integration at port ${gatePort}`);
} finally {
  if (gate) { gate.kill(); await new Promise(resolve => gate.once('exit', resolve)); }
  await new Promise(resolve => mock.close(resolve));
  if (temp.startsWith(os.tmpdir() + path.sep)) fs.rmSync(temp, { recursive: true, force: true });
}

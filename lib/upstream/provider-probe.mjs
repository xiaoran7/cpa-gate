import { requestCpaJson } from './management.mjs';

function parseBody(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function providerEndpoint(baseUrl, operation) {
  if (typeof baseUrl !== 'string' || baseUrl.length > 2048) throw Object.assign(new Error('提供商地址无效'), { statusCode: 400 });
  let url;
  try { url = new URL(baseUrl); } catch { throw Object.assign(new Error('提供商地址无效'), { statusCode: 400 }); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw Object.assign(new Error('提供商地址必须是 HTTP(S) 基础地址'), { statusCode: 400 });
  }
  let pathname = url.pathname.replace(/\/+$/, '');
  pathname = pathname.replace(/\/(?:models|chat\/completions)$/i, '');
  url.pathname = `${pathname}/${operation === 'discover' ? 'models' : 'chat/completions'}`;
  return url.href;
}

function readModels(payload) {
  const list = Array.isArray(payload) ? payload : payload?.data || payload?.models || payload?.items;
  if (!Array.isArray(list)) throw new Error('上游模型列表格式无法识别');
  return [...new Set(list.map(item => typeof item === 'string' ? item : item?.id || item?.name).filter(id => typeof id === 'string' && id.length > 0 && id.length <= 200))].slice(0, 500);
}

export async function probeOpenAiProvider({ index, key_index, operation, model }) {
  if (!Number.isInteger(index) || index < 0 || !Number.isInteger(key_index) || key_index < 0 || !['discover', 'test'].includes(operation)) {
    throw Object.assign(new Error('无效的提供商请求'), { statusCode: 400 });
  }
  if (operation === 'test' && (typeof model !== 'string' || !/^[^\s]{1,200}$/.test(model))) {
    throw Object.assign(new Error('请选择要测试的模型'), { statusCode: 400 });
  }
  const config = await requestCpaJson('GET', '/openai-compatibility');
  const providers = config['openai-compatibility'];
  const provider = Array.isArray(providers) ? providers[index] : null;
  if (!provider || typeof provider !== 'object') throw Object.assign(new Error('提供商不存在，请刷新配置'), { statusCode: 404 });
  const entries = Array.isArray(provider['api-key-entries']) ? provider['api-key-entries'] : [];
  if (entries.length && !entries[key_index]) throw Object.assign(new Error('API Key 条目不存在，请刷新配置'), { statusCode: 404 });
  const key = entries[key_index]?.['api-key'] || provider['api-key'];
  const headers = {};
  if (provider.headers && typeof provider.headers === 'object' && !Array.isArray(provider.headers)) {
    for (const [name, value] of Object.entries(provider.headers)) {
      if (/^[A-Za-z0-9-]{1,80}$/.test(name) && typeof value === 'string' && value.length <= 2048) headers[name] = value;
    }
  }
  if (typeof key === 'string' && key && !Object.keys(headers).some(name => name.toLowerCase() === 'authorization')) headers.Authorization = `Bearer ${key}`;
  const url = providerEndpoint(provider['base-url'], operation);
  const payload = { method: operation === 'discover' ? 'GET' : 'POST', url, header: headers };
  if (operation === 'test') {
    payload.header['Content-Type'] = 'application/json';
    payload.data = JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply OK.' }], max_tokens: 8, stream: false });
  }
  const response = await requestCpaJson('POST', '/api-call', payload);
  const statusCode = Number(response.status_code);
  const body = parseBody(response.body);
  if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) throw new Error('CPA 返回的探测状态无效');
  if (operation === 'test') return { status_code: statusCode, ok: statusCode >= 200 && statusCode < 300, message: statusCode >= 200 && statusCode < 300 ? '模型请求成功' : String(body?.error?.message || body?.error || body?.message || response.body || '请求失败').slice(0, 300) };
  if (statusCode < 200 || statusCode >= 300) throw Object.assign(new Error(`上游模型发现失败：HTTP ${statusCode}`), { statusCode: 502 });
  return { status_code: statusCode, models: readModels(body) };
}

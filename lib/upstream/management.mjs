import http from 'http';
import { CPA_MGMT_HOST, CPA_MGMT_PORT, CPA_MGMT_SECRET } from '../config.mjs';
import { upstreamHttpAgent } from '../proxy/http-agent.mjs';

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

// CPA 的 /logs 只有 after 一个秒级游标参数，没有 limit/until，所以响应体积
// 完全由「回溯多久」决定——服务端无法只取末尾 N 行。生产实测 24h 档约 6.2MB，
// 已经贴近 8MB 上限，流量一涨 24h 档就会开始失败。
// 对日志类响应而言，尾部截断是可接受的结果（用户要的是最近发生了什么），
// 而整体失败会让面板直接死掉。所以超限时改为「保留已收到的部分并标记截断」，
// 而不是 reject。非日志类响应（config、auth-files 等）一旦被截断就是坏数据，
// 仍然必须整体失败。
// 注意 fullPath 已经是拼完版本前缀的完整路径（如 /v0/management/logs）。
// 按路径段判断而不是前缀匹配：logs 必须是某一段的完整名字，
// 这样 /v0/management/logs?after=1 算，而 /request-error-logs 不算。
function isTruncatablePath(path) {
  const pathname = String(path).split('?')[0];
  return pathname.split('/').includes('logs');
}

// CPA 侧超限时给一句能照着做的话，而不是裸的 "response too large"。
// 生产 CPA 日志已积累 320MB，若前端把 after 游标置 0 去拉全量，就会被这里拦下，
// 前端此前只看到一句没头没尾的英文，面板直接卡死且无从下手。
function responseTooLargeError(size) {
  const mb = (size / 1024 / 1024).toFixed(1);
  return Object.assign(
    new Error(`CPA 响应超出 ${MAX_RESPONSE_BYTES / 1024 / 1024}MB 上限（已接收 ${mb}MB）。请缩小时间范围后重试，不要一次性拉取全量历史。`),
    { statusCode: 413, cpaResponseTooLarge: true }
  );
}

export function requestCpaManagement(method, path, body = null, contentType = 'application/json', apiVersion = 'v0') {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(body);
    const headers = { Authorization: `Bearer ${CPA_MGMT_SECRET}` };
    if (payload) {
      headers['Content-Type'] = contentType;
      headers['Content-Length'] = payload.length;
    }
    const fullPath = path.startsWith('/v') ? path : `/${apiVersion}/management${path}`;
    const truncatable = isTruncatablePath(fullPath);
    const upstream = http.request({
      hostname: CPA_MGMT_HOST,
      port: CPA_MGMT_PORT,
      path: fullPath,
      method,
      headers,
      agent: upstreamHttpAgent,
      timeout: 15000
    }, response => {
      const chunks = [];
      let size = 0;
      let truncated = false;
      // 截断收尾与正常收尾共用一套逻辑：destroy 不带 error 参数时不会触发
      // reject，但 'end' 事件在提前 destroy 后不保证触发，所以自己调 finish。
      const finish = () => {
        const bytes = Buffer.concat(chunks);
        const status = response.statusCode || 502;
        if (status < 200 || status >= 300) {
          const error = new Error(`CPA management returned ${status}: ${bytes.toString('utf8').slice(0, 400)}`);
          error.statusCode = status;
          reject(error);
          return;
        }
        resolve({
          bytes,
          contentType: response.headers['content-type'] || 'application/octet-stream',
          truncated
        });
      };
      response.on('data', chunk => {
        if (size + chunk.length > MAX_RESPONSE_BYTES) {
          truncated = true;
          // 日志类：能吃多少吃多少，剩下的丢掉，面板照样有最近的数据可看。
          // 非日志类：一字节都不留，整体失败，避免把坏数据当成功结果用。
          if (truncatable) {
            const room = MAX_RESPONSE_BYTES - size;
            if (room > 0) chunks.push(chunk.subarray(0, room));
            size = MAX_RESPONSE_BYTES;
          }
          // 必须先摘掉 data 监听再 destroy，否则后续 chunk 会继续触发累计判定。
          response.removeAllListeners('data');
          response.resume();
          if (truncatable) {
            upstream.removeAllListeners('error');
            upstream.destroy();
            finish();
          } else {
            upstream.destroy(responseTooLargeError(size));
          }
          return;
        }
        size += chunk.length;
        chunks.push(chunk);
      });
      response.on('end', finish);
      response.on('aborted', () => {
        if (!truncated) reject(new Error('CPA management connection aborted'));
      });
    });
    upstream.on('timeout', () => upstream.destroy(new Error('CPA management request timeout')));
    upstream.on('error', reject);
    if (payload) upstream.write(payload);
    upstream.end();
  });
}

// 被字节上限截断的 JSON 尾部必然断裂（字符串没闭合、数组没闭合）。
// 直接 JSON.parse 会抛错，那截断就白做了。
//
// 实现上不搞花哨的单次扫描：从完整文本末尾按「结构边界」一步步往前砍，
// 每砍一刀就补上未闭括号试一次解析。宁可多试几十次，也不要写出一个
// 只在部分用例上碰巧正确的状态机。最多砍 64 刀，砍不完就返回空壳——
// 面板拿到「有响应但没数据」，也好过崩在解析异常上。
//
// 只在超限路径上调用一次，8MB 文本的代价完全可接受。
function repairTruncatedJson(text) {
  const tryParse = body => {
    // 数一下未闭括号，按栈补齐
    const stack = [];
    let inString = false;
    let escaped = false;
    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
      else if (ch === '}' || ch === ']') { if (stack.length) stack.pop(); }
    }
    if (inString) return null; // 字符串没闭合，这一刀砍得不对
    return body + stack.reverse().join('');
  };

  let body = text;
  for (let attempt = 0; attempt < 64; attempt++) {
    const candidate = tryParse(body);
    if (candidate !== null) {
      try { JSON.parse(candidate); return candidate; } catch {}
    }
    // 往前找一个结构边界退回去：优先逗号，其次冒号，再退到上一个闭括号前
    const comma = body.lastIndexOf(',');
    const colon = body.lastIndexOf(':');
    const cut = Math.max(comma, colon);
    if (cut < 0) break;
    body = body.slice(0, cut);
  }
  return '{}';
}

export async function requestCpaJson(method, path, value, apiVersion = 'v0') {
  const body = value === undefined ? null : JSON.stringify(value);
  const response = await requestCpaManagement(method, path, body, 'application/json', apiVersion);
  if (!response.bytes.length) return {};
  const text = response.bytes.toString('utf8');
  try { return JSON.parse(text); }
  catch (firstError) {
    if (!response.truncated) throw new Error('CPA management returned invalid JSON');
    // 只有截断导致的坏 JSON 才尝试修复，修不好就明确告知是截断所致
    try {
      return JSON.parse(repairTruncatedJson(text));
    } catch {
      throw Object.assign(
        new Error('CPA 日志响应达到 8MB 上限且无法完整解析，请改选更短的时间范围'),
        { statusCode: 413, cpaResponseTooLarge: true }
      );
    }
  }
}

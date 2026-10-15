import http from 'http';
import {
  UPSTREAM_HOST,
  UPSTREAM_PORT,
  ADMIN_SECRET,
  CPA_MGMT_SECRET
} from '../config.mjs';
import {
  checkQuota,
  checkRateLimit,
  resolveKeyId,
  recordRequest
} from '../../quota-manager.mjs';
import { upstreamAvailable } from './circuit-breaker.mjs';
import { parseCookies, verifySecret } from '../routes/upstream-proxy.mjs';

function rejectSocket(socket, statusCode, statusText, message, type) {
  if (socket.destroyed || !socket.writable) return;
  const body = JSON.stringify({ error: { message, type, code: statusCode } });
  const res = [
    `HTTP/1.1 ${statusCode} ${statusText}`,
    'Content-Type: application/json; charset=utf-8',
    'Connection: close',
    `Content-Length: ${Buffer.byteLength(body)}`,
    '',
    body
  ].join('\r\n');
  try {
    socket.end(res);
  } catch {
    socket.destroy();
  }
}

/**
 * 从请求中提取鉴权凭证（支持 Authorization 头、URL 参数、Sec-WebSocket-Protocol 或 Cookie）
 */
function extractAuthCandidate(req) {
  const authHeader = req.headers['authorization'] || '';
  if (authHeader) return authHeader;

  try {
    const urlObj = new URL(req.url, 'http://localhost');
    const queryToken = urlObj.searchParams.get('token') ||
      urlObj.searchParams.get('api_key') ||
      urlObj.searchParams.get('key');
    if (queryToken) return `Bearer ${queryToken}`;
  } catch {}

  const protocols = req.headers['sec-websocket-protocol'] || '';
  if (protocols) {
    const parts = protocols.split(',').map(s => s.trim());
    for (const p of parts) {
      if (p.startsWith('openai-insecure-api-key.')) {
        return `Bearer ${p.slice('openai-insecure-api-key.'.length)}`;
      }
      if (p.startsWith('bearer.')) {
        return `Bearer ${p.slice('bearer.'.length)}`;
      }
    }
  }

  const cookies = parseCookies(req.headers['cookie']);
  if (cookies['gate_admin_token']) {
    return `Bearer ${cookies['gate_admin_token']}`;
  }

  return '';
}

/**
 * 处理 WebSocket 升级全双工转发代理
 */
export function handleWebSocketUpgrade(req, socket, head, customUpstreamHost = UPSTREAM_HOST, customUpstreamPort = UPSTREAM_PORT) {
  // 1. 检查客户端请求是否为标准的 WebSocket 升级请求
  const upgradeHeader = String(req.headers['upgrade'] || '').toLowerCase();
  if (upgradeHeader !== 'websocket') {
    rejectSocket(socket, 400, 'Bad Request', 'Invalid upgrade header. Must be websocket.', 'invalid_upgrade');
    return;
  }

  const authCandidate = extractAuthCandidate(req);
  if (!authCandidate) {
    rejectSocket(socket, 401, 'Unauthorized', 'Valid API key or Admin token required for WebSocket connection', 'unauthorized');
    return;
  }
  const bearerToken = authCandidate.toLowerCase().startsWith('bearer ') ? authCandidate.slice(7).trim() : authCandidate;

  // 2. 区分管理路径与数据面路径鉴权
  const urlObj = new URL(req.url, 'http://localhost');
  const urlPath = urlObj.pathname;

  if (urlPath.startsWith('/admin') || urlPath.startsWith('/v0/management') || urlPath.startsWith('/v8/management')) {
    const isAdmin = verifySecret(bearerToken, ADMIN_SECRET) || verifySecret(bearerToken, CPA_MGMT_SECRET);
    if (!isAdmin) {
      rejectSocket(socket, 401, 'Unauthorized', 'Gate admin authentication required for WebSocket', 'unauthorized');
      return;
    }
  } else {
    // 2.1 数据面 API 限速与配额检查
    const rpmCheck = checkRateLimit(authCandidate);
    if (!rpmCheck.allowed) {
      rejectSocket(socket, 429, 'Too Many Requests', rpmCheck.reason, 'rate_limit_exceeded');
      return;
    }

    const quotaCheck = checkQuota(authCandidate);
    if (!quotaCheck.allowed) {
      rejectSocket(socket, 429, 'Too Many Requests', quotaCheck.reason, 'insufficient_quota');
      return;
    }
  }

  // 3. 熔断器检查
  if (!upstreamAvailable(customUpstreamPort)) {
    rejectSocket(socket, 503, 'Service Unavailable', 'Upstream temporarily unavailable (circuit open)', 'upstream_circuit_open');
    return;
  }

  // 4. 构建发往上游 CPA 的 WebSocket 升级请求
  const upstreamHeaders = { ...req.headers };
  upstreamHeaders.host = `${customUpstreamHost}:${customUpstreamPort}`;
  if (authCandidate && !upstreamHeaders['authorization']) {
    upstreamHeaders['authorization'] = authCandidate;
  }

  const upstreamReq = http.request({
    hostname: customUpstreamHost,
    port: customUpstreamPort,
    path: req.url,
    method: req.method,
    headers: upstreamHeaders,
    timeout: 30000
  });

  const startTime = Date.now();
  const keyId = resolveKeyId(authCandidate);

  upstreamReq.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
    // 上游 101 Switching Protocols 握手成功
    const headersArr = [`HTTP/1.1 101 Switching Protocols`];
    for (const [k, v] of Object.entries(upstreamRes.headers)) {
      if (Array.isArray(v)) {
        for (const item of v) headersArr.push(`${k}: ${item}`);
      } else {
        headersArr.push(`${k}: ${v}`);
      }
    }
    socket.write(headersArr.join('\r\n') + '\r\n\r\n');

    // 管道级数据直通（无缓冲，零延迟，支持标准 WS 与增量 WS 协议）
    if (upstreamHead && upstreamHead.length > 0) socket.write(upstreamHead);
    if (head && head.length > 0) upstreamSocket.write(head);

    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);

    // 级联断开保护
    const cleanup = () => {
      if (!socket.destroyed) socket.destroy();
      if (!upstreamSocket.destroyed) upstreamSocket.destroy();
    };

    socket.on('error', cleanup);
    upstreamSocket.on('error', cleanup);
    socket.on('close', cleanup);
    upstreamSocket.on('close', cleanup);

    // 记录审计流水
    recordRequest({
      keyId,
      model: 'websocket-session',
      status: 101,
      totalTokens: 0,
      latencyMs: Date.now() - startTime,
      stream: true,
      errorType: null
    });
  });

  upstreamReq.on('response', (upstreamRes) => {
    // 上游拒绝升级或返回常规 HTTP 错误响应
    const headersArr = [`HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage || ''}`];
    for (const [k, v] of Object.entries(upstreamRes.headers)) {
      if (Array.isArray(v)) {
        for (const item of v) headersArr.push(`${k}: ${item}`);
      } else {
        headersArr.push(`${k}: ${v}`);
      }
    }
    socket.write(headersArr.join('\r\n') + '\r\n\r\n');
    upstreamRes.pipe(socket);
  });

  upstreamReq.on('error', (err) => {
    console.error(`[Gate] Upstream WebSocket connection failed:`, err.message);
    rejectSocket(socket, 502, 'Bad Gateway', `Upstream WebSocket connection error: ${err.message}`, 'upstream_connection_error');
  });

  upstreamReq.end();
}

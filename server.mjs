import http from 'http';
import {
  GUARD_DIR,
  ADMIN_SECRET,
  CPA_MGMT_SECRET,
  UPSTREAM_HOST,
  UPSTREAM_PORT,
  MAX_REQUEST_BODY_BYTES,
  MAX_ADMIN_BODY_BYTES,
  METRICS_TOKEN,
  BIND_TARGETS,
  validateAdminSecret,
  readBody,
  writeJson
} from './lib/config.mjs';
import {
  checkQuota,
  checkRateLimit,
  checkModelAllowed,
  filterModelsForKey,
  resolveKeyId,
  recordRequest,
  getQuotaStatusSummary
} from './quota-manager.mjs';
import { notifyEvent } from './notify.mjs';
import {
  upstreamAvailable,
  markUpstreamSuccess,
  markUpstreamFailure,
  negativeCache,
  computePayloadFingerprint,
  metric,
  UPSTREAM_FAILURE_THRESHOLD,
  UPSTREAM_COOLDOWN_MS
} from './lib/proxy/circuit-breaker.mjs';
import {
  isRequestRetryEligible
} from './lib/proxy/continuation.mjs';
import {
  executeTransportGuard,
  sanitizeResponseHeaders
} from './lib/proxy/transport.mjs';
import { handleWebSocketUpgrade } from './lib/proxy/websocket-proxy.mjs';
import { handleSystemRoutes } from './lib/routes/system-routes.mjs';
import { handleStaticRoutes } from './lib/routes/static-routes.mjs';
import { handleMemberRoutes } from './lib/routes/member-routes.mjs';
import { handleAdminRoutes } from './lib/routes/admin-routes.mjs';
import { handleUpstreamManagementProxy, parseCookies, verifySecret } from './lib/routes/upstream-proxy.mjs';

// 启动前校验管理员密码
validateAdminSecret();

async function requestHandler(req, res) {
  const urlObj = new URL(req.url, 'http://localhost');
  const urlPath = urlObj.pathname;

  // 1. 系统路由 (/healthz, /readyz, /metrics, /api/status/quota)
  if (handleSystemRoutes(req, res, urlPath, METRICS_TOKEN)) {
    return;
  }

  // 2. 静态页面与静态资产路由 (/admin, /admin/assets/*)
  if (handleStaticRoutes(req, res, urlPath, GUARD_DIR)) {
    return;
  }

  // 3. 租户隔离的 Member 端 API (/api/member/*)
  if (handleMemberRoutes(req, res, urlPath)) {
    return;
  }

  // 4. 管理端 API (/admin/api/*)
  if (await handleAdminRoutes(req, res, urlPath, ADMIN_SECRET, MAX_ADMIN_BODY_BYTES)) {
    return;
  }

  // 4.1 上游原生管理控制台受控反向代理通道 (/admin/upstream/*)
  // 必须经由 Gate 管理密钥 (GATE_ADMIN_SECRET) 鉴权，且由 Gate 服务端强行注入 CPA_MGMT_SECRET，
  // 既保留原生 management.html 与全部调试 API 访问，又彻底阻止未鉴权直连触发 CPA 防爆破 IP 封禁。
  if (urlPath.startsWith('/admin/upstream')) {
    if (await handleUpstreamManagementProxy(req, res, urlPath, ADMIN_SECRET, CPA_MGMT_SECRET, UPSTREAM_HOST, UPSTREAM_PORT)) {
      return;
    }
  }

  // 4.2 上游内部管理平面安全隔离防御
  // CPA 的管理端点仅允许由 Gate 后端通过环境变量 GATE_MGMT_SECRET 在服务端受控调用（例如 /admin/api/cpa/* 或 /admin/upstream/*）。
  // 严禁任何外部客户端直接透传访问上游内部管理路由（/v0/management/*, /v8/management/*, /management.html 等），
  // 否则外部未认证请求或无效凭据重试会在 CPA 侧累积 401 失败计数，触发 CPA 防爆破阈值进而封禁 Gate 出口 IP。
  if (
    urlPath.startsWith('/v0/management') ||
    urlPath.startsWith('/v8/management') ||
    urlPath === '/management.html' ||
    urlPath.startsWith('/management/')
  ) {
    // 双重安全防护：若请求来自于持有合法 Gate 管理凭据（Cookie 或 Bearer）的已认证管理员，
    // 自动接入受控反代通道转发，避免客户端绝对路径改写遗漏触发 403 阻断
    const cookies = parseCookies(req.headers['cookie']);
    const authHeader = req.headers['authorization'] || '';
    const bearer = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
    const token = cookies['gate_admin_token'] || bearer;
    if (verifySecret(token, ADMIN_SECRET) || verifySecret(token, CPA_MGMT_SECRET)) {
      if (await handleUpstreamManagementProxy(req, res, '/admin/upstream' + urlPath, ADMIN_SECRET, CPA_MGMT_SECRET, UPSTREAM_HOST, UPSTREAM_PORT)) {
        return;
      }
    }

    console.warn(`[Gate] Blocked direct access to upstream management route: ${req.method} ${urlPath} from ${req.socket.remoteAddress || 'unknown'}`);
    writeJson(res, 403, {
      error: {
        message: 'Direct access to upstream management API is forbidden. Use Gate Admin (/admin).',
        type: 'management_access_forbidden',
        code: 403
      }
    });
    return;
  }

  // 5. 热路径限速检查（Key 级 RPM 滑动窗口，先于配额）
  const rpmCheck = checkRateLimit(req.headers['authorization']);
  if (!rpmCheck.allowed) {
    console.warn('[Gate] Request blocked by rate limit: ' + rpmCheck.reason);
    metric('gate_rejections_total', { reason: 'rate_limited' });
    recordRequest({
      keyId: resolveKeyId(req.headers['authorization']),
      model: null,
      status: 429,
      totalTokens: 0,
      latencyMs: 0,
      stream: false,
      errorType: 'rate_limited'
    });
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '10' });
    res.end(JSON.stringify({
      error: {
        message: rpmCheck.reason,
        type: 'rate_limit_exceeded',
        code: 429
      }
    }));
    return;
  }

  // 6. 热路径配额检查 (极速内存比对，阻断超额 Key)
  const quotaCheck = checkQuota(req.headers['authorization']);
  if (!quotaCheck.allowed) {
    console.warn('[Gate] Request blocked by daily quota: ' + quotaCheck.reason);
    recordRequest({
      keyId: resolveKeyId(req.headers['authorization']),
      model: null,
      status: 429,
      totalTokens: 0,
      latencyMs: 0,
      stream: false,
      errorType: 'quota_exceeded'
    });
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: {
        message: quotaCheck.reason,
        type: 'insufficient_quota',
        code: 429
      }
    }));
    return;
  }

  if (req.url === '/keeper' || req.url.startsWith('/keeper/')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: {
        message: 'Keeper has been retired and consolidated into Gate native dashboard (/admin)',
        type: 'keeper_retired',
        code: 404
      }
    }));
    return;
  }

  const upstreamPort = UPSTREAM_PORT;
  if (!upstreamAvailable(upstreamPort)) {
    metric('gate_rejections_total', { reason: 'upstream_circuit_open' });
    notifyEvent('upstream_circuit_open', `port:${upstreamPort}`, `Gate 上游熔断打开（端口 ${upstreamPort}，连续失败 ${UPSTREAM_FAILURE_THRESHOLD} 次），请求返回 503，冷却 ${Math.round(UPSTREAM_COOLDOWN_MS / 1000)}s`).catch(() => {});
    recordRequest({
      keyId: resolveKeyId(req.headers['authorization']),
      model: null,
      status: 503,
      totalTokens: 0,
      latencyMs: 0,
      stream: false,
      errorType: 'upstream_circuit_open'
    });
    return writeJson(res, 503, {
      error: {
        message: 'Upstream temporarily unavailable',
        type: 'upstream_circuit_open',
        code: 503
      }
    }, { 'Retry-After': String(Math.ceil(UPSTREAM_COOLDOWN_MS / 1000)) });
  }

  // 对 GET /v1/models 进行按 Key 动态过滤
  if (req.method === 'GET' && (urlPath === '/v1/models' || urlPath === '/models')) {
    const headers = { ...req.headers };
    headers.host = `${UPSTREAM_HOST}:${upstreamPort}`;

    const proxyReq = http.request({
      hostname: UPSTREAM_HOST,
      port: upstreamPort,
      path: req.url,
      method: req.method,
      headers: headers
    }, (proxyRes) => {
      const chunks = [];
      proxyRes.on('data', chunk => chunks.push(chunk));
      proxyRes.on('end', () => {
        if (proxyRes.statusCode >= 200 && proxyRes.statusCode < 500) markUpstreamSuccess(upstreamPort);
        else markUpstreamFailure(upstreamPort);
        const rawBody = Buffer.concat(chunks);
        if (proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) {
          try {
            const json = JSON.parse(rawBody.toString('utf8'));
            if (Array.isArray(json.data)) {
              json.data = filterModelsForKey(req.headers['authorization'], json.data);
              const filteredBuf = Buffer.from(JSON.stringify(json), 'utf8');
              const sanitizedHeaders = sanitizeResponseHeaders(proxyRes.headers);
              sanitizedHeaders['content-length'] = filteredBuf.length;
              res.writeHead(proxyRes.statusCode, sanitizedHeaders);
              res.end(filteredBuf);
              return;
            }
          } catch (e) {}
        }
        res.writeHead(proxyRes.statusCode, sanitizeResponseHeaders(proxyRes.headers));
        res.end(rawBody);
      });
    });

    proxyReq.on('error', (err) => {
      console.error(`[Gate] Models passthrough connection error:`, err.message);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Bad Gateway: Upstream unreachable', type: 'upstream_connection_error', code: 502 } }));
      } else {
        if (!res.destroyed) res.destroy();
      }
    });

    res.on('close', () => {
      if (!res.writableEnded) proxyReq.destroy();
    });

    req.pipe(proxyReq);
    return;
  }

  // 非 POST 请求直通代理
  if (req.method !== 'POST') {
    const headers = { ...req.headers };
    headers.host = `${UPSTREAM_HOST}:${UPSTREAM_PORT}`;

    const proxyReq = http.request({
      hostname: UPSTREAM_HOST,
      port: upstreamPort,
      path: req.url,
      method: req.method,
      headers: headers
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, sanitizeResponseHeaders(proxyRes.headers));
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      markUpstreamFailure(upstreamPort);
      console.error(`[Gate] Passthrough connection error:`, err.message);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Bad Gateway: Upstream unreachable', type: 'upstream_connection_error', code: 502 } }));
      } else {
        if (!res.destroyed) res.destroy();
      }
    });

    res.on('close', () => {
      if (!res.writableEnded) proxyReq.destroy();
    });

    req.pipe(proxyReq);
    return;
  }

  // POST 请求（LLM 推理通道）
  readBody(req, MAX_REQUEST_BODY_BYTES).then(rawReqBody => {
    let parsedBody = null;
    try {
      parsedBody = JSON.parse(rawReqBody.toString('utf8'));
    } catch (e) {}

    // 热路径模型白名单检查：校验请求的 model 是否在 Key 的允许集合内
    if (parsedBody && parsedBody.model) {
      const modelCheck = checkModelAllowed(req.headers['authorization'], parsedBody.model);
      if (!modelCheck.allowed) {
        console.warn(`[Gate] Model access forbidden: ${modelCheck.reason}`);
        recordRequest({
          keyId: resolveKeyId(req.headers['authorization']),
          model: parsedBody.model,
          status: 403,
          totalTokens: 0,
          latencyMs: 0,
          stream: false,
          errorType: 'model_forbidden'
        });
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: {
            message: modelCheck.reason,
            type: 'permission_denied',
            code: 403
          }
        }));
        return;
      }
    }

    // 检查 30 秒 Negative Cache 熔断
    const fingerprint = computePayloadFingerprint(rawReqBody);
    const expireTime = negativeCache.get(fingerprint);
    if (expireTime && Date.now() < expireTime) {
      console.warn(`[Gate] Fast circuit-breaker 502 for deadlocked fingerprint: ${fingerprint.slice(0, 12)}...`);
      recordRequest({
        keyId: resolveKeyId(req.headers['authorization']),
        model: parsedBody?.model || null,
        status: 502,
        totalTokens: 0,
        latencyMs: 0,
        stream: parsedBody?.stream === true || parsedBody?.stream === 'true',
        errorType: 'empty_response'
      });
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          message: 'Upstream model returned empty response previously; cached empty circuit-breaker active.',
          type: 'upstream_empty_response',
          code: 502
        }
      }));
      return;
    }

    const retryEligible = isRequestRetryEligible(parsedBody);
    const abortController = new AbortController();
    const startTime = Date.now();
    const hotKeyId = resolveKeyId(req.headers['authorization']);

    res.on('close', () => {
      if (!res.writableEnded) {
        abortController.abort();
      }
    });

    executeTransportGuard(
      req,
      res,
      rawReqBody,
      parsedBody,
      fingerprint,
      retryEligible,
      UPSTREAM_HOST,
      upstreamPort,
      0,
      abortController,
      startTime,
      hotKeyId
    );
  }).catch(err => {
    metric('gate_rejections_total', { reason: err.statusCode === 413 ? 'body_too_large' : 'body_read_error' });
    if (!res.headersSent) {
      writeJson(res, err.statusCode || 400, {
        error: {
          message: err.message,
          type: err.statusCode === 413 ? 'request_entity_too_large' : 'invalid_request',
          code: err.statusCode || 400
        }
      });
    }
  });
}

// ---- 定时后台巡检与 Uptime Kuma Push 心跳（可选）----
const UPTIME_KUMA_PUSH_URL = process.env.GATE_UPTIME_KUMA_PUSH_URL || '';
async function runQuotaPeriodicCheck() {
  try {
    const summary = getQuotaStatusSummary();
    if (UPTIME_KUMA_PUSH_URL) {
      let pushUrl = UPTIME_KUMA_PUSH_URL;
      const statusParam = summary.status === 'ok' || summary.status === 'warning' ? 'up' : 'down';
      const msgParam = encodeURIComponent(`[Gate] ${summary.status}: ${summary.message} (tokens: ${summary.summary.today_tokens}, blocked: ${summary.summary.keys_blocked})`);
      const sep = pushUrl.includes('?') ? '&' : '?';
      pushUrl = `${pushUrl}${sep}status=${statusParam}&msg=${msgParam}&ping=`;

      const u = new URL(pushUrl);
      const reqMod = u.protocol === 'https:' ? (await import('https')).default : http;
      const pReq = reqMod.get(pushUrl, { timeout: 8000 }, (pRes) => {
        pRes.resume();
      });
      pReq.on('error', (e) => console.warn('[Gate] Kuma push failed:', e.message));
      pReq.on('timeout', () => pReq.destroy());
    }
  } catch (err) {
    console.warn('[Gate] Quota periodic check error:', err.message);
  }
}
setInterval(runQuotaPeriodicCheck, 60000).unref();

for (const target of BIND_TARGETS) {
  const srv = http.createServer(requestHandler);
  srv.requestTimeout = 0;
  srv.headersTimeout = 0;
  srv.keepAliveTimeout = 120000;

  // 监听 WebSocket Upgrade 事件，支持标准与增量 WebSocket 穿透代理
  srv.on('upgrade', (req, socket, head) => {
    handleWebSocketUpgrade(req, socket, head);
  });

  srv.on('error', (err) => {
    console.error(`[Gate] Failed to bind ${target.name} on ${target.host}:${target.port}:`, err.message);
  });

  srv.listen(target.port, target.host, () => {
    console.log(`[Gate] Listening on ${target.host}:${target.port} (${target.name}) -> upstream ${UPSTREAM_HOST}:${UPSTREAM_PORT}`);
  });
}

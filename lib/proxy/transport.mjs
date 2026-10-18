import http from 'http';
import fs from 'fs';
import {
  MAX_ATTEMPTS,
  DEFAULT_RETRY_DELAY_MS,
  MAX_429_RETRY_AFTER_MS,
  REQUEST_TOTAL_DEADLINE_MS,
  MAX_PRECOMMIT_BYTES,
  buildHealingPayload,
  extractSemanticStatus,
  SseStreamParser,
  parseRetryAfterMs,
  abortableSleep
} from './continuation.mjs';
import {
  negativeCache,
  NEGATIVE_CACHE_TTL_MS,
  markUpstreamSuccess,
  markUpstreamFailure
} from './circuit-breaker.mjs';
import {
  estimateTokensFromChars,
  estimateInputTokens,
  extractUsageFromJson,
  extractReasoningEffort
} from './token-estimator.mjs';
import {
  recordErrorEvent,
  recordRequest,
  recordUpstreamValidation
} from '../../quota-manager.mjs';
import { notifyEvent } from '../../notify.mjs';
import { extractValidationUrl, completeGoogleValidationUrl } from '../../validation-url.mjs';
import { decompressBody } from '../config.mjs';

import { upstreamHttpAgent } from './http-agent.mjs';

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'proxy-connection',
  'content-length'
]);

export function sanitizeResponseHeaders(upstreamHeaders) {
  const sanitized = {};
  for (const [key, value] of Object.entries(upstreamHeaders)) {
    const lowerKey = key.toLowerCase();
    if (!HOP_BY_HOP_HEADERS.has(lowerKey)) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

export async function executeTransportGuard(
  clientReq,
  clientRes,
  originalRawBody,
  parsedBody,
  fingerprint,
  retryEligible,
  upstreamHost,
  upstreamPort,
  attempt,
  abortController,
  startTime,
  hotKeyId
) {
  if (abortController.signal.aborted || clientRes.destroyed || clientRes.writableEnded) {
    return;
  }

  const requestModel = parsedBody && typeof parsedBody.model === 'string' ? parsedBody.model : null;
  const requestStream = parsedBody?.stream === true || (typeof parsedBody?.stream === 'string' && parsedBody.stream === 'true');
  const requestReasoningEffort = extractReasoningEffort(parsedBody);
  const inputEstimate = estimateInputTokens(parsedBody);

  let payloadToSend = originalRawBody;
  if (attempt === 2) {
    const healedBuf = buildHealingPayload(parsedBody);
    if (healedBuf) {
      payloadToSend = healedBuf;
      console.log(`[Gate] Attempt 3: Applying gentle continuation healing probe.`);
    }
  }

  const headers = { ...clientReq.headers };
  headers.host = `${upstreamHost}:${upstreamPort}`;
  delete headers['content-encoding']; // 已在网关层完成解压，向上游传递标准解压后的 UTF-8 JSON Payload
  headers['content-length'] = payloadToSend.length;

  const options = {
    hostname: upstreamHost,
    port: upstreamPort,
    path: clientReq.url,
    method: clientReq.method,
    headers: headers,
    agent: upstreamHttpAgent,
    signal: abortController.signal
  };

  let isCommitted = false;
  let hasRecorded = false;
  let hasSemanticEvents = false;
  let hasReasoningEvents = false;
  let hasExplicitFilter = false;
  let finalFinishReason = null;
  let precommitBytes = 0;
  let lastUsage = null;
  let outputChars = 0;
  let ttftMs = 0;
  let detectedAuthIndex = '';
  const earlyBufferedChunks = [];

  const recordOnce = (payload) => {
    if (hasRecorded) return;
    hasRecorded = true;
    recordRequest({
      reasoningEffort: requestReasoningEffort,
      ...payload
    });
  };

  const recordClientAbort = () => {
    if (hasRecorded) return;
    const usage = lastUsage || (outputChars > 0
      ? {
          promptTokens: inputEstimate,
          completionTokens: estimateTokensFromChars(outputChars),
          totalTokens: inputEstimate + estimateTokensFromChars(outputChars),
          estimated: true
        }
      : null);
    const finalLatency = Date.now() - startTime;
    recordOnce({
      keyId: hotKeyId,
      model: requestModel,
      status: 499,
      promptTokens: usage?.promptTokens ?? 0,
      completionTokens: usage?.completionTokens ?? 0,
      cachedTokens: usage?.cachedTokens ?? 0,
      totalTokens: usage?.totalTokens ?? 0,
      latencyMs: finalLatency,
      ttftMs: ttftMs || finalLatency,
      stream: requestStream,
      estimated: usage?.estimated ?? false,
      errorType: 'client_closed',
      authIndex: detectedAuthIndex
    });
  };

  const activeProxyReq = http.request(options, async (proxyRes) => {
    const onAbort = () => {
      if (!proxyRes.destroyed) {
        proxyRes.destroy();
      }
    };
    if (abortController.signal.aborted) {
      onAbort();
      return;
    }
    abortController.signal.addEventListener('abort', onAbort, { once: true });
    proxyRes.on('close', () => {
      abortController.signal.removeEventListener('abort', onAbort);
    });

    let isPausedForDrain = false;
    const writeWithBackpressure = (targetRes, chunk) => {
      const ok = targetRes.write(chunk);
      if (!ok && !isPausedForDrain) {
        isPausedForDrain = true;
        proxyRes.pause();
        targetRes.once('drain', () => {
          isPausedForDrain = false;
          if (!proxyRes.destroyed) {
            proxyRes.resume();
          }
        });
      }
      return ok;
    };

    clientRes.on('close', () => {
      isPausedForDrain = false;
      recordClientAbort();
      if (!proxyRes.destroyed) {
        proxyRes.destroy();
      }
    });

    const statusCode = proxyRes.statusCode;
    const contentType = proxyRes.headers['content-type'] || '';
    const isStream = contentType.includes('text/event-stream');

    // 从 X-Cpa-Trace-Id 提取 16 位 auth_index
    const traceId = proxyRes.headers['x-cpa-trace-id'] || '';
    const traceMatch = String(traceId).match(/-([0-9a-f]{16})-/i);
    if (traceMatch) {
      detectedAuthIndex = traceMatch[1];
    }

    if (statusCode === 429) {
      const retryAfterMs = parseRetryAfterMs(proxyRes.headers);
      const elapsed = Date.now() - startTime;
      const canRetry429 = retryEligible && attempt < (MAX_ATTEMPTS - 1) && retryAfterMs <= MAX_429_RETRY_AFTER_MS && (elapsed + retryAfterMs < REQUEST_TOTAL_DEADLINE_MS);

      recordErrorEvent({
        keyId: hotKeyId,
        authIndex: detectedAuthIndex,
        provider: '',
        model: requestModel,
        status: 429,
        errorType: 'upstream_rate_limited',
        errorBody: `Rate limit 429 from upstream. Retry-After: ${retryAfterMs}ms`,
        retryAfterMs
      });

      if (canRetry429) {
        console.warn(`[Gate] Upstream 429. Backing off ${retryAfterMs}ms (attempt ${attempt + 2}/${MAX_ATTEMPTS})...`);
        try {
          await abortableSleep(retryAfterMs, abortController.signal);
          return executeTransportGuard(clientReq, clientRes, originalRawBody, parsedBody, fingerprint, retryEligible, upstreamHost, upstreamPort, attempt + 1, abortController, startTime, hotKeyId);
        } catch (e) {
          return;
        }
      }

      clientRes.writeHead(statusCode, sanitizeResponseHeaders(proxyRes.headers));
      proxyRes.pipe(clientRes);
      recordOnce({
        keyId: hotKeyId,
        model: requestModel,
        status: 429,
        totalTokens: 0,
        latencyMs: Date.now() - startTime,
        ttftMs: Date.now() - startTime,
        stream: requestStream,
        errorType: 'upstream_rate_limited',
        authIndex: detectedAuthIndex
      });
      return;
    }

    if (statusCode >= 500 && retryEligible && attempt < (MAX_ATTEMPTS - 1) && !abortController.signal.aborted) {
      console.warn(`[Gate] Upstream ${statusCode}. Retrying attempt ${attempt + 2}/${MAX_ATTEMPTS}...`);
      recordErrorEvent({
        keyId: hotKeyId,
        authIndex: detectedAuthIndex,
        provider: '',
        model: requestModel,
        status: statusCode,
        errorType: 'upstream_server_error',
        errorBody: `Upstream returned status ${statusCode}`,
        retryAfterMs: DEFAULT_RETRY_DELAY_MS
      });
      try {
        await abortableSleep(DEFAULT_RETRY_DELAY_MS, abortController.signal);
        return executeTransportGuard(clientReq, clientRes, originalRawBody, parsedBody, fingerprint, retryEligible, upstreamHost, upstreamPort, attempt + 1, abortController, startTime, hotKeyId);
      } catch (e) {
        return;
      }
    }

    if (statusCode < 200 || statusCode >= 300) {
      isCommitted = true;
      const errChunks = [];
      proxyRes.on('data', (c) => errChunks.push(c));
      proxyRes.on('end', async () => {
        const fullErrBuf = Buffer.concat(errChunks);
        const encoding = proxyRes.headers['content-encoding'];
        let auditErrBuf = fullErrBuf;
        if (encoding) {
          try {
            auditErrBuf = decompressBody(fullErrBuf, encoding);
          } catch (e) {}
        }
        const errStr = auditErrBuf.toString('utf8');

        let isValidationReq = false;
        const rawValidationUrl = extractValidationUrl(errStr);
        const validationUrl = rawValidationUrl ? (completeGoogleValidationUrl(rawValidationUrl) || rawValidationUrl) : null;
        let validationMsg = 'Verify your account to continue.';

        if (statusCode === 403 && (errStr.includes('VALIDATION_REQUIRED') || errStr.includes('validation_url') || validationUrl)) {
          isValidationReq = true;
          try {
            const errJson = JSON.parse(errStr);
            validationMsg = errJson.error?.metadata?.validation_error_message || errJson.metadata?.validation_error_message || validationMsg;
          } catch (_) {}

          if (validationUrl || detectedAuthIndex) {
            console.warn(`[Gate] [Validation] Intercepted Antigravity validation_url for auth=${detectedAuthIndex}`);
            recordUpstreamValidation({
              authIndex: detectedAuthIndex,
              provider: 'antigravity',
              validationUrl,
              errorMessage: validationMsg,
              rawError: errStr,
              allowMissingUrl: true
            });
            notifyEvent('upstream_validation_required', detectedAuthIndex, `Google Antigravity 账号需要安全验证${validationUrl ? `: ${validationUrl}` : '，请检查上游返回信息'}`);
          }
        }

        const errorType = isValidationReq ? 'upstream_validation_required' : ('upstream_status_' + statusCode);
        const errorBodySummary = isValidationReq
          ? `Antigravity requires validation: ${validationUrl || validationMsg}`
          : (errStr.slice(0, 300) || `Upstream HTTP ${statusCode}`);

        recordErrorEvent({
          keyId: hotKeyId,
          authIndex: detectedAuthIndex,
          provider: isValidationReq ? 'antigravity' : '',
          model: requestModel,
          status: statusCode,
          errorType,
          errorBody: errorBodySummary,
          retryAfterMs: 0
        });

        clientRes.writeHead(statusCode, sanitizeResponseHeaders(proxyRes.headers));
        clientRes.end(fullErrBuf);

        recordOnce({
          keyId: hotKeyId,
          model: requestModel,
          status: statusCode,
          totalTokens: 0,
          latencyMs: Date.now() - startTime,
          ttftMs: Date.now() - startTime,
          stream: requestStream,
          errorType,
          authIndex: detectedAuthIndex
        });
      });
      return;
    }

    // A. 非流式响应
    if (!isStream) {
      const nonStreamChunks = [];
      proxyRes.on('data', (c) => nonStreamChunks.push(c));
      proxyRes.on('end', async () => {
        const fullBuf = Buffer.concat(nonStreamChunks);
        if (statusCode >= 200 && statusCode < 500) markUpstreamSuccess(upstreamPort);
        else markUpstreamFailure(upstreamPort);

        const encoding = proxyRes.headers['content-encoding'];
        let auditBuf = fullBuf;
        if (encoding) {
          try {
            auditBuf = decompressBody(fullBuf, encoding);
          } catch (e) {
            console.warn('[Gate] Failed to decompress upstream response for audit:', e.message);
          }
        }

        let isEmptyCleanStop = false;

        try {
          const respJson = JSON.parse(auditBuf.toString('utf8'));
          if (Array.isArray(respJson.choices) && respJson.choices.length > 0) {
            const { hasSemantic, isExplicitFinish, finishReason } = extractSemanticStatus(respJson.choices[0]);
            if (!hasSemantic && !isExplicitFinish && finishReason === 'stop') {
              isEmptyCleanStop = true;
            }
          }
        } catch (e) {}

        if (isEmptyCleanStop) {
          console.warn(`[Gate] [Non-stream] Attempt ${attempt + 1}/${MAX_ATTEMPTS}: empty 200 stop.`);

          if (retryEligible && attempt < (MAX_ATTEMPTS - 1) && !abortController.signal.aborted) {
            try {
              await abortableSleep(DEFAULT_RETRY_DELAY_MS, abortController.signal);
              return executeTransportGuard(clientReq, clientRes, originalRawBody, parsedBody, fingerprint, retryEligible, upstreamHost, upstreamPort, attempt + 1, abortController, startTime, hotKeyId);
            } catch (e) {
              return;
            }
          }

          negativeCache.set(fingerprint, Date.now() + NEGATIVE_CACHE_TTL_MS);
          if (!clientRes.headersSent) {
            clientRes.writeHead(502, { 'Content-Type': 'application/json' });
            clientRes.end(JSON.stringify({
              error: {
                message: `Upstream model returned empty response with stop finish_reason after ${attempt + 1} attempts.`,
                type: 'upstream_empty_response',
                code: 502
              }
            }));
            recordOnce({
              keyId: hotKeyId,
              model: requestModel,
              status: 502,
              totalTokens: 0,
              latencyMs: Date.now() - startTime,
              stream: false,
              errorType: 'empty_response',
              authIndex: detectedAuthIndex
            });
            return;
          }
        }

        negativeCache.delete(fingerprint);
        clientRes.writeHead(statusCode, sanitizeResponseHeaders(proxyRes.headers));
        clientRes.end(fullBuf);

        let usageInfo = null;
        try {
          const respJson = JSON.parse(auditBuf.toString('utf8'));
          usageInfo = extractUsageFromJson(respJson);
          if (!usageInfo && Array.isArray(respJson.choices) && respJson.choices.length > 0) {
            const msg = respJson.choices[0].message || respJson.choices[0].delta || {};
            const outChars = (typeof msg.content === 'string' ? msg.content.length : 0) +
              (typeof msg.reasoning_content === 'string' ? msg.reasoning_content.length : 0) +
              (Array.isArray(msg.tool_calls) ? msg.tool_calls.reduce((s, tc) => s + (tc.function?.arguments?.length || 0), 0) : 0);
            if (outChars > 0) {
              const completion = estimateTokensFromChars(outChars);
              usageInfo = { promptTokens: inputEstimate, completionTokens: completion, totalTokens: inputEstimate + completion, estimated: true };
            }
          }
        } catch (e) {}
        const finalLatency = Date.now() - startTime;
        recordOnce({
          keyId: hotKeyId,
          model: requestModel,
          status: statusCode,
          promptTokens: usageInfo?.promptTokens ?? 0,
          completionTokens: usageInfo?.completionTokens ?? 0,
          cachedTokens: usageInfo?.cachedTokens ?? 0,
          totalTokens: usageInfo?.totalTokens ?? 0,
          latencyMs: finalLatency,
          ttftMs: finalLatency,
          stream: false,
          estimated: usageInfo ? (usageInfo.estimated ?? false) : false,
          errorType: null,
          authIndex: detectedAuthIndex
        });
      });

      proxyRes.on('error', (err) => {
        console.error(`[Gate] Non-stream error:`, err.message);
        if (!clientRes.headersSent) {
          clientRes.writeHead(502, { 'Content-Type': 'application/json' });
          clientRes.end(JSON.stringify({ error: { message: `Upstream connection failed: ${err.message}`, type: 'upstream_connection_error', code: 502 } }));
        } else if (!clientRes.destroyed) {
          clientRes.destroy();
        }
      });
      return;
    }

    // B. 流式响应
    const sseParser = new SseStreamParser((eventName, dataStr) => {
      if (dataStr === '[DONE]') return;

      try {
        const payload = JSON.parse(dataStr);
        const usageSeen = extractUsageFromJson(payload)
          || (payload.message ? extractUsageFromJson(payload.message) : null);
        if (usageSeen) {
          if (lastUsage) {
            // 流式跨 chunk 融合累加：保留早期 chunk (如 Anthropic message_start) 的 promptTokens 与 cachedTokens，
            // 融合末尾 delta (如 message_delta) 的 completionTokens，彻底防止 Prompt Cache 缓存命中被覆写归零
            const p = usageSeen.promptTokens > 0 ? usageSeen.promptTokens : lastUsage.promptTokens;
            const c = usageSeen.completionTokens > 0 ? usageSeen.completionTokens : lastUsage.completionTokens;
            const ca = usageSeen.cachedTokens > 0 ? usageSeen.cachedTokens : lastUsage.cachedTokens;
            lastUsage = {
              promptTokens: p,
              completionTokens: c,
              cachedTokens: ca,
              totalTokens: (usageSeen.totalTokens > p && usageSeen.promptTokens > 0) ? usageSeen.totalTokens : (p + c),
              estimated: Boolean(usageSeen.estimated && lastUsage.estimated)
            };
          } else {
            lastUsage = usageSeen;
          }
        }

        if (Array.isArray(payload.choices)) {
          for (const choice of payload.choices) {
            const { hasSemantic, hasReasoning, isExplicitFinish, finishReason } = extractSemanticStatus(choice);
            if (hasSemantic) hasSemanticEvents = true;
            if (hasReasoning) hasReasoningEvents = true;
            if (isExplicitFinish) hasExplicitFilter = true;
            if (finishReason) finalFinishReason = finishReason;

            const delta = choice.delta || choice.message;
            if (delta) {
              if (typeof delta.content === 'string') outputChars += delta.content.length;
              if (typeof delta.reasoning_content === 'string') outputChars += delta.reasoning_content.length;
              if (typeof delta.reasoning === 'string') outputChars += delta.reasoning.length;
              if (Array.isArray(delta.tool_calls)) {
                for (const tc of delta.tool_calls) {
                  if (typeof tc.function?.arguments === 'string') outputChars += tc.function.arguments.length;
                }
              }
            }
          }
        }

        // Anthropic Messages SSE 协议支持：
        // 1. 文本块增量 (text_delta)
        if (typeof payload.delta?.text === 'string') {
          outputChars += payload.delta.text.length;
          if (payload.delta.text.length > 0) hasSemanticEvents = true;
        }

        // 2. 深度思考增量 (thinking_delta) 与签名
        if (typeof payload.delta?.thinking === 'string') {
          outputChars += payload.delta.thinking.length;
          if (payload.delta.thinking.length > 0) {
            hasSemanticEvents = true;
            hasReasoningEvents = true;
          }
        }
        if (typeof payload.delta?.signature === 'string' && payload.delta.signature.length > 0) {
          hasSemanticEvents = true;
        }

        // 3. 工具调用参数增量 (input_json_delta)
        if (typeof payload.delta?.partial_json === 'string') {
          outputChars += payload.delta.partial_json.length;
          if (payload.delta.partial_json.length > 0) hasSemanticEvents = true;
        }

        // 4. 工具块启动 (tool_use block)
        if (payload.content_block?.type === 'tool_use' || payload.content_block?.type === 'thinking') {
          hasSemanticEvents = true;
          if (payload.content_block?.type === 'thinking') hasReasoningEvents = true;
        }

        if (!ttftMs && (hasSemanticEvents || outputChars > 0)) {
          ttftMs = Date.now() - startTime;
        }
      } catch (e) {}
    });

    proxyRes.on('data', (chunk) => {
      sseParser.feed(chunk);

      if (!isCommitted) {
        precommitBytes += chunk.length;
        earlyBufferedChunks.push(chunk);

        if (precommitBytes > MAX_PRECOMMIT_BYTES) {
          console.error(`[Gate] Precommit buffer exceeded ${MAX_PRECOMMIT_BYTES} bytes without semantic commit. Aborting.`);
          activeProxyReq.destroy();
          if (!clientRes.headersSent) {
            clientRes.writeHead(502, { 'Content-Type': 'application/json' });
            clientRes.end(JSON.stringify({
              error: {
                message: 'Precommit buffer overflow without semantic output.',
                type: 'upstream_stream_overflow',
                code: 502
              }
            }));
            recordOnce({
              keyId: hotKeyId,
              model: requestModel,
              status: 502,
              totalTokens: 0,
              latencyMs: Date.now() - startTime,
              stream: true,
              errorType: 'stream_overflow'
            });
          } else if (!clientRes.destroyed) {
            clientRes.destroy();
          }
          return;
        }

        if (hasSemanticEvents || hasExplicitFilter) {
          isCommitted = true;
          negativeCache.delete(fingerprint);
          clientRes.writeHead(statusCode, sanitizeResponseHeaders(proxyRes.headers));
          for (const b of earlyBufferedChunks) {
            writeWithBackpressure(clientRes, b);
          }
          earlyBufferedChunks.length = 0;
        }
      } else {
        writeWithBackpressure(clientRes, chunk);
      }
    });

    proxyRes.on('end', async () => {
      sseParser.flush();

      if (sseParser.isIncompleteEof) {
        console.error(`[Gate] Stream ended prematurely with incomplete SSE block.`);
        if (!isCommitted && !clientRes.headersSent) {
          if (retryEligible && attempt < (MAX_ATTEMPTS - 1) && !abortController.signal.aborted) {
            try {
              await abortableSleep(DEFAULT_RETRY_DELAY_MS, abortController.signal);
              return executeTransportGuard(clientReq, clientRes, originalRawBody, parsedBody, fingerprint, retryEligible, upstreamHost, upstreamPort, attempt + 1, abortController, startTime, hotKeyId);
            } catch (e) {
              return;
            }
          }
          clientRes.writeHead(502, { 'Content-Type': 'application/json' });
          clientRes.end(JSON.stringify({
            error: {
              message: 'Upstream stream ended prematurely with incomplete SSE block.',
              type: 'upstream_stream_interrupted',
              code: 502
            }
          }));
          recordOnce({
            keyId: hotKeyId,
            model: requestModel,
            status: 502,
            totalTokens: 0,
            latencyMs: Date.now() - startTime,
            stream: true,
            errorType: 'stream_interrupted',
            authIndex: detectedAuthIndex
          });
          return;
        } else {
          if (!clientRes.destroyed) clientRes.destroy();
          return;
        }
      }

      if (!isCommitted) {
        if (statusCode >= 200 && statusCode < 500) markUpstreamSuccess(upstreamPort);
        else markUpstreamFailure(upstreamPort);

        if (hasExplicitFilter) {
          clientRes.writeHead(statusCode, sanitizeResponseHeaders(proxyRes.headers));
          for (const b of earlyBufferedChunks) {
            clientRes.write(b);
          }
          clientRes.end();
          recordOnce({
            keyId: hotKeyId,
            model: requestModel,
            status: statusCode,
            promptTokens: lastUsage?.promptTokens ?? 0,
            completionTokens: lastUsage?.completionTokens ?? 0,
            totalTokens: lastUsage?.totalTokens ?? 0,
            latencyMs: Date.now() - startTime,
            stream: true,
            estimated: false,
            errorType: 'content_filtered'
          });
          return;
        }

        const reasonDesc = hasReasoningEvents ? 'reasoning-only empty stop' : 'clean empty stop';
        console.warn(`[Gate] [Stream] Attempt ${attempt + 1}/${MAX_ATTEMPTS} finished before commit (${reasonDesc}).`);

        if (retryEligible && attempt < (MAX_ATTEMPTS - 1) && !abortController.signal.aborted) {
          const nextAttempt = attempt + 1;
          const label = nextAttempt === 2 ? 'Healing probe (attempt 3/3)' : `Safe identical retry (attempt ${nextAttempt + 1}/${MAX_ATTEMPTS})`;
          console.log(`[Gate] ${label}...`);
          try {
            await abortableSleep(DEFAULT_RETRY_DELAY_MS, abortController.signal);
            return executeTransportGuard(clientReq, clientRes, originalRawBody, parsedBody, fingerprint, retryEligible, upstreamHost, upstreamPort, nextAttempt, abortController, startTime, hotKeyId);
          } catch (e) {
            return;
          }
        }

        negativeCache.set(fingerprint, Date.now() + NEGATIVE_CACHE_TTL_MS);

        if (!clientRes.headersSent) {
          console.error(`[Gate] Returning 502 upstream_empty_response to client after ${MAX_ATTEMPTS} attempts.`);
          try {
            const reqObj = JSON.parse(originalRawBody.toString('utf8'));
            const summary = {
              timestamp: new Date().toISOString(),
              model: reqObj.model,
              payload_sha256_prefix: fingerprint.slice(0, 12),
              messages_count: Array.isArray(reqObj.messages) ? reqObj.messages.length : 0,
              tools_count: Array.isArray(reqObj.tools) ? reqObj.tools.length : 0
            };
            fs.writeFileSync('/tmp/cpa_last_empty_request.json', JSON.stringify(summary, null, 2));
            console.log('[Gate] Dumped failed request structure to /tmp/cpa_last_empty_request.json');
          } catch (e) {
            console.error('[Gate] Failed to dump empty request:', e.message);
          }
          clientRes.writeHead(502, { 'Content-Type': 'application/json' });
          clientRes.end(JSON.stringify({
            error: {
              message: `Upstream model returned empty stream without semantic output after ${MAX_ATTEMPTS} attempts.`,
              type: 'upstream_empty_response',
              code: 502
            }
          }));
          recordOnce({
            keyId: hotKeyId,
            model: requestModel,
            status: 502,
            totalTokens: 0,
            latencyMs: Date.now() - startTime,
            stream: true,
            errorType: 'empty_response',
            authIndex: detectedAuthIndex
          });
          return;
        }
      }

      if (!clientRes.writableEnded) {
        clientRes.end();
      }

      if (isCommitted && !hasExplicitFilter) {
        const usage = lastUsage || (outputChars > 0
          ? {
              promptTokens: inputEstimate,
              completionTokens: estimateTokensFromChars(outputChars),
              totalTokens: inputEstimate + estimateTokensFromChars(outputChars),
              estimated: true
            }
          : null);
        const finalLatency = Date.now() - startTime;
        recordOnce({
          keyId: hotKeyId,
          model: requestModel,
          status: statusCode,
          promptTokens: usage?.promptTokens ?? 0,
          completionTokens: usage?.completionTokens ?? 0,
          cachedTokens: usage?.cachedTokens ?? 0,
          totalTokens: usage?.totalTokens ?? 0,
          latencyMs: finalLatency,
          ttftMs: ttftMs || finalLatency,
          stream: true,
          estimated: usage?.estimated ?? false,
          errorType: null,
          authIndex: detectedAuthIndex
        });
      }
    });

    proxyRes.on('error', (err) => {
      console.error(`[Gate] Upstream socket error while streaming:`, err.message);
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { 'Content-Type': 'application/json' });
        clientRes.end(JSON.stringify({ error: { message: `Upstream error: ${err.message}`, type: 'upstream_stream_interrupted', code: 502 } }));
      } else {
        if (!clientRes.destroyed) clientRes.destroy();
      }
    });
  });

    activeProxyReq.on('error', async (err) => {
      if (abortController.signal.aborted) {
        return;
      }

      markUpstreamFailure(upstreamPort);
      console.error(`[Gate] Network failure connecting to upstream:`, err.message);

    if (!isCommitted && !clientRes.headersSent && retryEligible && attempt < (MAX_ATTEMPTS - 1)) {
      console.log(`[Gate] Retrying on network failure (attempt ${attempt + 2}/${MAX_ATTEMPTS})...`);
      try {
        await abortableSleep(DEFAULT_RETRY_DELAY_MS, abortController.signal);
        return executeTransportGuard(clientReq, clientRes, originalRawBody, parsedBody, fingerprint, retryEligible, upstreamHost, upstreamPort, attempt + 1, abortController, startTime, hotKeyId);
      } catch (e) {
        return;
      }
    }

    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({
        error: {
          message: `Bad Gateway: Upstream connection failed (${err.message})`,
          type: 'upstream_connection_error',
          code: 502
        }
      }));
      recordOnce({
        keyId: hotKeyId,
        model: requestModel,
        status: 502,
        totalTokens: 0,
        latencyMs: Date.now() - startTime,
        stream: requestStream,
        errorType: 'connection_error'
      });
    } else {
      if (!clientRes.destroyed) clientRes.destroy();
    }
  });

  activeProxyReq.write(payloadToSend);
  activeProxyReq.end();
}

import http from 'http';

let isShuttingDownState = false;
const activeHttpRequests = new Set();
const activeWebSockets = new Set();
let shutdownTimer = null;
let drainResolve = null;

export function isShuttingDown() {
  return isShuttingDownState;
}

export function getActiveRequestCounts() {
  return {
    http: activeHttpRequests.size,
    ws: activeWebSockets.size,
    total: activeHttpRequests.size + activeWebSockets.size
  };
}

/**
 * Rejects a raw socket with HTTP status during shutdown or error
 */
export function rejectSocket(socket, statusCode, statusText, message, type) {
  if (!socket || socket.destroyed || !socket.writable) return;
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
 * Track an incoming HTTP request.
 * Returns false if the request was rejected due to shutdown in progress.
 * Returns true if request should proceed normally.
 */
export function trackHttpRequest(req, res) {
  if (isShuttingDownState) {
    let urlPath = '';
    try {
      urlPath = new URL(req.url, 'http://localhost').pathname;
    } catch {}

    if (urlPath === '/healthz' || urlPath === '/readyz') {
      res.writeHead(503, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Connection': 'close'
      });
      res.end(JSON.stringify({
        status: 'shutting_down',
        service: 'gate',
        message: 'Gate is shutting down',
        now: Date.now()
      }));
      return false;
    }

    res.writeHead(503, {
      'Content-Type': 'application/json; charset=utf-8',
      'Connection': 'close',
      'Retry-After': '5'
    });
    res.end(JSON.stringify({
      error: {
        message: 'Gate is shutting down. Please retry request on another instance or after restart.',
        type: 'service_shutting_down',
        code: 503
      }
    }));
    return false;
  }

  // Intercept writeHead to inject 'Connection: close' if shutdown starts during processing
  const origWriteHead = res.writeHead.bind(res);
  res.writeHead = function (statusCode, ...args) {
    if (isShuttingDownState) {
      let headersArg = null;
      if (args.length > 0) {
        const last = args[args.length - 1];
        if (typeof last === 'object' && last !== null && !Array.isArray(last)) {
          headersArg = last;
        }
      }
      if (headersArg) {
        headersArg['connection'] = 'close';
      } else {
        try {
          res.setHeader('Connection', 'close');
        } catch {}
      }
    }
    return origWriteHead(statusCode, ...args);
  };

  const reqItem = { req, res, startedAt: Date.now() };
  activeHttpRequests.add(reqItem);

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    res.removeListener('finish', cleanup);
    res.removeListener('close', cleanup);
    activeHttpRequests.delete(reqItem);

    if (isShuttingDownState) {
      // Ensure socket is closed cleanly after response ends so client won't reuse keep-alive
      if (req.socket && !req.socket.destroyed) {
        try {
          req.socket.end();
        } catch {
          req.socket.destroy();
        }
      }
      checkDrain();
    }
  };

  res.on('finish', cleanup);
  res.on('close', cleanup);
  return true;
}

/**
 * Track an active WebSocket upgrade connection.
 * Returns false if rejected due to shutdown in progress.
 */
export function trackWebSocket(socket) {
  if (isShuttingDownState) {
    rejectSocket(socket, 503, 'Service Unavailable', 'Gate is shutting down', 'service_shutting_down');
    return false;
  }

  const wsItem = { socket, startedAt: Date.now() };
  activeWebSockets.add(wsItem);

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    socket.removeListener('close', cleanup);
    socket.removeListener('error', cleanup);
    activeWebSockets.delete(wsItem);

    if (isShuttingDownState) {
      checkDrain();
    }
  };

  socket.on('close', cleanup);
  socket.on('error', cleanup);
  return true;
}

function checkDrain() {
  if (activeHttpRequests.size === 0 && activeWebSockets.size === 0) {
    if (drainResolve) {
      const resolve = drainResolve;
      drainResolve = null;
      resolve();
    }
  }
}

/**
 * Set up graceful shutdown handlers for the given list of HTTP servers.
 */
export function setupGracefulShutdown(servers, options = {}) {
  const timeoutMs = options.timeoutMs ?? parseInt(process.env.GATE_SHUTDOWN_TIMEOUT_MS || '60000', 10);
  const onDrain = options.onDrain || null;
  const exitProcess = options.exitProcess !== false;

  const handleSignal = async (signal) => {
    if (isShuttingDownState) {
      console.warn(`[Gate] Second ${signal} received. Forcing immediate termination.`);
      if (exitProcess) process.exit(1);
      return;
    }

    isShuttingDownState = true;
    const initialCounts = getActiveRequestCounts();
    console.log(`[Gate] Received ${signal}. Initiating graceful shutdown (in-flight HTTP: ${initialCounts.http}, WS: ${initialCounts.ws}, timeout: ${timeoutMs}ms)...`);

    // 1. Stop accepting new connections on all HTTP servers
    for (const srv of servers) {
      try {
        srv.close((err) => {
          if (err && err.code !== 'ERR_SERVER_NOT_RUNNING') {
            console.warn(`[Gate] Error closing server:`, err.message);
          }
        });
      } catch (e) {}

      // 2. Immediately close idle keep-alive connections
      try {
        if (typeof srv.closeIdleConnections === 'function') {
          srv.closeIdleConnections();
        }
      } catch (e) {}
    }

    // 3. Wait for in-flight requests to drain or timeout
    const drainPromise = new Promise((resolve) => {
      if (activeHttpRequests.size === 0 && activeWebSockets.size === 0) {
        resolve();
      } else {
        drainResolve = resolve;
      }
    });

    const timeoutPromise = new Promise((resolve) => {
      shutdownTimer = setTimeout(() => {
        const remaining = getActiveRequestCounts();
        console.warn(`[Gate] Shutdown timeout (${timeoutMs}ms) reached. Force terminating ${remaining.http} HTTP and ${remaining.ws} WS connections.`);

        // Force close remaining HTTP sockets
        for (const item of activeHttpRequests) {
          try {
            if (item.res && !item.res.headersSent) {
              item.res.writeHead(503, { 'Content-Type': 'application/json', 'Connection': 'close' });
              item.res.end(JSON.stringify({ error: { message: 'Gate shutdown timeout', code: 503 } }));
            }
            if (item.req?.socket && !item.req.socket.destroyed) {
              item.req.socket.destroy();
            }
          } catch (e) {}
        }
        activeHttpRequests.clear();

        // Force close remaining WebSockets
        for (const item of activeWebSockets) {
          try {
            if (item.socket && !item.socket.destroyed) {
              item.socket.destroy();
            }
          } catch (e) {}
        }
        activeWebSockets.clear();

        resolve();
      }, timeoutMs);
    });

    const drainStart = Date.now();
    await Promise.race([drainPromise, timeoutPromise]);
    if (shutdownTimer) clearTimeout(shutdownTimer);

    const elapsed = Date.now() - drainStart;
    console.log(`[Gate] In-flight requests drained in ${elapsed}ms. Running final cleanup...`);

    if (onDrain) {
      try {
        await onDrain();
      } catch (err) {
        console.error(`[Gate] Error during shutdown cleanup:`, err.message);
      }
    }

    console.log(`[Gate] Graceful shutdown complete. Exiting.`);
    if (exitProcess) {
      process.exit(0);
    }
  };

  const sigtermHandler = () => handleSignal('SIGTERM');
  const sigintHandler = () => handleSignal('SIGINT');

  process.on('SIGTERM', sigtermHandler);
  process.on('SIGINT', sigintHandler);

  return {
    handleSignal,
    removeSignalHandlers: () => {
      process.removeListener('SIGTERM', sigtermHandler);
      process.removeListener('SIGINT', sigintHandler);
    }
  };
}

/**
 * Reset all internal shutdown and active tracking state (for unit and integration tests only).
 */
export function resetShutdownStateForTests() {
  isShuttingDownState = false;
  activeHttpRequests.clear();
  activeWebSockets.clear();
  if (shutdownTimer) {
    clearTimeout(shutdownTimer);
    shutdownTimer = null;
  }
  drainResolve = null;
}

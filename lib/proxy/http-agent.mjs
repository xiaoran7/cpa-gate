import http from 'http';

/**
 * Gate 全局持久上游 HTTP 连接池 (Keep-Alive Agent)
 *
 * 复用 Gate 到 CPA 之间的 TCP 连接，消除每次请求的握手与建连开销，
 * 提升 TTFT 首字延迟并大幅减少系统 socket 与 TIME_WAIT 句柄占用。
 */
export const upstreamHttpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 15000,
  maxSockets: 256,
  maxFreeSockets: 64,
  timeout: 120000
});

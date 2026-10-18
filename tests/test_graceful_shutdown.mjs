import http from 'http';
import assert from 'assert';
import { EventEmitter } from 'events';
import {
  isShuttingDown,
  getActiveRequestCounts,
  trackHttpRequest,
  trackWebSocket,
  setupGracefulShutdown,
  resetShutdownStateForTests,
  rejectSocket
} from '../lib/core/graceful-shutdown.mjs';
import { handleSystemRoutes } from '../lib/routes/system-routes.mjs';

console.log('=== 开始执行 Gate 优雅停机与排空机制测试 (Graceful Shutdown & Drain) ===\n');

// 辅助创建模拟 HTTP req/res
function createMockHttpPair(url = '/v1/chat/completions') {
  const req = new EventEmitter();
  req.url = url;
  req.method = 'POST';
  req.headers = { host: 'localhost:8317' };
  req.socket = new EventEmitter();
  req.socket.destroyed = false;
  req.socket.end = () => { req.socket.destroyed = true; req.socket.emit('close'); };
  req.socket.destroy = () => { req.socket.destroyed = true; req.socket.emit('close'); };

  const res = new EventEmitter();
  res.headersSent = false;
  res.statusCode = 200;
  res._headers = {};
  res.setHeader = (k, v) => { res._headers[k.toLowerCase()] = v; };
  res.writeHead = (code, headers = {}) => {
    res.statusCode = code;
    res.headersSent = true;
    for (const [k, v] of Object.entries(headers)) {
      res._headers[k.toLowerCase()] = v;
    }
  };
  res.end = (data) => {
    res._data = data;
    res.emit('finish');
    res.emit('close');
  };

  return { req, res };
}

// 辅助创建模拟 WebSocket socket
function createMockSocket() {
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.writable = true;
  socket._written = [];
  socket.write = (data) => { socket._written.push(String(data)); return true; };
  socket.end = (data) => {
    if (data) socket.write(data);
    socket.destroyed = true;
    socket.emit('close');
  };
  socket.destroy = () => {
    socket.destroyed = true;
    socket.emit('close');
  };
  return socket;
}

// ---- 测试 1: 正常流量生命周期追踪 ----
console.log('测试 1: 正常流量生命周期追踪与计数');
resetShutdownStateForTests();
assert.strictEqual(isShuttingDown(), false);
assert.strictEqual(getActiveRequestCounts().total, 0);

const pair1 = createMockHttpPair();
const accepted1 = trackHttpRequest(pair1.req, pair1.res);
assert.strictEqual(accepted1, true, '正常状态应放行请求');
assert.strictEqual(getActiveRequestCounts().http, 1, '活跃 HTTP 计数应为 1');

pair1.res.end('done');
assert.strictEqual(getActiveRequestCounts().http, 0, '请求结束后活跃计数应归零');
console.log('  ✓ 正常 HTTP 请求生命周期与计数器增减验证通过');

// ---- 测试 2: WebSocket 升级连接生命周期追踪 ----
console.log('\n测试 2: WebSocket 升级连接生命周期追踪');
const ws1 = createMockSocket();
const wsAccepted1 = trackWebSocket(ws1);
assert.strictEqual(wsAccepted1, true, '正常状态应放行 WebSocket 升级');
assert.strictEqual(getActiveRequestCounts().ws, 1, '活跃 WebSocket 计数应为 1');

ws1.emit('close');
assert.strictEqual(getActiveRequestCounts().ws, 0, 'WebSocket 关闭后活跃计数应归零');
console.log('  ✓ WebSocket 升级连接生命周期与计数器增减验证通过');

// ---- 测试 3: 停机阶段新请求与探针拦截 (503 Fast Reject) ----
console.log('\n测试 3: 停机阶段新请求与探针拦截 (503 Fast Reject)');
resetShutdownStateForTests();

// 模拟触发停机信号
const mockServer = {
  closeCalled: false,
  idleConnectionsClosed: false,
  close(cb) { this.closeCalled = true; if (cb) cb(); },
  closeIdleConnections() { this.idleConnectionsClosed = true; }
};

let drained = false;
const shutdownCtrl = setupGracefulShutdown([mockServer], {
  timeoutMs: 1000,
  exitProcess: false,
  onDrain: async () => { drained = true; }
});

await shutdownCtrl.handleSignal('SIGTERM');
assert.strictEqual(isShuttingDown(), true, '停机标志应被置为 true');
assert.strictEqual(mockServer.closeCalled, true, '所有 HTTP 监听服务应停止接收新连接 (srv.close)');
assert.strictEqual(mockServer.idleConnectionsClosed, true, '空闲 Keep-Alive 连接应被立即关闭 (closeIdleConnections)');

// 1. 停机阶段业务请求拒绝
const pair2 = createMockHttpPair('/v1/chat/completions');
const accepted2 = trackHttpRequest(pair2.req, pair2.res);
assert.strictEqual(accepted2, false, '停机阶段业务请求应被直接拒绝');
assert.strictEqual(pair2.res.statusCode, 503, '拒绝状态码应为 503');
assert.strictEqual(pair2.res._headers['connection'], 'close', '应显式告知客户端断开连接');
assert.strictEqual(pair2.res._headers['retry-after'], '5', '应包含重试退避提示');
const resJson2 = JSON.parse(pair2.res._data);
assert.strictEqual(resJson2.error.type, 'service_shutting_down');

// 2. 停机阶段健康探针拒绝
const pairHealth = createMockHttpPair('/healthz');
const acceptedHealth = trackHttpRequest(pairHealth.req, pairHealth.res);
assert.strictEqual(acceptedHealth, false, '停机阶段探针应被拒绝');
assert.strictEqual(pairHealth.res.statusCode, 503, '健康检查探针应返回 503 (告诉负载均衡节点正在下线)');
const resHealthJson = JSON.parse(pairHealth.res._data);
assert.strictEqual(resHealthJson.status, 'shutting_down');

// 3. 停机阶段 WebSocket 升级拒绝
const ws2 = createMockSocket();
const wsAccepted2 = trackWebSocket(ws2);
assert.strictEqual(wsAccepted2, false, '停机阶段 WebSocket 升级应被直接拒绝');
assert.ok(ws2._written.some(msg => msg.includes('503 Service Unavailable')), 'WebSocket 应收到 503 拒绝报文');

console.log('  ✓ 停机期间业务请求返回 503 service_shutting_down 验证通过');
console.log('  ✓ 停机期间健康探针返回 503 shutting_down 验证通过');
console.log('  ✓ 停机期间 WebSocket 升级拦截并拒绝验证通过');

// ---- 测试 4: 在途长流式请求排空 (In-flight Draining & Connection Close) ----
console.log('\n测试 4: 在途长流式请求排空与连接关闭');
resetShutdownStateForTests();

const mockServer2 = {
  closeCalled: false,
  close(cb) { this.closeCalled = true; if (cb) cb(); },
  closeIdleConnections() {}
};

// 1. 模拟停机信号到达前，已有一个长流式推理请求正在进行 (例如 Claude Desktop 生成代码)
const inFlightStream = createMockHttpPair('/v1/messages');
trackHttpRequest(inFlightStream.req, inFlightStream.res);
assert.strictEqual(getActiveRequestCounts().http, 1, '在途流式请求已计入活跃队列');

let drainCompleted = false;
let drainCleanedUp = false;
const shutdownCtrl2 = setupGracefulShutdown([mockServer2], {
  timeoutMs: 2000,
  exitProcess: false,
  onDrain: async () => {
    drainCleanedUp = true;
  }
});

// 2. 此时外部触发 SIGTERM (例如运维 systemctl restart gate)
const shutdownPromise = shutdownCtrl2.handleSignal('SIGTERM');
assert.strictEqual(isShuttingDown(), true);
assert.strictEqual(inFlightStream.req.socket.destroyed, false, '在途请求的 Socket 严禁被立刻切断！');
assert.strictEqual(drainCleanedUp, false, '还有请求未完成，不得提前触发清理');

// 3. 在途流式请求后续向客户端写入响应头 (例如上游首字吐出)
inFlightStream.res.writeHead(200, {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache'
});
// 校验 writeHead 钩子：因为 Gate 正在停机，必须自动注入 Connection: close 告知客户端此连接用完即毁
assert.strictEqual(inFlightStream.res._headers['connection'], 'close', '流式响应头必须自动注入 connection: close');

// 4. 流式响应传输完毕，调用 res.end()
inFlightStream.res.end('data: [DONE]\n\n');

// 等待排空完成
await shutdownPromise;
assert.strictEqual(getActiveRequestCounts().http, 0, '所有在途请求已排空，计数应为 0');
assert.strictEqual(drainCleanedUp, true, '在途请求排空后应触发 onDrain 钩子');
assert.strictEqual(inFlightStream.req.socket.destroyed, true, '响应完成后原底层 Socket 应被优雅关闭，杜绝客户端重用');
console.log('  ✓ 在途长流式请求未被硬中断验证通过');
console.log('  ✓ 停机期间在途响应头自动注入 Connection: close 验证通过');
console.log('  ✓ 请求自然结束后安全触发清理与退出闭环验证通过');

// ---- 测试 5: 超时强制截断防御 (Bounded Timeout) ----
console.log('\n测试 5: 超时强制截断防御 (Bounded Timeout)');
resetShutdownStateForTests();

const mockServer3 = {
  close(cb) { if (cb) cb(); },
  closeIdleConnections() {}
};

// 模拟一个死锁的客户端请求（不响应也不结束）
const hangingReq = createMockHttpPair();
trackHttpRequest(hangingReq.req, hangingReq.res);

let timeoutDrainTriggered = false;
const shutdownCtrl3 = setupGracefulShutdown([mockServer3], {
  timeoutMs: 100, // 缩短为 100ms 快速验证
  exitProcess: false,
  onDrain: async () => {
    timeoutDrainTriggered = true;
  }
});

const t0 = Date.now();
await shutdownCtrl3.handleSignal('SIGTERM');
const elapsed = Date.now() - t0;

assert.ok(elapsed >= 90, `耗时应接近超时设置 (实测 ${elapsed}ms)`);
assert.strictEqual(timeoutDrainTriggered, true, '超时后应强制触发 onDrain');
assert.strictEqual(hangingReq.req.socket.destroyed, true, '超时的悬挂 Socket 应被强制销毁');
assert.strictEqual(getActiveRequestCounts().total, 0, '超时后活跃队列应被清空');
console.log('  ✓ 超时强制截断保底机制验证通过');

// ---- 测试 6: /metrics 优雅停机与排空指标导出 ----
console.log('\n测试 6: /metrics 优雅停机与排空指标导出');
resetShutdownStateForTests();

let metricsOutput = '';
const metricsRes = {
  writeHead: () => {},
  end: (data) => { metricsOutput = data; }
};
handleSystemRoutes({}, metricsRes, '/metrics', '');
assert.ok(metricsOutput.includes('gate_shutting_down 0'), '初始停机指标应为 0');
assert.ok(metricsOutput.includes('gate_in_flight_http_requests 0'), '初始 HTTP 在途指标应为 0');
assert.ok(metricsOutput.includes('gate_in_flight_ws_requests 0'), '初始 WS 在途指标应为 0');
assert.ok(metricsOutput.includes('gate_in_flight_requests_total 0'), '初始总在途指标应为 0');

console.log('  ✓ /metrics Prometheus 停机与排空监控指标验证通过');

// 测试收尾
resetShutdownStateForTests();
shutdownCtrl.removeSignalHandlers();
shutdownCtrl2.removeSignalHandlers();
shutdownCtrl3.removeSignalHandlers();

console.log('\n=== 全部 Gate 优雅停机与排空测试用例执行完毕，全部通过！===');

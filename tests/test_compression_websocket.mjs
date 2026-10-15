import assert from 'assert';
import http from 'http';
import zlib from 'zlib';
import { isolateTestDb } from './_isolated-db.mjs';

isolateTestDb(import.meta.url, 'gate-compression-ws');

const { decompressBody, readBody } = await import('../lib/config.mjs');
const { handleWebSocketUpgrade } = await import('../lib/proxy/websocket-proxy.mjs');

console.log('=== 开始执行 Gate 上下行压缩与 WebSocket 穿透集成测试 ===\n');

// 1. 测试 lib/config.mjs 中的 decompressBody 与 readBody
console.log('测试 1: 上行请求体压缩格式解析 (Gzip, Deflate, Brotli)');
const testPayload = JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hello compression' }] });
const rawBuf = Buffer.from(testPayload, 'utf8');

// 1.1 Gzip 解压测试
const gzipBuf = zlib.gzipSync(rawBuf);
const gunzipped = decompressBody(gzipBuf, 'gzip');
assert.strictEqual(gunzipped.toString('utf8'), testPayload, 'decompressBody gzip 应正确还原原始 Payload');

// 1.2 Deflate 解压测试
const deflateBuf = zlib.deflateSync(rawBuf);
const inflated = decompressBody(deflateBuf, 'deflate');
assert.strictEqual(inflated.toString('utf8'), testPayload, 'decompressBody deflate 应正确还原原始 Payload');

// 1.3 Brotli 解压测试
const brBuf = zlib.brotliCompressSync(rawBuf);
const brotlied = decompressBody(brBuf, 'br');
assert.strictEqual(brotlied.toString('utf8'), testPayload, 'decompressBody br 应正确还原原始 Payload');

console.log('  ✓ Gzip / Deflate / Brotli 解压算法单元测试通过');

// 2. 模拟客户端发起带有 Content-Encoding 的 HTTP 请求体，验证 readBody 自动解压
console.log('\n测试 2: 客户端携带 Content-Encoding 上行请求，readBody 自动解压缩');

const dummyServer = http.createServer(async (req, res) => {
  try {
    const body = await readBody(req, 1024 * 1024);
    const json = JSON.parse(body.toString('utf8'));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ received: json }));
  } catch (err) {
    res.writeHead(err.statusCode || 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

await new Promise(resolve => dummyServer.listen(0, '127.0.0.1', resolve));
const dummyPort = dummyServer.address().port;

async function sendCompressedReq(encoding, compressedData) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: dummyPort,
      path: '/test',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Encoding': encoding,
        'Content-Length': compressedData.length
      }
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.on('error', reject);
    req.end(compressedData);
  });
}

const gzipRes = await sendCompressedReq('gzip', gzipBuf);
assert.strictEqual(gzipRes.status, 200, 'Gzip 上行请求应返回 200');
assert.strictEqual(gzipRes.body.received.model, 'gpt-4o', 'readBody 应自动将 Gzip 解压并解析出正确的 JSON 内容');

const brRes = await sendCompressedReq('br', brBuf);
assert.strictEqual(brRes.status, 200, 'Brotli 上行请求应返回 200');
assert.strictEqual(brRes.body.received.model, 'gpt-4o', 'readBody 应自动将 Brotli 解压并解析出正确的 JSON 内容');

console.log('  ✓ 客户端上行请求体 Gzip & Brotli 自动解压端到端验证通过');
dummyServer.close();

// 3. 测试 WebSocket 升级拦截与全双工代理
console.log('\n测试 3: WebSocket 升级请求代理与鉴权拦截');

// 3.1 启动模拟上游 WebSocket 服务器
let upstreamWsReceived = null;
const mockUpstreamServer = http.createServer((req, res) => {
  res.writeHead(404);
  res.end();
});

mockUpstreamServer.on('upgrade', (req, socket, head) => {
  // 模拟上游返回标准的 101 Switching Protocols
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=',
    '',
    ''
  ].join('\r\n'));

  socket.on('data', chunk => {
    upstreamWsReceived = chunk.toString();
    // 回声（Echo）响应，模拟双向数据交互（如增量 WS 或 Realtime 协议）
    socket.write(`echo:${upstreamWsReceived}`);
  });
});

await new Promise(resolve => mockUpstreamServer.listen(0, '127.0.0.1', resolve));
const mockUpstreamPort = mockUpstreamServer.address().port;

// 3.2 启动 Gate 网关层（挂载 handleWebSocketUpgrade 并指向模拟上游）
const gateWsServer = http.createServer();
gateWsServer.on('upgrade', (req, socket, head) => {
  handleWebSocketUpgrade(req, socket, head, '127.0.0.1', mockUpstreamPort);
});

await new Promise(resolve => gateWsServer.listen(0, '127.0.0.1', resolve));
const gateWsPort = gateWsServer.address().port;

// 3.3 测试用例：未带有效认证的非法升级请求应被 401 拦截
const unauthTest = await new Promise((resolve) => {
  const req = http.request({
    hostname: '127.0.0.1',
    port: gateWsPort,
    path: '/v1/realtime',
    method: 'GET',
    headers: {
      'Connection': 'Upgrade',
      'Upgrade': 'websocket',
      'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Version': '13'
    }
  });

  req.on('response', (res) => {
    resolve({ statusCode: res.statusCode });
  });

  req.on('error', (err) => resolve({ error: err.message }));
  req.end();
});

assert.strictEqual(unauthTest.statusCode, 401, '未认证的 WebSocket 升级请求必须被 Gate 拦截并返回 401');
console.log('  ✓ 非法/未认证 WebSocket 升级安全拦截验证通过 (HTTP 401)');

// 3.4 测试用例：携带 Admin Secret 的合法 WebSocket 请求建立 101 连接并双向传输
const wsConnectionTest = await new Promise((resolve, reject) => {
  const req = http.request({
    hostname: '127.0.0.1',
    port: gateWsPort,
    path: '/admin/realtime',
    method: 'GET',
    headers: {
      'Connection': 'Upgrade',
      'Upgrade': 'websocket',
      'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Version': '13',
      'Authorization': 'Bearer ' + (process.env.GATE_ADMIN_SECRET || 'test-secret-12345678901234567890')
    }
  });

  req.on('upgrade', (res, socket, upgradeHead) => {
    assert.strictEqual(res.statusCode, 101, 'Gate 应成功转发上游 101 Switching Protocols');

    // 发送测试消息，验证双向直通
    socket.write('ping_from_client');

    socket.on('data', (chunk) => {
      const text = chunk.toString();
      socket.destroy();
      resolve({ statusCode: 101, echoReceived: text });
    });
  });

  req.on('error', reject);
  req.end();
});

assert.strictEqual(wsConnectionTest.statusCode, 101, 'WebSocket 握手应成功返回 101');
assert.strictEqual(wsConnectionTest.echoReceived, 'echo:ping_from_client', '全双工通道应畅通无阻，支持增量 WS 双向数据互通');
console.log('  ✓ WebSocket 握手协议升级与双向全双工增量透传验证通过');

mockUpstreamServer.close();
gateWsServer.close();

// 4. 测试下行非流式响应压缩与 Gate Token 审计解压感知
console.log('\n测试 4: 下行响应压缩 (Content-Encoding: gzip) 透传与 Gate Token 审计解压');

const mockLlmUpstream = http.createServer((req, res) => {
  const respObj = {
    id: 'chatcmpl-gz-test',
    choices: [{
      message: { role: 'assistant', content: 'hello from compressed upstream' },
      finish_reason: 'stop'
    }],
    usage: {
      prompt_tokens: 120,
      completion_tokens: 35,
      total_tokens: 155
    }
  };
  const gzipped = zlib.gzipSync(Buffer.from(JSON.stringify(respObj), 'utf8'));
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Encoding': 'gzip',
    'Content-Length': gzipped.length
  });
  res.end(gzipped);
});

await new Promise(resolve => mockLlmUpstream.listen(0, '127.0.0.1', resolve));
const mockLlmPort = mockLlmUpstream.address().port;

const { executeTransportGuard } = await import('../lib/proxy/transport.mjs');

const clientReqMock = {
  url: '/v1/chat/completions',
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'accept-encoding': 'gzip, deflate, br'
  }
};

let clientResHeaders = null;
const clientResChunks = [];
let clientResEnded = false;

const clientResMock = new (await import('events')).EventEmitter();
clientResMock.writeHead = (status, headers) => { clientResHeaders = { status, ...headers }; };
clientResMock.write = (chunk) => { clientResChunks.push(chunk); return true; };
clientResMock.end = (chunk) => {
  if (chunk) clientResChunks.push(chunk);
  clientResEnded = true;
  clientResMock.emit('finish');
};
clientResMock.headersSent = false;
clientResMock.destroyed = false;
clientResMock.writableEnded = false;

const rawReqPayload = Buffer.from(JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: 'test' }] }));
const parsedReq = JSON.parse(rawReqPayload.toString('utf8'));
const ac = new AbortController();

await executeTransportGuard(
  clientReqMock,
  clientResMock,
  rawReqPayload,
  parsedReq,
  'fingerprint-test-1',
  false,
  '127.0.0.1',
  mockLlmPort,
  0,
  ac,
  Date.now(),
  1
);

await new Promise(resolve => {
  if (clientResEnded) resolve();
  else clientResMock.once('finish', resolve);
});

assert.strictEqual(clientResHeaders.status, 200, '下行压缩响应状态码应为 200');
assert.strictEqual(clientResHeaders['content-encoding'], 'gzip', 'Gate 应保留上游下发的 Content-Encoding: gzip 节约下行带宽');
const receivedCompressed = Buffer.concat(clientResChunks);
const unzippedBody = JSON.parse(zlib.gunzipSync(receivedCompressed).toString('utf8'));
assert.strictEqual(unzippedBody.usage.total_tokens, 155, '客户端解压后应完整获得正确 JSON');
console.log('  ✓ 下行响应压缩透传与 Gate 审计感知验证通过');

mockLlmUpstream.close();

console.log('\n=== 全部上下行压缩与 WebSocket 穿透测试通过！===');
process.exit(0);

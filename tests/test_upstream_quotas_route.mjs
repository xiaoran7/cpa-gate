import assert from 'node:assert';
import http from 'node:http';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isolateTestDb } from './_isolated-db.mjs';

isolateTestDb(import.meta.url, 'upstream-quotas-route');

const { writeJson: writeJsonConfig } = await import('../lib/config.mjs');
const { writeJson: writeJsonAdmin, handleAdminRoutes } = await import('../lib/routes/admin-routes.mjs');
const { getCachedUpstreamQuotas } = await import('../lib/upstream/sync.mjs');

console.log('=== 开始执行上游凭证配额路由与安全序列化测试 ===\n');

// -------------------------------------------------------------
// 测试 1: writeJson 安全序列化与 Content-Length 契约
// -------------------------------------------------------------
console.log('测试 1: writeJson 安全序列化与 Content-Length 契约');
{
  // 1.1 正常对象序列化
  {
    const headers = {};
    let writtenBuf = null;
    let ended = false;
    const mockRes = {
      headersSent: false,
      writeHead(status, hdrs) {
        this.statusCode = status;
        Object.assign(headers, hdrs);
        this.headersSent = true;
      },
      end(data) {
        writtenBuf = data;
        ended = true;
      }
    };

    const payload = { test: '中文数据测试 ✿', count: 42 };
    writeJsonAdmin(mockRes, 200, payload);

    assert.strictEqual(mockRes.statusCode, 200);
    assert.strictEqual(ended, true);
    assert.ok(headers['Content-Length'], '必须包含 Content-Length 头');
    assert.strictEqual(headers['Content-Length'], writtenBuf.length, 'Content-Length 必须精确匹配 Buffer 字节长度');
    assert.deepStrictEqual(JSON.parse(writtenBuf.toString('utf8')), payload);
  }

  // 1.2 payload 为 undefined 时不得产生空响应
  {
    const headers = {};
    let writtenBuf = null;
    const mockRes = {
      headersSent: false,
      writeHead(status, hdrs) {
        this.statusCode = status;
        Object.assign(headers, hdrs);
        this.headersSent = true;
      },
      end(data) {
        writtenBuf = data;
      }
    };

    writeJsonAdmin(mockRes, 200, undefined);
    assert.strictEqual(mockRes.statusCode, 200);
    assert.ok(writtenBuf.length > 0, 'payload 为 undefined 时不得写入 0 字节体');
    assert.strictEqual(writtenBuf.toString('utf8'), 'null');
    assert.strictEqual(headers['Content-Length'], writtenBuf.length);
  }

  // 1.3 payload 无法被 JSON.stringify 序列化（例如 BigInt）时安全捕获并返回 500
  {
    const headers = {};
    let writtenBuf = null;
    const mockRes = {
      headersSent: false,
      writeHead(status, hdrs) {
        this.statusCode = status;
        Object.assign(headers, hdrs);
        this.headersSent = true;
      },
      end(data) {
        writtenBuf = data;
      }
    };

    const circularObj = { big: 123456789012345678901234567890n };
    writeJsonAdmin(mockRes, 200, circularObj);
    assert.strictEqual(mockRes.statusCode, 500);
    assert.ok(writtenBuf.length > 0);
    assert.strictEqual(headers['Content-Length'], writtenBuf.length);
    const parsed = JSON.parse(writtenBuf.toString('utf8'));
    assert.ok(parsed.error);
  }

  // 1.4 config.mjs 的 writeJson 具备同等安全序列化与 Content-Length
  {
    const headers = {};
    let writtenBuf = null;
    const mockRes = {
      headersSent: false,
      writeHead(status, hdrs) {
        this.statusCode = status;
        Object.assign(headers, hdrs);
        this.headersSent = true;
      },
      end(data) {
        writtenBuf = data;
      }
    };

    writeJsonConfig(mockRes, 200, { key: 'value' });
    assert.strictEqual(mockRes.statusCode, 200);
    assert.ok(headers['Content-Length'] > 0);
    assert.strictEqual(headers['Content-Length'], writtenBuf.length);
  }

  console.log('  ✓ writeJson 正常序列化、undefined 兜底、异常捕获与 Content-Length 验证通过');
}

// -------------------------------------------------------------
// 测试 2: /admin/api/upstream-quotas 路由异步 await 与响应完整性
// -------------------------------------------------------------
console.log('测试 2: /admin/api/upstream-quotas 路由异步 await 与响应完整性');
{
  const adminSecret = 'test-secret-12345678901234567890';

  // 2.1 GET 默认（非刷新）返回 200 且内容完整
  {
    let statusCode = null;
    let headers = {};
    let writtenBody = null;
    const res = {
      headersSent: false,
      writeHead(s, h) {
        statusCode = s;
        Object.assign(headers, h);
        this.headersSent = true;
      },
      end(b) {
        writtenBody = b;
      }
    };
    const req = {
      method: 'GET',
      url: '/admin/api/upstream-quotas',
      headers: {
        authorization: `Bearer ${adminSecret}`
      }
    };

    const handled = await handleAdminRoutes(req, res, '/admin/api/upstream-quotas', adminSecret, 1048576);
    assert.strictEqual(handled, true);
    assert.strictEqual(statusCode, 200);
    assert.ok(headers['Content-Length'] > 0);
    assert.strictEqual(headers['Content-Length'], writtenBody.length);
    const parsed = JSON.parse(writtenBody.toString('utf8'));
    assert.ok(Array.isArray(parsed.accounts));
    assert.strictEqual(typeof parsed.default_priority, 'number');
  }

  // 2.2 GET 带 ?refresh=1 返回 200 且正确 await 完成后下发完整 JSON
  {
    let statusCode = null;
    let headers = {};
    let writtenBody = null;
    const res = {
      headersSent: false,
      writeHead(s, h) {
        statusCode = s;
        Object.assign(headers, h);
        this.headersSent = true;
      },
      end(b) {
        writtenBody = b;
      }
    };
    const req = {
      method: 'GET',
      url: '/admin/api/upstream-quotas?refresh=1',
      headers: {
        authorization: `Bearer ${adminSecret}`
      }
    };

    const handled = await handleAdminRoutes(req, res, '/admin/api/upstream-quotas', adminSecret, 1048576);
    assert.strictEqual(handled, true);
    assert.strictEqual(statusCode, 200);
    assert.ok(headers['Content-Length'] > 0);
    assert.strictEqual(headers['Content-Length'], writtenBody.length);
    const parsed = JSON.parse(writtenBody.toString('utf8'));
    assert.ok(Array.isArray(parsed.accounts));
  }

  // 2.3 POST 触发刷新返回 200 且内容完整
  {
    let statusCode = null;
    let headers = {};
    let writtenBody = null;
    const res = {
      headersSent: false,
      writeHead(s, h) {
        statusCode = s;
        Object.assign(headers, h);
        this.headersSent = true;
      },
      end(b) {
        writtenBody = b;
      }
    };
    const req = {
      method: 'POST',
      url: '/admin/api/upstream-quotas',
      headers: {
        authorization: `Bearer ${adminSecret}`
      }
    };

    const handled = await handleAdminRoutes(req, res, '/admin/api/upstream-quotas', adminSecret, 1048576);
    assert.strictEqual(handled, true);
    assert.strictEqual(statusCode, 200);
    assert.ok(headers['Content-Length'] > 0);
    assert.strictEqual(headers['Content-Length'], writtenBody.length);
    const parsed = JSON.parse(writtenBody.toString('utf8'));
    assert.ok(Array.isArray(parsed.accounts));
  }

  console.log('  ✓ GET、GET?refresh=1 与 POST /admin/api/upstream-quotas 响应与 Content-Length 完整性验证通过');
}

// -------------------------------------------------------------
// 测试 3: 前端 admin-quotas.js 对空响应/异常响应的防御弹性测试
// -------------------------------------------------------------
console.log('测试 3: 前端 admin-quotas.js 对空响应/异常响应的防御弹性测试');
{
  const quotasJsPath = join(process.cwd(), 'admin-quotas.js');
  const quotasJsContent = readFileSync(quotasJsPath, 'utf8');

  // 沙箱环境验证 fetchUpstreamQuotas 的解析逻辑
  // 模拟三种边界情况：1) 正常 JSON；2) 空字符串 ""；3) 畸变格式
  const sandbox = {
    isMemberAuth: () => false,
    isFetchingUpstreamQuotas: false,
    getAdminSecret: () => 'valid-secret',
    cachedUpstream: null,
    upstreamLoaded: false,
    renderUpstreamCards: () => {},
    renderStatusCards: () => {},
    renderOperationsStrip: () => {},
    setUpstreamPlaceholder: () => {},
    t: (k, vars) => `${k}:${JSON.stringify(vars || {})}`,
    escapeHtml: (s) => String(s),
    console: {
      warn: () => {},
      log: () => {},
      error: () => {}
    }
  };

  // 提取 fetchUpstreamQuotas 函数体
  const fnMatch = quotasJsContent.match(/async function fetchUpstreamQuotas\([\s\S]*?^    }/m);
  assert.ok(fnMatch, '必须能从 admin-quotas.js 中提取 fetchUpstreamQuotas');

  const script = new vm.Script(fnMatch[0]);
  const ctx = vm.createContext(sandbox);
  script.runInContext(ctx);

  // 3.1 正常 JSON 响应
  {
    ctx.fetch = async () => ({
      status: 200,
      async text() {
        return JSON.stringify({ accounts: [{ id: 'acc1', provider: 'codex' }] });
      }
    });

    await ctx.fetchUpstreamQuotas(false);
    assert.strictEqual(ctx.upstreamLoaded, true);
    assert.strictEqual(ctx.cachedUpstream.accounts.length, 1);
  }

  // 3.2 空字符串 "" 响应（引发此前 Unexpected end of JSON input 崩溃的根本原因）
  {
    ctx.fetch = async () => ({
      status: 200,
      async text() {
        return '';
      }
    });

    // 必须优雅降级，绝对不可抛出异常导致出现拉取网络异常弹窗
    ctx.cachedUpstream = null;
    ctx.upstreamLoaded = false;
    let threw = false;
    try {
      await ctx.fetchUpstreamQuotas(false);
    } catch (e) {
      threw = true;
    }
    assert.strictEqual(threw, false, '空响应不得抛出未捕获异常');
    assert.strictEqual(ctx.upstreamLoaded, true);
    assert.ok(Array.isArray(ctx.cachedUpstream.accounts));
  }

  // 3.3 包含空白字符的响应
  {
    ctx.fetch = async () => ({
      status: 200,
      async text() {
        return '   \n  ';
      }
    });

    ctx.cachedUpstream = null;
    ctx.upstreamLoaded = false;
    await ctx.fetchUpstreamQuotas(false);
    assert.strictEqual(ctx.upstreamLoaded, true);
    assert.ok(Array.isArray(ctx.cachedUpstream.accounts));
  }

  console.log('  ✓ 前端 fetchUpstreamQuotas 对空响应、空白响应与正常响应的解析弹性验证通过');
}

console.log('\n=== 全部上游凭证配额路由与安全序列化测试通过！===\n');

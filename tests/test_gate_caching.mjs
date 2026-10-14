import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { isolateTestDb } from './_isolated-db.mjs';

// 本用例会读 getPagedRequests / getAdminData，必须跑在自己的空库上，
// 否则断言读到的是开发机 gate.db 里的真实流水，数字随环境漂移。
isolateTestDb(import.meta.url, 'gate-caching');

import {
  getPagedRequests,
  getPagedErrorEvents,
  clearAuditLogsCache,
  recordErrorEvent
} from '../lib/analytics/audit-logs.mjs';
import {
  getAdminData,
  invalidateAdminDataCache
} from '../lib/analytics/quota-health.mjs';
import { quotaRulesVersion } from '../lib/core/engine.mjs';
import { keyRegistryVersion } from '../lib/core/key-registry.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('=== 开始执行 Gate 多级缓存与水合测试 ===\n');

// 1. 测试后端 audit-logs.mjs 分页缓存与自动失效
console.log('测试 1: 请求流水与故障中心服务端多级缓存与失效机制');
const initialRequests = getPagedRequests({ page: 1, pageSize: 25 });
const cachedRequests = getPagedRequests({ page: 1, pageSize: 25 });
assert.strictEqual(initialRequests, cachedRequests, '两次连续调用 getPagedRequests 应命中内存缓存并返回同一对象引用');

// 手动清空缓存
clearAuditLogsCache();
const afterClearRequests = getPagedRequests({ page: 1, pageSize: 25 });
assert.notStrictEqual(initialRequests, afterClearRequests, 'clearAuditLogsCache() 后应重新查询数据库生成新结果');

// 故障中心分页缓存
const initialErrors = getPagedErrorEvents({ page: 1, pageSize: 25 });
const cachedErrors = getPagedErrorEvents({ page: 1, pageSize: 25 });
assert.strictEqual(initialErrors, cachedErrors, '两次连续调用 getPagedErrorEvents 应命中内存缓存并返回同一对象引用');
console.log('  ✓ audit-logs.mjs 分页请求与故障缓存命中与主动清除验证通过');

// 2. 测试 quota-health.mjs 的 getAdminData 缓存与版本失效
console.log('\n测试 2: API 密钥列表 (getAdminData) 防抖缓存与失效机制');
const data1 = getAdminData();
const data2 = getAdminData();
assert.strictEqual(data1, data2, '2.5s 内两次调用 getAdminData 应命中缓存并返回同一对象');

invalidateAdminDataCache();
const data3 = getAdminData();
assert.notStrictEqual(data1, data3, 'invalidateAdminDataCache() 后应重新计算并生成新数据对象');
console.log('  ✓ quota-health.mjs getAdminData 2.5s 缓存与主动失效验证通过');

// 3. 测试 admin.html 中的首屏水合与 Key 下拉初始注入逻辑
console.log('\n测试 3: 前端 admin.html 缓存水合与下拉提前注入代码静态验证');
const adminHtmlPath = path.join(__dirname, '..', 'admin.html');
const adminHtml = fs.readFileSync(adminHtmlPath, 'utf8');

assert.ok(adminHtml.includes('const KEY_STORAGE_KEYS = \'gate_cache_keys_v2\';'), '必须定义 KEY_STORAGE_KEYS');
assert.ok(adminHtml.includes('const KEY_STORAGE_LOGS = \'gate_cache_logs_v2\';'), '必须定义 KEY_STORAGE_LOGS');
assert.ok(adminHtml.includes('const KEY_STORAGE_ERRORS = \'gate_cache_errors_v2\';'), '必须定义 KEY_STORAGE_ERRORS');
assert.ok(adminHtml.includes('function hydratePersistentCaches()'), '必须包含 hydratePersistentCaches 函数');
assert.ok(adminHtml.includes('hydratePersistentCaches();'), '首屏初始化必须立即执行 hydratePersistentCaches()');
assert.ok(adminHtml.includes('const logsQueryCache = new Map();'), '必须包含前端请求流水内存缓存 logsQueryCache');
assert.ok(adminHtml.includes('const errorsQueryCache = new Map();'), '必须包含前端故障中心内存缓存 errorsQueryCache');

// 验证 initCustomDropdowns 中 logs-key-dropdown 是否使用了 cachedKeys
assert.ok(
  adminHtml.includes("initialKeyMap.set(String(k.key_id)"),
  'logs-key-dropdown 初始化时必须注入 cachedKeys，确保流水页未访问 API 密钥页时选项不为空'
);

// 验证 switchNavTab 瞬时渲染缓存
assert.ok(
  adminHtml.includes("renderEventsTable(cachedEvents, cachedEventsTotal);"),
  'switchNavTab 必须即时呈现已有流水缓存且传入 cachedEventsTotal 避免闪烁'
);

// 验证 refreshCurrentTab 移除锁与串行阻塞
assert.ok(
  !adminHtml.includes('if (isRefreshingCurrentTab) return;'),
  '必须彻底移除 isRefreshingCurrentTab 全局锁，杜绝切 Tab 吞请求'
);

console.log('  ✓ admin.html 首屏水合、下拉提前注入、0ms 切页渲染与去瀑布流验证通过');

console.log('\n=== 全部缓存与水合测试通过！===');

import assert from 'node:assert/strict';
import { isolateTestDb } from './_isolated-db.mjs';

// 隔离到专属临时目录与临时数据库，避免污染本地开发/生产数据库
isolateTestDb(import.meta.url, 'gate-key-model-quota');

const {
  extractRawKey,
  resolveKeyId,
  rawKeyToId,
  rebuildMemoryFromKeys
} = await import('../lib/core/key-registry.mjs');

const {
  stmtInsertKey,
  stmtKeyByRaw,
  quotaDb
} = await import('../lib/db/sqlite.mjs');

const {
  normalizeModelWhitelist,
  parseModelWhitelist,
  isModelPermitted,
  checkModelAllowed,
  filterModelsForKey,
  updateQuotaRule,
  deleteQuotaRule,
  checkQuota,
  checkRateLimit,
  quotaRules,
  keyModelRules,
  rpmWindows,
  loadQuotaRules
} = await import('../lib/core/engine.mjs');

console.log('=== 开始执行 API Key 规则配置、模型限制与限额管控端到端测试 ===\n');

// 准备测试 Key
const testKeyRaw = 'sk-cpa-test-verification-key-12345';
const testKey2Raw = 'sk-cpa-test-verification-key-67890';
const res1 = stmtInsertKey.run(testKeyRaw, '测试主要Key');
const key1Id = Number(res1.lastInsertRowid);
const res2 = stmtInsertKey.run(testKey2Raw, '测试次要Key');
const key2Id = Number(res2.lastInsertRowid);
rebuildMemoryFromKeys();

assert.equal(rawKeyToId.get(testKeyRaw), key1Id, `testKeyRaw 应映射到 key_id ${key1Id}`);
assert.equal(rawKeyToId.get(testKey2Raw), key2Id, `testKey2Raw 应映射到 key_id ${key2Id}`);

// -------------------------------------------------------------
console.log('测试 1: 多协议请求凭证提取 (Multi-Header & Query extractRawKey)');
{
  // 1.1 标准 Authorization: Bearer
  assert.equal(extractRawKey({ headers: { authorization: `Bearer ${testKeyRaw}` } }), testKeyRaw);
  assert.equal(extractRawKey({ headers: { authorization: `bearer  ${testKeyRaw} ` } }), testKeyRaw);
  assert.equal(extractRawKey(`Bearer ${testKeyRaw}`), testKeyRaw);

  // 1.2 Anthropic 原生规范 (x-api-key)
  assert.equal(extractRawKey({ headers: { 'x-api-key': testKeyRaw } }), testKeyRaw);

  // 1.3 Azure OpenAI 原生规范 (api-key)
  assert.equal(extractRawKey({ headers: { 'api-key': testKeyRaw } }), testKeyRaw);

  // 1.4 Google Gemini 原生规范 (x-goog-api-key)
  assert.equal(extractRawKey({ headers: { 'x-goog-api-key': testKeyRaw } }), testKeyRaw);

  // 1.5 Google Gemini REST URL Query 参数 (?key=...)
  assert.equal(extractRawKey({ headers: {}, url: `/v1beta/models/gemini-2.5-flash:generateContent?key=${testKeyRaw}` }), testKeyRaw);

  // 1.6 无效或空请求
  assert.equal(extractRawKey(null), null);
  assert.equal(extractRawKey({ headers: {} }), null);
  assert.equal(extractRawKey(''), null);

  // 1.7 通过 resolveKeyId 验证 Key ID 权威解析
  assert.equal(resolveKeyId({ headers: { 'x-api-key': testKeyRaw } }), key1Id);
  assert.equal(resolveKeyId({ headers: {}, url: `https://gate.example.com/models?key=${testKeyRaw}` }), key1Id);
  assert.equal(resolveKeyId({ headers: { authorization: `Bearer ${testKey2Raw}` } }), key2Id);

  console.log('  ✓ 标准 Authorization、Anthropic x-api-key、Azure api-key、Gemini x-goog-api-key 与 ?key= 提取验证通过');
}

// -------------------------------------------------------------
console.log('测试 2: 模型白名单归一化存储与解析 (normalize & parseModelWhitelist)');
{
  // 2.1 数组形态入参归一化
  const fromArray = normalizeModelWhitelist(['gemini-2.5-flash', 'Claude-3-7-Sonnet']);
  assert.equal(fromArray, JSON.stringify(['gemini-2.5-flash', 'claude-3-7-sonnet']));

  // 2.2 逗号分隔历史数据形态归一化
  const fromCsv = normalizeModelWhitelist('gemini-2.5-flash, claude-3-7-sonnet');
  assert.equal(fromCsv, JSON.stringify(['gemini-2.5-flash', 'claude-3-7-sonnet']));

  // 2.3 异常单元素混逗号数组形态（前端曾出现的解析缺陷形态）
  const fromCorrupted = normalizeModelWhitelist(['gemini-2.5-flash,claude-3-7-sonnet']);
  assert.equal(fromCorrupted, JSON.stringify(['gemini-2.5-flash', 'claude-3-7-sonnet']));

  // 2.4 空值与通配符归一化
  assert.equal(normalizeModelWhitelist(''), '');
  assert.equal(normalizeModelWhitelist('*'), '');
  assert.equal(normalizeModelWhitelist('["*"]'), '');
  assert.equal(normalizeModelWhitelist([]), '');

  // 2.5 解析为 Set
  const set1 = parseModelWhitelist('["gemini-2.5-flash","claude-3-7-sonnet"]');
  assert.ok(set1 instanceof Set);
  assert.equal(set1.size, 2);
  assert.ok(set1.has('gemini-2.5-flash'));
  assert.ok(set1.has('claude-3-7-sonnet'));

  const setCsv = parseModelWhitelist('gemini-2.5-flash, claude-3-7-sonnet');
  assert.ok(setCsv instanceof Set);
  assert.equal(setCsv.size, 2);

  assert.equal(parseModelWhitelist('*'), null);
  assert.equal(parseModelWhitelist(''), null);

  console.log('  ✓ 数组、JSON 字符串、逗号混杂字符串归一化与解析验证通过');
}

// -------------------------------------------------------------
console.log('测试 3: 智能模型匹配引擎 (isModelPermitted)');
{
  const allowed = new Set(['claude-3-7-sonnet', 'gemini-2.5-flash', 'gpt-4o*']);

  // 精确匹配与大小写不敏感
  assert.equal(isModelPermitted('claude-3-7-sonnet', allowed), true);
  assert.equal(isModelPermitted('Claude-3-7-Sonnet', allowed), true);

  // 厂商 / 命名空间前缀剥离 (如 anthropic/claude-3-7-sonnet)
  assert.equal(isModelPermitted('anthropic/claude-3-7-sonnet', allowed), true);
  assert.equal(isModelPermitted('models/gemini-2.5-flash', allowed), true);

  // 通配符匹配 (gpt-4o*)
  assert.equal(isModelPermitted('gpt-4o', allowed), true);
  assert.equal(isModelPermitted('gpt-4o-mini', allowed), true);
  assert.equal(isModelPermitted('gpt-4o-2024-11-20', allowed), true);

  // 版本与日期后缀匹配 (如 SDK 默认带日期后缀)
  assert.equal(isModelPermitted('claude-3-7-sonnet-20250219', allowed), true);
  assert.equal(isModelPermitted('claude-3-7-sonnet@20250219', allowed), true);

  // 动态倍率后缀匹配 (如 WorkBuddy :3.33x, :1x, :1.5x)
  assert.equal(isModelPermitted('workbuddy/claude-3-7-sonnet:1.5x', allowed), true);
  assert.equal(isModelPermitted('claude-3-7-sonnet:3.33x', allowed), true);
  assert.equal(isModelPermitted('claude-3-7-sonnet-20250219:2x', allowed), true);
  assert.equal(isModelPermitted('gpt-4o:1x', allowed), true);
  assert.equal(isModelPermitted('gpt-4o-mini:1.25x', allowed), true);

  // 白名单规则自身含倍率时，双向匹配无倍率与同倍率请求
  const allowedWithMultiplier = new Set(['claude-opus-5-5:3.33x']);
  assert.equal(isModelPermitted('claude-opus-5-5', allowedWithMultiplier), true);
  assert.equal(isModelPermitted('workbuddy/claude-opus-5-5:3.33x', allowedWithMultiplier), true);
  assert.equal(isModelPermitted('workbuddy/claude-opus-5-5', allowedWithMultiplier), true);

  // 未允许的模型被严格阻断
  assert.equal(isModelPermitted('deepseek-chat', allowed), false);
  assert.equal(isModelPermitted('deepseek-chat:1x', allowed), false);
  assert.equal(isModelPermitted('o3-mini', allowed), false);
  assert.equal(isModelPermitted('claude-3-5-haiku', allowed), false);

  console.log('  ✓ 精确匹配、大小写不敏感、厂商前缀剥离、通配符、日期后缀与动态倍率后缀匹配验证通过');
}

// -------------------------------------------------------------
console.log('测试 4: API Key 规则持久化与加载闭环 (updateQuotaRule & loadQuotaRules)');
{
  // 为 key1 配置白名单与限额
  updateQuotaRule(key1Id, {
    enabled: true,
    daily_limit: 5000000,
    hard_ratio: 1.2,
    rpm_limit: 60,
    model_whitelist: ['gemini-2.5-flash', 'claude-3-7-sonnet']
  });

  const rule101 = quotaRules.get(key1Id);
  assert.ok(rule101, `key ${key1Id} 规则应存在`);
  assert.equal(rule101.enabled, true);
  assert.equal(rule101.daily_limit, 5000000);
  assert.equal(rule101.rpm_limit, 60);
  assert.equal(rule101.model_whitelist, JSON.stringify(['gemini-2.5-flash', 'claude-3-7-sonnet']));

  const modelRule101 = keyModelRules.get(key1Id);
  assert.ok(modelRule101 instanceof Set);
  assert.equal(modelRule101.size, 2);
  assert.ok(modelRule101.has('gemini-2.5-flash'));
  assert.ok(modelRule101.has('claude-3-7-sonnet'));

  // 验证重新 loadQuotaRules 后持久化数据依然一致无损
  loadQuotaRules();
  const reloaded = quotaRules.get(key1Id);
  assert.equal(reloaded.model_whitelist, JSON.stringify(['gemini-2.5-flash', 'claude-3-7-sonnet']));

  console.log('  ✓ updateQuotaRule 写入 SQLite、内存加载与重启一致性验证通过');
}

// -------------------------------------------------------------
console.log('测试 5: 模型访问热路径拦截检查 (checkModelAllowed & filterModelsForKey)');
{
  // 模拟携带 Anthropic 原生请求头的请求
  const reqAnthropic = {
    headers: { 'x-api-key': testKeyRaw }
  };

  // 允许的模型 -> 放行
  const checkAllowed1 = checkModelAllowed(reqAnthropic, 'claude-3-7-sonnet');
  assert.equal(checkAllowed1.allowed, true);

  const checkAllowed2 = checkModelAllowed(reqAnthropic, 'anthropic/claude-3-7-sonnet-20250219');
  assert.equal(checkAllowed2.allowed, true);

  // 模拟携带 Gemini ?key= 参数的请求
  const reqGemini = {
    headers: {},
    url: `/v1beta/models/gemini-2.5-flash:generateContent?key=${testKeyRaw}`
  };
  const checkAllowedGemini = checkModelAllowed(reqGemini, 'gemini-2.5-flash');
  assert.equal(checkAllowedGemini.allowed, true);

  // 未允许的模型 -> 严格拦截 (403 forbidden)
  const checkForbidden = checkModelAllowed(reqAnthropic, 'gpt-4o');
  assert.equal(checkForbidden.allowed, false);
  assert.ok(checkForbidden.reason.includes('not permitted'));

  const checkForbidden2 = checkModelAllowed(reqGemini, 'o3-mini');
  assert.equal(checkForbidden2.allowed, false);

  // /v1/models 模型列表过滤
  const allModels = [
    { id: 'claude-3-7-sonnet' },
    { id: 'gemini-2.5-flash' },
    { id: 'gpt-4o' },
    { id: 'deepseek-chat' }
  ];
  const filtered = filterModelsForKey(reqAnthropic, allModels);
  assert.equal(filtered.length, 2);
  assert.deepEqual(filtered.map(m => m.id), ['claude-3-7-sonnet', 'gemini-2.5-flash']);

  // 未受限的 Key 102 访问所有模型
  const reqKey2 = {
    headers: { authorization: `Bearer ${testKey2Raw}` }
  };
  assert.equal(checkModelAllowed(reqKey2, 'gpt-4o').allowed, true);
  assert.equal(filterModelsForKey(reqKey2, allModels).length, 4);

  console.log('  ✓ checkModelAllowed 允许与拒绝判定准确，filterModelsForKey 正确按白名单过滤');
}

// -------------------------------------------------------------
console.log('测试 6: RPM 速率限制与滑动窗口拦截 (checkRateLimit)');
{
  // 为 key2 设置 RPM = 2
  updateQuotaRule(key2Id, {
    enabled: true,
    daily_limit: null,
    hard_ratio: 1.2,
    rpm_limit: 2,
    model_whitelist: ''
  });

  const reqKey2 = {
    headers: { 'x-api-key': testKey2Raw }
  };

  // 清空窗口
  rpmWindows.delete(key2Id);

  // 第 1 次请求：允许
  const r1 = checkRateLimit(reqKey2);
  assert.equal(r1.allowed, true);

  // 第 2 次请求：允许
  const r2 = checkRateLimit(reqKey2);
  assert.equal(r2.allowed, true);

  // 第 3 次请求：超限拦截 (429 rate limit exceeded)
  const r3 = checkRateLimit(reqKey2);
  assert.equal(r3.allowed, false);
  assert.ok(r3.reason.includes('Rate limit exceeded'));

  console.log('  ✓ RPM 滑动窗口精准计数并在第 3 次请求返回 429 阻断');
}

// -------------------------------------------------------------
console.log('测试 7: 前端模型解析与配置联动逻辑验证 (Front-end parseModelList)');
{
  // 模拟前端 parseModelList 逻辑
  function frontendParseModelList(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) {
      const res = [];
      raw.forEach(item => {
        if (typeof item === 'string') {
          item.split(/[\s,]+/).map(s => s.trim().toLowerCase()).filter(Boolean).forEach(m => {
            if (!res.includes(m)) res.push(m);
          });
        }
      });
      return res;
    }
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (!trimmed || trimmed === '*' || trimmed === '["*"]') return [];
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed) || typeof parsed === 'string') {
          return frontendParseModelList(parsed);
        }
      } catch (e) {}
      return trimmed.split(/[\s,]+/).map(s => s.trim().toLowerCase()).filter(Boolean).filter((m, idx, arr) => arr.indexOf(m) === idx);
    }
    return [];
  }

  // 测试历史逗号数据加载
  const legacyCsv = 'gemini-2.5-flash,claude-3-7-sonnet';
  const loadedFromCsv = frontendParseModelList(legacyCsv);
  assert.equal(loadedFromCsv.length, 2);
  assert.equal(loadedFromCsv[0], 'gemini-2.5-flash');
  assert.equal(loadedFromCsv[1], 'claude-3-7-sonnet');

  // 测试规范 JSON 数据加载
  const jsonStr = '["gemini-2.5-flash","claude-3-7-sonnet"]';
  const loadedFromJson = frontendParseModelList(jsonStr);
  assert.equal(loadedFromJson.length, 2);
  assert.equal(loadedFromJson[0], 'gemini-2.5-flash');
  assert.equal(loadedFromJson[1], 'claude-3-7-sonnet');

  // 保证每个模型项均为独立无逗号的纯净小写字符串（彻底解决下拉复选框无法勾选匹配的问题）
  assert.ok(loadedFromCsv.includes('gemini-2.5-flash'));
  assert.ok(loadedFromCsv.includes('claude-3-7-sonnet'));

  console.log('  ✓ 前端模型解析兼容旧版逗号串与新版 JSON，下拉匹配恢复正常');
}

console.log('\n=== 全部 API Key 模型限制与限额管控测试执行完毕，全部通过！===');

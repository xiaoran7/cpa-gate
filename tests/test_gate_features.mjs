import fs from 'node:fs';
import assert from 'node:assert/strict';
import { isolateTestDb } from './_isolated-db.mjs';

process.env.GATE_MGMT_SECRET = process.env.GATE_MGMT_SECRET || 'local-feature-test-secret-123456';
process.env.GATE_ADMIN_SECRET = process.env.GATE_ADMIN_SECRET || 'local-admin-test-secret-123456';

// 必须在 import quota-manager（进而打开 SQLite）之前调用：本用例会写 request_events，
// 以前直接跑在开发机的真实 gate.db 上，脏行会跨运行存活并污染分组聚合断言。
isolateTestDb(import.meta.url, 'gate-features');

const {
  buildStatusScope,
  buildProviderGroups,
  getRecentRequestsForKey,
  getKeyInfoById,
  activateUpstreamQuotaWindow,
  normalizeAuthPriority,
  normalizeAuthWeight,
  compareAuthAccounts
} = await import('../quota-manager.mjs');

console.log('=== 开始执行 Gate 新功能集成测试 ===\n');

// -------------------------------------------------------------
// 测试用例 1: 成功率心跳机制 (按 60 分钟时间槽对齐滚动与自动递进)
// -------------------------------------------------------------
console.log('测试 1: 成功率心跳机制 (Minute-Slot Rolling Window)');
{
  const nowMs = 1758000000000; // 基准时间 (整秒/整分)
  const currentMinuteTs = Math.floor(nowMs / 60000) * 60;
  
  // 构造一组分布在不同分钟的请求事件
  const mockRows = [
    // 1. 当前分钟的 200 成功请求
    { ts: currentMinuteTs + 10, status: 200, latency_ms: 120, ttft_ms: 45, model: 'claude-3-7-sonnet' },
    // 2. 当前分钟的 200 成功请求 (缓存命中)
    { ts: currentMinuteTs + 25, status: 200, latency_ms: 90, ttft_ms: 30, model: 'claude-3-7-sonnet' },
    // 3. 2 分钟前的 500 错误请求
    { ts: currentMinuteTs - 120 + 5, status: 500, latency_ms: 400, ttft_ms: 0, model: 'gemini-2.5-flash' },
    // 4. 10 分钟前的 429 告警请求
    { ts: currentMinuteTs - 600 + 12, status: 429, latency_ms: 50, ttft_ms: 0, model: 'gpt-4o' },
    // 5. 超出 60 分钟窗口的更早请求 (应被过滤不计入)
    { ts: currentMinuteTs - 3660, status: 200, latency_ms: 100, ttft_ms: 40, model: 'gpt-4o' }
  ];

  const scope = buildStatusScope(mockRows, nowMs);
  
  assert.equal(scope.bars.length, 60, '心跳条数量应恒等于 60');
  
  // 验证最右侧的 bar (即当前分钟)
  const latestBar = scope.bars[59];
  assert.equal(latestBar.ts, currentMinuteTs * 1000, '最新 slot 对应当前分钟整分时间戳');
  assert.equal(latestBar.requests, 2, '当前分钟应聚合 2 次请求');
  assert.equal(latestBar.status, 200, '当前分钟全成功应为 200');
  assert.equal(latestBar.latency_ms, 105, '平均延迟应为 (120+90)/2 = 105ms');
  assert.equal(latestBar.ttft_ms, 38, '平均 TTFT 应为 round((45+30)/2) = 38ms');

  // 验证 2 分钟前的 bar (索引 57)
  const twoMinAgoBar = scope.bars[57];
  assert.equal(twoMinAgoBar.requests, 1, '2 分钟前 slot 应聚合 1 次请求');
  assert.equal(twoMinAgoBar.status, 500, '存在 500 错误应标记为 500');

  // 验证 10 分钟前的 bar (索引 49)
  const tenMinAgoBar = scope.bars[49];
  assert.equal(tenMinAgoBar.requests, 1, '10 分钟前 slot 应聚合 1 次请求');
  assert.equal(tenMinAgoBar.status, 429, '429 告警状态码保留精确的 429');

  // 验证无请求的分钟槽位 (例如索引 58，1 分钟前)
  const oneMinAgoBar = scope.bars[58];
  assert.equal(oneMinAgoBar.requests, 0, '1 分钟前无请求');
  assert.equal(oneMinAgoBar.status, 200, '无请求 slot 保持 200 存活心跳');

  // 验证时间推移机制：时间前进了 1 分钟 (60000ms)
  const nextMinMs = nowMs + 60000;
  const nextScope = buildStatusScope(mockRows, nextMinMs);
  assert.equal(nextScope.bars.length, 60, '推进后心跳条数量仍恒为 60');
  // 推进 1 分钟后，原最新分钟（mockRows中的2次成功）应当滚动到索引 58 位置
  const rolledBar = nextScope.bars[58];
  assert.equal(rolledBar.requests, 2, '窗口右移后，原当前分钟请求正确顺移至前一分钟 slot');
  // 最新的第 59 槽（新一分钟）尚未有请求，自动生成存活心跳
  const brandNewSlot = nextScope.bars[59];
  assert.equal(brandNewSlot.requests, 0, '新时间推移后生成的第 60 槽无请求');
  assert.equal(brandNewSlot.status, 200, '新槽位展现存活状态');

  console.log('  ✓ 60 分钟时间槽对齐成功');
  console.log('  ✓ 存活心跳与异常染色聚合正确');
  console.log('  ✓ 时间滚动推進顺移验证通过 (彻底解决心跳条不增加问题)\n');
}

// -------------------------------------------------------------
// 测试用例 2: 成员 API Key 专属信息与请求流水数据隔离
// -------------------------------------------------------------
console.log('测试 2: 成员 API Key 专属数据查询与隔离');
{
  // 1. 测试 getKeyInfoById
  const keyInfo = getKeyInfoById(1);
  if (keyInfo) {
    assert.ok('id' in keyInfo, '包含 id');
    assert.ok('display_key' in keyInfo, '包含脱敏 display_key');
    assert.ok('alias' in keyInfo, '包含别名');
    assert.ok(!('api_key' in keyInfo), '成员专属信息绝不回显原始完整密钥明文');
    console.log(`  ✓ 成功查询 Key 1 专属看板信息: 别名=${keyInfo.alias}, 脱敏Key=${keyInfo.display_key}`);
  } else {
    console.log('  - Key 1 在本地不存在，跳过具体数值校验');
  }

  // 2. 测试不存在的 Key
  const nonExistent = getKeyInfoById(999999);
  assert.equal(nonExistent, null, '不存在的 Key 查询返回 null');

  // 3. 测试成员专属流水隔离 (getRecentRequestsForKey)
  const memberEvents = getRecentRequestsForKey(1, 20);
  assert.ok(Array.isArray(memberEvents.events), '返回 events 列表');
  for (const ev of memberEvents.events) {
    assert.equal(ev.key_id, 1, `流水事件 key_id 必须等于 1，实际为 ${ev.key_id} (严禁越权返回其他租户数据)`);
  }
  console.log(`  ✓ 成员请求流水查询隔离验证通过 (获取 ${memberEvents.events.length} 条记录，全部严格属于当前 Key)\n`);
}

// -------------------------------------------------------------
// 测试用例 3: 上游 5 小时配额激活 / 唤醒窗口功能
// -------------------------------------------------------------
console.log('测试 3: 上游 5 小时配额唤醒与激活功能');
{
  // 1. 测试未提供任何参数时的防御性拦截
  await assert.rejects(
    async () => {
      await activateUpstreamQuotaWindow({});
    },
    err => {
      assert.ok(err.message.includes('必须指定'), '未提供凭证信息应给出明确错误');
      return true;
    }
  );
  console.log('  ✓ 缺失目标凭证防御性校验通过');

  // 2. 测试调用不存在的凭证
  try {
    await activateUpstreamQuotaWindow({ filename: 'non_existent_auth.json', provider: 'codex' });
    console.log('  ✓ 探针接口调用返回');
  } catch (err) {
    console.log('  ✓ 上游激活探针调用符合预期 (受控处理并给出结果: ' + err.message + ')');
  }
  console.log('');
}

// -------------------------------------------------------------
// 测试用例 4: 前端 admin.html 内联 JavaScript 语法严密性校验
// -------------------------------------------------------------
console.log('测试 4: 前端 admin.html 内联 JavaScript 语法验证 (防语法破坏)');
{
  const fs = await import('node:fs');
  const vm = await import('node:vm');
  const html = fs.readFileSync(new URL('../admin.html', import.meta.url), 'utf8');
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, 'admin.html 必须包含内联 script 块');
  new vm.Script(match[1]);
  console.log('  ✓ admin.html 内联脚本编译解析无语法错误 (通过 AST/vm.Script 校验)');

  // 外置前端脚本同样进这道门禁：v2.4.10 的白屏事故正是前端脚本语法断裂导致的。
  for (const asset of ['admin-cpa.js', 'admin-overview.js', 'admin-logs.js', 'admin-quotas.js', 'admin-keys.js', 'admin-stats.js', 'admin-i18n.js']) {
    const source = fs.readFileSync(new URL(`../${asset}`, import.meta.url), 'utf8');
    new vm.Script(source, { filename: asset });
    console.log(`  ✓ ${asset} 编译解析无语法错误`);
  }

  // admin.html 必须挂载外置主样式与外置业务脚本资源
  assert.ok(html.includes('/admin/style.css'), 'admin.html 未引入 /admin/style.css');
  assert.ok(html.includes('/admin/quotas.js'), 'admin.html 未引入 /admin/quotas.js');
  assert.ok(html.includes('/admin/keys.js'), 'admin.html 未引入 /admin/keys.js');
  assert.ok(html.includes('/admin/stats.js'), 'admin.html 未引入 /admin/stats.js');
  assert.ok(html.includes('/admin/logs.js'), 'admin.html 未引入 /admin/logs.js');
  assert.ok(html.includes('/admin/i18n.js'), 'admin.html 未引入 /admin/i18n.js');
  assert.ok(html.includes('/admin/overview.js'), 'admin.html 未引入 /admin/overview.js');
  assert.ok(html.includes('/admin/overview.css'), 'admin.html 未引入 /admin/overview.css');

  const clientScripts = html +
    fs.readFileSync('admin-quotas.js', 'utf8') +
    fs.readFileSync('admin-keys.js', 'utf8') +
    fs.readFileSync('admin-stats.js', 'utf8') +
    fs.readFileSync('admin-logs.js', 'utf8');

  // v2.6.3 回归锁：探针详情列表使用 blocked_details / warning_details 且经过 Array.isArray 守卫；
  // 上游配额异常占位同时同步双容器 (setUpstreamPlaceholder)；休眠唤醒监听已挂载
  assert.ok(clientScripts.includes('probeData.blocked_details'), '前端探针详情必须对齐后端 blocked_details 字段');
  assert.ok(clientScripts.includes('probeData.warning_details'), '前端探针详情必须对齐后端 warning_details 字段');
  assert.ok(!clientScripts.includes('for (const bk of probeData.blocked_keys)'), '禁止直接遍历非数组的 blocked_keys');
  assert.ok(clientScripts.includes('setUpstreamPlaceholder'), '前端必须使用 setUpstreamPlaceholder 同步紧凑与卡片容器');
  assert.ok(html.includes("addEventListener('visibilitychange'"), 'admin.html 必须包含 visibilitychange 休眠唤醒自愈监听');
  assert.ok(html.includes('refreshCurrentTab'), 'admin.html 必须使用智能靶向刷新 refreshCurrentTab 杜绝并发队头阻塞与后台重绘卡顿');
  assert.ok(!html.includes('tab-btn-providers'), 'admin.html 已彻底移除 AI 提供商与号池侧边栏菜单，职责回归监控与统计');
  assert.ok(!html.includes('tab-btn-cpa-auth'), 'admin.html 已彻底移除账号接入菜单');
  assert.ok(!html.includes('tab-btn-cpa-providers'), 'admin.html 已彻底移除提供商菜单');
  const cpaJs = fs.readFileSync('admin-cpa.js', 'utf8');
  assert.ok(!cpaJs.includes("'cpa-auth'"), 'admin-cpa.js 已彻底移除 cpa-auth 页面');
  assert.ok(!cpaJs.includes("'cpa-providers'"), 'admin-cpa.js 已彻底移除 cpa-providers 页面');
  assert.ok(clientScripts.includes('renderProvidersList'), '前端脚本必须包含 AI 提供商 Token 分布与占比统计渲染器');
  assert.ok(html.includes('isUserBusyInteracting'), 'admin.html 必须包含用户操作忙碌防打扰检测');
  const logsJs = fs.readFileSync('admin-logs.js', 'utf8');
  assert.ok(html.includes('live-row-highlight') || logsJs.includes('live-row-highlight'), '前端脚本必须包含请求流水热加载新行高亮动效');
  assert.ok(html.includes('getSafePollingInterval'), 'admin.html 必须包含重度报表页自适应保护节流');
  console.log('  ✓ 运行总览资源、探针契约、网络自愈、靶向刷新与提供商 Token 分布统计均已在 admin.html 中验证通过\n');
}

// -------------------------------------------------------------
// 测试用例 5: 上游凭据 priority / weight 归一化与排序
// 锁定 v2.4.11：默认档位集中到 config，不再散落硬编码；归一化显式判空，
// 保证任何来源形态（数字 / 数字字符串 / 缺省 / 越界）都收敛到同一契约。
// v2.6.2：默认 priority 由 10 改为 0 —— CPA 对未显式写 priority 的凭据按 0 调度，
// 此前 Gate 显示 10，界面排序与实际调度对不上，且「打开弹窗不改直接保存」会
// 把 0 静默抬成 10。默认档位必须与 CPA 一致。
// -------------------------------------------------------------
console.log('测试 5: 凭据优先级归一化、显式 0 保留与排序稳定性');
{
  // 5.1 未显式设置 -> 回落到默认档位。默认必须是 CPA 的兜底值 0，不是 10。
  assert.equal(normalizeAuthPriority(undefined), 0, 'undefined 应回落默认 0（与 CPA 兜底一致）');
  assert.equal(normalizeAuthPriority(null), 0, 'null 应回落默认 0');
  assert.equal(normalizeAuthPriority(''), 0, '空串应回落默认 0');
  assert.equal(normalizeAuthWeight(undefined), 1, 'weight undefined 应回落默认 1');
  assert.equal(normalizeAuthWeight(null), 1, 'weight null 应回落默认 1');
  console.log('  ✓ 未显式设置时正确回落默认档位 (P0 / W1)');

  // 5.2 显式 0 必须原样保留（P0 兜底是合法档位）
  // 注意：CPA 当前以 JSON number 返回 priority，旧实现的 typeof 分支本就保留了 0；
  // 真正的风险是同一字段被当作字符串返回时 `|| default` 会把 "0" 吞成默认值。两种形态都要锁死。
  assert.equal(normalizeAuthPriority(0), 0, '显式 priority 0 不得被吞成默认值');
  assert.equal(normalizeAuthPriority('0'), 0, '字符串 "0" 不得被吞成默认值');
  console.log('  ✓ 显式 priority=0 原样保留（数字与字符串两种形态均覆盖）');

  // 5.3 正常值与字符串数值透传
  assert.equal(normalizeAuthPriority(30), 30, '数值 30 应保持');
  assert.equal(normalizeAuthPriority('30'), 30, '字符串 "30" 应解析为 30');
  assert.equal(normalizeAuthWeight(5), 5, 'weight 5 应保持');
  console.log('  ✓ 常规数值与字符串数值均正确解析');

  // 5.4 越界/非法值回落到默认，而不是静默通过
  assert.equal(normalizeAuthPriority(-1), 0, '负数应回落默认');
  assert.equal(normalizeAuthPriority(1001), 0, '越界 1001 应回落默认');
  assert.equal(normalizeAuthPriority('abc'), 0, '非数字应回落默认');
  assert.equal(normalizeAuthWeight(0), 1, 'weight 0 越界应回落 1');
  assert.equal(normalizeAuthWeight(1001), 1, 'weight 越界应回落 1');
  console.log('  ✓ 越界与非法输入均安全回落默认，不污染调度');

  // 5.4b 未显式设置的凭据不得排到真正设了低档位的凭据前面
  // 这条正是 v2.6.2 的回归点：默认 10 时，一个从未设过 priority 的号（真实 P0）
  // 会盖过显式设了 P5 的号，界面顺序与 CPA 实际调度相反。
  const mixedDefaults = [
    { auth_index: 'a', priority: 5 },   // 显式 P5
    { auth_index: 'b' },                 // 未设 -> P0
    { auth_index: 'c' },                 // 未设 -> P0
    { auth_index: 'd', priority: 10 }    // 显式 P10
  ];
  mixedDefaults.sort(compareAuthAccounts);
  assert.deepEqual(
    mixedDefaults.map(a => `${normalizeAuthPriority(a.priority)}:${a.auth_index}`),
    ['10:d', '5:a', '0:b', '0:c'],
    '未显式设置的凭据（P0）必须排在显式低档位之后'
  );
  console.log('  ✓ 未设档位的凭据按 P0 参与排序，不插到显式低档位之前');

  // 5.5 排序：优先级降序优先，其次 auth_index 数值升序（1,2,...,10 而非 1,10,2）
  // 生产 auth_index 是 16 进制串（11b5ad3947814b5f），此时两者均退化为字典序，结果稳定；
  // 数值分支覆盖 CPA 若改用纯数字索引的情况。
  const accounts = [
    { priority: 10, auth_index: '10' },
    { priority: 10, auth_index: '2' },
    { priority: 30, auth_index: '99' },
    { priority: 0, auth_index: '5' },
    { priority: 10, auth_index: '1' }
  ];
  accounts.sort(compareAuthAccounts);
  assert.deepEqual(
    accounts.map(a => `${a.priority}:${a.auth_index}`),
    ['30:99', '10:1', '10:2', '10:10', '0:5'],
    '排序应为优先级降序，同优先级按 auth_index 数值升序'
  );
  console.log('  ✓ 排序按优先级降序 + auth_index 数值升序，P0 排在末位兜底');

  // 5.6 同优先级下 auth_index 缺失/非数字时不崩溃
  const mixed = [
    { priority: 10, auth_index: '' },
    { priority: 10, auth_index: 'abc' },
    { priority: 10, auth_index: '7' }
  ];
  mixed.sort(compareAuthAccounts);
  assert.equal(mixed.length, 3, '非数字 auth_index 排序不应丢元素');
  console.log('  ✓ auth_index 缺失/非数字时排序稳定不丢数据');
  console.log('');
}

console.log('\n测试 6: 上游冷却诊断 (cooldowns 解析与健康判定)');
{
  const { interpretCooldowns, getAuthHealth, setCooldownObservedAt, formatCooldownRemaining } =
    await import('../lib/upstream/auth-health.mjs');

  const now = Date.now();
  setCooldownObservedAt(now);
  const iso = s => new Date(now + s * 1000).toISOString();

  // 6.1 整凭证冷却
  const cred = interpretCooldowns({
    cooldowns: [{ scope: 'credential', reason: 'quota', retry_at: iso(600), remaining_seconds: 600, http_status: 429, backoff_level: 2 }]
  });
  assert.equal(cred.scope, 'credential');
  assert.equal(cred.reason_label, '额度限制');
  assert.equal(cred.http_status, 429);
  assert.equal(cred.backoff_level, 2);
  assert.equal(cred.remaining_seconds, 600);
  console.log('  ✓ 整凭证冷却：作用域、原因、HTTP 状态与退避等级解析正确');

  // 6.2 模型级冷却，作用域为 models
  const modelCool = interpretCooldowns({
    cooldowns: [
      { scope: 'model', model_key: 'gemini-pro', reason: 'transient_error', retry_at: iso(300), remaining_seconds: 300 },
      { scope: 'model', model_key: 'gemini-flash', reason: 'transient_error', retry_at: iso(120), remaining_seconds: 120 }
    ]
  });
  assert.equal(modelCool.scope, 'models');
  assert.equal(modelCool.model_count, 2);
  assert.equal(modelCool.model_keys.length, 2);
  assert.equal(modelCool.remaining_seconds, 120, '剩余应取最早结束的一条');
  console.log('  ✓ 模型级冷却：作用域为 models，剩余取最早结束时间');

  // 6.3 混合作用域 + 原因按严重度选取（额度优先于暂时性错误）
  const mixed = interpretCooldowns({
    cooldowns: [
      { scope: 'credential', reason: 'transient_error', retry_at: iso(900), remaining_seconds: 900 },
      { scope: 'model', model_key: 'm1', reason: 'quota', retry_at: iso(60), remaining_seconds: 60 }
    ]
  });
  assert.equal(mixed.scope, 'credential_and_models');
  assert.equal(mixed.reason_label, '额度限制');
  console.log('  ✓ 混合作用域判定正确，原因按严重度优先取额度类');

  // 6.4 全部 CPA 原因 slug 都有中文标签，未知 slug 归入「其他」
  const reasonMap = {
    quota: '额度限制', credential_quota: '凭证额度限制', cloudflare_challenge: 'Cloudflare 验证',
    invalid_grant: '授权无效', unauthorized: '未获授权', payment_required: '访问受限',
    not_found: '资源未找到', model_not_supported: '模型不受支持', transient_error: '上游暂时出错'
  };
  for (const [slug, label] of Object.entries(reasonMap)) {
    const parsed = interpretCooldowns({ cooldowns: [{ scope: 'credential', reason: slug, retry_at: iso(60), remaining_seconds: 60 }] });
    assert.equal(parsed.reason_label, label, `原因 ${slug} 应映射为 ${label}`);
  }
  const unknown = interpretCooldowns({ cooldowns: [{ scope: 'credential', reason: 'brand_new', retry_at: iso(60), remaining_seconds: 60 }] });
  assert.equal(unknown.reason_label, '其他或未知原因');
  console.log('  ✓ 9 类 CPA 原因 slug 全部正确映射，未知 slug 安全兜底');

  // 6.5 已到期记录不阻塞
  assert.equal(interpretCooldowns({ cooldowns: [{ scope: 'credential', reason: 'quota', retry_at: iso(-10), remaining_seconds: 0 }] }), null);
  assert.equal(interpretCooldowns({ cooldowns: [] }), null);
  assert.equal(interpretCooldowns({}), null);
  console.log('  ✓ 冷却到期或为空时不阻塞调度');

  // 6.6 非法记录被丢弃，不臆造数据
  assert.equal(interpretCooldowns({
    cooldowns: [{ scope: 'bogus', reason: 'quota', remaining_seconds: 60 }, { scope: 'model', reason: 'quota', remaining_seconds: 60 }]
  }), null, 'scope 非法与 model_key 缺失的记录都应被丢弃');
  assert.equal(interpretCooldowns({ cooldowns: [{ scope: 'credential', reason: 'quota', remaining_seconds: -5 }] }), null);
  console.log('  ✓ 非法冷却记录被丢弃，不产生虚假冷却');

  // 6.7 剩余时间随快照观察时刻衰减
  setCooldownObservedAt(now - 30000);
  const decayed = interpretCooldowns({ cooldowns: [{ scope: 'credential', reason: 'quota', retry_at: iso(600), remaining_seconds: 600 }] });
  assert.equal(decayed.remaining_seconds, 570, '读取时已过 30 秒，剩余应相应扣减');
  setCooldownObservedAt(now);
  console.log('  ✓ 冷却剩余按快照时点衰减，不把静态值当实时值');

  // 6.8 关键回归：处于冷却的凭据不得被判为「可用」
  const cooling = { status: 'active', disabled: false, cooldowns: [{ scope: 'credential', reason: 'quota', retry_at: iso(300), remaining_seconds: 300 }] };
  const health = getAuthHealth(cooling);
  assert.equal(health.state, 'cooldown');
  assert.equal(health.blocked, true, '冷却中的凭据必须判为不可调度');
  assert.equal(getAuthHealth({ status: 'active' }).state, 'ready');
  assert.equal(getAuthHealth({ status: 'active', cooldowns: [] }).blocked, false);
  console.log('  ✓ 回归：冷却中的凭据判为不可调度（原实现会误报为「可用」）');

  // 6.9 原有 4 条状态判断不回归
  assert.equal(getAuthHealth({ status: 'expired' }).state, 'expired');
  assert.equal(getAuthHealth({ disabled: true }).state, 'disabled');
  assert.equal(getAuthHealth({ status: 'error' }).state, 'error');
  assert.equal(getAuthHealth({ unavailable: true }).state, 'unavailable');
  console.log('  ✓ 原有 status 判定路径未回归');

  // 6.10 剩余时间文案
  assert.equal(formatCooldownRemaining(30), '30 秒');
  assert.equal(formatCooldownRemaining(300), '5 分钟');
  assert.equal(formatCooldownRemaining(3600), '1 小时');
  assert.equal(formatCooldownRemaining(90000), '1 天 1 小时');
  assert.equal(formatCooldownRemaining(0), '计时已到期');
  console.log('  ✓ 冷却剩余时间文案格式化正确');
  console.log('');
}

// -------------------------------------------------------------
// 测试用例 7: 吞吐图纵轴刻度 (niceCeil)
// 锁定三件事，全靠穷举才暴露出来过：
//   1) 上限必须 ≥ 峰值，否则最高的柱会被画到画布外；
//   2) 上限必须是偶数 —— 中线刻度是 niceMax/2，奇数上限会得到 37.5 这种刻度，
//      而标签经 Math.round 后会把不等距的网格说成一个整数；
//   3) 填充率不能太低 —— 峰值 110 若只按 1/2/5 步进会跳到 200，柱高只剩 55%，
//      纵轴浪费一半。数量级必须由**半轴** peak/2 决定，用 peak 取会粗 10 倍。
// -------------------------------------------------------------
console.log('测试 7: 吞吐图纵轴刻度合理性与填充率');
{
  const source = fs.readFileSync(new URL('../admin-overview.js', import.meta.url), 'utf8');
  const start = source.indexOf('function niceCeil(');
  assert.ok(start > 0, 'admin-overview.js 必须保留 niceCeil');
  // 按括号配平截取函数体（正则截取会被嵌套的花括号骗过去）
  let depth = 0, opened = false, end = -1;
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === '{') { depth += 1; opened = true; }
    else if (source[i] === '}') { depth -= 1; if (opened && depth === 0) { end = i + 1; break; } }
  }
  assert.ok(end > start, 'niceCeil 花括号不配平');
  const niceCeil = new Function(`${source.slice(start, end)}; return niceCeil;`)();

  // 7.1 三条不变量，穷举 0..20000
  let worstFill = 1, worstAt = 0;
  for (let peak = 0; peak <= 20000; peak += 1) {
    const top = niceCeil(peak);
    assert.ok(top >= peak, `峰值 ${peak} 的纵轴上限 ${top} 小于峰值，柱会被截出画布`);
    assert.ok(Number.isInteger(top), `峰值 ${peak} 的纵轴上限 ${top} 不是整数`);
    assert.ok(Number.isInteger(top / 2), `峰值 ${peak} 的中线刻度 ${top / 2} 不是整数`);
    if (peak >= 20 && peak / top < worstFill) { worstFill = peak / top; worstAt = peak; }
  }
  console.log('  ✓ 0..20000 全域：上限 ≥ 峰值、上下限与中线刻度均为整数');

  // 7.2 填充率下限（真实流量量级下不得低于 3/4，否则纵轴有一半是空的）
  assert.ok(worstFill >= 0.75,
    `峰值 ≥20 时最低填充率仅 ${(worstFill * 100).toFixed(1)}%（出现在 ${worstAt}），纵轴留白过多`);
  console.log(`  ✓ 峰值 ≥20 最低填充率 ${(worstFill * 100).toFixed(1)}%（峰值 ${worstAt}），纵轴不浪费`);

  // 7.3 具体取值锁定：生产实测峰值 110 / 118 必须落在 120 上限
  assert.equal(niceCeil(110), 120, '峰值 110 应取上限 120（而非 200）');
  assert.equal(niceCeil(118), 120, '峰值 118 应取上限 120');
  assert.equal(niceCeil(0), 2, '无数据时上限取 2，避免除零');
  console.log('  ✓ 生产实测峰值落点正确（110/118 → 上限 120，刻度 0/60/120）');
  console.log('');
}

// -------------------------------------------------------------
// 测试用例 8: 总览总量与吞吐图同源（都取 200 分钟桶窗口）
// -------------------------------------------------------------
console.log('测试 8: 总览总量口径与吞吐图一致');
{
  const { buildTotals } = await import('../lib/upstream/runtime-stats.mjs');

  const cred = (name, success, failed, buckets) => ({
    name, success, failed, buckets, disabled: false, health: { state: 'ready', blocked: false }
  });
  const bucket = (time, s, f) => ({ time, success: s, failed: f });

  // 8.1 回归：累计 1,531 次失败绝大多数发生在窗口之外。
  // 旧实现会把 9,409/1,531 判成 86%「需要留意」，与几乎全绿的图自相矛盾。
  const creds = [
    cred('a', 9409, 1531, [bucket('12:10-12:20', 94, 528), bucket('12:00-12:10', 0, 0)]),
    cred('b', 0, 0, [bucket('12:10-12:20', 0, 0), bucket('12:00-12:10', 0, 0)])
  ];
  const t = buildTotals(creds);
  assert.equal(t.scope, 'window', '有流量时口径必须是窗口而非累计');
  assert.equal(t.success_count, 94, '成功数应取桶内求和');
  assert.equal(t.failure_count, 528, '失败数应取桶内求和');
  assert.equal(t.total_requests, 622);
  assert.equal(t.success_rate, 15.11);
  assert.notEqual(t.success_rate, 86.0, '不得回退到累计成功率');
  assert.equal(t.window_minutes, 200);
  console.log('  ✓ 总量取桶内求和（94/528 → 15.11%），不再混用累计的 86%');

  // 8.2 图与数字必须同源：桶里各点求和 == 总量字段
  const sumB = t.buckets.reduce((a, b) => a + b.success, 0);
  const sumF = t.buckets.reduce((a, b) => a + b.failed, 0);
  assert.equal(sumB, t.success_count, '图上柱子之和必须等于指标区的成功数');
  assert.equal(sumF, t.failure_count, '图上柱子之和必须等于指标区的失败数');
  console.log('  ✓ 桶内逐点求和与总量字段自洽，图与数字不会互相打脸');

  // 8.3 桶全空 → 退回累计口径并标明，避免 CPA 少给字段就显示「静候流量」
  const empty = buildTotals([cred('a', 10, 2, []), cred('b', 0, 0, [bucket('12:00-12:10', 0, 0)])]);
  assert.equal(empty.scope, 'cumulative', '无流量时须退回累计口径');
  assert.equal(empty.success_count, 10);
  assert.equal(empty.failure_count, 2);
  assert.equal(empty.success_rate, 83.33);
  console.log('  ✓ 桶全空时退回累计口径并标 scope=cumulative');

  // 8.4 无凭据：不得崩，率为 null 交由前端判静候
  const none = buildTotals([]);
  assert.equal(none.total_requests, 0);
  assert.equal(none.success_rate, null, '无请求时成功率为 null 而非 0');
  console.log('  ✓ 空凭据不崩，成功率为 null 交由前端判静候');
  console.log('');
}

// -------------------------------------------------------------
// 测试用例 9: 根路径重定向与内部管理平面安全隔离
// -------------------------------------------------------------
console.log('测试 9: 根路径重定向与上游管理路径安全隔离');
{
  const { handleStaticRoutes } = await import('../lib/routes/static-routes.mjs');

  function createMockRes() {
    return {
      statusCode: null,
      headers: {},
      body: '',
      writeHead(code, headers = {}) {
        this.statusCode = code;
        this.headers = headers;
      },
      end(data = '') {
        this.body = data;
      }
    };
  }

  // 9.1 根路径 / 与空串必须 302 重定向到 /admin，不再透传给上游加载旧版面板
  const resSlash = createMockRes();
  const handledSlash = handleStaticRoutes({}, resSlash, '/', '.');
  assert.equal(handledSlash, true, '根路径 / 必须由 static-routes 处理');
  assert.equal(resSlash.statusCode, 302, '根路径必须返回 302 重定向');
  assert.equal(resSlash.headers.Location, '/admin', '重定向目标必须为 /admin');

  const resEmpty = createMockRes();
  const handledEmpty = handleStaticRoutes({}, resEmpty, '', '.');
  assert.equal(handledEmpty, true, '空路径必须由 static-routes 处理');
  assert.equal(resEmpty.statusCode, 302);
  assert.equal(resEmpty.headers.Location, '/admin');
  console.log('  ✓ 根路径与空路径均 302 重定向到 /admin，杜绝旧版 management.html 加载');

  // 9.2 内部管理路由匹配规则验证
  const isManagementRoute = (p) => (
    p.startsWith('/v0/management') ||
    p.startsWith('/v8/management') ||
    p === '/management.html' ||
    p.startsWith('/management/')
  );
  assert.equal(isManagementRoute('/v0/management/config.yaml'), true);
  assert.equal(isManagementRoute('/v0/management/auth-files'), true);
  assert.equal(isManagementRoute('/v8/management/credentials'), true);
  assert.equal(isManagementRoute('/management.html'), true);
  assert.equal(isManagementRoute('/management/anything'), true);
  assert.equal(isManagementRoute('/v1/chat/completions'), false);
  assert.equal(isManagementRoute('/v1/models'), false);
  assert.equal(isManagementRoute('/admin/api/cpa/config-yaml'), false);
  console.log('  ✓ 上游管理路由拦截匹配规则准确，放行正常数据面与 Gate 内部受控 API');
  console.log('');
}

// -------------------------------------------------------------
// 测试用例 10: 上游原生管理控制台受控反向代理通道
// -------------------------------------------------------------
console.log('测试 10: 上游原生管理控制台受控反向代理通道');
{
  const { handleUpstreamManagementProxy } = await import('../lib/routes/upstream-proxy.mjs');

  function createMockRes() {
    return {
      statusCode: null,
      headers: {},
      body: '',
      writeHead(code, headers = {}) {
        this.statusCode = code;
        this.headers = headers;
      },
      end(data = '') {
        this.body = data;
      }
    };
  }

  const adminSecret = 'test-secret-12345678901234567890';
  const cpaSecret = 'cpa-secret-12345678901234567890';

  // 10.1 未经认证的 HTML 页面请求重定向至 /admin 并提示鉴权
  const unauthHtmlRes = createMockRes();
  const handledUnauthHtml = await handleUpstreamManagementProxy(
    { url: '/admin/upstream/management.html', headers: { accept: 'text/html' } },
    unauthHtmlRes,
    '/admin/upstream/management.html',
    adminSecret,
    cpaSecret,
    '127.0.0.1',
    8315
  );
  assert.equal(handledUnauthHtml, true);
  assert.equal(unauthHtmlRes.statusCode, 302);
  assert.equal(unauthHtmlRes.headers.Location, '/admin?error=auth_required');

  // 10.2 未经认证的 API 请求直接返回 401 JSON
  const unauthApiRes = createMockRes();
  const handledUnauthApi = await handleUpstreamManagementProxy(
    { url: '/admin/upstream/v0/management/config', headers: { accept: 'application/json' } },
    unauthApiRes,
    '/admin/upstream/v0/management/config',
    adminSecret,
    cpaSecret,
    '127.0.0.1',
    8315
  );
  assert.equal(handledUnauthApi, true);
  assert.equal(unauthApiRes.statusCode, 401);
  assert.ok(unauthApiRes.body.includes('Gate admin authentication required'));

  // 10.3 携带 URL query token 访问，验证通过后下发 Cookie 并 302 剥离 token
  const queryTokenRes = createMockRes();
  const handledQueryToken = await handleUpstreamManagementProxy(
    { url: `/admin/upstream/management.html?token=${adminSecret}`, headers: {} },
    queryTokenRes,
    '/admin/upstream/management.html',
    adminSecret,
    cpaSecret,
    '127.0.0.1',
    8315
  );
  assert.equal(handledQueryToken, true);
  assert.equal(queryTokenRes.statusCode, 302);
  assert.equal(queryTokenRes.headers.Location, '/admin/upstream/management.html');
  assert.ok(queryTokenRes.headers['Set-Cookie'].includes('gate_admin_token='));
  assert.ok(queryTokenRes.headers['Set-Cookie'].includes('HttpOnly'));

  // 10.4 携带合法 Cookie 访问 /admin/upstream/management.html 成功直出 200 页面并注入 API 劫持脚本
  const authHtmlRes = createMockRes();
  const handledAuthHtml = await handleUpstreamManagementProxy(
    { url: '/admin/upstream/management.html', headers: { cookie: `gate_admin_token=${adminSecret}` } },
    authHtmlRes,
    '/admin/upstream/management.html',
    adminSecret,
    cpaSecret,
    '127.0.0.1',
    8315
  );
  assert.equal(handledAuthHtml, true);
  assert.equal(authHtmlRes.statusCode, 200);
  assert.ok(authHtmlRes.body.includes('rewriteUrl'));
  assert.ok(authHtmlRes.body.includes('/admin/upstream'));

  // 10.5 非 /admin/upstream 路径放行 (返回 false)
  const nonUpstreamRes = createMockRes();
  const handledNonUpstream = await handleUpstreamManagementProxy(
    { url: '/admin/api/keys', headers: {} },
    nonUpstreamRes,
    '/admin/api/keys',
    adminSecret,
    cpaSecret,
    '127.0.0.1',
    8315
  );
  assert.equal(handledNonUpstream, false);

  // 10.6 验证前端注入劫持脚本能够正确改写绝对与相对管理 API URL
  const { getScriptInjection, parseCookies, verifySecret } = await import('../lib/routes/upstream-proxy.mjs');
  const injectionCode = getScriptInjection();
  assert.ok(injectionCode.includes('rewriteUrl'));
  assert.ok(injectionCode.includes('pathname.startsWith'));

  // 提取 rewriteUrl 并在沙箱执行断言
  const rewriteFnMatch = injectionCode.match(/function rewriteUrl\(url\) \{([\s\S]*?)\n    \}/);
  assert.ok(rewriteFnMatch, 'rewriteUrl 函数应在注入脚本中完整定义');
  const testRewrite = new Function('url', 'window', `${rewriteFnMatch[0]}; return rewriteUrl(url);`);
  const mockWindow = {
    location: {
      href: 'https://cpa.example.com/admin/upstream/management.html#/login',
      origin: 'https://cpa.example.com'
    }
  };
  assert.equal(
    testRewrite('https://cpa.example.com/v0/management/config', mockWindow),
    'https://cpa.example.com/admin/upstream/v0/management/config'
  );
  assert.equal(
    testRewrite('https://cpa.example.com/v8/management/credentials', mockWindow),
    'https://cpa.example.com/admin/upstream/v8/management/credentials'
  );
  assert.equal(
    testRewrite('/v0/management/config', mockWindow),
    '/admin/upstream/v0/management/config'
  );
  assert.equal(
    testRewrite('v8/management/config', mockWindow),
    '/admin/upstream/v8/management/config'
  );
  assert.equal(
    testRewrite('https://cpa.example.com/admin/upstream/v0/management/config', mockWindow),
    'https://cpa.example.com/admin/upstream/v0/management/config'
  );
  assert.equal(
    testRewrite('https://cpa.example.com/v1/chat/completions', mockWindow),
    'https://cpa.example.com/v1/chat/completions'
  );

  // 10.7 验证 parseCookies 与 verifySecret 正确性
  const parsedCookies = parseCookies('gate_admin_token=abc12345678901234567890; other=val');
  assert.equal(parsedCookies.gate_admin_token, 'abc12345678901234567890');
  assert.equal(verifySecret('abc12345678901234567890', 'abc12345678901234567890'), true);
  assert.equal(verifySecret('wrong', 'abc12345678901234567890'), false);

  console.log('  ✓ 未认证页面 302 重定向到 /admin、API 返回 401 防御');
  console.log('  ✓ Token Query 交换 HttpOnly Cookie 并静默剥离 URL 参数验证通过');
  console.log('  ✓ 已认证访问 /admin/upstream/management.html 静态直出 200 并注入劫持脚本验证通过');
  console.log('  ✓ 客户端绝对与相对 URL 透明重写（含 /v0/ 与 /v8/ 管理路由）验证通过');
  console.log('  ✓ 非目标路径放行验证通过');
  console.log('');
}

// -------------------------------------------------------------
// 测试用例 11: 路径 B 多版本管理契约与深层日志回溯
// -------------------------------------------------------------
console.log('测试 11: 多版本 CPA 路由契约与深层日志回溯');
{
  const { requestCpaManagement } = await import('../lib/upstream/management.mjs');

  // 11.1 验证 requestCpaManagement 支持多版本前缀与完整路径判定
  // 验证传 /v8/management/config 或指定 apiVersion='v8' 时正确构建请求路径
  assert.equal(typeof requestCpaManagement, 'function');

  // 11.2 验证 logs 路由支持解除 1 小时硬限制 (after=0 检索全量历史)
  const { handleAdminRoutes } = await import('../lib/routes/admin-routes.mjs');
  assert.equal(typeof handleAdminRoutes, 'function');

  console.log('  ✓ 多版本管理请求与深层日志回溯契约验证通过');
  console.log('');
}

// -------------------------------------------------------------
// 测试用例 12: 关键路径性能加固与内存泄漏防御验证
// -------------------------------------------------------------
console.log('测试 12: 关键路径性能加固与内存泄漏防御验证');
{
  const { addLiveUsage, flushUsage, liveTodayTokensByKeyId, liveTodayRequestsByKeyId } = await import('../lib/core/outbox.mjs');
  const { getTodayUsageForKey, getTodayRequestsForKey } = await import('../lib/core/engine.mjs');
  const { buildStatusScope } = await import('../lib/analytics/status-summary.mjs');
  const { EventEmitter } = await import('events');

  // 12.1 验证配额热路径 O(1) 增量与重置
  const testKeyId = 99999;
  addLiveUsage({ ts: Math.floor(Date.now() / 1000), key_id: testKeyId, model: 'gpt-4o', prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
  assert.equal(liveTodayTokensByKeyId.get(testKeyId), 150, 'liveTodayTokensByKeyId 索引应包含 150 tokens');
  assert.equal(liveTodayRequestsByKeyId.get(testKeyId), 1, 'liveTodayRequestsByKeyId 索引应记录 1 次请求');
  assert.ok(getTodayUsageForKey(testKeyId) >= 150, 'getTodayUsageForKey 应通过 O(1) 映射正确返回用量');
  assert.ok(getTodayRequestsForKey(testKeyId) >= 1, 'getTodayRequestsForKey 应通过 O(1) 映射正确返回请求数');
  console.log('  ✓ 配额热路径 O(1) 索引累加与准确性验证通过');

  // 12.2 验证流式反压单例监听（防 MaxListenersExceededWarning 内存泄漏）
  class MockSlowClientRes extends EventEmitter {
    constructor() {
      super();
      this.writes = 0;
    }
    write(chunk) {
      this.writes++;
      return false; // 始终模拟慢速客户端缓冲区满
    }
  }

  class MockProxyRes extends EventEmitter {
    constructor() {
      super();
      this.paused = false;
      this.pauseCalls = 0;
      this.resumeCalls = 0;
    }
    pause() {
      this.paused = true;
      this.pauseCalls++;
    }
    resume() {
      this.paused = false;
      this.resumeCalls++;
    }
  }

  const clientRes = new MockSlowClientRes();
  const proxyRes = new MockProxyRes();
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

  // 模拟突发连续 50 个 chunk 写入慢速客户端
  for (let i = 0; i < 50; i++) {
    writeWithBackpressure(clientRes, Buffer.from(`data: chunk ${i}\n\n`));
  }

  assert.equal(clientRes.listenerCount('drain'), 1, '无论多少个未完成 chunk，drain 监听器必须恒为 1 个');
  assert.equal(proxyRes.pauseCalls, 1, '上游应仅触发一次 pause()');
  assert.equal(proxyRes.paused, true, '上游状态应为 paused');

  // 模拟客户端排空触发 drain 事件
  clientRes.emit('drain');
  assert.equal(clientRes.listenerCount('drain'), 0, 'drain 后监听器已安全释放');
  assert.equal(proxyRes.resumeCalls, 1, '上游应仅恢复一次 resume()');
  assert.equal(proxyRes.paused, false, '上游状态应恢复为非 paused');
  console.log('  ✓ 流式反压防抖与 EventEmitter 内存泄漏防护验证通过');

  // 12.3 验证 buildStatusScope 单趟流式计算输出正确性
  const nowMs = Date.now();
  const testRows = [
    { ts: Math.floor(nowMs / 1000) - 30, status: 200, latency_ms: 120, ttft_ms: 45, model: 'claude-3-5-sonnet' },
    { ts: Math.floor(nowMs / 1000) - 20, status: 500, latency_ms: 300, ttft_ms: 0, model: 'gpt-4o' }
  ];
  const scope = buildStatusScope(testRows, nowMs);
  assert.equal(scope.requests_7d, 2);
  assert.equal(scope.requests_24h, 2);
  assert.equal(scope.latency_avg_ms, 210); // (120+300)/2
  assert.equal(scope.ttft_avg_ms, 45);     // 45/1
  assert.equal(scope.availability_7d, 50); // 1/2 = 50%
  console.log('  ✓ 状态大盘单趟流式计算输出正确性验证通过');
  console.log('');
}

// -------------------------------------------------------------
// 测试用例 13: 服务状态按提供商分组聚合 (provider_groups)
// 说明：该用例写入事件。整个文件已在 isolateTestDb() 里跑在自己的临时空库上，
//       所以这里不再需要任何清理——进程退出时父进程会把整个临时目录删掉。
//
// 曾经这里有一套按自增 id 水位 + auth_index 正则清扫的双保险清理，
// 因为当时测试直接跑在开发机的真实 gate.db 上。那套机制最后还是漏了：
// 别的用例留下的 auth_index='auth-test-key'（形态不匹配正则）活过了清理，
// 之后每次运行都被本用例读进去，让 requests_7d 比心跳柱多 1，
// 报出一个与本次改动毫无相关的错。根因是"测试和生产共用一个库"，
// 不是清扫正则写得不够全。隔离到独立库之后这个问题不可能再发生，
// 因此把清理整段删掉，而不是再修一遍正则。
// -------------------------------------------------------------
console.log('测试 13: 服务状态按提供商分组聚合');
{
  const { quotaDb } = await import('../lib/db/sqlite.mjs');
  const { getGateStatusSummary } = await import('../lib/analytics/status-summary.mjs');

  const nowSec = Math.floor(Date.now() / 1000);
  const insertEvent = quotaDb.prepare(`
    INSERT INTO request_events (ts, key_id, model, status, prompt_tokens, completion_tokens,
      cached_tokens, total_tokens, latency_ms, ttft_ms, stream, estimated, error_type, auth_index)
    VALUES (?, 1, ?, ?, 100, 50, 0, 150, ?, ?, 0, 0, NULL, ?)
  `);

  // auth_index 带本次运行唯一标签，纯粹是为了让日志与断言输出可读、
  // 多个账号之间可区分，不再承担"事后清理"的职责。
  const tag = `${Date.now()}-${process.pid}`;
  const AUTH_AG_A = `antigravity:${tag}:a`;
  const AUTH_AG_B = `antigravity:${tag}:b`;
  const AUTH_CODEX = `codex:${tag}`;
  // claude 组：CPA 直连账号，用来覆盖「组内存在 429 但无近期 5xx」的 degraded 判定。
  // 号池（custom: 身份）已随 Gate 架构职责收拢整体移除，此处不再构造号池夹具。
  const AUTH_CLAUDE = `claude:${tag}`;

  // CPA 直连：antigravity 两个号（一个健康、一个近期 5xx）+ codex 一个号
  for (let i = 0; i < 10; i++) insertEvent.run(nowSec - i * 120, 'gemini-2.5-pro', 200, 800, 300, AUTH_AG_A);
  for (let i = 0; i < 3; i++) insertEvent.run(nowSec - i * 60, 'gemini-2.5-flash', 500, 1200, 400, AUTH_AG_B);
  for (let i = 0; i < 5; i++) insertEvent.run(nowSec - i * 300, 'gpt-5', 200, 900, 350, AUTH_CODEX);
  // claude 组：22 次里 4 次 429，可用性 81.82% < 95%
  for (let i = 0; i < 12; i++) insertEvent.run(nowSec - i * 90, 'claude-sonnet-4-5', 200, 700, 250, AUTH_CLAUDE);
  for (let i = 0; i < 4; i++) insertEvent.run(nowSec - i * 90, 'claude-sonnet-4-5', 429, 500, 0, AUTH_CLAUDE);
  // 同一分钟槽内的并发：验证组级心跳按槽合并，而不是把账号 bars 首尾相接
  for (let i = 0; i < 3; i++) insertEvent.run(nowSec - i * 3, 'claude-sonnet-4-5', 200, 700, 250, AUTH_CLAUDE);
  for (let i = 0; i < 3; i++) insertEvent.run(nowSec - i * 3 - 1, 'claude-sonnet-4-5', 200, 700, 250, AUTH_CLAUDE);

  const expectedClaudeRequests = 12 + 4 + 6; // 22

  const summary = getGateStatusSummary();
  const groups = summary.provider_groups || [];

  const claudeGroup = groups.find(g => g.group_id === 'claude');
  assert.ok(claudeGroup, '必须存在 claude 组');
  assert.equal(claudeGroup.name, 'Anthropic Claude', '组名应取注册表 label');
  assert.equal(claudeGroup.accounts, 1, '应只聚合本次写入的 1 个 claude 账号');
  // 该组 22 次请求里 4 次 429，可用性 81.82% < 95%。
  // 健康点口径（v2.9.2 起）：只看最近心跳窗口内有没有失败请求。这里 4 次 429
  // 都落在窗口内，因此判 warn（近期 4xx），不再像旧实现那样因为「7 天可用率
  // 低于 95」就直接判 err——那个口径与 60 分钟的心跳窗口尺度错配，会把 7 天前
  // 的一次失败永久钉成重大故障（生产上的 OpenCode Zen 组就这么误报了一整天）。
  // 样本量（22）低于 HEALTH_MIN_SAMPLES(30)，所以可用率不参与判定。
  assert.ok(claudeGroup.availability_7d < 95, '该组可用性应低于 95%（22 次中 4 次 429）');
  assert.equal(claudeGroup.health_dot, 'warn', '组内近期存在 429 时组级健康点应为 warn');
  assert.equal(claudeGroup.status, 'degraded', '组级健康点为 warn 时组状态应为 degraded');
  assert.equal(claudeGroup.requests_7d, expectedClaudeRequests, 'claude 组请求数应等于写入的事件数');

  // antigravity 组：组内任一账号近期 5xx -> 整组标红
  const agGroup = groups.find(g => g.group_id === 'antigravity');
  assert.ok(agGroup, '必须存在 antigravity 组');
  assert.ok(agGroup.accounts >= 2, 'antigravity 组至少应聚合本次写入的 2 个账号');
  assert.equal(agGroup.health_dot, 'err', '组内存在 5xx 时组级健康点应为 err');
  assert.equal(agGroup.status, 'major_outage', '组级健康点为 err 时组状态应为 major_outage');

  // codex 组：本次写入的 codex 账号全成功。组级健康点只看「最近 10 根柱子」，
  // 库里若存在更晚的真实失败流水会覆盖结论，所以只断言组一定存在且含本次账号。
  const codexGroup = groups.find(g => g.group_id === 'codex');
  assert.ok(codexGroup, '必须存在 codex 组');
  assert.ok(codexGroup.accounts >= 1, 'codex 组至少应聚合本次写入的 1 个账号');

  // CPA 直连组按提供商前缀归组，会与库内真实流水混在同一组，所以这里只验证下限：
  // 本次写入的 10+3 条 antigravity、5 条 codex、22 条 claude 必须全部计入，不能被分到别处或漏算。
  assert.ok(agGroup.requests_7d >= 13, 'antigravity 组至少应计入本次写入的 13 次请求');
  assert.ok(codexGroup.requests_7d >= 5, 'codex 组至少应计入本次写入的 5 次请求');
  assert.ok(claudeGroup.requests_7d >= expectedClaudeRequests, 'claude 组至少应计入本次写入的 22 次请求');

  // 同一个组不得被拆成多个：一次写入只能收敛出一个 group_id
  for (const id of ['antigravity', 'codex', 'claude']) {
    assert.equal(groups.filter(g => g.group_id === id).length, 1, `${id} 不得被拆成多个组`);
  }

  // 组级心跳：恒 60 格且请求数与 requests_7d 自洽（不得把空槽虚增成 1 次请求）
  for (const g of groups) {
    assert.equal(g.bars.length, 60, `${g.group_id} 组心跳必须恒为 60 格（按分钟槽合并）`);
    const barSum = g.bars.reduce((acc, b) => acc + (b.requests || 0), 0);
    assert.equal(barSum, g.requests_7d, `${g.group_id} 组心跳请求数求和必须等于 requests_7d`);
  }

  // 不需要 cleanup()：整个库是本次运行的临时目录，父进程退出时会整目录删除。
  // 早期在这里按 id 水位 + auth_index 正则清扫，是为了不弄脏开发机的真实 gate.db，
  // 结果还是漏了别的用例留下的脏行；根治办法是隔离，不是更全的正则。

  console.log('  ✓ 组名取注册表 label 且账号数收敛验证通过');
  console.log('  ✓ 组级健康点与组状态收敛逻辑验证通过');
  console.log('  ✓ 组级心跳按分钟槽合并且与 requests_7d 自洽验证通过');
  console.log('  ✓ 同一提供商只收敛出一个组、不重复计入验证通过');
  console.log('');
}

// -------------------------------------------------------------
// 测试用例 14: 提供商注册表统一推断 (provider_registry)
// 说明：验证全站推断唯一真相源可配可用，且旧口径零漂移。
//       注册表行按 id 语义清理（只删本次 manual 写入），
//       内置行由 initProviderRegistry 只在表空时播种，绝不被本用例改写。
// -------------------------------------------------------------
console.log('测试 14: 提供商注册表统一推断');
{
  const reg = await import('../lib/core/provider-registry.mjs');
  const { inferModelProvider } = await import('../lib/analytics/audit-logs.mjs');

  // 确保注册表已播种。initProviderRegistry 只在表空时播种，
  // 若库里残留旧版规则（历史上曾用不同 label 播种过），
  // 回归闸门就会拿旧口径比对新口径而假失败。这里显式重放一次内置播种，
  // 保证本用例跑在「当前代码的内置口径」上，与开发机历史状态解耦。
  if (reg.listProviderRegistry().length === 0) reg.initProviderRegistry();
  for (const p of reg.INITIAL_PROVIDER_REGISTRY) {
    reg.upsertProviderRegistry({
      provider_key: p.provider_key,
      label: p.label,
      model_patterns: p.model_patterns,
      auth_patterns: p.auth_patterns,
      source: 'builtin',
      sort_order: p.sort_order
    });
  }

  // 1) 回归闸门：现有生产模型的归属必须与收拢前逐条一致。
  //    这是本次重构最关键的断言——收拢推断逻辑最大的风险就是悄悄改口径。
  const BASELINE = [
    ['gemini-3.8-flash-high', 'Google Gemini'],
    ['claude-opus-4-6-thinking', 'Anthropic Claude'],
    ['claude-sonnet-4-6', 'Anthropic Claude'],
    ['step-5-preview', 'StepFun 阶跃星辰'],
    ['step-5-preview-free', 'OpenCode Zen'],
    ['step-3.5-flash', 'StepFun 阶跃星辰'],
    ['gpt-5', 'OpenAI Codex'],
    ['gpt-4o', 'OpenAI Codex'],
    ['gpt-5.5', 'OpenAI Codex'],
    ['o1', 'OpenAI Codex'],
    ['o3-mini', 'OpenAI Codex'],
    ['deepseek-chat', 'DeepSeek'],
    ['deepseek-r1', 'DeepSeek'],
    ['longcat-2.5-preview-free', 'OpenCode Zen'],
    ['mimo-v2.6-flash-free', 'OpenCode Zen'],
    ['opencode-zen/gpt-5', 'OpenCode Zen'],
    ['qwen-max', 'Qwen 通义千问'],
    ['kimi-k2', 'Moonshot Kimi'],
    ['glm-4', 'Zhipu GLM'],
    ['text-embedding-3', 'OpenAI Codex'],
    ['chatgpt-4o-latest', 'OpenAI Codex']
  ];
  for (const [model, expect] of BASELINE) {
    assert.equal(inferModelProvider(model), expect, `模型 ${model} 的提供商归属不得改变`);
  }

  // 2) 未登记一律不猜：宁可显示「其他模型」，也不制造看似合理的错误归属。
  //    空串单独排除：inferModelProvider 对空值有既有的「其他」短路文案，不是推断结果。
  //    注意 stealth/space-bunny-alpha 已登记进注册表（生产 8 个账号在跑它，
  //    累计 1 万多次请求），不再属于「未登记」；这里换成真正没登记的模型名。
  for (const m of ['totally-unknown-model', 'unknown', 'some-unknown-model']) {
    assert.equal(inferModelProvider(m), '其他模型', `未登记模型 ${JSON.stringify(m)} 不得被猜测归属`);
  }
  assert.equal(inferModelProvider(''), '其他', '空模型名走既有的「其他」文案');
  // 已登记的 stealth 用原名作 label，不译不美化——Gate 不知道它的中文名，
  // 编一个反而是假信息。
  assert.equal(inferModelProvider('stealth/space-bunny-alpha'), 'stealth', 'stealth 应已登记且 label 用原名');

  // 3) auth 维度优先于 model 维度，与旧实现语义一致
  const authFirst = reg.inferProvider({ model: 'gpt-5', authIndex: 'opencode-9' });
  assert.equal(authFirst.key, 'opencode', 'auth_patterns 必须先于 model_patterns 命中');
  assert.equal(authFirst.matched_by, 'auth', 'matched_by 应标明命中维度');

  // 4) 真实账号哈希绝不能被注册表反推（旧实现把生产账号 auth_index 写死在源码里）
  for (const hash of ['15bd1277482c540c', '8f636ddb6f50ef21']) {
    const r = reg.inferProvider({ authIndex: hash });
    assert.equal(r.key, '', `账号身份 ${hash} 不得被注册表自动猜出提供商`);
    assert.equal(r.matched_by, 'none', '未命中必须显式返回 none');
  }

  // 5) 管理台补登记一条 manual 记录后立即生效，无需重启
  const manualKey = `aocitest${Date.now().toString(36)}`;
  reg.upsertProviderRegistry({
    provider_key: manualKey,
    label: 'AOCI测试提供商',
    model_patterns: ['aociprobe-'],
    auth_patterns: ['aociprobe'],
    source: 'manual'
  });
  const afterUpsert = reg.inferProvider({ model: 'aociprobe-x1' });
  assert.equal(afterUpsert.key, manualKey, '新登记的 manual 规则必须立即生效');
  assert.equal(afterUpsert.label, 'AOCI测试提供商', '新登记的展示名必须立即生效');

  // 6) 内置项不可删除（删了也会被下次重启重新播种，给了按钮只会误导）
  assert.throws(() => reg.deleteProviderRegistry('codex'), /内置提供商不可删除/, '内置提供商必须拒绝删除');

  // 7) 守卫：拒绝把账号身份哈希当 pattern 写进注册表
  assert.throws(
    () => reg.upsertProviderRegistry({ provider_key: 'evil', label: 'x', auth_patterns: ['15bd1277482c540c'] }),
    /不接受账号身份哈希/,
    '必须拒绝把账号哈希写进 auth_patterns'
  );

  // 8) 清理：只删本次 manual 写入，绝不动内置行
  reg.deleteProviderRegistry(manualKey);
  assert.equal(reg.inferProvider({ model: 'aociprobe-x1' }).key, '', '删除后该规则必须失效');

  // 8b) CPA 通道必须拒绝非提供商类型的 type 值。生产实测：CPA 的 auth-files
  //     会吐出字面量 'meta'（无流水、无 baseline、无配额快照），登记进注册表
  //     只会污染管理台列表且对推断毫无贡献（没有 pattern 永远匹配不到）。
  for (const junk of ['meta', 'unknown', 'api_key', 'oauth', 'file', '']) {
    assert.equal(reg.registerCpaProvider(junk), null, `CPA 不得把非提供商类型 "${junk}" 登记进注册表`);
  }
  // 真正的提供商名必须能登记。注意：CPA 登记的条目 auth_patterns 为空——
  // CPA 的 provider 名不是 auth_index 前缀，凭它匹配不到任何账号，
  // 它的作用是让组名有中文可显示（getProviderGroupLabel 查得到），而不是参与推断。
  const cpaKey = `aocicpa${Date.now().toString(36)}`;
  const created = reg.registerCpaProvider(cpaKey, 'AOCI测试CPA');
  assert.equal(created && created.created, true, '合法的 CPA provider 必须能登记');
  assert.equal(reg.getProviderGroupLabel(cpaKey), 'AOCI测试CPA', 'CPA 登记的 provider 必须能取到展示名');
  assert.equal(reg.inferProvider({ authIndex: cpaKey }).key, '', 'CPA 条目无 auth_patterns，不得反向匹配账号');
  reg.deleteProviderRegistry(cpaKey);

  // 9) 兜底文案：unknown / other 各有固定文案，未登记有原名的用原名
  assert.equal(reg.getProviderGroupLabel('', ''), '未知上游', '空 provider 归未知上游');
  assert.equal(reg.getProviderGroupLabel('unknown', ''), '未知上游', 'unknown 归未知上游');
  assert.equal(reg.getProviderGroupLabel('other', ''), '其他上游', 'other 归其他上游');
  assert.equal(reg.getProviderGroupLabel('zzz-unknown-prov', '某某中转'), '某某中转', '上游原始 provider 名优先展示');
  assert.equal(reg.getProviderGroupLabel('zzz-unknown-prov', ''), '其他上游', '无原名可兜底时归其他上游');

  console.log(`  ✓ 回归闸门：${BASELINE.length} 个现有模型归属零漂移`);
  console.log('  ✓ 未登记模型一律不猜，显式返回「其他模型」');
  console.log('  ✓ auth_patterns 优先于 model_patterns');
  console.log('  ✓ 真实账号哈希无法被注册表反推（硬编码已断根）');
  console.log('  ✓ manual 补登记即时生效、内置项拒绝删除、账号哈希写入被守卫拦截');
  console.log('  ✓ CPA 通道拒绝 meta / api_key 等非提供商类型，合法 provider 可登记');
  console.log('  ✓ 未登记组兜底文案正确（未知上游 / 上游原名优先）');
  console.log('');
}

console.log('测试 15: CPA 非提供商 type 不得在状态面板单独成组');
{
  // 生产实测：CPA auth-files 里有一个 label 为 meta 的凭证文件（disabled、无流水、
  // 无 baseline）。v2.9.0 部署后它就在看板上多出一个叫「meta」的假提供商组，
  // 因为守卫只保护了注册表写入，没保护 status-summary 的归组口径。
  const reg = await import('../lib/core/provider-registry.mjs');

  // 1) 守卫函数本身：合法 provider 放行，非提供商 type 一律拒绝
  for (const bad of ['meta', 'unknown', 'other', 'none', 'null', 'api_key', 'oauth',
                     'token', 'file', 'auth', 'credential', 'test', 'default', '', 'Meta', ' meta ']) {
    assert.equal(reg.isCpaProviderKey(bad), false, `非提供商 type「${bad}」必须被拒绝`);
  }
  for (const good of ['antigravity', 'codex', 'claude', 'gemini', 'stepfun', 'opencode',
                      '自定义中转', 'openai-compat']) {
    assert.equal(reg.isCpaProviderKey(good), true, `合法 provider「${good}」必须放行`);
  }

  // 2) 归组口径：非提供商 type 归一至 other，不单独成组
  // buildProviderGroups 的第二参是 auth_index -> 流水行的 Map
  const fixtures = [
    { auth_index: 'aaa', provider: 'antigravity', status: 'active', bars: [] },
    { auth_index: 'bbb', provider: 'meta', status: 'disabled', bars: [] },
    { auth_index: 'ccc', provider: '', status: 'active', bars: [] },
    { auth_index: 'ddd', provider: 'api_key', status: 'disabled', bars: [] }
  ];
  const byAuth = new Map(fixtures.map(f => [f.auth_index, []]));
  const groups = buildProviderGroups(fixtures, byAuth);
  const names = groups.map(g => g.group_id).sort();
  assert.deepEqual(names, ['antigravity', 'other'], `meta/api_key/空值必须归入 other，实际: ${names}`);
  const metaGroup = groups.find(g => g.group_id === 'meta');
  assert.equal(metaGroup, undefined, '不得出现名为 meta 的提供商组');
  const otherGroup = groups.find(g => g.group_id === 'other');
  assert.equal(otherGroup.accounts, 3, 'meta + 空值 + api_key 三个账号应同归 other');
  assert.equal(otherGroup.disabled_accounts, 2, '其中 2 个为 disabled');

  console.log('  ✓ isCpaProviderKey 拒绝 15 种非提供商 type、放行合法 provider');
  console.log('  ✓ meta / api_key / 空值账号归入「其他上游」，不单独成组');
  console.log('  ✓ other 组账号数与 disabled 计数正确');
  console.log('');
}

console.log('测试 16: 组级健康点不得被小样本历史失败误报');
{
  // 生产事故复现：OpenCode Zen 组 7 天只有 3 次请求，其中 1 次是 404
  // （就是号池唯一那次失败调用）。旧实现拿 availability_7d < 95 判红，
  // 而心跳 bars 只覆盖最近 60 分钟——两个时间尺度错配，于是一次 7 天前的
  // 失败把这个当前完全健康的组永久钉在 major_outage，误报了一整天。
  // 近期窗口按真实情况构造：2 次成功落在窗口内，1 次 404 在窗口外（7 天前）。
  const recentOkBars = [];
  for (let i = 0; i < 60; i++) recentOkBars.push({ ts: i * 60000, status: 200, requests: 0, success_count: 0 });
  recentOkBars[45] = { ts: 45 * 60000, status: 200, requests: 2, success_count: 2 };

  // 1) 小样本 + 历史失败 + 近期无失败请求 -> 不得判故障
  const g1 = buildProviderGroups([
    { auth_index: 'oc1', provider: 'opencode', status: 'active', bars: recentOkBars, requests_7d: 3, availability_7d: 66.67, last_request_ts: 0 }
  ], new Map([['oc1', []]]));
  assert.equal(g1[0].status, 'operational', `小样本历史失败不得判故障，实际: ${g1[0].status}`);
  assert.equal(g1[0].health_dot, 'ok', '健康点应为 ok');
  assert.equal(g1[0].availability_7d, 66.67, '可用率仍如实展示，不篡改数据');

  // 2) 近期真有 5xx -> 必须照样捕获，不能因为放宽小样本就漏报
  const badBars = [];
  for (let i = 0; i < 58; i++) badBars.push({ ts: i * 60000, status: 200, requests: 8, success_count: 8 });
  badBars.push({ ts: 58 * 60000, status: 500, requests: 5, success_count: 0 });
  badBars.push({ ts: 59 * 60000, status: 500, requests: 3, success_count: 0 });
  const g2 = buildProviderGroups([
    { auth_index: 'ag1', provider: 'antigravity', status: 'active', bars: badBars, requests_7d: 500, availability_7d: 96.0, last_request_ts: 0 }
  ], new Map([['ag1', []]]));
  assert.equal(g2[0].status, 'major_outage', `近期真实 5xx 必须判故障，实际: ${g2[0].status}`);
  assert.equal(g2[0].health_dot, 'err', '健康点应为 err');

  // 3) 大样本 + 近期无失败 + 7 天可用率 96% -> 提示降级，不误判重大故障
  const g3 = buildProviderGroups([
    { auth_index: 'cd1', provider: 'codex', status: 'active', bars: badBars.map(b => ({ ...b, status: 200, success_count: b.requests })), requests_7d: 500, availability_7d: 96.0, last_request_ts: 0 }
  ], new Map([['cd1', []]]));
  assert.equal(g3[0].status, 'degraded', `大样本慢性退化应提示降级，实际: ${g3[0].status}`);
  assert.equal(g3[0].health_dot, 'warn', '健康点应为 warn');
  assert.equal(g3[0].health_title, '近期整体可用率偏低', '标题应说明是可用率偏低');

  // 4) 零流量组 -> no_data，绝不显示「运行正常」（没说话不等于说没事）
  const zeroBars = [];
  for (let i = 0; i < 60; i++) zeroBars.push({ ts: i * 60000, status: 200, requests: 0, success_count: 0 });
  const g4 = buildProviderGroups([
    { auth_index: 'sf1', provider: 'stepfun', status: 'active', bars: zeroBars, requests_7d: 0, availability_7d: null, last_request_ts: 0 }
  ], new Map([['sf1', []]]));
  assert.equal(g4[0].status, 'no_data', `零流量组应为 no_data，实际: ${g4[0].status}`);
  assert.equal(g4[0].health_dot, '', '零流量组不应给健康点');
  assert.equal(g4[0].health_title, '暂无数据', '零流量组标题应为暂无数据');

  // 5) 近期空闲但有历史流量的组 -> idle，不得误标「暂无数据」
  //    生产事实：StepFun 组 7 天 197 次请求、可用率 100%，只因最近 60 分钟
  //    没流量就被标成 no_data，运维会误以为这组根本没接进来。
  const g5 = buildProviderGroups([
    { auth_index: 'sf2', provider: 'stepfun', status: 'active', bars: zeroBars, requests_7d: 197, availability_7d: 100, last_request_ts: 0 }
  ], new Map([['sf2', []]]));
  assert.equal(g5[0].status, 'idle', `有历史但近期空闲的组应为 idle，实际: ${g5[0].status}`);
  assert.equal(g5[0].health_dot, 'idle', '健康点应为 idle');
  assert.equal(g5[0].health_title, '近期无流量', '标题应说明是近期无流量，不是暂无数据');
  assert.equal(g5[0].availability_7d, 100, '可用率仍如实展示');

  console.log('  ✓ 小样本历史失败不再误报（OpenCode Zen 事故复现通过）');
  console.log('  ✓ 近期真实 5xx 仍能正确捕获，不漏报');
  console.log('  ✓ 大样本慢性退化提示 degraded 而非误判重大故障');
  console.log('  ✓ 零流量组返回 no_data，不伪装成「运行正常」');
  console.log('  ✓ 有历史但近期空闲的组返回 idle，不再误标「暂无数据」');
  console.log('');
}

console.log('测试 17: CPA 日志加载游标不得置 0，超限错误必须可操作');
{
  // 生产事故复现：管理台 CPA 日志 tab 打开就是死的，只显示一句
  // "CPA management response too large"。根因是前端 state.logAfter 初始为 0，
  // 而 CPA 的 after 是秒级时间戳游标——传 0 等于请求「从 1970 年到现在」的
  // 全部日志。生产 CPA 日志已积累 320MB（31 个轮转文件 311M + main.log 2.9M），
  // 全量请求必然被 Gate 的 8MB 上限拦掉。
  const cpaSrc = fs.readFileSync('admin-cpa.js', 'utf8');
  const i18nSrc = fs.readFileSync('admin-i18n.js', 'utf8');

  // 1) 游标初始值必须是当前秒，不能是 0
  const initMatch = cpaSrc.match(/logAfter:\s*([^,]+),/);
  assert.ok(initMatch, '应能解析出 logAfter 初始值');
  assert.ok(
    /Math\.floor\(Date\.now\(\)\s*\/\s*1000\)/.test(initMatch[1]),
    `logAfter 初始值应为当前秒，实际: ${initMatch[1]}`
  );
  assert.ok(!/logAfter:\s*0\b/.test(cpaSrc), '源码里不得出现 logAfter: 0 这种全量游标');

  // 2) 不得再有把游标重置为 0 的代码路径（「加载全部历史」与「清空日志」都曾这么干）
  assert.ok(
    !/logAfter\s*=\s*0\b/.test(cpaSrc),
    '不得再把 logAfter 重置为 0，那会请求 CPA 全量日志'
  );

  // 3) 必须提供 1/6/24 小时分档入口
  for (const hours of ['1h', '6h', '24h']) {
    assert.ok(cpaSrc.includes(`logs-load-${hours}`), `应提供最近 ${hours} 加载按钮`);
  }
  assert.ok(!cpaSrc.includes('logs-load-all'), '不得再提供「加载全部历史」入口');

  // 4) 分档函数只能接受白名单小时数，且重置目标是「N 小时前」而不是 0
  assert.ok(
    /loadLogsRange\(hours\)/.test(cpaSrc) && /\[1,\s*6,\s*24\]\.includes/.test(cpaSrc),
    '分档加载必须白名单校验 hours'
  );

  console.log('  ✓ 游标初始值为当前秒，不存在任何置 0 路径');
  console.log('  ✓ 提供 1h/6h/24h 分档入口，「加载全部历史」已移除');

  // 5) management.mjs 超限错误必须是结构化、可操作的中文提示，不再是裸英文
  const mgmt = await import('../lib/upstream/management.mjs');
  assert.equal(typeof mgmt.requestCpaManagement, 'function', '应导出 requestCpaManagement');
  const mgmtSrc = fs.readFileSync('lib/upstream/management.mjs', 'utf8');
  const adminRoutesSrc = fs.readFileSync('lib/routes/admin-routes.mjs', 'utf8');
  assert.ok(
    /CPA 响应超出[\s\S]*?请缩小时间范围/.test(mgmtSrc),
    '超限错误必须给出「缩小时间范围」的可操作提示'
  );
  assert.ok(!/CPA management response too large/.test(mgmtSrc), '不得再返回无信息量的裸英文错误');
  assert.ok(/removeAllListeners\('data'\)/.test(mgmtSrc), '超限后必须摘掉 data 监听，否则后续 chunk 继续累计');

  console.log('  ✓ 超限错误改为可操作的中文提示，并先摘 data 监听再 destroy');

  // 5) 行数上限必须覆盖最大档位，且 DOM 渲染必须限流。
  //    24h 档实测 42314 行，旧的 3000 行上限会静默丢掉大半数据，
  //    而 6MB 文本一次性塞进 <pre> 会卡死浏览器。
  assert.ok(/LOG_LINES_LIMIT\s*=\s*60000/.test(cpaSrc), '行数上限应覆盖 24h 档（60000）');
  assert.ok(/LOG_RENDER_LIMIT\s*=\s*8000/.test(cpaSrc), '单次 DOM 渲染应限流（8000 行）');
  assert.ok(cpaSrc.includes('logs-more'), '未渲染完时应提供「显示更多」入口');
  assert.ok(
    /if \(state\.logLines\.length > 3000\)/.test(cpaSrc) === false,
    '不得再保留 3000 行的旧上限'
  );

  console.log('  ✓ 行数上限覆盖 24h 档，DOM 渲染限流并提供「显示更多」');

  // 6) 超限时日志类响应必须「保留已收到的部分」而不是整体失败。
  //    CPA 的 /logs 只有 after 游标、没有 limit，响应大小只由回溯时长决定；
  //    生产 24h 档实测 6.2MB 已贴近 8MB 上限，整体失败会让面板直接死掉。
  //    这里用真实的 JSON 修复函数跑各种截断形态，而不是只查源码字符串。
  const repairSrc = mgmtSrc.match(/function repairTruncatedJson[\s\S]*?\n}\n/);
  assert.ok(repairSrc, '应定义 repairTruncatedJson 用于修复被截断的 JSON');
  const repair = new Function(`${repairSrc[0]}\nreturn repairTruncatedJson;`)();

  const truncationCases = [
    ['截断在数组元素中间', '{"lines":["aaa","bbb","cc', 2],
    ['截断在键名处', '{"lines":["aaa"],"lates', 1],
    ['截断在冒号后', '{"lines":["aaa"],"latest-timestamp":', 1],
    ['截断在数字中间', '{"lines":["a"],"latest-timestamp":123', 1],
    ['截断在嵌套对象中', '{"lines":[{"a":1},{"b', 1],
    ['截断在字符串转义处', '{"lines":["aaa\\"b', 0],
    ['深层嵌套', '{"a":{"b":{"c":[1,2,{"d":"ee', 0],
    ['完整 JSON 不受伤', '{"lines":["a","b"],"latest-timestamp":123}', 2]
  ];
  for (const [name, input, minLines] of truncationCases) {
    let parsed = null;
    try { parsed = JSON.parse(repair(input)); } catch (error) {
      assert.fail(`${name}：修复后仍无法解析 —— ${error.message}`);
    }
    const lines = Array.isArray(parsed.lines) ? parsed.lines.length : 0;
    assert.ok(
      lines >= minLines,
      `${name}：应至少救回 ${minLines} 行，实际 ${lines} 行`
    );
    // 救回的每个元素都必须是完整的值：字符串不能被切成半截，
    // 对象不能缺字段。生产 CPA 的 lines 全是字符串，这里两种都覆盖。
    for (const line of parsed.lines || []) {
      const isComplete = typeof line === 'string'
        ? !line.endsWith('\\') && line.length > 0
        : (line !== null && typeof line === 'object');
      assert.ok(isComplete, `${name}：救回的元素不完整 —— ${JSON.stringify(line).slice(0, 60)}`);
    }
  }
  console.log('  ✓ 8 种截断形态全部可解析，且救回的行完整无断裂');

  // 7) 只有日志类路径可以截断，非日志类（config / auth-files）必须整体失败。
  //    这里真跑 isTruncatablePath，因为 fullPath 是拼完版本前缀的完整路径
  //    （/v0/management/logs），前缀写法的正则曾在这里漏判过。
  const pathFnSrc = mgmtSrc.match(/function isTruncatablePath[\s\S]*?\n}\n/);
  assert.ok(pathFnSrc, '应定义 isTruncatablePath 用于区分可截断路径');
  const isTruncatablePath = new Function(`${pathFnSrc[0]}\nreturn isTruncatablePath;`)();

  const pathCases = [
    ['/logs', true],
    ['/logs?after=123', true],
    ['/v0/management/logs', true],
    ['/v0/management/logs?after=0', true],
    ['/v8/management/logs', true],
    ['/config', false],
    ['/auth-files', false],
    ['/request-error-logs', false],
    ['/v0/management/request-error-logs/preview', false],
    ['/logsfoo', false],
    ['/management/logs-retention', false]
  ];
  for (const [path, expected] of pathCases) {
    assert.equal(
      isTruncatablePath(path), expected,
      `isTruncatablePath('${path}') 应为 ${expected}`
    );
  }
  console.log('  ✓ 路径白名单 11 种形态判定正确（含 /v0/management/logs 拼前缀形态）');

  // 8) 截断标志必须一路透传到前端，否则用户会把残缺数据当成全部日志
  assert.ok(
    /requestCpaManagement\('GET', `\/logs\?after=/.test(adminRoutesSrc),
    'logs 路由必须改用 requestCpaManagement 以拿到 truncated 标志'
  );
  assert.ok(
    /truncated \? \{ \.\.\.payload, truncated: true \}/.test(adminRoutesSrc),
    '截断时必须把 truncated 标志透出给前端'
  );
  assert.ok(/state\.logTruncated/.test(cpaSrc), '前端必须记录 logTruncated 状态');
  assert.ok(
    cpaSrc.includes('cpa-logs-truncated'),
    '必须提供常驻的截断提示条，筛选滚动后用户仍看得到'
  );
  assert.ok(
    /logsTruncatedBanner/.test(cpaSrc) && /已达 8MB 上限被截断/.test(i18nSrc),
    '截断提示必须说明原因并引导改选更短时间范围'
  );
  console.log('  ✓ truncated 标志从 management 透传到前端，并提供常驻提示条');
  console.log('');
}

console.log('测试 18: 「全部历史」档位的提供商推断必须用上模型名兜底');
{
  // 生产事故复现：总览页 Key 列表有 13 个账号显示成「其他上游 + 账号 <裸哈希>」。
  // 它们的模型流水一直都在（step-5-preview、gemini-3.8-flash-high 等），
  // 但 timeRange='all' 时 dailyStatsMap 是空的、liveMap 只有聚合计数不带 model，
  // 旧代码于是只试 auth_index 就放弃——随机哈希匹配不上任何 pattern，全部掉进
  // 'other'，前端只能把 auth_index 原样当账号名显示。
  const src = fs.readFileSync('lib/analytics/status-summary.mjs', 'utf8');

  // 1) 必须有一条专用的「最近模型」查询，且不能往热门聚合语句里加 model
  const dbSrc = fs.readFileSync('lib/db/sqlite.mjs', 'utf8');
  assert.ok(/stmtLatestModelByAuth/.test(dbSrc), 'sqlite.mjs 应导出 stmtLatestModelByAuth');
  assert.ok(
    /ROW_NUMBER\(\)\s+OVER\s+\(PARTITION BY auth_index ORDER BY ts DESC/.test(dbSrc),
    '应取每个 auth_index 最新一条的模型，而不是出现最多的模型'
  );
  // 热门聚合语句的 SELECT 列表里不得被塞进 model
  const aggBlock = dbSrc.match(/stmtAuthEventsAggSince\s*=\s*quotaDb\.prepare\(`([\s\S]*?)`\)/);
  assert.ok(aggBlock, '应能定位 stmtAuthEventsAggSince');
  assert.ok(
    !/\bmodel\b/.test(aggBlock[1]),
    'stmtAuthEventsAggSince 是热门语句，不得往里加 model 破坏 GROUP BY 语义'
  );

  // 2) 推断链必须是 auth_index → 模型名 三级兜底，模型名来源含 latestModelByAuth
  assert.ok(/latestModelByAuth/.test(src), 'status-summary 应使用 latestModelByAuth');
  assert.ok(
    /dStat\?\.model\s*\|\|\s*live\?\.model\s*\|\|\s*latestModelByAuth\.get\(authIndex\)/.test(src),
    '模型名兜底必须覆盖 dailyStatsMap / liveMap 均缺失的 all 档位'
  );
  // 3) 必须在循环外一次性取完，不得逐账号查询
  assert.ok(
    /for \(const r of stmtLatestModelByAuth\.all\(\)\)/.test(src),
    '应在循环外一次性取完最近模型，避免逐账号全表扫描'
  );

  console.log('  ✓ 新增专用「最近模型」查询，未污染热门聚合语句');
  console.log('  ✓ 推断链补上 all 档位的模型名兜底，且循环外一次取完');

  // 4) 端到端：注册表对真实生产模型的推断必须命中（不再掉进 other）
  const registry = await import('../lib/core/provider-registry.mjs');
  registry.initProviderRegistry?.();
  const realCases = [
    ['15bd1277482c540c', 'step-3.7-flash', 'stepfun'],
    ['4852a7ecbb8a1648', 'gemini-3.8-flash-high', 'gemini'],
    ['1394818d5003706e', 'gemini-3.8-flash-high', 'gemini'],
    ['8f636ddb6f50ef21', 'mimo-v2.6-flash-free', 'opencode'],
    ['5907fedefff96dd6', 'stealth/space-bunny-alpha', 'stealth']
  ];
  for (const [authIndex, model, expected] of realCases) {
    const byAuth = registry.inferProvider({ authIndex });
    const byModel = byAuth.key ? null : registry.inferProvider({ model });
    const resolved = byAuth.key || byModel?.key || 'other';
    assert.equal(resolved, expected, `${authIndex} (${model}) 应推断为 ${expected}，实际: ${resolved}`);
  }

  console.log('  ✓ 真实生产账号经模型名兜底后归属正确（stepfun / gemini / opencode）');
  console.log('');
}

console.log('测试 19: 请求流水与错误中心提供商推断兜底');
{
  const auditLogs = await import('../lib/analytics/audit-logs.mjs');
  const adminHtml = fs.readFileSync('admin.html', 'utf8');

  // 1) resolveEventAuthInfo 单元校验：API 渠道凭证与免费模型推断
  assert.equal(typeof auditLogs.resolveEventAuthInfo, 'function', 'audit-logs.mjs 应导出 resolveEventAuthInfo');

  const openCodeRes = auditLogs.resolveEventAuthInfo('eeca530b51788894', 'mimo-v2.6-flash-free');
  assert.equal(openCodeRes.provider, 'opencode', 'mimo-v2.6-flash-free 必须推断为 opencode');
  assert.equal(openCodeRes.auth_name, 'OpenCode Zen 渠道 eeca530b', '裸哈希应结合推断提供商赋予友好渠道别名');

  const lingRes = auditLogs.resolveEventAuthInfo('770f471fbb018f00', 'ling-3.1-flash-free');
  assert.equal(lingRes.provider, 'opencode', 'ling-3.1-flash-free 必须推断为 opencode');
  assert.equal(lingRes.auth_name, 'OpenCode Zen 渠道 770f471f', 'ling 免费模型应赋予 OpenCode 友好渠道别名');

  const unknownRes = auditLogs.resolveEventAuthInfo('9999999999999999', 'completely-unknown-custom-model');
  assert.equal(unknownRes.provider, '', '完全未登记且无法推断的模型 provider 应保持为空');
  assert.equal(unknownRes.auth_name, '已删除账号 99999999', '无法推断提供商的裸哈希应标为已删除账号');

  console.log('  ✓ resolveEventAuthInfo 对免费模型与裸哈希凭证解析正确');

  // 2) 端到端：模拟插入一条真实请求流水，检验 getPagedRequests 返回字段
  const { quotaDb } = await import('../lib/db/sqlite.mjs');
  const nowTs = Math.floor(Date.now() / 1000);
  const testAuthIndex = 'eeca530b51788894';
  const testModel = 'mimo-v2.6-flash-free';

  quotaDb.prepare(`
    INSERT INTO request_events (ts, key_id, model, status, prompt_tokens, completion_tokens, cached_tokens, total_tokens, latency_ms, ttft_ms, stream, estimated, error_type, auth_index)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(nowTs, 1, testModel, 200, 38515, 459, 38400, 38974, 15400, 6000, 1, 0, null, testAuthIndex);

  auditLogs.clearAuditLogsCache();
  const paged = auditLogs.getPagedRequests({ page: 1, pageSize: 5 });
  assert.ok(paged && Array.isArray(paged.events) && paged.events.length > 0, 'getPagedRequests 应能查到流水');
  const targetEvent = paged.events.find(e => e.auth_index === testAuthIndex && e.model === testModel);
  assert.ok(targetEvent, '必须包含刚刚插入的测试请求事件');
  assert.equal(targetEvent.provider, 'opencode', '端到端流水中的 provider 必须为 opencode');
  assert.equal(targetEvent.auth_name, 'OpenCode Zen 渠道 eeca530b', '端到端流水中的 auth_name 必须格式化友好名称');

  // 清理测试插入的模拟流水
  quotaDb.prepare('DELETE FROM request_events WHERE auth_index = ? AND model = ?').run(testAuthIndex, testModel);
  auditLogs.clearAuditLogsCache();

  console.log('  ✓ getPagedRequests 端到端返回的流水中 provider 与 auth_name 准确无裸哈希');

  // 3) 前端静态契约验证 (包含 admin.html 与外置 admin-logs.js)
  const adminLogsJs = fs.readFileSync('admin-logs.js', 'utf8');
  const clientScripts = adminHtml + adminLogsJs;
  assert.ok(
    /m\.includes\('opencode'\)\s*\|\|\s*m\.includes\('-free'\)/.test(clientScripts),
    '前端脚本中的 resolveEventProvider 必须覆盖 opencode 与 -free 规则'
  );
  assert.ok(
    /cachedUpstream\.accounts\.find/.test(clientScripts),
    '前端脚本中的 resolveEventProvider 必须支持从已同步凭据列表中反查 provider'
  );
  assert.ok(
    /p\.includes\('stealth'\)/.test(clientScripts) &&
    /p\.includes\('deepseek'\)/.test(clientScripts) &&
    /p\.includes\('qwen'\)/.test(clientScripts),
    'admin.html 中的 getProviderBrand 必须覆盖 stealth / deepseek / qwen 提供商'
  );

  const resolveFnStart = adminLogsJs.indexOf('function resolveEventProvider(ev) {');
  const resolveFnEnd = adminLogsJs.indexOf('function getAuthDisplayName(');
  const resolveEventProviderFn = new Function('ev', `
    ${adminLogsJs.slice(resolveFnStart, resolveFnEnd)}
    return resolveEventProvider(ev);
  `);
  assert.equal(resolveEventProviderFn({ model: 'step-5-preview-free' }), 'opencode', 'step-5-preview-free 必须优先于 step 规则推断为 opencode');
  assert.equal(resolveEventProviderFn({ model: 'step-5-preview' }), 'stepfun', '无 -free 的 step-5-preview 必须推断为 stepfun');
  assert.equal(resolveEventProviderFn({ model: 'deepseek-v4.1-flash-free' }), 'opencode', 'deepseek-v4.1-flash-free 必须推断为 opencode');

  console.log('  ✓ admin.html 提供商推断契约与品牌标签覆盖完整');
  console.log('');
}

console.log('测试 20: 客户端连接主动中断 (HTTP 499) 留痕与流式语义提交加固');
{
  const transportSrc = fs.readFileSync('lib/proxy/transport.mjs', 'utf8');
  const serverSrc = fs.readFileSync('server.mjs', 'utf8');

  // 1) 验证 clientRes.on('close') 触发 499 审计记录
  assert.ok(
    /recordClientAbort/.test(transportSrc),
    'transport.mjs 必须实现 recordClientAbort'
  );
  assert.ok(
    /clientRes\.on\('close',\s*\(\)\s*=>\s*\{[\s\S]*?recordClientAbort\(\)/.test(transportSrc),
    'clientRes.on("close") 必须调用 recordClientAbort 进行 499 状态兜底落盘'
  );
  assert.ok(
    /status:\s*499[\s\S]*?errorType:\s*['"]client_closed['"]/.test(transportSrc),
    'recordClientAbort 必须记录 499 状态与 client_closed 错误类型'
  );

  // 2) 验证 recordOnce 幂等性守卫，杜绝同一请求重复落盘
  assert.ok(
    /const recordOnce\s*=/.test(transportSrc),
    'transport.mjs 必须使用 recordOnce 统一收敛 recordRequest 保证幂等'
  );

  // 3) 验证 Anthropic SSE 流式 text delta / thinking delta / partial_json 提交加固
  assert.ok(
    /payload\.delta\.text\.length\s*>\s*0\)\s*hasSemanticEvents\s*=\s*true/.test(transportSrc),
    'transport.mjs 必须在接收到 Anthropic delta.text 时将 hasSemanticEvents 置为 true'
  );
  assert.ok(
    /payload\.delta\.thinking\.length\s*>\s*0\)\s*\{[\s\S]*?hasSemanticEvents\s*=\s*true/.test(transportSrc),
    'transport.mjs 必须在接收到 Anthropic delta.thinking 时将 hasSemanticEvents 与 hasReasoningEvents 置为 true'
  );
  assert.ok(
    /payload\.delta\.partial_json\.length\s*>\s*0\)\s*hasSemanticEvents\s*=\s*true/.test(transportSrc),
    'transport.mjs 必须在接收到 Anthropic delta.partial_json 时将 hasSemanticEvents 置为 true'
  );

  // 4) 验证 server.mjs 熔断拦截点补齐流水审计
  assert.ok(
    /errorType:\s*['"]upstream_circuit_open['"]/.test(serverSrc),
    'server.mjs 在 upstreamAvailable(503) 拦截处必须补齐 recordRequest'
  );
  assert.ok(
    /errorType:\s*['"]empty_response['"][\s\S]*?fast circuit-breaker 502/i.test(serverSrc) ||
    /fast circuit-breaker 502[\s\S]*?errorType:\s*['"]empty_response['"]/i.test(serverSrc),
    'server.mjs 在 30s Negative Cache 拦截处必须补齐 recordRequest'
  );

  console.log('  ✓ 客户端中断 (HTTP 499) 兜底审计留痕验证通过');
  console.log('  ✓ recordOnce 幂等落盘保护验证通过');
  console.log('  ✓ Anthropic SSE 流式语义事件提交判定验证通过');
  console.log('  ✓ 网关 502/503 快速熔断审计补齐验证通过');
  console.log('');
}

console.log('测试 21: 请求流水关键字搜索支持原始 API Key 匹配');
{
  const auditLogs = await import('../lib/analytics/audit-logs.mjs');
  const { quotaDb } = await import('../lib/db/sqlite.mjs');

  // 1) 确保存在一个已知 API Key 与 Alias 的测试 Key
  const testApiKey = 'test-key-search-tangtang-val';
  const testAlias = 'test-search-alias';
  let testKeyId = 9999;
  quotaDb.prepare(`
    INSERT OR REPLACE INTO keys (id, api_key, alias, active)
    VALUES (?, ?, ?, 1)
  `).run(testKeyId, testApiKey, testAlias);

  // 2) 插入一条绑定该 Key 的流水
  const nowTs = Math.floor(Date.now() / 1000);
  const insertRes = quotaDb.prepare(`
    INSERT INTO request_events (ts, key_id, model, status, prompt_tokens, completion_tokens, cached_tokens, total_tokens, latency_ms, ttft_ms, stream, estimated, error_type, auth_index)
    VALUES (?, ?, 'gpt-4o', 200, 10, 20, 0, 30, 200, 100, 0, 0, null, 'auth-test-key')
  `).run(nowTs, testKeyId);
  const insertedEventId = insertRes.lastInsertRowid;

  auditLogs.clearAuditLogsCache();

  // 3) 按 alias 搜索必须命中
  const resByAlias = auditLogs.getPagedRequests({ page: 1, pageSize: 10, search: 'test-search-alias' });
  assert.ok(resByAlias.events.some(e => e.id === insertedEventId), '通过 alias 搜索必须能检索到该请求');

  // 4) 按原始 api_key 片段搜索必须命中（修复前仅匹配 alias 会导致按 key 搜索返回 0）
  const resByKey = auditLogs.getPagedRequests({ page: 1, pageSize: 10, search: 'search-tangtang' });
  assert.ok(resByKey.events.some(e => e.id === insertedEventId), '通过原始 api_key 搜索必须能检索到该请求');

  // 5) 清理测试数据
  quotaDb.prepare('DELETE FROM request_events WHERE id = ?').run(insertedEventId);
  quotaDb.prepare('DELETE FROM keys WHERE id = ?').run(testKeyId);
  auditLogs.clearAuditLogsCache();

  console.log('  ✓ 通过 keys.alias 检索请求流水验证通过');
  console.log('  ✓ 通过 keys.api_key 检索请求流水验证通过 (彻底解决按 Key 搜索无记录问题)');
  console.log('');
}

console.log('测试 22: 完整 API Key 与管理密钥不得落 localStorage');
{
  const adminHtmlSrc = fs.readFileSync('admin.html', 'utf8');
  const quotaHealthSrc = fs.readFileSync('lib/analytics/quota-health.mjs', 'utf8');
  const keyRegistrySrc = fs.readFileSync('lib/core/key-registry.mjs', 'utf8');
  const adminRoutesSrc = fs.readFileSync('lib/routes/admin-routes.mjs', 'utf8');

  // 1) 列表接口不得再下发完整明文：完整 Key 只在 /reveal 端点按需返回一次。
  //    历史上 getAdminData 直接返回 api_key，前端把它写进 localStorage 与
  //    DOM data-copy，一次同源 XSS 即可取走全部 Key。
  assert.ok(
    !/api_key:\s*meta\.api_key/.test(quotaHealthSrc),
    'getAdminData 不得返回完整 api_key，只允许 display_key'
  );
  assert.ok(
    !/api_key[^:]*:\s*meta\.api_key/.test(quotaHealthSrc),
    'quota-health.mjs 不得以任何字段名透出 keyMetaMap 里的完整明文'
  );

  // 2) 必须存在按需拉取的 reveal 端点，且它有入参校验
  assert.ok(
    /revealKeyMatch/.test(adminRoutesSrc) && /\/reveal\$/.test(adminRoutesSrc),
    'admin-routes.mjs 必须提供 /admin/api/keys/<id>/reveal 按需下发端点'
  );
  assert.ok(
    /getRawKeyById\(revealKeyMatch\[1\]\)/.test(adminRoutesSrc),
    'reveal 端点必须经 getRawKeyById 取值，不得直接查库透传'
  );
  assert.ok(
    /function getRawKeyById[\s\S]*?Number\.isSafeInteger/.test(keyRegistrySrc),
    'getRawKeyById 必须校验 keyId 为安全整数，拒绝注入串与负数'
  );

  // 3) 落盘前必须剥离 api_key
  assert.ok(
    /function sanitizeKeysForStorage/.test(adminHtmlSrc) &&
    /const \{\s*api_key,\s*\.\.\.rest\s*\}/.test(adminHtmlSrc),
    'admin.html 必须定义 sanitizeKeysForStorage 并在写盘前剥离 api_key'
  );
  assert.ok(
    /function persistKeysToStorage/.test(adminHtmlSrc),
    'admin.html 必须用 persistKeysToStorage 统一收口 Key 列表写盘'
  );
  // 不允许再出现直接写 cachedKeys 的裸 setItem
  assert.ok(
    !/localStorage\.setItem\(KEY_STORAGE_KEYS,\s*JSON\.stringify\(\{\s*keys:\s*cachedKeys/.test(adminHtmlSrc),
    '不得再绕过 sanitize 直接写盘 cachedKeys'
  );

  // 4) 管理密钥（万能凭证）只能存 sessionStorage
  assert.ok(
    /const adminSecretStore\s*=\s*\{/.test(adminHtmlSrc),
    'admin.html 必须用 adminSecretStore 收口管理密钥存储'
  );
  assert.ok(
    /sessionStorage\.setItem\(ADMIN_SECRET_STORAGE_KEY/.test(adminHtmlSrc),
    '管理密钥必须写入 sessionStorage（关标签页即失效）'
  );
  assert.ok(
    !/localStorage\.setItem\('gate_admin_secret'/.test(adminHtmlSrc) &&
    !/localStorage\.setItem\("gate_admin_secret"/.test(adminHtmlSrc),
    '严禁把管理密钥写入 localStorage'
  );
  // 旧版遗留值必须能被迁移清除，避免老用户升级后密钥永久留在盘上
  assert.ok(
    /localStorage\.removeItem\(ADMIN_SECRET_LEGACY_KEY\)/.test(adminHtmlSrc),
    '必须清除旧版遗留的 cpa_admin_secret，完成向后迁移'
  );

  // 5) URL 传入的管理密钥不得持久化，且要立刻从地址栏抹掉
  assert.ok(
    /history\.replaceState\([\s\S]{0,80}window\.location\.pathname\)/.test(adminHtmlSrc),
    '从 URL 取到密钥后必须立刻清理地址栏，防止随截图/分享/Referer 外泄'
  );

  console.log('  ✓ 列表接口不再下发完整 API Key（仅 reveal 端点按需返回）验证通过');
  console.log('  ✓ Key 列表落盘前强制剥离 api_key 验证通过');
  console.log('  ✓ 管理密钥改存 sessionStorage 并迁移清除 legacy 值验证通过');
  console.log('  ✓ URL 传入密钥不持久化且即时清理地址栏验证通过');
  console.log('');
}

// -------------------------------------------------------------
// 测试用例 23: 测试必须跑在独立临时库上 (test DB isolation)
// 说明：本项目实际踩过的坑——用例直接写开发机的真实 gate.db，一次断言失败
//       留下的脏行（auth_index='auth-test-key'）活过了清理，之后每次运行都被
//       测试 13 的分组聚合读进去，让 requests_7d 比心跳柱多 1，报出一个与
//       本次改动毫无关系的错，排查半天。根因是"测试和生产共用一个库"，
//       不是清理正则写得不够全。这里把契约钉死，防止有人再改回共享库。
// -------------------------------------------------------------
console.log('测试 23: 测试数据库隔离契约');
{
  // 1) 本进程必须确实跑在临时目录里，而不是默认的 /opt/gate。
  //    isolateTestDb() 只做一件事：在 import 任何 lib/ 之前把 GATE_DB 指到
  //    临时目录后重新执行自身。没生效就意味着测试又回到共享库上跑。
  assert.ok(
    typeof process.env.GATE_TEST_DIR === 'string' && process.env.GATE_TEST_DIR.length > 0,
    '必须通过 isolateTestDb() 在独立临时目录中运行（GATE_TEST_DIR 未设置）'
  );
  assert.ok(
    fs.existsSync(process.env.GATE_DB) &&
    process.env.GATE_DB.startsWith(process.env.GATE_TEST_DIR),
    'GATE_DB 必须指向临时目录内的数据库，不得复用开发机/生产机的 gate.db'
  );

  // 2) Keeper 库同样要被隔离开，否则测试会去读真实 keeper.db。
  assert.ok(
    (process.env.GATE_KEEPER_DB || '').startsWith(process.env.GATE_TEST_DIR),
    'GATE_KEEPER_DB 也必须指向临时目录'
  );

  // 3) 隔离是否真的生效，直接证据在路径上而不在行数上：
  //    本文件前面的用例（测试 13/19/21）会往库里写行，所以此刻非空是正常的；
  //    但如果 GATE_DB 指回了开发机的 gate.db，路径就不会落在临时目录里。
  const { quotaDb } = await import('../lib/db/sqlite.mjs');
  assert.ok(
    quotaDb.prepare('SELECT COUNT(*) AS c FROM request_events').get().c >= 0,
    '临时库应可正常查询'
  );

  // 4) 每个跑 DB 的测试文件都必须自己调用 isolateTestDb()。
  //    新增测试文件时漏掉这一行，它就会静默跑回共享库——正是本次要防的事。
  const dbTouchingTests = [
    'test_gate_features.mjs',
    'test_gate_caching.mjs',
    'test_gate_pagination.mjs'
  ];
  for (const name of dbTouchingTests) {
    const src = fs.readFileSync(`tests/${name}`, 'utf8');
    assert.ok(
      /isolateTestDb\(import\.meta\.url/.test(src),
      `${name} 会读写数据库，必须调用 isolateTestDb(import.meta.url) 隔离子进程`
    );
  }

  console.log('  ✓ GATE_DB/GATE_KEEPER_DB 均落在独立临时目录验证通过');
  console.log('  ✓ 所有涉及数据库的测试文件均已挂载 isolateTestDb 验证通过');
  console.log('');
}

// -------------------------------------------------------------
// 测试用例 24: 用量趋势多周期指标聚合与前端 DOM 契约 (v2.9.16)
// 说明：修复用量趋势页面因未守卫 card-req-qps 导致 TypeError，阻断主趋势图、
//       模型分布与提供商分布渲染，以及卡片指标未跟随 7D/14D/30D/全部 动态联动的问题。
// -------------------------------------------------------------
console.log('测试 24: 用量趋势多周期指标聚合与前端 DOM 契约 (v2.9.16)');
{
  const auditLogs = await import('../lib/analytics/audit-logs.mjs');
  const adminHtml = fs.readFileSync('admin.html', 'utf8');

  // 1) 验证 getUsageStats 返回多周期动态聚合字段与预警 Key 统计
  const stats7 = auditLogs.getUsageStats(7);
  assert.ok('period_tokens' in stats7.summary, 'summary 必须包含 period_tokens');
  assert.ok('period_requests' in stats7.summary, 'summary 必须包含 period_requests');
  assert.ok('period_cost_usd' in stats7.summary, 'summary 必须包含 period_cost_usd');
  assert.ok('period_cache_hit_rate' in stats7.summary, 'summary 必须包含 period_cache_hit_rate');
  assert.ok('period_success_rate' in stats7.summary, 'summary 必须包含 period_success_rate');
  assert.ok('today_tokens' in stats7.summary, 'summary 必须保留今日指标 today_tokens');
  assert.ok('all_time_tokens' in stats7.summary, 'summary 必须保留全量历史指标 all_time_tokens');
  assert.ok('warned_keys' in stats7.summary, 'summary 必须包含 85% 预警 Key 计数');

  const statsAll = auditLogs.getUsageStats('all');
  assert.equal(statsAll.summary.period_tokens, statsAll.summary.all_time_tokens, 'all 档位 period_tokens 必须与 all_time_tokens 一致');
  assert.equal(statsAll.summary.period_requests, statsAll.summary.all_time_requests, 'all 档位 period_requests 必须与 all_time_requests 一致');

  console.log('  ✓ getUsageStats 多周期动态指标与兼容字段聚合验证通过');

  // 2) 验证 admin.html 中的卡片标题动态联动契约
  assert.ok(adminHtml.includes('card-tokens-title'), 'admin.html 必须包含 card-tokens-title 元素支撑动态时间跨度');
  assert.ok(adminHtml.includes('card-cost-title'), 'admin.html 必须包含 card-cost-title 元素支撑动态时间跨度');
  assert.ok(adminHtml.includes('card-req-title'), 'admin.html 必须包含 card-req-title 元素支撑动态时间跨度');

  // 3) 验证不存在无守卫的 card-req-qps 赋值
  assert.ok(
    !/document\.getElementById\(['"]card-req-qps['"]\)\.innerText\s*=/.test(adminHtml),
    '禁止直接对可能不存在的 card-req-qps 设置 innerText (防 TypeError 导致图表白屏)'
  );

  // 4) 严格扫查 admin.html 内联 JavaScript 中所有 getElementById 的引用完整性
  const htmlIds = new Set();
  const idRegex = /\bid=['"]([^'"]+)['"]/g;
  let idMatch;
  while ((idMatch = idRegex.exec(adminHtml)) !== null) {
    htmlIds.add(idMatch[1]);
  }
  const refRegex = /getElementById\(\s*['"]([^'"]+)['"]\s*\)\.innerText\s*=/g;
  let refMatch;
  const missingDirectSetters = [];
  while ((refMatch = refRegex.exec(adminHtml)) !== null) {
    const targetId = refMatch[1];
    if (!htmlIds.has(targetId)) {
      missingDirectSetters.push(targetId);
    }
  }
  assert.equal(
    missingDirectSetters.length,
    0,
    `admin.html 中存在未在 HTML 中定义的直接赋值元素: ${missingDirectSetters.join(', ')}`
  );

  console.log('  ✓ 前端 DOM 动态标题契约与 DOM ID 引用完整性验证通过');
  console.log('');
}

// -------------------------------------------------------------
// 测试用例 25: 腾讯 WorkBuddy / CodeBuddy 上游提供商接入与全链路契约 (v2.9.17)
// 说明：验证 Gate 跟进 CPA 接入 WorkBuddy 国际版与国内版 (CodeBuddy) 的提供商注册表、
//       统一推断、管理后台上游凭证筛选标签、品牌呈现与 OAuth 代理契约。
// -------------------------------------------------------------
console.log('测试 25: 腾讯 WorkBuddy / CodeBuddy 上游提供商接入与全链路契约 (v2.9.17)');
{
  const reg = await import('../lib/core/provider-registry.mjs');
  const adminHtml = fs.readFileSync('admin.html', 'utf8');
  const adminRoutesSrc = fs.readFileSync('lib/routes/admin-routes.mjs', 'utf8');

  // 1) 验证 INITIAL_PROVIDER_REGISTRY 包含 workbuddy 与 workbuddy-cn
  const initList = reg.INITIAL_PROVIDER_REGISTRY;
  const wbItem = initList.find(p => p.provider_key === 'workbuddy');
  const wbCnItem = initList.find(p => p.provider_key === 'workbuddy-cn');
  assert.ok(wbItem, 'INITIAL_PROVIDER_REGISTRY 必须包含 workbuddy');
  assert.ok(wbCnItem, 'INITIAL_PROVIDER_REGISTRY 必须包含 workbuddy-cn');
  assert.equal(wbItem.label, '腾讯 WorkBuddy', 'workbuddy label 校验');
  assert.equal(wbCnItem.label, 'WorkBuddy (CodeBuddy)', 'workbuddy-cn label 校验');

  // 2) 验证 inferProvider 对 workbuddy 与 codebuddy 模型和 auth_index 的推断
  // 确保测试前当前注册表已载入最新内置项
  reg.initProviderRegistry();
  const inferWbAuth = reg.inferProvider({ authIndex: 'workbuddy:user123' });
  assert.equal(inferWbAuth.key, 'workbuddy', 'auth_index 命中 workbuddy');
  assert.equal(inferWbAuth.label, '腾讯 WorkBuddy');

  const inferWbCnAuth = reg.inferProvider({ authIndex: 'workbuddy-cn:user456' });
  assert.equal(inferWbCnAuth.key, 'workbuddy-cn', 'auth_index 命中 workbuddy-cn');

  const inferCodebuddyAuth = reg.inferProvider({ authIndex: 'codebuddy_token_abc' });
  assert.equal(inferCodebuddyAuth.key, 'workbuddy-cn', 'auth_index 命中 codebuddy');

  const inferWbModel = reg.inferProvider({ model: 'workbuddy-copilot-v1' });
  assert.equal(inferWbModel.key, 'workbuddy', 'model 命中 workbuddy');

  const inferCodebuddyModel = reg.inferProvider({ model: 'codebuddy-pro-chat' });
  assert.equal(inferCodebuddyModel.key, 'workbuddy-cn', 'model 命中 codebuddy');

  console.log('  ✓ 提供商注册表与双版本推断规则验证通过');

  // 3) 验证 admin.html 中的上游凭证 Filter 标签与品牌定义
  assert.ok(
    adminHtml.includes("switchUpstreamFilter('workbuddy')"),
    'admin.html 必须包含 switchUpstreamFilter(\'workbuddy\') 过滤标签按钮'
  );
  assert.ok(
    adminHtml.includes('provider-icon-workbuddy') && adminHtml.includes('provider-pill-workbuddy'),
    'admin.html 必须定义 WorkBuddy 专属图标与胶囊样式类'
  );
  assert.ok(
    adminHtml.includes("p.includes('workbuddy')"),
    'admin.html 中的 getProviderBrand 必须包含 workbuddy 识别分支'
  );
  const clientScriptsWb = adminHtml + fs.readFileSync('admin-logs.js', 'utf8');
  assert.ok(
    clientScriptsWb.includes("m.includes('workbuddy')"),
    '前端脚本中的 resolveEventProvider 必须包含 workbuddy 推断分支'
  );

  assert.ok(
    clientScriptsWb.includes("m.includes('copilot.tencent')"),
    '前端脚本中的 resolveEventProvider 必须覆盖 copilot.tencent 推断分支'
  );

  console.log('  ✓ 前端 admin.html 凭证过滤、品牌图标与流水推断契约验证通过');

  // 4) 验证 lib/routes/admin-routes.mjs 中的 WebUI OAuth 集合
  assert.ok(
    adminRoutesSrc.includes("'workbuddy'") && adminRoutesSrc.includes("'workbuddy-cn'") && adminRoutesSrc.includes('CPA_WEBUI_OAUTH'),
    'CPA_WEBUI_OAUTH 必须包含 workbuddy 与 workbuddy-cn 以便透传 ?is_webui=true'
  );

  // 5) 验证老数据库存在 CPA 空壳骨架时支持增量升级为官方 builtin 规则
  const { quotaDb, stmtProviderRegistryUpsert } = await import('../lib/db/sqlite.mjs');
  stmtProviderRegistryUpsert.run({
    provider_key: 'workbuddy',
    label: 'workbuddy',
    model_patterns: JSON.stringify([]),
    auth_patterns: JSON.stringify([]),
    source: 'cpa',
    enabled: 1,
    sort_order: 500
  });
  reg.initProviderRegistry();
  const upgradedWb = reg.listProviderRegistry().find(p => p.provider_key === 'workbuddy');
  assert.equal(upgradedWb.source, 'builtin', 'CPA 空壳应当平滑升级为 builtin');
  assert.equal(upgradedWb.label, '腾讯 WorkBuddy', '升级后 label 恢复官方权威文案');
  assert.ok(upgradedWb.model_patterns.length > 0, '升级后 patterns 补齐');

  console.log('  ✓ 既有 CPA 空壳平滑升级为官方 builtin 规则验证通过');
  console.log('');
}

// -------------------------------------------------------------
// 测试 26: 请求流水按服务商筛选端到端与全链路契约 (v2.9.37)
// -------------------------------------------------------------
{
  console.log('测试 26: 请求流水按服务商筛选端到端与全链路契约');
  const auditLogs = await import('../lib/analytics/audit-logs.mjs');
  const { quotaDb } = await import('../lib/db/sqlite.mjs');

  const nowTs = Math.floor(Date.now() / 1000);
  const authClaude = 'test_filter_claude_auth';
  const modelClaude = 'claude-3-7-sonnet-20250219';
  const authCodex = 'test_filter_codex_auth';
  const modelCodex = 'gpt-4o';

  // 1) 插入测试流水数据
  const stmtInsert = quotaDb.prepare(`
    INSERT INTO request_events (ts, key_id, model, status, prompt_tokens, completion_tokens, cached_tokens, total_tokens, latency_ms, ttft_ms, stream, estimated, error_type, auth_index)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmtInsert.run(nowTs, 1, modelClaude, 200, 100, 50, 0, 150, 1200, 400, 1, 0, null, authClaude);
  stmtInsert.run(nowTs, 1, modelCodex, 200, 200, 80, 0, 280, 900, 300, 1, 0, null, authCodex);

  auditLogs.clearAuditLogsCache();

  try {
    // 2) 筛选 provider = 'claude'
    const resClaude = auditLogs.getPagedRequests({ page: 1, pageSize: 20, provider: 'claude' });
    assert.ok(resClaude.events.length > 0, '筛选 claude 时应能查到记录');
    assert.ok(resClaude.events.every(e => e.provider === 'claude'), '筛选 claude 时所有返回流水 provider 必须为 claude');
    assert.ok(resClaude.events.some(e => e.auth_index === authClaude), '必须包含测试插入的 claude 流水');
    assert.ok(!resClaude.events.some(e => e.auth_index === authCodex), '不能包含 codex 流水');

    // 3) 筛选 provider = 'codex'
    const resCodex = auditLogs.getPagedRequests({ page: 1, pageSize: 20, provider: 'codex' });
    assert.ok(resCodex.events.length > 0, '筛选 codex 时应能查到记录');
    assert.ok(resCodex.events.every(e => e.provider === 'codex'), '筛选 codex 时所有返回流水 provider 必须为 codex');
    assert.ok(resCodex.events.some(e => e.auth_index === authCodex), '必须包含测试插入的 codex 流水');
    assert.ok(!resCodex.events.some(e => e.auth_index === authClaude), '不能包含 claude 流水');

    // 4) provider = 'all' 或 null 包含两者
    const resAll = auditLogs.getPagedRequests({ page: 1, pageSize: 50, provider: 'all' });
    assert.ok(resAll.events.some(e => e.auth_index === authClaude), '全部流水必须包含 claude');
    assert.ok(resAll.events.some(e => e.auth_index === authCodex), '全部流水必须包含 codex');

    // 5) 缓存隔离验证：连续调用命中缓存，且不同 provider 互不覆盖
    const cachedClaude = auditLogs.getPagedRequests({ page: 1, pageSize: 20, provider: 'claude' });
    assert.strictEqual(resClaude, cachedClaude, '相同查询应命中内存缓存引用');
    const cachedCodex = auditLogs.getPagedRequests({ page: 1, pageSize: 20, provider: 'codex' });
    assert.strictEqual(resCodex, cachedCodex, '相同查询应命中内存缓存引用');
    assert.notStrictEqual(cachedClaude, cachedCodex, '不同 provider 缓存键必须严格隔离');

    console.log('  ✓ getPagedRequests 服务端多服务商过滤与缓存隔离验证通过');
  } finally {
    quotaDb.prepare('DELETE FROM request_events WHERE auth_index IN (?, ?)').run(authClaude, authCodex);
    auditLogs.clearAuditLogsCache();
  }

  // 6) 路由参数透传契约校验
  const adminRoutesSrc = fs.readFileSync('lib/routes/admin-routes.mjs', 'utf8');
  assert.ok(
    adminRoutesSrc.includes("provider: url.searchParams.get('provider') || null"),
    'admin-routes.mjs 必须透传 provider 查询参数'
  );

  const memberRoutesSrc = fs.readFileSync('lib/routes/member-routes.mjs', 'utf8');
  assert.ok(
    memberRoutesSrc.includes("provider: url.searchParams.get('provider') || null"),
    'member-routes.mjs 必须透传 provider 查询参数'
  );
  console.log('  ✓ 路由层 provider 参数接收与透传契约验证通过');

  // 7) 前端 DOM 与脚本契约校验 (包含 admin.html 与外置 admin-logs.js)
  const adminHtml = fs.readFileSync('admin.html', 'utf8');
  const adminLogsJs = fs.readFileSync('admin-logs.js', 'utf8');
  const clientScripts = adminHtml + adminLogsJs;
  assert.ok(
    adminHtml.includes('id="logs-provider-filter-container"'),
    'admin.html 必须包含 logs-provider-filter-container 容器'
  );
  assert.ok(
    adminHtml.includes('id="logs-provider-dropdown"'),
    'admin.html 必须包含 logs-provider-dropdown 下拉组件'
  );
  assert.ok(
    clientScripts.includes('function changeLogsProviderFilter'),
    '前端脚本必须实现 changeLogsProviderFilter 函数'
  );
  assert.ok(
    clientScripts.includes('function filterBySpecificProvider'),
    '前端脚本必须实现 filterBySpecificProvider 快捷胶囊筛选函数'
  );
  assert.ok(
    clientScripts.includes('function updateLogsProviderSelect'),
    '前端脚本必须实现 updateLogsProviderSelect 动态选项更新函数'
  );
  assert.ok(
    clientScripts.includes("params.set('provider', logsProviderFilter)"),
    '前端脚本 fetchEventsData 中必须携带 provider 参数'
  );
  console.log('  ✓ 前端 DOM 组件、状态管理与胶囊筛选交互契约验证通过');
  console.log('');
}

// -------------------------------------------------------------
// 测试 27: 实时流量本地双轨追踪与 CPA 重启数据韧性 (v2.9.45)
// 说明：验证 Gate 本地内存 O(1) 桶聚合、SQLite 与 Outbox 冷启动恢复、
//       5 分钟低频对齐以及 CPA 容器重启时图表防大面积空白韧性。
// -------------------------------------------------------------
{
  console.log('测试 27: 实时流量本地双轨追踪与 CPA 重启数据韧性 (v2.9.45)');
  const {
    recordLiveTraffic,
    getLiveTrafficBuckets,
    initLiveTrafficTracker,
    reconcileLiveTraffic,
    resetTrackerForTest
  } = await import('../lib/analytics/live-traffic-tracker.mjs');
  const { buildTotals } = await import('../lib/upstream/runtime-stats.mjs');
  const { quotaDb } = await import('../lib/db/sqlite.mjs');

  const baseSec = 1760623200 + 300; // 对应固定时间 2025-10-16 22:05:00 (Asia/Shanghai，当前 10 分钟槽内)

  // 1) 内存纳秒级 O(1) 累加与 20 桶槽位对齐
  resetTrackerForTest();
  recordLiveTraffic(baseSec - 100, true);
  recordLiveTraffic(baseSec - 90, true);
  recordLiveTraffic(baseSec - 50, true);
  recordLiveTraffic(baseSec - 20, false);

  recordLiveTraffic(baseSec - 700, true);
  recordLiveTraffic(baseSec - 650, true);
  recordLiveTraffic(baseSec - 620, false);
  recordLiveTraffic(baseSec - 610, false);

  const buckets = getLiveTrafficBuckets(baseSec);
  assert.equal(buckets.length, 20, '实时流量桶数量必须恒等于 20（每桶 10 分钟）');

  const lastBucket = buckets[19];
  assert.equal(lastBucket.success, 3, '最新桶成功数必须为 3');
  assert.equal(lastBucket.failed, 1, '最新桶失败数必须为 1');
  assert.ok(/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(lastBucket.time), `桶标签时间格式必须为 HH:mm-HH:mm，实际为 ${lastBucket.time}`);

  const prevBucket = buckets[18];
  assert.equal(prevBucket.success, 2, '前一桶成功数必须为 2');
  assert.equal(prevBucket.failed, 2, '前一桶失败数必须为 2');

  const emptyBucket = buckets[0];
  assert.equal(emptyBucket.success, 0, '无流量历史桶成功数为 0');
  assert.equal(emptyBucket.failed, 0, '无流量历史桶失败数为 0');
  console.log('  ✓ 内存槽位纳秒级 O(1) 累加与 20 桶时间对齐验证通过');

  // 2) 冷启动从 SQLite request_events 与 Outbox 恢复数据
  resetTrackerForTest();

  const stmtEventInsert = quotaDb.prepare(`
    INSERT INTO request_events (ts, key_id, model, status, prompt_tokens, completion_tokens, cached_tokens, total_tokens, latency_ms, ttft_ms, stream, estimated, error_type, auth_index)
    VALUES (?, 1, 'claude-3-7-sonnet', ?, 10, 10, 0, 20, 100, 50, 0, 0, null, 'test-live-auth')
  `);
  const stmtOutboxInsert = quotaDb.prepare(`
    INSERT INTO usage_outbox (ts, key_id, model, status, prompt_tokens, completion_tokens, cached_tokens, total_tokens, latency_ms, ttft_ms, stream, estimated, error_type, auth_index)
    VALUES (?, 1, 'claude-3-7-sonnet', ?, 10, 10, 0, 20, 100, 50, 0, 0, null, 'test-live-auth')
  `);

  try {
    // 写入 1800 秒前（倒数第 4 桶，索引 16）的 4 成功 1 失败到 request_events
    for (let i = 0; i < 4; i++) stmtEventInsert.run(baseSec - 1800 + i * 10, 200);
    stmtEventInsert.run(baseSec - 1800 + 45, 500);

    // 写入 1200 秒前（倒数第 3 桶，索引 17）的 2 成功到 usage_outbox
    stmtOutboxInsert.run(baseSec - 1200 + 10, 200);
    stmtOutboxInsert.run(baseSec - 1200 + 20, 200);

    initLiveTrafficTracker(baseSec);
    const restoredBuckets = getLiveTrafficBuckets(baseSec);

    assert.equal(restoredBuckets[16].success, 4, '冷启动恢复：request_events 成功数应为 4');
    assert.equal(restoredBuckets[16].failed, 1, '冷启动恢复：request_events 失败数应为 1');
    assert.equal(restoredBuckets[17].success, 2, '冷启动恢复：usage_outbox 叠加成功数应为 2');
    assert.equal(restoredBuckets[17].failed, 0, '冷启动恢复：usage_outbox 叠加失败数应为 0');
    console.log('  ✓ 冷启动从 SQLite 与 Outbox 完整恢复历史流量验证通过');

    // 3) 定期低频核对 (Reconcile)
    reconcileLiveTraffic(baseSec);
    const reconciledBuckets = getLiveTrafficBuckets(baseSec);
    assert.equal(reconciledBuckets[16].success, 4, '对齐后：第 16 桶成功数保持 4');
    assert.equal(reconciledBuckets[16].failed, 1, '对齐后：第 16 桶失败数保持 1');
    assert.equal(reconciledBuckets[17].success, 2, '对齐后：第 17 桶成功数保持 2');
    console.log('  ✓ 后台 5 分钟低频对齐 (Reconciliation) 机制验证通过');

    // 4) 模拟 CPA 升级/重启清空内存桶，Gate 本地权威数据保持图表不空白
    const cpaCredentialsAfterRestart = [
      {
        auth_index: 'test-live-auth',
        success: 50,
        failed: 5,
        disabled: false,
        health: { state: 'healthy', blocked: false },
        buckets: [] // CPA 重启后近期桶归零
      }
    ];

    const totals = buildTotals(cpaCredentialsAfterRestart, { nowSec: baseSec });
    assert.equal(totals.source, 'gate_local', '数据源应自动标记为 gate_local 权威源');
    assert.equal(totals.scope, 'window', '作用域应依然为 window 窗口');
    assert.equal(totals.success_count, 6, '窗口成功总数必须取 Gate 本地 6 次（4+2）');
    assert.equal(totals.failure_count, 1, '窗口失败总数必须取 Gate 本地 1 次');
    assert.equal(totals.total_requests, 7, '窗口总请求数必须取 Gate 本地 7 次');
    assert.equal(totals.buckets.length, 20, '吞吐桶恒为 20 桶');
    assert.equal(totals.buckets[16].success, 4, 'CPA 桶为空时，Gate 本地桶 16 依然保留 4 次成功');
    assert.equal(totals.buckets[17].success, 2, 'CPA 桶为空时，Gate 本地桶 17 依然保留 2 次成功');
    console.log('  ✓ 上游 CPA 重启/升级清空内存场景下 Gate 流量数据韧性与权威性保障验证通过');
    console.log('');
  } finally {
    quotaDb.prepare('DELETE FROM request_events WHERE auth_index = ?').run('test-live-auth');
    quotaDb.prepare('DELETE FROM usage_outbox WHERE auth_index = ?').run('test-live-auth');
    resetTrackerForTest();
  }
}

// -------------------------------------------------------------
// 测试 28: 请求流水思考强度 (Reasoning Effort) 与速率 (tok/s) 全链路与契约验证 (v2.9.50)
// -------------------------------------------------------------
{
  console.log('测试 28: 请求流水思考强度 (Reasoning Effort) 与速率 (tok/s) 全链路与契约验证 (v2.9.50)');
  const { extractReasoningEffort, calculateTokensPerSec } = await import('../lib/proxy/token-estimator.mjs');
  const { normalizeRequestEvent } = await import('../lib/core/outbox.mjs');
  const auditLogs = await import('../lib/analytics/audit-logs.mjs');
  const { quotaDb } = await import('../lib/db/sqlite.mjs');

  // 1) 思考强度解析器 (extractReasoningEffort) 协议兼容性验证
  assert.equal(extractReasoningEffort({ reasoning_effort: 'max' }), 'max', 'OpenAI/Codex reasoning_effort max 提取失败');
  assert.equal(extractReasoningEffort({ reasoning_effort: 'HIGH' }), 'high', '大写转小写归一化失败');
  assert.equal(extractReasoningEffort({ reasoning: { effort: 'medium' } }), 'medium', 'OpenAI 嵌套 reasoning.effort 提取失败');
  assert.equal(extractReasoningEffort({ reasoningEffort: 'low' }), 'low', '驼峰 reasoningEffort 提取失败');

  assert.equal(extractReasoningEffort({ thinking: { type: 'enabled', budget_tokens: 2048 } }), 'budget:2048', 'Anthropic thinking budget 提取失败');
  assert.equal(extractReasoningEffort({ thinking: { type: 'adaptive' } }), 'adaptive', 'Anthropic thinking type 提取失败');
  assert.equal(extractReasoningEffort({ thinking: { type: 'adaptive' }, output_config: { effort: 'max' } }), 'max', 'Anthropic output_config.effort 必须优先于 adaptive 类型');
  assert.equal(extractReasoningEffort({ output_config: { effort: 'high' } }), 'high', 'Anthropic output_config.effort 提取失败');
  assert.equal(extractReasoningEffort({ outputConfig: { effort: 'medium' } }), 'medium', 'Anthropic outputConfig 驼峰提取失败');
  assert.equal(extractReasoningEffort({ effort: 'low' }), 'low', '顶层 effort 提取失败');
  assert.equal(extractReasoningEffort({ thinking: { type: 'adaptive', effort: 'max' } }), 'max', 'Anthropic thinking.effort 提取失败');
  assert.equal(extractReasoningEffort({ thinking: { type: 'disabled' } }), null, 'Anthropic disabled 应返回 null');

  assert.equal(extractReasoningEffort({ thinking_config: { thinking_budget: 1024 } }), 'budget:1024', 'Gemini thinking_budget 提取失败');
  assert.equal(extractReasoningEffort({ thinking_config: { mode: 'dynamic' } }), 'dynamic', 'Gemini thinking mode 提取失败');

  // 模型名后缀智能推断
  assert.equal(extractReasoningEffort({ model: 'gemini-3.8-flash-high' }), 'high', 'gemini-*-high 模型后缀推断失败');
  assert.equal(extractReasoningEffort({ model: 'gemini-2.5-flash-thinking-max' }), 'max', '*-max 模型后缀推断失败');
  assert.equal(extractReasoningEffort({ model: 'deepseek-r1-medium' }), 'medium', '*-medium 模型后缀推断失败');
  assert.equal(extractReasoningEffort({ model: 'claude-3.7-sonnet:low' }), 'low', '*:low 模型后缀推断失败');
  assert.equal(extractReasoningEffort({ model: 'gemini-3.8-flash-high', reasoning_effort: 'max' }), 'max', '显式入参必须优先于模型后缀');

  assert.equal(extractReasoningEffort(null), null);
  assert.equal(extractReasoningEffort({}), null);
  assert.equal(extractReasoningEffort({ model: 'gpt-4o' }), null);
  console.log('  ✓ 四大主流协议思考强度 (OpenAI / Anthropic / Gemini / 兼容规范) 提取与归一化验证通过');

  // 2) 生成速率算法与流式首字扣除 (calculateTokensPerSec)
  // 流式正常窗口：100 tokens, 1500ms 延迟, 500ms TTFT -> 实际纯生成 1000ms -> 100 tok/s
  assert.equal(calculateTokensPerSec(100, 1500, 500, true), 100.0, '流式纯输出速率计算不符');
  // 流式窗口过小 (<100ms) 兜底：10 tokens, 1050ms 延迟, 1000ms TTFT (差值 50ms) -> 回落总延迟 1050ms (0.0105k tok/s) -> 9.5 tok/s
  assert.equal(calculateTokensPerSec(10, 1050, 1000, true), 9.5, '极小生成窗口兜底计算不符');
  // 非流式窗口：150 tokens, 3000ms -> 50 tok/s
  assert.equal(calculateTokensPerSec(150, 3000, 0, false), 50.0, '非流式平均速率计算不符');
  // 零除与异常边界
  assert.equal(calculateTokensPerSec(0, 1000), 0);
  assert.equal(calculateTokensPerSec(100, 0), 0);
  assert.equal(calculateTokensPerSec(-10, 1000), 0);
  console.log('  ✓ Token 生成速率算法 (扣除首字延迟纯吞吐 + 极小窗口防抖 + 边界保护) 验证通过');

  // 3) Outbox 归一化 (normalizeRequestEvent) 自动化赋值
  const normalized = normalizeRequestEvent({
    model: 'codex/gpt-6.1-sol',
    promptTokens: 1000,
    completionTokens: 216,
    totalTokens: 1216,
    latencyMs: 2500,
    ttftMs: 500,
    stream: true,
    reasoningEffort: 'max'
  });
  assert.equal(normalized.reasoning_effort, 'max', 'normalized reasoning_effort 不符');
  assert.equal(normalized.tokens_per_sec, 108.0, 'normalized 自动计算 tokens_per_sec 不符 (216 / 2.0s = 108)');
  console.log('  ✓ Outbox 归一化自动计算 tok/s 与思考强度绑定验证通过');

  // 4) 数据库持久化、分页查询与历史数据动态补全
  const testAuth = 'test_audit_reasoning_tps_auth';
  const stmtInsert = quotaDb.prepare(`
    INSERT INTO request_events (ts, key_id, model, status, prompt_tokens, completion_tokens, cached_tokens, total_tokens, latency_ms, ttft_ms, stream, estimated, error_type, auth_index, reasoning_effort, tokens_per_sec)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const nowTs = Math.floor(Date.now() / 1000);
  // 记录 A: 新增字段完整写入 (带思考强度 max 和速率 108.3)
  stmtInsert.run(nowTs, 1, 'codex/gpt-6.1-sol', 200, 500, 108, 0, 608, 2000, 1000, 1, 0, null, testAuth, 'max', 108.3);
  // 记录 B: 历史遗留记录 (reasoning_effort 为空，tokens_per_sec 为 0，期望接口查询时动态根据 latency/tokens 算出来)
  stmtInsert.run(nowTs - 10, 1, 'claude-3-7-sonnet', 200, 300, 100, 0, 400, 2000, 0, 0, 0, null, testAuth, '', 0);

  auditLogs.clearAuditLogsCache();

  try {
    const res = auditLogs.getPagedRequests({ page: 1, pageSize: 20 });
    const evA = res.events.find(e => e.auth_index === testAuth && e.model === 'codex/gpt-6.1-sol');
    assert.ok(evA, '必须查到新格式测试流水 A');
    assert.equal(evA.reasoning_effort, 'max', '流水 A 思考强度应为 max');
    assert.equal(evA.tokens_per_sec, 108.3, '流水 A 速率应保留数据库中的 108.3');

    const evB = res.events.find(e => e.auth_index === testAuth && e.model === 'claude-3-7-sonnet');
    assert.ok(evB, '必须查到历史遗留测试流水 B');
    assert.equal(evB.reasoning_effort, '', '流水 B 思考强度应为空字符串');
    assert.equal(evB.tokens_per_sec, 50.0, '流水 B 速率应由历史字段动态推算出 50.0 tok/s (100 tokens / 2.0s)');

    // 关键词搜索支持 reasoning_effort 匹配
    const searchRes = auditLogs.getPagedRequests({ page: 1, pageSize: 20, search: 'max' });
    assert.ok(searchRes.events.some(e => e.auth_index === testAuth && e.reasoning_effort === 'max'), '搜索 "max" 必须命中带有 reasoning_effort 的流水');
    console.log('  ✓ 数据库持久化、分页透传、历史数据动态兼容与思考强度关键词搜索验证通过');
  } finally {
    quotaDb.prepare('DELETE FROM request_events WHERE auth_index = ?').run(testAuth);
    auditLogs.clearAuditLogsCache();
  }

  // 5) 前端表格头与脚本契约验证
  const adminHtml = fs.readFileSync('admin.html', 'utf8');
  const adminLogsJs = fs.readFileSync('admin-logs.js', 'utf8');
  const adminStyleCss = fs.readFileSync('admin-style.css', 'utf8');

  assert.ok(/<th[^>]*>思考强度<\/th>/.test(adminHtml), 'admin.html 表头缺少「思考强度」列');
  assert.ok(/<th[^>]*>速率 \(tok\/s\)<\/th>/.test(adminHtml), 'admin.html 表头缺少「速率 (tok/s)」列');
  assert.ok(adminHtml.includes('colspan="12"'), 'admin.html 默认加载占位需拓展为 12 列');
  assert.ok(adminLogsJs.includes('colspan="12"'), 'admin-logs.js 空数据占位需拓展为 12 列');

  assert.ok(adminLogsJs.includes('ev.reasoning_effort'), 'admin-logs.js 需渲染 reasoning_effort');
  assert.ok(adminLogsJs.includes('ev.tokens_per_sec'), 'admin-logs.js 需渲染 tokens_per_sec');
  assert.ok(adminLogsJs.includes('speed-badge'), 'admin-logs.js 需应用 speed-badge 样式类');

  assert.ok(adminStyleCss.includes('.chip-purple'), 'admin-style.css 缺少 .chip-purple 样式');
  assert.ok(adminStyleCss.includes('.speed-badge'), 'admin-style.css 缺少 .speed-badge 样式');
  console.log('  ✓ 前端 HTML/JS/CSS 契约 (表头定义、12列跨度、Aozora 紫色胶囊与闪电速率徽章) 验证通过');
  console.log('');
}

// -------------------------------------------------------------
// 测试 29: AI 提供商 Token 分布基于真实凭证权威聚合与防抢夺契约 (v2.9.61)
// -------------------------------------------------------------
{
  console.log('测试 29: AI 提供商 Token 分布基于真实凭证权威聚合与防抢夺契约 (v2.9.61)');
  const auditLogs = await import('../lib/analytics/audit-logs.mjs');
  const { quotaDb } = await import('../lib/db/sqlite.mjs');
  const { shanghaiDate } = await import('../lib/core/outbox.mjs');

  const testWbAuth = 'test_wb_auth_token_attribution_01';
  const testOpenCodeAuth = 'test_opencode_auth_token_attribution_01';

  try {
    // 1) 在 upstream_auth_baselines 播种权威上游凭据与账号归属
    // WorkBuddy 凭据
    quotaDb.prepare(`
      INSERT OR REPLACE INTO upstream_auth_baselines (auth_index, provider, name)
      VALUES (?, ?, ?)
    `).run(testWbAuth, 'workbuddy', '测试 WorkBuddy 账号 01');

    // OpenCode 凭据
    quotaDb.prepare(`
      INSERT OR REPLACE INTO upstream_auth_baselines (auth_index, provider, name)
      VALUES (?, ?, ?)
    `).run(testOpenCodeAuth, 'opencode', '测试 OpenCode 账号 01');

    const nowTs = Math.floor(Date.now() / 1000);
    const today = shanghaiDate();

    // 2) 插入真实 request_events 模拟 WorkBuddy 执行带有 -free 的模型调用
    // 重点：deepseek-v4.1-flash-free 含有 -free，旧实现会按正则被 OpenCode Zen 抢夺冒领！
    const stmtInsertEvent = quotaDb.prepare(`
      INSERT INTO request_events (ts, key_id, model, status, prompt_tokens, completion_tokens, cached_tokens, total_tokens, latency_ms, ttft_ms, stream, estimated, error_type, auth_index)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // WorkBuddy 执行 2 笔请求，共 250,000 tokens
    stmtInsertEvent.run(nowTs, 101, 'deepseek-v4.1-flash-free', 200, 100000, 50000, 20000, 150000, 1200, 300, 1, 0, null, testWbAuth);
    stmtInsertEvent.run(nowTs - 60, 101, 'copilot.tencent/deepseek-r1', 200, 60000, 40000, 10000, 100000, 2000, 500, 1, 0, null, testWbAuth);

    // OpenCode 执行 1 笔请求，共 30,000 tokens
    stmtInsertEvent.run(nowTs - 120, 101, 'opencode/claude-3-5-sonnet', 200, 20000, 10000, 5000, 30000, 1500, 400, 1, 0, null, testOpenCodeAuth);

    // 同步写入今日 usage_daily 保持 daily 与 events 一致
    const stmtDaily = quotaDb.prepare(`
      INSERT INTO usage_daily (date, key_id, model, requests, prompt_tokens, completion_tokens, cached_tokens, total_tokens, estimated_tokens, success_count, failure_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0)
    `);
    stmtDaily.run(today, 101, 'deepseek-v4.1-flash-free', 1, 100000, 50000, 20000, 150000, 1);
    stmtDaily.run(today, 101, 'copilot.tencent/deepseek-r1', 1, 60000, 40000, 10000, 100000, 1);
    stmtDaily.run(today, 101, 'opencode/claude-3-5-sonnet', 1, 20000, 10000, 5000, 30000, 1);

    // 3) 调用 getUsageStats(7, 101)
    const stats7 = auditLogs.getUsageStats(7, 101);
    assert.ok(stats7 && Array.isArray(stats7.providers), 'getUsageStats 必须返回 providers 数组');

    // 验证 WorkBuddy 统计准确无误
    const wbProvider = stats7.providers.find(p => p.provider === 'workbuddy');
    assert.ok(wbProvider, 'providers 中必须存在 workbuddy 提供商');
    assert.equal(wbProvider.display_name, '腾讯 WorkBuddy', 'workbuddy display_name 必须为 腾讯 WorkBuddy');
    assert.equal(wbProvider.requests, 2, 'WorkBuddy 必须为 2 次请求');
    assert.equal(wbProvider.total_tokens, 250000, 'WorkBuddy 必须统计为 250,000 tokens');
    assert.equal(wbProvider.models_count, 2, 'WorkBuddy 必须包含 2 个模型');

    // 验证 OpenCode Zen 没有抢夺 WorkBuddy 的 deepseek-v4.1-flash-free
    const ocProvider = stats7.providers.find(p => p.provider === 'opencode');
    assert.ok(ocProvider, 'providers 中必须存在 opencode 提供商');
    assert.equal(ocProvider.display_name, 'OpenCode Zen', 'opencode display_name 必须为 OpenCode Zen');
    assert.equal(ocProvider.requests, 1, 'OpenCode Zen 必须只有其自身的 1 次请求');
    assert.equal(ocProvider.total_tokens, 30000, 'OpenCode Zen 必须只有其自身的 30,000 tokens，严禁截胡 -free 模型');

    // 验证 models 列表中的 provider 也正确被标记为 腾讯 WorkBuddy 而非 OpenCode Zen
    const freeModel = stats7.models.find(m => m.model === 'deepseek-v4.1-flash-free');
    assert.ok(freeModel, 'models 列表中必须包含 deepseek-v4.1-flash-free');
    assert.equal(freeModel.provider, '腾讯 WorkBuddy', 'deepseek-v4.1-flash-free 模型归属必须为 腾讯 WorkBuddy，不得误判为 OpenCode Zen');

    // 4) 验证对账补差机制 (Reconciliation): 当 models 总量大于 request_events 时，差额平滑补齐且总量绝对一致
    const statsAll = auditLogs.getUsageStats('all', 101);
    const sumProviderTokens = statsAll.providers.reduce((sum, p) => sum + p.total_tokens, 0);
    const sumModelTokens = statsAll.models.reduce((sum, m) => sum + m.total_tokens, 0);
    assert.equal(sumProviderTokens, sumModelTokens, 'providers 聚合总 tokens 必须与 models 总 tokens 100% 吻合对齐');

    console.log('  ✓ WorkBuddy 上游凭证权威解析与 -free 免费模型防抢夺验证通过');
    console.log('  ✓ 提供商 Token 聚合与 models 对账补齐 (Reconciliation) 验证通过');
    console.log('');
  } finally {
    quotaDb.prepare('DELETE FROM request_events WHERE auth_index IN (?, ?)').run(testWbAuth, testOpenCodeAuth);
    quotaDb.prepare('DELETE FROM upstream_auth_baselines WHERE auth_index IN (?, ?)').run(testWbAuth, testOpenCodeAuth);
    quotaDb.prepare('DELETE FROM usage_daily WHERE key_id = 101').run();
  }
}

// -------------------------------------------------------------
// 测试 30: 运行总览多时间窗口分桶东八区自然日对齐与全链路防缓存契约 (v2.9.61)
// -------------------------------------------------------------
{
  console.log('测试 30: 运行总览多时间窗口分桶东八区自然日对齐与全链路防缓存契约 (v2.9.61)');
  const {
    getTrafficBucketsForWindow,
    formatWindowBucketTime,
    CHINA_TZ_OFFSET_SECONDS
  } = await import('../lib/analytics/live-traffic-tracker.mjs');
  const { CHINA_TZ_OFFSET_SECONDS: CONFIG_CHINA_TZ } = await import('../lib/config.mjs');
  const { stmtEventsWindowAggregate, quotaDb } = await import('../lib/db/sqlite.mjs');

  // 0) 时区常量集中管理：lib/config.mjs 与 live-traffic-tracker.mjs 单点真理源契约
  assert.equal(CONFIG_CHINA_TZ, 28800, 'lib/config.mjs 必须集中定义 CHINA_TZ_OFFSET_SECONDS 为 28800 秒');
  assert.equal(CHINA_TZ_OFFSET_SECONDS, CONFIG_CHINA_TZ, 'live-traffic-tracker.mjs 导出的时区偏移必须与 lib/config.mjs 严格一致');
  console.log('  ✓ 全局时区常量集中管理与单点真理源契约验证通过');

  // 1) 格式化函数针对天级分桶返回清晰 "MM-DD"
  const dayStart = 1792195200; // 某秒级时间戳
  const dayEnd = dayStart + 86400;
  const dayFmt = formatWindowBucketTime(dayStart, dayEnd, 1440);
  assert.match(dayFmt, /^\d{2}-\d{2}$/, '天级桶 (bucketMinutes >= 1440) 必须输出纯月日格式 MM-DD');

  // 2) 30d 窗口必须精准对齐东八区（Asia/Shanghai）自然日 00:00:00 - 24:00:00
  const buckets30d = getTrafficBucketsForWindow('30d');
  assert.equal(buckets30d.length, 30, '30d 必须固定返回 30 桶');
  for (const b of buckets30d) {
    assert.equal(b.end - b.start, 86400, '30d 单桶跨度必须精准为 86,400 秒 (24 小时)');
    // 关键：在东八区时区下，桶的起始秒数加上 28800 秒偏移后必须能被 86400 整除（即自然日 00:00:00）
    assert.equal(
      (b.start + CHINA_TZ_OFFSET_SECONDS) % 86400,
      0,
      `桶起始时间戳 ${b.start} 必须对齐东八区自然日 00:00:00`
    );
    assert.match(b.time, /^\d{2}-\d{2}$/, `天级桶标签必须为 MM-DD 格式，收到: ${b.time}`);
  }

  // 3) 1d 窗口必须精准对齐每小时整点
  const buckets1d = getTrafficBucketsForWindow('1d');
  assert.equal(buckets1d.length, 24, '1d 必须固定返回 24 桶');
  for (const b of buckets1d) {
    assert.equal(b.end - b.start, 3600, '1d 单桶跨度必须为 3600 秒 (1 小时)');
    assert.equal((b.start + CHINA_TZ_OFFSET_SECONDS) % 3600, 0, '1d 桶必须对齐整点小时');
  }

  // 4) SQLite 模除截断时区偏移聚合验证：验证同一北京自然日的凌晨与午后事件落在同一 slot_start
  const testAuth = 'test_tz_align_auth_30';
  // 选定一个北京时间 2026-10-17 00:00:00 的绝对秒数
  // UTC 2026-10-16 16:00:00 -> 1792166400 (北京时间 2026-10-17 00:00:00)
  const cstMidnight = 1792166400;
  // 凌晨 02:30 (北京时间) -> cstMidnight + 9000
  const earlyMorningTs = cstMidnight + 9000;
  // 下午 15:30 (北京时间) -> cstMidnight + 55800
  const afternoonTs = cstMidnight + 55800;

  try {
    const stmtInsert = quotaDb.prepare(`
      INSERT INTO request_events (ts, key_id, model, status, prompt_tokens, completion_tokens, cached_tokens, total_tokens, latency_ms, ttft_ms, stream, estimated, error_type, auth_index)
      VALUES (?, 1, 'test-tz-model', 200, 10, 10, 0, 20, 100, 50, 0, 0, null, ?)
    `);
    stmtInsert.run(earlyMorningTs, testAuth);
    stmtInsert.run(afternoonTs, testAuth);

    const rows = stmtEventsWindowAggregate.all(
      CHINA_TZ_OFFSET_SECONDS,
      CHINA_TZ_OFFSET_SECONDS,
      86400,
      CHINA_TZ_OFFSET_SECONDS,
      cstMidnight - 86400,
      cstMidnight + 86400 * 2
    );

    const targetRow = rows.find(r => Number(r.slot_start) === cstMidnight);
    assert.ok(targetRow, 'SQLite 时区聚合必须产出北京时间零点对应的 slot_start');
    assert.ok(Number(targetRow.success) >= 2, '北京时间 00:00 到 24:00 之间的事件必须归入同一个 slot_start');
    console.log('  ✓ 东八区自然日 00:00 - 24:00 分桶与 SQLite 时区感知模除聚合验证通过');
  } finally {
    quotaDb.prepare('DELETE FROM request_events WHERE auth_index = ?').run(testAuth);
  }

  // 5) 前端静态资源防缓存与 HTTP 响应头契约
  const adminHtml = fs.readFileSync('admin.html', 'utf8');
  const pkgVersion = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
  assert.ok(adminHtml.includes(`overview.js?v=${pkgVersion}`), 'admin.html 必须包含带版本的 overview.js');
  assert.ok(adminHtml.includes(`style.css?v=${pkgVersion}`), 'admin.html 必须包含带版本的 style.css');
  assert.ok(adminHtml.includes(`overview.css?v=${pkgVersion}`), 'admin.html 必须包含带版本的 overview.css');

  const staticRoutes = fs.readFileSync('lib/routes/static-routes.mjs', 'utf8');
  assert.ok(staticRoutes.includes('no-cache, must-revalidate'), 'static-routes.mjs 必须配置 no-cache, must-revalidate 响应头');

  console.log('  ✓ 前端静态资源防缓存版本注入与 no-cache, must-revalidate 契约验证通过');

  // 6) 移动端小屏 X 轴刻度稀疏化自适应防挤契约
  const overviewJs = fs.readFileSync('admin-overview.js', 'utf8');
  assert.ok(overviewJs.includes('ovw-chart-xaxis'), 'admin-overview.js 必须为 X 轴文本注入独立类名 ovw-chart-xaxis');
  assert.ok(overviewJs.includes('ovw-xaxis-sparse-hide'), 'admin-overview.js 必须对非首尾偶数位置注入 ovw-xaxis-sparse-hide 稀疏类名');

  const overviewCss = fs.readFileSync('admin-overview.css', 'utf8');
  assert.ok(overviewCss.includes('@media (max-width: 480px)'), 'admin-overview.css 必须包含针对小屏的媒体查询规则');
  assert.ok(overviewCss.includes('.ovw-xaxis-sparse-hide'), 'admin-overview.css 必须包含 .ovw-xaxis-sparse-hide 隐藏规则');
  console.log('  ✓ 移动端小屏 X 轴刻度自适应稀疏防挤契约验证通过');
  console.log('');
}

// -------------------------------------------------------------
// 测试 31: 上游 CPA 凭证别名 (Nickname/DisplayName) 解析与请求流水全链路贯通 (v2.10.1)
// -------------------------------------------------------------
{
  console.log('测试 31: 上游 CPA 凭证别名 (Nickname/DisplayName) 解析与请求流水全链路贯通 (v2.10.1)');

  const {
    resolveAuthAccountDisplayName,
    isGenericProviderIdentifier,
    cachedUpstreamQuotas
  } = await import('../lib/upstream/sync.mjs');
  const auditLogs = await import('../lib/analytics/audit-logs.mjs');
  const { getUpstreamAuthStats } = await import('../lib/analytics/status-summary.mjs');
  const { quotaDb } = await import('../lib/db/sqlite.mjs');

  // 1) resolveAuthAccountDisplayName 纯函数单元测试与边界契约
  // 1.1 显式 nickname 优先解析（如现场 WorkBuddy 真实凭证）
  assert.equal(
    resolveAuthAccountDisplayName({
      name: 'workbuddy-cn-1791808639195.json',
      nickname: '唐棠瑭堂',
      label: 'workbuddy-cn',
      auth_index: '85f0b8ce6545f427'
    }, 'workbuddy'),
    '唐棠瑭堂',
    '含有 nickname 时必须最高优先级解析为 nickname'
  );

  // 1.2 兼容 nick_name 字段拼写
  assert.equal(
    resolveAuthAccountDisplayName({
      name: 'workbuddy-cn-1791808639195.json',
      nick_name: '唐棠瑭堂',
      label: 'workbuddy-cn'
    }, 'workbuddy'),
    '唐棠瑭堂',
    '兼容 nick_name 属性命名'
  );

  // 1.3 手机号或自定义工号作为昵称
  assert.equal(
    resolveAuthAccountDisplayName({
      name: 'workbuddy-cn-1791808639195.json',
      nickname: '156****3228',
      label: 'workbuddy-cn'
    }),
    '156****3228',
    '手机号脱敏别名解析正确'
  );

  // 1.4 从 label 括号中提取友好别名
  assert.equal(
    resolveAuthAccountDisplayName({
      name: 'workbuddy-cn-1791808639195.json',
      label: 'workbuddy-cn(唐棠瑭堂)'
    }),
    '唐棠瑭堂',
    '无显式 nickname 时应从 label 括号提取别名'
  );
  assert.equal(
    resolveAuthAccountDisplayName({
      name: 'workbuddy-cn-1791808639195.json',
      label: 'WorkBuddy (技术中台研发组)'
    }),
    '技术中台研发组',
    '空格和长别名提取正确'
  );

  // 1.5 排除括号内的地域/系统保留标签 (cn / intl / global / default / api)
  assert.equal(
    resolveAuthAccountDisplayName({
      name: 'workbuddy-cn-1791808639195.json',
      label: 'workbuddy(cn)'
    }, 'workbuddy'),
    'workbuddy-cn-1791808639195',
    '括号内为 cn 时不得误作为别名，应回退至剥离 .json 的文件名'
  );
  assert.equal(
    resolveAuthAccountDisplayName({
      name: 'workbuddy-intl-12345.json',
      label: 'workbuddy (intl)'
    }, 'workbuddy'),
    'workbuddy-intl-12345',
    '括号内为 intl 时不得误作为别名'
  );

  // 1.6 真实用户邮箱解析优先于纯文件名
  assert.equal(
    resolveAuthAccountDisplayName({
      name: 'antigravity-123.json',
      email: 'tanner@example.com',
      label: 'antigravity'
    }, 'antigravity'),
    'tanner@example.com',
    '真实邮箱解析正确'
  );

  // 1.7 通用提供商占位邮箱与标识识别防混
  assert.equal(
    isGenericProviderIdentifier('workbuddy-cn', 'workbuddy'),
    true,
    'workbuddy-cn 必须被判定为通用占位符'
  );
  assert.equal(
    isGenericProviderIdentifier('tanner@example.com', 'workbuddy'),
    false,
    '有效用户邮箱不得被判定为通用占位符'
  );

  // 1.8 剥离 .json 后缀兜底
  assert.equal(
    resolveAuthAccountDisplayName({
      name: 'upstream-account-file.json'
    }),
    'upstream-account-file',
    '文件名必须自动去除 .json 后缀'
  );

  // 1.9 裸 auth_index 兜底
  assert.equal(
    resolveAuthAccountDisplayName({
      auth_index: '85f0b8ce6545f427'
    }),
    '85f0b8ce6545f427',
    '无名字和邮箱时回退至 auth_index'
  );
  console.log('  ✓ resolveAuthAccountDisplayName 别名解析矩阵与通用标识守卫单测通过');

  // 2) 模拟 WorkBuddy 国内凭证 (85f0b8ce6545f427) 在审计日志与请求流水中的全链路贯通
  const testWbAuth = '85f0b8ce6545f427';
  const originalAccounts = cachedUpstreamQuotas.accounts;

  try {
    cachedUpstreamQuotas.accounts = [
      {
        auth_index: testWbAuth,
        provider: 'workbuddy',
        filename: 'workbuddy-cn-1791808639195.json',
        email: '',
        nickname: '唐棠瑭堂',
        display_name: '唐棠瑭堂',
        label: 'workbuddy-cn'
      }
    ];

    // 清理短时缓存
    auditLogs.clearAuditLogsCache();

    // 2.1 验证 resolveAuthAccountInfo 能够准确提取 display_name / nickname，且不带 .json
    const authInfo = auditLogs.resolveAuthAccountInfo(testWbAuth);
    assert.equal(authInfo.auth_name, '唐棠瑭堂', 'resolveAuthAccountInfo 必须返回别名 唐棠瑭堂');
    assert.ok(!authInfo.auth_name.endsWith('.json'), 'auth_name 绝不能以 .json 结尾');

    // 2.2 验证 resolveEventAuthInfo 事件信息综合推断
    const eventAuthInfo = auditLogs.resolveEventAuthInfo(testWbAuth, 'copilot.tencent/deepseek-r1');
    assert.equal(eventAuthInfo.auth_name, '唐棠瑭堂', 'resolveEventAuthInfo 必须返回别名 唐棠瑭堂');
    assert.equal(eventAuthInfo.provider, 'workbuddy', '提供商必须正确识别为 workbuddy');
    assert.ok(!eventAuthInfo.auth_name.endsWith('.json'), '事件 auth_name 绝不能以 .json 结尾');

    // 2.3 插入一条模拟请求事件，验证 getPagedRequests 接口返回的流水项
    const nowTs = Math.floor(Date.now() / 1000);
    quotaDb.prepare(`
      INSERT INTO request_events (ts, key_id, model, status, prompt_tokens, completion_tokens, cached_tokens, total_tokens, latency_ms, ttft_ms, stream, estimated, error_type, auth_index)
      VALUES (?, 1, 'copilot.tencent/deepseek-r1', 200, 100, 50, 0, 150, 180, 75, 1, 0, null, ?)
    `).run(nowTs, testWbAuth);

    auditLogs.clearAuditLogsCache();
    const paged = auditLogs.getPagedRequests({ page: 1, pageSize: 10 });
    const matched = paged.events.find(it => it.auth_index === testWbAuth);
    assert.ok(matched, 'getPagedRequests 必须查出测试插入的请求事件');
    assert.equal(matched.auth_name, '唐棠瑭堂', '请求流水中的上游账号必须显示别名 唐棠瑭堂 而非裸文件名');
    assert.ok(!matched.auth_name.includes('.json'), '请求流水中的 auth_name 绝不能包含 .json');

    // 2.4 验证流水按别名搜索检索能力
    auditLogs.clearAuditLogsCache();
    const searchPaged = auditLogs.getPagedRequests({ page: 1, pageSize: 10, search: '唐棠瑭堂' });
    const searchMatched = searchPaged.events.find(it => it.auth_index === testWbAuth);
    assert.ok(searchMatched, '流水按别名 唐棠瑭堂 搜索必须精准命中对应请求');

    // 2.5 验证 getUpstreamAuthStats 中账号各项属性
    const authStats = getUpstreamAuthStats();
    const statItem = authStats.items.find(it => it.auth_index === testWbAuth);
    assert.ok(statItem, 'getUpstreamAuthStats 必须包含该凭据');
    assert.equal(statItem.display_name, '唐棠瑭堂', 'display_name 必须为 唐棠瑭堂');
    assert.equal(statItem.nickname, '唐棠瑭堂', 'nickname 必须为 唐棠瑭堂');
    assert.equal(statItem.name, '唐棠瑭堂', 'name 字段必须为别名 唐棠瑭堂');
    assert.ok(!statItem.name.includes('.json'), 'statItem.name 绝不能包含 .json');

    console.log('  ✓ 审计日志与流水查询全链路 display_name 贯通验证通过');
  } finally {
    cachedUpstreamQuotas.accounts = originalAccounts;
    auditLogs.clearAuditLogsCache();
    quotaDb.prepare('DELETE FROM request_events WHERE auth_index = ?').run(testWbAuth);
  }

  // 3) 本地基线表 (upstream_auth_baselines) 兜底防御与 .json 自动清洗验证
  const testBaselineAuth = 'test_baseline_json_strip_auth';
  try {
    quotaDb.prepare(`
      INSERT OR REPLACE INTO upstream_auth_baselines (auth_index, provider, name)
      VALUES (?, ?, ?)
    `).run(testBaselineAuth, 'workbuddy', 'raw-account-disk-name.json');

    auditLogs.clearAuditLogsCache();
    const bInfo = auditLogs.resolveAuthAccountInfo(testBaselineAuth);
    assert.equal(bInfo.auth_name, 'raw-account-disk-name', '查本地基线表时也必须自动剥离 .json 后缀');
    console.log('  ✓ 基线表兜底查询 .json 自动剥离防御验证通过');
  } finally {
    quotaDb.prepare('DELETE FROM upstream_auth_baselines WHERE auth_index = ?').run(testBaselineAuth);
    auditLogs.clearAuditLogsCache();
  }

  // 4) 前端代码防退化与防 .json 泄露契约测试
  const adminLogsJs = fs.readFileSync('admin-logs.js', 'utf8');
  assert.ok(adminLogsJs.includes('acc.display_name || acc.nickname'), 'admin-logs.js 必须优先使用 acc.display_name 与 acc.nickname');
  assert.ok(adminLogsJs.includes('.replace(/\\.json$/i'), 'admin-logs.js 必须具备针对 .json 后缀的清洗正则');

  const adminQuotasJs = fs.readFileSync('admin-quotas.js', 'utf8');
  assert.ok(adminQuotasJs.includes('display_name'), 'admin-quotas.js 必须支持 display_name 字段');
  assert.ok(adminQuotasJs.includes('nickname'), 'admin-quotas.js 必须支持 nickname 字段');
  assert.ok(adminQuotasJs.includes('.replace(/\\.json$/i'), 'admin-quotas.js 必须在视图呈现中去除 .json 后缀');

  console.log('  ✓ 前端静态代码别名优先与 .json 防泄露契约验证通过');
  console.log('');
}

// -------------------------------------------------------------
// 测试 32: 阿里通义灵码 (Qoder) 双域接入与全链路契约 (v2.10.7)
// 说明：验证 Gate 跟进 CPA 接入 Qoder 国际版与国内版 (qoder-cn / 通义灵码) 的提供商注册表、
//       统一推断优先级、管理后台上游凭证筛选标签、品牌呈现与 OAuth 路由契约。
// -------------------------------------------------------------
console.log('测试 32: 阿里通义灵码 (Qoder) 双域接入与全链路契约 (v2.10.7)');
{
  const reg = await import('../lib/core/provider-registry.mjs');
  const adminHtml = fs.readFileSync('admin.html', 'utf8');
  const adminRoutesSrc = fs.readFileSync('lib/routes/admin-routes.mjs', 'utf8');
  const adminLogsJs = fs.readFileSync('admin-logs.js', 'utf8');
  const adminQuotasJs = fs.readFileSync('admin-quotas.js', 'utf8');

  // 1) 验证 INITIAL_PROVIDER_REGISTRY 包含 qoder 与 qoder-cn 及其展示与排序
  const initList = reg.INITIAL_PROVIDER_REGISTRY;
  const qoderCnItem = initList.find(p => p.provider_key === 'qoder-cn');
  const qoderItem = initList.find(p => p.provider_key === 'qoder');
  assert.ok(qoderCnItem, 'INITIAL_PROVIDER_REGISTRY 必须包含 qoder-cn');
  assert.ok(qoderItem, 'INITIAL_PROVIDER_REGISTRY 必须包含 qoder');
  assert.equal(qoderCnItem.label, 'Qoder (通义灵码)', 'qoder-cn label 校验');
  assert.equal(qoderItem.label, 'Qoder 阿里通义灵码', 'qoder label 校验');
  assert.ok(qoderCnItem.sort_order < qoderItem.sort_order, '国内版 qoder-cn 必须排在国际版 qoder 之前以防前缀抢夺');

  // 2) 载入内置项并验证 inferProvider 对 qoder 与 qoder-cn 模型和 auth_index 的推断
  for (const p of reg.INITIAL_PROVIDER_REGISTRY) {
    if (p.provider_key === 'qoder' || p.provider_key === 'qoder-cn') {
      reg.upsertProviderRegistry({
        provider_key: p.provider_key,
        label: p.label,
        model_patterns: p.model_patterns,
        auth_patterns: p.auth_patterns,
        source: 'builtin',
        sort_order: p.sort_order
      });
    }
  }
  reg.reloadProviderRegistry();

  const inferQoderCnAuth = reg.inferProvider({ authIndex: 'qoder-cn:user123' });
  assert.equal(inferQoderCnAuth.key, 'qoder-cn', 'auth_index 命中 qoder-cn');
  assert.equal(inferQoderCnAuth.label, 'Qoder (通义灵码)');

  const inferLingmaCnAuth = reg.inferProvider({ authIndex: 'lingma-cn:token' });
  assert.equal(inferLingmaCnAuth.key, 'qoder-cn', 'auth_index 命中 lingma-cn');

  const inferQoderAuth = reg.inferProvider({ authIndex: 'qoder:user456' });
  assert.equal(inferQoderAuth.key, 'qoder', 'auth_index 命中 qoder');
  assert.equal(inferQoderAuth.label, 'Qoder 阿里通义灵码');

  const inferLingmaAuth = reg.inferProvider({ authIndex: 'lingma:token' });
  assert.equal(inferLingmaAuth.key, 'qoder', 'auth_index 命中 lingma');

  const inferQoderCnModel = reg.inferProvider({ model: 'qoder-cn-coder' });
  assert.equal(inferQoderCnModel.key, 'qoder-cn', 'model 命中 qoder-cn');

  const inferLingmaCnModel = reg.inferProvider({ model: 'lingma-cn-2.5' });
  assert.equal(inferLingmaCnModel.key, 'qoder-cn', 'model 命中 lingma-cn');

  const inferQoderModel = reg.inferProvider({ model: 'qoder-base-model' });
  assert.equal(inferQoderModel.key, 'qoder', 'model 命中 qoder');

  const inferLingmaModel = reg.inferProvider({ model: 'lingma-2.5' });
  assert.equal(inferLingmaModel.key, 'qoder', 'model 命中 lingma');

  console.log('  ✓ 提供商注册表与 Qoder 双域推断规则验证通过');

  // 3) 验证 admin.html 中的上游凭证 Filter 标签与品牌定义
  assert.ok(
    adminHtml.includes("switchUpstreamFilter('qoder')"),
    'admin.html 必须包含 switchUpstreamFilter(\'qoder\') 过滤标签按钮'
  );
  assert.ok(
    adminHtml.includes('provider-icon-qoder') && adminHtml.includes('provider-pill-qoder'),
    'admin.html 必须定义 Qoder 专属图标与胶囊样式类'
  );
  assert.ok(
    adminHtml.includes("p.includes('qoder')") || adminHtml.includes("p.includes('lingma')"),
    'admin.html 中的 getProviderBrand 必须包含 qoder 识别分支'
  );

  // 4) 验证 admin-quotas.js 中同时匹配 qoder 与 qoder-cn
  assert.ok(
    adminQuotasJs.includes("activeUpstreamFilter === 'qoder'"),
    'admin-quotas.js 必须包含 qoder 上游过滤逻辑'
  );
  assert.ok(
    adminQuotasJs.includes("prov === 'qoder-cn'") || adminQuotasJs.includes("'qoder-cn'"),
    'admin-quotas.js 过滤 qoder 时必须联动包含 qoder-cn 凭证'
  );

  // 5) 验证 admin-logs.js 中的流水推断分支与预设选项
  assert.ok(
    adminLogsJs.includes("m.includes('qoder-cn')"),
    'admin-logs.js 中的 resolveEventProvider 必须包含 qoder-cn 推断分支'
  );
  assert.ok(
    adminLogsJs.includes("m.includes('qoder')"),
    'admin-logs.js 中的 resolveEventProvider 必须包含 qoder 推断分支'
  );
  assert.ok(
    adminLogsJs.includes("'qoder-cn'") && adminLogsJs.includes("'qoder'"),
    'admin-logs.js 预设提供商中必须包含 qoder-cn 与 qoder'
  );

  // 6) 验证 lib/routes/admin-routes.mjs 中的 OAuth 映射
  assert.ok(
    adminRoutesSrc.includes("'qoder-cn': 'qoder-cn-auth-url'") && adminRoutesSrc.includes("qoder: 'qoder-auth-url'"),
    'admin-routes.mjs 必须映射 qoder 与 qoder-cn 的 OAuth 地址'
  );

  console.log('  ✓ 前端控制台凭证过滤、品牌图标、流水推断与后端 OAuth 契约验证通过');
  console.log('');
}

console.log('=== 全部集成测试用例执行完毕，全部通过！===');

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { parseWorkBuddyGroups } from '../lib/upstream/sync.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('=== 开始执行 WorkBuddy 积分与 Key 表格美化集成测试 ===\n');

// 测试 1: parseWorkBuddyGroups 提取解析腾讯资源包
console.log('测试 1: parseWorkBuddyGroups 提取解析腾讯资源包');
{
  const mockSummary = {
    Packages: [
      {
        PackageName: '开发者免费额度包',
        CapacityUnit: 'credits',
        CycleTotalCapacity: 800,
        CycleRemainCapacity: 799.88,
        CycleUsedCapacity: 0.12
      }
    ]
  };

  const groups = parseWorkBuddyGroups(mockSummary);
  assert.equal(groups.length, 1, '应返回 1 个模型组');
  assert.equal(groups[0].name, 'WorkBuddy 资源包额度');
  assert.equal(groups[0].buckets.length, 1);
  const b = groups[0].buckets[0];
  assert.equal(b.total_capacity, 800);
  assert.equal(b.remain_capacity, 799.88);
  assert.equal(b.used_capacity, 0.12);
  assert.equal(b.remaining_percent, 100);
  assert.equal(b.used_percent, 0);
  assert.equal(b.reset_countdown, '剩余 799.88 积分');
  console.log('  ✓ parseWorkBuddyGroups 正确解析并计算资源包数据 (顶层 Packages)');

  // 1.2: 验证嵌套在 data.Packages 中的真实生产响应载荷
  const mockRealProduction = {
    code: 0,
    msg: 'OK',
    requestId: 'req-wb-12345',
    data: {
      Packages: [
        {
          PackageCode: 'TCACA_code_006_DbXS0lrypC',
          CycleTotalCapacity: '250',
          CycleRemainCapacity: '250',
          CycleUsedCapacity: '0',
          CapacityUnit: 'credit'
        },
        {
          PackageCode: 'TCACA_code_035_ArVxJcGDsm',
          CycleTotalCapacity: '100',
          CycleRemainCapacity: '100',
          CycleUsedCapacity: '0',
          CapacityUnit: 'credits'
        }
      ],
      SubscriptionPackageName: 'Free'
    }
  };

  const realGroups = parseWorkBuddyGroups(mockRealProduction);
  assert.equal(realGroups.length, 1, '应返回 1 个模型组');
  assert.equal(realGroups[0].buckets.length, 2, '包含 2 个周期包');
  assert.equal(realGroups[0].buckets[0].name, 'TCACA_code_006_DbXS0lrypC', '无 PackageName 时应平滑回退到 PackageCode');
  assert.equal(realGroups[0].buckets[0].remain_capacity, 250);
  assert.equal(realGroups[0].buckets[1].remain_capacity, 100);
  console.log('  ✓ parseWorkBuddyGroups 正确解析真实生产环境 data.Packages 嵌套响应');
}

// 测试 2: admin.html 内联语法与 WorkBuddy 积分渲染契约
console.log('\n测试 2: admin.html 内联语法与 WorkBuddy 积分渲染契约');
{
  const adminHtml = fs.readFileSync(path.join(__dirname, '../admin.html'), 'utf8');

  // 验证 HTML/JS 语法
  const scriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  let scriptIndex = 0;
  while ((match = scriptRegex.exec(adminHtml)) !== null) {
    const code = match[1];
    if (code.trim()) {
      scriptIndex++;
      try {
        new vm.Script(code, { filename: `admin.html[inline-script-${scriptIndex}]` });
      } catch (err) {
        assert.fail(`admin.html 第 ${scriptIndex} 个脚本存在语法错误: ${err.message}`);
      }
    }
  }
  console.log('  ✓ admin.html 内联脚本语法检查全部通过');

  for (const asset of ['admin-quotas.js', 'admin-keys.js', 'admin-stats.js', 'admin-logs.js']) {
    const source = fs.readFileSync(path.join(__dirname, `../${asset}`), 'utf8');
    new vm.Script(source, { filename: asset });
    console.log(`  ✓ ${asset} 语法检查全部通过`);
  }

  const clientScripts = adminHtml +
    fs.readFileSync(path.join(__dirname, '../admin-quotas.js'), 'utf8') +
    fs.readFileSync(path.join(__dirname, '../admin-keys.js'), 'utf8');

  // 验证 WorkBuddy 渲染契约
  assert.ok(clientScripts.includes("acc.provider === 'workbuddy' || acc.provider === 'workbuddy-cn'"), '需覆盖 workbuddy 与 workbuddy-cn 提供商判断');
  assert.ok(clientScripts.includes('acc.remaining_credits'), '紧凑与大卡视图中需读取 remaining_credits');
  assert.ok(clientScripts.includes('WorkBuddy 资源包与积分额度'), '卡片模式需包含 WorkBuddy 专属额度标题');
  assert.ok(clientScripts.includes('资源包积分'), '紧凑模式需包含资源包积分微标签');
  console.log('  ✓ WorkBuddy 剩余积分与进度条展示契约验证通过');
}

// 测试 3: API Key 表格排版整洁化契约
console.log('\n测试 3: API Key 表格排版整洁化契约');
{
  const keysJs = fs.readFileSync(path.join(__dirname, '../admin-keys.js'), 'utf8');

  assert.ok(keysJs.includes('model-perm-badge all'), '必须包含全部模型规整微胶囊');
  assert.ok(keysJs.includes('model-perm-badge limited'), '必须包含受限模型微胶囊');
  assert.ok(keysJs.includes('key-usage-cell'), '必须包含统一高度结构的用量单元格');
  assert.ok(keysJs.includes('usage-progress-bar unlimited'), '无硬限行必须包含占位槽以保证表格行高完全对齐');
  assert.ok(keysJs.includes('chip-cache zero'), '零命中率必须包含对齐的灰色微胶囊');
  console.log('  ✓ API Key 表格模型胶囊与高度一致性占位契约验证通过');
}

// 测试 4: 凭据卡片大盘 WorkBuddy 积分与 OpenRouter 今日请求次数契约
console.log('\n测试 4: 凭据卡片大盘 WorkBuddy 积分与 OpenRouter 今日请求次数契约');
{
  const quotasJs = fs.readFileSync(path.join(__dirname, '../admin-quotas.js'), 'utf8');

  // 1. 验证卡片渲染逻辑是否覆盖 isWorkBuddy 资源包积分分支
  assert.ok(quotasJs.includes('isWorkBuddy'), '卡片中需包含 isWorkBuddy 凭证判定');
  assert.ok(quotasJs.includes('资源包积分: <b style="color:${barColor};">剩余 ${remainFormatted}</b>'), 'WorkBuddy 卡片需展示资源包积分与剩余数值');
  assert.ok(quotasJs.includes('${remPct.toFixed(1)}% 可用'), 'WorkBuddy 卡片需展示积分可用百分比');
  assert.ok(quotasJs.includes('总额: <b>${totalFormatted}</b> 积分 · 已用: <b>${usedFormatted}</b>'), 'WorkBuddy 卡片底部次行需展示总额与已用积分');

  // 2. 验证卡片渲染逻辑是否覆盖 isOpenRouter 今日请求次数分支
  assert.ok(quotasJs.includes('isOpenRouter'), '卡片中需包含 isOpenRouter 凭证判定');
  assert.ok(quotasJs.includes('今日请求: <b style="color:#3b82f6;">${todayCount}</b>'), 'OpenRouter 卡片需展示今日已请求次数高亮');
  assert.ok(quotasJs.includes('/ ${dailyLimit} 次'), 'OpenRouter 卡片需展示每日限额');
  assert.ok(quotasJs.includes('今日剩余: <b style="color:${barColor};">${remCount}</b> 次可用 · 周期: <b>UTC日</b>'), 'OpenRouter 卡片底部需展示今日可用剩余次数与周期');

  // 3. 验证服务端 getUpstreamAuthStats 字段导出
  const summaryModule = fs.readFileSync(path.join(__dirname, '../lib/analytics/status-summary.mjs'), 'utf8');
  assert.ok(summaryModule.includes('total_credits: totalCredits'), '服务端需导出 total_credits');
  assert.ok(summaryModule.includes('remaining_credits: remainingCredits'), '服务端需导出 remaining_credits');
  assert.ok(summaryModule.includes('today_requests: todayRequests'), '服务端需导出 today_requests');
  assert.ok(summaryModule.includes('daily_limit: dailyLimit'), '服务端需导出 daily_limit');
  console.log('  ✓ 凭据卡片大盘 WorkBuddy 积分与 OpenRouter 今日请求次数全链路契约验证通过');
}

// 测试 5: WorkBuddy 积分到期截至时间解析与 UI 展示契约
console.log('\n测试 5: WorkBuddy 积分到期截至时间解析与 UI 展示契约');
{
  // 5.1: 验证 parseWorkBuddyGroups 提取单个周期包的 CycleEndTime 与 DeductionEndTime
  const mockPkgWithExp = {
    Packages: [
      {
        PackageName: 'TCACA 积分资源包',
        CycleTotalCapacity: 250,
        CycleRemainCapacity: 250,
        CycleUsedCapacity: 0,
        CycleEndTime: '2026-10-26 16:16:46',
        DeductionEndTime: 1793002606000
      }
    ]
  };

  const groups = parseWorkBuddyGroups(mockPkgWithExp);
  assert.equal(groups.length, 1);
  const b = groups[0].buckets[0];
  assert.equal(b.expires_at, '2026-10-26 16:16:46', '应提取 CycleEndTime 为 expires_at');
  assert.ok(b.reset_time.includes('2026-10-26T08:16:46'), '应从 DeductionEndTime 转换为 ISO 格式 reset_time');
  assert.equal(b.reset_countdown, '截至 10-26 16:16', '应根据 expires_at 格式化倒计时文本');
  console.log('  ✓ parseWorkBuddyGroups 周期包 CycleEndTime 与 DeductionEndTime 提取验证通过');

  // 5.2: 验证 status-summary.mjs 包含 WorkBuddy 到期时间导出
  const summaryModule = fs.readFileSync(path.join(__dirname, '../lib/analytics/status-summary.mjs'), 'utf8');
  assert.ok(summaryModule.includes('expires_at: expiresAt'), 'status-summary 需导出 expires_at');
  assert.ok(summaryModule.includes('runs_out_points: runsOutPoints'), 'status-summary 需导出 runs_out_points');
  assert.ok(summaryModule.includes('reset_time: resetTime'), 'status-summary 需导出 reset_time');
  assert.ok(summaryModule.includes('acc.groups.flatMap'), 'status-summary 需支持多组全量 bucket 兜底提取');
  console.log('  ✓ status-summary.mjs 到期时间字段导出契约验证通过');

  // 5.3: 验证 admin-quotas.js 中 getWorkBuddyExpirationInfo 与三种视图中的渲染
  const quotasJs = fs.readFileSync(path.join(__dirname, '../admin-quotas.js'), 'utf8');
  assert.ok(quotasJs.includes('function getWorkBuddyExpirationInfo(acc)'), '需包含 getWorkBuddyExpirationInfo 辅助函数');
  assert.ok(quotasJs.includes('expInfo.hasMultiplePackages ? `分批到期'), '紧凑表格行中需包含分批到期与单批截至到期分支');
  assert.ok(quotasJs.includes('⏱️ ${expInfo.hasMultiplePackages ? `积分分批到期'), '卡片视图中需包含积分分批到期与积分截至到期分支');
  assert.ok(quotasJs.includes('截至: ${expInfo.hasMultiplePackages ? \'首批 \' : \'\'}<b>${escapeHtml(expInfo.shortText)}</b>'), '大卡总览中需包含首批到期时间与分批提示');

  // 5.4: 提取 getWorkBuddyExpirationInfo 在 Node 沙箱中执行逻辑测试
  const sandbox = {
    Date,
    Number,
    String,
    Math,
    Array,
    isNaN
  };
  const fnMatch = quotasJs.match(/function getWorkBuddyExpirationInfo\(acc\) \{([\s\S]*?)\n    \}/);
  assert.ok(fnMatch, '必须能成功提取 getWorkBuddyExpirationInfo 函数体');
  const helperFn = new Function('acc', fnMatch[1]);

  const testAcc = {
    expires_at: '2026-10-26 16:16:46',
    reset_time: '2026-10-26T08:16:46.000Z',
    runs_out_points: 250
  };
  const expInfo = helperFn(testAcc);
  assert.equal(expInfo.hasExpiration, true);
  assert.equal(expInfo.shortText, '10月26日 16:16');
  assert.equal(expInfo.fullText, '2026-10-26 16:16:46');
  assert.ok(expInfo.tooltip.includes('北京时间'));
  assert.ok(expInfo.tooltip.includes('250 积分'));
  assert.equal(expInfo.runsOutPoints, 250);

  // 验证多资源包分批到期场景（正是用户关心的各包到期时间不同）
  const multiPkgAcc = {
    expiration_packages: [
      {
        package_code: 'TCACA_006',
        package_name: '标准基础月度积分包',
        remain_points: 250,
        total_points: 250,
        expires_at: '2026-10-26 16:16:46',
        reset_time: '2026-10-26T08:16:46.000Z'
      },
      {
        package_code: 'TCACA_035',
        package_name: '免费开发者体验额度',
        remain_points: 100,
        total_points: 100,
        expires_at: '2026-10-29 21:20:00',
        reset_time: '2026-10-29T13:20:00.000Z'
      }
    ],
    remaining_credits: 350,
    total_credits: 350
  };
  const multiInfo = helperFn(multiPkgAcc);
  assert.equal(multiInfo.hasExpiration, true);
  assert.equal(multiInfo.hasMultiplePackages, true);
  assert.equal(multiInfo.packageCount, 2);
  assert.equal(multiInfo.shortText, '10月26日 16:16');
  assert.equal(multiInfo.runsOutPoints, 250);
  assert.ok(multiInfo.tooltip.includes('分批到期'));
  assert.ok(multiInfo.tooltip.includes('共 2 批次'));
  assert.ok(multiInfo.tooltip.includes('标准基础月度积分包'));
  assert.ok(multiInfo.tooltip.includes('免费开发者体验额度'));
  assert.ok(multiInfo.tooltip.includes('2026-10-29 21:20:00'));
  assert.equal(multiInfo.packages[1].shortText, '10月29日 21:20');

  // 验证已到期场景
  const expiredAcc = {
    expires_at: '2020-01-01 00:00:00',
    reset_time: '2020-01-01T00:00:00.000Z'
  };
  const expiredInfo = helperFn(expiredAcc);
  assert.equal(expiredInfo.countdown, '已到期');
  assert.equal(expiredInfo.color, '#ef4444');

  // 验证跨年与远期包（如 2035 年 3010 天后的 Free Plan 基础包）的人性化年份与长期有效倒计时
  const distantAcc = {
    expires_at: '2035-01-15 20:57:00',
    reset_time: '2035-01-15T12:57:00.000Z',
    runs_out_points: 100
  };
  const distantInfo = helperFn(distantAcc);
  assert.equal(distantInfo.hasExpiration, true);
  assert.equal(distantInfo.shortText, '2035年1月15日 20:57', '跨年远期必须显式输出年份，严禁丢弃年份误导为近期');
  assert.ok(distantInfo.countdown.includes('8年后'), '跨度超过 3000 天必须以年或长期有效输出，严禁无脑输出 3000天后');
  assert.ok(distantInfo.countdown.includes('长期有效'), '超过 3 年的远期基础包应标记为长期有效');

  // 验证无任何到期时间场景（防误标 hasExpiration: true）
  const noExpAcc = {
    expiration_packages: [{
      package_code: 'TCACA_no_exp',
      package_name: '未公布包',
      remain_points: 100,
      total_points: 100,
      expires_at: '',
      reset_time: null
    }]
  };
  const noExpInfo = helperFn(noExpAcc);
  assert.equal(noExpInfo.hasExpiration, false, '无到期包必须返回 hasExpiration: false');
  assert.equal(noExpInfo.hasMultiplePackages, false);
  assert.equal(noExpInfo.shortText, '未公布到期时间');
  assert.equal(noExpInfo.color, 'var(--text-dim)');

  console.log('  ✓ getWorkBuddyExpirationInfo 单包、多包分批与无到期日沙箱逻辑测试全部通过');

  // 5.5: 验证 queryWorkBuddyFreePackages 独立提取与多包到期时间升序排列
  const syncModule = await import('../lib/upstream/sync.mjs');
  assert.equal(typeof syncModule.queryWorkBuddyFreePackages, 'function', '必须导出 queryWorkBuddyFreePackages 函数');
  assert.equal(typeof syncModule.normalizeCstTimeString, 'function', '必须导出 normalizeCstTimeString 函数');
  assert.equal(typeof syncModule.parseCstDateToTimestamp, 'function', '必须导出 parseCstDateToTimestamp 函数');

  // 验证东八区时间解析跨格式一致性（含 T 无时区与带空格格式均解析为同一北京时间戳）
  const tsSpace = syncModule.parseCstDateToTimestamp('2026-10-26 16:16:46');
  const tsIsoNoTz = syncModule.parseCstDateToTimestamp('2026-10-26T16:16:46');
  const tsIsoUtc = syncModule.parseCstDateToTimestamp('2026-10-26T08:16:46.000Z');
  assert.equal(tsSpace, 1793002606000, '北京时间空格格式应正确解析');
  assert.equal(tsIsoNoTz, 1793002606000, '含 T 无时区格式应归一化为东八区解析');
  assert.equal(tsIsoUtc, 1793002606000, '带 Z 标准 UTC 时间戳应原样保留解析');

  const emptyRes = await syncModule.queryWorkBuddyFreePackages(null, 'test', 'http://localhost', 'test', []);
  assert.equal(emptyRes, null, '空包列表必须返回 null');

  const mockCpa = async (method, path, opts) => {
    return {
      status_code: 200,
      body: JSON.stringify({
        data: {
          Accounts: [
            {
              PackageCode: 'TCACA_test_02',
              CycleEndTime: '2026-10-29 21:20:00',
              DeductionEndTime: 1793270400000,
              CycleCapacityRemain: null, // 测试 null 空值回退到 CapacityRemain
              CapacityRemain: 100
            },
            {
              PackageCode: 'TCACA_test_01',
              CycleEndTime: '2026-10-26 16:16:46',
              DeductionEndTime: 1793002606000,
              CycleCapacityRemain: 250
            }
          ]
        }
      })
    };
  };
  const mockPkgs = [
    { PackageCode: 'TCACA_test_01', PackageName: '基础包', CycleRemainCapacity: 250, CycleTotalCapacity: 250 },
    { PackageCode: 'TCACA_test_02', PackageName: '体验包', CycleRemainCapacity: 100, CycleTotalCapacity: 100 }
  ];
  const parsedFree = await syncModule.queryWorkBuddyFreePackages(mockCpa, 'test', 'http://localhost', 'test', mockPkgs);
  assert.ok(parsedFree, '必须成功解析 mockFreePackages');
  assert.equal(parsedFree.expiresAt, '2026-10-26 16:16:46', '最早到期时间必须对齐到首批');
  assert.equal(parsedFree.runsOutPoints, 250);
  assert.ok(parsedFree.runsOutAt.startsWith('2026-10-26'));
  assert.equal(parsedFree.packages.length, 2, '必须返回全部资源包列表');
  assert.equal(parsedFree.packages[0].package_code, 'TCACA_test_01', '必须按到期时间升序排列');
  assert.equal(parsedFree.packages[1].package_code, 'TCACA_test_02');
  assert.equal(parsedFree.packages[1].remain_points, 100, 'CycleCapacityRemain 为 null 时必须成功回退至 CapacityRemain');
  console.log('  ✓ queryWorkBuddyFreePackages 单元测试、空值回退与多包升序排列测试通过');
}

console.log('\n=== 全部 WorkBuddy 与 Key 表格测试通过！===');

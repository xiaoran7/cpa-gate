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

console.log('\n=== 全部 WorkBuddy 与 Key 表格测试通过！===');

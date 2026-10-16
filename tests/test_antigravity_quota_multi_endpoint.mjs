import assert from 'node:assert/strict';
import {
  ANTIGRAVITY_USER_AGENT,
  ANTIGRAVITY_QUOTA_URLS,
  parseAntigravityGroups
} from '../lib/upstream/sync.mjs';

console.log('=== 开始执行 Google Antigravity 配额多端点与官方 UA 门槛测试 ===\n');

// 测试 1: 客户端版本门槛校验 (必须 >= 1.2.0 方返回 Gemini 模型组)
console.log('测试 1: 客户端 User-Agent 版本门槛');
assert.ok(
  ANTIGRAVITY_USER_AGENT.includes('antigravity/cli/'),
  '必须包含 antigravity/cli 前缀'
);
const versionMatch = ANTIGRAVITY_USER_AGENT.match(/antigravity\/cli\/(\d+\.\d+\.\d+)/);
assert.ok(versionMatch, 'User-Agent 中必须有规范的三段式版本号');
const [major, minor, patch] = versionMatch[1].split('.').map(Number);
const isAboveOrEqual120 = major > 1 || (major === 1 && minor >= 2);
assert.ok(isAboveOrEqual120, `客户端版本 (${versionMatch[1]}) 必须 >= 1.2.0，以避免 Google 上游静默隐藏 Gemini 模型组`);
console.log(`  ✓ 客户端 User-Agent 版本为 ${versionMatch[1]} (≥ 1.2.0)，通过官方门槛校验`);

// 测试 2: 多端点容灾列表校验
console.log('测试 2: 多端点容灾端点列表');
assert.ok(Array.isArray(ANTIGRAVITY_QUOTA_URLS) && ANTIGRAVITY_QUOTA_URLS.length >= 2, '必须提供至少 2 个容灾端点');
assert.ok(
  ANTIGRAVITY_QUOTA_URLS.some(u => u.includes('daily-cloudcode-pa.googleapis.com')),
  '必须包含官方默认 daily 端点'
);
assert.ok(
  ANTIGRAVITY_QUOTA_URLS.some(u => u.includes('cloudcode-pa.googleapis.com')),
  '必须包含稳定生产端点'
);
console.log(`  ✓ 容灾端点列表完整 (${ANTIGRAVITY_QUOTA_URLS.length} 个端点)`);

// 测试 3: parseAntigravityGroups 双模型组（Gemini + Claude）解析
console.log('测试 3: parseAntigravityGroups 完整双组解析与百分比计算');
const mockPayload = {
  groups: [
    {
      displayName: 'Gemini Models',
      description: 'Gemini 1.5 Pro / Flash 速率限制窗口',
      buckets: [
        {
          bucketId: 'gemini-5h',
          displayName: '5小时限额',
          window: '5h',
          remainingFraction: 0.85
        },
        {
          bucketId: 'gemini-weekly',
          displayName: '周限额',
          window: 'weekly',
          remainingFraction: 0.95
        }
      ]
    },
    {
      displayName: 'Claude and GPT models',
      description: 'Claude 3.5 Sonnet 及其他模型',
      buckets: [
        {
          bucketId: 'claude-5h',
          displayName: '5小时限额',
          window: '5h',
          remainingFraction: 1.0
        },
        {
          bucketId: 'claude-weekly',
          displayName: '周限额',
          window: 'weekly',
          remainingFraction: 0.0
        }
      ]
    }
  ]
};

const groups = parseAntigravityGroups(mockPayload);
assert.equal(groups.length, 2, '必须成功解析出 2 个模型组');
const geminiGroup = groups.find(g => (g.name || '').includes('Gemini'));
assert.ok(geminiGroup, '必须包含 Gemini 模型组');
assert.equal(geminiGroup.buckets.length, 2, 'Gemini 必须包含 5小时与周限额两个桶');
assert.equal(geminiGroup.buckets[0].remaining_percent, 85);
assert.equal(geminiGroup.buckets[1].remaining_percent, 95);

const claudeGroup = groups.find(g => (g.name || '').includes('Claude'));
assert.ok(claudeGroup, '必须包含 Claude 模型组');
assert.equal(claudeGroup.buckets[0].remaining_percent, 100);
assert.equal(claudeGroup.buckets[1].remaining_percent, 0);

console.log('  ✓ Gemini 与 Claude 双模型组解析、滑动窗口百分比换算均正确');

console.log('\n=== 全部 Google Antigravity 配额与多端点测试通过！===');

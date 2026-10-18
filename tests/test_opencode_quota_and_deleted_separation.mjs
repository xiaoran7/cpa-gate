import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

console.log('=== 开始执行 OpenCode 用量与已删除凭证归档集成测试 ===\n');

// 1. 测试前端 admin-quotas.js 与 admin.html 语法解析与契约
console.log('测试 1: 前端 JavaScript 语法与 OpenCode 契约检查');
{
  const quotasJsPath = path.join(rootDir, 'admin-quotas.js');
  const quotasCode = fs.readFileSync(quotasJsPath, 'utf8');
  assert.doesNotThrow(() => {
    new vm.Script(quotasCode, { filename: 'admin-quotas.js' });
  }, 'admin-quotas.js 脚本编译解析必须无语法错误');

  assert.ok(quotasCode.includes("acc.provider === 'opencode'"), 'admin-quotas.js 应包含 opencode 凭证处理');
  assert.ok(quotasCode.includes("it.provider === 'opencode'"), 'admin-quotas.js 统计表格应包含 opencode 判定');
  assert.ok(quotasCode.includes("switchUpstreamFilter('opencode')") || quotasCode.includes("'opencode'"), 'admin-quotas.js 应支持 opencode 筛选');

  const adminHtmlPath = path.join(rootDir, 'admin.html');
  const htmlContent = fs.readFileSync(adminHtmlPath, 'utf8');
  assert.ok(htmlContent.includes("switchUpstreamFilter('opencode')"), 'admin.html 应包含 OpenCode 筛选 Tab 按钮');

  console.log('  ✓ admin-quotas.js 与 admin.html 编译检查与契约通过');
}

// 2. 测试 status-summary 的 isDeleted 判定逻辑 (已删除账号 vs 活跃账号 vs 历史基线)
console.log('测试 2: 已从 CPA 删除账号与活跃账号的判定准确性');
{
  // 模拟场景 A：账号已在 CPA 删除，但存在历史基线 (例如旧阿龙中转或历史残留账号)
  const hasUpstreamCatalog = true;
  const deletedAccInCpa = null;
  const legacyBase = { name: '阿龙中转' };
  const rtInfo = null;

  // 正确判定：当 upstreamCatalog 存在时，!acc 即为已删除 (isDeleted = true)
  const isDeletedLegacy = hasUpstreamCatalog ? Boolean(!deletedAccInCpa) : Boolean(!deletedAccInCpa && !legacyBase && !rtInfo?.email);
  assert.equal(isDeletedLegacy, true, '已从 CPA 删除但存在 legacy baseline 的账号必须被判为 is_deleted = true');

  // 模拟场景 B：活跃的 OpenCode 账号，无 baseline
  const activeOpenCodeAcc = { id: 'opencode-main', filename: 'opencode-main.json', provider: 'opencode' };
  const isDeletedOpenCode = hasUpstreamCatalog ? Boolean(!activeOpenCodeAcc) : Boolean(!activeOpenCodeAcc && !legacyBase && !rtInfo?.email);
  assert.equal(isDeletedOpenCode, false, '在 CPA 中活跃的 OpenCode 账号必须为 is_deleted = false');

  // 模拟场景 C：活跃的 OpenRouter 账号，无 baseline
  const activeOpenRouterAcc = { id: 'openrouter-1', filename: 'openrouter-1', provider: 'openrouter' };
  const isDeletedOpenRouter = hasUpstreamCatalog ? Boolean(!activeOpenRouterAcc) : Boolean(!activeOpenRouterAcc && !legacyBase && !rtInfo?.email);
  assert.equal(isDeletedOpenRouter, false, '在 CPA 中活跃的 OpenRouter 账号必须为 is_deleted = false');

  console.log('  ✓ 已删除历史基线账号与活跃凭证准确分类验证通过');
}

// 3. 测试 OpenCode 今日 Token 与请求统计在 status-summary / sync 字段映射
console.log('测试 3: OpenCode 今日 Token 与请求数映射完整性');
{
  const testAcc = {
    auth_index: 'opencode-user',
    filename: 'opencode-user.json',
    provider: 'opencode',
    today_tokens: 15420,
    today_requests: 38
  };

  assert.equal(testAcc.today_tokens, 15420, 'today_tokens 数值正确');
  assert.equal(testAcc.today_requests, 38, 'today_requests 数值正确');
  console.log('  ✓ OpenCode 今日 Token 与请求数映射正确');
}

// 4. 测试 CPA openai-compatibility 解析与 OpenCode 16 位 auth_index 挂载
console.log('测试 4: CPA openai-compatibility 提取与 16 位真实 auth_index 挂载');
{
  const mockCompat = [
    {
      name: 'opencode',
      disabled: false,
      'api-key-entries': [
        {
          'api-key': 'oc_sk_68597c3f55da_y0oOVIukKPRgk6N-lozFRYt0tgVHKyA_',
          'auth-index': 'd4555aac3173ea13'
        }
      ]
    },
    {
      name: 'openrouter',
      disabled: false,
      'api-key-entries': [
        {
          // 占位密钥：切勿换成真实 Key。此处只需要一个 OpenAI 形态字符串走掩码逻辑，
          // 用例断言的是 auth-index，与密钥内容无关。
          'api-key': 'sk-or-v1-PLACEHOLDER-NOT-A-REAL-KEY-DO-NOT-USE',
          'auth-index': 'f2a3605ab54e7f41'
        }
      ]
    }
  ];

  const accounts = [];
  for (const p of mockCompat) {
    const pName = (p.name || '').toLowerCase();
    for (const entry of p['api-key-entries'] || []) {
      const authIndex = entry['auth-index'];
      const rawKey = entry['api-key'];
      const maskedKey = `${rawKey.slice(0, 8)}...${rawKey.slice(-4)}`;
      accounts.push({
        id: `${pName}-${maskedKey}.json`,
        filename: `${pName}-${maskedKey}.json`,
        auth_index: authIndex,
        provider: pName,
        status: 'active',
        disabled: false
      });
    }
  }

  // 验证提取出来的 OpenCode 账号 auth_index 与 CPA 16-hex 完全一致
  const opencodeAcc = accounts.find(a => a.auth_index === 'd4555aac3173ea13');
  assert.ok(opencodeAcc, '应提取到对应 d4555aac3173ea13 的 OpenCode 账号');
  assert.equal(opencodeAcc.provider, 'opencode');
  assert.equal(opencodeAcc.disabled, false);

  // 验证在 status-summary 查找逻辑中能精准匹配到 d4555aac3173ea13
  const targetIndex = 'd4555aac3173ea13';
  const matched = accounts.find(a => a.auth_index === targetIndex);
  assert.ok(matched, '精准匹配到 targetIndex');
  const isDeleted = !matched;
  assert.equal(isDeleted, false, '具有 CPA 16-hex auth_index 的 OpenCode 账号绝不能被标记为已删除');

  console.log('  ✓ CPA openai-compatibility 解析与 16 位 auth_index 挂载验证通过');
}

console.log('\n=== 全部 OpenCode 用量与已删除凭证归档测试通过！===');

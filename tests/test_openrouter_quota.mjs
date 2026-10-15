import assert from 'node:assert/strict';
import {
  OPENROUTER_DAILY_LIMIT,
  getNextUtcMidnight,
  formatResetCountdown,
  syncOpenRouterAccounts,
  probeOpenRouterAccount
} from '../lib/upstream/openrouter.mjs';
import { getProviderQuota } from '../lib/upstream/provider-quota.mjs';
import { activateUpstreamQuotaWindow, syncUpstreamQuotas } from '../lib/upstream/sync.mjs';

console.log('=== 开始执行 OpenRouter 上游配额集成测试 ===\n');

// 1. 常量与时间重置
console.log('测试 1: OpenRouter 免费层 800 次每日限额与 UTC 00:00 重置计算');
{
  assert.equal(OPENROUTER_DAILY_LIMIT, 800, '免费层每日请求限额应为 800');

  const testDate = new Date('2026-10-15T14:30:00Z');
  const nextUtc = getNextUtcMidnight(testDate);
  assert.equal(nextUtc.iso, '2026-10-16T00:00:00.000Z', '下一个 UTC 00:00 时刻计算准确');
  assert.ok(typeof nextUtc.countdown === 'string' && nextUtc.countdown.length > 0, '倒计时文案非空');
  console.log('  ✓ 800 次限额与 UTC 重置计算准确');
}

// 2. 账号加载与配额归一化
console.log('测试 2: OpenRouter 凭证数据加载与归一化');
{
  const mockFetch = async (url, opts) => {
    if (url.includes('/api/v1/analytics/query')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            data: [{ request_count: 42 }]
          }
        })
      };
    }
    return { ok: false, status: 404 };
  };

  const accounts = await syncOpenRouterAccounts({ force: true, fetchImpl: mockFetch });
  assert.ok(Array.isArray(accounts), '返回账号列表为数组');
  if (accounts.length > 0) {
    const acc = accounts[0];
    assert.equal(acc.provider, 'openrouter', '提供商标识为 openrouter');
    assert.equal(acc.daily_limit, 800, '每日上限为 800');
    assert.equal(acc.today_requests, 42, '今日调用次数应通过 mock 解析为 42');
    assert.equal(acc.remaining_requests, 800 - 42, '剩余可用次数应准确为 758');
    assert.ok(acc.auth_index.startsWith('openrouter-'), 'auth_index 前缀规范');
    assert.ok(acc.reset_time, '包含 reset_time');
    assert.ok(acc.reset_countdown, '包含 reset_countdown');
  }
  console.log('  ✓ 凭证归一化与今日调用次数解析正确');
}

// 3. 独立账号探针与 getProviderQuota 路由
console.log('测试 3: 独立凭证探针查询与提供商配额接入');
{
  const quota = await getProviderQuota('openrouter-1');
  assert.equal(quota.provider, 'openrouter');
  assert.equal(quota.results?.quota?.status_code, 200);
  assert.equal(quota.results?.quota?.data?.daily_limit, 800);
  assert.ok(Number.isFinite(quota.results?.quota?.data?.today_requests));
  assert.ok(Number.isFinite(quota.results?.quota?.data?.remaining_requests));
  console.log('  ✓ getProviderQuota 成功返回规范的 OpenRouter 纯数字配额');
}

// 4. 激活窗口接口 activateUpstreamQuotaWindow 支持 openrouter
console.log('测试 4: activateUpstreamQuotaWindow 探针兼容性');
{
  const activated = await activateUpstreamQuotaWindow({
    authIndex: 'openrouter-1',
    provider: 'openrouter'
  });
  assert.equal(activated.success, true);
  assert.equal(activated.probe_response?.status_code, 200);
  assert.equal(activated.probe_response?.body?.daily_limit, 800);
  console.log('  ✓ activateUpstreamQuotaWindow 对 openrouter 凭证激活成功');
}

console.log('\n=== 全部 OpenRouter 配额集成测试用例执行完毕，全部通过！===');

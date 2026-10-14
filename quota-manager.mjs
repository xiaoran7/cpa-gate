// 门面入口 (Facade)：重导出所有子模块 API，保持 100% 签名与状态兼容
import { validateConfig } from './lib/config.mjs';
import { migrateFromKeeperIfNeeded } from './lib/db/keeper-migrator.mjs';
import { loadQuotaRules } from './lib/core/engine.mjs';
import { rebuildMemoryFromKeys, syncCpaKeys } from './lib/core/key-registry.mjs';
import { reloadPreloadedToday, replayOutboxIntoMemory, flushUsage } from './lib/core/outbox.mjs';
import { initModelPrices } from './lib/core/pricing.mjs';
import { initProviderRegistry } from './lib/core/provider-registry.mjs';
import { syncUpstreamQuotas } from './lib/upstream/sync.mjs';

// 验证必要配置
validateConfig();

// 启动初始化流程：Keeper 迁移 -> 规则加载 -> 内存映射重建 -> 今日用量预热 -> Outbox 回放 -> 模型定价初始化 -> 提供商注册表初始化 -> CPA 同步
migrateFromKeeperIfNeeded();
loadQuotaRules();
rebuildMemoryFromKeys();
reloadPreloadedToday();
replayOutboxIntoMemory();
initModelPrices();
initProviderRegistry();
syncCpaKeys();

// 后台定时调度器
setInterval(syncCpaKeys, 10000).unref();
setInterval(flushUsage, 5000).unref();

// 启动后异步预热上游凭证配额（60s 轮询一次）
setTimeout(() => {
  syncUpstreamQuotas().catch(() => {});
  setInterval(() => syncUpstreamQuotas().catch(() => {}), 60000).unref();
}, 1000).unref();

// ---- 统一导出所有业务 API（保持外部导入契约零破坏） ----

// 1. Core Engine: 配额与限流热路径
export {
  checkQuota,
  checkRateLimit,
  checkModelAllowed,
  filterModelsForKey,
  updateQuotaRule,
  deleteQuotaRule,
  getTodayUsageForKey,
  getTodayRequestsForKey
} from './lib/core/engine.mjs';

// 2. Core Key Registry: 凭据与 Key 映射管理
export {
  resolveKeyId,
  getKeyInfoById,
  getRawKeyById,
  updateKeyAlias,
  createCpaKey,
  rotateCpaKey,
  deleteCpaKey,
  syncCpaKeys
} from './lib/core/key-registry.mjs';

// 3. Core Outbox: 用量事件落盘与一致性刷新
export {
  recordRequest,
  flushUsage,
  getOutboxSnapshot
} from './lib/core/outbox.mjs';

// 4. Core Pricing: 模型动态定价矩阵与 Token 费用计算
export {
  calculateModelCost,
  getAllModelPrices,
  upsertModelPrice,
  deleteModelPrice,
  reloadModelPrices
} from './lib/core/pricing.mjs';

// 5. Upstream: 账号配额轮询、优先级控制与 403 验证单管理
export {
  syncUpstreamQuotas,
  getCachedUpstreamQuotas,
  activateUpstreamQuotaWindow,
  recordQuotaSnapshot,
  getQuotaSnapshots,
  normalizeAuthPriority,
  normalizeAuthWeight,
  compareAuthAccounts
} from './lib/upstream/sync.mjs';

export {
  updateUpstreamAuthPriority,
  updateUpstreamAuthStatus
} from './lib/upstream/priority.mjs';

export {
  recordUpstreamValidation,
  getPendingUpstreamValidations,
  getUpstreamValidations,
  resolveUpstreamValidation,
  resolveUpstreamValidationByAuth,
  dismissUpstreamValidation,
  deleteUpstreamValidation
} from './lib/upstream/validation-store.mjs';

// 6. Analytics: 统计大盘、心跳时钟、服务端分页与健康检查
export {
  getUsageStats,
  getRecentRequests,
  getRecentRequestsForKey,
  getPagedRequests,
  recordErrorEvent,
  getRecentErrorEvents,
  getPagedErrorEvents
} from './lib/analytics/audit-logs.mjs';

export {
  buildStatusScope,
  buildProviderGroups,
  getGateStatusSummary,
  getUpstreamAuthStats
} from './lib/analytics/status-summary.mjs';

export {
  getAdminData,
  getQuotaStatusSummary,
  getQuotaHealth,
  getTodayDetailsForKey,
  getAllTimeDetailsForKey
} from './lib/analytics/quota-health.mjs';

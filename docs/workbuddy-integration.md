# 腾讯 WorkBuddy / CodeBuddy 配额集成规范

记录 Gate 对腾讯 WorkBuddy（国际版）与 CodeBuddy（国内版）资源包计量接口、双轨同步及到期展示的实现契约。

## 1. 官方计量接口契约

| 类型 | 提供商标识 | URL (`POST`) | `X-Domain` Header |
|---|---|---|---|
| 国内汇总 | `workbuddy-cn` | `https://copilot.tencent.com/billing/meter/get-user-resource-summary` | `www.codebuddy.cn` |
| 国内明细 | `workbuddy-cn` | `https://copilot.tencent.com/billing/meter/get-user-resource-free-packages` | `www.codebuddy.cn` |
| 国际汇总 | `workbuddy` | `https://www.workbuddy.ai/billing/meter/get-user-resource-summary` | `www.workbuddy.ai` |
| 国际明细 | `workbuddy` | `https://www.workbuddy.ai/billing/meter/get-user-resource-free-packages` | `www.workbuddy.ai` |

### 必填 Headers 与请求体
- **Headers**：`Authorization: Bearer <Access_Token>`、`Content-Type: application/json`、`X-Domain`（见上表）、`X-Product: SaaS`、`X-IDE-Type: WorkBuddy`、`User-Agent: WorkBuddy/5.5.6 WorkBuddy AI/5.5.6 CLI/5.5.6`。
- **Body**：
  - 汇总接口：`{}`
  - 明细接口：`{ "PageNumber": 1, "PageSize": 50, "PackageCodes": ["TCACA_code_..."] }`（**必须带 `PageNumber` 与 `PageSize`，否则返回 `10001: invalid pagination`**）。

### 核心响应字段与嵌套结构 (`data.Packages` / `data.Accounts`)
```json
{
  "code": 0,
  "data": {
    "Packages": [
      { "PackageCode": "TCACA_code_006", "PackageName": "标准基础月度积分包", "CycleTotalCapacity": "250", "CycleRemainCapacity": "250", "CycleUsedCapacity": "0" }
    ]
  }
}
```
- **汇总 (`data.Packages` 或顶层 `Packages`)**：`PackageCode`、`PackageName`（缺省回退 `PackageCode`）、`CycleTotalCapacity`、`CycleRemainCapacity`、`CycleUsedCapacity`、`CapacityUnit`。
- **明细 (`data.Accounts`)**：`PackageCode`、`CycleStartTime`、`CycleEndTime`（北京时间 `YYYY-MM-DD HH:mm:ss`）、`DeductionEndTime`（毫秒时间戳）、`CycleCapacityRemain`。

## 2. Gate 双轨同步与时间解析 (`lib/upstream/sync.mjs`)

1. **第一层（CPA 原生通道）**：调用 CPA `/v0/management/quota/fetch`，单次获取 `points_remain`、`points_total`、`points_used`、`runs_out_points`、`expires_at` 与 `runs_out_at`。
2. **第二层（多包全量明细与自治兜底）**：只要存在有效资源包，通过 `queryWorkBuddyFreePackages` 拉取全部包的独立到期时间，按截止时间升序排列挂载至 `acc.expiration_packages`（由 `lib/analytics/status-summary.mjs` 导出）。就地刷新（`activateUpstreamQuotaWindow`）使用 `Promise.allSettled` 并行请求，直连失败时保底复用 CPA 数据。
3. **空值回退与东八区对齐**：
   - 检查 `CycleCapacityRemain != null && !== ''` 后再转数值，防止 `Number(null) === 0` 短路回退。
   - 统一通过 `normalizeCstTimeString` 识别无时区后缀的时间串并补 `+08:00`，格式化统一使用 `targetTs + 8 * 3600 * 1000` + UTC getters，确保跨时区容器与浏览器零偏移。

## 3. 前端渲染与远期包语义净化 (`admin-quotas.js`)

通过 `getWorkBuddyExpirationInfo(acc)` 统一驱动紧凑表格、凭据卡片与总览大卡：
- **远期基础包净化（`isLongTerm`）**：到期时间 `>= 3` 年（如 `2035-01-15` 哨兵值），或包名含 `Free Plan` / `体验` / `免费` 且 `> 1` 年的资源包，展示文案直接净化为绿色 `"长期有效"`（`#10b981`），隐藏机械天数倒计时，Tooltip 保留完整物理时间戳；包名宽度自适应放宽至 `72%` 防截断。
- **混合包与多包分批**：
  - 全部为长期包时，顶栏显示 `积分额度: 长期有效`；
  - 限期包与长期包混合时，"首批到期"自动锚定最早的限期包，不被远期包干扰；
  - 跨年限期包显式输出完整年份（`YYYY年MM月DD日 HH:mm`）；全部无到期日时返回 `hasExpiration: false`（显示"未公布到期时间"）。
- **紧急度染色**：已过期或 `<24h` 红色 (`#ef4444`)；`<72h` 橙色 (`#f59e0b`)；长期有效翡翠绿 (`#10b981`)；其余常规灰 (`var(--text-muted)`)。

## 4. 验证

```bash
node tests/test_workbuddy_quota_and_table.mjs
```

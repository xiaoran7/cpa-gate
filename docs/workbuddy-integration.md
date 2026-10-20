# Tencent WorkBuddy / CodeBuddy Quota Integration

Records the implementation contract for Gate's resource-package metering against Tencent WorkBuddy (international) and CodeBuddy (China), the dual-track sync, and the expiry display.

[English](#top) | [中文](#中文版)

## 1. Official metering API contract

| Type | Provider id | URL (`POST`) | `X-Domain` header |
|---|---|---|---|
| China summary | `workbuddy-cn` | `https://copilot.tencent.com/billing/meter/get-user-resource-summary` | `www.codebuddy.cn` |
| China detail | `workbuddy-cn` | `https://copilot.tencent.com/billing/meter/get-user-resource-free-packages` | `www.codebuddy.cn` |
| International summary | `workbuddy` | `https://www.workbuddy.ai/billing/meter/get-user-resource-summary` | `www.workbuddy.ai` |
| International detail | `workbuddy` | `https://www.workbuddy.ai/billing/meter/get-user-resource-free-packages` | `www.workbuddy.ai` |

### Required headers and request body
- **Headers**: `Authorization: Bearer <Access_Token>`, `Content-Type: application/json`, `X-Domain` (see the table above), `X-Product: SaaS`, `X-IDE-Type: WorkBuddy`, `User-Agent: WorkBuddy/5.5.6 WorkBuddy AI/5.5.6 CLI/5.5.6`.
- **Body**:
  - Summary endpoint: `{}`
  - Detail endpoint: `{ "PageNumber": 1, "PageSize": 50, "PackageCodes": ["TCACA_code_..."] }` (**`PageNumber` and `PageSize` are mandatory, otherwise the API returns `10001: invalid pagination`**).

### Core response fields and nested structure (`data.Packages` / `data.Accounts`)
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
- **Summary (`data.Packages` or top-level `Packages`)**: `PackageCode`, `PackageName` (falls back to `PackageCode` when absent), `CycleTotalCapacity`, `CycleRemainCapacity`, `CycleUsedCapacity`, `CapacityUnit`.
- **Detail (`data.Accounts`)**: `PackageCode`, `CycleStartTime`, `CycleEndTime` (Beijing time, `YYYY-MM-DD HH:mm:ss`), `DeductionEndTime` (millisecond timestamp), `CycleCapacityRemain`.

> The `PackageName` value above is raw upstream API data and is intentionally left in Chinese — it is not UI copy and must not be translated. The same applies to the `Free Plan` / `体验` / `免费` name fragments matched in the long-term-package heuristic.

## 2. Gate's dual-track sync and time parsing (`lib/upstream/sync.mjs`)

1. **First track (CPA's native channel)**: calls CPA's `/v0/management/quota/fetch`, retrieving `points_remain`, `points_total`, `points_used`, `runs_out_points`, `expires_at` and `runs_out_at` in one shot.
2. **Second track (full multi-package detail and autonomous fallback)**: whenever a valid resource package exists, `queryWorkBuddyFreePackages` pulls the independent expiry time of every package, and they are mounted onto `acc.expiration_packages` sorted by deadline ascending (exported by `lib/analytics/status-summary.mjs`). The in-place refresh (`activateUpstreamQuotaWindow`) issues the requests in parallel via `Promise.allSettled`, falling back to CPA's data when a direct call fails.
3. **Empty-value fallback and UTC+8 alignment**:
   - `CycleCapacityRemain != null && !== ''` is checked before converting to a number, preventing the `Number(null) === 0` short-circuit fallback.
   - `normalizeCstTimeString` recognizes time strings without a timezone suffix and appends `+08:00`; formatting uniformly uses `targetTs + 8 * 3600 * 1000` plus UTC getters, so containers and browsers in other timezones stay at zero offset.

## 3. Front-end rendering and long-term package semantics (`admin-quotas.js`)

`getWorkBuddyExpirationInfo(acc)` uniformly drives the compact table, the credential cards and the overview tiles:
- **Long-term base package purification (`isLongTerm`)**: packages whose expiry is `>= 3` years out (e.g. the `2035-01-15` sentinel value), or whose name contains `Free Plan` / `体验` / `免费` and which exceed `1` year, are purified to a green "never expires" label (`#10b981`), hiding the mechanical day countdown while the tooltip keeps the full physical timestamp. The package-name width is loosened to `72%` to prevent truncation.
- **Mixed and multi-batch packages**:
  - When every package is long-term, the top bar shows the credit quota as never expiring;
  - When limited packages and long-term packages are mixed, the "first batch expires" anchor is automatically bound to the earliest limited package and is not disturbed by far-future packages;
  - Cross-year limited packages explicitly print the full year (`YYYY-MM-DD HH:mm`); when no package carries an expiry, `hasExpiration: false` is returned (displayed as "expiry not yet announced").
- **Urgency coloring**: expired or `<24h` is red (`#ef4444`); `<72h` is orange (`#f59e0b`); never-expires is emerald green (`#10b981`); everything else is regular grey (`var(--text-muted)`).

The UI strings above are dictionary keys in `admin-i18n.js`, not literal Chinese — for example `quotas.workbuddy.longTerm` ("长期有效" / "never expires"), `quotas.workbuddy.expiryUnannounced` ("未公布到期时间" / "expiry not yet announced") and `quotas.workbuddy.packPointsTitle` ("资源包积分:" / "Resource package credits:").

## 4. Verification

```bash
node tests/test_workbuddy_quota_and_table.mjs
```

<a id="中文版"></a>

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

> 上面的 `PackageName` 取值是上游 API 原始数据，故刻意保留中文——它不是界面文案，不得翻译。长期包判定里匹配的 `Free Plan` / `体验` / `免费` 包名片段同理。

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

上述界面文案是 `admin-i18n.js` 中的字典 key，而非中文字面量——例如 `quotas.workbuddy.longTerm`（"长期有效" / "never expires"）、`quotas.workbuddy.expiryUnannounced`（"未公布到期时间" / "expiry not yet announced"）与 `quotas.workbuddy.packPointsTitle`（"资源包积分:" / "Resource package credits:"）。

## 4. 验证

```bash
node tests/test_workbuddy_quota_and_table.mjs
```

# 腾讯 WorkBuddy / CodeBuddy 资源计量与配额集成规范 (WorkBuddy Quota Integration Specification)

本文件详细记录 Gate 对腾讯 WorkBuddy / CodeBuddy 上游提供商的资源计量接口规范、数据契约、Gate 侧自治实现机制及前端渲染标准。

---

## 1. 架构定位与设计原则 (Architectural Division)

依据全干工程架构准则：
- **CLIProxyAPI (CPA)**：负责上游凭据文件（`auth-files`）存储、OAuth 会话生命周期与大模型推理流量分发；不维护各家服务商的特定计费与积分私有逻辑。
- **Gate 网关**：负责流量调度、审计流水、多租户鉴权以及**上游配额实时同步、聚合计算与监控展示**。

因此，**WorkBuddy 的积分计量与配额查询完全在 Gate 层自治实现，CPA 保持零侵入、零污染**。

```text
  ┌───────────────────────────────────────────────────────────┐
  │                         Gate 网关                         │
  │  1. 读取 CPA 中的凭据 Token (auth-files)                   │
  │  2. 直连腾讯官方计费网关查询资源包数据                     │
  │  3. 内存聚合 total / remaining / used 积分                │
  │  4. 向 Aozora UI 交付实时额度与支持就地刷新              │
  └─────────────┬───────────────────────────────┬─────────────┘
                │ 1. 读 Token                   │ 2. 查积分
                ▼                               ▼
     ┌─────────────────────┐        ┌───────────────────────┐
     │  CLIProxyAPI (CPA)  │        │   腾讯官方计费端点    │
     │  (凭据存储与代理)   │        │   (copilot.tencent)   │
     └─────────────────────┘        └───────────────────────┘
```

---

## 2. 腾讯官方计量接口契约 (Official Metering API Contract)

### 2.1 基础端点 (Endpoints)

区分国内版（CodeBuddy）与国际版（WorkBuddy）：

| 版本标识 | 归属提供商 | 官方计费接口 URL |
|---|---|---|
| 国内版汇总 | `workbuddy-cn` | `https://copilot.tencent.com/billing/meter/get-user-resource-summary` |
| 国内版明细包 | `workbuddy-cn` | `https://copilot.tencent.com/billing/meter/get-user-resource-free-packages` |
| 国际版汇总 | `workbuddy` | `https://www.workbuddy.ai/billing/meter/get-user-resource-summary` |
| 国际版明细包 | `workbuddy` | `https://www.workbuddy.ai/billing/meter/get-user-resource-free-packages` |

### 2.2 请求协议与必须 Headers (Request Headers)

- **HTTP Method**：`POST`
- **Body**：
  - 汇总接口：`{}`（空 JSON 对象）
  - 明细包接口：`{ "PageNumber": 1, "PageSize": 50, "PackageCodes": ["TCACA_code_..."] }`（**必须携带分页参数 `PageNumber: 1, PageSize: 50`，否则腾讯网关会返回 `10001: invalid pagination` 报错**）
- **Headers**：
  ```http
  POST /billing/meter/get-user-resource-summary HTTP/1.1
  Host: copilot.tencent.com
  Content-Type: application/json
  Authorization: Bearer <Tencent_WorkBuddy_Access_Token>
  X-Domain: www.codebuddy.cn
  X-Product: SaaS
  X-IDE-Type: WorkBuddy
  User-Agent: WorkBuddy/5.5.6 WorkBuddy AI/5.5.6 CLI/5.5.6
  ```

> **注意**：
> 1. `X-Domain` 必须与所请求的环境一致：国内版填 `www.codebuddy.cn`，国际版填 `www.workbuddy.ai`。
> 2. `X-IDE-Type` 与 `User-Agent` 必须携带官方 IDE 标识，否则可能被上游网关拒绝。
> 3. `get-user-resource-free-packages` 端点包含每个资源包的真实有效期截止时间（`CycleEndTime`、`DeductionEndTime`）。

### 2.3 真实响应结构与到期时间载荷 (Response Payload & Expiration)

#### 汇总响应 (Summary)
腾讯线上环境真实响应中，资源包通常嵌套在 `data.Packages` 结构中：

```json
{
  "code": 0,
  "msg": "OK",
  "requestId": "req-9c8e2f...",
  "data": {
    "SubscriptionPackageName": "Free",
    "Packages": [
      {
        "PackageCode": "TCACA_code_006_DbXS0lrypC",
        "PackageName": "标准基础月度积分包",
        "CycleTotalCapacity": "250",
        "CycleRemainCapacity": "250",
        "CycleUsedCapacity": "0",
        "CapacityUnit": "credit"
      },
      {
        "PackageCode": "TCACA_code_035_ArVxJcGDsm",
        "PackageName": "免费开发者体验额度",
        "CycleTotalCapacity": "100",
        "CycleRemainCapacity": "100",
        "CycleUsedCapacity": "0",
        "CapacityUnit": "credits"
      }
    ]
  }
}
```

#### 明细包到期时间响应 (Free Packages)
通过 `get-user-resource-free-packages` 查出的每个包周期起始、截至与毫秒时间戳：

```json
{
  "code": 0,
  "msg": "OK",
  "data": {
    "Accounts": [
      {
        "PackageCode": "TCACA_code_006_DbXS0lrypC",
        "CycleStartTime": "2026-09-26 16:16:46",
        "CycleEndTime": "2026-10-26 16:16:46",
        "DeductionEndTime": 1793002606000,
        "CycleCapacityRemain": 250
      }
    ],
    "TotalCount": 1
  }
}
```

#### 关键字段含义
- `code`：状态码，`0` 表示成功；
- `data.Packages`：资源包数组（Gate 同时向前兼容直接挂在顶层 `body.Packages` 的数据形态）；
- `PackageCode` / `PackageName`：资源包唯一代码或名称（若 `PackageName` 缺省，则平滑降级使用 `PackageCode`）；
- `CycleTotalCapacity`：当前计费周期的总容量；
- `CycleRemainCapacity`：当前计费周期内的剩余可用容量（核心指标）；
- `CycleUsedCapacity`：当前计费周期内已消耗容量；
- `CycleEndTime`：北京时间周期截至时间字符串（如 `2026-10-26 16:16:46`）；
- `DeductionEndTime`：积分扣除截止时间毫秒时间戳（如 `1793002606000`）；
- `CapacityUnit`：容量单位，通常为 `credit` 或 `credits`。

---

## 3. Gate 侧实现与双轨同步机制 (Dual-Layer Sync Architecture)

核心代码位于 [lib/upstream/sync.mjs](lib/upstream/sync.mjs) 与 [lib/analytics/status-summary.mjs](lib/analytics/status-summary.mjs)。

### 3.1 双轨获取策略与多包到期时间聚合 (Dual-Layer Fetch & Multi-Package Aggregation)
Gate 实现了优雅的高可用双轨策略：
1. **第一层（原生高速）**：直调 CPA `/v0/management/quota/fetch` 原生配额通道，CPA 内部已原生集成 WorkBuddy `QueryQuota`（并行执行汇总与包明细查询），单次 HTTP 往返即可获取结构化 `points_remain`、`points_total`、`points_used`、`runs_out_points`、`expires_at`（北京时间）与 `runs_out_at`（UTC ISO8601）；
2. **第二层（自治保底兜底与多包全量提取）**：只要凭据返回了有效资源包（`pkgs.length > 0`），Gate 均通过 `queryWorkBuddyFreePackages(cpaRequest, authIndex, baseUrl, domain, pkgs)` 并行分页拉取 `/billing/meter/get-user-resource-free-packages`，提取全部资源包的各自到期时间与可用额度，并按到期截止时间由近及远升序排列（`packages: packageList`）。无论多包拥有多么不同的截止时间，首批到期包（`earliestEndCst` / `earliestPoints`）均精准对齐，同时将完整包清单透传至 `acc.expiration_packages`。

### 3.2 资源包解析与聚合 (`parseWorkBuddyGroups`)

解析函数严格遵循类型安全与防御性编程：
1. **双层嵌套兼容提取**：兼顾 `data.Packages` 与顶层 `Packages`；
2. **多包累加与积分汇总**：自动对所有包进行求和，计算 `total_credits`、`remaining_credits` 与 `used_credits`；
3. **多资源包独立到期时间与倒计时绑定**：
   - 支持传入 `options.packages`（或从各包 `CycleEndTime` / `DeductionEndTime` 提取）；
   - 提取每个包的各自截止时间，归一化为 ISO 标准时间与北京时间字符串；
   - 生成动态微倒计时（如 `截至 10-26 16:16` 或 `剩余 N 积分`）。

### 3.3 就地靶向刷新 (`activateUpstreamQuotaWindow`)
- **交互入口**：管理后台凭据卡片上的「刷新额度」按钮；
- **并发调度与高可用容灾**：通过 `Promise.allSettled` 并行发起 CPA 配额读取与直连腾讯端点请求，耗时减半；
- **优雅保底机制**：当直连腾讯接口偶发网络超时或返回非 200 时，系统自动优先复用 CPA 层的有效配额数据，避免直接抛错或将有效凭据误染为探针失败；若缺少 `runsOutAt`，由 `expiresAt` 防御性推导补齐。

---

## 4. 前端 Aozora UI 渲染规范 (Frontend Presentation)

在 [admin-quotas.js](admin-quotas.js) 中通过通用辅助函数 `getWorkBuddyExpirationInfo(acc)` 实现了三处视图的一体化视觉对齐与分批到期支持：

### 4.1 紧凑表格视图 (Compact Mode)
适用日常高密度巡检（`.compact-meter-wrap` 复合单元格）：
- **第 1 行**：左侧「资源包积分」，右侧展示高亮「剩余 350 积分」；
- **第 2 行**：4px 动态三阶微进度条（绿/黄/红）；
- **第 3 行**：展示「总额: 350 积分 · 已用: 0」；
- **第 4 行（分批与单批自适应）**：
  - 单包：左侧展示「截至到期」，右侧显示格式化短日期与倒计时胶囊：`10月26日 16:16 (8天后)`；
  - 多包：左侧展示「分批到期 (N批)」，右侧展示「首批 10月26日 16:16 (8天后)」；
  - 紧急度分阶染色：已到期或 24 小时内红字 (`#ef4444`)；72 小时内警示橙 (`#f59e0b`)；充裕正常柔和灰 (`var(--text-muted)`)；
  - 悬停浮动气泡（Tooltip）：若多包分批，完整列出每一批次的包名称、可用积分、截至时间与独立倒计时。

### 4.2 凭据卡片模式视图 (Account Cards View)
- 在核心数据看板下方渲染：
  - 标题行自适应：单包展示「⏱️ 积分截至到期」，多包展示「⏱️ 积分分批到期 (共 N 批)」；右侧高亮呈现首批截止时间与倒计时；
  - **多包独立清单展开**：当存在多个不同到期时间的资源包时，在下方自动渲染内嵌的轻量包明细列表：
    ```text
    1. 标准基础月度积分包  250 积分   10月26日 16:16 (8天后)
    2. 免费开发者体验额度  100 积分   10月29日 21:20 (11天后)
    ```
    每个子包拥有独立的到期时间、剩余积分与状态染色。

### 4.3 网格总览大卡片 (Quota Cards View)
- 在「总额 / 已用」行右侧优雅呈现：
  - 单包：`截至: 10月26日 16:16 (8天后)`；
  - 多包：`截至: 首批 10月26日 16:16 (8天后) (共N批)`，悬停显示全量分批明细。

### 4.4 东八区单点真理源与时间防御性解析 (East Eight SSOT & Safe Parsing)
- **全局东八区单点真理源**：在格式化函数中统一执行 `cstDate = new Date(targetTs + 8 * 3600 * 1000)` 并使用 UTC getters (`getUTCFullYear()`, `getUTCMonth() + 1`, `getUTCDate()`, `getUTCHours()`, `getUTCMinutes()`, `getUTCSeconds()`) 提取字段，保证在海外服务器（如 UTC 容器、东京 VPS）或海外客户端浏览器下，呈现的小时与日期永远与北京时间完全一致，避免产生 8 小时偏移；
- **防御性时间字符串解析**：针对上游不同形式的时间输入，解析时检查 `.includes('T') ? s : s.replace(' ', 'T') + '+08:00'` 并用 try-catch 包裹，彻底杜绝给标准 ISO 字符串重复追加时区导致 `RangeError: Invalid time value`。

---

## 5. 自动化测试与验证 (Verification)

测试用例位于 [tests/test_workbuddy_quota_and_table.mjs](tests/test_workbuddy_quota_and_table.mjs)。

### 测试覆盖矩阵
1. **顶层 Packages 解析**：验证单包数据提取与百分比换算；
2. **生产嵌套 `data.Packages` 解析**：验证真实腾讯多包合并、`PackageCode` 兜底以及数值/字符串类型转换；
3. **前端语法与契约**：使用 Node.js `vm.Script` 对 `admin.html` 进行 AST 编译，保证零语法破坏并验证 DOM/变量引用契约；
4. **大盘卡片积分与今日请求次数全链路契约**：验证服务端 `status-summary.mjs` 字段导出与大盘卡片多条件展示；
5. **到期截至时间与倒计时解析**：覆盖有效到期、已到期、边界数值以及多时区环境（`TZ=UTC`、`TZ=America/New_York`、`TZ=Asia/Tokyo`）稳定性测试；
6. **`queryWorkBuddyFreePackages` 独立模块测试**：验证空包列表兜底与多包到期时间聚合。

### 运行测试
```bash
node tests/test_workbuddy_quota_and_table.mjs
```
或运行全量套件：
```bash
npm test
```

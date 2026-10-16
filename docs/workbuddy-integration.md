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
| 国内版 | `workbuddy-cn` | `https://copilot.tencent.com/billing/meter/get-user-resource-summary` |
| 国际版 | `workbuddy` | `https://www.workbuddy.ai/billing/meter/get-user-resource-summary` |

### 2.2 请求协议与必须 Headers (Request Headers)

- **HTTP Method**：`POST`
- **Body**：`{}`（空 JSON 对象）
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

### 2.3 真实响应结构载荷 (Response Payload)

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

#### 关键字段含义
- `code`：状态码，`0` 表示成功；
- `data.Packages`：资源包数组（Gate 同时向前兼容直接挂在顶层 `body.Packages` 的数据形态）；
- `PackageCode` / `PackageName`：资源包唯一代码或名称（若 `PackageName` 缺省，则平滑降级使用 `PackageCode`）；
- `CycleTotalCapacity`：当前计费周期的总容量（注意上游返回类型可能为字符串或数值）；
- `CycleRemainCapacity`：当前计费周期内的剩余可用容量（核心指标）；
- `CycleUsedCapacity`：当前计费周期内已消耗容量；
- `CapacityUnit`：容量单位，通常为 `credit` 或 `credits`。

---

## 3. Gate 侧实现与生命周期 (Implementation & Lifecycle)

核心代码位于 [lib/upstream/sync.mjs](lib/upstream/sync.mjs)。

### 3.1 资源包解析与聚合 (`parseWorkBuddyGroups`)

解析函数严格遵循类型安全与防御性编程：
1. **双层嵌套兼容提取**：
   ```javascript
   const dataObj = summaryBody?.data || summaryBody;
   const pkgs = Array.isArray(dataObj?.Packages)
     ? dataObj.Packages
     : (Array.isArray(summaryBody?.Packages) ? summaryBody.Packages : []);
   ```
2. **多包累加与积分汇总**：
   单个账号可能同时持有多个资源包（如活动赠送包 + 基础免费包），Gate 自动对所有包进行求和：
   $$\text{total\_credits} = \sum \text{CycleTotalCapacity}$$
   $$\text{remaining\_credits} = \sum \text{CycleRemainCapacity}$$
   $$\text{used\_credits} = \sum \text{CycleUsedCapacity}$$
3. **桶结构输出**：生成符合 Gate 统一标准的 Bucket 列表，每个 Bucket 包含精确的 `remaining_percent`、`used_percent` 以及文案 `剩余 N 积分`。

### 3.2 周期性被动同步 (`syncUpstreamQuotas`)
- Gate 启动后及管理面板轮询时调用；
- 具备 **30 秒内存级防抖保护**，防止并发刷新击穿上游或触发腾讯账号流控；
- 遍历所有 `workbuddy` 与 `workbuddy-cn` 凭据，提取 CPA 内部 Token 发起官方接口请求，并将结果汇总注入到 `cachedUpstreamQuotas`。

### 3.3 就地靶向刷新 (`activateUpstreamQuotaWindow`)
- **交互入口**：管理后台凭据卡片上的「刷新额度」按钮；
- **执行逻辑**：
  1. 前端向 Gate 发起 `POST /admin/api/upstream-quota/activate`；
  2. Gate 判定服务商为 WorkBuddy 时，构造官方接口请求头直接向腾讯发起单点探测；
  3. 收到官方 200 响应后，**就地更新（In-Place Update）内存缓存中的该凭据对象**（重算积分总数并清空 `raw_error`）；
  4. 瞬间向前端返回成功，前端无需整体重新加载即可完成该凭据的额度更新。

---

## 4. 前端 Aozora UI 渲染规范 (Frontend Presentation)

在 [admin.html](admin.html) 中实现了两种视图模式的无缝适配：

### 4.1 紧凑视图 (Compact Mode)
适用日常高密度巡检（`activeUpstreamViewMode === 'compact'`）：
- **结构**：`.compact-meter-wrap` 复合行；
- **上行**：左侧展示灰字「资源包积分」，右侧以大号加粗字体呈现：
  ```text
  剩余 350 积分
  ```
- **中行**：渲染 4px 动态三阶微进度条：
  - 剩余率 $> 50\%$：青空绿 (`#10b981`, `.meter-high`)
  - $20\% <$ 剩余率 $\le 50\%$：警示橙 (`#f59e0b`, `.meter-medium`)
  - 剩余率 $\le 20\%$：危险红 (`#ef4444`, `.meter-low`)
- **下行**：附带微字阶展示「总额: 350 积分 · 已用: 0」。

### 4.2 网格大卡片视图 (Grid Cards Mode)
适用单账号深度体检（`activeUpstreamViewMode === 'grid'`）：
- **专属区块**：标题为 `WorkBuddy 资源包与积分额度 · 腾讯官方计量`；
- **核心数据看板**：
  - 左侧：当前可用积分以 **24px 超大加粗高亮** 呈现；
  - 右侧：总容量与剩余百分比徽章；
- **进度条与明细**：6px 标准高度进度条，底部附带精确到两位小数的已消耗积分及各包详情。

---

## 5. 自动化测试与验证 (Verification)

测试用例位于 [tests/test_workbuddy_quota_and_table.mjs](tests/test_workbuddy_quota_and_table.mjs)。

### 测试覆盖矩阵
1. **顶层 Packages 解析**：验证单包数据提取与百分比换算；
2. **生产嵌套 `data.Packages` 解析**：验证真实腾讯多包合并、`PackageCode` 兜底以及数值/字符串类型转换；
3. **前端语法与契约**：使用 Node.js `vm.Script` 对 `admin.html` 进行 AST 编译，保证零语法破坏并验证 DOM/变量引用契约。

### 运行测试
```bash
node tests/test_workbuddy_quota_and_table.mjs
```
或运行全量套件：
```bash
npm test
```

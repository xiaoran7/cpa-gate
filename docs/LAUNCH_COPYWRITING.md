# cpa-gate 开源宣发文案包

基于当前仓库真实实现整理的多平台发布文案模板（仓库：https://github.com/xiaoran7/cpa-gate）。

## 1. V2EX / 知乎（中文）

**标题**：`[开源] cpa-gate：给 CLIProxyAPI 加上多租户 Key、日额度、RPM 限速和 60 FPS 审计看板`

```text
长期用 CLIProxyAPI（CPA）聚合 Claude / Gemini / Codex 等上游账号。CPA 的凭证池和 OAuth 刷新很稳，但它本身不管多租户：没法按人发 Key、没法设日 Token 硬顶和 RPM 限速，也查不到某个 Key 烧了多少 token。

于是我在 CPA 前面做了一层轻量网关 cpa-gate（MIT 开源）：

1. 多租户与多协议鉴权：每个 Key 独立配置日 Token 硬顶（默认 1.2x 缓冲）、60s 滑动窗口 RPM（先于额度检查防突发烧空预算）与智能模型白名单（支持通配符、厂商前缀、日期后缀），兼容 Bearer、Anthropic x-api-key、Azure api-key、Gemini x-goog-api-key 与 ?key=。
2. 弹性传输守卫：5xx 熔断器、30s 空响应负缓存、OpenAI/Anthropic 深度思考与工具流式语义识别；重试默认关闭防流量放大，可通过 GATE_MAX_ATTEMPTS 按需开启续写自愈。
3. 安全反代 CPA 原生管理台：/admin/upstream/* 由服务端内存注入 CPA 主密钥，浏览器不落明文；外层拦截 /v0/management/* 误探，防止触发 CPA 30 分钟 IP 连坐封禁。
4. 账目零丢失：SQLite WAL + usage_outbox 事务性发件箱，先入库再核算，5 秒原子刷盘，崩溃重启自动回放。
5. Aozora UI 看板：原生 JS 无构建步骤，含分钟级心跳、东八区多窗口吞吐趋势、基于真实 auth_index 的提供商归属核算与多上游实时配额（WorkBuddy 分批/长期有效、OpenRouter、Antigravity、OpenCode）。

技术栈：Node.js >= 20，唯一运行时依赖 better-sqlite3。
上游归属：凭据与 OAuth 归 CLIProxyAPI，原生管理台 UI 来自 CLI Proxy API Management Center（均为 MIT，未 Fork 核心逻辑）。

仓库：https://github.com/xiaoran7/cpa-gate
```

## 2. Reddit / Show HN（英文）

**Title**: `Show HN: cpa-gate – Multi-tenant quota, rate-limit and audit gateway in front of CLIProxyAPI`

```markdown
I run CLIProxyAPI (CPA) to aggregate Claude, Gemini, and Codex accounts. CPA handles credentials and OAuth refresh well, but it does not meter tenants. I built **cpa-gate** in front of it:

- **Multi-protocol tenant guard**: Per-key daily token cap (`hard_ratio` 1.2x), 60s sliding-window RPM limit (evaluated before quota), and wildcard/prefix/date-suffix model allowlists across `Bearer`, `x-api-key`, `api-key`, `x-goog-api-key`, and `?key=`.
- **Transport guard**: 5xx circuit breaker, 30s SHA-256 negative cache for empty completions, SSE parser (OpenAI & Anthropic `thinking`/`tool_use` deltas), and opt-in retries (`GATE_MAX_ATTEMPTS`).
- **Transactional outbox**: Synchronous writes to SQLite `usage_outbox` (WAL mode), flushed every 5s into `usage_daily`, `upstream_daily_stats`, and `request_events`, with startup crash replay.
- **Safe CPA UI proxy**: Serves `/admin/upstream/*` with server-side secret injection and blocks direct `/v0/management/*` probes to avoid CPA's 30-minute IP ban.

Stack: Node.js >= 20, single dependency (`better-sqlite3`), vanilla JS dashboard (`/admin`). Credentials and OAuth stay upstream in CLIProxyAPI (MIT); bundled upstream UI is CLI Proxy API Management Center (MIT).

Repo: https://github.com/xiaoran7/cpa-gate (includes `llms-full.txt` and 14 isolated test suites).
```

## 3. X / Twitter（短贴）

```text
Open-sourced cpa-gate — a multi-tenant gateway in front of CLIProxyAPI:
• Per-key daily token quotas + 60s sliding-window RPM
• Multi-protocol key auth & smart model allowlists
• Circuit breaker + empty-stream negative cache
• SQLite transactional outbox (zero lost usage rows)
• Authenticated proxy for CPA's management UI

Node >= 20, single dependency (better-sqlite3).
https://github.com/xiaoran7/cpa-gate
```

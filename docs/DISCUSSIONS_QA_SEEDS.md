# GitHub Discussions Seed Q&A

Once Discussions is enabled on the repository, publish the following Q&A to the **Q&A** category and mark official replies as **Answer**.

[English](#top) | [中文](#中文版)

## Q1: What do cpa-gate and CLIProxyAPI each do? Do I need both?

- **Q**: Is cpa-gate a replacement for CLIProxyAPI (CPA)? Can I install just one?
- **A**: Not a replacement — the two work together (client -> `cpa-gate 8316/8317` -> `CPA 127.0.0.1:8315` -> upstream):
  - **CLIProxyAPI (upstream, MIT)**: owns upstream credential files, OAuth refresh, account scheduling and model routing; it does not do multi-tenancy.
  - **cpa-gate (this project, MIT)**: stores no upstream OAuth tokens; it stands in front of CPA and provides multi-tenant, multi-protocol API keys (Bearer / `x-api-key` / `api-key` / `x-goog-api-key` / `?key=`), daily token limits, a 60s sliding-window RPM limit, smart model allowlists, transport circuit breaking and a SQLite audit dashboard. For solo use, install CPA alone; add cpa-gate when you distribute keys to multiple people and need limits and auditing.

## Q2: After the first clone, `npm start` reports a secret error or `/admin` returns 500 — how do I fix it?

- **Q**: After following the Quick Start it exits with an error, or static assets 404.
- **A**: Upgrade to `v2.10.0+` and run from the repository root:
  1. The current working directory's `.env` is read automatically at startup (process environment variables take precedence) — make sure `GATE_ADMIN_SECRET` and `GATE_MGMT_SECRET` are each at least 24 characters;
  2. Static assets resolve from the install root by default (`GATE_STATIC_DIR` can override it); `GATE_DIR` (`./data`) only needs to hold the SQLite data;
  3. Verify with `curl -i http://127.0.0.1:8317/healthz` and `/admin` that they return 200.

## Q3: When opening CPA's native management console through cpa-gate, is CPA's master secret exposed to the frontend?

- **Q**: After reverse-proxying CPA's management console, can the browser see `GATE_MGMT_SECRET`?
- **A**: No. `/admin/upstream/*` is validated by the Gate server against `GATE_ADMIN_SECRET` (stored in `sessionStorage` only), which then injects `GATE_MGMT_SECRET` in memory when forwarding, so the frontend never touches CPA's master secret. Direct external requests to `/v0/management/*`, `/v8/management/*` or `/management.html` are rejected with 403 by Gate, which prevents triggering CPA's 30-minute source-IP ban. The key list endpoint only returns the masked `display_key`.

## Q4: Why is the RPM limit checked before the daily quota? Why are retries off by default (`GATE_MAX_ATTEMPTS=1`)?

- **Q**: What engineering trade-offs sit behind these two defaults?
- **A**:
  1. **RPM before quota**: the hot-path order is `RPM -> daily quota -> circuit breaker -> model allowlist -> negative cache`. When a client falls into a retry loop, rate limiting kicks in first with a 429, so a single burst cannot burn through the whole day's token budget.
  2. **Retries off by default**: retrying by default amplifies transient upstream jitter into multiple times the traffic and accelerates the circuit breaker. You can opt in with `GATE_MAX_ATTEMPTS=2..5` (the 3rd attempt injects a continuation prompt to salvage an empty response); Agent requests carrying non-`function` tools always skip retries to avoid duplicated side effects.

## Q5: If the process crashes or restarts, is usage accounting lost?

- **Q**: Are requests in flight at the moment of a restart missed?
- **A**: No. Every usage event is written synchronously to the SQLite `usage_outbox` (WAL mode) first, and a 5-second timer then flushes it into `usage_daily`, `upstream_daily_stats` and `request_events` in a single transaction. After a crash restart, `replayOutboxIntoMemory()` automatically replays records that had not been flushed; on `SIGTERM` it drains in-flight streaming requests and runs `flushUsage()` before exiting. Calendar days are always split at `Asia/Shanghai` (UTC+8).

<a id="中文版"></a>

# GitHub Discussions 种子问答库

在仓库开启 Discussions 后，将以下问答发布至 **Q&A** 分类并标记官方回复为 **Answer**。

## Q1: cpa-gate 和 CLIProxyAPI 分别负责什么？必须两个都装吗？

- **提问**：cpa-gate 是不是 CLIProxyAPI（CPA）的替代品？只装一个行不行？
- **解答**：不是替代品，两者配合使用（客户端 -> `cpa-gate 8316/8317` -> `CPA 127.0.0.1:8315` -> 上游）：
  - **CLIProxyAPI（上游，MIT）**：负责上游凭据文件、OAuth 刷新、账号调度与模型路由，不管理多租户。
  - **cpa-gate（本项目，MIT）**：不存储上游 OAuth Token，站在 CPA 前方提供多租户多协议 API Key（Bearer / `x-api-key` / `api-key` / `x-goog-api-key` / `?key=`）、日 Token 限额、60s 滑动窗口 RPM、智能模型白名单、传输熔断与 SQLite 审计看板。单人自用装 CPA 即可；多人分发 Key、限额与审计时加装 cpa-gate。

## Q2: 首次 clone 后 `npm start` 报密钥错误或 `/admin` 返回 500 怎么解决？

- **提问**：按 Quick Start 操作后报错退出或静态资源 404。
- **解答**：升级至 `v2.10.0+` 并在仓库根目录运行：
  1. 启动时自动读取当前工作目录 `.env`（进程环境变量优先），请确认 `GATE_ADMIN_SECRET` 与 `GATE_MGMT_SECRET` 均不少于 24 位；
  2. 静态资源默认从安装根目录解析（`GATE_STATIC_DIR` 可覆盖），`GATE_DIR`（`./data`）仅需存放 SQLite 数据；
  3. 用 `curl -i http://127.0.0.1:8317/healthz` 与 `/admin` 验证是否返回 200。

## Q3: 通过 cpa-gate 打开 CPA 原生管理台时，CPA 主密钥会暴露在前端吗？

- **提问**：反代 CPA 管理台后，浏览器能否看到 `GATE_MGMT_SECRET`？
- **解答**：不会。`/admin/upstream/*` 由 Gate 服务端校验 `GATE_ADMIN_SECRET`（仅存 `sessionStorage`）后在内存中注入 `GATE_MGMT_SECRET` 转发，前端永不接触 CPA 主密钥。外部直接请求 `/v0/management/*`、`/v8/management/*` 或 `/management.html` 会被 Gate 直接 403 拦截，防止触发 CPA 的 30 分钟来源 IP 封禁。Key 列表接口仅返回脱敏 `display_key`。

## Q4: 为什么先做 RPM 限速再查日额度？为什么重试默认关闭（`GATE_MAX_ATTEMPTS=1`）？

- **提问**：这两个默认值背后的工程考量是什么？
- **解答**：
  1. **RPM 先于额度**：热路径顺序为 `RPM -> 日额度 -> 熔断 -> 模型白名单 -> 负缓存`。客户端陷入死循环重试时先返回 429 限速，避免一次突发把整天 Token 预算烧光。
  2. **重试默认关闭**：默认重试会将上游瞬时抖动放大为多倍流量并加速触发熔断。可通过 `GATE_MAX_ATTEMPTS=2..5` 按需开启（第 3 次尝试注入续写提示挽救空响应）；携带非 `function` 工具的 Agent 请求始终跳过重试以防重复副作用。

## Q5: 进程崩溃或重启时，用量统计会丢吗？

- **提问**：重启瞬间的请求会不会漏记账？
- **解答**：不会。每条用量事件先同步写入 SQLite `usage_outbox`（WAL 模式），再由 5 秒定时器在单事务中刷入 `usage_daily`、`upstream_daily_stats` 与 `request_events`。崩溃重启后 `replayOutboxIntoMemory()` 会自动回放未刷盘记录；收到 `SIGTERM` 时会先排空在途流式请求并执行 `flushUsage()` 后再退出。自然日固定按 `Asia/Shanghai`（UTC+8）切分。

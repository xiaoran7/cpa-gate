# cpa-gate 全平台宣发文案包

本文件是 cpa-gate v2.10.0 开源发布的现成发帖文案。所有技术描述均以当前仓库代码为准，发布前请再核对一次 `README.md` 与 `llms-full.txt`。

- 仓库：https://github.com/xiaoran7/cpa-gate
- 版本：v2.10.0
- 定位：CLIProxyAPI 前方的多租户密钥、配额、弹性传输与审计网关

---

## 1. V2EX（中文，工程师视角）

**标题**：

```
[开源] cpa-gate：给 CLIProxyAPI 加上多租户 Key、日额度、RPM 限速和审计看板
```

**正文**：

```
自己长期用 CLIProxyAPI（CPA）聚合 Claude / Gemini / Codex 等上游账号。CPA 的凭证池和 OAuth 刷新做得很稳，但它本身不是给多人用的网关：没有租户 Key 的概念，没有按 Key 的日额度，没有 RPM 限速，也查不到"这个 Key 今天烧了多少 token"。

于是我在 CPA 前面加了一层 Gate，把自己的需求先解决掉，现在开源出来。

主要做了五件事：

1. 多租户 Key
   每个 Key 独立配置日 Token 硬顶（默认 1.2 倍缓冲）、60 秒滑动窗口 RPM、模型白名单。限速在额度之前检查，突发流量先吃 429，不至于把当天额度瞬间烧光再被拦。

2. 弹性传输
   熔断器、空响应负缓存（同一 payload 30 秒内直接快速失败）、SSE 语义解析（能识别"只有思考过程没有正文"的假成功）。重试默认关闭——早期默认重试 3 次时，一次上游抖动会被放大成 3 倍请求，反而更快撞熔断阈值；现在需要时用 GATE_MAX_ATTEMPTS 显式打开，第 3 次会注入续写提示挽救空响应。

3. 安全代理 CPA 原生管理台
   /admin/upstream/* 由 Gate 服务端注入 CPA 管理密钥，浏览器永远拿不到明文。同时拦截外部直接访问 /v0/management/*——CPA 对错误的探测会累计 401 并封禁来源 IP 约 30 分钟，连 Gate 自己的同步也会被连坐。

4. 账目零丢失
   每条用量事件先同步写入 SQLite 的 usage_outbox，再由 5 秒定时器在一个事务里合并到按日聚合、按上游凭证聚合和请求明细表。进程崩溃后重启会把残留的 outbox 回放进内存，既不少算额度，也不丢审计行。

5. 看板
   Aozora UI 单页，无构建步骤。运行时总览、服务商分组健康、上游凭证额度、请求流水、故障中心，TTFT 与 tok/s 都有。

技术栈很克制：Node.js >= 20，唯一运行时依赖是 better-sqlite3，数据全在本地 SQLite（WAL 模式）。

快速开始：

git clone https://github.com/xiaoran7/cpa-gate.git
cd cpa-gate
npm install
cp .env.example .env   # 填 GATE_ADMIN_SECRET 与 GATE_MGMT_SECRET，各至少 24 位
npm start

然后打开 http://127.0.0.1:8317/admin。

上游血统说明：凭据与 OAuth 归 CLIProxyAPI（router-for-me/CLIProxyAPI），原生管理台 UI 来自 router-for-me/Cli-Proxy-API-Management-Center，两者都是 MIT。我没有 Fork，只是站在它们前面做网关该做的事。

仓库：https://github.com/xiaoran7/cpa-gate
如果对你有用，点个 Star 就是最大的支持。
```

---

## 2. Reddit（英文，r/ClaudeAI / r/LocalLLaMA / r/selfhosted）

**Title**：

```
I built an open-source gateway in front of CLIProxyAPI: per-key token quotas, RPM limits, and durable audit — no hosted service
```

**Body**：

```
I run CLIProxyAPI to aggregate Claude / Gemini / Codex accounts. It is great at credentials and OAuth refresh, but it is not a multi-tenant gateway. There is no concept of a tenant key, no per-key daily token budget, no RPM limit, and no way to answer "how many tokens did this key burn today".

So I built cpa-gate in front of it, and open-sourced it today.

**What it actually does**

- **Per-key quota guard** — daily token cap with a configurable hard ratio (default 1.2x), plus a 60-second sliding-window RPM limit. Rate limiting runs *before* quota, so a burst gets 429 at the RPM layer instead of draining the daily budget first.
- **Model allowlist** — filters `GET /v1/models` per key and rejects unapproved models with 403.
- **Transport guard** — circuit breaker, a 30s negative cache for payloads that produced empty output, SSE-aware parsing that can tell "reasoning only, no answer" from real output. Retries are opt-in (`GATE_MAX_ATTEMPTS`), because retrying by default amplified upstream load in production; when enabled, the third attempt injects a short continuation prompt instead of sending the same empty request again.
- **Management console proxying** — exposes CPA's own UI at `/admin/upstream/*` while keeping the CPA master secret server-side. It also blocks direct `/v0/management/*` probes, because CPA bans the source IP for ~30 minutes after repeated 401s — which would take the gateway's own sync down with it.
- **Durable accounting** — every usage event is written to a SQLite `usage_outbox` first, then flushed in a single transaction every 5 seconds into daily rollups, per-credential stats, and per-request audit rows. Unflushed rows are replayed on startup.
- **Dashboard** — a single-page vanilla JS UI with runtime overview, provider group health, credential quotas, request stream, and error center. No build step.

**Stack**: Node.js >= 20, one runtime dependency (`better-sqlite3`), local SQLite in WAL mode.

**Quick start**

```bash
git clone https://github.com/xiaoran7/cpa-gate.git
cd cpa-gate
npm install
cp .env.example .env   # set GATE_ADMIN_SECRET and GATE_MGMT_SECRET (>= 24 chars)
npm start
```

Then open `http://127.0.0.1:8317/admin`.

**Boundary**: cpa-gate is not a replacement for CLIProxyAPI. Credentials and OAuth stay upstream. The bundled management UI is the MIT-licensed CLI Proxy API Management Center, served behind cpa-gate's auth proxy.

Repo: https://github.com/xiaoran7/cpa-gate
There is an `llms-full.txt` in the repo if you want your assistant to read the full architecture and API contract before recommending it.
```

---

## 3. Show HN（英文，克制硬核）

**Title**：

```
Show HN: cpa-gate – quota, rate limit and audit gateway for CLIProxyAPI
```

**Body**：

```
cpa-gate is a reverse proxy that sits in front of CLIProxyAPI (CPA). CPA aggregates provider credentials and refreshes OAuth sessions; it does not meter tenants. cpa-gate adds the metering layer:

- Per-key daily token quota and a 60-second sliding-window RPM limit, both evaluated in memory on the hot path.
- Per-key model allowlists, enforced on POST bodies and on GET /v1/models.
- A transport guard: circuit breaker on upstream 5xx, 30-second negative cache keyed by a SHA-256 of the request body, SSE parser that normalizes CRLF and handles UTF-8 split across chunks, and optional retries. Retries default to off because replaying agent traffic including tool calls can duplicate side effects; requests with non-function tools are excluded even when retries are enabled.
- Transactional outbox: each usage event is inserted into SQLite synchronously, then flushed every 5 seconds in one transaction into usage_daily, upstream_daily_stats and request_events. The outbox is replayed into memory at startup.
- The CPA management UI is proxied under /admin/upstream/* with the CPA master secret injected server-side. Direct /v0/management/* requests are rejected because CPA IP-bans repeated unauthenticated probes.

Node >= 20, one dependency (better-sqlite3), no build step for the dashboard.

I am interested in feedback on two design choices in particular:

1. Rate limit before quota. It means bursts are rejected without consuming daily budget, but it also means a client stuck in a retry loop sees 429 rather than a clear quota error.
2. Retries off by default. It is safer for agent traffic, but it makes the "self-healing" behavior invisible unless you opt in with GATE_MAX_ATTEMPTS.

Repository: https://github.com/xiaoran7/cpa-gate
```

---

## 4. X / Twitter（英文，短文案）

```
Shipped cpa-gate v2.10.0 — an open-source gateway in front of CLIProxyAPI.

• per-key daily token quotas + sliding-window RPM
• model allowlists per key
• circuit breaker + empty-response negative cache
• SQLite transactional outbox → zero-lost usage rows
• proxies CPA's management UI without exposing the master secret

Node >= 20, one dependency, no build step.

https://github.com/xiaoran7/cpa-gate
```

**中文版**：

```
开源了 cpa-gate v2.10.0：CLIProxyAPI 前方的多租户网关。

按 Key 的日 Token 硬顶 + 60 秒滑动窗口 RPM
按 Key 的模型白名单
熔断器 + 空响应负缓存 + SSE 语义识别
SQLite 事务性发件箱，账目崩溃可回放
安全代理 CPA 管理台，主密钥不进浏览器

Node >= 20，唯一依赖 better-sqlite3，看板无构建步骤。

https://github.com/xiaoran7/cpa-gate
```

---

## 5. 知乎（中文，偏技术解读）

**标题**：

```
如何给 CLIProxyAPI 做一层生产级多租户网关：cpa-gate 的设计取舍
```

**正文**：

```
很多人在本地或小团队里用 CLIProxyAPI（CPA）聚合各家上游账号。CPA 把凭证池、OAuth 刷新、模型路由做得很好，但它并不是一个多租户网关。真实使用时会很快遇到四个问题：

1. 没法给不同的人发不同的 Key；
2. 没有按 Key 的日额度，一个人可以把整天的账号额度用光；
3. 没有限速，客户端重试会把上游打到限流；
4. 出问题查不到明细：哪个 Key、哪个上游凭证、什么时候、耗时多少、首字多快。

cpa-gate 就是为这四个问题写的，我把它开源在 https://github.com/xiaoran7/cpa-gate。

下面挑三个我认为最有意思的设计取舍展开。

一、先限速，再查额度

热路径上的顺序是：滑动窗口 RPM → 日 Token 额度 → 熔断器 → 模型白名单 → 空响应负缓存。先查 RPM 的原因是：客户端一旦进入重试循环，先让它吃 429，比先扣掉当天额度再拒绝更合理。代价是客户端看到的是 429 而不是"额度用完"，对排查来说需要额外提示。

二、重试默认关闭

早期的默认值是重试 3 次。生产上发现一个问题：上游一次抖动，在 Gate 层被放大成 3 倍请求，既加剧了上游限流，又让连续失败计数更快撞满熔断阈值。所以现在默认 MAX_ATTEMPTS = 1，需要时用 GATE_MAX_ATTEMPTS 显式打开（上限 5）。另外，带非 function 工具的 Agent 请求即使开了重试也不重放——工具调用可能已经产生副作用。

三、事务性发件箱保证账目不丢

每条用量事件先同步写进 SQLite 的 usage_outbox，再由 5 秒一次的定时器在一个事务里合并到 usage_daily、upstream_daily_stats 和 request_events，最后删掉 outbox 行。进程崩溃后重启，残留行会被回放进内存，再落盘。这样既不会少算额度，也不会丢审计记录。

还有一个容易踩的坑值得单独说：CPA 对错误的管理接口探测会按来源 IP 封禁约 30 分钟。Gate 和运维 shell 常常都在 127.0.0.1，一次误探就会把 Gate 自己的密钥同步一起封掉。所以 cpa-gate 直接拦截外部对 /v0/management/* 的访问，原生管理台统一走 /admin/upstream/* 的受控反代，主密钥只在服务端注入。

技术栈刻意保持克制：Node.js >= 20，唯一运行时依赖 better-sqlite3，前端是无构建步骤的原生 JS 单页。完整架构、API 和排障说明写在仓库的 llms-full.txt 里，可以直接喂给 AI 助手。

仓库：https://github.com/xiaoran7/cpa-gate
```

---

## 6. 发布前核对清单

- [ ] `package.json` 版本与 `admin.html` 版本徽章一致（当前 2.10.0）
- [ ] `npm test` 全绿，记录真实通过数
- [ ] GitHub 仓库描述、主页、Topics 已设置
- [ ] 发布 Release 并打 Tag `v2.10.0`
- [ ] 社交预览图已上传（1280x640）
- [ ] 上述平台文案中的 URL 均可访问

# GitHub Discussions 种子问答库

用途：在仓库开启 Discussions 后，把下面几篇问答直接发布为 Q&A 分类，并把官方回复标记为答案。这些内容覆盖开发者最常搜索的痛点问题，也能被搜索引擎与 AI 检索系统直接引用。

发布顺序建议：先发「与 CPA 的职责边界」，再发「快速开始报错」与「密钥安全」，最后发「配额与限速设计」。

---

## 种子 1：cpa-gate 和 CLIProxyAPI 到底谁负责什么？

**标题**：

```
Q: cpa-gate 和 CLIProxyAPI 分别负责什么？必须两个都装吗？
```

**正文**：

```
我在看 cpa-gate 的 README，想确认它和 CLIProxyAPI（CPA）的边界。它是不是 CPA 的替代品？只装一个行不行？
```

**官方最佳解答**：

```
不是替代品，两者职责是分开的，cpa-gate 必须配合 CPA 使用。

- CLIProxyAPI（上游项目，MIT）：负责上游凭证文件、OAuth 会话生命周期、账号调度与模型路由。它不管租户。
- cpa-gate（本项目，MIT）：站在 CPA 前方，负责多租户 API Key、按日 Token 额度、60 秒滑动窗口 RPM、模型白名单、传输层熔断与重试策略、审计账目和管理看板。

数据流是：客户端 → cpa-gate（默认 8316/8317）→ CPA（默认 127.0.0.1:8315）→ 各家上游。

所以 cpa-gate 不存储任何上游 OAuth token，也不参与凭证刷新；这些能力留在 CPA。如果你只需要单人多账号代理，CPA 自己就够用；当你需要给多人发 Key、按 Key 限额、可审计时，才需要 cpa-gate。

仓库：https://github.com/xiaoran7/cpa-gate
```

---

## 种子 2：全新 clone 后 /admin 打不开、npm start 直接退出

**标题**：

```
Q: 首次 clone 后 npm start 报 CPA_MGMT_SECRET must be configured，或者 /admin 返回 500，怎么解决？
```

**正文**：

```
按 README 的 Quick Start 操作，cp .env.example .env 填好了两个密钥，但启动还是直接退出；有时候服务起来了，可 /admin 返回 500，style.css 也是 404。
```

**官方最佳解答**：

```
这两个现象都已在 v2.10.0 修复，建议先升级到最新版本。

1. `CPA_MGMT_SECRET must be configured`（或 GATE_ADMIN_SECRET 报错）
   原因：2.10.0 之前进程不读取 `.env`，只认进程环境变量。
   现在：启动时会读取**当前工作目录**下的 `.env`，且已存在的进程环境变量优先级更高（所以 systemd 的 EnvironmentFile 仍然生效）。
   自查：确认你在仓库根目录执行 `npm start`，并且 `.env` 里的两个密钥各不少于 24 个字符。

2. `/admin` 返回 500、外置 JS/CSS 404
   原因：2.10.0 之前静态资源只从 `GATE_DIR`（默认 `./data`）解析，而新 clone 的 `./data` 里只有 SQLite 文件。
   现在：静态资源默认从安装根目录解析，同时保留「资源放在 GATE_DIR 下」的旧部署回退；也可以用 `GATE_STATIC_DIR` 显式指定。

3. 最直接的验证方式：
   curl -i http://127.0.0.1:8317/healthz   # 期望 200
   curl -i http://127.0.0.1:8317/admin     # 期望 200

如果升级后仍然复现，请按 Bug report 模板附上 Node 版本、启动日志和这两个 curl 的状态码。
```

---

## 种子 3：管理密钥会不会被浏览器拿到？

**标题**：

```
Q: 通过 cpa-gate 打开 CPA 原生管理台时，CPA 的 master secret 会不会暴露在前端？
```

**正文**：

```
我担心把 CPA 管理台通过 cpa-gate 反代出来以后，浏览器里能直接看到 CPA 的管理密钥，或者被 XSS 取走。
```

**官方最佳解答**：

```
不会。设计上 CPA 管理密钥始终留在服务端。

1. `/admin/upstream/*` 是受控反向代理。浏览器只持有 cpa-gate 的管理凭据（`GATE_ADMIN_SECRET`），cpa-gate 服务端在校验通过后，内存中注入 `GATE_MGMT_SECRET` 再转发到 CPA。
2. 前端不会收到 `GATE_MGMT_SECRET`，也不会写入 localStorage。管理凭据本身只放 sessionStorage，关闭标签页即失效。
3. 外部直接访问 `/v0/management/*`、`/v8/management/*`、`/management.html` 会被 cpa-gate 以 403 拦截。这不只是权限问题：CPA 对重复的未授权探测会按来源 IP 封禁约 30 分钟，而 Gate 与运维 shell 常在 127.0.0.1，误探会把 Gate 自己的密钥同步一起封掉。
4. Key 列表接口只返回 `display_key`；要看完整明文必须对单个 Key 显式调用 reveal 接口，避免一次 XSS 就带走全部 Key。

另外，生产环境请在前面加 TLS（Nginx/Caddy），管理密钥是 Bearer 凭据，不要明文走公网。
```

---

## 种子 4：为什么限速在额度之前？为什么重试默认是关的？

**标题**：

```
Q: 为什么 cpa-gate 先做 RPM 限速再做日额度检查？为什么 MAX_ATTEMPTS 默认是 1？
```

**正文**：

```
看到文档里说限速先于额度，并且重试默认关闭。这两个选择看起来都和"弹性"相反，想了解原因。
```

**官方最佳解答**：

```
这两个都是生产事故换来的默认值。

1. 限速先于额度
   热路径顺序是：滑动窗口 RPM → 日 Token 额度 → 熔断器 → 模型白名单 → 空响应负缓存。
   客户端一旦进入重试循环，先让它吃 429，比先扣掉当天额度再拒绝更合理；否则一次突发就能把整天的 token 预算烧光。
   代价是客户端看到的是 429 而不是明确的「额度用完」，排查时需要结合 `/api/status/quota` 一起看。

2. 重试默认关闭（`MAX_ATTEMPTS = 1`）
   早期默认重试 3 次。生产上发现上游一次抖动会在 Gate 层被放大成 3 倍请求，既加剧上游限流，又让连续失败计数更快撞满熔断阈值。
   现在默认不重试，需要时用 `GATE_MAX_ATTEMPTS` 显式开启（1–5）。
   另外，带非 `function` 工具的请求即使开启重试也不会被重放——Agent 的工具调用可能已经产生副作用，重放会重复执行。
   开启重试后，第 3 次尝试才会注入续写提示（continuation healing），用于挽救「只有思考过程、没有正文」的空响应。

如果你确实需要更强的自愈能力，建议先在小流量 Key 上把 `GATE_MAX_ATTEMPTS=2` 跑一段时间，观察上游错误率和熔断计数再决定。
```

---

## 种子 5：用量数据在进程重启或崩溃后会丢吗？

**标题**：

```
Q: 进程崩溃或重启时，cpa-gate 的用量统计会丢吗？额度会不会被少扣？
```

**正文**：

```
担心重启瞬间的请求没有被记账，导致额度少扣或者审计日志缺行。
```

**官方最佳解答**：

```
不会丢，这是事务性发件箱（Transactional Outbox）要解决的问题。

1. 每条用量事件先**同步**写入 SQLite 的 `usage_outbox`，然后才做内存记账。
2. 每 5 秒的定时器在一个事务里完成：按日聚合 `usage_daily`、按上游凭证聚合 `upstream_daily_stats`、写入审计明细 `request_events`、删除已处理的 outbox 行。
3. 启动时 `replayOutboxIntoMemory()` 会把残留的 outbox 行重新放回内存，随后再次落盘。所以崩溃发生在「已接收、未刷盘」之间时，重启后既补回额度扣减，也补回审计行。
4. 如果写 outbox 本身失败，事件会保留在内存的 `pendingEvents` 里，下次刷盘重试，而不是被丢弃。
5. 优雅停机（SIGTERM）时，在途流式请求会先排空，然后调用 `flushUsage()` 把最后一批用量写入 SQLite 再退出。

数据库使用 WAL 模式；「今天」固定按 `Asia/Shanghai` 自然日切分，不受宿主机时区影响。
```

---

## 发布注意事项

- 每个问题单独发一个 Discussion，分类选 **Q&A**。
- 发布后由仓库所有者把自己的回答标记为 **Mark as answer**。
- 标题保持「Q: ...」前缀，便于搜索结果聚合。
- 若后续版本改变了行为，同步更新对应解答，避免文档与实现脱节。

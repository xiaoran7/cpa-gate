# 权威 Awesome 列表收录 PR 清单

本文件列出与 cpa-gate 匹配、且当前**确实接受**此类项目的高权重 Awesome 仓库，并给出可直接粘贴的 PR 标题、修改位置与条目文本。

收录前请先核对对方最新的 `CONTRIBUTING.md`，列表的收录标准会变。以下信息核对于 2026-10-18。

---

## 1. cuihuan/awesome-ai-gateway（首选）

- 仓库：https://github.com/cuihuan/awesome-ai-gateway
- 规模：约 130 Stars，收录 160+ 网关
- 语言要求：**英文**
- 收录标准（摘自其 CONTRIBUTING）：
  1. 必须是站在请求路径上的真实网关 / 代理 / 路由器；
  2. 公开可用；
  3. 近 12 个月内有活动；
  4. 不依赖逆向私有 API 或转售盗用额度。

cpa-gate 满足前三条；第 4 条也满足——它的配额计量调用的是各厂商官方端点，不逆向私有接口。

### 修改位置

`README.md` 与 `README.zh-CN.md` 的 **`## 🔓 Self-hosted open source`** 小节。
`CLIProxyAPI` 条目已在列表内，建议紧跟其后插入，形成「上游 + 前网关」的阅读顺序。

### PR 标题

```
Add cpa-gate — multi-tenant quota/audit gateway in front of CLIProxyAPI
```

### 英文条目（README.md）

```markdown
- [cpa-gate](https://github.com/xiaoran7/cpa-gate) <!--s:xiaoran7/cpa-gate-->⭐ ~10<!--/s--> - MIT Node.js reverse proxy that adds per-key daily token quotas, 60-second sliding-window RPM limits and model allowlists in front of CLIProxyAPI, with a circuit breaker, empty-response negative cache, SQLite transactional outbox for usage accounting, and an authenticated proxy for CPA's own management UI.
```

### 中文条目（README.zh-CN.md）

```markdown
- [cpa-gate](https://github.com/xiaoran7/cpa-gate) <!--s:xiaoran7/cpa-gate-->⭐ ~10<!--/s--> - MIT 协议的 Node.js 反向代理，在 CLIProxyAPI 前方提供按 Key 的日 Token 额度、60 秒滑动窗口 RPM 与模型白名单，并带熔断器、空响应负缓存、SQLite 事务性发件箱记账，以及对 CPA 原生管理台的鉴权反代。
```

### PR 描述模板

```markdown
## What this adds

`cpa-gate` is a self-hosted gateway that sits in front of CLIProxyAPI. It does not
compete with CLIProxyAPI: credentials and OAuth stay upstream, while cpa-gate adds
tenant keys, quotas, transport resilience and accounting.

- Per-key daily token quota and 60-second sliding-window RPM limit
- Per-key model allowlist (enforced on POST bodies and `GET /v1/models`)
- Circuit breaker, 30-second negative cache for empty responses, optional retries
- SQLite transactional outbox: usage survives crashes and restarts
- Authenticated reverse proxy for CLIProxyAPI's management UI
- Node.js >= 20, one runtime dependency (`better-sqlite3`), MIT

## Checklist

- [x] Sits on the request path (reverse proxy)
- [x] Public repository: https://github.com/xiaoran7/cpa-gate
- [x] Active (initial release 2026-10-14, current release 2026-10-18)
- [x] Uses only official vendor metering endpoints; no reverse-engineered APIs
- [x] Added to both `README.md` and `README.zh-CN.md`
- [x] Description is factual, no superlatives

🤖 Generated with [Coding Assistant](https://claude.com/claude-code)
```

---

## 2. talhaanwarch/awesome-llmops-platforms（次选）

- 仓库：https://github.com/talhaanwarch/awesome-llmops-platforms
- 规模：约 38 Stars，收录 144 个开源工具
- 语言要求：**英文**
- 格式：表格，按 Stars 降序自动刷新，列固定为 `Stars | Project | Description | License | Last push`

### 修改位置

`README.md` → **`LLM gateways and routers`** 表格，按 Stars 落位（周更 Action 会自动修正星数）。

### PR 标题

```
Add cpa-gate to LLM gateways and routers
```

### 表格行

```markdown
| 10 | [cpa-gate](https://github.com/xiaoran7/cpa-gate) | Multi-tenant quota, rate-limit and audit gateway in front of CLIProxyAPI, with SQLite transactional outbox accounting. | MIT | 2026-10-18 |
```

### PR 描述模板

```markdown
Adds cpa-gate to the "LLM gateways and routers" table.

cpa-gate is an MIT-licensed Node.js reverse proxy that sits in front of
CLIProxyAPI and adds per-key daily token quotas, sliding-window RPM limits, model
allowlists, circuit breaking, and crash-safe usage accounting via a SQLite
transactional outbox.

Repo: https://github.com/xiaoran7/cpa-gate

🤖 Generated with [Coding Assistant](https://claude.com/claude-code)
```

---

## 3. 暂不建议提交的列表（附原因，避免无效 PR）

| 仓库 | 原因 |
|---|---|
| [yenanjing/awesome-model-routing](https://github.com/yenanjing/awesome-model-routing) | 明确要求 **1,000+ Stars**，当前不满足。等项目成长后再提交。 |
| [Shubhamsaboo/awesome-llm-apps](https://github.com/Shubhamsaboo/awesome-llm-apps) | 聚焦应用与 Agent 模板，不是基础设施网关，分类不匹配。 |
| [hesreallyhim/awesome-claude-code](https://github.com/hesreallyhim/awesome-claude-code) | 聚焦 Claude Code 的斜杠命令、Hook 与工作流，不是 LLM 网关。 |
| [12britz/awesome-ai-gateways](https://github.com/12britz/awesome-ai-gateways)、[wauputr4/awesome-llm-gateways](https://github.com/wauputr4/awesome-llm-gateways) | 主题匹配但规模很小（< 50 Stars），收录带来的检索权重有限，可等主列表收录后再补。 |

---

## 4. 提交前自检

- [ ] 仓库已设置描述、主页与 Topics（见下方建议）
- [ ] Release `v2.10.0` 已发布，Tag 存在
- [ ] `README.md` 中的 Quick Start 在干净环境下实测可跑通
- [ ] `llms.txt` 与 `llms-full.txt` 已推送，链接可访问
- [ ] 目标列表的 `CONTRIBUTING.md` 已重新读一遍
- [ ] 一次 PR 只加一个项目
- [ ] 条目语言与目标文件一致（英文列表不要贴中文条目）

### 建议的 GitHub Topics

```
llm-gateway, llm-proxy, cliproxyapi, api-gateway, rate-limiting,
token-quota, observability, sqlite, self-hosted, openai-compatible
```

### 建议的 GitHub 仓库描述

```
Multi-tenant quota, rate-limit and audit gateway for CLIProxyAPI. Per-key token budgets, model allowlists, circuit breaking, SQLite outbox accounting.
```

### 建议的 Homepage 字段

指向 README 的快速开始锚点或后续文档站：

```
https://github.com/xiaoran7/cpa-gate#quick-start
```

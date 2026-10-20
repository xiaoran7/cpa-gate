# Awesome List Submission PR Checklist

Before submitting, check the target repository's latest `CONTRIBUTING.md`.

[English](#top) | [中文](#中文版)

The two Markdown blocks marked "English entry" and "中文条目" below are **verbatim submission payloads** — they are copied as-is into the upstream repositories' `README.md` and `README.zh-CN.md` respectively. Do not translate, reformat or "improve" them; only the framing text around them is bilingual.

## 1. cuihuan/awesome-ai-gateway (preferred)

- **Repository**: https://github.com/cuihuan/awesome-ai-gateway
- **Location**: the `## 🔓 Self-hosted open source` section of `README.md` and `README.zh-CN.md` (immediately after `CLIProxyAPI`)
- **PR title**: `Add cpa-gate — multi-tenant quota/audit gateway in front of CLIProxyAPI`

**English entry (`README.md`)**:
```markdown
- [cpa-gate](https://github.com/xiaoran7/cpa-gate) <!--s:xiaoran7/cpa-gate-->⭐ ~10<!--/s--> - MIT Node.js reverse proxy that adds per-key daily token quotas, 60-second sliding-window RPM limits and model allowlists in front of CLIProxyAPI, with a circuit breaker, empty-response negative cache, SQLite transactional outbox for usage accounting, and an authenticated proxy for CPA's own management UI.
```

**中文条目（`README.zh-CN.md`）**：
```markdown
- [cpa-gate](https://github.com/xiaoran7/cpa-gate) <!--s:xiaoran7/cpa-gate-->⭐ ~10<!--/s--> - MIT 协议的 Node.js 反向代理，在 CLIProxyAPI 前方提供按 Key 的日 Token 额度、60 秒滑动窗口 RPM 与模型白名单，并带熔断器、空响应负缓存、SQLite 事务性发件箱记账，以及对 CPA 原生管理台的鉴权反代。
```

## 2. talhaanwarch/awesome-llmops-platforms (runner-up)

- **Repository**: https://github.com/talhaanwarch/awesome-llmops-platforms
- **Location**: `README.md` -> the `LLM gateways and routers` table
- **PR title**: `Add cpa-gate to LLM gateways and routers`

```markdown
| 10 | [cpa-gate](https://github.com/xiaoran7/cpa-gate) | Multi-tenant quota, rate-limit and audit gateway in front of CLIProxyAPI, with SQLite transactional outbox accounting. | MIT | 2026-10-19 |
```

## 3. Lists we deliberately do not submit to (avoids wasted PRs)

| Repository | Reason |
|---|---|
| `yenanjing/awesome-model-routing` | Requires 1,000+ stars; we have not reached the threshold |
| `Shubhamsaboo/awesome-llm-apps` | Focuses on applications and Agent templates, not infrastructure gateways |
| `hesreallyhim/awesome-claude-code` | Focuses on Claude Code plugins/workflows; the category does not match |
| `12britz/awesome-ai-gateways`, `wauputr4/awesome-llm-gateways` | Smaller scale (< 50 stars); revisit after the main lists have listed us |

## 4. Suggested repository metadata

- **Description**: `Multi-tenant quota, rate-limit and audit gateway for CLIProxyAPI. Per-key token budgets, model allowlists, circuit breaking, SQLite outbox accounting.`
- **Topics**: `llm-gateway, llm-proxy, cliproxyapi, api-gateway, rate-limiting, token-quota, observability, sqlite, self-hosted, openai-compatible`

<a id="中文版"></a>

# Awesome 列表收录 PR 清单

收录前请核对目标仓库最新的 `CONTRIBUTING.md`。

下方标注「English entry」与「中文条目」的两个 Markdown 块是**逐字提交载荷**——分别原样复制进上游仓库的 `README.md` 与 `README.zh-CN.md`。不要翻译、不要重排、不要"优化"；只有其外围的框架文案是中英双语的。

## 1. cuihuan/awesome-ai-gateway（首选）

- **仓库**：https://github.com/cuihuan/awesome-ai-gateway
- **位置**：`README.md` 与 `README.zh-CN.md` 的 `## 🔓 Self-hosted open source` 小节（紧跟 `CLIProxyAPI` 之后）
- **PR 标题**：`Add cpa-gate — multi-tenant quota/audit gateway in front of CLIProxyAPI`

**英文条目（`README.md`）**：
```markdown
- [cpa-gate](https://github.com/xiaoran7/cpa-gate) <!--s:xiaoran7/cpa-gate-->⭐ ~10<!--/s--> - MIT Node.js reverse proxy that adds per-key daily token quotas, 60-second sliding-window RPM limits and model allowlists in front of CLIProxyAPI, with a circuit breaker, empty-response negative cache, SQLite transactional outbox for usage accounting, and an authenticated proxy for CPA's own management UI.
```

**中文条目（`README.zh-CN.md`）**：
```markdown
- [cpa-gate](https://github.com/xiaoran7/cpa-gate) <!--s:xiaoran7/cpa-gate-->⭐ ~10<!--/s--> - MIT 协议的 Node.js 反向代理，在 CLIProxyAPI 前方提供按 Key 的日 Token 额度、60 秒滑动窗口 RPM 与模型白名单，并带熔断器、空响应负缓存、SQLite 事务性发件箱记账，以及对 CPA 原生管理台的鉴权反代。
```

## 2. talhaanwarch/awesome-llmops-platforms（次选）

- **仓库**：https://github.com/talhaanwarch/awesome-llmops-platforms
- **位置**：`README.md` -> `LLM gateways and routers` 表格
- **PR 标题**：`Add cpa-gate to LLM gateways and routers`

```markdown
| 10 | [cpa-gate](https://github.com/xiaoran7/cpa-gate) | Multi-tenant quota, rate-limit and audit gateway in front of CLIProxyAPI, with SQLite transactional outbox accounting. | MIT | 2026-10-19 |
```

## 3. 暂不提交的列表（避免无效 PR）

| 仓库 | 原因 |
|---|---|
| `yenanjing/awesome-model-routing` | 要求 1,000+ Stars，当前未达门槛 |
| `Shubhamsaboo/awesome-llm-apps` | 聚焦应用与 Agent 模板，非基础设施网关 |
| `hesreallyhim/awesome-claude-code` | 聚焦 Claude Code 插件/工作流，分类不符 |
| `12britz/awesome-ai-gateways`、`wauputr4/awesome-llm-gateways` | 规模较小（< 50 Stars），待主列表收录后再补 |

## 4. 仓库元数据建议

- **Description**: `Multi-tenant quota, rate-limit and audit gateway for CLIProxyAPI. Per-key token budgets, model allowlists, circuit breaking, SQLite outbox accounting.`
- **Topics**: `llm-gateway, llm-proxy, cliproxyapi, api-gateway, rate-limiting, token-quota, observability, sqlite, self-hosted, openai-compatible`

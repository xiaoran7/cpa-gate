# cpa-gate

<div align="center">

<img src="./gate-assets/gate-sakura-mark-v2.png" alt="cpa-gate logo" width="128" />

**High-Performance Resilient LLM API Gateway & Reverse Proxy for CLIProxyAPI**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square&color=0284c7)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg?style=flat-square&color=0284c7)](https://nodejs.org/)
[![Database](https://img.shields.io/badge/SQLite-WAL%20%2B%20Outbox-orange.svg?style=flat-square)](https://sqlite.org/)
[![UI Style](https://img.shields.io/badge/Design-Aozora%20UI%2060FPS-informational.svg?style=flat-square)](https://github.com/xiaoran7/cpa-gate)
[![Tests](https://img.shields.io/badge/tests-14%20suites%20passing-10b981.svg?style=flat-square)](https://github.com/xiaoran7/cpa-gate/actions/workflows/ci.yml)
[![Upstream](https://img.shields.io/badge/upstream-CLIProxyAPI-64748b.svg?style=flat-square)](https://github.com/router-for-me/CLIProxyAPI)

[English](./README.md) | [中文说明](#中文介绍) · [AI Spec (llms-full.txt)](./llms-full.txt)

</div>

---

## Overview

**cpa-gate** is a self-hosted LLM API gateway and reverse proxy built specifically for [CLIProxyAPI (CPA)](https://github.com/router-for-me/CLIProxyAPI). While CPA handles multi-upstream credential aggregation and OAuth refresh, **cpa-gate** sits in front of it (`8316/8317` -> `127.0.0.1:8315`) to provide multi-tenant guardrails and observability:

- **Multi-Tenant API Keys & Protocol Penetration**: Issue independent keys with daily token quotas (`hard_ratio` burst allowance, default `1.2`), 60s sliding-window RPM limits (enforced before quota), and smart model whitelists (exact, wildcard `gpt-4o*`, provider prefix `anthropic/...`, and date suffix `@20250219`). Supports `Authorization: Bearer`, Anthropic `x-api-key`, Azure `api-key`, Gemini `x-goog-api-key`, and URL `?key=` across OpenAI/Anthropic/Gemini REST routes.
- **Resilient Transport Guard**: Circuit breaker on consecutive 5xx, 30s negative cache for empty-output fingerprints, SSE-aware stream accounting (OpenAI & Anthropic `thinking`/`tool_use` deltas), Google Antigravity 403 `VALIDATION_REQUIRED` challenge URL extraction, and opt-in retries (`GATE_MAX_ATTEMPTS`) with continuation healing.
- **Safe CPA Control Plane Proxy**: Serves CPA's management UI under `/admin/upstream/*` with server-side secret injection, while blocking unauthenticated `/v0/management/*` probes to prevent CPA's 30-minute IP-ban trap.
- **Transactional Outbox Durability**: Synchronous writes to SQLite `usage_outbox` (WAL mode) with 5s atomic batch flushes into `usage_daily`, `upstream_daily_stats`, and `request_events`, plus startup crash replay.
- **Aozora UI Dashboard**: 60 FPS vanilla JS console (`/admin`) with minute-slot heartbeats, multi-window traffic charts (`3h20m` to `30d`, `Asia/Shanghai` aligned), credential-first provider attribution, audit/error search, and real-time quota panels (WorkBuddy multi-package & long-term sentinel purification, OpenRouter, Antigravity, OpenCode).

```text
[Clients / Agents] ──(8316 / 8317)──▶ [cpa-gate: Auth · RPM/Quota · Allowlist · Outbox · Guard]
                                                               │ (127.0.0.1:8315)
                                                               ▼
                                      [CLIProxyAPI: Credential Pool · OAuth · Routing] ──▶ [LLMs]
```

---

## Quick Start

**Prerequisites**: Node.js >= 20.0.0 and a running [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) instance on `127.0.0.1:8315`.

```bash
git clone https://github.com/xiaoran7/cpa-gate.git
cd cpa-gate
npm install
cp .env.example .env   # Configure GATE_ADMIN_SECRET and GATE_MGMT_SECRET (>= 24 chars each)
npm start
```

Open `http://127.0.0.1:8317/admin` in your browser.

> `.env` is loaded from the working directory at startup (existing environment variables take precedence). Static assets resolve from the application root; `GATE_DIR` (`./data`) stores SQLite files.

### Production Deployment (systemd)

Install [`gate.service`](./gate.service) to `/etc/systemd/system/gate.service` (configured with `WorkingDirectory=/opt/gate`, `EnvironmentFile=/etc/gate.env`, and `TimeoutStopSec=75` for graceful stream draining & outbox flush):

```bash
systemctl daemon-reload
systemctl enable --now gate
```

---

## Configuration & Endpoints

| Variable | Default | Description |
|---|---|---|
| `GATE_ADMIN_SECRET` | *Required (>=24 chars)* | Bearer secret for `/admin` dashboard and management APIs |
| `GATE_MGMT_SECRET` | *Required (>=24 chars)* | Master plaintext secret configured in upstream CPA |
| `GATE_UPSTREAM_HOST` / `PORT` | `127.0.0.1` / `8315` | Upstream CLIProxyAPI address |
| `GATE_BIND_TARGETS` | `127.0.0.1:8316:...;127.0.0.1:8317:...` | Semicolon-separated `host:port:name` listeners |
| `GATE_DIR` / `GATE_DB` | `./data` / `${GATE_DIR}/gate.db` | Runtime data directory and SQLite path |
| `GATE_STATIC_DIR` | application root | Static UI asset directory (falls back to `GATE_DIR`) |
| `GATE_MAX_REQUEST_BODY_BYTES` | `67108864` (64 MiB) | Max inbound POST payload size |
| `GATE_MAX_ATTEMPTS` | `1` (retries off) | Upstream attempts per request (`1`–`5`) |
| `GATE_UPSTREAM_FAILURE_THRESHOLD` / `COOLDOWN_MS` | `5` / `15000` | Circuit-breaker threshold and cooldown |
| `GATE_METRICS_TOKEN` | *(empty)* | Optional bearer token for `/metrics` |
| `GATE_NOTIFY_WEBHOOKS` / `GATE_UPTIME_KUMA_PUSH_URL` | *(empty)* | Alert webhooks and Uptime Kuma push URL |

**Health & Monitoring**:
- `GET /healthz`: Liveness probe (HTTP 200).
- `GET /readyz`: Readiness probe (HTTP 200 when CPA sync and outbox flush are within 30s).
- `GET /api/status/quota`: Synthetic probe (`200` OK, `429` Quota Exceeded, `503` Degraded; `?strict=1` warns at 85%).
- `GET /metrics`: Prometheus metrics (`gate_*` and legacy `cpa_guard_*`).

---

## Documentation

- **[CPA Upstream Integration](docs/cpa-upstream.md)**: Port topology, management API contract, credential alias hierarchy, and IP-ban defenses.
- **[WorkBuddy / CodeBuddy Quota Integration](docs/workbuddy-integration.md)**: Official metering endpoints, dual-layer sync, multi-package & long-term expiration handling.
- **[llms.txt](./llms.txt)** / **[llms-full.txt](./llms-full.txt)**: Machine-readable specifications for AI assistants.

```bash
npm test   # Run all 14 isolated SQLite test suites
```

---

## Upstream Projects & Attribution

cpa-gate integrates two MIT-licensed upstream projects without forking their core logic:
- **[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)** — Upstream credential aggregation, OAuth session lifecycle, and provider routing.
- **[CLI Proxy API Management Center](https://github.com/router-for-me/Cli-Proxy-API-Management-Center)** — Single-file management UI vendored at `static/management.html` and served behind `/admin/upstream/*`.

When troubleshooting provider credentials or the upstream management UI, check upstream releases, issues, and PRs first before patching locally.

---

<div id="中文介绍"></div>

## 中文介绍

**cpa-gate** 是位于 [CLIProxyAPI (CPA)](https://github.com/router-for-me/CLIProxyAPI) 前方的高性能自建 LLM API 网关与反向代理：
- **多租户与多协议鉴权**：按 Key 配置日 Token 硬限额、60s 滑动窗口 RPM 与智能模型白名单（支持通配符、厂商前缀与日期后缀），穿透识别 Bearer、`x-api-key`、`api-key`、`x-goog-api-key` 及 URL `?key=`；
- **弹性传输与流式守卫**：5xx 熔断器、30s 空响应负缓存、OpenAI/Anthropic 深度思考与工具流式语义识别、Google 403 验证链接提取及可选重试续写（`GATE_MAX_ATTEMPTS`）；
- **安全反代 CPA 控制台**：服务端内存注入 `GATE_MGMT_SECRET` 代理 `/admin/upstream/*`，外层拦截未授权 `/v0/management/*` 探测以防触发 CPA 30 分钟 IP 连坐封禁；
- **事务性发件箱记账**：SQLite WAL + `usage_outbox` 先入库后核算，5 秒原子刷盘，崩溃重启自动回放；
- **Aozora UI 60 FPS 控制台**：提供分钟级心跳、东八区对齐的多窗口吞吐趋势、基于真实凭证 `auth_index` 的提供商归属核算、审计检索及多上游实时配额看板。

快速启动请参考上方 [Quick Start](#quick-start)。遵循 [MIT License](LICENSE) 开源。

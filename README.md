# cpa-gate

<div align="center">

<img src="./gate-assets/gate-sakura-mark-v2.png" alt="cpa-gate logo" width="128" />

# cpa-gate
**High-Performance Resilient LLM API Gateway & Reverse Proxy for CLIProxyAPI**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square&color=0284c7)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg?style=flat-square&color=0284c7)](https://nodejs.org/)
[![Database](https://img.shields.io/badge/SQLite-WAL%20%2B%20Outbox-orange.svg?style=flat-square)](https://sqlite.org/)
[![UI Style](https://img.shields.io/badge/Design-Aozora%20UI%2060FPS-informational.svg?style=flat-square)](https://github.com/xiaoran7/cpa-gate)
[![Tests](https://img.shields.io/badge/tests-13%20suites%20passing-10b981.svg?style=flat-square)](https://github.com/xiaoran7/cpa-gate/actions/workflows/ci.yml)
[![Upstream](https://img.shields.io/badge/upstream-CLIProxyAPI-64748b.svg?style=flat-square)](https://github.com/router-for-me/CLIProxyAPI)

[English](./README.md) | [中文说明](#中文介绍) · [AI-readable spec (llms-full.txt)](./llms-full.txt)

</div>

---

## Overview

**cpa-gate** is a high-performance, resilient, and self-hosted LLM API gateway and reverse proxy crafted specifically for [CLIProxyAPI (CPA)](https://github.com/router-for-me/CLIProxyAPI).

While CLIProxyAPI excels at multi-upstream LLM credential aggregation and OAuth session orchestration, **cpa-gate** sits in front of it to provide production-grade guardrails:
- **Multi-tenant API Key Isolation & Management**: Issue custom API keys with independent token quotas, sliding-window RPM limits, and model whitelists.
- **Resilient Transport Guard**: Circuit breaking, negative caching of empty responses, optional retries with `Retry-After` awareness, and an SSE-aware continuation healing payload.
- **Safe CPA Management Console Brokering**: Reverse proxy CPA's internal management interface without exposing upstream master keys to the browser, while shielding against CPA's internal IP-ban triggers.
- **Durable Local Accounting**: SQLite WAL mode + Transactional Outbox pattern guarantees accounting rows survive process crashes and restarts.
- **Aozora UI Unified Dashboard**: High-aesthetic 60 FPS single-page management console with service heartbeats, TTFT/latency tracking, provider distribution charts, and credential quota diagnostics.

```text
  [Clients: Web Apps / Cursor / Cline / Coding Assistant / Custom Agents]
                               │
                        (Port 8316 / 8317)
                               ▼
  ┌──────────────────────────────────────────────────────────────┐
  │                           cpa-gate                           │
  │  ┌───────────────────┐  ┌──────────────────┐  ┌───────────┐  │
  │  │ Multi-Tenant Keys │  │ RPM / Quota O(1) │  │  Outbox   │  │
  │  │ Model Whitelists  │  │ Circuit Breakers │  │  SQLite   │  │
  │  └───────────────────┘  └──────────────────┘  └───────────┘  │
  │  ┌─────────────────────────────────────────────────────────┐ │
  │  │  Transport Guard (SSE semantics, retries, healing)      │ │
  │  └─────────────────────────────────────────────────────────┘ │
  └──────────────────────────────┬───────────────────────────────┘
                                 │ HTTP (127.0.0.1:8315)
                                 ▼
  ┌──────────────────────────────────────────────────────────────┐
  │                      CLIProxyAPI (CPA)                       │
  │       (Token Pool / OAuth Refresh / Model Routing)           │
  └──────┬──────────────┬──────────────┬──────────────┬──────────┘
         ▼              ▼              ▼              ▼
     [Claude]       [Gemini]        [GPT-4o]      [DeepSeek] ...
```

---

## Key Features

### 1. Multi-Tenant Key Management & Quota Guard
- **Daily Quotas**: Strict token limit per API key with configurable burst allowance (`hard_ratio`, default 1.2).
- **Sliding-Window RPM Limiting**: 60-second sliding rate window per key, returning clean 429 with `Retry-After`, applied before quota so bursts do not burn the daily budget.
- **Dynamic Model Whitelist**: Filter `/v1/models` outputs and reject unapproved models at gateway boundaries.
- **Key Rotation & Granular Control**: Key rotation through CPA's management API, per-key aliases, and instant revocation.

### 2. Resilient Transport Guard & Empty Output Healing
- **Circuit Breaker**: Consecutive upstream 5xx failures open a cooldown window and fail fast with `Retry-After`.
- **Fast-Fail Negative Cache**: Caches empty-output payload fingerprints for 30s to prevent upstream abuse.
- **Retries & Continuation Healing** (opt-in): With `GATE_MAX_ATTEMPTS>=2`, transient 5xx, bounded 429 `Retry-After`, and pre-commit network failures are retried; the third attempt injects a gentle continuation prompt to recover from reasoning-only or empty stops.
- **SSE-Aware Stream Accounting**: Correctly handles CRLF splits, UTF-8 chunk boundaries, BOMs, and incomplete EOF; empty streams are detected rather than billed as success.
- **Google Antigravity 403 Auto-Interception**: Parses and formats `VALIDATION_REQUIRED` challenge URLs to unblock Google OAuth credentials seamlessly.

### 3. Native CPA Control Plane Proxy
- **Zero-Secret Browser Exposure**: CPA master keys never leave the server; Gate proxies and authenticates management API calls transparently.
- **Anti-Brute Force Protection**: Directly shields against CPA's internal 30-minute IP-ban trap caused by direct unauthorized probes.
- **Deep Upstream Diagnostics**: Unifies CPA runtime facts with Gate's high-precision token analytics.

### 4. Transactional Outbox Durability
- Synchronous logging to `usage_outbox` prior to memory accounting.
- Periodic 5s atomic flush commits daily rollups, upstream-per-credential stats, request events, and purges outbox entries in one transaction.
- Uncommitted outbox replay on startup so a crash neither loses usage nor under-counts quota.

### 5. Aozora UI Control Center
- Ultra-clean light-blue responsive theme with monochrome thin-line vector SVG icons (zero emoji pollution).
- **Service Status**: Visual minute-slot heartbeat bars (60-minute window) and 7-day availability tracking.
- **Runtime Overview**: Throughput charts over selectable windows, error categorization tooltips, and click-to-filter audit jumps.
- **Audit Center & Error Logs**: Search the request stream by API Key alias, model, provider, or HTTP status with full latency and tokens/sec metrics.
- **Per-Provider Quota Panels**: WorkBuddy multi-package expiration, OpenRouter call counts, Antigravity model groups, and OpenCode daily usage.

---

## Quick Start

### Prerequisites
- Node.js >= 20.0.0
- npm / yarn / pnpm
- A running [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) instance (defaulting to `127.0.0.1:8315`)

### Installation & Run

```bash
# 1. Clone repository
git clone https://github.com/xiaoran7/cpa-gate.git
cd cpa-gate

# 2. Install dependencies (only better-sqlite3 is required)
npm install

# 3. Configure environment (.env is read from the current working directory)
cp .env.example .env
# Edit .env and configure strong secrets (GATE_ADMIN_SECRET, GATE_MGMT_SECRET)

# 4. Start cpa-gate
npm start
```

Visit `http://127.0.0.1:8317/admin` in your browser to access the management dashboard.

> `.env` values are loaded at startup; variables already present in the process environment take precedence. Static UI assets are served from the application root, so `GATE_DIR` only needs to hold SQLite data.

---

## Production Deployment

### systemd Service

The repository ships [`gate.service`](./gate.service). Install it as `/etc/systemd/system/gate.service`:

```ini
[Unit]
Description=Gate — LLM API Gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/gate
ExecStart=/usr/bin/node /opt/gate/server.mjs
EnvironmentFile=/etc/gate.env
Restart=always
RestartSec=3
TimeoutStopSec=75
KillMode=control-group
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/opt/gate

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
systemctl daemon-reload
systemctl enable --now gate
```

> `TimeoutStopSec=75` leaves room for in-flight streaming requests to drain on restart; cpa-gate flushes the outbox before exiting.

---

## Configuration Reference

| Environment Variable | Default | Description |
|---|---|---|
| `GATE_ADMIN_SECRET` | *Required (>=24 chars)* | Bearer secret for `/admin` dashboard and management APIs |
| `GATE_MGMT_SECRET` | *Required (>=24 chars)* | Master plaintext secret configured in upstream CPA |
| `GATE_UPSTREAM_HOST` | `127.0.0.1` | Host where CLIProxyAPI is listening |
| `GATE_UPSTREAM_PORT` | `8315` | Port where CLIProxyAPI is listening |
| `GATE_DIR` | `./data` | Directory for databases and runtime data |
| `GATE_DB` | `${GATE_DIR}/gate.db` | Main SQLite database file |
| `GATE_STATIC_DIR` | application root | Where `admin.html`, `admin-*.js/css`, `gate-assets/` live |
| `GATE_BIND_TARGETS` | `127.0.0.1:8316:...;127.0.0.1:8317:...` | Semicolon-separated `host:port:name` list |
| `GATE_MAX_REQUEST_BODY_BYTES` | `67108864` (64 MiB) | Maximum inbound POST request payload size |
| `GATE_MAX_ATTEMPTS` | `1` (retries disabled) | Upstream attempts per request, clamped to 1–5 |
| `GATE_UPSTREAM_FAILURE_THRESHOLD`| `5` | Consecutive failures before circuit-breaker activates |
| `GATE_UPSTREAM_COOLDOWN_MS` | `15000` (15s) | Circuit-breaker cooldown window |
| `GATE_METRICS_TOKEN` | *(empty)* | Optional bearer token for `/metrics` |
| `GATE_NOTIFY_WEBHOOKS` | *(empty)* | Webhook endpoints for quota/health alerts |
| `GATE_UPTIME_KUMA_PUSH_URL` | *(empty)* | Uptime Kuma push notification endpoint |

---

## Health & Monitoring Endpoints

- **`/healthz`**: Liveness probe (HTTP 200).
- **`/readyz`**: Readiness probe (returns HTTP 200 only after successful CPA key sync and outbox flush).
- **`/api/status/quota`**: Synthetic health probe for Uptime Kuma (200 = OK, 429 = Quota Exceeded, 503 = Storage Degraded). Supports `?strict=1` for 85% quota early warning.
- **`/metrics`**: Prometheus-compatible metrics endpoint (emits `gate_*` series, plus legacy `cpa_guard_*` aliases).

---

## Documentation

- **[CPA Upstream Integration Specification](docs/cpa-upstream.md)**: Network topology, management API contracts, and anti-brute force defenses.
- **[Tencent WorkBuddy / CodeBuddy Quota Integration](docs/workbuddy-integration.md)**: Official metering endpoints, data contracts, multi-package expiration, and in-place cache hydration.
- **[llms.txt](./llms.txt)** / **[llms-full.txt](./llms-full.txt)**: Concise and full machine-readable specifications for AI assistants and deep-research engines.

---

## Testing

cpa-gate includes an extensive test suite verifying route contracts, AST syntax safety, transactional outbox durability, SSE parsing, credential attribution, and cache hydration:

```bash
# Run all suites (uses isolated temporary SQLite databases)
npm test
```

---

## Upstream Projects & Attribution

cpa-gate is built around two MIT-licensed upstream projects. Their modules stay at the upstream boundary rather than being forked:

- **[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)** — credential aggregation, OAuth session lifecycle, and provider routing. cpa-gate proxies the data plane to it and calls its management API; all credential logic remains upstream.
- **[CLI Proxy API Management Center](https://github.com/router-for-me/Cli-Proxy-API-Management-Center)** — the single-file management UI vendored at `static/management.html` and served behind cpa-gate's authenticated `/admin/upstream/*` proxy.

If you hit a bug in either of those modules, check the upstream releases, issues, and pull requests first before patching locally.

---

<div id="中文介绍"></div>

## 中文介绍

**cpa-gate** 是专为 [CLIProxyAPI (CPA)](https://github.com/router-for-me/CLIProxyAPI) 打造的高性能、高弹性自建 LLM API 网关与反向代理。

CPA 专注于各家上游模型凭证与 OAuth 账号池的汇聚聚合，而 **cpa-gate** 则在其前方构筑了一道坚固可靠的企业级生产防护墙：
- **多租户 API Key 隔离与分发**：支持发放独立的租户密钥、按日 Token 额度上限硬限制、60 秒滑动窗口 RPM 限制以及模型权限白名单；
- **智能弹性传输防护**：熔断器、空响应负缓存、可选重试与 `Retry-After` 感知、SSE 语义解析；当 `GATE_MAX_ATTEMPTS>=2` 时，后续尝试会注入柔和的续写提示挽救空响应；
- **安全代理 CPA 原生控制台**：在完全不暴露 CPA 后台 Master 密码的前提下，向前端反代 CPA 原生管理界面，并彻底拦截可能导致上游触发 30 分钟 IP 封禁的恶意探测；
- **事务性发件箱持久化（SQLite WAL + Outbox）**：采用事务性发件箱机制，先入库再核算，进程崩溃或重启后自动回放，用量账目零丢失；
- **Aozora UI 极简科技看板**：60 FPS 流畅单色细线条矢量仪表盘，提供分钟级心跳健康条、TTFT 首字延迟、吞吐趋势、服务商配额面板与请求明细检索。

### 快速开始

```bash
git clone https://github.com/xiaoran7/cpa-gate.git
cd cpa-gate
npm install
cp .env.example .env    # 填写 GATE_ADMIN_SECRET 与 GATE_MGMT_SECRET（各不少于 24 位）
npm start
```

浏览器打开 `http://127.0.0.1:8317/admin`。

> 启动时会读取当前工作目录下的 `.env`，进程环境变量优先。静态页面资源从安装根目录提供，`GATE_DIR` 只需存放 SQLite 数据。

---

## License

This project is licensed under the [MIT License](LICENSE).

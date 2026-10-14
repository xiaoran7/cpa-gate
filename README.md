# cpa-gate

<div align="center">

<img src="./gate-assets/gate-sakura-mark-v2.png" alt="cpa-gate logo" width="128" />

# cpa-gate
**High-Performance Resilient LLM API Gateway & Reverse Proxy for CLIProxyAPI**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org/)
[![Database](https://img.shields.io/badge/SQLite-WAL%20%2B%20Outbox-orange.svg)](https://sqlite.org/)
[![UI Style](https://img.shields.io/badge/Design-Aozora%20UI%2060FPS-informational.svg)](#dashboard-preview)

[English](./README.md) | [中文说明](#中文介绍)

</div>

---

## Overview

**cpa-gate** is a high-performance, resilient, and self-hosted LLM API gateway and reverse proxy crafted specifically for [CLIProxyAPI (CPA)](https://github.com/eceasy/cli-proxy-api). 

While CLIProxyAPI excels at multi-upstream LLM credential aggregation and OAuth session orchestration, **cpa-gate** sits in front of it to provide production-grade enterprise guardrails:
- **Multi-tenant API Key Isolation & Management**: Issue custom API keys with independent token quotas, sliding-window RPM limits, and model whitelists.
- **Resilient Transport & Self-Healing Retries**: Transparent retry on transient upstream 5xx errors, SSE stream dropouts, and empty model outputs.
- **Safe CPA Management Console Brokering**: Reverse proxy CPA's internal management interface without exposing upstream master keys to the browser, while shielding against CPA's internal IP-ban triggers.
- **Durable Local Accounting**: SQLite WAL mode + Transactional Outbox pattern guarantees zero token loss across restarts.
- **Aozora UI Unified Dashboard**: High-aesthetic 60 FPS single-page management console with minute-level heartbeats, TTFT/latency tracking, provider distribution charts, and credential cooldown diagnostics.

```text
  [Clients: Web Apps / Cursor / Cline / Claude Code / Custom Agents]
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
  │  │ Self-Healing Transport (Continuation & Stream Retries)  │ │
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
- **Sliding-Window RPM Limiting**: 60-second sliding rate window per key, returning clean 429 with `Retry-After`.
- **Dynamic Model Whitelist**: Filter `/v1/models` outputs and reject unapproved models at gateway boundaries.
- **Key Rotation & Granular Control**: Zero-downtime key rotation, per-key aliases, and instant revocation.

### 2. Resilient Transport Guard & Empty Output Healing
- **3-Attempt Safe Retry**: Transparently handles incomplete SSE chunks, transient 5xx, or empty network returns.
- **Continuation Self-Healing**: Detects empty stops or reasoning-only terminations, injecting polite continuation prompts on final attempts to recover usable outputs.
- **Fast-Fail Negative Cache**: Caches invalid payload fingerprints for 30s to prevent upstream abuse.
- **Google Antigravity 403 Auto-Interception**: Parses and formats `VALIDATION_REQUIRED` challenge URLs to unblock Google OAuth credentials seamlessly.

### 3. Native CPA Control Plane Proxy
- **Zero-Secret Browser Exposure**: CPA master keys never leave the server; Gate proxies and authenticates management API calls transparently.
- **Anti-Brute Force Protection**: Directly shields against CPA's internal 30-minute IP-ban trap caused by direct unauthorized probes.
- **Deep Upstream Diagnostics**: Unifies CPA runtime facts with Gate's high-precision token analytics.

### 4. Zero-Loss SQLite Durability (Transactional Outbox)
- Synchronous logging to `usage_outbox` prior to memory accounting.
- Periodic 5s atomic flush commits daily rollups, request events, and purges outbox entries.
- Uncommitted outbox replay on startup ensures 100% financial audit accuracy.

### 5. Aozora UI Control Center
- Ultra-clean light-blue responsive theme with monochrome thin-line vector SVG icons (zero emoji pollution).
- **Service Status**: Visual minute-slot heartbeat bars (60-minute window) and 7-day availability tracking.
- **Runtime Overview**: 20-bucket throughput charts, error categorization tooltips, and click-to-filter audit jumps.
- **Audit Center & Error Logs**: Search request stream by API Key alias, user token, or HTTP status with full latency metrics.

---

## Quick Start

### Prerequisites
- Node.js >= 20.0.0
- npm / yarn / pnpm
- A running [CLIProxyAPI](https://github.com/eceasy/cli-proxy-api) instance (defaulting to `127.0.0.1:8315`)

### Installation & Run

```bash
# 1. Clone repository
git clone https://github.com/xiaoran7/cpa-gate.git
cd cpa-gate

# 2. Install dependencies (only better-sqlite3 is required)
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env and configure strong secrets (GATE_ADMIN_SECRET, GATE_MGMT_SECRET)

# 4. Start cpa-gate
npm start
```

Visit `http://127.0.0.1:8317/admin` in your browser to access the management dashboard.

---

## Production Deployment

### systemd Service

Create `/etc/systemd/system/gate.service`:

```ini
[Unit]
Description=cpa-gate LLM API Gateway
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/cpa-gate
EnvironmentFile=/etc/gate.env
ExecStart=/usr/bin/node server.mjs
Restart=always
RestartSec=3
LimitNOFILE=65536
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
systemctl daemon-reload
systemctl enable --now gate
```

---

## Configuration Reference

| Environment Variable | Default | Description |
|---|---|---|
| `GATE_ADMIN_SECRET` | *Required (>=24 chars)* | Bearer secret for `/admin` dashboard and management APIs |
| `GATE_MGMT_SECRET` | *Required (>=24 chars)* | Master plaintext secret configured in upstream CPA |
| `GATE_UPSTREAM_HOST` | `127.0.0.1` | Host where CLIProxyAPI is listening |
| `GATE_UPSTREAM_PORT` | `8315` | Port where CLIProxyAPI is listening |
| `GATE_DIR` | `./data` | Directory for databases and runtime files |
| `GATE_DB` | `${GATE_DIR}/gate.db` | Main SQLite database file |
| `GATE_BIND_TARGETS` | `127.0.0.1:8316:...;127.0.0.1:8317:...` | Semicolon-separated `host:port:name` list |
| `GATE_MAX_REQUEST_BODY_BYTES` | `67108864` (64 MiB) | Maximum inbound POST request payload size |
| `GATE_UPSTREAM_FAILURE_THRESHOLD`| `5` | Consecutive failures before circuit-breaker activates |
| `GATE_UPSTREAM_COOLDOWN_MS` | `15000` (15s) | Circuit-breaker cooldown window |
| `GATE_NOTIFY_WEBHOOKS` | *(empty)* | Webhook endpoints for quota/health alerts |
| `GATE_UPTIME_KUMA_PUSH_URL` | *(empty)* | Uptime Kuma push notification endpoint |

---

## Health & Monitoring Endpoints

- **`/healthz`**: Liveness probe (HTTP 200).
- **`/readyz`**: Readiness probe (returns HTTP 200 only after successful CPA key sync and outbox flush).
- **`/api/status/quota`**: Synthetic health probe for Uptime Kuma (200 = OK, 429 = Quota Exceeded, 503 = Storage Degraded). Supports `?strict=1` for 85% quota early warning.
- **`/metrics`**: Prometheus-compatible metrics endpoint (emits `gate_*` series).

---

## Testing

cpa-gate includes an extensive test suite verifying route contracts, AST syntax safety, transactional outbox durability, and cache hydration:

```bash
# Run all integration tests (uses isolated temporary SQLite databases)
npm test
```

---

<div id="中文介绍"></div>

## 中文介绍

**cpa-gate** 是专为 [CLIProxyAPI (CPA)](https://github.com/eceasy/cli-proxy-api) 打造的高性能、高弹性自建 LLM API 网关与反向代理。

CPA 专注于各家上游模型凭证与 OAuth 账号池的汇聚聚合，而 **cpa-gate** 则在其前方构筑了一道坚固可靠的企业级生产防护墙：
- **多租户 API Key 隔离与分发**：支持发放独立的租户密钥、按日 Token 额度上限硬限制、60 秒滑动窗口 RPM 限制以及模型权限白名单；
- **智能弹性传输与空响应自愈**：上游出现偶发网络抖动、5xx 错误、SSE 流截断或模型吐空时，自动发起透明重试；并在最终尝试时下发柔和补救 Payload 挽救空响应；
- **安全代理 CPA 原生控制台**：在完全不暴露 CPA 后台 Master 密码的前提下，向前端反代 CPA 原生管理界面，并彻底拦截可能导致上游触发 30 分钟 IP 封禁的恶意探测；
- **零丢失本地持久化（SQLite WAL + Outbox）**：采用事务性发件箱（Transactional Outbox）机制，先入库再核算，进程重启或断电零丢字数；
- **Aozora UI 极简科技看板**：60 FPS 流畅单色细线条矢量仪表盘，提供分钟级心跳健康条、TTFT 首字延迟、吞吐趋势与请求明细检索。

---

## License

This project is licensed under the [MIT License](LICENSE).

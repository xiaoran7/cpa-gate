# CPA 上游集成规范与技术契约 (CPA Upstream Integration Specification)

本文件记录 Gate 与上游 CLIProxyAPI (CPA) 协同工作时的网络拓扑、管理 API 契约与关键运维经验。

---

## 1. 架构与端口拓扑 (Network Topology)

Gate 作为高性能网关，常驻于 CPA 前方，解耦生产数据流量与后台管理通道：

```text
  [Client Inbound]
         │
         ▼
┌──────────────────┐
│   Gate (Proxy)   │ ─── 8316 (Nginx / OpenResty 反向代理入口)
│                  │ ─── 8317 (本地 / 局域网直连数据面入口)
└────────┬─────────┘
         │ (HTTP 127.0.0.1:8315)
         ▼
┌──────────────────┐
│   CLIProxyAPI    │ ─── 8315 (仅对本地环回 127.0.0.1 暴露)
└──────────────────┘
```

| 监听端口 | 归属服务 | 角色说明 |
|---|---|---|
| `127.0.0.1:8315` | CLIProxyAPI | 宿主机本地发布端口，作为 Gate 的上游（`GATE_UPSTREAM_*` / `GATE_MGMT_*` 默认值） |
| `127.0.0.1:8316` | Gate 网关 | 接受反向代理（如 Nginx / OpenResty）流量 |
| `127.0.0.1:8317` | Gate 网关 | 本地 / VPN 内网直连入口 |

> **排障注意**：Gate 的健康探测接口为 `/healthz` 和 `/readyz`，`/health` 默认返回 404，请直接探测指定的数据端口。

---

## 2. 管理 API 契约与凭据安全 (Management API Contract)

Gate 内部模块通过 `GATE_MGMT_SECRET` 访问 CPA 的 `/v0/management/*` 与 `/v8/management/*`。

### 2.1 密钥来源防踩坑
**CPA 启动时会将其配置文件中的 `remote-management.secret-key` 原地替换为 bcrypt 哈希**（形如 `$2b$10$...`）。
- **严禁**：拿 CPA 配置文件中的哈希密钥直接请求管理接口，否则会收到 401 认证失败。
- **正解**：明文密钥应仅在环境变量 `GATE_MGMT_SECRET` 中配置。

### 2.2 核心端点映射
- 凭据列表：`/v0/management/auth-files`、`/v0/management/api-keys`
- 凭据字段热更新：`PATCH /v0/management/auth-files/fields`，Body 形如 `{ name, ...fields }`，支持动态调整 `priority` (0–1000)、`weight` (1–1000)、`note`、`proxy_url`、`disabled`、`disable_cooling` 等。
- 调度优先级兜底：**上游凭据未显式设置 `priority` 时，CPA 默认按 0 调度**。Gate 的 `DEFAULT_AUTH_PRIORITY` 默认对齐为 0。

---

## 3. 防暴力破解与 IP 封禁连坐陷阱 (Anti-Brute Force Protection)

### 3.1 故障现象
若外界使用错误密钥高频探测 CPA 原生管理路由，或管理控制台被未授权探查，CPA 会触发内存级防爆机制（封禁来源 IP 约 30 分钟），返回：
```json
{"error":"IP banned due to too many failed attempts. Try again in 28m55s"}
```
由于 Gate 与运维 Shell 同在 `127.0.0.1`，误探会直接导致 Gate 与 CPA 间的后台同步接口被连坐封禁。

### 3.2 Gate 的防御加固方案
1. **控制台受控反代通道**：Gate 实现了 `/admin/upstream/*` 反向代理通道，向前端提供受控管理控制台，由服务端在内存中注入有效 `GATE_MGMT_SECRET`，并透明重写管理请求 URL；
2. **根路径直达拦截**：非管理员直接请求 `/v0/management/*` 或 `/management.html` 时，Gate 直接在最外层拦截并拦截恶意探针，彻底阻断触发上游 IP 封禁的可能；
3. **数据面与管理面隔离**：即使管理面不慎遭遇上游内存封禁，数据面（`/v1/*` 推理流量）依然正常走 API Key 认证，服务绝不中断。
4. **清除方式**：CPA 该封禁状态**仅驻留于内存**，重启 CPA 容器或进程即可瞬间解除，无需等待 30 分钟。

---

## 4. 特殊上游计量与自治扩展 (Special Upstream Metering)

对于具备独立官方计量端点且未被 CPA 深度原生聚合的上游（如腾讯 WorkBuddy / CodeBuddy、OpenRouter 等），Gate 采用自治拓展方案直接对接上游官方接口：
- **腾讯 WorkBuddy / CodeBuddy 资源计量与积分呈现**：详见 [workbuddy-integration.md](workbuddy-integration.md)。
- **Google Antigravity 官方客户端版本门槛与多端点容灾**：
  - **版本门槛（Client UA Threshold）**：Google 服务端对 `retrieveUserQuotaSummary` 接口增加了客户端版本判定，要求客户端版本必须 `>= 1.2.0`。使用老旧版本（如 `1.0.13`）会被静默降级为只下发 `Claude and GPT models`；Gate 统一切换为官方 CLI 最新 `antigravity/cli/1.3.6 (aidev_client; os_type=darwin; arch=arm64)`。
  - **多端点容灾轮询（Multi-Endpoint Fallback）**：按序探测 `daily-cloudcode-pa.googleapis.com`、`cloudcode-pa.googleapis.com` 与 `daily-cloudcode-pa.sandbox.googleapis.com`，当且仅当响应包含完整的 Gemini 模型组时才提交生效。



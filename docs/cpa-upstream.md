# CPA 上游集成规范 (CPA Upstream Integration)

记录 Gate 与上游 CLIProxyAPI (CPA) 协同的端口拓扑、管理 API 契约与防封禁机制。

## 1. 端口拓扑

| 监听地址 | 服务 | 角色说明 |
|---|---|---|
| `127.0.0.1:8315` | CLIProxyAPI | 上游实例（`GATE_UPSTREAM_*` / `GATE_MGMT_*` 默认值） |
| `127.0.0.1:8316` | Gate | 反向代理（Nginx / OpenResty）入口 |
| `127.0.0.1:8317` | Gate | 本地 / Tailnet 内网直连入口 |

> 健康探针为 `/healthz`（存活）和 `/readyz`（就绪，需 CPA 同步与 Outbox 刷盘在 30s 内），`/health` 返回 404。

## 2. 管理 API 契约与凭据安全

Gate 通过环境变量 `GATE_MGMT_SECRET` 访问 CPA 的 `/v0/management/*` 与 `/v8/management/*`。

- **严禁读取 CPA 配置文件中的哈希密钥**：CPA 启动时会将 `remote-management.secret-key` 原地替换为 `$2b$10$...` bcrypt 哈希，直接拿哈希请求会触发 401；`GATE_MGMT_SECRET` 必须填明文密钥。
- **核心端点**：
  - 凭据与密钥列表：`GET /v0/management/auth-files`、`GET /v0/management/api-keys`
  - 凭据字段热更新：`PATCH /v0/management/auth-files/fields`（Body: `{ name, priority, weight, note, nickname, label, proxy_url, disabled, disable_cooling }`）
  - 调度默认值：CPA 未显式设置 `priority` 时默认按 `0` 调度，`GATE_DEFAULT_AUTH_PRIORITY` 对齐为 `0`（权重默认 `1`）。
- **凭证别名优先级**：`resolveAuthAccountDisplayName` 按 `nickname` -> `label` 括号内非区域词 -> 非通用 `email` -> 自定义 `label` -> 剥离 `.json` 的文件名 -> 16 位 `auth_index` 依次回退。

## 3. 防暴力破解与 IP 封禁隔离

CPA 对重复 401 管理探测会触发内存级 IP 封禁（约 30 分钟，`IP banned due to too many failed attempts`）。因 Gate 与 CPA 同在 `127.0.0.1`，外部未授权误探会连坐封禁 Gate 后台同步。

**Gate 防御机制**：
1. **受控反代 `/admin/upstream/*`**：前端仅持 `GATE_ADMIN_SECRET`，由 Gate 服务端在内存中注入 `GATE_MGMT_SECRET` 转发，主密钥永不下发浏览器。
2. **直达拦截**：非管理员直接请求 `/v0/management/*`、`/v8/management/*` 或 `/management.html` 一律在 Gate 外层返回 403。
3. **跨仓静态同步**：`static/management.html` 源头在 `Project/cliproxyapi`，修改后必须同步至本仓并校验 MD5 一致，部署后执行 `systemctl restart gate`。
4. **解除封禁**：CPA 封禁仅驻留内存，重启 CPA 进程/容器即可解除。

## 4. 特殊上游自治计量

- **腾讯 WorkBuddy / CodeBuddy**：详见 [workbuddy-integration.md](workbuddy-integration.md)。
- **Google Antigravity**：
  - **UA 门槛**：`retrieveUserQuotaSummary` 要求客户端版本 `>= 1.2.0`（旧版仅返回 Claude/GPT 组），Gate 统一使用 `antigravity/cli/1.3.6 (aidev_client; os_type=darwin; arch=arm64)`。
  - **多端点容灾**：按序轮询 `daily-cloudcode-pa.googleapis.com`、`cloudcode-pa.googleapis.com`、`daily-cloudcode-pa.sandbox.googleapis.com`，仅当响应包含完整 Gemini 模型组时采纳。

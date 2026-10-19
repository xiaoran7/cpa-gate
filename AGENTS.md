# 项目规则

## 工作约定

- 只在本项目内维护规则、记忆和产物；跨仓操作须有任务依据。先检查 Git 状态，保留其他会话改动；提交、推送、部署分别按用户授权执行。
- 按当前代码、清单和配置核对文档；测试、设备验收和生产状态分别报告，历史记录不能证明当前可用。
- 不提交凭据、私钥、Cookie、真实个人资料或运行数据库。删改前核对路径、归属和用途，不动他人改动、源素材、签名材料及私人日志。
- 发版或部署必须递增实际产品版本并同步相关清单；Android/Harmony 同步 versionCode/versionName。纯文档整理不虚构发版。
- README 放启动与导航；本文件放约束；docs 放契约和经验；CHANGELOG 放历史；MEMORY 放偏好。同一事实只维护一处，删改同步修复引用；Markdown 用 UTF-8 无 BOM。
- 临时产物放本项目 `_scratch/`，交付物用项目既定路径或 `Deliverables/`；验证新版后清理本项目过期产物，保留必要回滚及指定基线。收尾只停止本次启动的进程。

## 项目边界

- **职责与拓扑**：本仓是 CLIProxyAPI (`127.0.0.1:8315`) 前方的多租户网关与反向代理（默认监听 `8316` 反代入口、`8317` 本地直连）；上游凭据存储与 OAuth 刷新留在 CPA，本仓负责多协议 Key 鉴权、RPM/Token 限额、模型白名单、传输守卫、SQLite Outbox 记账与 `/admin` 控制台。
- **跨仓静态同步红线**：`static/management.html` 源头在 `Project/cliproxyapi`；源头变更必须同步复制到本仓并校验 MD5 一致，部署替换后必须执行 `systemctl restart gate` 并走 `/admin/upstream/management.html` 鉴权路径验证。
- **版本与防缓存同步**：发版递增 `package.json`（及 `package-lock.json`）版本时，必须同步更新 `admin.html` 中的版本徽章与 `admin-*.js/css?v=` 缓存参数。
- **验证与深入文档**：代码改动必须通过 `npm test`（14 个隔离 SQLite 测试套件，含 `test_repo_hygiene.mjs` 凭据扫描）。深入契约见 [docs/cpa-upstream.md](docs/cpa-upstream.md)、[docs/workbuddy-integration.md](docs/workbuddy-integration.md) 与 [llms-full.txt](llms-full.txt)。

长期偏好见 [MEMORY.md](MEMORY.md)。

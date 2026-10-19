# Gate (formerly CPA Stream Guard) Changelog

## [v2.10.5] - 2026-10-19

实施 WorkBuddy 远期基础包语义净化 (方案 A: 长期有效与包名排版防截断)：

- **WorkBuddy 远期基础包语义净化（Long-Term Sentinel Semantic Purification）**：
  1. **语义净化与去除机械倒计时**：针对腾讯 API 为 `Free Plan Subscription` / `CodeBuddy个人体验版` 等基础额度包返回的远期哨兵时间戳（如 `2035-01-15`，~8.24 年），在 `admin-quotas.js` 的 `getWorkBuddyExpirationInfo` 中自动识别远期基础包（到期时间 ≥ 3 年或包名包含 Free Plan/体验/免费且 > 1 年），将展示文本直接净化为「长期有效」，倒计时文本置空（消除冗余的机械天数或年数括号），颜色统一为健康安心的翡翠绿（`#10b981`）；在悬浮 tooltip 中依然完整保留北京时间物理时间戳（如 `2035-01-15 20:57:00`）供精确核查；
  2. **账号总览状态智能对齐**：当账号下所有资源包均为长期有效时，卡片顶部到期栏自适应切换为 `⏱️ 积分额度: 长期有效`（隐藏机械的“首批到期”）；若存在月度限期包与长期包混合，首批到期自动精准锚定紧迫的限期包，绝不被 2035 长期包篡夺或混淆；
  3. **紧凑表格与大盘总览协同**：在凭证紧凑模式表格行中，全量长期包状态显示为 `积分额度: 长期有效`；在运行总览大盘大卡中协同显示为高亮绿色的 `长期有效`；
- **资源包名称排版自适应放宽（Adaptive Package Name Layout & Anti-Truncation）**：
  1. **包名宽度动态自适应**：在卡片分批列表渲染中，基于 `pkg.isLongTerm` 动态调整包名 `max-width`；由于右侧「长期有效」字符短小规整，左侧包名最大宽度由 55% 大幅放宽至 72%，彻底解决 `Free Plan Subscription` 较长英文名称被无情截断为 `Free Plan Subscripti...` 的排版瑕疵；
  2. **后端与实时工具协同**：在 `lib/upstream/sync.mjs` 中对远期包同步生成 `长期有效` 倒计时文案，`admin.html` 实时刷新倒计时组件中针对 ≥ 3 年远期包统一输出 `长期有效`；
- **自动化测试套件与版本一致性（Automated Testing Suite & Versioning）**：
  1. **新增纯净长期有效与混合包单测**：在 `tests/test_workbuddy_quota_and_table.mjs` 中新增针对远期纯净「长期有效」、普通跨年显式年份及急迫包与长期包混合场景单测断言；
  2. **全套测试回归验证**：`npm test` 14 个测试套件 100% 通过，版本升级至 `v2.10.5`。

## [v2.10.4] - 2026-10-19

修复 WorkBuddy / 腾讯官方长期免费体验包跨年日期年份缺失与远期倒计时（3000天）反人类展示缺陷：

- **跨年与远期资源包日期格式化修复（Cross-Year & Far-Future Expiration Formatting Fix）**：
  1. **跨年年份显式补全**：在 `admin-quotas.js` 的 `getWorkBuddyExpirationInfo` 函数中，对东八区时间提取的 `yyyy` 与当前东八区自然年份进行对比；当资源包到期时间非当年时（如腾讯官方免费基础包/个人体验版设定的 `2035-01-15`），`shortText` 强制输出包含完整年份的格式 `${yyyy}年${mm}月${dd}日 ${hh}:${min}`（如 `2035年1月15日 20:57`），彻底根除原逻辑丢弃年份输出 `1月15日 20:57` 导致用户误以为是近在眼前三个月后到期的视觉错觉；
  2. **字符串到期时间防御**：对仅有 `expires_at` 字符串的分支同步补齐正则匹配年份逻辑，若跨年同样输出完整年月日；
  3. **后端与全局工具函数同步补齐**：在 `lib/upstream/sync.mjs` 的 `countdownText` 与 `admin.html` 的 `formatResetAbs` 中一并增加跨年年份检测，跨年时刻完整保留 `YYYY-MM-DD` / `YYYY年MM月DD日`。
- **超长跨度倒计时分级与长期有效人性化展示（Human-Friendly Countdown & Long-Term Tiering）**：
  1. **告别机械无脑天数输出**：修复原倒计时逻辑只要大于 72 小时就一律 `${days}天后`，导致腾讯 8.24 年（3010 天）远期免维护基础包直接输出吓人的 `(3010天后)` / `(3006天后)`；
  2. **多梯度智能单位转换**：
     - `< 24小时`：`${hours}小时后`（红色高危）；
     - `< 72小时`：`${days}天后`（黄色紧迫）；
     - `< 365天`：`${days}天后`（常规倒计时）；
     - `1~3年`：`${years}年多后`（或 `${years}年后`）；
     - `≥ 3年（如 2035 年长期体验包）`：智能标记为 `长期有效 · ${years}年后`（在实时倒计时组件中展示为 `长期有效 (${years}年后)`），既尊重腾讯官方真实返回的远期时间，又符合人类对长期有效基础额度的认知直觉。
- **自动化测试套件与版本一致性（Automated Testing Suite & Versioning）**：
  1. **新增跨年远期单测**：在 `tests/test_workbuddy_quota_and_table.mjs` 中新增针对 2035 年 3010 天跨年远期包的单测断言，确保年份必显与长期有效倒计时契约生效；
  2. **全套测试回归验证**：`npm test` 14 个测试套件 100% 通过，版本升级至 `v2.10.4`。

## [v2.10.3] - 2026-10-19

API Key 模型白名单与每日限额配置持久化与加载修复、多协议凭证穿透与网关热路径真实限制强化：

- **API Key 模型白名单与每日限额配置持久化与回显加载修复（API Key Model Whitelist & Quota Hydration Fix）**：
  1. **后端模型白名单标准化存储**：在 `lib/core/engine.mjs` 中新增 `normalizeModelWhitelist` 与 `parseModelWhitelist`，对接收到的数组、JSON 串、逗号分割字符串统一标准化；存入 SQLite 时序列化为标准 JSON 数组字符串或空字符串，彻底解决 `updateQuotaRule` 原逻辑强制 `String(model_whitelist)` 导致数组被强转为逗号连接字符串而破坏 JSON 格式的问题；
  2. **前端多格式解析与下拉匹配**：在 `admin-keys.js` 中新增 `parseModelList(raw)`，兼容历史逗号串与标准 JSON 数组，保证解析后的每一项均为独立无逗号的纯净小写模型名，解决编辑弹窗打不开或无法高亮勾选已有模型项的问题；
  3. **限额输入联动与开启开关防丢**：修复输入每日限额（Token）但未手动勾选「硬限额」开关时保存导致限额失效并在表格显示为「不限」的问题；前端在输入每日限额时自动联动勾选启用硬限额，保存时若限额 > 0 且未启用则自动激活；在密钥列表中对未启用的限额明确标注为 `${limit} (未启用)` 并显示 RPM 限制，防止误解。
- **多协议凭证穿透与网关热路径真实限制强化（Multi-Protocol Key Resolution & Traffic Enforcement）**：
  1. **多协议凭证提取**：在 `lib/core/key-registry.mjs` 中重构 `extractRawKey` 与 `resolveKeyId`，支持直接传入 `IncomingMessage` 请求对象，统一解析 `Authorization: Bearer`、Anthropic 原生 `x-api-key`、Azure `api-key`、Google Gemini `x-goog-api-key` 以及 Gemini REST URL `?key=` 参数；
  2. **热路径全局传递**：在 `server.mjs` 中将各热路径限速（RPM）、每日配额检查（`checkQuota`）、模型过滤（`filterModelsForKey`）与模型白名单检查（`checkModelAllowed`）统一传入 `req` 对象，彻底堵住了非 Bearer 请求头（如 Claude 原生客户端、Gemini REST 客户端）绕过限流限额与模型限制的漏洞；
  3. **智能模型匹配引擎**：在 `lib/core/engine.mjs` 中实现 `isModelPermitted`，支持精确匹配、大小写不敏感、厂商前缀剥离（如 `anthropic/claude-3-7-sonnet`）、通配符匹配（如 `gpt-4o*`）以及版本日期后缀匹配（如 `claude-3-7-sonnet-20250219`、`@20250219`）；
  4. **Gemini REST 端点模型提取**：在 `server.mjs` 中针对 POST 请求支持从 URL 路径 `/\/models\/([^/:]+)/` 提取模型名称进行热路径拦截。
- **自动化测试套件扩展与验证（Automated Testing Suite）**：
  1. **专用端到端测试**：新增 `tests/test_key_model_and_quota_restrictions.mjs`，包含多协议 Key 提取、模型归一化、智能模型匹配、SQLite 持久化与重启一致性、热路径 403 阻断与 429 RPM 滑动窗口拦截、前端解析 7 大测试项；
  2. **测试全量通过**：纳入 `npm test`，全量 14 个测试套件 100% 通过。

## [v2.10.2] - 2026-10-19

上游 CPA 管理控制台同步与跨仓库静态资源一致性闭环：

- **上游 CPA 管理控制台原生同步（Upstream CPAMC Management Sync）**：
  1. **响应解包与状态挂载防御**：从 `cliproxyapi` 源头同步最新 `static/management.html`（MD5 `17164d99ee3b5da5a5b5fa3be5926a07`），彻底解决 WorkBuddy 签到/补偿套件在 Axios 解包后的防御性访问缺陷（`p(e?.data || e)`）；
  2. **自动拉取与凭证状态恢复**：修复前端抽屉打开时由于解包失败将状态重置为 `undefined`，导致今日日期卡在 "正在拉取..." 且纳管账号总数显示为 0 的顽疾；
- **跨仓库静态资源交付防倒灌治理（Cross-Repository Static Delivery Hardening）**：
  1. **宿主仓库基准对齐**：根除源头仓库单向临时向生产机修补导致的托管版本脱节隐患；
  2. **打包版本升级与静态版本号递增**：版本升级至 `v2.10.2`，更新 `package.json`、`package-lock.json` 与 `admin.html` 静态资源缓存控制版本，全量 31 项自动化测试 100% 通过。

## [v2.10.1] - 2026-10-19

上游 CPA 凭证别名 (Nickname/DisplayName) 权威解析与全链路流水穿透、审计搜索与前端 .json 防泄露治理：

- **上游 CPA 凭证别名 (Nickname/DisplayName) 权威解析与分级推断（Upstream Credential Nickname & Display Hierarchy）**：
  1. **层级化别名解析矩阵**：在 `lib/upstream/sync.mjs` 中构建统一的 `resolveAuthAccountDisplayName(file, provider)` 函数，建立 `nickname`（或 `nick_name`）-> `label` 括号别名提取（如 `workbuddy-cn(唐棠瑭堂)` -> `唐棠瑭堂`，严格排除 `cn`/`intl`/`global`/`default`/`api` 等区域保留字）-> 真实非通用邮箱 -> 自定义非通用 label -> 剥离 `.json` 的干净文件名 -> 16 位 `auth_index` 的分级决策树；
  2. **通用标识守卫强化**：新增 `isGenericProviderIdentifier(str, provider)`，防止通用占位串（如 `workbuddy`、`workbuddy-cn`、`antigravity`、`codex`、`other` 等）抢占作为展示名称；
  3. **数据同步与快照全链路挂载**：在 `syncUpstreamQuotas` 的普通凭据循环、`openai-compatibility` 循环及 OpenRouter 凭证解析中，统一为账号对象挂载 `display_name` 与 `nickname`，并清洗 `email` 与 `filename`；
  4. **PATCH 白名单放行与即时缓存失效**：在 `lib/routes/admin-routes.mjs` 的 `/auth-files/fields` PATCH 端点白名单中加入 `nickname` 与 `label`，并在修改完成后主动调用 `clearAuditLogsCache()` 触发即时失效。
- **请求流水、错误中心与数据大盘穿透治理（Audit Logs, Error Center & Dashboard Penetration）**：
  1. **流水账号动态解析修复**：在 `lib/analytics/audit-logs.mjs` 的 `resolveAuthAccountInfo` 与 `resolveEventAuthInfo` 中，优先提取 `acc.display_name || acc.nickname || acc.email || acc.filename`，并自动剥离 `.json` 后缀；解决上游改名后流水依然展示生产磁盘裸文件名（如 `workbuddy-cn-1791808639195.json`）的顽疾；
  2. **本地基线兜底清洗**：对于未同步到活跃列表的账号，从 `upstream_auth_baselines` 本地基线表读取时一律通过 `.replace(/\.json$/i, '')` 剥离 `.json` 后缀；
  3. **流水按别名/上游账号全文检索**：在 `getPagedRequests` 的 `term` 搜索过滤中，支持根据搜索词匹配 `cachedUpstreamQuotas.accounts` 中的 `display_name`、`nickname`、`email`、`filename`、`label` 及 `upstream_auth_baselines.name`，并将命中账号的 `auth_index` 引入 SQL 索引查询，彻底解决管理台按账号别名搜索无结果的问题；
  4. **状态大盘与运行时统计对齐**：在 `lib/analytics/status-summary.mjs` 与 `lib/upstream/runtime-stats.mjs` 中对齐 `display_name` 与 `nickname` 字段导出，消除跨端名称不一致。
- **前端 Aozora UI 视觉防退化与防 .json 泄露（Frontend Defenses & Cache Invalidation）**：
  1. **请求流水表格渲染**：更新 `admin-logs.js`，在 `getAuthDisplayName`、请求行及错误中心行中优先展示友好别名，并增加全局 `.replace(/\.json$/i, '')` 防御，杜绝界面出现 `.json`；
  2. **配额管理控制台**：更新 `admin-quotas.js`，卡片标题、紧凑行、优先级弹窗与 403 验证单表格全面对齐别名展示与 `.json` 剥离，同时扩展前端本地搜索过滤支持 `display_name` 与 `nickname`；
  3. **静态资源防缓存版本更新**：同步升级版本至 `v2.10.1`，更新 `package.json`、`package-lock.json` 与 `admin.html` 中静态资源版本查询参数；
  4. **自动化回归测试扩展**：在 `tests/test_gate_features.mjs` 中新增「测试 31: 上游 CPA 凭证别名 (Nickname/DisplayName) 解析与请求流水全链路贯通」，全量 31 项测试套件 100% 通过。
- **CI 流水线环境隔离与测试自愈（CI Environment Isolation & Self-Contained Test Fixtures）**：
  1. **OpenRouter 配额测试沙箱隔离**：在 `tests/_isolated-db.mjs` 中为子进程注入 `GATE_OPENROUTER_ACCOUNTS_PATH` 环境变量，将账号存储指派至独立临时目录；并在 `tests/test_openrouter_quota.mjs` 中接入 `isolateTestDb` 与基础凭据预置（Seed Fixture），根除干净拉取的 CI Runner（GitHub Actions 与 Gitea Actions）因缺少宿主机真实 `data/openrouter-accounts.json` 触发 404 导致测试红灯的缺陷；
  2. **跨平台独立验证**：测试用例自包含生命周期断言，不依赖任何宿主机外部持久化状态，13 套件全量通过。

## [v2.10.0] - 2026-10-18

开源发布硬化：修复全新 clone 无法启动与静态资源 500/404 两个阻断性缺陷、补齐 .env 加载、重试可配置化、npm 包白名单与 GitHub 社区治理体系，并新增双层 AI 检索规范：

- **开源冷启动阻断性缺陷修复（Open-Source Quick-Start Blockers）**：
  1. **全文入口崩溃修复**：修复 README 中 `cp .env.example .env && npm start` 直接抛 `CPA_MGMT_SECRET must be configured` 的缺陷——此前进程不读取 `.env`，只认进程环境变量。现在 `lib/config.mjs` 在启动时读取**当前工作目录**下的 `.env`（与 systemd `WorkingDirectory` 语义一致），已存在的进程环境变量优先；`process.loadEnvFile` 在 Node 20.0–20.11 不存在，额外提供极简兜底解析（注释、引号、`KEY=VALUE`）；
  2. **管理台 500 与静态资源 404 修复**：此前 `admin.html`、`admin-*.js/css`、`gate-assets/` 只从 `GATE_DIR`（默认 `./data`）解析，而全新 clone 的 `./data` 只有 SQLite，导致 `/admin` 返回 500、外置脚本全部 404。新增 `STATIC_DIR`（默认解析到安装根目录，可用 `GATE_STATIC_DIR` 覆盖），并保留「资源放在 `GATE_DIR` 下」的旧部署形态回退；
  3. **管理台静态副本路径修正**：`lib/routes/upstream-proxy.mjs` 改用 `APP_ROOT` 解析 `static/management.html`，不再依赖进程 `cwd`，并回退到 `GATE_DIR/static/`；
  4. **回归测试**：新增 `tests/test_static_assets_layout.mjs`，覆盖 14 个静态路径在空 `GATE_DIR` 下的解析、旧部署回退、单次 404 安全性与 `.env` 优先级，并纳入 `npm test`；
  5. **真实凭据泄漏治理**：`tests/test_opencode_quota_and_deleted_separation.mjs` 曾把一组**真实 OpenRouter Key** 当作样例数据写死（v2.9.58 引入），准备推送公开仓库时被 GitHub Push Protection 拦截。现已替换为 `sk-or-v1-PLACEHOLDER-NOT-A-REAL-KEY-DO-NOT-USE` 明示占位串（全 0 形态仍会被密钥扫描器命中，故不用），并新增 `tests/test_repo_hygiene.mjs` 扫描全部被 Git 跟踪的文件（OpenRouter / AI / OpenAI / Google / GitHub / Slack / 私钥形态，自动放行占位串），纳入 `npm test` 作为推送前闸门；该 Key 只进入过私有 History（`aafd272`），公开仓库历史从未包含，仍建议在 OpenRouter 控制台轮换。
- **重试策略可配置化（Configurable Retry Policy）**：
  1. 新增 `GATE_MAX_ATTEMPTS`，默认仍为 `1`（不重试），取值夹紧到 1–5，非法值安全回落；保留「默认不放大上游负载」的生产默认值；
  2. 开启后第 3 次尝试才会下发 continuation healing payload，与 `llms-full.txt` 描述一致；README 同步把「3-Attempt Safe Retry」改为「opt-in」的准确表述。
- **包与元数据规范（Package & Metadata Hygiene）**：
  1. `package.json` 补充 `repository`、`homepage`、`bugs`、`keywords` 与 `files` 白名单（剔除 `tests/`、`.github/`、`node_modules/`、本地运行数据），发布包 72 个文件、约 4.8MB；
  2. 修正双 `license` 字段冲突（原 `"license": "MIT"` 被后一个 `"license": "UNLICENSED"` 覆盖），统一为 MIT；`package-lock.json` 同步回填 `name` 与 `license`；
  3. 版本递增至 `2.10.0`，`admin.html` 版本徽章与全部静态资源缓存破坏参数同步。
- **上游血统与死链修复（Upstream Lineage & Dead Links）**：
  1. README 中 `github.com/eceasy/cli-proxy-api` 已 404，全量更正为真实上游 `github.com/router-for-me/CLIProxyAPI`（MIT）；
  2. 新增「Upstream Projects & Attribution」章节，明确 CLIProxyAPI 负责凭据与 OAuth、CLI Proxy API Management Center 负责原生管理台 UI，两者均为 MIT，本项目不 Fork、模块边界归上游；同步写入 `llms-full.txt` 与 `llms.txt`；
  3. `gate.service` 与 README 的部署路径对齐（README 原写 `/opt/cpa-gate`，实际单元文件为 `/opt/gate`），并补充 `TimeoutStopSec` 排空说明。
- **GitHub 社区治理体系（Community Standards）**：
  1. 新增 `.github/ISSUE_TEMPLATE/bug_report.yml`、`feature_request.yml` 与 `config.yml`（YAML 表单，禁用空白 issue，跳转文档）；
  2. 新增 `.github/PULL_REQUEST_TEMPLATE.md`，要求如实声明已运行的验证项；
  3. 新增 `.github/workflows/ci.yml`：Node 20/22/24 三版本矩阵执行 `npm ci && npm test`。
- **AI 检索生态与冷启动物料（GEO & Launch Assets）**：
  1. 新增 `llms.txt`（89 行，含项目定义、推荐触发场景、五分钟上手、核心配置）与 `llms-full.txt`（18 章全量规格：架构、请求生命周期、传输守卫、数据库结构、HTTP API、上游计量、配置参考、运维、测试矩阵、FAQ、排障表）；
  2. 新增 `docs/LAUNCH_COPYWRITING.md`（V2EX、Reddit、Show HN、X 中英、知乎五套现成文案）；
  3. 新增 `docs/DISCUSSIONS_QA_SEEDS.md`（5 篇带官方解答的 Q&A 种子）；
  4. 新增 `docs/COMMUNITY_SUBMISSIONS.md`（核验过收录标准的 Awesome 列表 PR 模板，并标注暂不提交的列表及原因）；
  5. 未生成 `smithery.yaml`：本项目不对外提供 MCP Server，凭空生成注册配置属于虚假宣传。
- **测试证据**：`npm test` 13 个套件、165 项断言全部通过、0 失败；`node --check` 覆盖全部改动文件；实测「空 `GATE_DIR` + 根目录资源」下 `/admin`、`/admin/style.css`、`gate-assets/*.webp`、`/admin/upstream/management.html` 均返回 200；`npm ci --dry-run` 通过，CI 可直接运行。

## [v2.9.66] - 2026-10-18

WorkBuddy 代码审查问题闭环修复、多包容量空值回退、无到期包防误标与全量分组指标导出：

- **深度代码审查问题闭环修复与类型健壮性加固（WorkBuddy Quota Review Fixes & Multi-Package Resilience Guard）**：
  - 核心修复与优化：
    1. **资源包剩余容量空值防御与安全回退**：修复 `lib/upstream/sync.mjs` 中对 `accItem.CycleCapacityRemain` 先行执行 `Number(...) != null` 导致的判定短路缺陷（JS 中 `Number(null)` 恒为 `0` 且 `0 != null` 为真，导致字段为 `null` 时被误设为 0 并阻断向 `CapacityRemain` 或汇总包的正常回退）；增加前置 `!= null && !== ''` 检查，确保数据缺失时平滑回退；
    2. **无到期日资源包防误标有效到期**：修复 `admin-quotas.js` 中 `getWorkBuddyExpirationInfo` 在全部资源包均未公布到期时间时依然误标 `hasExpiration: true` 并渲染“未知到期日”的缺陷；增加 `hasAnyExpiration` 判定，全无到期日时严格返回 `hasExpiration: false`、文案对齐为“未公布到期时间”并使用 `var(--text-dim)` 柔和暗色显示；多包排序时优先将具备明确到期时间的批次排在前面；
    3. **服务端指标导出全量分组多资源包**：在 `lib/analytics/status-summary.mjs` 中使用 `flatMap` 遍历提取 `acc.groups` 下所有分组的 buckets，彻底修复原本硬编码仅读取第 0 组导致后续分组资源包被丢弃的数据遗漏问题；
    4. **东八区时间跨时区容器解析加固**：在 `lib/upstream/sync.mjs` 中提取统一的 `normalizeCstTimeString` 与 `parseCstDateToTimestamp` 辅助函数，通过正则精准匹配时区后缀（`Z` 或 `[+-]HH:MM`），防止形如 `2026-10-26T16:16:46`（含 `T` 但无时区后缀）的时间在海外 Docker 容器或生产机器（`TZ=UTC`）中被误当作 UTC 时间导致 8 小时系统性偏移；
    5. **消除重复解析与可选链防护统一**：消除 `queryWorkBuddyFreePackages` 内部对明细包与汇总包重复的时间解析逻辑，并在 `parseWorkBuddyGroups` 转换时间戳时补齐 `matchedExp?.end_ms` 可选链防护；
    6. **自动化回归测试扩展**：扩展 `tests/test_workbuddy_quota_and_table.mjs`，增加跨时区时间解析一致性断言、空值容量回退断言、无到期日状态防误标断言与多分组全量导出测试，全量 30 项测试用例全部通过。

## [v2.9.65] - 2026-10-18

腾讯 WorkBuddy 多资源包各包分批截至到期时间全链路透传与三端精细化分批看板：

- **腾讯 WorkBuddy 多资源包各包到期截至时间独立追踪与 Aozora UI 分批到期展示（WorkBuddy Multi-Package Itemized Expiration & Multi-Batch Schedule Guard）**：
  - 需求背景：用户反馈 WorkBuddy 账号通常由多个生命周期完全不同的资源包组成（例如标准基础月度包 250 积分截至 10月26日、开发者体验额度 100 积分截至 10月29日），过去单一的「到期截至时间」将多包折叠为首批时间，无法得知其余积分包何时到期，且容易产生误解；
  - 核心架构与多包提取调度：
    1. **多包到期时间全量拉取与升序排序**：在 `lib/upstream/sync.mjs` 的 `queryWorkBuddyFreePackages` 中遍历腾讯官方返回的所有资源包，提取各自的 `PackageCode`、`PackageName`、`CycleEndTime`、`DeductionEndTime`、剩余积分与总积分，并严格按到期时间由近及远升序排列，生成完整 `packages` 列表并挂载至 `acc.expiration_packages`；
    2. **全生命周期探针多包聚合**：无论在后台 5 分钟定时同步（`syncUpstreamQuotas`）还是前台就地靶向刷新（`activateUpstreamQuotaWindow`），只要账号包含资源包即并发拉取多包有效期，确保每个包均具备独立到期时间与倒计时；
    3. **服务端汇总契约升级**：在 `lib/analytics/status-summary.mjs` 中将结构化的 `expiration_packages` 数组作为凭据顶层字段导出至 `/admin/api/accounts/summary` 与前端数据大盘；
  - 前端 Aozora UI 三端分批到期视觉升级：
    1. **凭据卡片模式（Account Cards View）**：在核心额度看板下方新增分批自适应展示；单包时展示「⏱️ 积分截至到期」，多包时自适应展示「⏱️ 积分分批到期 (共 N 批)」及首批倒计时；并在下方内嵌展开每个资源包的条目化明细清单（序号、包名称、可用积分、截止时间、独立倒计时与紧急度染色）；
    2. **紧凑表格视图（Compact Table Mode）**：第 4 行自适应切换为「分批到期 (N批)」及「首批 MM月DD日 HH:mm (倒计时)」，悬停浮动气泡（Tooltip）清晰展示所有批次的完整明细；
    3. **网格总览大卡（Quota Cards View）**：右侧自适应显示 `截至: 首批 MM月DD日 HH:mm (倒计时) (共N批)`，悬停气泡完整显示分批日程；
  - 自动化测试与全链路守护：
    1. 扩展 `tests/test_workbuddy_quota_and_table.mjs`，覆盖多包到期时间升序排列、Node 沙箱多包解析、多批次浮动气泡提示与各端分批 UI 渲染契约；
    2. 将 `tests/test_gate_features.mjs` 中的静态资源防缓存版本断言升级为动态绑定 `package.json` 版本，防范后续递增漂移；全量 `npm test` 30 项套件 100% 通过。

## [v2.9.64] - 2026-10-18

代码审查问题闭环修复、东八区跨时区真理源对齐与 WorkBuddy 配额查询并发加固：

- **深度代码审查问题系统性修复与高可用加固（WorkBuddy Quota Review Fixes & High-Availability Concurrency Guard）**：
  - 核心修复与优化：
    1. **东八区（UTC+8）全局单点真理源与跨时区环境兼容**：在 `admin-quotas.js` 的 `getWorkBuddyExpirationInfo` 中统一采用 `targetTs + 8 * 3600 * 1000` 结合 UTC getters 提取月日时分秒，彻底根治客户端浏览器或测试运行在海外/UTC 时区（如 GitHub Actions、美西沙箱机）时小时数偏离的问题，修复 `test_workbuddy_quota_and_table.mjs` 测试 5 在非东八区时区下的断言异常；
    2. **防御性时间格式解析与 RangeError 消除**：在 `lib/upstream/sync.mjs` 中对 `expAt` 及资源包 `CycleEndTime` 增加 `.includes('T')` 与 try-catch 保护，防止 ISO 8601 格式时间因无条件拼接 `+08:00` 触发 `RangeError: Invalid time value` 或计算出 `NaN` 丢失到期时间；
    3. **就地探针刷新并发与高可用容灾**：在 `activateUpstreamQuotaWindow` 中通过 `Promise.allSettled` 将原本串行的 CPA 原生配额查询与腾讯直连接口改为并行执行，请求往返耗时减半；当直连腾讯接口返回非 200 时优先复用 CPA 有效配额数据，杜绝误报探针失败；
    4. **代码复用与重复逻辑消除**：提取通用的 `queryWorkBuddyFreePackages` 分页查询与最早到期包解析函数，彻底消除后台全量同步与前台就地刷新之间 50 行重复代码；
    5. **探针激活数据对称性对齐**：在探针激活逻辑中对齐 `runsOutAt` 与 `expiresAt` 的推导，避免 `targetAcc.reset_time` 为空导致的状态不一致；
    6. **全站版本与防缓存标识同步递增**：将 `package.json`、`admin.html` 顶栏版本徽章及全站静态资源缓存破坏版本号统一递增至 `v2.9.64`；
  - 自动化测试与契约守护：全量自动化测试（`npm test`）与多时区（`TZ=UTC`、`TZ=America/New_York`、`TZ=Asia/Tokyo`）运行均 100% 绿灯通过。

## [v2.9.63] - 2026-10-17

腾讯 WorkBuddy 官方资源包积分到期截至时间全链路透传与三端看板实时展示：

- **腾讯 WorkBuddy 积分到期截至时间全链路透传与 Aozora UI 实时倒计时看板（WorkBuddy Quota Expiration Deadline & Live Countdown Display Guard）**：
  - 需求背景：用户在使用腾讯 WorkBuddy / CodeBuddy 上游凭据时，管理台虽然展示了剩余积分、总额与用量进度条，但缺少官方额度的到期截止时间（例如积分包将在何时过期失效），无法提前得知何时需要续期或消耗积分；
  - 核心架构与多层双轨获取：
    1. 第一层（原生高速通道）：在 `lib/upstream/sync.mjs` 中直调 CPA `/v0/management/quota/fetch` 接口（CPA 原生实现了 WorkBuddy `QueryQuota`，单次往返聚合返回 `points_remain`、`points_total`、`runs_out_points`、`expires_at` 与 `runs_out_at`）；
    2. 第二层（自治直接兜底）：若 CPA 原生配额通道暂不可用，Gate 自动通过已解密的凭据调用官方 `/billing/meter/get-user-resource-summary`，并携带提取出的 `PackageCodes` 联动分页查询 `/billing/meter/get-user-resource-free-packages`（规整注入 `PageNumber: 1, PageSize: 50` 解决腾讯网关分页参数校验限制），由 Gate 在内存中解析各包的 `CycleEndTime` 与 `DeductionEndTime` 并计算出最早到期截止时间与到期积分；
    3. 服务端权威指标透传：在 `lib/analytics/status-summary.mjs` 中将凭据级与桶级的 `expires_at`（北京时间字符串）、`runs_out_points`（首批到期积分数）、`reset_time`（ISO 标准时间）和 `reset_countdown` 导出至 `/admin/api/status-summary` 与 `/admin/api/upstream-quotas`；
  - Aozora UI 视觉对齐与实时倒计时展示：
    1. 紧凑表格视图（Compact Table Row）：在 `.compact-meter-wrap` 中新增「截至到期」专行，展示格式化短日期（如 `10月26日 16:16`）与相对倒计时胶囊（如 `8天后`），并引入三阶紧急度染色（已到期或 24 小时内红字 `#ef4444`、72 小时内警示橙 `#f59e0b`、充裕正常柔和灰 `var(--text-muted)`），悬停气泡完整显示北京时间秒级精度与首批到期积分；
    2. 抽屉详情弹窗（Drawer Detail Modal）：在核心看板区新增虚线分割的「⏱️ 积分截至到期」专行，完整呈现年月日时分秒与到期倒计时；
    3. 凭据总览大卡（Quota Cards View）：在「总额 / 已用」行右侧优雅呈现 `截至: 10月26日 16:16 (8天后)`，保持整卡紧凑平衡；
  - 全站版本与防缓存同步递增：将 `package.json` 与 `admin.html` 静态资源缓存破坏版本号统一递增至 `v2.9.63`；
  - 自动化测试与验证：在 `tests/test_workbuddy_quota_and_table.mjs` 新增「测试 5: WorkBuddy 积分到期截至时间解析与 UI 展示契约」，全量自动化测试（`npm test`）100% 绿灯通过。

## [v2.9.62] - 2026-10-17

移动端超窄屏 X 轴刻度排版自适应优化与全站东八区时区常量集中管理：

- **移动端超窄屏 X 轴刻度自适应稀疏防挤与全局东八区单点真理源集中管理（Mobile X-Axis Sparse Adaptive Guard & Global Timezone Single Source of Truth）**：
  - 核心优化：
    1. 全局东八区单点真理源集中管理：在 `lib/config.mjs` 中统一收敛定义 `CHINA_TZ_OFFSET_SECONDS = 28800`，其他模块（如 `live-traffic-tracker.mjs`）统一引用该单点真理源，彻底消除跨文件魔数分散；
    2. 移动端小屏 X 轴刻度自适应稀疏防挤：针对小于 480px 的超窄屏幕，`admin-overview.js` 对非首尾的中间奇数位 X 轴刻度注入 `ovw-xaxis-sparse-hide` 类，配合 `admin-overview.css` 媒体查询在超小屏幕下自适应隐藏非首尾刻度，彻底杜绝小屏字符重叠；
    3. 长远扩容与超大历史聚合架构备忘：在内存追踪器核心注释与项目工程备忘中固化超大规模数据演进路径（单月突破 200 万笔时优先引入 60s 内存 TTL 缓存或复用现有 `usage_daily`，杜绝过早设计引入冗余汇总表）；
    4. 全站版本与防缓存标识同步递增：将 `package.json` 与 `admin.html` 顶栏版本徽章及全站静态资源缓存破坏版本号统一递增至 `v2.9.62`；
  - 自动化测试与契约守护：在 `tests/test_gate_features.mjs` 测试 30 中补全断言守卫，验证时区单点真理源契约、移动端小屏刻度稀疏化与防缓存版本一致性，全量自动化测试 100% 绿灯通过。

## [v2.9.61] - 2026-10-17

全面重构用量趋势 AI 提供商 Token 聚合引擎并补齐 Anthropic 协议思考强度细粒度档位提取：

- **补齐 Anthropic Messages 协议思考强度（Reasoning Effort）细粒度档位提取，优先识别 `output_config.effort` 与 `thinking.effort`（Anthropic Steering Effort Extraction Guard）**：
  - 根因分析：客户端（如 Claude Code / Desktop 等）走 Anthropic Messages API 开启思考并指定具体档位（如 `Max` / `High` / `Medium` / `Low`）时，会在请求体中同时携带 `output_config: { effort: "max" }` 与 `thinking: { type: "adaptive" }`。Gate 原本在 `extractReasoningEffort()` 中仅提取了 `thinking.type`，固定返回外层容器模式 `adaptive`，漏看了更精细的 `output_config.effort`、`outputConfig.effort`、`thinking.effort` 与顶层 `effort` 字段，导致用户明明勾选了 `Max`，大盘流水却显示为较为笼统的 `adaptive`；
  - 核心修复：在 `lib/proxy/token-estimator.mjs` 中强化 Anthropic 思考强度提取策略，优先提取 `output_config.effort`、`outputConfig.effort`、`thinking.effort` 与顶层 `effort` 并完成大小写归一化（如 `max`、`high`、`medium`、`low`），仅在未声明具体档位指导时平滑回落为 `adaptive` 或 `budget:<tokens>`；
  - 自动化测试与验证：在 `tests/test_gate_features.mjs` 测试 28 中追加 `output_config.effort` 优先于 `adaptive`、驼峰与嵌套属性的多形态断言守卫，所有测试 100% 绿灯通过。

- **根治用量趋势「AI 提供商 Token 分布与占比」因模型正则粗暴猜测导致特化模型被 OpenCode Zen 抢夺冒领缺陷（Authoritative Credential-Based Provider Token Breakdown & Attribution Guard）**：
  - 根因分析：原本 `getUsageStats()` 统计 `providers` 分布时，直接遍历聚合后的 `models` 数组，并依靠 `inferModelProvider(m.model)` 浅层正则推断提供商。在 `provider-registry.mjs` 中，`opencode` 内置了 `[{ p: '-free', anchor: '' }]` 匹配规则且优先级较高（`sort_order: 45`）。当其他上游提供商（如腾讯 WorkBuddy）运行带有 `-free` 后缀的模型（例如 `deepseek-v4.1-flash-free`）时，所有 Token 与请求数被浅层正则强行掠夺归入 OpenCode Zen，导致出大力的 WorkBuddy 显示为 0，而 OpenCode Zen 虚假吞噬全量 Token；
  - 核心架构改造（彻底走长期，不留任何后患）：
    1. 底层持久化与索引加速：在 `lib/db/sqlite.mjs` 中为 `request_events` 新增 `(key_id, ts)` 复合索引，并新增 `stmtAuthEventsModelAgg`、`stmtAuthEventsModelAggByKey`、`stmtAuthEventsModelAggSince`、`stmtAuthEventsModelAggSinceByKey` 4 条高效预编译语句，直接基于 `(auth_index, model)` 权威分组；
    2. 全生命周期事件双轨聚合：在 `lib/analytics/audit-logs.mjs` 中，联合持久化 `request_events` 与 Outbox / 内存中待刷盘的在途请求事件（`getOutboxSnapshot()` 与 `pendingEvents`），确保高并发与实时请求场景下指标毫秒级准确；
    3. 真实账号权威凭证溯源：基于每个真实请求绑定的 `auth_index`，通过 `resolveEventAuthInfo(auth_index, model)` 溯源 CPA 在线权威账号快照与离线基线（`upstream_auth_baselines`），让提供商归属牢牢锚定在真实的调用凭证与上游提供商身份上，彻底杜绝跨提供商模型名截胡；
    4. 模型层优势提供商与多上游智能回标：`models` 列表中的 `provider` 改由该模型真实产生最大 Token 贡献的优势提供商标签标记，保证模型与提供商看板逻辑自洽；
    5. Token 全量对账补差引擎（Reconciliation Engine）：当历史事件被裁剪或降级测试环境下 `request_events` 不足时，自动基于 `models` 对账平滑补齐差额，确保 `providers` 聚合的总 Token 与请求数与 `periodTotalTokens` 100% 绝对一致；
  - 自动化测试与契约守护：在 `tests/test_gate_features.mjs` 新增「测试 29: AI 提供商 Token 分布基于真实凭证权威聚合与防抢夺契约 (v2.9.61)」，验证 WorkBuddy 调度 `-free` 模型时 Token 100% 归属腾讯 WorkBuddy 且对账自洽无误，`npm test` 全套测试套件 100% 绿灯通过。

- **修复运行总览多时间窗口（尤其是 30d）分桶跨天错位与东八区自然日零点时区对齐，重构 X 轴多尺度采样刻度并注入全链路防缓存契约（Timezone-Aligned Natural Day Bucketing, Multi-Tick X-Axis & Cache Busting Guard）**：
  - 根因分析：
    1. 分桶时区偏移漂移：Unix Epoch 时间戳以 UTC 00:00:00 为基准。在按 86,400 秒（1 天）分桶时，UTC 零点整除后映射到北京时间（Asia/Shanghai UTC+8）恰好是早晨 08:00:00。这导致 30d 窗口下的所谓“天级”分桶实际时间边界为 `08:00 - 次日 08:00`，当天凌晨 0 点到早晨 8 点的请求被错误计入昨天，造成流量与真实自然日严重脱节；
    2. X 轴刻度粗暴与截断：原前端 X 轴硬编码为固定的 3 个采样点，在天级桶时对时间字符串直接执行 `split('-')[0]`，导致刻度上只显示孤零零的截断月份数字 `"09"`、`"10"`、`"10"`，完全无法识别具体日期；
    3. 浏览器静态资源强缓存：HTML 引入的静态脚本未附带缓存破坏版本号，导致用户浏览器强缓存了旧版逻辑。
  - 核心修复：
    1. 东八区（Asia/Shanghai UTC+8）自然日分桶对齐：引入 `CHINA_TZ_OFFSET_SECONDS = 28800`，本地槽位按 `Math.floor((currentSec + 28800) / bucketSeconds)` 计算，使每个天级桶的起点与终点严格落在北京时间自然日 `00:00:00 - 24:00:00`；
    2. SQLite 时区感知模除聚合：在 SQL 中执行 `((ts + ?) - ((ts + ?) % ?)) - ? AS slot_start`，将底层持久化数据的分桶聚合与内存时间槽做到纳秒级精准对齐；天级分桶直接格式化为直观清晰的 `MM-DD`（如 `"10-17"`）；
    3. 自适应多刻度分布与锚点渲染：针对 30d、7d、3d、1d、5h、3h20m 等不同窗口，动态生成 5 ~ 8 个等距刻度点。最左刻度采用 `text-anchor="start"` 防止溢出坐标轴，最右刻度采用 `text-anchor="end"` 防止溢出画布，中间刻度居中对齐；
    4. 全链路防缓存契约：在 `admin.html` 中为全部 CSS/JS 注入 `?v=2.9.61` 动态版本号，并在 `static-routes.mjs` 中设置 `Cache-Control: no-cache, must-revalidate`，杜绝任何静态缓存问题。
  - 自动化测试与契约守护：在 `tests/test_gate_features.mjs` 新增「测试 30: 运行总览多时间窗口分桶东八区自然日对齐与全链路防缓存契约 (v2.9.61)」，验证自然日 00:00-24:00 分桶、SQLite 时区聚合、MM-DD 格式化与防缓存头，所有测试 100% 绿灯通过。

## [v2.9.60] - 2026-10-17

修复 Anthropic Messages SSE 流式预提交识别漏洞，支持深度思考与复杂工具调用免误判 502：

- **根治 Anthropic 深度思考与复杂工具调用被误判为 502 空流的缺陷（Anthropic Thinking & Tool Use Stream Guard）**：
  - 根因分析：在 `lib/proxy/transport.mjs` 中，网关在提交流式响应给下游客户端前，会通过看门狗检测前置 Buffer 内是否存在「有效语义内容」（`hasSemanticEvents`）。原本只针对 OpenAI 协议解析 `payload.choices[0].delta`，针对 Anthropic 协议仅检查了 `payload.delta.text`。当客户端通过 Anthropic `/v1/messages` 发起开启深度思考（`thinking`）或大参数工具调用的请求时，上游首先流式返回的是 `thinking_delta`、`tool_use` 或 `input_json_delta`，此时 `delta.text` 为空且不存在 `choices`，导致看门狗误判为「无语义输出的空流（clean empty stop）」，直接拦截并向下游抛出 HTTP 502 `upstream_empty_response`，进而激活 30 秒负向死锁熔断；
  - 核心修复：全面补齐 Anthropic Messages 协议全生命周期事件的语义判定：
    1. 文本块增量：`payload.delta.text`；
    2. 深度思考增量与签名：`payload.delta.thinking`（置 `hasSemanticEvents` 与 `hasReasoningEvents`）与 `payload.delta.signature`；
    3. 工具调用参数增量：`payload.delta.partial_json`；
    4. 块启动事件：`payload.content_block.type === 'tool_use' || 'thinking'`；
  - 自动化测试与验证：更新 `tests/test_gate_features.mjs`，增加针对 Anthropic `delta.thinking` 与 `delta.partial_json` 的完整断言守卫，所有自动化测试 100% 绿灯。

## [v2.9.59] - 2026-10-17

全面重构运行总览实时流量多时间窗口聚合、自适应 X 轴时间刻度与全上游凭据双轨融合大盘：

- **根治 SQLite 分桶截断浮点除法精度丢失导致的统计断崖下跌（SQLite Epoch Modulo Bucket Alignment）**：
  - 根因分析：在 `lib/db/sqlite.mjs` 中的时间窗口分桶聚合查询原采用 `(ts / ?) * ?`。SQLite 默认执行浮点除法，当 `bucketSeconds` 为非整除数或计算大数时，产出带小数点的 `slot_start`。而在 `live-traffic-tracker.mjs` 中构建对比槽位使用的是整型秒数（`slot * bucketSeconds`），导致 Map 查找几乎全部落空。切换至 `5h`、`1d`、`3d`、`7d` 时，请求总数从数千笔断崖式跌落至个位数；
  - 核心修复：改用 SQLite 原生整数模除截断表达式 `(ts - (ts % ?)) AS slot_start`，确保分桶秒级起始绝对对齐整数边界，且优化 SQL 绑定参数（从 4 个减少至 3 个）；生产环境验证后，数据随时间跨度严格单调递增（3h20m: 1,766 → 5h: 4,991 → 1d: 15,414 → 3d: 26,512 → 7d: 38,138 → 30d: 89,271）。
- **新增 30 天超长分析窗口与六档时间自选全覆盖（30-Day Window Support & Full Presets）**：
  - 在 `live-traffic-tracker.mjs`、`runtime-stats.mjs` 与前端 `admin-overview.js` 中新增 `'30d'` 预设配置（43,200 分钟 / 1,440 分钟桶 / 30 桶）；
  - 全面支持 `3h20m`、`5h`、`1d`、`3d`、`7d`、`30d` 六档预设，并在前端窗口切换器中提供统一的胶囊按钮支持与本地缓存记忆（localStorage 记忆用户自选偏好）。
- **根治多尺度时间分桶 X 轴刻度全屏误显为月份数字 "10" 的异常（Adaptive X-Axis Time Labeling）**：
  - 根因分析：原前端通过 `fullTime.split('-')[0]` 提取时间作为刻度，对于小颗粒度的时分文本（如 `18:00-18:10`）有效，但当跨度超过 1 小时带日期（如 `10-17 18:00-19:00`）时，按 `-` 切割会将前缀月份 `10` 当作时间渲染，导致整屏刻度全部显示为荒谬的数字 `"10"`；
  - 核心修复：重构刻度提取算法，按 `bucketMinutes` 分级自适应：小于 60 分钟提取纯时分 `HH:mm`；大于等于 1440 分钟（天级）通过正则匹配日期 `MM-DD`；小时级窗口则完整提取 `MM-DD HH:mm`，并在分桶密集时实施每隔 2~4 个刻度抽样展示，图表时间清晰可读。
- **全上游凭据（OAuth 与 API Key）双轨融合与舰队大盘数据修复（OAuth & API Key Provider Union）**：
  - 根因分析：`runtime-stats.mjs` 中原本将 `apiKeyProviders` 与 `credentials` 做排他互斥，只要存在任何 API Key 凭据（如 OpenCode），就彻底弃用从 `credentials` 推导的 OAuth 提供商，导致占生产 99% 请求量的 Antigravity、WorkBuddy、Codex 在供应商舰队（Fleet）列表中瞬间蒸发；
  - 核心修复：实现 OAuth 提供商与 API Key 提供商的字典并集归集。两者同名时自动合并其请求量、成功率、桶序列与密钥数；两者不同名时完整并列展示，大盘提供商覆盖率与真实流量 100% 吻合。
- **全套自动化测试套件同步演进与验证（Full Regression Pass）**：
  - 更新 `tests/test_cpa_management.mjs`，将时间窗口可用数量断言从 5 升级至 6，并新增针对 `30d` 窗口参数、分桶计算及切片长度的端到端断言，`npm test` 28 项测试套件全部绿灯通过。

## [v2.9.58] - 2026-10-17

全面接入 CPA 原生 OpenAI-Compatibility 提供商（OpenCode / OpenRouter / StepFun）16 位 Auth-Index 权威目录：

- **深度打通 CPA `openai-compatibility` 凭据源与真实 Auth-Index 映射（CPA OpenAI-Compatibility Deep Integration）**：
  - 根因分析：OpenCode 与 OpenRouter 在 CPA 中属于 `openai-compatibility` 配置，而非独立的 `.json` OAuth 授权文件。此前 Gate 仅通过 `/v0/management/auth-files` 获取上游凭据，导致 CPA 中活跃的 10 个 OpenCode 密钥与 OpenRouter 凭证缺失顶层账号定义。请求发生时，从响应 Trace-ID 提取的 16 位 16 进制索引（如 `d4555aac3173ea13`）在 `cachedUpstreamQuotas.accounts` 中查无此号，被 Gate 误判为已删除凭据；
  - 核心改造：在 [lib/upstream/sync.mjs](lib/upstream/sync.mjs) 中同步拉取 CPA `/v0/management/openai-compatibility` 接口，完整提取 `api-key-entries` 中的 16 位规范 `auth-index`、脱敏密钥及启用状态；
  - 状态精准关联：[lib/analytics/status-summary.mjs](lib/analytics/status-summary.mjs) 中直接利用真实的 `auth-index` 精准关联账号对象，OpenCode 所有活跃账号在主配额大盘中 100% 标记为 `is_deleted: false`，彻底移出底部已删除归档抽屉；
  - OpenRouter 凭据双轨映射：将本地 `openrouter-accounts.json` 中的 API Key 与 CPA 下发的 16 位 `auth-index` 自动绑定，同时兼容 `openrouter-N` 别名与底层真实 16 进制 Trace-ID，确保全链路指标自洽汇聚。

## [v2.9.57] - 2026-10-17

上游凭证配额大盘 OpenCode 原生用量接入、历史已删除账号准确归档与冷启动防误判加固：

- **OpenCode 原生用量统计与配额卡片（OpenCode Native Daily Usage & Quota Cards）**：
  - 完整响应用户对 OpenCode 提供商配额可视化的需求，在凭证卡片与用量大盘中原生呈现 OpenCode 今日消耗与请求统计；
  - 核心链路利用 Gate 本地 SQLite `upstream_daily_stats` 聚合当日（Asia/Shanghai 自然日）权威 Token 消耗总数与请求次数（`today_tokens` / `today_requests`）；
  - 配额管理视图（紧凑列表 + 完整卡片双模式）与用量统计大盘均增加 OpenCode 原生卡片块，清爽展示今日消耗 Token 总量与请求次数，彻底终结 “— 暂无实时配额水位 —” 或 “额度未知，等待 CPA 返回有效数据” 的占位；
  - 上游凭证导航与筛选栏新增 OpenCode 专属过滤标签（`switchUpstreamFilter('opencode')`）与批量刷新按钮。
- **根治历史基线导致已删除账号霸屏与重复 Codex 异常（Ghost Deleted Accounts & Duplicate Codex Fix）**：
  - 根因分析：历史基线表 `upstream_auth_baselines` 记录了旧版导入的凭证基线（包含“阿龙中转”与历史旧 Codex 账号）。此前 `isDeleted` 判定为 `!acc && !base && !rt?.email`，当账号已从 CPA 删除（`!acc` 为真）但仍存留历史基线时（`base` 不为空），`!base` 误判为 `false`，导致 Gate 误把已删除账号作为活跃账号在主卡片网格渲染，产生阿龙中转“复活”及双 Codex 卡片现象；
  - 修复实现：在上游凭证目录已就绪时（`hasUpstreamCatalog`），严格以 CPA 当前活跃凭据目录作为唯一真理源（`isDeleted = Boolean(!acc)`）。不在 CPA 中的账号强制判定为 `is_deleted = true`，自动收拢至底部“已删除账号留痕归档”折叠抽屉中，既保留历史 Token 流水与中文可读名称，又彻底净化主卡片大盘。
- **彻底根治冷启动时 OpenCode 与 OpenRouter 误判进已删除抽屉痛点（Cold-Start Misclassification Elimination）**：
  - 根因分析：在网关冷启动或后台配额缓存尚未写回前，`cachedUpstreamQuotas.accounts` 临时为空，而 OpenCode / OpenRouter 作为现代提供商在历史旧基线中无记录，导致首屏被错误归类为已删除账号，数分钟同步完成后才恢复；
  - 修复实现：
    1. 在 [lib/upstream/sync.mjs](lib/upstream/sync.mjs) 中为 `syncUpstreamQuotas` 引入并发互斥锁 `inFlightSyncPromise`，防止并发调用并发起重复拉取或返回空快照；
    2. 在 [lib/routes/admin-routes.mjs](lib/routes/admin-routes.mjs) 的 `/admin/api/upstream-auth-stats` 路由中增加就绪门禁，当凭证目录尚未加载时同步等待后台拉取完成，保证首次请求即下发准确分类。
- **全套自动化回归测试套件（Automated Regression Test Suite）**：
  - 新增专用集成测试 [tests/test_opencode_quota_and_deleted_separation.mjs](tests/test_opencode_quota_and_deleted_separation.mjs)，覆盖前端 JavaScript 语法校验、历史基线账号与活跃凭证准确分类、OpenCode 今日用量字段映射等契约，并纳入 `npm test` 自动闸门。

## [v2.9.56] - 2026-10-17

网关全链路优雅停机与在途流式推理请求连接排空（Graceful Shutdown & In-Flight Stream Draining）：

- **在途长流式与 WebSocket 全链路零中断排空（Zero-Interruption In-Flight Request Draining）**：
  - 彻底根治生产环境（如运维热更、节点重启、服务重载）执行 `systemctl restart gate` 时瞬时切断在途 LLM 推理长流式响应，导致客户端（如 Claude Desktop / CLI）遭遇 `Stream error: error decoding response body` 的痛点；
  - 核心模块引入 [lib/core/graceful-shutdown.mjs](lib/core/graceful-shutdown.mjs)，接管 Node.js 原生 `SIGTERM` / `SIGINT` 终止信号；
  - 信号到达时立即执行 `server.close()` 停止监听端口，并通过 `server.closeIdleConnections()` 极速释放闲置的 Keep-Alive 连接，杜绝空闲句柄挂起；
  - 在途活跃 HTTP/SSE 长流式推理与 WebSocket 全双工通道继续正常交互与数据吐出，直至上游完成推理或客户端自然断开，实现“只出不进”优雅收尾；
- **停机阶段瞬时拦截防御与连接隔离（503 Fast Reject & Auto Connection Close Injection）**：
  - 停机期间在既有连接上新到达的业务请求一律直接返回 HTTP 503 `service_shutting_down`，附带 `Connection: close` 与 `Retry-After: 5`，避免客户端在即将消亡的节点上积压重试；
  - 健康检查探针（`/healthz`、`/readyz`）同步返回 503 `shutting_down`，通知上游负载均衡网关（如 Nginx / HAProxy / SLB）即刻将该节点摘除；
  - 在途流式请求写入响应头时自动拦截并注入 `Connection: close`，并在响应 `finish` 后主动释放底层 Socket，杜绝客户端重用旧通道；
- **有界超时强制截断与用量一致性落盘保底（Bounded Timeout & Final Outbox Flush Guarantee）**：
  - 支持通过环境变量 `GATE_SHUTDOWN_TIMEOUT_MS` 配置最大排空容忍时限（默认 60,000ms = 60s）；
  - 配套更新 [gate.service](gate.service)，显式设置 `TimeoutStopSec=75` 与 `KillMode=control-group`，预留 15 秒充裕系统级缓冲；
  - 排空完成（或超时截断）后，自动触发 `flushUsage()` 一致性刷盘，将最后一批在途完成 Token 完整写入 SQLite 持久化层，杜绝用量丢失；
- **Prometheus 监控指标与全套自动化测试回归（Prometheus Metrics & Automated Regression Suite）**：
  - `/metrics` 端点扩充 `gate_shutting_down`、`gate_in_flight_http_requests`、`gate_in_flight_ws_requests` 与 `gate_in_flight_requests_total` 实时排空监控指标；
  - 新增专用集成测试套件 [tests/test_graceful_shutdown.mjs](tests/test_graceful_shutdown.mjs)，覆盖正常追踪、503 快速拒绝、长流式自然排空、超时截断保护与 `/metrics` 状态验证等全量用例，并纳入 `npm test` 自动闸门。

运行总览实时流量新增多时间窗口自选切换（Aozora UI Multi-Window Switcher for Live Traffic & Overview）：

- **多跨度时间窗口自由选择（Multi-Span Window Selection）**：
  - 突破过去固定在 CPA 200 分钟（3 小时 20 分）的单一限制，新增 `3h20m`（默认）、`5h`、`1d`（24 小时）、`3d`（72 小时）、`7d`（7 天）共 5 档时间粒度；
  - 自动根据选定跨度自适应分桶粒度：`3h20m` 与 `5h` 保持 10 分钟一桶，`1d` 采用 1 小时一桶，`3d` 采用 3 小时一桶，`7d` 采用 6 小时一桶，图表柱数恒定维持在 20～30 根黄金视觉区间；
- **全链路动态分桶与快速聚合（Dynamic In-Memory & SQLite Aggregation Pipeline）**：
  - 默认 `3h20m` 优先走内存槽位纳秒级 O(1) 累加与未落盘 Outbox/Pending 事件对齐，零数据库 I/O 损耗；
  - 扩展时间窗口（`5h` / `1d` / `3d` / `7d`）基于 SQLite 既有 `idx_events_ts` 索引毫秒级范围聚合（[lib/db/sqlite.mjs](lib/db/sqlite.mjs)、[lib/analytics/live-traffic-tracker.mjs](lib/analytics/live-traffic-tracker.mjs) 与 [lib/upstream/runtime-stats.mjs](lib/upstream/runtime-stats.mjs)）；
  - `/admin/api/runtime-facts` 接口支持 `?window=<id>` 查询，并在基础凭据事实缓存未失效时动态重算窗口 totals 与分桶，实现无感极速切换；
- **Aozora UI 药丸切换组件与持久化（Aozora Pill Switcher with LocalStorage Persistence）**：
  - 在运行总览「实时流量」卡片标题栏右侧加入 Aozora 蓝白药丸组件（[admin-overview.js](admin-overview.js)、[admin-overview.css](admin-overview.css)）；
  - 切换时间窗口后自动同步更新 Hero 卡片指标、分桶颗粒度文案、横轴时间跨度、Tooltip 视窗标签与底层柱状图，并通过 `localStorage` 记住选择，刷新页面不丢失；
- **端到端与全链路契约回归测试（End-to-End & Playwright Automation Suite）**：
  - 在 [tests/test_cpa_management.mjs](tests/test_cpa_management.mjs) 中追加 5h 与 1d 动态分桶切片的 API 契约断言；
  - 在 [tests/test_cpa_ui.py](tests/test_cpa_ui.py) 中追加浏览器端时间窗口切换、状态持久化与 Hero 文案联动的 Playwright 自动化测试。

## [v2.9.54] - 2026-10-17

请求流水新增模型名称后缀思考强度智能推断（Model Name Suffix Heuristic Inference for Reasoning Effort）：

- **模型后缀启发式智能推断（Heuristic Suffix Inference for Discarded Parameters）**：
  - 针对客户端（如 Claude CLI / OpenAI SDK 兼容适配器）调用非 OpenAI 原生模型（如 Gemini、DeepSeek、Claude 等）时，因客户端 SDK 参数白名单机制导致前端选择的思考强度（如 `Max`）未随 HTTP Body 序列化 `reasoning_effort` 的痛点；
  - 在 `extractReasoningEffort`（[lib/proxy/token-estimator.mjs](lib/proxy/token-estimator.mjs)）中新增模型后缀智能推断机制，精准识别 `[-_:](high|medium|low|max)$` 后缀（如 `gemini-3.8-flash-high`、`gemini-2.5-flash-thinking-max`、`claude-3.7-sonnet:low`）；
  - 显式入参（`reasoning_effort`、`thinking`、`thinking_config`）具备最高优先级，模型后缀作为无显式参数时的无害兜底；
- **历史记录动态映射与零副作用保障（Safe Zero-Side-Effect & Dynamic Historical Backfill）**：
  - 该推断仅在审计落盘与流水查询呈现层生效，绝对不篡改转发至上游 CPA 的请求体，规避任何上游 HTTP 400 校验异常；
  - 在 [lib/analytics/audit-logs.mjs](lib/analytics/audit-logs.mjs) 的 `resolveEventReasoningEffort` 中对历史已落盘记录进行动态兜底，使得历史包含后缀的模型立即展示对应的紫色强度徽章，无需重写历史库表；
- **自动化测试回归验证（Automated Regression Test Suite）**：
  - 在 [tests/test_gate_features.mjs](tests/test_gate_features.mjs) 的测试 28 中追加针对各种分隔符（`-`、`_`、`:`）与显式入参优先级的完整自动化断言。
- **运行总览多时间窗口聚合查询（Multi-Window Aggregation & Sharding for Runtime Facts）**：
  - 扩展 `/admin/api/runtime-facts` 支持 `window` 参数（`3h20m`、`5h`、`1d`、`3d`、`7d`）（[lib/routes/admin-routes.mjs](lib/routes/admin-routes.mjs) 与 [lib/upstream/runtime-stats.mjs](lib/upstream/runtime-stats.mjs)）；
  - 结合持久层 `request_events` 分桶索引（[lib/db/sqlite.mjs](lib/db/sqlite.mjs)）与本地内存双轨追踪（[lib/analytics/live-traffic-tracker.mjs](lib/analytics/live-traffic-tracker.mjs)），实现不同跨度的动态快速重算；
  - 并在 [tests/test_cpa_management.mjs](tests/test_cpa_management.mjs) 中补充集成测试用例。

## [v2.9.53] - 2026-10-17

请求流水速率徽章移除 Emoji 并统一 Aozora 纯净视觉规范（Refine Generation Speed Badge Styling without Emojis）：

- **视觉风格一致性优化（Unified Minimalist Badge Design）**：
  - 移除请求流水「速率 (tok/s)」单元格中的闪电图标（`⚡`），统一保持纯粹数字与紧凑半透明单位标记（`${tpsNum} tok/s`）（[admin-logs.js](admin-logs.js)）；
  - 保留速率档位色阶（极速绿、高速青、低速橙），视觉更整洁沉静，与全站 Aozora UI 保持无缝一致。

## [v2.9.52] - 2026-10-17

运行总览上游路由策略选择器全面升级为统一 Aozora UI 下拉组件（Unified Aozora CustomDropdown for Runtime Routing Strategy）：

- **全站选择组件一致性闭环（100% Elimination of Primitive Native Selects）**：
  - 将控制台「运行总览」（Runtime Overview）中最后一个原生的 HTML `<select id="ovw-routing-strategy">` 替换为统一的轻量青空规范组件 `CustomDropdown`（[admin-overview.js](admin-overview.js)）；
  - 彻底淘汰浏览器原生弹窗样式，提供微浮动动画、自适应视口碰撞向上展开（`.dropup`）、点击外部自动收起及 `Escape`/`ArrowUp`/`ArrowDown` 完整键盘导航无障碍支持；
- **双层架构确保自动化测试与事件同步（Dual-Layer Architecture & Full Test Compatibility）**：
  - 在渲染现代 `.ovw-routing-dropdown` 容器的同时保留隐藏的 `<select id="ovw-routing-strategy" style="display:none;" aria-hidden="true">` 并双向绑定；
  - 保证 Playwright 自动化测试脚本（[tests/test_cpa_ui.py](tests/test_cpa_ui.py)）与表单事件的完全向后兼容；
- **青空微装饰样式微调（Aozora Control Styling）**：
  - 在 [admin-overview.css](admin-overview.css) 中为 `.ovw-dropdown-wrap` 与 `.ovw-routing-dropdown` 添加紧凑对齐、自适应截断与层级（z-index）保护，与总览网格保持严丝合缝；
- **界面版本标识同步（UI Version Tag Alignment）**：
  - 将导航栏标题版本标识同步对齐至 v2.9.52（[admin.html](admin.html)）。

## [v2.9.51] - 2026-10-17

请求流水统计新增思考强度 (Reasoning Effort) 与生成速率 (tok/s) 字段（Audit Logs Reasoning Effort & Generation Speed Statistics）：

- **思考强度智能解析与归一化（Multi-Protocol Reasoning Effort Ingestion）**：
  - 新增 `extractReasoningEffort` 模块（[lib/proxy/token-estimator.mjs](lib/proxy/token-estimator.mjs)），无缝统一业界主流思考/推理配置协议：
    - **OpenAI / Codex / o-series**：解析 `reasoning_effort`（`low` / `medium` / `high` / `max`）以及嵌套 `reasoning.effort`、`reasoningEffort`；
    - **Anthropic Claude**：解析 `thinking.budget_tokens`（归一化为 `budget:2048` 等）与 `thinking.type`（如 `adaptive`），对 `disabled` 状态安全过滤；
    - **Google Gemini**：解析 `thinking_config.thinking_budget`（归一化为 `budget:1024` 等）与 `thinking_config.mode`；
  - 在转发链路（[lib/proxy/transport.mjs](lib/proxy/transport.mjs)）与网关拦截层（[server.mjs](server.mjs)）中自动提取请求体中的思考强度，并注入至审计记录流水。
- **纯输出阶段生成速率计算（Accurate Pure Generation TPS Algorithm）**：
  - 新增 `calculateTokensPerSec` 算法（[lib/proxy/token-estimator.mjs](lib/proxy/token-estimator.mjs)）：
    - 对于流式请求，当具备有效首字延迟（TTFT）且生成耗时达标时，智能扣除首字等待延迟（`duration = latency - ttft`），精准计算模型纯输出吞吐速率；
    - 对于非流式请求或异常时间窗口，平滑回退至总耗时计算，四舍五入保留 1 位小数；
  - 在 [lib/core/outbox.mjs](lib/core/outbox.mjs) 的 `normalizeRequestEvent` 中自动计算并落盘。
- **数据存储持久化与平滑迁移（Database Schema & Non-Destructive Alter Migrations）**：
  - 在 [lib/db/sqlite.mjs](lib/db/sqlite.mjs) 中为 `request_events` 和 `usage_outbox` 表扩展 `reasoning_effort TEXT DEFAULT ''` 与 `tokens_per_sec REAL NOT NULL DEFAULT 0`；
  - 在启动迁移数组 `alterMigrations` 中追加非破坏性 `ALTER TABLE` 语句，确保平滑热升级无需重建数据库；
  - 在 [lib/analytics/audit-logs.mjs](lib/analytics/audit-logs.mjs) 中支持对历史遗留未记录速率的数据动态实时计算，保证历史流水无断层与空白展示；支持通过 `search` 模糊搜索匹配思考强度。
- **Aozora UI 现代化流水道展示（Modern Frontend Table & Badges Integration）**：
  - 在 [admin.html](admin.html) 与 [admin-logs.js](admin-logs.js) 中将请求流水表格扩展为 12 列，新增「思考强度」与「速率 (tok/s)」列；
  - 在 [admin-style.css](admin-style.css) 中新增微透明 Aozora 紫色胶囊样式 `.chip-purple` 与闪电速率徽章样式 `.speed-badge`（包含绿色 ≥100 tok/s、青色 50~100 tok/s 等梯度色彩区分）。
- **全链路契约回归与端到端测试（End-to-End Integration Test Suite）**：
  - 在 [tests/test_gate_features.mjs](tests/test_gate_features.mjs) 中新增测试 28，覆盖协议提取、速率算法、存储持久化、动态补算与 DOM/样式契约全量断言。

## [v2.9.50] - 2026-10-17

OpenCode 免费模型推断优先级修正与防误判加固（Fix Provider Inference Order: Prioritize -free & OpenCode Over StepFun）：

- **前端日志与服务端提供商推断口径修正（Prioritize -free in Provider Inference）**：
  - **核心痛点解决**：此前在日志展示与注册表推断中，由于 `stepfun` 判定（`startsWith('step')`，`sort_order: 50`）排在 `opencode`（`includes('-free')`，`sort_order: 60`）之前，导致 OpenCode 平台专属的免费模型（如 `step-5-preview-free`）被错误识别为 StepFun 渠道，并在前端动态渲染为 "StepFun 阶跃星辰 渠道 d4555aac"；
  - 在 [admin-logs.js](admin-logs.js) 的 `resolveEventProvider` 中，将 `opencode` / `-free` 的匹配规则前移至 `step` 规则之前，确保所有包含 `-free` 后缀的聚合免费模型均准确识别为 `opencode`；
  - 在 [lib/core/provider-registry.mjs](lib/core/provider-registry.mjs) 中将 `opencode` 的内置 `sort_order` 从 60 调整为 45（优先于 `stepfun` 的 50），保证前后端推断口径严格一致；
  - 在 [tests/test_gate_features.mjs](tests/test_gate_features.mjs) 中补充 `step-5-preview-free` 与 `step-5-preview` 的正反向推断断言，杜绝未来出现推断回退。

## [v2.9.49] - 2026-10-17

上游连接池复用与现代模型选择器（Upstream HTTP Keep-Alive Connection Pooling & Modern Aozora Model Picker）：

- **上游长连接池模块化与全链路复用（Upstream HTTP Keep-Alive Agent）**：
  - 新增专用 [lib/proxy/http-agent.mjs](lib/proxy/http-agent.mjs)，建立单例 `upstreamHttpAgent`（配置 `keepAlive: true, keepAliveMsecs: 15000, maxSockets: 256, maxFreeSockets: 64, timeout: 120000`）；
  - 将模型数据转发链路（[lib/proxy/transport.mjs](lib/proxy/transport.mjs)）、原生管理反向代理链路（[lib/routes/upstream-proxy.mjs](lib/routes/upstream-proxy.mjs)）、高频多版本管理 API 查询（[lib/upstream/management.mjs](lib/upstream/management.mjs)）以及 Key 注册表同步（[lib/core/key-registry.mjs](lib/core/key-registry.mjs)）全面接入该连接池；
  - 消除每次与上游 CPA（8315）交互时的 TCP 频繁握手与销毁开销，提升首字延迟（TTFT），减少系统 socket 句柄和 `TIME_WAIT` 堆积。
- **现代 Aozora UI 极简模型搜索选择器（Modern Model Picker Dropdown Component）**：
  - 彻底移除配置弹窗中圈出的粗糙手动输入框与“添加”按钮（[admin.html](admin.html)），淘汰浏览器原始原生 `<select>` 控件；
  - 升级配置弹窗中的模型选择体验，引入纯 CSS/JS 现代毛玻璃青空风格下拉选择菜单（[admin-style.css](admin-style.css)、[admin.html](admin.html) 与 [admin-keys.js](admin-keys.js)）；
  - 支持全量上游模型即时搜索过滤、一键多选添加/移除切换，并保留对未收录自定义模型 ID 的直接添加支持。

## [v2.9.48] - 2026-10-17

API 密钥模型权限胶囊展示归一化、上游模型实时拉取与配置弹窗精简（Model Permission Display Unification, Upstream Model Discovery & Key Modal Streamlining）：

- **模型权限胶囊展示归一化（Normalize Model Permission Badges in API Keys Table）**：
  - **核心痛点解决**：此前在 API 密钥列表中，当 Key 白名单配置为单个模型时，由于 JSON 序列化数组（`["gemini-3.8-flash-high"]`）与原生逗号/空格分隔字符串的解析分支不一致，导致同为单个模型时有的显示 `允许 1 个模型`，有的显示模型具体名称（如 `gemini-3.8-flash-high`），造成界面语义割裂；
  - 在 [admin-keys.js](admin-keys.js) 中统一白名单解析逻辑：无论以 JSON 数组、JSON 字符串还是以文本逗号/空格分隔存储，提取到的模型列表在数量为 1 时一律直接显示该模型的具体名称；当模型数量大于 1 时统一展示 `允许 N 个模型` 并带完整悬浮提示（`title`）；未设置限制时统一展示 `全部模型 (*)`；
  - 在 [admin-style.css](admin-style.css) 中对 `.model-perm-badge` 补充 `max-width: 240px; overflow: hidden; text-overflow: ellipsis;`，防止超长模型名称破坏表格排版。
- **Key 规则配置弹窗移除冗余提示与陈旧预设（Purify Key Configuration Modal）**：
  - 在 [admin.html](admin.html) 的“配置 Key 规则”弹窗（`#edit-modal`）中，彻底移除硬编码的模型组预设按钮行（`全部 (*)`、`Flash/Mini经济组`、`Claude专属组`、`推理旗舰组`、`清空`），杜绝因上游模型演进导致硬编码预设过期的问题；
  - 彻底移除“启用每日额度硬顶管控”下方的次级辅助描述 `<div class="help-text">关闭时此 Key 不限制每日 Token 上限</div>`，使弹窗表单更加紧凑精炼。
- **新增上游模型实时拉取与选择器（Upstream Model Discovery & Selection）**：
  - 在 [admin.html](admin.html) 白名单标签栏下方新增模型拉取与选择交互组件（`<select id="edit-upstream-model-select">` 与 `<button id="btn-fetch-models">`）；
  - 在 [admin-keys.js](admin-keys.js) 中接入 `/admin/api/cpa/models` 端点，管理员点击“拉取上游模型”即可实时查询上游 CPA / 模型系统目录中全部可用模型，并在下拉菜单中直接选择模型自动添加到白名单标签栏（支持去重、已添加标记与会话级内存缓存），同时完整保留自定义输入模型 ID 的回车添加能力。

## [v2.9.47] - 2026-10-17

架构治理与协同规约纯净化（Zero-Burden Infrastructure & Architecture Governance）：

- **项目级协同规约彻底纯净化（Complete Removal of Project-Level Coordination Burden）**：
  - 遵循 Agent-Nexus“零负担被动防护”铁律，彻底移除此前在 [AGENTS.md](AGENTS.md) 注入的 `<!-- NEXUS-COORDINATION-START -->` 规约块与本地 `.mcp.json` 引用，仓库恢复 100% 业务纯净无感态；
  - 协同防护全面委托至宿主机全局 PreToolUse Hook 与中枢 Daemon，业务仓库无需承担任何配置负担或制度文本。

## [v2.9.46] - 2026-10-17

控制台顶部场景纯净化与版本标识对齐（Purify Top Workspace Scenic Header & Synchronize Global Version Badge）：

- **顶部冗余字体彻底移除与场景通透化（Complete Removal of Redundant Top Intro Typography）**：
  - **核心痛点解决**：此前各工作台页面顶部 `.page-intro` 容器内常驻展示大字号页面标题（`#page-title`，如“API 密钥”、“上游凭证”等）与副标题说明（`#page-description`，如“管理成员访问权限、速率限制与每日额度。”）。该文字与顶部导航栏面包屑（`工作台 / API 密钥`）及下方各卡片内部面板标题（`API 密钥与配额管控`）形成三重重复冗余，且巨大文字直接覆盖在青空樱花观景台原画之上，严重破坏了 Aozora UI 的通透美感与呼吸感；
  - 在 [admin.html](admin.html) 中将 `.page-intro > div:first-child` 初始结构显式置为隐藏（`display:none`），同时保留内部 DOM 节点以保证 `getElementById` 赋值与自动化测试契约完全兼容；
  - 在 [admin-style.css](admin-style.css) 中对 `.page-intro > div:first-child`、`.page-intro h2`、`.page-intro p`、`#page-title`、`#page-description` 设置全局 `display: none !important;`，桌面端与移动端媒体查询全覆盖；
  - **顶部空白彻底折叠与卡片自然上移（Collapse Empty Top Spacing & Shift Workspace Cards Upward）**：针对文字移除后留下的 156px 空白占位问题，将非配额页面的 `.page-intro` 容器彻底折叠（`display: none !important; min-height: 0 !important; margin: 0 !important; padding: 0 !important;`），配额页面仅紧凑保留操作按钮（“配额健康详情”、“刷新上游配额”）并自适应居右对齐，各页面业务卡片（如 Google 验证指标卡、API 密钥表格、请求流水等）自然上移贴合顶栏，彻底解决顶部大面积空白空洞感。
- **侧边栏品牌版本标识同步对齐（Synchronize Sidebar Brand Version Badge）**：
  - 修复 [admin.html](admin.html) 侧边栏品牌头部硬编码历史版本号 `v2.9.37` 的缺陷，与 [package.json](package.json) 权威版本对齐升级为 `v2.9.46`，彻底杜绝版本显示落后引发的部署陈旧疑虑。

## [v2.9.45] - 2026-10-16

实时流量图表重构为 Gate 本地权威双轨流，彻底免疫上游 CPA 容器重启导致的历史数据丢失（Refactor Live Traffic Chart to Gate-Authoritative Dual-Track Streams with Zero CPA Restart Vulnerability）：

- **核心痛点与事故根因解决（Root Cause & Incident Resolution）**：
  - **核心痛点解决**：此前运行总览管理控制台上的“LIVE TRAFFIC 实时流量”吞吐图直接依赖上游 CPA 的内存 `recent_requests` 桶（固定 20 桶 x 10 分钟 = 200 分钟窗口）。当生产机升级、重启或重建 CPA 容器时，CPA 内部内存桶瞬间归零，导致管理台近 200 分钟历史流量出现大面积空白断层；
  - **事实真相还原**：经排查确认 Gate 的 SQLite 数据库（`gate.db`）完整记录了流经网关的全部数万笔真实请求，未丢失任何一笔数据，缺陷完全在于前端数据源绑定了易失的上游内存桶。
- **双轨架构与零数据库 I/O 损耗设计（Dual-Track In-Memory / SQLite Architecture）**：
  - **读热路径（Hot Path）**：在 [lib/analytics/live-traffic-tracker.mjs](lib/analytics/live-traffic-tracker.mjs) 中基于 10 分钟时间槽对齐（`Math.floor(ts / 600)`），由 `recordRequest`（[lib/core/outbox.mjs](lib/core/outbox.mjs)）在每笔请求完成时执行内存纳秒级 O(1) 累加，请求处理路径零数据库 I/O 损耗，彻底杜绝自发 DDoS；
  - **冷启动持久化恢复（Cold Start Recovery）**：在服务启动初始化流程（[quota-manager.mjs](quota-manager.mjs)）中，基于 `idx_events_ts` 索引查询 `request_events` 近 200 分钟历史事件，并无缝叠加尚未落盘的 `usage_outbox` 与 `pendingEvents` 内存待办事件，进程重启后瞬间恢复完整的 200 分钟流量图；
  - **低频定期对齐（Periodic Reconciliation）**：后台每 5 分钟定时执行一次轻量对齐（`reconcileLiveTraffic`），先执行 Outbox 刷盘再重新校验 SQLite 最新权威事实，彻底杜绝长期运行下的内存与数据库状态漂移；
  - **上游解耦与权威判定（Decoupling & Authoritative Fallback）**：在 [lib/upstream/runtime-stats.mjs](lib/upstream/runtime-stats.mjs) 的 `buildTotals` 中，以 Gate 本地追踪为第一真相源（标记 `source: 'gate_local'`），CPA 容器重启导致其桶为空时，本地 20 桶依然完整保留，图表与总量指标自洽无损。
- **全链路集成测试覆盖（Comprehensive Integration Test Coverage）**：
  - 在 [tests/test_gate_features.mjs](tests/test_gate_features.mjs) 中新增“测试 27: 实时流量本地双轨追踪与 CPA 重启数据韧性”，全面覆盖纳秒级内存槽位对齐、冷启动 SQLite / Outbox 恢复、5 分钟低频对齐以及 CPA 容器重启清空场景，全套 27 项测试套件全部通过。

## [v2.9.44] - 2026-10-16

修复请求流水热更新下拉菜单穿透重叠与无损 DOM 状态保持（Fix Dropdown Menu Layer Stacking Context and Lossless State Preservation during Log Hot Updates）：

- **CSS 层叠上下文隔离与 GPU 合成层穿透修复（Stacking Context Isolation & GPU Compositing Layer Fix）**：
  - **核心痛点解决**：在请求流水开启全局实时轮询热更新时，新请求行入场动画（`live-row-enter`）包含 `translateZ(0)` 与 `will-change: transform`，会被浏览器引擎提升为独立 3D GPU 合成层；而筛选工具栏 `.logs-controls` 因声明了 `backdrop-filter: blur(8px)` 形成隔离层叠上下文却未设定绝对的 `z-index`，导致后续兄弟节点表格内容直接穿透覆盖在浮动的服务商下拉菜单之上；
  - 在 [admin-style.css](admin-style.css) 中对 `.logs-controls` 显式声明 `position: relative; z-index: 10;`，当存在展开下拉菜单时提升至 `z-index: 50;`；
  - 对表格滑动容器 `.table-scroll-container` 明确约束 `position: relative; z-index: 1;`，确保任何三维 GPU 合成层均无法越级穿透覆盖上层浮动菜单；
  - 对激活展开的 `.dropdown.open` 赋予高优先级 `z-index: 100;`。
- **自定义下拉组件无损差异比对与交互状态保护（Lossless Diffing & Scroll Preservation in CustomDropdown）**：
  - 在 [admin.html](admin.html) 的 `CustomDropdown` 类中重构 `updateOptions(options, selectedValue)`：在热更新周期内比对新旧选项列表与选中值，若无变动则静默跳过渲染，彻底消除频繁销毁重建 DOM 导致的滚动条归零和闪烁；
  - 若数据确实变化，在重新渲染前后记录并恢复 `.dropdown-menu` 内部 `scrollTop` 滚动进度；
  - 展开与关闭时联动父级容器动态赋予/移除 `.has-open-dropdown` 类，实现兼容旧浏览器的双重层级保护。

## [v2.9.43] - 2026-10-16

侧边栏请求流水与故障中心徽标口径重构：由历史全量改为展示今日（Asia/Shanghai 当天）请求与故障计数（Refactor Sidebar Badges to Display Today's Requests and Errors Instead of All-Time Totals）：

- **业务口径重构与精准下钻（Accurate Today's Metric Alignment）**：
  - **核心痛点解决**：此前控制台侧边栏导航上的“请求流水”与“故障中心”徽标直接绑定查询表格的未过滤总条数，导致请求流水常年显示 `9999+`、故障中心长期显示累积的历史上千条故障总数，无法让管理员和成员直观感知今日系统的实时活跃度与健康状况；
  - **今日口径锚定**：统一基于东八区（Asia/Shanghai）自然日零点（`00:00:00`）为基准时点，只统计并呈现从今日零点至当前时间的请求总数与故障总数。
- **服务端高速统计与状态大盘下发（High-Performance Database Query & Backend API Integration）**：
  - 在 [lib/analytics/audit-logs.mjs](lib/analytics/audit-logs.mjs) 中基于已有的 `request_events(ts)` 与 `error_events(ts)` 覆盖索引，新增 `getTodayStartTimestamp()`、`getTodayRequestsCount(keyId)` 与 `getTodayErrorsCount(keyId)` 高速只读查询，单次毫秒级返回，并在写请求落盘一致性刷新缓冲 `flushUsage()` 之后安全聚合；
  - 在 `getPagedRequests` 与 `getPagedErrorEvents` 的服务端分页返回体中附带 `today_total`，确保流水与故障页刷新时即时校准今日指标；
  - 在 [lib/analytics/status-summary.mjs](lib/analytics/status-summary.mjs)（`/admin/api/status-summary`）与 [lib/routes/member-routes.mjs](lib/routes/member-routes.mjs)（`/api/member/status-summary`）中全量输出 `today_requests` 与 `today_errors`（成员模式自动按凭据 `keyId` 严格隔离）。
- **前端首屏水合、隔天自愈与表格筛选解耦（SWR Hydration, Day-Rollover Zeroing & Filter Decoupling）**：
  - 在 [admin.html](admin.html) 中引入独立本地持久化键 `gate_cache_today_badges_v1`，携带东八区日期标记 `date: YYYY-MM-DD`。首屏水合立即恢复今日数字，若跨入新的一天则自动清零，杜绝白屏闪烁与昨日脏数据；
  - 抽离出权威更新入口 `updateNavBadgeLogs(count)` 与 `updateNavBadgeErrors(count)`；
  - 在 [admin-logs.js](admin-logs.js) 中彻底移除表格按条件筛选（如状态码、用户、服务商、分页）时对侧边栏导航徽标的错误篡改，导航徽标与表格底部局部翻页器（如 `第 1 / 4 页 (共 98 条)`）彻底解耦；
  - 在 [admin-stats.js](admin-stats.js) 的 `fetchGateStatus()` 中监听心跳大盘下发的 `today_requests` 与 `today_errors` 实时对齐导航徽标。

## [v2.9.42] - 2026-10-16

管理台视觉纯净化：去除页面副标题顶部全大写英文字眉装饰（Remove Uppercase Eyebrow Badges from Page Intro Headers）：

- **视觉规范降噪与审美对齐（Visual Noise Reduction & Clean Header Hierarchy）**：
  - 彻底移除管理控制台各页面主标题（如“上游凭证”、“服务状态”、“请求流水”等）上方的全大写英文装饰字眉（如 `UPSTREAM OPERATIONS`、`SERVICE STATUS` 等）；
  - 在 [admin.html](admin.html) 中移除初始 DOM 中的 `page-eyebrow` 标签，并调整 `updatePageContext()` 防御性更新逻辑；
  - 在 [admin-style.css](admin-style.css) 中对 `.page-eyebrow` 设置全局不可见并规范标题外边距，使顶部樱花场景和标题层级更加清爽通透。

## [v2.9.41] - 2026-10-16

凭据用量大盘卡片支持 WorkBuddy 资源包积分与 OpenRouter 今日请求次数实时水位展示（Render Real-Time Quota Bars for WorkBuddy Credits & OpenRouter Daily Requests in Upstream Auth Cards）：

- **多 Agent 并发协同与工程记忆中枢接入（Agent-Nexus Integration & Engineering Governance）**：
  - **环境识别与视界隔离**：基于项目根物理路径确立规范 Project ID（`efdbbb4db064cbdf`），支持跨 Git Worktree 共同根自动对齐；
  - **项目级 MCP 无损智能注入**：在项目根 `.mcp.json` 中增量注入 `nexus` 节点，与既有 `aoci` 全局代码认知服务无损共存；
  - **物理隔离与 Git 纯净边界治理**：在 `.gitignore` 中补充 `.nexus` 本地状态目录忽略规则，严格守住宿主机私有配置零污染远端仓库铁律；
  - **协同纪律对齐**：在 [AGENTS.md](AGENTS.md) 注入 Onboarding 意图申报、命名资源锁（`tests`、`dev-server`、`build`）、跨工作树防撞与长期经验沉淀（`nexus_save_memory`）三原则。
- **凭据大盘水位卡片多源异构统一呈现（Unified Quota Water Level across Heterogeneous Providers）**：
  - **核心痛点解决**：此前管理控制台用量大盘的凭据卡片视图（`upstream-stat-card`）硬编码依赖 `quota_5h`（仅限 Antigravity 与 Codex 滑动窗口），导致 WorkBuddy 凭据与 OpenRouter 凭据一律降级显示为“— 暂无实时配额水位 —”，无法直观感知额度余量；
  - **WorkBuddy 积分实时水位**：确立“WorkBuddy 的配额即资源包积分”的业务领域模型。卡片实时展示资源包可用剩余积分、百分比进度条（绿/黄/红三级警戒色），并在底部次行清晰标明总积分与已用积分；
  - **OpenRouter 今日请求次数实时水位**：确立“OpenRouter 的配额即今日已请求次数与 800 次/日限额”的业务领域模型。卡片高亮展示今日请求次数与 `/ 800 次` 限额、UTC 00:00 重置倒计时、剩余可用请求条以及日重置周期标签。
- **服务端大盘统计接口字段聚合补全（Upstream Auth Stats API Field Extraction & Fallback Matching）**：
  - 在 [lib/analytics/status-summary.mjs](lib/analytics/status-summary.mjs) 的 `getUpstreamAuthStats` 中，扩展多维凭据索引匹配（支持 `auth_index`、`filename`、`id`、`workbuddy` 与 `openrouter-${id}` 兼容前缀）；
  - 自动提取并导出 WorkBuddy `total_credits`、`remaining_credits` 与 `used_credits`（若顶层缺失则从 `acc.groups[].buckets` 自动按需累加）；
  - 自动提取并导出 OpenRouter `today_requests`、`daily_limit`（默认 800）、`remaining_requests`、`reset_time` 与 `reset_countdown`。
- **前端卡片渲染与多层兜底（Aozora UI Responsive Card Rendering in `admin-quotas.js`）**：
  - 在 [admin-quotas.js](admin-quotas.js) 的 `renderUpstreamStatsTable()` 中扩展卡片分支逻辑：
    - `isWorkBuddy` 分支：优先使用接口返回的积分，若接口未刷则从前端缓存 `cachedUpstream.accounts` 兜底查找，支持数字本地化格式化；
    - `isOpenRouter` 分支：优先使用接口返回的每日请求计数，同样支持 `cachedUpstream.accounts` 兜底与 UTC 00:00 倒计时展示；
    - `quota_5h` 分支：保持 Antigravity 与 Codex 5小时与周限额滑动窗口平滑向下兼容。
- **全链路自动化测试回归锁死（Full-Stack Regression Locks in Integration Tests）**：
  - 在 [tests/test_workbuddy_quota_and_table.mjs](tests/test_workbuddy_quota_and_table.mjs) 中增加独立测试“测试 4: 凭据卡片大盘 WorkBuddy 积分与 OpenRouter 今日请求次数契约”，严密断言 `admin-quotas.js` 语法与渲染模板、`lib/analytics/status-summary.mjs` 字段导出与契约一致性；
  - 运行全部测试流水线 `npm test`，所有 26 项核心测试与子套件 100% 绿灯通过。

## [v2.9.40] - 2026-10-16

彻底解耦重构管理后台 `admin.html`：完成内联 CSS 与四大业务领域 JS 模块化物理拆分（Decouple Monolithic `admin.html` into CSS & Modular Business JS Scripts）：

- **单体上帝文件彻底瘦身（Eliminate Monolithic God File）**：
  - **核心痛点解决**：随着 Google Antigravity 多端点容灾、WorkBuddy 官方计量集成、请求流水多维筛选等业务特性的快速迭代，管理控制台 `admin.html` 逐渐膨胀至 **9,421 行**的超大单体文件，维护心智负担与代码合并冲突风险剧增；
  - **体积锐减 71%**：在严格遵守**零打包依赖（Vanilla JS/CSS 开箱即用）**、**HTML 内联事件回调兼容**与**原生浏览器加载顺畅**的前提下，将 `admin.html` 从 9,421 行彻底精简至 **2,727 行**（仅保留核心 HTML DOM 骨架、全局核心状态管理与 Tab 路由引导代码）。
- **业务领域垂直解耦与静态资源架构（Domain-Driven JS & CSS Extraction）**：
  - **`admin-style.css`（3,033 行）**：集中收敛 `:root` 变量、基础 Reset、组件层（Buttons, Modals, Panels, Tables, Badges, Tabs）以及 v2.3.9/v2.3.10 樱花主题与 Beszel 监控多层样式覆盖；
  - **`admin-quotas.js`（1,771 行）**：负责上游凭证配额（Antigravity、Codex、WorkBuddy 等全上游卡片与紧凑视图渲染）、配额多维度检索过滤、Google 验证专区、OpenRouter 原生账号管理与优先级/停用管理；
  - **`admin-keys.js`（517 行）**：负责 API Key 完整生命周期管理（CRUD、脱敏轮换、别名修改、模型权限规则编辑与 SWR 缓存）以及模型定价规则管理；
  - **`admin-stats.js`（706 行）**：负责 Uptime Kuma 风格服务心跳卡汇总、免密探针状态监控、核心大卡统计与多维度用量趋势图表（SVG 渲染与交互）；
  - **`admin-logs.js`（688 行）**：负责请求流水真分页拉取、服务商反查与权威同口径推断、多维筛选联动以及错误与熔断中心审计。
- **静态路由缓存与零开销分发（Static Routing with ETag & 304 Cache）**：
  - 在 [lib/routes/static-routes.mjs](lib/routes/static-routes.mjs) 中登记 `/admin/quotas.js`、`/admin/keys.js`、`/admin/stats.js`、`/admin/logs.js`、`/admin/style.css` 及其兼容别名路由；
  - 接入内存级 Stat 缓存与 MD5 ETag 协商机制，实现 304 秒级响应与 Gzip 压缩分发；单 404 捕获杜绝 `ERR_HTTP_HEADERS_SENT` 崩溃风险。
- **自动化测试契约锁死与严密门禁（AST Validation & Regression Locks）**：
  - 在 [tests/test_gate_features.mjs](tests/test_gate_features.mjs) 与 [tests/test_workbuddy_quota_and_table.mjs](tests/test_workbuddy_quota_and_table.mjs) 中将所有拆分的外置脚本纳入 `vm.Script` 语法检查门禁，并在客户端脚本聚合上严格保障探针契约、占位同步、WorkBuddy 渲染与 Key 表格排版整洁化；
  - 在 [tests/test_cpa_management.mjs](tests/test_cpa_management.mjs) 中完善静态资源 HTTP 200 与缺失 404 单次捕获断言；
  - 全套 `npm test`（26 项核心测试与子套件）全部 100% 绿灯通过。

## [v2.9.39] - 2026-10-16

修复 Google Antigravity 配额因客户端版本门槛导致 Gemini 模型组缺失问题，并引入官方多端点容灾轮询（Fix Google Antigravity Missing Gemini Quota via Client UA Threshold & Multi-Endpoint Fallback）：

- **Google Antigravity 客户端版本门槛升级与 UA 对齐（Client Version Threshold & UA Alignment）**：
  - **核心痛点解决**：近期 Google 上游对 `retrieveUserQuotaSummary` 接口增加了客户端版本判定，要求客户端版本必须达到 `>= 1.2.0`。使用老旧的 `1.0.13` 时，Google 服务端会自动降级响应，只下发 `Claude and GPT models` 组，导致管理后台凭据卡片中的 `Gemini Models`（含 Flash / Pro 5小时与周限额）凭空消失；
  - **对齐官方 CLI 1.3.6 UA**：在 [lib/upstream/sync.mjs](lib/upstream/sync.mjs) 中统一定义并导出 `ANTIGRAVITY_USER_AGENT = 'antigravity/cli/1.3.6 (aidev_client; os_type=darwin; arch=arm64)'`，全面替代全项目遗留的 `1.0.13` 硬编码；同时同步更新 [static/management.html](static/management.html) 中静态打包的客户端版本。
- **多端点容灾轮询与完整性保障（Multi-Endpoint Fallback & Integrity Guard）**：
  - **端点列表**：配置 `ANTIGRAVITY_QUOTA_URLS`，依次尝试 `daily-cloudcode-pa.googleapis.com`、`cloudcode-pa.googleapis.com`（官方 PR #496 推荐稳定端点）与 `daily-cloudcode-pa.sandbox.googleapis.com` 沙箱端点；
  - **健壮轮询函数 `requestAntigravityQuotaSummary`**：在周期同步 `syncUpstreamQuotas` 与就地单点刷新 `activateUpstreamQuotaWindow` 中接入多端点容灾机制，若返回结果中未包含 Gemini 模型组则自动顺延请求下一端点，保证凭据配额完整性。
- **自动化测试闭环（Integration Test & Verification）**：
  - 新增独立测试文件 [tests/test_antigravity_quota_multi_endpoint.mjs](tests/test_antigravity_quota_multi_endpoint.mjs)，覆盖客户端 UA 版本门槛（`>= 1.2.0`）、容灾端点列表完整性以及 `parseAntigravityGroups` 双模型组解析与百分比换算；
  - 接入 `package.json` 测试流水线，全量 `npm test` 全部 100% 绿灯通过。

## [v2.9.38] - 2026-10-15

重构美化 API 密钥管理表格排版并实现 WorkBuddy 剩余积分与官方资源包实时高亮呈现（Refactor API Keys Table Alignment & Add WorkBuddy Credits Display to Upstream Cards）：

- **API 密钥表格排版整洁化与视觉对齐（API Keys Table Aozora UI 60 FPS Refactoring）**：
  - **核心痛点解决**：此前“模型权限”列中纯文本 `全部 (*)` 与带边框的 `允许 N 个模型` 胶囊混排，导致表格横向扫描重心不一；同时有硬顶限制的行塞有进度条，无限制的行则没有，导致表格行高忽高忽矮（48px~72px 错落跳动），严重影响整洁度与阅读体验；
  - **规整胶囊设计**：统一采用带微圆点的圆角微胶囊 `.model-perm-badge`：无限制时渲染青空蓝微胶囊 `<span class="model-perm-badge all"><span class="perm-dot all"></span>全部模型 (*)</span>`，限制模型时渲染紫罗兰微胶囊 `<span class="model-perm-badge limited"><span class="perm-dot limited"></span>允许 N 个模型</span>`，具备统一步长与基线对齐；
  - **用量单元格高度锁死与结构化布局**：引入 `.key-usage-cell` 复合微容器，第一行固定展示高亮今日 Tokens 与请求次数，第二行展示累计用量与限额百分比标签，底部统一预留 4px 进度条槽位（未设置限额时渲染极其清透的 `.usage-progress-bar.unlimited` 占位槽），确保所有表格行高严格水平对齐，彻底消除纵向高低跳动；
  - **缓存命中与空值统一**：0% 缓存命中率统一采用微胶囊 `.chip-cache.zero`，未设每日额度与 RPM 时统一采用 `<span class="cell-unlimited">不限</span>`，表格整体规整、通透、层次分明。
- **腾讯 WorkBuddy / CodeBuddy 剩余积分与额度呈现（WorkBuddy Credits & Packages Quota Rendering）**：
  - **紧凑视图（Compact Mode）**：在紧凑账号列表中，对 `workbuddy` 与 `workbuddy-cn` 账号直接渲染专属进度条与积分指标：第一行以大号 mono 高亮展示 `剩余 ${remainCredits} 积分`，第二行展示彩色比例进度条，底部附带总额（如 `总额: 800 积分`）与已消耗数，一眼即知剩余可用额度；
  - **网格大卡片视图（Grid Cards Mode）**：在卡片模式中，增加专属“WorkBuddy 资源包与积分额度”区块，呈现当前可用积分、总容量、已用积分与周期资源包进度条；
  - **数据层与就地刷新闭环**：结合 [lib/upstream/sync.mjs](lib/upstream/sync.mjs) 中的腾讯官方计费端点，用户点击卡片上的“刷新额度”即可直接调用官方计量 API 就地拉取最新积分并实时刷新视图；支持兼容直接嵌套在 `data.Packages` 结构与 `PackageCode` 字段的腾讯真实计费响应。
- **架构与接口文档系统化整理（Integration Specification & Documentation）**：
  - 新增专项技术文档 [docs/workbuddy-integration.md](docs/workbuddy-integration.md)，详细收录腾讯 WorkBuddy / CodeBuddy 官方计量端点 URL、必须携带的 Headers、真实响应嵌套结构、Gate 侧内存防抖与就地缓存刷新机制以及 Aozora UI 双视图展现标准；
  - 在 [docs/cpa-upstream.md](docs/cpa-upstream.md) 与 [README.md](README.md) 中建立系统化文档索引，明确 Gate 与 CPA 的自治边界。
- **自动化测试闭环（Integration Test & Verification）**：
  - 新增独立测试文件 [tests/test_workbuddy_quota_and_table.mjs](tests/test_workbuddy_quota_and_table.mjs)，端到端覆盖 `parseWorkBuddyGroups` 资源包解析计算、`admin.html` 内联语法与 WorkBuddy 渲染契约、API 密钥表格胶囊与高度一致性占位契约；
  - 挂载至 `package.json` 测试流水线，全量 `npm test` 26 大项与子测试全部 100% 绿灯通过。

## [v2.9.37] - 2026-10-15

实时请求流水新增上游服务商维度筛选与全链路打通（Add Upstream Provider Filter to Activity Logs & End-to-End Pipeline Alignment）：

- **服务端过滤与统一口径对齐（Server-Side SQLite Extension & Zero Drift Inference）**：
  - **核心痛点解决**：过去在管理后台与成员中心的“请求流水”面板中，仅支持按密钥、时间跨度、错误类型及文本模糊搜索，无法按具体的 AI 服务商（如 OpenAI Codex、Claude、Gemini、StepFun、OpenCode、WorkBuddy 等）快速聚焦定位；
  - **Better-SQLite3 运行时原生扩展**：在 [lib/analytics/audit-logs.mjs](lib/analytics/audit-logs.mjs) 中通过 `quotaDb.function('resolve_event_provider', ...)` 原生注册 JavaScript 提供商推断函数，使得 SQL 层的 `WHERE resolve_event_provider(auth_index, model) = ?` 筛选口径与列表展示层的 `resolveEventAuthInfo` 实现 100% 绝对一致，杜绝了重新编写 SQL 正则导致的分类漂移与抢断顺序错乱；
  - **覆盖索引与多级缓存防抖**：分页查询继续保持延迟关联（Deferred Join）极致性能；同时将 `provider` 精准纳入 `pagedRequestsCache` 的缓存键计算，确保切换服务商时缓存严格隔离并支持即时更新；
  - **REST API 双重视图全覆盖**：在 [lib/routes/admin-routes.mjs](lib/routes/admin-routes.mjs) 与 [lib/routes/member-routes.mjs](lib/routes/member-routes.mjs) 的 `/admin/api/requests` 与 `/api/member/requests` 中同步解析并透传 `provider` 参数，实现管理员端全局查看与成员端个人视角的一致可用。
- **前端 Aozora UI 交互与下拉组件整合（Aozora UI Modern Dropdown & Interactive Pills）**：
  - **专属控制栏筛选器**：在 [admin.html](admin.html) 的流水控制条中，于密钥筛选器旁新增 `#logs-provider-filter-container` 与 `#logs-provider-dropdown` 轻量定制下拉组件；
  - **内置主流与动态上游选项聚合**：下拉框默认预设所有官方认证的主流服务商，并结合已同步的活跃凭据账号与当前流水动态补充未见服务商，选项完整且不产生布局重绘；
  - **一键胶囊快捷聚焦**：流水表格中各行的提供商 Pill 胶囊绑定点击筛选事件，支持用户在滚动日志时一键点击快速只看该服务商的全部流水；
  - **热加载与无损体验**：筛选切换时维持防抖与平滑加载，不破坏滚动条与页面选区。
- **自动化测试闭环（Integration Test & Verification）**：
  - 在 [tests/test_gate_features.mjs](tests/test_gate_features.mjs) 中新增“测试 26”，端到端模拟插入多提供商流水，严格校验单服务商精确匹配、多服务商排除、全部模式兼容性、多级缓存键隔离，以及路由透传与前端 DOM 契约；
  - 全套 `npm test`（26 项功能测试、语法校验、多级缓存与水合测试等）全绿通过。

## [v2.9.36] - 2026-10-15

优化提供商注册表空壳平滑升级机制并补齐前端推断覆盖（Optimize Provider Registry CPA Skeleton Upgrade & Frontend Fallback Matching）：

- **注册表增量平滑升级（Provider Registry Incremental Upgrade）**：
  - **核心痛点解决**：在早期从 CPA 同步过占位记录的数据库中，`provider_registry` 表内部分内置提供商可能仅以 `source: 'cpa'` 且 `model_patterns` / `auth_patterns` 均为空数组的形式作为空壳占位存在；
  - **智能识别与升级**：重构 [lib/core/provider-registry.mjs](lib/core/provider-registry.mjs) 中的 `initProviderRegistry()`，在启动增量补种阶段不仅比对缺失键，还自动检测并识别仅包含空 pattern 的 CPA 空壳记录，安全且幂等地将其平滑升级为官方权威内置规则（恢复权威 label、完整 patterns 及内置优先级），同时严格保留用户手动录入的 `manual` 规则或已有自定义 pattern 的配置。
- **前端回落推断口径严格对齐（Frontend Offline Inference Alignment）**：
  - 同步更新 [admin.html](admin.html) 中的 `resolveEventProvider(ev)` 离线兜底推断逻辑，补齐 `copilot.tencent` 匹配特征，确保在离线回落状态下 WorkBuddy 模型的流量归属与后端注册表完全对齐。
- **测试与回归验证（Test & Verification）**：
  - 在 [tests/test_gate_features.mjs](tests/test_gate_features.mjs) 测试 25 中扩展断言：覆盖前端 `copilot.tencent` 规则校验，以及模拟历史数据库 CPA 空壳记录在系统启动时的增量自动升级与权威字段恢复校验；
  - 全量 `npm test`（25 项功能测试、AST 语法验证、缓存水合测试等）全绿通过。

## [v2.9.35] - 2026-10-15

重构凭证统计主视图：剥离已删除留痕账号至底部折叠归档面板，彻底释放主监控工作区（Prune Deleted Historical Accounts to Bottom Collapsible Archive & Free Up Upstream Stats Workspace）：

- **视觉层级与数据流清晰分离（Clear Visual Hierarchy & Data Stream Separation）**：
  - **核心痛点解决**：针对在 CPA 中已被移除、但在 Gate 数据库仍保留历史审计流水的账号（`已删除账号 <前8位>`），过去作为同尺寸大卡片直接混排在主卡片网格中，大面积霸占首屏与工作区空间；
  - **双通道数据流渲染**：在 `lib/analytics/status-summary.mjs` 中显式赋予 `is_deleted` 字段；在前端 `admin.html` 的 `renderUpstreamStatsTable()` 中将凭证精准拆分为活跃列表 (`activeItems`) 与已删除留痕列表 (`deletedItems`)；
  - **主卡片网格专注有效资产**：主 CSS Grid 网格现在仅渲染正常运行的活跃上游凭证卡片，彻底排除无效干扰，信噪比大幅提高。
- **Aozora UI 弱化次级收纳归档区（Aozora UI Subdued Collapsible Archive）**：
  - 在卡片网格下方提供轻量半透明虚线框折叠组件（`<details class="deleted-accounts-archive">`），默认处于收起状态；
  - **收起时极度克制**：仅呈现一条约 38px 高、低饱和度的折叠摘要条（`已删除账号历史留痕 (N 个账号) · 已从 CPA 移除，仅保留 Gate 审计流水与历史 Token`），完全不抢占视线；
  - **展开时紧凑结构化**：采用轻量紧凑表格（`.deleted-accounts-table`），单行展示账号 ID、提供商 Pill、请求总数（成/败）、成功率、Token 消耗细分、分时水位（5h/24h/累计）及最后调用模型，5~10 个留痕凭据仅需一小段纵向空间即可纵览全局；
  - **交互体验保持连贯**：搜索过滤或刷新时自动保留展开/收起状态，无留痕账号时自动隐藏。
- **测试与验证（Test & Verification）**：
  - `tests/test_openrouter_quota.mjs` 网络隔离与独立探针 Mock 完善；
  - 全量 `npm test`（25 项功能测试、AST 语法验证、缓存水合测试等）与 `npm run test:management:ui`（Playwright 响应式测试）通过。

## [v2.9.34] - 2026-10-15

彻底剥离内嵌 CPA 日志与配置，并重构「凭证统计」为 Aozora UI 账号卡片看板（Prune Embedded CPA Pages & Overhaul Upstream Stats with Account Cards Grid）：

- **彻底剥离所有内嵌 CPA 页面（Complete Separation of CPA Pages）**：
  - **核心边界锁定**：继上一轮剥离「账号接入」和「提供商」后，本版本彻底移除侧边栏与工作台中遗留的 `>_ CPA 日志` (`tab-btn-cpa-logs`) 和 `!! CPA 配置` (`tab-btn-cpa-config`)；
  - Gate 工作台全面聚焦于流量统计、智能调度、状态监控、流水审计与故障中心，CPA 原生设置与底层日志统一通过左下角「原生面板 ↗」安全直达；
  - 侧边栏按钮精简为 9 个核心原生工作区，并在「故障中心」与「API 密钥」之间增设视觉分割线，形成清晰的 3 段式功能层级。
- **凭证统计重构为账号卡片网格（Upstream Stats Overhaul: Account Cards Grid）**：
  - 彻底淘汰原有的宽表格 (`<table>`) 展现形式，解决横向滚动不便与信息扁平的问题；
  - 采用现代 CSS Grid 响应式卡片流（`upstream-stats-cards-grid`），在桌面端与移动端自适应展现；
  - **高信息密度卡片设计**：
    - **卡片头部**：提供商图标 Badge + 提供商 Pill（Antigravity、Codex、WorkBuddy 等）+ 账号名称（加粗、溢出保护、全名悬停）+ 停用/历史留痕标签 + 凭据短 ID + 优先级徽章（P10/P20）；
    - **成功率大徽章**：红/橙/绿优雅半透明微边框徽章，清晰展示 CPA 运行时成功率；
    - **周期配额模块**：展示 5h 剩余水位百分比进度条与满额/重置倒计时，以及周限额进度；
    - **核心指标 3 格**：总请求数（成功/失败分布及 CPA 来源标识）、本地 Token 消耗（入/出细分）、缓存命中率（缓存 Token 细分）；
    - **分时段 Token 水位带**：以蓝/紫/灰三色点清晰标示 5h、24h 及全部历史累计 Token；
    - **底栏最近活跃模型**：Mono 字体浅灰胶囊展示该凭据最近处理的模型名称。
  - **即时搜索过滤**：顶部新增轻量搜索输入框，支持按账号名、提供商、模型名及凭据 ID 毫秒级即时过滤卡片。
- **OpenRouter 凭证数据完全独立自治与管理面板（OpenRouter Full Autonomy & Local Management）**：
  - **解耦外部依赖与本地持久化**：数据存储路径全面切换为 Gate 本地权威文件 `./data/openrouter-accounts.json`（已加入 `.gitignore` 严密防护）；
  - **平滑自动迁移**：启动或读取时若检测到本地缺失，自动从旧 `openrouter-monitor` 账号库安全拷贝迁移，迁移后 Gate 100% 独立运行，可随时彻底下线或删除外部监控项目；
  - **原生 CRUD 增删改查 API**：在 [lib/routes/admin-routes.mjs](lib/routes/admin-routes.mjs) 中挂载 `/admin/api/openrouter/accounts` 系列端点，支持安全脱敏列出、录入、修改与删除 OpenRouter 账号；
  - **原生 WebUI 管理弹窗**：在 [admin.html](admin.html) 中增加“⚙️ 管理账号”弹窗，直接配置账号名称、备注、API Key 与用于统计今日调用次数的 Management Key；
  - **配额纯计数直出**：列表与卡片视图统一采用大字体直接呈现今日模型调用次数，去除之前假设的 800 次每日上限与剩余计算，更契合实际。
- **全量测试与回归验证（Verification & Regression Suite）**：
  - [tests/test_cpa_ui.py](tests/test_cpa_ui.py)：更新 Playwright 端到端测试，验证侧边栏 9 个核心 Tab、卡片网格渲染及搜索过滤；
  - 全量 `npm test` 与 `npm run test:management:ui` 自动化测试套件通过。

## [v2.9.33] - 2026-10-15

明确 CPA 与 Gate 架构职责边界，彻底剥离 Gate 控制台中的“账号接入”与“提供商”模块（Architectural Boundary Clarification: Pruned Account Access & AI Providers Modules）：

- **架构职责边界回归（Architecture Boundary Realignment）**：
  - **核心设计意图**：Gate 的核心定位专注于可观测性、流量调度、状态监控、凭据用量与额度探针、请求流水审计以及故障追踪；账号授权（OAuth、JSON 文件上传、Vertex 导入）与 AI 提供商（模型发现、通道配置）属于 CPA 的原生管辖范围；
  - 移除了 Gate 前台中冗余重复的“账号接入” (`cpa-auth`) 与“提供商” (`cpa-providers`) 侧边栏导航与工作区，如需配置账号授权或提供商规则，维护者可随时点击顶部“原生面板 ↗”进入 CPA 管理后台；
  - 侧边栏导航重新梳理，在 `tab-btn-validations`（Google 验证）后补齐分段线，保持 4 大功能分区的视觉节奏。
- **前端与样式瘦身（UI & Code Cleanup）**：
  - [admin-cpa.js](admin-cpa.js)：移除 `cpa-auth` 与 `cpa-providers` 的导航注册、DOM 模板注入与大量过期事件绑定及请求函数，纯净保留 `cpa-config`（CPA 配置）与 `cpa-logs`（CPA 日志）；
  - [admin-cpa.css](admin-cpa.css)：清理超过 700 行已废弃的号池与提供商 CSS 选择器；
  - [admin.html](admin.html)：更新成员模式 (`member-mode`) 导航白名单校验。
- **全量测试与回归加固（Verification & Regression Suite）**：
  - [tests/test_gate_features.mjs](tests/test_gate_features.mjs)：加入回归断言，锁定 `admin.html` 与 `admin-cpa.js` 不再包含 `cpa-auth` 与 `cpa-providers`；
  - [tests/test_cpa_ui.py](tests/test_cpa_ui.py)：更新端到端 UI 侧边栏预期列表与断言；
  - 全量 `npm test` 测试套件运行通过。

## [v2.9.32] - 2026-10-15

补齐 OpenRouter 独立提供商配额集成测试套件并纳入 CI/npm test 闭环（OpenRouter Quota Integration Test Suite）：

- **测试自动化（Automated Testing）**：
  - 新增全链路集成测试 [tests/test_openrouter_quota.mjs](tests/test_openrouter_quota.mjs)；
  - 覆盖 OpenRouter 免费层 800 次每日限额计算、UTC 00:00 重置倒计时、凭据归一化与调用次数解析、独立凭证探针查询与 `activateUpstreamQuotaWindow` 原地激活兼容性；
  - 在 [package.json](package.json) 中将该测试纳入 `npm test` 必过流水线。

## [v2.9.31] - 2026-10-15

集成 OpenRouter 独立提供商配额管理与今日用量实时探测（OpenRouter Free Tier Daily Quota & In-Place Probe）：

- **功能落地与业务契约（Features & Implementation）**：
  - **OpenRouter 凭证数据接入（[lib/upstream/openrouter.mjs](lib/upstream/openrouter.mjs)）**：自适应读取 `openrouter-monitor` 账号配置，对接 OpenRouter 官方 Analytics Query API 自动汇总每日模型请求数（800次/日免费额度），并自动计算距离 UTC 00:00 的精准重置倒计时；
  - **凭据同步与配额热感知（[lib/upstream/sync.mjs](lib/upstream/sync.mjs) & [lib/upstream/provider-quota.mjs](lib/upstream/provider-quota.mjs)）**：统一融入 Gate 上游凭证大盘与独立额度查询，支持凭据卡片一键唤醒与就地原地刷新；
  - **前台 UI 与筛选交互（[admin.html](admin.html) & [admin-cpa.js](admin-cpa.js)）**：新增 OpenRouter 专属过滤标签与批量查询能力，采用双指标胶囊清晰展示“今日已调用”与“今日剩余可用”纯数字指标，超出警告阈值自动染色。
- **全量测试（Verification）**：自动化测试套件通过。

## [v2.9.30] - 2026-10-15

全面补齐上下行 HTTP 压缩（Gzip/Deflate/Brotli）解压感知与 WebSocket 全双工穿透代理（HTTP Compression Decompression & WebSocket Full-Duplex Proxying）：

- **背景与痛点治理（Background & Industry Alignment）**：
  - 针对社区反馈“网关与客户端上下行不采用 HTTP 压缩导致跨海跨区流量浪费严重”、“缺少 WebSocket 升级支持导致增量 WS 协议与 Realtime 模式失效”等关键架构缺陷进行全面自查与治理；
  - 彻底拔除 Gate 架构中“上行请求体不支持压缩”、“下行压缩响应破坏 Token 审计”以及“完全不支持 WebSocket 升级”三大硬伤。
- **架构重构与核心能力落地（Architecture & Implementation）**：
  - **上行请求体自适应解压（Request Body Decompression）**：
    - 在 [lib/config.mjs](lib/config.mjs) 中封装 `decompressBody`，支持 `gzip`、`deflate` 与 `br` (Brotli) 算法；
    - 在 `readBody` 中感知客户端 `Content-Encoding` 请求头并完成透明解压，支持现代客户端/SDK 发送压缩 Payload 节省上行网络带宽；
    - 转发给上游时安全剔除 `content-encoding` 并重新计算 `content-length`，彻底消除上游 CPA 不支持上行解压导致的兼容性隐患。
  - **下行响应压缩保留与内存感知审计（Downstream Decompression for Audit）**：
    - 在 [lib/proxy/transport.mjs](lib/proxy/transport.mjs) 中优化非流式与错误响应处理流程；
    - 当上游返回经过压缩的响应时，向客户端原样保留并透传 `Content-Encoding: gzip/deflate/br`，极致节约出站下行带宽；
    - 网关在后台通过 `decompressBody` 解压内存副本进行 `JSON.parse`，精准提取 `usage` 与 `finish_reason`，彻底解决因压缩二进制流导致的 Token 审计失真问题。
  - **WebSocket (WS/WSS) 升级代理与全双工穿透（`lib/proxy/websocket-proxy.mjs`）**：
    - 在 [server.mjs](server.mjs) 中挂载原生 `upgrade` 协议升级事件监听器；
    - **前置安全防御与配额守卫**：全方位支持 Header Bearer、URL Query（`token`/`api_key`/`key`）、`Sec-WebSocket-Protocol` 及 Cookie 多源凭据提取，在升级握手前严格执行 Key 鉴权、RPM 限速、日配额与熔断器可用性检查，非法/未认证长连接请求一律在握手层安全拦截；
    - **双向全双工管道**：上游响应 `101 Switching Protocols` 后，建立零缓冲 Socket 直通管道，无缝穿透标准 WebSocket、增量 WebSocket（如 Codex 增量代码流、ZCode 增量协议）以及 OpenAI Realtime 双向会话；
    - **审计闭环**：成功升级的 WebSocket 会话纳入 Gate 审计流水（`status: 101`，`stream: true`）。
- **测试验证（Verification & Benchmark）**：
  - 新增全链路集成测试 [tests/test_compression_websocket.mjs](tests/test_compression_websocket.mjs)，端到端覆盖 Gzip/Deflate/Brotli 解压、客户端上行压缩传输、WebSocket 401 拦截与 101 双向回声测试、下行 Gzip 压缩透传与审计；
  - 运行 `npm test`，全套 26 项集成测试 100% 通过（`PASS`）。

## [v2.9.29] - 2026-10-15

移动端加载极限性能优化：静态资产 WebP 适配、服务端 Gzip 动态压缩与 ETag 304 协商缓存落地（Mobile Performance & Static Caching Architecture）：

- **背景与根因排查（Background & Diagnosis）**：
  - 用户反馈手机浏览器访问 Gate 控制台（`/admin`）加载极其迟缓，甚至出现数十秒卡顿；
  - 链路全生命周期排查确认后端 SQLite 查询耗时极低（单次 `LIMIT 3000` 流水在 5ms 内），真正瓶颈在于跨海移动网络下的巨大静态传输负载与严苛缓存策略：
    1. **静态大图传输庞大**：原桌面横幅 `sakura-gate-v2.png` 达 2.02 MB，高分率 Logo `gate-sakura-mark-v2.png` 达 366 KB，移动端无差别下载全尺寸资源；
    2. **服务端未开启传输压缩**：`admin.html` 单文件达 612 KB、上游兜底 `management.html` 达 3.35 MB，均以原始文本明文传输；
    3. **静态路由强开 `no-store`**：此前路由层为防旧缓存残留强制设置 `no-store`，导致移动端浏览器每次刷新或前后台切换均强制重新拉取 3.0 MB+ 原始数据。
- **架构重构与性能工程（Architecture & Performance Engineering）**：
  - **静态素材 WebP 转换与移动端媒体查询断点（`gate-assets/` & `admin.html`）**：
    - 桌面端横幅重构为 WebP 格式（`sakura-gate-v2.webp`），体积从 2,025 KB 降至 127 KB（**体积缩减 93.7%**）；
    - 针对移动端屏幕尺寸（`@media (max-width: 640px)`）专门裁切并生成轻量级移动端横幅（`sakura-gate-mobile.webp`），体积仅 47 KB（**体积缩减 97.7%**）；
    - 品牌 Logo 转换为 128px Retina WebP（`gate-sakura-mark-128.webp`），体积从 366 KB 降至 4.5 KB（**缩减 98.8%**），并提供 8.7 KB 的 PNG 兜底。
  - **服务端多级内存缓存与 ETag 304 零负载协商（`lib/routes/static-routes.mjs`）**：
    - 设计 `sendFileWithCache` 工具函数，以 `filePath`、`mtimeMs` 与 `size` 为索引构建服务端内存缓存池（`staticCache`），彻底消除每次 HTTP 请求重复读取磁盘与重复压缩计算的 CPU/IO 开销；
    - 自动计算 16 位 MD5 ETag 并响应客户端 `If-None-Match`，匹配时直接秒级返回 `304 Not Modified`（网络有效传输负载为 0 字节）；
    - 精准解耦缓存控制策略：图片类资产赋予 `public, max-age=604800, immutable`（强缓存 7 天无需回源），HTML、JS 与 CSS 等动态页面赋予 `no-cache` + ETag（强制协商验证，既规避旧缓存 bug，又享受秒开 304）。
  - **动态 Gzip / Deflate 预压缩（`lib/routes/static-routes.mjs` & `lib/routes/upstream-proxy.mjs`）**：
    - 静态路由根据客户端 `Accept-Encoding` 头自适应下发 Gzip 或 Deflate 压缩流，`admin.html` 传输体积从 612 KB 降至 ~150 KB；
    - 上游兜底控制台 `management.html` 同样支持预压缩，传输体积从 3.35 MB 降至 ~750 KB。
- **效果验证（Verification & Benchmark）**：
  - 手机移动端首次访问总传输体积从 **~3.0 MB 降至 ~206 KB，降幅达 93.1%**；
  - 手机端二次访问与前后台切换命中 ETag 304 与浏览器本地强缓存，传输负载 **降低 100%**，真正实现移动端秒开；
  - 自动化回归套件 `npm test` 25 项全链路测试与 `test_cpa_management.mjs` 100% 通过。

## [v2.9.28] - 2026-10-14

AOCI 认知边界治理与 Git 零污染规范化落地（AOCI Zero-Footprint & Clean Repository Governance）：

- **背景与合规治理（Governance & Isolation）**：
  - 严格遵循 `aoci-setup` 工程规范，确立“AOCI 本地认知加速，对外绝对零污染”核心红线；
  - 梳理并健全 `.gitignore` 中针对 AOCI 本地认知资产（`aoci.*`、`.aoci/`、`.mcp.json`、备份文件）与本地 Agent 垫片/临时态（`AGENT.md`、`agent.md`、`*.local.md`、`.claude/worktrees/`）的完整忽略规则；
  - 历史污染无损清洗：执行 `git rm --cached` 将历史误追踪的 AOCI 全量资产（`.aoci/.gitignore`、`.aoci/baseline.json`、`.aoci/config.json`、`aoci.code.txt`、`aoci.meta.txt`、`aoci.txt`）及 Agent 跳转垫片（`AGENT.md`）从 Git 索引彻底移除，确保远端开源零泄密、本地文件完好无损。
- **AOCI 本地认知终态对齐（AOCI Alignment & Proof）**：
  - 维护并更新 AOCI 索引，解绑孤儿 `AGENT.md` 并刷新 `.gitignore` 条目；
  - 执行 `aoci verify --json`、`aoci check --json` 及 `aoci index agent guide --agent claude --json`，三项权威质检 100% 证明治理完全对齐（`governance_aligned: true`，`complete: true`，`next_action: "none"`）。

## [v2.9.27] - 2026-10-14

前端 UI 去低幼化重构：全面肃清原生 Emoji 并升级 Aozora UI 细线条单色矢量图标（Anti-Emoji Policy & Monochrome Vector SVG Refactor）：

- **背景与痛点（Background & Problem）**：
  - 用户反馈 CPA 提供商配置面板中存在的原生系统 Emoji（`⚡`、`🔑`、`🤖`、`🏷️`、`🌐`、`⚙️` 等）“太幼稚了”，在跨平台（Windows Segoe UI / macOS Apple Color）中呈现杂乱高饱和色块，严重破坏生产级管理控制台的专业度与严肃科技感；
  - 确立长期前端设计红线并在 `skill: ui-design` 中沉淀经验偏好（严禁原生 Emoji，拥抱极简细线条单色 SVG 与 Typography First）。
- **重构与实现（Refactor & Implementation）**：
  - **单色矢量图标字典（`admin-cpa.js`）**：
    - 引入基于 Lucide 风格的微型单色 SVG 字典 `CPA_ICONS`（含 `server`、`key`、`model`、`tag`、`globe`、`settings`、`ban`、`warn`、`eye`、`eyeOff`、`copy`）；
    - 全面剔除提供商卡片标题、指标胶囊（Pill）、高危配置折叠栏、明密文切换按钮与复制工具中的全部原生 Emoji；
    - 密文显隐切换逻辑（`toggle-key-visibility`）重构为无缝切换 `CPA_ICONS.eye` 与 `CPA_ICONS.eyeOff` 单色矢量 SVG。
  - **Aozora UI 细边框与基线对齐样式（`admin-cpa.css`）**：
    - 封装 `.cpa-svg-icon` 基础样式，光学居中绑定 `currentColor` 与垂直基线对齐；
    - 对 `.cpa-provider-icon`、`.cpa-keys-icon`、`.cpa-metric-pill`、`.cpa-btn-tool`、`.cpa-danger-icon` 精确定义微型图标尺寸与悬停微沉态，维持 60 FPS 无重绘渲染。
- **验证（Verification）**：
  - 本地自动化测试套件 `npm test` 25 项全链路测试 100% 通过；
  - 经 Node 正则扫描，`admin-cpa.js` 原生系统 Emoji 遗留数为 0。

## [v2.9.26] - 2026-10-14

对齐上游 CPA 路由调度（Smart/Pace）、管理套件与最新控制面板（Upstream CPA Smart & Pace Routing, WorkBuddy Suite & CPAMC Sync）：

- **背景与目标（Background & Alignment）**：
  - 上游 CLIProxyAPI (CPA) 近期发布重要更新（v8.0.27 及后续补丁）：
    1. **新增 Smart 与 Pace 配额感知路由策略**：支持临期优先（`smart`，按额度重置周期就近消耗避免作废）与步调均衡（`pace`，按每小时可用剩余额度平滑分摊）；
    2. **集成 WorkBuddy 统一管理套件**：支持每日自动签到（国际/国内双端）、多端授权与额度流水；
    3. **修复 CPAMC 管理面板语法与请求路径**：修复多处 JSX 嵌套语法导致的控制台白屏问题，更正 Axios BaseURL 下的 checkin 相对路径；
  - Gate 作为上游 CPA 的核心流量网关与安全中枢，需全面对齐上述策略与功能，消除策略回退降级隐患并同步最新管理面板。

- **架构与实现（Architecture & Implementation）**：
  - **路由调度支持 Smart 与 Pace 策略及别名归一化（`lib/upstream/routing.mjs`）**：
    - `ROUTING_STRATEGIES` 扩展为 5 种算法：轮询（`round-robin`）、加权轮询（`weighted-round-robin`）、填充优先（`fill-first`）、临期优先（`smart`）与步调均衡（`pace`）；
    - 实现 `normalizeRoutingStrategy` 策略归一化函数，对齐 CPA 后端与 CPAMC 解析契约，透明兼容 `smart-routing`、`pace-routing`、`roundrobin`、`wrr`、`ff` 等别名；
    - 在 `readRoutingConfig` 与 `validateRoutingPatch` 中支持新策略的完整校验与热改写，杜绝因未识别新策略而降级回退至 `round-robin`。
  - **前端路由下拉组件与说明文案全面对齐（`admin-cpa.js` & `admin-overview.js`）**：
    - 在「CPA 凭据/配置」面板的 `#cpa-routing-strategy` 下拉框中新增「临期优先 (Smart Quota)」与「步调均衡 (Pace Quota)」两项原生选项；
    - 在「运行总览」运行时一览卡片（`admin-overview.js`）中同步更新 `ROUTING_STRATEGIES`，支持无缝展示、编辑与防抖落库；
    - 补充表单说明文案，清晰指导算力调度选型。
  - **同步官方最新 CPAMC 原生控制台单文件产物（`static/management.html`）**：
    - 将 CPA 项目最新编译修复的 `static/management.html`（3.34MB，含 WorkBuddySuite、Smart/Pace 视觉控件与语法修复）全量同步至 Gate 本地兜底目录；
    - 配合 Gate 现有的 `/admin/upstream/` 透明反向代理与脚本劫持注入机制，杜绝生产机因白屏或路径错误导致的无法访问。
  - **请求流水异常类型汉化补齐（`admin.html`）**：
    - 在 `errorTypeLabel(t)` 映射表中补充对 `stream_loop_detected`（思考死循环熔断）、`payload_too_large`（请求体过大）、`upstream_validation_required`（上游人机验证）等新错误类型的友好中文解析。

- **测试（Tests）**：
  - 本地 `npm test` 全部 25 项全链路集成测试 100% 通过；
  - `tests/test_cpa_management.mjs` 补充 `smart` 与 `pace` 策略的配置改写、别名兼容归一化与快照不变性断言；
  - `tests/test_cpa_ui.py` 浏览器端到端测试扩展验证下拉选项完整性（5 种策略）与实时切换落库，Playwright 测试通过（EXIT=0）。

## [v2.9.25] - 2026-10-14

流水增量物理展开动效与 DOM-Diffing 健壮插入重构（The Cell Expand & Content Drop Architecture for Live Logs）：

- **背景与根因（Background & Root Cause Analysis）**：
  - 用户实测反馈“流水增量要有动画动效，目前没有”；
  - **CSS 规范与浏览器引擎限制**：在 W3C CSS Transforms 规范及 Chromium/WebKit 渲染引擎中，`display: table-row`（`<tr>`）属于不可变换元素（not transformable elements），直接在 `<tr>` 上设置 `transform: translateY(...)` 会被浏览器直接忽略；同时表格行无法直接通过 CSS 在 `<tr>` 上进行 `height` 或 `max-height` 平滑过渡，导致之前的位移动效无法被肉眼感知；
  - **JS 增量判定狭窄边界**：在 `renderEventsTable` 中原逻辑包含 `newEvents.length < pageEvents.length` 的狭窄条件，当新进条数等于当前总条数（如刚测试发了几条新请求时）时被判定为 false，进而走入全表销毁重绘逻辑；同时 `oldFirstId` 纯依赖内存 `cachedEvents[0]?.id`，未与实际展现的 DOM 第一行做交叉验证。

- **架构与实现（Architecture & Implementation）**：
  - **三维复合 60 FPS 表格行展开与微光方案（`admin.html`）**：
    - **物理高度展开（Smooth Height Expansion）**：对新行的所有 `<td>` 应用 `liveRowCellExpand` 关键帧动画（`padding-top: 0; padding-bottom: 0` 过渡到 `12px`），利用 `<td>` 原生支持 padding 动画的特性，温柔、平滑地将原有的第一行及下方所有行向下推移展开，彻底解决 table 无法做高度动画的浏览器限制；
    - **内容硬件加速下落滑入（GPU Accelerated Content Drop）**：每个 `<td>` 内部将单元格内容包裹于 `<div class="live-cell-content">`，利用独立块级盒模型执行 `transform: translateY(-20px) translateZ(0)` 与 `opacity: 0` 到 `0` 与 `1` 的关键帧过渡，阻尼曲线采用 `cubic-bezier(0.16, 1, 0.3, 1)`，耗时 0.52s，完全由 GPU 合成层驱动；
    - **青空蓝微光渐隐（Cyan-Sky Glow Fade-out）**：对新行 `<td>` 应用 `liveRowCellGlow` 关键帧（从 `rgba(56, 189, 248, 0.45)` 在 2.5 秒内缓缓淡出至透明），确保在各类屏幕与主题下呈现极具质感的感知提示；
    - **动画类名自动清理**：插入完成后设置 2.6s 延时定时器自动移除 `live-row-enter` 与 `live-row-highlight` 类名，使表格行恢复干净原生状态。
  - **双重 DOM-Diffing 采样与健壮增量插入判定**：
    - 在 `fetchEventsData` 中双重采样现有 DOM 第一行（`tr[data-id]`）与内存首条 ID，类型安全转换为字符串做跨周期比对，彻底避免因页面刚打开或状态切换导致 `oldFirstId` 丢失；
    - 摒弃原先存在边界缺陷的 `newEvents.length < pageEvents.length`，改为通过 `pageEvents.filter(ev => newlyAddedIds.has(ev.id) && !tbody.querySelector(\`tr[data-id="${ev.id}"]\`))` 精准过滤出尚未在 DOM 中呈现的全新数据行，通过 `insertBefore` 增量 prepend 到顶部，并自动裁撤超出 `logsPageSize` 的尾部老行。

- **测试（Tests）**：
  - 本地 `npm test` 全部 25 项端到端与集成测试 100% 通过；
  - 前端 AST/vm.Script 内联脚本严格编译校验 100% 通过；
  - 多级缓存与前端水合测试 100% 通过。

## [v2.9.24] - 2026-10-13

请求流水增量动效渲染、单一权威全局轮询与现代极简组件去套娃重构（DOM-Diffing Smooth Prepend, Single Polling Loop & Flat Minimalist Controls）：

- **背景与目标（Background）**：
  - 用户反馈请求流水自动更新时全表硬刷新闪烁难受，缺乏平滑流畅的新到请求过渡动效；
  - 顶栏全局轮询定时器与配额页独立局部定时器并存，认知混乱且难以确定生效规则；
  - 筛选栏组件层层嵌套包裹（组件套组件）、内层生硬纯白底块刺眼、控件高度字体与颜色不统一，分段按钮残留不协调的粉色下划线。

- **架构与实现（Architecture & Implementation）**：
  - **DOM-Diffing 流水增量插入与 60 FPS 硬件加速动效（`admin.html`）**：
    - 解耦单行渲染器 `renderEventRowHtml(ev, isNew)` 与表格调度器 `renderEventsTable`；
    - 当第一页检测到新请求流入且表格已存在行时，不再执行全表销毁重绘（`tbody.innerHTML`），改为通过 `insertBefore` 仅向表格顶部精准插入新行；
    - 配合 60 FPS 硬件加速关键帧动效 `@keyframes liveRowSlideDown`（使用 `transform: translateY(-8px) translateZ(0)` 与 `will-change: transform, opacity, background-color`，耗时 0.75s 弹性向下滑入并伴随青空蓝微光渐隐），底部行按 `logsPageSize` 自动修剪，既有 DOM 结构与用户选中完全保持不动，彻底告别硬刷新闪烁；
  - **收口单一权威全局轮询体系与实时状态胶囊**：
    - 彻底废除配额页多余的局部定时器 `upstreamPollingTimer`、冗余下拉实例 `upstream-polling-dropdown` 及其驱动函数，全站统一由顶栏权威全局定时器驱动；
    - 顶栏下拉明确标明全局属性（如 `15 秒实时 (全局推荐)`、`暂停全局轮询`）；
    - 在请求流水与故障事件控制条新增实时同步指示胶囊（`#logs-sync-badge`、`#errors-sync-badge`），配合呼吸动效光点实时显示全局刷新状态（如 `实时同步 · 全局 15s`，暂停时自适应呈现灰度状态）；
  - **扁平去嵌套组件重构与青空现代极简规范**：
    - 全面废除外层卡片嵌套包裹框（`.logs-filter-group`），去除灰色药丸描边，改用现代扁平无框 `.filter-control-item` + `.filter-label`；
    - 搜索框（`.logs-search-input`）、下拉触发器（`.dropdown-trigger`）与分页按钮（`.page-btn`）高度统一对齐为 32px，圆角统一为 8px，背景采用温润半透明质感（`rgba(255, 255, 255, 0.9)`），焦点外圈统一为青空蓝光晕（`box-shadow: 0 0 0 3px rgba(20, 125, 197, 0.14)`），彻底消除突兀生硬的纯白补丁；
    - 全站分段单选按钮（`.segmented-tabs`）重构为现代 iOS/Linear 扁平胶囊风格，半透明底轨（`rgba(226, 232, 240, 0.65)`）+ 悬浮白药丸（`box-shadow: 0 1px 3px rgba(15, 23, 42, 0.08)`），彻底剔除所有粉色底线残留。

- **测试（Tests）**：
  - 本地 `npm test` 全部 25 项端到端与集成测试 100% 通过；
  - 前端 AST/vm.Script 内联脚本严格编译校验 100% 通过；
  - 多级缓存与前端水合测试 100% 通过。

## [v2.9.23] - 2026-10-13

前端页面自动热加载与自适应平滑刷新机制（Zero-Disruption Live Hot Reload & Adaptive Polling）：

- **背景与目标（Background）**：
  - 用户反馈打开管理页面（如"运行总览"、"请求流水"等）停留不动时一直不会自动刷新，必须手动点击或切换其他 Tab 才能更新数据；
  - 深度排查发现：虽然前端具备倒计时圆环与全局轮询函数 `resetPolling()`，但在首屏生命周期中被遗漏调用，导致定时器初值保持为 `null`；同时默认的 60 秒轮询间隔对高频监控场景严重滞后；
  - 实现开箱即用的热加载刷新机制，同时严格保障用户体验，坚决杜绝打断用户操作、闪烁重绘或翻页跳动。

- **架构与实现（Architecture & Implementation）**：
  - **首屏轮询唤醒与偏好记忆（`admin.html`）**：
    - 在页面生命周期尾部显式调用 `resetPolling()`，开箱即刻唤醒倒计时圆环与自动轮询调度器；
    - 引入默认 15 秒（`15000ms`）实时轮询档位，并从 `localStorage`（`gate_admin_polling_interval`）恢复用户偏好设置；
    - 顶部轮询下拉组件升级支持 10秒（极速）、15秒（实时推荐）、30秒（平衡）、60秒（标准）、5分钟与暂停，倒计时 SVG 圆环添加 `0.8s linear` 匀速过渡动效，消除卡顿跳帧。
  - **交互防打扰与挂起保护（`isUserBusyInteracting`）**：
    - 当用户处于下列操作状态时，自动刷新智能静默推迟，绝不粗暴打断：
      1. 屏幕上有任何 Modal 弹窗（修改 Key、配置规则、新建 Key、定价管理等）处于打开状态；
      2. 键盘焦点正位于文本输入框且正在打字；
      3. 在请求流水页翻到历史分页（`logsPage > 1`），避免跳页破坏视线；
      4. 运行总览吞吐图 Tooltip 正在悬停查看时，推迟图表 SVG 重建；
      5. 网页进入后台（`document.hidden`）时彻底停止无谓轮询，切回前台时安全自愈拉新。
  - **请求流水热加载与静默差异合并（`fetchEventsData` & `renderEventsTable`）**：
    - 引入新老流水指纹比对机制；当数据无变化时，0 DOM 变动、0 节点重构，保留所有用户选区与悬停状态；
    - 识别新流入请求，赋予青空微光淡入样式（`live-row-highlight`，淡蓝微光平滑渐隐），让新到来的流水一目了然且赏心悦目。
  - **分层自适应节流保护（`getSafePollingInterval`）**：
    - 运行总览（`runtime`）、请求流水（`logs`）、服务状态（`status`）等高频页保持全速实时节奏；
    - 用量趋势（`overview`）等重度 SQL 聚合报表页自适应节流至不少于 30 秒，保护后端 SQLite 吞吐。

- **测试（Tests）**：
  - 本地 `npm test` 全部 25 项集成测试与前端 AST/vm.Script 门禁 100% 通过；
  - 新增用户防打扰、流水微光热更新、重度报表自适应保护静态断言。

## [v2.9.22] - 2026-10-13

CPA 提供商表单紧凑卡片化重构与折叠式密钥池支持（CPA Provider Compact Card & Collapsible Key Pool）：

- **背景与目标（Background）**：
  - 用户反馈 CPA 提供商配置面板（`#tab-page-cpa-providers`）表单过于裸露臃肿，在配置多个 API Key（如 OpenRouter 配置 7 个密钥）时，全部密钥、代理地址等输入框全屏平铺展开数十行，上下滑动极其耗时吃力；
  - 学习并对齐原版 CPA 高效收敛的卡片化展示风格，实现提供商概览卡片高密度收纳、指标胶囊统计与折叠式密钥池管理。

- **架构与实现（Architecture & Implementation）**：
  - **紧凑提供商卡片与指标栏设计（`admin-cpa.css` & `admin-cpa.js`）**：
    - 提供商卡片重构为通透白卡（`rgba(255,255,255,0.96)`、圆角 14px、淡蓝边框 `#d9e7f2`）；
    - 顶部整合提供商标题徽标、启用/禁用状态胶囊、路由前缀标识；
    - 新增指标概览条（`.cpa-provider-metrics-bar`），清晰展示模型数、密钥数、代理配置状态与自定义 Header 数量；
    - 基础设置与高级参数分列排版，字段标签精简紧凑，彻底消除空白冗余。
  - **折叠式 API 密钥池与密码掩码（`admin-cpa.js`）**：
    - 将密钥列表收纳至原生折叠抽屉（`<details class="cpa-provider-keys-details">`）；
    - 默认折叠多密钥卡片（`keys.length > 1`），汇总栏显示密钥总数与脱敏前缀摘要（如 `sk-or-v1••••99ef`），单密钥则智能保持展开方便即时编辑；
    - 单行高密度网格布局（序号、脱敏密钥、代理地址、操作栏），支持密码明暗切换（👁️）与一键剪贴板复制；
    - 维护折叠状态缓存（`state.expandedProviderKeys`），点击「添加新密钥」时自动展开抽屉，确保操作流畅连贯。
  - **运行概览首屏配置与刷新鲁棒性加固（`admin-overview.js` & `admin.html`）**：
    - 修复概览页在部分场景下因未拉取运行时配置导致显示「运行时配置暂不可用」的问题，确保首屏及切换回 Tab 时自动调取 `fetchRuntimeConfig()`。

- **测试（Tests）**：
  - 本地 `npm test` 25 项后端集成测试全部通过；
  - Playwright UI 全量端到端测试（`npm run test:management:ui`）100% 通过（EXIT=0）。

## [v2.9.21] - 2026-10-13

吞吐 Tooltip 原生 Aozora UI 白卡重构与 502 空流 auth_index 补齐（Aozora Floating Tooltip Restyling & 502 Auth Tracking）：

- **背景与目标（Background）**：
  - 用户反馈吞吐图表的悬停 Tooltip 风格过于黑夜模式/AI 生成风，与整体青空（Aozora UI）设计风格严重割裂；
  - 同时排查流水中出现的频繁 502（`empty_response`）错误原因，定位上游响应特征与凭据追踪缺失。

- **架构与实现（Architecture & Implementation）**：
  - **吞吐图表 Tooltip 青空风格深度重构（`admin-overview.css` & `admin-overview.js`）**：
    - 废弃黑夜半透明黑卡设计，换装通透纯白半透明卡片（`rgba(255,255,255,0.98)`、`backdrop-filter: blur(12px)`），采用柔和淡蓝细边框（`rgba(186,215,242,0.85)`）与双层浅色阴影；
    - 文本全面回归深灰主字色（`#0f172a` 与 `#475569`），状态数字采用官方绿（`#059669`）、警示红（`#dc2626`）与 amber（`#b45309`）；
    - 移除所有 emoji（如 ⚡、⚠️、✓），改用规范的产品排版，上游凭据胶囊统一使用 `.provider-pill` 设计系统，与全局风格浑然一体；
  - **流式 502 错误原因剖析与上游凭据补齐（`lib/proxy/transport.mjs`）**：
    - 调查确认 502 根因：客户端发送 143 条超长对话 + 112 个 Tools 给 `gemini-3.8-flash-high`，上游直接返回带 `finish_reason: "stop"` 却无任何文字的空响应；
    - 修复此前空流判断逻辑在 502 熔断上报时遗漏传入 `detectedAuthIndex` 的缺陷，确保 502 错误也能完整记录其承接的上游账号（不再渲染为空横线 `—`）。

- **测试（Tests）**：本地 `npm test` 25 项全量集成测试全部通过（EXIT=0）。

## [v2.9.20] - 2026-10-13

吞吐错误归因悬停与点击错误柱一键跳转请求流水（Throughput Error Attribution & One-Click Log Drill-Down）：

- **背景与目标（Background）**：
  - 用户反馈在「运行总览」吞吐图表中，看到红色错误柱却不知道错误原因及具体哪家提供商和账号发生故障；
  - 要求完善错误提示构成，并支持点击错误柱直接跳转到请求流水排查具体报错。

- **架构与实现（Architecture & Implementation）**：
  - **运行总览吞吐图表错误深度归因（`admin-overview.js` & `admin-overview.css`）**：
    - `bucketTooltipHtml` 增强错误时段的深度解析：联动 `facts.credentials` 实时归集该 10 分钟窗口内所有产生 `failed > 0` 的上游凭据与提供商，明确展示异常提供商（如 Antigravity / Claude）、涉及账号数及故障次数；
    - 激活并升级现代化浮动 Tooltip（`.ovw-tooltip`），支持智能避障跟随鼠标平滑定位；
    - 吞吐图表红色错误柱增加 `.has-failed` 与高亮呼吸阴影效果，明确指示可交互性；
  - **点击错误柱一键跳转请求流水（`admin-overview.js` & `admin.html`）**：
    - 吞吐图表柱体增加点击与键盘回车交互，触发 `window.ovwJumpToErrorLogs(bucketTime, failCount)`；
    - 自动无缝切换至「实时请求流水」工作区（`switchNavTab('logs')`），自动选中并执行「异常错误」筛选，展示对应该时段的所有 4xx、5xx 及熔断拦截请求，并弹出明确操作反馈 Toast；
  - **请求流水支持综合异常筛选与视觉强调（`lib/analytics/audit-logs.mjs` & `admin.html`）**：
    - 后端 `getPagedRequests` 新增 `filter === 'errors'` 支持（`(status >= 400 OR error_type IS NOT NULL)`），一网打尽所有上游异常与拦截流水；
    - 前端流水过滤器选项卡新增「异常错误」快速切换按钮，并在流水表格中将 `error_type` 标签标红并附带错误详情悬停提示。

- **测试（Tests）**：本地 `npm test` 25 项全量集成测试全部通过（EXIT=0）。

## [v2.9.19] - 2026-10-13

今日用量 24 小时分时趋势、提供商工作区分组精简、心跳状态收敛与流式缓存命中率修复（Daily 24H Breakdown, Status Health Decay, Provider Modular Tabs & Streaming Cache Hit Fix）：

- **背景与目标（Background）**：
  - 用户反馈 6 项系统与交互痛点：
    1. 「今日 (1D)」用量图表只有 1 根单日柱状，需要细化分时段展示；
    2. 上游凭证顶部大黄条说明冗余，且表格中的「本地推算」胶囊小标签视觉杂乱；
    3. 服务状态健康度被几十分钟前的偶发错误持续拉低，应由最近前 2~3 根心跳决定；
    4. 「模型探针」无业务需求，彻底移除该工作区及全部关联逻辑；
    5. AI 提供商工作区纵向滚动过长、排版层级深且输入框与操作按钮未对齐；
    6. 请求流水中部分流式请求的 Prompt 缓存命中率异常显示为破折号 `—`。

- **架构与实现（Architecture & Implementation）**：
  - **今日用量趋势 24 小时连续分时展示（`lib/analytics/audit-logs.mjs` & `admin.html`）**：
    - `getUsageStats` 当 `days === 1` 时，采用 SQLite `strftime('%H', datetime(ts, 'unixepoch', '+8 hours'))` 将全天数据按 24 个自然小时分桶统计，融合内存实时增量数据；
    - 连续补齐当天 `00:00` 至 `23:00` 的完整 24 个离散时段，在前端主图表中渲染为 24 根堆叠柱状图，直观展现每小时的 Token 吞吐与成本构成；
  - **视觉噪声与冗余文案清理（`admin.html`）**：
    - 移除「上游凭证配额 (Auth Files)」表格上方关于额度周期与 Token 计算口径的黄色提示横幅；
    - 移除各表格中请求数旁边的「本地推算」胶囊徽章，界面回归纯净统计数字；
  - **服务状态健康度前 2~3 根心跳动态衰减（`lib/analytics/status-summary.mjs`）**：
    - 优化 `deriveGroupHealth` 算法，从原本计入全部历史心跳改为仅评估最近 2~3 个有效心跳槽（`activeBars.slice(-3)`）；偶发网络抖动在恢复后 2~3 分钟内即可完全自愈，不再产生长时间的虚假告警；
  - **彻底移除模型探针工作区（`admin-cpa.js` & `tests/test_cpa_ui.py`）**：
    - 从侧边栏移除 `cpa-models`，清理 `tab-page-cpa-models`、`loadModelCatalog`、`renderModelCatalog`、`runModelProbe` 及全部探针测试事件监听器；测试用例同步断言 13 个核心工作区；
  - **提供商工作区分组选项卡与按钮高度对齐（`admin-cpa.js` & `admin-cpa.css`）**：
    - 引入 `.cpa-provider-tabs` 顶部现代化子选项卡，将提供商划分至「提供商密钥与配置」、「OpenAI 兼容模型发现与测试」、「OAuth 模型别名映射」与「全局模型别名映射」四个扁平视图，避免长列表无限向下滚动；
    - 统合 `.cpa-provider-key` 与 `.cpa-provider-list-row` 的输入框与按钮样式，统一采用 `41px` 高度与 `align-self: end`，实现像素级底边对齐；
  - **流式 SSE 跨数据块 Token 累加与缓存命中率修复（`lib/proxy/token-estimator.mjs` & `lib/proxy/transport.mjs`）**：
    - `extractUsageFromJson` 增强多厂商（Anthropic / OpenAI / Gemini / DeepSeek）缓存字段兼容性，并针对 Anthropic 协议对 Prompt Tokens 与 Cached Tokens 进行非重叠归一化计算；
    - `transport.mjs` 在解析流式 SSE 数据块时建立字段级累加聚合机制：保留首包（`message_start`）中的 `promptTokens` 与 `cachedTokens`，累加尾包（`message_delta`）中的 `completionTokens`，彻底解决后续 delta 数据块覆盖清空前序缓存计量、导致前端渲染空白破折号的问题；
    - `admin.html` 流式流水对于缓存为 0 的成功请求规范展示 `0%`，仅在无法提取时才显示 `—`。

- **测试（Tests）**：本地 `npm test` 25 项全量集成测试全部通过（EXIT=0），语法与 AST 检查零错误。

## [v2.9.18] - 2026-10-13

官方原版品牌图标全面对齐（Official Provider Brand Icons Alignment）：

- **背景与目标（Background）**：
  - 用户反馈服务状态大盘与管理台中的 OpenCode Zen 及腾讯 WorkBuddy / CodeBuddy 图标与官方原版设计存在差异；
  - 必须从上游 CPA 源码与其原版管理台中提取官方权威图标资源，坚决杜绝非官方手绘简笔画。

- **架构与实现（Architecture & Implementation）**：
  - **OpenCode Zen 官方双层矩形卡片 SVG 对齐（`admin.html`）**：
    - 废弃原细边框单层中空矩形，换装 CPA 官方原版极简几何填充卡片 SVG（`<svg viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd"><path d="M3 2h18v20H3V2zm4 4h10v12H7V6z"/></svg>`），精准还原外实内虚的双层实体矩形外轮廓；
  - **腾讯 WorkBuddy / CodeBuddy 官方品牌图片图标对齐（`admin.html`）**：
    - 废弃自绘猫耳机器人简笔线条，全面接入 CPA 原生上游凭证管理与 OAuth 界面内置的高清官方品牌图标（`data:image/jpeg;base64,...`），无缝兼容 `.provider-icon-badge` 并在服务状态、请求流水、故障中心与凭据列表中呈现官方一致的视觉体验；
  - 同步侧栏版本徽章至 `v2.9.18`。

- **测试（Tests）**：本地 `npm test` 全量 25 项集成测试、分页测试、URL 提取测试、多级缓存测试与 CPA 管理集成测试全部通过（EXIT=0）。

## [v2.9.17] - 2026-10-13

腾讯 WorkBuddy / CodeBuddy 上游提供商全链路接入支持（Native Tencent WorkBuddy & CodeBuddy Upstream Integration）：

- **背景与目标（Background）**：
  - 上游 CPA 已接入并支持腾讯 WorkBuddy（含国际版 `workbuddy` 与国内版 `workbuddy-cn` / CodeBuddy）；
  - Gate 网关同步跟进全链路提供商注册表识别、凭据配额管理、服务状态分组、前端工作台展示与 OAuth 鉴权代理。

- **架构与实现（Architecture & Implementation）**：
  - **提供商注册表唯一真相源（`lib/core/provider-registry.mjs`）**：
    - `INITIAL_PROVIDER_REGISTRY` 注册 `workbuddy-cn` (sort_order: 68, label: 'WorkBuddy (CodeBuddy)') 与 `workbuddy` (sort_order: 69, label: '腾讯 WorkBuddy')；
    - 权威规则支持精确匹配 `workbuddy`、`workbuddy-cn`、`codebuddy` 与 `copilot.tencent`，并将更具体的 `workbuddy-cn` 排在前面防止被前缀包含抢配；
    - `initProviderRegistry()` 增加增量内置项自动补种机制，旧数据库升级后自动补充新增内置提供商，且绝不覆盖用户自定义规则；
  - **上游配额同步与探针激活（`lib/upstream/sync.mjs`）**：
    - `syncUpstreamQuotas` 识别 `workbuddy` / `workbuddy-cn`，赋予友好计划名称（`WorkBuddy` / `CodeBuddy`）；
    - `activateUpstreamQuotaWindow` 针对 WorkBuddy 凭据就绪探测进行适配，消除未知提供商探针报错；
  - **CPA OAuth 鉴权透明代理（`lib/routes/admin-routes.mjs`）**：
    - 将 `workbuddy` 与 `workbuddy-cn` 纳入 `CPA_WEBUI_OAUTH` 集合，启动授权时自动附加 `?is_webui=true` 参数以契合上游 WebUI 协议；
  - **管理控制台前端全链路支持（`admin.html`）**：
    - 「上游凭证配额 (Auth Files)」面板新增「WorkBuddy」专属筛选标签（`<button onclick="switchUpstreamFilter('workbuddy')">WorkBuddy</button>`），同时匹配 `workbuddy` 与 `workbuddy-cn`，批量额度查询支持联动；
    - 品牌定义 `getProviderBrand` 增加 `workbuddy` 与 `codebuddy` 识别，呈现官方极简绿猫耳机器人矢量图标与品牌胶囊徽章（`.provider-icon-workbuddy`、`.provider-pill-workbuddy`，采用官方 `#e8f8f0` / `#0d7a42` 薄荷绿配色）；
    - 请求流水与故障中心推断 `resolveEventProvider` 全面对齐；
    - 同步侧栏版本徽章至 `v2.9.17`。

- **测试（Tests）**：
  - 新增集成测试 25（`tests/test_gate_features.mjs`），断言提供商注册表双版本推断、前端 DOM 过滤按钮与样式类、OAuth WebUI 配置全链路契约；同时加固测试 13 分钟末秒边界稳定性；
  - 本地 `npm test` 全量 25 项集成测试、分页测试、URL 提取测试、多级缓存测试与 CPA 管理集成测试全部通过（EXIT=0）。

## [v2.9.16] - 2026-10-13

用量趋势页面崩溃修复与顶部五联卡片多周期动态联动（Usage Trends Crash Fix & Multi-Period KPI Cards Sync）：

- **症状（Symptom）**：
  - 打开管理台「用量趋势」页面时，主趋势图始终报错显示“用量数据暂不可用。请检查密钥或稍后刷新。”，右侧「模型用量分布」一直停留在“暂无模型记录”（0 个模型），底部「AI 提供商 Token 分布与占比」一直停留在“暂无提供商统计”（0 个提供商）；
  - 顶部第 4 张卡片「请求」的成功率始终显示 `--`、状态停在“等待数据”，第 5 张卡片「Key 状态」始终显示 `0 活跃 / 0`；
  - 切换 `7D`、`14D`、`30D`、`全部` 时间跨度或选择特定凭据时，顶部核心指标卡片的数值与标题完全不随之变化，始终只显示今日单日数值。

- **根因分析（Root Cause）**：
  - **前端空指针异常阻断渲染链**：v2.8.3 将第 4 张卡片右上角 `<span id="card-req-qps">` 替换为 `<span id="card-alltime-requests">`，但 `renderSummaryCards()` 第 6467 行仍直接执行 `document.getElementById('card-req-qps').innerText = ...`，触发 `TypeError: Cannot set properties of null (setting 'innerText')`。该异常直接中断了 `renderSummaryCards()` 后半段（导致成功率、Key 状态全部未渲染），并被外层 `fetchStatsData()` 的 `catch` 捕获，把主趋势图覆盖为“用量数据暂不可用”，同时跳过了 `renderMainChart()`、`renderModelsList()` 与 `renderProvidersList()` 的执行；
  - **后端 `summary` 缺少所选区间聚合**：`lib/analytics/audit-logs.mjs` 的 `getUsageStats(days, filterKeyId)` 虽然按 `days` 查询了每日明细与模型分布，但 `summary` 对象只计算了 `today_*` 与 `all_time_*`，未汇总所选时间窗口的区间总计（`period_tokens`、`period_requests`、`period_cost_usd`、`period_savings_usd`、`period_cache_hit_rate`、`period_success_rate`），且 `renderSummaryCards()` 硬编码只读 `summary.today_*`。

- **修复与落地（Fix & Architecture）**：
  - **消除 `card-req-qps` 空指针崩溃并加固 DOM 守卫（`admin.html`）**：对 `card-req-qps` 增加存在性守卫，并将区间均速 QPS 与今日请求数合入 `#card-requests-sub` 悬停提示，确保 `renderSummaryCards`、`renderMainChart`、`renderModelsList`、`renderProvidersList` 全链路顺畅执行；
  - **后端补齐所选时间窗口 `period_*` 聚合与 85% 预警 Key 统计（`lib/analytics/audit-logs.mjs`）**：
    - 基于 `dailyMap` 汇总当前所选周期的 `period_tokens`、`period_requests`、`period_prompt_tokens`、`period_completion_tokens`、`period_cached_tokens`、`period_cache_hit_rate`、`period_cost_usd`、`period_savings_usd`、`period_success_rate`；
    - 补齐 `warned_keys`（配额使用率 ≥ 85% 且未阻断的 Key 计数）及提供商 `avg_tokens_per_request` 字段；
  - **顶部五联卡片与时间跨度（今日 / 7D / 14D / 30D / 全部）实时联动（`admin.html`）**：
    - 时间跨度切换栏新增「今日 (`1D`)」按钮，支持 `今日 / 7D / 14D / 30D / 全部` 五档切换；
    - 卡片标题（`#card-tokens-title`、`#card-cost-title`、`#card-req-title`）与主数值、输入/缓存/输出比例条、花费、缓存命中率、请求数及成功率全部随所选时间范围和凭据筛选动态更新，右上角徽章保留历史累计与今日对照；
    - 优化多日柱状图 `barW` 自适应下限（`Math.max(2, ...)`），防止 30D / 全量历史模式下柱体过宽重叠；同步侧栏版本徽章至 `v2.9.16`。
  - **新增回归测试 24（`tests/test_gate_features.mjs`）**：锁死 `getUsageStats` 多周期聚合字段契约，并扫描 `admin.html` 内联脚本所有 `getElementById(...).innerText` 引用，确保每个目标 ID 在 HTML 中真实存在，杜绝同类空指针白屏回归。

- **测试（Tests）**：本地 `npm test` 全量 24 项集成测试、分页测试、URL 提取测试、多级缓存测试与 CPA 管理集成测试全部通过（EXIT=0）。

## [v2.9.15] - 2026-10-12

测试隔离加固：所有涉及数据库的测试一律跑在独立临时库上（Test Database Isolation）：

- **症状（Symptom）**：
  - `npm test` 偶发失败在「测试 13: 服务状态按提供商分组聚合」，报 `codex 组心跳请求数求和必须等于 requests_7d`，`5 !== 6`；
  - 失败与本次改动毫无关系——改动只碰了管理台凭据存储，而这个用例测的是提供商分组聚合；
  - 清理开发机 `gate.db` 后重跑即通过，但只要库里残留一行历史测试数据就又失败，表现成"时好时坏"。

- **根因分析（Root Cause）**：
  - 测试直接跑在开发机的**真实** `gate.db` 上。`lib/db/sqlite.mjs` 在 import 时就按 `config.mjs` 的路径打开 SQLite，且模块只求值一次，测试文件里再改环境变量已经来不及；
  - 测试 13 原本有一套「按自增 id 水位 + auth_index 正则」的双保险清理，用来不弄脏共享库。这套机制最后还是漏了：其他用例留下的 `auth_index='auth-test-key'` 形态不匹配那个正则，活过了清理；
  - 该行的 `model='gpt-4o'` 被提供商注册表归到 **codex** 组，时间戳落在 7 天窗口内、却在 60 分钟心跳窗口外，于是 `requests_7d` 被多算 1 而心跳柱之和不变，恰好差 1；
  - 根因是「测试与生产共用一个库」，不是清理正则写得不够全——再怎么补正则也防不住下一种新形态的脏行。

- **修复与落地（Fix & Architecture）**：
  - 新增公共助手 `tests/_isolated-db.mjs`，导出 `isolateTestDb(import.meta.url, label)`：在任何 `lib/` import 之前，把 `GATE_DIR` / `GATE_DB` / `GATE_KEEPER_DB` 指到一个 `mkdtempSync` 临时目录，然后 spawn 一个带这些环境变量的自己，父进程原样透传子进程退出码后退出；
  - 之所以必须 re-exec：SQLite 连接在 import 时就已建立，进程内换库无解，只能在 import 发生之前把变量设好；
  - 三个会碰库的测试全部挂载：`test_gate_features.mjs`、`test_gate_caching.mjs`，以及原本已自带一份隔离逻辑的 `test_gate_pagination.mjs`（改为复用公共助手，删掉重复实现）；
  - **删除**测试 13 的整套清理机制（id 水位 + 正则清扫 + `process.on('exit')` 钩子）：库是临时目录，进程退出即整目录删除，清理已无意义。原处留注释说明为什么删，避免后来者再修一遍正则；
  - 新增测试 23 固化隔离契约：断言 `GATE_DB`/`GATE_KEEPER_DB` 必须落在 `GATE_TEST_DIR` 内，且三个碰库的测试文件都必须出现 `isolateTestDb(import.meta.url)`——新增测试文件漏挂载会被这条直接抓住。

- **测试（Tests）**：全量 23 项集成测试与多级缓存、分页、CPAMC 测试全部通过（EXIT=0，92 条断言）。隔离有效性做了正反两面验证：往真实 `gate.db` 里植入当初那行毒数据（`auth_index='auth-test-key'`）后跑测试仍然全绿，且该行事后确认未被读写；反向把 `test_gate_caching.mjs` 的 `isolateTestDb` 调用临时摘掉，测试 23 立刻以"必须调用 isolateTestDb"失败，证明这条契约真的能兜住回归。另确认整套跑完真实 `gate.db` 零改动、零临时目录残留。

- **顺手修正**：`test_gate_pagination.mjs` 复用公共助手时补回了原先散在隔离分支里的 `GATE_MGMT_SECRET` / `GATE_MGMT_PORT` 设置，否则 import `quota-manager.mjs` 会因缺 `CPA_MGMT_SECRET` 直接抛错。

- **生产部署与验证（Deployment & Production Verification，2026-10-13）**：
  - 本版本**不含任何运行时代码改动**：10 个运行时文件（`server.mjs`、`lib/**`、`quota-manager.mjs`、`admin.html`）的 SHA-256 与生产服务器逐一比对全部相同，因此只需同步测试、文档与版本号，共 6 个文件：`package.json`、`CHANGELOG.md`、`tests/_isolated-db.mjs`、`tests/test_gate_features.mjs`、`tests/test_gate_caching.mjs`、`tests/test_gate_pagination.mjs`；
  - 部署后核验：6 个文件 SHA-256 与本地逐一相同；`node --check` 四个测试文件全部通过；`package.json` 版本号为 v2.9.15；
  - **在生产机上实跑测试套件**（这是本次部署的重点）：`test_gate_features.mjs`（含测试 23 隔离契约）、`test_gate_caching.mjs`、`test_gate_pagination.mjs`、`test_gate_validation_url.mjs` 四个脚本全部 `EXIT=0`；
  - **隔离在生产环境同样生效**：跑测试前后比对生产库，`request_events` 计数增加的行全部是真实业务流量（`key_id=2`、真实上游 `auth_index` 哈希、status 200），没有任何测试行；`auth_index LIKE 'auth-test-key'` 的残留为 0；`/tmp` 下无残留临时目录；
  - `systemctl restart gate` 后服务 `active`，5 个监听端口全部就绪；重启后功能复核：`/healthz` 200、未鉴权访问 reveal 401、列表 200 且 9 个 Key 全部不含 `api_key` 字段、带鉴权 reveal 200、按原始 Key 搜索 200（`total=51025`），确认 v2.9.14 的凭据存储加固未被本次部署破坏。

## [v2.9.14] - 2026-10-12

管理台凭据存储安全加固：完整 API Key 与管理密钥不再落 localStorage（Credential Storage Hardening）：

- **症状（Symptom）**：
  - 代码审查发现：`GET /admin/api/keys` 随列表下发**完整 API Key 明文**，前端将其写入 `localStorage`（关浏览器不消失）并塞进 DOM `data-copy` 属性；
  - 管理密钥 `GATE_ADMIN_SECRET` 同样存 `localStorage`，而它是可放行全部 `/admin/api/*`（建/删/轮换 Key、改配额）的万能凭证；
  - 从 URL `?key=` 传入的管理密钥被写入 `localStorage` 持久化，而 URL 本身会留在浏览器历史与 Referer 中；
  - 复合风险：一次同源 XSS 可同时取走「钥匙」与「全部钥匙的明文」，服务端 `Cache-Control: no-store` 的防护被前端落盘完全抵消。

- **根因分析（Root Cause）**：
  - `lib/analytics/quota-health.mjs` 的 `getAdminData()` 直接返回 `api_key: meta.api_key`，无截断、无按需机制；
  - 前端把整个 `cachedKeys` 数组（含明文）写入 `gate_cache_keys_v2`，首屏水合时再整体读回；
  - 管理密钥与成员 Key 共用 `localStorage`，未按权限分级；
  - 初始化分支对 URL 传入的密钥不区分类型，一律 `localStorage.setItem` 持久化。

- **修复与落地（Fix & Architecture）**：
  - **列表接口不再下发完整 Key（`lib/analytics/quota-health.mjs`）**：删除 `api_key: meta.api_key` 字段，列表只保留 `display_key`（截断形）；
  - **新增按需拉取端点（`lib/routes/admin-routes.mjs`、`lib/core/key-registry.mjs`、`quota-manager.mjs`）**：
    - 新增 `GET /admin/api/keys/<id>/reveal`，仅在用户显式点击「复制完整 Key」时返回单个 Key 的明文，取到即用、不做任何持久化；
    - `getRawKeyById()` 校验 `Number.isSafeInteger` 且 `> 0`，对不存在、负数、非数字与注入串一律返回 `null`；
  - **前端落盘强制剥离（`admin.html`）**：
    - 新增 `sanitizeKeysForStorage()` 与统一写盘入口 `persistKeysToStorage()`，写盘前剥离 `api_key`，兜住任何将来误把明文塞进 `cachedKeys` 的路径；
    - 首屏水合读回旧缓存时同样剥离——旧版本可能已把完整 Key 写在盘上，老用户升级后无感清理；
  - **管理密钥改存 sessionStorage（`admin.html`）**：
    - 新增 `adminSecretStore` 收口层统一读写；管理密钥只进 `sessionStorage`，关标签页即失效，不在机器上跨会话留存；
    - 保留对旧 `localStorage` 键（`gate_admin_secret` / `cpa_admin_secret`）的兼容读取，读到即迁移并删除旧值，避免老用户升级后突然掉登录；
    - 成员 Key 仍用 `localStorage`（低权限、可撤销，本就是给成员用的），按权限分级存储；
  - **URL 传入密钥不持久化（`admin.html`）**：管理密钥只进 `sessionStorage`，并在读取后立刻 `history.replaceState` 抹掉地址栏 `?key=`，防止随截图、分享或 Referer 外泄。

- **测试（Tests）**：新增集成测试 22（`tests/test_gate_features.mjs`），固化四项契约：列表接口不再下发完整 Key、reveal 端点存在且经 `getRawKeyById` 取值、落盘前强制剥离 `api_key`、管理密钥只写 `sessionStorage` 并迁移清除 legacy 值。另以隔离库实测 HTTP 层：未鉴权/错密钥访问 reveal 返回 401、正确密钥 200、不存在 Key 404、列表接口序列化后不含完整明文、流水搜索接口无回归。全量 22 项集成测试与多级缓存测试全部通过（EXIT=0）。

- **顺手修正**：`package.json` 版本号补齐至 v2.9.14，修复 v2.9.13 条目只写升级动作、漏同步版本号导致的 CHANGELOG 与 package.json 口径断裂。

- **部署与生产验证（Deployment & Production Verification，2026-10-12）**：
  - 部署路径：生产宿主机 `/opt/gate`，按 `scp` + `systemctl restart gate` 落地；
  - 部署文件：`lib/analytics/quota-health.mjs`、`lib/core/key-registry.mjs`、`lib/routes/admin-routes.mjs`、`quota-manager.mjs`、`admin.html`、`package.json` 共 6 个；`static/management.html` 经 SHA-256 比对与本地一致（`596721bcd2d9d83d`）未重传；
  - 部署后核验：6 个文件 SHA-256 与本地逐一相同，`node --check` 全部通过，`systemctl is-active gate` = active，启动日志无 error；
  - 生产接口实测（带真实 `GATE_ADMIN_SECRET`）：未带凭据与错凭据访问 reveal 均 401；正确凭据 200 且返回单 Key 明文；不存在 Key 404；列表 200 且 9 个 Key 全部**不含** `api_key` 字段（仅 `key_id`/`display_key`/`key_alias` 等）；流水按原始 Key 搜索 200（`total=50317`）、按别名搜索 200（`total=50029`）；租户隔离 `key_id=2`（50040）+ `key_id=10`（288）= 50328，与无过滤总量吻合，无重复计入或漏算；
  - 部署后负面断言：`admin.html` 中已不存在 `localStorage.setItem('gate_admin_secret'`、已不存在未剥离的 `cachedKeys` 直写、已不存在 `data-copy` 携带完整 Key；
  - **踩坑记录**：首次 `scp` 把多个文件一次性传到远程裸目录 `/opt/gate/`，三个带子目录的文件（`lib/analytics/…`、`lib/core/…`、`lib/routes/…`）被静默丢弃——只有根目录文件落地成功。已改为对每个子目录文件显式写全远程路径重传，并一律以 SHA-256 比对确认。

## [v2.9.13] - 2026-10-12

CPA 管理控制台（CPAMC）升级至官方最新 v1.26.2 并全量保持 OpenCode 与 WorkBuddy 原生支持（Upgrade CPAMC to v1.26.2 with OpenCode & WorkBuddy Native Support）：

- **升级与合并（Upgrade & Merge）**：
  - 同步官方最新 `router-for-me/Cli-Proxy-API-Management-Center` v1.26.2 单文件控制台 `static/management.html`；
  - 继承上游最新能力：Claude 独立额度与美元余额展示、Plugin 配额路由修复、新增韩文（ko）与越南文（vi）国际化等；
  - 完整迁移并合并所有 OpenCode 原生适配：左侧独立提供商导航分类、官方中空回字矢量图标、提供商描述符、独立 OpenCode 路由与多 Key 表单；
  - 完整合并保留所有 WorkBuddy / CodeBuddy 原生适配：OAuth 登录磁贴（`WorkBuddy (en)` 与 `WorkBuddy (cn)`）、绿猫耳官方机器人头像图标、凭据文件（Auth Files）分类过滤与预设、主题颜色映射，确保历史功能零丢失。

- **测试（Tests）**：`tests/test_cpa_management.mjs` 全量通过（含未认证 302、Token-Cookie 交换、已认证静态直出、URL 透明重写、非目标路径放行）；`static/management.html` 版本号核验为 v1.26.2。注：该文件体积超过 AOCI 单条目上限（oversize），仅登记基线不作曲目索引。

## [v2.9.12] - 2026-10-12

请求流水支持按原始 API Key 字符串检索与体验加固（Request Audit Search by Raw API Key & Alias Binding）：

- **问题（Symptom）**：
  - 用户在控制台请求流水搜索框输入 API Key（例如 `tangtangtangtang`）时，提示 "共 0 条"，造成用户误以为该 Key 的请求未被统计；
  - 实际上底层数据库已准确记录该 Key 的数万条流水（注册为 Key ID 2，别名 `test-key`），但由于搜索 SQL 过滤仅匹配了 `keys.alias` 而遗漏了 `keys.api_key`，导致按原始 Key 字符串搜索无结果。

- **根因分析（Root Cause）**：
  - `lib/analytics/audit-logs.mjs` 中的 `getPagedRequests()` 的 `search` 谓词子查询写为：
    `EXISTS (SELECT 1 FROM keys WHERE keys.id = request_events.key_id AND keys.alias LIKE ?)`，缺少对 `keys.api_key LIKE ?` 的比对。
  - 前端输入框 placeholder 为 "搜索模型、Key别名、上游账号或错误..."，未明确说明支持输入原始 Key。

- **修复与落地（Fix & Architecture）**：
  - **后端审计搜索子查询扩展（`lib/analytics/audit-logs.mjs`）**：
    - 将子查询调整为 `EXISTS (SELECT 1 FROM keys WHERE keys.id = request_events.key_id AND (keys.alias LIKE ? OR keys.api_key LIKE ?))`，支持模糊匹配 Key 的真实字符串与别名。
  - **前端交互提示优化（`admin.html`）**：
    - 更新搜索框 placeholder 为 "搜索模型、API Key/别名、上游账号或错误..."，清晰引导输入。
  - **自动化测试（`tests/test_gate_features.mjs`）**：
    - 新增测试 21，校验通过 `keys.alias` 与 `keys.api_key` 模糊检索请求流水的端到端正确性。

## [v2.9.11] - 2026-10-12

CPA 管理中心 OAuth 授权增加 WorkBuddy / CodeBuddy 原生支持（Native WorkBuddy & CodeBuddy OAuth Integration）：

- **新增提供商映射（`lib/routes/admin-routes.mjs`）**：
  - 在 `CPA_OAUTH_RESOURCES` 中注册 `workbuddy: 'workbuddy-auth-url'` 与 `'workbuddy-cn': 'workbuddy-cn-auth-url'`。
- **管理控制台前端扩展（`admin-cpa.js`）**：
  - 在账号授权下拉选择框中增加 `WorkBuddy` 与 `WorkBuddy (国内 / CodeBuddy)` 选项。

## [v2.9.10] - 2026-10-12

全链路审计流水漏记与客户端异常中断治理（100% Request Audit Trail & HTTP 499 Ingestion）：

- **问题（Symptom）**：
  1. 用户在管理控制台 "请求流水" 中发现请求数显著少于实际发送量，存在大面积漏记；
  2. 客户端主动中断、取消生成或超时断开时，请求完全从流水表中蒸发，已消耗 Tokens 与耗时未落盘；
  3. 部分 Anthropic 协议流式请求以及网关层负缓存/上游熔断阻断的请求未进审计流水。

- **根因分析（Root Cause）**：
  1. **客户端中断（499）无落盘守卫**：`lib/proxy/transport.mjs` 中 `clientRes.on('close')` 直接执行 `proxyRes.destroy()`，连接销毁后上游不再触发 `proxyRes.on('end')`，导致整个生命周期未触发 `recordRequest`；
  2. **Anthropic SSE 流式提交遗漏**：`transport.mjs` 在解析流式 SSE 时，`hasSemanticEvents` 仅在检测到 `choices` 数组时置 true；对于 Anthropic 协议格式的 `payload.delta.text`，未将 `hasSemanticEvents` 置 true，存在被下游误判为 empty stop 的隐患；
  3. **网关熔断阻断点漏记流水**：`server.mjs` 在命中 30 秒 Negative Cache 快速熔断（502）以及上游熔断器打开（503）时，直接 `res.writeHead` 退出，缺少 `recordRequest` 审计记录。

- **修复与落地（Fix & Architecture）**：
  - **499 客户端中断兜底落盘与幂等收敛（`lib/proxy/transport.mjs`）**：
    - 增加 `recordOnce` 幂等守卫，确保同一个请求无论在正常结束、客户端中断或网络异常下只落盘一次；
    - 在 `clientRes.on('close')` 中增加 `recordClientAbort`，以 HTTP 499、`errorType: 'client_closed'` 记录审计，并带上已生成的 Tokens 估算与实际耗时；
  - **Anthropic SSE 流式事件提交判定加固（`lib/proxy/transport.mjs`）**：
    - 在检测到 `payload.delta?.text.length > 0` 时显式设置 `hasSemanticEvents = true`，确保跨协议流式解析准确提交；
  - **网关阻断点流水补齐（`server.mjs`）**：
    - 在 30 秒 Negative Cache 快速 502 熔断点与上游不可用 503 熔断拦截点处补齐 `recordRequest`，保证全量请求 100% 留痕。

- **测试（Tests）**：新增集成测试 20（`tests/test_gate_features.mjs`），覆盖 499 状态兜底、`recordOnce` 幂等守卫、Anthropic 流式语义提交与网关熔断落盘校验。全量 20 项集成测试与多级缓存测试全部通过（EXIT=0）。

## [v2.9.9] - 2026-10-12

请求流水与错误中心全链路提供商推断兜底：彻底消灭 API 渠道凭证掉入 "其他上游" 与 16 位裸哈希展示（Request Logs & Error Events Provider Resolution）：

- **问题（Symptom）**：
  1. 用户在管理控制台 "请求流水" 与 "错误与熔断中心" 中，调用 `-free` 系列免费模型（如 `mimo-v2.6-flash-free`、`ling-3.1-flash-free`）时，上游账号列均显示为 "其他上游" 徽章；
  2. 上游账号名直接退化为 16 位十六进制裸哈希（如 `eeca530b51788894`、`e25cdb055a6aff94` 等），既看不出真实提供商，也看不出渠道归属。

- **根因分析（Root Cause）**：
  1. **流水接口漏掉推断兜底**：`lib/analytics/audit-logs.mjs` 中的 `getPagedRequests`、`getRecentRequests`、`getPagedErrors` 等在组装事件时，仅尝试匹配 OAuth 凭证文件列表（`auth-files`）；由于 OpenCode 等属于 CPA 原生 API Key 渠道配置（动态分配 16 位 trace auth_index），无静态凭证文件，查空后直接透传空字符串 `provider: ""`，且漏掉了调用 `inferProvider({ model: r.model, authIndex: r.auth_index })` 进行兜底；
  2. **前端硬编码口径残缺**：`admin.html` 中的 `resolveEventProvider` 历史代码仅硬编码了 `step`、`claude`、`gemini`、`gpt` 4 种前缀，未包含 `opencode` 与 `-free`（以及 deepseek、qwen、kimi、glm、stealth 等），当后端返回空 provider 时直接返回空串，命中 `getProviderBrand` 的兜底分支，渲染为 "其他上游"；
  3. **账号名称退化为裸哈希**：静态凭证查空后，后端 `auth_name` 直接原样返回 16 位十六进制字符串，前端亦未结合提供商推断进行友好渠道命名。

- **修复与落地（Fix & Architecture）**：
  - **服务端全链路推断闭环（`audit-logs.mjs`）**：
    - 引入 `resolveEventAuthInfo(authIndex, model, explicitProvider)`，在组装流水与错误事件时，优先使用凭证提供商；若缺失则无缝走 `inferProvider` 注册表兜底；
    - 当凭证名为空或等于原始裸哈希时，结合推断提供商自动赋予友好别名（如 "OpenCode Zen 渠道 eeca530b"），无法推断的孤儿哈希统一标注为 "已删除账号 <前8位>"；
    - `getPagedRequests`、`getRecentRequests`、`getRecentRequestsForKey`、`getPagedErrors` 与 `getRecentErrorEvents` 全面接入统一解析。
  - **管理端提供商识别与品牌标签扩充（`admin.html`）**：
    - `resolveEventProvider` 全面同步 `provider-registry.mjs` 权威规则，完整覆盖 `opencode`（含 `-free`）、`stealth`、`deepseek`、`openrouter`、`qwen`、`moonshot`、`zhipu` 等已注册提供商；
    - 增加从已同步凭据列表中按 `auth_index` 反查 provider 的前置逻辑；
    - `getProviderBrand` 补齐 `stealth`、`deepseek`、`qwen`、`moonshot`、`zhipu` 的矢量品牌定义与标签样式；
    - 前端渲染表格做双重防漏兜底，杜绝任何裸哈希直出。

- **测试（Tests）**：新增集成测试 19（`tests/test_gate_features.mjs`），覆盖 `resolveEventAuthInfo` 对免费模型与裸哈希推断、`getPagedRequests` 端到端流水字段断言以及 `admin.html` 语法与静态契约校验。`npm test` 全量通过（EXIT=0）。

## [v2.9.8] - 2026-10-11

管理控制台全链路多级缓存架构与首屏即时水合：彻底根除请求流水、API 密钥与故障中心全量拉取延迟，实现 0ms 切页呈现与流水页 Key 预填充（Multi-Tier SWR Caching & Instant Key Hydration）：

- **问题（Symptom）**：
  1. 用户在管理控制台切换至「请求流水」、「API 密钥」、「故障中心」或刷新时，页面每次发起全量或大分页数据拉取，存在高延迟与白屏等待，体验极差；
  2. 初次打开页面或尚未点击访问「API 密钥」Tab 时，进入「请求流水」页面的密钥筛选下拉列表为空（仅有默认项），无法按特定 Key 筛选流水。

- **根因分析（Root Cause）**：
  1. **首屏未水合与串行依赖**：`cachedKeys` 仅在访问「API 密钥」Tab 时被填充，且 `initCustomDropdowns()` 初始仅生成单个默认选项；`fetchEventsData` 在拉取流水前通过 `await ensureKeysLoaded()` 串行阻塞，形成瀑布流；
  2. **缺少多级缓存与 SWR 机制**：前端切 Tab 时清空或重置视图重新发网，翻页与回切没有命中内存查询缓存，导致无谓的重复网络往返与 DOM 闪烁；
  3. **全局锁与并发阻塞**：`refreshCurrentTab` 使用全局布尔锁 `isRefreshingCurrentTab`，快速点击不同 Tab 会丢弃新 Tab 的数据拉取；同时无条件 `await Promise.allSettled` 阻塞等待顶栏探活接口；
  4. **服务端循环全表扫描**：`audit-logs.mjs` 中的 `resolveAuthAccountInfo` 在大列表中由于无缓存频繁执行全表扫描查询。

- **修复与架构落地（Fix & Architecture）**：
  - **首屏持久化水合与 Key 下拉即时注入**：
    - 引入 `gate_cache_keys_v2`、`gate_cache_logs_v2` 与 `gate_cache_errors_v2` 持久化存储；
    - 在管理脚本执行初期立即运行 `hydratePersistentCaches()` 同步水合，并在构造 `logs-key-dropdown` 与 `chart-key-dropdown` 时直接注入全量 Keys，确保任何时机进入流水页均具备完整密钥列表；
    - 页面启动时后台非阻塞异步触发 `ensureKeysLoaded()`，静默同步最新 Key 列表，无需用户手动切 Tab。
  - **前端 SWR 极速响应与 0ms 切页呈现**：
    - 引入 `logsQueryCache` 与 `errorsQueryCache` 内存查询池（15s TTL，容量淘汰保护）；
    - `switchNavTab` 切换至各 Tab 时瞬时呈现已有缓存（0ms 响应，无白屏），并在后台静默校验或重新拉取最新数据；
    - 修复 `switchNavTab` 中 `renderEventsTable` 漏传 `cachedEventsTotal` 导致分页条数闪烁的问题。
  - **拆除瀑布流串行阻塞与全局锁**：
    - 移除 `refreshCurrentTab` 内部 `isRefreshingCurrentTab` 锁丢弃，快速切 Tab 不再丢弃数据拉取；
    - 将顶栏探活 `fetchQuotaProbeStatus()` 与 `fetchGateStatus()` 改为 15s 节流异步并发，不再通过 `await` 阻塞当前激活 Tab 的专属数据拉取；
    - 移除 `fetchEventsData` 对 `await ensureKeysLoaded()` 的串行阻塞。
  - **服务端高频查询加固与版本自增自动失效**：
    - `audit-logs.mjs`: `baselinesCacheMap` 与 `authInfoCache` 10s TTL 消除列表循环中 N 次全表扫描；分页查询 `getPagedRequests` 与 `getPagedErrorEvents` 内存缓存，在数据写入与清空时自动失效；
    - `quota-health.mjs`: `getAdminData` 2.5s TTL 缓存，基于 `${keyRegistryVersion}:${quotaRulesVersion}:${liveUsage.size}` 版本联动；
    - 当 API Key 创建、轮换、删除、别名变更或配额规则变更时，前端 `invalidateKeysFrontendCache()` 与后端版本自增联动双重失效。

- **测试（Tests）**：新增 `tests/test_gate_caching.mjs` 覆盖服务端分页缓存与主动清除、API 密钥防抖缓存与主动失效、前端静态语法与首屏水合、下拉提前注入与去瀑布流验证。`npm test` 全量通过（EXIT=0）。

## [v2.9.7] - 2026-10-11

彻底拆掉 CPA 日志管道的三处定时炸弹：8MB 硬墙不再让面板整体死掉、CPA 日志目录设硬上限、历史积压轮转文件清退（CPA Log Pipeline Hardening）：

- **问题（Symptom）**：v2.9.4 把 `after=0` 的全量请求修掉后，面板能用了，但留下了三个没根治的隐患：
  1. **24 小时档正在顶穿 8MB 上限**。实测 24h 档 6.2MB / 上限 8MB，只剩约 30% 余量。流量一涨，用户点「最近 24 小时」就是一次整体失败——又回到 v2.9.4 之前的死面板。
  2. **CPA 日志目录没有任何有效上限**。`logs-max-total-size-mb: 500` 配了，但 311MB 还远没到阈值，清理器从未触发；等它真涨到 500MB，磁盘和内存压力已经很难看。而 `debug: true` 一直在写，轮转文件每个正好 10MB 且**永久保留**。
  3. **311MB 历史积压白占磁盘**。31 个 `main-*.log` 轮转文件，最早的可追溯到 9 月 7 日，全是 gin 访问日志（`[info]` 19400 行 + `[debug]` 4298 行），对排障没有价值。

- **根因一：把「可容忍尾部截断」当成了「必须整体失败」（Truncation Policy）**。CPA 的 `/logs` 只有 `after` 一个秒级游标参数，**没有 `limit`/`until`**（已从二进制确认：路由只有 `management/logs`，参数只有 `after`）。所以响应体积完全由「回溯多久」决定，服务端无法只取末尾 N 行。原来的实现是一超标就 `reject`，可日志工具要的是「最近发生了什么」，尾部缺一段照样能用，整体失败反而让面板彻底瞎掉。
- **根因二：截断会切坏 JSON，而坏 JSON 会让截断白做（Broken JSON）**。按 8MB 字节边界硬切，`{"lines":[...],"latest-timestamp":N}` 必然断在字符串或数组中间，`JSON.parse` 直接抛错——那时候的超限处理等于没做。
- **根因三：CPA 的日志清理器只管 error 日志（Cleaner Scope）**。二进制里有 `configureLogDirCleanerLocked` / `runLogDirCleaner` / `enforceLogDirSizeLimit` / `oldLogFiles`，说明 main 日志目录清理器是存在且受 `LogsMaxTotalSizeMB` 驱动的；但 `cleanupOldErrorLogs` 只清 error 文件（生产 `error-*` 正好 20 个 = 配置的 `error-logs-max-files: 20`，这条清理是生效的）。main 轮转文件能否被清取决于阈值是否被触及——500MB 太高，等于没设。
- **根因四：`debug: true` 让日志量翻倍（Debug Logging）**。生产 `observability.logs.debug` 是 `true`（示例配置默认 `false`）。采样 `main.log`：`[info]` 19400 行、`[debug]` 4298 行、`[warn]` 1396 行、`[error]` 仅 3 行。写盘的主要是 gin 访问日志，而其中 **13107 行是 `POST /v0/management/api-call`、4952 行是 `GET /v0/management/api-keys`** ——Gate 自己的轮询在刷盘。

- **修复（Fix）**：
  - **日志类响应超限改为「保留已收到的部分」**：按路径段判断是否可截断（`pathname.split('/').includes('logs')`），只有日志路径允许截断；`config`/`auth-files` 等响应一旦被截就是坏数据，仍然整体失败。截断时按字节边界吃满 8MB，标记 `truncated: true`，**不走 reject**；
  - **新增 `repairTruncatedJson()` 修复被切坏的 JSON**：从末尾按逗号/冒号边界逐刀回退，每刀补上未闭括号试解析，最多 64 刀。实测 8.52MB 构造响应截到 8MB 后 **129ms 修复、救回 93.9%（57532/61281 行）、末行完整无断裂**；
  - **截断标志一路透传到前端**：`admin-routes.mjs` 的 logs 路由改用 `requestCpaManagement` 以拿到 `truncated`，原样透出；前端新增 `state.logTruncated` 与常驻提示条 `#cpa-logs-truncated`（`role="alert"`），文案说明「已达 8MB 上限被截断，请改选更短的时间范围」——用户筛选滚动后仍然看得到，不会把残缺数据当成全部日志；
  - **CPA 侧 `debug` 关掉、日志目录设 200MB 硬上限**（生产配置变更，见下）；
  - **清退 311MB 历史积压轮转文件**（生产数据操作，见下）。

- **测试（Tests）**：测试 17 从「查源码字符串」升级为**真跑函数**——覆盖 8 种截断形态（数组元素中间、键名、冒号后、数字中间、嵌套对象、字符串转义处、深层嵌套、完整 JSON 不受伤），断言每种都能解析、救回行数达标、且救回的元素完整无断裂；另真跑 `isTruncatablePath` 验证 11 种路径形态（含 `/v0/management/logs` 这种拼完版本前缀的真实形态）。另断言：logs 路由改用 `requestCpaManagement`、`truncated` 被透传、前端有 `state.logTruncated` 与 `cpa-logs-truncated` 提示条、提示文案含「已达 8MB 上限被截断」。`npm test` 全绿（EXIT=0）。
- **自查抓到的真 bug（Self-Caught Bug）**：初版白名单写成 `/^\/logs\b/`、`/^\/v\d+\/logs\b/`，而 `requestCpaManagement` 内部会把 `fullPath` 拼成 `/v0/management/logs`——**两个正则都匹配不上**，`truncatable` 恒为 false，等于截断逻辑在生产上完全不生效，24h 档超限照样整体失败。单测只查了「源码里有 `/logs\b`」所以没发现。改为按路径段切分判断，并把 11 种路径形态加进测试真跑。这条是「测试不能只查字符串存在」的活例。
- **顺带修掉（Incidental Fix）**：工作区里遗留了一批未提交的 `lib/analytics/audit-logs.mjs` 缓存优化改动（`resolveAuthAccountInfo`/分页查询加 10 秒 TTL 缓存、新增 `clearAuditLogsCache`），但它有两处重复声明（`getPagedErrorEvents` 内 `now` 声明两次、`getPagedRequests` 内 `term` 声明两次）导致 `npm test` 完全跑不起来。本次修掉这两处编译错误并单独提交，与本次日志修复分开留痕。

- **生产变更（Production，均需用户确认后执行）**：
  1. CPA `config.yaml`：`observability.logs.debug` 由 `true` 改 `false`；`logs-max-total-size-mb` 由 `500` 改 `200`；
  2. 清理日志目录下历史积压轮转文件（约 311MB），保留当前日志文件；
  3. 重启 `cliproxyapi` 容器使配置生效。

## [v2.9.6] - 2026-10-11

修掉总览页 Key 列表「只显示裸哈希、不知道跑的什么模型」：历史账号显式标识为已删除，登记 stealth 提供商，新增「最近模型」列（Upstream Account Identity & Model Column）：

- **问题（Symptom）**：总览页上游凭证统计表里，一批账号显示成「其他上游 + 账号 30df32d10be4fb38」——既不知道这个凭证是谁，也不知道它在跑什么模型。
- **根因二：四层身份元数据全空时甩裸哈希（Bare-Hash Fallback）**：`displayName` 的兜底是 `账号 ${authIndex}`。生产有 19 个账号四层全空——它们的凭证早已从 CPA 删除，只剩 `request_events` 历史流水（最后请求分别在 6 天前、1 天前等）。裸哈希既看不出身份，也看不出「这个账号已经不在用了」。
- **根因三：`stealth/space-bunny-alpha` 未登记（Unregistered Provider）**：8 个账号跑这个模型、累计 1 万多次请求，注册表没有对应 pattern，只能落进「其他上游」。
- **修复（Fix）**：
  - **登记 `stealth` 提供商**，`label` 用原名 `stealth` 不译不美化——Gate 不知道它的中文名，编一个反而是假信息；
  - **历史账号显式标识**：`displayName` 兜底从 `账号 <哈希>` 改为 `已删除账号 <前8位>`，前端对该前缀弱化显示并在 tooltip 说明「该凭证已从 CPA 删除，此处仅保留历史流水」；
  - **新增「最近模型」列**：后端 `items` 增补 `last_model` 字段，前端在名称列后插一列展示；表格 `colspan` 由 7 同步改 8。
- **生产验证（Production）**：部署后实测裸哈希兜底 **13 → 0**；provider 分布 `antigravity` 10 / `gemini` 9 / `stealth` 7 / `codex` 2 / `某某中转` 2 / `opencode` 2 / `stepfun` 1；19 个账号显示为「已删除账号 xxxxxxxx」并带最近模型；活账号正常显示最近模型。
- **测试（Tests）**：测试 14 的未登记模型清单把 `stealth/space-bunny-alpha` 换成真正未登记的 `totally-unknown-model`，并新增断言「stealth 应已登记且 label 用原名」。`npm test` 全绿（EXIT=0）。
- **生产数据操作**：`provider_registry` 表非空时不会重新播种，故对生产库显式 `INSERT` 了 `stealth` 一行（`sort_order=65`，`source=builtin`），与 `INITIAL_PROVIDER_REGISTRY` 保持一致，新库部署时由播种覆盖。

## [v2.9.5] - 2026-10-11

修复「全部历史」档位的提供商推断盲区，让没有 baseline 的账号不再全部掉进「其他上游」（Provider Inference Model-Name Fallback）：

- **问题（Symptom）**：总览页上游凭证统计表中，一批账号的 provider 恒为「其他上游」，尽管它们的模型流水明确指向 Gemini / StepFun / OpenCode。
- **根因（Root Cause）**：`getUpstreamAuthStats` 里 `timeRange='all'` 时 `dailyStatsMap` 是空的（只有 `7d`/`30d` 才填充）、`liveMap` 只有聚合计数不带 `model`，于是 `dStat?.model || live?.model` 两个都是 `undefined`，模型名推断整段被跳过，只剩 `inferProvider({ authIndex })`。而这批账号的 `auth_index` 是随机哈希，匹配不上任何 pattern。**模型名一直躺在 `request_events` 里，只是没人去查。**
- **修复（Fix）**：
  - 新增 `stmtLatestModelByAuth`，用窗口函数取每个账号**最近一次**请求的模型。刻意取最新而非最多——最近一次最能反映账号当前在跑什么，账号换渠道后旧模型不该继续代表它；
  - **没有往 `stmtAuthEventsAggSince` 里加 `model`**：那是热门语句，加列会破坏 GROUP BY 语义；
  - 推断链补三级兜底 `dStat?.model || live?.model || latestModelByAuth.get(authIndex)`，在循环外一次性取完，避免 33 个账号打 33 次全表扫描。
- **测试（Tests）**：新增测试 18「全部历史档位的提供商推断必须用上模型名兜底」——断言新查询存在且未污染热门聚合语句、推断链覆盖 all 档位、循环外一次取完、真实生产账号归属正确。`npm test` 全绿（EXIT=0）。
- **生产验证（Production）**：部署后 `gemini` 9 个、`stepfun` 1 个、`opencode` 2 个账号的 provider 归位。

## [v2.9.4] - 2026-10-11

修复管理台 CPA 日志面板打开即死的故障，改为按 1h/6h/24h 分档加载（CPA Log Panel Dead-on-Open Fix）：
- **问题（Symptom）**：管理台「CPA 日志」tab 打开后日志区一片空白，只显示红色错误 `CPA management response too large`；切 tab、点刷新、点「加载全部历史」均无效，且没有任何本地缓存兜底。
- **根因（Root Cause）**：CPA 的 `/logs?after=` 参数是**秒级时间戳游标**，而前端 `state.logAfter` 初始值为 `0`——传 0 等于请求「从 1970 年到现在」的全部日志。生产 CPA 日志已积累 **320MB**（31 个轮转文件 311M + 当前 `main.log` 2.9M，`/opt/1panel/docker/compose/cliproxyapi/logs/`），全量请求必然被 Gate 的 8MB 上限拦断。「加载全部历史」按钮与「清空 CPA 日志」后处理又把游标显式重置为 0，等于主动请求 320MB。面板文案写的却是「默认读取最近一小时」——文案与实现从上线起就不一致。
- **实测证据（Measured）**：同一 CPA 端点，`after` 取当前秒返回 318 字节、一小时前 264KB、一天前 6.2MB，取 0 返回 336092281 字节（336MB）。
- **修复（Fix）**：
  - `logAfter` 初始值改为 `Math.floor(Date.now() / 1000)`，首次进入只拉最近一段；
  - 「加载全部历史」按钮移除，替换为**最近 1 小时 / 6 小时 / 24 小时**三个分档按钮，`loadLogsRange(hours)` 白名单校验 `[1, 6, 24]`，游标重置目标为「N 小时前」而非 0；
  - 「清空 CPA 日志」后同样按当前档位回退游标，不再置 0；
  - 顺带修正行数上限与渲染上限：24h 档实测 **42314 行**，旧的 3000 行 `logLines` 上限会静默丢掉大半数据（用户点了 24h 却只看到一小截，筛选也在残片上做）；改为 `LOG_LINES_LIMIT = 60000` 覆盖全档位，同时 `LOG_RENDER_LIMIT = 8000` 限制单次 DOM 渲染——6MB 文本一次性塞进 `<pre>` 会卡死浏览器，超出部分经新增的「显示更多」按钮逐段追加，筛选仍在完整数组上进行。
- **超限错误可操作化（Actionable Errors）**：`lib/upstream/management.mjs` 超限时不再抛裸英文 `CPA management response too large`，改为 `CPA 响应超出 8MB 上限（已接收 8.1MB）。请缩小时间范围后重试，不要一次性拉取全量历史。`，并带 `statusCode: 413`；超限后先 `removeAllListeners('data')` 再 `destroy`，避免后续 chunk 继续累计。前端 `request()` 原样透传 `error.error` 到面板状态行，链路已通。
- **测试（Tests）**：新增测试 17「CPA 日志加载游标不得置 0，超限错误必须可操作」——断言 `logAfter` 初始值为当前秒、源码中不存在任何 `logAfter = 0` 路径、提供 1h/6h/24h 入口且 `logs-load-all` 已移除、`loadLogsRange` 白名单校验、超限错误含「请缩小时间范围」可操作提示且裸英文已清除、行数上限覆盖 24h 档且 DOM 渲染限流并提供「显示更多」。`npm test` 全绿（EXIT=0）。
- **生产验证（Production）**：部署后经 Gate 代理实测 1h 1885 行 / 6h 10777 行 / 24h 42359 行均 HTTP 200；`after=0` 返回 HTTP 413 + 上述中文提示；请求错误文件列表仍正常（2087 字节）。
- **未处理（Out of Scope）**：那 311MB CPA 轮转日志属于 CPA 容器数据，本次未清理，需另行确认。

## [v2.9.3] - 2026-10-11

修正组级健康判定把「近期一小时没说话」误标成「暂无数据」的反向误报（Idle vs No-Data Distinction）：

- **问题（Symptom）**：v2.9.2 修掉 OpenCode Zen 的假故障后，管理台上「StepFun 阶跃星辰」组变成了「暂无数据」——但它 7 天有 197 次请求、可用率 100%，只是最近 60 分钟没有流量。运维看到「暂无数据」会以为这组根本没接进来。
- **根因（Root Cause）**：`deriveGroupHealth` 只用一个判据——心跳窗口（最近 60 分钟）请求数是否为 0，为零就返回 `{ dot: '', title: '暂无数据' }`。这把两种完全不同的情况压成了一句话：**「最近一小时没说话」和「从来没说过话」**。前者是空闲，历史可用率已经证明它是通的；后者才是真的没有数据。
- **修复（Fix）**：
  - 心跳窗口零请求时，先看 7 天窗口有没有请求：有历史的返回 `{ dot: 'idle', title: '近期无流量' }`，并派生 `status: 'idle'`，前端渲染灰色 chip「近期空闲」；
  - 7 天同样零请求才维持 `{ dot: '', title: '暂无数据' }` 与 `status: 'no_data'`——绝不显示「运行正常」，没说话不等于说没事；
  - `idle` 既不是 operational 也不是故障，不谎报健康也不冒充故障，大盘 `overall` 聚合不受影响。
- **前端同步（Frontend）**：`admin.html` 的 `statusLabel` 增加 `idle → '近期空闲'` 分支，chip 配色与「暂无数据」同为 `chip-gray`；本地兜底那段判定逻辑同步改为同一口径（零窗口请求时按 `availability != null && req7d > 0` 区分 idle 与 no_data）。
- **测试（Tests）**：测试 16 新增场景 5——StepFun 组（7d 197 次、可用率 100%、窗口零请求）断言 `status === 'idle'`、`health_dot === 'idle'`、`health_title === '近期无流量'`，且可用率仍如实展示。`npm test` 全绿（EXIT=0）。
- **生产验证（Production）**：部署后 `/admin/api/status-summary` 实测三组分别为 Google Gemini `operational` / StepFun `idle`「近期无流量」/ OpenCode Zen `idle`「近期无流量」；大盘 7d 请求 3000 次、24h 178 次，与改前一致无回归。

## [v2.9.2] - 2026-10-11

修复组级健康把「7 天前一次失败」永久钉成重大故障的小样本误报（Group Health Small-Sample False Alarm）：

- **问题（Symptom）**：管理台「OpenCode Zen」组显示 `major_outage`「故障」，但该组当前完全健康——7 天只有 3 次请求，其中 1 次是 404。
- **根因（Root Cause）**：两个时间尺度被混在了一起。心跳 bars 只覆盖**最近 60 分钟**，而 `availability_7d` 覆盖**7 天**；旧实现拿 7 天可用率 < 95% 判红，于是一次 7 天前的 404 把这个当前零失败的组永久钉在故障态，误报了一整天。3 次请求失败 1 次就是 66.67%，那是统计噪声不是服务退化。另外 `deriveGroupHealth` 写好后从未被调用，`buildProviderGroups` 里另有一份内联判定逻辑，两处口径本身就不一致。
- **修复（Fix）**：
  - 新增小样本门槛 `HEALTH_MIN_SAMPLES = 30`：7 天请求数低于此值的组，其可用率不参与健康判定，只在大盘展示；
  - 新增阈值 `HEALTH_WARN_AVAILABILITY = 99`：够样本后仍低于此值才提示「近期整体可用率偏低」，且只提示 `warn`，不再像旧实现那样判 `err`——近期窗口没有失败请求时，没有任何理由把一个组标成重大故障；
  - 让 `deriveGroupHealth` 真正被 `buildProviderGroups` 调用，删掉那份内联的重复判定逻辑，前后端口径收敛到一处；
  - 心跳窗口零请求时返回 `{ dot: '', title: '暂无数据' }` 并派生 `status: 'no_data'`，不再掉进 else 分支显示「运行正常」——没说话不等于说没事。
- **前端同步（Frontend）**：`admin.html` 的本地兜底健康逻辑原先独立使用同一套错误的 95/99 可用率口径，重写为与后端 `deriveGroupHealth` 一致：只看心跳窗口内有无失败请求，绝不拿 7 天可用率判红判黄。
- **测试（Tests）**：新增测试 16「组级健康点不得被小样本历史失败误报」——4 个场景：小样本历史失败不得判故障（OpenCode Zen 事故复现）、近期真实 5xx 必须照样捕获不漏报、大样本慢性退化提示 `degraded`、零流量组返回 `no_data`。同时修正测试 13 的固化断言（`err`/`major_outage` → `warn`/`degraded`），并加固共享库清理（`process.on('exit', cleanup)` + 按 auth_index 模式预清扫），修复 id 水位清理法永远够不到旧残留的棘轮缺陷。`npm test` 全绿（EXIT=0）。
- **生产验证（Production）**：部署后 OpenCode Zen 组不再显示故障。

## [v2.9.1] - 2026-10-11

修复 CPA 非提供商 type 泄漏成假提供商组，并放行中文 provider 名（Non-Provider Type Leak Fix & Unicode Provider Keys）：

- **问题（Symptom）**：v2.9.0 部署到生产后，管理台服务状态面板多出一个名为「meta」的提供商组——1 个账号、disabled、7 天 0 请求、无模型。用户会误以为上游接了新服务。
- **根因（Root Cause）**：CPA 的 `auth-files` 里混有一个 `id: meta-60159e0d4d7e8b0e.json`、`label: meta` 的凭证文件（disabled、无流水、无 baseline、无配额快照），它是 CPA 自己的元数据文件，不是 AI 提供商。v2.8.9 加的 `CPA_NON_PROVIDER_TYPES` 守卫只保护了 `registerCpaProvider` 的注册表写入路径，`lib/analytics/status-summary.mjs` 的 `buildProviderGroups` 却直接把 CPA 返回的原始 `provider` 值当组键，`meta` 因此漏过守卫单独成组。
- **修复（Fix）**：
  - 把守卫抽成导出函数 `isCpaProviderKey()`，注册表写入与状态面板归组共用同一把尺子，杜绝两处口径再次漂移；
  - `buildProviderGroups` 与 `getUpstreamAuthStats` 两条 provider 取值路径都改为经 `isCpaProviderKey()` 校验，不合法的一律归入「其他上游」（`other`），与未登记账号的兜底口径一致；
  - `buildProviderGroups` 从私有改为导出，`quota-manager.mjs` 同步 re-export，使其归组口径可被测试直接覆盖。
- **顺带修正中文 provider 被误杀（Unicode Provider Keys）**：原守卫正则 `/^[a-z0-9][a-z0-9_-]*$/` 只认 ASCII，会把实际存在的中文 provider「自定义中转」（baselines 表账号）误判为非提供商，导致账号掉进「其他上游」。改用 Unicode 属性转义 `/^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u`，放行中文等 Unicode 字母数字开头，同时仍拒绝空值、空格、斜杠与以符号开头。
- **测试（Tests）**：新增测试 15「CPA 非提供商 type 不得在状态面板单独成组」——断言 `isCpaProviderKey` 拒绝 15 种非提供商 type 且放行合法 provider（含中文）、断言 `meta`/`api_key`/空值账号归入 `other` 且不单独成组、断言 other 组账号数与 disabled 计数正确。`npm test` 全绿（EXIT=0）。

## [v2.9.0] - 2026-10-11

彻底移除 Gate 自建号池（Custom Providers & Key Pools），删除其全部死代码，恪守 "CPA 负责凭证与提供商接入，Gate 负责流量统计、调度与审计" 的架构铁律（Complete Removal of Gate Self-Built Provider Pools）：

- **问题定性：号池是越界建设的第二套网关（Pool Was an Out-of-Scope Second Gateway）**：
  - v2.8.7 只剥离了号池的管理界面（Tab、模态框），却留下了整条数据面：`lib/upstream/custom-routing.mjs` 在 [server.mjs](server.mjs) 抢在正常转发前面按模型规则分流，`custom-pool.mjs` 自己做多 Key 平滑加权轮询与 429 冷却，`custom-probe.mjs` 自己探活——等于 Gate 里又建了一个网关；
  - 按既定架构铁律，"建号池" 就是自建一份凭证池，属于 CPA 的职责范围，本次整体移除。
- **生产数据判决：号池已证明自己是纯冗余（Production Data Proved It Redundant）**：
  - 生产库 `custom_providers` 1 行、`custom_provider_keys` 10 个 Key，其中 **8 个与 CPA `opencode` 渠道完全一致**，另 2 个是被 `name` 字段污染的同一把 Key（库中存成 `"0809 oc_sk_xxx"`，拆出真实部分后也在 CPA 里）——**删除零凭据损失**；
  - CPA 侧已具备对等能力：`opencode` 渠道原生注册 9 个免费模型（含号池唯一跑过的 `longcat-2.5-preview-free`），实测容器 `/v1/models` 已吐出；
  - 流水给出最硬的证据：10-10 06:25 走号池 `custom:1:1` 请求 `longcat-2.5-preview-free` **返回 404**，3 分钟后同一模型经 CPA 账号 `8f636ddb6f50ef21` **返回 200**——号池唯一一次真实调用是失败的，CPA 直连同一模型成功。
- **删除的死代码（Dead Code Removed，共 2700 行）**：
  - 号池数据面三模块：`lib/upstream/custom-pool.mjs`（291 行）、`lib/upstream/custom-routing.mjs`（600 行）、`lib/upstream/custom-probe.mjs`（393 行）；
  - `server.mjs`：移除 `findCustomProviderForModel` 分流入口与 `/v1/models` 的号池模型聚合；
  - `lib/routes/admin-routes.mjs`：移除 `/admin/api/custom-providers` 全套 8 个端点（254 行）与仅供其使用的 `maskApiKey` 脱敏函数；
  - `lib/db/sqlite.mjs`：移除 `custom_providers` / `custom_provider_keys` 建表与全部预编译语句，并新增一次性破坏性迁移 `DROP TABLE IF EXISTS` 清掉存量库的死表；
  - `lib/analytics/status-summary.mjs`：移除 `buildCustomProviderGroups`，号池组不再出现在服务状态面板；
  - `lib/core/provider-registry.mjs`：移除 `custom:` 身份特判分支与 `自建提供商` 组名兜底——号池不存在后这些已成为死代码；
  - `admin.html`：移除 `kind === 'custom'` 渲染分支与「号池已删除」幽灵状态；
  - `admin-cpa.css`：移除 580 行号池专属样式（实测这些 class 在 HTML 中零引用）；
  - `tests/test_custom_providers.mjs`（201 行）整体删除，`npm test` 脚本同步摘除。
- **历史流水零丢失、归属更准确（History Preserved & Better Attributed）**：
  - 迁移只删表结构，**不碰 `request_events` 一行审计记录**；唯一那条 `custom:1:1` 流水改由模型名推断落入 `OpenCode Zen`（它的真实上游），不再显示为永不消失的「已删除的号池 #1」幽灵组；
  - 以生产库副本只读核对：号池组消失后总请求量不变（2998 + 1 = 2999），14 个 baseline 账号的 CPA 直连分组零漂移。
- **测试（Tests）**：
  - 测试 13 保留组级聚合覆盖，改用 CPA 直连 `claude` 账号做夹具（22 次中 4 次 429，验证可用性 < 95% 判 `major_outage`），不再构造号池数据；
  - 测试 14 摘除号池相关断言；`npm test` 全绿（EXIT=0）。

## [v2.8.9] - 2026-10-11

全面删除提供商推断硬编码，建立 `provider_registry` 唯一真相源（Provider Registry as Single Source of Truth）：

- **删除源码中的真实生产账号身份（Removed Hardcoded Production Account Identity）**：
  - 彻底移除 5 处把真实 CPA 账号 `auth_index` 写死在源码里的 StepFun 特判：`admin.html` 的 `resolveEventProvider` 与 `getAuthDisplayName`、`lib/analytics/audit-logs.mjs` 的 `resolveAuthAccountInfo`、`lib/analytics/status-summary.mjs` 的两处 `isStep` 判定；
  - 该哈希此前已随 v2.8.7 / v2.8.8 提交并部署到生产，属于既有的设计缺陷：账号重登后 `auth_index` 即变，特判立刻失效，账号随之掉进「未知上游」——这正是 `8f636ddb6f50ef21` 长期无法正确归属的根因；
  - 现在账号级身份一律来自 `upstream_auth_baselines`（由 Keeper `usage_identities` 导入）或 CPA 同步，源码里不再存在任何账号身份。
- **新增提供商注册表（New Provider Registry）**：
  - 新建 `lib/core/provider-registry.mjs` 与 `provider_registry` 表，镜像 `lib/core/pricing.mjs` 的 seed-then-override 结构：内置 11 家提供商规则仅在表空时播种，可被 DB 覆盖，用户改过的规则永不被重启覆盖；
  - 每条规则含 `label` / `model_patterns` / `auth_patterns` / `sort_order` / `source`（`builtin` / `cpa` / `manual`）；
  - `auth_patterns` 只存通用前缀（如 `step`），绝不放具体账号 `auth_index`；写入接口带守卫，形如账号哈希的长串十六进制一律拒绝并提示改用 CPA 同步；
  - `inferProvider()` 为全站唯一推断入口，优先级固定 `auth_patterns` → `model_patterns`；未命中返回空 key，**绝不猜测**——宁可显示「未登记」让人补，也不制造看似合理其实错误的归属。
- **服务端 4 处推断全部收拢（Collapsed All Server-Side Inference）**：
  - `lib/analytics/status-summary.mjs`：删除 `PROVIDER_GROUP_LABELS` 标签表与整条 `startsWith` 推断链，组名改由注册表提供；
  - `lib/analytics/audit-logs.mjs`：`inferModelProvider` 的 12 个 `includes` 分支改为委托注册表；
  - `lib/routes/admin-routes.mjs` 模型目录的 `provider` 字段改由注册表推断；
  - `lib/upstream/sync.mjs`：CPA 同步成功后自动把观察到的 provider 登记进注册表（`source='cpa'`），上游新增提供商零改代码；
  - `lib/proxy/transport.mjs` 的 `provider_type` 协议分支与 Antigravity 专属配额调用保持不变——那是协议指纹与渠道适配，不是身份推断。
- **口径零漂移验证（Zero Attribution Drift Verified）**：
  - 以生产库副本做只读逐账号核对：28 个账号中 27 个标签与改前完全一致，1 个由「其他上游」修正为「OpenCode Zen」，**0 个退化**；
  - 曾靠硬编码特判的 `15bd1277482c540c`（465 次请求，`step-3.5-flash`）现由注册表 `step-` 模型规则正确识别为 StepFun，证明硬编码可安全移除；
  - 新增回归闸门断言 20 个现有生产模型的归属逐条不变，含 `-free` → OpenCode Zen 这条易丢的历史口径（`longcat-2.5-preview-free` / `mimo-v2.6-flash-free` 依赖它）。
- **管理台补登记端点（Admin Registry Endpoints）**：
  - 新增 `GET /admin/api/provider-registry`、`POST /admin/api/provider-registry`、`DELETE /admin/api/provider-registry/:key`，对齐既有 `model-prices` 端点形态；
  - 内置项（`source='builtin'`）拒绝删除——删了也会被下次重启重新播种，给了按钮只会误导；
  - 未登记账号在状态面板显示为「未知上游 / 其他上游」并保留上游原名，不再伪装归属。UI 配置页面下个迭代补齐，端点已就绪。
- **测试（Tests）**：
  - 新增测试 14「提供商注册表统一推断」：20 个生产模型回归闸门、未登记不猜测、auth 优先于 model、自建号池 `custom:` 身份优先于模型名、账号哈希无法被反推、manual 即时生效、内置项拒绝删除、哈希写入被守卫拦截、组名兜底文案；
  - 测试 13 清理机制未变，仍按自增 id 水位回收，不碰真实流水。

## [v2.8.8] - 2026-10-10

服务状态按提供商分组监测与流水 Key 筛选全量化（Grouped Service Status by Provider & Complete Key Filtering）：

- **服务状态按提供商分组监测（Grouped Service Status by Provider）**：
  - 重构 `status-summary.mjs`，新增 `buildProviderGroups` 与 `buildCustomProviderGroups`，把原先「一个上游账号一张卡」的扁平刷屏列表改为按提供商分组的组级看板；
  - 每组输出组级健康点（正常 / 降级 / 故障）、组内账号数或 Key 数与冷却数、模型规则、7 天可用性与最近 60 分钟合并心跳；
  - 组级心跳按分钟槽合并而非把各账号 bars 首尾相接，恒为 60 格；空槽不再按 1 次请求虚增，柱状图与总数口径一致；
  - 组级延迟与首字 TTFT 按带延迟的分钟槽加权汇总，避免小流量账号的均值被放大。
- **自建号池纳入分组统计（Custom Provider Pools in Status Grouping）**：
  - Gate 自建号池的 `custom:<providerId>:<keyId>` 身份按 providerId 单独归组，读取 `custom_providers` / `custom_provider_keys` 真实元数据；
  - 该类身份在 CPA 直连归组中被显式跳过，杜绝同一个池被重复计入「自建提供商」大组导致组数翻倍、请求量双算；
  - 号池已从后台删除但流水仍留有历史事件时，明确标记为「号池已删除」而非伪装成「已停用」，避免误导用户去拨开关救活。
- **流水 Key 筛选下拉全量化（Complete Key Filter in Request Logs）**：
  - 修复「筛选密钥」下拉只列出当前页流水中出现过的 Key 的问题，新增 `ensureKeysLoaded()` 独立拉取全量 Key 列表（带 30 秒 TTL 缓存），与流水数据解耦；
  - 管理员模式下打开流水页签即预取全量 Key，成员模式不受影响。
- **成员端状态接口修复（Member Status Endpoint Fix）**：
  - 修复 `/api/member/status-summary` 读取从未存在的 `summary.providers` 字段导致成员端状态卡片恒为空的问题，改为下发聚合后的 `provider_groups`；
  - 聚合组仅含组名、组级健康与合并心跳，不向成员端暴露任何单账号 `auth_index` 身份。
- **测试与回归（Tests & Regression）**：
  - 新增测试 13「服务状态按提供商分组聚合」，覆盖自建号池元数据、组级健康点收敛、组级心跳按槽合并且与 `requests_7d` 自洽、自建号池与 CPA 直连不重复计入；
  - 该用例的清理改为按自增 id 水位精确回收本次插入行，不再按 `auth_index` 批量删除，避免误删同名的真实生产流水。
- **部署后修正：CPA 通道拒绝非提供商类型污染注册表（Post-Deploy Fix）**：
  - 生产部署 v2.8.9 后实测发现 CPA 的 auth-files 会吐出字面量 `provider=meta`，`registerCpaProvider` 不辨类型直接登记，导致注册表多出一条无流水、无 baseline、无配额快照的幽灵条目，搅乱管理台列表；
  - 该条目 `auth_patterns` 为空永远匹配不到任何账号，对推断无害，但属于上游数据未校验就入库；
  - 新增 `CPA_NON_PROVIDER_TYPES` 拒绝清单（`meta` / `unknown` / `api_key` / `oauth` / `file` 等 18 项非提供商语义的 type 值），从源头收口；测试 14 补断言覆盖；
  - 已清除生产库中该幽灵行，注册表终态为 11 条内置规则。
- **生产部署验证（Production Deployment Verified）**：
  - 服务 `active`，NRestarts 0，5 个绑定端口（含两个 Docker 网桥）全部 Listen，8316 / 8317 的 `/admin` 均返回 200；
  - `provider_registry` 由 `initProviderRegistry()` 自动建表并播种 11 条内置规则，`sort_order` 迁移正常；
  - 数据零丢失：`request_events` 51288 → 51288，`custom_provider_keys` 10 → 10，`custom_providers` 1 → 1，`upstream_auth_baselines` 14 → 14；
  - 真实流量分组正确渲染：Google Gemini（17 账号 / 2799 请求）、StepFun 阶跃星辰（1 账号 / 197 请求）、OpenCode Zen、自建号池 OpenCode-Zen 各自独立成组；
  - 曾依赖硬编码哈希的 `15bd1277482c540c`（197 次请求）现由注册表 `step-` 模型规则正确归入 StepFun，硬编码移除得到生产验证。

## [v2.8.7] - 2026-10-10

Token 监控全维度高精度重构、上游凭证列表净化与 Gate 架构边界收拢（Precision Token Analytics, Pure Upstream Credentials & Architecture Boundary Alignment）：

- **Token 监控高精度模型折算与全维度聚合（Model-based Pricing & Full-Spectrum Token Analytics）**：
  - **废除硬编码 default 定价折算**：重构历史用量分析引擎 `audit-logs.mjs`，每日预估花费改由各模型真实消耗的 Prompt / Completion / Cache 结合模型定价矩阵精准折算，解决混合模型调用时花费严重失真的问题；
  - **内存实时用量双轨合并（Dual-track Live Usage Merge）**：将当前尚未刷盘的 `liveUsage` 内存缓冲实时合并进用量趋势的日构成图表与模型排行中，实现趋势图与用量大卡零延迟同步；
  - **全量历史跨度支持（All-Time Analytics Range）**：新增 `stmtDailyAllTimeGrouped`、`stmtModelAllTimeDetailed` 等 SQLite 预编译语句，用量趋势支持全量历史 `days='all'` 跨度查询与平滑渲染；
  - **AI 提供商维度聚合推断（Provider Token Breakdown）**：新增 `inferModelProvider` 智能解析引擎，将模型用量归类映射至 OpenAI Codex、Google Gemini、Anthropic Claude、StepFun、OpenCode Zen、DeepSeek 等独立提供商，输出调用次数、均耗、缓存命中率与份额占比，并在前端用量趋势中新增专属看板。
- **上游凭证列表全面净化（Purified Upstream Credentials List）**：
  - 剔除 `lib/upstream/sync.mjs` 中拉取 `/v0/management/openai-compatibility` 并将第三方 API Key 伪装为 `plan_type: 'api_key'` 混入 `cachedUpstreamQuotas.accounts` 的逻辑；
  - 上游凭证（Auth Files）聚焦以 Codex、Antigravity 为代表的真实物理账号与滑动周期限额，彻底移除外部按量 Key 刷屏与遮挡真实配额的问题；
  - 同步清理 `admin.html` 中针对外部按量凭证的临时分支代码。
- **Gate 架构职责收拢与号池管理界面彻底剥离（Gate Architecture Boundary Focus）**：
  - 恪守 "CPA 负责凭证与提供商接入，Gate 负责流量调度、监控与统计" 的核心架构铁律；
  - 从 Gate 管理台主导航与页面中彻底移除「AI 提供商与号池」管理 Tab（`tab-page-providers`）、模态框与残留控制器；
  - 提供商与物理凭证的管理职责收拢于 CPA，Gate 专注负责流量转发、数据面流控、用量监控大盘与全链路审计。

## [v2.8.6] - 2026-10-10

修复 CPA 控制台 OpenCode 提供商运行时 sheetSize 报错、补齐品牌图标与全套管理功能（Fix OpenCode Provider sheetSize Crash, Branded Card Icon & Full Management Parity）：

- **彻底根治 sheetSize 崩溃异常（Fix sheetSize TypeError）**：
  - 在 `management.html` 提供商规格映射表 `Sw` 中完整注册 `opencode` 抽屉配置（`sheetSize: "lg"` 与全套表单能力开关），彻底消除点击 OpenCode 资源时 `Cannot read properties of undefined (reading 'sheetSize')` 的 React 崩溃。
- **高辨识度 OpenCode 矢量品牌 Logo 重构（Branded Vector Card Logo）**：
  - 修复此前 SVG Data URI 中由于 `%2523` 二次转义及引号缺失导致浏览器 XML 解析失败、在浅色与深色背景下完全隐形的缺陷；
  - 精准注入用户指定的 OpenCode 原生「中空矩形回字框」矢量品牌 Logo（`fill-rule="evenodd"`，浅色模式纯黑 `#000000`、深色模式纯白 `#ffffff`），同步注册至导航栏 `aS` 与全局统计视图 `YD`。
- **全面对齐上游提供商核心能力（Full Feature Parity）**：
  - **连通性探活测试**：修复 `pE` 测试函数中对 `opencode` 品牌的拦截逻辑，支持单 Key 独立探活与全部 Key 批量探活；
  - **零配置与多 Key 表单**：初始化表单 `OE` 默认填充端点与模型字段，多 Key 列表支持按 Key 独立配置权重与代理；
  - **增删改查与状态全链路打通**：对齐保存更新（`C`）、新建提供商（`S`）与全局/局部禁用开关（`T`），支持完整的增删改查生命周期管理。

## [v2.8.5] - 2026-10-10

OpenCode 升级为独立第一类 AI 提供商与协议级全自动指纹伪装（Native First-Class OpenCode AI Provider with Dedicated Protocol Cloaking & Card Logo）：

- **CPA 原生控制台与 Gate 全链路双轨独立支持（Dual First-Class Provider Architecture）**：
  - **CPA 原生管理控制台专属展示**：对齐用户管理心智（"CPA 负责管理凭证，Gate 负责统计调度"），对上游直出单页管理控制台 `management.html` 进行深层原生定制；
  - **左侧导航栏独立 OpenCode 品牌**：将 OpenCode 彻底从「OpenAI 兼容」通用分组中拆分独立，在左侧 AI 提供商列表中独立设为一级项目，徽章实时呈现活跃密钥数；
  - **专属矢量中空矩形卡片 Logo**：无缝注入专属深浅主题卡片矢量图标，支持高对比度展示；
  - **专属路由与极简管理**：接入 `/ai-providers/opencode` 独立视图，点击左侧菜单直达 OpenCode 10 密钥号池，支持专属 Base URL、模型探测与全套增删改查。
- **协议级全自动指纹与反 429 伪装引擎（Dedicated Protocol Cloaking Engine）**：
  - **CLI 客户端指纹注入**：针对 OpenCode 仅允许官方 CLI 调用机制，底层自动注入官方 UA（`opencode/1.18.35`）、`x-opencode-client: cli` 与 `x-opencode-project: global`；
  - **逆向毫秒时间戳 Base62 会话/请求 ID（genOpenCodeId）**：在 Node.js 出站代理层完整实现毫秒时间戳取反/正向掩码与 Base62 随机字符串拼接算法，自动生成合规的 `x-opencode-session`、`x-opencode-session-id` 与 `x-opencode-request`；
  - **Dummy Tools 工具集自动注入**：针对 OpenCode 免费模型必须包含 tools 字段的限制，在出站请求体重写时自动补齐 `read`、`bash`、`write` 占位工具与 `tool_choice: "auto"`，解除 400 语法校验封锁；
  - **强制上游流式与非流式聚合转换（SSE-to-JSON Aggregator）**：针对客户端发起非流式请求场景，底层自动向上游请求 SSE 流并在网关层透明聚合成标准 Chat Completion JSON 响应，彻底根除 429 与非流式报错。
- **零配置多 Key 号池管理与全量探针联动（Zero-Config Pool & Probing）**：
  - **快速预设与模态框升级**：一键预设升级为 OpenCode Zen 原生模型池，自动绑定 `https://opencode.ai/zen/v1` 与 `*-free`、`deepseek-*` 通配规则；
  - **免配置 API 密钥录入体验**：添加 Key 时展示专属原生协议提示条，用户只需填入 API Key 即可，无需手动编写 Header 或进行复杂客户端伪装；
  - **原生探活探针加固**：探活请求自动搭载完整时间戳会话与 Dummy Tools，杜绝探活阶段 400/429 假死误报。

## [v2.8.4] - 2026-10-10

深度分页性能优化与全维度时间范围筛选扩展（Deep Pagination Deferred Join & Multi-Span Time Range Filter）：

- **大偏移量深度分页延迟关联与游标加速（Deferred Join & Seek Pagination Optimization）**：
  - **延迟关联子查询（Deferred Join）**：在 `getPagedRequests` 与 `getPagedErrorEvents` 中采用覆盖索引子查询提取目标页 `id`，再做回表连接（`JOIN (SELECT id FROM ... LIMIT ? OFFSET ?) p ON r.id = p.id`），彻底消除百万级日志大偏移量分页时反序列化全量大字段的性能瓶颈；
  - **游标分页能力扩展**：新增 `before_id` 寻址支持，支持 $O(1)$ 游标瞬时定位；
  - **索引加固**：为 `request_events` 新增 `(ts DESC, id DESC)` 复合索引 `idx_events_ts_id`，与 `error_events` 保持一致，最大化时间与主键逆序扫描吞吐。
- **全维度时间跨度筛选（Multi-Span Time Range Filtering）**：
  - **前后端全量联动**：后端原生支持 `time_range`（`all`、`today`、`24h`、`3d`、`7d`、`30d`）及自定义 `since`、`until` 时间戳区间；
  - **请求流水与故障中心控制台升级**：请求流水与故障中心均新增「时间跨度」轻量级下拉筛选菜单，支持即时按天、按小时动态切片，且自动联动分页与防抖搜索；
  - **成员端点对齐**：`/api/member/requests` 同步支持时间跨度与游标传参。
- **回归测试覆盖**：
  - 增强 `tests/test_gate_pagination.mjs`，覆盖 `since`、`until` 时间过滤与 `beforeId` 游标寻址断言，全量集成测试 100% 通过。

## [v2.8.3] - 2026-10-10

全量历史用量统计看板与服务端真分页架构升级（All-Time Usage Analytics & Server-Side Pagination）：纠正历史累计与今日消耗口径混淆，解除 300 条伪分页限制并支持全量流水与故障中心真翻页：

- **全量历史用量统计与双轨看板（All-Time Token Analytics & Dual-Track Dashboard）**：
  - **历史总用量聚合落盘**：SQLite 数据库增加全量历史统计预编译语句（`stmtDailyAllTime`、`stmtDailyAllTimeByKey`、`stmtDailyAllTimeByAllKeys` 及分模型定价统计 `stmtModelAllTime`），跨全量日表 `usage_daily` 聚合历史 Token、请求数并叠加内存实时未落盘 `liveUsage`；
  - **总览卡片双轨直观展示**：Overview 顶部首张与第四张大卡片升级为“今日 / 累计 Tokens”与“今日 / 累计请求”，通过高亮徽章显式展示全量生命周期累计总用量与总请求数，彻底告别午夜归零导致的“十几 B 用量变成个位数”误解；
  - **密钥表格多周期用量**：Key 管理列表同时展示【今日用量】与【累计消耗】（如 `2.1 M · 累计 15.82 B`），清楚了解各 Key 生命周期累计额度与消耗；
  - **成员模式专属信息补齐**：`/api/member/info` 端点补齐今日与累计用量、费用折算与配额详情，消除成员看板显示空白。
- **请求流水与故障中心服务端真分页（True Server-Side Pagination Architecture）**：
  - **彻底废除 300 条限制**：前端不再受限于内存假分页与写死 `limit=300` / `limit=200`，全面接通后端的真服务端分页接口（`getPagedRequests` 与 `getPagedErrorEvents`）；
  - **多维过滤与防抖搜索联动**：状态过滤（2xx/4xx/5xx/拦截/缓存）、密钥筛选、上游账号筛选与搜索关键词均直接转为服务端查询，搜索输入增加 300ms 智能防抖；
  - **故障中心分页控制台**：故障中心页面新增与流水一致的分页控制台（每页 25/50/100 条自定义切换、上一页/下一页、总记录数徽章实时联动）；
  - **索引加固**：数据库增加 `(ts DESC, id DESC)` 与 `(key_id)` 索引，保障超大规模日志下毫秒级极速分页。
- **全量回归测试 100% 通过**：
  - 更新 `tests/test_gate_pagination.mjs`，验证全量历史累计与分页契约；全套 12+ 自动化测试套件持续绿灯通过。

## [v2.8.2] - 2026-10-09

前端性能彻底根治与提供商敏感信息折叠隐藏保护：靶向按需刷新机制消除并发排队与后台无意义重绘，卡片默认折叠收起与密码圆点遮罩护航隐私：

- **提供商已保存信息折叠收起与密码级隐私保护（Privacy-First Collapsed Cards & Password Masking）**：
  - **手风琴折叠默认收起**：手风琴卡片视图（Accordion View）默认将全部已保存提供商置于折叠收纳状态，仅呈现轻量顶栏摘要，彻底隐藏详细模型规则与号池凭据；卡片头部支持一键点击整栏展开或收起，并提供全局“全部展开 / 全部收起”快捷按钮；
  - **密码圆点遮罩与眼睛显隐切换**：号池 Key 默认以密码圆点 `••••••••••••` 掩码呈现，杜绝录屏与屏幕共享泄露；提供直观的眼睛图标按钮（查看/隐藏），支持按需展开脱敏明文或一键切换全站密钥显隐，独立复制按钮安全复制真实脱敏 Key；
  - **分栏侧栏工作台加固**：工作台接管规则与调度策略精简聚合，敏感参数受保护呈现。
- **根治向服务器拉取慢与使用卡顿根因（Targeted Active-Tab Refreshing & 60 FPS Performance Architecture）**：
  - **瓶颈根因锁定**：原先 `refreshAll()` 轮询与切屏触发时无差别并发派发 10~11 个重型 API 请求，触碰浏览器 6 连接上限触发严重队头阻塞（Queued / Stalled），且返回后在后台全量重绘非活动 Tab 的 300 条流水 DOM 与图表，引发垃圾回收（GC）与主线程严重掉帧；
  - **靶向按需精准拉取（Targeted Refresh）**：全面升级为 `refreshCurrentTab()` 机制，仅维持轻量全局健康探活（毫秒级返回），并仅对当前激活的工作区 Tab（如 `providers` 或 `quotas`）进行针对性数据拉取与 DOM 局部渲染；非活动页面零重绘、零网络开销；
  - **切屏防风暴自愈保护**：`visibilitychange` 唤醒监听增加 5 秒节流防抖门禁，彻底杜绝多桌面窗口切屏时的并发风暴；
  - **实测收益**：并发请求由 11 个锐减为 1~2 个，网络等待时间由秒级阻塞骤降至 50ms 瞬时响应，后台 DOM 节点废弃与 GC 停顿彻底归零。
- **测试门禁与 AOCI 认知层全量对齐**：
  - 补充前端 AST 回归门禁，验证语法完整性、靶向刷新与折叠防护锁；测试 100% 通过。

## [v2.8.1] - 2026-10-09

AI 提供商与号池管理界面重构加固与报错根治：全新 Master-Detail 分栏侧栏与卡片手风琴折叠双模视图，根治提供商页面过长裸露需一直滑动的痛点，并修复单 Key 探活响应解析与脱敏密钥复制错误：

- **提供商分栏侧栏与手风琴折叠双模交互（Master-Detail & Accordion Dual-Mode UI）**：
  - **分栏侧栏中枢（默认模式）**：左侧提供商导航列表，支持实时搜索过滤、类型徽章与 Key 状态摘要（健康/冷却/停用），右侧独立承载选中提供商的工作台，彻底终结纵向无限滑动；
  - **手风琴折叠视图（Accordion View）**：支持在顶部自由切换视图模式，各卡片默认收纳或支持独立折叠展开，并配备一键全部展开/全部折叠快捷控制；
  - **号池表格局部滚动保护**：号池 Key 表格容器自适应最大高度滚动，避免过多 Key 撑爆外层页面，体验平滑利落。
- **单 Key 探活响应解析与字段契约双向对齐（Key Probe Response Contract Alignment）**：
  - **根本原因**：后端探活端点返回 `{ success: true, result: { ok: true, limit_remaining, ... } }`，前端原先错误判断未定义的 `data.ok`，导致即便探活通过也误报“Key 探活失败: 未知错误”；
  - **双向修复**：前端兼容判断 `data.ok || (data.success && data.result?.ok)`，并正确从 `data.result.limit_remaining` 提取剩余额度提示；后端补充输出顶层 `ok` 与 `limit_remaining` 字段，实现双向契约闭环。
- **号池密钥脱敏呈现与复制体验优化（Key Mask & Clipboard Fix）**：
  - **脱敏密钥对齐**：对齐后端返回的 `api_key_masked`，修复表格中 Key 字符呈现空白及点击复制传入 undefined 的问题；
  - **一键安全复制**：点击直接复制有效脱敏凭据并触发 Toast 成功反馈。
- **AOCI 全量认知验证与自动化测试 100% 通过**：
  - 更新 AOCI 认知层（CSS、HTML、Routes）；通过 `aoci verify`, `aoci check`, `aoci guide` 终态证明；通过全部集成与单测门禁。

## [v2.8.0] - 2026-10-09

原生支持自定义 AI 提供商与多 Key 监控号池架构（Custom AI Providers & Key Pools），彻底免除 CPA 二改升级风险与外部反代胶水层：

- **原生双轨上游分流与动态路由架构（Dual-Track Native Dynamic Upstream Routing）**：
  - **根本架构决策**：放弃难以持续维护且升级阻断的编译型 CPA (Go) 二改方案，在 Gate 网关内核原生扩展多上游调度分流；
  - **模型通配符规则匹配（Wildcard Model Matching）**：在 `lib/upstream/custom-routing.mjs` 中实现高效正则通配引擎，支持精确模型名（如 `deepseek-v4-flash-free`）、前后缀通配（`*-free`、`*:free`、`openrouter/*`）与全局通配（`*`），精准接管特定渠道模型；
  - **出站代理与流式反压**：复用轻量 HTTPS/HTTP 出站代理通道，支持 SSE 流式事件解析、Usage 提取、Token 估算及 `lib/core/outbox.mjs` 请求日志归因。
- **客户端指纹与反 429 伪装引擎（Client Fingerprint Spoofing & Header Injection）**：
  - **OpenCode Zen 429 规避**：针对 OpenCode 免费模型池，出站自动注入最新 CLI 指纹（`User-Agent: opencode/1.18.18 ai-sdk/provider-utils/4.0.38 runtime/bun/1.3.14`、`x-opencode-client: cli`、`x-opencode-project: global`），彻底规避官方对非命令行请求的 429 封禁拦截；
  - **自定义请求头支持**：提供商支持配置自定义 JSON 请求头，由网关在出站时安全注入，无需客户端重复配置。
- **多 Key 号池平滑加权轮询调度与 429 冷却自愈（Smooth Weighted Round-Robin & Failover State Machine）**：
  - **调度策略**：在 `lib/upstream/custom-pool.mjs` 实现 Nginx 平滑加权轮询（Smooth Weighted Round-Robin）、标准轮询与高优先级故障降级（Priority-Failover）；
  - **自愈状态机**：解析上游 429 的 `Retry-After` 头，以壁钟衰减算法标记 Key 冷却状态（`cooldown_until`）；在请求头尚未提交时，自动故障转移到号池中下一个健康 Key 重试，对调用方完全透明；
  - **内存缓存与快照同步**：内存维护常驻号池对象，支持在后台变更时毫秒级无锁重载。
- **吸收 openrouter-monitor 成熟监控契约与双 Key 追踪（Dual-Key Quota & Activity Monitoring）**：
  - **双 Key 契约**：在 `lib/upstream/custom-probe.mjs` 移植 `openrouter-monitor` 核心算法；标准推理用 `api_key` 探活与拉取 `limit`, `limit_remaining`, `usage_daily`；可选管理密钥 `mgmt_key` 经由 `/api/v1/activity` 追踪今日精准请求次数与历史模型分布；
  - **多类型探活支持**：涵盖 OpenRouter 额度查询、OpenCode Zen 鉴权探针与通用 OpenAI 兼容 `/models` 端点探活。
- **前端 Aozora UI 原生卡片与号池监控大盘（Frontend Dashboard Integration）**：
  - **侧边栏专属 Tab**：在工作区集成「AI 提供商与号池 (Providers)」，并在成员模式下严格实施租户安全隔离；
  - **指标概览条与卡片列表**：直观展示提供商启用状态、Key 总量、活跃/冷却分布、今日调用计数；卡片清晰呈现接管规则胶囊、出站端点、调度策略与健康指示灯；
  - **号池表格与交互操作**：掩码 Key 点击一键复制、额度消耗进度条（绿/橙/红）、冷却倒计时（秒数衰减）、一键在线探活与解除冷却功能；
  - **预设模板弹窗**：提供 OpenCode Zen 免费模型池、OpenRouter 聚合双 Key 池与通用 OpenAI 兼容端点一键填充模板。
- **全套自动化测试套件与安全门禁**：
  - 新增 `tests/test_custom_providers.mjs`，覆盖通配符规则匹配、数据归一化算法、加权轮询调度、429 故障冷却自愈；
  - 纳入 `npm test` 自动化回归门禁，100% 通过包括 AST vm.Script 在内的全部测试。

## [v2.7.6] - 2026-10-09

前端显示与交互全链路地毯式排查加固：修复模型定价规则字段名错位导致显示/编辑空白、流水与错误日志提供商错误兜底Antigravity、流水时间戳跨天与毫秒级防御、Key配额进度条NaN防御以及凭证卡片外部按量渠道友好展示。

- **模型定价规则表格与编辑弹窗显示修复（Model Pricing Pattern Field Misalignment Fix）**：
  - **根本原因**：后端返回定价规则对象字段名为 `pattern`，前端此前错误读取未定义的 `p.model_pattern`，导致模型模式列展示全为空白，且点击“编辑”按钮时表单标题和输入框中的模型模式均被置为空串；提交保存时前端曾单传 `model_pattern`，与后端的必填校验 `pattern` 产生歧义；
  - **修复实现**：前端全链路读取 `p.pattern || p.model_pattern || ''`，定价规则表格正确回显各模型匹配模式，点击“编辑”准确回填当前模式与价格倍率；保存与后端接口全链路支持 `pattern` 与 `model_pattern` 双向兼容校验。
- **请求流水与错误中心上游提供商精准推断（Provider Fallback Hardening）**：
  - **根本原因**：流水与错误中心此前在无显式 provider 时暴力兜底 `'antigravity'`，导致未标记的 Claude、Codex 或外部兼容渠道被错误冠以反重力标签；
  - **修复实现**：引入 `resolveEventProvider(ev)` 智能反查模型前缀（`step-*` 归为 StepFun、`claude-*` 归为 Claude、`gemini-*` 归为 Gemini、`gpt-*` 归为 Codex），未知时回落为中立的“其他上游”，彻底杜绝误标。
- **实时流水时间戳跨天与毫秒级防御（Logs Timestamp Formatting & Cross-Day Display）**：
  - 增加 `ev.ts > 1e11 ? ev.ts : ev.ts * 1000` 秒/毫秒双重防御；
  - 时间列增加月-日（如 `10-09 18:32:01`）展示，hover 悬浮查看完整 ISO 统一时间，便于跨天翻页排查。
- **API Key 配额进度条 NaN 精度防御（Key Quota Progress NaN Guard）**：
  - 针对空用量进行 `Number(k.today_usage) || 0` 防御转换，限制 ratio 落在合法区间 `[0, 1]`，彻底杜绝 `width: NaN%` 导致的异常渲染。
- **凭证概览卡片外部按量渠道展示优化（Upstream Card External Key View）**：
  - 针对无配额滑动窗口的兼容渠道（StepFun / OpenRouter / Custom），在紧凑列表与大卡片中明确展示「外部按量/兼容凭证 · 无周期配额限制」，消除误导性的“额度未知，等待 CPA 返回有效数据”黄字警告。
- **全局模型别名数据结构数组形态防御（Global Model Aliases Array Defense）**：
  - 在 `admin-routes.mjs` 中对 CPA 返回的 `model-aliases` 增加 `Array.isArray` 结构防御，避免对象遍历提取数组下标索引。

## [v2.7.4] - 2026-10-09

可用模型目录数组索引修复、OpenAI 兼容渠道（StepFun 阶跃星辰等）精准映射与凭据大盘反重力误标彻底纠正。

- **可用模型目录数字索引缺陷彻底修复（Model Catalog Array Index Bug Fix）**：
  - **根本原因**：`getAllModelPrices()` 返回 SQLite 行对象数组 `[{ pattern, prompt_price, ... }]`。原端点对数组执行 `Object.entries(priceMap)` 迭代，导致变量提取了数组下标索引 `"0"`, `"1"`, `"2"`...，进而将模型 ID 渲染为一连串递增数字，且提供商全被误判为 `general`；
  - **修复实现**：直接遍历价格对象数组，提取每行的 `item.pattern` 建立模型目录，彻底清除数字 ID，恢复模型真实名称（如 `claude-3-5-sonnet-20241022`、`gemini-2.5-pro` 等）与提供商；
  - **兼容渠道模型自动补充**：在目录聚合中同步拉取 CPA 的 `/openai-compatibility` 兼容渠道配置，将阶跃星辰（`step-*` 系列）等自定义上游配置的模型自动注入可用模型列表，并正确标注其兼容渠道来源。
- **上游凭据大盘 OpenAI 兼容渠道识别与 Antigravity 误标根治（OpenAI-Compatibility Trace Resolution & Antigravity False-Fallback Fix）**：
  - **根本原因**：CPA 对 `openai-compatibility`（如阶跃星辰 StepFun）转发时生成 16 进制链路 Trace ID `15bd1277482c540c`。因该渠道不属于 OAuth 授权文件（`/auth-files`），在网关凭证统计大盘遍历 `request_events` 时未能匹配到 OAuth 账号，且代码原先采用了 `provider || 'antigravity'` 的暴力兜底，导致用户配置的阶跃星辰渠道被冠以“反重力 Antigravity 账号 15bd1277482c540c”，且因缺失 Google 配额桶而显示周期额度为破折号 `—`；
  - **兼容渠道凭据双向同步**：在 `lib/upstream/sync.mjs` 中接入 `/v0/management/openai-compatibility` 凭据解析，同步登记其 `auth-index` 与掩码 Key，提供商准确归类为 `stepfun` / `openrouter` 等；
  - **大盘聚合与审计精准解析**：在 `lib/analytics/status-summary.mjs` 和 `lib/analytics/audit-logs.mjs` 中消除盲目兜底 `antigravity`，将 `15bd1277482c540c` 与 `step-*` 系列模型准确映射为「阶跃星辰 StepFun」，周期额度列明确展示「外部按量渠道 · 无需 5h 滚动限制」，彻底消除用户疑虑。
- **全套集成测试验证通过**：
  - 本地 12 项新老功能集成测试与端到端断言全部 100% 通过。

## [v2.7.3] - 2026-10-08

控制台交互与安全边界深度重构：可用模型列表支持实时搜索过滤、自适应高度滚动与一键快捷探针联动；底层完整 YAML 编辑器重度安全收拢，默认折叠收起、移至危险区底部并增加全量覆盖二次强警告防误触。

- **可用模型卡片全流程体验重构（Model Catalog Real-Time Search & Scroll View）**：
  - **即时过滤搜索框**：在【可用模型】卡片顶部增加即时搜索框（`#cpa-key-models-search`），支持按模型 ID（如 `claude`, `gemini`, `gpt`, `step`）和提供商实时模糊过滤；
  - **表格视口高度约束与表头吸顶**：引入 `.cpa-scroll-table-wrap` 容器，限制最大高度为 420px 并启用内嵌平滑滚动，表头增加 `sticky` 置顶效果，彻底解决几十上百个模型将页面纵向撑爆的严重排版问题；
  - **模型总数与匹配数实时统计**：卡片右上角动态显示当前模型总数与过滤匹配数（如 `显示 12 / 64 个模型`）；
  - **一键快捷复制与探针联动**：每行模型均支持点击按钮一键复制模型 ID；增加「探针测试 ↗」快捷按钮，点击可自动跳转至【在线模型探针测试台】并预填目标模型，省去多页面复制粘贴的繁琐操作。
- **底层完整 YAML 编辑器安全防误触收拢（YAML Editor Hardening & Danger Zone）**：
  - **调整展示层级与位置**：将原先横亘在页面中间的裸露【完整 YAML】卡片移至整个配置页面最底部，作为「高级维护危险区」；
  - **默认折叠收起保护**：采用 `<details class="cpa-danger-panel">` 默认收拢隐藏，增加醒目的安全锁与高危黄色/红色警示条，杜绝误触光标或滚动滑轮造成的配置篡改；
  - **强二次确认弹窗防误触**：保存按钮样式升级为醒目的 `btn-danger`，点击保存时强制弹出明确的风险二次确认警告（覆盖全部 49 项上游配置），用户取消则完全不发起任何网络请求。
- **全套自动化测试 100% 通过**：
  - 更新 Playwright UI 自动化测试用例 `tests/test_cpa_ui.py`，全套 12 个集成测试与无头浏览器端到端测试均 100% 通过。

## [v2.7.2] - 2026-10-08

控制台关键管理链路修复与组件状态同步加固：修复路由调度策略读取报 404/Unsupported CPA operation 错误，修复配置面板中可用模型 API Key 下拉菜单状态未同步为空白的问题，并增加选 Key 自动联动模型查询与自动化测试防回归守护。

- **路由调度策略管理端点双向打通（Routing Strategy & Runtime-Config Proxy Routing）**：
  - **根本原因修复**：修复 `admin-cpa.js` 中 `loadRoutingConfig` 请求 `/admin/api/cpa/runtime-config` 时，后端 `handleCpaManagementRoutes` 未识别对应子路径并返回 404 `Unsupported CPA management operation` 的问题；
  - **服务端全链路兼容**：在 `lib/routes/admin-routes.mjs` 中为 `handleCpaManagementRoutes` 显式接入 `suffix === 'runtime-config'` 与 `(suffix === 'upstream-routing' || suffix === 'routing') && req.method === 'PUT'` 分支，并提取 `getRuntimeConfigSnapshot()` 保证无论通过 `/admin/api/cpa/` 还是 `/admin/api/` 请求，运行时一览与路由策略数据均 100% 畅通；
  - **前端请求韧性兜底**：在 `admin-cpa.js` 的 `loadRoutingConfig` 中增加双重容错获取，无论新旧部署均能安全获取并回显路由策略与会话粘性配置。
- **配置面板可用模型 API Key 下拉菜单同步（Model Key Dropdown Synchronization）**：
  - **根本原因修复**：`admin-cpa.js` 在页面启动时将 `<select id="cpa-model-key">` 包装为浮动下拉组件 `.dropdown` 并隐藏原生 select；后续异步拉取到 Keys 列表后仅替换了原生 select 的 options，遗漏了重新调用 `syncCpaDropdown('cpa-model-key')`，导致界面浮动组件保持初始化时的空“请选择”状态；
  - **下拉菜单双向同步**：在 `loadModelKeys` 填充 options 后，自动选择有效 Key 并立即调用 `syncCpaDropdown('cpa-model-key')` 重绘浮动菜单；当无 Key 时显示友好提示；
  - **选 Key 自动联动模型查询**：为 `cpa-model-key` 绑定原生 `change` 事件监听器，并在初始加载到 Key 后自动触发 `loadModels()`，用户无需手动反复点击“查询模型”按钮即可直观浏览该 Key 授权的所有可用模型。
- **自动化测试加固**：
  - 在 `tests/test_cpa_management.mjs` 中增加针对 `/admin/api/cpa/runtime-config` 与 `/admin/api/cpa/upstream-routing` 的自动化断言；
  - 更新 `tests/test_cpa_ui.py` 导航 Tab 期望列表，全套单元测试、集成测试与无头浏览器 UI 自动化测试 100% 通过。

## [v2.7.1] - 2026-10-08

监控大盘与全链路审计体系全面加固：修复故障中心时间乱序与微秒溢出，打通上游承接账号全链路追踪，凭证统计表格深度接入 Antigravity/Codex 滚动周期额度（5h 剩余与重置倒计时）及分时段 Token 消耗对比，彻底解答配额计算与大上下文缓存口径疑问。

- **故障中心时间严谨排序与微秒溢出根除（Error Chronological Ordering & Timestamp Normalization）**：
  - **时间戳自适应与溢出修复**：彻底修复 `admin.html` 中前端对已是毫秒级的 `ev.ts` 重复乘以 1000（`new Date(ev.ts * 1000)`）导致微秒溢出与时间显示怪异错乱的严重 Bug；采用毫秒自适应解析并输出完整可读年月日时分秒（如 `03-09 15:43:20`），鼠标悬停可查看标准 ISO 完整时点。
  - **确定性时序排序**：重构 `lib/db/sqlite.mjs` 中的 `stmtErrorsRecent` 查询与 `getPagedErrorEvents` 为 `ORDER BY ts DESC, id DESC`，确保无论是实时流还是分页拉取，最新错误与熔断事件恒严格排在最前。
- **全链路承接账号透明化追踪（Upstream Account Attribution Across Audit & Errors）**：
  - **故障中心账号直观归属**：在 `lib/analytics/audit-logs.mjs` 中接入 `resolveAuthAccountInfo` 统一凭据解析引擎，将原本仅有十六进制 Hash（如 `4e5fd676dc65ea0d`）的错误事件关联到具体业务账号名称与邮箱；前端表头升级为「上游账号 / 凭据」，清晰标明具体哪个上游账号发生 429 限流或被熔断退避。
  - **实时请求流水增加「上游账号」专属列**：在实时流水表格中新增独立的「上游账号」列，直观展示该请求由哪个账号承接处理并带平台品牌徽标；支持点击上游账号一键按账号快速筛选该号的所有请求流水。
- **凭证统计表格接入周期额度与刷新倒计时（Upstream Quota Windows & Auto-Reset Countdown）**：
  - **滚动周期额度（5h / 周）大盘呈现**：在 `lib/analytics/status-summary.mjs` 中为每个账号提取 Antigravity 与 Codex 原生的 `5h` 和 `weekly` 配额窗口，在凭证统计表格中新增专属列「周期额度 (5h / 周)」，呈现彩色进度条（绿/黄/红）、剩余百分比（如 `85.0%`）与重置倒计时（如 `还有 1小时25分 重置` 或 `满额就绪`）。
  - **分时段 Token 消耗矩阵（Multi-Period Token Breakdown）**：在后端预聚合每个账号在当前 5h 周期、近 24 小时、近 7 天与历史累计的 Token 消耗，直接在表格「Token 总数」列下方并列标出分时段用量（如 `5h: 12.5 K · 24h: 350 K · 总: 2.80 B`），无需频繁切换 Tab 即可纵览账号分时段消耗。
  - **计算口径与 Prompt Cache 通俗说明**：在凭证统计顶部增加口径说明条，清晰解释为什么在编程对话场景下历史累计会有数十亿（Prompt Caching 命中率高达 ~87% 带来的大上下文吞吐计量），彻底打消用户对计算方式的困惑。
- **自动化测试 100% 通过**：
  - 运行全套 12 个集成测试与前端 AST/vm.Script 校验，所有用例全部通过，零语法破坏与零回归。

## [v2.7.0] - 2026-10-08

全栈深度代码审查与关键路径性能加固：彻底消除生产已捕获的 SSE 反压 EventEmitter 内存泄漏，阻断客户端断连产生的上游流式僵尸连接，重构配额热路径为 O(1) 索引查询，优化大盘单趟流式计算，并启用本地管理页面内存单例缓存与 SQLite 性能参数深度调优。

- **流式反压与 EventEmitter 内存泄漏彻底消除（Stream Backpressure & Zero-Leak）**：
  - **单例反压监听器**：重构 `lib/proxy/transport.mjs` 中的流式传输逻辑，引入受控反压状态机，当下游客户端写入缓冲区满（`res.write()` 返回 `false`）时，仅注册单个防重 `'drain'` 监听器，彻底根除生产环境已出现的 `MaxListenersExceededWarning: 11 drain listeners added` 告警。
  - **断连资源安全清理**：在 `clientRes.on('close')` 时重置反压状态并安全释放连接，杜绝未排空悬挂监听器。
- **客户端断连即时销毁上游流式请求（Zombie Stream Prevention）**：
  - 在 `lib/proxy/transport.mjs` 中将客户端请求的中断信号（`abortController.signal`）与上游响应（`proxyRes`）深度绑定，当下游取消或网络闪断时，立即销毁上游响应连接，阻止上游继续生成无效 Tokens 并节省服务器带宽与算力。
- **配额校验引擎热路径 O(1) 优化（Nanosecond O(1) Hot Path）**：
  - 在 `lib/core/outbox.mjs` 中新增二级内存聚合索引 `liveTodayTokensByKeyId` 与 `liveTodayRequestsByKeyId`，在请求入队时同步 O(1) 增量累加并在用量刷盘后同步清空。
  - 重构 `lib/core/engine.mjs` 中的 `getTodayUsageForKey(keyId)` 与 `getTodayRequestsForKey(keyId)` 为纯 O(1) Map 读取，彻底消除此前在纳秒热路径对全量 `liveUsage` 进行 `for..of` 循环遍历与 `${usageDate}|${keyId}|` 字符串模板匹配的性能瓶颈。
- **系统状态大盘单趟流式计算（Single-Pass Scope Aggregation）**：
  - 重构 `lib/analytics/status-summary.mjs` 中的 `buildStatusScope`，以单次循环同步统计总延迟、TTFT、成功数与 24h 请求数，彻底移除 4 组 `.filter()` 与中间临时数组分配，GC 压力归零。
- **静态管理页面内存单例缓存（Zero-Disk-I/O Static Cache）**：
  - 在 `lib/routes/upstream-proxy.mjs` 中接入 `cachedLocalManagementHtml` 内存单例缓存，首次读取并注入脚本后长驻内存，杜绝每次直出页面时同步读取 340 KB 文件的磁盘阻塞。
- **SQLite 引擎参数调优（Pragma Tuning）**：
  - 在 `lib/db/sqlite.mjs` 中开启 `cache_size = -32000`（32MB 缓存页）、`mmap_size = 300000000`（300MB 内存映射 I/O）与 `temp_store = MEMORY`，显著提升大表查询吞吐。
- **请求体异步读取异常泄漏保护（Async Body Reader Guard）**：
  - 在 `lib/routes/admin-routes.mjs` 的 `readBody` 中增加 `req.on('close')` 守卫，客户端提前断开连接时立即拒绝并释放 Promise，防止异步请求悬挂。
- **自动化测试扩充**：
  - 在 `tests/test_gate_features.mjs` 新增测试用例 12，覆盖配额 O(1) 累加准确性、流式反压单例监听防泄漏验证与大盘单趟流式计算一致性验证，全套集成测试 100% 通过。

## [v2.6.9] - 2026-10-08

路径 B 终极阶段：全面补齐原生 CPA 控制台仅存的核心能力，打通在线模型探针测试台、凭据冷却监控与一键解冻中心、高级路由策略与会话粘性控制，以及全局模型别名可视化映射，实现对原生 management.html 的 100% 闭环平替。

- **模型中心与在线实时探针测试台（Model Catalog & Live Model Probe）**：
  - **新增子页面 "cpa-models"（模型探针）**：在 Gate 原生 CPA 面板中内建专属模型目录与在线推理探针台。
  - **聚合模型目录（Aggregated Model Catalog）**：后端通过 `GET /admin/api/cpa/models` 聚合知名模型清单与上游 CPA 凭据支持的模型集合，支持实时搜索与一键填入测试台。
  - **安全在线推理探针（In-Browser Probe Playground）**：后端接入 `POST /admin/api/cpa/model-probe`，向上游发起小样本推理请求，精准记录 TTFT（首包时延）、总耗时、HTTP 状态码与响应正文，前端以暗色代码窗口直观渲染。
- **凭据冷却中心与一键解冻（Cooldown Center & Instant Reset）**：
  - **冷却状态监控横幅**：在 "cpa-auth" 页面顶部新增动态警报横幅，自动扫描聚合处于 cooling 状态的凭据、冷却原因、受限模型与剩余倒计时。
  - **全局一键解冻与单项重置**：后端接入 `POST /admin/api/cpa/cooldown/reset-all` 与 `POST /admin/api/cpa/cooldown/reset`，支持一键或单项解除冷却限制，并在写回后立即触发 `resetRuntimeFactsCache()` 刷新运行时事实。
  - **全量凭据刷新**：后端接入 `POST /admin/api/cpa/credentials/refresh-all`，提供一键刷新全部凭据状态能力。
- **高级路由策略与会话粘性控制（Routing Strategy & Session Affinity）**：
  - 在 "cpa-config" 页面新增路由策略表单卡片，支持可视化配置轮询（Round Robin）、加权轮询（Weighted Round Robin）与填充优先（Fill First）策略。
  - 支持直观配置会话粘性（Session Affinity）开关与 TTL 保持秒数，无缝对接 `upstream-routing` 热配置写回。
- **全局模型别名可视化映射（Global Model Aliases）**：
  - 在 "cpa-providers" 页面提供双列键值对卡片，后端接入 `GET/POST /admin/api/cpa/global-model-aliases`，安全读写全局 `model-aliases` 字段，支持将客户端请求模型名精准重写映射至目标上游模型。
- **AOCI-CODE 认知治理与自动化测试**：
  - 完成 Volumes v1 全量 Code Entry 维护对齐，`governance_aligned` 与 `stage: aligned` 100% 验证通过。
  - 扩充 `tests/test_cpa_management.mjs`，全量测试套件通过（`npm test` 零报错）。

## [v2.6.8] - 2026-10-07

全面清理全栈死代码与废弃导入，加固运行时事实缓存一致性，补全前端交互流并完成全部 13 个工作区自动化巡检验证。

- **全栈死代码与无用模块清理（Dead Code Elimination）**：
  - **后端无用导入与未引用实体移除**：清理 `lib/config.mjs` 中冗余的 `import fs from 'fs'`；清理 `lib/core/engine.mjs` 中废弃的 `shanghaiDate` 与 `reloadPreloadedToday`；清理 `lib/analytics/status-summary.mjs` 中未使用的 `stmtUpstreamDailyAgg` 与 `getRuntimeFacts`。
  - **前端废弃别名清理**：删除 `admin.html` 中历史遗留的无用别名函数 `triggerActivateAllCodexWindows()`。
- **运行时事实缓存一致性加固（Runtime Facts Cache Invalidation）**：
  - 在 `lib/upstream/priority.mjs`（凭据优先级更新、启用/禁用状态修改）与 `lib/upstream/batch.mjs`（批量启用、禁用、改优先级、重置冷却、删除）关键操作中接入 `resetRuntimeFactsCache()`，确保凭据状态发生变更时运行时缓存立即失效并重新计算，杜绝前端统计与调度状态数据漂移。
- **前端交互链路补全与剪贴板容灾保护（UI/UX Hardening）**：
  - **补齐验证记录「忽略」动作流**：打通未接入的 `dismissValidation(id)` 函数，在 Google 待核验凭据卡片与 Antigravity 账号状态行中新增「忽略提醒」操作按钮，提供完整业务闭环。
  - **剪贴板操作安全降级**：为 `copyProbeUrl()` 与 `admin-cpa.js` 中的错误日志检视器复制、OAuth 设备验证码复制接入 `copyToClipboard()` 安全降级机制，支持在无安全上下文或 Headless 自动化测试环境下优雅处理，杜绝未捕获的剪贴板权限异常。
- **端到端自动化测试与全工作区巡检（E2E Testing & UI Verification）**：
  - 扩充 `tests/test_cpa_ui.py`，完整覆盖 Google 验证中心（手动录入、保存并打开、列表刷新）、凭据统计多时间跨度切换、用量趋势多指标/周期切换、请求流水状态筛选与翻页、故障中心刷新、API 密钥规则预设配置、顶部定价/密钥/配额探针弹窗、上游凭证优先级调整与面板折叠展开。
  - 经 Headless 真实浏览器巡检，全站 13 个工作区与各类弹窗全部交互正常、零控制台错误（Zero Console Errors）。

## [v2.6.7] - 2026-10-06

全面推进路径 B（对齐原生 CPA 管理能力第二阶段）：支持请求错误日志在线实时检视、OAuth 设备码快捷复制、流程自愈与错误日志文件数配额管理，并彻底修复原生管理面板登录 403 路由阻断问题。

- **修复原生面板登录与 API 绝对路径 403 阻断（路径 A 安全加固）**：
  - **客户端绝对 URL 智能改写**：重构注入到原生 `management.html` 的前端拦截器，支持通过 `URL` 解析器将带 Origin/协议的绝对地址（如 `https://cpa.example.com/v0/management/config`）和多版本路径（`/v8/management/*`）透明重定向至当前域名的 `/admin/upstream/...` 隔离通道，解决原生 SPA 在登录校验时直连后端被直接阻断的问题。
  - **服务端已认证流量双保险放行**：在 `server.mjs` 管理路由防火墙层接入双重判断，若访问 `/v0/management/*` 或 `/v8/management/*` 的请求持有合法的 `gate_admin_token` Cookie 或 Bearer 鉴权凭据，Gate 将自动交由受控反代通道转发并注入 `CPA_MGMT_SECRET`，杜绝已认证管理员误触 403 连坐；对无凭据的外部请求依然执行严格 403 阻断。
  - **全局 Cookie 作用域优化**：将 `gate_admin_token` 的作用域扩展为 `Path=/`，并支持通过 Bearer 登录后自动补签 Cookie。
- **请求错误日志在线检视器（In-Browser Error Log Viewer）**：
  - 在 `lib/routes/admin-routes.mjs` 中接入 `GET /admin/api/cpa/request-error-logs/preview` 路由，配合严格文件名校验（`^error-[A-Za-z0-9._-]+\.log$` 与路径穿越拦截）。
  - **2 MiB 安全防爆截断（Size Cap Guard）**：对齐原生 CPA `logs.preview_too_large` 规则，当下游日志体积超过 2 MiB 时返回 HTTP 413 并提示转为下载离线查看，保护服务端与浏览器内存。
  - **前端内建代码查看模态窗**：在请求错误文件列表中新增「在线查看」按钮，以深色代码块（`#111d2c`、Aozora UI 细边框）直观渲染异常栈与上下文，配备「一键复制」、「下载原文件」与「关闭」快捷动作。
- **配置项对齐：错误日志保留文件数**：
  - 将 `error-logs-max-files` 纳入 Gate 配置资源白名单，支持在常用设置面板中动态调整日志轮转保留上限并热写回 CPA。
- **OAuth 设备码流与回调提交体验加固**：
  - 为 Device Code 授权流程（如 Kimi、Vertex 等）提供独立的验证码高亮卡片与一键复制功能。
  - 在回调地址提交后自动触发状态轮询与凭据列表重载，改善手动授权完成后的刷新体验。
- **集成测试覆盖**：
  - 扩充 `tests/test_cpa_management.mjs`，覆盖错误日志在线预览、超限 2 MiB 413 拦截、非法路径阻断以及 `error-logs-max-files` 设置读写。
- **工程认知治理（AOCI-CODE）**：
  - 构建 gate 项目 Volumes v1 结构化认知索引，全量纳管 52 个核心源码与配置对象并完成 FRAS v2 语义作者化与基线对齐。

## [v2.6.6] - 2026-10-06

对齐原生 CPA 管理能力（路径 B），升级凭据属性可视化编辑器、多版本管理契约与深层日志回溯。

- **凭据高级属性双模可视化编辑器**：
  - 将原有单一的原始 JSON 文本框重构为「可视化表单」与「原始 JSON」双模式编辑器（Aozora UI 磨砂面板），支持随时无缝切换并进行双向数据同步。
  - **排除模型规则芯片化管理（Chip Manager）**：支持通配符规则（如 `gpt-4*`、`claude-3-opus*`），可直接按回车或点击按钮动态添加/删除芯片 Tag，直观展示命中排除的模型规则。
  - **自定义 HTTP 请求头表格（Headers KV Table）**：支持可视化动态新增、编辑与删除多行自定义请求头（键值对形态），替代手工手写 JSON 对象的易错操作。
  - **核心调度参数步进调节**：直观提供优先级（Priority，保留显式 0 档位）、权重（Weight）、独立代理地址（Proxy URL）、模型前缀（Prefix）、备注信息（Note）、免除冷却惩罚（`disable_cooling`）与启用 WebSocket（`websockets`）的可视化表单控件。
  - 保存时调用受控安全接口 `PATCH /admin/api/cpa/auth-files/fields`，完成属性实时保存与列表自动刷新。
- **多版本 CPA 路由契约与受控代理**：
  - 扩展 `lib/upstream/management.mjs`，支持灵活适配 `/v0/` 与 `/v8/` 等多版本上游 CPA 端点路径。
  - 在 `lib/routes/admin-routes.mjs` 中接入 `/admin/api/cpa/v8/*` 路由透明代理，服务端自动注入管理密钥，实现安全受控调用上游新版管理端点。
- **CPA 服务日志深层追踪与全量检索**：
  - 解除原有日志接口强制向后截断 1 小时（`now - 3600`）的硬限制；当调用方传入游标或明确要求全量时放行 `after` 查询。
  - 在前端日志面板新增「加载全部历史」快捷操作，允许运维人员在故障排查时一键重置游标检索全量 CPA 服务日志。
- **原生管理面板 404 兜底与直出增强**：
  - 在 `lib/routes/upstream-proxy.mjs` 中接入本地 `static/management.html` 优先直出机制；彻底解决上游 CPA 配置 `disable-control-panel: true` 时反代回源返回 404 的问题。
  - 请求时动态注入双向 API 拦截劫持脚本，将原生 SPA 的所有 `/v0/management/` 与 `/v8/management/` 请求透明映射至 `/admin/upstream/` 鉴权通道。
- **自动化测试套件扩充**：
  - 在 `tests/test_gate_features.mjs` 中新增测试用例 11，覆盖多版本端点路径构建契约与日志游标全量查询逻辑。
  - 更新版本标识至 `v2.6.6`。

## [v2.6.5] - 2026-10-06

全面打磨 Gate 管理控制台 UI 与 UX 布局、排版与微交互，实现 Aozora UI 高级产品质感。

- **现代产品排版与字体体系重构**：
  - 重构全局字体栈为现代跨平台无衬线栈，优先调用 "Inter"、"SF Pro Text"、"HarmonyOS Sans SC"、"MiSans"、"PingFang SC"、"Microsoft YaHei UI"，并对所有数值、百分比、徽章与监控统计字段强制开启 `tabular-nums`，彻底消除实时轮询与计数刷新时的字形横向抖动。
  - 注入全局抗锯齿与排版优化基石（`-webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; text-rendering: optimizeLegibility;`），消除不同浏览器与 Windows 环境下的字体发虚与粗糙锯齿。
- **网格布局与对称性校准**：
  - **CPA 授权工作区栅格对齐**：为桌面端 Section 01 账号授权卡片配置 `grid-row: 1 / span 2;`，使左侧 OAuth 授权面板与右侧 A、B 两大导入面板在高度上自然咬合，彻底消除 Section A 下方遗留的孤立空白。
  - **提供商卡片复选框基准线对齐**：新增 `.cpa-field-checkbox` 弹性自适应对齐规则，修正双列栅格中复选框（如"暂停此提供商"）浮于顶部、与相邻文本输入框底线脱节的问题，实现严格水平居中对齐。
- **控件微交互与视觉质感升级**：
  - **Toast 浮动通知全新重构**：告别旧版水泥灰生硬边框，升级为通透圆角磨砂卡片（`rgba(255, 255, 255, 0.96); backdrop-filter: blur(16px)`），搭配轻量彩色状态圆点与平滑弹入淡出动效；前端新增 1500ms 消息防抖去重机制，彻底杜绝连续误点导致多条相同提示刷屏堆叠。
  - **文件上传控件定制**：将原生粗糙的 file input 重构为青空蓝虚线边框卡片，为 `::file-selector-button` 与 WebKit 伪元素添加细腻圆角与悬浮动效。
  - **运行总览控制项精致化**：为 `select.ovw-control` 注入内联定制 SVG 箭头指示与聚焦环，优化表单输入与悬停响应。
  - **模态弹窗平滑渲染**：所有弹窗统一接入高斯磨砂遮罩（`backdrop-filter: blur(8px)`）与 `@keyframes modalPop` 柔和弹出动效。
- **移动端与响应式布局严丝合缝**：
  - 在 `<= 900px` 视口下，将顶部"密钥"管理按钮（`#btn-auth`）一并纳入 34px 方形紧凑图标折叠逻辑，小屏下与价格查询、新建密钥图标统一成行，彻底杜绝按钮折行挤占面包屑空间。
  - 核心操作按钮添加 `white-space: nowrap; flex-shrink: 0;`，杜绝"刷新额度"等动作文本在窄容器下尴尬折为两行。
  - 修复浅色模式下激活 5 小时配额按钮的文字对比度，由过浅的 `#7dd3fc` 调整为符合 WCAG AA 标准的 `#0284c7`（hover `#0369a1`）。
- **文案本土化与符号规范统一**：
  - 将凭据列表中的原生英文未处理状态 `ready` / `active` 统一本地化为中文"正常" / "活跃"。
  - 全局清洗历史遗留的直角引号 `「」`，统一规范为双引号 `""` 与逗号。
  - 同步递增各模块与页面版本徽标至 `v2.6.5`。
- **安全兜底通道：受控反向代理原生 CPA 管理控制台**：
  - 新增 `lib/routes/upstream-proxy.mjs`，为原生 `management.html` 及其底层 API 开设受控代理通道 `/admin/upstream/*`。
  - 强制接入 Gate 管理员鉴权（支持 Bearer、Cookie 与 URL Query 换取 HttpOnly Cookie），服务端自动向上游 CPA 注入 `CPA_MGMT_SECRET`，既保证运维人员随时可使用原生面板完整功能，又彻底阻断未经授权直连 CPA 导致 IP 封禁。
  - 在 Gate 控制台侧边栏底部提供一键直达原生面板的安全链接入口。
  - 新增测试 10：锁定未认证重定向、401 防御、Cookie 交换与非目标路径放行规则。

## [v2.6.4] - 2026-10-06

修正运行总览成功率与吞吐图口径打脸，彻底杜绝 CPA 管理端 IP 连坐封禁缺陷。

**根因 A（总览口径）**：`buildTotals()` 累加各凭据的 `success` / `failed` **累计**值（进程启动以来的总量），而吞吐图用的是 `recent_requests` 的 **200 分钟桶窗口**。生产实测曾出现同一屏显示「成功率 86.0% · 需要留意」配一张几乎全绿的图——累计里 1,531 次失败绝大多数发生在早已滚出窗口的历史时段。累计算的是「启动以来」，窗口算的是「现在」，运行总览要回答的是后者。指标区提示语写着「窗口内共 N 次请求」，描述的却是一个累计值。

- **总量改与图同源**：`buildTotals()` 改为按 200 分钟桶求和，新增 `scope` 字段标明口径。累计值不再进入总览任何数字。
  - CPA 不返回任何字段说明某个计数是否为窗口内值，桶是唯一带时间边界的数据，因此窗口内总量一律由桶推导。
  - 桶全空时退回累计口径并标 `scope: 'cumulative'`，避免 CPA 少给一个字段就把界面显示成「静候流量」。
- **消除前端重复求和**：`aggregateBuckets()` 原本在前端又按位置对齐求和一遍，与服务端同一份数据存在两套实现。总览图与 Hero 迷你图现直接消费服务端算好的 `totals.buckets`。
- **提示语跟随口径**：`scope === 'cumulative'` 时改述为「累计共 N 次请求 · 窗口内无流量」，不再用「窗口内」描述累计值。
- **新增测试 8**：锁定「桶内逐点求和 == 总量字段」这一不变量，回归数据取生产实测值（94/528，窗口口径 15.11% vs 旧累计口径 86.0%）。

**根因 B（CPA 管理 IP 连坐封禁 `IP banned due to too many failed attempts`）**：
- 现象：用户在 Gate 控制台正常操作（如调整调度优先级保存）时频发 403 `IP banned due to too many failed attempts`，排查证实用户从未输错密钥。
- 根因分析：
  1. OpenResty 根路径历史遗留配置将域名根路径代理至旧版 `management.html`（CPA 原生面板 SPA）。
  2. 访客或后台标签页打开该页面时，该 SPA 会在无密钥或旧密钥状态下并发发起 `GET /v0/management/config.yaml` 或 `/v8/management/credentials`。
  3. Gate 过去对未匹配的非 POST 请求执行无脑直通透传，导致未认证的外部管理请求直接击穿至 CPA 8315 端口。
  4. CPA 校验失败返回 401，页面快速重试累计满 5 次后，CPA 判定来自 `172.18.0.1`（Docker 网桥出口即 Gate 宿主机）在暴力破解，将该 IP 封禁 30 分钟。
  5. Gate 自身合法的内部同步与管理代理请求（走 `172.18.0.1`）遭到一刀切连坐封锁。
- **彻底根治方案**：
  - **Gate 路由防御防火墙**：在 `server.mjs` 中对直接访问 `/v0/management/*`、`/v8/management/*`、`/management.html` 等上游内部平面的外部请求一律由 Gate 本地直接 403 击落，严禁直通上游，从源头切断外部失败计数污染。
  - **根路径与空路径重定向**：`static-routes.mjs` 中根路径 `/` 统一 302 重定向至 Gate 控制台 `/admin`，彻底废除旧版 `management.html` 暴露。
  - **CPA 信任代理与网关防护**：CPA 配置 `trusted-proxies` 并清理反向代理旧规则。
  - **新增测试 9**：固化根路径重定向与内部管理平面拦截规则。

## [v2.6.3] - 2026-09-28

修复管理后台探针状态误报「探针离线」、休眠唤醒不自愈与紧凑列表错误留白缺陷。

- **根因 A：弹窗清单键名不一致引发 JS 异常误报探针离线**：
  - 前端 `renderQuotaHealthList()` 将 `probeData.blocked_keys` 与 `probeData.warning_keys` 当作数组遍历，而服务端实际契约中这两个键为数值（`summary` 计数），明细数组键名为 `blocked_details` 与 `warning_details`。当触发阻断或预警时，遍历数字直接抛出 `TypeError: ... is not iterable` 并冒泡至探针拉取的 `catch`，导致原本健康正常的探针状态被无脑重置为「探针离线」。
  - 修复：对齐真实键名契约并加入 `Array.isArray()` 严格防护。
- **根因 B：休眠唤醒与网络抖动缺乏前台自愈**：
  - 用户电脑合盖休眠唤醒或 Tailscale 隧道重连瞬间，单次 `fetch('/api/status/quota')` 因局域网暂未握手抛错，徽章被置为红点且永久停留在离线状态。
  - 修复：新增 `visibilitychange`、`online`、`offline` 生命周期监听，前台激活时自动重置倒计时并静默刷新；探针异常时区分「网络未连通」与「探针重试中」，并启动 5 秒后台探测自动自愈。
- **根因 C：紧凑视图下异常提示全屏留白**：
  - 默认视图激活「紧凑列表」时，`upstream-compact-container` 为可见容器，但 `fetchUpstreamQuotas()` 与 `refreshUpstreamQuotas()` 在未配置密钥、401 鉴权失败、网络异常和加载态中仅向已隐藏的 `upstream-cards-container` 写入 HTML，导致紧凑视图下列表区域完全留白。
  - 修复：抽离 `setUpstreamPlaceholder(html)` 同步更新双容器。
- **稳健性提升**：
  - 全局拉取 `refreshAll()` 采用 `Promise.allSettled()` 取代 `Promise.all()`，阻断单接口失败波及整体刷新。
  - 补充 `.status-badge.degraded` 与 `.status-badge.offline` 样式映射。

## [v2.6.2] - 2026-09-27

P1：修正上游凭据默认档位与 CPA 不一致，导致管理台显示一个**并不存在的调度档位**。

**根因**：CPA 对 `auths/<name>.json` 里没写 `priority` 的凭据按 **0** 调度，而 Gate 的 `DEFAULT_AUTH_PRIORITY` 默认是 **10**。新加的号从未显式设过档位，Gate 却在界面上标成 P10、还把它排到真正设了 P0/P5 的号前面。v2.4.11 把散落的字面量 `10` 收进 config 解决了「多处硬编码」，但没有核对过这个值本身对不对。

- **默认值对齐 CPA**：`DEFAULT_AUTH_PRIORITY` 由 10 改为 0，`GATE_DEFAULT_AUTH_PRIORITY` 随之。未设档位的号现在显示 P0、排在自己设的 P0 档位同档——与 CPA 的真实行为一致。config 与 README 均加注「改前先确认 CPA 侧默认值」。
- **修掉「打开弹窗不动也会改值」**：`openPriorityModal()` 回填的是 `acc.priority ?? defaultAuthPriority()`。此前**一个键都不碰、直接点「保存并生效」，就会把 `priority: 10` 真正写进 auths 文件**——这个号从 0 被抬到 10，而用户全程以为自己没改。现在回填走归一化，弹窗明写「保存会显式写入 P<n>；未显式设置的凭据默认是 P0」。
  - 提示对**所有**凭据显示而非只对未设的：服务端 `syncUpstreamQuotas` 已把「未设」归一化成默认档位才下发，前端拿到的永远是数字，无从区分显式与未设；而保存本身对两者一视同仁都会写入显式字段。
- **清掉 4 处 `?? 10` 残留**（`admin.html` 4914 / 5145 / 5362 / 5540）：v2.4.11 声称「前端不再自带常量」，但四处回落仍写着 10。当前是死代码（服务端已保证是数字，走不到 `??`），语义上与该约定相悖。新增前端 `normalizeAuthPriority()`，与后端 [sync.mjs](../lib/upstream/sync.mjs) 同语义：显式判空（保住合法的 0）、越界回落、缺字段取服务端下发值。
- **修正反了的预设标签**：`P10 · 默认` → `P10 · 标准`。CPA 侧「默认」是 P0，这个按钮点的是 10，标签与实际语义相反；P0 按钮的 title 补上「未显式设置的凭据即为该档位」。
- **测试**：测试 5 的默认值断言由 10 改为 0；新增 **5.4b** 回归断言——把一个显式 P5 的号与两个未设档位的号一起排序，断言未设的（P0）不得插到 P5 之前。这条在旧默认值下必然失败，正是本次缺陷的最小复现。
- **落盘文件未改动**：auths 里的凭据内容一律不动，仅纠正展示与排序口径。

## [v2.6.1] - 2026-09-26

修复运行总览「实时流量」图的排版。**数据本身没有问题**——已用生产 CPA 的 `runtime-facts` 逐桶核对：20 桶求和 879，柱高与各桶 `success+failed` 逐一吻合。问题全在刻度取值上。

- **纵轴刻度改为「好看的半轴」**（`niceCeil()`）：原实现取 `[0, max/2, max]`，峰值 118 时中线落在 59 这种没人读得懂的数上。现在改为先选一个整数半轴 h、再令上限 = 2h，中线恒为 h、上限恒为偶数。
  - 关键细节：数量级 `mag` 必须由**半轴** `peak/2` 决定。用 `peak` 取会让步进粗 10 倍——峰值 110 的 mag 是 100，候选半轴从 100 起跳，上限直接变 200，柱高只剩画布的 55%。按 `peak/2=55` 取 mag=10 才能落到半轴 60 → 上限 120（92% 填充）。
  - 生产实测峰值 110 / 118 现在都落在上限 120，刻度 0/60/120，柱高占满纵向空间。
- **加强基线**：零刻度线加粗加深（`#c3d8ea` / 1.2px），与网格线（`#e9f2fa` / 1px）区分开，柱高不再悬空。
- **刻度标签走 `fmtInt()`**，与页面其它数字对齐；左侧留白 34→46px 容纳三位数标签。
- **刻意不标「末桶进行中」**：CPA 的桶是裸时间串 `"19:20-19:30"` 不带时区，而网关进程跑 UTC、CPA 出桶是 UTC+8，payload 里没有任何字段能判定末桶是否仍在累积——硬标就是猜，猜错会让柱高被误读成最终值。
- **新增 `tests/test_gate_features.mjs` 测试 7**，穷举 0..20000 锁定三条不变量（上限 ≥ 峰值、上下限与中线刻度均为整数、峰值 ≥20 时填充率不低于 75%）。三条断言均经变异测试验证有效。

## [v2.6.0] - 2026-09-26

P1：路由策略写入 + 认证文件批量操作。

调研纠正了一个前提——原计划里的「URL 路由」在 CPA 里并不存在。逐一探测生产 CPA 的管理端点与 49 个 config 顶层键后确认，CPA 面板中叫「路由」的是**凭据调度**（`chapters.networks`），共三项：路由策略、会话粘性路由、会话粘性 TTL。Gate 此前只读得到 `round-robin`/`fill-first`，且**完全没有写入路径**。

- **新增 `lib/upstream/routing.mjs`：路由配置读写**：
  - `ROUTING_STRATEGIES` 三个策略常量（`round-robin` / `weighted-round-robin` / `fill-first`），其中**加权轮询是 v2.5.0 之前 Gate 完全看不到的策略**。
  - 写入走 `PATCH /v0/management/config` 且**只提交 `routing` 子树**。生产 config 有 49 个顶层键，而 Gate 原先唯一的配置写入路径 `config-yaml` PUT 是整体替换 YAML——用它改路由一次手滑就会抹掉 api-keys、claude、vertex 等全部配置。
  - `validateRoutingPatch()` 只认 `strategy` / `session_affinity` / `session_affinity_ttl` 三个字段，其余键一律 400。没有这道闸，一个透传任意 JSON 的接口等于把整份 config 当 routing 提交。
  - **写后回读校验**：PATCH 返回 200 不等于值真的落到配置里，不回读就会出现「界面显示已保存、实际没生效」。
  - TTL 留空 = 清掉该键（与 CPA 面板 `DR()` 语义一致），而非写成 0。
- **新增 `PUT /admin/api/upstream-routing`**，沿用既有 `verifyAdminAuth` + `readBody` + `writeJson` 模式。
- **`runtime-config` 的 `routing` 改取完整子树**（`/routing` 而非 `/routing/strategy`），策略、粘性、TTL 三项一次到手。
- **新增 `lib/upstream/batch.mjs`：认证文件批量操作**：
  - `applyBatchAction({ names, action, value })` 支持 `enable` / `disable` / `priority` / `reset-cooldown` / `delete`。
  - **逐条执行、逐条汇报**：一个条目失败不阻断其余，也不回滚已成功的条目。真实运维中十几条凭据挂掉一两条是常态，整体回滚反而要重做。
  - 每个 action 复用既有单条实现（`updateUpstreamAuthStatus` / `updateUpstreamAuthPriority` / `requestCpaJson`），不新造 CPA 调用路径，避免同一操作两套实现随时间漂移。
  - 入参校验：文件名过 `safeAuthFilename`、单批上限 200、按需去重保序。响应只含文件名与错误原因，不回显任何凭据材料。
  - 只有 `reset-cooldown` 需要 `auth_index`，该映射仅在此 action 下才拉取，避免 auth-files 失败拖累其余动作。
- **新增 `PUT /admin/api/upstream-auth/batch`**，单文件端点全部保留，向后兼容。
- **前端批量 UI**：认证文件工具条新增「批量启用 / 批量停用 / 批量设优先级 / 重置冷却」，与既有「删除选中」并列。复用已有的 `state.selectedAuth` 选中集合；结果以汇总横幅呈现（已处理 N 个：成功 X · 失败 Y），失败项逐条列出原因并给「重试失败项」入口。成功的条目移出选中、失败的保留选中便于重试。`deleteSelectedAuthFiles()` 的客户端串行循环改走同一批量端点与同一套 UI，避免删除与其余批量动作行为不一致。
- **运行总览「运行时一览」的路由策略升级为可编辑控件**：策略下拉、会话粘性开关、会话粘性 TTL 输入。成员模式与未配置管理密钥时保持只读；保存中禁用控件防重复提交；失败时回读服务端真值并回滚，不会停在「以为改了其实没改」的状态。
- **测试**：
  - 路由写入只提交 `routing` 子树——断言**其余 config 键原样保留且不增删键**。这条断言经变异测试验证：故意往 PATCH 里塞入 `api_keys` 后测试确实失败（首版断言因「写入后再取快照」而永远通过，已修正为写入前捕获）。
  - 非法 strategy / 非 boolean 粘性 / 非数字或负数 TTL / 白名单外字段 / 空对象一律 400，且**被拒的写入不得改动 CPA 配置**；无管理密钥的 PUT 返回 401 且不产生任何 CPA 写入。
  - 批量部分失败（3 条中第 2 条失败）验证第 3 条仍成功；去重、超上限、非法文件名、非法 action、越界优先级逐项覆盖；响应不含 `sk-` / `access_token`；单文件端点回归。
  - 变异测试确认逐条执行语义有效：把 catch 改为 `throw` 后测试失败。
  - 浏览器用例新增：路由三控件存在且策略选项齐全、改策略后从服务端读回确认真落库、批量停用后行状态确实变为「已停用」、部分失败汇总正确。
  - 修正两处会因夹具变动而失效的脆弱断言：`ops-enabled-accounts` 改为按账号列表现算（仍锁住「停用/冷却/过期不算可用」这条规则）、删除汇总文案随批量端点更新。
- **UI 修正**：「路由策略」标签在四列栅格下被压成一列竖排单字（`.ovw-runtime-label` 缺 `flex-shrink: 0`）；策略选项改用 CPA 的短标签，避免下拉框被裁切。

## [v2.5.0] - 2026-09-26

运行总览工作区 + 凭证统计口径切换为以 CPA 运行时事实为准。

调研结论：CPA 自 v6.10.0 移除自带用量统计，但其管理面板仍通过两个只读管理接口拿到上游调度的**运行时事实**并据此构建全部图表——`GET /v0/management/auth-files`（每凭证 `success`/`failed`/`recent_requests[20]`/`cooldowns[]`）与 `GET /v0/management/api-key-usage`（`provider → key → {success, failed, recent_requests[20]}`）。这两个接口 Gate 一个都没接，「凭证统计」页的数字因此全部来自 `upstream_auth_baselines` 的**本地基线推算**——是估算，不是调度器实际怎么打的。

- **新增 `lib/upstream/runtime-stats.mjs`：运行时事实聚合层**：
  - `getRuntimeFacts({force})` 聚合上述两个只读接口为一个载荷，15 秒缓存，`?refresh=1` 强制刷新。
  - 桶序列按**右对齐**求和（各序列长度可能不等），窗口 20 桶 × 10 分钟 = 200 分钟，与 CPA 的 `RUNTIME_WINDOW_MINUTES` 口径一致。
  - 成功率用**累计计数**（`total_success + total_failed`）做分母，不与 200 分钟桶窗口内的计数混算——两者时间口径不同，混算会算出 >100% 的成功率。
  - 两端点用 `Promise.allSettled` 独立收敛：单个失败不阻塞另一个，双双失败时置 `degraded: true` 而非抛错。
  - API Key 原始材料永不出网关，只回传末段指纹用于去重计数。
- **新增 `GET /admin/api/runtime-facts`** 与 **`GET /admin/api/runtime-config`**（后者聚合 CPA 的 `/config`、`/routing/strategy`、`/latest-version`、`/usage-statistics-enabled`，每项独立 `Promise.all` 包裹，单项失败只标记该项 `ok: false`）。CPA 桥新增 `api-key-usage` / `usage-statistics-enabled` / `routing/strategy` 三个只读资源放行。
- **修复冷却中的凭据被误报为「可用」**（本次最严重的语义错误）：
  - `lib/upstream/auth-health.mjs` 原本只有 18 行、4 条字符串匹配，**完全忽略 `cooldowns[]`**。凭据正处于额度冷却时，管理台仍显示「可用」并参与调度排序。
  - 新增 `interpretCooldowns()` 消费 `cooldowns[]`：判定 `credential` / `models` / `credential_and_models` 三种作用域，映射 CPA 的 9 类原因 slug 为中文（未知 slug 兜底为「其他或未知原因」），保留 `http_status` / `backoff_level`。
  - `getAuthHealth()` 在原有 4 条 status 判断**之前**先跑冷却判定，冷却中返回 `state: 'cooldown'` / `blocked: true`。原有 4 条路径行为不变。
  - 剩余时间按快照观察时刻**衰减**（`remaining_seconds - (now - observed_at)`），不把静态值当实时值；`lib/upstream/sync.mjs` 在 auth-files 拉取成功后调用 `setCooldownObservedAt(Date.now())` 标记该响应的观察时刻。
  - 语义边界：冷却到期**不等于**额度恢复，到期后仍走原有 status 判定。
- **「凭证统计」页口径切换为双源并显式标注**：
  - 请求数 / 成功 / 失败 / 成功率改读 CPA 运行时事实；Token / 成本 / 缓存命中**保留**本地 `upstream_daily_stats` + `request_events` 聚合路径——CPA 不返回任何 Token 数据。
  - 每行新增 `runtime_source: 'cpa_runtime' | 'local_estimate'` 与 `runtime_window_minutes`；响应新增 `source` 信封说明当前口径。
  - `range=all` **恒为本地推算并标注**：CPA 只有 20 桶 ≈200 分钟，撑不起「全部历史」，前端不假装它是 CPA 事实。
  - `upstream_auth_baselines` / `upstream_daily_stats` 表与 prepared statement 全部保留（仍是 Token 三列的数据源，也仍服务 5h/24h/7d 本地时间窗）。
- **新增「运行总览」工作区，置于侧栏导航首位并作为默认首屏**（`admin-overview.js` + `admin-overview.css`，独立文件不进 `admin.html` 内联脚本，规避 v2.4.10 白屏事故面）：Hero（滚动窗口请求总数 + 稳态判定 + sparkline）、核心指标 4 块、20 桶实时吞吐柱状图、供应商横向对比、运行时一览。
  - 首屏切换放在 `admin-overview.js` 的 `promoteToFirstScreen()` 而非改 `admin.html` 的 `activeNavTab` 初值：脚本加载失败时仍退回原有 quotas 首屏，不会停在半初始化的工作台上。
  - **成员模式与未配置管理密钥时一律不接管首屏**，仍落在 quotas —— 运行总览聚合的是全站上游调度事实，成员不得查看。
  - 只接管首屏：用户之后自己切走到别的页再刷新，仍尊重当前所在页，不会被强行拉回。
  - 成员模式隐藏该入口与相邻分隔线——成员看板只暴露自己的 Key 用量。
- **修复静态资源缺失导致整个网关进程退出**（`lib/routes/static-routes.mjs`）：
  - 资源处理器原先先 `res.writeHead(200)` 再 `fs.readFileSync()`，文件缺失时 catch 里二次 `writeHead(404)`，抛 `ERR_HTTP_HEADERS_SENT` 并**拖垮整个网关进程**（非仅该请求）。这是既有潜在缺陷，新增 2 条资源映射后更易触发。
  - 改为**先读文件再写响应头**，`adminAssets` 与 `adminImages` 两个处理器均已修正。
  - 新增回归测试：直接调用处理器并桩掉 `writeHead` 以捕获二次写入。注：走 URL 的 `fetch` 会被 WHATWG URL 归一化，永远摸不到「读文件失败」这一分支，测不出该缺陷。
- **测试**：`tests/test_gate_features.mjs` 新增测试 6（冷却诊断，10 组子用例：三种作用域、9 类原因映射、到期/空/非法记录、剩余时间衰减、**冷却判为不可调度的关键回归**、原有 4 条 status 路径不回归、时长文案），并将 `admin-overview.js` 纳入既有前端语法门禁。`tests/test_cpa_management.mjs` 新增约 40 项断言，覆盖冷却诊断、供应商成功率一致性（锁 0–100% 区间）、桶右对齐、双源口径切换与 `runtime-config` 端点。

## 2026-09-26 — 文档核对与精简

- 核对脚本与配置入口，删去纳秒级性能和重复 UI 描述，标明历史运维快照边界。

## 2026-09-26 — 单项目 Agent 入口

- 规则、长期偏好和相关排障经验迁入本项目，agent 不再依赖父目录共享文档。

## [v2.4.12] - 2026-09-26

- **修复 `/admin/api/upstream-quotas` 刷新路径响应缺字段**：
  - v2.4.11 新增的 `default_priority`（及既有的 `pending_validations`）只在非刷新分支经 `getCachedUpstreamQuotas()` 组装时出现；`?refresh=1` 与 `POST` 分支直接回写 `syncUpstreamQuotas()` 的裸缓存对象，导致同一端点两条路径响应结构不一致，前端在点击「刷新」后拿不到默认档位。
  - 两处刷新分支改为 `syncUpstreamQuotas(true).then(() => getCachedUpstreamQuotas())`，与 GET 非刷新分支统一走同一组装函数。

## [v2.4.11] - 2026-09-26

- **上游凭据调度默认档位去硬编码并收敛为单一契约**：
  - 原先字面量 `10` 散落在 5 处（`lib/upstream/sync.mjs` 解析与排序、`lib/upstream/priority.mjs` 排序、`lib/analytics/status-summary.mjs` 3 处展示与排序、`admin.html` 弹窗回填），无任何配置入口。现集中到 `lib/config.mjs` 的 `DEFAULT_AUTH_PRIORITY` / `DEFAULT_AUTH_WEIGHT`（对应 `GATE_DEFAULT_AUTH_PRIORITY` / `GATE_DEFAULT_AUTH_WEIGHT`，默认 10 / 1），并一并显式声明 `AUTH_PRIORITY_MIN/MAX`、`AUTH_WEIGHT_MIN/MAX` 区间常量。
  - 新增 `normalizeAuthPriority()` / `normalizeAuthWeight()`：先做 null/undefined/空串判空，再做区间裁剪，越界与非法输入安全回落默认值而非静默通过。旧实现的 `parseInt(...) || default` 在字段以字符串形态返回时会把显式 `"0"` 吞成 10（P0 兜底是合法档位，管理台内置该预设）；归一化后不再依赖「CPA 恰好返回 JSON number」这一假设。
  - 新增 `compareAuthAccounts()` 统一排序：优先级降序，同优先级按 `auth_index` 数值升序、数值不可解析时回退字典序，消除 3 处重复的匿名比较函数。生产 `auth_index` 为 16 进制串，行为与旧字典序一致，属等价收敛。
  - `GET /admin/api/upstream-quotas` 响应新增 `default_priority` 字段，管理台弹窗改由服务端下发值回填并展示「未显式设置时的默认档位」，前端不再自带常量。
- **测试**：新增 `tests/test_gate_features.mjs` 测试 5（凭据优先级归一化、显式 0 保留、越界回落、排序稳定性），此前 priority 相关零覆盖。

## [v2.4.10] - 2026-09-25

- **彻底修复 admin.html 前端内联脚本语法中断致命缺陷 (SyntaxError)**：
  - 定位并清除紧凑凭证配额渲染分支中残留的非闭合 HTML 模板片段（`SyntaxError: Unexpected token '<'`），该错误导致浏览器在解析脚本时彻底崩溃中断，前端所有 API 初始化请求（包括配额状态、Key 列表、上游凭证等）均未发出，表现为页面加载后呈现空白/无数据。
  - 在自动化测试套件中正式引入前端 `admin.html` 内联 JavaScript 语法严密性 AST 编译门禁（`tests/test_gate_features.mjs` 测试 4），杜绝任何语法断裂意外上线。

## [v2.4.9] - 2026-09-25

- **顶部刷新按钮解耦与 Provider 动态自适应**：
  - 彻底淘汰此前死板硬编码的「刷新全部 Codex 额度」，改为根据当前视图的 Provider 筛选标签（全部 / Antigravity / Codex / Claude 等）动态自适应文案与提示。
  - 批量刷新逻辑联动：在「全部」视图下一键并发查询所有支持上游探针的有效账号；在特定 Provider 标签下精准定向批量查询当前提供商的凭证。
- **根治反重力（Antigravity）满额度倒计时与分钟不动假象**：
  - 辨析 Google 5h 滑动限额窗口特性：当账号未发生消耗（`remaining_percent >= 100`）时，Google 返回的 `now + 5h` 仅为理论备用占位；系统将其精确归一化为「满额就绪」，消除误导性的假倒计时。
  - 一旦账号发生实际调用消耗（`remaining_percent < 100`），滑动限额窗口自动启动精准时序倒数。
  - 解决单账号刷新延迟：在 `activateUpstreamQuotaWindow` 探针返回后就地更新目标账号在内存缓存中的配额数据并落盘快照，不再受限于全局慢速轮询与并发锁。
- **客户端实时动态倒计时（Live Countdown Timer）**：
  - 彻底根除页面静态渲染导致的时间分钟数停滞；前端挂载客户端级动态倒计时时钟，随时间推移自动精确递减，分钟跳动实时反映上游配额恢复进展。

## [v2.4.8] - 2026-09-25

- **侧边栏全量高质感 SVG 图标统一与领域聚合重构**：
  - 彻底淘汰此前部分菜单缺失图标的“半截子”状态，全面对齐 Aozora UI 极简科技风，为全部 12 个工作区补齐一致规格的精致矢量 SVG 线性图标（服务状态、凭证统计、账号接入、提供商、CPA 配置、CPA 日志等）。
  - 合理化领域归类与相邻重排：
    1. **上游凭据与接入类（Upstream & Accounts）**：上游凭证 -> Google 验证 -> 账号接入 -> 提供商；
    2. **网关监控与流水类（Gateway Operations & Logs）**：服务状态 -> 凭证统计 -> 用量趋势 -> 请求流水 -> 故障中心 -> CPA 日志；
    3. **访问凭证与系统配置类（Access & Configuration）**：API 密钥 -> CPA 配置。
  - 视觉细节优化：在领域之间引入柔和渐变分割线（`.sidebar-section-divider`），侧边栏高度与内边距紧凑微调，开启平滑滚动，在全分辨率视口下均呈现浑然一体的秩序感与科技质感。

## [v2.4.7] - 2026-09-25

- **下拉组件真自定义 DOM 升级与彻底淘汰 OS 原生弹窗**：
  - 针对账号授权提供商、配置类型、模型别名与 Key 筛选等区域，全面实装基于纯 Web DOM 的现代化浮动下拉组件（`syncCpaDropdown`）。
  - 下拉展开呈现带 SVG 对勾指示、选中微缩与轻科技悬浮光晕的毛玻璃卡片（`backdrop-filter: blur(14px)`），彻底告别 Windows/浏览器自带的粗糙方角蓝白原生菜单。
  - 双向数据绑定：底层保留隐藏的原生 `<select>`，实现纯 DOM 交互与原生事件、表单自动化测试（Playwright / select_option）无缝双向兼容。

## [v2.4.6] - 2026-09-25

- **UI 现代化与交互重构**：
  - 淘汰老旧原生下拉选框：定制 Aozora UI 轻科技现代感 Select 控件，内嵌 SVG 矢量下拉箭头与聚焦光晕。
  - 账号授权卡片重构：根除下方大面积死区空白，在卡片内部常驻现代引导占位区，OAuth 授权链接生成后直接在卡片内平滑填充呈现，杜绝突兀弹出的外部 DOM 块。
  - 提供商页面导航优化：增加顶部粘性快捷导航条（Sticky Subnav Pills），支持一键平滑滚动直达“提供商配置”与“OAuth 模型别名与排除规则”，大幅降低长页面滚动成本。
  - 常用配置开关升级：全面淘汰老旧的开启/关闭原生 select 选项，升级为现代 iOS/二次元风格的高级滑动 Toggle 开关，支持即时响应与状态高亮联动。

## [v2.4.5] - 2026-09-25

- 修复 Antigravity/Gemini 额度查询发往错误的 Cloud Code 主机，改用与个人账号一致的 daily 主机查询额度与套餐；修正百分比精度和缺失值显示，并让手动额度查询使用凭据对应的项目 ID。

## [v2.4.4] - 2026-09-25

- 调整 CPA 账号接入页的桌面与手机排版、表单控件和认证文件操作区；OAuth 改为在页面内生成并复制授权链接，不再自动打开浏览器窗口。

## [v2.4.3] - 2026-09-25

- 生产联调发现 CPA 全量日志响应约 174 MB，超过 Gate 的 8 MB 管理响应上限；日志页改为默认读取最近一小时并增量刷新，服务端限制过早的日志查询，避免面板首次打开返回 502。

## [v2.4.2] - 2026-09-25

- OAuth 模型别名与排除规则增加按渠道的可视化编辑，保留高级 JSON 与未知字段；保存别名前重新核对 CPA 当前配置，避免覆盖其他管理员的修改。
- 修复 CPA 工作区切换与隐藏按钮的样式规则，并以桌面/手机页面测试覆盖别名冲突和排除规则保存。

## [v2.4.1] - 2026-09-25

- 将 v2.4.0 的 CPA 管理工作区迁入正式 Gate Git 仓库，统一 UI、服务端路由和项目测试入口。
- 认证文件支持筛选分页、多文件上传、勾选后批量删除；OpenAI 兼容提供商支持可视化编辑名称、地址与密钥条目，通过 CPA 发现模型、加入待保存配置并发起最多 8 token 的连通测试。
- Claude、Kimi、xAI、Devin、Meta 账号额度增加按需查询的剩余比例卡片；Meta 响应仅返回额度字段，隔离 DCA token、上游密钥和个人信息；CPA 日志可隐藏管理请求；新增隔离 CPA 管理集成测试与可选桌面/手机页面测试。
- Gemini、Codex、Claude、Vertex、Interactions、Meta、xAI 的 API Key 列表增加常用字段可视化编辑及增删；提供商卡片支持模型别名、Header 与排除模型的表单，保留未知配置字段和高级 JSON 编辑入口。
- 修复 CPA 凭据过期却在 Gate 显示额度：透传并突出显示认证健康状态，过期/不可用时停止额度探测和展示；没有有效配额数据时显示“额度未知”，不再默认剩余 100%。
- **生产上游 CPA 由 v7.3.9 升级至 v7.3.17**（东京 VPS，commit `9bdde54`）：镜像标签由浮动的 `latest` 钉死为 `eceasy/cli-proxy-api:v7.3.17`；8 个补丁版本无 breaking change 与迁移步骤，`config.example.yaml` 仅新增 `trusted-proxies` 与凭据级 `disable-codex-cloaking`，12 个凭据的 priority/disabled/type 与升级前逐字节一致；升级前备份位于 `/root/recycle-20260925/cliproxyapi-pre-v7.3.17/`。
- 新增 [docs/cpa-upstream.md](docs/cpa-upstream.md) 记录 CPA 生产事实与坑点：端口拓扑（Gate 实际监听 8316/8317，3101 是无关服务；健康端点为 `/healthz` 与 `/readyz` 而非 `/health`）、CPA 启动时将 `remote-management.secret-key` 原地 bcrypt 化导致明文只存在于 `/etc/gate.env`、管理接口认证失败会按来源 IP 封禁约 30 分钟并连带阻断 Gate 密钥同步（仅内存态，`docker compose restart` 即可清除，数据面不受影响）、以及 v7.3.13 的 `priority` PATCH 属于 API Key 类凭据而非 auth-files 的归属澄清。

## [v2.4.0] - 2026-09-24

- 增加 CPA 管理工作区：OAuth 授权、设备码、取消会话与手动回调，认证文件筛选、启停及 Vertex 导入、支持模型、提供商与 OAuth 别名、常用配置和完整 YAML、CPA 日志及版本检查；管理通道只开放明确列出的操作。
- 修复新建 Key 结果字段与服务状态入口；支持导入自定义 Key 和原 ID 轮换，生成的 Key 改用安全随机数。
- 停止自动清理 Gate 请求流水和每日用量历史；Claude、Kimi、xAI 额度改为按需查询；修正 Antigravity 配额巡检地址。
- 使用隔离模拟 CPA 验证管理 API、Key 轮换与桌面/手机页面交互；未进行生产部署。

## [v2.3.15] - 2026-09-24

- **修复 Antigravity 配额拉取生产端点与验证完成状态自愈闭环**：
  - 将巡检端点由测试环境 `daily-cloudcode-pa.googleapis.com` 修正为正式生产端点 `cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary`，消除此前因测试域 403 导致健康账号被误报为没有 License 或需要验证的假阳性。
  - 在配额巡检获取到正常分组数据后，自动调用 `resolveUpstreamValidationByAuth` 将该账号的 pending 验证状态核验自愈为 resolved，并清空错误；前端新增 `resolveValidation` 交互闭环，点击即时触发上游配额重新核验。

## [v2.3.14] - 2026-09-24

- **上游配额巡检自动拦截 403 VALIDATION_REQUIRED**：
  - 在 `syncUpstreamQuotas` 轮询上游账号配额与套餐时，深度接入 403 错误拦截：当 Google 返回 `VALIDATION_REQUIRED` 或 `Verify your account to continue.` 时，自动从上游响应中精准提取 `validation_url` 并存入 SQLite `upstream_validations`，生成待验证任务。
  - 在上游凭证列表（紧凑视图与完整卡片视图）中，对出现待验证的账号呈现醒目的“⚠️ 需 Google 验证”红框呼吸指示与直达验证按钮，彻底实现在管理台中自动呈现并一键去验证。

## [v2.3.13] - 2026-09-24

- **上游凭证页面彻底物理拆解解耦**：彻底解决原凭证页面臃肿滑动过长问题。将“服务状态”与“凭证统计”在 DOM 静态结构中从长页彻底剥离，置入真正独立的侧边栏工作区页面，按需加载渲染。
- **Google Antigravity 403 认证机制智能补全与全周期治理**：
  - 针对上游 Google 403 `VALIDATION_REQUIRED` 拦截，深入结合 GitHub Issue #4272 & #1729 规范，新增智能补全器 `completeGoogleValidationUrl`，自动填充官方回调 `continue=https://developers.google.com/gemini-code-assist/auth/auth_success_gemini`、`sarp=1`、`scc=1` 和 `flowName=GlifWebSignIn`，彻底救活因缺少 continue 参数而打不开或死循环的验证链接。
  - 侧栏开辟专属「Google 验证」工作区，直观呈现官方认证链接、智能补全标识徽章、按目标账号邮箱直达打开（杜绝多账号浏览器串号错误），并支持手动录入校验与历史测试记录彻底删除（`DELETE /admin/api/upstream-validations/:id`）。
- **请求流水与故障中心读写一致性（Read-Your-Writes）**：
  - 在查询流水（`getRecentRequests`、`getRecentRequestsForKey`、`getPagedRequests`）前强制同步刷新内存 `pendingEvents` / `usage_outbox`，消除高频请求落盘时序空洞，彻底根治“刚发完请求流水看不到/以为丢数据”的困扰。
  - 修复故障中心毫秒时间戳多乘 1000 的时间展示异常。
- **Aozora UI (青空 UI) 视觉规范对齐**：全面校准侧边栏、状态指示徽章、表格操作按钮与弹窗间距，保持纯净轻量低重绘。

## [v2.3.12] - 2026-09-24

- 根据 CLIProxyAPI 的 403 认证 issue 校正链接判断：`signin/continue` 缺少 `continue` 或 `plt` 时不再作为可打开的认证链接；提取时优先选完整链接，并保留结构化字段末尾字符。
- 管理台不再将上游链接称作保证可用的“官方直达”链接；对不完整记录提示重新获取完整 `validation_url`，手动录入拒绝不完整链接。
- 已部署至东京 Gate 服务；发布前运行文件备份位于 `/opt/gate/backups/v2.3.11-before-v2.3.12-20260924T092652Z`。公网 `/healthz`、`/readyz`、`/admin` 均返回 200，运行文件哈希与本地一致。

## [v2.3.11] - 2026-09-24

- 管理台将服务状态、凭证统计从上游凭证长页拆入侧边栏；待认证账号入口强化，统一页面字号、标题层级与表格分页区域。
- 请求流水与故障中心改为服务端分页，流水筛选与搜索在数据库执行；修复故障时间戳重复乘 1000 的错误，并停止自动删除请求流水及每日用量历史。
- 403 账号认证链接支持嵌套 JSON、转义字符和 Google 新版登录路径；无链接时仍记录待处理账号，手动录入仅接受 Google 官方 HTTPS 链接。
- 已部署至东京 Gate 服务；发布前代码与 SQLite 备份位于 `/opt/gate/backups/v2.3.10-before-v2.3.11-20260924T090400Z`。本机及公网 `/healthz`、`/readyz`、`/admin` 均返回 200，管理接口分页与 SQLite quick_check 通过。

## [v2.3.10] - 2026-09-23

- 管理台移除独立顶部插画横幅，改为贯穿工作区的轻量樱花观测站场景；角色在桌面概况区拥有独立留白，侧栏、服务心跳、凭证列表、趋势卡及空状态统一视觉语言。
- 服务状态卡改用自适应换行布局，奇数卡片不再留下大块空白；新增约 116 KB 的 WebP 场景及约 15 KB 的城市线稿分区素材与对应静态资源路由，保留无持续动画的滚动优化。
- 生产已发布至 Gate VPS；公网管理台、两张 WebP、healthz、readyz 与 metrics 均返回 200。发布前 v2.3.9 回滚副本：`/opt/gate/backups/v2.3.9-55a3803e-before-v2.3.10-20260923T120105Z`。

## [v2.3.9] - 2026-09-23

- 修复上游凭证与服务状态宽屏并排时因内容高度不等产生的大块空白：服务状态改为整行自适应卡片网格，凭证列表与统计表依次衔接；取消状态卡区域固定高度和内部滚动。

## [v2.3.8] - 2026-09-23

- 管理台重构为左侧工作区导航、上下文工具栏、紧凑樱花场景横幅与独立页面标题；上游凭证与服务状态改为宽屏并列、窄屏堆叠的操作工作区。
- 手机端新增抽屉式导航和保留新建 Key、定价管理的图标入口；五个页面的面包屑与说明随页面切换，并保持原有筛选、刷新、弹窗和成员模式功能。
- 沿用 v2.3.7 的低重绘性能优化与原有 Gate 插画素材，不新增滚动监听或持续动画。

## [v2.3.7] - 2026-09-23

- 优化 Gate 长列表滚动：移除服务状态点的持续阴影动画与心跳格发光，避免大量卡片持续重绘；复用心跳时间格式化结果，降低定时刷新时的主线程占用。

## [v2.3.6] - 2026-09-22

- Gate 管理台改为 Beszel 风格的浅蓝监控界面，新增路由线路页头背景与可缩放 Gate 标识；统一卡片、表格、状态、移动端布局与键盘焦点。
- 修复浅色界面的悬停文字/输入背景对比、未认证时无效控件与空加载面板、下拉键盘操作及无数据时误报 100% 成功率；拉取失败提供明确提示。
- 参考定制 Beszel 与用户樱花人像，生成独立的二次元天空/樱花背景和 Gate 樱花标志；新增低干扰场景横幅，并保留高对比度监控数据卡片。

## [v2.3.5] - 2026-09-18
### Fixed & Improved
- **修复趋势图 Token 堆叠重复计算导致总量虚高一倍的致命缺陷**：
  - **根因修复**：在大模型（Anthropic/OpenAI）标准统计口径中，`cached_tokens` 是 `prompt_tokens` 的子集（即命中缓存的输入），原图表将 `prompt_tokens` 绘制后再叠加 `cached_tokens`，导致缓存命中率高的场景下 Token 总量翻倍（如 11.5 亿被虚假放大为 22.5 亿，柱状图暴涨至 2.00 B+）；
  - **精准切分**：修正为物理不重叠的三段式堆叠结构：`未缓存输入 (prompt_tokens - cached_tokens)`（底）+ `缓存读取 (cached_tokens)`（中）+ `输出 (completion_tokens)`（顶），真实反映底层物理消耗；
  - **今日用量比例条同步纠偏**：修正大卡中输入/缓存/输出占比的分母基数计算，去除双重累加。
- **用量趋势分析支持按 API Key 维度筛选**：
  - **后端端点支持**：`/admin/api/stats` 新增 `key_id` 过滤参数，预编译专用 SQL `stmtDailyRangeByKey` 与 `stmtModelRangeByKey`，支持毫秒级按单一凭据拉取历史每日趋势、今日汇总与模型消耗排行；
  - **前端交互集成**：在趋势图上方新增「凭据筛选」现代毛玻璃轻量下拉组件（与 Key 列表实时联动），支持在「🔑 全部凭据」与各独立 API Key（含别名展示）之间自由无缝切换，大卡与模型排行随之实时联动。

## Workspace demo - 2026-09-20

- 新增 `_scratch/pelican-bike/pelican-bicycle.html`：单文件 SVG 2D 动画「鹈鹕骑自行车」。纯 SVG + requestAnimationFrame 驱动，无外部依赖；包含踩踏曲柄与两段式 IK 腿部求解（双脚锁在脚踏上并保持水平）、车轮辐条旋转、链条流动虚线、车身随踩踏起伏前倾、围巾波形飘动、迎风翅膀扇动、随机眨眼，以及云/远山/树/路面/草丛五层视差滚动与风流线、飞鸟扇翅。已用 Playwright 实机渲染截图验证（含腿部与脚踏局部放大复查）。

## Workspace tooling - 2026-09-16

- Updated the shared `androidbridge-real-device-control` skill from accessibility-first fallback behavior to control-type evidence routing: guarded visual anchors for dynamic/content surfaces, accessibility for stable native identity and input, bounded recovery, business-state verification, and asynchronous screenshot auditing.

## [v2.3.4] - 2026-09-16
### Added & Upgraded
- **成员 API Key 专属看板与权限隔离体系**：
  - **后端 Key-Scoped 鉴权与端点支持**：
    - 在 `/api/member/*` 下新增安全接口：`GET /api/member/info`（获取 Key 自身今日 Token 用量、缓存命中率、花费及限额状态，彻底去除原始明文 API Key 回显）、`GET /api/member/status-summary`（提供网关整体及各上游服务状态与心跳）、`GET /api/member/requests`（基于预编译 SQL `stmtEventsRecentByKey` 精确检索属于当前 Key 的历史请求流水）；
    - 服务端基于 `resolveKeyId` 实施强类型租户隔离鉴权，防止越权访问其他成员数据与管理配置；
    - 新增 `/member` 与 `/member/` 前端托管路由。
  - **前端智能模式识别与极简专属视图**：
    - 认证弹窗支持直接输入管理密钥 `GATE_ADMIN_SECRET` 或成员 API Key（如 `sk-cpa-...`），亦可使用 `?key=...` 链接直达；
    - 自动激活成员看板模式：标题显示「成员专属看板」胶囊，隐藏管理员敏感按钮（新建 Key、定价管理）；
    - 动态精简导航 Tab（仅保留「我的额度与服务状态」和「我的请求流水」），隐藏全站上游账号配置、全局趋势图、Key 管控列表与熔断故障表；
    - 上线「我的 API 密钥专属用量看板」组件，直观展示今日总 Tokens、输入/输出/缓存 Tokens、缓存命中率、今日预估花费、每日软限额与彩色进度条；
    - 专属流水列表支持关键词搜索、状态过滤（全部/缓存/2xx/4xx/5xx/拦截）与分页翻页，隐藏跨 Key 筛选组件。
- **服务状态成功率心跳 60 分钟时间槽对齐滚动聚合 (Minute-Slot Rolling Window)**：
  - **对齐 sub2api / Uptime Kuma 机制**：彻底弃用旧版依赖静态请求条目切片的机制，重构 `buildStatusScope` 为按当前时间整分戳向前对齐 60 个 1 分钟时间槽（`[nowMinute - 59*60, nowMinute]`）；
  - **动态滚动推进**：每过去一分钟，窗口整体自动向右平滑滚动一格，彻底解决“刷新后心跳条不增加、停留不动”的困扰；
  - **存活心跳与异常染色**：无业务流量的分钟槽位自动输出柔和绿色的存活心跳（`live` 样式，悬浮提示“存活心跳正常 · 200”），有流量的槽位聚合请求量、平均延迟、首字 TTFT、模型标签与成功/4xx/5xx 精准染色。
- **上游 5 小时配额开启计时与预热唤醒功能**：
  - 针对 Codex / Antigravity 等上游凭证在首个请求发生前处于惰性未激活状态的问题，在配额卡片右上角新增「⚡ 开启5h计时」快捷操作按钮；
  - 新增管理端点 `POST /admin/api/upstream-auth/activate-window`，通过 CPA 管理通道 `/v0/management/api-call` 发送微型无损探针唤醒上游凭据并触发 5 小时速率限制窗口倒计时；
  - 探针发送后立即强制触发 `syncUpstreamQuotas(true)` 强刷并回传最新重置时刻与倒计时。
### Added & Polished
- **上游账号授权优先级展示与调度排序**：
  - `quota-manager.mjs` 中的 `syncUpstreamQuotas()` 完整提取并规范化上游凭证的 `priority`（默认 10）、`weight`（默认 1）、`disabled`（布尔值）和 `note`；
  - 列表默认采用优先级降序（P 数值高优先消耗，相同优先级按 `auth_index` 稳定排序），调度顺位一目了然；
  - 配额卡与服务状态卡全面展示 `P<数值>` 优先级金标（`p-high` 红色高优 / `p-normal` 蓝色标准 / `p-low` 灰色备用）。
- **交互式优先级与启停在线快速调整**：
  - 配额卡右上角新增「⚙️ 调整」次级按钮，呼出现代毛玻璃风格模态框（`#upstream-priority-modal`）；
  - 支持快捷预设档位（`P30 最高优`、`P20 优先`、`P10 默认`、`P5 备用`、`P0 兜底`）与自定义数值输入（0~1000）；
  - 支持快捷切换账号可用状态（`启用` / `临时停用`），停用时卡片呈现弱化态并提示 `[已停用]`；
  - 新增服务端 Admin 接口：`PUT /admin/api/upstream-auth/priority`（同步至 CPA `/v0/management/auth-files/fields`）与 `PUT /admin/api/upstream-auth/status`（同步至 CPA `/v0/management/auth-files/status`），更新后 Gate 内存缓存即时生效重排，无需等待轮询。
- **品牌矢量 SVG 图标与显式提供商胶囊呈现**：
  - 彻底淘汰原单字母（A / C / K / O）占位文本，重构 `getProviderBrand(provider)` 矢量渲染函数；
  - 为 **反重力 (Antigravity)** 设计专属引力星芒菱形矢量 SVG，搭配蓝紫流光（`#3b82f6` -> `#8b5cf6`）；
  - 为 **Codex (OpenAI / ChatGPT)** 内联官方六瓣旋涡结晶精细矢量 SVG，搭配翡翠绿渐变（`#10a37f` -> `#059669`）；
  - 为 **Claude (Anthropic)** 内联官方太阳花星芒矢量 SVG，搭配暖金渐变（`#d97706` -> `#b45309`）；
  - 为 **Google Gemini** 与 **Gate 网关总入口** 配备专属矢量图标；
  - 标题行在邮箱旁直接呈现显式品牌胶囊徽章（`反重力 Antigravity`、`Codex 官方`、`Claude 官方`），告别靠邮箱猜测提供商的痛点。

## [v2.3.1] - 2026-09-13
### Added & Polished
- **全面重构现代极简定制 Dropdown 下拉组件**：
  - 彻底淘汰所有原生 OS `<select>` 标签及其陈旧的操作系统级高亮弹层（消除 Windows 亮蓝选项底色与原生弹窗违和感）；
  - 封装统一轻量驱动类 `CustomDropdown`，采用现代暗色毛玻璃卡片（`rgba(22, 22, 26, 0.96)`、`backdrop-filter: blur(14px)`、微阴影、圆角与微缩微动效）；
  - 支持键盘焦点、点击外部自动收起、对勾选中态指示以及向上/向右响应式弹出（`menuClass: dropup/menu-right`）；
  - 全站 5 处核心下拉（顶部自动轮询、上游配额轮询、流水筛选密钥、流水拉取深度、流水分页大小）全部无缝替换为定制组件。
- **可用性轮询节能优化**：服务状态心跳卡与全局自动轮询默认由 10s 调整为 60s（1 分钟），心跳倒计时以 60s 周期平稳递减，大幅减少对网关接口与 SQLite 数据库的重复读取开销。
- **用量概览视觉增强与组件饱满化**：
  - 主容器由 1240px 适度放宽至 1400px，消除大屏宽屏留白空旷感；
  - 顶部 5 大指标卡片内边距提升至 20px 22px，主数值字号放大至 30px 粗体，Token 分布进度条加粗为 6px，增加微渐变投影与发光层次；
  - 趋势图 SVG 渲染高度提升至 290px，右侧模型分布列表高度对齐适配至 330px，整体版面充实对称。
- **实时流水滚动治理与多 Key 区分**：
  - 增加固定高度滚动容器（`max-height: 600px`）与表头 `position: sticky` 吸顶悬浮，告别无限长滚动；
  - 默认分页由 50 条收敛至舒适的 25 条（支持 25 / 50 / 100 自由切换）；
  - 新增「🔑 筛选Key」独立下拉菜单，支持一键过滤指定 Key 流水，彻底解决高频 Key 刷屏问题；
  - 流水 Key 列增加色彩 Badge 徽章，基于 Key 哈希生成专属柔和色标；支持在流水中点击任意 Key Badge 瞬间聚焦筛选该 Key。
- **Key 别名快捷编辑与体验修复**：
  - 密钥管理表格别名旁采用无边框 SVG 微图标，操作列新增「改名」次级按钮；
  - 新增轻量级修改别名模态框（`#rename-modal`），支持回车即时保存并自动局部更新界面缓存与流水下拉菜单；
  - 服务端 `updateKeyAlias` 优化为即使在特定未全量缓存状态下依然基于 SQLite `changes` 强落盘与内存热更，并修复前端保存规则时对 HTTP 状态码的严格校验。

## [v2.3.0] - 2026-09-13
### Added & Polished
- **服务状态面板 (Uptime Kuma 风格)**：上游凭证配额 Tab 顶部新增 Service Status 心跳卡 —— 网关总入口 + 各上游凭据（按 `auth_index` 归属）独立卡片，展示对话延迟、首字 TTFT、7 天可用性与「近 60 次记录」彩色心跳条（绿成功 / 黄 4xx / 红 5xx），带 PAST→NOW 轴标与刷新倒计时。
- **新增 `/admin/api/status-summary` 聚合接口**：服务端一次性输出整体与按凭据的心跳条（近 60 次）、平均延迟/TTFT、7 天可用性（整体口径取自 `usage_daily` 全量聚合）、24h 请求量。
- **配额刷新绝对时刻**：上游凭证配额卡每个窗口条新增「预计 M月D日 HH:mm 刷新」（本地时区）+ 原倒计时双栏展示；账号卡文件名行改为凭据索引 + 彩色状态。
- **布局美化与存量修复**：页面顶部径向光晕背景、状态卡/心跳条全套样式、健康呼吸灯；修复模型用量分布进度条 inline 高度塌陷不可见与今日请求 QPS 低流量恒显 0.00 的问题；版本号对齐 v2.3.0。

## [v2.2.1] - 2026-09-12
### Added & Aligned
- **Keeper 核心数据全面对齐与无损同步**：
  - 从 Keeper (`app.db`) 全量同步 2026-09-04 至 2026-09-12 历史 `usage_overview_daily_stats` 到 Gate `usage_daily`，补齐历史 9 天所有 API Key、各模型的精细化 Tokens（输入、输出、Prompt Cache 命中与总额度）。
  - 同步 Keeper 历史 `usage_events` 请求流水至 Gate `request_events`，扩充至 5,000 条真实高精度流水。
  - 对齐 Keeper 自定义 `model_price_settings` 定价字典（含 `gemini-3.8-flash-high`、`claude-opus-4-6-thinking`、`claude-sonnet-4-6`、`gpt-5.6-sol`、`gpt-6-astra`、`gemini-3.1-flash-lite` 等）。
- **多主页 Tab 导航与体验升级**：
  - 彻底解构原单页纵向堆叠，划分为 4 大独立主页：上游凭证配额、用量概览与趋势、API 密钥管控、实时请求流水。
  - 上游凭证卡片增加定时自动轮询开关（15s / 30s / 60s / 5m / 手动）。
  - 纠正 Prompt Caching 命中率分母口径，真实呈现长上下文 90%+ 缓存命中效益。
  - 请求流水全面升级：支持毫秒级模糊搜索、100~3000 条按需加载与分页控制。

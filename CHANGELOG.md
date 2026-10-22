# Gate (cpa-gate) Changelog

All notable changes to `cpa-gate` are documented in this file.

## [v2.11.2] - 2026-10-22
- **单凭据主动刷新探针与错误透传加固 (`admin-quotas.js`)**：
  - 在 `admin-quotas.js` 的 `triggerActivateQuotaWindow` 中增加 `data.success === false` 的显式异常拦截，精确捕获并弹出后端上游探针返回的真实错误原因（`data.message || data.error`），杜绝因 HTTP 200 状态码而误报"配额查询完成"；
- **Antigravity 上游周限额瓶颈约束、Disabled 桶拦截与模型冷却解耦渲染**：
  - 深度修复前端在处理 Google Cloud Code PA (`retrieveUserQuotaSummary`) 配额时的逻辑盲区：上游在周限额超限后会将 5 小时滑动窗口标记为 `disabled: true` 但仍返回 `remainingFraction: 1.0`；重构 `admin-quotas.js` 中的 `buildAntigravityMeter`，严格检查 `bkt.disabled` 并在周限额存在时进行瓶颈截断（`effectiveRem = isBktDisabled ? 0 : (isWeeklyBottleneck ? weeklyRem : rawRem)`），彻底根除额度已被周限额扼死却仍死板显示 100% 满额的误导；
  - 解耦单模型冷却与凭证级锁定状态：此前单个模型（如 `claude-3-5-sonnet`）触发 429 冷却时，前端将整个凭据标记为 `isBlocked` 并将全部进度条替换为"额度已隐藏"，同时隐藏"刷新额度"按钮；重构后仅对整凭据冷却（`credential`）隐藏额度，模型级冷却（`models`）展示橙色告警条与精确恢复倒计时，Gemini 等未受限模型进度条保持可见，且"刷新额度"按钮保持可用；
  - 在 `admin-i18n.js` 补齐 `quotas.bucket.weeklyExhausted`、`quotas.bucket.weeklyBottleneck`、`quotas.bucket.cooldownResume` 等 14 项完整双语词条，通过 `test_i18n.mjs` 及全量测试套件。
- **Antigravity 多模型组（Claude 与 Gemini）配额盲区根除与双指示条精细渲染**：
  - 修复此前紧凑模式卡片（`admin-quotas.js`）过滤排除 Claude/GPT 模型组且仅提取渲染 Gemini 5h / 周限额的盲区，彻底解决用户明明消耗了 Claude 额度（如降至 50%）而控制台仍只显示 Gemini 100% 的认知误导；重构 Antigravity 紧凑仪表逻辑，当 Claude 与 Gemini 主力模型组均存在时，并排呈现 `Claude 5h` 与 `Gemini 5h` 独立进度条与激活倒计时，并在悬浮提示中展示各自周限额；
  - 修复 `lib/analytics/status-summary.mjs` 在计算账号整体 5 小时周期（`quota_5h`）时因 `!quota5h` 提前锁定第 0 组（Gemini 100%）而漏掉第 1 组（Claude 50%）的缺陷，重构为多组瓶颈动态筛选（选取剩余百分比最小的紧缺窗口，同等比例下优先倾斜 Claude），确保总览大盘与运行卡片精准反映真实额度瓶颈；
  - 在 `admin-i18n.js` 补齐 `quotas.bucket.claudeRolling5h`、`quotas.bucket.claudeWeekly` 与 `quotas.bucket.claudeWeeklyTotal` 双语翻译词条，通过 `tests/test_i18n.mjs` 字典完整性与 16 组全量自动化集成测试。
- **控制台路径完整对齐与镜像支持 (`/console/*`)**：在 `lib/routes/static-routes.mjs`、`lib/routes/admin-routes.mjs` 与 `lib/routes/upstream-proxy.mjs` 中为 `/console` 及其静态资源、API、上游反代路径提供对等镜像别名，使 `/console/api/upstream-quotas` 与 `/console/upstream/` 全链路与原生 CPA 控制台平滑互通。
- **上游原生控制台动态前缀感知与脚本注入**：升级 `getScriptInjection()` 中的 URL 重写逻辑，根据当前视窗路由自动区分 `/console/upstream` 或 `/admin/upstream` 基准前缀，保持反向代理受控隔离通道一致性。

## [v2.11.1] - 2026-10-21
- **上游凭证配额网络异常与空 JSON 解析崩溃修复**：彻底解决上游凭证控制台因 `Failed to execute 'json' on 'Response': Unexpected end of JSON input` 抛出拉取网络异常的缺陷。在 `admin-quotas.js` 中引入安全文本流读取（`await res.text()`）与结构化 JSON 解析，对空响应或异常文本安全降级至 `{ accounts: [] }` 并保持控制台正常渲染。
- **服务端 JSON 响应序列化生命周期加固**：重构 `lib/config.mjs`、`lib/routes/admin-routes.mjs` 与 `lib/routes/member-routes.mjs` 中的 `writeJson` 实现，确保在调用 `res.writeHead` 提交 HTTP 状态头之前完成 `JSON.stringify(payload ?? null)`，杜绝因未定义或不可序列化字段导致头部提前下发后产生 0 字节截断；显式计算 UTF-8 字节长度并输出精确的 `Content-Length` 头，阻断 Transfer-Encoding: chunked 提前终止风险。
- **异步刷新路由对齐与 Key 删除统一 await**：将 `/admin/api/upstream-quotas` 带有 `?refresh=1` 或 POST 刷新的路由重构为 `await syncUpstreamQuotas(true)`，并将 `/admin/api/keys/:id` 删除重构为统一 `await` 异步等待，防止外层处理函数在异步 I/O 结束前提前退出。
- **国际化函数 t() 局部变量遮蔽防护**：修复 `admin.html` 中 `formatResetAbs`（`const t = new Date(iso)`）与 `admin-logs.js` 中 `errorTypeLabel(t)` 局部形参遮蔽全局翻译函数 `t()` 导致的潜在 `TypeError`；在 `tests/test_i18n.mjs` 补充静态语法树扫描守卫（测试 8），防止未来代码引入局部 `t` 标识符。
- **新增上游配额路由与安全序列化测试套件**：新增 `tests/test_upstream_quotas_route.mjs`，包含 `writeJson` 异常捕获与字节头精确对齐、`/admin/api/upstream-quotas` 完整生命周期、以及前端解析弹性沙箱单测，全量 16 个自动化测试套件全绿。

## [v2.11.0] - 2026-10-20
- **控制台中英双语国际化 (i18n) 全栈落地**：上线 `admin-i18n.js` 集中翻译字典（1099 条 `{ zh, en }`）与全局 `t(key, vars?)` helper，顶栏新增语言切换按钮（`EN` / `中文`），支持 `zh-CN` 与 `en` 实时无缝切换与 `localStorage['gate_lang']` 持久化；管理台 `admin.html`、`admin-*.js`、导航侧边栏、表单提示、表格字段、图表文字及状态胶囊全面覆盖双语字典，彻底告别中文单语。
- **静态与动态文案双向打通**：静态文案通过 `data-i18n` / `data-i18n-title` / `data-i18n-placeholder` / `data-i18n-aria-label` 绑定，动态渲染文案在渲染时经 `t()` 取值；`pageMeta` 改为存储字典 key 而非已翻译文案，使 `admin-overview.js` 的运行时写入在切换语言后依然正确。切换后 `relocalizeDynamicUI()` 依据内存 `cached*` 缓存重绘当前页，无需重新请求网络；`<html lang>` 与 `Intl` / `toLocaleString` 的显示 locale 同步切换。
- **i18n 静默失效防护**：将原本拿中文字面量做 `===` / `!==` 比较的 10 处逻辑改为比较底层数据 key（服务状态徽章、WorkBuddy 资源包排序、图表全量历史档位、已删除账号识别等），并将显示 locale 从硬编码 `zh-CN` 提为 `LOCALE` 常量（保留 `admin-stats.js` 中作为日期键生成器的 `en-CA`）。
- **双语文档体系**：`docs/` 下 5 篇文档改为「英文段在前 + `<a id="中文版"></a>` 锚点 + 中文段在后」同文件双段结构，顶部附 `[English](#top) | [中文](#中文版)` 切换行，与仓库既有 `README.md` 惯例一致。`COMMUNITY_SUBMISSIONS.md` 的中英文条目块与 `LAUNCH_COPYWRITING.md` 的 Reddit / Show HN、X / Twitter 文案作为逐字交付物原样保留；`workbuddy-integration.md` 中上游 API 原始数据（`"PackageName": "标准基础月度积分包"`）按原样保留中文。
- **Qoder 官方品牌高清矢量与自适应图标**：同步引入 Qoder 官方品牌矢量 SVG 及浅色/深色透明自适应 PNG 资产至 `gate-assets/`，在管理台与提供商标识中统一呈现。
- **国际化回归测试套件**：新增 `tests/test_i18n.mjs`（15 个自动化测试套件之一），7 类闸门覆盖字典结构与键名引用完整性、`t()` 缺键回落与插值、`setLocale` 同步 `<html lang>` / `LOCALE` / `localStorage`、静态标记覆盖、中文字面量不得参与逻辑比较、显示 locale 不得硬编码、渲染代码中不得残留中文字面量（`i18n-exempt` 注释可显式豁免），15 个自动化测试套件全量通过。
- **同步更新**：`README.md` / `AGENTS.md` / `llms.txt` / `llms-full.txt` 的测试套件计数 14 -> 15；`llms-full.txt` 新增「Console internationalization (zh/en)」章节（现共 19 章），并补充控制台语言切换的故障排查条目。

## [v2.10.7] - 2026-10-20
- **API Key 模型白名单动态倍率适配**：`isModelPermitted` 智能剥离动态积分倍率后缀（`:\d+(?:\.\d+)?x`），双向支持带倍率请求与无倍率规则、带倍率规则与无倍率请求的无损匹配，彻底防止上游 WorkBuddy 动态积分倍率模型（如 `workbuddy/claude-opus-5-5:3.33x`）被网关白名单误判阻断。
- **Qoder (通义灵码) 双域服务商全链路注册与支持**：在 `INITIAL_PROVIDER_REGISTRY` 注册 `qoder-cn`（`sort_order: 74`）与 `qoder`（`sort_order: 75`），精准区分国内版与国际版；前端控制台 `admin.html`、`admin-logs.js`、`admin-quotas.js`、`admin-style.css` 与 `admin-routes.mjs` 全面支持 Qoder 品牌展示、图标与胶囊（`#ff6a00`）、流水推断、凭证过滤及 OAuth 路由。
- **Qoder 官方品牌图标与管理面板同步**：控制台与 CPA 管理面板接入阿里通义灵码 (Qoder) 官方高清图标（支持浅色/深色透明自适应与用户品牌图标资产），同步更新 `static/management.html` 并保持跨仓库 MD5 一致（`60b99ac5c47fd6cd54ddb4b1c4ee537b`）。
- **全链路集成与端到端测试**：更新 `tests/test_key_model_and_quota_restrictions.mjs` 与 `tests/test_gate_features.mjs`（新增测试 32），14 个测试套件全量通过。

## [v2.10.6] - 2026-10-20
- **上游 CPA 控制台同步与 Qoder 双域支持**：从 `cliproxyapi` 同步最新 `static/management.html`（MD5 `56e6d6a4e9a62ea055dd6a5f2743117e`），新增 Qoder 国际版 (`qoder`) 与国内版 (`qoder-cn`) OAuth 登录卡片、标签过滤、SVG 图标与账号别名规范支持。

## [v2.10.5] - 2026-10-19
- **WorkBuddy 远期基础包语义净化**：针对腾讯 API 为免费/体验包返回的远期哨兵时间（`>= 3` 年，如 `2035-01-15`）或包名含 `Free Plan`/`体验`/`免费` 且 `> 1` 年的资源包，解决此前展示机械天数倒计时的问题，在 `getWorkBuddyExpirationInfo` 与 `sync.mjs` 中统一净化为翡翠绿 `"长期有效"`（`#10b981`），Tooltip 保留完整物理时间戳；混合账号的"首批到期"严格锚定短期包。
- **资源包排版防截断与验证**：远期包左侧包名最大宽度由 `55%` 放宽至 `72%`，解决 `Free Plan Subscription` 截断问题；新增长期包与混合包单测，`npm test` 14 个测试套件全部通过。

## [v2.10.4] - 2026-10-19
- **WorkBuddy 跨年日期与多梯度倒计时**：修复 `getWorkBuddyExpirationInfo` 丢弃跨年年份导致远期包被误认为近期到期的缺陷，非当年到期包强制输出完整年份（`YYYY年MM月DD日 HH:mm`）；倒计时按 `<24h`、`<72h`、`<365d`、`1~3y`、`>=3y` 分级展示，`npm test` 14 个测试套件全部通过。

## [v2.10.3] - 2026-10-19
- **API Key 模型白名单与限额持久化修复**：修复 `updateQuotaRule` 强制 `String(model_whitelist)` 将数组转为逗号串破坏 JSON 的根因，新增 `normalizeModelWhitelist` / `parseModelWhitelist` 与前端 `parseModelList`；输入每日限额时自动联动开启硬限额开关，未启用限额标注 `(未启用)`。
- **多协议凭证穿透与智能模型匹配**：`extractRawKey` / `resolveKeyId` 统一解析 `Authorization: Bearer`、Anthropic `x-api-key`、Azure `api-key`、Gemini `x-goog-api-key` 及 URL `?key=`，解决非 Bearer 客户端绕过热路径限制的漏洞；`isModelPermitted` 支持大小写不敏感、厂商前缀剥离（`anthropic/...`）、通配符（`gpt-4o*`）与版本日期后缀（`-20250219`、`@20250219`），并拦截 Gemini REST `/models/{model}:*` 路径；新增 `tests/test_key_model_and_quota_restrictions.mjs`，14 个测试套件全部通过。

## [v2.10.2] - 2026-10-19
- **上游 CPA 控制台同步**：从 `cliproxyapi` 同步最新 `static/management.html`（MD5 `17164d99ee3b5da5a5b5fa3be5926a07`），修复 WorkBuddy 签到套件在 Axios 解包后的防御性访问缺陷（`p(e?.data || e)`）导致的抽屉状态重置为 `undefined` 问题，全量自动化测试通过。

## [v2.10.1] - 2026-10-19
- **CPA 凭证别名权威解析与流水穿透**：解决上游改名后请求流水仍展示裸 `.json` 文件名及按别名搜索无果的问题，新增 `resolveAuthAccountDisplayName` 分级决策树（`nickname` -> `label` 括号非区域别名 -> 非通用 `email` -> 自定义 `label` -> 去 `.json` 文件名 -> `auth_index`）；请求流水、错误中心、状态大盘与配额页全面展示友好别名并剥离 `.json` 后缀。
- **CI 沙箱隔离**：`tests/_isolated-db.mjs` 注入独立 `GATE_OPENROUTER_ACCOUNTS_PATH`，根除干净 CI Runner 缺少宿主机 `data/openrouter-accounts.json` 触发 404 的问题，13 个测试套件全部通过。

## [v2.10.0] - 2026-10-18
- **开源冷启动修复**：解决新 clone 因进程不读 `.env` 报 `CPA_MGMT_SECRET` 错误及 `GATE_DIR` 仅含 SQLite 导致 `/admin` 500 的两个阻断缺陷；启动时自动加载工作目录 `.env`（进程环境变量优先，兼容 Node 20.0+），新增 `STATIC_DIR` 默认从安装根目录解析静态资源并回退 `GATE_DIR`。
- **凭据卫生与重试可配置化**：将 `test_opencode_quota_and_deleted_separation.mjs` 中的样例 Key 替换为 `sk-or-v1-PLACEHOLDER-NOT-A-REAL-KEY-DO-NOT-USE` 明示占位串（原 Key 仅进入过私有历史 `aafd272`，公开仓库历史从未包含），新增 `tests/test_repo_hygiene.mjs` 全仓凭据扫描闸门与 `tests/test_static_assets_layout.mjs`；新增 `GATE_MAX_ATTEMPTS`（默认 `1`，范围 `1..5`）。
- **开源治理与检索规范**：补齐 `package.json` 元数据与 `files` 白名单、GitHub Actions CI（Node 20/22/24）、Issue/PR 模板、`llms.txt` 与 `llms-full.txt`，13 个测试套件全部通过。

## [v2.9.66] - 2026-10-18
- **WorkBuddy 多包健壮性加固**：修复 `CycleCapacityRemain` 为 `null` 时 `Number(null) === 0` 导致的容量回退短路；修复无到期日资源包被误标 `hasExpiration: true` 的缺陷；`status-summary.mjs` 改用 `flatMap` 导出全部分组资源包；提取 `normalizeCstTimeString` 强化跨时区容器东八区时间解析。

## [v2.9.65] - 2026-10-18
- **WorkBuddy 多资源包分批到期追踪**：`queryWorkBuddyFreePackages` 全量拉取各资源包独立到期时间并按截止时间升序排列（挂载至 `acc.expiration_packages`）；凭据卡片、紧凑表格与总览大卡支持分批到期清单与悬浮气泡明细展示。

## [v2.9.64] - 2026-10-18
- **东八区单点真理源与配额并发刷新**：`getWorkBuddyExpirationInfo` 统一采用 `targetTs + 8 * 3600 * 1000` + UTC getters 消除跨时区偏移；`activateUpstreamQuotaWindow` 改用 `Promise.allSettled` 并行请求 CPA 与腾讯直连接口，直连异常时保底复用 CPA 数据。

## [v2.9.63] - 2026-10-17
- **WorkBuddy 积分到期时间全链路透传**：实现 CPA `/v0/management/quota/fetch` 与腾讯官方 `get-user-resource-free-packages`（注入必填分页参数 `PageNumber: 1, PageSize: 50`）双轨获取，透传 `expires_at`、`runs_out_points` 与三阶紧急度染色倒计时。

## [v2.9.62] - 2026-10-17
- **移动端窄屏刻度稀疏化与时区常量收敛**：在 `lib/config.mjs` 集中定义 `CHINA_TZ_OFFSET_SECONDS = 28800`；`<480px` 超窄屏下自适应隐藏中间奇数位 X 轴刻度（`ovw-xaxis-sparse-hide`）防止重叠。

## [v2.9.61] - 2026-10-17
- **基于真实凭证 `auth_index` 的提供商 Token 权威归属**：在 `sqlite.mjs` 新增 `(auth_index, model)` 预编译聚合查询，联合 `request_events` 与内存 Outbox 溯源真实调用凭证，根治 WorkBuddy 跑 `-free` 模型被正则误归入 OpenCode Zen 的缺陷。
- **Anthropic 思考档位提取与 30d 自然日对齐**：`extractReasoningEffort` 优先识别 `output_config.effort` 与 `thinking.effort`；运行总览天级分桶对齐北京时间 `00:00–24:00` 并为静态资源注入 `?v=` 防缓存参数。

## [v2.9.60] - 2026-10-17
- **Anthropic 流式深度思考与工具调用守卫**：在 `lib/proxy/transport.mjs` 补齐 `/v1/messages` 流式 `delta.thinking`、`delta.signature`、`delta.partial_json` 与 `content_block` 语义识别，防止深度思考或大参数工具调用被误判为 502 空流。

## [v2.9.59] - 2026-10-17
- **SQLite 整数模除分桶与 30d 窗口**：修复 SQLite `(ts / ?) * ?` 浮点除法导致的分桶查找落空，改用 `(ts - (ts % ?))` 整数截断；新增 `30d` 预设（共 `3h20m`/`5h`/`1d`/`3d`/`7d`/`30d` 六档）；修复多尺度 X 轴刻度提取与 OAuth/API Key 提供商并集归集。

## [v2.9.58] - 2026-10-17
- **CPA `openai-compatibility` 16 位 `auth_index` 权威接入**：`sync.mjs` 同步拉取 `/v0/management/openai-compatibility`，提取 OpenCode / OpenRouter / StepFun 的真实 16 位 `auth_index`，消除活跃 API Key 凭据被误判为已删除账号的问题。

## [v2.9.57] - 2026-10-17
- **OpenCode 原生今日用量卡片与已删除账号准确归档**：基于 `upstream_daily_stats` 展示 OpenCode 当日 Token 与请求数；以 CPA 活跃目录为唯一真理源判定 `is_deleted`，并为 `syncUpstreamQuotas` 增加 `inFlightSyncPromise` 互斥锁防止冷启动误判。

## [v2.9.56] - 2026-10-17
- **全链路优雅停机与流式排空 (`lib/core/graceful-shutdown.mjs`)**：接管 `SIGTERM`/`SIGINT`，停机期新请求与探针快速返回 `503`，在途 HTTP/SSE 流式请求与 WebSocket 自然排空并注入 `Connection: close`，排空后执行 `flushUsage()` 落盘；新增 `/admin/api/runtime-facts?window=` 多时间窗口切换。

## [v2.9.54] - 2026-10-17
- **模型后缀思考强度启发式推断**：`extractReasoningEffort` 支持在无显式入参时从模型名后缀 `[-_:](high|medium|low|max)$` 推断思考强度（仅作用于审计与展示，不改写上游请求体）。

## [v2.9.53] - 2026-10-17
- **流水速率徽章纯净化**：移除请求流水 `tok/s` 徽章中的闪电 Emoji，统一为 Aozora 纯数字与色阶胶囊。

## [v2.9.52] - 2026-10-17
- **运行总览路由策略下拉组件统一**：将原生 `<select id="ovw-routing-strategy">` 升级为支持键盘导航与碰撞翻转的 `CustomDropdown`。

## [v2.9.51] - 2026-10-17
- **请求流水新增思考强度与生成速率 (`tok/s`)**：跨 OpenAI/Anthropic/Gemini 提取 `reasoning_effort`，流式请求扣除 TTFT 计算纯输出 `tokens_per_sec`，并在 `request_events` 与 `usage_outbox` 落盘展示。

## [v2.9.50] - 2026-10-17
- **OpenCode 免费模型推断优先级修正**：将 `opencode` (`-free`) 的匹配优先级调整至 `stepfun` (`step*`) 之前，修复 `step-5-preview-free` 被误标为 StepFun 的问题。

## [v2.9.49] - 2026-10-17
- **上游 HTTP Keep-Alive 长连接池与模型搜索选择器**：引入单例 Keep-Alive Agent 复用上游 TCP 连接；新增支持搜索过滤的 Aozora 模型选择器组件。

## [v2.9.48] - 2026-10-17
- **API Key 模型权限胶囊归一化与实时模型发现**：统一密钥表格中的模型权限胶囊排版，支持从上游实时拉取可用模型列表供勾选配置。

## [v2.9.47] - 2026-10-17
- **仓库协同规约清理**：移除项目内冗余的外部协同文件，保持仓库边界干净。

## [v2.9.46] - 2026-10-17
- **控制台顶部场景纯净化**：移除顶部冗余装饰字眉，同步侧边栏品牌版本标识。

## [v2.9.45] - 2026-10-16
- **实时流量图表重构为 Gate 本地双轨流 (`live-traffic-tracker.mjs`)**：结合内存时间槽与 SQLite `request_events` 提供实时流量趋势，彻底免疫上游 CPA 重启导致的图表归零。

## [v2.9.44] - 2026-10-16
- **流水热更新下拉防穿透与状态保持**：修复请求流水定时刷新时的 CSS 层叠上下文穿透，保持已展开下拉菜单的滚动与选中状态。

## [v2.9.43] - 2026-10-16
- **侧边栏徽标口径改为今日计数**：侧边栏请求流水与故障中心徽标由历史累计改为展示 `Asia/Shanghai` 当日请求与故障数，跨天自动归零。

## [v2.9.42] - 2026-10-16
- **页面副标题降噪**：移除各工作区副标题顶部的全大写英文字眉装饰。

## [v2.9.41] - 2026-10-16
- **凭据大盘卡片接入 WorkBuddy 积分与 OpenRouter 今日请求水位**：在 `/admin/api/upstream-auth-stats` 与 `admin-quotas.js` 中统一渲染异构提供商的实时配额进度条。

## [v2.9.40] - 2026-10-16
- **管理台前端模块化拆分**：将单体 `admin.html` 拆分为 `admin-style.css`、`admin-overview.css` 及 `admin-overview.js`、`admin-quotas.js`、`admin-keys.js`、`admin-logs.js`、`admin-cpa.js`，配合静态路由 ETag 缓存分发。

## [v2.9.39] - 2026-10-16
- **Google Antigravity 客户端 UA 门槛升级与多端点容灾**：升级 UA 至 `antigravity/cli/1.3.6`（满足 `>=1.2.0` 门槛以获取完整 Gemini 模型组），并实现 `daily` / `prod` / `sandbox` 三端点容灾轮询。

## [v2.9.38] - 2026-10-15
- **API Key 表格美化与 WorkBuddy 积分展示**：重构密钥管理表格排版对齐，并在上游凭据卡片中支持腾讯 WorkBuddy / CodeBuddy 剩余积分与资源包展示。

## [v2.9.37] - 2026-10-15
- **请求流水新增上游服务商筛选**：前后端打通按 `provider` 维度过滤实时请求流水。

## [v2.9.36] - 2026-10-15
- **提供商注册表平滑升级与前端回落对齐**：优化 `provider_registry` 增量升级逻辑，对齐前后端离线模型推断规则。

## [v2.9.35] - 2026-10-15
- **已删除历史凭据折叠归档**：将已从 CPA 移除但保留历史流水的账号收拢至底部折叠归档区，释放主监控面板。

## [v2.9.34] - 2026-10-15
- **凭证统计重构为账号卡片网格与 OpenRouter 本地自治**：剥离内嵌 CPA 配置页，将凭证统计升级为 Aozora 卡片网格，并实现 OpenRouter 账号本地存储与配额面板。

## [v2.9.33] - 2026-10-15
- **明确 CPA 与 Gate 控制台边界**：从 Gate 主界面剥离重复的"账号接入"与"提供商"内嵌页，统一收口至受控反代 `/admin/upstream/*`。

## [v2.9.32] - 2026-10-15
- **OpenRouter 配额集成测试套件**：新增 `tests/test_openrouter_quota.mjs` 并纳入 `npm test`。

## [v2.9.31] - 2026-10-15
- **OpenRouter 免费层每日配额探测**：集成 OpenRouter 每日 800 次免费限额、UTC 00:00 重置计算与就地探针刷新。

## [v2.9.30] - 2026-10-15
- **上下行 HTTP 压缩感知与 WebSocket 全双工代理**：支持客户端 `gzip`/`deflate`/`br` 请求体解压、下行压缩流 Token 审计解压，以及带鉴权/限额守卫的 WebSocket 升级透传（`tests/test_compression_websocket.mjs`）。

## [v2.9.29] - 2026-10-15
- **静态资源 WebP、Gzip 压缩与 ETag 304 缓存**：全面优化管理台静态资产体积与首屏加载性能。

## [v2.9.28] - 2026-10-14
- **仓库 `.gitignore` 边界治理**：规范化本地开发辅助配置与运行数据的 Git 忽略规则。

## [v2.9.27] - 2026-10-14
- **全面替换原生 Emoji 为单色细线条矢量 SVG 图标**：确立 Aozora UI 零 Emoji 污染视觉规范。

## [v2.9.26] - 2026-10-14
- **对齐上游 CPA Smart/Pace 路由调度与管理面板**：同步最新 `static/management.html` 与上游路由策略枚举。

## [v2.9.25] - 2026-10-14
- **请求流水增量 DOM-Diffing 物理展开动效**：新到达流水行采用平滑高度展开与内容下落动画，避免整表闪烁重绘。

## [v2.9.24] - 2026-10-13
- **全局单一轮询循环与扁平控件重构**：合并分散的前端定时器为单一权威轮询，简化嵌套边框。

## [v2.9.23] - 2026-10-13
- **前端自适应平滑刷新**：页面隐藏时降频轮询、唤醒时即时水合，减少后台资源占用。

## [v2.9.22] - 2026-10-13
- **提供商紧凑卡片与折叠密钥池**：优化多密钥渠道在管理台中的紧凑折叠展示。

## [v2.9.21] - 2026-10-13
- **吞吐图表 Aozora 浮动白卡 Tooltip 与 502 `auth_index` 补齐**：重构图表悬浮气泡样式，并在 502 空流错误中保留上游 `auth_index` 归因。

## [v2.9.20] - 2026-10-13
- **吞吐图表错误归因与一键下钻**：悬停显示错误分类明细，点击异常柱直接跳转请求流水对应时段。

## [v2.9.19] - 2026-10-13
- **今日用量 24 小时分时趋势与流式缓存命中率修复**：新增当日 24 小时分时柱状图，修复流式响应中 `cached_tokens` 统计遗漏。

## [v2.9.18] - 2026-10-13
- **官方品牌矢量图标对齐**：统一 Anthropic、Google、OpenAI、DeepSeek、Qwen 等服务商官方 SVG 标识。

## [v2.9.17] - 2026-10-13
- **腾讯 WorkBuddy / CodeBuddy 上游提供商接入**：支持 `workbuddy` 与 `workbuddy-cn` 渠道识别、图标与配额探针接入。

## [v2.9.16] - 2026-10-13
- **用量趋势顶部五联 KPI 卡片多周期联动**：切换 7 天/14 天/30 天/全部历史时，顶部汇总卡片同步重算。

## [v2.9.15] - 2026-10-12
- **测试数据库沙箱隔离 (`tests/_isolated-db.mjs`)**：所有涉及 SQLite 的测试自动在独立临时目录子进程中运行，零污染宿主数据。

## [v2.9.14] - 2026-10-12
- **管理台凭据安全加固**：管理密钥改存 `sessionStorage`，Key 列表仅返回脱敏 `display_key`，查看明文需单 Key 显式调用 reveal 接口。

## [v2.9.13] - 2026-10-12
- **升级内置 CPAMC 管理台至 v1.26.2**：同步上游管理中心并保留 OpenCode 与 WorkBuddy 支持。

## [v2.9.12] - 2026-10-12
- **请求流水支持按原始 API Key 检索**：搜索框输入完整或部分原始 Key 时自动解析为对应 `key_id` 过滤流水。

## [v2.9.11] - 2026-10-12
- **CPA OAuth 授权新增 WorkBuddy / CodeBuddy 入口**：在管理路由与前端接入向导中打通腾讯双域 OAuth。

## [v2.9.10] - 2026-10-12
- **客户端中断 (HTTP 499) 审计入库**：客户端中途断连时按已生成内容估算 Token 并记录为 `499 client_closed`，消除流水漏记。

## [v2.9.9] - 2026-10-12
- **请求流水与错误中心提供商推断兜底**：修复 API 渠道凭证掉入"其他上游"及展示 16 位裸哈希的问题。

## [v2.9.8] - 2026-10-11
- **管理台多级 SWR 缓存与首屏即时水合 (`test_gate_caching.mjs`)**：实现请求流水、密钥与故障中心 0ms 切页水合。

## [v2.9.7] - 2026-10-11
- **CPA 日志管道防爆加固**：移除 8MB 整体报错硬墙，改为安全尾部截断并修复截断处的残缺 JSON 行。

## [v2.9.6] - 2026-10-11
- **上游账号身份补全与"最近模型"列**：四层元数据回退避免裸哈希展示，登记 `stealth` 提供商，凭证表新增最近调用模型列。

## [v2.9.5] - 2026-10-11
- **历史全量档位提供商模型名回落推断**：无 baseline 的历史记录按模型名规则兜底归类提供商。

## [v2.9.4] - 2026-10-11
- **CPA 日志面板按 1h/6h/24h 分档加载**：根治打开日志面板时全量拉取卡死的问题。

## [v2.9.3] - 2026-10-11
- **区分组级"近期空闲 (Idle)"与"暂无数据 (No-Data)"**：修复近 1 小时无请求但 7 天内有流量的服务组被误标为"暂无数据"。

## [v2.9.2] - 2026-10-11
- **修复组级健康小样本误报 (`deriveGroupHealth`)**：当前状态仅看近 60 分钟，避免 7 天前的单次失败将健康组永久钉为重大故障。

## [v2.9.1] - 2026-10-11
- **过滤 CPA 非提供商类型并放行中文提供商名**：防止配置项类型泄漏为假提供商分组，支持中文渠道名。

## [v2.9.0] - 2026-10-11
- **移除 Gate 自建号池死代码（净删 2700 行）**：确立"CPA 负责凭据与上游接入，Gate 负责多租户限额、传输守卫与审计"的严格边界。

## [v2.8.9] - 2026-10-11
- **建立 `provider_registry` 数据库表唯一真理源**：收敛全栈 4 处硬编码正则，移除源码中的生产账号特征，开放 `/admin/api/provider-registry` 管理接口。

## [v2.8.8] - 2026-10-10
- **服务状态按提供商分组监测与流水 Key 筛选全量化**：服务状态按提供商聚合心跳，修复 `/api/member/status-summary` 响应契约。

## [v2.8.7] - 2026-10-10
- **Token 监控高精度模型折算与凭证列表净化**：基于 `model_prices` 精细化折算输入/缓存/输出成本，净化上游凭证列表。

## [v2.8.6] - 2026-10-10
- **修复 CPA 控制台 OpenCode `sheetSize` 报错与品牌图标**：补齐 OpenCode 矢量品牌标识与管理台兼容性修复。

## [v2.8.5] - 2026-10-10
- **OpenCode 升级为一等提供商**：支持 OpenCode 渠道识别、协议头部适配与卡片图标展示。

## [v2.8.4] - 2026-10-10
- **深度分页延迟关联优化 (`test_gate_pagination.mjs`)**：使用 SQLite 延迟关联（Deferred Join）与游标加速大偏移量流水查询，支持多时间跨度筛选。

## [v2.8.3] - 2026-10-10
- **全量历史用量看板与服务端真分页**：新增全部历史累计 Token 统计，解除前端 300 条伪分页限制，升级为服务端分页。

## [v2.8.2] - 2026-10-09
- **按需靶向刷新与敏感信息默认折叠遮罩**：仅刷新当前激活 Tab，敏感配置默认圆点遮罩收起，保障 60 FPS 流畅度。

## [v2.8.1] - 2026-10-09
- **提供商分栏与手风琴折叠视图**：重构长列表为 Master-Detail 分栏与折叠卡片，修复探活响应解析与脱敏密钥复制。

## [v2.8.0] - 2026-10-09
- **多 Key 监控与加权轮询探针尝试**：探索多 Key 渠道状态监控与 429 冷却状态机（后于 v2.9.0 收敛归并至 CPA 上游边界）。

## [v2.7.6] - 2026-10-09
- **模型定价字段对齐与多处边界防御**：修复定价弹窗 pattern 字段错位、流水跨天时间戳格式化、配额进度条 `NaN` 防御及模型别名数组形态兼容。

## [v2.7.4] - 2026-10-09
- **可用模型目录索引修复与 OpenAI 兼容渠道归因**：修复模型目录数字索引 Bug，纠正 OpenAI 兼容渠道被误标为 Antigravity 的问题。

## [v2.7.3] - 2026-10-08
- **可用模型实时搜索与 YAML 编辑器安全收拢**：模型目录支持实时搜索与滚动视图，完整 YAML 编辑器移入折叠危险区防误触。

## [v2.7.2] - 2026-10-08
- **路由调度策略端点双向打通**：打通 `/admin/api/runtime-config` 路由策略读写与可用模型下拉同步。

## [v2.7.1] - 2026-10-08
- **故障中心时间归一化与承接账号全链路追踪**：根除微秒时间戳溢出乱序，在请求流水与错误中心统一展示承接请求的 `auth_index` 账号及配额重置倒计时。

## [v2.7.0] - 2026-10-08
- **流式反压、热路径 O(1) 与 SQLite 性能调优**：消除 SSE 流式转发 EventEmitter 内存泄漏，客户端断连即时销毁上游请求；配额校验热路径 O(1) 化，静态管理页内存缓存，调优 SQLite WAL Pragma。

## [v2.6.9] - 2026-10-08
- **模型中心在线探针、冷却中心与会话粘性控制**：支持在线发起模型可用性探针、一键解冻冷却凭据及全局模型别名可视化映射。

## [v2.6.8] - 2026-10-07
- **死代码清理与运行时缓存一致性加固**：清理废弃模块，写操作后主动失效 `runtime-facts` 缓存，补齐剪贴板复制降级保护。

## [v2.6.7] - 2026-10-06
- **原生管理面板 `/admin/upstream/*` 绝对路径重写与错误日志检视器**：注入脚本自动将 `/v0/management/*` 重写至受控代理路径，新增浏览器内错误日志检视器与 OAuth 设备码回调加固。

## [v2.6.6] - 2026-10-06
- **凭据高级属性双模编辑器与 CPA 日志检索**：支持可视化与 JSON 双模编辑凭据属性（`priority`/`weight`/`note`/`proxy_url`），兼容 `/v0` 与 `/v8` 管理路由。

## [v2.6.5] - 2026-10-06
- **受控反向代理原生 CPA 管理台 (`/admin/upstream/*`)**：服务端内存注入 `GATE_MGMT_SECRET` 反代 `static/management.html`，外层拦截未授权管理探测以防触发 CPA 30 分钟 IP 封禁。

## [v2.6.4] - 2026-10-06
- **运行总览总量与分桶图同源对齐**：消除前端重复求和导致的口径偏差。

## [v2.6.3] - 2026-09-28
- **修复弹窗键名不一致误报离线与休眠唤醒自愈**：统一响应键名契约，页面从休眠唤醒时自动重连刷新，修复紧凑视图留白。

## [v2.6.2] - 2026-09-27
- **上游凭据默认优先级对齐 CPA (`DEFAULT_AUTH_PRIORITY = 0`)**：清除 `?? 10` 残留，修复打开编辑弹窗未修改即改写默认档位的缺陷。

## [v2.6.1] - 2026-09-26
- **运行总览图表纵轴刻度与基线优化**：纵轴刻度改用 `fmtInt()` 半轴对齐，强化零基线视觉清晰度。

## [v2.6.0] - 2026-09-26
- **新增路由配置读写 (`lib/upstream/routing.mjs`) 与凭据批量操作 (`lib/upstream/batch.mjs`)**：上线 `PUT /admin/api/upstream-routing` 与 `PUT /admin/api/upstream-auth/batch`，支持批量启停/删除/改优先级。

## [v2.5.0] - 2026-09-26
- **新增"运行总览"首屏与运行时事实聚合层 (`lib/upstream/runtime-stats.mjs`)**：上线 `GET /admin/api/runtime-facts`，准确区分冷却中凭据与可用凭据，静态资源缺失时返回 404 而非退出进程。

## [v2.4.12] - 2026-09-26
- **修复 `/admin/api/upstream-quotas` 刷新响应缺字段**：补齐强制刷新路径下的统计返回结构。

## [v2.4.11] - 2026-09-26
- **上游凭据调度默认档位收敛为单一常量契约**：在 `lib/config.mjs` 中集中管理优先级与权重区间（`0..1000` / `1..1000`）。

## [v2.4.10] - 2026-09-25
- **修复 `admin.html` 内联脚本语法错误并新增 AST 编译测试**：使用 `new vm.Script()` 在测试中锁死前端脚本语法安全。

## [v2.4.9] - 2026-09-25
- **顶部刷新按钮按页面解耦与客户端秒级实时倒计时**：修复 Antigravity 满额度倒计时静止假象，引入前端 `data-reset-iso` 实时倒计时刷新。

## [v2.4.8] - 2026-09-25
- **侧边栏 SVG 图标统一与领域导航聚合**：重构侧边栏导航分组与高对比度矢量图标。

## [v2.4.7] - 2026-09-25
- **自定义 DOM 下拉组件 (`CustomDropdown`)**：替换浏览器原生 `<select>` 弹窗。

## [v2.4.6] - 2026-09-25
- **管理台卡片与表单交互细节打磨**：统一按钮间距、输入框焦点态与弹窗过渡动效。

## [v2.4.5] - 2026-09-25
- **修正 Antigravity/Gemini 额度查询主机与百分比精度**：改用与个人账号一致的 `daily-cloudcode-pa` 主机查询额度并保留精确百分比。

## [v2.4.4] - 2026-09-25
- **优化 OAuth 授权链接生成体验**：改为在页面内生成并复制授权链接，不再强制弹出新窗口。

## [v2.4.3] - 2026-09-25
- **CPA 日志默认读取最近 1 小时并增量刷新**：避免单次拉取上百 MB 全量日志触发 8MB 响应上限。

## [v2.4.2] - 2026-09-25
- **OAuth 模型别名与排除规则可视化编辑**：保存前重新核对 CPA 当前配置，防止覆盖并发修改。

## [v2.4.1] - 2026-09-25
- **CPA 管理适配器合入主仓与多厂商按需额度卡片**：认证文件支持筛选与批量上传删除；新增 Claude、Kimi、xAI、Codeium、Meta 按需额度查询。

## [v2.4.0] - 2026-09-24
- **新增 CPA 管理适配器与自定义 Key 导入/原 ID 轮换**：支持导入指定 Key 字符串、按原 ID 轮换密钥（`crypto.randomBytes`）；停止自动删除历史每日用量。

## [v2.3.15] - 2026-09-24
- **Antigravity 验证完成状态自愈闭环**：配额巡检恢复正常后自动调用 `resolveUpstreamValidationByAuth` 将待验证工单标记为 `resolved`。

## [v2.3.14] - 2026-09-24
- **配额巡检自动拦截 403 `VALIDATION_REQUIRED`**：巡检遇到 Google 403 验证要求时自动提取 `validation_url` 存入 `upstream_validations` 并在卡片高亮提示。

## [v2.3.13] - 2026-09-24
- **上游凭证页物理拆解、Google 403 链接智能补全与流水 Read-Your-Writes**：将服务状态与凭证统计拆为独立侧栏页面；新增 `completeGoogleValidationUrl` 补全 `continue`/`sarp`/`flowName` 参数；查询流水前同步刷新内存 `pendingEvents` 消除读写延迟。

## [v2.3.12] - 2026-09-24
- **Google 403 验证链接完整性校验 (`validation-url.mjs`)**：识别缺失 `continue` 或 `plt` 的残缺链接并提示重新获取，手动录入仅接受完整 Google 官方 HTTPS 链接。

## [v2.3.11] - 2026-09-24
- **请求流水与故障中心服务端分页及嵌套 JSON 验证链接提取**：流水筛选下沉至 SQLite 执行；修复故障时间戳重复乘 1000 的问题；支持从嵌套 JSON 与转义字符串中提取 `validation_url`。

## [v2.3.10] - 2026-09-23
- **贯穿式樱花观测站轻量 WebP 场景与服务状态自适应网格**：新增 `gate-assets/` WebP 视觉素材与静态路由，消除奇数卡片空白。

## [v2.3.9] - 2026-09-23
- **修复服务状态与凭证列表并排留白**：取消状态卡固定高度与内部滚动，改为整行自适应网格依次衔接。

## [v2.3.8] - 2026-09-23
- **左侧工作区导航与移动端抽屉菜单重构**：重构为左侧边栏 + 上下文工具栏布局，手机端支持抽屉式导航。

## [v2.3.7] - 2026-09-23
- **长列表 60 FPS 滚动优化**：移除状态点持续阴影动画与心跳格发光重绘，复用心跳时间格式化结果。

## [v2.3.6] - 2026-09-22
- **Aozora UI（青空 UI）浅蓝监控界面确立**：从早期深色界面全面升级为通透浅蓝白卡设计体系，修复無数据时误报 100% 成功率问题。

## [v2.3.5] - 2026-09-18
- **修复趋势图缓存 Token 双重累加虚高并支持按 API Key 筛选**：将柱状图修正为不重叠的三段堆叠（`未缓存输入 + 缓存命中 + 输出`）；`/admin/api/stats` 支持 `?key_id=` 独立凭据趋势分析。

## [v2.3.4] - 2026-09-16
- **成员 API Key 只读看板 (`/api/member/*`) 与 60 分钟时间槽滚动心跳**：上线租户自查看板（隔离他人数据与 `auth_index`）；服务状态升级为 60 分钟滚动时间槽，支持凭据优先级在线调整与 5 小时配额窗口预热唤醒。

## [v2.3.1] - 2026-09-13
- **下拉组件重构、轮询节能与 Key 别名快捷编辑**：优化后台轮询频率、实时流水多 Key 区分与别名内联编辑。

## [v2.3.0] - 2026-09-13
- **Uptime Kuma 风格服务状态面板与 `/admin/api/status-summary`**：新增多上游可用性心跳监控与配额重置绝对时刻展示。

## [v2.2.1] - 2026-09-12
- **SQLite 事务性发件箱 (`usage_outbox`)、Keeper 数据无损迁移与多标签页管理台**：确立 Gate 核心架构——多租户 API Key 日限额、60s 滑动窗口 RPM、模型白名单、5xx 熔断器、30s 空响应负缓存、SSE 语义流式守卫及 SQLite WAL + Outbox 持久化记账。

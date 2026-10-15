import asyncio
import os
from pathlib import Path

from playwright.async_api import async_playwright


async def main():
    base = os.environ["GATE_TEST_URL"]
    secret = os.environ["GATE_TEST_ADMIN_SECRET"]
    output = Path(os.environ["GATE_TEST_SCREENSHOT_DIR"])
    output.mkdir(parents=True, exist_ok=True)
    errors = []
    console_errors = []
    missing_urls = []
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True)
        context = await browser.new_context(viewport={"width": 1440, "height": 900}, device_scale_factor=1, permissions=["clipboard-read", "clipboard-write"])
        page = await context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("console", lambda message: console_errors.append(f"[{message.type}] {message.text}"))
        page.on("response", lambda response: missing_urls.append(f"{response.status} {response.url}"))
        await page.add_init_script(f"sessionStorage.setItem('gate_admin_secret', {secret!r}); localStorage.setItem('gate_admin_secret', {secret!r})")
        await page.goto(base + "/admin", wait_until="domcontentloaded")
        assert await page.title()

        # 运行总览工作区（v2.5.0 新增，置于导航首位）
        assert await page.locator("#tab-btn-runtime").count() == 1
        await page.locator("#ovw-hero-value").wait_for(timeout=10000)
        # 无需点击：运行总览就是默认首屏
        assert await page.locator("#tab-page-runtime").is_visible(), "运行总览必须是默认打开的首屏"
        assert not await page.locator("#tab-page-quotas").is_visible()
        assert "--" not in await page.locator("#ovw-hero-value").inner_text(), "Hero 未拿到运行时事实，仍是占位符"
        assert "等待数据" not in await page.locator("#ovw-verdict").inner_text(), "稳态判定未渲染"
        # 冷却中的凭据必须在总览以「冷却中」计数呈现，而不是算作可用
        stat_labels = await page.locator("#ovw-stats .ovw-stat-label").all_inner_texts()
        assert "冷却中" in stat_labels, f"核心指标缺少「冷却中」项: {stat_labels}"
        cooldown_tile = page.locator("#ovw-stats .ovw-stat", has=page.locator(".ovw-stat-label", has_text="冷却中"))
        cooldown_value = await cooldown_tile.locator(".ovw-stat-value").inner_text()
        assert cooldown_value not in ("--", ""), f"冷却计数未渲染: {cooldown_value!r}"
        # 存在冷却凭据时该计数必须为正，且提示不可参与调度
        assert int(cooldown_value.replace(",", "")) > 0, f"mock 中有冷却凭据，计数却为 {cooldown_value}"
        assert "不可参与调度" in await cooldown_tile.locator(".ovw-stat-hint").inner_text()
        # 降级横幅在 CPA 正常时不得出现
        assert not await page.locator("#ovw-banner").is_visible(), "CPA 可用时不应显示降级横幅"

        # P1：路由三项必须可编辑，且写入后能从服务端读回（不是只在界面上变了）
        try:
            await page.locator("#ovw-routing-strategy").wait_for(timeout=10000)
        except Exception as e:
            print("Console Errors:", console_errors)
            print("Page Errors:", errors)
            print("Grid HTML:", await page.locator("#ovw-runtime-grid").inner_html())
            raise e
        assert await page.locator("#ovw-routing-affinity").count() == 1, "缺少会话粘性开关"
        assert await page.locator("#ovw-routing-ttl").count() == 1, "缺少会话粘性 TTL 输入"
        # 加权轮询与临期优先 (smart) / 步调均衡 (pace) 对齐 CPA 最新支持的调度策略
        options = await page.locator("#ovw-routing-strategy option").evaluate_all("els => els.map(e => e.value)")
        assert options == ["round-robin", "weighted-round-robin", "fill-first", "smart", "pace"], f"路由策略选项不全: {options}"

        await page.select_option("#ovw-routing-strategy", "weighted-round-robin")
        await page.wait_for_timeout(1200)
        stored = await page.evaluate(
            """async () => {
                const s = sessionStorage.getItem('gate_admin_secret') || localStorage.getItem('gate_admin_secret');
                const r = await fetch('/admin/api/runtime-config', {headers: {Authorization: 'Bearer ' + s}});
                return (await r.json()).routing.value.strategy;
            }"""
        )
        assert stored == "weighted-round-robin", f"路由策略未真正落库，服务端仍是 {stored!r}"

        # 测试切换至临期优先 (smart)
        await page.select_option("#ovw-routing-strategy", "smart")
        await page.wait_for_timeout(1200)
        stored_smart = await page.evaluate(
            """async () => {
                const s = sessionStorage.getItem('gate_admin_secret') || localStorage.getItem('gate_admin_secret');
                const r = await fetch('/admin/api/runtime-config', {headers: {Authorization: 'Bearer ' + s}});
                return (await r.json()).routing.value.strategy;
            }"""
        )
        assert stored_smart == "smart", f"路由策略切换 smart 未真正落库，服务端仍是 {stored_smart!r}"

        # 切回原值，避免影响后续用例
        await page.select_option("#ovw-routing-strategy", "round-robin")
        await page.wait_for_timeout(1200)

        await page.locator("#ovw-runtime-grid").screenshot(path=str(output / "cpa-gate-routing-controls.png"))
        await page.screenshot(path=str(output / "cpa-gate-runtime-overview.png"))
        await page.locator("#btn-create-key").click()
        await page.locator("#create-alias").fill("browser test")
        await page.locator("#create-custom-key").fill("sk-browser-test-1234567890")
        await page.locator("#create-submit-btn").click()
        await page.locator("#created-key-val").get_by_text("sk-browser-test-1234567890").wait_for(timeout=10000)
        await page.get_by_role("button", name="完成").click()
        # 账号接入、提供商、CPA 日志与 CPA 配置 Tab 已彻底从 Gate 移除（职责边界回归网关监控、统计与调度，账号与配置由 CPA 统一管理）
        assert await page.locator("#tab-btn-cpa-auth").count() == 0, "账号接入 tab 已彻底移除"
        assert await page.locator("#tab-btn-cpa-providers").count() == 0, "提供商 tab 已彻底移除"
        assert await page.locator("#tab-page-cpa-auth").count() == 0, "账号接入页面容器已彻底移除"
        assert await page.locator("#tab-page-cpa-providers").count() == 0, "提供商页面容器已彻底移除"
        assert await page.locator("#tab-btn-cpa-logs").count() == 0, "CPA 日志 tab 已彻底移除"
        assert await page.locator("#tab-btn-cpa-config").count() == 0, "CPA 配置 tab 已彻底移除"
        assert await page.locator("#tab-page-cpa-logs").count() == 0, "CPA 日志页面容器已彻底移除"
        assert await page.locator("#tab-page-cpa-config").count() == 0, "CPA 配置页面容器已彻底移除"

        await page.locator("#tab-btn-quotas").click()
        await page.evaluate("fetchUpstreamQuotas(true)")
        # 7 个启用账号中，idx-b（整凭证冷却）与 idx-c（模型级冷却）必须被排除：
        # 冷却中的凭据不参与调度，不能计入「可用凭证」（v2.5.0 起 cooldown 会置 blocked）
        # 11 个账号中排除 5 个：auth-claude-expired / auth-codex-expired（授权过期）、
        # idx-d（已停用）、idx-b（整凭证冷却）、idx-c（模型级冷却）。
        # 后两个正是 v2.5.0 的修复点：修复前处于冷却的凭据会被误计为可用。
        accs = await page.evaluate(
            "fetch('/admin/api/upstream-quotas', {headers:{Authorization:'Bearer '+localStorage.getItem('gate_admin_secret')}})"
            ".then(r => r.json()).then(b => b.accounts.map(a => [a.auth_index, !!a.disabled, a.health && a.health.state, a.health && a.health.blocked]))"
        )
        cooled = {a[0] for a in accs if a[1] is False and a[2] == "cooldown"}
        assert cooled == {"idx-b", "idx-c"}, f"冷却凭据未被正确识别，实际冷却集合 {cooled}"
        assert all(a[3] for a in accs if a[2] == "cooldown"), "冷却中的凭据必须 blocked=true"
        # 可用计数从账号列表现算，而不是写死数字：夹具增减不该让这条断言失效，
        # 但「停用/冷却/过期一律不算可用」这条规则仍被牢牢锁住。
        expected_enabled = sum(1 for a in accs if not a[1] and a[2] not in ("cooldown", "expired"))
        enabled = await page.locator("#ops-enabled-accounts").inner_text()
        assert enabled == str(expected_enabled), (
            f"冷却/过期/停用的凭据未从可用计数中排除：界面 {enabled!r}，按账号列表应为 {expected_enabled}"
        )

        # 验证顶部刷新按钮根据 Provider Tab 动态自适应
        activate_btn = page.locator("#btn-activate-provider")
        assert "刷新全部额度" in await activate_btn.inner_text()
        await page.locator("#upstream-filter-tabs button").filter(has_text="Antigravity").click()
        assert "刷新全部 Antigravity 额度" in await activate_btn.inner_text()
        await page.locator("#upstream-filter-tabs button").filter(has_text="Codex").click()
        assert "刷新全部 Codex 额度" in await activate_btn.inner_text()
        await page.locator("#upstream-filter-tabs button").filter(has_text="全部").click()
        assert "刷新全部额度" in await activate_btn.inner_text()

        antigravity_compact = page.locator("#upstream-compact-container .compact-account-row").filter(has_text="antigravity@example.com")
        assert "剩余 16.1%" in await antigravity_compact.inner_text()
        assert "剩余 99.9%" in await antigravity_compact.inner_text()
        expired_compact = page.locator("#upstream-compact-container .compact-account-row").filter(has_text="codex-expired@example.com")
        await expired_compact.get_by_text("Token 已过期").first.wait_for(timeout=10000)
        assert "剩余 100%" not in await expired_compact.inner_text()
        assert "额度已隐藏" in await expired_compact.inner_text()
        await page.evaluate("switchUpstreamViewMode('cards')")
        antigravity_card = page.locator("#upstream-cards-container .account-card").filter(has_text="antigravity@example.com")
        assert "剩余 16.1%" in await antigravity_card.inner_text()
        assert "剩余 99.9%" in await antigravity_card.inner_text()
        expired_card = page.locator("#upstream-cards-container .account-card").filter(has_text="codex-expired@example.com")
        assert "额度已隐藏" in await expired_card.inner_text()
        assert "剩余 100%" not in await expired_card.inner_text()
        await page.screenshot(path=str(output / "cpa-gate-expired-token-desktop.png"))

        # 测试 Google 验证中心与手动录入弹窗
        await page.locator("#tab-btn-validations").click()
        assert await page.locator("#tab-page-validations").is_visible()
        await page.get_by_role("button", name="手动录入验证链接").click()
        await page.locator("#manual-val-modal").wait_for(state="visible", timeout=10000)
        await page.locator("#manual-val-modal").get_by_role("button", name="取消").click()
        await page.locator("#manual-val-modal").wait_for(state="hidden", timeout=10000)
        await page.get_by_role("button", name="手动录入验证链接").click()
        await page.locator("#manual-val-account").fill("ui-test@antigravity.internal")
        await page.locator("#manual-val-url").fill("https://accounts.google.com/signin/continue?plt=test1234&continue=https://developers.google.com/gemini-code-assist/auth/auth_success_gemini")
        await page.locator("#manual-val-modal").get_by_role("button", name="保存并打开验证 ↗").click()
        await page.locator("#manual-val-modal").wait_for(state="hidden", timeout=10000)
        await page.locator("#validations-history-tbody").get_by_text("ui-test@antigravity.internal").wait_for(timeout=10000)
        await page.locator("#tab-page-validations").get_by_role("button", name="刷新列表").click()

        # 测试凭证统计工作区与账号卡片网格
        await page.locator("#tab-btn-upstream-stats").click()
        assert await page.locator("#tab-page-upstream-stats").is_visible()
        assert await page.locator("#upstream-stats-cards-container").count() == 1
        for range_btn in ("5 小时", "24 小时", "7 天", "全部历史"):
            await page.locator("#tab-page-upstream-stats").get_by_role("button", name=range_btn).click()
        await page.locator("#upstream-stats-filter").fill("antigravity")
        await page.wait_for_timeout(200)
        await page.locator("#upstream-stats-filter").fill("")
        await page.locator("#tab-page-upstream-stats").get_by_role("button", name="刷新统计").click()
        await page.wait_for_timeout(500)
        assert await page.locator("#upstream-stats-cards-container .upstream-stat-card").count() > 0

        # 测试用量趋势工作区与图表指标/跨度切换
        await page.locator("#tab-btn-overview").click()
        assert await page.locator("#tab-page-overview").is_visible()
        for metric_btn in ("Token 构成", "花费 ($)", "缓存率 (%)"):
            await page.locator("#tab-page-overview").get_by_role("button", name=metric_btn).click()
        for range_btn in ("7D", "14D", "30D"):
            await page.locator("#tab-page-overview").get_by_role("button", name=range_btn).click()

        # 测试请求流水工作区与筛选过滤及翻页
        await page.locator("#tab-btn-logs").click()
        assert await page.locator("#tab-page-logs").is_visible()
        for filter_btn in ("缓存命中", "2xx 成功", "4xx 异常", "5xx 错误", "仅拦截", "全部"):
            await page.locator("#tab-page-logs").get_by_role("button", name=filter_btn).click()
        if not await page.locator("#logs-next-btn").is_disabled():
            await page.locator("#logs-next-btn").click()
        if not await page.locator("#logs-prev-btn").is_disabled():
            await page.locator("#logs-prev-btn").click()

        # 测试故障中心工作区
        await page.locator("#tab-btn-errors").click()
        assert await page.locator("#tab-page-errors").is_visible()
        await page.locator("#tab-page-errors").get_by_role("button", name="刷新故障记录").click()

        # 测试 API 密钥工作区与规则/重命名弹窗
        await page.locator("#tab-btn-keys").click()
        assert await page.locator("#tab-page-keys").is_visible()
        edit_rule_btn = page.locator("#keys-tbody").get_by_role("button", name="配置").first
        if await edit_rule_btn.count() > 0:
            await edit_rule_btn.click()
            await page.locator("#edit-modal").wait_for(state="visible", timeout=10000)
            await page.locator("#edit-modal").get_by_role("button", name="Flash/Mini经济组").click()
            await page.locator("#edit-modal").get_by_role("button", name="全部 (*)").click()
            await page.locator("#edit-modal").get_by_role("button", name="取消").click()
            await page.locator("#edit-modal").wait_for(state="hidden", timeout=10000)

        # 测试顶部全局操作按钮与对应 Modal (定价、密钥、配额探针)
        await page.locator("#btn-prices").click()
        await page.locator("#prices-modal").wait_for(state="visible", timeout=10000)
        await page.locator("#prices-modal").get_by_role("button", name="重置").click()
        await page.locator("#prices-modal").get_by_role("button", name="关闭").click()
        await page.locator("#prices-modal").wait_for(state="hidden", timeout=10000)

        await page.locator("#btn-auth").click()
        await page.locator("#auth-modal").wait_for(state="visible", timeout=10000)
        await page.locator("#auth-secret-eye-btn").click()
        await page.locator("#auth-modal").get_by_role("button", name="取消").click()
        await page.locator("#auth-modal").wait_for(state="hidden", timeout=10000)

        await page.locator("#quota-probe-badge").click()
        await page.locator("#quota-modal").wait_for(state="visible", timeout=10000)
        await page.locator("#quota-modal").get_by_role("button", name="复制链接").click()
        await page.locator("#quota-modal").get_by_role("button", name="关闭").click()
        await page.locator("#quota-modal").wait_for(state="hidden", timeout=10000)

        # 测试上游凭证页优先级调整弹窗与面板折叠
        await page.locator("#tab-btn-quotas").click()
        await page.locator("#upstream-panel-fold-btn").click()
        await page.locator("#upstream-panel-fold-btn").click()
        prio_btn = page.locator("#upstream-compact-container").get_by_role("button", name="调整").first
        if await prio_btn.count() > 0:
            await prio_btn.click()
            await page.locator("#upstream-priority-modal").wait_for(state="visible", timeout=10000)
            await page.locator("#upstream-priority-modal").get_by_role("button", name="P20 · 优先").click()
            assert await page.locator("#prio-modal-input").input_value() == "20"
            await page.locator("#upstream-priority-modal").get_by_role("button", name="取消").click()
            await page.locator("#upstream-priority-modal").wait_for(state="hidden", timeout=10000)

        await page.locator("#tab-btn-status").click()
        assert await page.locator("#tab-page-status").is_visible()
        await page.locator("#status-panel-fold-btn").click()
        await page.locator("#status-panel-fold-btn").click()

        # 验证侧边栏工作区全部带有 SVG 矢量图标且顺序正确聚合
        # 运行总览由 admin-overview.js 插到首位
        expected_tabs = [
            "tab-btn-runtime",
            "tab-btn-quotas",
            "tab-btn-validations",
            "tab-btn-status",
            "tab-btn-upstream-stats",
            "tab-btn-overview",
            "tab-btn-logs",
            "tab-btn-errors",
            "tab-btn-keys"
        ]
        actual_tabs = await page.locator("#main-nav-tabs .nav-tab-btn").evaluate_all("elements => elements.map(el => el.id)")
        assert actual_tabs == expected_tabs, f"Sidebar tabs order mismatch: {actual_tabs} != {expected_tabs}"
        for tab_id in expected_tabs:
            svg_count = await page.locator(f"#{tab_id} svg").count()
            assert svg_count >= 1, f"Sidebar button #{tab_id} is missing an SVG icon!"
        await page.screenshot(path=str(output / "cpa-gate-sidebar-grouped.png"))

        mobile = await browser.new_page(viewport={"width": 390, "height": 844}, device_scale_factor=1)
        mobile.on("pageerror", lambda error: errors.append(str(error)))
        mobile.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
        mobile.on("response", lambda response: missing_urls.append(response.url) if response.status == 404 else None)
        await mobile.add_init_script(f"localStorage.setItem('gate_admin_secret', {secret!r})")
        await mobile.goto(base + "/admin", wait_until="domcontentloaded")
        await mobile.locator("#mobile-menu-button").click()
        await mobile.locator("#tab-btn-upstream-stats").click()
        await mobile.wait_for_timeout(350)
        assert await mobile.locator("#tab-page-upstream-stats").is_visible()
        await mobile.screenshot(path=str(output / "cpa-gate-ui-mobile.png"))

        member = await browser.new_page(viewport={"width": 900, "height": 700})
        member.on("pageerror", lambda error: errors.append(str(error)))
        await member.add_init_script("localStorage.setItem('gate_member_key', 'sk-member-test-1234567890')")
        await member.goto(base + "/member", wait_until="domcontentloaded")
        assert await member.locator("#tab-btn-cpa-auth").count() == 0
        assert await member.locator("#tab-btn-cpa-providers").count() == 0
        assert not await member.locator("#tab-btn-status").is_visible()
        # 运行总览聚合的是全站上游调度事实：成员既看不到入口，也不得被停在首屏
        assert not await member.locator("#tab-btn-runtime").is_visible(), "成员模式不得暴露运行总览入口"
        assert not await member.locator("#tab-page-runtime").is_visible(), "成员模式不得停在运行总览首屏"
        assert await member.locator("#tab-page-quotas").is_visible(), "成员模式首屏应为 quotas"

        # 未配置管理密钥时同样退回 quotas，不得停在看不到数据的运行总览上
        noauth = await browser.new_page(viewport={"width": 900, "height": 700})
        noauth.on("pageerror", lambda error: errors.append(str(error)))
        await noauth.goto(base + "/admin", wait_until="domcontentloaded")
        await noauth.wait_for_timeout(600)
        assert not await noauth.locator("#tab-page-runtime").is_visible(), "无管理密钥时不得停在运行总览首屏"
        assert await noauth.locator("#tab-page-quotas").is_visible(), "无管理密钥时首屏应为 quotas"

        assert not errors, errors
        print(f"PASS rendered Gate CPA workspaces at desktop and mobile viewports; mock 404s: {list(dict.fromkeys(missing_urls))[:8]}")
        await browser.close()


asyncio.run(main())

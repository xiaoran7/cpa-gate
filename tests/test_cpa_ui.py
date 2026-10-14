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
        assert await page.locator("#tab-btn-cpa-auth").count() == 1
        await page.locator("#tab-btn-cpa-auth").click()
        await page.locator("#cpa-auth-rows").get_by_text("test@example.com").wait_for(timeout=10000)
        assert await page.locator("#tab-page-cpa-auth").is_visible()
        assert not await page.locator("#tab-page-cpa-providers").is_visible()
        # Screenshot the modern custom dropdown open
        await page.locator("#cpa-oauth-provider-custom-dropdown .dropdown-trigger").click()
        await page.wait_for_timeout(200)
        trigger_box = await page.locator("#cpa-oauth-provider-custom-dropdown .dropdown-trigger").bounding_box()
        menu_box = await page.locator("#cpa-oauth-provider-custom-dropdown .dropdown-menu").bounding_box()
        print(f"TriggerBox: {trigger_box}")
        print(f"MenuBox: {menu_box}")
        await page.screenshot(path=str(output / "cpa-gate-dropdown-open.png"))
        await page.locator("#cpa-oauth-provider-custom-dropdown .dropdown-item[data-value='codex']").click()
        popups = []
        page.on("popup", lambda popup: popups.append(popup))
        await page.get_by_role("button", name="生成授权链接").click()
        await page.wait_for_function("document.getElementById('cpa-oauth-link-input').value === 'https://example.com/auth'", timeout=10000)
        assert not popups, "生成授权链接时不应自动打开浏览器窗口"
        assert await page.locator("#cpa-oauth-link").get_attribute("href") == "https://example.com/auth"
        await page.get_by_role("button", name="复制链接").click()
        assert "链接" in await page.locator("#cpa-oauth-status").inner_text()
        await page.screenshot(path=str(output / "cpa-gate-auth-link-desktop.png"))
        await page.get_by_role("button", name="取消授权").click()
        await page.locator("#cpa-oauth-result").wait_for(state="hidden", timeout=10000)
        expired_row = page.locator("#cpa-auth-rows tr").filter(has_text="claude-expired@example.com")
        await expired_row.get_by_text("Token 已过期").wait_for(timeout=10000)
        assert await expired_row.get_by_role("button", name="查看额度").count() == 0
        await page.locator("#cpa-auth-search").fill("missing-account")
        assert "暂无认证文件" in await page.locator("#cpa-auth-rows").inner_text()
        await page.locator("#cpa-auth-search").fill("test@example.com")
        await page.locator("#cpa-auth-rows").locator(".cpa-row-menu summary").click()
        await page.locator("#cpa-auth-rows").get_by_role("button", name="启用").click()
        await page.locator("#cpa-auth-rows").locator(".cpa-row-menu summary").click()
        await page.locator("#cpa-auth-rows").get_by_role("button", name="停用").wait_for(timeout=10000)
        await page.locator("#cpa-auth-rows").locator("[data-cpa-select-auth='codex-test.json']").check()
        assert await page.locator("#cpa-auth-rows").locator("[data-cpa-select-auth='codex-test.json']").is_checked()
        await page.locator("#cpa-auth-rows").locator("[data-cpa-select-auth='codex-test.json']").uncheck()
        await page.locator("#cpa-auth-search").fill("")
        await page.locator("#cpa-auth-rows tr").filter(has_text="claude@example.com").get_by_role("button", name="查看额度").click()
        await page.locator("#cpa-provider-quota-cards").get_by_text("剩余 86%").wait_for(timeout=10000)
        await page.locator("#cpa-auth-rows tr").filter(has_text="meta@example.com").get_by_role("button", name="查看额度").click()
        await page.locator("#cpa-provider-quota-cards").get_by_text("剩余 80%").wait_for(timeout=10000)
        assert "must-never-reach-browser" not in await page.locator("#cpa-provider-quota-data").inner_text()
        await page.locator("#cpa-auth-upload").set_input_files([
            {"name": "batch-a.json", "mimeType": "application/json", "buffer": b'{"token":"a"}'},
            {"name": "batch-b.json", "mimeType": "application/json", "buffer": b'{"token":"b"}'},
            {"name": "batch-c.json", "mimeType": "application/json", "buffer": b'{"token":"c"}'},
            {"name": "batch-d.json", "mimeType": "application/json", "buffer": b'{"token":"d"}'},
            {"name": "batch-e.json", "mimeType": "application/json", "buffer": b'{"token":"e"}'},
        ])
        await page.locator("#tab-page-cpa-auth").get_by_role("button", name="上传并注册").click()
        await page.locator("#cpa-auth-rows").locator("[data-cpa-select-auth='batch-a.json']").wait_for(timeout=10000)
        await page.locator("#cpa-auth-rows").locator("[data-cpa-select-auth='batch-a.json']").check()
        await page.locator("#cpa-auth-rows").locator("[data-cpa-select-auth='batch-b.json']").check()
        page.on("dialog", lambda dialog: asyncio.create_task(dialog.accept()))
        # P1：删除已改走服务端批量端点，与其余批量动作共用同一套汇总 UI
        await page.locator("#tab-page-cpa-auth").get_by_role("button", name="删除选中").click()
        await page.locator("#cpa-auth-status").get_by_text("成功 2/2").wait_for(timeout=10000)
        report = page.locator("#cpa-auth-batch-report")
        assert "全部成功" in await report.inner_text(), f"批量汇总应显示全成功: {await report.inner_text()}"
        await page.screenshot(path=str(output / "cpa-gate-ui-desktop.png"))

        # 批量停用：三个凭据一次性改状态，并给出汇总
        await page.locator("#tab-btn-cpa-auth").click()
        for name in ("batch-c.json", "batch-d.json", "batch-e.json"):
            await page.locator("#cpa-auth-rows").locator(f"[data-cpa-select-auth='{name}']").wait_for(timeout=10000)
            await page.locator("#cpa-auth-rows").locator(f"[data-cpa-select-auth='{name}']").check()
        await page.locator("#tab-page-cpa-auth").get_by_role("button", name="批量停用").click()
        await page.locator("#cpa-auth-status").get_by_text("停用：成功 3/3").wait_for(timeout=10000)
        assert "全部成功" in await page.locator("#cpa-auth-batch-report").inner_text()
        # 停用后应能从行状态读回，而不是只信汇总文案
        for name in ("batch-c.json", "batch-d.json", "batch-e.json"):
            row = page.locator("#cpa-auth-rows tr", has=page.locator(f"[data-cpa-select-auth='{name}']"))
            txt = (await row.inner_text())
            # 行状态列渲染的是中文「已停用」，不是 disabled 原始值
            assert "已停用" in txt, f"{name} 行状态未变为停用，实际: {txt!r}"
        await page.locator("#tab-page-cpa-auth .cpa-batch-report").screenshot(path=str(output / "cpa-gate-batch-report.png"))

        # 部分失败：逐条执行，汇总必须区分成功与失败
        mixed_result = await page.evaluate(
            """async () => {
                const s = localStorage.getItem('gate_admin_secret');
                const r = await fetch('/admin/api/upstream-auth/batch', {
                  method: 'PUT',
                  headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer ' + s},
                  body: JSON.stringify({ names: ['batch-c.json', 'missing-batch.json', 'batch-d.json'], action: 'enable' })
                });
                return await r.json();
            }"""
        )
        assert mixed_result["succeeded"] == 2, f"第 3 条应照常成功: {mixed_result}"
        assert mixed_result["failed"] == 1
        assert mixed_result["results"][1]["name"] == "missing-batch.json"
        assert mixed_result["results"][1]["error"], "失败条目必须带原因"

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

        await page.locator("#tab-btn-cpa-providers").click()
        await page.locator("#cpa-provider-status").get_by_text("已读取").wait_for(timeout=10000)
        await page.locator("#cpa-provider-cards [data-cpa-provider-field='name']").fill("mock-edited")
        await page.locator("#cpa-provider-cards [data-cpa-provider-field='name']").press("Tab")
        assert 'mock-edited' in await page.locator("#cpa-provider-json").input_value()
        await page.locator("#cpa-provider-cards [data-cpa-provider-field='prefix']").fill("open-prefix")
        await page.locator("#cpa-provider-cards [data-cpa-provider-field='prefix']").press("Tab")
        await page.locator("#cpa-provider-cards [data-cpa-provider-field='disabled']").check()
        await page.locator("#cpa-provider-cards [data-cpa-provider-field='entry-proxy-url']").fill("socks5://proxy.example.com:1080")
        await page.locator("#cpa-provider-cards [data-cpa-provider-field='entry-proxy-url']").press("Tab")
        openai_draft = await page.locator("#cpa-provider-json").input_value()
        assert all(value in openai_draft for value in ("open-prefix", '"disabled": true', "socks5://proxy.example.com:1080"))
        await page.locator("#cpa-provider-probe").get_by_role("button", name="发现模型").click()
        await page.wait_for_function("document.getElementById('cpa-discovered-models').value.includes('mock-model-a')", timeout=10000)
        assert "mock-model-a" in await page.locator("#cpa-discovered-models").input_value()
        await page.locator("#cpa-provider-probe").get_by_role("button", name="加入 JSON 配置").click()
        assert "mock-model-a" in await page.locator("#cpa-provider-json").input_value()
        await page.locator("#cpa-provider-probe").get_by_role("button", name="测试模型连通").click()
        await page.locator("#cpa-probe-status").get_by_text("模型请求成功").wait_for(timeout=10000)
        await page.locator("#cpa-provider-cards").scroll_into_view_if_needed()
        await page.screenshot(path=str(output / "cpa-gate-providers-desktop.png"))
        await page.locator("#cpa-provider-kind").select_option("claude-api-key")
        await page.locator("#tab-page-cpa-providers").get_by_role("button", name="读取配置").click()
        await page.locator("#cpa-provider-cards [data-cpa-provider-field='base-url']").fill("https://claude-new.example.com")
        await page.locator("#cpa-provider-cards [data-cpa-provider-field='base-url']").press("Tab")
        draft = await page.locator("#cpa-provider-json").input_value()
        assert "claude-new.example.com" in draft and '"cloak"' in draft
        await page.locator("#cpa-provider-cards .cpa-provider-details").first.locator("summary").click()
        await page.locator("#cpa-provider-cards [data-cpa-provider-field='model-alias']").fill("claude-new-alias")
        await page.locator("#cpa-provider-cards [data-cpa-provider-field='model-alias']").press("Tab")
        await page.locator("#cpa-provider-cards [data-cpa-provider-field='header-name']").fill("X-Request-Trace")
        await page.locator("#cpa-provider-cards [data-cpa-provider-field='header-name']").press("Tab")
        await page.locator("#cpa-provider-cards [data-cpa-provider-field='excluded-model']").fill("claude-new-*")
        await page.locator("#cpa-provider-cards [data-cpa-provider-field='excluded-model']").press("Tab")
        draft = await page.locator("#cpa-provider-json").input_value()
        assert all(value in draft for value in ("claude-new-alias", "X-Request-Trace", "claude-new-*", '"extra": "preserve"'))
        await page.screenshot(path=str(output / "cpa-gate-claude-provider-desktop.png"))
        await page.locator("#cpa-provider-add-row").get_by_role("button", name="添加提供商 / 密钥").click()
        assert await page.locator("#cpa-provider-cards .cpa-provider-card").count() == 2
        await page.locator("#cpa-provider-cards [data-cpa-provider-index='1'] [data-cpa-provider-field='api-key']").fill("sk-mock-second-claude")
        await page.locator("#cpa-provider-cards [data-cpa-provider-index='1'] [data-cpa-provider-field='api-key']").press("Tab")
        await page.locator("#tab-page-cpa-providers").get_by_role("button", name="保存到 CPA").click()
        await page.locator("#cpa-provider-status").get_by_text("已保存到 CPA").wait_for(timeout=10000)
        assert await page.locator("#cpa-provider-cards .cpa-provider-card").count() == 2
        assert '"cloak"' in await page.locator("#cpa-provider-json").input_value()
        await page.locator("#cpa-provider-kind").select_option("oauth-excluded-models")
        await page.locator("#tab-page-cpa-providers").get_by_role("button", name="读取配置").click()
        assert not await page.locator("#cpa-provider-add-row").is_visible()
        excluded = page.locator("#cpa-provider-cards [data-cpa-excluded-models='codex']")
        await excluded.fill("gpt-old-*\ngpt-retired-*")
        await excluded.press("Tab")
        await page.locator("#cpa-excluded-new-channel").select_option("claude")
        await page.locator("#cpa-provider-cards").get_by_role("button", name="添加渠道").click()
        await page.locator("#cpa-provider-cards [data-cpa-excluded-models='claude']").fill("claude-retired-*")
        await page.locator("#cpa-provider-cards [data-cpa-excluded-models='claude']").press("Tab")
        await page.locator("#tab-page-cpa-providers").get_by_role("button", name="保存到 CPA").click()
        await page.locator("#cpa-provider-status").get_by_text("已保存到 CPA").wait_for(timeout=10000)
        assert '"antigravity"' in await page.locator("#cpa-provider-json").input_value()
        assert "claude-retired-*" in await page.locator("#cpa-provider-json").input_value()
        if await page.locator("[data-cpa-provider-tab='section-cpa-providers-alias']").count() > 0:
            await page.locator("[data-cpa-provider-tab='section-cpa-providers-alias']").click()
        await page.locator("#tab-page-cpa-providers").get_by_role("button", name="读取别名").click()
        await page.evaluate("""async () => {
          const response = await fetch('/admin/api/cpa/oauth-model-alias', {
            method: 'PATCH', headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ channel: 'codex', aliases: [{ name: 'gpt-upstream', alias: 'gpt-external', fork: true, 'display-name': 'Preserve title' }] })
          });
          if (!response.ok) throw new Error(`external update failed: ${response.status}`);
        }""")
        await page.locator("#cpa-alias-cards [data-cpa-alias-field='alias']").fill("gpt-stale")
        await page.locator("#cpa-alias-cards [data-cpa-alias-field='alias']").press("Tab")
        await page.locator("#tab-page-cpa-providers").get_by_role("button", name="保存别名").click()
        await page.locator("#cpa-alias-status").get_by_text("已变化").wait_for(timeout=10000)
        await page.locator("#tab-page-cpa-providers").get_by_role("button", name="读取别名").click()
        await page.locator("#cpa-alias-status").get_by_text("已读取 codex").wait_for(timeout=10000)
        assert await page.locator("#cpa-alias-cards [data-cpa-alias-field='alias']").input_value() == "gpt-external"
        await page.locator("#cpa-alias-cards [data-cpa-alias-field='alias']").fill("gpt-public-new")
        await page.locator("#cpa-alias-cards [data-cpa-alias-field='alias']").press("Tab")
        await page.locator("#cpa-alias-add-row").get_by_role("button", name="添加映射").click()
        await page.locator("#cpa-alias-cards [data-cpa-alias-index='1'] [data-cpa-alias-field='name']").fill("gpt-second")
        await page.locator("#cpa-alias-cards [data-cpa-alias-index='1'] [data-cpa-alias-field='name']").press("Tab")
        await page.locator("#cpa-alias-cards [data-cpa-alias-index='1'] [data-cpa-alias-field='alias']").fill("gpt-second-public")
        await page.locator("#cpa-alias-cards [data-cpa-alias-index='1'] [data-cpa-alias-field='alias']").press("Tab")
        await page.locator("#tab-page-cpa-providers").get_by_role("button", name="保存别名").click()
        await page.locator("#cpa-alias-status").get_by_text("模型别名已保存").wait_for(timeout=10000)
        alias_draft = await page.locator("#cpa-alias-json").input_value()
        assert all(value in alias_draft for value in ("gpt-public-new", "gpt-second-public", '"display-name": "Preserve title"')), alias_draft
        await page.screenshot(path=str(output / "cpa-gate-oauth-rules-desktop.png"))
        await page.locator("#tab-btn-cpa-config").click()
        if await page.locator("#cpa-yaml-details summary").count() > 0:
            await page.locator("#cpa-yaml-details summary").click()
        await page.wait_for_function("document.getElementById('cpa-yaml-editor').value.includes('debug: true')", timeout=10000)
        assert "debug: true" in await page.locator("#cpa-yaml-editor").input_value()
        await page.locator("#cpa-yaml-editor").fill("debug: true\nrequest-retry: 3\n")
        await page.get_by_role("button", name="查看改动").click()
        assert await page.locator("#cpa-yaml-diff").is_visible()
        await page.locator("#tab-btn-cpa-logs").click()
        await page.locator("#cpa-log-view").get_by_text("mock cpa log").wait_for(timeout=10000)
        # 测试错误日志在线检视、复制与关闭
        error_preview_btn = page.locator("#cpa-error-logs-rows").locator("[data-cpa-action='error-preview']").first
        if await error_preview_btn.count() > 0:
            await error_preview_btn.click()
            await page.locator("#cpa-error-viewer").wait_for(state="visible", timeout=10000)
            assert "oops" in await page.locator("#cpa-error-viewer-content").inner_text()
            await page.locator("[data-cpa-action='error-viewer-copy']").click()
            await page.locator("[data-cpa-action='error-viewer-close']").click()
            await page.locator("#cpa-error-viewer").wait_for(state="hidden", timeout=10000)

        # 测试 CPA 配置页检查更新与常用设置
        await page.locator("#tab-btn-cpa-config").click()
        await page.locator("[data-cpa-action='version-check']").click()
        await page.locator("#cpa-version-status").get_by_text("v7.3.0").wait_for(timeout=10000)

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

        # 测试凭证统计工作区与时间跨度切换
        await page.locator("#tab-btn-upstream-stats").click()
        assert await page.locator("#tab-page-upstream-stats").is_visible()
        for range_btn in ("5 小时", "24 小时", "7 天", "全部历史"):
            await page.locator("#tab-page-upstream-stats").get_by_role("button", name=range_btn).click()
        await page.locator("#tab-page-upstream-stats").get_by_role("button", name="刷新统计").click()

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
            "tab-btn-cpa-auth",
            "tab-btn-cpa-providers",
            "tab-btn-status",
            "tab-btn-upstream-stats",
            "tab-btn-overview",
            "tab-btn-logs",
            "tab-btn-errors",
            "tab-btn-cpa-logs",
            "tab-btn-keys",
            "tab-btn-cpa-config"
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
        await mobile.locator("#tab-btn-cpa-auth").click()
        await mobile.locator("#cpa-auth-rows").get_by_text("test@example.com").wait_for(timeout=10000)
        await mobile.wait_for_timeout(350)
        await mobile.screenshot(path=str(output / "cpa-gate-ui-mobile.png"))
        mobile_popups = []
        mobile.on("popup", lambda popup: mobile_popups.append(popup))
        await mobile.get_by_role("button", name="生成授权链接").click()
        await mobile.locator("#cpa-oauth-result").wait_for(state="visible", timeout=10000)
        assert not mobile_popups
        link_bounds = await mobile.locator("#cpa-oauth-result").bounding_box()
        assert link_bounds and link_bounds["x"] >= 0 and link_bounds["x"] + link_bounds["width"] <= 391, link_bounds
        await mobile.screenshot(path=str(output / "cpa-gate-auth-link-mobile.png"))
        await mobile.locator("#cpa-auth-rows").scroll_into_view_if_needed()
        bounds = await mobile.locator("#tab-page-cpa-auth .cpa-table-wrap").bounding_box()
        assert bounds and bounds["x"] >= 0 and bounds["x"] + bounds["width"] <= 391, bounds
        assert await mobile.locator("#cpa-auth-select-all").is_visible()
        await mobile.screenshot(path=str(output / "cpa-gate-auth-list-mobile.png"))
        member = await browser.new_page(viewport={"width": 900, "height": 700})
        member.on("pageerror", lambda error: errors.append(str(error)))
        await member.add_init_script("localStorage.setItem('gate_member_key', 'sk-member-test-1234567890')")
        await member.goto(base + "/member", wait_until="domcontentloaded")
        assert not await member.locator("#tab-btn-cpa-auth").is_visible()
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

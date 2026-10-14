(() => {
  const nav = document.getElementById('main-nav-tabs');
  const workspace = document.getElementById('workspace');
  if (!nav || !workspace) return;

  const pages = [
    ['cpa-auth', '账号接入', 'ACCOUNT ACCESS', '授权账号并管理 CPA 认证文件。', '<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" stroke-linecap="round" stroke-linejoin="round"></path><circle cx="9" cy="7" r="4"></circle><path d="M22 21v-2a4 4 0 0 0-3-3.87" stroke-linecap="round" stroke-linejoin="round"></path><path d="M16 3.13a4 4 0 0 1 0 7.75" stroke-linecap="round" stroke-linejoin="round"></path></svg>', 'tab-btn-validations', false],
    ['cpa-providers', '提供商', 'AI PROVIDERS', '管理上游 API Key、兼容提供商与模型排除规则。', '<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"></rect><rect x="2" y="14" width="20" height="8" rx="2" ry="2"></rect><line x1="6" y1="6" x2="6.01" y2="6"></line><line x1="6" y1="18" x2="6.01" y2="18"></line></svg>', 'tab-btn-cpa-auth', true],
    ['cpa-logs', 'CPA 日志', 'CPA LOGS', '查看 CPA 服务日志与请求错误文件。', '<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>', 'tab-btn-errors', true],
    ['cpa-config', 'CPA 配置', 'CPA CONFIGURATION', '修改常用设置或审阅并保存完整 YAML。', '<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><line x1="4" y1="21" x2="4" y2="14"></line><line x1="4" y1="10" x2="4" y2="3"></line><line x1="12" y1="21" x2="12" y2="12"></line><line x1="12" y1="8" x2="12" y2="3"></line><line x1="20" y1="21" x2="20" y2="16"></line><line x1="20" y1="12" x2="20" y2="3"></line><line x1="1" y1="14" x2="7" y2="14"></line><line x1="9" y1="8" x2="15" y2="8"></line><line x1="17" y1="16" x2="23" y2="16"></line></svg>', 'tab-btn-keys', false]
  ];
  for (const [id, title, eyebrow, description, iconSvg, insertAfterId, addDividerAfter] of pages) {
    pageMeta[id] = { title, eyebrow, description };
    const btnHtml = `<button class="nav-tab-btn cpa-nav" id="tab-btn-${id}" type="button" data-cpa-nav="${id}">${iconSvg}<span>${title}</span></button>${addDividerAfter ? '<div class="sidebar-section-divider"></div>' : ''}`;
    const anchorBtn = insertAfterId ? document.getElementById(insertAfterId) : null;
    if (anchorBtn && anchorBtn.parentNode === nav) {
      anchorBtn.insertAdjacentHTML('afterend', btnHtml);
    } else {
      nav.insertAdjacentHTML('beforeend', btnHtml);
    }
    workspace.insertAdjacentHTML('beforeend', `<div class="tab-page cpa-workspace" id="tab-page-${id}"></div>`);
  }

  const $ = id => document.getElementById(id);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  // 日志水位：24 小时档实测 42314 行，所以行数上限取 60000 覆盖全档位；
  // 单次 DOM 渲染上限取 8000 行——6MB 文本一次性塞进 <pre> 会卡死浏览器，
  // 超出部分逐段追加。两个上限服务不同目的，别合并。
  const LOG_LINES_LIMIT = 60000;
  const LOG_RENDER_LIMIT = 8000;
  const state = { yaml: '', yamlEtag: '', provider: '', providerRaw: '', providerItems: [], aliasChannel: '', aliasRaw: '', oauthProvider: '', oauthState: '', oauthTimer: null, logAfter: Math.floor(Date.now() / 1000), logLines: [], logRangeHours: 1, logRenderLimit: LOG_RENDER_LIMIT, logTruncated: false, authFiles: [], authPage: 1, selectedAuth: new Set(), editingAuthName: '', editingAuthExcluded: [], editingAuthHeaders: [], editingAuthTab: 'visual', viewingErrorName: '', lastBatch: null, cooldownList: [], globalAliases: [], globalAliasesRaw: '', keyModels: [], expandedProviderKeys: new Set() };
  const button = (action, label, cls = 'btn btn-secondary btn-sm') => `<button class="${cls}" type="button" data-cpa-action="${action}">${label}</button>`;
  const CPA_ICONS = {
    server: '<svg class="cpa-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/></svg>',
    key: '<svg class="cpa-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/></svg>',
    model: '<svg class="cpa-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/></svg>',
    tag: '<svg class="cpa-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2H2v10l9.29 9.29c.94.94 2.48.94 3.42 0l6.58-6.58c.94-.94.94-2.48 0-3.42L12 2Z"/><path d="M7 7h.01"/></svg>',
    globe: '<svg class="cpa-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" x2="22" y1="12" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
    settings: '<svg class="cpa-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/></svg>',
    ban: '<svg class="cpa-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" x2="19.07" y1="4.93" y2="19.07"/></svg>',
    warn: '<svg class="cpa-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" x2="12" y1="9" y2="13"/><line x1="12" x2="12.01" y1="17" y2="17"/></svg>',
    eye: '<svg class="cpa-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>',
    eyeOff: '<svg class="cpa-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" y1="2" x2="22" y2="22"/></svg>',
    copy: '<svg class="cpa-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>'
  };
  const formatAuthStatus = status => {
    const map = { ready: '正常', active: '活跃', ok: '正常', valid: '正常', idle: '空闲', disabled: '已停用', cooling: '冷却中', error: '异常' };
    const key = String(status || '').trim().toLowerCase();
    return map[key] || (status || '正常');
  };

  // 现代定制浮动下拉组件与原生 select 双向绑定管理器
  const cpaDropdowns = new Map();
  function syncCpaDropdown(selectId, optionsOverride) {
    const select = $(selectId);
    if (!select) return;
    let entry = cpaDropdowns.get(selectId);
    if (!entry) {
      const container = document.createElement('div');
      container.className = 'dropdown';
      container.id = selectId + '-custom-dropdown';
      select.classList.add('cpa-select-hidden');
      select.parentNode.insertBefore(container, select);
      entry = { container, isOpen: false };
      cpaDropdowns.set(selectId, entry);

      container.addEventListener('click', e => {
        const trigger = e.target.closest('.dropdown-trigger');
        if (trigger) {
          e.stopPropagation();
          cpaDropdowns.forEach((val, id) => {
            if (id !== selectId && val.isOpen) {
              val.isOpen = false;
              val.container.classList.remove('open');
              val.container.querySelector('.dropdown-trigger')?.setAttribute('aria-expanded', 'false');
            }
          });
          entry.isOpen = !entry.isOpen;
          container.classList.toggle('open', entry.isOpen);
          trigger.setAttribute('aria-expanded', String(entry.isOpen));
          return;
        }
        const item = e.target.closest('.dropdown-item');
        if (item) {
          e.stopPropagation();
          const val = item.getAttribute('data-value');
          if (val !== select.value) {
            select.value = val;
            select.dispatchEvent(new Event('change', { bubbles: true }));
          }
          entry.isOpen = false;
          container.classList.remove('open');
          container.querySelector('.dropdown-trigger')?.setAttribute('aria-expanded', 'false');
          render();
        }
      });

      select.addEventListener('change', () => { render(); });
      document.addEventListener('click', e => {
        if (!container.contains(e.target) && entry.isOpen) {
          entry.isOpen = false;
          container.classList.remove('open');
          container.querySelector('.dropdown-trigger')?.setAttribute('aria-expanded', 'false');
        }
      });
    }

    function render() {
      const opts = optionsOverride || Array.from(select.options).map(o => ({ value: o.value, label: o.textContent }));
      const current = opts.find(o => String(o.value) === String(select.value)) || opts[0];
      const label = current ? current.label : '请选择';
      entry.container.innerHTML = `
        <button type="button" class="dropdown-trigger" aria-label="${escape(label)}" aria-expanded="${entry.isOpen}" aria-haspopup="listbox">
          <span class="dropdown-label">${escape(label)}</span>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
        </button>
        <div class="dropdown-menu" role="listbox">
          ${opts.map(o => {
            const isSelected = String(o.value) === String(select.value);
            return `
              <div class="dropdown-item ${isSelected ? 'selected' : ''}" role="option" aria-selected="${isSelected}" data-value="${escape(o.value)}">
                <span>${escape(o.label)}</span>
                <svg class="check-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                  <polyline points="20 6 9 17 4 12"></polyline>
                </svg>
              </div>`;
          }).join('')}
        </div>
      `;
    }

    render();
  }

  $('tab-page-cpa-auth').innerHTML = `
    <div class="cpa-auth-layout">
      <section class="cpa-panel cpa-auth-panel"><div class="cpa-panel-heading"><span class="cpa-step">01</span><div><h3>账号授权</h3><p>选择提供商，生成授权链接，再由你自行打开完成登录。</p></div></div>
        <div class="cpa-field"><label for="cpa-oauth-provider">提供商</label><select id="cpa-oauth-provider">
          <option value="codex">Codex</option><option value="claude">Claude</option><option value="antigravity">Antigravity</option><option value="kimi">Kimi</option><option value="kimi-ai">Kimi AI</option><option value="xai">xAI / Grok</option><option value="devin">Devin</option><option value="meta">Meta</option><option value="workbuddy">WorkBuddy</option><option value="workbuddy-cn">WorkBuddy (国内 / CodeBuddy)</option>
        </select></div>
        <div class="cpa-actions">${button('oauth-start', '生成授权链接', 'btn btn-primary btn-sm')}${button('oauth-cancel', '取消授权')}</div>
        <div class="cpa-oauth-result" id="cpa-oauth-result" hidden><div class="cpa-result-heading"><span class="cpa-step">02</span><strong>复制链接并在浏览器中打开</strong></div>
          <div class="cpa-field"><label for="cpa-oauth-link-input">授权链接</label><input id="cpa-oauth-link-input" type="text" readonly spellcheck="false" aria-label="授权链接"/></div>
          <div class="cpa-actions">${button('oauth-copy', '复制链接', 'btn btn-primary btn-sm')}<a class="cpa-link" id="cpa-oauth-link" target="_blank" rel="noopener noreferrer">手动打开链接 ↗</a></div>
          <div class="cpa-device-code-card" id="cpa-oauth-device-code" hidden>
            <span>设备验证码：</span>
            <strong id="cpa-oauth-device-code-val"></strong>
            <button type="button" class="btn btn-secondary btn-sm" data-cpa-action="oauth-copy-code" style="margin-left:auto;min-height:28px;padding:2px 8px;">复制验证码</button>
          </div>
          <div class="cpa-divider"></div><div class="cpa-result-heading"><span class="cpa-step">03</span><strong>完成回调</strong></div>
          <p>若浏览器停在本地回调页，请复制地址栏中的完整地址并提交；xAI 也可填写验证码。</p>
          <div class="cpa-field"><label for="cpa-oauth-callback">回调地址或 xAI 验证码</label><textarea id="cpa-oauth-callback" placeholder="粘贴完整回调 URL 或 xAI 验证码"></textarea></div>
          <div class="cpa-actions">${button('oauth-callback', '提交回调地址')}</div>
        </div>
        <div class="cpa-oauth-placeholder" id="cpa-oauth-placeholder">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>
          <span>点击上方"生成授权链接"即可在此卡片内直接展示专属登录 URL、设备码与回调提交区</span>
        </div>
        <div class="cpa-status" id="cpa-oauth-status" role="status" aria-live="polite"></div>
      </section>
      <section class="cpa-panel"><div class="cpa-panel-heading"><span class="cpa-step">A</span><div><h3>导入认证文件</h3><p>上传 CPA 凭据 JSON 文件，支持一次选择多个。</p></div></div>
        <div class="cpa-field"><label for="cpa-auth-upload">选择 JSON 文件</label><input id="cpa-auth-upload" type="file" accept=".json,application/json" multiple/></div>
        <div class="cpa-actions">${button('auth-upload', '上传并注册', 'btn btn-primary btn-sm')}</div><div class="cpa-status" id="cpa-auth-upload-status"></div>
      </section>
      <section class="cpa-panel"><div class="cpa-panel-heading"><span class="cpa-step">B</span><div><h3>导入 Vertex 服务账号</h3><p>上传 Google 服务账号 JSON，由 CPA 验证并生成凭据。</p></div></div>
        <div class="cpa-field"><label for="cpa-vertex-upload">服务账号 JSON</label><input id="cpa-vertex-upload" type="file" accept=".json,application/json"/></div>
        <div class="cpa-field"><label for="cpa-vertex-location">区域（可选）</label><input id="cpa-vertex-location" placeholder="us-central1"/></div>
        <div class="cpa-actions">${button('vertex-import', '导入 Vertex', 'btn btn-primary btn-sm')}</div><div class="cpa-status" id="cpa-vertex-status"></div>
      </section>
    </div>
    <section class="cpa-panel cpa-cooldown-banner-panel" id="cpa-cooldown-banner" hidden>
      <div class="cpa-cooldown-banner-header">
        <h3>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="width:18px;height:18px;"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
          凭据冷却与熔断监控中心 (Cooldown Center)
        </h3>
        <div class="cpa-actions" style="margin:0;">
          ${button('cooldown-reset-all', '一键解除全部冷却', 'btn btn-danger btn-sm')}
          ${button('cooldown-refresh', '刷新冷却状态', 'btn btn-secondary btn-sm')}
        </div>
      </div>
      <div class="cpa-cooldown-list" id="cpa-cooldown-list"></div>
      <div class="cpa-status" id="cpa-cooldown-status"></div>
    </section>
    <section class="cpa-panel"><div class="cpa-panel-header"><div><h3>认证文件</h3><p>查看状态并管理已接入的账号。</p></div><div class="cpa-actions">${button('auth-batch-enable', '批量启用', 'btn btn-secondary btn-sm')}${button('auth-batch-disable', '批量停用', 'btn btn-secondary btn-sm')}${button('auth-batch-priority', '批量设优先级', 'btn btn-secondary btn-sm')}${button('auth-batch-reset-cooldown', '重置冷却', 'btn btn-secondary btn-sm')}${button('auth-refresh-all', '全量刷新', 'btn btn-secondary btn-sm')}${button('auth-delete-selected', '删除选中', 'btn btn-danger btn-sm')}${button('auth-refresh', '刷新列表')}</div></div>
      <div class="cpa-field"><label for="cpa-auth-search">筛选账号</label><input id="cpa-auth-search" type="search" placeholder="按名称、邮箱、提供商或状态搜索"/></div>
      <div class="cpa-table-wrap"><table class="cpa-table"><thead><tr><th><input id="cpa-auth-select-all" type="checkbox" aria-label="选择当前显示的文件"/></th><th>账号 / 文件</th><th>提供商</th><th>状态</th><th>操作</th></tr></thead><tbody id="cpa-auth-rows"><tr><td colspan="5">等待加载</td></tr></tbody></table></div>
      <div class="cpa-actions cpa-pagination"><span id="cpa-auth-page-info" class="cpa-status"></span>${button('auth-prev-page', '上一页')}${button('auth-next-page', '下一页')}</div>
      <div class="cpa-batch-report" id="cpa-auth-batch-report" hidden></div>
      <div class="cpa-status" id="cpa-auth-status"></div>
      <div id="cpa-auth-models" class="cpa-status"></div>
      <div id="cpa-provider-quota" hidden><h3>账号额度详情</h3><div class="cpa-quota-grid" id="cpa-provider-quota-cards"></div><details><summary>查看原始响应</summary><pre class="cpa-diff" id="cpa-provider-quota-data"></pre></details></div>
      <div id="cpa-auth-editor" class="cpa-auth-editor-card" hidden>
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
          <div>
            <h4>凭据高级属性配置</h4>
            <p style="margin:0;font-size:12px;color:var(--text-dim);">账号文件：<strong id="cpa-auth-edit-name" style="font-family:var(--mono);color:var(--accent);"></strong></p>
          </div>
          <div class="cpa-actions" style="margin:0;">
            ${button('auth-editor-close', '收起', 'btn btn-secondary btn-sm')}
          </div>
        </div>
        <div class="cpa-auth-editor-tabs">
          <button type="button" class="cpa-editor-tab-btn active" data-editor-tab="visual">可视化表单</button>
          <button type="button" class="cpa-editor-tab-btn" data-editor-tab="raw">原始 JSON</button>
        </div>
        <div id="cpa-auth-editor-visual">
          <div class="cpa-grid">
            <div class="cpa-field"><label for="cpa-edit-priority">调度优先级 (Priority)</label><input type="number" id="cpa-edit-priority" min="0" max="1000" placeholder="默认 0"/></div>
            <div class="cpa-field"><label for="cpa-edit-weight">调度权重 (Weight)</label><input type="number" id="cpa-edit-weight" min="1" max="1000" placeholder="默认 1"/></div>
          </div>
          <div class="cpa-grid">
            <div class="cpa-field"><label for="cpa-edit-proxy">独立代理地址 (Proxy URL)</label><input id="cpa-edit-proxy" placeholder="http://127.0.0.1:7897 或 socks5://..."/></div>
            <div class="cpa-field"><label for="cpa-edit-prefix">模型前缀 (Prefix)</label><input id="cpa-edit-prefix" placeholder="可选前缀"/></div>
          </div>
          <div class="cpa-field">
            <label>排除模型规则 (Excluded Models · 命中规则的模型不会分配给本凭据)</label>
            <div class="cpa-chip-list" id="cpa-edit-excluded-chips"></div>
            <div class="cpa-chip-input-wrap">
              <input id="cpa-edit-excluded-input" placeholder="输入模型 ID 或通配符 (如 gpt-4* 或 claude-3-opus*)"/>
              ${button('auth-add-excluded-chip', '添加排除', 'btn btn-secondary btn-sm')}
            </div>
          </div>
          <div class="cpa-field">
            <label>自定义 HTTP 请求头 (Headers)</label>
            <div class="cpa-kv-table" id="cpa-edit-headers-table"></div>
            <div class="cpa-actions" style="margin:6px 0;">
              ${button('auth-add-header-row', '添加请求头', 'btn btn-secondary btn-sm')}
            </div>
          </div>
          <div class="cpa-grid">
            <div class="cpa-field cpa-field-checkbox">
              <label><input type="checkbox" id="cpa-edit-disable-cooling"/> 免除冷却惩罚 (disable_cooling)</label>
            </div>
            <div class="cpa-field cpa-field-checkbox">
              <label><input type="checkbox" id="cpa-edit-websockets"/> 启用 WebSocket (websockets)</label>
            </div>
          </div>
          <div class="cpa-field">
            <label for="cpa-edit-note">备注信息 (Note)</label>
            <input id="cpa-edit-note" placeholder="例如：美西专线 / 个人测试号"/>
          </div>
        </div>
        <div id="cpa-auth-editor-raw" hidden>
          <div class="cpa-field">
            <label for="cpa-auth-fields">JSON 对象</label>
            <textarea id="cpa-auth-fields" spellcheck="false" style="min-height:220px;"></textarea>
          </div>
        </div>
        <div class="cpa-actions">
          ${button('auth-fields-save', '保存属性', 'btn btn-primary btn-sm')}
          ${button('auth-editor-close', '取消', 'btn btn-secondary btn-sm')}
        </div>
        <div class="cpa-status" id="cpa-auth-fields-status"></div>
      </div>
    </section>`;

  $('tab-page-cpa-providers').innerHTML = `
    <div class="cpa-provider-tabs">
      <button class="cpa-provider-tab-btn active" type="button" data-cpa-provider-tab="section-cpa-providers-config">提供商密钥与配置</button>
      <button class="cpa-provider-tab-btn" type="button" data-cpa-provider-tab="cpa-provider-probe">OpenAI 兼容模型发现与测试</button>
      <button class="cpa-provider-tab-btn" type="button" data-cpa-provider-tab="section-cpa-providers-alias">OAuth 模型别名映射</button>
      <button class="cpa-provider-tab-btn" type="button" data-cpa-provider-tab="section-cpa-providers-global-alias">全局模型别名映射</button>
    </div>
    <section class="cpa-panel" id="section-cpa-providers-config"><h3>提供商配置</h3><p>常用字段可直接编辑；保存前会重新读取 CPA，避免覆盖其他管理员刚做的修改。</p>
      <div class="cpa-field"><label for="cpa-provider-kind">配置类型</label><select id="cpa-provider-kind">
        <option value="openai-compatibility">OpenAI 兼容提供商</option><option value="gemini-api-key">Gemini API Key</option>
        <option value="codex-api-key">Codex API Key</option><option value="claude-api-key">Claude API Key</option>
        <option value="vertex-api-key">Vertex API Key</option><option value="interactions-api-key">Gemini Interactions API Key</option>
        <option value="meta-api-key">Meta API Key</option><option value="xai-api-key">xAI API Key</option>
        <option value="oauth-excluded-models">OAuth 排除模型</option>
      </select></div>
      <div class="cpa-actions">${button('provider-load', '读取配置')}${button('provider-save', '保存到 CPA', 'btn btn-primary btn-sm')}</div>
      <div id="cpa-provider-cards"></div><div id="cpa-provider-add-row" class="cpa-actions" hidden>${button('provider-add-card', '添加提供商 / 密钥')}</div>
      <details id="cpa-provider-json-details"><summary>高级 JSON 配置</summary><div class="cpa-field"><label for="cpa-provider-json">完整配置</label><textarea class="cpa-code" id="cpa-provider-json" spellcheck="false"></textarea></div></details>
      <div class="cpa-status" id="cpa-provider-status"></div>
    </section>
    <section class="cpa-panel" id="cpa-provider-probe" hidden><h3>OpenAI 兼容提供商模型</h3><p>通过 CPA 向已保存的提供商读取模型；模型测试会实际发起一次最多 8 token 的请求。</p>
      <div class="cpa-grid"><div class="cpa-field"><label for="cpa-probe-provider">提供商</label><select id="cpa-probe-provider"></select></div>
      <div class="cpa-field"><label for="cpa-probe-key">API Key 条目</label><select id="cpa-probe-key"></select></div></div>
      <div class="cpa-actions">${button('provider-discover', '发现模型', 'btn btn-primary btn-sm')}${button('provider-import-models', '加入 JSON 配置')}</div>
      <div class="cpa-field"><label for="cpa-discovered-models">发现的模型 ID（每行一个，可删减）</label><textarea id="cpa-discovered-models" spellcheck="false"></textarea></div>
      <div class="cpa-field"><label for="cpa-probe-model">测试模型 ID</label><input id="cpa-probe-model" placeholder="选择一个发现的模型"/></div>
      <div class="cpa-actions">${button('provider-test', '测试模型连通')}</div><div class="cpa-status" id="cpa-probe-status"></div>
    </section>
    <section class="cpa-panel" id="section-cpa-providers-alias" hidden><h3>OAuth 模型别名</h3><p>按提供商配置模型名称映射。每条记录需包含 name 和 alias。</p>
      <div class="cpa-field"><label for="cpa-alias-channel">提供商</label><select id="cpa-alias-channel"><option value="codex">Codex</option><option value="antigravity">Antigravity</option><option value="claude">Claude</option><option value="vertex">Vertex</option><option value="aistudio">AI Studio</option><option value="kimi">Kimi</option><option value="xai">xAI</option><option value="meta">Meta</option><option value="openai">OpenAI 旧配置</option></select></div>
      <div class="cpa-actions">${button('alias-load', '读取别名')}${button('alias-save', '保存别名', 'btn btn-primary btn-sm')}</div>
      <div id="cpa-alias-cards">请先读取此渠道的模型别名</div><div id="cpa-alias-add-row" class="cpa-actions" hidden>${button('alias-add', '添加映射')}</div>
      <details id="cpa-alias-json-details"><summary>高级 JSON 配置</summary><div class="cpa-field"><label for="cpa-alias-json">完整别名数组</label><textarea id="cpa-alias-json" spellcheck="false"></textarea></div></details>
      <div class="cpa-status" id="cpa-alias-status"></div>
    </section>
    <section class="cpa-panel" id="section-cpa-providers-global-alias" hidden><h3>全局模型别名映射 (Global Model Aliases)</h3><p>跨所有上游协议生效的全局模型名称映射（客户端发起 from 别名 -> 实际由上游 to 模型承载）。</p>
      <div class="cpa-actions">${button('global-alias-load', '读取全局别名')}${button('global-alias-save', '保存全局别名', 'btn btn-primary btn-sm')}${button('global-alias-add', '新增别名行')}</div>
      <div id="cpa-global-alias-cards">请点击"读取全局别名"加载</div>
      <div class="cpa-status" id="cpa-global-alias-status"></div>
    </section>`;

  const settings = [
    ['request-retry', '请求重试次数', 'number'], ['max-retry-interval', '最大重试间隔（秒）', 'number'],
    ['proxy-url', '全局代理地址', 'text'], ['request-log', '请求日志', 'boolean'],
    ['logging-to-file', '写入文件日志', 'boolean'], ['ws-auth', 'WebSocket 鉴权', 'boolean'],
    ['usage-statistics-enabled', '用量统计', 'boolean'],
    ['quota-exceeded/switch-project', '配额耗尽时切换项目', 'boolean'],
    ['quota-exceeded/switch-preview-model', '配额耗尽时切换预览模型', 'boolean'],
    ['error-logs-max-files', '错误日志保留文件数', 'number']
  ];
  $('tab-page-cpa-config').innerHTML = `
    <section class="cpa-panel" id="cpa-routing-panel"><h3>路由调度与会话粘性策略 (Routing & Load Balancing)</h3><p>控制上游凭据池分发算法与会话亲和性。支持轮询、加权轮询、填充优先、临期优先 (Smart) 与步调均衡 (Pace)。保存后直接热写回配置。</p>
      <div class="cpa-grid">
        <div class="cpa-field">
          <label for="cpa-routing-strategy">分发算法 (Strategy)</label>
          <select id="cpa-routing-strategy">
            <option value="round-robin">轮询 (Round Robin)</option>
            <option value="weighted-round-robin">加权轮询 (Weighted Round Robin)</option>
            <option value="fill-first">填充优先 (Fill First)</option>
            <option value="smart">临期优先 (Smart Quota)</option>
            <option value="pace">步调均衡 (Pace Quota)</option>
          </select>
        </div>
        <div class="cpa-field cpa-field-checkbox" style="align-self:end;margin-bottom:10px;">
          <label><input type="checkbox" id="cpa-routing-affinity"/> 启用会话粘性路由 (Session Affinity)</label>
        </div>
      </div>
      <div class="cpa-grid">
        <div class="cpa-field">
          <label for="cpa-routing-ttl">会话粘性 TTL (秒，留空表示关闭)</label>
          <input type="number" id="cpa-routing-ttl" min="0" placeholder="例如 3600"/>
        </div>
        <div class="cpa-actions" style="align-self:end;margin-bottom:8px;">
          ${button('routing-load', '刷新路由配置')}
          ${button('routing-save', '保存路由配置', 'btn btn-primary btn-sm')}
        </div>
      </div>
      <div class="cpa-status" id="cpa-routing-status"></div>
    </section>
    <section class="cpa-panel"><h3>常用设置</h3><p>修改后由 CPA 写回配置并热加载。</p>
      <div class="cpa-actions">${button('settings-load', '刷新设置')}${button('version-check', '检查 CPA 新版本')}</div><div class="cpa-status" id="cpa-version-status"></div>
      <div id="cpa-settings-rows">${settings.map(([key, label, type]) => `
        <div class="cpa-setting-row" data-cpa-setting="${key}">
          <label>${label}</label>
          ${type === 'boolean' ? `
            <label class="cpa-toggle-wrapper">
              <input class="cpa-setting-value cpa-toggle-input" type="checkbox"/>
              <span class="cpa-toggle-track"><span class="cpa-toggle-thumb"></span></span>
              <span class="cpa-toggle-state-text">关闭</span>
            </label>
          ` : `<input class="cpa-setting-value" type="${type}"/>`}
          ${button('setting-save', '保存')}
        </div>
      `).join('')}</div>
      <div class="cpa-status" id="cpa-settings-status"></div>
    </section>
    <section class="cpa-panel">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px;margin-bottom:12px;">
        <div>
          <h3>可用模型</h3>
          <p style="margin-bottom:0;">按选定的 API Key 查询经过 Gate 实际可访问的模型，支持快速过滤与直连探针测试。</p>
        </div>
        <div id="cpa-key-models-count" style="font-size:12px;color:#50708d;font-weight:600;align-self:center;"></div>
      </div>
      <div style="display:flex;flex-wrap:wrap;align-items:flex-end;gap:12px;margin-bottom:14px;">
        <div class="cpa-field" style="flex:1;min-width:240px;margin:0;">
          <label for="cpa-model-key">API Key</label>
          <select id="cpa-model-key"></select>
        </div>
        <div class="cpa-field" style="flex:1.2;min-width:240px;margin:0;">
          <label for="cpa-key-models-search">过滤模型</label>
          <input type="search" id="cpa-key-models-search" placeholder="输入模型名称或提供商过滤..."/>
        </div>
        <div class="cpa-actions" style="margin:0;padding-bottom:1px;">
          ${button('models-load-keys', '刷新 Key')}
          ${button('models-load', '重新查询', 'btn btn-primary btn-sm')}
        </div>
      </div>
      <div class="cpa-scroll-table-wrap">
        <table class="cpa-table">
          <thead>
            <tr>
              <th style="min-width:220px;">模型 ID</th>
              <th style="width:140px;">提供商</th>
              <th style="width:120px;text-align:right;">操作</th>
            </tr>
          </thead>
          <tbody id="cpa-model-rows">
            <tr><td colspan="3" style="text-align:center;padding:24px;color:#6b8194;">选择 Key 后查询</td></tr>
          </tbody>
        </table>
      </div>
      <div class="cpa-status" id="cpa-model-status"></div>
    </section>
    <details class="cpa-panel cpa-danger-panel" id="cpa-yaml-details">
      <summary class="cpa-danger-summary">
        <div class="cpa-danger-summary-title">
          <span class="cpa-danger-icon">${CPA_ICONS.warn}</span>
          <div>
            <strong style="color:#b4233a;font-size:14px;">高级维护：完整 config.yaml (高危配置区)</strong>
            <div style="font-size:12.5px;color:#6b8194;font-weight:normal;margin-top:2px;">
              直接编辑 CPA 原始底层配置文件。保存将全量替换 49 项全部全局配置，默认安全折叠防误触。
            </div>
          </div>
        </div>
        <span class="cpa-danger-expand-btn">点击展开编辑器 ▾</span>
      </summary>
      <div class="cpa-danger-content">
        <div style="background:#fff7f6;border:1px solid #ffd0d0;border-radius:10px;padding:10px 14px;margin-bottom:14px;font-size:12.5px;color:#99242a;line-height:1.5;">
          <strong>操作须知：</strong>保存将全量替换 CPA 全部配置。建议优先使用上方「常用设置」与「路由调度」进行细粒度修改。若确需手动编辑，保存前请务必仔细核对差异。
        </div>
        <div class="cpa-actions">
          ${button('yaml-load', '重新读取')}
          ${button('yaml-preview', '查看改动')}
          ${button('yaml-save', '保存 YAML (全量替换)', 'btn btn-danger btn-sm')}
        </div>
        <div class="cpa-field">
          <label for="cpa-yaml-editor">CPA config.yaml 原文</label>
          <textarea class="cpa-code" id="cpa-yaml-editor" spellcheck="false" style="min-height:280px;"></textarea>
        </div>
        <pre class="cpa-diff" id="cpa-yaml-diff" hidden></pre>
        <div class="cpa-status" id="cpa-yaml-status"></div>
      </div>
    </details>`;

  $('tab-page-cpa-logs').innerHTML = `
    <section class="cpa-panel"><h3>CPA 服务日志</h3><p>按时间范围分档加载（1 小时 / 6 小时 / 24 小时），随后增量刷新。CPA 的日志接口只支持「从某个秒级时间戳开始」，不支持只取末尾若干行，所以响应大小完全由回溯时长决定，因此不提供「全部历史」入口。若某个档位的日志量超过 8MB，Gate 会保留已收到的部分并在此处提示截断，此时请改选更短的时间范围。需要更早的历史日志请登录服务器直接查看 CPA 宿主机或容器日志挂载目录。Gate 请求流水仍在原工作区。</p>
      <div class="cpa-actions">${button('logs-load-1h', '最近 1 小时')}${button('logs-load-6h', '最近 6 小时')}${button('logs-load-24h', '最近 24 小时')}${button('logs-refresh', '获取新日志')}${button('logs-clear', '清空 CPA 日志', 'btn btn-danger btn-sm')}</div>
      <div class="cpa-field"><label for="cpa-log-filter">筛选日志</label><input id="cpa-log-filter" placeholder="按文本筛选已加载的日志" type="search"/></div>
      <label class="cpa-inline-check"><input id="cpa-hide-management" type="checkbox" checked/>隐藏管理 API 请求</label>
      <pre class="cpa-log-view" id="cpa-log-view">等待加载</pre><button class="btn btn-secondary btn-sm" type="button" id="cpa-logs-more" data-cpa-action="logs-more" hidden style="margin-top:6px;"></button><div class="cpa-logs-truncated" id="cpa-logs-truncated" role="alert" hidden style="margin-top:6px; padding:8px 10px; border:1px solid var(--danger, #d9534f); border-radius:6px; color:var(--danger, #d9534f); font-size:12.5px; line-height:1.5;"></div><div class="cpa-status" id="cpa-logs-status"></div>
    </section>
    <section class="cpa-panel"><div class="cpa-actions"><h3 style="margin-right:auto">请求错误文件</h3>${button('error-logs-refresh', '刷新文件')}</div>
      <div id="cpa-error-files">等待加载</div>
      <div id="cpa-error-viewer" class="cpa-log-viewer-modal" hidden>
        <div class="cpa-log-viewer-header">
          <div>
            <h4 id="cpa-error-viewer-title" style="margin:0;font-size:14px;font-family:var(--mono);color:#1e3a8a;"></h4>
            <span id="cpa-error-viewer-meta" style="font-size:12px;color:var(--text-dim);"></span>
          </div>
          <div class="cpa-actions" style="margin:0;">
            ${button('error-viewer-copy', '一键复制', 'btn btn-secondary btn-sm')}
            ${button('error-viewer-download', '下载原文件', 'btn btn-secondary btn-sm')}
            ${button('error-viewer-close', '关闭', 'btn btn-secondary btn-sm')}
          </div>
        </div>
        <pre class="cpa-error-log-body" id="cpa-error-viewer-content"></pre>
      </div>
    </section>`;

  async function request(path, options = {}) {
    const headers = { ...getAuthHeaders(), ...(options.headers || {}) };
    const response = await fetch(`/admin/api/cpa/${path}`, { ...options, headers });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `HTTP ${response.status}`);
    }
    return response;
  }
  async function json(path, method = 'GET', body) {
    const response = await request(path, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return response.json();
  }
  function status(id, message, kind = '') { const node = $(id); node.textContent = message; node.className = `cpa-status ${kind}`; }

  function renderAuthFiles() {
      const query = $('cpa-auth-search').value.trim().toLowerCase();
      const filtered = state.authFiles.filter(file => !query || [file.name, file.email, file.label, file.provider, file.type, file.status, file.status_message].some(value => String(value || '').toLowerCase().includes(query)));
      const pages = Math.max(1, Math.ceil(filtered.length / 25));
      state.authPage = Math.min(Math.max(1, state.authPage), pages);
      const files = filtered.slice((state.authPage - 1) * 25, state.authPage * 25);
      $('cpa-auth-rows').innerHTML = files.length ? files.map(file => {
        const name = String(file.name || '');
        const onDisk = !file.runtime_only && file.source !== 'memory' && name.endsWith('.json');
        const provider = String(file.provider || file.type || '').toLowerCase();
        const extraQuota = ['claude', 'anthropic', 'kimi', 'xai', 'grok', 'devin', 'meta'].includes(provider) && file.auth_index;
        const health = file.gate_health || {};
        const blocked = health.blocked === true;
        const detail = blocked ? health.detail : file.status_message;
        const primaryAction = extraQuota && !blocked
          ? `<button class="btn btn-secondary btn-sm" data-cpa-action="provider-quota" data-index="${escape(file.auth_index)}">查看额度</button>`
          : onDisk ? `<button class="btn btn-secondary btn-sm" data-cpa-action="auth-models" data-name="${escape(name)}">查看模型</button>` : '';
        const moreActions = [
          onDisk && extraQuota && !blocked ? `<button class="btn btn-secondary btn-sm" data-cpa-action="auth-models" data-name="${escape(name)}">查看模型</button>` : '',
          onDisk ? `<button class="btn btn-secondary btn-sm" data-cpa-action="auth-edit" data-name="${escape(name)}">高级字段</button><button class="btn btn-secondary btn-sm" data-cpa-action="credential-refresh" data-name="${escape(name)}" data-index="${escape(file.auth_index || '')}">刷新凭据</button>` : '',
          name ? `<button class="btn btn-secondary btn-sm" data-cpa-action="auth-toggle" data-name="${escape(name)}" data-disabled="${file.disabled ? 'false' : 'true'}">${file.disabled ? '启用' : '停用'}</button>` : '',
          file.auth_index ? `<button class="btn btn-secondary btn-sm" data-cpa-action="quota-reset" data-index="${escape(file.auth_index)}">重置冷却</button>` : '',
          onDisk ? `<button class="btn btn-secondary btn-sm" data-cpa-action="auth-download" data-name="${escape(name)}">下载文件</button><button class="btn btn-danger btn-sm" data-cpa-action="auth-delete" data-name="${escape(name)}">删除文件</button>` : ''
        ].filter(Boolean).join('');
        return `<tr><td class="cpa-auth-select">${onDisk ? `<input type="checkbox" data-cpa-select-auth="${escape(name)}" aria-label="选择 ${escape(name)}" ${state.selectedAuth.has(name) ? 'checked' : ''}/>` : ''}</td><td class="cpa-auth-identity"><strong>${escape(file.email || file.label || name)}</strong><small>${escape(name)}</small></td><td data-label="提供商">${escape(provider || '—')}</td><td class="cpa-auth-health" data-label="状态"><span class="cpa-badge ${blocked ? 'error' : ''}">${escape(blocked ? health.label : formatAuthStatus(file.status || 'ready'))}</span>${detail ? `<small class="${blocked ? 'cpa-auth-error' : ''}">${escape(detail)}</small>` : ''}</td><td class="cpa-auth-action-cell" data-label="操作"><div class="cpa-row-actions">${primaryAction}${moreActions ? `<details class="cpa-row-menu"><summary>更多操作</summary><div class="cpa-row-menu-content">${moreActions}</div></details>` : ''}</div></td></tr>`;
      }).join('') : '<tr><td colspan="5">暂无认证文件</td></tr>';
      const selectable = [...$('cpa-auth-rows').querySelectorAll('[data-cpa-select-auth]')];
      $('cpa-auth-select-all').checked = selectable.length > 0 && selectable.every(box => box.checked);
      $('cpa-auth-page-info').textContent = `${filtered.length} 个账号 · 第 ${state.authPage}/${pages} 页 · 已选 ${state.selectedAuth.size} 个`;
      $('tab-page-cpa-auth').querySelector('[data-cpa-action="auth-prev-page"]').disabled = state.authPage <= 1;
      $('tab-page-cpa-auth').querySelector('[data-cpa-action="auth-next-page"]').disabled = state.authPage >= pages;
  }
  function renderCooldownBanner() {
    const banner = $('cpa-cooldown-banner');
    const list = $('cpa-cooldown-list');
    if (!banner || !list) return;

    const cooling = (state.authFiles || []).filter(f => {
      const h = f.gate_health || {};
      return h.state === 'cooldown' || f.status === 'cooling' || (h.cooldown && h.cooldown.remaining_seconds > 0);
    });
    state.cooldownList = cooling;

    if (!cooling.length) {
      banner.hidden = true;
      list.innerHTML = '';
      return;
    }

    banner.hidden = false;
    list.innerHTML = cooling.map(file => {
      const h = file.gate_health || {};
      const cd = h.cooldown || {};
      const remainingText = cd.remaining_text || (cd.remaining_seconds ? `约 ${Math.ceil(cd.remaining_seconds / 60)} 分钟` : '冷却中');
      const reasonText = cd.reason_label || h.label || '请求异常冷却';
      const scopeText = cd.scope_label || '整凭证';
      const name = String(file.name || '');
      const authIndex = String(file.auth_index || '');
      return `<div class="cpa-cooldown-item">
        <div class="cpa-cooldown-identity">
          <strong>${escape(file.email || file.label || name)}</strong>
          <small>${escape(name)} · ${escape(scopeText)}</small>
        </div>
        <div class="cpa-cooldown-detail">
          <span class="cpa-badge error">${escape(reasonText)}</span>
          <span class="cpa-cooldown-timer">${escape(remainingText)}</span>
        </div>
        ${authIndex ? `<button class="btn btn-secondary btn-sm" type="button" data-cpa-action="cooldown-reset-one" data-index="${escape(authIndex)}" data-name="${escape(name)}">立即解冻</button>` : ''}
      </div>`;
    }).join('');
  }

  async function loadCooldowns() {
    await loadAuthFiles();
    renderCooldownBanner();
  }

  async function resetAllCooldowns() {
    if (!confirm('确定解除全部凭据的冷却状态吗？')) return;
    try {
      const result = await json('cooldown/reset-all', 'POST');
      status('cpa-cooldown-status', result.message || '全部冷却已成功解除', 'success');
      showToast(result.message || '全部冷却已成功解除', 'success');
      await loadAuthFiles();
      renderCooldownBanner();
    } catch (err) {
      status('cpa-cooldown-status', err.message, 'error');
      showToast(`解除冷却失败：${err.message}`, 'error');
    }
  }

  async function resetOneCooldown(authIndex, name) {
    try {
      await json('cooldown/reset', 'POST', { auth_index: authIndex });
      showToast(`已解除 ${name} 的冷却状态`, 'success');
      await loadAuthFiles();
      renderCooldownBanner();
    } catch (err) {
      showToast(`解除冷却失败：${err.message}`, 'error');
    }
  }

  async function refreshAllCredentials() {
    if (!confirm('确定向 CPA 请求全量刷新所有凭据吗？')) return;
    try {
      status('cpa-auth-status', '正在后台全量刷新凭据...', '');
      const result = await json('credentials/refresh-all', 'POST');
      const msg = `全量刷新完成：成功 ${result.succeeded} / 失败 ${result.failed} / 总共 ${result.total}`;
      status('cpa-auth-status', msg, result.failed ? 'error' : 'success');
      showToast(msg, result.failed ? 'warning' : 'success');
      await loadAuthFiles();
    } catch (err) {
      status('cpa-auth-status', `刷新失败：${err.message}`, 'error');
      showToast(`刷新凭据失败：${err.message}`, 'error');
    }
  }

  async function loadAuthFiles() {
    try {
      const data = await json('auth-files');
      state.authFiles = Array.isArray(data.files) ? data.files : [];
      $('cpa-provider-quota').hidden = true;
      const existing = new Set(state.authFiles.filter(file => !file.runtime_only && file.source !== 'memory' && String(file.name || '').endsWith('.json')).map(file => file.name));
      for (const name of state.selectedAuth) if (!existing.has(name)) state.selectedAuth.delete(name);
      renderAuthFiles();
      renderCooldownBanner();
      status('cpa-auth-status', `CPA 返回 ${state.authFiles.length} 个凭据`, 'success');
    } catch (error) { status('cpa-auth-status', error.message, 'error'); }
  }

  async function toggleAuthFile(name, disabled) {
    try {
      await json('auth-files/status', 'PATCH', { name, disabled });
      await loadAuthFiles();
      status('cpa-auth-status', disabled ? `已停用 ${name}` : `已启用 ${name}`, 'success');
    } catch (error) { status('cpa-auth-status', error.message, 'error'); }
  }

  async function uploadAuthFile() {
    const files = [...($('cpa-auth-upload').files || [])];
    if (!files.length) return status('cpa-auth-upload-status', '请先选择 JSON 文件', 'error');
    const failures = [];
    let uploaded = 0;
    for (const file of files) {
      try {
        if (file.size > 2 * 1024 * 1024) throw new Error('文件超过 2 MiB');
        const content = await file.text();
        JSON.parse(content);
        await json('auth-files', 'POST', { name: file.name, content });
        uploaded++;
      } catch (error) { failures.push(`${file.name}: ${error.message}`); }
    }
    $('cpa-auth-upload').value = '';
    status('cpa-auth-upload-status', `成功上传 ${uploaded}/${files.length} 个文件${failures.length ? `；失败：${failures.join('；')}` : ''}`, failures.length ? 'error' : 'success');
    await loadAuthFiles();
  }

  const BATCH_LABELS = { enable: '启用', disable: '停用', priority: '设置优先级', 'reset-cooldown': '重置冷却', delete: '删除' };

  // 批量结果的统一呈现：汇总计数 + 失败项逐条列出 + 一键重试失败项。
  // 成功的条目从选中集合里移除，失败的保留选中，方便直接重试或再排查。
  function renderBatchReport(action, result) {
    const holder = $('cpa-auth-batch-report');
    if (!holder) return;
    const label = BATCH_LABELS[action] || action;
    if (!result.failed) {
      holder.className = 'cpa-batch-report is-ok';
      holder.innerHTML = `<strong>${escape(label)}</strong> 已处理 ${result.total} 个：全部成功`;
      holder.hidden = false;
      return;
    }
    const failures = result.results.filter(r => !r.ok);
    holder.className = 'cpa-batch-report is-error';
    holder.innerHTML = `<strong>${escape(label)}</strong> 已处理 ${result.total} 个：成功 ${result.succeeded} · 失败 ${result.failed}
      <ul class="cpa-batch-failures">${failures.map(r => `<li><code>${escape(r.name)}</code> — ${escape(r.error || '未知错误')}</li>`).join('')}</ul>
      <div class="cpa-actions"><button class="btn btn-secondary btn-sm" data-cpa-action="auth-batch-retry" type="button">重试失败项</button><button class="btn btn-secondary btn-sm" data-cpa-action="auth-batch-dismiss" type="button">关闭</button></div>`;
    holder.hidden = false;
  }

  // 逐条执行、逐条汇报：一个失败不阻断其余，也不回滚已成功的条目
  async function runBatch(action, names, value) {
    if (!names.length) return status('cpa-auth-status', '请先选择认证文件', 'error');
    // 批量端点不在 /admin/api/cpa/ 桥下（那层只转发 CPA 自身的路径），
    // 所以直接 fetch 完整路径，不能走 json() 助手。
    const response = await fetch('/admin/api/upstream-auth/batch', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ names, action, value })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    for (const row of result.results) {
      if (row.ok) state.selectedAuth.delete(row.name);
    }
    // 记下本次动作与失败项，供 "重试失败项" 原样重发
    state.lastBatch = { action, value, failedNames: result.results.filter(r => !r.ok).map(r => r.name) };
    await loadAuthFiles();
    renderBatchReport(action, result);
    status('cpa-auth-status', `${BATCH_LABELS[action] || action}：成功 ${result.succeeded}/${result.total}`, result.failed ? 'error' : 'success');
    return result;
  }

  async function retryFailedBatch() {
    const last = state.lastBatch;
    if (!last || !last.failedNames.length) return;
    await runBatch(last.action, last.failedNames, last.value);
  }

  async function batchSelectedAuthFiles(action) {
    const names = [...state.selectedAuth];
    if (!names.length) return status('cpa-auth-status', '请先选择认证文件', 'error');
    if (action === 'disable' && !confirm(`确定停用选中的 ${names.length} 个认证文件？停用后它们不再参与调度。`)) return;
    if (action === 'reset-cooldown' && !confirm(`确定重置选中的 ${names.length} 个凭据的冷却状态？`)) return;
    await runBatch(action, names);
  }

  async function batchSetPriority() {
    const names = [...state.selectedAuth];
    if (!names.length) return status('cpa-auth-status', '请先选择认证文件', 'error');
    const current = typeof defaultAuthPriority === 'function' ? defaultAuthPriority() : 10;
    const input = prompt(`为选中的 ${names.length} 个认证文件设置调度优先级（0-1000，数值越大越优先）`, String(current));
    if (input === null) return;
    if (!/^\d+$/.test(input.trim())) return status('cpa-auth-status', '优先级必须是非负整数', 'error');
    await runBatch('priority', names, Number.parseInt(input.trim(), 10));
  }

  async function deleteSelectedAuthFiles() {
    const names = [...state.selectedAuth];
    if (!names.length) return status('cpa-auth-status', '请先选择认证文件', 'error');
    if (!confirm(`确定从 CPA 删除选中的 ${names.length} 个认证文件？`)) return;
    // 走服务端批量端点，与其余批量动作共用同一套汇总与重试 UI
    const result = await runBatch('delete', names);
    return result;
  }

  async function importVertex() {
    const file = $('cpa-vertex-upload').files?.[0];
    if (!file) return status('cpa-vertex-status', '请先选择服务账号 JSON 文件', 'error');
    if (file.size > 2 * 1024 * 1024) return status('cpa-vertex-status', '文件不得超过 2 MiB', 'error');
    try {
      const content = await file.text();
      JSON.parse(content);
      const location = $('cpa-vertex-location').value.trim();
      const result = await json('vertex/import', 'POST', { name: file.name, content, ...(location ? { location } : {}) });
      $('cpa-vertex-upload').value = '';
      status('cpa-vertex-status', `已导入 ${result.project_id || 'Vertex 服务账号'}`, 'success');
      await loadAuthFiles();
    } catch (error) { status('cpa-vertex-status', error.message, 'error'); }
  }

  async function download(path, name) {
    const response = await request(path);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function showAuthModels(name) {
    try {
      const data = await json(`auth-files/models?name=${encodeURIComponent(name)}`);
      const models = Array.isArray(data.models) ? data.models : [];
      $('cpa-auth-models').textContent = `${name} 支持模型：${models.map(model => model.id || model.name || String(model)).join('、') || '暂无数据'}`;
    } catch (error) { status('cpa-auth-status', error.message, 'error'); }
  }
  async function showProviderQuota(authIndex) {
    try {
      const file = state.authFiles.find(item => String(item.auth_index || item.authIndex || '') === String(authIndex));
      if (file?.gate_health?.blocked) { $('cpa-provider-quota').hidden = true; return status('cpa-auth-status', file.gate_health.detail, 'error'); }
      const data = await json(`provider-quota?auth_index=${encodeURIComponent(authIndex)}`);
      const rows = [];
      const percent = (value, used = false) => {
        if (value === null || value === undefined || value === '') return null;
        const number = Number(value);
        return Number.isFinite(number) ? Math.max(0, Math.min(100, used ? 100 - number : number)) : null;
      };
      const add = (label, remaining, detail = '') => rows.push({ label, remaining, detail });
      if (data.provider === 'claude') {
        const usage = data.results?.usage?.data || {};
        const labels = { five_hour: '5 小时', seven_day: '7 天', seven_day_opus: 'Opus 7 天', seven_day_sonnet: 'Sonnet 7 天', seven_day_oauth_apps: 'OAuth 应用 7 天', seven_day_cowork: 'Cowork 7 天' };
        for (const [key, label] of Object.entries(labels)) if (usage[key] && usage[key].utilization !== undefined) {
          const reset = usage[key].resets_at ? `恢复：${new Date(usage[key].resets_at).toLocaleString()}` : '';
          add(label, percent(usage[key].utilization, true), reset);
        }
      } else if (data.provider === 'kimi') {
        const usage = data.results?.usage?.data || {};
        const limits = Array.isArray(usage.limits) ? usage.limits : [];
        for (const [index, item] of [usage.usage, ...limits.map(entry => entry.detail || entry)].entries()) {
          if (!item) continue;
          const used = Number(item.used), limit = Number(item.limit);
          const remaining = Number.isFinite(used) && Number.isFinite(limit) && limit > 0 ? percent(((limit - used) / limit) * 100) : null;
          add(item.title || item.name || limits[index - 1]?.title || `额度 ${index + 1}`, remaining, Number.isFinite(used) && Number.isFinite(limit) ? `${used} / ${limit} 已用` : '');
        }
      } else if (data.provider === 'xai') {
        for (const [name, label] of [['weekly', '每周'], ['monthly', '每月']]) {
          const config = data.results?.[name]?.data?.config;
          if (!config) continue;
          const used = config.creditUsagePercent ?? config.credit_usage_percent;
          const period = config.currentPeriod || config.current_period;
          add(label, percent(used, true), period?.end ? `周期结束：${new Date(period.end).toLocaleString()}` : '');
        }
      } else if (data.provider === 'devin') {
        const quota = data.results?.quota?.data || {};
        for (const [name, label] of [['daily', '每天'], ['weekly', '每周']]) {
          const remaining = percent(quota[`${name}_remaining_percent`]);
          const reset = Number(quota[`${name}_reset_at_unix`]);
          add(label, remaining, [quota.plan ? `套餐：${quota.plan}` : '', reset > 0 ? `恢复：${new Date(reset * 1000).toLocaleString()}` : ''].filter(Boolean).join(' · '));
        }
      } else if (data.provider === 'meta') {
        const quota = data.results?.quota?.data || {};
        for (const [name, label] of [['window', '当前窗口'], ['weekly', '每周']]) {
          const window = quota[name];
          if (!window) continue;
          const reset = Number(window.resets_at);
          add(label, percent(window.used_percent, true), [quota.plan ? `套餐：${quota.plan}` : '', reset > 0 ? `恢复：${new Date(reset * 1000).toLocaleString()}` : ''].filter(Boolean).join(' · '));
        }
      }
      $('cpa-provider-quota-cards').innerHTML = rows.length ? rows.map(row => `<div class="cpa-quota-item"><strong>${escape(row.label)}</strong><span>${row.remaining === null ? '额度未知' : `剩余 ${Math.round(row.remaining)}%`}</span><div class="cpa-quota-meter"><i style="width:${row.remaining ?? 0}%"></i></div><small>${escape(row.detail)}</small></div>`).join('') : '<p>上游未提供可计算的额度，详情见原始响应。</p>';
      $('cpa-provider-quota-data').textContent = JSON.stringify(data, null, 2);
      $('cpa-provider-quota').hidden = false;
      $('cpa-provider-quota').scrollIntoView({ block: 'nearest' });
    } catch (error) { $('cpa-provider-quota').hidden = true; status('cpa-auth-status', error.message, 'error'); }
  }
  function renderExcludedChips() {
    const list = $('cpa-edit-excluded-chips');
    if (!list) return;
    if (!state.editingAuthExcluded.length) {
      list.innerHTML = '<span style="font-size:12px;color:var(--text-dim);padding:2px 4px;">暂无排除规则 (可使用通配符如 gpt-4*)</span>';
      return;
    }
    list.innerHTML = state.editingAuthExcluded.map((model, idx) => `
      <span class="cpa-chip" data-chip-index="${idx}">
        <span>${escape(model)}</span>
        <span class="chip-del" data-cpa-action="auth-delete-excluded-chip" data-index="${idx}" title="移除">×</span>
      </span>
    `).join('');
  }

  function renderHeadersTable() {
    const table = $('cpa-edit-headers-table');
    if (!table) return;
    if (!state.editingAuthHeaders.length) {
      table.innerHTML = '<span style="font-size:12px;color:var(--text-dim);">暂无自定义请求头</span>';
      return;
    }
    table.innerHTML = state.editingAuthHeaders.map((item, idx) => `
      <div class="cpa-kv-row" data-header-index="${idx}">
        <input placeholder="Header 名称 (如 X-Custom-Auth)" value="${escape(item.key)}" data-header-field="key" data-index="${idx}"/>
        <input placeholder="Header 值" value="${escape(item.value)}" data-header-field="value" data-index="${idx}"/>
        <button type="button" class="btn btn-secondary btn-sm" data-cpa-action="auth-delete-header-row" data-index="${idx}" style="min-height:36px;">移除</button>
      </div>
    `).join('');
  }

  function collectVisualFields() {
    const prioRaw = $('cpa-edit-priority').value.trim();
    const weightRaw = $('cpa-edit-weight').value.trim();
    const proxy = $('cpa-edit-proxy').value.trim();
    const prefix = $('cpa-edit-prefix').value.trim();
    const note = $('cpa-edit-note').value.trim();
    const disableCooling = $('cpa-edit-disable-cooling').checked;
    const websockets = $('cpa-edit-websockets').checked;

    // 同步请求头表单中的输入值到 state
    const table = $('cpa-edit-headers-table');
    if (table) {
      const rows = table.querySelectorAll('.cpa-kv-row');
      state.editingAuthHeaders = [...rows].map(row => {
        const k = row.querySelector('[data-header-field="key"]')?.value.trim() || '';
        const v = row.querySelector('[data-header-field="value"]')?.value.trim() || '';
        return { key: k, value: v };
      }).filter(item => item.key);
    }

    const headersObj = {};
    for (const h of state.editingAuthHeaders) {
      if (h.key) headersObj[h.key] = h.value;
    }

    const payload = {};
    if (prioRaw !== '') payload.priority = Number(prioRaw);
    if (weightRaw !== '') payload.weight = Number(weightRaw);
    if (proxy) payload.proxy_url = proxy;
    if (prefix) payload.prefix = prefix;
    if (note) payload.note = note;
    if (state.editingAuthExcluded.length) payload.excluded_models = [...state.editingAuthExcluded];
    if (Object.keys(headersObj).length) payload.headers = headersObj;
    if (disableCooling) payload.disable_cooling = true;
    if (websockets) payload.websockets = true;

    return payload;
  }

  function switchEditorTab(tab) {
    state.editingAuthTab = tab;
    const visualPanel = $('cpa-auth-editor-visual');
    const rawPanel = $('cpa-auth-editor-raw');
    const tabBtns = document.querySelectorAll('.cpa-editor-tab-btn');
    tabBtns.forEach(btn => btn.classList.toggle('active', btn.dataset.editorTab === tab));

    if (tab === 'visual') {
      try {
        const currentJson = JSON.parse($('cpa-auth-fields').value || '{}');
        populateVisualInputs(currentJson);
      } catch (_) {}
      if (visualPanel) visualPanel.hidden = false;
      if (rawPanel) rawPanel.hidden = true;
    } else {
      const visualPayload = collectVisualFields();
      $('cpa-auth-fields').value = JSON.stringify(visualPayload, null, 2);
      if (visualPanel) visualPanel.hidden = true;
      if (rawPanel) rawPanel.hidden = false;
    }
  }

  function populateVisualInputs(fields) {
    $('cpa-edit-priority').value = fields.priority !== undefined ? fields.priority : '';
    $('cpa-edit-weight').value = fields.weight !== undefined ? fields.weight : '';
    $('cpa-edit-proxy').value = fields.proxy_url || '';
    $('cpa-edit-prefix').value = fields.prefix || '';
    $('cpa-edit-note').value = fields.note || '';
    $('cpa-edit-disable-cooling').checked = Boolean(fields.disable_cooling || fields['disable-cooling']);
    $('cpa-edit-websockets').checked = Boolean(fields.websockets);

    const rawExcluded = fields.excluded_models || fields['excluded-models'] || [];
    state.editingAuthExcluded = Array.isArray(rawExcluded) ? [...rawExcluded].filter(Boolean) : [];
    renderExcludedChips();

    const rawHeaders = (fields.headers && typeof fields.headers === 'object') ? fields.headers : {};
    state.editingAuthHeaders = Object.entries(rawHeaders).map(([k, v]) => ({ key: k, value: String(v) }));
    renderHeadersTable();
  }

  function editAuthFields(name) {
    const file = state.authFiles.find(item => item.name === name);
    if (!file) return;
    const keys = ['prefix', 'proxy_url', 'headers', 'priority', 'weight', 'note', 'excluded_models', 'excluded-models', 'disable_cooling', 'disable-cooling', 'websockets', 'using_api', 'expired'];
    const fields = Object.fromEntries(keys.filter(key => file[key] !== undefined).map(key => [key, file[key]]));
    state.editingAuthName = name;
    $('cpa-auth-edit-name').textContent = name;
    $('cpa-auth-fields').value = JSON.stringify(fields, null, 2);

    populateVisualInputs(fields);
    switchEditorTab('visual');

    $('cpa-auth-editor').hidden = false;
    $('cpa-auth-editor').scrollIntoView({ block: 'nearest' });
  }

  async function saveAuthFields() {
    if (!state.editingAuthName) return;
    try {
      let fields;
      if (state.editingAuthTab === 'visual') {
        fields = collectVisualFields();
      } else {
        fields = JSON.parse($('cpa-auth-fields').value);
      }
      if (!fields || Array.isArray(fields) || typeof fields !== 'object') throw new Error('字段配置必须是 JSON 对象');
      await json('auth-files/fields', 'PATCH', { name: state.editingAuthName, ...fields });
      status('cpa-auth-fields-status', '凭据高级属性已成功保存', 'success');
      await loadAuthFiles();
    } catch (error) { status('cpa-auth-fields-status', error.message, 'error'); }
  }

  async function startOAuth() {
    const provider = $('cpa-oauth-provider').value;
    if (state.oauthTimer) clearInterval(state.oauthTimer);
    state.oauthTimer = null;
    state.oauthProvider = '';
    state.oauthState = '';
    $('cpa-oauth-result').hidden = true;
    $('cpa-oauth-placeholder').hidden = false;
    $('cpa-oauth-link-input').value = '';
    $('cpa-oauth-link').removeAttribute('href');
    status('cpa-oauth-status', '正在向 CPA 生成授权链接…');
    try {
      const data = await json(`oauth/${provider}/start`, 'POST');
      const url = new URL(data.url);
      if (!['https:', 'http:'].includes(url.protocol)) throw new Error('CPA 返回的授权链接无效');
      state.oauthProvider = provider;
      state.oauthState = typeof data.state === 'string' ? data.state : '';
      $('cpa-oauth-link-input').value = url.href;
      $('cpa-oauth-link').href = url.href;
      $('cpa-oauth-placeholder').hidden = true;
      $('cpa-oauth-result').hidden = false;
      const code = $('cpa-oauth-device-code');
      const codeVal = $('cpa-oauth-device-code-val');
      if (code) code.hidden = !data.user_code;
      if (codeVal) codeVal.textContent = data.user_code || '';
      status('cpa-oauth-status', state.oauthState ? '链接已生成。打开并完成授权后，Gate 会自动检查结果。' : '链接已生成。完成授权后，请刷新认证文件列表。');
      if (!state.oauthState) return;
      let attempts = 0;
      state.oauthTimer = setInterval(async () => {
        try {
          const result = await json(`oauth/status?state=${encodeURIComponent(state.oauthState)}`);
          if (result.status === 'wait' && ++attempts < 120) return;
          clearInterval(state.oauthTimer); state.oauthTimer = null;
          status('cpa-oauth-status', result.status === 'ok' ? '授权已完成' : (result.error || '授权未完成或已超时'), result.status === 'ok' ? 'success' : 'error');
          if (result.status === 'ok') loadAuthFiles();
        } catch (error) { clearInterval(state.oauthTimer); state.oauthTimer = null; status('cpa-oauth-status', error.message, 'error'); }
      }, 3000);
    } catch (error) {
      $('cpa-oauth-placeholder').hidden = false;
      status('cpa-oauth-status', error.message, 'error');
    }
  }

  async function copyOAuthLink() {
    const input = $('cpa-oauth-link-input');
    if (!input.value) return status('cpa-oauth-status', '请先生成授权链接', 'error');
    try {
      await navigator.clipboard.writeText(input.value);
      status('cpa-oauth-status', '授权链接已复制，请自行粘贴到浏览器打开。', 'success');
    } catch (_) {
      input.focus();
      input.select();
      status('cpa-oauth-status', '无法自动复制，已选中链接，请手动复制。', 'error');
    }
  }

  async function cancelOAuth() {
    try {
      if (state.oauthState) await json('oauth/cancel', 'POST', { state: state.oauthState });
      if (state.oauthTimer) clearInterval(state.oauthTimer);
      state.oauthTimer = null;
      state.oauthState = '';
      state.oauthProvider = '';
      $('cpa-oauth-result').hidden = true;
      $('cpa-oauth-placeholder').hidden = false;
      $('cpa-oauth-link-input').value = '';
      $('cpa-oauth-link').removeAttribute('href');
      status('cpa-oauth-status', '已关闭授权链接', 'success');
    } catch (error) { status('cpa-oauth-status', error.message, 'error'); }
  }

  async function submitOAuthCallback() {
    if (!state.oauthProvider) return status('cpa-oauth-status', '请先启动授权', 'error');
    const input = $('cpa-oauth-callback').value.trim();
    try {
      let redirect = input;
      if (state.oauthProvider === 'xai' && input && !/^https?:\/\//i.test(input)) {
        if (!state.oauthState) throw new Error('xAI 验证码缺少授权 state，请重新启动授权');
        const code = input.match(/\bcode\s*[:=]\s*([^\s&]+)/i)?.[1] || (/^[A-Za-z0-9._~-]+$/.test(input) ? input : '');
        if (!code) throw new Error('未找到 xAI 验证码');
        const callback = new URL('http://127.0.0.1:56121/callback');
        callback.searchParams.set('state', state.oauthState);
        callback.searchParams.set('code', code);
        redirect = callback.href;
      }
      const url = new URL(redirect);
      if (!['https:', 'http:'].includes(url.protocol)) throw new Error('请粘贴完整的 HTTP(S) 回调地址');
      await json('oauth/callback', 'POST', { provider: state.oauthProvider, redirect_url: redirect });
      status('cpa-oauth-status', '回调已提交，正在等待 CPA 保存凭据...', 'success');
      if (state.oauthState) {
        try {
          const check = await json(`oauth/status?state=${encodeURIComponent(state.oauthState)}`);
          if (check.status === 'ok') {
            status('cpa-oauth-status', 'OAuth 授权与凭据保存已完成！', 'success');
            await loadAuthFiles();
            return;
          }
        } catch (_) {}
      }
      await loadAuthFiles();
    } catch (error) { status('cpa-oauth-status', error.message, 'error'); }
  }

  function extractProviderData(kind, data) { return data?.[kind] ?? data; }
  function maskKey(key) {
    if (!key || typeof key !== 'string') return '未配置密钥';
    const str = key.trim();
    if (!str) return '未配置密钥';
    if (str.length <= 8) return '••••••••';
    if (str.length <= 16) return str.slice(0, 4) + '••••' + str.slice(-2);
    return str.slice(0, 8) + '••••' + str.slice(-4);
  }

  function providerDetails(item, kind) {
    const supported = ['openai-compatibility', 'gemini-api-key', 'codex-api-key', 'claude-api-key', 'vertex-api-key'].includes(kind);
    if (!supported && !['models', 'headers', 'excluded-models'].some(field => Object.hasOwn(item, field))) return '';
    const models = Array.isArray(item.models) ? item.models : [];
    const headers = item.headers && typeof item.headers === 'object' && !Array.isArray(item.headers) ? Object.entries(item.headers) : [];
    const excluded = Array.isArray(item['excluded-models']) ? item['excluded-models'] : [];
    const supportsExcluded = ['gemini-api-key', 'codex-api-key', 'claude-api-key'].includes(kind) || Object.hasOwn(item, 'excluded-models');
    return `<details class="cpa-provider-details">
      <summary class="cpa-provider-details-summary">
        <span class="cpa-details-summary-title">${CPA_ICONS.settings} 高级配置（模型别名、自定义 Header${supportsExcluded ? ' 与排除规则' : ''}）</span>
        <span class="cpa-keys-arrow">⌄</span>
      </summary>
      <div class="cpa-provider-details-body">
        <h4>模型别名</h4>${models.map((model, index) => `<div class="cpa-provider-list-row" data-cpa-model-index="${index}">
          <div class="cpa-field"><label>上游模型</label><input data-cpa-provider-field="model-name" value="${escape(model?.name || '')}"/></div>
          <div class="cpa-field"><label>对外别名</label><input data-cpa-provider-field="model-alias" value="${escape(model?.alias || '')}"/></div>
          ${button('provider-delete-model', '移除', 'btn btn-secondary btn-sm')}</div>`).join('')}${button('provider-add-model', '添加模型')}
        <h4>自定义 Header</h4>${headers.map(([name, value], index) => `<div class="cpa-provider-list-row" data-cpa-header-index="${index}">
          <div class="cpa-field"><label>名称</label><input data-cpa-provider-field="header-name" value="${escape(name)}"/></div>
          <div class="cpa-field"><label>值</label><div class="cpa-input-with-tools"><input type="password" autocomplete="off" data-cpa-provider-field="header-value" value="${escape(value)}"/><button type="button" class="cpa-btn-tool" data-cpa-action="toggle-key-visibility" title="查看明文/隐藏">${CPA_ICONS.eye}</button><button type="button" class="cpa-btn-tool" data-cpa-action="copy-key-val" title="复制 Header 值">${CPA_ICONS.copy}</button></div></div>
          ${button('provider-delete-header', '移除', 'btn btn-secondary btn-sm')}</div>`).join('')}${button('provider-add-header', '添加 Header')}
        ${supportsExcluded ? `<h4>排除模型</h4>${excluded.map((pattern, index) => `<div class="cpa-provider-list-row cpa-provider-list-row-short" data-cpa-excluded-index="${index}"><div class="cpa-field"><label>模型 ID / 通配规则</label><input data-cpa-provider-field="excluded-model" value="${escape(pattern)}"/></div>${button('provider-delete-excluded', '移除', 'btn btn-secondary btn-sm')}</div>`).join('')}${button('provider-add-excluded', '添加排除规则')}` : ''}
      </div>
    </details>`;
  }
  function renderProviderCards() {
    const cards = $('cpa-provider-cards');
    if (!state.expandedProviderKeys) state.expandedProviderKeys = new Set();
    const prevCards = [...cards.querySelectorAll('.cpa-provider-card')];
    const expanded = new Set(prevCards.filter(card => card.querySelector('.cpa-provider-details')?.open).map(card => card.dataset.cpaProviderIndex));
    for (const card of prevCards) {
      const idx = card.dataset.cpaProviderIndex;
      const kd = card.querySelector('.cpa-provider-keys-details');
      if (kd) {
        if (kd.open) state.expandedProviderKeys.add(idx);
        else state.expandedProviderKeys.delete(idx);
      }
    }
    const kind = $('cpa-provider-kind').value;
    if (state.provider !== kind) { cards.textContent = '请先读取此类型的当前配置'; return; }
    if (kind === 'oauth-excluded-models') {
      try {
        const map = JSON.parse($('cpa-provider-json').value);
        if (!map || typeof map !== 'object' || Array.isArray(map)) throw new Error('配置必须是渠道到模型数组的 JSON 对象');
        const channels = Object.entries(map);
        const options = [['codex', 'Codex'], ['antigravity', 'Antigravity'], ['claude', 'Claude'], ['vertex', 'Vertex'], ['aistudio', 'AI Studio'], ['kimi', 'Kimi'], ['xai', 'xAI'], ['meta', 'Meta'], ['openai', 'OpenAI 旧配置']].filter(([value]) => !Object.hasOwn(map, value));
        cards.innerHTML = `${channels.map(([channel, models]) => {
          if (!Array.isArray(models) || models.some(model => typeof model !== 'string')) throw new Error(`${channel} 必须是模型 ID 字符串数组`);
          return `<div class="cpa-provider-card" data-cpa-excluded-channel="${escape(channel)}"><div class="cpa-actions"><h3 style="margin-right:auto">${escape(channel)} · ${models.length} 个排除规则</h3>${button('excluded-delete-channel', '移除渠道', 'btn btn-danger btn-sm')}</div><div class="cpa-field"><label>模型 ID 或通配规则，每行一个</label><textarea data-cpa-excluded-models="${escape(channel)}" spellcheck="false">${escape(models.join('\n'))}</textarea></div></div>`;
        }).join('') || '<p>尚未配置 OAuth 排除模型。</p>'}
          ${options.length ? `<div class="cpa-actions"><select id="cpa-excluded-new-channel" aria-label="新增排除规则渠道">${options.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select>${button('excluded-add-channel', '添加渠道')}</div>` : ''}`;
        if (options.length) setTimeout(() => syncCpaDropdown('cpa-excluded-new-channel'), 0);
      } catch (error) { cards.textContent = `JSON 草稿无效：${error.message}`; }
      return;
    }
    try {
      const items = JSON.parse($('cpa-provider-json').value);
      if (!Array.isArray(items)) throw new Error('配置必须是 JSON 数组');
      cards.innerHTML = items.length ? items.map((item, index) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`第 ${index + 1} 条配置必须是对象`);
        if (kind !== 'openai-compatibility') {
          const fields = ['api-key', 'prefix', 'base-url', 'proxy-url'];
          const commonKinds = ['gemini-api-key', 'codex-api-key', 'claude-api-key', 'vertex-api-key'];
          return `<div class="cpa-provider-card" data-cpa-provider-index="${index}">
            <div class="cpa-provider-header">
              <div class="cpa-provider-title-group">
                <span class="cpa-provider-icon">${CPA_ICONS.key}</span>
                <h3 class="cpa-provider-name">密钥凭据 #${index + 1}${item.prefix ? ` · ${escape(item.prefix)}` : ''}</h3>
                ${item.prefix ? `<span class="cpa-pill-prefix">前缀: ${escape(item.prefix)}</span>` : ''}
              </div>
              <div class="cpa-actions" style="margin:0;">${button('provider-delete-card', '移除密钥', 'btn btn-danger btn-sm')}</div>
            </div>
            <div class="cpa-provider-metrics-bar">
              <div class="cpa-metric-pill" title="已映射模型别名数">${CPA_ICONS.model} <strong>${Array.isArray(item.models) ? item.models.length : 0}</strong> 个模型</div>
              <div class="cpa-metric-pill" title="排除模型数">${CPA_ICONS.ban} <strong>${Array.isArray(item['excluded-models']) ? item['excluded-models'].length : 0}</strong> 个排除</div>
              <div class="cpa-metric-pill" title="自定义 Header 数">${CPA_ICONS.tag} <strong>${item.headers && typeof item.headers === 'object' ? Object.keys(item.headers).length : 0}</strong> 个 Header</div>
              ${item['base-url'] ? `<div class="cpa-metric-pill cpa-metric-url" title="${escape(item['base-url'])}">${CPA_ICONS.globe} <span class="cpa-pill-url-text">${escape(item['base-url'])}</span></div>` : ''}
            </div>
            <div class="cpa-grid">${fields.filter(field => field === 'api-key' || commonKinds.includes(kind) || Object.hasOwn(item, field)).map(field => {
              const labels = { 'api-key': 'API Key', prefix: '模型前缀', 'base-url': '基础地址', 'proxy-url': '代理地址' };
              if (field === 'api-key') {
                return `<div class="cpa-field"><label>${labels[field]}</label>
                  <div class="cpa-input-with-tools">
                    <input type="password" autocomplete="off" data-cpa-provider-field="${field}" value="${escape(item[field] || '')}"/>
                    <button type="button" class="cpa-btn-tool" data-cpa-action="toggle-key-visibility" title="查看明文/隐藏">${CPA_ICONS.eye}</button>
                    <button type="button" class="cpa-btn-tool" data-cpa-action="copy-key-val" title="复制密钥">${CPA_ICONS.copy}</button>
                  </div>
                </div>`;
              }
              return `<div class="cpa-field"><label>${labels[field]}</label><input data-cpa-provider-field="${field}" value="${escape(item[field] || '')}"/></div>`;
            }).join('')}</div>
            ${providerDetails(item, kind)}
          </div>`;
        }
        const keys = Array.isArray(item['api-key-entries']) ? item['api-key-entries'] : [];
        const isKeysOpen = prevCards.length === 0 ? (keys.length <= 1) : (state.expandedProviderKeys.has(String(index)) || keys.length <= 1);
        return `<div class="cpa-provider-card" data-cpa-provider-index="${index}">
          <div class="cpa-provider-header">
            <div class="cpa-provider-title-group">
              <span class="cpa-provider-icon">${CPA_ICONS.server}</span>
              <h3 class="cpa-provider-name">${escape(item.name || `提供商 ${index + 1}`)}</h3>
              <span class="cpa-pill-status ${item.disabled ? 'is-disabled' : 'is-active'}">
                <span class="cpa-status-dot"></span>${item.disabled ? '已暂停' : '活跃中'}
              </span>
              ${item.prefix ? `<span class="cpa-pill-prefix" title="模型路由前缀">前缀: ${escape(item.prefix)}</span>` : ''}
            </div>
            <div class="cpa-actions" style="margin:0;">${button('provider-delete-card', '移除提供商', 'btn btn-danger btn-sm')}</div>
          </div>
          <div class="cpa-provider-metrics-bar">
            <div class="cpa-metric-pill cpa-metric-keys ${keys.length > 0 ? 'highlight' : ''}" title="配置的 API 密钥数">
              ${CPA_ICONS.key} <strong>${keys.length}</strong> 个密钥
            </div>
            <div class="cpa-metric-pill" title="已映射模型别名数">
              ${CPA_ICONS.model} <strong>${Array.isArray(item.models) ? item.models.length : 0}</strong> 个模型
            </div>
            <div class="cpa-metric-pill" title="自定义 HTTP 请求头数">
              ${CPA_ICONS.tag} <strong>${item.headers && typeof item.headers === 'object' ? Object.keys(item.headers).length : 0}</strong> 个 Header
            </div>
            ${item['base-url'] ? `
              <div class="cpa-metric-pill cpa-metric-url" title="${escape(item['base-url'])}">
                ${CPA_ICONS.globe} <span class="cpa-pill-url-text">${escape(item['base-url'])}</span>
              </div>` : ''}
          </div>
          <div class="cpa-grid">
            <div class="cpa-field"><label>提供商名称</label><input data-cpa-provider-field="name" value="${escape(item.name || '')}" placeholder="例如 OpenRouter"/></div>
            <div class="cpa-field"><label>基础地址 (Base URL)</label><input data-cpa-provider-field="base-url" value="${escape(item['base-url'] || '')}" placeholder="https://api.example.com/v1"/></div>
          </div>
          <div class="cpa-grid" style="align-items: center;">
            <div class="cpa-field"><label>模型前缀 (Prefix)</label><input data-cpa-provider-field="prefix" value="${escape(item.prefix || '')}" placeholder="例如 openrouter"/></div>
            <div class="cpa-field cpa-field-checkbox" style="margin-top: 18px;"><label><input type="checkbox" data-cpa-provider-field="disabled" ${item.disabled ? 'checked' : ''}/> 暂停此提供商调度</label></div>
          </div>
          ${typeof item['api-key'] === 'string' && item['api-key'] ? `
            <div class="cpa-field" style="margin: 8px 0;">
              <label style="color:#b25e02; display:flex; align-items:center; gap:5px;">${CPA_ICONS.warn} 旧版 API Key (建议迁移到下方密钥池)</label>
              <div class="cpa-input-with-tools">
                <input type="password" autocomplete="off" data-cpa-provider-field="api-key" value="${escape(item['api-key'])}"/>
                <button type="button" class="cpa-btn-tool" data-cpa-action="toggle-key-visibility" title="查看明文/隐藏">${CPA_ICONS.eye}</button>
                <button type="button" class="cpa-btn-tool" data-cpa-action="copy-key-val" title="复制密钥">${CPA_ICONS.copy}</button>
              </div>
            </div>` : ''}
          <details class="cpa-provider-keys-details" ${isKeysOpen ? 'open' : ''}>
            <summary class="cpa-provider-keys-summary">
              <div class="cpa-keys-summary-left">
                <span class="cpa-keys-icon">${CPA_ICONS.key}</span>
                <strong style="color:#17324d; font-size: 13px;">API 密钥池</strong>
                <span class="cpa-badge ${keys.length > 0 ? 'cpa-badge-cyan' : 'cpa-badge-gray'}">${keys.length} 个密钥</span>
                ${keys.length > 0 ? `
                  <span class="cpa-keys-preview" title="首个密钥脱敏预览">首密钥：<code>${escape(maskKey(keys[0]?.['api-key']))}</code>${keys.length > 1 ? ` · 共 ${keys.length} 个轮询密钥` : ''}</span>
                ` : '<span class="cpa-keys-empty" style="color:var(--text-dim);font-size:12px;">暂未配置密钥</span>'}
              </div>
              <div class="cpa-keys-summary-right">
                <span class="cpa-keys-toggle-hint">${isKeysOpen ? '收起密钥列表' : '展开管理密钥'}</span>
                <span class="cpa-keys-arrow">⌄</span>
              </div>
            </summary>
            <div class="cpa-provider-keys-body">
              ${keys.length ? `
                <div class="cpa-provider-keys-list">
                  ${keys.map((key, keyIndex) => `
                    <div class="cpa-provider-key" data-cpa-key-index="${keyIndex}">
                      <span class="cpa-key-badge" title="轮询序号">#${keyIndex + 1}</span>
                      <div class="cpa-field cpa-field-key">
                        <label>API Key</label>
                        <div class="cpa-input-with-tools">
                          <input type="password" autocomplete="off" data-cpa-provider-field="entry-api-key" value="${escape(key['api-key'] || '')}" placeholder="sk-..."/>
                          <button type="button" class="cpa-btn-tool" data-cpa-action="toggle-key-visibility" title="查看明文/隐藏">${CPA_ICONS.eye}</button>
                          <button type="button" class="cpa-btn-tool" data-cpa-action="copy-key-val" title="复制密钥">${CPA_ICONS.copy}</button>
                        </div>
                      </div>
                      <div class="cpa-field cpa-field-proxy">
                        <label>专属代理地址 (可选)</label>
                        <input data-cpa-provider-field="entry-proxy-url" value="${escape(key['proxy-url'] || '')}" placeholder="留空走全局代理"/>
                      </div>
                      <div class="cpa-key-action">
                        <button type="button" class="btn btn-secondary btn-sm cpa-btn-delete-key" data-cpa-action="provider-delete-key" title="从草稿中移除此密钥">移除</button>
                      </div>
                    </div>
                  `).join('')}
                </div>
              ` : '<p style="color:var(--text-dim);font-size:12px;margin:6px 0;">当前尚未添加任何 API Key，可点击下方按钮添加。</p>'}
              <div class="cpa-actions" style="margin-top: 10px; margin-bottom: 2px;">
                ${button('provider-add-key', '+ 添加新密钥', 'btn btn-secondary btn-sm')}
              </div>
            </div>
          </details>
          ${providerDetails(item, kind)}
        </div>`;
      }).join('') : '<p>此类型尚未配置凭据，可点击下方按钮添加。</p>';
      for (const card of cards.querySelectorAll('.cpa-provider-card')) {
        const details = card.querySelector('.cpa-provider-details');
        if (details && expanded.has(card.dataset.cpaProviderIndex)) details.open = true;
        const keysDetails = card.querySelector('.cpa-provider-keys-details');
        if (keysDetails && (state.expandedProviderKeys.has(card.dataset.cpaProviderIndex) || keysDetails.hasAttribute('open'))) keysDetails.open = true;
      }
    } catch (error) { cards.textContent = `JSON 草稿无效：${error.message}`; }
  }
  function updateProviderDraft(mutator) {
    try {
      const items = JSON.parse($('cpa-provider-json').value);
      if (!Array.isArray(items)) throw new Error('配置必须是 JSON 数组');
      mutator(items);
      $('cpa-provider-json').value = JSON.stringify(items, null, 2);
      renderProviderCards();
      status('cpa-provider-status', '草稿已更新；点击“保存到 CPA”才会生效');
    } catch (error) { status('cpa-provider-status', error.message, 'error'); }
  }
  function updateExcludedDraft(mutator) {
    try {
      const map = JSON.parse($('cpa-provider-json').value);
      if (!map || typeof map !== 'object' || Array.isArray(map)) throw new Error('排除规则必须是 JSON 对象');
      mutator(map);
      $('cpa-provider-json').value = JSON.stringify(map, null, 2);
      renderProviderCards();
      status('cpa-provider-status', '草稿已更新；点击“保存到 CPA”才会生效');
    } catch (error) { status('cpa-provider-status', error.message, 'error'); }
  }
  function refreshProbeKeys() {
    const provider = state.providerItems[Number($('cpa-probe-provider').value)];
    const entries = Array.isArray(provider?.['api-key-entries']) ? provider['api-key-entries'] : [];
    $('cpa-probe-key').innerHTML = entries.length ? entries.map((_, index) => `<option value="${index}">密钥 ${index + 1}</option>`).join('') : '<option value="0">默认凭据</option>';
    syncCpaDropdown('cpa-probe-key');
  }
  function refreshProbeProviders(items) {
    state.providerItems = Array.isArray(items) ? items : [];
    $('cpa-probe-provider').innerHTML = state.providerItems.length ? state.providerItems.map((item, index) => `<option value="${index}">${escape(item.name || `提供商 ${index + 1}`)}</option>`).join('') : '<option value="">暂无提供商</option>';
    syncCpaDropdown('cpa-probe-provider');
    refreshProbeKeys();
  }
  async function loadProvider() {
    const kind = $('cpa-provider-kind').value;
    try {
      const data = extractProviderData(kind, await json(`providers/${kind}`));
      state.provider = kind; state.providerRaw = JSON.stringify(data);
      $('cpa-provider-json').value = JSON.stringify(data, null, 2);
      $('cpa-provider-probe').hidden = kind !== 'openai-compatibility';
      $('cpa-provider-add-row').hidden = kind === 'oauth-excluded-models';
      $('cpa-provider-json-details').open = false;
      renderProviderCards();
      if (kind === 'openai-compatibility') refreshProbeProviders(data);
      status('cpa-provider-status', '已读取 CPA 当前配置', 'success');
    } catch (error) { status('cpa-provider-status', error.message, 'error'); }
  }
  async function probeProvider(operation) {
    if (state.provider !== 'openai-compatibility' || !state.providerItems.length) return status('cpa-probe-status', '请先读取 OpenAI 兼容提供商配置', 'error');
    const index = Number($('cpa-probe-provider').value);
    const key_index = Number($('cpa-probe-key').value);
    const model = $('cpa-probe-model').value.trim();
    try {
      const result = await json('providers/openai-compatibility/probe', 'POST', { index, key_index, operation, ...(operation === 'test' ? { model } : {}) });
      if (operation === 'discover') {
        $('cpa-discovered-models').value = result.models.join('\n');
        if (!model && result.models.length) $('cpa-probe-model').value = result.models[0];
        status('cpa-probe-status', `发现 ${result.models.length} 个模型，可编辑列表后加入 JSON 配置`, 'success');
      } else status('cpa-probe-status', `${result.status_code} · ${result.message}`, result.ok ? 'success' : 'error');
    } catch (error) { status('cpa-probe-status', error.message, 'error'); }
  }
  function importDiscoveredModels() {
    if (state.provider !== 'openai-compatibility') return status('cpa-probe-status', '请先读取 OpenAI 兼容提供商配置', 'error');
    try {
      const items = JSON.parse($('cpa-provider-json').value);
      const index = Number($('cpa-probe-provider').value);
      if (!Array.isArray(items) || !items[index] || typeof items[index] !== 'object') throw new Error('JSON 配置中找不到所选提供商');
      const ids = [...new Set($('cpa-discovered-models').value.split(/\r?\n/).map(id => id.trim()).filter(Boolean))];
      if (!ids.length) throw new Error('请先发现模型');
      const existing = Array.isArray(items[index].models) ? items[index].models : [];
      const known = new Set(existing.map(item => item.name));
      let added = 0;
      for (const id of ids) if (!known.has(id)) { existing.push({ name: id, alias: id }); known.add(id); added++; }
      items[index].models = existing;
      $('cpa-provider-json').value = JSON.stringify(items, null, 2);
      renderProviderCards();
      status('cpa-probe-status', `已将 ${added} 个模型加入编辑区；请检查 JSON 后点击“保存到 CPA”`, 'success');
    } catch (error) { status('cpa-probe-status', error.message, 'error'); }
  }
  async function saveProvider() {
    const kind = $('cpa-provider-kind').value;
    if (kind !== state.provider) return status('cpa-provider-status', '请先读取此类型的当前配置', 'error');
    try {
      const value = JSON.parse($('cpa-provider-json').value);
      if (kind !== 'oauth-excluded-models' && !Array.isArray(value)) throw new Error('该提供商需要 JSON 数组');
      if (kind === 'oauth-excluded-models' && (typeof value !== 'object' || value === null || Array.isArray(value))) throw new Error('模型排除规则需要 JSON 对象');
      const latest = extractProviderData(kind, await json(`providers/${kind}`));
      if (JSON.stringify(latest) !== state.providerRaw) throw new Error('CPA 配置已变化，请重新读取后合并修改');
      if (!confirm(`确定保存 ${kind} 到 CPA 吗？`)) return;
      await json(`providers/${kind}`, 'PUT', value);
      await loadProvider();
      status('cpa-provider-status', '已保存到 CPA', 'success');
    } catch (error) { status('cpa-provider-status', error.message, 'error'); }
  }

  async function loadAliases() {
    const channel = $('cpa-alias-channel').value;
    try {
      const response = await json('oauth-model-alias');
      const map = response['oauth-model-alias'] || response.items || response;
      const aliases = map[channel] || [];
      if (!Array.isArray(aliases)) throw new Error(`${channel} 的模型别名不是数组`);
      state.aliasChannel = channel; state.aliasRaw = JSON.stringify(aliases);
      $('cpa-alias-json').value = JSON.stringify(aliases, null, 2);
      $('cpa-alias-json-details').open = false;
      renderAliasCards();
      status('cpa-alias-status', `已读取 ${channel} 模型别名`, 'success');
    } catch (error) { status('cpa-alias-status', error.message, 'error'); }
  }
  function renderAliasCards() {
    const cards = $('cpa-alias-cards');
    const loaded = state.aliasChannel === $('cpa-alias-channel').value;
    $('cpa-alias-add-row').hidden = !loaded;
    if (!loaded) { cards.textContent = '请先读取此渠道的模型别名'; return; }
    try {
      const aliases = JSON.parse($('cpa-alias-json').value);
      if (!Array.isArray(aliases)) throw new Error('别名配置必须是 JSON 数组');
      cards.innerHTML = aliases.map((item, index) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`第 ${index + 1} 条别名必须是对象`);
        return `<div class="cpa-provider-card" data-cpa-alias-index="${index}">
          <div class="cpa-actions"><h3 style="margin-right:auto">映射 ${index + 1}</h3>${button('alias-delete', '移除映射', 'btn btn-danger btn-sm')}</div>
          <div class="cpa-grid"><div class="cpa-field"><label>上游模型 name</label><input data-cpa-alias-field="name" value="${escape(item.name || '')}"/></div>
          <div class="cpa-field"><label>对外别名 alias</label><input data-cpa-alias-field="alias" value="${escape(item.alias || '')}"/></div></div>
          <div class="cpa-field"><label>显示名称（可选）</label><input data-cpa-alias-field="display-name" value="${escape(item['display-name'] || '')}"/></div>
          <div class="cpa-actions"><label class="cpa-inline-check"><input type="checkbox" data-cpa-alias-field="fork" ${item.fork ? 'checked' : ''}/> 同时保留原模型名</label>
          <label class="cpa-inline-check"><input type="checkbox" data-cpa-alias-field="force-mapping" ${item['force-mapping'] ? 'checked' : ''}/> 强制映射</label></div>
        </div>`;
      }).join('') || '<p>此渠道尚未配置模型别名。</p>';
    } catch (error) { cards.textContent = `JSON 草稿无效：${error.message}`; }
  }
  function updateAliasDraft(mutator) {
    try {
      if (state.aliasChannel !== $('cpa-alias-channel').value) throw new Error('请先读取此渠道的模型别名');
      const aliases = JSON.parse($('cpa-alias-json').value);
      if (!Array.isArray(aliases)) throw new Error('别名配置必须是 JSON 数组');
      mutator(aliases);
      $('cpa-alias-json').value = JSON.stringify(aliases, null, 2);
      renderAliasCards();
      status('cpa-alias-status', '草稿已更新；点击“保存别名”才会生效');
    } catch (error) { status('cpa-alias-status', error.message, 'error'); }
  }
  async function saveAliases() {
    try {
      const channel = $('cpa-alias-channel').value;
      if (state.aliasChannel !== channel) throw new Error('请先读取此渠道的模型别名');
      const aliases = JSON.parse($('cpa-alias-json').value);
      if (!Array.isArray(aliases) || aliases.some(item => !item || typeof item !== 'object' || Array.isArray(item) || typeof item.name !== 'string' || !item.name.trim() || typeof item.alias !== 'string' || !item.alias.trim())) throw new Error('每条模型别名都需要非空的 name 和 alias');
      const response = await json('oauth-model-alias');
      const map = response['oauth-model-alias'] || response.items || response;
      if (JSON.stringify(map[channel] || []) !== state.aliasRaw) throw new Error('CPA 模型别名已变化，请重新读取后合并修改');
      if (!confirm(`确定保存 ${channel} 的模型别名？`)) return;
      await json('oauth-model-alias', 'PATCH', { channel, aliases });
      await loadAliases();
      status('cpa-alias-status', '模型别名已保存', 'success');
    } catch (error) { status('cpa-alias-status', error.message, 'error'); }
  }

  async function loadYaml() {
    try {
      const response = await request('config-yaml');
      state.yaml = await response.text(); state.yamlEtag = response.headers.get('etag') || '';
      $('cpa-yaml-editor').value = state.yaml;
      $('cpa-yaml-diff').hidden = true;
      status('cpa-yaml-status', '已读取 CPA 配置', 'success');
    } catch (error) { status('cpa-yaml-status', error.message, 'error'); }
  }
  function previewYaml() {
    const oldLines = state.yaml.split('\n');
    const newLines = $('cpa-yaml-editor').value.split('\n');
    const changes = [];
    for (let i = 0; i < Math.max(oldLines.length, newLines.length); i++) {
      if (oldLines[i] === newLines[i]) continue;
      changes.push(`第 ${i + 1} 行\n- ${oldLines[i] ?? ''}\n+ ${newLines[i] ?? ''}`);
      if (changes.length >= 80) { changes.push('…仅显示前 80 处差异'); break; }
    }
    $('cpa-yaml-diff').textContent = changes.join('\n') || '无改动';
    $('cpa-yaml-diff').hidden = false;
    return changes.length;
  }
  async function saveYaml() {
    if (!state.yamlEtag) return status('cpa-yaml-status', '请先读取配置', 'error');
    if (!previewYaml()) return status('cpa-yaml-status', '没有需要保存的改动');
    if (!confirm('【高危操作警告】\n\n您正在全量覆盖 CPA 生产配置 (config.yaml)！\n此操作将整体替换全部 49 项网关配置，手滑可能导致所有上游服务不可用。\n\n请确认您已知晓风险并确定继续保存？')) return;
    try {
      const response = await request('config-yaml', { method: 'PUT', headers: { 'Content-Type': 'application/yaml', 'If-Match': state.yamlEtag }, body: $('cpa-yaml-editor').value });
      await response.json(); await loadYaml();
      status('cpa-yaml-status', 'YAML 已保存并由 CPA 验证', 'success');
    } catch (error) { status('cpa-yaml-status', error.message, 'error'); }
  }

  async function loadSettings() {
    const results = await Promise.allSettled(settings.map(async ([key, , type]) => {
      const data = await json(`settings/${key}`);
      const row = [...document.querySelectorAll('[data-cpa-setting]')].find(node => node.dataset.cpaSetting === key);
      const input = row?.querySelector('.cpa-setting-value');
      const rawVal = data[key.split('/').at(-1)] ?? data.value ?? '';
      if (input) {
        if (type === 'boolean') {
          const isChecked = rawVal === true || String(rawVal) === 'true';
          input.checked = isChecked;
          const textEl = row.querySelector('.cpa-toggle-state-text');
          if (textEl) textEl.textContent = isChecked ? '开启' : '关闭';
        } else {
          input.value = String(rawVal);
        }
      }
    }));
    const failures = results.filter(result => result.status === 'rejected');
    status('cpa-settings-status', failures.length ? `${failures.length} 项读取失败：${failures[0].reason.message}` : '常用设置已同步', failures.length ? 'error' : 'success');
  }

  async function loadModelKeys() {
    try {
      const response = await fetch('/admin/api/keys', { headers: getAuthHeaders() });
      if (!response.ok) throw new Error(`读取 Key 失败：HTTP ${response.status}`);
      const data = await response.json();
      const keys = Array.isArray(data.keys) ? data.keys : [];
      const selector = $('cpa-model-key');
      if (selector) {
        const prevValue = selector.value;
        selector.replaceChildren(...keys.map(key => {
          const option = document.createElement('option');
          option.value = key.api_key;
          option.textContent = `${key.key_alias || key.display_key} · ${key.display_key}`;
          return option;
        }));
        if (keys.length > 0) {
          if (prevValue && keys.some(k => k.api_key === prevValue)) {
            selector.value = prevValue;
          } else {
            selector.value = keys[0].api_key;
          }
          syncCpaDropdown('cpa-model-key');
        } else {
          syncCpaDropdown('cpa-model-key', [{ value: '', label: '暂无可用 API Key' }]);
        }
      }
      status('cpa-model-status', keys.length ? `可选择 ${keys.length} 个 Key` : '请先创建 API Key', keys.length ? 'success' : '');
      if (keys.length > 0) {
        await loadModels();
      }
    } catch (error) { status('cpa-model-status', error.message, 'error'); }
  }
  function renderKeyModels() {
    const query = ($('cpa-key-models-search')?.value || '').trim().toLowerCase();
    const allModels = state.keyModels || [];
    const filtered = query
      ? allModels.filter(m => String(m.id || '').toLowerCase().includes(query) || String(m.owned_by || '').toLowerCase().includes(query))
      : allModels;

    const countEl = $('cpa-key-models-count');
    if (countEl) {
      countEl.textContent = query
        ? `显示 ${filtered.length} / ${allModels.length} 个模型`
        : `共 ${allModels.length} 个可用模型`;
    }

    const tbody = $('cpa-model-rows');
    if (!tbody) return;

    if (!allModels.length) {
      tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;padding:24px;color:#6b8194;">此 Key 暂无可用模型</td></tr>';
      return;
    }

    if (!filtered.length) {
      tbody.innerHTML = `<tr><td colspan="3" style="text-align:center;padding:24px;color:#6b8194;">无匹配模型（关键词："${escape(query)}"）</td></tr>`;
      return;
    }

    tbody.innerHTML = filtered.map(model => {
      const id = escape(model.id);
      const provider = escape(model.owned_by || 'upstream');
      return `<tr>
        <td>
          <div style="display:flex;align-items:center;gap:8px;">
            <code style="font-family:var(--mono, monospace);font-size:12.5px;color:#19334c;font-weight:600;">${id}</code>
            <button class="btn btn-secondary btn-sm" type="button" data-cpa-action="copy-model-id" data-model="${id}" style="min-height:24px;padding:1px 6px;font-size:11px;" title="复制模型 ID">复制</button>
          </div>
        </td>
        <td><span class="cpa-badge">${provider}</span></td>
        <td style="text-align:right;">
          <button class="btn btn-secondary btn-sm" type="button" data-cpa-action="test-in-probe" data-model="${id}" style="min-height:26px;padding:2px 8px;font-size:11.5px;">探针测试 ↗</button>
        </td>
      </tr>`;
    }).join('');
  }

  async function loadModels() {
    const key = $('cpa-model-key')?.value;
    if (!key) return status('cpa-model-status', '请先选择 API Key', 'error');
    status('cpa-model-status', '正在检索模型列表...', '');
    try {
      const response = await fetch('/v1/models', { headers: { Authorization: `Bearer ${key}` } });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || `HTTP ${response.status}`);
      state.keyModels = Array.isArray(data.data) ? data.data : [];
      renderKeyModels();
      status('cpa-model-status', `返回 ${state.keyModels.length} 个模型`, 'success');
    } catch (error) {
      status('cpa-model-status', error.message, 'error');
    }
  }
  async function saveSetting(row) {
    const key = row.dataset.cpaSetting;
    const input = row.querySelector('.cpa-setting-value');
    const type = settings.find(item => item[0] === key)?.[2];
    const value = type === 'boolean' ? input.checked : type === 'number' ? Number(input.value) : input.value.trim();
    if (type === 'number' && (!Number.isFinite(value) || value < 0)) return status('cpa-settings-status', '请输入非负数字', 'error');
    try { await json(`settings/${key}`, 'PATCH', { value }); status('cpa-settings-status', `${key} 已保存`, 'success'); }
    catch (error) { status('cpa-settings-status', error.message, 'error'); }
  }

  // after 是 CPA 的秒级时间戳游标，绝不能传 0——那等于请求「从 1970 年到现在」
  // 的全部日志。生产 CPA 日志已积累 320MB（31 个轮转文件 311M + 当前 main.log
  // 2.9M），全量请求会被 Gate 的 8MB 上限拦掉。
  // 超上限时 Gate 侧不再整体失败，而是保留已收到的部分并把 truncated 置真，
  // 所以这里必须显式告知用户看到的是残缺数据，不能让人以为这就是全部。
  // 返回本次新增行数，失败返回 null，供分档加载判断要不要覆盖状态文案。
  async function loadLogs() {
    try {
      const data = await json(`logs?after=${state.logAfter}`);
      const lines = Array.isArray(data.lines) ? data.lines : [];
      state.logLines.push(...lines);
      state.logTruncated = data.truncated === true;
      // 上限对齐最大档位：24 小时档实测 42314 行，旧的 3000 行上限会把大部分
      // 数据静默丢掉，用户点「最近 24 小时」却只看到一小截，筛选也在残片上做。
      if (state.logLines.length > LOG_LINES_LIMIT) state.logLines.splice(0, state.logLines.length - LOG_LINES_LIMIT);
      renderLogs();
      state.logAfter = Number(data['latest-timestamp']) || state.logAfter;
      status('cpa-logs-status', `本次新增 ${lines.length} 行`, 'success');
      return lines.length;
    } catch (error) { status('cpa-logs-status', error.message, 'error'); return null; }
  }
  // 按小时分档加载。重置游标到「N 小时前」而不是 0，既不丢历史也不炸请求。
  async function loadLogsRange(hours) {
    const safeHours = [1, 6, 24].includes(Number(hours)) ? Number(hours) : 1;
    state.logRangeHours = safeHours;
    state.logAfter = Math.floor(Date.now() / 1000) - safeHours * 3600;
    state.logLines = [];
    state.logTruncated = false;
    const added = await loadLogs();
    if (added !== null) {
      status(
        'cpa-logs-status',
        state.logTruncated
          ? `已加载最近 ${safeHours} 小时日志，共 ${state.logLines.length} 行。注意：CPA 在该时间范围内日志过多，响应已达 8MB 上限被截断，更早的部分未加载——请改选更短的时间范围。`
          : `已加载最近 ${safeHours} 小时日志，共 ${state.logLines.length} 行`,
        state.logTruncated ? 'error' : 'success'
      );
    }
  }
  function renderLogs() {
    const query = $('cpa-log-filter').value.toLowerCase();
    const visible = state.logLines.filter(line => (!query || String(line).toLowerCase().includes(query)) && (!$('cpa-hide-management').checked || !String(line).includes('/v0/management/')));
    const view = $('cpa-log-view');
    // 24 小时档实测 42314 行，一次性 join 成 6MB 文本再塞进 <pre> 会明显卡顿。
    // 改为只渲染末尾 LOG_RENDER_LIMIT 行，其余靠「显示更多」逐段追加，
    // 既保住全量筛选能力（筛选在完整数组上进行），又不让 DOM 爆炸。
    const shown = visible.slice(Math.max(0, visible.length - state.logRenderLimit));
    view.textContent = shown.join('\n') || '暂无日志';
    const hidden = visible.length - shown.length;
    const more = $('cpa-logs-more');
    if (more) {
      if (hidden > 0) {
        more.hidden = false;
        more.textContent = `仅显示最近 ${shown.length} 行，另有 ${hidden} 行未渲染，点击显示更多`;
      } else {
        more.hidden = true;
        more.textContent = '';
      }
    }
    // 截断提示必须常驻：用户一筛选一滚动就看不到加载时那句状态栏了，
    // 会把残缺数据当成该时间范围的全部日志。
    const banner = $('cpa-logs-truncated');
    if (banner) {
      banner.hidden = !state.logTruncated;
      if (state.logTruncated) {
        banner.textContent = `本次加载已被 8MB 响应上限截断，共收到 ${state.logLines.length} 行，更早的日志未加载。请改选更短的时间范围查看完整内容。`;
      }
    }
    view.scrollTop = view.scrollHeight;
  }
  async function loadErrorFiles() {
    try {
      const data = await json('request-error-logs');
      const files = Array.isArray(data.files) ? data.files : [];
      $('cpa-error-files').innerHTML = files.length ? files.map(file => `
        <div class="cpa-setting-row" style="align-items:center;">
          <span style="font-family:var(--mono);word-break:break-all;"><strong>${escape(file.name)}</strong> · ${escape(file.size)} 字节</span>
          <span style="color:var(--text-dim);font-size:12px;">${file.modified ? new Date(Number(file.modified) * 1000).toLocaleString() : ''}</span>
          <div class="cpa-actions" style="margin:0;">
            <button class="btn btn-primary btn-sm" data-cpa-action="error-preview" data-name="${escape(file.name)}" data-size="${escape(file.size)}" data-modified="${escape(file.modified || '')}">在线查看</button>
            <button class="btn btn-secondary btn-sm" data-cpa-action="error-download" data-name="${escape(file.name)}">下载</button>
          </div>
        </div>`).join('') : '暂无请求错误文件';
    } catch (error) { $('cpa-error-files').textContent = error.message; }
  }

  async function previewErrorLog(name, size, modified) {
    if (!name) return;
    state.viewingErrorName = name;
    const viewer = $('cpa-error-viewer');
    const title = $('cpa-error-viewer-title');
    const meta = $('cpa-error-viewer-meta');
    const content = $('cpa-error-viewer-content');
    if (!viewer) return;

    title.textContent = name;
    meta.textContent = `${size ? `${size} 字节` : ''}${modified ? ` · 修改时间：${new Date(Number(modified) * 1000).toLocaleString()}` : ''}`;
    content.textContent = '正在读取错误日志上下文...';
    viewer.hidden = false;
    viewer.scrollIntoView({ block: 'nearest' });

    try {
      const response = await fetch(`/admin/api/cpa/request-error-logs/preview?name=${encodeURIComponent(name)}`, {
        headers: getAuthHeaders()
      });
      if (response.status === 413) {
        content.textContent = '该日志文件大小超过 2 MiB 预览上限，请使用上方“下载原文件”进行离线排查。';
        showToast('日志文件超过 2MB 预览上限，请下载查看', 'error');
        return;
      }
      if (!response.ok) {
        const errJson = await response.json().catch(() => ({}));
        throw new Error(errJson.error || `HTTP ${response.status}`);
      }
      const text = await response.text();
      content.textContent = text || '日志内容为空';
    } catch (error) {
      content.textContent = `加载日志失败：${error.message}`;
      showToast(`加载错误日志失败：${error.message}`, 'error');
    }
  }

  // --- 全局模型别名 (Global Model Aliases) ---
  async function loadGlobalAliases() {
    try {
      const data = await json('global-model-aliases');
      state.globalAliases = Array.isArray(data.aliases) ? data.aliases : [];
      state.globalAliasesRaw = JSON.stringify(state.globalAliases);
      renderGlobalAliases();
      status('cpa-global-alias-status', `已加载 ${state.globalAliases.length} 条全局别名`, 'success');
    } catch (err) {
      status('cpa-global-alias-status', err.message, 'error');
    }
  }

  function renderGlobalAliases() {
    const container = $('cpa-global-alias-cards');
    if (!container) return;
    if (!state.globalAliases.length) {
      container.innerHTML = '<p style="color:var(--text-dim);font-size:13px;">暂未配置全局模型别名（点击"新增别名行"添加）。</p>';
      return;
    }
    container.innerHTML = state.globalAliases.map((item, idx) => `
      <div class="cpa-provider-card" data-global-alias-index="${idx}">
        <div class="cpa-actions" style="margin-bottom:8px;">
          <strong style="margin-right:auto;font-size:13px;">映射规则 #${idx + 1}</strong>
          <button class="btn btn-danger btn-sm" type="button" data-cpa-action="global-alias-delete" data-index="${idx}">删除行</button>
        </div>
        <div class="cpa-grid">
          <div class="cpa-field">
            <label>客户端请求别名 (From)</label>
            <input type="text" data-alias-field="from" value="${escape(item.from || '')}" placeholder="例如 gpt-4o 或 claude-3-5-sonnet"/>
          </div>
          <div class="cpa-field">
            <label>上游实际模型 (To)</label>
            <input type="text" data-alias-field="to" value="${escape(item.to || '')}" placeholder="例如 gemini-2.5-flash 或 claude-3-7-sonnet"/>
          </div>
        </div>
      </div>
    `).join('');
  }

  function collectGlobalAliasesFromUI() {
    const cards = document.querySelectorAll('[data-global-alias-index]');
    const list = [];
    cards.forEach(card => {
      const from = card.querySelector('[data-alias-field="from"]')?.value?.trim() || '';
      const to = card.querySelector('[data-alias-field="to"]')?.value?.trim() || '';
      if (from || to) list.push({ from, to });
    });
    state.globalAliases = list;
  }

  function addGlobalAliasRow() {
    collectGlobalAliasesFromUI();
    state.globalAliases.push({ from: '', to: '' });
    renderGlobalAliases();
  }

  async function saveGlobalAliases() {
    collectGlobalAliasesFromUI();
    try {
      await json('global-model-aliases', 'POST', { aliases: state.globalAliases });
      status('cpa-global-alias-status', '全局模型别名映射已成功保存', 'success');
      showToast('全局模型别名映射已保存', 'success');
      await loadGlobalAliases();
    } catch (err) {
      status('cpa-global-alias-status', `保存失败：${err.message}`, 'error');
      showToast(`保存别名失败：${err.message}`, 'error');
    }
  }

  // --- 路由策略与会话粘性 (Routing Strategy & Affinity) ---
  async function loadRoutingConfig() {
    try {
      let data;
      try {
        data = await json('runtime-config');
      } catch {
        const res = await fetch('/admin/api/runtime-config', { headers: getAuthHeaders() });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        data = await res.json();
      }
      const routing = data.routing?.value || data.routing || {};
      if ($('cpa-routing-strategy')) {
        $('cpa-routing-strategy').value = routing.strategy || 'round-robin';
        syncCpaDropdown('cpa-routing-strategy');
      }
      if ($('cpa-routing-affinity')) {
        $('cpa-routing-affinity').checked = routing.session_affinity === true;
      }
      if ($('cpa-routing-ttl')) {
        $('cpa-routing-ttl').value = routing.session_affinity_ttl ?? '';
      }
      status('cpa-routing-status', '路由配置已加载', 'success');
    } catch (err) {
      status('cpa-routing-status', `读取路由失败：${err.message}`, 'error');
    }
  }

  async function saveRoutingConfig() {
    try {
      const strategy = $('cpa-routing-strategy')?.value || 'round-robin';
      const session_affinity = Boolean($('cpa-routing-affinity')?.checked);
      const session_affinity_ttl = $('cpa-routing-ttl')?.value?.trim() || '';
      const payload = { strategy, session_affinity, session_affinity_ttl };

      const res = await fetch('/admin/api/upstream-routing', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      status('cpa-routing-status', '路由调度策略已成功更新', 'success');
      showToast('路由调度策略已保存', 'success');
      await loadRoutingConfig();
    } catch (err) {
      status('cpa-routing-status', `保存失败：${err.message}`, 'error');
      showToast(`保存路由策略失败：${err.message}`, 'error');
    }
  }

  const loaded = new Set();
  async function loadPage(id) {
    if (loaded.has(id)) return;
    loaded.add(id);
    if (id === 'cpa-auth') await loadAuthFiles();
    if (id === 'cpa-providers') await Promise.all([loadProvider(), loadGlobalAliases()]);
    if (id === 'cpa-config') await Promise.all([loadYaml(), loadSettings(), loadRoutingConfig(), loadModelKeys()]);
    if (id === 'cpa-logs') await Promise.all([loadLogsRange(state.logRangeHours), loadErrorFiles()]);
  }

  document.addEventListener('click', async event => {
    const navButton = event.target.closest('[data-cpa-nav]');
    if (navButton) {
      if (isMemberAuth()) return;
      switchNavTab(navButton.dataset.cpaNav);
      loadPage(navButton.dataset.cpaNav);
      return;
    }
    const editorTabBtn = event.target.closest('.cpa-editor-tab-btn');
    if (editorTabBtn && editorTabBtn.dataset.editorTab) {
      switchEditorTab(editorTabBtn.dataset.editorTab);
      return;
    }
    const providerTabBtn = event.target.closest('.cpa-provider-tab-btn');
    if (providerTabBtn && providerTabBtn.dataset.cpaProviderTab) {
      const targetId = providerTabBtn.dataset.cpaProviderTab;
      document.querySelectorAll('.cpa-provider-tab-btn').forEach(btn => btn.classList.toggle('active', btn === providerTabBtn));
      ['section-cpa-providers-config', 'cpa-provider-probe', 'section-cpa-providers-alias', 'section-cpa-providers-global-alias'].forEach(secId => {
        const sec = $(secId);
        if (sec) sec.hidden = secId !== targetId;
      });
      return;
    }
    const control = event.target.closest('[data-cpa-action]');
    if (!control) return;
    const action = control.dataset.cpaAction;
    control.disabled = true;
    try {
      if (action === 'auth-refresh') await loadAuthFiles();
      else if (action === 'auth-prev-page') { state.authPage--; renderAuthFiles(); }
      else if (action === 'auth-next-page') { state.authPage++; renderAuthFiles(); }
      else if (action === 'auth-upload') await uploadAuthFile();
      else if (action === 'auth-delete-selected') await deleteSelectedAuthFiles();
      else if (action === 'auth-batch-enable') await batchSelectedAuthFiles('enable');
      else if (action === 'auth-batch-disable') await batchSelectedAuthFiles('disable');
      else if (action === 'auth-batch-priority') await batchSetPriority();
      else if (action === 'auth-batch-reset-cooldown') await batchSelectedAuthFiles('reset-cooldown');
      else if (action === 'auth-batch-dismiss') { const r = $('cpa-auth-batch-report'); if (r) r.hidden = true; }
      else if (action === 'auth-batch-retry') await retryFailedBatch();
      else if (action === 'auth-models') await showAuthModels(control.dataset.name);
      else if (action === 'auth-toggle') await toggleAuthFile(control.dataset.name, control.dataset.disabled === 'true');
      else if (action === 'provider-quota') await showProviderQuota(control.dataset.index);
      else if (action === 'auth-edit') editAuthFields(control.dataset.name);
      else if (action === 'auth-editor-close') { $('cpa-auth-editor').hidden = true; state.editingAuthName = null; }
      else if (action === 'auth-add-excluded-chip') {
        const input = $('cpa-edit-excluded-input');
        const val = input ? input.value.trim() : '';
        if (val) {
          if (!state.editingAuthExcluded.includes(val)) {
            state.editingAuthExcluded.push(val);
            renderExcludedChips();
          }
          input.value = '';
          input.focus();
        }
      }
      else if (action === 'auth-delete-excluded-chip') {
        const idx = Number(control.dataset.index);
        if (!Number.isNaN(idx)) {
          state.editingAuthExcluded.splice(idx, 1);
          renderExcludedChips();
        }
      }
      else if (action === 'auth-add-header-row') {
        // 先收集当前 table 中的数据
        collectVisualFields();
        state.editingAuthHeaders.push({ key: '', value: '' });
        renderHeadersTable();
        const rows = document.querySelectorAll('.cpa-kv-row');
        const lastRow = rows[rows.length - 1];
        lastRow?.querySelector('[data-header-field="key"]')?.focus();
      }
      else if (action === 'auth-delete-header-row') {
        collectVisualFields();
        const idx = Number(control.dataset.index);
        if (!Number.isNaN(idx)) {
          state.editingAuthHeaders.splice(idx, 1);
          renderHeadersTable();
        }
      }
      else if (action === 'auth-fields-save') await saveAuthFields();
      else if (action === 'credential-refresh') { await json('auth-files/refresh', 'POST', { name: control.dataset.name, auth_index: control.dataset.index }); await loadAuthFiles(); status('cpa-auth-status', '已请求 CPA 刷新凭据', 'success'); }
      else if (action === 'auth-delete' && confirm(`确定从 CPA 删除 ${control.dataset.name}？`)) { await json(`auth-files?name=${encodeURIComponent(control.dataset.name)}`, 'DELETE'); await loadAuthFiles(); }
      else if (action === 'auth-download') await download(`auth-files/download?name=${encodeURIComponent(control.dataset.name)}`, control.dataset.name);
      else if (action === 'quota-reset' && confirm('重置此凭据的 CPA 冷却状态？')) { await json('reset-quota', 'POST', { auth_index: control.dataset.index }); await loadAuthFiles(); }
      else if (action === 'oauth-start') await startOAuth();
      else if (action === 'oauth-copy') await copyOAuthLink();
      else if (action === 'oauth-cancel') await cancelOAuth();
      else if (action === 'vertex-import') await importVertex();
      else if (action === 'oauth-callback') await submitOAuthCallback();
      else if (action === 'provider-load') await loadProvider();
      else if (action === 'provider-save') await saveProvider();
      else if (action === 'provider-discover') await probeProvider('discover');
      else if (action === 'provider-test') await probeProvider('test');
      else if (action === 'provider-import-models') importDiscoveredModels();
      else if (action === 'toggle-key-visibility') {
        const wrapper = control.closest('.cpa-input-with-tools');
        const input = wrapper?.querySelector('input');
        if (input) {
          const isPass = input.type === 'password';
          input.type = isPass ? 'text' : 'password';
          control.innerHTML = isPass ? CPA_ICONS.eyeOff : CPA_ICONS.eye;
          control.title = isPass ? '隐藏明文' : '查看明文';
        }
      }
      else if (action === 'copy-key-val') {
        const wrapper = control.closest('.cpa-input-with-tools');
        const input = wrapper?.querySelector('input');
        if (input && input.value) {
          if (typeof copyToClipboard === 'function') {
            copyToClipboard(input.value, '已复制到剪贴板');
          } else if (navigator.clipboard) {
            await navigator.clipboard.writeText(input.value).catch(() => {});
            showToast('已复制到剪贴板', 'success');
          }
        }
      }
      else if (action === 'provider-add-card') updateProviderDraft(items => items.push($('cpa-provider-kind').value === 'openai-compatibility' ? { name: '', 'base-url': '', 'api-key-entries': [], models: [] } : { 'api-key': '' }));
      else if (action === 'provider-delete-card' && confirm('确定从草稿中移除此提供商？')) updateProviderDraft(items => items.splice(Number(control.closest('[data-cpa-provider-index]').dataset.cpaProviderIndex), 1));
      else if (action === 'provider-add-key') {
        const cardIndex = control.closest('[data-cpa-provider-index]')?.dataset.cpaProviderIndex;
        if (cardIndex !== undefined) {
          if (!state.expandedProviderKeys) state.expandedProviderKeys = new Set();
          state.expandedProviderKeys.add(String(cardIndex));
        }
        updateProviderDraft(items => {
          const item = items[Number(cardIndex)];
          if (!Array.isArray(item['api-key-entries'])) item['api-key-entries'] = [];
          item['api-key-entries'].push({ 'api-key': '' });
        });
      }
      else if (action === 'provider-delete-key' && confirm('确定从草稿中移除此密钥？')) updateProviderDraft(items => items[Number(control.closest('[data-cpa-provider-index]').dataset.cpaProviderIndex)]['api-key-entries'].splice(Number(control.closest('[data-cpa-key-index]').dataset.cpaKeyIndex), 1));
      else if (action === 'provider-add-model') updateProviderDraft(items => { const item = items[Number(control.closest('[data-cpa-provider-index]').dataset.cpaProviderIndex)]; if (!Array.isArray(item.models)) item.models = []; item.models.push({ name: '', alias: '' }); });
      else if (action === 'provider-delete-model') updateProviderDraft(items => items[Number(control.closest('[data-cpa-provider-index]').dataset.cpaProviderIndex)].models.splice(Number(control.closest('[data-cpa-model-index]').dataset.cpaModelIndex), 1));
      else if (action === 'provider-add-header') updateProviderDraft(items => { const item = items[Number(control.closest('[data-cpa-provider-index]').dataset.cpaProviderIndex)]; if (!item.headers || typeof item.headers !== 'object') item.headers = {}; let name = 'X-New-Header', number = 2; while (Object.hasOwn(item.headers, name)) name = `X-New-Header-${number++}`; item.headers[name] = ''; });
      else if (action === 'provider-delete-header') updateProviderDraft(items => { const item = items[Number(control.closest('[data-cpa-provider-index]').dataset.cpaProviderIndex)]; delete item.headers[Object.keys(item.headers)[Number(control.closest('[data-cpa-header-index]').dataset.cpaHeaderIndex)]]; });
      else if (action === 'provider-add-excluded') updateProviderDraft(items => { const item = items[Number(control.closest('[data-cpa-provider-index]').dataset.cpaProviderIndex)]; if (!Array.isArray(item['excluded-models'])) item['excluded-models'] = []; item['excluded-models'].push(''); });
      else if (action === 'provider-delete-excluded') updateProviderDraft(items => items[Number(control.closest('[data-cpa-provider-index]').dataset.cpaProviderIndex)]['excluded-models'].splice(Number(control.closest('[data-cpa-excluded-index]').dataset.cpaExcludedIndex), 1));
      else if (action === 'excluded-add-channel') updateExcludedDraft(map => { const channel = $('cpa-excluded-new-channel').value; if (!channel || Object.hasOwn(map, channel)) throw new Error('请选择尚未配置的渠道'); map[channel] = []; });
      else if (action === 'excluded-delete-channel' && confirm('确定从草稿中移除此渠道的所有排除规则？')) updateExcludedDraft(map => { delete map[control.closest('[data-cpa-excluded-channel]').dataset.cpaExcludedChannel]; });
      else if (action === 'alias-load') await loadAliases();
      else if (action === 'alias-save') await saveAliases();
      else if (action === 'alias-add') updateAliasDraft(aliases => aliases.push({ name: '', alias: '' }));
      else if (action === 'alias-delete') updateAliasDraft(aliases => aliases.splice(Number(control.closest('[data-cpa-alias-index]').dataset.cpaAliasIndex), 1));
      else if (action === 'yaml-load') await loadYaml();
      else if (action === 'yaml-preview') previewYaml();
      else if (action === 'yaml-save') await saveYaml();
      else if (action === 'settings-load') await loadSettings();
      else if (action === 'models-load-keys') await loadModelKeys();
      else if (action === 'models-load') await loadModels();
      else if (action === 'copy-model-id') {
        const id = control.dataset.model;
        if (id) {
          if (typeof copyToClipboard === 'function') {
            copyToClipboard(id, `模型 ID ${id} 已复制`);
          } else if (navigator.clipboard) {
            await navigator.clipboard.writeText(id).catch(() => {});
            showToast(`模型 ID ${id} 已复制`, 'success');
          }
        }
      }
      else if (action === 'version-check') { const version = await json('latest-version'); status('cpa-version-status', JSON.stringify(version), 'success'); }
      else if (action === 'setting-save') await saveSetting(control.closest('[data-cpa-setting]'));
      else if (action === 'logs-refresh') await loadLogs();
      else if (action === 'logs-load-1h') await loadLogsRange(1);
      else if (action === 'logs-load-6h') await loadLogsRange(6);
      else if (action === 'logs-load-24h') await loadLogsRange(24);
      else if (action === 'logs-more') { state.logRenderLimit += LOG_RENDER_LIMIT; renderLogs(); }
      // 清空后同样不能用 0 重置游标：CPA 日志文件可能仍在，传 0 会再次请求全量。
      else if (action === 'logs-clear' && confirm('确定清空 CPA 服务日志？')) { await json('logs', 'DELETE'); state.logAfter = Math.floor(Date.now() / 1000) - state.logRangeHours * 3600; state.logLines = []; state.logTruncated = false; await loadLogs(); }
      else if (action === 'error-logs-refresh') await loadErrorFiles();
      else if (action === 'error-preview') await previewErrorLog(control.dataset.name, control.dataset.size, control.dataset.modified);
      else if (action === 'error-viewer-close') { const v = $('cpa-error-viewer'); if (v) v.hidden = true; state.viewingErrorName = ''; }
      else if (action === 'error-viewer-copy') {
        const text = $('cpa-error-viewer-content')?.textContent;
        if (text) {
          if (typeof copyToClipboard === 'function') {
            copyToClipboard(text, '日志内容已成功复制到剪贴板');
          } else if (navigator.clipboard) {
            await navigator.clipboard.writeText(text).catch(() => {});
            showToast('日志内容已成功复制到剪贴板', 'success');
          }
        }
      }
      else if (action === 'error-viewer-download') {
        if (state.viewingErrorName) await download(`request-error-logs/download?name=${encodeURIComponent(state.viewingErrorName)}`, state.viewingErrorName);
      }
      else if (action === 'error-download') await download(`request-error-logs/download?name=${encodeURIComponent(control.dataset.name)}`, control.dataset.name);
      else if (action === 'oauth-copy-code') {
        const val = $('cpa-oauth-device-code-val')?.textContent;
        if (val) {
          if (typeof copyToClipboard === 'function') {
            copyToClipboard(val, `设备验证码 ${val} 已复制`);
          } else if (navigator.clipboard) {
            await navigator.clipboard.writeText(val).catch(() => {});
            showToast(`设备验证码 ${val} 已复制`, 'success');
          }
        }
      }
      else if (action === 'cooldown-reset-all') await resetAllCooldowns();
      else if (action === 'cooldown-reset-one') await resetOneCooldown(control.dataset.index, control.dataset.name);
      else if (action === 'cooldown-refresh') await loadCooldowns();
      else if (action === 'auth-refresh-all') await refreshAllCredentials();
      else if (action === 'global-alias-load') await loadGlobalAliases();
      else if (action === 'global-alias-save') await saveGlobalAliases();
      else if (action === 'global-alias-add') addGlobalAliasRow();
      else if (action === 'global-alias-delete') {
        const idx = Number(control.dataset.index);
        if (!Number.isNaN(idx)) {
          collectGlobalAliasesFromUI();
          state.globalAliases.splice(idx, 1);
          renderGlobalAliases();
        }
      }
      else if (action === 'routing-load') await loadRoutingConfig();
      else if (action === 'routing-save') await saveRoutingConfig();
    } catch (error) { showToast(`CPA 操作失败：${error.message}`, 'error'); }
    finally { control.disabled = false; }
  });

  $('cpa-log-filter').addEventListener('input', renderLogs);
  $('cpa-hide-management').addEventListener('change', renderLogs);
  $('cpa-auth-search').addEventListener('input', () => { state.authPage = 1; renderAuthFiles(); });
  $('cpa-edit-excluded-input')?.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      const val = event.target.value.trim();
      if (val) {
        if (!state.editingAuthExcluded.includes(val)) {
          state.editingAuthExcluded.push(val);
          renderExcludedChips();
        }
        event.target.value = '';
      }
    }
  });
  $('cpa-settings-rows').addEventListener('change', event => {
    const toggle = event.target.closest('.cpa-toggle-input');
    if (!toggle) return;
    const textEl = toggle.closest('.cpa-setting-row')?.querySelector('.cpa-toggle-state-text');
    if (textEl) textEl.textContent = toggle.checked ? '开启' : '关闭';
  });
  $('cpa-probe-provider').addEventListener('change', refreshProbeKeys);
  $('cpa-provider-kind').addEventListener('change', () => {
    const kind = $('cpa-provider-kind').value;
    const openai = kind === 'openai-compatibility';
    $('cpa-provider-probe').hidden = !openai;
    $('cpa-provider-add-row').hidden = kind === 'oauth-excluded-models' || state.provider !== kind;
    $('cpa-provider-json-details').open = false;
    renderProviderCards();
  });
  $('cpa-provider-cards').addEventListener('change', event => {
    const excluded = event.target.closest('[data-cpa-excluded-models]');
    if (excluded) {
      updateExcludedDraft(map => {
        const channel = excluded.dataset.cpaExcludedModels;
        if (!Object.hasOwn(map, channel)) throw new Error('该渠道不存在，请重新读取');
        map[channel] = [...new Set(excluded.value.split(/\r?\n/).map(model => model.trim()).filter(Boolean))];
      });
      return;
    }
    const input = event.target.closest('[data-cpa-provider-field]');
    if (!input) return;
    const index = Number(input.closest('[data-cpa-provider-index]').dataset.cpaProviderIndex);
    const field = input.dataset.cpaProviderField;
    updateProviderDraft(items => {
      const item = items[index];
      if (field === 'entry-api-key') item['api-key-entries'][Number(input.closest('[data-cpa-key-index]').dataset.cpaKeyIndex)]['api-key'] = input.value;
      else if (field === 'entry-proxy-url') { const key = item['api-key-entries'][Number(input.closest('[data-cpa-key-index]').dataset.cpaKeyIndex)]; if (input.value || Object.hasOwn(key, 'proxy-url')) key['proxy-url'] = input.value; }
      else if (field === 'disabled') item.disabled = input.checked;
      else if (field === 'model-name' || field === 'model-alias') item.models[Number(input.closest('[data-cpa-model-index]').dataset.cpaModelIndex)][field === 'model-name' ? 'name' : 'alias'] = input.value;
      else if (field === 'excluded-model') item['excluded-models'][Number(input.closest('[data-cpa-excluded-index]').dataset.cpaExcludedIndex)] = input.value;
      else if (field === 'header-name' || field === 'header-value') {
        const original = Object.keys(item.headers)[Number(input.closest('[data-cpa-header-index]').dataset.cpaHeaderIndex)];
        if (field === 'header-value') item.headers[original] = input.value;
        else {
          const name = input.value.trim();
          if (!name || /[\r\n:]/.test(name) || (name !== original && Object.hasOwn(item.headers, name))) throw new Error('Header 名称不能为空、包含冒号或与现有名称重复');
          const value = item.headers[original]; delete item.headers[original]; item.headers[name] = value;
        }
      } else if (field === 'api-key' || input.value || Object.hasOwn(item, field)) item[field] = input.value;
    });
  });
  $('cpa-provider-json').addEventListener('change', renderProviderCards);
  $('cpa-alias-channel').addEventListener('change', () => {
    $('cpa-alias-json-details').open = false;
    renderAliasCards();
    status('cpa-alias-status', '请先读取此渠道的模型别名');
  });
  $('cpa-alias-cards').addEventListener('change', event => {
    const input = event.target.closest('[data-cpa-alias-field]');
    if (!input) return;
    const index = Number(input.closest('[data-cpa-alias-index]').dataset.cpaAliasIndex);
    const field = input.dataset.cpaAliasField;
    updateAliasDraft(aliases => {
      const item = aliases[index];
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('该映射不存在，请重新读取');
      if (field === 'fork' || field === 'force-mapping') item[field] = input.checked;
      else if (field === 'display-name' && !input.value.trim()) delete item[field];
      else item[field] = input.value;
    });
  });
  $('cpa-alias-json').addEventListener('change', renderAliasCards);
  $('cpa-auth-select-all').addEventListener('change', event => {
    for (const box of $('cpa-auth-rows').querySelectorAll('[data-cpa-select-auth]')) {
      box.checked = event.target.checked;
      if (box.checked) state.selectedAuth.add(box.dataset.cpaSelectAuth);
      else state.selectedAuth.delete(box.dataset.cpaSelectAuth);
    }
    renderAuthFiles();
  });
  $('cpa-auth-rows').addEventListener('change', event => {
    const box = event.target.closest('[data-cpa-select-auth]');
    if (!box) return;
    if (box.checked) state.selectedAuth.add(box.dataset.cpaSelectAuth);
    else state.selectedAuth.delete(box.dataset.cpaSelectAuth);
    renderAuthFiles();
  });

  $('cpa-key-models-search')?.addEventListener('input', renderKeyModels);
  $('cpa-model-key')?.addEventListener('change', () => {
    loadModels();
  });

  setInterval(() => { if (activeNavTab === 'cpa-logs' && !isMemberAuth()) loadLogs(); }, 15000);

  // 初始化所有已声明的静态 select 元素为现代浮动下拉组件
  ['cpa-oauth-provider', 'cpa-provider-kind', 'cpa-alias-channel', 'cpa-model-key', 'cpa-routing-strategy'].forEach(id => {
    syncCpaDropdown(id);
  });
})();

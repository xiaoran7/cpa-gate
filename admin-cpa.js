(() => {
  const nav = document.getElementById('main-nav-tabs');
  const workspace = document.getElementById('workspace');
  if (!nav || !workspace) return;

  const pages = [
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
  const state = { yaml: '', yamlEtag: '', logAfter: Math.floor(Date.now() / 1000), logLines: [], logRangeHours: 1, logRenderLimit: LOG_RENDER_LIMIT, logTruncated: false, viewingErrorName: '', keyModels: [] };
  const button = (action, label, cls = 'btn btn-secondary btn-sm') => `<button class="${cls}" type="button" data-cpa-action="${action}">${label}</button>`;
  const CPA_ICONS = {
    warn: '<svg class="cpa-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" x2="12" y1="9" y2="13"/><line x1="12" x2="12.01" y1="17" y2="17"/></svg>',
    eye: '<svg class="cpa-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>',
    copy: '<svg class="cpa-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>'
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
          <p style="margin-bottom:0;">按选定的 API Key 查询经过 Gate 实际可访问的模型，支持快速过滤与复制 ID。</p>
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
  function status(id, message, kind = '') { const node = $(id); if (node) { node.textContent = message; node.className = `cpa-status ${kind}`; } }

  async function download(path, name) {
    const response = await request(path);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
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
          <button class="btn btn-secondary btn-sm" type="button" data-cpa-action="copy-model-id" data-model="${id}" style="min-height:26px;padding:2px 8px;font-size:11.5px;">复制 ID</button>
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
    const control = event.target.closest('[data-cpa-action]');
    if (!control) return;
    const action = control.dataset.cpaAction;
    control.disabled = true;
    try {
      if (action === 'yaml-load') await loadYaml();
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
      else if (action === 'routing-load') await loadRoutingConfig();
      else if (action === 'routing-save') await saveRoutingConfig();
    } catch (error) { showToast(`CPA 操作失败：${error.message}`, 'error'); }
    finally { control.disabled = false; }
  });

  $('cpa-log-filter')?.addEventListener('input', renderLogs);
  $('cpa-hide-management')?.addEventListener('change', renderLogs);
  $('cpa-settings-rows')?.addEventListener('change', event => {
    const toggle = event.target.closest('.cpa-toggle-input');
    if (!toggle) return;
    const textEl = toggle.closest('.cpa-setting-row')?.querySelector('.cpa-toggle-state-text');
    if (textEl) textEl.textContent = toggle.checked ? '开启' : '关闭';
  });

  $('cpa-key-models-search')?.addEventListener('input', renderKeyModels);
  $('cpa-model-key')?.addEventListener('change', () => {
    loadModels();
  });

  setInterval(() => { if (activeNavTab === 'cpa-logs' && !isMemberAuth()) loadLogs(); }, 15000);

  // 初始化所有已声明的静态 select 元素为现代浮动下拉组件
  ['cpa-model-key', 'cpa-routing-strategy'].forEach(id => {
    syncCpaDropdown(id);
  });
})();

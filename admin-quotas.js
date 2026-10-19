/**
 * Gate Admin Console - Upstream Quotas, Validations & Credentials Module
 * 包含上游凭证配额卡片渲染、搜索过滤、Google 验证处理、OpenRouter 与优先级管理及用量统计
 */

    // ---- 优先级弹窗交互 ----
    let currentEditingAuth = null;

    function openPriorityModal(filename) {
      const accounts = cachedUpstream.accounts || [];
      const acc = accounts.find(a => a.filename === filename || a.id === filename);
      if (!acc) {
        showToast('未找到凭证信息', 'error');
        return;
      }
      currentEditingAuth = acc;
      document.getElementById('prio-modal-filename').innerText = acc.filename;
      const dispName = (acc.display_name || acc.nickname || acc.email || acc.filename || '').replace(/\.json$/i, '');
      document.getElementById('prio-modal-email').innerText = dispName || acc.email;
      document.getElementById('prio-modal-input').value = normalizeAuthPriority(acc.priority);
      // 保存总是会把当前数值作为显式字段写进 auths/<name>.json——哪怕一个键都没碰。
      // 而服务端已把 "未设" 归一化成默认档位，前端无从区分显式与未设，因此不能只对
      // 未设的号提示。默认档位一并说明，让人知道不设等于什么。
      document.getElementById('prio-modal-default-hint').innerText =
        `保存会显式写入 P${normalizeAuthPriority(acc.priority)}；未显式设置的凭据默认是 P${defaultAuthPriority()}`;

      const toggle = document.getElementById('prio-modal-status-toggle');
      const isEnabled = !acc.disabled && acc.status !== 'disabled';
      toggle.checked = isEnabled;

      openModal('upstream-priority-modal');
    }

    function setPresetPriority(val) {
      document.getElementById('prio-modal-input').value = val;
    }

    async function saveUpstreamPriority() {
      if (!currentEditingAuth) return;
      const secret = getAdminSecret();
      if (!secret) {
        showToast('管理密钥未配置', 'error');
        return;
      }
      const btn = document.getElementById('prio-modal-save-btn');
      btn.disabled = true;
      btn.innerText = '正在保存...';

      const prioVal = Number(document.getElementById('prio-modal-input').value);
      const isEnabled = document.getElementById('prio-modal-status-toggle').checked;
      const filename = currentEditingAuth.filename || currentEditingAuth.id;

      try {
        // 1. 更新优先级
        const prioRes = await fetch('/admin/api/upstream-auth/priority', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + secret
          },
          body: JSON.stringify({
            name: filename,
            priority: prioVal
          })
        });
        if (!prioRes.ok) {
          const errData = await prioRes.json().catch(() => ({}));
          throw new Error(errData.error || '更新优先级失败');
        }

        // 2. 更新启用/停用状态
        const statusRes = await fetch('/admin/api/upstream-auth/status', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + secret
          },
          body: JSON.stringify({
            name: filename,
            disabled: !isEnabled
          })
        });
        if (!statusRes.ok) {
          const errData = await statusRes.json().catch(() => ({}));
          throw new Error(errData.error || '更新账号状态失败');
        }

        showToast(`账号 ${currentEditingAuth.email} 优先级已更新为 P${prioVal}`, 'success');
        closeModal('upstream-priority-modal');
        // 本地立即刷新配额与状态卡
        await fetchUpstreamQuotas(false);
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        btn.disabled = false;
        btn.innerText = '保存并生效';
      }
    }

    // ---- OpenRouter 原生账号管理交互 (Gate 自治) ----
    let cachedOpenRouterAccountList = [];

    async function openOpenRouterModal() {
      openModal('modal-openrouter-accounts');
      hideOpenRouterForm();
      await loadOpenRouterAccountList();
    }

    async function loadOpenRouterAccountList() {
      const tbody = document.getElementById('openrouter-accounts-tbody');
      if (!tbody) return;
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:var(--text-dim); padding:20px;">正在加载账号清单...</td></tr>';
      try {
        const res = await fetch('/admin/api/openrouter/accounts', {
          headers: getAuthHeaders()
        });
        if (!res.ok) throw new Error('拉取 OpenRouter 账号列表失败');
        const data = await res.json();
        cachedOpenRouterAccountList = data.accounts || [];
        renderOpenRouterAccountsTable();
      } catch (err) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--danger); padding:20px;">${escapeHtml(err.message)}</td></tr>`;
      }
    }

    function renderOpenRouterAccountsTable() {
      const tbody = document.getElementById('openrouter-accounts-tbody');
      if (!tbody) return;
      if (cachedOpenRouterAccountList.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:var(--text-dim); padding:24px;">暂无 OpenRouter 账号，点击上方“➕ 添加账号”快速接入。</td></tr>';
        return;
      }

      tbody.innerHTML = cachedOpenRouterAccountList.map(acc => {
        const hasMgmt = acc.hasMgmtKey;
        const mgmtBadge = hasMgmt
          ? `<span style="display:inline-flex; align-items:center; gap:3px; color:#10b981; background:rgba(16,185,129,0.1); padding:2px 6px; border-radius:4px; font-size:11px;" title="${escapeHtml(acc.mgmtKeyMasked || '已配置')}"><svg fill="none" stroke="currentColor" stroke-width="2.5" style="width:11px;height:11px;" viewBox="0 0 24 24"><path d="M5 13l4 4L19 7" stroke-linecap="round" stroke-linejoin="round"/></svg>已配置</span>`
          : `<span style="color:var(--text-dim); background:rgba(0,0,0,0.04); padding:2px 6px; border-radius:4px; font-size:11px;" title="未配置 Management Key，无法拉取调用次数">未配置</span>`;

        const apiMasked = acc.apiKeyMasked ? `<span style="font-family:var(--mono); color:var(--text-muted); font-size:11px;">${escapeHtml(acc.apiKeyMasked)}</span>` : '<span style="color:var(--text-dim); font-size:11px;">未填</span>';
        const todayCountTxt = Number.isFinite(acc.today_requests) ? `<strong style="color:#3b82f6; font-family:var(--mono); font-size:13px;">${acc.today_requests}</strong> 次` : '<span style="color:var(--text-dim); font-size:11px;">待拉取</span>';

        return `
          <tr style="border-bottom:1px solid var(--border-subtle, rgba(0,0,0,0.04));">
            <td style="padding:8px 6px; font-weight:600; color:var(--text-main);">${escapeHtml(acc.name)}</td>
            <td style="padding:8px 6px; color:var(--text-muted); font-size:11px;">${escapeHtml(acc.note || '-')}</td>
            <td style="padding:8px 6px;">${apiMasked}</td>
            <td style="padding:8px 6px;">${mgmtBadge}</td>
            <td style="padding:8px 6px;">${todayCountTxt}</td>
            <td style="padding:8px 6px; text-align:right; white-space:nowrap;">
              <button class="btn btn-secondary btn-sm" onclick="editOpenRouterAccount('${escapeHtml(acc.id)}')" style="padding:2px 8px; font-size:11px; margin-right:4px;">编辑</button>
              <button class="btn btn-secondary btn-sm" onclick="deleteOpenRouterAccountById('${escapeHtml(acc.id)}', '${escapeHtml(acc.name)}')" style="padding:2px 8px; font-size:11px; color:var(--danger);">删除</button>
            </td>
          </tr>
        `;
      }).join('');
    }

    function showAddOpenRouterForm(editData = null) {
      const card = document.getElementById('openrouter-form-card');
      const title = document.getElementById('openrouter-form-title');
      const idInput = document.getElementById('openrouter-form-id');
      const nameInput = document.getElementById('openrouter-form-name');
      const noteInput = document.getElementById('openrouter-form-note');
      const apiInput = document.getElementById('openrouter-form-apikey');
      const mgmtInput = document.getElementById('openrouter-form-mgmtkey');

      if (!card) return;
      card.style.display = 'block';

      if (editData) {
        title.textContent = `编辑账号 [${editData.name}]`;
        idInput.value = editData.id;
        nameInput.value = editData.name || '';
        noteInput.value = editData.note || '';
        apiInput.value = '';
        apiInput.placeholder = editData.hasApiKey ? '保留原 API Key (如需更新请输入新 Key)' : 'sk-or-v1-...';
        mgmtInput.value = '';
        mgmtInput.placeholder = editData.hasMgmtKey ? '保留原 Management Key (如需更新请输入新 Key)' : 'sk-or-v1-...';
      } else {
        title.textContent = '添加 OpenRouter 账号';
        idInput.value = '';
        nameInput.value = '';
        noteInput.value = '';
        apiInput.value = '';
        apiInput.placeholder = 'sk-or-v1-...';
        mgmtInput.value = '';
        mgmtInput.placeholder = 'sk-or-v1-... (用于获取今日模型调用次数)';
      }
      nameInput.focus();
    }

    function hideOpenRouterForm() {
      const card = document.getElementById('openrouter-form-card');
      if (card) card.style.display = 'none';
    }

    function editOpenRouterAccount(id) {
      const acc = cachedOpenRouterAccountList.find(a => String(a.id) === String(id));
      if (!acc) return;
      showAddOpenRouterForm(acc);
    }

    async function submitOpenRouterAccount() {
      const id = document.getElementById('openrouter-form-id').value.trim();
      const name = document.getElementById('openrouter-form-name').value.trim();
      const note = document.getElementById('openrouter-form-note').value.trim();
      const apiKey = document.getElementById('openrouter-form-apikey').value.trim();
      const mgmtKey = document.getElementById('openrouter-form-mgmtkey').value.trim();
      const btn = document.getElementById('openrouter-form-submit-btn');

      if (!name) {
        showToast('请输入账号名称', 'error');
        return;
      }

      btn.disabled = true;
      btn.textContent = '保存中...';

      try {
        const isEdit = Boolean(id);
        const url = isEdit ? `/admin/api/openrouter/accounts/${encodeURIComponent(id)}` : '/admin/api/openrouter/accounts';
        const method = isEdit ? 'PATCH' : 'POST';

        const payload = { name, note };
        if (apiKey) payload.apiKey = apiKey;
        if (mgmtKey) payload.mgmtKey = mgmtKey;

        const res = await fetch(url, {
          method,
          headers: {
            'Content-Type': 'application/json',
            ...getAuthHeaders()
          },
          body: JSON.stringify(payload)
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || '保存账号失败');
        }

        showToast(isEdit ? `账号 ${name} 已更新` : `账号 ${name} 添加成功`, 'success');
        hideOpenRouterForm();
        await loadOpenRouterAccountList();
        // 静默刷新外层大盘
        fetchUpstreamQuotas(true).catch(() => {});
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = '保存账号';
      }
    }

    async function deleteOpenRouterAccountById(id, name) {
      if (!confirm(`确定要删除 OpenRouter 账号 [${name || id}] 吗？此操作无法撤销。`)) return;
      try {
        const res = await fetch(`/admin/api/openrouter/accounts/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          headers: getAuthHeaders()
        });
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || '删除账号失败');
        }
        showToast(`已成功删除账号 ${name || id}`, 'success');
        await loadOpenRouterAccountList();
        fetchUpstreamQuotas(true).catch(() => {});
      } catch (err) {
        showToast(err.message, 'error');
      }
    }


    let cachedUpstreamValidations = [];

    // 获取上游验证链接列表与渲染
    async function fetchUpstreamValidations(showTip = false) {
      const secret = getAdminSecret();
      if (!secret || isMemberAuth()) return;
      try {
        const res = await fetch('/admin/api/upstream-validations', {
          headers: getAuthHeaders()
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        cachedUpstreamValidations = data.validations || [];
        renderValidationsBanner();
        renderValidationsPage();
        if (showTip) showToast('验证列表已更新', 'success');
      } catch (err) {
        console.warn('[Gate] fetchUpstreamValidations error:', err.message);
        if (showTip) showToast('获取验证列表失败: ' + err.message, 'error');
      }
    }

    function renderValidationsBanner() {
      const banner = document.getElementById('upstream-validations-banner');
      const container = document.getElementById('upstream-validations-container');
      const opsBox = document.getElementById('ops-validations-box');
      const opsCount = document.getElementById('ops-validations-count');
      const navBadge = document.getElementById('nav-badge-validations');

      const pendings = cachedUpstreamValidations.filter(v => v.status === 'pending');

      if (navBadge) {
        navBadge.textContent = String(pendings.length);
        if (pendings.length > 0) {
          navBadge.style.background = '#ef4444';
          navBadge.style.color = '#ffffff';
          navBadge.style.fontWeight = '700';
        } else {
          navBadge.style.background = 'rgba(148, 163, 184, 0.2)';
          navBadge.style.color = 'var(--text-dim)';
          navBadge.style.fontWeight = '500';
        }
      }

      if (opsBox && opsCount) {
        if (pendings.length > 0) {
          opsBox.style.display = 'flex';
          opsCount.textContent = String(pendings.length);
        } else {
          opsBox.style.display = 'none';
        }
      }

      if (!banner || !container) return;

      if (pendings.length === 0) {
        banner.style.display = 'none';
        container.innerHTML = '';
        return;
      }

      banner.style.display = 'block';
      container.innerHTML = pendings.map(v => {
        const timeStr = new Date(v.updated_at).toLocaleTimeString('zh-CN', { hour12: false });
        const nameDisp = escapeHtml(v.account_name || v.auth_index || '未知账号');
        const urlSafe = escapeHtml(v.validation_url);
        return `
          <div style="background:var(--bg-card); border:1px solid rgba(239,68,68,0.25); border-radius:6px; padding:10px 14px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
            <div style="display:flex; flex-direction:column; gap:2px; min-width:0; max-width:70%;">
              <div style="display:flex; align-items:center; gap:8px;">
                <span class="chip chip-red" style="font-size:10.5px; font-weight:700;">待 Google 验证</span>
                <strong style="color:var(--text-main); font-size:13px;">${nameDisp}</strong>
                <span style="font-family:var(--mono); font-size:11px; color:var(--text-dim);">ID: ${escapeHtml(String(v.auth_index).slice(0, 8))} · ${timeStr}</span>
              </div>
              <div style="font-size:11px; color:var(--text-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                ${escapeHtml(v.error_message || 'Verify your account to continue.')}
              </div>
            </div>
            <div style="display:flex; align-items:center; gap:8px;">
              <a href="${urlSafe}" target="_blank" rel="noopener noreferrer" class="btn btn-sm" style="background:#ef4444; color:#fff; text-decoration:none; display:inline-flex; align-items:center; gap:4px; padding:4px 12px; font-weight:600;" title="在浏览器打开官方验证页面">
                打开验证链接 ↗
              </a>
              <button class="btn btn-secondary btn-sm" onclick="resolveValidation(${v.id})" title="已在浏览器完成验证，清除此提醒">
                标记已完成
              </button>
            </div>
          </div>
        `;
      }).join('');
    }

    // 渲染 "Google 验证" 专属工作区页面
    function renderValidationsPage() {
      const pendings = cachedUpstreamValidations.filter(v => v.status === 'pending');
      const resolved = cachedUpstreamValidations.filter(v => v.status === 'resolved');
      const antigravityAccounts = (cachedUpstream.accounts || []).filter(a => a.provider === 'antigravity');

      // 1. 顶部指标
      const pendingCountEl = document.getElementById('val-pending-count');
      const totalAntigravityCountEl = document.getElementById('val-total-antigravity-count');
      const resolvedCountEl = document.getElementById('val-resolved-count');
      const pendingChipEl = document.getElementById('val-pending-chip');

      if (pendingCountEl) pendingCountEl.textContent = String(pendings.length);
      if (totalAntigravityCountEl) totalAntigravityCountEl.textContent = String(antigravityAccounts.length);
      if (resolvedCountEl) resolvedCountEl.textContent = String(resolved.length);
      if (pendingChipEl) {
        pendingChipEl.style.display = pendings.length > 0 ? 'inline-flex' : 'none';
        pendingChipEl.textContent = `${pendings.length} 个需验证`;
      }

      // 2. 待验证卡片列表
      const pendingList = document.getElementById('validations-pending-list');
      if (pendingList) {
        if (pendings.length === 0) {
          pendingList.innerHTML = `
            <div class="val-empty-box">
              <svg style="width:36px;height:36px;color:#10b981;" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
              </svg>
              <div class="val-empty-title">当前所有 Google Antigravity 凭证均安全正常</div>
              <div class="val-empty-desc">
                暂无账号收到上游 <code>403 VALIDATION_REQUIRED</code> 风控拦截。当出现安全验证提示时，此处会立即生成直达链接并伴随高亮报警。你也可以通过右上角按钮手动录入。
              </div>
            </div>
          `;
        } else {
          pendingList.innerHTML = pendings.map(v => {
            const timeStr = new Date(v.updated_at).toLocaleString('zh-CN', { hour12: false });
            const nameDisp = escapeHtml(v.account_name || v.auth_index || 'Google 账号');
            const targetEmail = v.account_name && v.account_name.includes('@') ? v.account_name.trim() : null;
            const standardUrl = safeGoogleLink(v.validation_url);
            const userSpecificUrl = targetEmail ? safeGoogleLink(v.validation_url, targetEmail) : '';
            const errSafe = escapeHtml(v.error_message || 'Verify your account to continue.');
            const isCompletedAuto = v.validation_url && !v.validation_url.includes('continue=') && standardUrl.includes('continue=');

            return `
              <div class="val-pending-card">
                <div class="val-pending-header">
                  <div class="val-pending-title">
                    <span class="chip chip-red" style="font-weight:700;">待 Google 验证</span>
                    <span class="val-pending-name">${nameDisp}</span>
                    <span style="font-family:var(--mono); font-size:11.5px; color:var(--text-dim);">Auth: ${escapeHtml(v.auth_index)}</span>
                  </div>
                  <div style="font-size:11.5px; color:var(--text-dim); font-family:var(--mono);">
                    捕获时间: ${timeStr}
                  </div>
                </div>
                <div class="val-pending-msg">
                  ⚠️ ${errSafe}
                </div>
                <div style="font-size:12px; color:var(--text-muted); word-break:break-all; background:rgba(0,0,0,0.02); padding:8px 10px; border-radius:6px; border:1px dashed var(--card-border);">
                  <strong>官方验证链接：</strong>
                  ${standardUrl ? `<a href="${standardUrl}" target="_blank" rel="noopener noreferrer" style="color:var(--accent); text-decoration:underline;">${standardUrl}</a>` : '<span style="color:var(--danger);">链接无效或缺失，请重新触发请求或手动录入</span>'}
                  ${isCompletedAuto ? '<span class="chip chip-green" style="font-size:10px; margin-left:6px;">已智能补全官方回调</span>' : ''}
                </div>
                <div class="val-pending-actions" style="display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-top:10px;">
                  ${standardUrl ? `
                    <a href="${standardUrl}" target="_blank" rel="noopener noreferrer" class="val-btn-go">
                      <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;"><path stroke-linecap="round" stroke-linejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg>
                      官方认证直达 ↗
                    </a>
                  ` : ''}
                  ${userSpecificUrl && userSpecificUrl !== standardUrl ? `
                    <a href="${userSpecificUrl}" target="_blank" rel="noopener noreferrer" class="btn btn-secondary btn-sm" title="附带当前账号参数，防止浏览器多账号串号">
                      指定账号打开 (${escapeHtml(targetEmail)}) ↗
                    </a>
                  ` : ''}
                  ${standardUrl ? `
                    <button class="btn btn-secondary btn-sm" onclick="copyToClipboard('${standardUrl.replace(/'/g, "\\'")}', '验证链接已复制，可粘贴至无痕窗口')">
                      复制链接
                    </button>
                  ` : ''}
                  <button class="btn btn-secondary btn-sm" onclick="resolveValidation(${v.id})" style="background:rgba(16,185,129,0.08); color:#10b981; border-color:rgba(16,185,129,0.3);">
                    <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" style="width:13px;height:13px;"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>
                    我已完成验证，重新核验
                  </button>
                  <button class="btn btn-secondary btn-sm" onclick="dismissValidation(${v.id})" style="color:var(--text-dim);" title="暂时忽略该验证提醒">
                    忽略提醒
                  </button>
                  <button class="btn btn-secondary btn-sm" onclick="deleteValidation(${v.id})" style="color:var(--danger);">
                    删除记录
                  </button>
                </div>
              </div>
            `;
          }).join('');
        }
      }

      // 3. 所有 Antigravity 账号巡检表
      const accountsTbody = document.getElementById('antigravity-accounts-tbody');
      if (accountsTbody) {
        if (antigravityAccounts.length === 0) {
          accountsTbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--text-dim); padding:24px;">未检测到加载中的 Google Antigravity 账号</td></tr>`;
        } else {
          accountsTbody.innerHTML = antigravityAccounts.map(acc => {
            const hasPending = pendings.find(p => p.auth_index === acc.auth_index || (acc.email && p.account_name === acc.email));
            const statusBadge = acc.health?.blocked
              ? `<span class="chip chip-red">${escapeHtml(acc.health.label)}</span>`
              : `<span class="chip chip-green">运行中</span>`;

            const healthBadge = hasPending
              ? `<span class="chip chip-red" style="font-weight:700; animation:pulse 1.8s infinite;">⚠️ 需人工验证</span>`
              : (acc.health?.blocked ? `<span class="chip chip-red">${escapeHtml(acc.health.detail)}</span>` : `<span class="chip chip-green">✓ 健康正常</span>`);

            const updateTime = acc.updated_at ? new Date(acc.updated_at).toLocaleTimeString('zh-CN', { hour12: false }) : '--';

            let actionHtml = '';
            if (hasPending) {
              actionHtml = `
                <a href="${escapeHtml(hasPending.validation_url)}" target="_blank" rel="noopener noreferrer" class="btn btn-sm" style="background:#ef4444; color:#fff; text-decoration:none;">去验证 ↗</a>
                <button class="btn btn-secondary btn-sm" onclick="resolveValidation(${hasPending.id})">已完成</button>
                <button class="btn btn-secondary btn-sm" onclick="dismissValidation(${hasPending.id})" style="color:var(--text-dim);" title="忽略提醒">忽略</button>
              `;
            } else {
              actionHtml = `
                <button class="btn btn-secondary btn-sm" onclick="quickFillManualValidation('${escapeHtml(acc.email || '')}', '${escapeHtml(acc.auth_index)}')">录入链接</button>
              `;
            }

            return `
              <tr>
                <td>
                  <div style="font-weight:600; color:var(--text-main); font-size:13px;">${escapeHtml((acc.display_name || acc.email || acc.filename || acc.id || '').replace(/\.json$/i, ''))}</div>
                  <div style="font-size:11px; color:var(--text-dim);">${escapeHtml(acc.plan_name || 'Google AI Pro')}</div>
                </td>
                <td style="font-family:var(--mono); font-size:12px; color:var(--text-muted);">${escapeHtml(acc.auth_index || '--')}</td>
                <td>${statusBadge}</td>
                <td>${healthBadge}</td>
                <td style="font-family:var(--mono); font-size:11.5px; color:var(--text-dim);">${updateTime}</td>
                <td style="text-align:right;">
                  <div style="display:inline-flex; align-items:center; gap:6px;">
                    ${actionHtml}
                  </div>
                </td>
              </tr>
            `;
          }).join('');
        }
      }

      // 4. 历史验证记录流水表
      const histTbody = document.getElementById('validations-history-tbody');
      if (histTbody) {
        if (cachedUpstreamValidations.length === 0) {
          histTbody.innerHTML = `<tr><td colspan="8" style="text-align:center; color:var(--text-dim); padding:24px;">暂无捕获历史记录</td></tr>`;
        } else {
          histTbody.innerHTML = cachedUpstreamValidations.slice(0, 50).map(v => {
            const timeStr = new Date(v.ts).toLocaleString('zh-CN', { hour12: false });
            const upTimeStr = new Date(v.updated_at).toLocaleString('zh-CN', { hour12: false });
            const statusLabel = v.status === 'pending'
              ? `<span class="chip chip-red">待验证</span>`
              : (v.status === 'resolved' ? `<span class="chip chip-green">已验证</span>` : `<span class="chip chip-gray">已忽略</span>`);

            return `
              <tr>
                <td style="font-family:var(--mono); font-size:11.5px;">#${v.id}</td>
                <td style="font-family:var(--mono); font-size:11.5px; color:var(--text-muted);">${timeStr}</td>
                <td style="font-weight:600; font-size:12.5px;">${escapeHtml(v.account_name || '--')}</td>
                <td style="font-family:var(--mono); font-size:11.5px; color:var(--text-dim);">${escapeHtml(v.auth_index)}</td>
                <td style="font-size:11.5px; max-width:260px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(v.error_message || '')}">
                  ${escapeHtml(v.error_message || '--')}
                </td>
                <td>${statusLabel}</td>
                <td style="font-family:var(--mono); font-size:11.5px; color:var(--text-dim);">${upTimeStr}</td>
                <td style="text-align:right; white-space:nowrap;">
                  ${safeGoogleLink(v.validation_url, v.account_name) ? `<a href="${safeGoogleLink(v.validation_url, v.account_name)}" target="_blank" rel="noopener noreferrer" class="btn btn-secondary btn-sm" style="text-decoration:none;">访问链接 ↗</a>` : ''}
                  <button class="btn btn-secondary btn-sm" onclick="deleteValidation(${v.id})" style="color:var(--danger); margin-left:4px;" title="彻底删除此历史记录">删除</button>
                </td>
              </tr>
            `;
          }).join('');
        }
      }
    }

    function openManualValidationModal() {
      document.getElementById('manual-val-account').value = '';
      document.getElementById('manual-val-url').value = '';
      openModal('manual-val-modal');
    }

    function quickFillManualValidation(email, authIndex) {
      document.getElementById('manual-val-account').value = email || authIndex;
      document.getElementById('manual-val-url').value = '';
      openModal('manual-val-modal');
      setTimeout(() => document.getElementById('manual-val-url').focus(), 100);
    }

    async function submitManualValidation() {
      const account = document.getElementById('manual-val-account').value.trim();
      const url = document.getElementById('manual-val-url').value.trim();
      if (!url) {
        showToast('请输入 validation_url 验证链接', 'error');
        return;
      }
      try {
        const res = await fetch('/admin/api/upstream-validations/manual', {
          method: 'POST',
          headers: {
            ...getAuthHeaders(),
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            account_name: account,
            validation_url: url
          })
        });
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        const openUrl = data.validation_url || url;
        showToast('已保存验证链接，正在打开认证网页...', 'success');
        closeModal('manual-val-modal');
        window.open(openUrl, '_blank', 'noopener,noreferrer');
        await fetchUpstreamValidations();
        await fetchUpstreamQuotas(false);
      } catch (err) {
        showToast('录入失败: ' + err.message, 'error');
      }
    }

    async function resolveValidation(id) {
      const secret = getAdminSecret();
      if (!secret) return;
      try {
        const res = await fetch(`/admin/api/upstream-validations/${id}/resolve`, {
          method: 'POST',
          headers: getAuthHeaders()
        });
        if (res.ok) {
          showToast('已完成验证标记，正在重新核验上游状态...', 'success');
          await fetchUpstreamValidations();
          await fetchUpstreamQuotas(true);
        } else {
          showToast('标记失败', 'error');
        }
      } catch (err) {
        showToast('请求错误: ' + err.message, 'error');
      }
    }

    async function dismissValidation(id) {
      const secret = getAdminSecret();
      if (!secret) return;
      try {
        const res = await fetch(`/admin/api/upstream-validations/${id}/dismiss`, {
          method: 'POST',
          headers: getAuthHeaders()
        });
        if (res.ok) {
          showToast('已忽略该验证提醒', 'info');
          await fetchUpstreamValidations();
          await fetchUpstreamQuotas(false);
        } else {
          showToast('操作失败', 'error');
        }
      } catch (err) {
        showToast('请求错误: ' + err.message, 'error');
      }
    }

    async function deleteValidation(id) {
      if (!confirm('确定彻底删除该条验证记录吗？')) return;
      try {
        const res = await fetch(`/admin/api/upstream-validations/${id}`, {
          method: 'DELETE',
          headers: getAuthHeaders()
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        showToast('验证记录已删除', 'success');
        await fetchUpstreamValidations(true);
        await fetchUpstreamQuotas(false);
      } catch (err) {
        showToast(`删除失败：${err.message}`, 'error');
      }
    }

    // 0. 获取上游凭证配额 (Antigravity & Codex 账号卡片)
    let isFetchingUpstreamQuotas = false;
    function setUpstreamPlaceholder(html) {
      const cards = document.getElementById('upstream-cards-container');
      const compact = document.getElementById('upstream-compact-container');
      if (cards) cards.innerHTML = html;
      if (compact) compact.innerHTML = html;
    }

    async function fetchUpstreamQuotas(force = false) {
      if (isMemberAuth()) return;
      if (isFetchingUpstreamQuotas) return;
      isFetchingUpstreamQuotas = true;
      const secret = getAdminSecret();
      if (!secret) {
        setUpstreamPlaceholder(`
          <div class="upstream-empty-state" style="padding: 32px 20px;">
            <div style="font-size: 14px; color: var(--text-muted); margin-bottom: 8px;">未配置管理密钥 (GATE_ADMIN_SECRET)</div>
            <div style="font-size: 12px; color: var(--text-dim); margin-bottom: 16px;">请点击右上角"密钥"设置管理员密码以查看上游凭证配额与进行操作</div>
            <button class="btn btn-secondary btn-sm" onclick="openAuthModal()">立即设置管理密钥</button>
          </div>
        `);
        isFetchingUpstreamQuotas = false;
        return;
      }
      try {
        const url = '/admin/api/upstream-quotas' + (force ? '?refresh=1' : '');
        const res = await fetch(url, {
          headers: { 'Authorization': 'Bearer ' + secret }
        });
        if (res.status === 200) {
          cachedUpstream = await res.json();
          upstreamLoaded = true;
          renderUpstreamCards();
          renderStatusCards();
        } else if (res.status === 401 || res.status === 403) {
          upstreamLoaded = false;
          cachedUpstream = { accounts: [] };
          setUpstreamPlaceholder(`
            <div class="upstream-empty-state" style="padding: 32px 20px;">
              <div style="font-size: 14px; color: var(--danger); margin-bottom: 8px;">管理密钥鉴权失败 (HTTP ${res.status})</div>
              <div style="font-size: 12px; color: var(--text-dim); margin-bottom: 16px;">当前配置的管理密钥与服务器不匹配，请点击右上角"密钥"重新核对</div>
              <button class="btn btn-secondary btn-sm" onclick="openAuthModal()">重新输入管理密钥</button>
            </div>
          `);
        } else {
          upstreamLoaded = false;
          cachedUpstream = { accounts: [] };
          setUpstreamPlaceholder(`<div class="upstream-empty-state" style="color:var(--danger);">拉取上游配额失败 (HTTP ${res.status})，请稍后重试</div>`);
        }
      } catch (err) {
        upstreamLoaded = false;
        cachedUpstream = { accounts: [] };
        console.warn('Upstream quota fetch error:', err.message);
        setUpstreamPlaceholder(`<div class="upstream-empty-state" style="color:var(--danger);">拉取网络异常: ${escapeHtml(err.message)}</div>`);
      } finally {
        renderOperationsStrip();
        isFetchingUpstreamQuotas = false;
      }
    }

    async function refreshUpstreamQuotas(force = false) {
      setUpstreamPlaceholder('<div class="upstream-empty-state">正在拉取最新上游凭证与配额数据...</div>');
      await fetchUpstreamQuotas(force);
      showToast('上游凭证配额已更新', 'success');
    }

    // 向上游重新查询额度，然后刷新卡片。
    async function triggerActivateQuotaWindow(filename, provider, authIndex) {
      const secret = getAdminSecret();
      if (!secret) {
        showToast('管理密钥未配置，请先点击右上角"密钥"设置', 'error');
        return;
      }
      try {
        showToast(`正在查询 ${filename || provider} 的上游额度...`, 'info');
        const res = await fetch('/admin/api/upstream-auth/activate-window', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + secret
          },
          body: JSON.stringify({ filename, provider, authIndex })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '额度查询失败');
        showToast('额度查询完成，正在刷新卡片...', 'success');
        // 前端主动触发刷新获取最新配额与重置时刻
        await fetchUpstreamQuotas(true);
      } catch (err) {
        showToast('额度查询失败: ' + err.message, 'error');
      }
    }

    // 批量查询当前筛选 Provider（或全部可查询 Provider）凭证额度
    async function triggerActivateFilteredAccounts() {
      const secret = getAdminSecret();
      if (!secret) {
        showToast('管理密钥未配置，请先点击右上角"密钥"设置', 'error');
        return;
      }
      const filter = (activeUpstreamFilter || 'all').toLowerCase();
      const accounts = (cachedUpstream.accounts || []).filter(a => {
        if (a.disabled || a.status === 'disabled' || a.health?.blocked) return false;
        if (filter !== 'all') {
          if (filter === 'workbuddy') {
            const p = (a.provider || '').toLowerCase();
            return p === 'workbuddy' || p === 'workbuddy-cn';
          }
          return (a.provider || '').toLowerCase() === filter;
        }
        const prov = (a.provider || '').toLowerCase();
        return prov === 'codex' || prov === 'antigravity' || prov === 'workbuddy' || prov === 'workbuddy-cn' || prov === 'openrouter' || prov === 'opencode';
      });

      const filterLabel = filter === 'all' ? '全部' : (filter === 'antigravity' ? 'Antigravity' : (filter === 'codex' ? 'Codex' : (filter === 'claude' ? 'Claude' : (filter === 'workbuddy' ? 'WorkBuddy' : (filter === 'openrouter' ? 'OpenRouter' : (filter === 'opencode' ? 'OpenCode' : filter))))));
      if (accounts.length === 0) {
        showToast(`未找到可查询额度的有效 ${filterLabel} 凭证`, 'warning');
        return;
      }

      showToast(`正在批量查询 ${accounts.length} 个 ${filterLabel} 凭据的最新额度...`, 'info');
      let successCount = 0;
      const concurrency = 4;
      for (let i = 0; i < accounts.length; i += concurrency) {
        const batch = accounts.slice(i, i + concurrency);
        await Promise.allSettled(batch.map(async acc => {
          try {
            const res = await fetch('/admin/api/upstream-auth/activate-window', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + secret
              },
              body: JSON.stringify({ filename: acc.filename || acc.id, provider: acc.provider, authIndex: acc.auth_index })
            });
            if (res.ok) successCount++;
          } catch (e) {}
        }));
      }
      showToast(`已查询 ${successCount} 个凭证的额度，正在刷新...`, 'success');
      await fetchUpstreamQuotas(true);
    }

    function onUpstreamSearch(query) {
      upstreamSearchQuery = (query || '').trim().toLowerCase();
      renderUpstreamCards();
    }

    function toggleHideDisabled(hide) {
      upstreamHideDisabled = Boolean(hide);
      localStorage.setItem('cpa_upstream_hide_disabled', String(upstreamHideDisabled));
      renderUpstreamCards();
    }

    function switchUpstreamViewMode(mode) {
      activeUpstreamViewMode = mode;
      localStorage.setItem('cpa_upstream_view_mode', mode);
      const tabs = document.querySelectorAll('#upstream-view-mode-tabs button');
      tabs.forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('onclick')?.includes(`'${mode}'`));
      });
      renderUpstreamCards();
    }

    function updateActivateProviderButton() {
      const btn = document.getElementById('btn-activate-provider');
      if (!btn) return;
      const f = (activeUpstreamFilter || 'all').toLowerCase();
      if (f === 'all') {
        btn.textContent = '刷新全部额度';
        btn.title = '对所有有效上游凭据（Antigravity、Codex、WorkBuddy 等）批量查询最新额度';
      } else if (f === 'antigravity') {
        btn.textContent = '刷新全部 Antigravity 额度';
        btn.title = '对所有有效 Antigravity 凭据批量查询最新额度';
      } else if (f === 'codex') {
        btn.textContent = '刷新全部 Codex 额度';
        btn.title = '对所有有效 Codex 凭据触发探针查询最新额度';
      } else if (f === 'claude') {
        btn.textContent = '刷新全部 Claude 额度';
        btn.title = '对所有有效 Claude 凭据查询最新额度';
      } else if (f === 'workbuddy' || f === 'workbuddy-cn') {
        btn.textContent = '刷新全部 WorkBuddy 额度';
        btn.title = '对所有有效 WorkBuddy / CodeBuddy 凭据批量查询最新额度';
      } else if (f === 'openrouter') {
        btn.textContent = '刷新全部 OpenRouter 额度';
        btn.title = '对所有有效 OpenRouter 凭据批量查询今日调用次数与剩余额度';
      } else if (f === 'opencode') {
        btn.textContent = '刷新全部 OpenCode 额度';
        btn.title = '对所有有效 OpenCode 凭据刷新今日 Token 消耗与请求次数';
      } else {
        const brandName = f.charAt(0).toUpperCase() + f.slice(1);
        btn.textContent = `刷新全部 ${brandName} 额度`;
        btn.title = `对所有有效 ${brandName} 凭据批量查询最新额度`;
      }
      const openrouterBtn = document.getElementById('btn-manage-openrouter');
      if (openrouterBtn) {
        openrouterBtn.style.display = f === 'openrouter' ? 'inline-flex' : 'none';
      }
    }

    function switchUpstreamFilter(filter) {
      activeUpstreamFilter = filter;
      const tabs = document.querySelectorAll('#upstream-filter-tabs button');
      tabs.forEach(t => t.classList.remove('active'));
      const activeBtn = Array.from(tabs).find(b => b.getAttribute('onclick')?.includes(`'${filter}'`));
      if (activeBtn) activeBtn.classList.add('active');
      updateActivateProviderButton();
      renderUpstreamCards();
    }

    function formatBucketLabel(name, window) {
      if (!name) return '标准配额';
      const n = String(name).trim();
      const nl = n.toLowerCase();
      if (nl.includes('five hour') || nl.includes('5 hour') || nl.includes('5h') || nl.includes('5 小时') || window === '5h') {
        return '5 小时限额';
      }
      if (nl.includes('weekly') || nl.includes('week') || nl.includes('周限额') || window === 'weekly') {
        return '周限额';
      }
      return n;
    }

    function getWorkBuddyExpirationInfo(acc) {
      if (!acc) {
        return {
          hasExpiration: false,
          shortText: '未公布到期时间',
          fullText: '未公布到期时间',
          countdown: '',
          color: 'var(--text-dim)',
          tooltip: '腾讯官方暂未公布该资源包到期时间',
          packages: [],
          hasMultiplePackages: false,
          packageCount: 0
        };
      }

      // 提取所有候选包明细（优先 acc.expiration_packages，其次 acc.groups 各 buckets）
      let rawPackages = [];
      if (Array.isArray(acc.expiration_packages) && acc.expiration_packages.length > 0) {
        rawPackages = acc.expiration_packages;
      } else if (Array.isArray(acc.groups)) {
        for (const g of acc.groups) {
          for (const b of (g.buckets || [])) {
            if (b.expires_at || b.reset_time) {
              rawPackages.push({
                package_name: b.name,
                package_code: b.package_code || b.bucket_id,
                remain_points: b.remain_capacity != null ? Number(b.remain_capacity) : 0,
                total_points: b.total_capacity != null ? Number(b.total_capacity) : 0,
                expires_at: b.expires_at || '',
                reset_time: b.reset_time || ''
              });
            }
          }
        }
      }

      // 如果未收集到包列表，但顶层有 expires_at / reset_time，构建兜底单包
      if (rawPackages.length === 0 && (acc.expires_at || acc.reset_time)) {
        rawPackages.push({
          package_name: '标准积分包',
          package_code: '',
          remain_points: acc.runs_out_points != null ? Number(acc.runs_out_points) : (acc.remaining_credits != null ? Number(acc.remaining_credits) : 0),
          total_points: acc.total_credits != null ? Number(acc.total_credits) : 0,
          expires_at: acc.expires_at || '',
          reset_time: acc.reset_time || ''
        });
      }

      if (rawPackages.length === 0) {
        return {
          hasExpiration: false,
          shortText: '未公布到期时间',
          fullText: '未公布到期时间',
          countdown: '',
          color: 'var(--text-dim)',
          tooltip: '腾讯官方暂未公布该资源包到期时间',
          packages: [],
          hasMultiplePackages: false,
          packageCount: 0
        };
      }

      const now = Date.now();
      const formattedPackages = [];

      for (const p of rawPackages) {
        let targetTs = null;
        if (p.reset_time) {
          try {
            const d = new Date(p.reset_time);
            if (!isNaN(d.getTime())) targetTs = d.getTime();
          } catch (_) {}
        }
        if (!targetTs && p.expires_at) {
          try {
            const s = String(p.expires_at).trim();
            const norm = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(s) ? s : s.replace(' ', 'T') + '+08:00';
            const d = new Date(norm);
            if (!isNaN(d.getTime())) targetTs = d.getTime();
          } catch (_) {}
        }

        let shortText = '';
        let fullText = p.expires_at || '';
        const currentCstYear = new Date(now + 8 * 3600 * 1000).getUTCFullYear();
        if (targetTs) {
          // 全局东八区单点真理源：统一转为东八区（UTC+8 北京时间）并使用 UTC getter 提取，避免多时区偏移
          const cstDate = new Date(targetTs + 8 * 3600 * 1000);
          const yyyy = cstDate.getUTCFullYear();
          const mm = cstDate.getUTCMonth() + 1;
          const dd = cstDate.getUTCDate();
          const hh = String(cstDate.getUTCHours()).padStart(2, '0');
          const min = String(cstDate.getUTCMinutes()).padStart(2, '0');
          if (yyyy !== currentCstYear) {
            shortText = `${yyyy}年${mm}月${dd}日 ${hh}:${min}`;
          } else {
            shortText = `${mm}月${dd}日 ${hh}:${min}`;
          }
          if (!fullText) {
            const ss = String(cstDate.getUTCSeconds()).padStart(2, '0');
            fullText = `${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')} ${hh}:${min}:${ss}`;
          }
        } else if (p.expires_at) {
          const s = String(p.expires_at).trim();
          const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
          if (m && Number(m[1]) !== currentCstYear) {
            const tm = s.slice(11, 16);
            shortText = `${m[1]}年${Number(m[2])}月${Number(m[3])}日${tm ? ' ' + tm : ''}`.trim();
          } else {
            shortText = s.slice(5, 16).replace('T', ' ');
          }
        } else {
          shortText = '未知到期日';
          fullText = '未知到期日';
        }

        let countdown = '';
        let color = 'var(--text-muted)';
        let isLongTerm = false;
        const pkgRawName = p.package_name || p.name || '';
        const isFreeOrTrialName = /free plan|体验|免费/i.test(pkgRawName);

        if (targetTs) {
          const diff = targetTs - now;
          if (diff <= 0) {
            countdown = '已到期';
            color = '#ef4444';
          } else {
            const hours = Math.floor(diff / (1000 * 3600));
            const days = Math.floor(hours / 24);
            // 识别远期基础包（如腾讯 2035 年代表永久有效的 Free Plan Subscription 或体验版）
            if (days >= 365 * 3 || (isFreeOrTrialName && days >= 365)) {
              isLongTerm = true;
              shortText = '长期有效';
              countdown = '';
              color = '#10b981';
            } else if (hours < 24) {
              countdown = `${Math.max(1, hours)}小时后`;
              color = '#ef4444';
            } else if (hours < 72) {
              countdown = `${days}天后`;
              color = '#f59e0b';
            } else {
              if (days < 365) {
                countdown = `${days}天后`;
              } else {
                const years = Math.floor(days / 365);
                const remMonths = Math.floor((days % 365) / 30);
                countdown = remMonths >= 1 ? `${years}年${remMonths}个月后` : `${years}年后`;
              }
              color = 'var(--text-muted)';
            }
          }
        } else if (p.expires_at) {
          const m = String(p.expires_at).trim().match(/^(\d{4})/);
          if (m && (Number(m[1]) >= currentCstYear + 3 || (isFreeOrTrialName && Number(m[1]) > currentCstYear))) {
            isLongTerm = true;
            shortText = '长期有效';
            countdown = '';
            color = '#10b981';
          }
        }

        formattedPackages.push({
          name: p.package_name || p.name || '标准积分包',
          code: p.package_code || '',
          points: Number(p.remain_points ?? p.remain_capacity ?? 0),
          totalPoints: Number(p.total_points ?? p.total_capacity ?? 0),
          targetTs,
          shortText,
          fullText,
          countdown,
          color,
          isLongTerm
        });
      }

      // 按到期时间排序（最早到期的排前面，有到期但无时间戳的其次，完全无到期时间的排末尾）
      formattedPackages.sort((a, b) => {
        if (a.targetTs && b.targetTs) return a.targetTs - b.targetTs;
        if (a.targetTs) return -1;
        if (b.targetTs) return 1;
        const aHasText = a.fullText && a.fullText !== '未知到期日';
        const bHasText = b.fullText && b.fullText !== '未知到期日';
        if (aHasText && !bHasText) return -1;
        if (!aHasText && bHasText) return 1;
        return 0;
      });

      // 检查是否有任何包包含有效到期时间（无论是 targetTs 还是非空的 expires_at）
      const hasAnyExpiration = formattedPackages.some(p => p.targetTs != null || (p.fullText && p.fullText !== '未知到期日'));
      if (!hasAnyExpiration) {
        return {
          hasExpiration: false,
          shortText: '未公布到期时间',
          fullText: '未公布到期时间',
          countdown: '',
          color: 'var(--text-dim)',
          tooltip: '腾讯官方暂未公布该资源包到期时间',
          packages: formattedPackages,
          hasMultiplePackages: false,
          packageCount: formattedPackages.length
        };
      }

      const earliest = formattedPackages[0];
      const hasMultiplePackages = formattedPackages.length > 1;
      const isAllLongTerm = hasAnyExpiration && formattedPackages.every(p => p.isLongTerm);

      let tooltip = '';
      if (!hasMultiplePackages) {
        tooltip = `积分到期截至时间: ${earliest.fullText} (北京时间)`;
        if (earliest.points > 0) {
          tooltip += ` · 可用: ${earliest.points} 积分`;
        }
        if (earliest.isLongTerm) {
          tooltip += ' · 长期有效';
        }
      } else {
        tooltip = `积分按资源包分批到期 (北京时间 · 共 ${formattedPackages.length} 批次):\n` +
          formattedPackages.map((p, idx) =>
            `第 ${idx + 1} 批 [${p.name}]: ${p.points} 积分 · 截至 ${p.fullText}${p.countdown ? ` (${p.countdown})` : (p.isLongTerm ? ' (长期有效)' : '')}`
          ).join('\n');
      }

      return {
        hasExpiration: true,
        targetTs: earliest.targetTs,
        shortText: isAllLongTerm ? '长期有效' : earliest.shortText,
        fullText: earliest.fullText,
        countdown: isAllLongTerm ? '' : earliest.countdown,
        color: isAllLongTerm ? '#10b981' : earliest.color,
        tooltip,
        runsOutPoints: earliest.points,
        packages: formattedPackages,
        hasMultiplePackages,
        packageCount: formattedPackages.length,
        isAllLongTerm,
        isLongTerm: earliest.isLongTerm
      };
    }

    function renderUpstreamCards() {
      renderOperationsStrip();
      const cardsContainer = document.getElementById('upstream-cards-container');
      const compactContainer = document.getElementById('upstream-compact-container');
      const accounts = cachedUpstream.accounts || [];

      // 更新导航栏徽章
      const navBadge = document.getElementById('nav-badge-quotas');
      if (navBadge) navBadge.innerText = accounts.length;

      // 初始化 checkbox 状态
      const hideCheck = document.getElementById('upstream-hide-disabled');
      if (hideCheck && hideCheck.checked !== upstreamHideDisabled) {
        hideCheck.checked = upstreamHideDisabled;
      }

      // 初始化视图切换高亮
      const viewTabs = document.querySelectorAll('#upstream-view-mode-tabs button');
      viewTabs.forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('onclick')?.includes(`'${activeUpstreamViewMode}'`));
      });

      let filtered = accounts;
      if (activeUpstreamFilter !== 'all') {
        filtered = accounts.filter(a => {
          const prov = (a.provider || '').toLowerCase();
          if (activeUpstreamFilter === 'workbuddy') {
            return prov === 'workbuddy' || prov === 'workbuddy-cn';
          }
          return prov === activeUpstreamFilter;
        });
      }
      if (upstreamHideDisabled) {
        filtered = filtered.filter(a => !a.disabled && a.status !== 'disabled');
      }
      if (upstreamSearchQuery) {
        filtered = filtered.filter(a => {
          const email = (a.email || '').toLowerCase();
          const authIdx = (a.auth_index || '').toLowerCase();
          const fname = (a.filename || a.id || '').toLowerCase();
          const disp = (a.display_name || '').toLowerCase();
          const nick = (a.nickname || '').toLowerCase();
          return email.includes(upstreamSearchQuery) ||
                 authIdx.includes(upstreamSearchQuery) ||
                 fname.includes(upstreamSearchQuery) ||
                 disp.includes(upstreamSearchQuery) ||
                 nick.includes(upstreamSearchQuery);
        });
      }

      if (filtered.length === 0) {
        const emptyHtml = '<div class="upstream-empty-state">暂无符合筛选条件的上游认证凭证</div>';
        if (cardsContainer) cardsContainer.innerHTML = emptyHtml;
        if (compactContainer) compactContainer.innerHTML = emptyHtml;
        return;
      }

      // 切换显隐容器
      if (activeUpstreamViewMode === 'compact') {
        if (cardsContainer) cardsContainer.style.display = 'none';
        if (compactContainer) {
          compactContainer.style.display = 'flex';
          compactContainer.innerHTML = filtered.map(acc => {
            const safeFilename = escapeHtml(acc.filename || acc.id || '');
            const brand = getProviderBrand(acc.provider);
            const planType = (acc.plan_type || 'free').toLowerCase();
            let planClass = 'plan-free';
            if (planType.includes('pro') || planType.includes('ultra')) planClass = 'plan-pro';
            else if (planType.includes('plus')) planClass = 'plan-plus';

            const isDisabled = Boolean(acc.disabled || acc.status === 'disabled');
            const health = acc.health || {};
            const isBlocked = health.blocked === true;
            const prio = normalizeAuthPriority(acc.priority);
            const prioCls = prio >= 20 ? 'p-high' : (prio >= 10 ? 'p-normal' : 'p-low');

            // 智能提取配额桶：针对 Antigravity 提取 Gemini 5h 与 Gemini 周限额；针对 Codex 提取 5h 与周限额
            let gemini5hBucket = null;
            let geminiWeeklyBucket = null;
            let codex5hBucket = null;
            let codexWeeklyBucket = null;
            let fallbackBucket = null;

            for (const grp of (acc.groups || [])) {
              const gname = (grp.name || '').toLowerCase();
              for (const bkt of (grp.buckets || [])) {
                if (!fallbackBucket) fallbackBucket = bkt;
                const bname = (bkt.name || '').toLowerCase();
                const is5h = bname.includes('5h') || bname.includes('5 hour') || bname.includes('five') || bkt.window === '5h' || (bkt.bucket_id || '').includes('5h');
                const isWeekly = bname.includes('weekly') || bname.includes('week') || bname.includes('周') || bkt.window === 'weekly' || (bkt.bucket_id || '').includes('weekly');

                if (gname.includes('gemini') || bname.includes('gemini') || (bkt.bucket_id || '').includes('gemini')) {
                  if (is5h) gemini5hBucket = bkt;
                  if (isWeekly) geminiWeeklyBucket = bkt;
                } else if (!gname.includes('claude') && !gname.includes('gpt') && !gname.includes('3p')) {
                  if (is5h) codex5hBucket = bkt;
                  if (isWeekly) codexWeeklyBucket = bkt;
                }
              }
            }

            // 构建精细的双指示条渲染
            let metersHtml = '';
            if (isBlocked) {
              metersHtml = `<div class="account-health-warning">${escapeHtml(health.detail || health.label || 'CPA 报告凭据不可用')} · 额度已隐藏</div>`;
            } else if (acc.raw_error) {
              metersHtml = `<div class="account-health-warning" style="color:var(--danger); font-size:11px;" title="${escapeHtml(acc.raw_error)}">${escapeHtml(acc.raw_error)}</div>`;
            } else if ((acc.provider === 'antigravity' && !Number.isFinite(gemini5hBucket?.remaining_percent)) || (acc.provider === 'codex' && !Number.isFinite(codex5hBucket?.remaining_percent))) {
              metersHtml = '<div class="account-quota-unknown">额度未知，等待上游返回有效数据</div>';
            } else if (acc.provider === 'opencode') {
              const todayCount = Number.isFinite(acc.today_requests) ? acc.today_requests : 0;
              const todayTokens = Number.isFinite(acc.today_tokens) ? acc.today_tokens : 0;

              metersHtml = `
                <div class="compact-meter-wrap" style="display:flex; flex-direction:column; justify-content:center; gap:2px;" title="OpenCode 今日调用量统计">
                  <div style="display:flex; justify-content:space-between; align-items:center; font-size:11.5px;">
                    <span style="color:var(--text-muted); font-size:11px;">今日消耗</span>
                    <span style="font-family:var(--mono); font-weight:700; color:var(--text-main);">
                      <span style="color:#0ea5e9; font-size:13px;">${formatTokens(todayTokens)}</span>
                      <span style="color:var(--text-dim); font-size:10.5px;"> Tokens</span>
                    </span>
                  </div>
                  <div style="display:flex; justify-content:space-between; align-items:center; font-size:10.5px; color:var(--text-dim);">
                    <span>今日请求: <b style="font-family:var(--mono); color:var(--text-muted);">${todayCount}</b> 次</span>
                    <span>自然日累计</span>
                  </div>
                </div>
              `;
            } else if (acc.provider === 'openrouter') {
              const todayCount = Number.isFinite(acc.today_requests) ? acc.today_requests : 0;
              const resetTxt = (acc.reset_time || acc.reset_countdown) ? escapeHtml(acc.reset_countdown || (formatResetAbs(acc.reset_time) + '刷新')) : '00:00 UTC';

              metersHtml = `
                <div class="compact-meter-wrap" style="display:flex; flex-direction:column; justify-content:center; gap:2px;" title="OpenRouter 今日模型调用次数统计 (UTC 00:00 - 24:00)">
                  <div style="display:flex; justify-content:space-between; align-items:center; font-size:11.5px;">
                    <span style="color:var(--text-muted); font-size:11px;">今日调用</span>
                    <span style="font-family:var(--mono); font-weight:700; color:var(--text-main);">
                      <span style="color:#3b82f6; font-size:13.5px;">${todayCount}</span>
                      <span style="color:var(--text-dim); font-size:11px;"> 次</span>
                    </span>
                  </div>
                  <div style="display:flex; justify-content:space-between; align-items:center; font-size:10.5px; color:var(--text-dim);">
                    <span>统计周期: UTC日</span>
                    <span style="font-family:var(--mono);" ${acc.reset_time ? `data-reset-time="${escapeHtml(acc.reset_time)}"` : ''}>重置: ${resetTxt}</span>
                  </div>
                </div>
              `;
            } else if (acc.provider === 'workbuddy' || acc.provider === 'workbuddy-cn') {
              const remainCredits = Number(acc.remaining_credits) || 0;
              const totalCredits = Number(acc.total_credits) || 0;
              const usedCredits = Number(acc.used_credits) || 0;
              const pct = totalCredits > 0 ? Math.max(0, Math.min(100, Math.round((remainCredits / totalCredits) * 1000) / 10)) : (remainCredits > 0 ? 100 : 0);
              let cls = 'meter-high'; let col = '#10b981';
              if (pct <= 20) { cls = 'meter-low'; col = '#ef4444'; }
              else if (pct <= 50) { cls = 'meter-medium'; col = '#f59e0b'; }

              const expInfo = getWorkBuddyExpirationInfo(acc);

              metersHtml = `
                <div class="compact-meter-wrap" style="display:flex; flex-direction:column; justify-content:center; gap:3px;" title="${escapeHtml(expInfo.tooltip || `腾讯 WorkBuddy 官方资源包积分 (剩余: ${remainCredits} / 总额: ${totalCredits})`)}">
                  <div style="display:flex; justify-content:space-between; align-items:center; font-size:11px;">
                    <span style="color:var(--text-muted); font-size:10.5px;">资源包积分</span>
                    <span style="font-family:var(--mono); font-weight:700; color:${col};">
                      剩余 ${remainCredits.toLocaleString(undefined, {minimumFractionDigits: 0, maximumFractionDigits: 2})} 积分
                    </span>
                  </div>
                  <div class="quota-meter-bar" style="height:4px;">
                    <div class="quota-meter-fill ${cls}" style="width: ${pct}%"></div>
                  </div>
                  <div style="display:flex; justify-content:space-between; align-items:center; font-size:10px; color:var(--text-dim); font-family:var(--mono);">
                    <span>总额: ${totalCredits.toLocaleString()} 积分</span>
                    <span>已用: ${usedCredits.toLocaleString(undefined, {minimumFractionDigits: 0, maximumFractionDigits: 2})}</span>
                  </div>
                  <div style="display:flex; justify-content:space-between; align-items:center; font-size:9.5px; color:var(--text-dim); font-family:var(--mono); margin-top:1px; padding-top:2px; border-top:1px dashed var(--border-subtle, rgba(0,0,0,0.06));" title="${escapeHtml(expInfo.tooltip)}">
                    <span>${expInfo.isAllLongTerm ? '积分额度' : (expInfo.hasMultiplePackages ? `分批到期 <span style="font-size:9px; opacity:0.8;">(${expInfo.packageCount}批)</span>` : '截至到期')}</span>
                    <span style="color:${expInfo.color}; font-weight:600;">
                      ${expInfo.hasMultiplePackages && !expInfo.isAllLongTerm ? '首批 ' : ''}${escapeHtml(expInfo.shortText)}${expInfo.countdown ? ` <span style="font-size:9px; font-weight:normal; opacity:0.85;">(${escapeHtml(expInfo.countdown)})</span>` : ''}
                    </span>
                  </div>
                </div>
              `;
            } else if (!Number.isFinite(fallbackBucket?.remaining_percent)) {
              metersHtml = '<div class="account-quota-unknown">额度未知，等待 CPA 返回有效数据</div>';
            } else if (acc.provider === 'antigravity') {
              const b1 = gemini5hBucket;
              const b2 = geminiWeeklyBucket;

              const rem1 = b1.remaining_percent;
              let cls1 = 'meter-high'; let col1 = '#10b981';
              if (rem1 <= 25) { cls1 = 'meter-low'; col1 = '#ef4444'; }
              else if (rem1 <= 60) { cls1 = 'meter-medium'; col1 = '#f59e0b'; }
              const txt1 = (b1?.reset_time || b1?.reset_countdown) ? escapeHtml(b1.reset_countdown || (formatResetAbs(b1.reset_time) + '刷新')) : '待激活';

              let col2Html = '';
              if (b2 && Number.isFinite(b2.remaining_percent)) {
                const rem2 = b2.remaining_percent;
                let cls2 = 'meter-high'; let col2 = '#10b981';
                if (rem2 <= 25) { cls2 = 'meter-low'; col2 = '#ef4444'; }
                else if (rem2 <= 60) { cls2 = 'meter-medium'; col2 = '#f59e0b'; }
                const txt2 = (b2?.reset_time || b2?.reset_countdown) ? escapeHtml(b2.reset_countdown || (formatResetAbs(b2.reset_time) + '刷新')) : '待激活';

                col2Html = `
                  <div class="compact-meter-wrap" title="Gemini 自然周总限额">
                    <div style="display:flex; justify-content:space-between; align-items:center; font-size:11px;">
                      <span style="color:var(--text-muted); font-size:10.5px;">Gemini 周限额</span>
                      <span style="font-family:var(--mono); font-weight:700; color:${col2};">剩余 ${rem2}%</span>
                    </div>
                    <div class="quota-meter-bar" style="height:4px;">
                      <div class="quota-meter-fill ${cls2}" style="width: ${rem2}%"></div>
                    </div>
                    <span style="font-family:var(--mono); font-size:10px; color:var(--text-dim); text-align:right;">${txt2}</span>
                  </div>
                `;
              }

              metersHtml = `
                <div class="compact-meter-wrap" title="Gemini 官方 5 小时滑动限额">
                  <div style="display:flex; justify-content:space-between; align-items:center; font-size:11px;">
                    <span style="color:var(--text-muted); font-size:10.5px;">Gemini 5h</span>
                    <span style="font-family:var(--mono); font-weight:700; color:${col1};">剩余 ${rem1}%</span>
                  </div>
                  <div class="quota-meter-bar" style="height:4px;">
                    <div class="quota-meter-fill ${cls1}" style="width: ${rem1}%"></div>
                  </div>
                  <span style="font-family:var(--mono); font-size:10px; color:var(--text-dim); text-align:right;" ${b1?.reset_time ? `data-reset-time="${escapeHtml(b1.reset_time)}"` : ''}>${txt1}</span>
                </div>
                ${col2Html}
              `;
            } else if (acc.provider === 'codex') {
              const b1 = codex5hBucket;
              const b2 = codexWeeklyBucket;

              const rem1 = b1.remaining_percent;
              let cls1 = 'meter-high'; let col1 = '#10b981';
              if (rem1 <= 25) { cls1 = 'meter-low'; col1 = '#ef4444'; }
              else if (rem1 <= 60) { cls1 = 'meter-medium'; col1 = '#f59e0b'; }
              const txt1 = (b1?.reset_time || b1?.reset_countdown) ? escapeHtml(b1.reset_countdown || (formatResetAbs(b1.reset_time) + '刷新')) : '待激活';

              let col2Html = '';
              if (b2 && Number.isFinite(b2.remaining_percent)) {
                const rem2 = b2.remaining_percent;
                let cls2 = 'meter-high'; let col2 = '#10b981';
                if (rem2 <= 25) { cls2 = 'meter-low'; col2 = '#ef4444'; }
                else if (rem2 <= 60) { cls2 = 'meter-medium'; col2 = '#f59e0b'; }
                const txt2 = (b2?.reset_time || b2?.reset_countdown) ? escapeHtml(b2.reset_countdown || (formatResetAbs(b2.reset_time) + '刷新')) : '待激活';

                col2Html = `
                  <div class="compact-meter-wrap" title="Codex 官方自然周用量限额">
                    <div style="display:flex; justify-content:space-between; align-items:center; font-size:11px;">
                      <span style="color:var(--text-muted); font-size:10.5px;">周限额</span>
                      <span style="font-family:var(--mono); font-weight:700; color:${col2};">剩余 ${rem2}%</span>
                    </div>
                    <div class="quota-meter-bar" style="height:4px;">
                      <div class="quota-meter-fill ${cls2}" style="width: ${rem2}%"></div>
                    </div>
                    <span style="font-family:var(--mono); font-size:10px; color:var(--text-dim); text-align:right;" ${b2?.reset_time ? `data-reset-time="${escapeHtml(b2.reset_time)}"` : ''}>${txt2}</span>
                  </div>
                `;
              }

              metersHtml = `
                <div class="compact-meter-wrap" title="Codex 官方 5 小时滑动限额">
                  <div style="display:flex; justify-content:space-between; align-items:center; font-size:11px;">
                    <span style="color:var(--text-muted); font-size:10.5px;">5 小时限额</span>
                    <span style="font-family:var(--mono); font-weight:700; color:${col1};">剩余 ${rem1}%</span>
                  </div>
                  <div class="quota-meter-bar" style="height:4px;">
                    <div class="quota-meter-fill ${cls1}" style="width: ${rem1}%"></div>
                  </div>
                  <span style="font-family:var(--mono); font-size:10px; color:var(--text-dim); text-align:right;" ${b1?.reset_time ? `data-reset-time="${escapeHtml(b1.reset_time)}"` : ''}>${txt1}</span>
                </div>
                ${col2Html}
              `;
            } else {
              const b1 = fallbackBucket;
              const rem1 = b1.remaining_percent;
              let cls1 = 'meter-high'; let col1 = '#10b981';
              if (rem1 <= 25) { cls1 = 'meter-low'; col1 = '#ef4444'; }
              else if (rem1 <= 60) { cls1 = 'meter-medium'; col1 = '#f59e0b'; }
              const bname = b1 ? formatBucketLabel(b1.name, b1.window) : '标准配额';
              const txt1 = (b1?.reset_time || b1?.reset_countdown) ? escapeHtml(b1.reset_countdown || (formatResetAbs(b1.reset_time) + '刷新')) : '待激活';

              metersHtml = `
                <div class="compact-meter-wrap">
                  <div style="display:flex; justify-content:space-between; align-items:center; font-size:11px;">
                    <span style="color:var(--text-muted); font-size:10.5px;">${escapeHtml(bname)}</span>
                    <span style="font-family:var(--mono); font-weight:700; color:${col1};">剩余 ${rem1}%</span>
                  </div>
                  <div class="quota-meter-bar" style="height:4px;">
                    <div class="quota-meter-fill ${cls1}" style="width: ${rem1}%"></div>
                  </div>
                  <span style="font-family:var(--mono); font-size:10px; color:var(--text-dim); text-align:right;" ${b1?.reset_time ? `data-reset-time="${escapeHtml(b1.reset_time)}"` : ''}>${txt1}</span>
                </div>
              `;
            }

            const valInfo = acc.validation;
            const hasValidation = Boolean(valInfo && valInfo.status === 'pending');
            const safeValUrl = valInfo && valInfo.validation_url ? escapeHtml(valInfo.validation_url) : '';
            const accountTitle = (acc.display_name || acc.email || acc.filename || '').replace(/\.json$/i, '');
            const fullTip = acc.email && acc.email !== accountTitle ? `${accountTitle} (${acc.email})` : accountTitle;

            return `
              <div class="compact-account-row ${isDisabled ? 'is-disabled' : ''}" style="${hasValidation ? 'border-color:rgba(239,68,68,0.5); background:rgba(239,68,68,0.03);' : ''}">
                <div class="compact-left">
                  <div class="provider-icon-badge ${brand.iconClass}" title="${escapeHtml(brand.name)}">${brand.iconSvg}</div>
                  <div style="display:flex; flex-direction:column; min-width:0; gap:2px;">
                    <div style="display:flex; align-items:center; gap:6px; flex-wrap:nowrap;">
                      <span class="provider-pill ${brand.pillClass}" style="font-size:10px; padding:1px 5px;">${escapeHtml(brand.name)}</span>
                      <span class="priority-badge ${prioCls}">P${prio}</span>
                      <span style="font-weight:600; font-size:12.5px; color:var(--text-main); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(fullTip)}">
                        ${escapeHtml(accountTitle)}
                      </span>
                      ${isDisabled ? '<span class="chip chip-red" style="font-size:10px; padding:1px 5px; line-height:1.2; white-space:nowrap; flex-shrink:0;">已停用</span>' : ''}
                      ${isBlocked && !isDisabled ? `<span class="chip chip-red" style="font-size:10px; padding:1px 5px; line-height:1.2;">${escapeHtml(health.label)}</span>` : ''}
                      ${hasValidation ? '<span class="chip chip-red" style="font-size:10px; padding:1px 5px; line-height:1.2; white-space:nowrap; flex-shrink:0; background:rgba(239,68,68,0.15); border:1px solid rgba(239,68,68,0.3); animation:pulse 2s infinite;">⚠️ 需 Google 验证</span>' : ''}
                    </div>
                    <div style="font-size:10.5px; font-family:var(--mono); color:var(--text-dim);">
                      ID: ${acc.auth_index ? escapeHtml(String(acc.auth_index).slice(0, 12)) : '—'} ${isBlocked ? '' : `· <span class="account-card-plan ${planClass}" style="padding:0 5px; font-size:9.5px;">${escapeHtml(acc.plan_name || acc.plan_type)}</span>`}
                    </div>
                  </div>
                </div>

                <div class="compact-mid">
                  ${metersHtml}
                </div>

                <div class="compact-right">
                  ${hasValidation ? `
                    <a href="${safeValUrl}" target="_blank" rel="noopener noreferrer" class="priority-btn" style="color:#ef4444; border-color:rgba(239,68,68,0.4); background:rgba(239,68,68,0.08); padding:3px 9px; font-size:11px; text-decoration:none; display:inline-flex; align-items:center; gap:4px;" title="在浏览器中打开验证链接完成 Google 账号验证">
                      去验证 ↗
                    </a>
                    <button class="priority-btn" style="color:#10b981; border-color:rgba(16,185,129,0.3); background:rgba(16,185,129,0.06); padding:3px 7px; font-size:11px;" onclick="resolveValidation(${valInfo.id})" title="已完成验证，清除提示">
                      已验证
                    </button>
                  ` : ''}
                  ${isBlocked ? '' : `<button class="priority-btn" style="color:#2563eb; border-color:rgba(37,99,235,0.3); background:rgba(37,99,235,0.06); padding:3px 9px; font-size:11px;" data-filename="${safeFilename}" data-provider="${escapeHtml(acc.provider || '')}" data-authindex="${escapeHtml(acc.auth_index || '')}" onclick="triggerActivateQuotaWindow(this.dataset.filename, this.dataset.provider, this.dataset.authindex)" title="重新查询上游额度">
                    刷新额度
                  </button>`}
                  <button class="priority-btn" style="padding:3px 8px; font-size:11px;" data-filename="${safeFilename}" onclick="openPriorityModal(this.dataset.filename)" title="调整调度优先级与启停状态">
                    调整
                  </button>
                </div>
              </div>
            `;
          }).join('');
        }
      } else {
        if (compactContainer) compactContainer.style.display = 'none';
        if (cardsContainer) {
          cardsContainer.style.display = 'grid';
          cardsContainer.innerHTML = filtered.map(acc => {
            const safeFilename = escapeHtml(acc.filename || acc.id || '');
            const brand = getProviderBrand(acc.provider);
            const planType = (acc.plan_type || 'free').toLowerCase();
            let planClass = 'plan-free';
            if (planType.includes('pro') || planType.includes('ultra')) planClass = 'plan-pro';
            else if (planType.includes('plus')) planClass = 'plan-plus';

            const isDisabled = Boolean(acc.disabled || acc.status === 'disabled');
            const health = acc.health || {};
            const isBlocked = health.blocked === true;
            const stRaw = String(acc.status || '').toLowerCase();
            const stColor = (isBlocked || isDisabled || stRaw.includes('error') || stRaw.includes('invalid')) ? 'var(--danger)' : 'var(--success)';
            const prio = normalizeAuthPriority(acc.priority);
            const prioCls = prio >= 20 ? 'p-high' : (prio >= 10 ? 'p-normal' : 'p-low');

            // 渲染模型组
            const groupsHtml = (acc.groups || []).filter(grp => Array.isArray(grp.buckets) && grp.buckets.some(bkt => Number.isFinite(bkt.remaining_percent))).map(grp => {
              const gname = escapeHtml(grp.name);
              const bucketsHtml = (grp.buckets || []).filter(bkt => Number.isFinite(bkt.remaining_percent)).map(bkt => {
                const rem = bkt.remaining_percent;
                let meterClass = 'meter-high';
                let remColor = '#10b981';
                if (rem <= 25) { meterClass = 'meter-low'; remColor = '#ef4444'; }
                else if (rem <= 60) { meterClass = 'meter-medium'; remColor = '#f59e0b'; }

                const bktDispName = formatBucketLabel(bkt.name, bkt.window);

                return `
                  <div class="quota-meter-row">
                    <div class="quota-meter-header">
                      <span class="quota-window-name">${escapeHtml(bktDispName)}</span>
                      <span class="quota-window-rem" style="color:${remColor};">剩余 ${rem}%</span>
                    </div>
                    <div class="quota-meter-bar">
                      <div class="quota-meter-fill ${meterClass}" style="width: ${rem}%"></div>
                    </div>
                    ${(bkt.reset_time || bkt.reset_countdown) ? `
                      <div class="quota-meter-footer">
                        <span class="quota-reset-abs" title="预计配额重置的本地时刻">${bkt.reset_time ? '预计 ' + escapeHtml(formatResetAbs(bkt.reset_time)) + ' 刷新' : '&nbsp;'}</span>
                        <div style="display:flex; align-items:center; gap:6px;">
                          <span ${bkt.reset_time ? `data-reset-time="${escapeHtml(bkt.reset_time)}"` : ''}>${escapeHtml(bkt.reset_countdown || '')}</span>
                          <button class="btn-activate-5h btn-mini" data-filename="${safeFilename}" data-provider="${escapeHtml(acc.provider || '')}" data-authindex="${escapeHtml(acc.auth_index || '')}" onclick="triggerActivateQuotaWindow(this.dataset.filename, this.dataset.provider, this.dataset.authindex)" title="重新查询上游额度">
                            刷新额度
                          </button>
                        </div>
                      </div>
                    ` : `
                      <div class="quota-meter-footer" style="justify-content:flex-end;">
                        <button class="btn-activate-5h btn-mini" data-filename="${safeFilename}" data-provider="${escapeHtml(acc.provider || '')}" data-authindex="${escapeHtml(acc.auth_index || '')}" onclick="triggerActivateQuotaWindow(this.dataset.filename, this.dataset.provider, this.dataset.authindex)" title="重新查询上游额度">
                          刷新额度
                        </button>
                      </div>
                    `}
                  </div>
                `;
              }).join('');

              return `
                <div class="model-group-section">
                  <div class="model-group-title">${gname}</div>
                  ${bucketsHtml}
                </div>
              `;
            }).join('');

            const valInfo = acc.validation;
            const hasValidation = Boolean(valInfo && valInfo.status === 'pending');
            const safeValUrl = valInfo && valInfo.validation_url ? escapeHtml(valInfo.validation_url) : '';

            let quotaSectionHtml = '';
            if (isBlocked) {
              quotaSectionHtml = `<div class="account-health-warning">${escapeHtml(health.detail || health.label || 'CPA 报告凭据不可用')} · 额度已隐藏</div>`;
            } else if (acc.provider === 'opencode') {
              const todayCount = Number.isFinite(acc.today_requests) ? acc.today_requests : 0;
              const todayTokens = Number.isFinite(acc.today_tokens) ? acc.today_tokens : 0;

              quotaSectionHtml = `
                <div class="model-group-section" style="margin-top:8px;">
                  <div class="model-group-title" style="display:flex; justify-content:space-between; align-items:center;">
                    <span>OpenCode 今日调用统计</span>
                    <span style="font-size:11px; font-weight:normal; color:var(--text-dim);">自然日累计</span>
                  </div>
                  <div style="background:var(--bg-subtle, rgba(0,0,0,0.02)); border:1px solid var(--border-subtle, rgba(0,0,0,0.06)); border-radius:8px; padding:12px 14px; margin-top:6px; display:flex; justify-content:space-between; align-items:center;">
                    <div>
                      <div style="font-size:11px; color:var(--text-muted); margin-bottom:2px;">今日 Token 消耗</div>
                      <div style="font-family:var(--mono); line-height:1.2;">
                        <span style="font-size:24px; font-weight:700; color:#0ea5e9;">${formatTokens(todayTokens)}</span>
                        <span style="font-size:12px; color:var(--text-dim); font-weight:normal;" title="${todayTokens.toLocaleString()} Tokens"> Tokens</span>
                      </div>
                    </div>
                    <div style="text-align:right;">
                      <div style="font-size:11px; color:var(--text-muted); margin-bottom:2px;">今日请求次数</div>
                      <div style="font-family:var(--mono); line-height:1.2;">
                        <span style="font-size:22px; font-weight:700; color:var(--text-main);">${todayCount}</span>
                        <span style="font-size:12px; color:var(--text-dim); font-weight:normal;"> 次</span>
                      </div>
                    </div>
                  </div>
                  ${acc.raw_error ? `<div class="account-health-warning" style="color:var(--danger); margin-top:6px; font-size:11px;">${escapeHtml(acc.raw_error)}</div>` : ''}
                </div>
              `;
            } else if (acc.provider === 'openrouter') {
              const todayCount = Number.isFinite(acc.today_requests) ? acc.today_requests : 0;
              const resetTxt = (acc.reset_time || acc.reset_countdown) ? escapeHtml(acc.reset_countdown || (formatResetAbs(acc.reset_time) + '刷新')) : '00:00 UTC';

              quotaSectionHtml = `
                <div class="model-group-section" style="margin-top:8px;">
                  <div class="model-group-title" style="display:flex; justify-content:space-between; align-items:center;">
                    <span>OpenRouter 模型调用统计</span>
                    <span style="font-size:11px; font-weight:normal; color:var(--text-dim);" ${acc.reset_time ? `data-reset-time="${escapeHtml(acc.reset_time)}"` : ''}>重置: ${resetTxt}</span>
                  </div>
                  <div style="background:var(--bg-subtle, rgba(0,0,0,0.02)); border:1px solid var(--border-subtle, rgba(0,0,0,0.06)); border-radius:8px; padding:12px 14px; margin-top:6px; display:flex; justify-content:space-between; align-items:center;">
                    <div>
                      <div style="font-size:11px; color:var(--text-muted); margin-bottom:2px;">今日已调用</div>
                      <div style="font-family:var(--mono); line-height:1.2;">
                        <span style="font-size:24px; font-weight:700; color:#3b82f6;">${todayCount}</span>
                        <span style="font-size:13px; color:var(--text-dim); font-weight:normal;"> 次</span>
                      </div>
                    </div>
                    <div style="text-align:right;">
                      <div style="font-size:11px; color:var(--text-dim);">统计区间</div>
                      <div style="font-size:11.5px; font-family:var(--mono); color:var(--text-muted); margin-top:2px;">UTC 00:00 - 24:00</div>
                    </div>
                  </div>
                  ${acc.raw_error ? `<div class="account-health-warning" style="color:var(--danger); margin-top:6px; font-size:11px;">${escapeHtml(acc.raw_error)}</div>` : ''}
                </div>
              `;
            } else if (acc.provider === 'workbuddy' || acc.provider === 'workbuddy-cn') {
              const remainCredits = Number(acc.remaining_credits) || 0;
              const totalCredits = Number(acc.total_credits) || 0;
              const usedCredits = Number(acc.used_credits) || 0;
              const pct = totalCredits > 0 ? Math.max(0, Math.min(100, Math.round((remainCredits / totalCredits) * 1000) / 10)) : (remainCredits > 0 ? 100 : 0);
              let meterClass = 'meter-high'; let remColor = '#10b981';
              if (pct <= 20) { meterClass = 'meter-low'; remColor = '#ef4444'; }
              else if (pct <= 50) { meterClass = 'meter-medium'; remColor = '#f59e0b'; }

              const expInfo = getWorkBuddyExpirationInfo(acc);

              quotaSectionHtml = `
                <div class="model-group-section" style="margin-top:8px;">
                  <div class="model-group-title" style="display:flex; justify-content:space-between; align-items:center;">
                    <span>WorkBuddy 资源包与积分额度</span>
                    <span style="font-size:11px; font-weight:normal; color:var(--text-dim);">腾讯官方计量</span>
                  </div>
                  <div style="background:var(--bg-subtle, rgba(0,0,0,0.02)); border:1px solid var(--border-subtle, rgba(0,0,0,0.06)); border-radius:8px; padding:12px 14px; margin-top:6px;">
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                      <div>
                        <div style="font-size:11px; color:var(--text-muted); margin-bottom:2px;">当前可用积分</div>
                        <div style="font-family:var(--mono); line-height:1.2;">
                          <span style="font-size:24px; font-weight:700; color:${remColor};">${remainCredits.toLocaleString(undefined, {minimumFractionDigits: 0, maximumFractionDigits: 2})}</span>
                          <span style="font-size:13px; color:var(--text-dim); font-weight:normal;"> 积分</span>
                        </div>
                      </div>
                      <div style="text-align:right;">
                        <div style="font-size:11px; color:var(--text-dim);">总容量 / 剩余率</div>
                        <div style="font-size:13px; font-family:var(--mono); color:var(--text-main); font-weight:600; margin-top:2px;">
                          ${totalCredits.toLocaleString()} 积分 · <span style="color:${remColor};">${pct}%</span>
                        </div>
                      </div>
                    </div>
                    <div class="quota-meter-bar" style="margin-top:10px; height:6px;">
                      <div class="quota-meter-fill ${meterClass}" style="width: ${pct}%"></div>
                    </div>
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-top:6px; font-size:10.5px; color:var(--text-dim); font-family:var(--mono);">
                      <span>已消耗: ${usedCredits.toLocaleString(undefined, {minimumFractionDigits: 0, maximumFractionDigits: 2})} 积分</span>
                      <span>周期资源包</span>
                    </div>
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-top:8px; padding-top:8px; border-top:1px dashed var(--border-subtle, rgba(0,0,0,0.06)); font-size:11px;">
                      <span style="color:var(--text-muted); display:inline-flex; align-items:center; gap:4px;">
                        <span>⏱️ ${expInfo.isAllLongTerm ? '积分额度' : (expInfo.hasMultiplePackages ? `积分分批到期 <span style="font-size:10px; opacity:0.8;">(共 ${expInfo.packageCount} 批)</span>` : '积分截至到期')}</span>
                      </span>
                      <span style="font-family:var(--mono); font-weight:600; color:${expInfo.color};" title="${escapeHtml(expInfo.tooltip)}">
                        ${expInfo.hasMultiplePackages && !expInfo.isAllLongTerm ? '首批 ' : ''}${escapeHtml(expInfo.shortText)}${expInfo.countdown ? ` <span style="font-weight:normal; font-size:10px; opacity:0.85;">(${escapeHtml(expInfo.countdown)})</span>` : ''}
                      </span>
                    </div>
                    ${expInfo.hasMultiplePackages ? `
                      <div style="margin-top:8px; display:flex; flex-direction:column; gap:5px; padding:8px 10px; background:var(--bg-subtle, rgba(0,0,0,0.02)); border-radius:6px; border:1px solid var(--border-subtle, rgba(0,0,0,0.06)); font-size:10.5px; font-family:var(--mono);">
                        ${expInfo.packages.map((pkg, pIdx) => `
                          <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;" title="资源包 [${escapeHtml(pkg.name)}]: 可用 ${pkg.points} 积分，截至 ${escapeHtml(pkg.fullText || pkg.shortText)}">
                            <span style="color:var(--text-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:${pkg.isLongTerm ? '72%' : '55%'};">
                              <b style="color:var(--text-dim); font-weight:600;">${pIdx + 1}.</b> ${escapeHtml(pkg.name)} <span style="font-weight:600; color:var(--text-main);">${pkg.points} 积分</span>
                            </span>
                            <span style="color:${pkg.color}; font-weight:500; flex-shrink:0;">
                              ${escapeHtml(pkg.shortText)}${pkg.countdown ? ` <span style="font-size:9.5px; opacity:0.85;">(${escapeHtml(pkg.countdown)})</span>` : ''}
                            </span>
                          </div>
                        `).join('')}
                      </div>
                    ` : ''}
                  </div>
                  ${acc.raw_error ? `<div class="account-health-warning" style="color:var(--danger); margin-top:6px; font-size:11px;">${escapeHtml(acc.raw_error)}</div>` : ''}
                </div>
              `;
            } else if (groupsHtml) {
              quotaSectionHtml = groupsHtml;
            } else if (acc.raw_error) {
              quotaSectionHtml = `<div class="account-health-warning" style="color:var(--danger);">${escapeHtml(acc.raw_error)}</div>`;
            } else {
              quotaSectionHtml = '<div class="account-quota-unknown">额度未知，等待 CPA 返回有效数据</div>';
            }

            const accountCardTitle = (acc.display_name || acc.email || acc.filename || '').replace(/\.json$/i, '');
            const cardFullTip = acc.email && acc.email !== accountCardTitle ? `${accountCardTitle} (${acc.email})` : accountCardTitle;

            return `
              <div class="account-card ${isDisabled ? 'is-disabled' : ''}" style="${hasValidation ? 'border-color:rgba(239,68,68,0.5); box-shadow:0 0 12px rgba(239,68,68,0.15);' : ''}">
                <div class="account-card-header">
                  <div class="account-card-title-wrap">
                    <div class="provider-icon-badge ${brand.iconClass}" title="${escapeHtml(brand.name)}">${brand.iconSvg}</div>
                    <div style="display:flex; flex-direction:column; min-width:0; gap:3px;">
                      <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                        <span class="provider-pill ${brand.pillClass}">${escapeHtml(brand.name)}</span>
                        <span class="priority-badge ${prioCls}" title="调度优先级数值：越高越先调度">P${prio}</span>
                        ${isDisabled ? '<span class="chip chip-red" style="font-size:10.5px; padding:1px 6px; line-height:1.2; white-space:nowrap; flex-shrink:0;">已停用</span>' : ''}
                        ${isBlocked && !isDisabled ? `<span class="chip chip-red" style="font-size:10.5px; padding:1px 6px; line-height:1.2;">${escapeHtml(health.label)}</span>` : ''}
                        ${hasValidation ? '<span class="chip chip-red" style="font-size:10.5px; padding:1px 6px; line-height:1.2; white-space:nowrap; flex-shrink:0; background:rgba(239,68,68,0.15); border:1px solid rgba(239,68,68,0.3); animation:pulse 2s infinite;">⚠️ 需 Google 验证</span>' : ''}
                      </div>
                      <div class="account-card-email" title="${escapeHtml(cardFullTip)}">${escapeHtml(accountCardTitle)}</div>
                    </div>
                  </div>
                  <div style="display:flex; align-items:center; gap:6px;">
                    ${hasValidation ? `
                      <a href="${safeValUrl}" target="_blank" rel="noopener noreferrer" class="priority-btn" style="color:#ef4444; border-color:rgba(239,68,68,0.4); background:rgba(239,68,68,0.08); text-decoration:none; display:inline-flex; align-items:center; gap:4px;" title="在浏览器中打开验证链接完成 Google 账号验证">
                        去验证 ↗
                      </a>
                      <button class="priority-btn" style="color:#10b981; border-color:rgba(16,185,129,0.3); background:rgba(16,185,129,0.06);" onclick="resolveValidation(${valInfo.id})" title="已完成验证，清除提示">
                        已验证
                      </button>
                    ` : ''}
                    ${isBlocked ? '' : `<button class="priority-btn" style="color:#2563eb; border-color:rgba(37,99,235,0.35); background:rgba(37,99,235,0.06);" data-filename="${safeFilename}" data-provider="${escapeHtml(acc.provider || '')}" data-authindex="${escapeHtml(acc.auth_index || '')}" onclick="triggerActivateQuotaWindow(this.dataset.filename, this.dataset.provider, this.dataset.authindex)" title="重新查询上游额度">
                      刷新额度
                    </button>`}
                    <button class="priority-btn" data-filename="${safeFilename}" onclick="openPriorityModal(this.dataset.filename)" title="调整此账号的调度优先级与启停状态">
                      <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" style="width:12px;height:12px;"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4"/></svg>
                      调整
                    </button>
                    ${isBlocked ? '' : `<span class="account-card-plan ${planClass}">${escapeHtml(acc.plan_name || acc.plan_type)}</span>`}
                  </div>
                </div>
                <div class="account-card-subinfo">
                  <span title="${safeFilename}">凭据: ${acc.auth_index ? '<b class="num">' + escapeHtml(String(acc.auth_index).slice(0, 8)) + '</b>' : '—'}</span>
                  <span>状态: <b style="color:${stColor};">${isBlocked ? escapeHtml(health.label) : (isDisabled ? '已停用' : escapeHtml(acc.status))}</b></span>
                </div>
                ${hasValidation ? `
                  <div style="background:rgba(239,68,68,0.06); border:1px solid rgba(239,68,68,0.2); border-radius:6px; padding:8px 10px; margin:4px 0 10px 0; font-size:11.5px; display:flex; justify-content:space-between; align-items:center;">
                    <div style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:70%;">
                      <span style="color:var(--danger); font-weight:600;">验证要求:</span>
                      <span style="color:var(--text-main); margin-left:4px;">${escapeHtml(valInfo.error_message || 'Verify your account')}</span>
                    </div>
                    <a href="${safeValUrl}" target="_blank" rel="noopener noreferrer" style="color:var(--accent); text-decoration:underline; font-weight:600;">打开验证页 ↗</a>
                  </div>
                ` : ''}
                ${quotaSectionHtml}
              </div>
            `;
          }).join('');
        }
      }
    }

    // 0.6 获取上游凭证用量与成功率统计 (对齐 Keeper 统计视图，支持 5h / 24h / 7d / all)
    async function fetchUpstreamAuthStats() {
      const secret = getAdminSecret();
      if (!secret) return;
      try {
        const range = activeUpstreamStatsRange || 'all';
        const res = await fetch(`/admin/api/upstream-auth-stats?range=${encodeURIComponent(range)}`, {
          headers: { 'Authorization': 'Bearer ' + secret }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        cachedUpstreamStats = await res.json();
        renderUpstreamStatsTable();
      } catch (err) {
        const container = document.getElementById('upstream-stats-cards-container');
        if (container) {
          container.innerHTML = '<div style="grid-column: 1 / -1; text-align:center; padding:36px 16px; color:var(--text-dim);">统计暂不可用。请检查密钥或稍后刷新。</div>';
        }
        const archiveContainer = document.getElementById('upstream-stats-archive-container');
        if (archiveContainer) {
          archiveContainer.style.display = 'none';
          archiveContainer.innerHTML = '';
        }
        const tbody = document.getElementById('upstream-stats-table-body');
        if (tbody) {
          tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:24px;">统计暂不可用。请检查密钥或稍后刷新。</td></tr>';
        }
        console.warn('Upstream auth stats fetch error:', err.message);
      }
    }

    function switchUpstreamStatsRange(range) {
      activeUpstreamStatsRange = range;
      const tabs = document.getElementById('upstream-stats-range-tabs');
      if (tabs) {
        tabs.querySelectorAll('button').forEach(btn => {
          const onclickAttr = btn.getAttribute('onclick') || '';
          if (onclickAttr.includes(`'${range}'`)) {
            btn.classList.add('active');
          } else {
            btn.classList.remove('active');
          }
        });
      }

      // 更新副标题提示
      const subtitle = document.getElementById('upstream-stats-subtitle');
      if (subtitle) {
        if (range === '5h') {
          subtitle.innerText = '请求数与成功率取自 CPA 运行时事实（滚动约 200 分钟窗口）· Token 与缓存率取自网关本地计量';
        } else if (range === '24h') {
          subtitle.innerText = '请求数与成功率取自 CPA 运行时事实（滚动约 200 分钟窗口）· Token 与缓存率取自网关本地计量';
        } else if (range === '7d') {
          subtitle.innerText = '请求数与成功率取自 CPA 运行时事实（滚动约 200 分钟窗口）· Token 与缓存率取自网关本地计量';
        } else {
          subtitle.innerText = '本地基线推算 · CPA 运行时仅保留约 200 分钟窗口，撑不起全部历史，请求数与成功率为估算值';
        }
      }

      const container = document.getElementById('upstream-stats-cards-container');
      if (container) {
        container.innerHTML = '<div style="grid-column: 1 / -1; text-align:center; padding:36px 16px; color:var(--text-dim);">正在加载该时间段上游用量统计...</div>';
      }
      const archiveContainer = document.getElementById('upstream-stats-archive-container');
      if (archiveContainer) {
        archiveContainer.style.display = 'none';
        archiveContainer.innerHTML = '';
      }
      const tbody = document.getElementById('upstream-stats-table-body');
      if (tbody) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:24px; color:var(--text-dim);">正在加载该时间段上游用量统计...</td></tr>';
      }

      fetchUpstreamAuthStats();
    }

    function renderUpstreamStatsTable() {
      const container = document.getElementById('upstream-stats-cards-container');
      const archiveContainer = document.getElementById('upstream-stats-archive-container');
      const tbody = document.getElementById('upstream-stats-table-body');
      const data = cachedUpstreamStats;

      if (!data || !Array.isArray(data.items) || data.items.length === 0) {
        if (container) {
          container.innerHTML = '<div style="grid-column: 1 / -1; text-align:center; padding:36px 16px; color:var(--text-dim);">暂无上游凭证用量统计数据</div>';
        }
        if (archiveContainer) {
          archiveContainer.style.display = 'none';
          archiveContainer.innerHTML = '';
        }
        if (tbody) tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:24px; color:var(--text-dim);">暂无上游凭证用量统计数据</td></tr>';
        return;
      }

      const filterVal = (document.getElementById('upstream-stats-filter')?.value || '').trim().toLowerCase();
      const filteredItems = filterVal
        ? data.items.filter(it => {
            const name = String(it.name || '').toLowerCase();
            const provider = String(it.provider || '').toLowerCase();
            const model = String(it.last_model || '').toLowerCase();
            const id = String(it.auth_index || '').toLowerCase();
            return name.includes(filterVal) || provider.includes(filterVal) || model.includes(filterVal) || id.includes(filterVal);
          })
        : data.items;

      if (filteredItems.length === 0) {
        if (container) {
          container.innerHTML = `<div style="grid-column: 1 / -1; text-align:center; padding:36px 16px; color:var(--text-dim);">未找到匹配 "${escapeHtml(filterVal)}" 的凭证卡片</div>`;
        }
        if (archiveContainer) {
          archiveContainer.style.display = 'none';
          archiveContainer.innerHTML = '';
        }
        if (tbody) tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:24px; color:var(--text-dim);">未找到匹配的凭证</td></tr>';
        return;
      }

      // 核心拆分：活跃有效凭证 vs 已从 CPA 移除的历史留痕账号（避免历史账号大面积霸屏）
      const activeItems = [];
      const deletedItems = [];

      filteredItems.forEach(it => {
        const isDel = Boolean(it.is_deleted || /^已删除账号 /.test(it.name || ''));
        if (isDel) {
          deletedItems.push(it);
        } else {
          activeItems.push(it);
        }
      });

      // 1. 渲染主卡片网格（仅呈现正常活跃账号）
      let activeCardsHtml = '';
      if (activeItems.length > 0) {
        activeCardsHtml = activeItems.map(it => {
          const brand = getProviderBrand(it.provider);
          const prio = normalizeAuthPriority(it.priority);
          const prioCls = prio >= 20 ? 'p-high' : (prio >= 10 ? 'p-normal' : 'p-low');
          const isDisabled = Boolean(it.disabled || it.status === 'disabled');
          const successRate = it.success_rate != null ? it.success_rate.toFixed(1) + '%' : '100.0%';
          const reqSourceTag = it.runtime_source === 'cpa_runtime'
            ? '<span class="ovw-source-tag">CPA</span>'
            : '';

          let rateColor = '#059669'; // 绿
          let rateBorder = '#a7f3d0';
          let rateBg = '#ecfdf5';
          if (it.success_rate < 80) {
            rateColor = '#dc2626'; // 红
            rateBorder = '#fecaca';
            rateBg = '#fef2f2';
          } else if (it.success_rate < 95) {
            rateColor = '#d97706'; // 橙
            rateBorder = '#fde68a';
            rateBg = '#fffbeb';
          }

          // 周期额度与配额水位渲染：
          // 1. WorkBuddy: 资源包积分额度 (剩余/总额/已用)
          // 2. OpenRouter: 今日请求次数与 800 次每日限额
          // 3. Antigravity / Codex: 5h 与周限额滑动窗口
          let quotaHtml = '<div style="color:var(--text-dim); font-size:11px; text-align:center; padding:3px 0;">— 暂无实时配额水位 —</div>';

          // 辅助凭证对象兜底查询 (以防 stats 接口未刷新时已有 cachedUpstream.accounts)
          const fallbackAcc = (cachedUpstream.accounts || []).find(a =>
            (it.auth_index && a.auth_index === it.auth_index) ||
            a.id === it.name ||
            a.filename === it.name ||
            (it.provider === 'openrouter' && (a.id === it.auth_index || a.name === it.name || `openrouter-${a.id}` === it.auth_index)) ||
            (it.provider === 'opencode' && (a.id === it.auth_index || a.filename === it.name || a.email === it.name))
          );

          const isWorkBuddy = it.provider === 'workbuddy' || it.provider === 'workbuddy-cn' || String(it.name || '').toLowerCase().startsWith('workbuddy');
          const isOpenRouter = it.provider === 'openrouter' || String(it.name || '').toLowerCase().startsWith('openrouter');
          const isOpenCode = it.provider === 'opencode' || String(it.name || '').toLowerCase().startsWith('opencode');

          if (isWorkBuddy) {
            const totalCredits = it.total_credits != null ? Number(it.total_credits) : (fallbackAcc?.total_credits != null ? Number(fallbackAcc.total_credits) : null);
            const remainCredits = it.remaining_credits != null ? Number(it.remaining_credits) : (fallbackAcc?.remaining_credits != null ? Number(fallbackAcc.remaining_credits) : null);
            const usedCredits = it.used_credits != null ? Number(it.used_credits) : (fallbackAcc?.used_credits != null ? Number(fallbackAcc.used_credits) : 0);

            if (remainCredits != null || totalCredits != null) {
              const total = totalCredits || 0;
              const remain = remainCredits || 0;
              const used = usedCredits || 0;
              const remPct = total > 0 ? Math.max(0, Math.min(100, Math.round((remain / total) * 1000) / 10)) : (remain > 0 ? 100 : 0);
              let barColor = '#10b981'; // 充裕 (绿)
              if (remPct <= 20) barColor = '#ef4444'; // 耗尽或濒危 (红)
              else if (remPct <= 50) barColor = '#f59e0b'; // 警戒 (黄)

              const remainFormatted = remain.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
              const totalFormatted = total.toLocaleString();
              const usedFormatted = used.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });

              const targetObj = (it && (it.expires_at || it.reset_time)) ? it : (fallbackAcc || it);
              const expInfo = getWorkBuddyExpirationInfo(targetObj);

              quotaHtml = `
                <div class="quota-box-row">
                  <span class="quota-box-title">资源包积分: <b style="color:${barColor};">剩余 ${remainFormatted}</b></span>
                  <span class="quota-box-countdown">${remPct.toFixed(1)}% 可用</span>
                </div>
                <div class="quota-progress-track">
                  <div class="quota-progress-fill" style="width:${Math.max(0, Math.min(100, remPct))}%; background:${barColor};"></div>
                </div>
                <div class="quota-weekly-row" style="display:flex; justify-content:space-between; align-items:center;">
                  <span>总额: <b>${totalFormatted}</b> 积分 · 已用: <b>${usedFormatted}</b></span>
                  <span style="color:${expInfo.color}; font-size:11px;" title="${escapeHtml(expInfo.tooltip)}">
                    ${expInfo.isAllLongTerm ? '' : (expInfo.hasMultiplePackages ? '首批截至: ' : '截至: ')}<b>${escapeHtml(expInfo.shortText)}</b>${expInfo.countdown ? ` (${escapeHtml(expInfo.countdown)})` : ''}${expInfo.hasMultiplePackages && !expInfo.isAllLongTerm ? ` <span style="font-size:9.5px; opacity:0.8;">(共${expInfo.packageCount}批)</span>` : ''}
                  </span>
                </div>
              `;
            }
          } else if (isOpenRouter) {
            const todayCount = it.today_requests != null ? Number(it.today_requests) : (fallbackAcc?.today_requests != null ? Number(fallbackAcc.today_requests) : null);
            const dailyLimit = it.daily_limit != null ? Number(it.daily_limit) : (fallbackAcc?.daily_limit != null ? Number(fallbackAcc.daily_limit) : 800);
            const remainingReq = it.remaining_requests != null ? Number(it.remaining_requests) : (fallbackAcc?.remaining_requests != null ? Number(fallbackAcc.remaining_requests) : (todayCount != null ? Math.max(0, dailyLimit - todayCount) : null));
            const resetCountdown = it.reset_countdown || fallbackAcc?.reset_countdown || '';

            if (todayCount != null) {
              const remCount = remainingReq != null ? remainingReq : Math.max(0, dailyLimit - todayCount);
              const remPct = dailyLimit > 0 ? Math.max(0, Math.min(100, Math.round((remCount / dailyLimit) * 1000) / 10)) : 100;
              let barColor = '#10b981'; // 充裕 (绿)
              if (remPct <= 20) barColor = '#ef4444'; // 耗尽或濒危 (红)
              else if (remPct <= 50) barColor = '#f59e0b'; // 警戒 (黄)

              const countdownText = resetCountdown ? (resetCountdown.includes('重置') ? resetCountdown : `重置: ${resetCountdown}`) : 'UTC 00:00 重置';

              quotaHtml = `
                <div class="quota-box-row">
                  <span class="quota-box-title">今日请求: <b style="color:#3b82f6;">${todayCount}</b> <span style="font-size:10px; color:var(--text-dim); font-weight:normal;">/ ${dailyLimit} 次</span></span>
                  <span class="quota-box-countdown">${escapeHtml(countdownText)}</span>
                </div>
                <div class="quota-progress-track">
                  <div class="quota-progress-fill" style="width:${Math.max(0, Math.min(100, remPct))}%; background:${barColor};"></div>
                </div>
                <div class="quota-weekly-row">今日剩余: <b style="color:${barColor};">${remCount}</b> 次可用 · 周期: <b>UTC日</b></div>
              `;
            }
          } else if (isOpenCode) {
            const todayCount = it.today_requests != null ? Number(it.today_requests) : (fallbackAcc?.today_requests != null ? Number(fallbackAcc.today_requests) : 0);
            const todayTokens = it.today_tokens != null ? Number(it.today_tokens) : (fallbackAcc?.today_tokens != null ? Number(fallbackAcc.today_tokens) : 0);

            quotaHtml = `
              <div class="quota-box-row">
                <span class="quota-box-title">今日消耗: <b style="color:#0ea5e9;">${formatTokens(todayTokens)}</b> Tokens</span>
                <span class="quota-box-countdown">今日请求: <b style="color:var(--text-main); font-weight:700;">${todayCount}</b> 次</span>
              </div>
              <div class="quota-weekly-row" style="margin-top:4px;">自然日累计: <b>${todayTokens.toLocaleString()}</b> Tokens · <b>${todayCount}</b> 次请求</div>
            `;
          } else if (it.quota_5h) {
            const rem5h = it.quota_5h.remaining_percent;
            let barColor = '#10b981'; // 充裕 (绿)
            if (rem5h < 20) barColor = '#ef4444'; // 耗尽或濒危 (红)
            else if (rem5h < 50) barColor = '#f59e0b'; // 警戒 (黄)

            const countdownText = it.quota_5h.reset_countdown || (rem5h >= 100 ? '满额就绪' : '');
            quotaHtml = `
              <div class="quota-box-row">
                <span class="quota-box-title">5h 周期剩余: <b style="color:${barColor};">${rem5h.toFixed(1)}%</b></span>
                <span class="quota-box-countdown">${escapeHtml(countdownText)}</span>
              </div>
              <div class="quota-progress-track">
                <div class="quota-progress-fill" style="width:${Math.max(0, Math.min(100, rem5h))}%; background:${barColor};"></div>
              </div>
              ${it.quota_weekly ? `<div class="quota-weekly-row">周剩余: <b>${it.quota_weekly.remaining_percent.toFixed(1)}%</b> ${it.quota_weekly.reset_countdown ? `· ${escapeHtml(it.quota_weekly.reset_countdown)}` : ''}</div>` : ''}
            `;
          }

          // 分时段 Token 矩阵提取
          const pStats = it.period_stats || {};
          const tok5hStr = formatTokens(pStats.tokens_5h || 0);
          const tok24hStr = formatTokens(pStats.tokens_24h || 0);
          const tokAllStr = formatTokens(pStats.tokens_all || it.total_tokens || 0);
          const shortId = it.auth_index ? String(it.auth_index).slice(0, 16) : '—';

          return `
            <div class="upstream-stat-card ${isDisabled ? 'is-disabled' : ''}">
              <!-- 卡片顶栏：图标 + 名称 + 状态 + 优先级 + 成功率大徽章 -->
              <div class="stat-card-header">
                <div class="stat-card-identity">
                  <div class="provider-icon-badge ${brand.iconClass}" title="${escapeHtml(brand.name)}">
                    ${brand.iconSvg}
                  </div>
                  <div class="stat-card-title-wrap">
                    <div class="stat-card-title-row">
                      <span class="provider-pill ${brand.pillClass}">${escapeHtml(brand.name)}</span>
                      <span class="stat-card-name" title="${escapeHtml(it.name)}">
                        ${escapeHtml(it.name)}
                      </span>
                      ${isDisabled ? '<span class="status-tag tag-disabled">已停用</span>' : ''}
                    </div>
                    <div class="stat-card-sub-row">
                      <span class="stat-card-id" title="${escapeHtml(it.auth_index)}">ID: ${escapeHtml(shortId)}</span>
                      <span class="priority-badge ${prioCls}">P${prio}</span>
                    </div>
                  </div>
                </div>
                <div class="stat-card-rate-badge" style="color:${rateColor}; border-color:${rateBorder}; background:${rateBg};" title="成功率 (CPA 运行时事实/估算)">
                  <div class="stat-card-rate-val">${successRate}</div>
                  <div class="stat-card-rate-lbl">成功率</div>
                </div>
              </div>

              <!-- 周期额度条 (5h / 周限额) -->
              <div class="stat-card-quota-box">
                ${quotaHtml}
              </div>

              <!-- 核心指标 3 格 (总请求数 | Token 总数 | 缓存率) -->
              <div class="stat-card-metrics-grid">
                <div class="stat-metric-cell">
                  <div class="metric-cell-label">请求总数 ${reqSourceTag}</div>
                  <div class="metric-cell-value num">${formatTokens(it.total_requests)}</div>
                  <div class="metric-cell-sub">
                    <span style="color:#10b981;">成 ${formatTokens(it.success_count)}</span> / <span style="color:#ef4444;">败 ${formatTokens(it.failure_count)}</span>
                  </div>
                </div>
                <div class="stat-metric-cell">
                  <div class="metric-cell-label">Token 消耗 <span class="ovw-source-tag is-local">本地</span></div>
                  <div class="metric-cell-value num" title="${it.total_tokens.toLocaleString()}">${formatTokens(it.total_tokens)}</div>
                  <div class="metric-cell-sub">
                    入 ${formatTokens(it.prompt_tokens)} / 出 ${formatTokens(it.completion_tokens)}
                  </div>
                </div>
                <div class="stat-metric-cell">
                  <div class="metric-cell-label">缓存命中率 <span class="ovw-source-tag is-local">本地</span></div>
                  <div class="metric-cell-value num" style="color:#0284c7;">${it.cache_rate != null ? it.cache_rate.toFixed(1) + '%' : '0.0%'}</div>
                  <div class="metric-cell-sub" title="缓存 Tokens: ${Number(it.cached_tokens || 0).toLocaleString()}">
                    命中 ${formatTokens(it.cached_tokens)}
                  </div>
                </div>
              </div>

              <!-- 分时段 Token 水位带 (5h / 24h / 历史总数) -->
              <div class="stat-card-period-bar">
                <div class="period-item" title="5小时内Token"><span class="period-dot dot-5h"></span>5h: <b>${tok5hStr}</b></div>
                <div class="period-item" title="24小时内Token"><span class="period-dot dot-24h"></span>24h: <b>${tok24hStr}</b></div>
                <div class="period-item" title="全部历史总Token"><span class="period-dot dot-all"></span>累计: <b>${tokAllStr}</b></div>
              </div>

              <!-- 底部：最近活跃模型 -->
              <div class="stat-card-footer">
                <span class="footer-model-label">最近模型:</span>
                <span class="footer-model-value" title="${escapeHtml(it.last_model || '—')}">${escapeHtml(it.last_model || '—')}</span>
              </div>
            </div>
          `;
        }).join('');
      } else {
        activeCardsHtml = `<div style="grid-column: 1 / -1; text-align:center; padding:32px 16px; color:var(--text-dim); font-size:12.5px;">当前暂无活跃上游凭证卡片${deletedItems.length > 0 ? '（历史已删除账号已收纳至下方留痕归档区）' : ''}</div>`;
      }

      if (container) {
        container.innerHTML = activeCardsHtml;
      }

      // 2. 渲染已删除账号归档区（收纳至底部折叠面板，绝不占据主网格视线）
      if (archiveContainer) {
        if (deletedItems.length === 0) {
          archiveContainer.style.display = 'none';
          archiveContainer.innerHTML = '';
        } else {
          archiveContainer.style.display = 'block';
          const wasOpen = Boolean(archiveContainer.querySelector('.deleted-accounts-archive')?.open);

          const rowsHtml = deletedItems.map(it => {
            const brand = getProviderBrand(it.provider);
            const pStats = it.period_stats || {};
            const tok5hStr = formatTokens(pStats.tokens_5h || 0);
            const tok24hStr = formatTokens(pStats.tokens_24h || 0);
            const tokAllStr = formatTokens(pStats.tokens_all || it.total_tokens || 0);
            const shortId = it.auth_index ? String(it.auth_index).slice(0, 16) : '—';
            const successRate = it.success_rate != null ? it.success_rate.toFixed(1) + '%' : '100.0%';

            let rateColor = '#059669';
            if (it.success_rate < 80) rateColor = '#dc2626';
            else if (it.success_rate < 95) rateColor = '#d97706';

            return `
              <tr>
                <td>
                  <div class="deleted-row-name">
                    <span>${escapeHtml(it.name)}</span>
                    <span class="status-tag tag-deleted" style="font-size:9.5px; padding:1px 5px;">历史留痕</span>
                  </div>
                  <div class="deleted-row-id" title="${escapeHtml(it.auth_index)}">ID: ${escapeHtml(shortId)}</div>
                </td>
                <td>
                  <span class="provider-pill ${brand.pillClass}" style="font-size:10.5px;">${escapeHtml(brand.name)}</span>
                </td>
                <td>
                  <div style="font-family:var(--mono); font-weight:600; font-size:11.5px;">${formatTokens(it.total_requests)}</div>
                  <div style="font-size:10px; font-family:var(--mono); color:var(--text-dim);">
                    <span style="color:#10b981;">成 ${formatTokens(it.success_count)}</span> / <span style="color:#ef4444;">败 ${formatTokens(it.failure_count)}</span>
                  </div>
                </td>
                <td>
                  <span style="font-family:var(--mono); font-weight:700; color:${rateColor}; font-size:11.5px;">${successRate}</span>
                </td>
                <td>
                  <div style="font-family:var(--mono); font-weight:700; font-size:11.5px;" title="${it.total_tokens.toLocaleString()}">${formatTokens(it.total_tokens)}</div>
                  <div style="font-size:10px; font-family:var(--mono); color:var(--text-dim);">
                    入 ${formatTokens(it.prompt_tokens)} / 出 ${formatTokens(it.completion_tokens)}${it.cached_tokens ? ` · 缓 ${formatTokens(it.cached_tokens)}` : ''}
                  </div>
                </td>
                <td>
                  <div style="font-size:10.5px; font-family:var(--mono); color:var(--text-dim); display:flex; gap:8px;">
                    <span>5h: <b style="color:var(--text-main);">${tok5hStr}</b></span>
                    <span>24h: <b style="color:var(--text-main);">${tok24hStr}</b></span>
                    <span>累计: <b style="color:var(--text-main);">${tokAllStr}</b></span>
                  </div>
                </td>
                <td>
                  <span class="footer-model-value" style="font-size:10px;" title="${escapeHtml(it.last_model || '—')}">${escapeHtml(it.last_model || '—')}</span>
                </td>
              </tr>
            `;
          }).join('');

          archiveContainer.innerHTML = `
            <details class="deleted-accounts-archive" ${wasOpen ? 'open' : ''}>
              <summary class="deleted-accounts-summary">
                <div class="deleted-summary-left">
                  <svg class="deleted-archive-icon" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                    <path d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" stroke-linecap="round" stroke-linejoin="round"></path>
                  </svg>
                  <span class="deleted-summary-title">已删除账号历史留痕</span>
                  <span class="deleted-summary-badge">${deletedItems.length} 个账号</span>
                  <span class="deleted-summary-desc">（已从 CPA 移除，仅保留 Gate 审计流水与历史 Token）</span>
                </div>
                <div class="deleted-summary-right">
                  <span class="deleted-summary-hint">点击展开 / 收起</span>
                  <svg class="deleted-chevron" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                    <path d="M19 9l-7 7-7-7" stroke-linecap="round" stroke-linejoin="round"></path>
                  </svg>
                </div>
              </summary>
              <div class="deleted-accounts-body">
                <div class="deleted-accounts-table-wrap">
                  <table class="deleted-accounts-table">
                    <thead>
                      <tr>
                        <th style="min-width:170px;">账号标识 / 凭证 ID</th>
                        <th>提供商</th>
                        <th>请求总数</th>
                        <th>成功率</th>
                        <th>Token 消耗 (总 / 入 / 出)</th>
                        <th>分时消耗 (5h / 24h / 累计)</th>
                        <th>最近调用模型</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${rowsHtml}
                    </tbody>
                  </table>
                </div>
              </div>
            </details>
          `;
        }
      }

      if (tbody) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:12px; color:var(--text-dim);">已切换至卡片视图</td></tr>';
      }
    }

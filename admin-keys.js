/**
 * Gate Admin Console - Keys & Pricing Management Module
 * 包含 API Key CRUD (创建/轮换/别名/删除/模型权限) 及模型定价规则配置与渲染
 */

    // 2. 获取 Key 列表 (带 SWR 缓存与即时持久化)
    async function fetchKeysData(force = false) {
      if (!force && cachedKeys.length > 0 && (Date.now() - cachedKeysLoadedAt) < 10000) {
        renderKeysTable(cachedKeys);
        return;
      }
      try {
        const res = await fetch('/admin/api/keys', { headers: getAuthHeaders() });
        if (res.status === 401) {
          document.getElementById('keys-tbody').innerHTML = '<tr><td colspan="9" style="text-align: center; color: var(--danger); padding: 32px;">鉴权失败，请点击右上角"密钥"配置管理密钥。</td></tr>';
          return;
        }
        if (!res.ok) return;
        const data = await res.json();
        cachedKeys = data.keys || [];
        cachedKeysLoadedAt = Date.now();
        persistKeysToStorage(cachedKeys);
        renderKeysTable(cachedKeys);
        updateStatsKeyDropdown(cachedKeys);
        // Key 列表变更后同步流水筛选下拉（新建/删除 Key 后不用切 Tab 才生效）
        updateLogsKeySelect(cachedEvents);
      } catch (err) {
        console.warn('Fetch keys error:', err.message);
      }
    }

    function renderKeysTable(keys) {
      document.getElementById('table-keys-count').innerText = `共 ${keys.length} 个密钥`;
      const navBadge = document.getElementById('nav-badge-keys');
      if (navBadge) navBadge.innerText = keys.length;
      const tbody = document.getElementById('keys-tbody');
      if (keys.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; color: var(--text-dim); padding: 32px;">暂无 API 密钥，请点击"新建 Key"创建。</td></tr>';
        return;
      }
      let html = '';
      for (const k of keys) {
        const hardLimit = Number(k.hard_limit) || (k.daily_limit ? Math.floor(Number(k.daily_limit) * (Number(k.hard_ratio) || 1.2)) : 0);
        const usage = Number(k.today_usage) || 0;
        const ratio = hardLimit > 0 ? Math.max(0, Math.min(1, usage / hardLimit)) : 0;
        const barColorClass = k.is_blocked ? 'danger' : (ratio >= 0.85 ? 'warn' : '');

        let statusChip = '<span class="chip chip-gray">未限制</span>';
        if (k.is_blocked) {
          statusChip = '<span class="chip chip-red">硬顶阻断 (429)</span>';
        } else if (k.enabled) {
          if (ratio >= 0.85) statusChip = '<span class="chip chip-yellow">接近上限</span>';
          else statusChip = '<span class="chip chip-green">运行正常</span>';
        }

        let modelHtml = '<span class="model-perm-badge all" title="允许访问所有已接入模型"><span class="perm-dot all"></span>全部模型 (*)</span>';
        if (k.model_whitelist) {
          try {
            const list = JSON.parse(k.model_whitelist);
            if (Array.isArray(list) && list.length > 0) {
              modelHtml = `<span class="model-perm-badge limited" title="${escapeHtml(list.join(', '))}"><span class="perm-dot limited"></span>允许 ${list.length} 个模型</span>`;
            }
          } catch(e) {
            modelHtml = `<span class="model-perm-badge limited" title="${escapeHtml(k.model_whitelist)}"><span class="perm-dot limited"></span>${escapeHtml(k.model_whitelist)}</span>`;
          }
        }

        const cacheRate = k.cache_hit_rate > 0 ? `<span class="chip-cache">${k.cache_hit_rate}%</span>` : '<span class="chip-cache zero">0%</span>';

        let progressHtml = '';
        if (hardLimit > 0) {
          const pct = Math.max(0, Math.min(100, Math.round(ratio * 100)));
          progressHtml = `
            <div class="usage-progress-wrap" title="今日消耗进度: ${pct}% (软限额: ${formatTokens(k.daily_limit || 0)}, 硬限: ${formatTokens(hardLimit)})">
              <div class="usage-progress-bar">
                <div class="usage-progress-fill ${barColorClass}" style="width:${pct}%;"></div>
              </div>
            </div>`;
        } else {
          progressHtml = `
            <div class="usage-progress-wrap" title="未设置每日额度限制">
              <div class="usage-progress-bar unlimited"></div>
            </div>`;
        }

        const keyCopyBtn = `
          <button class="key-action-icon-btn" onclick="copyFullKey(${k.key_id})" title="复制完整 API Key">
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
          </button>`;

        const pctNum = hardLimit > 0 ? Math.max(0, Math.min(100, Math.round(ratio * 100))) : 0;
        const limitTag = hardLimit > 0 ? `<span style="color:${pctNum >= 85 ? 'var(--warning)' : 'var(--text-dim)'};">${pctNum}%</span>` : '<span style="color:var(--text-dim); opacity:0.8;">不限</span>';

        html += `<tr>
          <td>
            <div class="key-display-row">
              <div class="key-display" style="user-select:all; cursor:pointer;" title="完整 Key 需点击右侧按钮复制">${escapeHtml(k.display_key)}</div>
              ${keyCopyBtn}
            </div>
            <div class="key-alias-row">
              <span class="key-alias ${k.key_alias ? '' : 'empty'}">${escapeHtml(k.key_alias || '无备注')}</span>
              <button class="alias-quick-edit-btn" onclick="openRenameModal(${k.key_id})" title="修改备注别名">
                <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/></svg>
              </button>
            </div>
          </td>
          <td>${modelHtml}</td>
          <td>
            <div class="key-usage-cell">
              <div class="key-usage-primary">
                <span class="key-usage-tokens">${formatTokens(k.today_usage)}</span>
                <span class="key-usage-requests">${(k.today_requests || 0).toLocaleString()} 次</span>
              </div>
              <div class="key-usage-sub">
                <span class="key-usage-alltime">累计 ${formatTokens(k.all_time_usage || 0)}</span>
                ${limitTag}
              </div>
              ${progressHtml}
            </div>
          </td>
          <td class="num">${cacheRate}</td>
          <td class="num" style="color:#34d399; font-weight:500;">${formatCost(k.cost_usd)}</td>
          <td class="num">${k.enabled && k.daily_limit > 0 ? formatTokens(k.daily_limit) : '<span class="cell-unlimited">不限</span>'}</td>
          <td class="num">${k.enabled && k.rpm_limit > 0 ? k.rpm_limit : '<span class="cell-unlimited">不限</span>'}</td>
          <td>${statusChip}</td>
          <td style="text-align: right;">
            <div class="btn-action-group">
              <button class="btn btn-secondary btn-sm" onclick="openEditModal(${k.key_id})">配置</button>
              <button class="btn btn-secondary btn-sm" onclick="rotateKey(${k.key_id})">轮换</button>
              <button class="btn btn-danger btn-sm" onclick="deleteKey(${k.key_id})">删除</button>
            </div>
          </td>
        </tr>`;
      }
      tbody.innerHTML = html;
    }

    // ---- 快捷修改别名 ----
    let currentRenameKeyId = null;
    function openRenameModal(keyId) {
      const item = cachedKeys.find(k => k.key_id === keyId);
      if (!item) return;
      currentRenameKeyId = keyId;
      document.getElementById('rename-modal-title').innerText = `修改别名: ${item.display_key}`;
      const input = document.getElementById('rename-alias-input');
      input.value = item.key_alias || '';
      openModal('rename-modal');
      setTimeout(() => { input.focus(); input.select(); }, 50);
    }

    document.getElementById('rename-alias-input')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitRenameKey();
      }
    });

    async function submitRenameKey() {
      if (!currentRenameKeyId) return;
      const input = document.getElementById('rename-alias-input');
      const alias = input.value.trim();
      const saveBtn = document.getElementById('rename-save-btn');
      if (saveBtn) saveBtn.disabled = true;

      try {
        const res = await fetch(`/admin/api/keys/${currentRenameKeyId}/alias`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
          body: JSON.stringify({ alias })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '更新别名失败');

        // 本地更新缓存以即时反馈
        const item = cachedKeys.find(k => k.key_id === currentRenameKeyId);
        if (item) item.key_alias = alias;
        persistKeysToStorage(cachedKeys);
        clearLogsQueryCache();
        renderKeysTable(cachedKeys);
        updateLogsKeySelect(cachedEvents);
        renderEventsTable(cachedEvents, cachedEventsTotal);

        closeModal('rename-modal');
        showToast(alias ? `别名已更新为 "${alias}"` : '别名已清空', 'success');
      } catch (err) {
        showToast('修改别名失败: ' + err.message, 'error');
      } finally {
        if (saveBtn) saveBtn.disabled = false;
      }
    }

    // ---- Key 规则编辑逻辑 ----
    function openEditModal(keyId) {
      const item = cachedKeys.find(k => k.key_id === keyId);
      if (!item) return;
      currentKeyId = keyId;

      document.getElementById('edit-modal-title').innerText = `配置 Key 规则: ${item.key_alias || item.display_key}`;
      const rawGroup = document.getElementById('edit-key-raw-group');
      const rawInput = document.getElementById('edit-key-raw-input');
      // 完整 Key 不在列表里下发，改为打开弹窗时按需拉取；
      // 拉取失败就只显示截断形，不阻塞规则编辑。
      rawGroup.style.display = 'none';
      rawInput.value = '';
      if (item.key_id != null) {
        fetchFullKey(item.key_id).then(raw => {
          if (currentKeyId !== keyId) return;
          if (raw) {
            rawInput.value = raw;
            rawGroup.style.display = 'block';
          }
        }).catch(() => {});
      }
      document.getElementById('edit-alias').value = item.key_alias || '';
      document.getElementById('edit-enabled').checked = item.enabled;
      document.getElementById('edit-limit').value = item.daily_limit || '';
      document.getElementById('edit-ratio').value = item.hard_ratio || 1.2;
      document.getElementById('edit-rpm').value = item.rpm_limit || '';

      try {
        currentSelectedModels = item.model_whitelist ? JSON.parse(item.model_whitelist) : [];
      } catch(e) {
        currentSelectedModels = item.model_whitelist ? [item.model_whitelist] : [];
      }
      renderModelTags();
      openModal('edit-modal');
    }

    function renderModelTags() {
      const box = document.getElementById('edit-tags-box');
      if (currentSelectedModels.length === 0) {
        box.innerHTML = '<span class="tag-empty">未设置限制（全量模型均允许 *）</span>';
        return;
      }
      let html = '';
      currentSelectedModels.forEach((m, idx) => {
        html += `<span class="tag-item"><span>${escapeHtml(m)}</span><span class="tag-close" onclick="removeModel(${idx})">&times;</span></span>`;
      });
      box.innerHTML = html;
    }
    function removeModel(idx) {
      currentSelectedModels.splice(idx, 1);
      renderModelTags();
    }
    function addModelFromInput() {
      const input = document.getElementById('edit-model-input');
      const val = input.value.trim().toLowerCase();
      if (val && !currentSelectedModels.includes(val)) {
        currentSelectedModels.push(val);
        input.value = '';
        renderModelTags();
      }
    }
    document.getElementById('edit-model-input')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); addModelFromInput(); }
    });

    function setPreset(type) {
      if (type === 'all') currentSelectedModels = [];
      else if (type === 'flash') currentSelectedModels = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gpt-4o-mini', 'claude-3-5-haiku', 'deepseek-chat'];
      else if (type === 'claude') currentSelectedModels = ['claude-3-7-sonnet', 'claude-3-5-sonnet', 'claude-3-5-haiku'];
      else if (type === 'reasoning') currentSelectedModels = ['deepseek-reasoner', 'o1', 'o3-mini', 'claude-3-7-sonnet'];
      renderModelTags();
    }
    function clearModels() {
      currentSelectedModels = [];
      renderModelTags();
    }

    async function saveKeyRule() {
      if (!currentKeyId) return;
      const alias = document.getElementById('edit-alias').value.trim();
      const enabled = document.getElementById('edit-enabled').checked;
      const limit = Number(document.getElementById('edit-limit').value) || 0;
      const ratio = Number(document.getElementById('edit-ratio').value) || 1.2;
      const rpm = Number(document.getElementById('edit-rpm').value) || 0;

      try {
        const resAlias = await fetch(`/admin/api/keys/${currentKeyId}/alias`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
          body: JSON.stringify({ alias })
        });
        if (!resAlias.ok) {
          const errData = await resAlias.json().catch(() => ({}));
          throw new Error(errData.error || '保存别名失败');
        }

        const resQuota = await fetch(`/admin/api/keys/${currentKeyId}/quota`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
          body: JSON.stringify({
            enabled,
            daily_limit: limit,
            hard_ratio: ratio,
            rpm_limit: rpm,
            model_whitelist: currentSelectedModels
          })
        });
        if (!resQuota.ok) {
          const errData = await resQuota.json().catch(() => ({}));
          throw new Error(errData.error || '保存配额规则失败');
        }

        invalidateKeysFrontendCache();
        closeModal('edit-modal');
        showToast('Key 配置已更新生效', 'success');
        manualRefresh();
      } catch (err) {
        showToast('保存失败: ' + err.message, 'error');
      }
    }

    // ---- 新建与删除 Key ----
    function openCreateModal() {
      document.getElementById('create-form').style.display = 'block';
      document.getElementById('create-result').style.display = 'none';
      document.getElementById('create-alias').value = '';
      document.getElementById('create-custom-key').value = '';
      document.getElementById('create-enabled').checked = false;
      document.getElementById('create-limit').value = '';
      toggleCreateLimit();
      openModal('create-modal');
    }
    function toggleCreateLimit() {
      document.getElementById('create-limit-group').style.display = document.getElementById('create-enabled').checked ? 'block' : 'none';
    }
    async function submitCreateKey() {
      const alias = document.getElementById('create-alias').value.trim();
      const apiKey = document.getElementById('create-custom-key').value.trim();
      const enabled = document.getElementById('create-enabled').checked;
      const limit = Number(document.getElementById('create-limit').value) || 0;
      try {
        const res = await fetch('/admin/api/keys', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
          body: JSON.stringify({ alias, api_key: apiKey, enabled, daily_limit: limit })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '创建失败');
        invalidateKeysFrontendCache();
        createdKeyRaw = data.key?.api_key || data.api_key;
        if (!createdKeyRaw) throw new Error('CPA 已创建 Key，但响应未包含密钥，请在列表中查看');
        document.getElementById('created-key-val').innerText = createdKeyRaw;
        document.getElementById('create-form').style.display = 'none';
        document.getElementById('create-result').style.display = 'block';
        manualRefresh();
      } catch (err) {
        showToast(err.message, 'error');
      }
    }
    function copyCreatedKey() {
      if (!createdKeyRaw) return;
      navigator.clipboard.writeText(createdKeyRaw).then(() => showToast('已复制到剪贴板', 'success'));
    }
    function finishCreateKey() {
      closeModal('create-modal');
    }
    async function rotateKey(keyId) {
      if (!confirm('轮换后旧 Key 立即失效。确定为此 Key 生成新密钥吗？')) return;
      try {
        const res = await fetch(`/admin/api/keys/${keyId}/rotate`, { method: 'POST', headers: getAuthHeaders() });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '轮换失败');
        invalidateKeysFrontendCache();
        createdKeyRaw = data.key?.api_key;
        if (!createdKeyRaw) throw new Error('轮换已完成，但响应未包含新密钥');
        document.getElementById('created-key-val').innerText = createdKeyRaw;
        document.getElementById('create-form').style.display = 'none';
        document.getElementById('create-result').style.display = 'block';
        openModal('create-modal');
        manualRefresh();
      } catch (err) { showToast('轮换失败: ' + err.message, 'error'); }
    }

    async function deleteKey(keyId) {
      if (!confirm('确定要彻底删除该 Key 吗？此操作将同步至 CPA 并不再接受请求。')) return;
      try {
        const res = await fetch(`/admin/api/keys/${keyId}`, {
          method: 'DELETE',
          headers: getAuthHeaders()
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '删除失败');
        invalidateKeysFrontendCache();
        showToast('Key 已成功删除', 'success');
        manualRefresh();
      } catch (err) {
        showToast(err.message, 'error');
      }
    }

    // ---- 模型定价与倍率管理 (Pricing Rules Modal) ----
    let cachedModelPrices = [];

    function openPricesModal() {
      resetPriceForm();
      fetchModelPrices();
      openModal('prices-modal');
    }

    async function fetchModelPrices() {
      const secret = getAdminSecret();
      if (!secret) return;
      try {
        const res = await fetch('/admin/api/model-prices', { headers: getAuthHeaders() });
        if (!res.ok) return;
        const data = await res.json();
        cachedModelPrices = data.prices || [];
        renderPricesTable(cachedModelPrices);
      } catch (err) {
        console.warn('Model prices fetch error:', err.message);
      }
    }

    function renderPricesTable(prices) {
      const tbody = document.getElementById('prices-tbody');
      if (!tbody) return;
      if (!prices || prices.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-dim); padding: 24px;">暂无定价规则配置</td></tr>';
        return;
      }
      let html = '';
      for (const p of prices) {
        const pat = p.pattern || p.model_pattern || '';
        html += `<tr>
          <td><code style="font-family:var(--font-mono); color:var(--accent);">${escapeHtml(pat)}</code></td>
          <td class="num">$${Number(p.prompt_price || 0).toFixed(2)}</td>
          <td class="num">$${Number(p.completion_price || 0).toFixed(2)}</td>
          <td class="num">$${Number(p.cache_read_price || 0).toFixed(3)}</td>
          <td class="num"><span class="chip chip-gray">${Number(p.multiplier || 1.0).toFixed(1)}x</span></td>
          <td style="text-align: right;">
            <button class="btn btn-secondary btn-sm" onclick="editPriceRule(${p.id})">编辑</button>
            <button class="btn btn-danger btn-sm" style="margin-left:4px;" onclick="deletePriceRule(${p.id})">删除</button>
          </td>
        </tr>`;
      }
      tbody.innerHTML = html;
    }

    function resetPriceForm() {
      document.getElementById('price-form-id').value = '';
      document.getElementById('price-form-title').innerText = '添加 / 编辑定价规则';
      document.getElementById('price-pattern').value = '';
      document.getElementById('price-prompt').value = '';
      document.getElementById('price-completion').value = '';
      document.getElementById('price-cache').value = '';
      document.getElementById('price-multiplier').value = '1.0';
    }

    function editPriceRule(id) {
      const p = cachedModelPrices.find(item => item.id === id);
      if (!p) return;
      const pat = p.pattern || p.model_pattern || '';
      document.getElementById('price-form-id').value = p.id;
      document.getElementById('price-form-title').innerText = `编辑定价规则: ${pat}`;
      document.getElementById('price-pattern').value = pat;
      document.getElementById('price-prompt').value = p.prompt_price;
      document.getElementById('price-completion').value = p.completion_price;
      document.getElementById('price-cache').value = p.cache_read_price;
      document.getElementById('price-multiplier').value = p.multiplier;
    }

    async function saveModelPrice() {
      const id = document.getElementById('price-form-id').value;
      const pattern = document.getElementById('price-pattern').value.trim();
      if (!pattern) {
        showToast('模型匹配模式不可为空', 'error');
        return;
      }
      const promptPrice = Number(document.getElementById('price-prompt').value) || 0;
      const completionPrice = Number(document.getElementById('price-completion').value) || 0;
      const cachePrice = Number(document.getElementById('price-cache').value) || 0;
      const multiplier = Number(document.getElementById('price-multiplier').value) || 1.0;

      try {
        const payload = {
          id: id ? Number(id) : undefined,
          pattern,
          model_pattern: pattern,
          prompt_price: promptPrice,
          completion_price: completionPrice,
          cache_read_price: cachePrice,
          multiplier
        };
        const res = await fetch('/admin/api/model-prices', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '保存定价失败');
        showToast('定价规则已生效', 'success');
        resetPriceForm();
        fetchModelPrices();
        fetchStatsData();
      } catch (err) {
        showToast(err.message, 'error');
      }
    }

    async function deletePriceRule(id) {
      if (!confirm('确定删除该模型定价规则吗？删除后将采用默认兜底定价。')) return;
      try {
        const res = await fetch(`/admin/api/model-prices/${id}`, {
          method: 'DELETE',
          headers: getAuthHeaders()
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '删除失败');
        showToast('定价规则已移除', 'success');
        fetchModelPrices();
        fetchStatsData();
      } catch (err) {
        showToast(err.message, 'error');
      }
    }

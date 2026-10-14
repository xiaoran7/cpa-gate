import { cpaRequest } from '../core/key-registry.mjs';
import { cachedUpstreamQuotas, compareAuthAccounts } from './sync.mjs';
import { resetRuntimeFactsCache } from './runtime-stats.mjs';
import {
  DEFAULT_AUTH_WEIGHT,
  AUTH_PRIORITY_MIN,
  AUTH_PRIORITY_MAX,
  AUTH_WEIGHT_MIN,
  AUTH_WEIGHT_MAX
} from '../config.mjs';

/**
 * 更新上游凭证的优先级与权重 (CPA /v0/management/auth-files/fields)
 */
export async function updateUpstreamAuthPriority({ name, priority, weight, note }) {
  if (!name || typeof name !== 'string') {
    const err = new Error('凭证名称 name 不能为空');
    err.statusCode = 400;
    throw err;
  }
  const prioNum = Number.parseInt(priority, 10);
  if (Number.isNaN(prioNum) || prioNum < AUTH_PRIORITY_MIN || prioNum > AUTH_PRIORITY_MAX) {
    const err = new Error(`优先级 priority 必须在 ${AUTH_PRIORITY_MIN} 到 ${AUTH_PRIORITY_MAX} 之间`);
    err.statusCode = 400;
    throw err;
  }
  const weightNum = weight != null && weight !== '' ? Number.parseInt(weight, 10) : undefined;
  if (weightNum !== undefined && (Number.isNaN(weightNum) || weightNum < AUTH_WEIGHT_MIN || weightNum > AUTH_WEIGHT_MAX)) {
    const err = new Error(`权重 weight 必须在 ${AUTH_WEIGHT_MIN} 到 ${AUTH_WEIGHT_MAX} 之间`);
    err.statusCode = 400;
    throw err;
  }

  const payload = {
    name: name.trim(),
    priority: prioNum
  };
  if (weightNum !== undefined) payload.weight = weightNum;
  if (typeof note === 'string') payload.note = note.trim();

  const cpaRes = await cpaRequest('PATCH', '/v0/management/auth-files/fields', payload);

  // 内存缓存即时生效
  if (Array.isArray(cachedUpstreamQuotas.accounts)) {
    for (const acc of cachedUpstreamQuotas.accounts) {
      if (acc.filename === payload.name || acc.id === payload.name) {
        acc.priority = prioNum;
        if (weightNum !== undefined) acc.weight = weightNum;
        if (typeof note === 'string') acc.note = payload.note;
        acc.updated_at = Date.now();
        break;
      }
    }
    // 重新按优先级重排
    cachedUpstreamQuotas.accounts.sort(compareAuthAccounts);
  }

  resetRuntimeFactsCache();

  return {
    status: 'ok',
    name: payload.name,
    priority: prioNum,
    weight: weightNum ?? DEFAULT_AUTH_WEIGHT,
    cpa_response: cpaRes
  };
}

/**
 * 启用/停用上游凭证 (CPA /v0/management/auth-files/status)
 */
export async function updateUpstreamAuthStatus({ name, disabled }) {
  if (!name || typeof name !== 'string') {
    const err = new Error('凭证名称 name 不能为空');
    err.statusCode = 400;
    throw err;
  }
  const isDisabled = Boolean(disabled);

  const payload = {
    name: name.trim(),
    disabled: isDisabled
  };

  const cpaRes = await cpaRequest('PATCH', '/v0/management/auth-files/status', payload);

  // 内存缓存即时生效
  if (Array.isArray(cachedUpstreamQuotas.accounts)) {
    for (const acc of cachedUpstreamQuotas.accounts) {
      if (acc.filename === payload.name || acc.id === payload.name) {
        acc.disabled = isDisabled;
        acc.status = isDisabled ? 'disabled' : 'active';
        acc.updated_at = Date.now();
        break;
      }
    }
  }

  resetRuntimeFactsCache();

  return {
    status: 'ok',
    name: payload.name,
    disabled: isDisabled,
    cpa_response: cpaRes
  };
}

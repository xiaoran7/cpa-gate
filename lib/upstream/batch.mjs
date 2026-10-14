// 认证文件的批量操作。
//
// 逐条执行、逐条汇报：一个条目失败不阻断其余，也不回滚已成功的条目。
// 这是用户在 P1 拍板的语义 —— 真实运维场景里，十几条凭据里挂掉一两条是常态，
// 整体回滚反而让人不得不重做。
//
// 每个 action 都复用既有的单条实现，不新造 CPA 调用路径，避免同一操作有
// 两套实现随时间漂移。
import { updateUpstreamAuthPriority, updateUpstreamAuthStatus } from './priority.mjs';
import { requestCpaJson } from './management.mjs';
import { resetRuntimeFactsCache } from './runtime-stats.mjs';
import { AUTH_PRIORITY_MIN, AUTH_PRIORITY_MAX } from '../config.mjs';

export const BATCH_ACTIONS = ['enable', 'disable', 'priority', 'reset-cooldown', 'delete'];

// 单批上限：防止一次误选几千条把管理面打爆，也把请求体钳在有界范围内
export const BATCH_MAX = 200;

export function isValidAuthFilename(name) {
  return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}\.json$/.test(name) && !name.includes('..');
}

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

export function validateBatchRequest(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw badRequest('批量操作参数必须是对象');
  }
  const { names, action, value } = payload;

  if (!Array.isArray(names) || !names.length) throw badRequest('请至少选择一个认证文件');
  if (names.length > BATCH_MAX) throw badRequest(`单次最多处理 ${BATCH_MAX} 个认证文件`);
  const invalid = names.find(name => !isValidAuthFilename(name));
  if (invalid !== undefined) throw badRequest(`无效的认证文件名：${String(invalid).slice(0, 64)}`);

  if (!BATCH_ACTIONS.includes(action)) {
    throw badRequest(`不支持的批量操作：${String(action).slice(0, 32)}`);
  }

  // 去重但保序：同一文件被选中两次不该被处理两次
  const unique = [...new Set(names)];

  let priority;
  if (action === 'priority') {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < AUTH_PRIORITY_MIN || parsed > AUTH_PRIORITY_MAX) {
      throw badRequest(`优先级必须在 ${AUTH_PRIORITY_MIN} 到 ${AUTH_PRIORITY_MAX} 之间`);
    }
    priority = parsed;
  }

  return { names: unique, action, priority };
}

// auth_index 只有重置冷却需要：CPA 的 /reset-quota 认的是 auth_index 而不是文件名。
// 调用方按文件名传入，这里按需转换；缺失时该条目失败并给出可读原因，
// 而不是静默跳过。
function resolveAuthIndex(name, indexByName) {
  const authIndex = indexByName?.get(name);
  if (!authIndex) throw new Error('该凭据缺少 auth_index，无法重置冷却');
  return authIndex;
}

export async function applyBatchAction(payload, { authIndexByName } = {}) {
  const { names, action, priority } = validateBatchRequest(payload);
  const results = [];
  let succeeded = 0;

  for (const name of names) {
    try {
      if (action === 'enable') await updateUpstreamAuthStatus({ name, disabled: false });
      else if (action === 'disable') await updateUpstreamAuthStatus({ name, disabled: true });
      else if (action === 'priority') await updateUpstreamAuthPriority({ name, priority });
      else if (action === 'reset-cooldown') {
        const authIndex = resolveAuthIndex(name, authIndexByName);
        await requestCpaJson('POST', '/reset-quota', { auth_index: authIndex });
      } else if (action === 'delete') {
        await requestCpaJson('DELETE', `/auth-files?name=${encodeURIComponent(name)}`);
      }
      results.push({ name, ok: true });
      succeeded++;
    } catch (error) {
      // 只回传文件名与错误文案，不回显任何凭据材料
      results.push({ name, ok: false, error: error?.message || String(error) });
    }
  }

  resetRuntimeFactsCache();

  return {
    action,
    total: names.length,
    succeeded,
    failed: names.length - succeeded,
    results
  };
}

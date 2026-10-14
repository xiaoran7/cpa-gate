import {
  stmtValidationFindPending,
  stmtValidationInsert,
  stmtValidationUpdate,
  stmtValidationResolve,
  stmtValidationResolveByAuth,
  stmtValidationDismiss,
  stmtValidationDelete,
  stmtValidationAllRecent,
  stmtValidationPendingList,
  quotaDb
} from '../db/sqlite.mjs';
import { extractValidationUrl, completeGoogleValidationUrl } from '../../validation-url.mjs';

/**
 * 记录上游验证需求（如 Antigravity VALIDATION_REQUIRED）
 */
export function recordUpstreamValidation({ authIndex, provider = 'antigravity', accountName = null, validationUrl, errorMessage = '', rawError = '', allowMissingUrl = false }) {
  validationUrl = extractValidationUrl(validationUrl) || '';
  const now = Date.now();
  const safeAuth = (authIndex || '').trim();

  // 若没有提供 accountName，尝试从基线表里找对应名称
  let resolvedName = accountName;
  if (!resolvedName && safeAuth) {
    try {
      const row = quotaDb.prepare('SELECT name FROM upstream_auth_baselines WHERE auth_index = ?').get(safeAuth);
      if (row && row.name) resolvedName = row.name;
    } catch (_) {}
  }

  // 智能补全为具备官方 Gemini Code Assist 标准回调的完整验证链接
  if (validationUrl) {
    validationUrl = completeGoogleValidationUrl(validationUrl, resolvedName) || validationUrl;
  }

  if (!validationUrl && (!allowMissingUrl || !safeAuth)) return null;

  try {
    if (safeAuth) {
      const existing = stmtValidationFindPending.get(safeAuth);
      if (existing) {
        stmtValidationUpdate.run({
          id: existing.id,
          validation_url: validationUrl || existing.validation_url,
          error_message: errorMessage || existing.error_message,
          raw_error: (rawError || '').slice(0, 4000),
          account_name: resolvedName || existing.account_name,
          updated_at: now
        });
        return existing.id;
      }
    }

    const info = stmtValidationInsert.run({
      ts: now,
      auth_index: safeAuth,
      provider: provider || 'antigravity',
      account_name: resolvedName,
      validation_url: validationUrl,
      error_message: errorMessage || 'Verify your account to continue.',
      raw_error: (rawError || '').slice(0, 4000),
      updated_at: now
    });
    return info.lastInsertRowid;
  } catch (err) {
    console.error('[Gate] recordUpstreamValidation error:', err.message);
    return null;
  }
}

/**
 * 获取待验证记录列表
 */
export function getPendingUpstreamValidations() {
  try {
    return stmtValidationPendingList.all();
  } catch (err) {
    console.error('[Gate] getPendingUpstreamValidations error:', err.message);
    return [];
  }
}

/**
 * 获取所有最近的验证记录（用于控制台与故障中心）
 */
export function getUpstreamValidations(limit = 100) {
  try {
    return stmtValidationAllRecent.all(Number(limit) || 100);
  } catch (err) {
    console.error('[Gate] getUpstreamValidations error:', err.message);
    return [];
  }
}

/**
 * 将验证标记为已解决
 */
export function resolveUpstreamValidation(id) {
  try {
    const res = stmtValidationResolve.run(Date.now(), Number(id));
    return res.changes > 0;
  } catch (err) {
    console.error('[Gate] resolveUpstreamValidation error:', err.message);
    return false;
  }
}

/**
 * 将验证标记为已解决（按 auth_index）
 */
export function resolveUpstreamValidationByAuth(authIndex) {
  try {
    const res = stmtValidationResolveByAuth.run(Date.now(), String(authIndex));
    return res.changes > 0;
  } catch (err) {
    console.error('[Gate] resolveUpstreamValidationByAuth error:', err.message);
    return false;
  }
}

/**
 * 将验证标记为忽略
 */
export function dismissUpstreamValidation(id) {
  try {
    const res = stmtValidationDismiss.run(Date.now(), Number(id));
    return res.changes > 0;
  } catch (err) {
    console.error('[Gate] dismissUpstreamValidation error:', err.message);
    return false;
  }
}

/**
 * 彻底删除指定的验证记录
 */
export function deleteUpstreamValidation(id) {
  try {
    const res = stmtValidationDelete.run(Number(id));
    return res.changes > 0;
  } catch (err) {
    console.error('[Gate] deleteUpstreamValidation error:', err.message);
    return false;
  }
}

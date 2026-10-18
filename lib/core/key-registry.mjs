import http from 'http';
import { randomBytes } from 'crypto';
import { upstreamHttpAgent } from '../proxy/http-agent.mjs';
import {
  CPA_MGMT_HOST,
  CPA_MGMT_PORT,
  CPA_MGMT_SECRET
} from '../config.mjs';
import {
  stmtAllKeys,
  stmtKeyById,
  stmtKeyByRaw,
  stmtInsertKey,
  stmtUpdateKeyRaw,
  stmtSetActive,
  stmtUpdateAlias,
  quotaDb
} from '../db/sqlite.mjs';
import { notifyEvent } from '../../notify.mjs';

export const rawKeyToId = new Map();      // api_key(raw) -> key_id (仅 active)
export const keyMetaMap = new Map();      // key_id -> { id, api_key, display_key, alias }
export let keyRegistryVersion = 1;

export let lastSyncTimestamp = 0;
export let lastSyncError = null;
export let syncFailureCount = 0;

export function extractRawKey(authHeader) {
  if (!authHeader) return null;
  let raw = authHeader;
  if (raw.startsWith('Bearer ') || raw.startsWith('bearer ')) {
    raw = raw.slice(7).trim();
  }
  return raw;
}

export function resolveKeyId(authHeader) {
  const rawKey = extractRawKey(authHeader);
  if (!rawKey) return null;
  return rawKeyToId.get(rawKey) ?? null;
}

export function getKeyInfoById(keyId) {
  if (keyId == null) return null;
  const numId = Number(keyId);
  const mem = keyMetaMap.get(numId);
  if (mem) {
    return {
      id: mem.id,
      alias: mem.alias || '',
      display_key: mem.display_key
    };
  }
  const row = stmtKeyById.get(numId);
  if (!row) return null;
  return {
    id: row.id,
    alias: row.alias || '',
    display_key: row.api_key.slice(0, 10) + '…' + row.api_key.slice(-4)
  };
}

/**
 * 取单个 Key 的完整明文，仅供管理端「复制完整 Key」按需调用。
 *
 * 列表接口（getAdminData）只下发 display_key，完整明文不走列表——
 * 否则它会随列表被前端写进 localStorage 与 DOM data-* 属性，
 * 一次同源 XSS 即可取走全部 Key。要看明文就得单独请求这一个 Key。
 */
export function getRawKeyById(keyId) {
  const numId = Number(keyId);
  if (!Number.isSafeInteger(numId) || numId <= 0) return null;
  const row = stmtKeyById.get(numId);
  return row ? row.api_key : null;
}

export function rebuildMemoryFromKeys() {
  keyRegistryVersion++;
  rawKeyToId.clear();
  keyMetaMap.clear();
  for (const k of stmtAllKeys.all()) {
    if (!k.active) continue;
    rawKeyToId.set(k.api_key, k.id);
    keyMetaMap.set(k.id, {
      id: k.id,
      api_key: k.api_key,
      display_key: k.api_key.slice(0, 10) + '…' + k.api_key.slice(-4),
      alias: k.alias || ''
    });
  }
}

export function cpaRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = { Authorization: `Bearer ${CPA_MGMT_SECRET}` };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }
    const req = http.request({
      hostname: CPA_MGMT_HOST,
      port: CPA_MGMT_PORT,
      path,
      method,
      headers,
      agent: upstreamHttpAgent,
      timeout: 8000
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(text ? JSON.parse(text) : null); }
          catch (e) { resolve(null); }
        } else {
          reject(new Error(`CPA mgmt ${method} ${path} -> ${res.statusCode}: ${text.slice(0, 200)}`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('CPA mgmt request timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export async function syncCpaKeys() {
  try {
    const resp = await cpaRequest('GET', '/v0/management/api-keys');
    const list = Array.isArray(resp?.['api-keys']) ? resp['api-keys'] : null;
    if (!list) throw new Error('unexpected api-keys response');

    const listed = new Set(list.map(k => String(k).trim()).filter(Boolean));
    const tx = quotaDb.transaction(() => {
      for (const k of stmtAllKeys.all()) {
        const shouldActive = listed.has(k.api_key) ? 1 : 0;
        if (shouldActive !== k.active) stmtSetActive.run(shouldActive, k.id);
      }
      for (const raw of listed) {
        if (!stmtKeyByRaw.get(raw)) stmtInsertKey.run(raw, '');
      }
    });
    tx();

    rebuildMemoryFromKeys();
    lastSyncTimestamp = Date.now();
    lastSyncError = null;
    syncFailureCount = 0;
  } catch (err) {
    syncFailureCount++;
    lastSyncError = err.message;
    console.error('[Gate-Quota] CPA key sync error:', err.message);
    notifyEvent('sync_failure', 'sync', `Gate 与 CPA 管理 API 的 Key 同步失败：${err.message}`).catch(() => {});
  }
}

export function updateKeyAlias(keyId, alias) {
  const cleanAlias = String(alias || '').trim().slice(0, 64);
  stmtUpdateAlias.run(cleanAlias, Number(keyId));
  const meta = keyMetaMap.get(Number(keyId));
  if (meta) meta.alias = cleanAlias;
  keyRegistryVersion++;
  return { success: true };
}

export async function createCpaKey({ alias, api_key, daily_limit, enabled, model_whitelist, hard_ratio, rpm_limit }) {
  const currentResp = await cpaRequest('GET', '/v0/management/api-keys');
  const currentKeys = Array.isArray(currentResp?.['api-keys']) ? currentResp['api-keys'] : [];
  const suppliedKey = String(api_key || '').trim();
  if (suppliedKey && (!/^[^\s]{16,256}$/.test(suppliedKey) || suppliedKey === CPA_MGMT_SECRET)) throw new Error('自定义 Key 必须为 16–256 位、不能包含空白字符或使用管理密钥');
  const newRawKey = suppliedKey || 'sk-cpa-' + randomBytes(24).toString('base64url');
  if (currentKeys.includes(newRawKey)) throw new Error('此 API Key 已存在于 CPA');
  const updatedKeys = [...currentKeys, newRawKey];

  await cpaRequest('PUT', '/v0/management/api-keys', updatedKeys);

  const res = stmtInsertKey.run(newRawKey, String(alias || '').trim().slice(0, 64));
  const newKeyId = res.lastInsertRowid;

  if (daily_limit || enabled || model_whitelist || hard_ratio || rpm_limit) {
    const { updateQuotaRule } = await import('./engine.mjs');
    updateQuotaRule(newKeyId, {
      enabled: Boolean(enabled),
      daily_limit: daily_limit ? Number(daily_limit) : null,
      hard_ratio: hard_ratio ? Number(hard_ratio) : 1.2,
      rpm_limit: rpm_limit ? Number(rpm_limit) : 0,
      model_whitelist: model_whitelist || ''
    });
  }

  rebuildMemoryFromKeys();
  return {
    success: true,
    key: {
      id: newKeyId,
      api_key: newRawKey,
      alias: String(alias || '').trim()
    }
  };
}

export async function rotateCpaKey(keyId) {
  const keyRow = stmtKeyById.get(Number(keyId));
  if (!keyRow || !keyRow.active) throw new Error('找不到启用中的 Key');
  if (keyRow.api_key === CPA_MGMT_SECRET) throw new Error('拒绝轮换管理密钥');
  const nextKey = 'sk-cpa-' + randomBytes(24).toString('base64url');
  await cpaRequest('PATCH', '/v0/management/api-keys', { old: keyRow.api_key, new: nextKey });
  stmtUpdateKeyRaw.run(nextKey, keyRow.id);
  rebuildMemoryFromKeys();
  return { success: true, key: { id: keyRow.id, api_key: nextKey, alias: keyRow.alias || '' } };
}

export async function deleteCpaKey(keyId) {
  const idNum = Number(keyId);
  if (isNaN(idNum)) throw new Error('Invalid keyId');

  const keyRow = stmtKeyById.get(idNum);
  if (!keyRow) throw new Error('Key not found');
  if (keyRow.api_key === CPA_MGMT_SECRET) throw new Error('拒绝删除：该 Key 是当前管理密钥');

  await cpaRequest('DELETE', `/v0/management/api-keys?value=${encodeURIComponent(keyRow.api_key)}`);

  stmtSetActive.run(0, idNum);
  rebuildMemoryFromKeys();
  const { deleteQuotaRule } = await import('./engine.mjs');
  deleteQuotaRule(idNum);
  return { success: true };
}

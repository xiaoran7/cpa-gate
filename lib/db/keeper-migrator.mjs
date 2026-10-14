import Database from 'better-sqlite3';
import fs from 'fs';
import { KEEPER_DB_PATH } from '../config.mjs';
import {
  quotaDb,
  stmtMetaGet,
  stmtMetaSet,
  stmtKeyByRaw,
  stmtUpdateAlias,
  stmtDailyUpsert,
  stmtBaselineUpsert
} from './sqlite.mjs';

function shanghaiDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(d);
}

export function migrateFromKeeperIfNeeded() {
  if (!fs.existsSync(KEEPER_DB_PATH)) {
    return;
  }

  let keeperDb = null;
  try {
    // 1. 迁移 keys 与近 30 天日用量
    if (!stmtMetaGet.get('keeper_import_v1')) {
      keeperDb = new Database(KEEPER_DB_PATH, { readonly: true, fileMustExist: true });

      // keys 表按 Keeper id 插入，保证既有 quota_rules.key_id 继续有效
      const keeperKeys = keeperDb.prepare('SELECT id, api_key, key_alias, is_deleted FROM cpa_api_keys').all();
      let importedKeys = 0;
      for (const k of keeperKeys) {
        const existing = stmtKeyByRaw.get(k.api_key);
        if (existing) {
          if (!existing.alias && k.key_alias) stmtUpdateAlias.run(k.key_alias, existing.id);
          continue;
        }
        quotaDb.prepare('INSERT INTO keys (id, api_key, alias, active) VALUES (?, ?, ?, ?)')
          .run(k.id, k.api_key, k.key_alias || '', k.is_deleted ? 0 : 1);
        importedKeys++;
      }

      // 用量历史（近 30 天）：列结构防御式探测
      let importedUsage = 0;
      try {
        const cols = keeperDb.prepare('PRAGMA table_info(usage_overview_daily_stats)').all().map(c => c.name);
        const hasModel = cols.includes('model');
        const hasRequests = cols.includes('request_count') || cols.includes('requests');
        const requestsCol = cols.includes('request_count') ? 'request_count' : (cols.includes('requests') ? 'requests' : null);
        const since = shanghaiDate(new Date(Date.now() - 30 * 86400000));
        const rows = keeperDb.prepare(`
          SELECT substr(bucket_start, 1, 10) AS d,
                 api_group_key,
                 ${hasModel ? 'COALESCE(model, \'unknown\')' : "'unknown'"} AS model,
                 SUM(total_tokens) AS total
                 ${hasRequests ? `, SUM(${requestsCol}) AS requests` : ''}
          FROM usage_overview_daily_stats
          WHERE substr(bucket_start, 1, 10) >= ?
          GROUP BY d, api_group_key, model
        `).all(since);

        const tx = quotaDb.transaction((rows) => {
          for (const r of rows) {
            const keyRow = stmtKeyByRaw.get(r.api_group_key);
            if (!keyRow) continue;
            stmtDailyUpsert.run({
              date: r.d,
              key_id: keyRow.id,
              model: String(r.model || 'unknown').toLowerCase().slice(0, 120),
              requests: Number(r.requests) || 0,
              prompt_tokens: 0,
              completion_tokens: 0,
              cached_tokens: 0,
              total_tokens: Number(r.total) || 0,
              estimated_tokens: 0,
              success_count: Number(r.requests) || 0,
              failure_count: 0
            });
            importedUsage++;
          }
        });
        tx(rows);
      } catch (e) {
        console.warn('[Gate-Quota] Keeper usage import skipped:', e.message);
      }

      stmtMetaSet.run('keeper_import_v1', new Date().toISOString());
      console.log(`[Gate-Quota] Keeper migration done: ${importedKeys} keys, ${importedUsage} usage rows.`);
    }

    // 2. 迁移 Keeper usage_identities 作为上游凭据历史用量基线
    if (!stmtMetaGet.get('keeper_import_identities_v1')) {
      if (!keeperDb) {
        keeperDb = new Database(KEEPER_DB_PATH, { readonly: true, fileMustExist: true });
      }
      try {
        const rows = keeperDb.prepare(`
          SELECT identity, name, provider, total_requests, success_count, failure_count,
                 input_tokens, output_tokens, cached_tokens, total_tokens
          FROM usage_identities
          WHERE (total_requests > 0 OR total_tokens > 0)
        `).all();

        let importedIdentities = 0;
        const txIdentities = quotaDb.transaction((identities) => {
          for (const r of identities) {
            const authIdx = String(r.identity || '').trim();
            if (!authIdx) continue;
            stmtBaselineUpsert.run({
              auth_index: authIdx,
              name: String(r.name || '').trim(),
              provider: String(r.provider || '').trim(),
              base_requests: Number(r.total_requests) || 0,
              base_success_count: Number(r.success_count) || 0,
              base_failure_count: Number(r.failure_count) || 0,
              base_prompt_tokens: Number(r.input_tokens) || 0,
              base_completion_tokens: Number(r.output_tokens) || 0,
              base_cached_tokens: Number(r.cached_tokens) || 0,
              base_total_tokens: Number(r.total_tokens) || 0
            });
            importedIdentities++;
          }
        });
        txIdentities(rows);
        stmtMetaSet.run('keeper_import_identities_v1', new Date().toISOString());
        console.log(`[Gate-Quota] Keeper identities baseline migration done: ${importedIdentities} identities imported.`);
      } catch (e) {
        console.warn('[Gate-Quota] Keeper identities baseline migration skipped or error:', e.message);
      }
    }
  } catch (err) {
    console.error('[Gate-Quota] Keeper migration failed:', err.message);
  } finally {
    if (keeperDb) {
      try { keeperDb.close(); } catch (e) {}
    }
  }
}

import Database from 'better-sqlite3';
import fs from 'fs';
import { GUARD_DIR, QUOTA_DB_PATH } from '../config.mjs';

// 兼容迁移：默认路径下存在旧 quota.db 而新 gate.db 不存在时，原地重命名（含 WAL/SHM）
if (!process.env.GATE_DB && !process.env.CPA_GUARD_DB && !fs.existsSync(QUOTA_DB_PATH)) {
  const legacy = `${GUARD_DIR}/quota.db`;
  if (fs.existsSync(legacy)) {
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.renameSync(legacy + suffix, QUOTA_DB_PATH + suffix); } catch (e) {}
    }
    console.log('[Gate-Quota] Migrated legacy quota.db -> gate.db');
  }
}

// 确保父目录存在（特别是在指定临时测试目录时）
import path from 'path';
const parentDir = path.dirname(QUOTA_DB_PATH);
if (!fs.existsSync(parentDir)) {
  try { fs.mkdirSync(parentDir, { recursive: true }); } catch (_) {}
}

// 初始化 SQLite 数据库实例
export const quotaDb = new Database(QUOTA_DB_PATH);
quotaDb.pragma('journal_mode = WAL');
quotaDb.pragma('synchronous = NORMAL');
quotaDb.pragma('cache_size = -32000');
quotaDb.pragma('mmap_size = 300000000');
quotaDb.pragma('temp_store = MEMORY');

// 建表与初始索引
quotaDb.exec(`
  CREATE TABLE IF NOT EXISTS keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    api_key TEXT NOT NULL UNIQUE,
    alias TEXT DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS quota_rules (
    key_id INTEGER PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0,
    daily_limit INTEGER,
    hard_ratio REAL NOT NULL DEFAULT 1.2,
    rpm_limit INTEGER,
    model_whitelist TEXT DEFAULT '',
    model_group TEXT DEFAULT '',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS usage_daily (
    date TEXT NOT NULL,
    key_id INTEGER NOT NULL,
    model TEXT NOT NULL,
    requests INTEGER NOT NULL DEFAULT 0,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    cached_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    estimated_tokens INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (date, key_id, model)
  );
  CREATE TABLE IF NOT EXISTS request_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    key_id INTEGER,
    model TEXT,
    status INTEGER NOT NULL,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    cached_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    latency_ms INTEGER NOT NULL DEFAULT 0,
    ttft_ms INTEGER,
    stream INTEGER NOT NULL DEFAULT 0,
    estimated INTEGER NOT NULL DEFAULT 0,
    error_type TEXT,
    auth_index TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS usage_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    key_id INTEGER,
    model TEXT,
    status INTEGER NOT NULL,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    cached_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    latency_ms INTEGER NOT NULL DEFAULT 0,
    ttft_ms INTEGER,
    stream INTEGER NOT NULL DEFAULT 0,
    estimated INTEGER NOT NULL DEFAULT 0,
    error_type TEXT,
    auth_index TEXT DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_events_ts ON request_events (ts);
  CREATE INDEX IF NOT EXISTS idx_events_key_id ON request_events (key_id, id DESC);
  CREATE INDEX IF NOT EXISTS idx_events_auth_ts ON request_events (auth_index, ts);
  CREATE INDEX IF NOT EXISTS idx_events_ts_id ON request_events (ts DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_outbox_id ON usage_outbox (id);
  CREATE INDEX IF NOT EXISTS idx_daily_date ON usage_daily (date);
  CREATE INDEX IF NOT EXISTS idx_daily_date_key ON usage_daily (date, key_id);
  CREATE TABLE IF NOT EXISTS meta (
    k TEXT PRIMARY KEY,
    v TEXT
  );
  CREATE TABLE IF NOT EXISTS error_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    key_id INTEGER,
    auth_index TEXT,
    provider TEXT,
    model TEXT,
    status INTEGER NOT NULL,
    error_type TEXT,
    error_body TEXT,
    retry_after_ms INTEGER DEFAULT 0,
    recover_at INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_error_events_ts ON error_events (ts);
  CREATE INDEX IF NOT EXISTS idx_error_events_auth ON error_events (auth_index);
  CREATE INDEX IF NOT EXISTS idx_error_events_ts_id ON error_events (ts DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_daily_key_id ON usage_daily (key_id);
  CREATE TABLE IF NOT EXISTS model_prices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pattern TEXT UNIQUE NOT NULL,
    prompt_price REAL NOT NULL,
    completion_price REAL NOT NULL,
    cache_read_price REAL NOT NULL,
    multiplier REAL NOT NULL DEFAULT 1.0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS quota_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    auth_index TEXT NOT NULL,
    provider TEXT NOT NULL,
    account_email TEXT,
    window_name TEXT,
    remaining_percent REAL NOT NULL,
    reset_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_quota_snapshots_auth_ts ON quota_snapshots (auth_index, ts);
  CREATE TABLE IF NOT EXISTS upstream_auth_baselines (
    auth_index TEXT PRIMARY KEY,
    name TEXT,
    provider TEXT,
    base_requests INTEGER NOT NULL DEFAULT 0,
    base_success_count INTEGER NOT NULL DEFAULT 0,
    base_failure_count INTEGER NOT NULL DEFAULT 0,
    base_prompt_tokens INTEGER NOT NULL DEFAULT 0,
    base_completion_tokens INTEGER NOT NULL DEFAULT 0,
    base_cached_tokens INTEGER NOT NULL DEFAULT 0,
    base_total_tokens INTEGER NOT NULL DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS upstream_daily_stats (
    date TEXT NOT NULL,
    auth_index TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT '',
    requests INTEGER NOT NULL DEFAULT 0,
    success_count INTEGER NOT NULL DEFAULT 0,
    failure_count INTEGER NOT NULL DEFAULT 0,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    cached_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (date, auth_index)
  );
  CREATE INDEX IF NOT EXISTS idx_upstream_daily_date ON upstream_daily_stats (date);
  CREATE INDEX IF NOT EXISTS idx_upstream_daily_auth ON upstream_daily_stats (auth_index);
  CREATE TABLE IF NOT EXISTS upstream_validations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    auth_index TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'antigravity',
    account_name TEXT,
    validation_url TEXT NOT NULL,
    error_message TEXT,
    raw_error TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_upstream_validations_auth ON upstream_validations(auth_index, status);
  CREATE INDEX IF NOT EXISTS idx_upstream_validations_status ON upstream_validations(status);

  -- 提供商注册表：AI 提供商身份的唯一真相源。
  -- 存在以前，provider 推断逻辑硬编码散落在 11 个文件 46 处，且把真实生产账号的
  -- auth_index 写死在源码里做特判（账号重登后哈希即变，特判立刻失效）。
  -- 现在统一由 lib/core/provider-registry.mjs 读取本表，CPA 同步与管理台均可写入。
  -- 注意：auth_patterns 只存通用前缀（如 step），绝不存具体账号的 auth_index。
  CREATE TABLE IF NOT EXISTS provider_registry (
    provider_key TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    model_patterns TEXT NOT NULL DEFAULT '[]',
    auth_patterns TEXT NOT NULL DEFAULT '[]',
    source TEXT NOT NULL DEFAULT 'builtin',
    enabled INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 100,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

// 容错补全旧版本表字段
const alterMigrations = [
  `ALTER TABLE upstream_auth_baselines ADD COLUMN base_prompt_tokens INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE upstream_auth_baselines ADD COLUMN base_completion_tokens INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE quota_rules ADD COLUMN model_whitelist TEXT DEFAULT '';`,
  `ALTER TABLE quota_rules ADD COLUMN model_group TEXT DEFAULT '';`,
  `ALTER TABLE quota_rules ADD COLUMN rpm_limit INTEGER;`,
  `ALTER TABLE usage_daily ADD COLUMN cached_tokens INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE usage_daily ADD COLUMN success_count INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE usage_daily ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE request_events ADD COLUMN cached_tokens INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE request_events ADD COLUMN ttft_ms INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE request_events ADD COLUMN auth_index TEXT DEFAULT '';`,
  `ALTER TABLE usage_outbox ADD COLUMN cached_tokens INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE usage_outbox ADD COLUMN ttft_ms INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE usage_outbox ADD COLUMN auth_index TEXT DEFAULT '';`,
  `ALTER TABLE provider_registry ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 100;`
];

// 一次性破坏性迁移：号池（custom_providers / custom_provider_keys）已随 Gate
// 架构职责收拢整体移除——凭证与提供商接入归 CPA，Gate 只做流量统计、调度与审计。
// 生产实测该号池 10 个 Key 全部已在 CPA 侧登记，且其唯一一次真实调用（404）失败、
// 同一模型随后经 CPA 直连成功，属纯冗余的第二套网关。
// 这里只删表结构，不碰 request_events 里的历史流水——审计记录必须保留。
const dropMigrations = [
  `DROP TABLE IF EXISTS custom_provider_keys;`,
  `DROP TABLE IF EXISTS custom_providers;`
];

for (const sql of alterMigrations) {
  try { quotaDb.exec(sql); } catch (e) {}
}

for (const sql of dropMigrations) {
  try { quotaDb.exec(sql); } catch (e) {}
}

// Prepared Statements
export const stmtSelectRules = quotaDb.prepare('SELECT key_id, enabled, daily_limit, hard_ratio, rpm_limit, model_whitelist, model_group FROM quota_rules');
export const stmtUpsertRule = quotaDb.prepare(`
  INSERT INTO quota_rules (key_id, enabled, daily_limit, hard_ratio, rpm_limit, model_whitelist, model_group, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(key_id) DO UPDATE SET
    enabled = excluded.enabled,
    daily_limit = excluded.daily_limit,
    hard_ratio = excluded.hard_ratio,
    rpm_limit = excluded.rpm_limit,
    model_whitelist = excluded.model_whitelist,
    model_group = excluded.model_group,
    updated_at = CURRENT_TIMESTAMP
`);
export const stmtDeleteRule = quotaDb.prepare('DELETE FROM quota_rules WHERE key_id = ?');

export const stmtKeyById = quotaDb.prepare('SELECT id, api_key, alias, active FROM keys WHERE id = ?');
export const stmtKeyByRaw = quotaDb.prepare('SELECT id, api_key, alias, active FROM keys WHERE api_key = ?');
export const stmtInsertKey = quotaDb.prepare('INSERT INTO keys (api_key, alias, active) VALUES (?, ?, 1)');
export const stmtUpdateKeyRaw = quotaDb.prepare("UPDATE keys SET api_key = ?, updated_at = datetime('now') WHERE id = ?");
export const stmtSetActive = quotaDb.prepare("UPDATE keys SET active = ?, updated_at = datetime('now') WHERE id = ?");
export const stmtUpdateAlias = quotaDb.prepare("UPDATE keys SET alias = ?, updated_at = datetime('now') WHERE id = ?");
export const stmtAllKeys = quotaDb.prepare('SELECT id, api_key, alias, active FROM keys');

export const stmtDailyUpsert = quotaDb.prepare(`
  INSERT INTO usage_daily (date, key_id, model, requests, prompt_tokens, completion_tokens, cached_tokens, total_tokens, estimated_tokens, success_count, failure_count)
  VALUES (@date, @key_id, @model, @requests, @prompt_tokens, @completion_tokens, @cached_tokens, @total_tokens, @estimated_tokens, @success_count, @failure_count)
  ON CONFLICT(date, key_id, model) DO UPDATE SET
    requests = requests + excluded.requests,
    prompt_tokens = prompt_tokens + excluded.prompt_tokens,
    completion_tokens = completion_tokens + excluded.completion_tokens,
    cached_tokens = cached_tokens + excluded.cached_tokens,
    total_tokens = total_tokens + excluded.total_tokens,
    estimated_tokens = estimated_tokens + excluded.estimated_tokens,
    success_count = success_count + excluded.success_count,
    failure_count = failure_count + excluded.failure_count
`);
export const stmtDailyForDate = quotaDb.prepare('SELECT key_id, model, requests, prompt_tokens, completion_tokens, cached_tokens, total_tokens, estimated_tokens, success_count, failure_count FROM usage_daily WHERE date = ?');
export const stmtDailyForDateKey = quotaDb.prepare(`
  SELECT
    COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
    COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
    COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
    COALESCE(SUM(total_tokens), 0) AS total_tokens,
    COALESCE(SUM(requests), 0) AS requests
  FROM usage_daily
  WHERE date = ? AND key_id = ?
`);
export const stmtDailyRange = quotaDb.prepare(`
  SELECT date,
         SUM(requests) AS requests,
         SUM(prompt_tokens) AS prompt_tokens,
         SUM(completion_tokens) AS completion_tokens,
         SUM(cached_tokens) AS cached_tokens,
         SUM(total_tokens) AS total_tokens,
         SUM(success_count) AS success_count,
         SUM(failure_count) AS failure_count
  FROM usage_daily WHERE date >= ? GROUP BY date ORDER BY date
`);
export const stmtDailyRangeByKey = quotaDb.prepare(`
  SELECT date,
         SUM(requests) AS requests,
         SUM(prompt_tokens) AS prompt_tokens,
         SUM(completion_tokens) AS completion_tokens,
         SUM(cached_tokens) AS cached_tokens,
         SUM(total_tokens) AS total_tokens,
         SUM(success_count) AS success_count,
         SUM(failure_count) AS failure_count
  FROM usage_daily WHERE date >= ? AND key_id = ? GROUP BY date ORDER BY date
`);
export const stmtModelRange = quotaDb.prepare(`
  SELECT model,
         SUM(requests) AS requests,
         SUM(prompt_tokens) AS prompt_tokens,
         SUM(completion_tokens) AS completion_tokens,
         SUM(cached_tokens) AS cached_tokens,
         SUM(total_tokens) AS total_tokens,
         SUM(success_count) AS success_count,
         SUM(failure_count) AS failure_count
  FROM usage_daily WHERE date >= ? GROUP BY model ORDER BY total_tokens DESC
`);
export const stmtModelRangeByKey = quotaDb.prepare(`
  SELECT model,
         SUM(requests) AS requests,
         SUM(prompt_tokens) AS prompt_tokens,
         SUM(completion_tokens) AS completion_tokens,
         SUM(cached_tokens) AS cached_tokens,
         SUM(total_tokens) AS total_tokens,
         SUM(success_count) AS success_count,
         SUM(failure_count) AS failure_count
  FROM usage_daily WHERE date >= ? AND key_id = ? GROUP BY model ORDER BY total_tokens DESC
`);
export const stmtDailyAllTime = quotaDb.prepare(`
  SELECT COALESCE(SUM(requests), 0) AS requests,
         COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
         COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
         COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
         COALESCE(SUM(total_tokens), 0) AS total_tokens,
         COALESCE(SUM(success_count), 0) AS success_count,
         COALESCE(SUM(failure_count), 0) AS failure_count
  FROM usage_daily
`);
export const stmtDailyAllTimeByKey = quotaDb.prepare(`
  SELECT COALESCE(SUM(requests), 0) AS requests,
         COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
         COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
         COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
         COALESCE(SUM(total_tokens), 0) AS total_tokens,
         COALESCE(SUM(success_count), 0) AS success_count,
         COALESCE(SUM(failure_count), 0) AS failure_count
  FROM usage_daily WHERE key_id = ?
`);
export const stmtDailyAllTimeByAllKeys = quotaDb.prepare(`
  SELECT key_id,
         COALESCE(SUM(requests), 0) AS requests,
         COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
         COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
         COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
         COALESCE(SUM(total_tokens), 0) AS total_tokens,
         COALESCE(SUM(success_count), 0) AS success_count,
         COALESCE(SUM(failure_count), 0) AS failure_count
  FROM usage_daily GROUP BY key_id
`);
export const stmtModelAllTime = quotaDb.prepare(`
  SELECT model,
         SUM(prompt_tokens) AS prompt_tokens,
         SUM(completion_tokens) AS completion_tokens,
         SUM(cached_tokens) AS cached_tokens,
         SUM(total_tokens) AS total_tokens
  FROM usage_daily GROUP BY model
`);
export const stmtModelAllTimeByKey = quotaDb.prepare(`
  SELECT model,
         SUM(prompt_tokens) AS prompt_tokens,
         SUM(completion_tokens) AS completion_tokens,
         SUM(cached_tokens) AS cached_tokens,
         SUM(total_tokens) AS total_tokens
  FROM usage_daily WHERE key_id = ? GROUP BY model
`);
export const stmtDailyAllTimeGrouped = quotaDb.prepare(`
  SELECT date,
         SUM(requests) AS requests,
         SUM(prompt_tokens) AS prompt_tokens,
         SUM(completion_tokens) AS completion_tokens,
         SUM(cached_tokens) AS cached_tokens,
         SUM(total_tokens) AS total_tokens,
         SUM(success_count) AS success_count,
         SUM(failure_count) AS failure_count
  FROM usage_daily GROUP BY date ORDER BY date
`);
export const stmtDailyAllTimeGroupedByKey = quotaDb.prepare(`
  SELECT date,
         SUM(requests) AS requests,
         SUM(prompt_tokens) AS prompt_tokens,
         SUM(completion_tokens) AS completion_tokens,
         SUM(cached_tokens) AS cached_tokens,
         SUM(total_tokens) AS total_tokens,
         SUM(success_count) AS success_count,
         SUM(failure_count) AS failure_count
  FROM usage_daily WHERE key_id = ? GROUP BY date ORDER BY date
`);
export const stmtModelAllTimeDetailed = quotaDb.prepare(`
  SELECT model,
         SUM(requests) AS requests,
         SUM(prompt_tokens) AS prompt_tokens,
         SUM(completion_tokens) AS completion_tokens,
         SUM(cached_tokens) AS cached_tokens,
         SUM(total_tokens) AS total_tokens,
         SUM(success_count) AS success_count,
         SUM(failure_count) AS failure_count
  FROM usage_daily GROUP BY model ORDER BY total_tokens DESC
`);
export const stmtModelAllTimeDetailedByKey = quotaDb.prepare(`
  SELECT model,
         SUM(requests) AS requests,
         SUM(prompt_tokens) AS prompt_tokens,
         SUM(completion_tokens) AS completion_tokens,
         SUM(cached_tokens) AS cached_tokens,
         SUM(total_tokens) AS total_tokens,
         SUM(success_count) AS success_count,
         SUM(failure_count) AS failure_count
  FROM usage_daily WHERE key_id = ? GROUP BY model ORDER BY total_tokens DESC
`);
export const stmtDailyModelsRange = quotaDb.prepare(`
  SELECT date, model,
         SUM(prompt_tokens) AS prompt_tokens,
         SUM(completion_tokens) AS completion_tokens,
         SUM(cached_tokens) AS cached_tokens
  FROM usage_daily WHERE date >= ? GROUP BY date, model
`);
export const stmtDailyModelsRangeByKey = quotaDb.prepare(`
  SELECT date, model,
         SUM(prompt_tokens) AS prompt_tokens,
         SUM(completion_tokens) AS completion_tokens,
         SUM(cached_tokens) AS cached_tokens
  FROM usage_daily WHERE date >= ? AND key_id = ? GROUP BY date, model
`);
export const stmtDailyModelsAllTime = quotaDb.prepare(`
  SELECT date, model,
         SUM(prompt_tokens) AS prompt_tokens,
         SUM(completion_tokens) AS completion_tokens,
         SUM(cached_tokens) AS cached_tokens
  FROM usage_daily GROUP BY date, model
`);
export const stmtDailyModelsAllTimeByKey = quotaDb.prepare(`
  SELECT date, model,
         SUM(prompt_tokens) AS prompt_tokens,
         SUM(completion_tokens) AS completion_tokens,
         SUM(cached_tokens) AS cached_tokens
  FROM usage_daily WHERE key_id = ? GROUP BY date, model
`);
export const stmtEventsInsert = quotaDb.prepare(`
  INSERT INTO request_events (ts, key_id, model, status, prompt_tokens, completion_tokens, cached_tokens, total_tokens, latency_ms, ttft_ms, stream, estimated, error_type, auth_index)
  VALUES (@ts, @key_id, @model, @status, @prompt_tokens, @completion_tokens, @cached_tokens, @total_tokens, @latency_ms, @ttft_ms, @stream, @estimated, @error_type, @auth_index)
`);
export const stmtOutboxInsert = quotaDb.prepare(`
  INSERT INTO usage_outbox (ts, key_id, model, status, prompt_tokens, completion_tokens, cached_tokens, total_tokens, latency_ms, ttft_ms, stream, estimated, error_type, auth_index)
  VALUES (@ts, @key_id, @model, @status, @prompt_tokens, @completion_tokens, @cached_tokens, @total_tokens, @latency_ms, @ttft_ms, @stream, @estimated, @error_type, @auth_index)
`);
export const stmtOutboxAll = quotaDb.prepare('SELECT id, ts, key_id, model, status, prompt_tokens, completion_tokens, cached_tokens, total_tokens, latency_ms, ttft_ms, stream, estimated, error_type, auth_index FROM usage_outbox ORDER BY id');
export const stmtOutboxDelete = quotaDb.prepare('DELETE FROM usage_outbox WHERE id = ?');
export const stmtOutboxCount = quotaDb.prepare('SELECT COUNT(*) AS count FROM usage_outbox');
export const stmtEventsRecent = quotaDb.prepare('SELECT * FROM request_events ORDER BY id DESC LIMIT ?');
export const stmtEventsRecentByKey = quotaDb.prepare('SELECT * FROM request_events WHERE key_id = ? ORDER BY id DESC LIMIT ?');
export const stmtEventsForStatus = quotaDb.prepare('SELECT ts, model, status, latency_ms, ttft_ms, stream, auth_index FROM request_events WHERE ts >= ? ORDER BY id DESC LIMIT 3000');
export const stmtEventsPrune = quotaDb.prepare('DELETE FROM request_events WHERE id <= (SELECT MAX(id) FROM request_events) - ? OR ts < ?');
export const stmtDailyPrune = quotaDb.prepare('DELETE FROM usage_daily WHERE date < ?');
export const stmtMetaGet = quotaDb.prepare('SELECT v FROM meta WHERE k = ?');
export const stmtMetaSet = quotaDb.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v');

export const stmtBaselineUpsert = quotaDb.prepare(`
  INSERT INTO upstream_auth_baselines (
    auth_index, name, provider,
    base_requests, base_success_count, base_failure_count,
    base_prompt_tokens, base_completion_tokens, base_cached_tokens, base_total_tokens,
    updated_at
  )
  VALUES (
    @auth_index, @name, @provider,
    @base_requests, @base_success_count, @base_failure_count,
    @base_prompt_tokens, @base_completion_tokens, @base_cached_tokens, @base_total_tokens,
    CURRENT_TIMESTAMP
  )
  ON CONFLICT(auth_index) DO UPDATE SET
    name = excluded.name,
    provider = excluded.provider,
    base_requests = excluded.base_requests,
    base_success_count = excluded.base_success_count,
    base_failure_count = excluded.base_failure_count,
    base_prompt_tokens = excluded.base_prompt_tokens,
    base_completion_tokens = excluded.base_completion_tokens,
    base_cached_tokens = excluded.base_cached_tokens,
    base_total_tokens = excluded.base_total_tokens,
    updated_at = CURRENT_TIMESTAMP
`);
export const stmtBaselinesAll = quotaDb.prepare('SELECT * FROM upstream_auth_baselines');
export const stmtUpstreamDailyUpsert = quotaDb.prepare(`
  INSERT INTO upstream_daily_stats (
    date, auth_index, provider, requests, success_count, failure_count,
    prompt_tokens, completion_tokens, cached_tokens, total_tokens
  )
  VALUES (
    @date, @auth_index, @provider, @requests, @success_count, @failure_count,
    @prompt_tokens, @completion_tokens, @cached_tokens, @total_tokens
  )
  ON CONFLICT(date, auth_index) DO UPDATE SET
    requests = requests + excluded.requests,
    success_count = success_count + excluded.success_count,
    failure_count = failure_count + excluded.failure_count,
    prompt_tokens = prompt_tokens + excluded.prompt_tokens,
    completion_tokens = completion_tokens + excluded.completion_tokens,
    cached_tokens = cached_tokens + excluded.cached_tokens,
    total_tokens = total_tokens + excluded.total_tokens
`);
export const stmtUpstreamDailyAgg = quotaDb.prepare(`
  SELECT
    auth_index,
    SUM(requests) AS requests,
    SUM(success_count) AS success_count,
    SUM(failure_count) AS failure_count,
    SUM(prompt_tokens) AS prompt_tokens,
    SUM(completion_tokens) AS completion_tokens,
    SUM(cached_tokens) AS cached_tokens,
    SUM(total_tokens) AS total_tokens
  FROM upstream_daily_stats
  WHERE auth_index != ''
  GROUP BY auth_index
`);
export const stmtUpstreamDailyAggSince = quotaDb.prepare(`
  SELECT
    auth_index,
    SUM(requests) AS requests,
    SUM(success_count) AS success_count,
    SUM(failure_count) AS failure_count,
    SUM(prompt_tokens) AS prompt_tokens,
    SUM(completion_tokens) AS completion_tokens,
    SUM(cached_tokens) AS cached_tokens,
    SUM(total_tokens) AS total_tokens
  FROM upstream_daily_stats
  WHERE auth_index != '' AND date >= ?
  GROUP BY auth_index
`);
export const stmtBaselineAddDelta = quotaDb.prepare(`
  INSERT INTO upstream_auth_baselines (
    auth_index, name, provider,
    base_requests, base_success_count, base_failure_count,
    base_prompt_tokens, base_completion_tokens, base_cached_tokens, base_total_tokens,
    updated_at
  )
  VALUES (
    @auth_index, @name, @provider,
    @requests, @success_count, @failure_count,
    @prompt_tokens, @completion_tokens, @cached_tokens, @total_tokens,
    CURRENT_TIMESTAMP
  )
  ON CONFLICT(auth_index) DO UPDATE SET
    base_requests = base_requests + excluded.base_requests,
    base_success_count = base_success_count + excluded.base_success_count,
    base_failure_count = base_failure_count + excluded.base_failure_count,
    base_prompt_tokens = base_prompt_tokens + excluded.base_prompt_tokens,
    base_completion_tokens = base_completion_tokens + excluded.base_completion_tokens,
    base_cached_tokens = base_cached_tokens + excluded.base_cached_tokens,
    base_total_tokens = base_total_tokens + excluded.base_total_tokens,
    updated_at = CURRENT_TIMESTAMP
`);
export const stmtAuthEventsAgg = quotaDb.prepare(`
  SELECT
    auth_index,
    COUNT(*) AS requests,
    SUM(CASE WHEN status >= 200 AND status < 400 THEN 1 ELSE 0 END) AS success_count,
    SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS failure_count,
    SUM(prompt_tokens) AS prompt_tokens,
    SUM(completion_tokens) AS completion_tokens,
    SUM(cached_tokens) AS cached_tokens,
    SUM(total_tokens) AS total_tokens
  FROM request_events
  WHERE auth_index != ''
  GROUP BY auth_index
`);
export const stmtAuthEventsAggSince = quotaDb.prepare(`
  SELECT
    auth_index,
    COUNT(*) AS requests,
    SUM(CASE WHEN status >= 200 AND status < 400 THEN 1 ELSE 0 END) AS success_count,
    SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS failure_count,
    SUM(prompt_tokens) AS prompt_tokens,
    SUM(completion_tokens) AS completion_tokens,
    SUM(cached_tokens) AS cached_tokens,
    SUM(total_tokens) AS total_tokens
  FROM request_events
  WHERE auth_index != '' AND ts >= ?
  GROUP BY auth_index
`);

// 每个 auth_index 最近一次请求的模型，仅用于提供商身份推断。
// 不能往上面的聚合语句里加 model：那会破坏 GROUP BY 语义，且它是热门语句。
// 这里用「取最新一条」而不是「取出现最多的模型」——最近一次请求最能反映
// 这个账号当前在跑什么，账号换渠道后旧模型不该继续代表它。
export const stmtLatestModelByAuth = quotaDb.prepare(`
  SELECT auth_index, model
  FROM (
    SELECT auth_index, model,
           ROW_NUMBER() OVER (PARTITION BY auth_index ORDER BY ts DESC, id DESC) AS rn
    FROM request_events
    WHERE auth_index != '' AND model != ''
  )
  WHERE rn = 1
`);

export const stmtErrorInsert = quotaDb.prepare(`
  INSERT INTO error_events (ts, key_id, auth_index, provider, model, status, error_type, error_body, retry_after_ms, recover_at)
  VALUES (@ts, @key_id, @auth_index, @provider, @model, @status, @error_type, @error_body, @retry_after_ms, @recover_at)
`);
export const stmtErrorsRecent = quotaDb.prepare('SELECT * FROM error_events ORDER BY ts DESC, id DESC LIMIT ?');
export const stmtActiveErrors = quotaDb.prepare('SELECT * FROM error_events WHERE recover_at > ? ORDER BY recover_at DESC');

export const stmtModelPriceAll = quotaDb.prepare('SELECT id, pattern, prompt_price, completion_price, cache_read_price, multiplier FROM model_prices ORDER BY LENGTH(pattern) DESC, id DESC');
export const stmtModelPriceInsert = quotaDb.prepare(`
  INSERT INTO model_prices (pattern, prompt_price, completion_price, cache_read_price, multiplier, updated_at)
  VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
`);
export const stmtModelPriceUpdate = quotaDb.prepare(`
  UPDATE model_prices SET pattern = ?, prompt_price = ?, completion_price = ?, cache_read_price = ?, multiplier = ?, updated_at = CURRENT_TIMESTAMP
  WHERE id = ?
`);
export const stmtModelPriceDelete = quotaDb.prepare('DELETE FROM model_prices WHERE id = ?');

export const stmtQuotaSnapshotInsert = quotaDb.prepare(`
  INSERT INTO quota_snapshots (ts, auth_index, provider, account_email, window_name, remaining_percent, reset_at)
  VALUES (@ts, @auth_index, @provider, @account_email, @window_name, @remaining_percent, @reset_at)
`);
export const stmtQuotaSnapshotsByAuth = quotaDb.prepare(`
  SELECT ts, window_name, remaining_percent, reset_at
  FROM quota_snapshots
  WHERE auth_index = ? AND ts >= ?
  ORDER BY ts ASC
`);

export const stmtValidationFindPending = quotaDb.prepare(`
  SELECT * FROM upstream_validations
  WHERE auth_index = ? AND status = 'pending'
  ORDER BY id DESC LIMIT 1
`);
export const stmtValidationInsert = quotaDb.prepare(`
  INSERT INTO upstream_validations (ts, auth_index, provider, account_name, validation_url, error_message, raw_error, status, updated_at)
  VALUES (@ts, @auth_index, @provider, @account_name, @validation_url, @error_message, @raw_error, 'pending', @updated_at)
`);
export const stmtValidationUpdate = quotaDb.prepare(`
  UPDATE upstream_validations
  SET validation_url = @validation_url,
      error_message = @error_message,
      raw_error = @raw_error,
      account_name = COALESCE(@account_name, account_name),
      updated_at = @updated_at
  WHERE id = @id
`);
export const stmtValidationResolve = quotaDb.prepare(`
  UPDATE upstream_validations
  SET status = 'resolved', updated_at = ?
  WHERE id = ?
`);
export const stmtValidationResolveByAuth = quotaDb.prepare(`
  UPDATE upstream_validations
  SET status = 'resolved', updated_at = ?
  WHERE auth_index = ? AND status = 'pending'
`);
export const stmtValidationDismiss = quotaDb.prepare(`
  UPDATE upstream_validations
  SET status = 'dismissed', updated_at = ?
  WHERE id = ?
`);
export const stmtValidationDelete = quotaDb.prepare(`
  DELETE FROM upstream_validations
  WHERE id = ?
`);
export const stmtValidationAllRecent = quotaDb.prepare(`
  SELECT * FROM upstream_validations
  ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, updated_at DESC
  LIMIT ?
`);
export const stmtValidationPendingList = quotaDb.prepare(`
  SELECT * FROM upstream_validations
  WHERE status = 'pending'
  ORDER BY updated_at DESC
`);

// -------------------------------------------------------------
// 提供商注册表 (Provider Registry) Prepared Statements
// 由 lib/core/provider-registry.mjs 独家读写，业务代码不得直连本表。
// -------------------------------------------------------------
export const stmtProviderRegistryAll = quotaDb.prepare(`
  SELECT provider_key, label, model_patterns, auth_patterns, source, enabled, sort_order, created_at, updated_at
  FROM provider_registry
  ORDER BY sort_order ASC, provider_key ASC
`);
export const stmtProviderRegistryByKey = quotaDb.prepare(`
  SELECT provider_key, label, model_patterns, auth_patterns, source, enabled, sort_order, created_at, updated_at
  FROM provider_registry
  WHERE provider_key = ?
`);
export const stmtProviderRegistryUpsert = quotaDb.prepare(`
  INSERT INTO provider_registry (provider_key, label, model_patterns, auth_patterns, source, enabled, sort_order, updated_at)
  VALUES (@provider_key, @label, @model_patterns, @auth_patterns, @source, @enabled, @sort_order, datetime('now'))
  ON CONFLICT(provider_key) DO UPDATE SET
    label = excluded.label,
    model_patterns = excluded.model_patterns,
    auth_patterns = excluded.auth_patterns,
    source = excluded.source,
    enabled = excluded.enabled,
    sort_order = excluded.sort_order,
    updated_at = datetime('now')
`);
export const stmtProviderRegistryDelete = quotaDb.prepare(`
  DELETE FROM provider_registry WHERE provider_key = ?
`);


import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { isolateTestDb } from './_isolated-db.mjs';

// 隔离到临时空库：本用例自己造 fixtures，绝不能读开发机的真实 gate.db。
isolateTestDb(import.meta.url, 'gate-pagination');

process.env.GATE_MGMT_SECRET = 'local-pagination-test-secret-123456';
process.env.GATE_MGMT_PORT = '1';

const { getPagedRequests, getPagedErrorEvents, recordUpstreamValidation, getPendingUpstreamValidations, getUsageStats, getAdminData } = await import('../quota-manager.mjs');
const db = new Database(process.env.GATE_DB);
const insertRequest = db.prepare(`INSERT INTO request_events
  (ts, key_id, model, status, cached_tokens) VALUES (?, ?, ?, ?, ?)`);
insertRequest.run(100, 1, 'old-model', 200, 0);
insertRequest.run(101, 2, 'new-model', 403, 0);
insertRequest.run(102, 1, 'cache-model', 200, 20);
db.prepare(`INSERT INTO error_events (ts, key_id, model, status, error_type) VALUES (100, 1, 'old-model', 500, 'upstream_status_500')`).run();
db.prepare(`INSERT INTO error_events (ts, key_id, model, status, error_type) VALUES (101, 2, 'new-model', 403, 'upstream_validation_required')`).run();
db.prepare(`INSERT INTO usage_daily (date, key_id, model, requests, total_tokens) VALUES (?, ?, ?, ?, ?)`).run('2026-10-01', 1, 'gpt-4o', 5, 50000);

assert.deepEqual(getPagedRequests({ page: 1, pageSize: 2 }).events.map(e => e.model), ['cache-model', 'new-model']);
assert.deepEqual(getPagedRequests({ page: 2, pageSize: 2 }).events.map(e => e.model), ['old-model']);
assert.equal(getPagedRequests({ page: 1, pageSize: 25, keyId: 1, filter: 'cached' }).total, 1);
assert.equal(getPagedRequests({ page: 1, search: 'old-model' }).total, 1);
assert.equal(getPagedRequests({ page: 1, since: 101 }).total, 2);
assert.equal(getPagedRequests({ page: 1, until: 100 }).total, 1);
assert.equal(getPagedRequests({ page: 1, beforeId: 3, pageSize: 1 }).events[0].id, 2);
assert.equal(getPagedErrorEvents({ page: 2, pageSize: 1 }).errors[0].ts, 100000);
assert.equal(getPagedErrorEvents({ since: 101 }).total, 1);
assert.equal(getPagedErrorEvents({ beforeId: 2 }).errors.length, 1);
assert.equal(recordUpstreamValidation({ authIndex: 'acct-1', validationUrl: 'https://evil.example/' }), null);
assert.ok(recordUpstreamValidation({ authIndex: 'acct-1', validationUrl: '', allowMissingUrl: true }));
assert.equal(getPendingUpstreamValidations()[0].validation_url, '');

const stats = getUsageStats();
assert.ok('all_time_tokens' in stats.summary, 'summary contains all_time_tokens');
assert.ok('all_time_requests' in stats.summary, 'summary contains all_time_requests');
assert.ok(stats.summary.all_time_tokens >= 50000, 'all_time_tokens aggregates usage_daily');

const adminData = getAdminData();
assert.ok(Array.isArray(adminData.keys), 'getAdminData returns keys array');

db.close();
console.log('request and error pagination and all-time usage passed');

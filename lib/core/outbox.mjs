import {
  stmtDailyUpsert,
  stmtDailyForDate,
  stmtOutboxAll,
  stmtOutboxDelete,
  stmtOutboxInsert,
  stmtEventsInsert,
  stmtUpstreamDailyUpsert,
  quotaDb
} from '../db/sqlite.mjs';
import { notifyEvent } from '../../notify.mjs';
import { recordLiveTraffic } from '../analytics/live-traffic-tracker.mjs';
import { calculateTokensPerSec } from '../proxy/token-estimator.mjs';

export function shanghaiDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(d);
}

export let usageDate = shanghaiDate();
export let preloadedToday = new Map();         // key_id -> tokens（DB 中今日已落盘量）
export let preloadedTodayRequests = new Map(); // key_id -> requests（DB 中今日已落盘量）
export const liveTodayTokensByKeyId = new Map();   // key_id -> tokens（今日内存中未刷盘量，纳秒级O(1)查找）
export const liveTodayRequestsByKeyId = new Map(); // key_id -> requests（今日内存中未刷盘量，纳秒级O(1)查找）
export const liveUsage = new Map();            // "date|key_id|model" -> { requests, prompt_tokens, ... }
export const pendingEvents = [];               // 待落盘 request_events

export let lastFlushTimestamp = 0;
export let lastFlushError = null;
export let flushFailureCount = 0;
export let flushInProgress = false;

export function reloadPreloadedToday() {
  preloadedToday = new Map();
  preloadedTodayRequests = new Map();
  for (const row of stmtDailyForDate.all(usageDate)) {
    preloadedToday.set(row.key_id, (preloadedToday.get(row.key_id) || 0) + (row.total_tokens || 0));
    preloadedTodayRequests.set(row.key_id, (preloadedTodayRequests.get(row.key_id) || 0) + (row.requests || 0));
  }
}

export function addLiveUsage(event) {
  const date = shanghaiDate(new Date(event.ts * 1000));
  const keyId = event.key_id == null ? 0 : event.key_id;
  const model = (event.model || 'unknown').toLowerCase().slice(0, 120) || 'unknown';
  const bucket = `${date}|${keyId}|${model}`;
  let agg = liveUsage.get(bucket);
  if (!agg) {
    agg = { requests: 0, prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0, total_tokens: 0, estimated_tokens: 0 };
    liveUsage.set(bucket, agg);
  }
  agg.requests += 1;
  agg.prompt_tokens += event.prompt_tokens;
  agg.completion_tokens += event.completion_tokens;
  agg.cached_tokens += (event.cached_tokens || 0);
  agg.total_tokens += event.total_tokens;
  if (event.estimated) agg.estimated_tokens += event.total_tokens;

  if (date === usageDate) {
    liveTodayTokensByKeyId.set(keyId, (liveTodayTokensByKeyId.get(keyId) || 0) + event.total_tokens);
    liveTodayRequestsByKeyId.set(keyId, (liveTodayRequestsByKeyId.get(keyId) || 0) + 1);
  }
}

export function replayOutboxIntoMemory() {
  for (const event of stmtOutboxAll.all()) addLiveUsage(event);
}

export function normalizeRequestEvent(info) {
  const prompt = Math.max(0, Math.round(info.promptTokens) || 0);
  const completion = Math.max(0, Math.round(info.completionTokens) || 0);
  const cached = Math.max(0, Math.round(info.cachedTokens) || 0);
  let total = Math.round(info.totalTokens);
  if (!Number.isFinite(total) || total <= 0) total = prompt + completion;

  const latency = Math.max(0, Math.round(info.latencyMs) || 0);
  const ttft = Math.max(0, Math.round(info.ttftMs) || 0);
  const stream = info.stream ? 1 : 0;

  let tps = Number(info.tokensPerSec);
  if (!Number.isFinite(tps) || tps <= 0) {
    tps = calculateTokensPerSec(completion, latency, ttft, Boolean(stream));
  } else {
    tps = Math.round(tps * 10) / 10;
  }

  const reasoningEffort = String(info.reasoningEffort || '').trim().slice(0, 32);

  return {
    ts: Math.floor(Date.now() / 1000),
    key_id: info.keyId == null ? null : info.keyId,
    model: (info.model || 'unknown').toLowerCase().slice(0, 120) || 'unknown',
    status: info.status || 0,
    prompt_tokens: prompt,
    completion_tokens: completion,
    cached_tokens: cached,
    total_tokens: total,
    latency_ms: latency,
    ttft_ms: ttft,
    stream: stream,
    estimated: info.estimated ? 1 : 0,
    error_type: info.errorType || null,
    auth_index: String(info.authIndex || '').trim().slice(0, 64),
    reasoning_effort: reasoningEffort,
    tokens_per_sec: tps
  };
}

export function addPendingEvent(event, error) {
  pendingEvents.push(event);
  addLiveUsage(event);
  console.error('[Gate-Quota] Usage enqueue failed; retaining exact event in memory for retry:', error.message);
}

export function getOutboxSnapshot() {
  return stmtOutboxAll.all();
}

export function flushUsage() {
  if (flushInProgress) return;
  flushInProgress = true;
  const now = new Date();
  const today = shanghaiDate(now);

  if (today !== usageDate) {
    usageDate = today;
    liveTodayTokensByKeyId.clear();
    liveTodayRequestsByKeyId.clear();
    reloadPreloadedToday();
  }

  const outboxRows = stmtOutboxAll.all();
  if (outboxRows.length === 0 && pendingEvents.length === 0) {
    lastFlushTimestamp = Date.now();
    lastFlushError = null;
    flushInProgress = false;
    return;
  }

  try {
    const tx = quotaDb.transaction(() => {
      for (const ev of outboxRows) {
        const date = shanghaiDate(new Date(ev.ts * 1000));
        const isSuccess = ev.status >= 200 && ev.status < 400 ? 1 : 0;
        const isFailure = isSuccess ? 0 : 1;
        stmtDailyUpsert.run({
          date,
          key_id: ev.key_id == null ? 0 : ev.key_id,
          model: ev.model || 'unknown',
          requests: 1,
          prompt_tokens: ev.prompt_tokens,
          completion_tokens: ev.completion_tokens,
          cached_tokens: ev.cached_tokens || 0,
          total_tokens: ev.total_tokens,
          estimated_tokens: ev.estimated ? ev.total_tokens : 0,
          success_count: isSuccess,
          failure_count: isFailure
        });

        if (ev.auth_index) {
          stmtUpstreamDailyUpsert.run({
            date,
            auth_index: ev.auth_index,
            provider: '',
            requests: 1,
            success_count: isSuccess,
            failure_count: isFailure,
            prompt_tokens: ev.prompt_tokens,
            completion_tokens: ev.completion_tokens,
            cached_tokens: ev.cached_tokens || 0,
            total_tokens: ev.total_tokens
          });
        }

        stmtEventsInsert.run(ev);
        stmtOutboxDelete.run(ev.id);
      }

      while (pendingEvents.length > 0) {
        const ev = pendingEvents.shift();
        const date = shanghaiDate(new Date(ev.ts * 1000));
        const isSuccess = ev.status >= 200 && ev.status < 400 ? 1 : 0;
        const isFailure = isSuccess ? 0 : 1;
        stmtDailyUpsert.run({
          date,
          key_id: ev.key_id == null ? 0 : ev.key_id,
          model: ev.model || 'unknown',
          requests: 1,
          prompt_tokens: ev.prompt_tokens,
          completion_tokens: ev.completion_tokens,
          cached_tokens: ev.cached_tokens || 0,
          total_tokens: ev.total_tokens,
          estimated_tokens: ev.estimated ? ev.total_tokens : 0,
          success_count: isSuccess,
          failure_count: isFailure
        });

        if (ev.auth_index) {
          stmtUpstreamDailyUpsert.run({
            date,
            auth_index: ev.auth_index,
            provider: '',
            requests: 1,
            success_count: isSuccess,
            failure_count: isFailure,
            prompt_tokens: ev.prompt_tokens,
            completion_tokens: ev.completion_tokens,
            cached_tokens: ev.cached_tokens || 0,
            total_tokens: ev.total_tokens
          });
        }

        stmtEventsInsert.run(ev);
      }
    });
    tx();

    liveUsage.clear();
    liveTodayTokensByKeyId.clear();
    liveTodayRequestsByKeyId.clear();
    pendingEvents.length = 0;
    if (today === usageDate) reloadPreloadedToday();

    lastFlushTimestamp = Date.now();
    lastFlushError = null;
    flushFailureCount = 0;
  } catch (err) {
    flushFailureCount++;
    lastFlushError = err.message;
    console.error('[Gate-Quota] Flush usage error:', err.message);
    notifyEvent('flush_failure', 'flush', `Gate 用量落盘事务失败：${err.message}`).catch(() => {});
  } finally {
    flushInProgress = false;
  }
}

export function recordRequest(info) {
  const event = normalizeRequestEvent(info);
  try {
    stmtOutboxInsert.run(event);
    addLiveUsage(event);
  } catch (e) {
    if (e && e.message && e.message.includes('SQLITE')) {
      addPendingEvent(event, e);
    } else {
      console.error('[Gate-Quota] Usage accounting error:', e.message);
    }
  }

  const isSuccess = event.status >= 200 && event.status < 400;
  recordLiveTraffic(event.ts, isSuccess);

  const date = shanghaiDate();
  if (date !== usageDate) {
    usageDate = date;
    reloadPreloadedToday();
  }
}

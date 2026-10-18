import { metrics } from '../proxy/circuit-breaker.mjs';
import { getQuotaHealth, getQuotaStatusSummary } from '../analytics/quota-health.mjs';
import { isShuttingDown, getActiveRequestCounts } from '../core/graceful-shutdown.mjs';

export function handleSystemRoutes(req, res, urlPath, METRICS_TOKEN) {
  if (urlPath === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ status: 'ok', service: 'gate', now: Date.now() }));
    return true;
  }

  if (urlPath === '/readyz') {
    const health = getQuotaHealth();
    const syncAge = health.sync?.last_sync_ago_ms != null ? health.sync.last_sync_ago_ms : Infinity;
    const flushAge = health.flush?.last_flush_ago_ms != null ? health.flush.last_flush_ago_ms : Infinity;
    const ready = syncAge < 30000 && flushAge < 30000 && !health.flush?.last_error;
    res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ status: ready ? 'ready' : 'not_ready', checks: health }));
    return true;
  }

  if (urlPath === '/api/status/quota' || urlPath === '/status/quota') {
    const summary = getQuotaStatusSummary();
    const url = new URL(req.url, 'http://localhost');
    const strict = url.searchParams.get('strict') === '1';
    let code = summary.http_code || summary.httpCode || 200;
    if (strict && summary.status === 'warning') code = 503;
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'X-Gate-Status': summary.status
    });
    res.end(JSON.stringify(summary));
    return true;
  }

  if (urlPath === '/metrics') {
    if (METRICS_TOKEN && req.headers.authorization !== `Bearer ${METRICS_TOKEN}`) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return true;
    }
    const health = getQuotaHealth();
    const lines = [...metrics.entries()].map(([key, value]) => `${key} ${value}`);
    lines.push(`gate_quota_pending_events ${health.outbox_count || 0}`);
    lines.push(`gate_quota_pending_outbox ${health.outbox_count || 0}`);
    lines.push(`gate_quota_flush_failures ${health.flush_failure_count || 0}`);
    lines.push(`gate_quota_sync_failures ${health.sync_failure_count || 0}`);
    lines.push(`gate_notify_sent_total ${health.notify?.sent_total || 0}`);
    lines.push(`gate_notify_failures_total ${health.notify?.failure_count || 0}`);

    // 优雅停机与排空指标
    const reqCounts = getActiveRequestCounts();
    lines.push(`gate_shutting_down ${isShuttingDown() ? 1 : 0}`);
    lines.push(`gate_in_flight_http_requests ${reqCounts.http}`);
    lines.push(`gate_in_flight_ws_requests ${reqCounts.ws}`);
    lines.push(`gate_in_flight_requests_total ${reqCounts.total}`);

    // 旧 cpa_guard_* 别名
    lines.push(`cpa_guard_quota_pending_events ${health.outbox_count || 0}`);
    lines.push(`cpa_guard_quota_pending_outbox ${health.outbox_count || 0}`);
    lines.push(`cpa_guard_quota_flush_failures ${health.flush_failure_count || 0}`);
    lines.push(`cpa_guard_quota_sync_failures ${health.sync_failure_count || 0}`);

    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(lines.join('\n') + '\n');
    return true;
  }

  return false;
}

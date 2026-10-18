import {
  resolveKeyId,
  getKeyInfoById,
  getGateStatusSummary,
  getPagedRequests,
  getRecentRequestsForKey,
  getTodayDetailsForKey,
  getAllTimeDetailsForKey,
  calculateModelCost,
  getTodayRequestsCount,
  getTodayErrorsCount
} from '../../quota-manager.mjs';
import { quotaRules } from '../core/engine.mjs';

function writeJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(payload));
}

export function handleMemberRoutes(req, res, urlPath) {
  if (!urlPath.startsWith('/api/member/')) return false;

  const authHeader = req.headers['authorization'] || '';
  const keyId = resolveKeyId(authHeader);
  if (!keyId) {
    res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Unauthorized: invalid or missing API Key' }));
    return true;
  }

  if (urlPath === '/api/member/info' && req.method === 'GET') {
    const info = getKeyInfoById(keyId);
    if (!info) {
      writeJson(res, 404, { error: 'API Key not found or inactive' });
      return true;
    }
    const rule = quotaRules.get(keyId) || { enabled: false, daily_limit: 0, model_whitelist: '' };
    const today = getTodayDetailsForKey(keyId);
    const allTime = getAllTimeDetailsForKey(keyId);
    const pBase = Math.max(today.prompt, today.cached);
    const hitRate = pBase > 0 ? Math.round((today.cached / pBase) * 1000) / 10 : 0;
    const cost = calculateModelCost('default', today.prompt, today.completion, today.cached);

    const payload = {
      ...info,
      key_alias: info.alias,
      enabled: rule.enabled,
      daily_limit: rule.daily_limit || 0,
      model_whitelist: rule.model_whitelist ? rule.model_whitelist.split(',').map(s => s.trim()).filter(Boolean) : [],
      today_tokens: today.total,
      today_prompt_tokens: today.prompt,
      today_completion_tokens: today.completion,
      today_cached_tokens: today.cached,
      today_requests: today.requests,
      today_cost_usd: cost.costUsd,
      cache_hit_rate: hitRate,
      all_time_tokens: allTime.total,
      all_time_requests: allTime.requests
    };
    writeJson(res, 200, payload);
    return true;
  }

  if (urlPath === '/api/member/status-summary' && req.method === 'GET') {
    const summary = getGateStatusSummary();
    // 成员模式数据最小化脱敏：剥离内部具体账号 auth_index 列表，仅向成员暴露集群级与全局真实心跳。
    // provider_groups 同样是聚合口径（组名 + 组级健康 + 合并心跳），不含任何单账号身份。
    writeJson(res, 200, {
      generated_at: summary.generated_at,
      window_days: summary.window_days,
      heartbeat_count: summary.heartbeat_count,
      overall: summary.overall,
      providers: summary.providers,
      today_requests: getTodayRequestsCount(keyId),
      today_errors: getTodayErrorsCount(keyId),
      provider_groups: (summary.provider_groups || []).map(g => ({
        group_id: g.group_id,
        name: g.name,
        kind: g.kind,
        provider: g.provider,
        provider_type: g.provider_type,
        enabled: g.enabled,
        status: g.status,
        accounts: g.accounts,
        total_keys: g.total_keys,
        enabled_keys: g.enabled_keys,
        cooling_keys: g.cooling_keys,
        models: g.models,
        health_dot: g.health_dot,
        bars: g.bars,
        availability_7d: g.availability_7d,
        requests_7d: g.requests_7d,
        last_request_ts: g.last_request_ts
      }))
    });
    return true;
  }

  if (urlPath === '/api/member/requests' && req.method === 'GET') {
    const url = new URL(req.url, 'http://localhost');
    if (url.searchParams.has('page')) {
      writeJson(res, 200, getPagedRequests({
        page: url.searchParams.get('page'),
        pageSize: url.searchParams.get('page_size'),
        keyId,
        provider: url.searchParams.get('provider') || null,
        filter: url.searchParams.get('filter'),
        search: url.searchParams.get('search'),
        timeRange: url.searchParams.get('time_range'),
        since: url.searchParams.get('since'),
        until: url.searchParams.get('until'),
        beforeId: url.searchParams.get('before_id')
      }));
      return true;
    }
    writeJson(res, 200, getRecentRequestsForKey(keyId, url.searchParams.get('limit')));
    return true;
  }

  writeJson(res, 404, { error: 'Not Found' });
  return true;
}

import {
  stmtEventsForStatus,
  stmtUpstreamDailyAggSince,
  stmtBaselinesAll,
  stmtAuthEventsAgg,
  stmtAuthEventsAggSince,
  stmtLatestModelByAuth
} from '../db/sqlite.mjs';
import { cachedUpstreamQuotas, normalizeAuthPriority } from '../upstream/sync.mjs';
import { RUNTIME_WINDOW_MINUTES } from '../upstream/runtime-stats.mjs';
import { DEFAULT_AUTH_PRIORITY } from '../config.mjs';
import { inferProvider, getProviderGroupLabel, isCpaProviderKey, UNKNOWN_PROVIDER_KEY } from '../core/provider-registry.mjs';
import { getTodayRequestsCount, getTodayErrorsCount } from './audit-logs.mjs';

const STATUS_WINDOW_DAYS = 7;
const STATUS_HEARTBEATS = 60; // 最近 60 分钟，每分钟 1 个槽位

// 组级健康判定的小样本门槛与阈值。
// HEALTH_MIN_SAMPLES：7 天请求数低于此值的组，其可用率不具备统计意义——
// 3 次请求里失败 1 次就是 66%，那是一次抖动，不是服务退化。低于门槛时
// 可用率不参与健康判定，只在大盘展示。
// HEALTH_WARN_AVAILABILITY：够样本后仍低于此可用率才提示「整体可用率偏低」。
// 注意这里只提示 warn，不再像旧实现那样判 err：近期窗口没有失败请求时，
// 没有任何理由把一个组标成重大故障。
const HEALTH_MIN_SAMPLES = 30;
const HEALTH_WARN_AVAILABILITY = 99;

export function buildStatusScope(rows, nowMs = Date.now()) {
  const currentMinuteTs = Math.floor(nowMs / 60000) * 60; // 当前分钟起始秒数
  const slotCount = STATUS_HEARTBEATS;
  const startMinuteTs = currentMinuteTs - (slotCount - 1) * 60;

  // 1. 将最近 60 分钟内的事件按所属分钟槽归类（单次流式累加，零临时小数组分配）
  const slots = new Array(slotCount);
  for (let i = 0; i < slotCount; i++) {
    const slotMinTs = startMinuteTs + i * 60;
    slots[i] = {
      ts: slotMinTs * 1000,
      requests: 0,
      successCount: 0,
      hasErr: false,
      hasWarn: false,
      latencySum: 0,
      latencyCount: 0,
      ttftSum: 0,
      ttftCount: 0,
      models: new Set()
    };
  }

  let totalLatSum = 0;
  let totalLatCount = 0;
  let totalTtftSum = 0;
  let totalTtftCount = 0;
  let okCount = 0;
  let reqs24h = 0;
  const dayAgoTs = nowMs - 86400000;

  for (const r of rows) {
    const rTsMs = (r.ts || 0) * 1000;
    if (rTsMs >= dayAgoTs) reqs24h++;
    if (r.status >= 200 && r.status < 400) okCount++;
    if ((r.latency_ms || 0) > 0) {
      totalLatSum += r.latency_ms;
      totalLatCount++;
    }
    if ((r.ttft_ms || 0) > 0) {
      totalTtftSum += r.ttft_ms;
      totalTtftCount++;
    }

    if (r.ts < startMinuteTs || r.ts >= currentMinuteTs + 60) continue;
    const slotIdx = Math.floor((r.ts - startMinuteTs) / 60);
    if (slotIdx >= 0 && slotIdx < slotCount) {
      const s = slots[slotIdx];
      s.requests++;
      if (r.status >= 200 && r.status < 400) {
        s.successCount++;
      } else if (r.status >= 500 || r.status === 0) {
        s.hasErr = true;
      } else if (r.status >= 400) {
        s.hasWarn = true;
      }
      if ((r.latency_ms || 0) > 0) {
        s.latencySum += r.latency_ms;
        s.latencyCount++;
      }
      if ((r.ttft_ms || 0) > 0) {
        s.ttftSum += r.ttft_ms;
        s.ttftCount++;
      }
      if (r.model) s.models.add(r.model);
    }
  }

  // 2. 将每个分钟槽映射为标准心跳 bar 对象（从过去到当前正序排列）
  const bars = slots.map(s => {
    let status = 200;
    if (s.requests > 0) {
      if (s.hasErr) status = 500;
      else if (s.hasWarn) status = 429;
      else status = 200;
    } else {
      status = 200;
    }

    const avgLat = s.latencyCount > 0 ? Math.round(s.latencySum / s.latencyCount) : 0;
    const avgTtft = s.ttftCount > 0 ? Math.round(s.ttftSum / s.ttftCount) : 0;

    return {
      ts: s.ts,
      status,
      latency_ms: avgLat,
      ttft_ms: avgTtft,
      model: Array.from(s.models).slice(0, 2).join(', '),
      requests: s.requests,
      success_count: s.successCount,
      stream: false
    };
  });

  return {
    bars,
    latency_avg_ms: totalLatCount > 0 ? Math.round(totalLatSum / totalLatCount) : 0,
    ttft_avg_ms: totalTtftCount > 0 ? Math.round(totalTtftSum / totalTtftCount) : 0,
    availability_7d: rows.length > 0 ? Math.round((okCount / rows.length) * 10000) / 100 : null,
    requests_7d: rows.length,
    requests_24h: reqs24h,
    last_request_ts: rows.length > 0 ? rows[0].ts * 1000 : null
  };
}

/**
 * 组级健康点判定。
 *
 * 铁律：健康点只回答「这个组现在还正常吗」，因此只看最近的心跳窗口，
 * 绝不拿 7 天可用率来判。早期实现把 availability_7d < 95 也当作判红依据，
 * 而心跳 bars 只覆盖最近 60 分钟——两个时间尺度错配，导致 7 天前的一次
 * 失败（哪怕整组只有 3 次请求）能把一个当前完全健康的组永久钉在
 * major_outage，生产上的 OpenCode Zen 组就这样误报了整整一天。
 *
 * availability 参数仅用于在 title 里补充一句「近期整体可用率偏低」，
 * 且必须过小样本门槛，否则不参与判定。
 */
function deriveGroupHealth(bars, availability, recentRequests = null) {
  if (!bars || bars.length === 0) return { dot: '', title: '暂无数据' };
  const windowRequests = bars.reduce((a, b) => a + (b.requests || 0), 0);
  // 心跳窗口内一次请求都没有时，没有任何证据支持「健康」或「故障」的结论。
  if (windowRequests === 0) {
    const hasHistory = availability != null && recentRequests > 0;
    return hasHistory
      ? { dot: 'idle', title: '近期无流量' }
      : { dot: '', title: '暂无数据' };
  }
  // 核心优化：组级健康判定聚焦于最新前 2~3 根心跳（即最新的 2~3 个时间槽），
  // 解决历史偶发失败（如数十分钟前的瞬时网络抖动）长期将健康点拉低标红的问题。
  const activeBars = bars.filter(b => b.requests > 0);
  const evalBars = activeBars.length > 0 ? activeBars.slice(-3) : bars.slice(-3);
  const recentBad = evalBars.some(b => b.status >= 500 || b.status === 0);
  const recentWarn = evalBars.some(b => b.status >= 400 && b.status < 500);
  if (recentBad) return { dot: 'err', title: '组内当前存在失败请求' };
  if (recentWarn) return { dot: 'warn', title: '组内当前存在 4xx 异常' };
  // 7 天可用率只作补充提示：样本太少时一次失败就能把比率打到 95% 以下，
  // 那叫统计噪声，不叫故障。
  if (availability != null && recentRequests >= HEALTH_MIN_SAMPLES && availability < HEALTH_WARN_AVAILABILITY) {
    return { dot: 'warn', title: '近期整体可用率偏低' };
  }
  return { dot: 'ok', title: '运行正常' };
}

/**
 * 提供商组的中文展示名。唯一真相源是 lib/core/provider-registry.mjs，
 * 此处只做「未登记时怎么兜底」，不再自建标签表——旧实现在这里维护了一份
 * PROVIDER_GROUP_LABELS，与 audit-logs 的命名各说各话。
 *
 * 兜底顺序：上游原始 provider 名（如「某某中转」）> 「未知上游」。
 * 绝不用模型名去猜一个组名：猜错会把请求算到别家账上。
 */
function providerGroupLabel(providerKey, fallbackName) {
  return getProviderGroupLabel(providerKey, fallbackName);
}

/**
 * 按「提供商组」收敛服务状态：把 CPA 直连上游账号按提供商归组，
 * 每组给出一颗组级健康点与合并心跳，避免上游账号一多就把面板刷成刷屏长列表。
 */
export function buildProviderGroups(authScopes, byAuth) {
  const groups = new Map();

  const ensureGroup = (key, meta) => {
    if (!groups.has(key)) groups.set(key, { ...meta, items: [] });
    return groups.get(key);
  };

  for (const s of authScopes) {
    // CPA 的 auth-files 里混有非提供商 type（实测出现过 label 为 meta 的凭证文件）。
    // 这里必须与注册表共用同一把尺子，否则看板上会凭空多出一个叫「meta」的假提供商组。
    // 不合法的 provider 值一律归入「其他上游」，与未登记账号的兜底口径一致。
    const rawProv = (s.provider || '').toLowerCase();
    const provKey = isCpaProviderKey(rawProv) ? rawProv : UNKNOWN_PROVIDER_KEY;
    const g = ensureGroup(provKey, {
      group_id: provKey,
      provider: provKey,
      name: providerGroupLabel(provKey, s.provider),
      accounts: 0,
      disabled_accounts: 0
    });
    g.items.push(s);
    g.accounts++;
    if (s.status === 'disabled') g.disabled_accounts++;
  }

  const result = [];
  for (const [provKey, g] of groups.entries()) {
    // 组级心跳必须按分钟槽合并，而不是把各账号的 bars 首尾相接：
    // 直连拼接会让 2 个号产出 120 根柱子，前 60 分钟的历史被挤出可视区，
    // 且每根柱子只代表 1 次请求，与「组」的口径不符。
    const slotMap = new Map();
    let totalReq = 0;
    let okCount = 0;
    let lastTs = 0;
    for (const s of g.items) {
      for (const b of (s.bars || [])) {
        const slotTs = Math.floor(b.ts / 60000) * 60000;
        let slot = slotMap.get(slotTs);
        if (!slot) {
          slot = { ts: slotTs, requests: 0, successCount: 0, hasErr: false, hasWarn: false, latencySum: 0, latencyCount: 0, ttftSum: 0, ttftCount: 0 };
          slotMap.set(slotTs, slot);
        }
        // 空槽 (requests=0) 不能按 1 计入：每个账号都会吐满 60 个槽，
        // `|| 1` 会把无流量的分钟全部虚增成 1 次请求，柱状图与总数一起失真。
        const barRequests = b.requests || 0;
        slot.requests += barRequests;
        const barSuccess = b.success_count != null
          ? b.success_count
          : (b.status >= 200 && b.status < 400 ? barRequests : 0);
        slot.successCount += barSuccess;
        if (barRequests > 0) {
          if (b.status >= 500 || b.status === 0) slot.hasErr = true;
          else if (b.status >= 400) slot.hasWarn = true;
        }
        if ((b.latency_ms || 0) > 0) { slot.latencySum += b.latency_ms; slot.latencyCount++; }
        if ((b.ttft_ms || 0) > 0) { slot.ttftSum += b.ttft_ms; slot.ttftCount++; }
      }
      totalReq += s.requests_7d || 0;
      if (s.availability_7d != null) okCount += (s.availability_7d / 100) * (s.requests_7d || 0);
      if ((s.last_request_ts || 0) > lastTs) lastTs = s.last_request_ts || 0;
    }

    const mergedBars = Array.from(slotMap.values()).sort((a, b) => a.ts - b.ts).map(s => ({
      ts: s.ts,
      status: s.hasErr ? 500 : (s.hasWarn ? 429 : 200),
      latency_ms: s.latencyCount > 0 ? Math.round(s.latencySum / s.latencyCount) : 0,
      ttft_ms: s.ttftCount > 0 ? Math.round(s.ttftSum / s.ttftCount) : 0,
      requests: s.requests,
      success_count: s.successCount
    }));

    // 组级延迟/TTFT 必须按「带延迟的分钟槽」加权汇总，不能对各账号的均值再取平均：
    // 两个账号一个 3 次调用一个 300 次，直接平均均值会让流量小的账号权重被放大 100 倍。
    const slotLatSum = Array.from(slotMap.values()).reduce((a, s) => a + s.latencySum, 0);
    const slotLatCount = Array.from(slotMap.values()).reduce((a, s) => a + s.latencyCount, 0);
    const slotTtftSum = Array.from(slotMap.values()).reduce((a, s) => a + s.ttftSum, 0);
    const slotTtftCount = Array.from(slotMap.values()).reduce((a, s) => a + s.ttftCount, 0);
    const latencyAvg = slotLatCount > 0 ? Math.round(slotLatSum / slotLatCount) : 0;
    const ttftAvg = slotTtftCount > 0 ? Math.round(slotTtftSum / slotTtftCount) : 0;

    const availability = totalReq > 0 ? Math.round((okCount / totalReq) * 10000) / 100 : null;

    // 组级健康点：只看最近心跳窗口，7 天可用率仅作小样本门槛内的补充提示。
    // 旧实现在这里又内联了一份判定逻辑（且比 deriveGroupHealth 更宽松地
    // 拿 7 天可用率判红判黄），两处口径不一致；现在统一走 deriveGroupHealth。
    const health = deriveGroupHealth(mergedBars, availability, totalReq);
    const dot = health.dot;
    const title = health.title;

    // dot 为空表示「暂无数据」（7 天窗口同样零请求），此时既不能算 operational
    // 也不能算故障，否则前端会把「没说话」渲染成一颗绿点。
    // dot === 'idle' 是「近期无流量但有历史」，单独归为 idle，既不谎报健康
    // 也不冒充故障。
    const status = g.disabled_accounts >= g.accounts && g.accounts > 0
      ? 'disabled'
      : (dot === 'err' ? 'major_outage'
        : (dot === 'warn' ? 'degraded'
          : (dot === 'ok' ? 'operational'
            : (dot === 'idle' ? 'idle' : 'no_data'))));

    result.push({
      group_id: provKey,
      name: g.name,
      kind: 'cpa',
      provider: provKey,
      provider_type: provKey,
      accounts: g.accounts,
      disabled_accounts: g.disabled_accounts,
      total_keys: 0,
      enabled_keys: 0,
      cooling_keys: 0,
      models: [],
      enabled: true,
      status,
      health_dot: dot,
      health_title: title,
      bars: mergedBars,
      latency_avg_ms: latencyAvg,
      ttft_avg_ms: ttftAvg,
      availability_7d: availability,
      requests_7d: totalReq,
      requests_24h: totalReq,
      last_request_ts: lastTs || null
    });
  }

  result.sort((a, b) => (b.requests_7d || 0) - (a.requests_7d || 0));
  return result;
}

export function getGateStatusSummary() {
  const sinceTs = Math.floor((Date.now() - STATUS_WINDOW_DAYS * 86400000) / 1000);
  const rows = stmtEventsForStatus.all(sinceTs);

  const byAuth = new Map();
  const overallRows = [];

  for (const r of rows) {
    overallRows.push(r);
    const idx = (r.auth_index || '').trim();
    if (idx) {
      if (!byAuth.has(idx)) byAuth.set(idx, []);
      byAuth.get(idx).push(r);
    }
  }

  const overall = buildStatusScope(overallRows);

  const authScopes = [];
  const upstreamAccounts = Array.isArray(cachedUpstreamQuotas.accounts) ? cachedUpstreamQuotas.accounts : [];
  const accountMetaMap = new Map();
  for (const acc of upstreamAccounts) {
    if (acc.auth_index) {
      const rawName = acc.display_name || acc.nickname || acc.email || acc.filename || acc.id || acc.auth_index;
      const resolvedName = String(rawName).replace(/\.json$/i, '');
      accountMetaMap.set(acc.auth_index, {
        name: resolvedName,
        display_name: resolvedName,
        nickname: acc.nickname || '',
        provider: acc.provider || 'unknown',
        email: acc.email || '',
        status: acc.status || (acc.disabled ? 'disabled' : 'active'),
        priority: normalizeAuthPriority(acc.priority)
      });
    }
  }

  const seenAuthIndexes = new Set([...accountMetaMap.keys(), ...byAuth.keys()]);

  for (const authIndex of seenAuthIndexes) {
    const authRows = byAuth.get(authIndex) || [];
    const scope = buildStatusScope(authRows);
    let meta = accountMetaMap.get(authIndex);
    if (!meta) {
      // CPA 尚未同步完成时也要能归组，否则所有账号会一起塌进 "unknown" 组，
      // 分组就失去意义。归组一律走提供商注册表，不再本地写 startsWith 链，
      // 更不再把某个真实账号的 auth_index 特判进源码。
      // auth_index 前缀优先（CPA 直连账号的命名惯例），
      // 命中不了再退回模型名——顺序与注册表的 auth→model 优先级一致。
      const idxLower = String(authIndex).toLowerCase();
      let inferredProvider = 'unknown';
      const byAuthPrefix = inferProvider({ authIndex: idxLower });
      if (byAuthPrefix.key) {
        inferredProvider = byAuthPrefix.key;
      } else {
        const rows = authRows.filter(r => r && r.model);
        for (const r of rows) {
          const byModel = inferProvider({ model: r.model });
          if (byModel.key) { inferredProvider = byModel.key; break; }
        }
      }
      meta = {
        name: inferredProvider === 'unknown' ? `凭证 ${authIndex}` : providerGroupLabel(inferredProvider),
        provider: inferredProvider,
        email: '',
        status: 'active',
        priority: DEFAULT_AUTH_PRIORITY
      };
    }

    authScopes.push({
      auth_index: authIndex,
      name: meta.name,
      email: meta.email,
      provider: meta.provider,
      status: meta.status,
      priority: meta.priority,
      ...scope
    });
  }

  authScopes.sort((a, b) => {
    const pDiff = (b.priority ?? DEFAULT_AUTH_PRIORITY) - (a.priority ?? DEFAULT_AUTH_PRIORITY);
    if (pDiff !== 0) return pDiff;
    return (b.requests_7d - a.requests_7d) || (b.last_request_ts || 0) - (a.last_request_ts || 0);
  });

  const accountsObj = {};
  for (const item of authScopes) {
    if (item.auth_index) accountsObj[item.auth_index] = item;
  }

  const providerGroups = buildProviderGroups(authScopes, byAuth);

  const overallHealth = deriveGroupHealth(overall.bars, overall.availability_7d, overall.requests_7d);

  return {
    window_days: STATUS_WINDOW_DAYS,
    heartbeat_count: STATUS_HEARTBEATS,
    overall: {
      status: overallHealth.dot === 'err' ? 'major_outage' : (overallHealth.dot === 'warn' ? 'degraded' : (overallHealth.dot === 'idle' ? 'idle' : 'operational')),
      health_dot: overallHealth.dot,
      health_title: overallHealth.title,
      ...overall
    },
    accounts: accountsObj,
    upstreams: authScopes,
    provider_groups: providerGroups,
    today_requests: getTodayRequestsCount(),
    today_errors: getTodayErrorsCount(),
    updated_at: Date.now()
  };
}

export function getUpstreamAuthStats(timeRange = 'all', runtime = null) {
  const isAll = !timeRange || timeRange === 'all';
  const baselines = isAll ? stmtBaselinesAll.all() : [];
  const baselineMap = new Map();
  for (const b of baselines) {
    baselineMap.set(b.auth_index, b);
  }

  let dailyStatsMap = new Map();
  if (timeRange === '7d' || timeRange === '30d') {
    const days = timeRange === '7d' ? 7 : 30;
    const sinceDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(Date.now() - days * 86400000));
    const dRows = stmtUpstreamDailyAggSince.all(sinceDate);
    for (const r of dRows) dailyStatsMap.set(r.auth_index, r);
  } else if (!isAll) {
    let seconds = 86400;
    if (timeRange === '5h') seconds = 5 * 3600;
    else if (timeRange === '24h') seconds = 24 * 3600;
    else if (typeof timeRange === 'number') seconds = timeRange;
    const sinceTs = Math.floor((Date.now() - seconds * 1000) / 1000);
    const evRows = stmtAuthEventsAggSince.all(sinceTs);
    for (const r of evRows) dailyStatsMap.set(r.auth_index, r);
  }

  // 无论当前全局视图选什么范围，预先计算多时段 Token 矩阵供对比（当前 5h 周期、近 24h、近 7d）
  const nowTs = Math.floor(Date.now() / 1000);
  const ts5h = nowTs - 5 * 3600;
  const ts24h = nowTs - 24 * 3600;
  const since7d = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(Date.now() - 7 * 86400000));

  const map5h = new Map();
  const map24h = new Map();
  const map7d = new Map();
  const todayStatsMap = new Map();
  const todayDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
  try {
    const rows5h = stmtAuthEventsAggSince.all(ts5h);
    for (const r of rows5h) map5h.set(r.auth_index, r);
  } catch {}
  try {
    const rows24h = stmtAuthEventsAggSince.all(ts24h);
    for (const r of rows24h) map24h.set(r.auth_index, r);
  } catch {}
  try {
    const rows7d = stmtUpstreamDailyAggSince.all(since7d);
    for (const r of rows7d) map7d.set(r.auth_index, r);
  } catch {}
  try {
    const todayRows = stmtUpstreamDailyAggSince.all(todayDate);
    for (const r of todayRows) todayStatsMap.set(r.auth_index, r);
  } catch {}

  const liveEvents = isAll ? stmtAuthEventsAgg.all() : [];
  const liveMap = new Map();
  for (const l of liveEvents) {
    liveMap.set(l.auth_index, l);
  }

  // 每个账号最近一次请求的模型，供提供商身份推断兜底。
  // 必须在循环外一次性取完：循环内逐账号查询会让 34 个账号打 34 次全表扫描。
  let latestModelByAuth = new Map();
  try {
    for (const r of stmtLatestModelByAuth.all()) {
      latestModelByAuth.set(r.auth_index, r.model);
    }
  } catch {}

  // 「全部历史」只存在于 Gate 本地基线里——CPA 运行时只保留约 200 分钟窗口。
  // 该档位恒走本地推算并标注来源，不把推算值伪装成运行时事实。
  const runtimeUsable = !isAll && runtime && runtime.degraded === false && Array.isArray(runtime.credentials);
  const runtimeByIndex = new Map();
  if (runtimeUsable) {
    for (const c of runtime.credentials) {
      if (c.auth_index) runtimeByIndex.set(c.auth_index, c);
    }
  }

  const accounts = Array.isArray(cachedUpstreamQuotas.accounts) ? cachedUpstreamQuotas.accounts : [];
  const allIndexes = new Set([
    ...accounts.map(a => a.auth_index).filter(Boolean),
    ...baselineMap.keys(),
    ...dailyStatsMap.keys(),
    ...liveMap.keys(),
    ...runtimeByIndex.keys()
  ]);

  const items = [];
  for (const authIndex of allIndexes) {
    const acc = accounts.find(a =>
      a.auth_index === authIndex ||
      a.cpa_auth_index === authIndex ||
      a.legacy_auth_index === authIndex ||
      a.filename === authIndex ||
      a.id === authIndex ||
      (a.provider?.startsWith('workbuddy') && (a.id === authIndex || a.filename === authIndex)) ||
      (a.provider === 'openrouter' && (a.id === authIndex || a.filename === authIndex || `openrouter-${a.id}` === authIndex)) ||
      (a.provider === 'opencode' && (a.id === authIndex || a.filename === authIndex || a.email === authIndex || a.auth_index === authIndex))
    );
    const base = baselineMap.get(authIndex);
    const dStat = dailyStatsMap.get(authIndex);
    const live = liveMap.get(authIndex);
    const rt = runtimeByIndex.get(authIndex);

    // 上游 provider 缺失时按 auth_index / 模型名走注册表推断，
    // 不再特判具体账号哈希。推断不出就留在 'other'，由管理台补登记。
    // CPA 混进来的非提供商 type（meta 等）同样要走这条兜底，
    // 与 buildProviderGroups 的归组口径保持一致。
    //
    // 模型名兜底必须覆盖「全部历史」档位：该档位下 dailyStatsMap 是空的、
    // liveMap 只有聚合计数不带 model，旧代码于是只试 auth_index 就放弃，
    // 导致 13 个没有 baseline 的账号全部掉进 'other'——而它们的模型流水
    // （step-5-preview、gemini-3.8-flash-high 等）一直躺在 request_events 里。
    let provider = acc?.provider || base?.provider || rt?.provider;
    if (!provider || !isCpaProviderKey(provider)) {
      const byAuth = inferProvider({ authIndex });
      const modelForInfer = dStat?.model || live?.model || latestModelByAuth.get(authIndex);
      const byModel = (byAuth.key || !modelForInfer) ? null : inferProvider({ model: modelForInfer });
      provider = (byAuth.key || byModel?.key) ? (byAuth.key || byModel.key) : 'other';
    } else {
      provider = String(provider).toLowerCase();
    }
    // 账号活跃与删除判定：
    // 在上游凭证目录已加载时（hasUpstreamCatalog），一个凭证如果在 CPA 中已经删除（!acc），
    // 则必须被严格标记为已删除（is_deleted: true），移入下方历史留痕折叠抽屉，不能因为其在
    // 本地 upstream_auth_baselines 遗留有基线数据而误将其作为活跃凭证展示；
    // 历史基线名 base.name（如「阿龙中转」或旧「codex」）作为 deleted 抽屉内可读显示名展示。
    const hasUpstreamCatalog = Boolean(cachedUpstreamQuotas.last_updated && accounts.length > 0);
    const isDeleted = hasUpstreamCatalog ? Boolean(!acc) : Boolean(!acc && !base && !rt?.email);
    const rawDisplayName = acc?.display_name || acc?.nickname || acc?.email || base?.name || rt?.display_name || rt?.nickname || rt?.email || acc?.filename;
    const displayName = (rawDisplayName ? String(rawDisplayName).replace(/\.json$/i, '') : '')
      || `已删除账号 ${String(authIndex).slice(0, 8)}`;
    const priority = normalizeAuthPriority(acc?.priority ?? rt?.priority);
    const status = acc?.status || (acc?.disabled ? 'disabled' : 'active');
    const disabled = Boolean(acc?.disabled ?? rt?.disabled);

    // 请求量口径：可用时取 CPA 运行时事实（权威），否则退回本地基线推算。
    let totalRequests;
    let successCount;
    let failureCount;
    let runtimeSource;
    let runtimeWindowMinutes = null;

    if (rt) {
      totalRequests = (rt.success || 0) + (rt.failed || 0);
      successCount = rt.success || 0;
      failureCount = rt.failed || 0;
      runtimeSource = 'cpa_runtime';
      runtimeWindowMinutes = rt.window_minutes || RUNTIME_WINDOW_MINUTES;
    } else {
      runtimeSource = 'local_estimate';
      if (isAll) {
        totalRequests = (base?.base_requests || 0) + (live?.requests || 0);
        successCount = (base?.base_success_count || 0) + (live?.success_count || 0);
        failureCount = (base?.base_failure_count || 0) + (live?.failure_count || 0);
      } else if (dailyStatsMap.size > 0) {
        totalRequests = dStat?.requests || live?.requests || 0;
        successCount = dStat?.success_count || live?.success_count || 0;
        failureCount = dStat?.failure_count || live?.failure_count || 0;
      } else {
        totalRequests = live?.requests || 0;
        successCount = live?.success_count || 0;
        failureCount = live?.failure_count || 0;
      }
    }

    // Token 与成本：CPA 运行时接口不返回任何 Token 数据，恒取 Gate 本地计量。
    let promptTokens = 0;
    let completionTokens = 0;
    let cachedTokens = 0;
    let totalTokens = 0;

    if (isAll) {
      promptTokens = (base?.base_prompt_tokens || 0) + (live?.prompt_tokens || 0);
      completionTokens = (base?.base_completion_tokens || 0) + (live?.completion_tokens || 0);
      cachedTokens = (base?.base_cached_tokens || 0) + (live?.cached_tokens || 0);
      totalTokens = (base?.base_total_tokens || 0) + (live?.total_tokens || 0);
    } else if (dailyStatsMap.size > 0) {
      promptTokens = dStat?.prompt_tokens || live?.prompt_tokens || 0;
      completionTokens = dStat?.completion_tokens || live?.completion_tokens || 0;
      cachedTokens = dStat?.cached_tokens || live?.cached_tokens || 0;
      totalTokens = dStat?.total_tokens || live?.total_tokens || 0;
    } else {
      promptTokens = live?.prompt_tokens || 0;
      completionTokens = live?.completion_tokens || 0;
      cachedTokens = live?.cached_tokens || 0;
      totalTokens = live?.total_tokens || 0;
    }

    const successRate = totalRequests > 0
      ? Math.round((successCount / totalRequests) * 10000) / 100
      : 100.0;

    const promptBase = Math.max(promptTokens, cachedTokens);
    const cacheRate = promptBase > 0
      ? Math.round((cachedTokens / promptBase) * 10000) / 100
      : 0.0;

    // 提取当前账号在 Antigravity / Codex 中的 5 小时和周配额窗口
    let quota5h = null;
    let quotaWeekly = null;
    if (Array.isArray(acc?.groups)) {
      for (const grp of acc.groups) {
        if (Array.isArray(grp.buckets)) {
          for (const b of grp.buckets) {
            const is5h = b.window === '5h' || (b.bucket_id && b.bucket_id.includes('5h'));
            const isWeekly = b.window === 'weekly' || (b.bucket_id && b.bucket_id.includes('weekly'));
            if (is5h && !quota5h && Number.isFinite(b.remaining_percent)) {
              quota5h = {
                name: b.name || '5 小时周期',
                remaining_percent: b.remaining_percent,
                used_percent: b.used_percent,
                reset_time: b.reset_time,
                reset_countdown: b.reset_countdown
              };
            }
            if (isWeekly && !quotaWeekly && Number.isFinite(b.remaining_percent)) {
              quotaWeekly = {
                name: b.name || '周限额',
                remaining_percent: b.remaining_percent,
                used_percent: b.used_percent,
                reset_time: b.reset_time,
                reset_countdown: b.reset_countdown
              };
            }
          }
        }
      }
    }

    const stat5h = map5h.get(authIndex);
    const stat24h = map24h.get(authIndex);
    const stat7d = map7d.get(authIndex);
    const totalAllTokens = (base?.base_total_tokens || 0) + (live?.total_tokens || liveMap.get(authIndex)?.total_tokens || 0);

    // 提取 WorkBuddy / CodeBuddy 资源包积分额度（若顶层缺失则从 groups.buckets 累加）
    let totalCredits = acc?.total_credits != null ? Number(acc.total_credits) : null;
    let remainingCredits = acc?.remaining_credits != null ? Number(acc.remaining_credits) : null;
    let usedCredits = acc?.used_credits != null ? Number(acc.used_credits) : null;
    if (totalCredits == null && Array.isArray(acc?.groups)) {
      for (const grp of acc.groups) {
        if (Array.isArray(grp.buckets)) {
          for (const b of grp.buckets) {
            if (b.total_capacity != null || b.remain_capacity != null) {
              totalCredits = (totalCredits || 0) + (Number(b.total_capacity) || 0);
              remainingCredits = (remainingCredits || 0) + (Number(b.remain_capacity) || 0);
              usedCredits = (usedCredits || 0) + (Number(b.used_capacity) || 0);
            }
          }
        }
      }
    }

    // 提取今日 Token 消耗与今日请求次数（优先凭据对象，兜底 Gate 本地实时今日统计）
    const todayStat = todayStatsMap.get(authIndex);
    const todayTokens = acc?.today_tokens != null ? Number(acc.today_tokens) : (todayStat?.total_tokens || 0);
    const todayRequests = acc?.today_requests != null ? Number(acc.today_requests) : (todayStat?.requests != null ? Number(todayStat.requests) : null);
    const dailyLimit = acc?.daily_limit != null ? Number(acc.daily_limit) : (provider === 'openrouter' ? 800 : null);
    const remainingRequests = acc?.remaining_requests != null
      ? Number(acc.remaining_requests)
      : (todayRequests != null && dailyLimit != null ? Math.max(0, dailyLimit - todayRequests) : null);
    let resetTime = acc?.reset_time || null;
    let resetCountdown = acc?.reset_countdown || null;
    let expiresAt = acc?.expires_at || null;
    let runsOutPoints = acc?.runs_out_points != null ? Number(acc.runs_out_points) : null;

    if (!expiresAt && Array.isArray(acc?.groups)) {
      for (const grp of acc.groups) {
        for (const b of (grp.buckets || [])) {
          if (b.expires_at) {
            expiresAt = b.expires_at;
            break;
          }
          if (b.reset_time && !resetTime) {
            resetTime = b.reset_time;
          }
        }
        if (expiresAt) break;
      }
    }

    const periodStats = {
      tokens_5h: stat5h?.total_tokens || 0,
      tokens_24h: stat24h?.total_tokens || 0,
      tokens_7d: stat7d?.total_tokens || 0,
      tokens_all: totalAllTokens
    };

    items.push({
      auth_index: authIndex,
      name: displayName,
      display_name: displayName,
      nickname: acc?.nickname || rt?.nickname || '',
      is_deleted: isDeleted,
      provider,
      priority,
      status,
      disabled,
      // 最近一次请求的模型。这是账号身份最直接的旁证：provider 推断本身就靠它
      // 兜底（all 档位下 dailyStatsMap 空、liveMap 不带 model），而运维看到
      // 「已删除账号 5907fede」时，模型名是判断这账号当年干什么的唯一线索。
      last_model: latestModelByAuth.get(authIndex) || dStat?.model || live?.model || '',
      total_requests: totalRequests,
      success_count: successCount,
      failure_count: failureCount,
      success_rate: successRate,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      cached_tokens: cachedTokens,
      total_tokens: totalTokens,
      cache_rate: cacheRate,
      runtime_source: runtimeSource,
      runtime_window_minutes: runtimeWindowMinutes,
      quota_5h: quota5h,
      quota_weekly: quotaWeekly,
      total_credits: totalCredits,
      remaining_credits: remainingCredits,
      used_credits: usedCredits,
      runs_out_points: runsOutPoints,
      expires_at: expiresAt,
      expiration_packages: Array.isArray(acc?.expiration_packages) && acc.expiration_packages.length > 0
        ? acc.expiration_packages
        : (Array.isArray(acc?.groups)
            ? acc.groups.flatMap(g => Array.isArray(g?.buckets) ? g.buckets : []).filter(b => b.expires_at || b.reset_time).map(b => ({
                package_name: b.name,
                package_code: b.package_code || b.bucket_id,
                remain_points: b.remain_capacity,
                total_points: b.total_capacity,
                expires_at: b.expires_at,
                reset_time: b.reset_time
              }))
            : []),
      today_tokens: todayTokens,
      today_requests: todayRequests,
      daily_limit: dailyLimit,
      remaining_requests: remainingRequests,
      reset_time: resetTime,
      reset_countdown: resetCountdown,
      period_stats: periodStats
    });
  }

  items.sort((a, b) => (b.total_requests - a.total_requests) || (b.total_tokens - a.total_tokens));

  let sumRequests = 0;
  let sumSuccess = 0;
  let sumFailure = 0;
  let sumPrompt = 0;
  let sumCompletion = 0;
  let sumCached = 0;
  let sumTokens = 0;

  for (const it of items) {
    sumRequests += it.total_requests;
    sumSuccess += it.success_count;
    sumFailure += it.failure_count;
    sumPrompt += it.prompt_tokens;
    sumCompletion += it.completion_tokens;
    sumCached += it.cached_tokens;
    sumTokens += it.total_tokens;
  }

  const overallPromptBase = Math.max(sumPrompt, sumCached);
  const overallCacheRate = overallPromptBase > 0
    ? Math.round((sumCached / overallPromptBase) * 10000) / 100
    : 0.0;
  const overallSuccessRate = sumRequests > 0
    ? Math.round((sumSuccess / sumRequests) * 10000) / 100
    : 100.0;

  // 口径声明：请求量与成功率来自 CPA 运行时（仅当 range 非 all 且 CPA 可达），
  // Token / 成本 / 缓存命中恒来自 Gate 本地计量。两者不可混为一谈。
  const requestSource = items.some(i => i.runtime_source === 'cpa_runtime') ? 'cpa_runtime' : 'local_estimate';
  const tokenSource = 'local_metered';

  return {
    time_range: timeRange,
    items,
    summary: {
      total_accounts: items.length,
      total_requests: sumRequests,
      total_success: sumSuccess,
      total_failure: sumFailure,
      success_rate: overallSuccessRate,
      prompt_tokens: sumPrompt,
      completion_tokens: sumCompletion,
      cached_tokens: sumCached,
      total_tokens: sumTokens,
      cache_rate: overallCacheRate,
      request_source: requestSource,
      token_source: tokenSource
    },
    source: {
      requests: requestSource,
      tokens: tokenSource,
      runtime_window_minutes: isAll ? null : RUNTIME_WINDOW_MINUTES,
      note: isAll
        ? '「全部历史」为 Gate 本地基线推算；CPA 运行时仅保留约 200 分钟窗口。'
        : (requestSource === 'cpa_runtime'
          ? '请求数与成功率取自 CPA 运行时事实；Token 与成本取自 Gate 本地计量。'
          : 'CPA 运行时不可达，请求数已退回 Gate 本地基线推算。')
    },
    updated_at: Date.now()
  };
}

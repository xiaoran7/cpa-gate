import { cpaRequest } from '../core/key-registry.mjs';
import { getAuthHealth, setCooldownObservedAt } from './auth-health.mjs';
import { normalizeAuthPriority, resolveAuthAccountDisplayName } from './sync.mjs';
import {
  getLiveTrafficBuckets,
  getTrafficBucketsForWindow,
  isTrackerInitialized,
  resolveWindowPreset,
  WINDOW_PRESETS,
  DEFAULT_WINDOW_ID
} from '../analytics/live-traffic-tracker.mjs';

// CPA 的 recent_requests 固定 20 桶、每桶 10 分钟，即约 200 分钟滚动窗口。
// 面板侧的窗口文案与图表都以此为准，Gate 不夸大自己的时间跨度。
export const RUNTIME_BUCKET_COUNT = 20;
export const RUNTIME_BUCKET_MINUTES = 10;
export const RUNTIME_WINDOW_MINUTES = RUNTIME_BUCKET_COUNT * RUNTIME_BUCKET_MINUTES;

const CACHE_TTL_MS = 30000;

const cache = {
  payload: null,
  fetchedAt: 0,
  inFlight: null
};

function toCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

function normalizeBuckets(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(-RUNTIME_BUCKET_COUNT).map(b => ({
    time: typeof b?.time === 'string' ? b.time : '',
    success: toCount(b?.success),
    failed: toCount(b?.failed)
  }));
}

function emptyBuckets() {
  return Array.from({ length: RUNTIME_BUCKET_COUNT }, () => ({ time: '', success: 0, failed: 0 }));
}

/**
 * 把长度不一的多个桶序列按位置对齐后求和。
 * 不足的一侧按 0 补齐——桶是定长滚动窗口，尾部缺失即该侧当时无数据。
 */
function alignAndSum(sequences) {
  const nonEmpty = sequences.filter(s => s.length > 0);
  const result = emptyBuckets();
  if (nonEmpty.length === 0) return result;

  // 以最长序列为基准，较短序列右对齐（尾部对齐窗口末端）。
  const width = Math.max(...nonEmpty.map(s => s.length));
  const offset = RUNTIME_BUCKET_COUNT - width;
  for (const seq of nonEmpty) {
    const seqOffset = offset + (width - seq.length);
    seq.forEach((bucket, i) => {
      const target = result[seqOffset + i];
      if (!target) return;
      target.success += bucket.success;
      target.failed += bucket.failed;
      if (!target.time && bucket.time) target.time = bucket.time;
    });
  }
  return result;
}

function summarizeBuckets(buckets, windowMinutes = RUNTIME_WINDOW_MINUTES) {
  let totalSuccess = 0;
  let totalFailed = 0;
  let peakTotal = 0;
  let peakIndex = -1;

  buckets.forEach((b, i) => {
    totalSuccess += b.success;
    totalFailed += b.failed;
    const sum = b.success + b.failed;
    if (sum > peakTotal) {
      peakTotal = sum;
      peakIndex = i;
    }
  });

  const total = totalSuccess + totalFailed;
  return {
    buckets,
    total_success: totalSuccess,
    total_failed: totalFailed,
    total,
    success_rate: total > 0 ? Math.round((totalSuccess / total) * 10000) / 100 : null,
    peak_total: peakTotal,
    peak_index: peakIndex,
    window_minutes: windowMinutes
  };
}

/**
 * 从 api-key-usage 归集供应商维度。
 * 形状为 { <provider>: { "<baseUrl>|<key>": { success, failed, recent_requests[] } } }。
 * key 段含真实密钥，绝不外泄——只用它做同供应商内去重键。
 */
function buildProviderFacts(usageByKey) {
  const providers = new Map();

  if (!usageByKey || typeof usageByKey !== 'object' || Array.isArray(usageByKey)) return [];
  for (const [providerRaw, keysRaw] of Object.entries(usageByKey)) {
    if (!keysRaw || typeof keysRaw !== 'object' || Array.isArray(keysRaw)) continue;
    const provider = String(providerRaw || '').trim().toLowerCase() || 'unknown';

    let entry = providers.get(provider);
    if (!entry) {
      entry = { provider, key_count: 0, keyFingerprint: new Set(), bucketSeqs: [], total_success: 0, total_failed: 0 };
      providers.set(provider, entry);
    }

    for (const [keyId, stats] of Object.entries(keysRaw)) {
      if (!stats || typeof stats !== 'object') continue;
      entry.key_count += 1;
      // 指纹只用于「同一把 key 出现在多个供应商下」的合并判断，不落原文。
      entry.keyFingerprint.add(String(keyId).split('|').pop() || String(keyId));

      const success = toCount(stats.success);
      const failed = toCount(stats.failed);
      entry.total_success += success;
      entry.total_failed += failed;

      const buckets = normalizeBuckets(stats.recent_requests ?? stats.recentRequests);
      if (buckets.length > 0) entry.bucketSeqs.push(buckets);
    }
  }

  return [...providers.values()].map(entry => {
    const summary = summarizeBuckets(alignAndSum(entry.bucketSeqs));
    // total / success_rate 用累计计数（entry.*），与分子同源；
    // summary.* 是 200 分钟桶窗口内的计数，两者不可混算，否则成功率会超过 100%。
    const total = entry.total_success + entry.total_failed;
    return {
      provider: entry.provider,
      key_count: entry.key_count,
      unique_key_count: entry.keyFingerprint.size,
      total_success: entry.total_success,
      total_failed: entry.total_failed,
      total,
      success_rate: total > 0 ? Math.round((entry.total_success / total) * 10000) / 100 : null,
      buckets: summary.buckets,
      peak_total: summary.peak_total,
      peak_index: summary.peak_index,
      window_minutes: summary.window_minutes
    };
  }).sort((a, b) => b.total - a.total || a.provider.localeCompare(b.provider));
}

/** 从 auth-files 归集凭据维度，逐条带健康与冷却判定。 */
function buildCredentialFacts(files) {
  const list = Array.isArray(files) ? files : [];
  return list.map(file => {
    const health = getAuthHealth(file);
    const summary = summarizeBuckets(normalizeBuckets(file.recent_requests ?? file.recentRequests));
    const provider = String(file.provider || file.type || 'unknown').toLowerCase();
    const nickname = typeof file.nickname === 'string'
      ? file.nickname.trim()
      : (typeof file.nick_name === 'string' ? file.nick_name.trim() : '');
    const displayName = resolveAuthAccountDisplayName(file, provider);
    return {
      auth_index: String(file.auth_index || file.authIndex || ''),
      name: displayName || file.name || file.id || '',
      display_name: displayName,
      nickname,
      email: file.email || file.label || '',
      provider,
      priority: normalizeAuthPriority(file.priority),
      status: file.status || (file.disabled ? 'disabled' : 'active'),
      disabled: Boolean(file.disabled),
      unavailable: Boolean(file.unavailable),
      success: toCount(file.success),
      failed: toCount(file.failed),
      health,
      buckets: summary.buckets,
      window_minutes: summary.window_minutes
    };
  });
}

/**
 * 总览的总量口径：与吞吐图同源，都取 200 分钟桶窗口，而不是 CPA 的累计计数。
 *
 * 原来这里累加各凭据的 success/failed 累计值，于是同一屏上出现两个互相打脸的数字：
 * 指标区按累计判成「需要留意」，图却按窗口画成几乎全绿——累计里绝大部分失败发生在
 * 早已滚出窗口的历史时段。累计算的是进程启动以来的事，窗口算的是「现在」，
 * 运行总览要回答的是后者。
 *
 * CPA 不返回任何字段说明某个计数是否为窗口内值，桶是唯一带时间边界的数据，
 * 所以窗口内总量一律由桶推导。桶全空时退回累计口径并标 scope=cumulative，
 * 免得 CPA 少给一个字段就把界面显示成「静候流量」。
 */
export function buildTotals(credentials, options = {}) {
  let active = 0;
  let disabled = 0;
  let cooldown = 0;
  let blocked = 0;
  let cumulativeSuccess = 0;
  let cumulativeFailed = 0;
  let hasWindowTraffic = false;

  const preset = resolveWindowPreset(options.window);

  const bucketSeqs = [];
  for (const c of credentials) {
    cumulativeSuccess += c.success;
    cumulativeFailed += c.failed;
    if (c.disabled) disabled += 1;
    else active += 1;
    if (c.health.state === 'cooldown') cooldown += 1;
    if (c.health.blocked) blocked += 1;

    const buckets = c.buckets || [];
    if (buckets.length > 0) bucketSeqs.push(buckets);
    if (!hasWindowTraffic && buckets.some(b => b.success > 0 || b.failed > 0)) hasWindowTraffic = true;
  }

  // 权威实时流量源：
  // 1. 默认 3h20m 优先使用 Gate 本地双轨追踪的 200 分钟窗口数据；
  // 2. 自定义窗口（5h / 1d / 3d / 7d）直接通过 getTrafficBucketsForWindow 从持久层聚合。
  const localBuckets = getTrafficBucketsForWindow(preset.id, options.nowSec);
  const hasLocalTraffic = Boolean(localBuckets && localBuckets.some(b => b.success > 0 || b.failed > 0));

  const useLocal = Boolean(localBuckets && (hasLocalTraffic || !hasWindowTraffic || options.forceLocal || preset.id !== DEFAULT_WINDOW_ID));
  const buckets = useLocal
    ? localBuckets
    : (bucketSeqs.length > 0 ? alignAndSum(bucketSeqs) : (localBuckets || emptyBuckets()));

  const summary = summarizeBuckets(buckets, preset.windowMinutes);
  const effectiveWindowTraffic = hasLocalTraffic || hasWindowTraffic;
  const success = effectiveWindowTraffic ? summary.total_success : cumulativeSuccess;
  const failed = effectiveWindowTraffic ? summary.total_failed : cumulativeFailed;
  const total = success + failed;

  return {
    credentials_total: credentials.length,
    credentials_active: active,
    credentials_disabled: disabled,
    credentials_cooldown: cooldown,
    credentials_blocked: blocked,
    // window = 与图同源的窗口；cumulative = 桶全空时的累计兜底。
    scope: effectiveWindowTraffic ? 'window' : 'cumulative',
    buckets,
    success_count: success,
    failure_count: failed,
    total_requests: total,
    success_rate: total > 0 ? Math.round((success / total) * 10000) / 100 : null,
    window_id: preset.id,
    window_label: preset.label,
    window_minutes: preset.windowMinutes,
    bucket_minutes: preset.bucketMinutes,
    bucket_count: preset.bucketCount,
    source: hasLocalTraffic ? 'gate_local' : 'cpa_runtime'
  };
}

function degradedPayload(error, preset = resolveWindowPreset()) {
  return {
    source: 'cpa_runtime',
    degraded: true,
    error: error ? error.message : 'CPA runtime unreachable',
    fetched_at: Date.now(),
    window: preset.id,
    window_label: preset.label,
    window_minutes: preset.windowMinutes,
    bucket_minutes: preset.bucketMinutes,
    bucket_count: preset.bucketCount,
    available_windows: Object.values(WINDOW_PRESETS).map(p => ({
      id: p.id,
      label: p.label,
      short_label: p.shortLabel,
      window_minutes: p.windowMinutes,
      bucket_minutes: p.bucketMinutes,
      bucket_count: p.bucketCount
    })),
    totals: null,
    providers: [],
    credentials: []
  };
}

async function fetchRuntimeFacts(options = {}) {
  const observedAt = Date.now();
  setCooldownObservedAt(observedAt);

  const preset = resolveWindowPreset(options.window);

  // auth-files 承载凭据维度与冷却，api-key-usage 承载供应商维度。
  // 两者都是只读；任一失败不阻断另一份数据。
  const [authFilesResult, usageResult] = await Promise.allSettled([
    cpaRequest('GET', '/v0/management/auth-files'),
    cpaRequest('GET', '/v0/management/api-key-usage')
  ]);

  const authFilesOk = authFilesResult.status === 'fulfilled' && authFilesResult.value;
  const usageOk = usageResult.status === 'fulfilled' && usageResult.value;

  if (!authFilesOk && !usageOk) {
    const err = authFilesResult.status === 'rejected' ? authFilesResult.reason : usageResult.reason;
    return degradedPayload(err, preset);
  }

  const credentials = authFilesOk
    ? buildCredentialFacts(authFilesResult.value?.files)
    : [];
  const apiKeyProviders = usageOk ? buildProviderFacts(usageResult.value) : [];

  // 合并 OAuth 凭据提供商与 API Key 凭据提供商
  // 历史上只在 apiKeyProviders 为空时才从 credentials 推导，导致一旦存在 API Key 提供商（如 opencode），
  // 占 99% 请求量的 OAuth 提供商（如 antigravity、workbuddy 等）被完全弃用，大盘供应商列表严重失真。
  const oauthProvidersMap = new Map();
  for (const c of credentials) {
    const prov = c.provider;
    if (!prov || prov === 'unknown' || prov === 'meta') continue;
    let entry = oauthProvidersMap.get(prov);
    if (!entry) {
      entry = {
        provider: prov,
        key_count: 0,
        unique_key_count: 0,
        total_success: 0,
        total_failed: 0,
        bucketSeqs: []
      };
      oauthProvidersMap.set(prov, entry);
    }
    entry.key_count += 1;
    entry.unique_key_count += 1;
    entry.total_success += c.success;
    entry.total_failed += c.failed;
    if (c.buckets && c.buckets.length > 0) {
      entry.bucketSeqs.push(c.buckets);
    }
  }

  const oauthProviders = [...oauthProvidersMap.values()].map(entry => {
    const summary = summarizeBuckets(alignAndSum(entry.bucketSeqs), preset.windowMinutes);
    const total = entry.total_success + entry.total_failed;
    return {
      provider: entry.provider,
      key_count: entry.key_count,
      unique_key_count: entry.unique_key_count,
      total_success: entry.total_success,
      total_failed: entry.total_failed,
      total,
      success_rate: total > 0 ? Math.round((entry.total_success / total) * 10000) / 100 : null,
      buckets: summary.buckets,
      peak_total: summary.peak_total,
      peak_index: summary.peak_index,
      window_minutes: summary.window_minutes
    };
  });

  // 合并两者（按 provider 键排重合并，若同名则优先保留带 API Key 细分统计的记录）
  const combinedProvidersMap = new Map();
  for (const p of oauthProviders) {
    combinedProvidersMap.set(p.provider, p);
  }
  for (const p of apiKeyProviders) {
    const existing = combinedProvidersMap.get(p.provider);
    if (existing) {
      // 同一提供商既有 OAuth 又有 API Key，合并统计
      const mergedTotalSuccess = existing.total_success + p.total_success;
      const mergedTotalFailed = existing.total_failed + p.total_failed;
      const mergedTotal = mergedTotalSuccess + mergedTotalFailed;
      const mergedBuckets = summarizeBuckets(alignAndSum([existing.buckets, p.buckets]), preset.windowMinutes);
      combinedProvidersMap.set(p.provider, {
        provider: p.provider,
        key_count: existing.key_count + p.key_count,
        unique_key_count: existing.unique_key_count + p.unique_key_count,
        total_success: mergedTotalSuccess,
        total_failed: mergedTotalFailed,
        total: mergedTotal,
        success_rate: mergedTotal > 0 ? Math.round((mergedTotalSuccess / mergedTotal) * 10000) / 100 : null,
        buckets: mergedBuckets.buckets,
        peak_total: mergedBuckets.peak_total,
        peak_index: mergedBuckets.peak_index,
        window_minutes: mergedBuckets.window_minutes
      });
    } else {
      combinedProvidersMap.set(p.provider, p);
    }
  }

  const providers = [...combinedProvidersMap.values()].sort((a, b) => b.total - a.total || a.provider.localeCompare(b.provider));
  const providersDerived = apiKeyProviders.length === 0 && credentials.length > 0;

  return {
    source: 'cpa_runtime',
    degraded: false,
    providers_derived: providersDerived,
    fetched_at: observedAt,
    window: preset.id,
    window_label: preset.label,
    window_minutes: preset.windowMinutes,
    bucket_minutes: preset.bucketMinutes,
    bucket_count: preset.bucketCount,
    available_windows: Object.values(WINDOW_PRESETS).map(p => ({
      id: p.id,
      label: p.label,
      short_label: p.shortLabel,
      window_minutes: p.windowMinutes,
      bucket_minutes: p.bucketMinutes,
      bucket_count: p.bucketCount
    })),
    totals: buildTotals(credentials, options),
    providers,
    credentials
  };
}

export async function getRuntimeFacts(options = {}) {
  const force = Boolean(options.force);
  const preset = resolveWindowPreset(options.window);
  const now = Date.now();

  // 若基础缓存仍然有效，可直接复用 CPA 凭据/供应商列表，对当前请求的 window 动态重算 totals，毫秒级响应
  if (!force && cache.payload && now - cache.fetchedAt < CACHE_TTL_MS) {
    if (cache.payload.window === preset.id) {
      return cache.payload;
    }
    return {
      ...cache.payload,
      window: preset.id,
      window_label: preset.label,
      window_minutes: preset.windowMinutes,
      bucket_minutes: preset.bucketMinutes,
      bucket_count: preset.bucketCount,
      totals: buildTotals(cache.payload.credentials || [], { ...options, window: preset.id })
    };
  }

  if (cache.inFlight && !force) {
    const payload = await cache.inFlight;
    if (payload.window === preset.id) return payload;
    return {
      ...payload,
      window: preset.id,
      window_label: preset.label,
      window_minutes: preset.windowMinutes,
      bucket_minutes: preset.bucketMinutes,
      bucket_count: preset.bucketCount,
      totals: buildTotals(payload.credentials || [], { ...options, window: preset.id })
    };
  }

  cache.inFlight = fetchRuntimeFacts({ ...options, window: preset.id })
    .then(payload => {
      // 降级结果不进缓存，避免 CPA 短暂不可达后要等 30s 才恢复。
      if (!payload.degraded) {
        cache.payload = payload;
        cache.fetchedAt = Date.now();
      } else if (!cache.payload) {
        cache.payload = payload;
        cache.fetchedAt = Date.now();
      }
      return payload;
    })
    .catch(err => {
      const payload = degradedPayload(err, preset);
      if (!cache.payload) cache.payload = payload;
      return payload;
    })
    .finally(() => {
      cache.inFlight = null;
    });

  return cache.inFlight;
}

export function resetRuntimeFactsCache() {
  cache.payload = null;
  cache.fetchedAt = 0;
  cache.inFlight = null;
}

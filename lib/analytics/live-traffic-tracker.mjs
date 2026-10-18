import { stmtEventsForLiveBuckets, stmtEventsWindowAggregate, stmtOutboxAll } from '../db/sqlite.mjs';
import { pendingEvents, flushUsage } from '../core/outbox.mjs';
import { CHINA_TZ_OFFSET_SECONDS } from '../config.mjs';

/**
 * Gate 本地权威实时流量追踪器 (Dual-Track In-Memory / SQLite Persistent Tracker)
 *
 * 架构背景与设计目标：
 * 1. 过去运行总览吞吐图直接依赖上游 CPA 的 in-memory recent_requests (20 桶 x 10 分钟 = 200 分钟)。
 *    当生产环境升级、重启或重建 CPA 容器时，CPA 内存数据瞬间归零，导致管理台历史流量出现大面积空白。
 * 2. 实际上 Gate 的 SQLite 完整记录了每一笔流经网关的真实请求 (request_events 与 usage_outbox)。
 * 3. 本模块实现双轨方案：
 *    - 读热路径：内存中按 10 分钟时间槽对齐的 O(1) 计数，对请求处理零数据库 I/O 损耗，彻底杜绝自发 DDoS；
 *    - 冷启动：进程启动时从 SQLite 索引范围扫描 (ts >= now - 200分钟) 并叠加尚未落盘的 Outbox/Pending 事件，
 *      瞬间恢复完整 200 分钟流量图；
 *    - 低频对齐：后台每 5 分钟执行一次轻量对齐 (reconcile)，先刷盘再核验，防止内存与持久层产生漂移。
 */

export const RUNTIME_BUCKET_COUNT = 20;
export const RUNTIME_BUCKET_MINUTES = 10;
export const RUNTIME_BUCKET_SECONDS = RUNTIME_BUCKET_MINUTES * 60; // 600 秒
export const RUNTIME_WINDOW_SECONDS = RUNTIME_BUCKET_COUNT * RUNTIME_BUCKET_SECONDS; // 12000 秒 (200 分钟)
export const RECONCILE_INTERVAL_MS = 5 * 60 * 1000; // 5 分钟
export { CHINA_TZ_OFFSET_SECONDS }; // 单点真理源统一归拢在 lib/config.mjs，此处重导出保持兼容

export const WINDOW_PRESETS = {
  '3h20m': {
    id: '3h20m',
    label: '近 3 小时 20 分',
    shortLabel: '3h20m',
    windowMinutes: 200,
    bucketMinutes: 10,
    bucketCount: 20
  },
  '5h': {
    id: '5h',
    label: '近 5 小时',
    shortLabel: '5h',
    windowMinutes: 300,
    bucketMinutes: 10,
    bucketCount: 30
  },
  '1d': {
    id: '1d',
    label: '近 1 天',
    shortLabel: '1d',
    windowMinutes: 1440,
    bucketMinutes: 60,
    bucketCount: 24
  },
  '3d': {
    id: '3d',
    label: '近 3 天',
    shortLabel: '3d',
    windowMinutes: 4320,
    bucketMinutes: 180,
    bucketCount: 24
  },
  '7d': {
    id: '7d',
    label: '近 7 天',
    shortLabel: '7d',
    windowMinutes: 10080,
    bucketMinutes: 360,
    bucketCount: 28
  },
  '30d': {
    id: '30d',
    label: '近 30 天',
    shortLabel: '30d',
    windowMinutes: 43200,
    bucketMinutes: 1440,
    bucketCount: 30
  }
};

export const DEFAULT_WINDOW_ID = '3h20m';

export function resolveWindowPreset(windowId) {
  if (typeof windowId === 'string' && WINDOW_PRESETS[windowId]) {
    return WINDOW_PRESETS[windowId];
  }
  return WINDOW_PRESETS[DEFAULT_WINDOW_ID];
}

// 采用 Asia/Shanghai 时区固定两数字时分格式化（例如 "21:00-21:10"）
const timeFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
});

const dayTimeFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
});

function formatBucketTime(startSec, endSec) {
  const startStr = timeFormatter.format(new Date(startSec * 1000));
  const endStr = timeFormatter.format(new Date(endSec * 1000));
  return `${startStr}-${endStr}`;
}

export function formatWindowBucketTime(startSec, endSec, bucketMinutes) {
  if (bucketMinutes < 60) {
    return formatBucketTime(startSec, endSec);
  }
  const startParts = dayTimeFormatter.formatToParts(new Date(startSec * 1000));
  const endParts = dayTimeFormatter.formatToParts(new Date(endSec * 1000));
  const getPart = (parts, type) => parts.find(p => p.type === type)?.value || '';

  const m1 = getPart(startParts, 'month');
  const d1 = getPart(startParts, 'day');
  const h1 = getPart(startParts, 'hour');
  const min1 = getPart(startParts, 'minute');

  const m2 = getPart(endParts, 'month');
  const d2 = getPart(endParts, 'day');
  const h2 = getPart(endParts, 'hour');
  const min2 = getPart(endParts, 'minute');

  if (bucketMinutes >= 1440) {
    // 每日桶（如 30d 窗口），单桶代表整整一个自然日（00:00 - 24:00）
    // 格式化为直观清晰的月日，如 "10-17"
    return `${m1}-${d1}`;
  }

  if (m1 === m2 && d1 === d2) {
    return `${m1}-${d1} ${h1}:${min1}-${h2}:${min2}`;
  }
  return `${m1}-${d1} ${h1}:${min1}-${m2}-${d2} ${h2}:${min2}`;
}

// 内存槽映射：slotIndex (epochSec / 600) -> { success: number, failed: number }
const slotMap = new Map();
let trackerInitialized = false;
let reconcilerTimer = null;

/**
 * 记录单笔请求的实时流量（内存纳秒级 O(1) 累加）
 * @param {number} ts - 请求秒级时间戳
 * @param {boolean} isSuccess - 是否成功 (status >= 200 && status < 400)
 */
export function recordLiveTraffic(ts, isSuccess) {
  if (!Number.isFinite(ts) || ts <= 0) ts = Math.floor(Date.now() / 1000);
  const slot = Math.floor(ts / RUNTIME_BUCKET_SECONDS);

  let entry = slotMap.get(slot);
  if (!entry) {
    entry = { success: 0, failed: 0 };
    slotMap.set(slot, entry);
  }

  if (isSuccess) {
    entry.success += 1;
  } else {
    entry.failed += 1;
  }

  // 惰性内存修剪：槽位数量超过 60 个时清理早于 30 个槽位之前的陈旧数据
  if (slotMap.size > 60) {
    const minKeepSlot = slot - 30;
    for (const s of slotMap.keys()) {
      if (s < minKeepSlot) slotMap.delete(s);
    }
  }
}

/**
 * 获取当前 200 分钟（20 桶 x 10 分钟）对齐的实时流量桶序列
 * @param {number} [nowSec] - 可选参考时间（秒），默认当前时间
 * @returns {Array<{ time: string, success: number, failed: number, start: number, end: number }>}
 */
export function getLiveTrafficBuckets(nowSec) {
  const currentSec = Number.isFinite(nowSec) && nowSec > 0 ? nowSec : Math.floor(Date.now() / 1000);
  const currentSlot = Math.floor(currentSec / RUNTIME_BUCKET_SECONDS);
  const buckets = [];

  for (let i = 0; i < RUNTIME_BUCKET_COUNT; i++) {
    const slot = currentSlot - (RUNTIME_BUCKET_COUNT - 1 - i);
    const startSec = slot * RUNTIME_BUCKET_SECONDS;
    const endSec = (slot + 1) * RUNTIME_BUCKET_SECONDS;
    const entry = slotMap.get(slot);

    buckets.push({
      time: formatBucketTime(startSec, endSec),
      success: entry ? entry.success : 0,
      failed: entry ? entry.failed : 0,
      start: startSec,
      end: endSec
    });
  }

  return buckets;
}

/**
 * 获取指定时间窗口（如 3h20m / 5h / 1d / 3d / 7d / 30d）对齐的流量分桶序列
 *
 * 【长远技术演进备忘 / Scale Architecture Note】：
 * 1. 现状：当前生产 30 天约 15 万笔请求，底层 SQLite 借助 ts 复合索引执行 stmtEventsWindowAggregate 仅需 ~88ms。
 * 2. 远期扩容演进方案（当单月流量突破 200 万笔以上且查询出现明显可感延迟时）：
 *    - 优先方案（零存储开销）：对 7d / 30d 等长窗口的聚合结果增加轻量级内存 TTL 缓存（如 60s），
 *      因历史 29 天聚合事实固定不变，仅当日前进桶微幅变化，缓存可将 99% 的大盘扫表开销归零；
 *    - 备选方案：复用已有的自然日聚合表 usage_daily（包含按日、按 key_id、按 model 的 requests 与成功失败数），
 *      历史完整自然日直接读取 usage_daily，当天未结槽位叠加实时事件，避免引入额外的 daily_event_rollups 冗余表。
 *
 * @param {string} [windowId] - 窗口标识符（默认 '3h20m'）
 * @param {number} [nowSec] - 可选参考时间（秒），默认当前时间
 * @returns {Array<{ time: string, success: number, failed: number, start: number, end: number }>}
 */
export function getTrafficBucketsForWindow(windowId, nowSec) {
  const preset = resolveWindowPreset(windowId);
  const currentSec = Number.isFinite(nowSec) && nowSec > 0 ? nowSec : Math.floor(Date.now() / 1000);

  // 默认 3h20m 且内存追踪器已就绪时，优先取 O(1) 内存槽位保持零 I/O 损耗
  if (preset.id === DEFAULT_WINDOW_ID && isTrackerInitialized()) {
    return getLiveTrafficBuckets(currentSec);
  }

  const bucketSeconds = preset.bucketMinutes * 60;
  // 采用 Asia/Shanghai (UTC+8) 时区对齐：将 UTC 秒数加上 8 小时偏移转换到北京时间槽位
  const localCurrentSec = currentSec + CHINA_TZ_OFFSET_SECONDS;
  const localCurrentSlot = Math.floor(localCurrentSec / bucketSeconds);
  const minSlot = localCurrentSlot - preset.bucketCount + 1;
  const minTs = minSlot * bucketSeconds - CHINA_TZ_OFFSET_SECONDS;
  const maxTs = (localCurrentSlot + 1) * bucketSeconds - CHINA_TZ_OFFSET_SECONDS;

  const countMap = new Map();

  // 1. 查询 SQLite 聚合事实（传入时区偏移进行模除截断）
  try {
    const rows = stmtEventsWindowAggregate.all(
      CHINA_TZ_OFFSET_SECONDS,
      CHINA_TZ_OFFSET_SECONDS,
      bucketSeconds,
      CHINA_TZ_OFFSET_SECONDS,
      minTs,
      maxTs
    );
    for (const r of rows) {
      countMap.set(Number(r.slot_start), {
        success: Number(r.success) || 0,
        failed: Number(r.failed) || 0
      });
    }
  } catch (err) {
    console.error('[Gate-LiveTraffic] Failed to query stmtEventsWindowAggregate:', err.message);
  }

  // 2. 叠加 usage_outbox 中未落盘事件
  try {
    const outboxEvents = stmtOutboxAll.all();
    for (const ev of outboxEvents) {
      if (ev.ts >= minTs && ev.ts < maxTs) {
        const localTs = ev.ts + CHINA_TZ_OFFSET_SECONDS;
        const slotStart = Math.floor(localTs / bucketSeconds) * bucketSeconds - CHINA_TZ_OFFSET_SECONDS;
        let entry = countMap.get(slotStart);
        if (!entry) {
          entry = { success: 0, failed: 0 };
          countMap.set(slotStart, entry);
        }
        if (ev.status >= 200 && ev.status < 400) entry.success += 1;
        else entry.failed += 1;
      }
    }
  } catch (err) {
    console.error('[Gate-LiveTraffic] Failed to overlay usage_outbox for window buckets:', err.message);
  }

  // 3. 叠加 pendingEvents 内存待办事件
  try {
    for (const ev of pendingEvents) {
      if (ev && ev.ts >= minTs && ev.ts < maxTs) {
        const localTs = ev.ts + CHINA_TZ_OFFSET_SECONDS;
        const slotStart = Math.floor(localTs / bucketSeconds) * bucketSeconds - CHINA_TZ_OFFSET_SECONDS;
        let entry = countMap.get(slotStart);
        if (!entry) {
          entry = { success: 0, failed: 0 };
          countMap.set(slotStart, entry);
        }
        if (ev.status >= 200 && ev.status < 400) entry.success += 1;
        else entry.failed += 1;
      }
    }
  } catch (err) {
    console.error('[Gate-LiveTraffic] Failed to overlay pendingEvents for window buckets:', err.message);
  }

  // 4. 构建对齐的固定数量连续桶（若无请求则补 0）
  const buckets = [];
  for (let i = 0; i < preset.bucketCount; i++) {
    const slot = minSlot + i;
    const startSec = slot * bucketSeconds - CHINA_TZ_OFFSET_SECONDS;
    const endSec = (slot + 1) * bucketSeconds - CHINA_TZ_OFFSET_SECONDS;
    const entry = countMap.get(startSec);

    buckets.push({
      time: formatWindowBucketTime(startSec, endSec, preset.bucketMinutes),
      success: entry ? entry.success : 0,
      failed: entry ? entry.failed : 0,
      start: startSec,
      end: endSec
    });
  }

  return buckets;
}

/**
 * 冷启动初始化：从 SQLite 的 request_events 历史表以及待落盘的 Outbox/Pending 事件中加载数据
 * @param {number} [nowSec] - 可选参考时间（秒）
 */
export function initLiveTrafficTracker(nowSec) {
  const currentSec = Number.isFinite(nowSec) && nowSec > 0 ? nowSec : Math.floor(Date.now() / 1000);
  const currentSlot = Math.floor(currentSec / RUNTIME_BUCKET_SECONDS);
  const minSlot = currentSlot - RUNTIME_BUCKET_COUNT + 1;
  const minTs = minSlot * RUNTIME_BUCKET_SECONDS;
  const maxTs = (currentSlot + 1) * RUNTIME_BUCKET_SECONDS;

  slotMap.clear();

  // 1. 从 SQLite 历史表加载近 200 分钟事件
  try {
    const events = stmtEventsForLiveBuckets.all(minTs);
    for (const ev of events) {
      if (ev.ts < minTs || ev.ts >= maxTs) continue;
      const slot = Math.floor(ev.ts / RUNTIME_BUCKET_SECONDS);
      let entry = slotMap.get(slot);
      if (!entry) {
        entry = { success: 0, failed: 0 };
        slotMap.set(slot, entry);
      }
      const isSuccess = ev.status >= 200 && ev.status < 400;
      if (isSuccess) entry.success += 1;
      else entry.failed += 1;
    }
  } catch (err) {
    console.error('[Gate-LiveTraffic] Failed to load request_events for live buckets:', err.message);
  }

  // 2. 叠加 usage_outbox 中未落盘事件
  try {
    const outboxEvents = stmtOutboxAll.all();
    for (const ev of outboxEvents) {
      if (ev.ts < minTs || ev.ts >= maxTs) continue;
      const slot = Math.floor(ev.ts / RUNTIME_BUCKET_SECONDS);
      let entry = slotMap.get(slot);
      if (!entry) {
        entry = { success: 0, failed: 0 };
        slotMap.set(slot, entry);
      }
      const isSuccess = ev.status >= 200 && ev.status < 400;
      if (isSuccess) entry.success += 1;
      else entry.failed += 1;
    }
  } catch (err) {
    console.error('[Gate-LiveTraffic] Failed to overlay usage_outbox for live buckets:', err.message);
  }

  // 3. 叠加 pendingEvents 内存待办事件
  try {
    for (const ev of pendingEvents) {
      if (!ev || ev.ts < minTs || ev.ts >= maxTs) continue;
      const slot = Math.floor(ev.ts / RUNTIME_BUCKET_SECONDS);
      let entry = slotMap.get(slot);
      if (!entry) {
        entry = { success: 0, failed: 0 };
        slotMap.set(slot, entry);
      }
      const isSuccess = ev.status >= 200 && ev.status < 400;
      if (isSuccess) entry.success += 1;
      else entry.failed += 1;
    }
  } catch (err) {
    console.error('[Gate-LiveTraffic] Failed to overlay pendingEvents for live buckets:', err.message);
  }

  trackerInitialized = true;
}

/**
 * 低频后台核对（Reconcile）：先执行 Outbox 落盘，随后拉取 SQLite 最权威事实刷新内存，杜绝长期漂移
 * @param {number} [nowSec] - 可选参考时间（秒）
 */
export function reconcileLiveTraffic(nowSec) {
  try {
    flushUsage();
  } catch (_) {}

  const currentSec = Number.isFinite(nowSec) && nowSec > 0 ? nowSec : Math.floor(Date.now() / 1000);
  const currentSlot = Math.floor(currentSec / RUNTIME_BUCKET_SECONDS);
  const minSlot = currentSlot - RUNTIME_BUCKET_COUNT + 1;
  const minTs = minSlot * RUNTIME_BUCKET_SECONDS;
  const maxTs = (currentSlot + 1) * RUNTIME_BUCKET_SECONDS;

  const freshMap = new Map();

  try {
    const events = stmtEventsForLiveBuckets.all(minTs);
    for (const ev of events) {
      if (ev.ts < minTs || ev.ts >= maxTs) continue;
      const slot = Math.floor(ev.ts / RUNTIME_BUCKET_SECONDS);
      let entry = freshMap.get(slot);
      if (!entry) {
        entry = { success: 0, failed: 0 };
        freshMap.set(slot, entry);
      }
      const isSuccess = ev.status >= 200 && ev.status < 400;
      if (isSuccess) entry.success += 1;
      else entry.failed += 1;
    }

    // 叠加落盘间隙最新产生的 outbox/pending
    for (const ev of stmtOutboxAll.all()) {
      if (ev.ts < minTs || ev.ts >= maxTs) continue;
      const slot = Math.floor(ev.ts / RUNTIME_BUCKET_SECONDS);
      let entry = freshMap.get(slot);
      if (!entry) {
        entry = { success: 0, failed: 0 };
        freshMap.set(slot, entry);
      }
      const isSuccess = ev.status >= 200 && ev.status < 400;
      if (isSuccess) entry.success += 1;
      else entry.failed += 1;
    }

    for (const ev of pendingEvents) {
      if (!ev || ev.ts < minTs || ev.ts >= maxTs) continue;
      const slot = Math.floor(ev.ts / RUNTIME_BUCKET_SECONDS);
      let entry = freshMap.get(slot);
      if (!entry) {
        entry = { success: 0, failed: 0 };
        freshMap.set(slot, entry);
      }
      const isSuccess = ev.status >= 200 && ev.status < 400;
      if (isSuccess) entry.success += 1;
      else entry.failed += 1;
    }

    // 原子替换
    slotMap.clear();
    for (const [k, v] of freshMap.entries()) {
      slotMap.set(k, v);
    }
    trackerInitialized = true;
  } catch (err) {
    console.error('[Gate-LiveTraffic] Reconcile error:', err.message);
  }
}

/**
 * 启动后台低频定期核对定时器
 */
export function startLiveTrafficReconciler() {
  if (reconcilerTimer) clearInterval(reconcilerTimer);
  reconcilerTimer = setInterval(() => {
    reconcileLiveTraffic();
  }, RECONCILE_INTERVAL_MS);
  reconcilerTimer.unref();
}

/**
 * 停止后台核对定时器
 */
export function stopLiveTrafficReconciler() {
  if (reconcilerTimer) {
    clearInterval(reconcilerTimer);
    reconcilerTimer = null;
  }
}

/**
 * 检查追踪器是否已初始化
 */
export function isTrackerInitialized() {
  return trackerInitialized;
}

/**
 * 测试环境重置辅助函数
 */
export function resetTrackerForTest() {
  stopLiveTrafficReconciler();
  slotMap.clear();
  trackerInitialized = false;
}

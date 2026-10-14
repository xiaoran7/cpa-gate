import http from 'http';
import https from 'https';

// 通用 webhook 事件通知：逗号/空白分隔多个 URL，POST JSON（text/title/event/subject/ts）。
// 未配置 GATE_NOTIFY_WEBHOOKS 时整体休眠，零开销。旧 CPA_ 变量保留一个版本作兼容回退。
const WEBHOOKS = (process.env.GATE_NOTIFY_WEBHOOKS || process.env.CPA_NOTIFY_WEBHOOKS || '')
  .split(/[,\s]+/)
  .map(s => s.trim())
  .filter(Boolean);

const NOTIFY_TIMEOUT_MS = Number(process.env.GATE_NOTIFY_TIMEOUT_MS || 8000);

// 同一 (type, subject) 的冷却期内只推送一次，防止逐请求刷屏；全部发送失败则清冷却允许重试
const COOLDOWNS_MS = {
  quota_exceeded: 6 * 3600000,
  flush_failure: 30 * 60000,
  sync_failure: 30 * 60000,
  default: 3600000
};

const cooldowns = new Map(); // "type|subject" -> last attempt ts
let sentCount = 0;
let failureCount = 0;
let lastError = null;
let lastSentTs = 0;
let lastSentEvent = null;

function postJson(url, payload) {
  return new Promise((resolve, reject) => {
    let req;
    try {
      const body = Buffer.from(JSON.stringify(payload), 'utf8');
      const mod = url.startsWith('https:') ? https : http;
      req = mod.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': body.length
        },
        timeout: NOTIFY_TIMEOUT_MS
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve();
          else reject(new Error(`webhook ${url} -> ${res.statusCode}`));
        });
      });
      req.on('timeout', () => req.destroy(new Error(`webhook ${url} timeout`)));
      req.on('error', reject);
      req.end(body);
    } catch (e) {
      if (req) req.destroy();
      reject(e);
    }
  });
}

/**
 * 异步事件通知（fire-and-forget，严禁在请求热路径 await）。
 * 返回 true 表示本次确实发起了推送（非冷却抑制）。
 */
export async function notifyEvent(type, subject, text) {
  if (WEBHOOKS.length === 0) return false;

  const cooldownMs = COOLDOWNS_MS[type] || COOLDOWNS_MS.default;
  const key = `${type}|${subject || ''}`;
  const last = cooldowns.get(key) || 0;
  const now = Date.now();
  if (now - last < cooldownMs) return false;
  cooldowns.set(key, now);

  const payload = {
    title: `[Gate] ${type}`,
    text,
    event: type,
    subject: subject || '',
    ts: now
  };

  let delivered = 0;
  let lastErr = null;
  for (const url of WEBHOOKS) {
    try {
      await postJson(url, payload);
      delivered++;
    } catch (e) {
      lastErr = e.message;
    }
  }

  if (delivered > 0) {
    sentCount += delivered;
    lastSentTs = Date.now();
    lastSentEvent = type;
  } else {
    failureCount++;
    lastError = lastErr;
    // 全部失败：不立即解除冷却，改为 60s 后允许重试，避免端点宕机时形成重试风暴
    cooldowns.set(key, now + 60000 - cooldownMs);
  }
  return true;
}

export function getNotifyHealth() {
  return {
    enabled: WEBHOOKS.length > 0,
    targets: WEBHOOKS.length,
    sent_total: sentCount,
    failure_count: failureCount,
    last_error: lastError,
    last_sent_ts: lastSentTs,
    last_sent_event: lastSentEvent
  };
}

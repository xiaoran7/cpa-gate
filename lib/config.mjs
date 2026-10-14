// 路径可通过环境变量覆盖（本地测试或自定义部署路径用），默认提供规范 fallback；旧 CPA_* 变量保留作兼容回退
export const GUARD_DIR = process.env.GATE_DIR || process.env.CPA_GUARD_DIR || './data';
export const KEEPER_DB_PATH = process.env.GATE_KEEPER_DB || process.env.CPA_KEEPER_DB || './data/keeper.db';
export const QUOTA_DB_PATH = process.env.GATE_DB || process.env.CPA_GUARD_DB || `${GUARD_DIR}/gate.db`;

// CPA 管理 API（Key 注册表的唯一真理源）
export const CPA_MGMT_HOST = process.env.GATE_MGMT_HOST || process.env.CPA_MGMT_HOST || '127.0.0.1';
export const CPA_MGMT_PORT = Number(process.env.GATE_MGMT_PORT || process.env.CPA_MGMT_PORT || 8315);
export const CPA_MGMT_SECRET = process.env.GATE_MGMT_SECRET || process.env.CPA_MGMT_SECRET;

// Gate 自身管理密钥
export const ADMIN_SECRET = process.env.GATE_ADMIN_SECRET || process.env.CPA_ADMIN_SECRET;

// 上游配置与限制
export const UPSTREAM_HOST = process.env.GATE_UPSTREAM_HOST || process.env.CPA_UPSTREAM_HOST || '127.0.0.1';
export const UPSTREAM_PORT = Number(process.env.GATE_UPSTREAM_PORT || process.env.CPA_UPSTREAM_PORT || 8315);
export const MAX_REQUEST_BODY_BYTES = Number(process.env.GATE_MAX_REQUEST_BODY_BYTES || process.env.CPA_MAX_REQUEST_BODY_BYTES || 67108864); // 64 MiB
export const MAX_ADMIN_BODY_BYTES = Number(process.env.GATE_MAX_ADMIN_BODY_BYTES || process.env.CPA_MAX_ADMIN_BODY_BYTES || 262144); // 256 KiB
export const METRICS_TOKEN = process.env.GATE_METRICS_TOKEN || process.env.CPA_METRICS_TOKEN || '';

// 数据保留与自动修剪策略
export const EVENT_RETENTION_ROWS = Number(process.env.GATE_EVENT_RETENTION_ROWS || 50000);
export const EVENT_RETENTION_DAYS = Number(process.env.GATE_EVENT_RETENTION_DAYS || 14);
export const DAILY_RETENTION_DAYS = Number(process.env.GATE_DAILY_RETENTION_DAYS || 90);

// 上游凭据调度默认值：CPA 未在 auths/<name>.json 显式写 priority / weight 时的兜底。
// 与 CPA 自身的 0-1000 / 1-1000 区间对齐，非法值同样回落到默认值。
//
// priority 的默认值必须等于 CPA 自己的兜底值（0），否则管理台会显示一个
// 根本不存在的档位：未设的号真实按 P0 调度，界面却标成 P10，凭空插在
// 真正设了 P0/P5 的号前面。改这个常量前先确认 CPA 侧的默认值。
export const DEFAULT_AUTH_PRIORITY = Number(process.env.GATE_DEFAULT_AUTH_PRIORITY || 0);
export const DEFAULT_AUTH_WEIGHT = Number(process.env.GATE_DEFAULT_AUTH_WEIGHT || 1);
export const AUTH_PRIORITY_MIN = 0;
export const AUTH_PRIORITY_MAX = 1000;
export const AUTH_WEIGHT_MIN = 1;
export const AUTH_WEIGHT_MAX = 1000;

// 端口与网络拓扑绑定（可通过 GATE_BIND_TARGETS 自定义绑定）
export const BIND_TARGETS = (process.env.GATE_BIND_TARGETS || process.env.CPA_BIND_TARGETS)
  ? (process.env.GATE_BIND_TARGETS || process.env.CPA_BIND_TARGETS).split(';').map(s => {
      const [host, port, ...rest] = s.trim().split(':');
      return { host, port: Number(port), name: rest.join(':') || 'Bind Target' };
    })
  : [
      { host: '127.0.0.1', port: 8316, name: 'Reverse Proxy Port' },
      { host: '127.0.0.1', port: 8317, name: 'Local Direct Port' }
    ];

export function validateConfig() {
  if (!CPA_MGMT_SECRET || CPA_MGMT_SECRET.length < 24) {
    throw new Error('CPA_MGMT_SECRET must be configured and at least 24 characters');
  }
}

export function validateAdminSecret() {
  if (!ADMIN_SECRET || ADMIN_SECRET.length < 24) {
    throw new Error('GATE_ADMIN_SECRET must be configured and at least 24 characters');
  }
}

export function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      req.resume();
      reject(err);
    };
    req.on('data', chunk => {
      total += chunk.length;
      if (total > maxBytes) {
        fail(Object.assign(new Error('request body too large'), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!settled) { settled = true; resolve(Buffer.concat(chunks)); }
    });
    req.on('error', err => fail(err));
  });
}

export function writeJson(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders
  });
  res.end(JSON.stringify(payload));
}

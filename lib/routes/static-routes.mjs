import fs from 'fs';
import zlib from 'zlib';
import crypto from 'crypto';

// 内存级静态资源缓存（按文件路径、mtime与大小缓存原始与预压缩内容，避免重复读盘与重复压缩 CPU 消耗）
const staticCache = new Map();

function sendFileWithCache(req, res, filePath, contentType, cacheControl, isText = false) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return false;
  }

  const mtimeMs = stat.mtimeMs;
  const size = stat.size;
  let cached = staticCache.get(filePath);

  if (!cached || cached.mtimeMs !== mtimeMs || cached.size !== size) {
    let raw;
    try {
      raw = fs.readFileSync(filePath);
    } catch {
      return false;
    }
    const etag = `"${crypto.createHash('md5').update(raw).digest('hex').slice(0, 16)}"`;
    let gzipped = null;
    let deflated = null;
    if (isText && raw.length > 512) {
      try { gzipped = zlib.gzipSync(raw); } catch {}
      try { deflated = zlib.deflateSync(raw); } catch {}
    }
    cached = { mtimeMs, size, raw, etag, gzipped, deflated };
    staticCache.set(filePath, cached);
  }

  const headers = req.headers || {};
  const ifNoneMatch = headers['if-none-match'];

  // ETag 304 协商缓存命中，直接秒回（零网络传输）
  if (ifNoneMatch && (ifNoneMatch === cached.etag || ifNoneMatch === 'W/' + cached.etag || ifNoneMatch === '*')) {
    res.writeHead(304, {
      'ETag': cached.etag,
      'Cache-Control': cacheControl,
      'Vary': 'Accept-Encoding'
    });
    res.end();
    return true;
  }

  const acceptEncoding = headers['accept-encoding'] || '';
  let body = cached.raw;
  const responseHeaders = {
    'Content-Type': contentType,
    'Cache-Control': cacheControl,
    'ETag': cached.etag,
    'X-Content-Type-Options': 'nosniff',
    'Vary': 'Accept-Encoding'
  };

  if (isText) {
    if (cached.gzipped && acceptEncoding.includes('gzip')) {
      responseHeaders['Content-Encoding'] = 'gzip';
      body = cached.gzipped;
    } else if (cached.deflated && acceptEncoding.includes('deflate')) {
      responseHeaders['Content-Encoding'] = 'deflate';
      body = cached.deflated;
    }
  }

  res.writeHead(200, responseHeaders);
  res.end(body);
  return true;
}

export function handleStaticRoutes(req, res, urlPath, GUARD_DIR, STATIC_DIR = null) {
  // 静态资源优先从安装根目录读取（首次 clone 即可用），
  // 找不到时回退到旧部署形态：资产与 admin.html 放在 GATE_DIR 下。
  const staticRoot = STATIC_DIR || GUARD_DIR;
  const resolveAsset = (relPath) => {
    const primary = `${staticRoot}/${relPath}`;
    if (fs.existsSync(primary) || staticRoot === GUARD_DIR) return primary;
    return `${GUARD_DIR}/${relPath}`;
  };

  const adminAssets = {
    '/admin/cpa-management.js': { file: 'admin-cpa.js', type: 'text/javascript; charset=utf-8' },
    '/admin/cpa-management.css': { file: 'admin-cpa.css', type: 'text/css; charset=utf-8' },
    '/admin/overview.js': { file: 'admin-overview.js', type: 'text/javascript; charset=utf-8' },
    '/admin/overview.css': { file: 'admin-overview.css', type: 'text/css; charset=utf-8' },
    '/admin/style.css': { file: 'admin-style.css', type: 'text/css; charset=utf-8' },
    '/admin/admin-style.css': { file: 'admin-style.css', type: 'text/css; charset=utf-8' },
    '/admin/quotas.js': { file: 'admin-quotas.js', type: 'text/javascript; charset=utf-8' },
    '/admin/admin-quotas.js': { file: 'admin-quotas.js', type: 'text/javascript; charset=utf-8' },
    '/admin/keys.js': { file: 'admin-keys.js', type: 'text/javascript; charset=utf-8' },
    '/admin/admin-keys.js': { file: 'admin-keys.js', type: 'text/javascript; charset=utf-8' },
    '/admin/stats.js': { file: 'admin-stats.js', type: 'text/javascript; charset=utf-8' },
    '/admin/admin-stats.js': { file: 'admin-stats.js', type: 'text/javascript; charset=utf-8' },
    '/admin/logs.js': { file: 'admin-logs.js', type: 'text/javascript; charset=utf-8' },
    '/admin/admin-logs.js': { file: 'admin-logs.js', type: 'text/javascript; charset=utf-8' }
  };

  if (adminAssets[urlPath]) {
    const { file, type } = adminAssets[urlPath];
    const fullPath = resolveAsset(file);
    // 静态 JS/CSS 开启 ETag 协商与 no-cache, must-revalidate，杜绝强缓存，改动即时生效
    const ok = sendFileWithCache(req, res, fullPath, type, 'no-cache, must-revalidate', true);
    if (!ok) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Asset not found');
    }
    return true;
  }

  const adminImages = {
    '/admin/assets/routing-header.png': 'routing-header.png',
    '/admin/assets/sakura-gate-v2.png': 'sakura-gate-v2.png',
    '/admin/assets/sakura-gate-v2.webp': 'sakura-gate-v2.webp',
    '/admin/assets/sakura-gate-mobile.webp': 'sakura-gate-mobile.webp',
    '/admin/assets/gate-sakura-mark-v2.png': 'gate-sakura-mark-v2.png',
    '/admin/assets/gate-sakura-mark-128.png': 'gate-sakura-mark-128.png',
    '/admin/assets/gate-sakura-mark-128.webp': 'gate-sakura-mark-128.webp',
    '/admin/assets/sakura-observatory-v3.webp': 'sakura-observatory-v3.webp',
    '/admin/assets/sakura-cityline-v3.webp': 'sakura-cityline-v3.webp',
  };

  if (adminImages[urlPath]) {
    const imgFile = adminImages[urlPath];
    const fullPath = resolveAsset(`gate-assets/${imgFile}`);
    const contentType = imgFile.endsWith('.webp') ? 'image/webp' : 'image/png';
    // 图片资产开启 7 天强缓存 + ETag 协商
    const ok = sendFileWithCache(req, res, fullPath, contentType, 'public, max-age=604800, immutable', false);
    if (!ok) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Asset not found' }));
    }
    return true;
  }

  if (urlPath === '/' || urlPath === '') {
    res.writeHead(302, { Location: '/admin', 'Cache-Control': 'no-store' });
    res.end();
    return true;
  }

  if (urlPath === '/admin' || urlPath === '/admin/' || urlPath === '/member' || urlPath === '/member/') {
    const fullPath = resolveAsset('admin.html');
    const ok = sendFileWithCache(req, res, fullPath, 'text/html; charset=utf-8', 'no-cache, must-revalidate', true);
    if (!ok) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('admin.html load error: file not found');
    }
    return true;
  }

  return false;
}

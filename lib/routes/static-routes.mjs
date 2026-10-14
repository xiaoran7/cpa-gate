import fs from 'fs';

export function handleStaticRoutes(req, res, urlPath, GUARD_DIR) {
  const adminAssets = {
    '/admin/cpa-management.js': { file: 'admin-cpa.js', type: 'text/javascript; charset=utf-8' },
    '/admin/cpa-management.css': { file: 'admin-cpa.css', type: 'text/css; charset=utf-8' },
    '/admin/overview.js': { file: 'admin-overview.js', type: 'text/javascript; charset=utf-8' },
    '/admin/overview.css': { file: 'admin-overview.css', type: 'text/css; charset=utf-8' }
  };

  if (adminAssets[urlPath]) {
    const { file, type } = adminAssets[urlPath];
    // 先读文件再写响应头：反序会在文件缺失时于 catch 里二次 writeHead，
    // 触发 ERR_HTTP_HEADERS_SENT 并让整个网关进程退出。
    let body;
    try {
      body = fs.readFileSync(`${GUARD_DIR}/${file}`);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Asset not found');
      return true;
    }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(body);
    return true;
  }
  const adminImages = {
    '/admin/assets/routing-header.png': 'routing-header.png',
    '/admin/assets/sakura-gate-v2.png': 'sakura-gate-v2.png',
    '/admin/assets/gate-sakura-mark-v2.png': 'gate-sakura-mark-v2.png',
    '/admin/assets/sakura-observatory-v3.webp': 'sakura-observatory-v3.webp',
    '/admin/assets/sakura-cityline-v3.webp': 'sakura-cityline-v3.webp',
  };

  if (adminImages[urlPath]) {
    // 同上：先读后写，避免 ERR_HTTP_HEADERS_SENT 拖垮整个进程。
    let asset;
    try {
      asset = fs.readFileSync(`${GUARD_DIR}/gate-assets/${adminImages[urlPath]}`);
    } catch {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Asset not found' }));
      return true;
    }
    res.writeHead(200, {
      'Content-Type': adminImages[urlPath].endsWith('.webp') ? 'image/webp' : 'image/png',
      'Cache-Control': 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(asset);
    return true;
  }

  if (urlPath === '/' || urlPath === '') {
    res.writeHead(302, { Location: '/admin', 'Cache-Control': 'no-store' });
    res.end();
    return true;
  }

  if (urlPath === '/admin' || urlPath === '/admin/' || urlPath === '/member' || urlPath === '/member/') {
    try {
      const html = fs.readFileSync(`${GUARD_DIR}/admin.html`, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return true;
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('admin.html load error: ' + e.message);
      return true;
    }
  }

  return false;
}

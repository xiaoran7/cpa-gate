import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export function parseCookies(cookieHeader = '') {
  const cookies = {};
  cookieHeader.split(';').forEach(part => {
    const [k, v] = part.split('=').map(s => s && s.trim());
    if (k && v) cookies[k] = decodeURIComponent(v);
  });
  return cookies;
}

export function verifySecret(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string') return false;
  const token = candidate.trim();
  const secret = expected.trim();
  if (!token || !secret) return false;
  const bufA = Buffer.from(token);
  const bufB = Buffer.from(secret);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

let cachedLocalManagementHtml = null;

export function getScriptInjection() {
  return `
<script>
  (function() {
    function rewriteUrl(url) {
      if (!url) return url;
      if (typeof url !== 'string') {
        try { url = url.toString(); } catch (e) { return url; }
      }
      if (url.includes('/admin/upstream/')) return url;

      // 1. 相对路径
      if (url.startsWith('/v0/management') || url.startsWith('/v8/management')) {
        return '/admin/upstream' + url;
      }
      if (url.startsWith('v0/management') || url.startsWith('v8/management')) {
        return '/admin/upstream/' + url;
      }

      // 2. 绝对路径或带 Origin 的 URL (如 https://cpa.example.com/v0/management/...)
      try {
        const parsed = new URL(url, window.location.href);
        if (parsed.pathname.startsWith('/v0/management') || parsed.pathname.startsWith('/v8/management')) {
          return window.location.origin + '/admin/upstream' + parsed.pathname + parsed.search;
        }
      } catch (e) {}

      return url;
    }

    const originalFetch = window.fetch;
    window.fetch = function(input, init) {
      try {
        if (typeof input === 'string') {
          input = rewriteUrl(input);
        } else if (input instanceof URL) {
          input = new URL(rewriteUrl(input.toString()));
        } else if (input && typeof input.url === 'string') {
          const rewritten = rewriteUrl(input.url);
          if (rewritten !== input.url) {
            input = new Request(rewritten, input);
          }
        }
      } catch (e) {
        console.warn('[Gate-Proxy] fetch rewrite error:', e);
      }
      return originalFetch.call(this, input, init);
    };

    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      try {
        if (typeof url === 'string') {
          url = rewriteUrl(url);
        } else if (url && typeof url.toString === 'function') {
          url = rewriteUrl(url.toString());
        }
      } catch (e) {
        console.warn('[Gate-Proxy] XHR rewrite error:', e);
      }
      return originalOpen.call(this, method, url, ...rest);
    };
  })();
</script>
`;
}

export async function handleUpstreamManagementProxy(req, res, urlPath, ADMIN_SECRET, CPA_MGMT_SECRET, UPSTREAM_HOST, UPSTREAM_PORT) {
  if (!urlPath.startsWith('/admin/upstream')) {
    return false;
  }

  const parsedUrl = new URL(req.url, 'http://localhost');
  const queryToken = parsedUrl.searchParams.get('token');
  const cookies = parseCookies(req.headers['cookie']);
  const cookieToken = cookies['gate_admin_token'];
  const authHeader = req.headers['authorization'] || '';
  const bearerToken = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';

  // 1. 验证 Gate 管理密钥（支持 Query, Cookie, Bearer 三种方式，对齐 ADMIN_SECRET 与 CPA_MGMT_SECRET）
  const candidate = queryToken || cookieToken || bearerToken;
  const isAuthenticated = verifySecret(candidate, ADMIN_SECRET) || verifySecret(candidate, CPA_MGMT_SECRET);

  // 2. 若带有 query token 且通过验证，下发 Cookie 并重定向剥离 URL 里的敏感 token
  if (queryToken && isAuthenticated) {
    parsedUrl.searchParams.delete('token');
    const cleanUrl = parsedUrl.pathname + (parsedUrl.searchParams.toString() ? `?${parsedUrl.searchParams.toString()}` : '');
    res.writeHead(302, {
      'Location': cleanUrl,
      'Set-Cookie': `gate_admin_token=${encodeURIComponent(queryToken)}; Path=/; HttpOnly; SameSite=Lax`,
      'Cache-Control': 'no-store'
    });
    res.end();
    return true;
  }

  // 3. 未通过认证拦截
  if (!isAuthenticated) {
    const isHtmlRequest = (req.headers['accept'] || '').includes('text/html');
    if (isHtmlRequest || urlPath === '/admin/upstream' || urlPath === '/admin/upstream/' || urlPath.endsWith('.html')) {
      res.writeHead(302, { Location: '/admin?error=auth_required', 'Cache-Control': 'no-store' });
      res.end();
      return true;
    }
    res.writeHead(401, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify({ error: { message: 'Gate admin authentication required to access upstream management', code: 401 } }));
    return true;
  }

  // 若通过 Bearer 鉴权但尚无 Cookie，主动补充全局 Cookie，保障后续页面静态请求与无头请求通过
  if (bearerToken && isAuthenticated && !cookieToken) {
    res.setHeader('Set-Cookie', `gate_admin_token=${encodeURIComponent(bearerToken)}; Path=/; HttpOnly; SameSite=Lax`);
  }

  // 4. 路径映射到原生 CPA 目标路径
  let targetPath = urlPath.slice('/admin/upstream'.length);
  if (targetPath === '' || targetPath === '/') {
    targetPath = '/management.html';
  }

  // 4.1 本地静态 management.html 优先/兜底直出 (解决上游 CPA 禁用 control-panel 时返回 404 的问题，内存单例缓存防磁盘I/O)
  if (targetPath === '/management.html' || targetPath === 'management.html') {
    if (cachedLocalManagementHtml) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(cachedLocalManagementHtml);
      return true;
    }
    const localHtmlPath = path.resolve(process.cwd(), 'static/management.html');
    if (fs.existsSync(localHtmlPath)) {
      try {
        let html = fs.readFileSync(localHtmlPath, 'utf8');
        const injection = getScriptInjection();
        if (html.includes('<head>')) {
          html = html.replace('<head>', '<head>' + injection);
        } else {
          html = injection + html;
        }
        cachedLocalManagementHtml = html;
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store'
        });
        res.end(html);
        return true;
      } catch (e) {
        console.error('[Gate] Error serving local management.html:', e.message);
      }
    }
  }

  const upstreamTarget = targetPath + (parsedUrl.searchParams.toString() ? `?${parsedUrl.searchParams.toString()}` : '');

  // 5. 反向代理到上游 CPA，服务端强行注入合法的 CPA_MGMT_SECRET
  const headers = { ...req.headers };
  delete headers['cookie']; // 避免将 Gate 的 Cookie 发给 CPA
  headers['host'] = `${UPSTREAM_HOST}:${UPSTREAM_PORT}`;
  headers['authorization'] = `Bearer ${CPA_MGMT_SECRET || ADMIN_SECRET}`;

  const proxyReq = http.request({
    hostname: UPSTREAM_HOST,
    port: Number(UPSTREAM_PORT) || 8315,
    path: upstreamTarget,
    method: req.method,
    headers: headers
  }, (proxyRes) => {
    const status = proxyRes.statusCode;
    const respHeaders = { ...proxyRes.headers };

    // HTML 页面重写注入：让原生 SPA 的相对链接与 API 映射回 /admin/upstream 安全沙箱
    const contentType = respHeaders['content-type'] || '';
    if (contentType.includes('text/html')) {
      delete respHeaders['content-length'];
      delete respHeaders['content-security-policy']; // 避免严格 CSP 阻止注入
      respHeaders['cache-control'] = 'no-store';

      const chunks = [];
      proxyRes.on('data', chunk => chunks.push(chunk));
      proxyRes.on('end', () => {
        let html = Buffer.concat(chunks).toString('utf8');
        const injection = getScriptInjection();
        if (html.includes('<head>')) {
          html = html.replace('<head>', '<head>' + injection);
        } else {
          html = injection + html;
        }
        res.writeHead(status, respHeaders);
        res.end(html);
      });
      return;
    }

    res.writeHead(status, respHeaders);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error(`[Gate] Upstream management proxy error:`, err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Upstream CPA management unreachable: ' + err.message, code: 502 } }));
    } else {
      if (!res.destroyed) res.destroy();
    }
  });

  res.on('close', () => {
    if (!res.writableEnded) proxyReq.destroy();
  });

  req.pipe(proxyReq);
  return true;
}

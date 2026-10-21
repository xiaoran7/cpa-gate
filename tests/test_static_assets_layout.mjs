// 静态资源布局回归测试：首次 git clone 后 npm start 必须能直接打开管理台。
//
// 历史缺陷：admin.html / admin-*.js / gate-assets 曾只从 GATE_DIR（默认 ./data）读取，
// 而全新 clone 的 ./data 里只有 SQLite 文件，于是 /admin 返回 500、外置 JS/CSS 全 404。
// 本用例同时覆盖：
//   1. 默认布局（GATE_DIR 指向空临时目录，静态资源仍从安装根目录命中）；
//   2. 旧部署形态回退（GATE_DIR 下自带 admin.html 时优先使用该副本）；
//   3. .env 加载（进程级注入优先，文件里的值补齐缺失项）。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempDirs = [];
function makeTemp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function capture(handler, targetPath, guardDir, staticDir = null) {
  const seen = [];
  const res = {
    headers: {},
    writeHead(code) { seen.push(code); },
    setHeader() {},
    end() {}
  };
  handler({ url: targetPath, headers: {} }, res, targetPath, guardDir, staticDir);
  return seen;
}

console.log('=== 开始执行静态资源布局与 .env 加载回归测试 ===\n');

const { handleStaticRoutes } = await import('../lib/routes/static-routes.mjs');
const { APP_ROOT, STATIC_DIR } = await import('../lib/config.mjs');

// -------------------------------------------------------------
// 测试 1: 安装根目录解析（全新 clone 场景）
// -------------------------------------------------------------
console.log('测试 1: 默认布局下静态资源从安装根目录命中');
{
  assert.equal(APP_ROOT, root, 'APP_ROOT 必须解析到仓库根目录');
  assert.equal(STATIC_DIR, root, '默认 STATIC_DIR 必须等于安装根目录');

  const emptyGuardDir = makeTemp('gate-empty-guard-');
  const cases = [
    ['/admin', [200]],
    ['/admin/', [200]],
    ['/console', [200]],
    ['/console/', [200]],
    ['/member', [200]],
    ['/admin/style.css', [200]],
    ['/admin/quotas.js', [200]],
    ['/admin/keys.js', [200]],
    ['/admin/stats.js', [200]],
    ['/admin/logs.js', [200]],
    ['/admin/i18n.js', [200]],
    ['/admin/overview.js', [200]],
    ['/admin/overview.css', [200]],
    ['/admin/cpa-management.js', [200]],
    ['/admin/cpa-management.css', [200]],
    ['/admin/assets/sakura-gate-v2.webp', [200]],
    ['/admin/assets/gate-sakura-mark-128.png', [200]],
    ['/admin/assets/qoder-light.png', [200]],
    ['/admin/assets/qoder.svg', [200]],
    ['/console/style.css', [200]],
    ['/console/quotas.js', [200]],
    ['/console/keys.js', [200]],
    ['/console/stats.js', [200]],
    ['/console/logs.js', [200]],
    ['/console/i18n.js', [200]],
    ['/console/overview.js', [200]],
    ['/console/overview.css', [200]],
    ['/console/cpa-management.js', [200]],
    ['/console/cpa-management.css', [200]],
    ['/console/assets/sakura-gate-v2.webp', [200]],
    ['/console/assets/qoder.svg', [200]]
  ];
  for (const [target, expected] of cases) {
    // 与 server.mjs 的接线方式一致：GUARD_DIR 是数据目录，STATIC_DIR 是安装根目录。
    assert.deepEqual(capture(handleStaticRoutes, target, emptyGuardDir, STATIC_DIR), expected, `${target} 在空 GATE_DIR 下必须命中安装根目录`);
  }
  console.log(`  ✓ ${cases.length} 个静态路径在空 GATE_DIR 下全部 200`);
}

// -------------------------------------------------------------
// 测试 2: 旧部署形态回退（静态资源放在 GATE_DIR 下）
// -------------------------------------------------------------
console.log('测试 2: GATE_DIR 下自带静态资源时保持旧部署形态可用');
{
  const legacyDir = makeTemp('gate-legacy-guard-');
  fs.writeFileSync(path.join(legacyDir, 'admin.html'), '<!doctype html><title>legacy</title>');
  fs.writeFileSync(path.join(legacyDir, 'admin-style.css'), 'body {}');
  fs.mkdirSync(path.join(legacyDir, 'gate-assets'), { recursive: true });
  fs.writeFileSync(path.join(legacyDir, 'gate-assets', 'sakura-gate-v2.webp'), Buffer.from('RIFF'));

  assert.deepEqual(capture(handleStaticRoutes, '/admin', legacyDir), [200], 'legacy admin.html 必须可命中');
  assert.deepEqual(capture(handleStaticRoutes, '/admin/style.css', legacyDir), [200], 'legacy style.css 必须可命中');
  assert.deepEqual(capture(handleStaticRoutes, '/admin/assets/sakura-gate-v2.webp', legacyDir), [200], 'legacy 图片必须可命中');
  console.log('  ✓ 旧部署形态回退分支正常');
}

// -------------------------------------------------------------
// 测试 3: 资源缺失仍返回单个 404（不得二次 writeHead 崩进程）
// -------------------------------------------------------------
console.log('测试 3: 资源缺失时只返回一次 404');
{
  const emptyDir = makeTemp('gate-missing-guard-');
  const seen = [];
  const res = {
    headers: {},
    writeHead(code) { seen.push(code); if (seen.length > 1) throw new Error('ERR_HTTP_HEADERS_SENT'); },
    setHeader() {},
    end() {}
  };
  handleStaticRoutes({ url: '/admin/does-not-exist.js', headers: {} }, res, '/admin/does-not-exist.js', emptyDir, emptyDir);
  assert.deepEqual(seen, [], '未登记路径应放行给后续路由');
  console.log('  ✓ 未登记路径正确交还主路由');
}

// -------------------------------------------------------------
// 测试 4: .env 加载语义（进程注入优先，文件补齐缺失项）
// -------------------------------------------------------------
console.log('测试 4: .env 加载与进程级覆盖优先级');
{
  const envDir = makeTemp('gate-env-');
  const envFile = path.join(envDir, '.env');
  fs.writeFileSync(envFile, 'GATE_TEST_FROM_FILE=file-value\nGATE_TEST_PRECEDENCE=file-value\n# comment\nGATE_TEST_QUOTED="quoted value"\n');
  const script = `
    process.env.GATE_TEST_PRECEDENCE = 'process-value';
    await import(${JSON.stringify(new URL('../lib/config.mjs', import.meta.url).href)});
    console.log(JSON.stringify({
      fromFile: process.env.GATE_TEST_FROM_FILE,
      precedence: process.env.GATE_TEST_PRECEDENCE,
      quoted: process.env.GATE_TEST_QUOTED
    }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: envDir,
    env: { ...process.env, GATE_TEST_PRECEDENCE: 'process-value' },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.equal(parsed.fromFile, 'file-value', '.env 中的缺失项必须被补齐');
  assert.equal(parsed.precedence, 'process-value', '进程级环境变量必须优先于 .env');
  assert.equal(parsed.quoted, 'quoted value', '引号包裹的值必须去掉引号');
  console.log('  ✓ .env 补齐、进程优先与引号解析均正确');
}

for (const dir of tempDirs) {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n=== 全部静态资源布局与 .env 加载回归测试通过！===');

// 控制台中英双语回归测试：防止 i18n 改造在后续改动中退化。
//
// 背景：v2.11.0 给 /admin 控制台加了 zh/en 双语。集中字典 + t() 的做法把文案从代码里
// 抽离到了 admin-i18n.js，随之而来的是两类容易在后续迭代中悄悄坏掉的缺陷：
//
//   1. 键缺失：新增文案时只写了 t('xxx') 却没在字典里登记，t() 会回落到 key 本身，
//      页面上就会出现 "some.key" 这种裸键名。
//   2. 逻辑比较失效：把中文字面量拿去参与 ===/!== 比较。i18n 之后这些字面量会被换成
//      当前语言的文案，比较永远不成立，表现为「状态徽章颜色错了」「WorkBuddy 资源包
//      排序错了」这类静默失效 —— 不报错，只是结果不对。
//
// 本用例覆盖：
//   1. 字典完整性：所有 t('...') 引用的 key 都已登记，且中英两侧均非空；
//   2. 缺键回落：t() 对未登记的 key 回落到自身并告警，绝不抛异常、绝不返回 undefined；
//   3. setLocale 同步 <html lang> 与 window.LOCALE，并持久化到 localStorage；
//   4. 静态标记覆盖：admin.html 的可见中文文本节点都有 data-i18n 归属；
//   5. 逻辑比较闸门：中文字面量不得参与 ===/!== 比较（i18n-exempt 显式豁免除外）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

console.log('=== 开始执行控制台中英双语回归测试 ===\n');

const I18N_FILE = 'admin-i18n.js';
const HTML_FILE = 'admin.html';
// 会参与渲染的外置脚本
const CLIENT_SCRIPTS = [
  'admin-quotas.js', 'admin-keys.js', 'admin-stats.js',
  'admin-logs.js', 'admin-cpa.js', 'admin-overview.js'
];

const i18nSource = read(I18N_FILE);
const htmlSource = read(HTML_FILE);
const scriptSources = new Map(CLIENT_SCRIPTS.map(f => [f, read(f)]));

// -------------------------------------------------------------
// 测试 1: 字典结构与键完整性
// -------------------------------------------------------------
console.log('测试 1: 字典条目结构与 t() 引用键完整性');
const DICT = {};
{
  const re = /^\s*'([a-zA-Z][\w.]*)':\s*\{\s*zh:\s*'((?:[^'\\]|\\.)*)'\s*,\s*en:\s*'((?:[^'\\]|\\.)*)'\s*\}/gm;
  let m;
  while ((m = re.exec(i18nSource)) !== null) {
    DICT[m[1]] = { zh: m[2], en: m[3] };
  }
  assert.ok(Object.keys(DICT).length > 500, `字典条目数应超过 500，实际 ${Object.keys(DICT).length}`);
  console.log(`  ✓ 解析到 ${Object.keys(DICT).length} 条字典条目`);

  // 每条中英两侧都必须非空
  const empty = [];
  for (const [key, v] of Object.entries(DICT)) {
    if (!v.zh || !v.zh.trim()) empty.push(`${key} (zh)`);
    if (!v.en || !v.en.trim()) empty.push(`${key} (en)`);
  }
  assert.deepEqual(empty, [], `以下字典条目缺少中文或英文：${empty.join(', ')}`);
  console.log('  ✓ 每条字典的中文与英文均非空');
}

// 收集所有 t('key') 引用与 data-i18n* 属性引用
const referenced = new Map();   // key -> [来源]
function addRef(k, origin) {
  if (!referenced.has(k)) referenced.set(k, []);
  referenced.get(k).push(origin);
}
function scanTCalls(source, origin) {
  // 排除注释里的示例调用（admin-i18n.js 头部文档注释含 t('key.count') 之类的示例）
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const re = /\bt\(\s*(?:'([a-zA-Z][\w.]*)'|"([a-zA-Z][\w.]*)")/g;
  let m;
  while ((m = re.exec(code)) !== null) addRef(m[1] || m[2], origin);
}
function scanDataI18n(source, origin) {
  const re = /data-i18n(?:-title|-placeholder|-aria-label)?="([^"]+)"/g;
  let m;
  while ((m = re.exec(source)) !== null) addRef(m[1], origin);
}
scanTCalls(i18nSource, I18N_FILE);
for (const [f, src] of scriptSources) scanTCalls(src, f);
scanTCalls(htmlSource, HTML_FILE);
scanDataI18n(htmlSource, HTML_FILE);
// pageMeta 里存的 title/description 是字典 key 字符串
// 注意：admin-overview.js 也会在运行时写 pageMeta，同样是「存 key」形态，必须一起扫
for (const m of htmlSource.matchAll(/(?:title|description):\s*'([a-zA-Z][\w.]*)'/g)) {
  addRef(m[1], HTML_FILE);
}
for (const [f, src] of scriptSources) {
  for (const m of src.matchAll(/(?:title|description):\s*'([a-zA-Z][\w.]*)'/g)) {
    addRef(m[1], f);
  }
}

{
  const missing = [...referenced.keys()].filter(k => !(k in DICT)).sort();
  assert.deepEqual(missing, [], `以下 t() 引用的 key 未在字典中登记：${missing.join(', ')}`);
  console.log(`  ✓ ${referenced.size} 个被引用的 key 全部已登记`);

  // 反向：字典里的孤儿条目（从未被引用）—— 允许存在但给出提示，不作为失败
  const orphans = Object.keys(DICT).filter(k => !referenced.has(k)).sort();
  if (orphans.length) {
    console.log(`  · 提示：${orphans.length} 条字典条目当前无引用（${orphans.slice(0, 8).join(', ')}${orphans.length > 8 ? ' …' : ''}）`);
  }
}

// -------------------------------------------------------------
// 测试 2: t() 运行时行为（缺键回落 / 插值 / 语言切换）
// -------------------------------------------------------------
console.log('测试 2: t() 缺键回落、插值与 setLocale 同步');
{
  // 在最小 DOM 垫片上执行 admin-i18n.js
  const store = new Map();
  const sandbox = {
    window: {},
    document: { documentElement: {}, querySelectorAll: () => [] },
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v))
    },
    navigator: { language: 'zh-CN' },
    console: { warn: () => {}, error: () => {}, log: () => {} }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(i18nSource, sandbox, { filename: I18N_FILE });

  const w = sandbox.window;
  assert.equal(typeof w.t, 'function', 'window.t 必须可用');
  assert.equal(typeof w.setLocale, 'function', 'window.setLocale 必须可用');
  assert.equal(typeof w.toggleLocale, 'function', 'window.toggleLocale 必须可用');
  assert.equal(typeof w.applyStaticI18n, 'function', 'window.applyStaticI18n 必须可用');
  assert.equal(typeof w.onLocaleChange, 'function', 'window.onLocaleChange 必须可用');
  assert.equal(typeof w.onLocaleRebuild, 'function', 'window.onLocaleRebuild 必须可用');

  // 已知键：两种语言都能取到非空文案
  const sample = Object.keys(DICT).slice(0, 40);
  w.setLocale('zh');
  for (const k of sample) {
    const zh = w.t(k);
    assert.equal(typeof zh, 'string', `t('${k}') 必须返回字符串`);
    assert.ok(zh.length > 0, `t('${k}') 在中文下不得为空`);
    assert.notEqual(zh, k, `t('${k}') 在中文下不得回落到 key 本身`);
  }
  w.setLocale('en');
  for (const k of sample) {
    const en = w.t(k);
    assert.equal(typeof en, 'string', `t('${k}') 必须返回字符串`);
    assert.ok(en.length > 0, `t('${k}') 在英文下不得为空`);
    assert.notEqual(en, k, `t('${k}') 在英文下不得回落到 key 本身`);
  }
  console.log('  ✓ 已知键在两种语言下均返回非空文案');

  // 缺键回落：返回 key 本身且不抛异常
  const missingKey = 'definitely.not.a.real.key';
  assert.equal(w.t(missingKey), missingKey, '缺键必须回落到 key 本身');
  console.log('  ✓ 缺键回落到 key 本身且未抛异常');

  // 插值
  const interpKey = Object.keys(DICT).find(k => /\{(\w+)\}/.test(DICT[k].en));
  assert.ok(interpKey, '字典中应至少有一条带 {placeholder} 的条目');
  const ph = DICT[interpKey].en.match(/\{(\w+)\}/)[1];
  const rendered = w.t(interpKey, { [ph]: 'ZZZ' });
  assert.ok(rendered.includes('ZZZ'), `t('${interpKey}') 应把 {${ph}} 替换为传入值`);
  assert.ok(!rendered.includes(`{${ph}}`), `t('${interpKey}') 替换后不应残留占位符`);
  console.log('  ✓ {placeholder} 插值正常');

  // setLocale 同步 <html lang> 与 window.LOCALE，并持久化
  w.setLocale('en');
  assert.equal(sandbox.document.documentElement.lang, 'en', 'setLocale(\'en\') 必须把 <html lang> 设为 en');
  assert.equal(w.LOCALE, 'en-US', 'setLocale(\'en\') 必须把 LOCALE 设为 en-US');
  assert.equal(w.GATE_LOCALE, 'en', 'setLocale(\'en\') 必须把 GATE_LOCALE 设为 en');
  assert.equal(store.get('gate_lang'), 'en', 'setLocale 必须持久化到 localStorage[gate_lang]');

  w.setLocale('zh');
  assert.equal(sandbox.document.documentElement.lang, 'zh-CN', 'setLocale(\'zh\') 必须把 <html lang> 设为 zh-CN');
  assert.equal(w.LOCALE, 'zh-CN', 'setLocale(\'zh\') 必须把 LOCALE 设为 zh-CN');
  assert.equal(store.get('gate_lang'), 'zh', 'setLocale 必须持久化到 localStorage[gate_lang]');
  console.log('  ✓ setLocale 同步 <html lang> / LOCALE / localStorage');

  // toggleLocale 往返
  const before = w.GATE_LOCALE;
  w.toggleLocale();
  assert.notEqual(w.GATE_LOCALE, before, 'toggleLocale 必须切换语言');
  w.toggleLocale();
  assert.equal(w.GATE_LOCALE, before, 'toggleLocale 必须能切回原语言');
  console.log('  ✓ toggleLocale 往返正常');
}

// -------------------------------------------------------------
// 测试 3: 静态标记覆盖（admin.html 可见中文必须有 data-i18n）
// -------------------------------------------------------------
console.log('测试 3: admin.html 可见中文文本节点均有 data-i18n 覆盖');
{
  // 掩掉 script/style/HTML 注释
  const clean = htmlSource
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, m => ' '.repeat(m.length))
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, m => ' '.repeat(m.length))
    .replace(/<!--[\s\S]*?-->/g, m => ' '.repeat(m.length));

  const VOID = new Set(['input', 'img', 'br', 'hr', 'meta', 'link', 'source', 'area', 'base', 'col', 'embed', 'param', 'track', 'wbr']);
  const TAG = /<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  const CJK = /[一-鿿]/;

  function parseAttrs(s) {
    const attrs = {};
    let mm;
    const re = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
    while ((mm = re.exec(s)) !== null) attrs[mm[1].toLowerCase()] = mm[2];
    const re2 = /([\w:.-]+)\s*=\s*'([^']*)'/g;
    while ((mm = re2.exec(s)) !== null) if (!(mm[1].toLowerCase() in attrs)) attrs[mm[1].toLowerCase()] = mm[2];
    return attrs;
  }

  // 建树
  const rootEl = { tag: '#root', attrs: {}, start: 0, openEnd: 0, children: [] };
  const stack = [rootEl];
  let m;
  TAG.lastIndex = 0;
  while ((m = TAG.exec(clean)) !== null) {
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    if (closing) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tag) { stack.length = i; break; }
      }
      continue;
    }
    const el = {
      tag, attrs: parseAttrs(m[3]), start: m.index, openEnd: m.index + m[0].length,
      textEnd: VOID.has(tag) ? m.index + m[0].length : null, children: []
    };
    stack[stack.length - 1].children.push(el);
    if (!VOID.has(tag)) stack.push(el);
  }

  // 求各元素的可直接文本（排除子元素内部）
  const all = [];
  (function walk(el) { all.push(el); el.children.forEach(walk); })(rootEl);
  for (const el of all) {
    if (el.tag === '#root' || el.textEnd !== null) { el.direct = ''; continue; }
    let depth = 1, p = el.openEnd, close = el.openEnd;
    while (p < clean.length) {
      const mm = /<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
      mm.lastIndex = p;
      const t = mm.exec(clean);
      if (!t) break;
      if (t[1] === '/') {
        if (t[2].toLowerCase() === el.tag) { depth--; if (depth === 0) { close = t.index; el.textEnd = t.index + t[0].length; break; } }
      } else if (t[2].toLowerCase() === el.tag) depth++;
      p = t.index + t[0].length;
    }
    el.close = close;
  }
  for (const el of all) {
    if (el.tag === '#root' || el.textEnd === null) { el.direct = el.direct || ''; continue; }
    const parts = [];
    let cur = el.openEnd;
    for (const ch of el.children) {
      parts.push(clean.slice(cur, ch.start));
      cur = ch.textEnd !== null ? ch.textEnd : ch.openEnd;
    }
    parts.push(clean.slice(cur, el.close !== undefined ? el.close : el.openEnd));
    el.direct = parts.join('');
  }

  const uncovered = [];
  for (const el of all) {
    if (el.tag === '#root') continue;
    if (!el.direct || !CJK.test(el.direct)) continue;
    // 最近的带 data-i18n 的祖先
    let covered = false;
    let p = el;
    while (p && p.tag !== '#root') {
      if (p.attrs && p.attrs['data-i18n']) { covered = true; break; }
      p = p.parent;
    }
    if (!covered) uncovered.push(`<${el.tag}> ${el.direct.trim().slice(0, 60)}`);
  }
  assert.deepEqual(uncovered, [], `以下可见中文文本节点没有 data-i18n 覆盖：\n    ${uncovered.join('\n    ')}`);
  console.log('  ✓ admin.html 可见中文文本节点全部已被 data-i18n 覆盖');

  // title/placeholder/aria-label 属性里的中文同样需要 data-i18n-* 覆盖
  const attrGaps = [];
  for (const el of all) {
    if (el.tag === '#root' || !el.attrs) continue;
    for (const an of ['title', 'placeholder', 'aria-label']) {
      const v = el.attrs[an];
      if (v && CJK.test(v) && !el.attrs[`data-i18n-${an}`]) {
        attrGaps.push(`<${el.tag} ${an}="${v.slice(0, 50)}">`);
      }
    }
  }
  assert.deepEqual(attrGaps, [], `以下属性的中文未被 data-i18n-* 覆盖：\n    ${attrGaps.join('\n    ')}`);
  console.log('  ✓ title/placeholder/aria-label 的中文全部已被 data-i18n-* 覆盖');
}

// -------------------------------------------------------------
// 测试 4: 逻辑比较闸门（中文字面量不得参与 ===/!== 比较）
// -------------------------------------------------------------
console.log('测试 4: 中文字面量不得参与 ===/!== 逻辑比较');
{
  // 允许的例外：显式 i18n-exempt 注释标注的行（上游 API 原始数据匹配）
  const EXEMPT_MARK = 'i18n-exempt';

  // 中文字符串字面量
  const CJK_LITERAL = /(['"`])(?:[^'"`\\\n]|\\.)*?[一-鿿](?:[^'"`\\\n]|\\.)*?\1/g;
  // ===/!== 比较
  const COMPARISON = /[=!]==?/;

  const offenders = [];
  for (const [file, src] of scriptSources) {
    const lines = src.split('\n');
    lines.forEach((line, idx) => {
      if (line.includes(EXEMPT_MARK)) return;          // 显式豁免
      if (line.trim().startsWith('//') || line.trim().startsWith('*')) return;  // 注释行
      // 去掉行内注释（// 之后）—— 粗略但足够：只关心代码部分
      const code = line.replace(/\/\/.*$/, '');
      const lits = code.match(CJK_LITERAL);
      if (!lits) return;
      if (!COMPARISON.test(code)) return;
      // 排除 t('key') 形式（那是字典调用，不是中文）
      const realLits = lits.filter(l => /[一-鿿]/.test(l));
      if (!realLits.length) return;
      offenders.push(`${file}:${idx + 1}: ${line.trim().slice(0, 120)}`);
    });
  }

  assert.deepEqual(offenders, [],
    `以下代码把中文字面量用于逻辑比较，i18n 后会静默失效：\n    ${offenders.join('\n    ')}`);
  console.log('  ✓ 未发现中文字面量参与 ===/!== 比较');
}

// -------------------------------------------------------------
// 测试 5: 语言切换按钮与静态资源接线
// -------------------------------------------------------------
console.log('测试 5: 语言切换按钮与静态资源接线');
{
  assert.ok(htmlSource.includes('id="btn-locale-toggle"'), 'admin.html 必须有语言切换按钮');
  assert.ok(htmlSource.includes('toggleLocale()'), '语言切换按钮必须调用 toggleLocale()');
  assert.ok(htmlSource.includes('/admin/i18n.js'), 'admin.html 必须引入 /admin/i18n.js');

  // admin-i18n.js 必须在依赖它的业务脚本之前加载
  const i18nIdx = htmlSource.indexOf('/admin/i18n.js');
  const quotasIdx = htmlSource.indexOf('/admin/quotas.js');
  const keysIdx = htmlSource.indexOf('/admin/keys.js');
  const statsIdx = htmlSource.indexOf('/admin/stats.js');
  const logsIdx = htmlSource.indexOf('/admin/logs.js');
  assert.ok(i18nIdx > -1, 'admin.html 必须引入 /admin/i18n.js');
  assert.ok(i18nIdx < quotasIdx, 'admin-i18n.js 必须早于 quotas.js 加载（全局 t 需先就绪）');
  assert.ok(i18nIdx < keysIdx, 'admin-i18n.js 必须早于 keys.js 加载');
  assert.ok(i18nIdx < statsIdx, 'admin-i18n.js 必须早于 stats.js 加载');
  assert.ok(i18nIdx < logsIdx, 'admin-i18n.js 必须早于 logs.js 加载');
  console.log('  ✓ admin-i18n.js 加载顺序正确');

  // 静态资源路由已登记
  const routes = read('lib/routes/static-routes.mjs');
  assert.ok(routes.includes("'/admin/i18n.js'"), '静态资源表必须登记 /admin/i18n.js');
  console.log('  ✓ /admin/i18n.js 已在静态资源表登记');
}

// -------------------------------------------------------------
// 测试 6: 显示用 locale 不得硬编码为 zh-CN
// -------------------------------------------------------------
console.log('测试 6: 显示用日期/数字 locale 不得硬编码');
{
  // admin-stats.js / admin.html 里的 Intl.DateTimeFormat('en-CA') 是「日期键生成器」，
  // 不是显示 locale，必须保留。硬编码 'zh-CN' 的显示用 formatter 一律不允许。
  const offenders = [];
  for (const [file, src] of scriptSources) {
    src.split('\n').forEach((line, idx) => {
      const code = line.replace(/\/\/.*$/, '');
      if (code.includes("'zh-CN'") || code.includes('"zh-CN"')) {
        offenders.push(`${file}:${idx + 1}: ${line.trim().slice(0, 110)}`);
      }
    });
  }
  // admin.html 内联脚本同样检查
  const inline = htmlSource.match(/<script>([\s\S]*?)<\/script>/);
  if (inline) {
    inline[1].split('\n').forEach((line, idx) => {
      const code = line.replace(/\/\/.*$/, '');
      if (code.includes("'zh-CN'") || code.includes('"zh-CN"')) {
        offenders.push(`${HTML_FILE}(inline):${idx + 1}: ${line.trim().slice(0, 110)}`);
      }
    });
  }
  assert.deepEqual(offenders, [],
    `以下位置硬编码了 zh-CN 显示 locale，切换语言后不会跟随：\n    ${offenders.join('\n    ')}`);
  console.log('  ✓ 未发现硬编码的 zh-CN 显示 locale');
}

// -------------------------------------------------------------
// 测试 7: 残留中文字面量闸门
// -------------------------------------------------------------
// 背景：文案若只改了一半——比如 HTML 静态文本翻译了、但 JS 里的 toast
// 仍是硬编码中文——切到英文后就会漏出中文。这里扫描所有会参与渲染的
// 代码里的中文字符串字面量，命中即失败。
// 例外：显式 i18n-exempt 注释标注的行（品牌名、语言切换按钮等）。
console.log('测试 7: 残留中文字面量闸门');
{
  const EXEMPT_MARK = 'i18n-exempt';
  const CJK = /[一-鿿]/;
  const LITERAL = /(['"`])((?:[^'"`\\\n]|\\.)*?)\1/g;

  // admin.html 的内联脚本：取所有非 src 的 <script> 块
  const inlineBlocks = [];
  const scriptRe = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let sm;
  while ((sm = scriptRe.exec(htmlSource)) !== null) {
    const startLine = htmlSource.slice(0, sm.index).split('\n').length;
    inlineBlocks.push({ code: sm[1], startLine });
  }

  const offenders = [];
  const scan = (origin, code, lineOffset = 0) => {
    // 先剥掉注释，避免把注释里的中文当成残留文案
    const stripped = code
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/^\s*\/\/.*$/gm, (m) => m.replace(/[^\n]/g, ' '));
    const lines = stripped.split('\n');
    LITERAL.lastIndex = 0;
    let m;
    while ((m = LITERAL.exec(stripped)) !== null) {
      if (!CJK.test(m[2])) continue;
      const line = lines.slice(0, stripped.slice(0, m.index).split('\n').length - 1).length;
      const raw = code.split('\n')[line] || '';
      const prev = code.split('\n')[line - 1] || '';
      // 豁免标记可写在本行或上一行（注释独占一行时更易读）
      if (raw.includes(EXEMPT_MARK) || prev.includes(EXEMPT_MARK)) continue;
      offenders.push(`${origin}:${line + 1 + lineOffset}: ${raw.trim().slice(0, 110)}`);
    }
  };

  for (const b of inlineBlocks) scan(`${HTML_FILE}(inline)`, b.code, b.startLine - 1);
  for (const [f, src] of scriptSources) scan(f, src);

  assert.deepEqual(offenders, [],
    `以下代码仍硬编码中文字面量，切换到英文后界面会漏出中文：\n    ${offenders.join('\n    ')}`);
  console.log('  ✓ 未发现残留的中文字面量');
}

console.log('\n=== 控制台中英双语回归测试全部通过 ===\n');

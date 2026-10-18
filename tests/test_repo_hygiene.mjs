// 仓库卫生回归测试：防止真实上游凭据被写进测试夹具或文档。
//
// 背景：v2.9.58 的 OpenCode 测试用例把一组真实 OpenRouter Key 当成样例数据写进了
// tests/test_opencode_quota_and_deleted_separation.mjs，并在 v2.10.0 准备推送公开仓库时
// 被 GitHub Push Protection 拦下。测试只需要「OpenAI 形态的字符串」来验证掩码逻辑，
// 完全不需要真实 Key。
//
// 本用例扫描所有被 Git 跟踪的文本文件，命中真实凭据形态即失败。
// 允许占位值：全 0 / 全 x / 明显示例串，避免把夹具误判成泄漏。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function listTrackedFiles() {
  try {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
    return out.split('\0').filter(Boolean);
  } catch {
    // 非 Git 环境（例如 npm 包解压后的目录）退化为目录遍历
    const skip = new Set(['node_modules', '.git', 'data', '_scratch', '_local', '.aoci']);
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (skip.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else files.push(path.relative(root, full));
      }
    };
    walk(root);
    return files;
  }
}

// 真实凭据形态：前缀 + 足够长的随机体。夹具请用全 0 或全 x 的占位串。
const SECRET_PATTERNS = [
  { name: 'OpenRouter', re: /sk-or-v1-[0-9a-f]{40,}/g },
  { name: 'Anthropic', re: /sk-ant-(?:api\d{2}-)?[A-Za-z0-9_-]{40,}/g },
  { name: 'OpenAI project', re: /sk-proj-[A-Za-z0-9_-]{40,}/g },
  { name: 'OpenAI classic', re: /sk-[A-Za-z0-9]{48,}/g },
  { name: 'Google API key', re: /AIza[0-9A-Za-z_-]{35}/g },
  { name: 'GitHub token', re: /gh[pousr]_[A-Za-z0-9]{36,}/g },
  { name: 'Slack token', re: /xox[baprs]-[A-Za-z0-9-]{20,}/g },
  { name: 'Private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g }
];

// 明显占位串直接放行（全 0、全 x、全 a，或整体由 1-4 个字符的重复片段构成）
function isPlaceholder(match) {
  // 取前缀之后的随机体：sk-or-v1-xxxx / sk-proj-xxxx / gh p_xxxx 等前缀都含连字符或下划线
  const body = match.split(/[-_]/).pop() || '';
  if (!body) return false;
  if (/^(0+|x+|a+|X+|A+)$/.test(body)) return true;
  const unit = body.slice(0, 2);
  return unit.length === 2 && body === unit.repeat(body.length / unit.length);
}

console.log('=== 开始执行仓库凭据卫生检查 ===\n');

const files = listTrackedFiles();
console.log(`测试 1: 扫描 ${files.length} 个被 Git 跟踪的文件`);
const findings = [];
for (const rel of files) {
  const full = path.join(root, rel);
  let stat;
  try { stat = fs.statSync(full); } catch { continue; }
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue;

  let text;
  try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
  // 跳过二进制内容（含 NUL 的按文本读会带替换字符）
  if (text.includes('\u0000')) continue;

  for (const { name, re } of SECRET_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (isPlaceholder(m[0])) continue;
      findings.push({ file: rel, type: name, sample: `${m[0].slice(0, 12)}…(${m[0].length} chars)` });
    }
  }
}

if (findings.length > 0) {
  for (const f of findings) console.error(`  ✗ ${f.file} 疑似 ${f.type} 凭据：${f.sample}`);
}
assert.equal(
  findings.length,
  0,
  `被跟踪文件里发现 ${findings.length} 处疑似真实凭据。请改成全 0 / 全 x 占位串，并轮换已泄漏的 Key。`
);
console.log(`  ✓ ${files.length} 个文件未发现真实凭据形态`);

console.log('\n=== 仓库凭据卫生检查通过！===');

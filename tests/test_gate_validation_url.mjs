import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { extractValidationUrl, isActionableValidationUrl, completeGoogleValidationUrl, STANDARD_GEMINI_CONTINUE_URL } from '../validation-url.mjs';

const expected = 'https://accounts.google.com/signin/continue?plt=abc&flow=def';
assert.equal(extractValidationUrl({ error: { details: [{ metadata: { validation_url: expected } }] } }), expected);
assert.equal(extractValidationUrl(JSON.stringify({ error: { message: `VALIDATION_REQUIRED: ${expected}` } })), expected);
assert.equal(extractValidationUrl('VALIDATION_REQUIRED https://accounts.google.com/signin/continue?plt=abc&amp;flow=def'), expected);
assert.equal(extractValidationUrl({ validation_url: 'https://accounts.google.com/v3/signin/challenge?continue=abc' }), 'https://accounts.google.com/v3/signin/challenge?continue=abc');
assert.equal(extractValidationUrl('VALIDATION_REQUIRED https://accounts.google.com/signin/continue?plt=abc\\u0026flow=def'), expected);
assert.equal(extractValidationUrl('VALIDATION_REQUIRED https:\\/\\/accounts.google.com\\/signin\\/continue?plt=abc\\u0026flow=def'), expected);
assert.equal(extractValidationUrl('https://evil.example/signin/continue?redirect=https://accounts.google.com/signin/continue'), null);
assert.equal(extractValidationUrl('http://accounts.google.com/signin/continue?plt=abc'), null);
const issueUrl = 'https://accounts.google.com/signin/continue?sarp=1&scc=1&continue=https://developers.google.com/gemini-code-assist/auth/auth_success_gemini&plt=test-token&flowName=GlifWebSignIn&authuser';
assert.equal(extractValidationUrl({ error: { details: [{ metadata: { validation_url: issueUrl } }] } }), issueUrl);
assert.equal(isActionableValidationUrl(issueUrl), true);
assert.equal(isActionableValidationUrl('https://accounts.google.com/signin/continue?plt=short-token'), false);
assert.equal(extractValidationUrl({ error: { details: [
  { metadata: { validation_url: 'https://accounts.google.com/signin/continue?plt=short-token' } },
  { links: [{ url: issueUrl }] }
] } }), issueUrl);
assert.equal(extractValidationUrl({ validation_url: `${issueUrl}.` }), `${issueUrl}.`);

// 测试智能补全缺少 continue 的 Google 验证链接
const completed = completeGoogleValidationUrl('https://accounts.google.com/signin/continue?plt=sample_token', 'user@gmail.com');
assert.equal(isActionableValidationUrl(completed), true);
const compUrl = new URL(completed);
assert.equal(compUrl.searchParams.get('continue'), STANDARD_GEMINI_CONTINUE_URL);
assert.equal(compUrl.searchParams.get('plt'), 'sample_token');
assert.equal(compUrl.searchParams.get('authuser'), 'user@gmail.com');
assert.equal(compUrl.searchParams.get('sarp'), '1');
assert.equal(compUrl.searchParams.get('flowName'), 'GlifWebSignIn');

const admin = readFileSync(new URL('../admin.html', import.meta.url), 'utf8');
const safeLinkCode = admin.slice(admin.indexOf('function safeGoogleLink('), admin.indexOf('function copyToClipboard('));
const safeLink = vm.runInNewContext(`${safeLinkCode}\nsafeGoogleLink`, { URL, escapeHtml: value => value });
assert.equal(safeLink('https://accounts.google.com/signin/continue?plt=short-token'), '');
assert.equal(safeLink(issueUrl), issueUrl);
console.log('validation URL extraction passed');

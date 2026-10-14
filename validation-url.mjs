// CPA may embed the Google URL in JSON metadata, a JSON-encoded error string, or plain text.
// Reference: GitHub Issue #4272 & #1729 (router-for-me/CLIProxyAPI)
const GOOGLE_HOST = 'accounts.google.com';
export const STANDARD_GEMINI_CONTINUE_URL = 'https://developers.google.com/gemini-code-assist/auth/auth_success_gemini';

export function normalizeValidationUrl(candidate, fromProse = false) {
  if (typeof candidate !== 'string') return null;
  let value = candidate.trim()
    .replace(/&amp;/gi, '&')
    .replace(/\\u(0026|003d|003f|0025)/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\\//g, '/');
  if (fromProse) value = value.replace(/[),.;\]}>]+$/g, '');
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== GOOGLE_HOST) return null;
    return url.href;
  } catch {
    return null;
  }
}

// A signin/continue URL without its destination cannot complete the Google flow.
export function isActionableValidationUrl(value) {
  const normalized = normalizeValidationUrl(value);
  if (!normalized) return false;
  const url = new URL(normalized);
  return url.pathname !== '/signin/continue' ||
    (Boolean(url.searchParams.get('plt')) && Boolean(url.searchParams.get('continue')));
}

// 智能补全缺少标准回调的 Google signin/continue 链接（对齐 Issue 4272 官方行为）
export function completeGoogleValidationUrl(value, accountEmail = null) {
  const normalized = normalizeValidationUrl(value);
  if (!normalized) return null;
  try {
    const url = new URL(normalized);
    if (url.pathname === '/signin/continue') {
      if (!url.searchParams.has('sarp')) url.searchParams.set('sarp', '1');
      if (!url.searchParams.has('scc')) url.searchParams.set('scc', '1');
      if (!url.searchParams.has('continue')) {
        url.searchParams.set('continue', STANDARD_GEMINI_CONTINUE_URL);
      }
      if (!url.searchParams.has('flowName')) {
        url.searchParams.set('flowName', 'GlifWebSignIn');
      }
    }
    if (accountEmail && typeof accountEmail === 'string' && accountEmail.includes('@')) {
      url.searchParams.set('authuser', accountEmail.trim());
    }
    return url.href;
  } catch {
    return normalized;
  }
}

export function extractValidationUrl(input) {
  const seen = new Set();
  const candidates = [];

  function visit(value, depth = 0) {
    if (depth > 8 || value == null) return;
    if (typeof value === 'string') {
      const direct = normalizeValidationUrl(value);
      if (direct) { candidates.push(direct); return; }
      if (/^https?:\/\//i.test(value.trim())) return;
      if (seen.has(value)) return;
      seen.add(value);
      try {
        const parsed = JSON.parse(value);
        if (parsed !== value) visit(parsed, depth + 1);
      } catch {}
      // Unescape first before regex matching
      const cleaned = value
        .replace(/&amp;/gi, '&')
        .replace(/\\u(0026|003d|003f|0025)/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/\\\//g, '/');
      const matches = cleaned.matchAll(/https:\/\/accounts\.google\.com\/[^\s"'<>]+/gi);
      for (const match of matches) {
        const found = normalizeValidationUrl(match[0], true);
        if (found) candidates.push(found);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value === 'object') {
      // Prioritize known validation keys
      for (const key of ['validation_url', 'validationUrl', 'url', 'metadata', 'error', 'details', 'links', 'message']) {
        if (key in value) visit(value[key], depth + 1);
      }
      for (const item of Object.values(value)) visit(item, depth + 1);
    }
  }

  visit(input);
  return candidates.find(isActionableValidationUrl) || candidates[0] || null;
}

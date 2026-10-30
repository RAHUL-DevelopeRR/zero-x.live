// Test-only network guard for check-e2e-local.mjs, preloaded into the gateway process with
// `node --import ./e2e-upstream-shim.mjs server.js`. It never ships: server.js does not import it.
//
// - Upstream calls to Groq and Gemini that carry a fake key (Bearer e2e-...), and Claude calls
//   to api.anthropic.com with a fake x-api-key (e2e-...), are sent to the fake server at
//   E2E_UPSTREAM_BASE (loopback only), keeping the path.
// - With E2E_LIVE=true, calls with any other key go to the real upstream and are counted (host
//   name only, never the key) in E2E_REAL_CALLS_FILE; without it they are refused.
// - Every other non-loopback destination is refused, so a run can never reach another service.
import { appendFileSync } from 'node:fs';

const UPSTREAM_HOSTS = new Set(['api.groq.com', 'generativelanguage.googleapis.com']);
const CLAUDE_HOST = 'api.anthropic.com';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const base = new URL(process.env.E2E_UPSTREAM_BASE || 'http://invalid.invalid');
if (!LOOPBACK.has(base.hostname) || base.protocol !== 'http:') {
  throw new Error('e2e-upstream-shim: E2E_UPSTREAM_BASE must be a loopback http URL');
}
const live = process.env.E2E_LIVE === 'true';
const original = globalThis.fetch;

function header(input, init, name) {
  const headers = init?.headers ?? (input instanceof Request ? input.headers : null);
  if (!headers) return '';
  if (typeof headers.get === 'function') return headers.get(name) || '';
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return entry ? String(entry[1]) : '';
}
const authorization = (input, init) => header(input, init, 'authorization');

globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (LOOPBACK.has(url.hostname)) return original(input, init);
  // Claude is never called for real by this check, even with --live.
  if (url.hostname === CLAUDE_HOST && header(input, init, 'x-api-key').startsWith('e2e-')) {
    return original(new URL(url.pathname + url.search, base), init);
  }
  if (UPSTREAM_HOSTS.has(url.hostname)) {
    if (authorization(input, init).startsWith('Bearer e2e-')) {
      return original(new URL(url.pathname + url.search, base), init);
    }
    if (live) {
      if (process.env.E2E_REAL_CALLS_FILE) appendFileSync(process.env.E2E_REAL_CALLS_FILE, `${url.hostname}\n`);
      return original(input, init);
    }
  }
  throw new TypeError(`e2e-upstream-shim: outbound request to ${url.hostname} is not allowed`);
};

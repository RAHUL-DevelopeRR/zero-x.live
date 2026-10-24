// Test-only network guard for check-e2e-local.mjs, preloaded into the gateway process with
// `node --import ./e2e-upstream-shim.mjs server.js`. It never ships: server.js does not import it.
//
// - Upstream calls to Groq and Gemini that carry a fake key (Bearer e2e-...) are sent to the
//   fake OpenAI-compatible server at E2E_UPSTREAM_BASE (loopback only), keeping the path.
// - With E2E_LIVE=true, calls with any other key go to the real upstream and are counted (host
//   name only, never the key) in E2E_REAL_CALLS_FILE; without it they are refused.
// - Every other non-loopback destination is refused, so a run can never reach another service.
import { appendFileSync } from 'node:fs';

const UPSTREAM_HOSTS = new Set(['api.groq.com', 'generativelanguage.googleapis.com']);
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const base = new URL(process.env.E2E_UPSTREAM_BASE || 'http://invalid.invalid');
if (!LOOPBACK.has(base.hostname) || base.protocol !== 'http:') {
  throw new Error('e2e-upstream-shim: E2E_UPSTREAM_BASE must be a loopback http URL');
}
const live = process.env.E2E_LIVE === 'true';
const original = globalThis.fetch;

function authorization(input, init) {
  const headers = init?.headers ?? (input instanceof Request ? input.headers : null);
  if (!headers) return '';
  if (typeof headers.get === 'function') return headers.get('authorization') || '';
  const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === 'authorization');
  return entry ? String(entry[1]) : '';
}

globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (LOOPBACK.has(url.hostname)) return original(input, init);
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

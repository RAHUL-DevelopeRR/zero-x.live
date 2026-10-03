import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const cookies = new Map();
let rejectedWrites = 0;
const document = {
  currentScript: { src: 'https://www.zero-x.live/zerox-auth.js' },
  createElement: () => ({}), head: { appendChild() {} },
  get cookie() { return [...cookies].map(([key, value]) => `${key}=${value}`).join('; '); },
  set cookie(value) {
    if (Buffer.byteLength(value) > 4096) { rejectedWrites++; return; }
    const [pair] = value.split(';');
    const separator = pair.indexOf('=');
    const key = pair.slice(0, separator);
    if (value.includes('Max-Age=0')) cookies.delete(key);
    else cookies.set(key, pair.slice(separator + 1));
  },
};
let storage;
const window = {
  location: { hostname: 'www.zero-x.live', protocol: 'https:' },
  supabase: { createClient(_url, _key, options) {
    storage = options.auth.storage;
    return { auth: { onAuthStateChange() {}, getSession: async () => ({ data: { session: null } }) } };
  } },
};
vm.runInNewContext(readFileSync(new URL('../../zerox-auth.js', import.meta.url), 'utf8'), {
  document, window, URL, console,
  fetch: async () => ({ ok: true, json: async () => ({ configured: true, providers: [] }) }),
});
await window.ZeroXAuth.init();
for (const value of ['a'.repeat(12000), JSON.stringify({ profile: '"% & 😀'.repeat(1500) })]) {
  storage.setItem('zerox-supabase-auth', value);
  assert.equal(rejectedWrites, 0, 'Browser must not reject oversized session cookies');
  assert.equal(storage.getItem('zerox-supabase-auth'), value);
  storage.removeItem('zerox-supabase-auth');
  assert.equal(storage.getItem('zerox-supabase-auth'), null);
  assert.equal(cookies.size, 0);
}
console.log('PASS: encoded session cookie limits, Unicode round-trip, replacement and sign-out cleanup');

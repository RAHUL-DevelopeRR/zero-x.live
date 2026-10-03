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
const oauthRequests = [];
const window = {
  location: { hostname: 'www.zero-x.live', protocol: 'https:', origin: 'https://www.zero-x.live', pathname: '/neuron.html' },
  supabase: { createClient(_url, _key, options) {
    storage = options.auth.storage;
    return { auth: {
      onAuthStateChange() {}, getSession: async () => ({ data: { session: null } }),
      signInWithOAuth: async request => { oauthRequests.push(request); return {}; },
    } };
  } },
};
const source = readFileSync(new URL('../../zerox-auth.js', import.meta.url), 'utf8');
vm.runInNewContext(source.replace('window.ZeroXAuth = {', 'window.ZeroXAuth = { signInWithOAuth, runAuthAction,'), {
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
for (const provider of ['google', 'github', 'azure']) await window.ZeroXAuth.signInWithOAuth(provider);
assert.equal(oauthRequests[0].options.queryParams.prompt, 'select_account');
assert.equal(oauthRequests[0].options.redirectTo, 'https://www.zero-x.live/neuron.html');
assert.equal(oauthRequests[1].options.queryParams, undefined);
assert.equal(oauthRequests[2].options.scopes, 'email');
const icon = {}, text = {};
const button = {
  childNodes: [icon, text], disabled: false,
  set textContent(_value) { this.childNodes = []; },
  replaceChildren(...nodes) { this.childNodes = nodes; },
};
for (const fail of [false, true]) {
  await window.ZeroXAuth.runAuthAction(button, async () => {
    assert.equal(button.disabled, true);
    if (fail) throw new Error('Cancelled');
  });
  assert.deepEqual(button.childNodes, [icon, text]);
  assert.equal(button.disabled, false);
}
console.log('PASS: session cookie limits and cleanup, Google chooser, provider options, and logo restoration after success/failure');

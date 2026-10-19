// Device sign-in approval page (neuroncli/device/device.js) in a fake DOM: no approval
// without a click, Approve held for 1.5 s, the code leaves the address bar, the nonce is
// sent back, and a signed-out visitor is sent to sign in with the code kept.
//   node check-device-page.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../device/device.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../device/index.html', import.meta.url), 'utf8');
const drain = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };

const LOOKUP = {
  grant_id: '0b2f1c9e-0000-4000-8000-000000000001', user_code: 'BDWP-HQPK', account: { email: 'owner@example.com' },
  client: { name: 'neuron-cli', version: '7.0.0', device_name: 'laptop', os: 'windows' },
  requester: { ip: '203.0.113.7', country: 'IN', region: 'TN', city: 'Chennai', network: 'Example ISP' },
  browser_country: 'IN', created_at: new Date(Date.now() - 30_000).toISOString(),
  expires_at: new Date(Date.now() + 570_000).toISOString(), approval_nonce: '123.signature',
};

async function run({ search = '?user_code=bdwp-hqpk', signedIn = true, lookup = LOOKUP } = {}) {
  const elements = new Map();
  const el = id => {
    if (!elements.has(id)) {
      elements.set(id, { id, textContent: '', hidden: true, disabled: false, value: '', listeners: {},
        addEventListener(event, fn) { this.listeners[event] = fn; }, focus() {} });
    }
    return elements.get(id);
  };
  const calls = [];
  const timers = [];
  let replaced = null;
  let redirect = null;
  const context = vm.createContext({
    URL, URLSearchParams, AbortSignal, Date, console, Math, JSON, String, Object, Number,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    location: { search, origin: 'https://neuron.zero-x.live', pathname: '/device', hash: '' },
    history: { replaceState(_state, _title, value) { replaced = value; } },
    document: { getElementById: el },
    window: { ZeroXAuth: {
      async init() {}, async getProfile() { return signedIn ? { email: 'owner@example.com' } : null; },
      async getAccessToken() { return 'identity-token'; }, onAuthStateChange() {},
      async openAuthModal(options) { redirect = options.redirectTo; },
    } },
    fetch: async (path, options) => {
      calls.push({ path, body: JSON.parse(options.body), headers: options.headers, credentials: options.credentials });
      assert.equal(options.headers.Authorization, 'Bearer identity-token');
      const body = path === '/auth/device/lookup' ? lookup : { status: calls.at(-1).body.decision === 'approve' ? 'approved' : 'denied' };
      return new Response(JSON.stringify(body), { status: 200 });
    },
  });
  vm.runInContext(source, context);
  await drain();
  return { el, calls, timers, get replaced() { return replaced; }, get redirect() { return redirect; } };
}

// Signed in with a prefilled code: looked up, shown, nothing approved without a click.
const app = await run();
assert.equal(app.replaced, '/device', 'the code leaves the address bar');
assert.deepEqual(app.calls.map(call => call.path), ['/auth/device/lookup']);
assert.equal(app.calls[0].body.user_code, 'BDWPHQPK');
assert.equal(app.calls[0].credentials, 'omit', 'no cookie authenticates the API calls');
assert.equal(app.el('confirm-step').hidden, false);
assert.equal(app.el('confirm-code').textContent, 'BDWP-HQPK');
assert.match(app.el('device').textContent, /laptop · windows · neuron-cli 7\.0\.0 \(reported by the device\)/);
assert.match(app.el('location').textContent, /Chennai, TN, IN · 203\.0\.113\.7/);
assert.equal(app.el('mismatch').hidden, true);
assert.equal(app.el('approve').disabled, true, 'Approve is held after the details appear');
assert.equal(app.timers.at(-1).ms, 1500);
app.timers.at(-1).fn();
assert.equal(app.el('approve').disabled, false);
await app.el('approve').listeners.click();
await drain();
assert.deepEqual(app.calls.at(-1).body, { grant_id: LOOKUP.grant_id, approval_nonce: '123.signature', decision: 'approve' });
assert.match(app.el('done').textContent, /Approved/);

// Another country: a visible warning. Deny sends a deny.
const far = await run({ lookup: { ...LOOKUP, requester: { ...LOOKUP.requester, country: 'RU' } } });
assert.equal(far.el('mismatch').hidden, false);
assert.match(far.el('mismatch').textContent, /different country \(RU\).*\(IN\)/);
await far.el('deny').listeners.click();
await drain();
assert.equal(far.calls.at(-1).body.decision, 'deny');
assert.match(far.el('done').textContent, /Denied/);

// No code in the URL: the form is shown and nothing is looked up until it is submitted.
const typed = await run({ search: '' });
assert.equal(typed.calls.length, 0);
assert.equal(typed.el('code-step').hidden, false);
typed.el('code').value = 'bdwp hqpk';
typed.el('code').listeners.input();
assert.equal(typed.el('code').value, 'BDWP-HQPK');
await typed.el('code-step').listeners.submit({ preventDefault() {} });
await drain();
assert.equal(typed.calls[0].body.user_code, 'BDWPHQPK');

// Signed out: sign in first, coming back to the same code.
const signedOut = await run({ signedIn: false });
assert.equal(signedOut.calls.length, 0);
assert.equal(signedOut.el('signin-step').hidden, false);
await signedOut.el('signin').listeners.click();
assert.equal(signedOut.redirect, 'https://neuron.zero-x.live/device?user_code=BDWP-HQPK');

assert.match(html, /<meta name="referrer" content="no-referrer">/);
assert.ok(!/<script>(?!<\/script>)/.test(html.replace(/<script[^>]*src=[^>]*><\/script>/g, '')), 'no inline script');
console.log('PASS: device approval page: explicit approve/deny, 1.5 s hold, code removed from URL, nonce returned, country warning, sign-in keeps the code');

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

async function run({ search = '?user_code=bdwp-hqpk', signedIn = true, lookup = LOOKUP, decideFails = false } = {}) {
  const elements = new Map();
  const el = id => {
    if (!elements.has(id)) {
      elements.set(id, { id, textContent: '', hidden: id !== 'card', disabled: false, value: '', listeners: {},
        addEventListener(event, fn) { this.listeners[event] = fn; }, focus() { focused.push(id); } });
    }
    return elements.get(id);
  };
  const calls = [];
  const focused = [];
  const timers = [];
  let replaced = null;
  let redirect = null;
  let signOut = null;
  const context = vm.createContext({
    URL, URLSearchParams, AbortSignal, Date, console, Math, JSON, String, Object, Number,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    location: { search, origin: 'https://neuron.zero-x.live', pathname: '/device', hash: '' },
    history: { replaceState(_state, _title, value) { replaced = value; } },
    document: { getElementById: el, title: 'Sign in to Neuron | Zero-X' },
    window: { ZeroXAuth: {
      async init() {}, async getProfile() { return signedIn ? { email: 'owner@example.com' } : null; },
      async getAccessToken() { return 'identity-token'; }, onAuthStateChange() {},
      async openAuthModal(options) { redirect = options.redirectTo; },
      async signOut(options) { signOut = options; },
    } },
    fetch: async (path, options) => {
      calls.push({ path, body: JSON.parse(options.body), headers: options.headers, credentials: options.credentials });
      assert.equal(options.headers.Authorization, 'Bearer identity-token');
      if (decideFails && path === '/auth/device/approve') return new Response(JSON.stringify({ error: { message: 'This code expired.' } }), { status: 410 });
      const body = path === '/auth/device/lookup' ? lookup : { status: calls.at(-1).body.decision === 'approve' ? 'approved' : 'denied' };
      return new Response(JSON.stringify(body), { status: 200 });
    },
  });
  vm.runInContext(source, context);
  await drain();
  return { el, calls, timers, focused, document: context.document, get replaced() { return replaced; }, get redirect() { return redirect; },
    get signOut() { return signOut; } };
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
assert.equal(app.el('switch').hidden, false, 'a signed-in visitor can switch accounts');
assert.equal(app.el('approve').disabled, true, 'Approve is held after the details appear');
assert.equal(app.timers.at(-1).ms, 1500);
app.timers.at(-1).fn();
assert.equal(app.el('approve').disabled, false);
await app.el('approve').listeners.click();
await drain();
assert.deepEqual(app.calls.at(-1).body, { grant_id: LOOKUP.grant_id, approval_nonce: '123.signature', decision: 'approve' });
// The full-page result screen replaces the card, is announced and takes focus.
assert.equal(app.el('card').hidden, true, 'the card is hidden once decided');
assert.equal(app.el('result').hidden, false, 'the result screen is shown');
assert.equal(app.el('result-title').textContent, 'Neuron is signed in');
assert.equal(app.el('result-line').textContent, 'You can close this tab and return to your terminal.');
assert.equal(app.el('result-detail').textContent, 'Signed in as owner@example.com');
assert.equal(app.focused.at(-1), 'result-title', 'focus moves to the headline so it is read out');
assert.equal(app.document.title, 'Neuron is signed in | Zero-X');
assert.equal(app.el('switch').hidden, true, 'no account switch once decided');

// Wrong account: sign this browser out only and come back to the same code, deciding nothing.
const other = await run();
await other.el('switch').listeners.click();
await drain();
assert.deepEqual({ ...other.signOut }, { scope: 'local', redirectUrl: 'https://neuron.zero-x.live/device?user_code=BDWP-HQPK' });
assert.deepEqual(other.calls.map(call => call.path), ['/auth/device/lookup'], 'switching neither approves nor denies');

// Another country: a visible warning. Deny sends a deny.
const far = await run({ lookup: { ...LOOKUP, requester: { ...LOOKUP.requester, country: 'RU' } } });
assert.equal(far.el('mismatch').hidden, false);
assert.match(far.el('mismatch').textContent, /different country \(RU\).*\(IN\)/);
await far.el('deny').listeners.click();
await drain();
assert.equal(far.calls.at(-1).body.decision, 'deny');
assert.equal(far.el('card').hidden, true);
assert.equal(far.el('result').hidden, false);
assert.equal(far.el('result-title').textContent, 'Sign-in denied');
assert.equal(far.el('result-line').textContent, 'Nothing was signed in. You can close this tab.');
assert.equal(far.el('result-detail').textContent, '', 'no account line after a deny');
assert.equal(far.focused.at(-1), 'result-title');

// A failed decision keeps the card and says why: no result screen.
const failing = await run({ decideFails: true });
failing.timers.at(-1).fn();
await failing.el('approve').listeners.click();
await drain();
assert.equal(failing.el('message').textContent, 'This code expired.');
assert.equal(failing.el('result').hidden, true, 'no result screen when the decision failed');
assert.notEqual(failing.el('card').hidden, true, 'the card stays');


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
assert.equal(signedOut.el('switch').hidden, true);
await signedOut.el('signin').listeners.click();
assert.equal(signedOut.redirect, 'https://neuron.zero-x.live/device?user_code=BDWP-HQPK');

assert.match(html, /<meta name="referrer" content="no-referrer">/);
// The result screen markup: hidden until decided, Zero-X mark, focusable headline that carries the
// line and detail (aria-describedby). No live region: the focus move announces the result.
const result = html.match(/<section[^>]*id="result"[^>]*>[\s\S]*?<\/section>/)?.[0] || '';
assert.ok(result, 'the page has a result screen');
assert.match(result, /class="ap-result"/);
assert.match(result, / hidden>/);
assert.doesNotMatch(result, /role="status"|aria-live/, 'no live region that enters the tree already filled');
assert.match(result, /src="\/Assets\/zerox-mark\.svg"/);
assert.match(result, /<h1 id="result-title" class="ap-result-title" tabindex="-1" aria-describedby="result-line result-detail">/);
assert.match(html, /<div class="ap-card" id="card">/);
assert.doesNotMatch(source, /innerHTML/, 'text goes in with textContent only');
const css = readFileSync(new URL('../../auth-pages.css', import.meta.url), 'utf8');
for (const rule of ['.ap-result ', '.ap-result-mark', '.ap-result-title', '.ap-result-line', '.ap-result-detail']) assert.ok(css.includes(rule), 'auth-pages.css styles ' + rule.trim());
assert.ok(!/<script>(?!<\/script>)/.test(html.replace(/<script[^>]*src=[^>]*><\/script>/g, '')), 'no inline script');
console.log('PASS: device approval page: explicit approve/deny, full-page result screen (focused headline described by its line and detail, textContent only), 1.5 s hold, code removed from URL, nonce returned, country warning, sign-in keeps the code, switch account signs out locally');

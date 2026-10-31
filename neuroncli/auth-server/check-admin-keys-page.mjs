// Provider key vault page (neuroncli/admin/keys/keys.js) in a fake DOM: the admin token stays in
// memory, every API call carries it and nothing else authenticates, labels are text (never
// markup), the key field is emptied as the key is sent, Disable asks first, a refused token
// locks the page again. Plus the HTML: no inline script or style, forms that cannot submit.
//   node check-admin-keys-page.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../admin/keys/keys.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../admin/keys/index.html', import.meta.url), 'utf8');
const drain = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
const TOKEN = 'operator-token-'.padEnd(40, 'x');

const LIST = {
  vault_configured: true, access_configured: true,
  providers: [
    { provider: 'groq', active_keys: 1, max_keys: 20, env_key: { variable: 'GROQ_API_KEY', last4: 'aaaa', fallback: true, duplicate_of: null } },
    { provider: 'gemini', active_keys: 1, max_keys: 20, env_key: { variable: 'GEMINI_API_KEY', last4: 'bbbb', fallback: false, duplicate_of: 'k2' } },
    { provider: 'nvidia', active_keys: 0, max_keys: 20, env_key: null },
  ],
  keys: [
    { id: 'k1', provider: 'groq', label: '<img src=x onerror=alert(1)>', last4: 'wxyz', status: 'active',
      created_at: '2026-10-19T10:00:00Z', disabled_at: null, last_used_at: null,
      health: { pools: 3, available: 1, degraded: 0, busy: 0, blurred: 2 } },
    { id: 'k2', provider: 'gemini', label: 'gemini-project-2', last4: 'bbbb', status: 'active',
      created_at: '2026-10-19T10:00:00Z', disabled_at: null, last_used_at: '2026-10-19T11:00:00Z',
      health: { pools: 3, available: 3, degraded: 0, busy: 0, blurred: 0 } },
    { id: 'k0', provider: 'groq', label: 'old', last4: 'old1', status: 'disabled',
      created_at: '2026-10-18T10:00:00Z', disabled_at: '2026-10-19T09:00:00Z', last_used_at: null, health: null },
  ],
};

function element(tag, id) {
  return {
    tag, id, textContent: '', className: '', hidden: tag !== 'main' && ['vault', 'empty'].includes(id), disabled: false,
    value: '', type: '', children: [], listeners: {},
    addEventListener(event, fn) { this.listeners[event] = fn; },
    appendChild(child) { this.children.push(child); return child; },
    replaceChildren() { this.children = []; },
    focus() {},
    get innerHTML() { throw new Error('innerHTML is never read or written'); },
    set innerHTML(_) { throw new Error('innerHTML is never read or written'); },
  };
}

async function run({ respond, confirmAnswer = true } = {}) {
  const elements = new Map();
  const el = id => {
    if (!elements.has(id)) elements.set(id, element('div', id));
    return elements.get(id);
  };
  el('provider').value = 'groq';
  const calls = [];
  const context = vm.createContext({
    console, JSON, Object, String, Number, Date, AbortSignal, encodeURIComponent,
    document: { getElementById: el, createElement: tag => element(tag) },
    window: { confirm: () => confirmAnswer },
    fetch: async (path, options) => {
      calls.push({ path, method: options.method, headers: options.headers, body: options.body, credentials: options.credentials,
        cache: options.cache });
      const [status, body] = respond(path, options);
      return { ok: status < 300, status, json: async () => body };
    },
  });
  vm.runInContext(source, context);
  return { el, calls };
}

const rows = page => page.el('keys').children;
const text = node => node.textContent + node.children.map(text).join('');

// Unlock: the token goes in a header, the field is emptied, labels stay text.
let list = structuredClone(LIST);
const page = await run({ respond: (path, options) => {
  if (options.method === 'GET') return [200, list];
  if (options.method === 'POST') return [201, { key: { id: 'k3', provider: 'groq', label: 'groq-org-b', last4: '9999', status: 'active' } }];
  if (options.method === 'DELETE') return [200, { key: { ...LIST.keys[0], status: 'disabled' } }];
  return [404, null];
} });
assert.equal(page.calls.length, 0, 'nothing is fetched before the token is entered');
page.el('admin-token').value = TOKEN;
await page.el('unlock').listeners.submit({ preventDefault() {} });
await drain();
assert.equal(page.el('admin-token').value, '', 'the token leaves the input');
assert.equal(page.calls[0].path, '/admin/providers/keys');
assert.equal(page.calls[0].headers.Authorization, `Bearer ${TOKEN}`);
assert.equal(page.calls[0].cache, 'no-store');
assert.equal(page.el('vault').hidden, false);
assert.equal(page.el('unlock').hidden, true);
assert.equal(rows(page).length, 3);
assert.equal(rows(page)[0].children[1].textContent, '<img src=x onerror=alert(1)>', 'a label is text, never markup');
assert.equal(rows(page)[0].children[2].textContent, '••••wxyz');
assert.match(text(rows(page)[0].children[4]), /1 of 3 serving/);
assert.match(text(rows(page)[1].children[4]), /3 serving/);
assert.equal(rows(page)[2].children[7].children.length, 0, 'a disabled key has no Disable button');
const fallback = page.el('fallback').children.map(item => item.textContent);
assert.match(fallback[0], /Groq: GROQ_API_KEY ••••aaaa serves after the vault keys \(1 of 20/);
assert.match(fallback[1], /also in the vault/);
assert.match(fallback[2], /NVIDIA: no Worker secret/);
assert.equal(page.el('message').textContent, '', 'Access verified: no warning');

// Add: the key field is emptied as the key is sent; the label is kept until it succeeds.
page.el('label').value = 'groq-org-b';
page.el('key').value = '  gsk_new_key_value_1234567899999  ';
await page.el('add').listeners.submit({ preventDefault() {} });
await drain();
const post = page.calls.find(call => call.method === 'POST');
assert.deepEqual(JSON.parse(post.body), { provider: 'groq', label: 'groq-org-b', key: 'gsk_new_key_value_1234567899999' });
assert.equal(post.headers['Content-Type'], 'application/json');
assert.equal(post.headers.Authorization, `Bearer ${TOKEN}`);
assert.equal(page.el('key').value, '', 'the key does not stay in the page');
assert.equal(page.el('label').value, '');
assert.match(page.el('message').textContent, /Saved groq-org-b \(••••9999\)/);
assert.equal(page.calls.at(-1).method, 'GET', 'the list is reloaded');

// Disable asks first, then sends DELETE for that id.
await rows(page)[0].children[7].children[0].listeners.click();
await drain();
const removal = page.calls.find(call => call.method === 'DELETE');
assert.equal(removal.path, '/admin/providers/keys/k1');
assert.match(page.el('message').textContent, /Disabled/);

const cautious = await run({ confirmAnswer: false, respond: () => [200, structuredClone(LIST)] });
cautious.el('admin-token').value = TOKEN;
await cautious.el('unlock').listeners.submit({ preventDefault() {} });
await drain();
await rows(cautious)[0].children[7].children[0].listeners.click();
await drain();
assert.ok(!cautious.calls.some(call => call.method === 'DELETE'), 'no DELETE without confirmation');

// A rejected key shows the gateway's message; a refused token locks the page again.
const strict = await run({ respond: (path, options) => options.method === 'POST'
  ? [422, { error: { code: 'invalid_provider_key', message: 'groq rejected this key (HTTP 401). Nothing was saved.' } }]
  : [200, { ...structuredClone(LIST), access_configured: false }] });
strict.el('admin-token').value = TOKEN;
await strict.el('unlock').listeners.submit({ preventDefault() {} });
await drain();
assert.match(strict.el('message').textContent, /does not verify Cloudflare Access/, 'missing Access is pointed out');
strict.el('key').value = 'gsk_rejected_key_000000000000';
strict.el('label').value = 'bad';
await strict.el('add').listeners.submit({ preventDefault() {} });
await drain();
assert.match(strict.el('message').textContent, /rejected this key/);
assert.equal(strict.el('key').value, '');

const refused = await run({ respond: () => [401, { error: { code: 'invalid_session', message: 'Operator authentication required.' } }] });
refused.el('admin-token').value = 'wrong-token'.padEnd(40, 'y');
await refused.el('unlock').listeners.submit({ preventDefault() {} });
await drain();
assert.equal(refused.el('vault').hidden, true);
assert.equal(refused.el('unlock').hidden, false);
assert.match(refused.el('message').textContent, /not accepted/);

// The HTML: scripts and styles only from files, forms that cannot submit anywhere.
assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'no inline script');
assert.ok(!/<style\b/i.test(html) && !/\sstyle=/i.test(html), 'no inline style');
assert.ok(!/\son[a-z]+=/i.test(html), 'no inline event handlers');
assert.match(html, /<script defer src="\/admin\/keys\/keys\.js"><\/script>/);
assert.match(html, /<link rel="stylesheet" href="\/admin\/keys\/keys\.css">/);
assert.match(html, /<meta name="referrer" content="no-referrer">/);
assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
for (const form of html.match(/<form[^>]*>/g)) {
  assert.match(form, /method="post"/, 'a form never puts the key in a URL');
  assert.ok(!/action=/.test(form));
}
assert.match(html, /id="key"[^>]*type="password"[^>]*autocomplete="off"/);
assert.match(html, /id="admin-token"[^>]*type="password"/);
console.log('PASS: provider key page: token in memory and headers only, labels as text, key field emptied on send, confirmed disable, 401 locks, no inline script or style');

// Browser behaviour of the account dashboard, pricing checkout, Neuron CLI page script and the
// zerox-auth.js dev identity, exercised against the real HTML through a small DOM emulation.
// The emulated DOM throws whenever untrusted code assigns innerHTML (strict mode).
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
// Site scripts load as ES modules whatever package.json lies above the checkout.
import './site-modules.mjs';

const root = new URL('../../', import.meta.url);
const read = file => readFileSync(new URL(file, root), 'utf8');

/* ───────────── Minimal DOM ───────────── */

const VOID = new Set(['area','base','br','col','embed','hr','img','input','link','meta','source','track','wbr']);
const ENTITIES = {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ',middot:'·',rarr:'→',hellip:'…',mdash:'—',ndash:'–',copy:'©',times:'×',minus:'−'};
const decode = text => text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e] ?? m);

function makeEvent(type, init = {}) {
  return {type, bubbles: !!init.bubbles, cancelable: !!init.cancelable, defaultPrevented: false, cancelBubble: false, key: init.key, target: null,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.cancelBubble = true; }};
}

class Node {
  constructor(doc) { this.ownerDocument = doc; this.parentNode = null; this.childNodes = []; }
  get firstChild() { return this.childNodes[0] || null; }
  get children() { return this.childNodes.filter(n => n.nodeType === 1); }
  appendChild(node) { if (node.parentNode) node.parentNode.removeChild(node); node.parentNode = this; this.childNodes.push(node); return node; }
  append(...nodes) { for (const n of nodes) this.appendChild(typeof n === 'string' ? this.ownerDocument.createTextNode(n) : n); }
  prepend(...nodes) { for (const n of nodes.reverse()) this.insertBefore(typeof n === 'string' ? this.ownerDocument.createTextNode(n) : n, this.firstChild); }
  removeChild(node) { const i = this.childNodes.indexOf(node); if (i >= 0) { this.childNodes.splice(i, 1); node.parentNode = null; } return node; }
  insertBefore(node, ref) {
    if (!ref) return this.appendChild(node);
    if (node.parentNode) node.parentNode.removeChild(node);
    this.childNodes.splice(this.childNodes.indexOf(ref), 0, node); node.parentNode = this; return node;
  }
  replaceChildren(...nodes) { for (const c of [...this.childNodes]) this.removeChild(c); this.append(...nodes); }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  get textContent() { return this.childNodes.map(c => c.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); if (value !== '' && value != null) this.appendChild(this.ownerDocument.createTextNode(String(value))); }
}

class Text extends Node {
  constructor(doc, data) { super(doc); this.nodeType = 3; this.data = String(data); }
  get textContent() { return this.data; }
  set textContent(value) { this.data = String(value); }
}

const kebab = name => name.replace(/[A-Z]/g, c => '-' + c.toLowerCase());

class Element extends Node {
  constructor(doc, tag, ns) {
    super(doc); this.nodeType = 1; this.localName = tag.toLowerCase(); this.tagName = tag.toUpperCase(); this.namespaceURI = ns || 'http://www.w3.org/1999/xhtml';
    this.attributes = new Map(); this.listeners = {}; this.style = {};
  }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  hasAttribute(name) { return this.attributes.has(name); }
  toggleAttribute(name, force) { const on = force ?? !this.hasAttribute(name); if (on) this.setAttribute(name, ''); else this.removeAttribute(name); return on; }
  get id() { return this.getAttribute('id') || ''; } set id(v) { this.setAttribute('id', v); }
  get className() { return this.getAttribute('class') || ''; } set className(v) { this.setAttribute('class', v); }
  get classList() { const el = this; const list = () => el.className.split(/\s+/).filter(Boolean);
    return {contains: c => list().includes(c), add: (...c) => { el.className = [...new Set([...list(), ...c])].join(' '); }, remove: (...c) => { el.className = list().filter(x => !c.includes(x)).join(' '); }}; }
  get hidden() { return this.hasAttribute('hidden'); } set hidden(v) { this.toggleAttribute('hidden', !!v); }
  get disabled() { return this.hasAttribute('disabled'); } set disabled(v) { this.toggleAttribute('disabled', !!v); }
  get open() { return this.hasAttribute('open'); }
  get href() { return this.getAttribute('href') || ''; } set href(v) { this.setAttribute('href', v); }
  get src() { return this.getAttribute('src') || ''; } set src(v) { this.setAttribute('src', v); }
  get type() { return this.getAttribute('type') || ''; } set type(v) { this.setAttribute('type', v); }
  get name() { return this.getAttribute('name') || ''; } set name(v) { this.setAttribute('name', v); }
  get value() {
    if (this._value !== undefined) return this._value;
    if (this.localName === 'select') { const options = this.querySelectorAll('option'); const o = options.find(x => x.hasAttribute('selected')) || options[0]; return o ? o.getAttribute('value') ?? o.textContent : ''; }
    return this.getAttribute('value') ?? '';
  }
  set value(v) { this._value = String(v); }
  get dataset() {
    const el = this;
    return new Proxy({}, {get: (_, prop) => el.getAttribute('data-' + kebab(String(prop))) ?? undefined, set: (_, prop, v) => { el.setAttribute('data-' + kebab(String(prop)), v); return true; }});
  }
  set innerHTML(html) {
    if (this.ownerDocument.strict) throw new Error('innerHTML assignment is not allowed: ' + String(html).slice(0, 80));
    this.replaceChildren(); parseInto(this, String(html), this.ownerDocument);
  }
  get innerHTML() { throw new Error('innerHTML read is not supported by the test DOM'); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter(f => f !== fn); }
  dispatchEvent(event) {
    event.target ||= this;
    for (let node = this; node; node = node.parentNode) {
      event.currentTarget = node;
      for (const fn of [...(node.listeners?.[event.type] || [])]) fn.call(node, event);
      if (typeof node['on' + event.type] === 'function') node['on' + event.type](event);
      if (!event.bubbles || event.cancelBubble) break;
    }
    return !event.defaultPrevented;
  }
  click() {
    if (this.disabled) return;
    const event = makeEvent('click', {bubbles: true, cancelable: true});
    this.dispatchEvent(event);
    if (event.defaultPrevented) return;
    if (this.localName === 'button' && (this.getAttribute('type') || 'submit') === 'submit') {
      const form = this.closest('form');
      if (form) form.dispatchEvent(makeEvent('submit', {bubbles: true, cancelable: true}));
    }
  }
  focus() { this.ownerDocument.activeElement = this; }
  showModal() { this.setAttribute('open', ''); }
  close() { if (this.open) { this.removeAttribute('open'); this.dispatchEvent(makeEvent('close')); } }
  matches(selector) { return matchesSelector(this, selector); }
  closest(selector) { for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (matchesSelector(n, selector)) return n; return null; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) { const out = []; walk(this, n => { if (n !== this && n.nodeType === 1 && matchesSelector(n, selector)) out.push(n); }); return out; }
}

function walk(node, fn) { for (const child of node.childNodes) { fn(child); walk(child, fn); } }

function matchCompound(el, compound) {
  const m = compound.match(/^([a-zA-Z][\w-]*|\*)?((?:#[\w-]+|\.[\w-]+|\[[^\]]+\])*)$/);
  if (!m) throw new Error('Unsupported selector: ' + compound);
  if (m[1] && m[1] !== '*' && el.localName !== m[1].toLowerCase()) return false;
  for (const part of m[2].match(/#[\w-]+|\.[\w-]+|\[[^\]]+\]/g) || []) {
    if (part[0] === '#' && el.getAttribute('id') !== part.slice(1)) return false;
    if (part[0] === '.' && !el.classList.contains(part.slice(1))) return false;
    if (part[0] === '[') {
      const a = part.slice(1, -1).match(/^([\w:-]+)(?:=["']?([^"']*)["']?)?$/);
      if (!el.hasAttribute(a[1]) || (a[2] !== undefined && el.getAttribute(a[1]) !== a[2])) return false;
    }
  }
  return true;
}

function matchesSelector(el, selector) {
  return selector.split(',').some(group => {
    const parts = group.trim().split(/\s+/);
    if (!matchCompound(el, parts.at(-1))) return false;
    let node = el.parentNode;
    for (let i = parts.length - 2; i >= 0; i--) {
      while (node && node.nodeType === 1 && !matchCompound(node, parts[i])) node = node.parentNode;
      if (!node || node.nodeType !== 1) return false;
      node = node.parentNode;
    }
    return true;
  });
}

class Document extends Node {
  constructor({strict = true} = {}) { super(null); this.ownerDocument = this; this.strict = strict; this.activeElement = null; this.listeners = {}; this.nodeType = 9; }
  createElement(tag) { return new Element(this, tag); }
  createElementNS(ns, tag) { return new Element(this, tag, ns); }
  createTextNode(text) { return new Text(this, text); }
  getElementById(id) { let found = null; walk(this, n => { if (!found && n.nodeType === 1 && n.getAttribute('id') === id) found = n; }); return found; }
  querySelector(selector) { return Element.prototype.querySelector.call(this, selector); }
  querySelectorAll(selector) { return Element.prototype.querySelectorAll.call(this, selector); }
  get head() { return this.querySelector('head'); }
  get body() { return this.querySelector('body'); }
  get documentElement() { return this.querySelector('html'); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
}

function parseInto(parent, html, doc) {
  const stack = [parent];
  const token = /<!--[\s\S]*?-->|<![^>]*>|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|[^<]+|</g;
  let match;
  while ((match = token.exec(html))) {
    const [text, close, open, attrs, selfClose] = match;
    const top = stack.at(-1);
    if (close) {
      const index = stack.map(n => n.localName).lastIndexOf(close.toLowerCase());
      if (index > 0) stack.length = index;
    } else if (open) {
      const el = doc.createElement(open);
      for (const a of (attrs || '').matchAll(/([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) el.setAttribute(a[1], decode(a[2] ?? a[3] ?? a[4] ?? ''));
      top.appendChild(el);
      const tag = el.localName;
      if (tag === 'script' || tag === 'style' || tag === 'textarea') {
        const end = html.toLowerCase().indexOf('</' + tag, token.lastIndex);
        el.appendChild(doc.createTextNode(html.slice(token.lastIndex, end)));
        token.lastIndex = html.indexOf('>', end) + 1;
      } else if (!VOID.has(tag) && !selfClose) stack.push(el);
    } else if (!text.startsWith('<!')) {
      top.appendChild(doc.createTextNode(decode(text)));
    }
  }
}

function parseDocument(html, options) { const doc = new Document(options); parseInto(doc, html, doc); return doc; }

/* ───────────── Test doubles ───────────── */

const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)); };
const json = (status, data, headers = {}) => new Response(JSON.stringify(data), {status, headers: {'Content-Type': 'application/json', ...headers}});
const apiError = (status, code, message, extra = {}) => json(status, {error: {message, type: 'invalid_request_error', code, param: null, request_id: 'req_test', ...extra}});

function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {map, getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: k => map.delete(k)};
}

function makeFetch(routes) {
  const calls = [];
  const fetchImpl = async (path, options = {}) => {
    const method = options.method || 'GET';
    const call = {method, path, body: options.body ? JSON.parse(options.body) : undefined, headers: options.headers || {}};
    calls.push(call);
    const base = path.split('?')[0];
    const handler = routes[method + ' ' + base] ?? Object.entries(routes).find(([key]) => key.endsWith('*') && (method + ' ' + base).startsWith(key.slice(0, -1)))?.[1];
    if (handler === undefined) return apiError(404, 'not_found', 'No route ' + method + ' ' + path);
    const result = typeof handler === 'function' ? await handler(call) : handler;
    return result instanceof Response ? result : json(200, result);
  };
  return {fetchImpl, calls};
}

function makeAuth(profile, token = 'sb-access-token') {
  const callbacks = [];
  const auth = {profile, calls: {modal: [], signOut: []},
    async init() {}, async getUser() { return auth.profile ? {id: 'user'} : null; }, async getProfile() { return auth.profile; },
    async getAccessToken() { return auth.profile ? token : ''; }, onAuthStateChange(fn) { callbacks.push(fn); },
    async openAuthModal(options) { auth.calls.modal.push(options); }, async signOut(options) { auth.calls.signOut.push(options); },
    emit(event) { callbacks.forEach(fn => fn({event})); }};
  return auth;
}

function makeWindow({hostname = 'dashboard.zero-x.live', hash = '', auth, session = makeStorage(), local = makeStorage()} = {}) {
  const listeners = {};
  const fire = type => (listeners[type] || []).forEach(fn => fn({type}));
  const location = {hostname, origin: 'https://' + hostname, pathname: '/', assigned: null, reloads: 0, _hash: hash,
    get hash() { return this._hash; },
    set hash(value) { const next = value.startsWith('#') ? value : '#' + value; if (next !== this._hash) { this._hash = next; queueMicrotask(() => fire('hashchange')); } },
    assign(url) { this.assigned = url; }, reload() { this.reloads++; }};
  const win = {location, ZeroXAuth: auth, sessionStorage: session, localStorage: local, copied: null,
    navigator: {clipboard: {writeText: async value => { win.copied = value; }}},
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); }, fire};
  return win;
}

class FakeRazorpay {
  static instances = [];
  constructor(options) { this.options = options; this.events = {}; FakeRazorpay.instances.push(this); }
  on(event, fn) { this.events[event] = fn; }
  open() { this.opened = true; }
}

/* ───────────── Fixtures (contract §3.4–3.5 shapes) ───────────── */

const NOW = Date.parse('2026-10-16T18:00:00Z');
const XSS = '<img src=x onerror=alert(1)>';
const PROFILE = {id: 'u1', email: 'owner@example.com', fullName: XSS, firstName: 'Owner', imageUrl: 'javascript:alert(1)', providersDisplay: 'Google'};
const SECRET = 'nzx_' + 'A1b2C3d4'.repeat(5);
const accountPayload = (overrides = {}) => ({
  user: {id: '7f9c2a7e-0000-4000-8000-000000000001', email: 'owner@example.com', name: XSS, image_url: 'javascript:alert(1)'},
  plan: {id: 'pro', name: 'Pro'}, limits: {daily_requests: 2000, daily_tokens: 10000000, rpm: 30, concurrency: 4},
  usage_today: {requests: 1900, tokens: 2500000, resets_at: '2026-10-17T00:00:00.000Z'},
  credits: {balance_usd: 7.4213, monthly_grant_usd: 8},
  subscription: {status: 'active', current_period_end: '2026-11-01T00:00:00Z', cancel_at_period_end: false}, flags: {suspended: false}, ...overrides,
});
const plansPayload = {currency_default: 'USD', plans: [
  {id: 'free', name: 'Free', price: {usd_cents: 0, inr_paise: 0}, interval: 'month', limits: {daily_requests: 100, daily_tokens: 500000, rpm: 10, concurrency: 2}, monthly_credit_usd: 0, tiers: ['free'], features: ['Shared pools', XSS], highlighted: false},
  {id: 'pro', name: 'Pro', price: {usd_cents: 1000, inr_paise: 89900}, interval: 'month', limits: {daily_requests: 2000, daily_tokens: 10000000, rpm: 30, concurrency: 4}, monthly_credit_usd: 8, tiers: ['free', 'paid'], features: [], highlighted: true},
  {id: 'max', name: 'Max', price: {usd_cents: 4000, inr_paise: 349900}, interval: 'month', limits: {daily_requests: 10000, daily_tokens: 50000000, rpm: 60, concurrency: 8}, monthly_credit_usd: 35, tiers: ['free', 'paid'], features: [], highlighted: false},
  {id: 'ultrawork', name: 'Pro (legacy)', price: {usd_cents: 1000, inr_paise: 89900}, interval: 'month', limits: {}, monthly_credit_usd: 8, tiers: ['free', 'paid'], features: [], highlighted: false},
], topups: [{id: 'credits_5', credit_usd: 5, price: {usd_cents: 500, inr_paise: 44900}}, {id: 'credits_20', credit_usd: 20, price: {usd_cents: 2000, inr_paise: 174900}}]};

function dashboardRoutes(state) {
  return {
    'GET /api/account': () => state.account(),
    'GET /api/usage': {from: '2026-09-17', to: '2026-10-16', series: [
      {day: '2026-10-01', requests: 12, prompt_tokens: 9000, completion_tokens: 1000, cost_usd: 0.01},
      {day: '2026-10-16', requests: 40, prompt_tokens: 30000, completion_tokens: 4000, cost_usd: 0.02}],
    by_model: [{model: '<b>groq/openai/gpt-oss-120b</b>', requests: 52, prompt_tokens: 39000, completion_tokens: 5000, cost_usd: 0.03}],
    totals: {requests: 52, prompt_tokens: 39000, completion_tokens: 5000, cost_usd: 0.03}},
    'GET /api/usage/events': call => call.path.includes('before=123')
      ? {events: [{id: 100, created_at: '2026-10-15T09:00:00Z', model: 'gemini/gemini-2.5-flash', provider: 'gemini', tier: 'free', status: 'ok', prompt_tokens: 10, completion_tokens: 5, cost_usd: 0, latency_ms: 800, request_id: 'req_old'}], next_before: null}
      : {events: [{id: 124, created_at: '2026-10-16T17:00:00Z', model: XSS, provider: 'groq', tier: 'paid', status: 'error', prompt_tokens: 100, completion_tokens: 20, cost_usd: 0.0012, latency_ms: 1200, request_id: 'req_new'}], next_before: 123},
    'GET /api/keys': () => ({keys: state.keys}),
    'POST /api/keys': call => { state.keys.unshift({id: 'k-new', name: call.body.name, prefix: 'nzx_A1b2', created_at: '2026-10-16T18:00:00Z', last_used_at: null, revoked_at: null}); return json(201, {key: state.keys[0], secret: SECRET}); },
    'DELETE /api/keys/*': call => { const id = call.path.split('/').pop(); state.keys = state.keys.map(k => k.id === id ? {...k, revoked_at: '2026-10-16T18:01:00Z'} : k); return {status: 'revoked'}; },
    'GET /api/billing': () => ({provider_configured: true, subscription: {id: 'sub_TEST12345', plan: 'pro', status: 'active', current_period_end: '2026-11-01T00:00:00Z', cancel_at_period_end: state.cancelled, provider: 'razorpay'},
      payments: [{id: 'pay_1', kind: 'subscription', amount_minor: 89900, currency: 'INR', status: 'captured', created_at: '2026-10-01T10:00:00Z', invoice_url: 'https://rzp.io/i/abc'},
        {id: 'pay_2', kind: 'topup', amount_minor: 500, currency: 'USD', status: 'failed', created_at: '2026-10-02T10:00:00Z', invoice_url: 'javascript:alert(1)'}]}),
    'GET /api/plans': plansPayload,
    'POST /api/billing/cancel': () => { state.cancelled = true; return {status: 'cancel_scheduled', current_period_end: '2026-11-01T00:00:00Z'}; },
    'POST /api/billing/topup': call => ({provider: 'razorpay', key_id: 'rzp_test_AbCdEf123456', order_id: 'order_TEST123456', amount_minor: call.body.currency === 'INR' ? 44900 : 500, currency: call.body.currency, name: 'Zero-X', description: 'Credits', prefill: {email: 'owner@example.com', name: 'Owner'}}),
    'POST /api/billing/verify': {status: 'ok', account: {}},
    'POST /api/sessions/revoke-all': call => (call.body && call.body.api_keys ? {revoked: 3, api_keys_revoked: 2} : {revoked: 3}),
  };
}

const {createDashboard, TABS} = await import(new URL('dashboard.js', root));
const {createPricingPage, PENDING_CHECKOUT_KEY} = await import(new URL('pricing.js', root));
const {PAYMENT_LOCK_KEY, PAYMENT_LOCK_TTL_MS} = await import(new URL('billing-checkout.js', root));
const DASHBOARD_HTML = read('dashboard.html');

async function mountDashboard({profile = PROFILE, hash = '', state = {}, routes = {}, session, local} = {}) {
  const shared = {keys: [
    {id: 'k-1', name: 'Laptop', prefix: 'nzx_Qw12', created_at: '2026-10-01T00:00:00Z', last_used_at: '2026-10-15T00:00:00Z', revoked_at: null},
    {id: 'k-0', name: 'Old CI', prefix: 'nzx_Zz99', created_at: '2026-09-01T00:00:00Z', last_used_at: null, revoked_at: '2026-09-10T00:00:00Z'}],
  cancelled: false, account: () => accountPayload(), ...state};
  const doc = parseDocument(DASHBOARD_HTML);
  const auth = makeAuth(profile);
  const win = makeWindow({hash, auth, session, ...(local ? {local} : {})});
  win.Razorpay = FakeRazorpay;
  const {fetchImpl, calls} = makeFetch({...dashboardRoutes(shared), ...routes});
  const dashboard = createDashboard({doc, win, auth, fetchImpl, now: () => NOW});
  await dashboard.boot();
  await settle();
  return {doc, win, auth, calls, dashboard, shared, $: id => doc.getElementById(id)};
}

/* ───────────── Dashboard ───────────── */

{
  const {$, auth, calls} = await mountDashboard({profile: null});
  assert.equal($('dash-gate').hidden, false, 'Signed-out visitors see the sign-in gate');
  assert.equal($('dash-app').hidden, true);
  assert.equal(calls.length, 0, 'No API calls without a session');
  $('gate-signin').click();
  await settle();
  assert.equal(auth.calls.modal.length, 1, 'Sign in opens the ZeroXAuth modal');
}

{
  const t = await mountDashboard({session: makeStorage({'zx-dev-token': 'dev_b3duZXJAZXhhbXBsZS5jb20'})});
  const {$, doc, win, calls, auth} = t;
  assert.equal($('dash-app').hidden, false);
  assert.equal($('dash-loading').hidden, true);
  assert.ok(calls.every(call => call.headers.Authorization === 'Bearer sb-access-token'), 'Every API call carries the Supabase bearer token');
  // Overview renders contract data, not hardcoded limits.
  assert.equal($('ov-plan').textContent, 'Pro');
  assert.equal($('ov-requests').textContent, '1,900 / 2,000');
  assert.equal($('ov-requests-bar').getAttribute('aria-valuenow'), '95');
  assert.equal($('ov-requests-bar').getAttribute('data-tone'), 'danger');
  assert.equal($('ov-requests-bar').querySelector('.zx-progress__bar').style.width, '95%');
  assert.equal($('ov-tokens').textContent, '2.5M / 10M');
  assert.equal($('ov-tokens-bar').getAttribute('aria-valuenow'), '25');
  assert.equal($('ov-credits').textContent, '$7.42');
  assert.equal($('ov-reset').textContent, 'Resets in 6 h 0 min');
  assert.equal($('ov-upgrade').hidden, true, 'Paid plans do not see the upgrade CTA');
  assert.match($('ov-plan-detail').textContent, /Active · renews on Nov 1, 2026/);
  // Untrusted strings stay text; unsafe avatar URLs are ignored.
  assert.equal($('acct-name').textContent, XSS);
  assert.equal($('acct-name').querySelectorAll('img').length, 0);
  assert.equal($('acct-avatar').getAttribute('src'), '/Assets/zerox-favicon-centered.png');
  assert.equal($('acct-provider').textContent, 'Google');
  assert.equal($('acct-id').textContent, '7f9c2a7e-0000-4000-8000-000000000001');
  for (const link of doc.querySelectorAll('a[data-site-path]')) assert.match(link.getAttribute('href'), /^https:\/\/zero-x\.live\//);
  // Copy quick-start command.
  doc.querySelector('[data-copy-target="qs-install"]').click();
  await settle();
  assert.equal(win.copied, 'npm install -g @zero-x.live/neuron');

  // Hash routing to Usage.
  win.location.hash = '#usage';
  await settle();
  assert.equal($('panel-usage').hidden, false);
  assert.equal($('panel-overview').hidden, true);
  assert.equal($('tab-usage').getAttribute('aria-selected'), 'true');
  assert.equal($('tab-overview').getAttribute('aria-selected'), 'false');
  assert.equal($('tab-overview').getAttribute('tabindex'), '-1');
  assert.ok(calls.some(call => call.path === '/api/usage'));
  assert.ok(calls.some(call => call.path === '/api/usage/events?limit=25'));
  const chart = $('usage-chart').querySelector('svg');
  assert.equal(chart.getAttribute('role'), 'img');
  assert.equal(chart.querySelectorAll('rect').length, 2, 'Only non-zero days draw bars');
  assert.match(chart.querySelector('desc').textContent, /30 days, Sep 17 to Oct 16, 2026\. Total 52 requests\. Highest: 40 on Oct 16\./);
  assert.match(chart.querySelectorAll('rect')[1].querySelector('title').textContent, /Oct 16: 40 requests/);
  assert.equal(Number(chart.querySelectorAll('rect')[1].getAttribute('height')), 160, 'Bars scale to the nice maximum (40 of 50)');
  assert.equal($('usage-days').querySelectorAll('tr').length, 30, 'Table fallback lists every day');
  assert.equal($('usage-models').querySelector('code').textContent, '<b>groq/openai/gpt-oss-120b</b>');
  assert.equal($('usage-total-requests').textContent, '52');
  assert.equal($('usage-total-cost').textContent, '$0.03');
  doc.querySelector('[data-metric="tokens"]').click();
  assert.equal(doc.querySelector('[data-metric="tokens"]').getAttribute('aria-pressed'), 'true');
  assert.match($('usage-chart-caption').textContent, /^Tokens per day/);
  // Events pagination with next_before cursors.
  assert.equal($('usage-events').querySelector('code').textContent, XSS);
  assert.equal($('events-newer').disabled, true);
  assert.equal($('events-older').disabled, false);
  $('events-older').click();
  await settle();
  assert.ok(calls.some(call => call.path === '/api/usage/events?limit=25&before=123'));
  assert.equal($('events-page').textContent, 'Page 2');
  assert.equal($('events-older').disabled, true);
  assert.equal($('events-newer').disabled, false);
  $('events-newer').click();
  await settle();
  assert.equal($('events-page').textContent, 'Page 1');

  // Keyboard navigation and non-tab fragments.
  $('tab-usage').focus();
  $('dash-tabs').dispatchEvent(makeEvent('keydown', {key: 'ArrowRight', bubbles: true}));
  await settle();
  assert.equal(win.location.hash, '#keys');
  assert.equal(doc.activeElement, $('tab-keys'));
  assert.equal($('panel-keys').hidden, false);
  win.location.hash = '#main';
  await settle();
  assert.equal($('panel-keys').hidden, false, 'The skip-link fragment does not switch tabs');

  // API keys: validation, secret shown once, copy, hide, revoke with confirm.
  const rows = $('keys-list').querySelectorAll('tr');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].querySelectorAll('button').length, 1);
  assert.equal(rows[1].querySelectorAll('button').length, 0, 'Revoked keys cannot be revoked again');
  $('key-create').click();
  await settle();
  assert.match($('key-name-error').textContent, /Enter a name/);
  assert.equal($('key-name').getAttribute('aria-invalid'), 'true');
  assert.ok(!calls.some(call => call.method === 'POST' && call.path === '/api/keys'));
  $('key-name').value = 'CI <script>';
  $('key-create').click();
  await settle();
  assert.deepEqual(calls.find(call => call.method === 'POST' && call.path === '/api/keys').body, {name: 'CI <script>'});
  assert.equal($('key-secret').hidden, false);
  assert.equal($('key-secret-value').textContent, SECRET);
  assert.equal(doc.activeElement, $('key-secret-copy'));
  assert.equal($('keys-list').querySelector('th').textContent, 'CI <script>');
  $('key-secret-copy').click();
  await settle();
  assert.equal(win.copied, SECRET);
  assert.ok(![...win.sessionStorage.map.values(), ...win.localStorage.map.values()].some(v => v.includes(SECRET)), 'Secrets are never persisted');
  $('key-secret-done').click();
  assert.equal($('key-secret').hidden, true);
  assert.equal($('key-secret-value').textContent, '', 'The secret is removed from the page');
  const revoke = () => $('keys-list').querySelector('button[data-key-id="k-1"]');
  revoke().click();
  await settle();
  assert.equal($('confirm-dialog').open, true);
  assert.match($('confirm-body').textContent, /"Laptop" stops working immediately/);
  $('confirm-cancel').click();
  await settle();
  assert.ok(!calls.some(call => call.method === 'DELETE'), 'Cancelling the confirmation keeps the key');
  revoke().click();
  await settle();
  $('confirm-ok').click();
  await settle();
  assert.ok(calls.some(call => call.method === 'DELETE' && call.path === '/api/keys/k-1'));
  assert.equal($('keys-list').querySelector('button[data-key-id="k-1"]'), null);

  // Billing: subscription, payment history, invoice URL validation, cancel, top-up.
  win.location.hash = '#billing';
  await settle();
  assert.equal($('sub-plan').textContent, 'Pro');
  assert.equal($('sub-status').textContent, 'Active');
  assert.equal($('sub-period-label').textContent, 'Renews on');
  assert.equal($('sub-period').textContent, 'Nov 1, 2026');
  assert.equal($('sub-cancel').hidden, false);
  const payments = $('payments-list').querySelectorAll('tr');
  assert.equal(payments.length, 2);
  assert.equal(payments[0].querySelectorAll('td')[1].textContent, '₹899');
  const invoice = payments[0].querySelector('a');
  assert.equal(invoice.getAttribute('href'), 'https://rzp.io/i/abc');
  assert.equal(invoice.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(payments[1].querySelector('a'), null, 'javascript: invoice URLs are never linked');
  assert.equal(payments[1].querySelectorAll('td')[2].textContent, 'Failed');
  const topup5 = doc.querySelector('[data-topup="credits_5"]');
  assert.equal(topup5.textContent, 'Add $5 credit for $5');
  $('topup-currency').value = 'INR';
  $('topup-currency').dispatchEvent(makeEvent('change'));
  assert.equal(topup5.textContent, 'Add $5 credit for ₹449');
  $('sub-cancel').click();
  await settle();
  $('confirm-ok').click();
  await settle();
  assert.ok(calls.some(call => call.method === 'POST' && call.path === '/api/billing/cancel'));
  assert.equal($('billing-status').textContent, 'Cancellation scheduled. You keep your plan until Nov 1, 2026.');
  assert.equal($('sub-status').textContent, 'Cancels at period end');
  assert.equal($('sub-cancel').hidden, true);
  FakeRazorpay.instances.length = 0;
  topup5.click();
  await settle();
  assert.deepEqual(calls.find(call => call.path === '/api/billing/topup').body, {pack: 'credits_5', currency: 'INR'});
  const checkout = FakeRazorpay.instances[0];
  assert.equal(checkout.opened, true);
  assert.equal(checkout.options.key, 'rzp_test_AbCdEf123456');
  assert.equal(checkout.options.order_id, 'order_TEST123456');
  assert.equal(checkout.options.amount, 44900);
  assert.equal(checkout.options.currency, 'INR');
  assert.deepEqual(checkout.options.theme, {color: '#00E5FF'});
  assert.equal(topup5.disabled, true, 'Top-up buttons are disabled while checkout is open');
  checkout.events['payment.failed']({error: {description: 'Card declined'}});
  assert.match($('billing-status').textContent, /Payment failed: Card declined/);
  await checkout.options.handler({razorpay_payment_id: 'pay_TEST1234567', razorpay_order_id: 'order_TEST123456', razorpay_signature: 'ab'.repeat(32), unexpected: 'dropped'});
  await settle();
  assert.deepEqual(calls.find(call => call.path === '/api/billing/verify').body,
    {razorpay_payment_id: 'pay_TEST1234567', razorpay_signature: 'ab'.repeat(32), razorpay_order_id: 'order_TEST123456'});
  assert.equal($('billing-status').textContent, 'Payment confirmed. Credits have been added to your balance.');
  assert.equal(topup5.disabled, false);
  topup5.click();
  await settle();
  FakeRazorpay.instances.at(-1).options.modal.ondismiss();
  await settle();
  assert.equal($('billing-status').textContent, 'Checkout closed. You have not been charged.');
  assert.equal($('billing-error').textContent, '');

  // Sessions.
  win.location.hash = '#sessions';
  await settle();
  $('sessions-revoke').click();
  await settle();
  $('confirm-ok').click();
  await settle();
  assert.ok(calls.some(call => call.method === 'POST' && call.path === '/api/sessions/revoke-all'));
  assert.match($('sessions-status').textContent, /Signed out 3 CLI sessions\./);
  assert.deepEqual(calls.filter(call => call.path === '/api/sessions/revoke-all').at(-1).body, {});
  // Review P3 (integration): revoke-all can also revoke every API key (a leaked session can mint keys).
  $('sessions-keys').checked = true;
  $('sessions-revoke').click();
  await settle();
  assert.match($('confirm-title').textContent, /revoke every API key/);
  $('confirm-ok').click();
  await settle();
  assert.deepEqual(calls.filter(call => call.path === '/api/sessions/revoke-all').at(-1).body, {api_keys: true});
  assert.match($('sessions-status').textContent, /Signed out 3 CLI sessions and revoked 2 API keys\./);

  // Account sign out clears the local dev identity.
  win.location.hash = '#account';
  await settle();
  assert.equal($('panel-account').hidden, false);
  $('acct-signout').click();
  await settle();
  assert.equal(win.sessionStorage.getItem('zx-dev-token'), null, 'Sign out removes zx-dev-token');
  assert.equal(auth.calls.signOut[0].redirectUrl, 'https://zero-x.live/');
  assert.deepEqual(TABS, ['overview', 'usage', 'keys', 'billing', 'sessions', 'account']);
}

{
  // Direct deep link, free plan and suspended account.
  const {$, calls, doc} = await mountDashboard({hash: '#billing', state: {account: () => accountPayload({plan: {id: 'free', name: 'Free'}, subscription: null, credits: {balance_usd: 0, monthly_grant_usd: 0}, flags: {suspended: true}})},
    routes: {'GET /api/billing': {provider_configured: false, subscription: null, payments: []}}});
  assert.equal($('panel-billing').hidden, false);
  assert.equal($('ov-upgrade').hidden, false);
  assert.match($('dash-alert').textContent, /suspended/);
  assert.equal($('billing-notice').hidden, false, 'Unconfigured billing shows the manual-upgrade notice');
  assert.equal($('sub-status').textContent, 'No subscription');
  assert.equal($('sub-cancel').hidden, true);
  assert.equal($('payments-list').textContent, 'No payments yet.');
  assert.ok(calls.some(call => call.path === '/api/billing'));
  // Free accounts cannot buy credits they cannot spend (review B4 P2).
  assert.ok(doc.querySelectorAll('[data-topup]').every(button => button.disabled), 'top-ups are disabled on Free');
  assert.equal($('topup-note').hidden, false);
  assert.match($('topup-note').textContent, /need an active Pro or Max plan/);
  assert.equal($('topup-note').querySelector('a').getAttribute('href'), 'https://zero-x.live/pricing');
  doc.querySelector('[data-topup="credits_5"]').click();
  await settle();
  assert.ok(!calls.some(call => call.path === '/api/billing/topup'), 'no top-up order is created for Free');
}

{
  // Payment IDs are shown (the refund and contact pages ask for them); a scheduled
  // cancellation does not offer plans the checkout would refuse (review B4 P3).
  const {$, win} = await mountDashboard({hash: '#billing', state: {account: () => accountPayload({subscription:
    {status: 'active', current_period_end: '2026-11-01T00:00:00Z', cancel_at_period_end: true}})},
    routes: {'GET /api/billing': {provider_configured: true, subscription: {id: 'sub_TEST12345', plan: 'pro', status: 'active',
      current_period_end: '2026-11-01T00:00:00Z', cancel_at_period_end: true, provider: 'razorpay'},
      payments: [{id: 'pay_TEST1234567', kind: 'subscription', amount_minor: 89900, currency: 'INR', status: 'captured', created_at: '2026-10-01T10:00:00Z', invoice_url: null}]}}});
  const row = $('payments-list').querySelector('tr');
  assert.equal(row.querySelector('code').textContent, 'pay_TEST1234567');
  row.querySelector('button').click();
  await settle();
  assert.equal(win.copied, 'pay_TEST1234567');
  assert.equal($('sub-upgrade').hidden, true, 'no See plans while the cancelled subscription is still live');
  assert.match($('sub-note').textContent, /subscribe again after it ends/);
}

{
  // A verify failure after Razorpay took the payment is terminal: no retry prompt, no sign-in,
  // no second checkout, buttons stay locked (review B4 P2).
  const {$, doc, calls} = await mountDashboard({hash: '#billing', routes: {
    'POST /api/billing/verify': () => { throw new TypeError('network down'); }}});
  FakeRazorpay.instances.length = 0;
  doc.querySelector('[data-topup="credits_5"]').click();
  await settle();
  await FakeRazorpay.instances[0].options.handler({razorpay_payment_id: 'pay_TEST7654321', razorpay_order_id: 'order_TEST123456', razorpay_signature: 'ab'.repeat(32)});
  await settle();
  assert.match($('billing-error').textContent, /could not confirm the payment/);
  assert.match($('billing-error').textContent, /Payment ID: pay_TEST7654321/);
  assert.doesNotMatch($('billing-error').textContent, /try again/i);
  assert.equal($('billing-error').querySelector('button'), null, 'no retry button');
  assert.ok(doc.querySelectorAll('[data-topup]').every(button => button.disabled), 'buttons stay locked');
  doc.querySelector('[data-topup="credits_20"]').click();
  await settle();
  assert.equal(calls.filter(call => call.path === '/api/billing/topup').length, 1, 'no second checkout');
  assert.equal($('dash-gate').hidden, true);
}

{
  // Review P2 (integration): a pending top-up verify is not "Credits added": purchases stay locked,
  // also after a reload, until Billing lists the payment with a final status.
  const storage = makeStorage();
  const {$, doc, calls} = await mountDashboard({hash: '#billing', local: storage, routes: {
    'POST /api/billing/verify': {status: 'pending', account: accountPayload()}}});
  FakeRazorpay.instances.length = 0;
  doc.querySelector('[data-topup="credits_5"]').click();
  await settle();
  await FakeRazorpay.instances[0].options.handler({razorpay_payment_id: 'pay_TOPUPWAIT123', razorpay_order_id: 'order_TEST123456', razorpay_signature: 'ab'.repeat(32)});
  await settle();
  assert.doesNotMatch($('billing-status').textContent, /Credits have been added/);
  assert.match($('billing-error').textContent, /awaiting confirmation from Razorpay/);
  assert.ok(doc.querySelectorAll('[data-topup]').every(button => button.disabled), 'top-ups stay locked');
  assert.equal(JSON.parse(storage.getItem(PAYMENT_LOCK_KEY)).paymentId, 'pay_TOPUPWAIT123');
  doc.querySelector('[data-topup="credits_20"]').click();
  await settle();
  assert.equal(calls.filter(call => call.path === '/api/billing/topup').length, 1, 'no second order');
  const pendingRow = {id: 'pay_TOPUPWAIT123', kind: 'topup', amount_minor: 500, currency: 'USD', status: 'authorized', created_at: '2026-10-16T17:59:00Z', invoice_url: null};
  const billingWith = status => ({provider_configured: true, subscription: {id: 'sub_TEST12345', plan: 'pro', status: 'active',
    current_period_end: '2026-11-01T00:00:00Z', cancel_at_period_end: false, provider: 'razorpay'}, payments: [{...pendingRow, status}]});
  const reloaded = await mountDashboard({hash: '#billing', local: storage, routes: {'GET /api/billing': billingWith('authorized')}});
  assert.ok(reloaded.doc.querySelectorAll('[data-topup]').every(button => button.disabled), 'still locked after a reload');
  assert.match(reloaded.$('billing-status').textContent, /awaiting confirmation/);
  const confirmed = await mountDashboard({hash: '#billing', local: storage, routes: {'GET /api/billing': billingWith('captured')}});
  assert.equal(storage.getItem(PAYMENT_LOCK_KEY), null, 'the lock is cleared once the payment is captured');
  assert.equal(confirmed.doc.querySelector('[data-topup="credits_5"]').disabled, false, 'purchases are offered again');
  assert.equal(confirmed.$('billing-status').textContent, '');
}

{
  // An unpaid checkout ('created') explains itself instead of showing an empty note.
  const {$} = await mountDashboard({hash: '#billing', routes: {'GET /api/billing': {provider_configured: true, subscription: {id: 'sub_TEST12345', plan: 'pro',
    status: 'created', current_period_end: null, cancel_at_period_end: false, provider: 'razorpay'}, payments: []}}});
  assert.equal($('sub-status').textContent, 'Awaiting payment');
  assert.match($('sub-note').textContent, /activates as soon as Razorpay confirms the payment/);
}

{
  // Expired session → gate; server error → inline alert with retry.
  const expired = await mountDashboard({routes: {'GET /api/account': apiError(401, 'invalid_session', 'Session expired. Run neuron auth login.')}});
  assert.equal(expired.$('dash-gate').hidden, false);
  assert.match(expired.$('gate-error').textContent, /sign-in has expired/);
  let failures = 1;
  const flaky = await mountDashboard({routes: {'GET /api/account': () => (failures-- > 0 ? apiError(500, 'server_error', 'Database unavailable') : accountPayload())}});
  assert.match(flaky.$('overview-error').textContent, /Database unavailable/);
  assert.equal(flaky.$('overview-error').querySelector('p').textContent, 'Database unavailable');
  flaky.$('overview-error').querySelector('button').click();
  await settle();
  assert.equal(flaky.$('overview-error').textContent, '');
  assert.equal(flaky.$('ov-plan').textContent, 'Pro');
}

/* ───────────── Pricing checkout ───────────── */

async function mountPricing({profile = null, routes = {}, hostname = 'zero-x.live', local = makeStorage({'zx-currency': 'USD'})} = {}) {
  const doc = parseDocument(read('pricing.html'));
  const auth = makeAuth(profile);
  const win = makeWindow({hostname, auth, local});
  win.Razorpay = FakeRazorpay;
  const {fetchImpl, calls} = makeFetch({
    'GET /api/plans': plansPayload,
    'POST /api/billing/checkout': call => ({provider: 'razorpay', key_id: 'rzp_test_AbCdEf123456', subscription_id: 'sub_TEST12345', name: 'Zero-X', description: call.body.plan + ' plan', prefill: {email: 'owner@example.com', name: 'Owner'}, notes: {plan: call.body.plan, '<bad key>': 'x'}}),
    'POST /api/billing/verify': {status: 'ok', account: {}},
    ...routes,
  });
  const page = createPricingPage({doc, win, auth, fetchImpl, now: () => NOW});
  await page.init();
  await settle();
  return {doc, win, auth, calls, page, $: id => doc.getElementById(id)};
}

{
  const t = await mountPricing();
  const {doc, win, auth, calls, $} = t;
  assert.ok(calls.some(call => call.path === '/api/plans' && !call.headers.Authorization), '/api/plans is fetched anonymously');
  const freeFeatures = doc.querySelector('[data-plan-features="free"]').querySelectorAll('li');
  assert.equal(freeFeatures[1].textContent, XSS, 'API feature strings render as text');
  assert.equal(freeFeatures[1].querySelectorAll('img').length, 0);
  assert.equal(doc.querySelector('[data-plan-features="pro"]').querySelectorAll('li').length, 3, 'Empty API features keep the static list');
  assert.equal(doc.querySelector('[data-currency="USD"]').getAttribute('aria-pressed'), 'true');
  doc.querySelector('[data-currency="INR"]').click();
  assert.equal(doc.querySelector('[data-plan-price="pro"]').textContent, '₹899');
  assert.equal(doc.querySelector('[data-plan-price="max"]').textContent, '₹3,499');
  assert.equal(doc.querySelector('[data-plan-price="pro"][data-price-currency="USD"]').textContent, '$10', 'Fixed-currency comparison cells keep their currency');
  assert.equal(win.localStorage.getItem('zx-currency'), 'INR');
  assert.equal(doc.querySelector('[data-currency-label]').textContent, 'INR');
  // Signed out: open the auth modal and remember the intent.
  doc.querySelector('[data-upgrade="pro"]').click();
  await settle();
  assert.equal(auth.calls.modal.length, 1);
  assert.ok(!calls.some(call => call.path === '/api/billing/checkout'));
  // The intent is kept in localStorage so it survives sign-in reloads and new magic-link tabs (review B4 P2).
  assert.equal(win.sessionStorage.getItem(PENDING_CHECKOUT_KEY), null);
  const pending = JSON.parse(win.localStorage.getItem(PENDING_CHECKOUT_KEY));
  assert.deepEqual({kind: pending.kind, id: pending.id, currency: pending.currency}, {kind: 'plan', id: 'pro', currency: 'INR'});
  // Signing in resumes the checkout, verifies and redirects to billing.
  FakeRazorpay.instances.length = 0;
  auth.profile = PROFILE;
  auth.emit('SIGNED_IN');
  await settle();
  assert.equal(win.localStorage.getItem(PENDING_CHECKOUT_KEY), null, 'removed once Razorpay opens');
  const checkoutCall = calls.find(call => call.path === '/api/billing/checkout');
  assert.deepEqual(checkoutCall.body, {plan: 'pro', currency: 'INR'});
  assert.equal(checkoutCall.headers.Authorization, 'Bearer sb-access-token');
  const rzp = FakeRazorpay.instances[0];
  assert.equal(rzp.options.subscription_id, 'sub_TEST12345');
  assert.equal(rzp.options.order_id, undefined);
  assert.deepEqual(rzp.options.notes, {plan: 'pro'}, 'Unexpected note keys are dropped');
  assert.deepEqual(rzp.options.prefill, {email: 'owner@example.com', name: 'Owner'});
  assert.equal(doc.querySelector('[data-upgrade="max"]').disabled, true, 'Buttons are locked during checkout');
  await rzp.options.handler({razorpay_payment_id: 'pay_TEST1234567', razorpay_subscription_id: 'sub_TEST12345', razorpay_signature: 'cd'.repeat(32)});
  await settle();
  assert.deepEqual(calls.find(call => call.path === '/api/billing/verify').body,
    {razorpay_payment_id: 'pay_TEST1234567', razorpay_signature: 'cd'.repeat(32), razorpay_subscription_id: 'sub_TEST12345'});
  assert.equal(win.location.assigned, 'https://dashboard.zero-x.live/#billing');
  assert.equal($('pricing-error').textContent, '');
}

{
  const subscribed = await mountPricing({profile: PROFILE, routes: {'POST /api/billing/checkout': apiError(409, 'already_subscribed', 'Active subscription exists')}});
  FakeRazorpay.instances.length = 0;
  subscribed.doc.querySelector('[data-upgrade="max"]').click();
  await settle();
  assert.match(subscribed.$('pricing-error').textContent, /already have an active subscription/);
  assert.equal(subscribed.$('pricing-error').querySelector('a').getAttribute('href'), 'https://dashboard.zero-x.live/#billing');
  assert.equal(FakeRazorpay.instances.length, 0);
  assert.equal(subscribed.doc.querySelector('[data-upgrade="max"]').disabled, false);

  const unconfigured = await mountPricing({profile: PROFILE, hostname: '127.0.0.1', routes: {'POST /api/billing/checkout': apiError(503, 'billing_not_configured', 'Billing is not configured')}});
  unconfigured.doc.querySelector('[data-upgrade="pro"]').click();
  await settle();
  assert.match(unconfigured.$('pricing-error').textContent, /Online payments are not enabled yet/);
  assert.equal(unconfigured.$('pricing-error').querySelector('a').getAttribute('href'), 'mailto:support@zero-x.live');

  const local = await mountPricing({profile: PROFILE, hostname: '127.0.0.1'});
  FakeRazorpay.instances.length = 0;
  local.doc.querySelector('[data-upgrade="pro"]').click();
  await settle();
  FakeRazorpay.instances[0].options.modal.ondismiss();
  await settle();
  assert.equal(local.$('pricing-status').textContent, 'Checkout closed. You have not been charged.');
  assert.equal(local.$('pricing-error').textContent, '');
  local.doc.querySelector('[data-upgrade="pro"]').click();
  await settle();
  await FakeRazorpay.instances.at(-1).options.handler({razorpay_payment_id: 'pay_TEST1234567', razorpay_subscription_id: 'sub_TEST12345', razorpay_signature: 'cd'.repeat(32)});
  await settle();
  assert.equal(local.win.location.assigned, '/dashboard#billing', 'Local development stays on the loopback origin');

  const forged = await mountPricing({profile: PROFILE, routes: {'POST /api/billing/checkout': {provider: 'razorpay', key_id: 'javascript:alert(1)', subscription_id: 'sub_TEST12345'}}});
  FakeRazorpay.instances.length = 0;
  forged.doc.querySelector('[data-upgrade="pro"]').click();
  await settle();
  assert.equal(FakeRazorpay.instances.length, 0, 'Malformed checkout payloads never reach Razorpay');
  assert.match(forged.$('pricing-error').textContent, /not enabled yet/);
}

/* ───────────── Neuron CLI page script ───────────── */

for (const scenario of ['live', 'offline']) {
  const html = read('neuron-cli.html');
  const doc = parseDocument(html);
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
  const fetch = async path => {
    assert.equal(path, '/v1/models');
    if (scenario === 'offline') throw new TypeError('offline');
    return json(200, {object: 'list', data: [
      {id: 'auto', object: 'model', owned_by: 'zero-x', display_name: 'Auto', capabilities: {tools: true}, tiers: ['free', 'paid'], available: true},
      {id: 'gemini/gemini-2.5-flash', owned_by: 'gemini', display_name: XSS, context_window: 1048576, capabilities: {tools: true}, tiers: ['free', 'paid'], available: false, unavailable_reason: 'region_unavailable'},
      {id: 'paid/model', owned_by: 'groq', capabilities: {tools: false}, tiers: ['paid'], available: false, unavailable_reason: 'upgrade_required'},
      {id: 42}]});
  };
  vm.runInNewContext(script, {document: doc, fetch, Promise, Array, Math, isFinite, Error, TypeError});
  await settle();
  const tabs = doc.querySelectorAll('[role="tab"]');
  assert.deepEqual(tabs.map(tab => tab.textContent), ['npm', 'pip', 'install.sh', 'install.ps1']);
  assert.equal(doc.getElementById('install-npm').hidden, false);
  assert.equal(doc.getElementById('install-pip').hidden, true);
  tabs[2].click();
  assert.equal(doc.getElementById('install-sh').hidden, false);
  assert.equal(tabs[2].getAttribute('aria-selected'), 'true');
  tabs[2].focus();
  doc.querySelector('[role="tablist"]').dispatchEvent(makeEvent('keydown', {key: 'ArrowRight', bubbles: true}));
  assert.equal(doc.getElementById('install-ps1').hidden, false);
  assert.equal(doc.activeElement, tabs[3]);
  const rows = doc.getElementById('models-body').querySelectorAll('tr');
  if (scenario === 'live') {
    assert.equal(rows.length, 3, 'Invalid catalog entries are skipped');
    assert.equal(rows[1].querySelector('th').textContent, XSS);
    assert.equal(rows[1].querySelectorAll('td')[2].textContent, '1,048,576');
    assert.equal(rows[1].querySelectorAll('td')[4].textContent, 'All plans (not in your region)');
    assert.equal(rows[2].querySelectorAll('td')[4].textContent, 'Pro and Max');
    assert.match(doc.getElementById('models-status').textContent, /Live catalog from the Zero-X gateway: 3 models/);
  } else {
    assert.equal(rows.length, 7, 'The static catalog stays when /v1/models is unreachable');
    assert.match(doc.getElementById('models-status').textContent, /Default catalog shown/);
  }
}

/* ───────────── zerox-auth.js development identity ───────────── */

async function loadAuth({hostname, config, session = makeStorage(), sdk = true}) {
  const doc = parseDocument('<!doctype html><html><head></head><body></body></html>', {strict: false});
  doc.currentScript = {src: 'http://' + hostname + ':8787/zerox-auth.js'};
  const location = {hostname, protocol: 'http:', origin: 'http://' + hostname + ':8787', pathname: '/dashboard', href: 'http://' + hostname + ':8787/dashboard', reloads: 0, assigned: null,
    reload() { this.reloads++; }, assign(url) { this.assigned = url; }};
  const sdkCalls = [];
  const window = {location, sessionStorage: session,
    supabase: sdk ? {createClient(...args) { sdkCalls.push(args); return {auth: {onAuthStateChange() {}, async getSession() { return {data: {session: null}}; }, async getUser() { return {data: {user: null}}; }, async signOut() { return {}; }}}; }} : undefined};
  vm.runInNewContext(read('zerox-auth.js'), {window, document: doc, URL, console, setTimeout, clearTimeout, TextEncoder, TextDecoder, btoa, atob, Uint8Array,
    fetch: async path => { assert.equal(path, '/auth/config'); return json(200, config); }});
  return {auth: window.ZeroXAuth, window, doc, session, sdkCalls};
}

{
  const devConfig = {provider: 'dev', configured: true, dev: true, providers: ['dev']};
  const local = await loadAuth({hostname: '127.0.0.1', config: devConfig});
  await local.auth.init();
  assert.equal(local.auth.isDevMode(), true);
  assert.equal(local.sdkCalls.length, 0, 'Dev mode never creates a Supabase client');
  assert.equal(await local.auth.getAccessToken(), '');
  assert.equal(await local.auth.getProfile(), null);
  await local.auth.openAuthModal({title: 'Sign in'});
  const modal = local.doc.querySelector('[data-zerox-auth-modal="true"]');
  assert.equal(modal.open, true);
  assert.equal(modal.querySelector('[data-auth-dev-wrap="true"]').hidden, false);
  assert.equal(modal.querySelector('[data-auth-email-wrap="true"]').hidden, true);
  assert.equal(modal.querySelector('[data-auth-providers="true"]').childNodes.length, 0, 'No OAuth buttons in dev mode');
  modal.querySelector('#zerox-auth-dev-email').value = 'not-an-email';
  modal.querySelector('[data-auth-dev-wrap="true"]').dispatchEvent(makeEvent('submit', {cancelable: true}));
  await settle();
  assert.match(modal.querySelector('[data-auth-message="true"]').textContent, /valid email/);
  assert.equal(local.session.getItem('zx-dev-token'), null);
  modal.querySelector('#zerox-auth-dev-email').value = ' Dev@Example.com ';
  modal.querySelector('[data-auth-dev-wrap="true"]').dispatchEvent(makeEvent('submit', {cancelable: true}));
  await settle();
  const token = 'dev_' + Buffer.from('dev@example.com').toString('base64url');
  assert.equal(local.session.getItem('zx-dev-token'), token, 'Token is dev_<base64url(email)>');
  assert.equal(local.window.location.reloads, 1);
  assert.equal(await local.auth.getAccessToken(), token);
  assert.equal((await local.auth.getProfile()).email, 'dev@example.com');
  await local.auth.signOut({redirectUrl: '/'});
  assert.equal(local.session.getItem('zx-dev-token'), null, 'signOut clears the dev token');
  assert.equal(await local.auth.getAccessToken(), '');

  const forged = await loadAuth({hostname: '127.0.0.1', config: devConfig, session: makeStorage({'zx-dev-token': 'dev_' + Buffer.from('<script>').toString('base64url')})});
  assert.equal(await forged.auth.getAccessToken(), '');
  assert.equal(forged.session.getItem('zx-dev-token'), null, 'Malformed dev tokens are discarded');

  const publicHost = await loadAuth({hostname: 'zero-x.live', config: devConfig, session: makeStorage({'zx-dev-token': token})});
  await publicHost.auth.init();
  assert.equal(publicHost.auth.isDevMode(), false, 'Public hosts never enter dev mode');
  assert.equal(await publicHost.auth.getAccessToken(), '');

  const supabase = await loadAuth({hostname: 'zero-x.live', config: {configured: true, supabase_url: 'https://example.supabase.co', supabase_key: 'sb_publishable_test', providers: ['google']}, session: makeStorage({'zx-dev-token': token})});
  await supabase.auth.init();
  assert.equal(supabase.sdkCalls.length, 1);
  await supabase.auth.signOut({redirectUrl: 'https://zero-x.live/'});
  assert.equal(supabase.session.getItem('zx-dev-token'), null, 'Supabase sign out also clears any dev token');
  assert.equal(supabase.auth.sdkVersion, '2.117.2');

  const missingSdk = await loadAuth({hostname: 'zero-x.live', config: {configured: true, supabase_url: 'https://example.supabase.co', supabase_key: 'k', providers: []}, sdk: false});
  const pending = missingSdk.auth.init();
  await settle();
  const injected = missingSdk.doc.querySelectorAll('script');
  assert.equal(injected.length, 1, 'The pinned SDK is injected on demand');
  assert.equal(injected[0].src, 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/dist/umd/supabase.js');
  assert.match(injected[0].integrity, /^sha384-[A-Za-z0-9+/]{64}$/);
  assert.equal(injected[0].crossOrigin, 'anonymous');
  injected[0].onerror();
  await assert.rejects(pending, /Supabase JS SDK did not load/);
}

{
  // Review B4 P2: signed-out Upgrade, then sign-in through the REAL zerox-auth.js dev flow, which
  // reloads the page. The abandoned document must not start a checkout; the reloaded page resumes.
  const session = makeStorage();
  const local = makeStorage({'zx-currency': 'USD'});
  const devConfig = {provider: 'dev', configured: true, dev: true, providers: ['dev']};
  const real = await loadAuth({hostname: '127.0.0.1', config: devConfig, session});
  await real.auth.init();
  const doc = parseDocument(read('pricing.html'));
  const win = makeWindow({hostname: '127.0.0.1', auth: real.auth, session, local});
  win.Razorpay = FakeRazorpay;
  const first = makeFetch({'GET /api/plans': plansPayload, 'POST /api/billing/checkout': () => new Promise(() => {})});
  const page = createPricingPage({doc, win, auth: real.auth, fetchImpl: first.fetchImpl, now: () => NOW});
  await page.init();
  await settle();
  doc.querySelector('[data-upgrade="pro"]').click();
  await settle();
  assert.ok(local.getItem(PENDING_CHECKOUT_KEY), 'the intent is stored before sign-in');
  const modal = real.doc.querySelector('[data-zerox-auth-modal="true"]');
  modal.querySelector('#zerox-auth-dev-email').value = 'dev@example.com';
  modal.querySelector('[data-auth-dev-wrap="true"]').dispatchEvent(makeEvent('submit', {cancelable: true}));
  await settle();
  assert.equal(real.window.location.reloads, 1, 'zerox-auth reloads after dev sign-in');
  assert.equal(real.auth.isNavigating(), true);
  assert.equal(first.calls.filter(call => call.path === '/api/billing/checkout').length, 0, 'the unloading page starts no checkout');
  assert.ok(local.getItem(PENDING_CHECKOUT_KEY), 'the intent survives the reload');
  // The reloaded page (same storage) resumes the checkout once.
  FakeRazorpay.instances.length = 0;
  const doc2 = parseDocument(read('pricing.html'));
  const win2 = makeWindow({hostname: '127.0.0.1', auth: real.auth, session, local});
  win2.Razorpay = FakeRazorpay;
  const second = makeFetch({'GET /api/plans': plansPayload,
    'POST /api/billing/checkout': {provider: 'razorpay', key_id: 'rzp_test_AbCdEf123456', subscription_id: 'sub_TEST12345', name: 'Zero-X'}});
  const page2 = createPricingPage({doc: doc2, win: win2, auth: real.auth, fetchImpl: second.fetchImpl, now: () => NOW});
  // init() resumes into checkout, which stays pending while the Razorpay window is open.
  page2.init();
  await settle();
  assert.equal(second.calls.filter(call => call.path === '/api/billing/checkout').length, 1, 'the reloaded page resumed checkout');
  assert.equal(FakeRazorpay.instances.length, 1, 'Razorpay opened');
  assert.equal(local.getItem(PENDING_CHECKOUT_KEY), null, 'consumed once Razorpay opened');
  // A magic link opens a new tab: localStorage carries the intent there (sessionStorage would not).
  local.setItem(PENDING_CHECKOUT_KEY, JSON.stringify({kind: 'plan', id: 'max', currency: 'INR', created: NOW}));
  FakeRazorpay.instances.length = 0;
  const tab = makeWindow({hostname: '127.0.0.1', auth: real.auth, session: makeStorage({'zx-dev-token': session.getItem('zx-dev-token')}), local});
  tab.Razorpay = FakeRazorpay;
  const third = makeFetch({'GET /api/plans': plansPayload,
    'POST /api/billing/checkout': call => ({provider: 'razorpay', key_id: 'rzp_test_AbCdEf123456', subscription_id: 'sub_TEST54321', notes: {plan: call.body.plan}})});
  createPricingPage({doc: parseDocument(read('pricing.html')), win: tab, auth: real.auth, fetchImpl: third.fetchImpl, now: () => NOW}).init(); // stays pending with Razorpay open
  await settle();
  assert.deepEqual(third.calls.find(call => call.path === '/api/billing/checkout').body, {plan: 'max', currency: 'INR'});
}

{
  // Review B4 P2: after Razorpay reports success, a failed verify (network, 502, 401) is terminal.
  for (const [label, verify] of [['network', () => { throw new TypeError('offline'); }],
    ['502', apiError(502, 'upstream_error', 'Bad gateway')], ['401', apiError(401, 'invalid_session', 'Session expired')]]) {
    const t = await mountPricing({profile: PROFILE, routes: {'POST /api/billing/verify': verify}});
    FakeRazorpay.instances.length = 0;
    t.doc.querySelector('[data-upgrade="pro"]').click();
    await settle();
    await FakeRazorpay.instances[0].options.handler({razorpay_payment_id: 'pay_TEST1234567', razorpay_subscription_id: 'sub_TEST12345', razorpay_signature: 'cd'.repeat(32)});
    await settle();
    const message = t.$('pricing-error').textContent;
    assert.match(message, /could not confirm the payment/, label);
    assert.match(message, /Payment ID: pay_TEST1234567/, label);
    assert.doesNotMatch(message, /try again|sign-in has expired/i, label);
    assert.equal(t.$('pricing-error').querySelector('a').getAttribute('href'), 'https://dashboard.zero-x.live/#billing', label);
    assert.equal(t.auth.calls.modal.length, 0, `${label}: no sign-in prompt`);
    assert.equal(t.win.localStorage.getItem(PENDING_CHECKOUT_KEY), null, `${label}: no checkout re-queued`);
    assert.ok(t.doc.querySelectorAll('[data-upgrade], [data-topup]').every(button => button.disabled), `${label}: buttons stay locked`);
    t.doc.querySelector('[data-upgrade="max"]').click();
    await settle();
    assert.equal(t.calls.filter(call => call.path === '/api/billing/checkout').length, 1, `${label}: no second checkout`);
  }

  // Review P2 (integration): a verify answer of {status:'pending'} is not a confirmed payment. The
  // page says so, never redirects as if confirmed, and keeps purchases locked across reloads.
  const storage = makeStorage({'zx-currency': 'USD'});
  const waiting = await mountPricing({profile: PROFILE, local: storage, routes: {'POST /api/billing/verify': {status: 'pending', account: {}}}});
  FakeRazorpay.instances.length = 0;
  waiting.doc.querySelector('[data-upgrade="pro"]').click();
  await settle();
  await FakeRazorpay.instances[0].options.handler({razorpay_payment_id: 'pay_PENDING12345', razorpay_subscription_id: 'sub_TEST12345', razorpay_signature: 'cd'.repeat(32)});
  await settle();
  assert.equal(waiting.win.location.assigned, null, 'no redirect for an unconfirmed payment');
  assert.doesNotMatch(waiting.$('pricing-status').textContent, /Payment confirmed/);
  assert.match(waiting.$('pricing-error').textContent, /awaiting confirmation from Razorpay/);
  assert.match(waiting.$('pricing-error').textContent, /do not pay again/);
  assert.match(waiting.$('pricing-error').textContent, /Payment ID: pay_PENDING12345/);
  assert.equal(waiting.$('pricing-error').querySelector('a').getAttribute('href'), 'https://dashboard.zero-x.live/#billing');
  assert.ok(waiting.doc.querySelectorAll('[data-upgrade], [data-topup]').every(button => button.disabled), 'purchases stay locked');
  assert.deepEqual(JSON.parse(storage.getItem(PAYMENT_LOCK_KEY)), {code: 'payment_pending', paymentId: 'pay_PENDING12345', created: NOW});
  waiting.doc.querySelector('[data-upgrade="max"]').click();
  await settle();
  assert.equal(waiting.calls.filter(call => call.path === '/api/billing/checkout').length, 1, 'no second checkout');
  // A reload (or another tab) within 30 minutes is still locked.
  const reloaded = await mountPricing({profile: PROFILE, local: storage});
  assert.ok(reloaded.doc.querySelectorAll('[data-upgrade], [data-topup]').every(button => button.disabled), 'locked after a reload');
  assert.match(reloaded.$('pricing-error').textContent, /awaiting confirmation/);
  reloaded.doc.querySelector('[data-upgrade="pro"]').click();
  await settle();
  assert.ok(!reloaded.calls.some(call => call.path === '/api/billing/checkout'), 'no checkout after the reload');
  const expired = makeStorage({[PAYMENT_LOCK_KEY]: JSON.stringify({code: 'payment_pending', paymentId: 'pay_OLD1234567', created: NOW - PAYMENT_LOCK_TTL_MS - 1})});
  const later = await mountPricing({profile: PROFILE, local: expired});
  assert.equal(later.doc.querySelector('[data-upgrade="pro"]').disabled, false, 'the lock lapses after 30 minutes');
  const tampered = await mountPricing({profile: PROFILE, local: makeStorage({[PAYMENT_LOCK_KEY]: '{"code":"<script>","created":0}'})});
  assert.equal(tampered.doc.querySelector('[data-upgrade="pro"]').disabled, false, 'a malformed lock is ignored');
  // The server-side guard's answer (a checkout already in progress) points to Billing.
  const inProgress = await mountPricing({profile: PROFILE, routes: {'POST /api/billing/checkout':
    apiError(409, 'checkout_in_progress', 'A checkout for your account is already in progress.')}});
  inProgress.doc.querySelector('[data-upgrade="max"]').click();
  await settle();
  assert.match(inProgress.$('pricing-error').textContent, /already in progress or its payment is being confirmed/);
  assert.equal(inProgress.$('pricing-error').querySelector('a').getAttribute('href'), 'https://dashboard.zero-x.live/#billing');

  // A duplicate subscription (verify 409 already_subscribed) was cancelled and refunded by the
  // gateway: that is final and explained, not reported as an unconfirmed payment.
  const duplicate = await mountPricing({profile: PROFILE, routes: {'POST /api/billing/verify':
    apiError(409, 'already_subscribed', 'This subscription duplicates another subscription or checkout on your account.')}});
  FakeRazorpay.instances.length = 0;
  duplicate.doc.querySelector('[data-upgrade="pro"]').click();
  await settle();
  await FakeRazorpay.instances[0].options.handler({razorpay_payment_id: 'pay_DUPLICATE123', razorpay_subscription_id: 'sub_TEST12345', razorpay_signature: 'cd'.repeat(32)});
  await settle();
  assert.match(duplicate.$('pricing-error').textContent, /duplicated a subscription or checkout already on your account/);
  assert.match(duplicate.$('pricing-error').textContent, /being refunded/);
  assert.doesNotMatch(duplicate.$('pricing-error').textContent, /could not confirm/);
  assert.equal(duplicate.$('pricing-error').querySelector('a').getAttribute('href'), 'https://dashboard.zero-x.live/#billing');
  assert.equal(duplicate.win.location.assigned, null);

  // Review B4 P2: a signed-in Free account cannot open a top-up checkout.
  const free = await mountPricing({profile: PROFILE, routes: {'GET /api/account': accountPayload({plan: {id: 'free', name: 'Free'}, subscription: null})}});
  free.doc.querySelector('[data-topup="credits_5"]').click();
  await settle();
  assert.ok(!free.calls.some(call => call.path === '/api/billing/topup'), 'no order for Free accounts');
  assert.match(free.$('pricing-error').textContent, /need an active Pro or Max plan/);
  assert.equal(free.$('pricing-error').querySelector('a').getAttribute('href'), 'https://zero-x.live/pricing#plans');
  // The server-side refusal is handled the same way.
  const refused = await mountPricing({profile: PROFILE, routes: {'GET /api/account': accountPayload(),
    'POST /api/billing/topup': apiError(403, 'upgrade_required', 'Credit top-ups are available on the Pro and Max plans. Upgrade first.')}});
  refused.doc.querySelector('[data-topup="credits_5"]').click();
  await settle();
  assert.match(refused.$('pricing-error').textContent, /Pro and Max plans/);
  assert.equal(refused.$('pricing-error').querySelector('a').getAttribute('href'), 'https://zero-x.live/pricing#plans');
}

console.log('PASS: dashboard gate, contract-driven overview, hash tabs and keyboard, usage chart/table/pagination, key create-once/copy/revoke-confirm, billing cancel/top-up/verify, sessions, sign-out dev-token cleanup, 401/500 recovery, pricing currency/hydration/checkout/409/503/forged payloads, Neuron CLI tabs and models, zerox-auth dev identity and pinned SDK; untrusted data never reached innerHTML');
process.exit(0);

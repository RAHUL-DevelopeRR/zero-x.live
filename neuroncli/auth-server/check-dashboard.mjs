// Browser behaviour of the account dashboard, pricing checkout, Neuron CLI page script and the
// zerox-auth.js dev identity, exercised against the real HTML through a small DOM emulation.
// The emulated DOM throws whenever untrusted code assigns innerHTML (strict mode).
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
// Site scripts load as ES modules whatever package.json lies above the checkout.
import './site-modules.mjs';
import {NEURON_INSTALL} from './src/neuron-release.js';

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
  appendChild(node) { if (node.nodeType === 11) { for (const child of [...node.childNodes]) this.appendChild(child); return node; } if (node.parentNode) node.parentNode.removeChild(node); node.parentNode = this; this.childNodes.push(node); return node; }
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
  createDocumentFragment() { const fragment = new Node(this); fragment.nodeType = 11; return fragment; }
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

// The HTML parser turns CRLF into LF, as a browser does (a Windows checkout has CRLF pages).
function parseDocument(html, options) { const doc = new Document(options); parseInto(doc, html.replace(/\r\n?/g, '\n'), doc); return doc; }

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

function makeWindow({hostname = 'dashboard.zero-x.live', hash = '', search = '', auth, session = makeStorage(), local = makeStorage()} = {}) {
  const listeners = {};
  const fire = type => (listeners[type] || []).forEach(fn => fn({type}));
  const location = {hostname, origin: 'https://' + hostname, pathname: '/', search, assigned: null, reloads: 0, _hash: hash,
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
    by_model: [{model: '<b>groq/openai/gpt-oss-120b</b>', requests: 52, prompt_tokens: 39000, cache_read_tokens: 30000, cache_write_tokens: 4000, completion_tokens: 5000, cost_usd: 0.03}],
    totals: {requests: 52, prompt_tokens: 39000, completion_tokens: 5000, cost_usd: 0.03}},
    'GET /api/usage/events': call => call.path.includes('before=123')
      ? {events: [{id: 100, created_at: '2026-10-15T09:00:00Z', model: 'gemini/gemini-2.5-flash', provider: 'gemini', tier: 'free', status: 'ok', prompt_tokens: 10, completion_tokens: 5, cost_usd: 0, latency_ms: 800, request_id: 'req_old'}], next_before: null}
      : {events: [{id: 124, created_at: '2026-10-16T17:00:00Z', model: XSS, provider: 'groq', tier: 'paid', status: 'error', prompt_tokens: 100, cache_read_tokens: 80, cache_write_tokens: 15, completion_tokens: 20, cost_usd: 0.0012, latency_ms: 1200, request_id: 'req_new'}], next_before: 123},
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
    'POST /api/sessions/revoke-all': call => { state.sessions = []; return call.body && call.body.api_keys ? {revoked: 3, api_keys_revoked: 2} : {revoked: 3}; },
    'GET /api/sessions': () => ({sessions: state.sessions}),
    'DELETE /api/sessions/*': call => { const id = call.path.split('/').pop(); state.sessions = state.sessions.filter(s => s.id !== id); return {status: 'revoked', current: false}; },
  };
}

const {createDashboard, TABS} = await import(new URL('dashboard.js', root));
const {createPricingPage, findPlan, PENDING_CHECKOUT_KEY} = await import(new URL('pricing.js', root));
const {CHECKOUT_THEME_COLOR, PAYMENT_LOCK_KEY, PAYMENT_LOCK_TTL_MS, startSubscription} = await import(new URL('billing-checkout.js', root));
// The billing details step (billing-details.js) is replaced by a stub in every test but its own: it
// answers like a buyer who filled in the details and ticked every box.
const CONSENT_VERSIONS = {terms: '2026-10-25', privacy: '2026-10-25', auto_renewal: '2026-11-03', refund: '2026-10-24'};
const STUB_DETAILS = [];
const stubDetails = async options => {
  STUB_DETAILS.push(options);
  const documents = options.kind === 'subscription' ? ['terms', 'privacy', 'auto_renewal', 'refund'] : ['terms', 'privacy', 'refund'];
  return {consent: Object.fromEntries(documents.map(name => [name, CONSENT_VERSIONS[name]]))};
};
const consentFor = kind => (kind === 'subscription' ? ['terms', 'privacy', 'auto_renewal', 'refund'] : ['terms', 'privacy', 'refund'])
  .reduce((all, name) => ({...all, [name]: CONSENT_VERSIONS[name]}), {});
const DASHBOARD_HTML = read('dashboard.html');

async function mountDashboard({profile = PROFILE, hash = '', search = '', state = {}, routes = {}, session, local, details = stubDetails} = {}) {
  const shared = {keys: [
    {id: 'k-1', name: 'Laptop', prefix: 'nzx_Qw12', created_at: '2026-10-01T00:00:00Z', last_used_at: '2026-10-15T00:00:00Z', revoked_at: null},
    {id: 'k-0', name: 'Old CI', prefix: 'nzx_Zz99', created_at: '2026-09-01T00:00:00Z', last_used_at: null, revoked_at: '2026-09-10T00:00:00Z'}],
  sessions: [
    {id: 'aaaaaaaaaaaaaaaaaaaaaaaa', device_name: XSS, os: 'Windows 11', client: {name: 'neuron-cli', version: '6.3.0'}, created_at: '2026-10-01T00:00:00Z',
      last_used_at: '2026-10-16T17:00:00Z', expires_at: '2026-11-15T17:00:00Z', current: true},
    {id: 'bbbbbbbbbbbbbbbbbbbbbbbb', device_name: 'studio', os: 'macOS 15', client: {name: 'neuron-desktop', version: '0.2.0'}, created_at: '2026-10-02T00:00:00Z',
      last_used_at: null, expires_at: '2026-11-01T00:00:00Z', current: false},
    {id: 'cccccccccccccccccccccccc', device_name: null, os: null, client: {name: null, version: null}, created_at: '2026-10-03T00:00:00Z',
      last_used_at: null, expires_at: '2026-11-02T00:00:00Z', current: false},
    {id: '../../admin', device_name: 'forged'}],
  cancelled: false, account: () => accountPayload(), ...state};
  const doc = parseDocument(DASHBOARD_HTML);
  const auth = makeAuth(profile);
  const win = makeWindow({hash, search, auth, session, ...(local ? {local} : {})});
  win.Razorpay = FakeRazorpay;
  const {fetchImpl, calls} = makeFetch({...dashboardRoutes(shared), ...routes});
  const dashboard = createDashboard({doc, win, auth, fetchImpl, now: () => NOW, collectDetails: details});
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

// Free's rolling 5-hour window: the tokens card shows the window (usage_window), not the day.
{
  const freeAccount = accountPayload({plan: {id: 'free', name: 'Free'}, subscription: null,
    limits: {daily_requests: 100, daily_tokens: 5000000, window_tokens: 1000000, window_seconds: 18000, rpm: 10, concurrency: 2},
    usage_today: {requests: 40, tokens: 1300000, resets_at: '2026-10-17T00:00:00.000Z'},
    usage_window: {tokens: 800000, limit_tokens: 1000000, remaining_tokens: 200000, window_seconds: 18000, resets_at: '2026-10-16T20:30:00.000Z'}});
  const {$} = await mountDashboard({state: {account: () => freeAccount}});
  assert.equal($('ov-tokens-label').textContent, 'Tokens this 5-hour window');
  assert.equal($('ov-tokens').textContent, '800K / 1M');
  assert.equal($('ov-tokens-bar').getAttribute('aria-valuenow'), '80');
  assert.equal($('ov-tokens-detail').textContent, '200K tokens left · frees up in 2 h 30 min · 1.3M today');
  assert.equal($('ov-reset').textContent, 'Resets in 6 h 0 min. Tokens free up 5 hours after use.');
  assert.match($('ov-plan-detail').textContent, /rolling 5-hour window/);
  assert.equal($('ov-requests').textContent, '40 / 100', 'the daily request cap stays');
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
  assert.equal(win.copied, NEURON_INSTALL.powershell, 'the quick start install bar copies the command it shows');
  assert.equal(doc.querySelector('[data-copy-target="qs-install"]').getAttribute('data-state'), 'copied', 'the copied button shows the check');
  doc.querySelector('[data-copy-target="qs-headless"]').click();
  await settle();
  assert.equal(win.copied, 'export NEURON_TOKEN=nzx_your_key\nneuron -p "Run the tests and summarise failures"', 'the headless example copies');

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
  assert.deepEqual($('usage-models').querySelector('tr').querySelectorAll('td').map(cell => cell.textContent), ['52', '39,000', '30,000', '5,000', '$0.03'],
    'By model shows cached prompt tokens after prompt tokens');
  assert.equal($('usage-total-requests').textContent, '52');
  assert.equal($('usage-total-cost').textContent, '$0.03');
  doc.querySelector('[data-metric="tokens"]').click();
  assert.equal(doc.querySelector('[data-metric="tokens"]').getAttribute('aria-pressed'), 'true');
  assert.match($('usage-chart-caption').textContent, /^Tokens per day/);
  // Events pagination with next_before cursors.
  assert.equal($('usage-events').querySelector('code').textContent, XSS);
  const cachedTokens = $('usage-events').querySelector('tr').querySelectorAll('td')[4];
  assert.equal(cachedTokens.textContent, '120 (80 cached)');
  assert.equal(cachedTokens.getAttribute('title'), '80 read from the prompt cache, 15 written to it');
  assert.equal($('events-newer').disabled, true);
  assert.equal($('events-older').disabled, false);
  $('events-older').click();
  await settle();
  assert.ok(calls.some(call => call.path === '/api/usage/events?limit=25&before=123'));
  assert.equal($('events-page').textContent, 'Page 2');
  const plainTokens = $('usage-events').querySelector('tr').querySelectorAll('td')[4];
  assert.equal(plainTokens.textContent, '15', 'no cache note without cached prompt tokens');
  assert.equal(plainTokens.getAttribute('title'), null);
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
  assert.deepEqual(calls.find(call => call.path === '/api/billing/topup').body, {pack: 'credits_5', currency: 'INR', consent: consentFor('topup')});
  assert.deepEqual(STUB_DETAILS.at(-1) && [STUB_DETAILS.at(-1).kind, STUB_DETAILS.at(-1).pack.id, STUB_DETAILS.at(-1).currency], ['topup', 'credits_5', 'INR'], 'the details step runs before the top-up order is created');
  const checkout = FakeRazorpay.instances[0];
  assert.equal(checkout.opened, true);
  assert.equal(checkout.options.key, 'rzp_test_AbCdEf123456');
  assert.equal(checkout.options.order_id, 'order_TEST123456');
  assert.equal(checkout.options.amount, 44900);
  assert.equal(checkout.options.currency, 'INR');
  assert.deepEqual(checkout.options.theme, {color: '#3B82F6'});
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

  // Sessions: the signed-in devices list (A9), signing out one device, then all of them.
  win.location.hash = '#sessions';
  await settle();
  assert.ok(calls.some(call => call.method === 'GET' && call.path === '/api/sessions'));
  const deviceRows = () => [...$('sessions-list').querySelectorAll('tr')];
  assert.equal(deviceRows().length, 3, 'one row per signed-in device');
  assert.ok(deviceRows()[0].textContent.includes(XSS), 'device names are shown as text');
  assert.ok(deviceRows()[0].textContent.includes('This device'));
  assert.ok(deviceRows()[1].textContent.includes('neuron-desktop 0.2.0'));
  assert.ok(deviceRows()[2].textContent.includes('Unnamed device'), 'a session without a reported device still lists');
  const signOutDevice = () => $('sessions-list').querySelector('button[data-session-id="bbbbbbbbbbbbbbbbbbbbbbbb"]');
  signOutDevice().click();
  await settle();
  assert.match($('confirm-body').textContent, /"studio" is signed out of Zero-X/);
  $('confirm-cancel').click();
  await settle();
  assert.ok(!calls.some(call => call.method === 'DELETE' && call.path.startsWith('/api/sessions/')), 'cancelling keeps the device signed in');
  signOutDevice().click();
  await settle();
  $('confirm-ok').click();
  await settle();
  assert.ok(calls.some(call => call.method === 'DELETE' && call.path === '/api/sessions/bbbbbbbbbbbbbbbbbbbbbbbb'));
  assert.equal(signOutDevice(), null, 'the list reloads without the signed-out device');
  assert.equal(deviceRows().length, 2);
  $('sessions-revoke').click();
  await settle();
  $('confirm-ok').click();
  await settle();
  assert.ok(calls.some(call => call.method === 'POST' && call.path === '/api/sessions/revoke-all'));
  assert.match($('sessions-status').textContent, /Signed out 3 CLI sessions\./);
  assert.deepEqual(calls.filter(call => call.path === '/api/sessions/revoke-all').at(-1).body, {});
  assert.match($('sessions-list').textContent, /No device is signed in/, 'the list reloads after signing out everywhere');
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
  assert.deepEqual(TABS, ['overview', 'usage', 'keys', 'billing', 'sessions', 'connectors', 'account']);
  assert.equal($('tab-connectors').hidden, true, 'Connectors stays hidden while GET /api/connectors is 404');
  assert.ok(calls.some(call => call.path === '/api/connectors'), 'the dashboard asks whether connectors are served');
}

// Hosted connectors: hidden while the gateway answers 404 (HOSTED_CONNECTORS off), even on a deep link.
{
  const {$} = await mountDashboard({hash: '#connectors'});
  assert.equal($('tab-connectors').hidden, true);
  assert.equal($('panel-connectors').hidden, true);
  assert.equal($('panel-overview').hidden, false, '#connectors falls back to the overview when connectors are off');
}

// Hosted connectors on: the tab shows, rows render as text, connect redirects, disconnect confirms.
{
  const connectorRows = [
    {id: 'github', name: 'GitHub', publisher: 'GitHub', status: 'connected', scopes: ['repo', 'read:org'], connected_at: '2026-11-04T10:00:00Z'},
    {id: 'linear', name: 'Linear', publisher: 'Linear', status: 'not_connected', scopes: [], connected_at: null},
    {id: 'slack', name: XSS, publisher: 'Slack', status: 'unavailable', scopes: [], connected_at: null},
    {id: '../evil', name: 'Forged', status: 'connected'}];
  let disconnected = null;
  const routes = {
    'GET /api/connectors': () => ({connectors: connectorRows.map(row => row.id === disconnected ? {...row, status: 'not_connected', scopes: [], connected_at: null} : row)}),
    'POST /api/connectors/linear/connect': {authorize_url: 'https://linear.app/oauth/authorize?state=abc', expires_in: 600},
    'POST /api/connectors/github/connect': {authorize_url: 'javascript:alert(1)'},
    'DELETE /api/connectors/github': () => { disconnected = 'github'; return {status: 'disconnected', connector: 'github'}; },
  };
  const {$, win, calls, doc} = await mountDashboard({hash: '#connectors', search: '?connector=github&connect=ok', routes});
  assert.equal($('tab-connectors').hidden, false);
  assert.equal($('panel-connectors').hidden, false, 'a #connectors deep link opens the tab once it is served');
  assert.equal($('connectors-status').textContent, 'GitHub is connected.');
  const rows = $('connectors-list').querySelectorAll('tr');
  assert.equal(rows.length, 3, 'rows with an invalid id are dropped');
  assert.equal(rows[2].querySelector('th').textContent, XSS + ' · Slack');
  assert.equal(rows[2].querySelectorAll('img').length, 0);
  assert.deepEqual(rows[0].querySelectorAll('td').map(cell => cell.textContent).slice(0, 2), ['Connected', 'repo, read:org']);
  assert.equal(rows[2].querySelectorAll('td')[0].textContent, 'Coming soon');
  doc.querySelector('[data-connector="linear"]').click();
  await settle();
  assert.equal(win.location.assigned, 'https://linear.app/oauth/authorize?state=abc');
  assert.ok(calls.some(call => call.method === 'POST' && call.path === '/api/connectors/linear/connect'));
  // Disconnect asks first.
  doc.querySelector('[data-connector="github"]').click();
  await settle();
  assert.match($('confirm-title').textContent, /Disconnect GitHub\?/);
  $('confirm-ok').click();
  await settle();
  assert.ok(calls.some(call => call.method === 'DELETE' && call.path === '/api/connectors/github'));
  assert.equal($('connectors-list').querySelector('tr').querySelectorAll('td')[0].textContent, 'Not connected');
  // Keyboard navigation includes the tab once it is shown.
  $('tab-sessions').focus();
  win.location.hash = '#sessions';
  await settle();
  $('dash-tabs').dispatchEvent(makeEvent('keydown', {key: 'ArrowRight', bubbles: true}));
  await settle();
  assert.equal(win.location.hash, '#connectors');
}

// The provider sent the browser back with an error.
{
  const {$} = await mountDashboard({hash: '#connectors', search: '?connector=github&connect=error&reason=browser_mismatch',
    routes: {'GET /api/connectors': {connectors: [{id: 'github', name: 'GitHub', publisher: 'GitHub', status: 'not_connected', scopes: []}]}}});
  assert.equal($('connectors-error').textContent.includes('GitHub could not be connected: it was started in another browser, so start again here.'), true);
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
  assert.match($('topup-note').textContent, /need an active paid plan/);
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

async function mountPricing({profile = null, routes = {}, hostname = 'zero-x.live', local = makeStorage({'zx-currency': 'USD'}), details = stubDetails} = {}) {
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
  const page = createPricingPage({doc, win, auth, fetchImpl, now: () => NOW, collectDetails: details});
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
  assert.equal(doc.querySelector('[data-plan-features="pro"]').querySelectorAll('li').length, 6, 'Empty API features keep the static list');
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
  assert.deepEqual(checkoutCall.body, {plan: 'pro', currency: 'INR', consent: consentFor('subscription')});
  assert.deepEqual([STUB_DETAILS.at(-1).kind, STUB_DETAILS.at(-1).plan.id], ['subscription', 'pro'], 'the details step runs before the subscription is created');
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

/* ───────────── Pricing page: Athlete and Speed (migration 20261108000000) ───────────── */

{
  const NEW_PLANS = ['athlete', 'speed'];
  const onlyFor = (doc, id) => doc.querySelectorAll(`[data-plan-only="${id}"]`);
  // Static page (no script, or before /api/plans answers): five cards in price order, both new plans shown.
  const staticDoc = parseDocument(read('pricing.html'));
  assert.deepEqual(staticDoc.querySelectorAll('#plans .zx-plan').map(card => card.getAttribute('id')),
    ['plan-free', 'plan-athlete', 'plan-speed', 'plan-pro', 'plan-max'], 'pricing.html: Free, Athlete, Speed, Pro, Max');
  assert.deepEqual(staticDoc.querySelectorAll('[data-upgrade]').map(button => button.dataset.upgrade), ['athlete', 'speed', 'pro', 'max']);
  assert.ok(staticDoc.querySelector('#plan-pro').getAttribute('class').includes('zx-card--highlight'), 'Pro stays highlighted');
  for (const id of NEW_PLANS) {
    assert.equal(staticDoc.querySelector(`#plan-${id}`).getAttribute('data-plan-only'), id, `${id}: the card hides with its plan`);
    assert.ok(!staticDoc.querySelector(`#plan-${id}`).getAttribute('class').includes('zx-card--highlight'), `${id}: not highlighted`);
    // Every comparison cell of the plan's column hides with it: header, 14 rows.
    assert.equal(staticDoc.querySelectorAll('#compare [data-plan-only]').filter(el => el.dataset.planOnly === id).length, 15, `${id}: comparison column`);
    assert.ok(onlyFor(staticDoc, id).every(el => !el.hidden), `${id}: shown before hydration`);
  }

  // Before the migration: /api/plans lists Free, Pro and Max only (plansPayload), so both plans are
  // hidden and a click (or a remembered intent) cannot start a checkout.
  const before = await mountPricing({profile: PROFILE});
  for (const id of NEW_PLANS) {
    assert.ok(onlyFor(before.doc, id).length > 0 && onlyFor(before.doc, id).every(el => el.hidden), `${id}: hidden when the gateway does not list it`);
    assert.equal(findPlan(before.page.catalog, id), null);
  }
  assert.ok(!before.doc.querySelector('#plan-pro').hidden && !before.doc.querySelector('#plan-max').hidden, 'Pro and Max stay');
  before.doc.querySelector('[data-upgrade="athlete"]').click();
  await settle();
  assert.ok(!before.calls.some(call => call.path === '/api/billing/checkout'), 'no checkout for a plan the gateway does not offer');
  assert.match(before.$('pricing-error').textContent, /not available yet/);
  // The server's own refusal (a stale page) reads the same.
  const stale = await mountPricing({profile: PROFILE, routes: {'GET /api/plans': {currency_default: 'USD', plans: [...plansPayload.plans, {id: 'speed', name: 'Speed',
    price: {usd_cents: 500, inr_paise: 44900}, limits: {}, monthly_credit_usd: 4, tiers: ['free', 'paid'], features: [], highlighted: false}], topups: plansPayload.topups},
  'POST /api/billing/checkout': apiError(409, 'plan_unavailable', 'This plan is not available yet. Choose another plan, or email support@zero-x.live.')}});
  assert.ok(onlyFor(stale.doc, 'speed').every(el => !el.hidden) && onlyFor(stale.doc, 'athlete').every(el => el.hidden), 'each plan follows the gateway');
  stale.doc.querySelector('[data-upgrade="speed"]').click();
  await settle();
  assert.match(stale.$('pricing-error').textContent, /not available yet/);

  // After the migration: the gateway lists them; prices, credits and limits hydrate; checkout sends the plan id.
  const listed = {currency_default: 'USD', plans: [plansPayload.plans[0],
    {id: 'athlete', name: 'Athlete', price: {usd_cents: 100, inr_paise: 8900}, interval: 'month', limits: {daily_requests: 300, daily_tokens: 6000000, rpm: 15, concurrency: 2},
      monthly_credit_usd: 0.75, tiers: ['free', 'paid'], features: [], highlighted: false},
    {id: 'speed', name: 'Speed', price: {usd_cents: 500, inr_paise: 44900}, interval: 'month', limits: {daily_requests: 1000, daily_tokens: 8000000, rpm: 20, concurrency: 3},
      monthly_credit_usd: 4, tiers: ['free', 'paid'], features: [], highlighted: false},
    ...plansPayload.plans.slice(1)], topups: plansPayload.topups};
  const after = await mountPricing({profile: PROFILE, routes: {'GET /api/plans': listed}});
  for (const id of NEW_PLANS) assert.ok(onlyFor(after.doc, id).every(el => !el.hidden), `${id}: shown once the gateway lists it`);
  assert.equal(after.doc.querySelector('[data-plan-price="athlete"]').textContent, '$1');
  assert.equal(after.doc.querySelector('[data-plan-credit="athlete"]').textContent, '$0.75');
  assert.equal(after.doc.querySelector('[data-plan-limit="athlete:token_allowance"]').textContent, '6M per day');
  after.doc.querySelector('[data-currency="INR"]').click();
  assert.deepEqual(['athlete', 'speed', 'pro', 'max'].map(id => after.doc.querySelector(`#plan-${id} [data-plan-price]`).textContent), ['₹89', '₹449', '₹899', '₹3,499'],
    'INR prices in price order');
  assert.equal(after.doc.querySelectorAll('[data-plan-features="athlete"] li').length, 6, 'empty API features keep the static Athlete list');
  after.doc.querySelector('[data-upgrade="athlete"]').click();
  await settle();
  const checkoutCall = after.calls.find(call => call.path === '/api/billing/checkout');
  assert.deepEqual([checkoutCall.body.plan, checkoutCall.body.currency], ['athlete', 'INR'], 'checkout for Athlete in INR');
  // After the migration but before the Razorpay plan ids are stored: billing_plan_missing, as for Pro.
  const missing = await mountPricing({profile: PROFILE, routes: {'GET /api/plans': listed,
    'POST /api/billing/checkout': apiError(503, 'billing_plan_missing', 'Checkout for the Speed plan in USD is not set up yet.')}});
  missing.doc.querySelector('[data-upgrade="speed"]').click();
  await settle();
  assert.match(missing.$('pricing-error').textContent, /not set up yet/);
  assert.equal(missing.$('pricing-error').querySelector('a').getAttribute('href'), 'mailto:support@zero-x.live');
  await assert.rejects(startSubscription({plan: 'gold', currency: 'USD'}), /Athlete, Speed, Pro or Max/);
}

/* ───────────── Install bar (install-bar.js) ───────────── */

{
  const html = read('neuron-cli.html');
  assert.doesNotMatch(html, /\/\/ Install tabs/, 'neuron-cli.html: the inline install-tab script is gone (install-bar.js builds the menu)');
  const bar = await import(new URL('install-bar.js', root));
  const {copyButtons} = await import(new URL('copy-code.js', root));
  const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
  const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
  const LINUX_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
  const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
  assert.deepEqual([WINDOWS_UA, MAC_UA, LINUX_UA, ANDROID_UA, ''].map(ua => bar.detectOs(ua)), ['windows', 'macos', 'linux', 'android', null]);
  assert.equal(bar.detectOs('', 'Windows'), 'windows', 'client hints platform');
  assert.deepEqual(['windows', 'macos', 'linux', 'android', 'ios', null].map(bar.methodForOs), ['powershell', 'shell', 'shell', null, null, null]);
  const {detectOs} = await import(new URL('download.js', root));
  assert.equal(detectOs, bar.detectOs, 'download.js shares the one detectOs');
  // Tokens cover the whole command; the program, the pipe and the program piped into are marked.
  for (const command of [NEURON_INSTALL.powershell, NEURON_INSTALL.cmd, NEURON_INSTALL.shell, NEURON_INSTALL.npm, NEURON_INSTALL.pip]) {
    assert.equal(bar.commandTokens(command).map(t => t.text).join(''), command, 'tokens rebuild ' + command);
  }
  const kinds = command => bar.commandTokens(command).filter(t => t.kind !== 'space').map(t => `${t.kind}:${t.text}`);
  assert.deepEqual(kinds(NEURON_INSTALL.powershell), ['cmd:irm', 'text:https://zero-x.live/install.ps1', 'op:|', 'run:iex']);
  assert.deepEqual(kinds(NEURON_INSTALL.shell), ['cmd:curl', 'flag:-fsSL', 'text:https://zero-x.live/install.sh', 'op:|', 'run:sh']);
  assert.deepEqual(kinds(NEURON_INSTALL.pip), ['cmd:python', 'flag:-m', 'text:pip', 'text:install', 'flag:--pre', 'text:neuroncli']);
  assert.deepEqual(kinds(NEURON_INSTALL.cmd).slice(-4), ['cmd:"irm', 'text:https://zero-x.live/install.ps1', 'op:|', 'run:iex"']);

  const barWindow = ({ua = '', platform = '', stored = null, storage = true} = {}) => {
    const win = {
      written: [], saved: null, timers: [],
      navigator: {userAgent: ua, platform, clipboard: {writeText: async text => { win.written.push(text); }}},
      setTimeout: (fn, ms) => { win.timers.push({fn, ms}); return win.timers.length; }, clearTimeout() {},
    };
    if (storage) win.localStorage = {getItem: () => stored, setItem: (key, value) => { win.saved = [key, value]; }};
    else Object.defineProperty(win, 'localStorage', {get() { throw new Error('SecurityError'); }});
    return win;
  };
  const mount = (file, options) => {
    const doc = parseDocument(read(file));
    const win = barWindow(options);
    const bars = bar.installBars(doc, win);
    return {doc, win, bars, roots: doc.querySelectorAll('[data-install-bar]')};
  };
  const shown = root => root.querySelector('.zx-getbar__cmd').textContent;
  // Default per system: Windows gets PowerShell, macOS and Linux curl, anything else the page's default.
  for (const [ua, method] of [[WINDOWS_UA, 'powershell'], [MAC_UA, 'shell'], [LINUX_UA, 'shell'], [ANDROID_UA, 'powershell'], ['', 'powershell']]) {
    const {bars, roots} = mount('index.html', {ua});
    assert.equal(bars.length, 3, 'index.html: three install bars');
    for (const root of roots) assert.equal(shown(root), NEURON_INSTALL[method], `${ua || 'unknown system'}: shows the ${method} command`);
  }
  // An earlier pick wins over the system; blocked storage changes nothing.
  assert.equal(shown(mount('download.html', {ua: WINDOWS_UA, stored: 'npm'}).roots[0]), NEURON_INSTALL.npm, 'the remembered pick');
  assert.equal(shown(mount('download.html', {ua: WINDOWS_UA, stored: 'brew'}).roots[0]), NEURON_INSTALL.powershell, 'an unknown remembered pick is ignored');
  assert.equal(shown(mount('download.html', {ua: MAC_UA, storage: false}).roots[0]), NEURON_INSTALL.shell, 'storage that throws');

  const {doc, win, roots} = mount('index.html', {ua: MAC_UA});
  const hero = roots[0];
  const code = hero.querySelector('.zx-getbar__cmd');
  assert.equal(code.querySelector('.zx-tok-cmd').textContent, 'curl', 'the command word is tinted');
  assert.equal(code.querySelector('.zx-tok-op').textContent, '|');
  assert.equal(code.querySelector('.zx-tok-run').textContent, 'sh');
  const button = hero.querySelector('button.zx-getbar__pick');
  assert.ok(button && !hero.querySelector('span.zx-getbar__pick'), 'the label became a button');
  const menu = doc.getElementById(button.getAttribute('aria-controls'));
  assert.equal(button.getAttribute('aria-haspopup'), 'menu');
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  assert.equal(button.textContent.trim(), 'Get Neuron');
  assert.equal(button.getAttribute('aria-label'), 'Get Neuron, install method: macOS / Linux');
  assert.ok(menu && menu.getAttribute('role') === 'menu' && menu.hidden, 'a closed menu');
  const items = menu.querySelectorAll('[role="menuitemradio"]');
  assert.deepEqual(items.map(item => item.textContent), ['Windows (PowerShell)', 'Windows (Command Prompt)', 'macOS / Linux', 'npm', 'pip']);
  assert.deepEqual(items.map(item => item.getAttribute('aria-checked')), ['false', 'false', 'true', 'false', 'false']);
  assert.ok(items.every(item => item.getAttribute('tabindex') === '-1' && item.getAttribute('type') === 'button'));
  // Open: focus moves to the checked item; arrows move, Escape closes and focus returns to the button.
  button.click();
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.equal(menu.hidden, false);
  assert.equal(doc.activeElement, items[2], 'focus on the checked item');
  items[2].dispatchEvent(makeEvent('keydown', {key: 'ArrowDown', bubbles: true}));
  assert.equal(doc.activeElement, items[3]);
  items[3].dispatchEvent(makeEvent('keydown', {key: 'End', bubbles: true}));
  assert.equal(doc.activeElement, items[4]);
  items[4].dispatchEvent(makeEvent('keydown', {key: 'ArrowDown', bubbles: true}));
  assert.equal(doc.activeElement, items[0], 'wraps around');
  items[0].dispatchEvent(makeEvent('keydown', {key: 'Escape', bubbles: true}));
  assert.equal(menu.hidden, true, 'Escape closes');
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  assert.equal(doc.activeElement, button, 'focus returns to the button');
  assert.equal(shown(hero), NEURON_INSTALL.shell, 'Escape changes nothing');
  // ArrowUp on the button opens on the last item; a click outside closes.
  button.dispatchEvent(makeEvent('keydown', {key: 'ArrowUp', bubbles: true}));
  assert.equal(doc.activeElement, items[4]);
  doc.body.click();
  assert.equal(menu.hidden, true, 'a click outside closes');
  // Picking a method updates every bar on the page, remembers it, and the copy button copies it.
  button.click();
  items[4].click();
  assert.equal(menu.hidden, true);
  assert.equal(doc.activeElement, button);
  for (const root of roots) assert.equal(shown(root), NEURON_INSTALL.pip, 'every bar follows the pick');
  assert.deepEqual(win.saved, ['zx-install-method', 'pip']);
  assert.equal(items[4].getAttribute('aria-checked'), 'true');
  assert.equal(button.getAttribute('aria-label'), 'Get Neuron, install method: pip');
  assert.equal(hero.querySelector('.zx-getbar__scroll').getAttribute('aria-label'), 'pip install command');
  copyButtons(doc, win);
  hero.querySelector('button.zx-copy').click();
  await settle();
  assert.equal(win.written.at(-1), NEURON_INSTALL.pip, 'copies the chosen command');
  assert.equal(hero.querySelector('button.zx-copy').getAttribute('data-state'), 'copied', 'shows the check');
  // Bound once.
  assert.deepEqual(bar.installBars(doc, win), [], 'a second call wires nothing');
  assert.equal(doc.querySelectorAll('[role="menu"]').length, 3);
  console.log('ok - install-bar.js: per-system default (Windows PowerShell, macOS and Linux curl), remembered pick, tinted command, accessible menu (arrows, Escape, outside click), every bar follows the pick and copy copies it');
}

/* ───────────── Live model pane (home.js) ───────────── */

{
  const {liveModels} = await import(new URL('home.js', root));
  const mount = status => {
    const doc = parseDocument(read('index.html'));
    const pane = {doc, clock: Date.parse('2026-11-05T10:00:00Z'), up: true, timers: new Map(), ticks: [], next: 1};
    const win = {
      setTimeout: (fn, ms) => { const id = pane.next++; pane.timers.set(id, {fn, at: pane.clock + ms}); return id; },
      clearTimeout: id => { pane.timers.delete(id); },
      setInterval: fn => { pane.ticks.push(fn); return 0; },
    };
    const models = {object: 'list', data: [
      {id: 'openai/gpt-oss-120b', model_name: 'GPT-OSS 120B', maker: 'openai', context_window: 8000, tiers: ['free'], available: true, status: 'available'},
      {id: 'nvidia/nemotron-3-ultra-550b', model_name: 'Nemotron 3 Ultra 550B', maker: 'nvidia', context_window: 131072, tiers: ['free'], available: true, status: 'degraded'}]};
    const fetchImpl = async path => {
      if (!pane.up) throw new TypeError('gateway unreachable');
      if (path === '/v1/models') return json(200, models);
      assert.equal(path, '/v1/models/status');
      return json(200, status(pane.clock));
    };
    pane.advance = async seconds => {
      pane.clock += seconds * 1000;
      for (const [id, timer] of [...pane.timers].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at > pane.clock || !pane.timers.has(id)) continue;
        pane.timers.delete(id);
        timer.fn();
        await settle();
      }
      pane.ticks.forEach(fn => fn());
    };
    pane.view = () => ({
      live: doc.getElementById('models-live-text').textContent,
      note: doc.getElementById('models-note').textContent,
      rows: doc.querySelectorAll('#models-list .zx-model').map(row => [row.dataset.tone, row.querySelector('.zx-model__status').textContent]),
    });
    liveModels(doc, win, {fetchImpl, clock: () => pane.clock});
    return pane;
  };
  const checked = clock => ({object: 'list', checked_at: new Date(clock - 5000).toISOString(), poll_interval_seconds: 30, stale_after_seconds: 1200, data: [
    {id: 'openai/gpt-oss-120b', available: true, status: 'available'}, {id: 'nvidia/nemotron-3-ultra-550b', available: true, status: 'degraded'}]});

  // Live, then the gateway stops answering: the last verdicts stand for one missed poll, then every row reads unknown.
  const pane = mount(checked);
  await settle();
  let view = pane.view();
  assert.equal(view.live, 'Live · checked 5 s ago', 'the indicator is the health checker time');
  assert.deepEqual(view.rows, [['ok', 'Available'], ['warn', 'Slower than usual']]);
  assert.match(view.note, /^1 of 2 models available on the Free plan right now/);
  pane.up = false;
  await pane.advance(30);
  view = pane.view();
  assert.match(view.live, /^Reconnecting · last checked/);
  assert.deepEqual(view.rows, [['ok', 'Available'], ['warn', 'Slower than usual']], 'one missed poll keeps the last verdicts');
  await pane.advance(31);
  view = pane.view();
  assert.match(view.live, /^Reconnecting · last checked 1 min ago/);
  assert.deepEqual(view.rows, [['unknown', 'Not checked recently'], ['unknown', 'Not checked recently']], 'unchecked verdicts are never shown as available');
  assert.match(view.note, /not being checked right now/);
  assert.doesNotMatch(view.note, /available on the Free plan/);
  pane.up = true;
  await pane.advance(30);
  view = pane.view();
  assert.equal(view.live, 'Live · checked 5 s ago', 'the pane recovers when the gateway answers again');
  assert.deepEqual(view.rows, [['ok', 'Available'], ['warn', 'Slower than usual']]);
  assert.match(view.note, /^1 of 2 models available/);

  // Verdicts older than stale_after_seconds expire even sooner than two polls.
  const old = mount(clock => ({...checked(clock), checked_at: new Date(clock - 50000).toISOString(), stale_after_seconds: 60}));
  await settle();
  old.up = false;
  await old.advance(30);
  assert.deepEqual(old.view().rows.map(row => row[0]), ['unknown', 'unknown'], 'the health checker last looked 80 s ago, past its 60 s limit');

  // Per-route horizons (contract section 15.2) while the gateway keeps answering: a verdict expires
  // once it outlives its own route's horizon, between polls, and the other rows keep theirs.
  const t0 = Date.parse('2026-11-05T10:00:00Z');
  const perRow = mount(() => ({object: 'list', checked_at: new Date(t0 - 20 * 60000).toISOString(), poll_interval_seconds: 30, stale_after_seconds: 1200, data: [
    {id: 'openai/gpt-oss-120b', available: true, status: 'available', availability: 'available', checked_at: new Date(t0 - 60 * 60000).toISOString(), stale_after_seconds: 5400},
    {id: 'nvidia/nemotron-3-ultra-550b', available: true, status: 'available', availability: 'available', checked_at: new Date(t0 - 20 * 60000).toISOString(), stale_after_seconds: 1350}]}));
  await settle();
  assert.deepEqual(perRow.view().rows, [['ok', 'Available'], ['ok', 'Available']], 'both verdicts within their horizons');
  await perRow.advance(180);
  assert.match(perRow.view().live, /^Live/, 'the gateway still answers');
  assert.deepEqual(perRow.view().rows, [['ok', 'Available'], ['unknown', 'Not checked recently']],
    'the NVIDIA verdict (22.5 min) expired; the hourly-checked Groq one (90 min) still stands');
  assert.match(perRow.view().note, /^1 of 2 models available/);
  // A gateway alpha.4 reads: status says blurred, availability says unavailable; the site greys it out.
  const split = mount(clock => ({...checked(clock), data: [
    {id: 'openai/gpt-oss-120b', available: true, status: 'blurred', availability: 'unavailable', checked_at: new Date(clock - 5000).toISOString(), stale_after_seconds: 5400},
    {id: 'nvidia/nemotron-3-ultra-550b', available: true, status: 'unknown', availability: 'unknown'}]}));
  await settle();
  assert.deepEqual(split.view().rows, [['off', 'Temporarily unavailable'], ['unknown', 'Not checked recently']]);

  // No checked_at (the health checker has checked nothing yet): no time is invented.
  const fresh = mount(clock => ({...checked(clock), checked_at: null, data: [{id: 'openai/gpt-oss-120b', available: true, status: 'unknown'}]}));
  await settle();
  assert.equal(fresh.view().live, 'Live · not checked yet');
  assert.deepEqual(fresh.view().rows[0], ['unknown', 'Not checked recently']);
}

/* ───────────── Site header menu on phones (site-nav.js) ───────────── */

{
  const {installNav} = await import(new URL('site-nav.js', root));
  for (const file of ['index.html', 'pricing.html', 'docs/trust.html', 'dashboard.html']) {
    const doc = parseDocument(read(file));
    const header = doc.querySelector('.zx-header');
    const button = header.querySelector('.zx-nav-toggle');
    const nav = doc.getElementById('site-nav');
    assert.equal(button.hidden, true, `${file}: without the script the menu button is hidden (the wrapped nav shows)`);
    assert.equal(header.dataset.nav, undefined, `${file}: and the header is not in menu mode`);
    // Review 2026-11-05: menu mode is chosen before first paint by the inline script right after
    // </header>, not when the module runs (which follows the page's other modules), so the header
    // never paints as three wrapped rows and then jumps up. Browsers without modules keep the
    // wrapped nav (site-nav.js would never wire the button).
    const preset = [...read(file).matchAll(/<\/header>\s*<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    assert.equal(preset.length, 1, `${file}: one inline script right after </header>`);
    const legacy = parseDocument(read(file));
    vm.runInNewContext(preset[0], {document: legacy, HTMLScriptElement: {prototype: {}}});
    assert.deepEqual([legacy.querySelector('.zx-header').dataset.nav, legacy.querySelector('.zx-nav-toggle').hidden], [undefined, true],
      `${file}: no module support: the wrapped nav stays`);
    vm.runInNewContext(preset[0], {document: doc, HTMLScriptElement: {prototype: {noModule: false}}});
    assert.deepEqual([header.dataset.nav, button.hidden], ['closed', false], `${file}: menu mode before the module runs`);
    const menu = installNav(doc);
    assert.ok(menu, `${file}: the header has a menu`);
    assert.equal(button.hidden, false, `${file}: the script shows the button`);
    assert.deepEqual([button.getAttribute('aria-expanded'), button.getAttribute('aria-controls'), header.dataset.nav], ['false', 'site-nav', 'closed']);
    assert.equal(nav.getAttribute('aria-label'), 'Main');
    button.click();
    assert.deepEqual([button.getAttribute('aria-expanded'), header.dataset.nav], ['true', 'open'], `${file}: the button opens the nav`);
    button.click();
    assert.deepEqual([button.getAttribute('aria-expanded'), header.dataset.nav], ['false', 'closed'], `${file}: and closes it`);
    // Escape closes it and puts focus back on the button.
    button.click();
    const link = nav.querySelector('a');
    link.focus();
    const escape = makeEvent('keydown', {bubbles: true, cancelable: true, key: 'Escape'});
    link.dispatchEvent(escape);
    assert.equal(menu.isOpen(), false, `${file}: Escape closes the menu`);
    assert.equal(escape.defaultPrevented, true);
    assert.equal(doc.activeElement, button, `${file}: focus returns to the Menu button`);
    // Safari does not focus a button on click: after a tap on Menu the focus stays on the body,
    // and Escape from a hardware keyboard still closes the menu.
    button.click();
    doc.body.focus();
    const bodyEscape = makeEvent('keydown', {bubbles: true, cancelable: true, key: 'Escape'});
    doc.body.dispatchEvent(bodyEscape);
    assert.equal(menu.isOpen(), false, `${file}: Escape with focus on the body closes the menu`);
    assert.equal(bodyEscape.defaultPrevented, true);
    assert.equal(doc.activeElement, button, `${file}: and focus moves to the Menu button`);
    // Escape with the menu closed does nothing.
    const idle = makeEvent('keydown', {bubbles: true, cancelable: true, key: 'Escape'});
    button.dispatchEvent(idle);
    assert.equal(idle.defaultPrevented, false);
    // Following a link closes it; so does a click outside the header or focus leaving it.
    button.click();
    link.click();
    assert.equal(menu.isOpen(), false, `${file}: following a link closes the menu`);
    button.click();
    doc.querySelector('main').click();
    assert.equal(menu.isOpen(), false, `${file}: a click outside closes it`);
    button.click();
    header.querySelector('.zx-brand').click();
    assert.equal(menu.isOpen(), true, `${file}: a click inside the header leaves it open`);
    const leave = makeEvent('focusout', {bubbles: true});
    leave.relatedTarget = doc.querySelector('main');
    link.dispatchEvent(leave);
    assert.equal(menu.isOpen(), false, `${file}: focus leaving the header closes it`);
  }
  assert.equal(installNav(parseDocument('<!doctype html><html><head></head><body><main id="main"></main></body></html>')), null, 'no header: nothing to wire');
  console.log('ok - site header menu: a disclosure button (aria-expanded, aria-controls), Escape returns focus, link, outside click and focus loss close it, hidden without the script');
}

/* ───────────── Dark/light switch (site-nav.js installThemeToggle) ───────────── */

{
  const {installThemeToggle, THEME_KEY} = await import(new URL('site-nav.js', root));
  assert.equal(THEME_KEY, 'zx-theme');
  const media = dark => {
    const mql = {matches: dark, media: '(prefers-color-scheme: dark)', listeners: [], addEventListener(type, fn) { if (type === 'change') this.listeners.push(fn); }};
    mql.flip = value => { mql.matches = value; for (const fn of mql.listeners) fn({matches: value}); };
    return mql;
  };
  const windowStub = () => ({listeners: {}, addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }, fire(type, event) { for (const fn of this.listeners[type] || []) fn(event); }});
  const mount = ({file = 'index.html', dark = false, storage = makeStorage(), preset} = {}) => {
    const doc = parseDocument(read(file));
    if (preset) doc.documentElement.setAttribute('data-theme', preset);
    const mql = media(dark);
    const win = windowStub();
    const control = installThemeToggle(doc, {storage, matchMedia: () => mql, win});
    const button = doc.querySelector('.zx-theme-toggle');
    const view = () => ({theme: doc.documentElement.getAttribute('data-theme'), pressed: button.getAttribute('aria-pressed'), title: button.getAttribute('title'), label: button.getAttribute('aria-label'),
      colors: doc.querySelectorAll('meta[name="theme-color"]').map(m => m.getAttribute('content'))});
    return {doc, mql, win, control, button, view, storage};
  };
  for (const file of ['index.html', 'docs/trust.html', 'dashboard.html', '404.html']) {
    // System light, nothing saved: the button offers dark mode and the page is left to the system.
    const light = mount({file});
    assert.ok(light.control, `${file}: the header has a theme switch`);
    assert.deepEqual(light.view(), {theme: null, pressed: 'false', title: 'Switch to dark mode', label: 'Dark mode', colors: ['#FFFFFF', '#141413']}, `${file}: follows a light system`);
    light.button.click();
    assert.equal(light.storage.map.get('zx-theme'), 'dark', `${file}: dark is saved`);
    assert.deepEqual(light.view(), {theme: 'dark', pressed: 'true', title: 'Switch to light mode', label: 'Dark mode', colors: ['#141413', '#141413']}, `${file}: dark is applied, both theme-color tags follow`);
    light.button.click();
    assert.equal(light.storage.map.has('zx-theme'), false, `${file}: back to the system choice removes the key (two states)`);
    assert.deepEqual(light.view(), {theme: null, pressed: 'false', title: 'Switch to dark mode', label: 'Dark mode', colors: ['#FFFFFF', '#141413']}, `${file}: and restores the system theme-color tags`);
  }
  // System dark: the button starts pressed and offers light mode.
  const dark = mount({dark: true});
  assert.deepEqual([dark.view().theme, dark.view().pressed, dark.view().title], [null, 'true', 'Switch to light mode'], 'a dark system shows dark mode pressed');
  dark.button.click();
  assert.deepEqual([dark.storage.map.get('zx-theme'), dark.view().theme, dark.view().pressed, dark.view().colors], ['light', 'light', 'false', ['#FFFFFF', '#FFFFFF']], 'light is saved and applied');
  dark.button.click();
  assert.deepEqual([dark.storage.map.has('zx-theme'), dark.view().theme, dark.view().pressed], [false, null, 'true'], 'dark again equals the system: the key is removed');
  // A saved choice the head script already applied is read back on load.
  const saved = mount({storage: makeStorage({'zx-theme': 'dark'}), preset: 'dark'});
  assert.deepEqual([saved.view().theme, saved.view().pressed, saved.control.theme()], ['dark', 'true', 'dark'], 'a saved dark choice on a light system');
  // Junk in storage is ignored.
  const junk = mount({storage: makeStorage({'zx-theme': 'purple'})});
  assert.deepEqual([junk.view().theme, junk.view().pressed], [null, 'false'], 'an unknown saved value falls back to the system');
  // Storage that throws (private window, blocked site data): the switch still works for this page.
  const broken = {getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); }};
  const blocked = mount({storage: broken});
  assert.deepEqual([blocked.view().theme, blocked.view().pressed], [null, 'false'], 'throwing storage: follows the system');
  blocked.button.click();
  assert.deepEqual([blocked.view().theme, blocked.view().pressed], ['dark', 'true'], 'throwing storage: a click still switches the page');
  blocked.button.click();
  assert.deepEqual([blocked.view().theme, blocked.view().pressed], [null, 'false'], 'throwing storage: and back');
  const presetBlocked = mount({storage: broken, preset: 'dark'});
  assert.equal(presetBlocked.view().pressed, 'true', 'throwing storage: the theme already on <html> is kept');
  const noStorage = mount({storage: null});
  noStorage.button.click();
  assert.equal(noStorage.view().theme, 'dark', 'no storage at all: still switches');
  // Another tab changes the theme: the storage event keeps this page in step.
  const tab = mount();
  tab.storage.map.set('zx-theme', 'dark');
  tab.win.fire('storage', {key: 'zx-theme', newValue: 'dark'});
  assert.deepEqual([tab.view().theme, tab.view().pressed, tab.view().title], ['dark', 'true', 'Switch to light mode'], 'storage event: dark from another tab');
  tab.win.fire('storage', {key: 'something-else', newValue: 'x'});
  assert.equal(tab.view().theme, 'dark', 'storage event for another key: ignored');
  tab.storage.map.delete('zx-theme');
  tab.win.fire('storage', {key: 'zx-theme', newValue: null});
  assert.deepEqual([tab.view().theme, tab.view().pressed], [null, 'false'], 'storage event: key removed, back to the system');
  tab.storage.map.set('zx-theme', 'dark');
  tab.win.fire('storage', {key: null, newValue: null});
  assert.equal(tab.view().theme, 'dark', 'storage event for clear(): re-read');
  // The system theme changes while nothing is saved: the button state follows it.
  const system = mount();
  system.mql.flip(true);
  assert.deepEqual([system.view().theme, system.view().pressed, system.view().title], [null, 'true', 'Switch to light mode'], 'system switched to dark');
  system.button.click();
  assert.equal(system.storage.map.get('zx-theme'), 'light', 'then a click saves light');
  // A page without the header button: nothing to wire.
  assert.equal(installThemeToggle(parseDocument('<!doctype html><html><head></head><body><main id="main"></main></body></html>'), {storage: makeStorage(), matchMedia: () => media(false), win: windowStub()}), null, 'no button: nothing to wire');
  // The head preset: adds html.zx-js (only where module scripts run, the same guard as the Menu
  // button, so the button never shows without site-nav.js), applies a saved choice and survives
  // throwing storage.
  const preset = /<script>(\(function\(d\)\{if\('noModule'in HTMLScriptElement\.prototype\)d\.classList\.add\('zx-js'\)[\s\S]*?)<\/script>/.exec(read('index.html'))[1];
  const MODULES = {prototype: {noModule: false}};
  for (const [store, expected] of [[{getItem: () => 'dark'}, 'dark'], [{getItem: () => 'light'}, 'light'], [{getItem: () => 'purple'}, null], [{getItem() { throw new Error('blocked'); }}, null]]) {
    const doc = parseDocument(read('index.html'));
    vm.runInNewContext(preset, {document: doc, localStorage: store, HTMLScriptElement: MODULES});
    assert.deepEqual([doc.documentElement.classList.contains('zx-js'), doc.documentElement.getAttribute('data-theme')], [true, expected], 'head preset: zx-js and data-theme ' + expected);
  }
  {
    // No module support: no zx-js (the button stays hidden), but a saved theme still applies.
    const doc = parseDocument(read('index.html'));
    vm.runInNewContext(preset, {document: doc, localStorage: {getItem: () => 'dark'}, HTMLScriptElement: {prototype: {}}});
    assert.deepEqual([doc.documentElement.classList.contains('zx-js'), doc.documentElement.getAttribute('data-theme')], [false, 'dark'], 'head preset without modules: no zx-js, saved theme applied');
  }
  console.log('ok - theme switch: flips the effective theme, saves only a choice that differs from the system (else removes zx-theme), syncs aria-pressed, title and both theme-color tags, follows storage and system changes, survives throwing storage; the head preset applies it before paint');
}

/* ───────────── Signed-in account in the header (site-nav.js installAccountChip) ───────────── */

{
  const {installAccountChip, readSessionCookie, accountFromSession, safeAvatar, initialsFor, isLiveSession, pageOwnsAccountChip, AUTH_COOKIE, AVATAR_HOSTS} = await import(new URL('site-nav.js', root));
  assert.equal(AUTH_COOKIE, 'zerox-supabase-auth');
  // The avatar hosts match the CSP img-src allow-list.
  const cspSource = readFileSync(new URL('src/csp.js', import.meta.url), 'utf8');
  for (const host of AVATAR_HOSTS) assert.ok(cspSource.includes("'https://" + host + "'"), host + ' is allowed by img-src');
  // Cookies exactly as zerox-auth.js writes them: encodeURIComponent'd, chunked with a .parts count.
  const cookieFor = (session, chunk = 0) => {
    const raw = JSON.stringify(session);
    if (!chunk) return encodeURIComponent(AUTH_COOKIE) + '=' + encodeURIComponent(raw);
    const parts = raw.match(new RegExp('[\\s\\S]{1,' + chunk + '}', 'g'));
    return ['theme=dark', AUTH_COOKIE + '.parts=' + parts.length, ...parts.map((p, i) => AUTH_COOKIE + '.' + i + '=' + encodeURIComponent(p))].join('; ');
  };
  const b64url = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const GOOGLE = 'https://lh3.googleusercontent.com/a/ACg8ocK=s96-c';
  const user = (meta, email = 'ada@example.com') => ({id: 'u1', email, user_metadata: meta});
  // A stored session as supabase-js keeps it: with a refresh token (without one it is signed out).
  const live = s => ({refresh_token: 'r', ...s});
  const mount = (cookie, file = 'index.html') => {
    const doc = parseDocument(read(file));
    doc.cookie = cookie;
    const account = installAccountChip(doc);
    return {doc, account, link: doc.querySelector('.zx-header .zx-nav a.zx-btn')};
  };
  const snapshot = link => [link.getAttribute('aria-label'), link.getAttribute('title'), link.hasAttribute('data-signed-in'), link.querySelectorAll('.zx-nav-avatar').length, link.querySelectorAll('svg').length];

  // No cookie: the Dashboard button is untouched.
  const none = mount('');
  assert.equal(none.account, null);
  assert.deepEqual(snapshot(none.link), [null, null, false, 0, 1], 'signed out: nothing changes');
  assert.equal(none.link.textContent, 'Dashboard');
  // Unrelated or broken cookies: still untouched, no throw.
  for (const junk of ['theme=dark', AUTH_COOKIE + '=%E0%A4%A', AUTH_COOKIE + '=not-json', AUTH_COOKIE + '.parts=3; ' + AUTH_COOKIE + '.0=%7B', AUTH_COOKIE + '.parts=999']) {
    assert.deepEqual(snapshot(mount(junk).link), [null, null, false, 0, 1], 'junk cookie ' + JSON.stringify(junk) + ': untouched');
  }
  // A thrown doc.cookie getter is tolerated.
  {
    const doc = parseDocument(read('index.html'));
    Object.defineProperty(doc, 'cookie', {get() { throw new Error('blocked'); }});
    assert.equal(installAccountChip(doc), null, 'a throwing cookie getter: signed out');
  }

  // Chunked cookie with a Google avatar: a 20 px round <img>, the label and title.
  const session = {access_token: 'x.y.z', refresh_token: 'r', expires_at: 1, user: user({full_name: 'Ada Lovelace', avatar_url: GOOGLE, picture: 'https://evil.example/p.png'})};
  const google = mount(cookieFor(session, 40));
  assert.deepEqual(google.account, {name: 'Ada Lovelace', email: 'ada@example.com', image: GOOGLE});
  const box = google.link.querySelector('.zx-nav-avatar');
  assert.ok(box && google.link.firstChild === box, 'the avatar comes first in the button');
  assert.equal(box.getAttribute('aria-hidden'), 'true');
  const img = box.querySelector('img');
  assert.deepEqual([img.getAttribute('src'), img.getAttribute('alt'), img.getAttribute('referrerpolicy'), img.getAttribute('width'), img.getAttribute('height')], [GOOGLE, '', 'no-referrer', '20', '20']);
  assert.equal(google.link.getAttribute('aria-label'), 'Dashboard, signed in as Ada Lovelace');
  assert.equal(google.link.getAttribute('title'), 'ada@example.com');
  assert.equal(google.link.hasAttribute('data-signed-in'), true);
  assert.equal(google.link.textContent, 'Dashboard', 'the visible text stays "Dashboard"');
  // An image that fails to load falls back to initials.
  img.dispatchEvent(makeEvent('error'));
  assert.deepEqual([box.querySelectorAll('img').length, box.textContent], [0, 'AL'], 'image error: initials');
  // Running again (pageshow) does not add a second avatar; signing out elsewhere restores the button.
  google.doc.cookie = cookieFor(session, 40);
  installAccountChip(google.doc);
  assert.equal(google.link.querySelectorAll('.zx-nav-avatar').length, 1, 'idempotent');
  google.doc.cookie = '';
  installAccountChip(google.doc);
  assert.deepEqual(snapshot(google.link), [null, null, false, 0, 1], 'after sign-out the button is as it was');

  // GitHub picture is allowed; a disallowed host or http falls back to initials.
  assert.equal(safeAvatar('https://avatars.githubusercontent.com/u/1?v=4'), 'https://avatars.githubusercontent.com/u/1?v=4');
  for (const bad of ['http://lh3.googleusercontent.com/a', 'https://evil.example/a.png', 'https://lh3.googleusercontent.com.evil.example/a', 'javascript:alert(1)', '', null]) assert.equal(safeAvatar(bad), '', 'rejected ' + bad);
  const other = mount(cookieFor(live({user: user({name: 'grace hopper', avatar_url: 'https://evil.example/a.png'}, 'grace@example.com')})));
  assert.deepEqual([other.link.querySelectorAll('img').length, other.link.querySelector('.zx-nav-avatar').textContent], [0, 'GH'], 'disallowed host: initials');
  assert.equal(other.link.getAttribute('aria-label'), 'Dashboard, signed in as grace hopper');
  // An HTML-ish name stays text everywhere (the test DOM throws on innerHTML).
  const XSS_NAME = '<img src=x onerror=alert(1)>';
  const xss = mount(cookieFor(live({user: user({full_name: XSS_NAME})})));
  assert.equal(xss.link.querySelectorAll('img').length, 0, 'no element from the name');
  assert.equal(xss.link.getAttribute('aria-label'), 'Dashboard, signed in as ' + XSS_NAME);
  assert.equal(xss.link.querySelector('.zx-nav-avatar').textContent, '<S', 'initials are text');
  // Name order: full_name > name > user_name > email local part.
  assert.equal(accountFromSession({user: user({name: 'N', user_name: 'U'})}).name, 'N');
  assert.equal(accountFromSession({user: user({user_name: 'octo'})}).name, 'octo');
  assert.equal(accountFromSession({user: user({})}).name, 'ada');
  assert.equal(accountFromSession({user: user({picture: 'https://avatars.githubusercontent.com/u/2'})}).image, 'https://avatars.githubusercontent.com/u/2', 'picture when there is no avatar_url');
  assert.deepEqual([initialsFor('ada'), initialsFor('Ada  Byron Lovelace'), initialsFor('')], ['AD', 'AB', 'ZX']);
  // No session.user: the access token claims are decoded for display only.
  const jwt = 'h.' + b64url({sub: 'u2', email: 'linus@example.com', user_metadata: {full_name: 'Linus Ł'}}) + '.sig';
  const claims = mount(cookieFor(live({access_token: jwt})));
  assert.deepEqual(claims.account, {name: 'Linus Ł', email: 'linus@example.com', image: ''}, 'JWT payload (UTF-8) when the user is not stored');
  assert.equal(accountFromSession({access_token: 'not.a.jwt'}), null);
  assert.equal(readSessionCookie(encodeURIComponent(AUTH_COOKIE) + '=base64-' + b64url({user: user({})}))?.user.email, 'ada@example.com', 'base64- prefixed values');
  // A cookie whose session cannot be refreshed (no or empty refresh token, expired or not) shows
  // signed out; an expired access token with a refresh token still shows the account.
  const nowSec = Math.floor(Date.now() / 1000);
  for (const dead of [{user: user({full_name: 'Ada'})}, {refresh_token: '', user: user({full_name: 'Ada'})}, {refresh_token: null, expires_at: nowSec - 60, user: user({full_name: 'Ada'})}, {access_token: jwt, expires_at: nowSec + 3600}]) {
    const m = mount(cookieFor(dead));
    assert.equal(m.account, null, 'no refresh token: signed out ' + JSON.stringify(dead).slice(0, 60));
    assert.deepEqual(snapshot(m.link), [null, null, false, 0, 1], 'no refresh token: the button is untouched');
  }
  assert.equal(mount(cookieFor({refresh_token: 'r', expires_at: nowSec - 3600, user: user({full_name: 'Ada'})})).account?.name, 'Ada', 'expired access token with a refresh token: signed in');
  assert.deepEqual([isLiveSession(null), isLiveSession({refresh_token: 'r'}), isLiveSession({refresh_token: 1})], [false, true, false]);
  // Sign-out in another tab of a page restored from the back/forward cache resets the chip.
  const restored = mount(cookieFor(session));
  restored.doc.cookie = cookieFor({...session, refresh_token: ''});
  assert.equal(installAccountChip(restored.doc), null);
  assert.deepEqual(snapshot(restored.link), [null, null, false, 0, 1], 'pageshow after sign-out elsewhere: signed out');
  // The dashboard draws its own chip from the profile, so site-nav.js leaves it alone (load and pageshow).
  assert.equal(pageOwnsAccountChip(parseDocument(read('dashboard.html'))), true, 'dashboard.html owns its chip');
  for (const file of ['index.html', 'docs.html', '404.html']) assert.equal(pageOwnsAccountChip(parseDocument(read(file))), false, file + ': site-nav.js draws the chip');
  assert.match(read('site-nav.js'), /if \(!pageOwnsAccountChip\(document\)\) installAccountChip\(document\);/, 'the bootstrap skips pages that own the chip');
  assert.match(read('site-nav.js'), /event\.persisted && !pageOwnsAccountChip\(document\)\) installAccountChip\(document\)/, 'pageshow skips pages that own the chip');
  // Every page with the shared header gets the chip on its Dashboard button.
  for (const file of ['docs.html', 'pricing.html', 'docs/trust.html', '404.html']) {
    assert.equal(mount(cookieFor(session, 100), file).link.getAttribute('aria-label'), 'Dashboard, signed in as Ada Lovelace', file + ': chip');
  }
  // Styles: 20 px round, the generic icon hidden only when signed in, both themes via tokens.
  const css = read('zx-tokens.css');
  assert.match(css, /^\.zx-nav-avatar \{[^}]*width: 20px; height: 20px;[^}]*border-radius: 50%;[^}]*background: var\(--zx-surface-strong\);[^}]*color: var\(--zx-ink\)/m, '.zx-nav-avatar: 20 px round, token colours');
  assert.match(css, /^\.zx-nav-avatar img, \.zx-crumbs__avatar img \{[^}]*object-fit: cover;/m, 'avatar images fill the circle');
  assert.match(css, /^\.zx-btn\[data-signed-in\] > \.zx-icon \{ display: none; \}$/m, 'the user icon hides when the avatar shows');
  console.log('ok - account chip: reads the (chunked) Supabase cookie without a network call, shows an allowed avatar or initials on the Dashboard button with an accessible label, leaves signed-out pages untouched');
}

/* ───────────── Copy buttons (copy-code.js) ───────────── */

{
  const {copyButtons} = await import(new URL('copy-code.js', root));
  const copyWindow = writeText => {
    const timers = [];
    const win = {written: [], timers, selected: null,
      navigator: writeText === null ? {} : {clipboard: {writeText: writeText || (async value => { win.written.push(value); })}},
      setTimeout(fn, ms) { timers.push({fn, ms}); return timers.length; }, clearTimeout(id) { if (timers[id - 1]) timers[id - 1].fn = () => {}; },
      getSelection() { return {removeAllRanges() { win.selected = null; }, addRange(range) { win.selected = range.node; }}; }};
    return win;
  };
  for (const file of ['neuron-cli.html', 'docs.html', 'ai-coding-agent.html', 'free-ai-coding-agent.html', 'claude-code-alternative.html', 'index.html', 'download.html']) {
    const doc = parseDocument(read(file));
    doc.createRange = () => ({node: null, selectNodeContents(node) { this.node = node; }});
    const win = copyWindow();
    copyButtons(doc, win);
    copyButtons(doc, win); // idempotent: a second call binds nothing twice
    const buttons = doc.querySelectorAll('button[data-copy-target]');
    assert.ok(buttons.length > 0, file + ': copy buttons');
    for (const button of buttons) {
      assert.equal(button.hidden, false, file + ': visible with a clipboard');
      const target = doc.getElementById(button.dataset.copyTarget);
      button.click();
      await settle();
      assert.equal(win.written.length, 1, `${file} #${button.dataset.copyTarget}: one write per click after two copyButtons calls`);
      assert.equal(win.written.pop(), target.textContent.trim(), file + ': copies the trimmed command text');
      assert.equal(button.getAttribute('data-state'), 'copied', file + ': shows the check');
      assert.equal(doc.getElementById('copy-status').textContent, `Copied the ${button.dataset.copyLabel} to the clipboard.`);
      assert.equal(win.timers.at(-1).ms, 2000, 'resets after two seconds');
      win.timers.at(-1).fn();
      assert.equal(button.hasAttribute('data-state'), false, file + ': back to the copy icon');
    }
  }
  // neuron-cli.html: the exact multi-line text, entities decoded.
  {
    const doc = parseDocument(read('neuron-cli.html'));
    const win = copyWindow();
    copyButtons(doc, win);
    doc.querySelector('[data-copy-target="run-start"]').click();
    await settle();
    assert.equal(win.written[0], 'cd path/to/your-project\nneuron');
    doc.querySelector('[data-copy-target="install-cmd"]').click();
    await settle();
    assert.equal(win.written[1], NEURON_INSTALL.powershell);
  }
  // Clipboard refused: the command is selected and the live region gives the keyboard shortcut.
  {
    const doc = parseDocument(read('neuron-cli.html'));
    doc.createRange = () => ({node: null, selectNodeContents(node) { this.node = node; }});
    const win = copyWindow(async () => { throw new Error('NotAllowedError'); });
    copyButtons(doc, win);
    const button = doc.querySelector('[data-copy-target="hero-cmd"]');
    button.click();
    await settle();
    assert.equal(win.selected, doc.getElementById('hero-cmd'), 'the command text is selected');
    assert.equal(button.getAttribute('data-state'), 'selected');
    assert.equal(button.getAttribute('title'), 'Press Ctrl+C to copy', 'the tooltip gives the shortcut while selected');
    assert.match(doc.getElementById('copy-status').textContent, /Copying is blocked here\. The install command is selected; press Ctrl\+C, or Cmd\+C on a Mac\./);
    win.timers.at(-1).fn();
    assert.equal(button.hasAttribute('data-state'), false);
    assert.equal(button.getAttribute('title'), 'Copy', 'the tooltip resets with the icon');
  }
  // No clipboard API (or a missing target): the button is hidden rather than left doing nothing.
  {
    const doc = parseDocument(read('docs.html'));
    copyButtons(doc, copyWindow(null));
    assert.ok(doc.querySelectorAll('button[data-copy-target]').every(button => button.hidden), 'no clipboard: buttons hidden');
    const orphan = parseDocument('<div class="zx-code zx-code--copy"><pre><code id="a">x</code></pre><button class="zx-copy" type="button" data-copy-target="missing">c</button></div>');
    copyButtons(orphan, copyWindow());
    assert.equal(orphan.querySelector('button').hidden, true, 'missing target: hidden');
    const bare = parseDocument('<main></main>');
    copyButtons(bare, copyWindow()); // no buttons, no live region: nothing throws
  }
  console.log('ok - copy-code.js: every command block copies its trimmed text once per click (idempotent binding), shows the check for 2 s and announces it; refused clipboard selects the text with a Ctrl+C hint; no clipboard hides the button');
}

/* ───────────── Announcement bar (announce.js) ───────────── */

{
  const {installAnnounce, DISMISSED_KEY} = await import(new URL('announce.js', root));
  const html = read('index.html');
  const fresh = () => parseDocument(html);
  const memory = () => { const m = new Map(); return {getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), map: m}; };
  // Without the script the bar shows and its close button is hidden (nothing that does nothing).
  const bare = fresh();
  assert.equal(bare.querySelector('.zx-announce__close').hidden, true, 'announce: the close button is hidden until the script runs');
  assert.equal(bare.querySelector('.zx-announce').hidden, false, 'announce: the bar shows without the script');
  // First visit: the button appears; closing hides the bar and remembers the id.
  const doc = fresh();
  const storage = memory();
  const bar = installAnnounce(doc, storage);
  assert.ok(bar, 'announce: the homepage has a bar');
  assert.deepEqual([doc.querySelector('.zx-announce__close').hidden, bar.isHidden()], [false, false], 'announce: first visit shows the bar and its close button');
  doc.querySelector('.zx-announce__close').click();
  assert.equal(bar.isHidden(), true, 'announce: the close button hides the bar');
  assert.equal(storage.map.get(DISMISSED_KEY), doc.querySelector('.zx-announce').dataset.announce, 'announce: the dismissed id is remembered');
  // Next visit: the same id stays hidden; another id shows again.
  const again = fresh();
  assert.equal(installAnnounce(again, storage).isHidden(), true, 'announce: a dismissed bar stays hidden');
  const next = fresh();
  next.querySelector('.zx-announce').dataset.announce = 'something-new';
  assert.equal(installAnnounce(next, storage).isHidden(), false, 'announce: a new announcement shows again');
  // Storage that throws (private window, blocked site data) never breaks the bar.
  const broken = {getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }};
  const blocked = fresh();
  const barB = installAnnounce(blocked, broken);
  blocked.querySelector('.zx-announce__close').click();
  assert.equal(barB.isHidden(), true, 'announce: closing works without storage');
  assert.equal(installAnnounce(parseDocument('<!doctype html><html><body><main id="main"></main></body></html>'), storage), null, 'announce: no bar, nothing to wire');
  console.log('ok - announcement bar: close button hidden without the script, dismissal remembered per announcement id, storage failures ignored');
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
  const page = createPricingPage({doc, win, auth: real.auth, fetchImpl: first.fetchImpl, now: () => NOW, collectDetails: stubDetails});
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
  const page2 = createPricingPage({doc: doc2, win: win2, auth: real.auth, fetchImpl: second.fetchImpl, now: () => NOW, collectDetails: stubDetails});
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
  createPricingPage({doc: parseDocument(read('pricing.html')), win: tab, auth: real.auth, fetchImpl: third.fetchImpl, now: () => NOW, collectDetails: stubDetails}).init(); // stays pending with Razorpay open
  await settle();
  assert.deepEqual(third.calls.find(call => call.path === '/api/billing/checkout').body, {plan: 'max', currency: 'INR', consent: consentFor('subscription')});
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
  assert.match(free.$('pricing-error').textContent, /need an active paid plan/);
  assert.equal(free.$('pricing-error').querySelector('a').getAttribute('href'), 'https://zero-x.live/pricing#plans');
  // The server-side refusal is handled the same way.
  const refused = await mountPricing({profile: PROFILE, routes: {'GET /api/account': accountPayload(),
    'POST /api/billing/topup': apiError(403, 'upgrade_required', 'Credit top-ups are available on the paid plans (Athlete, Speed, Pro and Max). Upgrade first.')}});
  refused.doc.querySelector('[data-topup="credits_5"]').click();
  await settle();
  assert.match(refused.$('pricing-error').textContent, /paid plans \(Athlete, Speed, Pro and Max\)/);
  assert.equal(refused.$('pricing-error').querySelector('a').getAttribute('href'), 'https://zero-x.live/pricing#plans');
}

/* ───────────── Billing details dialog (billing-details.js, the real module) ───────────── */

{
  const {collectBillingDetails} = await import(new URL('billing-details.js', root));
  const DOCS = {terms: {version: '2026-10-25', path: '/terms'}, privacy: {version: '2026-10-25', path: '/privacy'},
    refund: {version: '2026-10-24', path: '/refund'}, auto_renewal: {version: '2026-11-03', path: '/terms#billing'}};
  const OPTIONS = {countries: [{code: 'IN', name: 'India'}, {code: 'US', name: 'United States'}, {code: 'AE', name: 'United Arab Emirates'}],
    states: {IN: [{code: 'KA', name: 'Karnataka'}, {code: 'TN', name: 'Tamil Nadu'}]}, no_postal: ['AE']};
  const SAVED = {customer_type: 'individual', full_name: 'Asha Kumar', business_name: null, country: 'IN', state: 'TN', city: 'Karur', postal_code: '639113',
    address_line1: '6/2 N. Pugalur', address_line2: null, phone: '+919876543210', tax_id: null};
  // GSTINs with a correct check character (check-billing-profile.mjs computes them): Tamil Nadu (33) and Karnataka (29).
  const GSTIN_TN = '33ABCDE1234F1Z7';
  const GSTIN_KA = '29ABCDE1234F1ZW';
  const detailsPayload = (extra = {}) => ({profile: null, complete: false, missing: ['full_name', 'country', 'city', 'postal_code'], documents: DOCS, accepted: {},
    tax: {no_gst_notice: false}, options: OPTIONS, ...extra});
  const returning = (extra = {}) => detailsPayload({profile: SAVED, complete: true, missing: [],
    accepted: {terms: {version: '2026-10-25', accepted_at: '2026-10-20T10:00:00.000Z', current: true}, privacy: {version: '2026-10-25', accepted_at: '2026-10-20T10:00:00.000Z', current: true},
      refund: {version: '2026-10-24', accepted_at: '2026-10-20T10:00:00.000Z', current: true}}, ...extra});
  const checkoutRoute = call => ({provider: 'razorpay', key_id: 'rzp_test_AbCdEf123456', subscription_id: 'sub_TEST12345', name: 'Zero-X', description: call.body.plan + ' plan',
    prefill: {email: 'owner@example.com', name: 'Asha Kumar', contact: '+919876543210'}, notes: {plan: call.body.plan}});
  const dialogOf = doc => doc.querySelector('dialog.zx-dialog--billing');
  const field = (doc, id) => doc.getElementById(id);
  const fill = (doc, values) => {
    for (const [id, value] of Object.entries(values)) {
      const element = field(doc, id);
      element.value = value;
      element.dispatchEvent(makeEvent(element.localName === 'select' ? 'change' : 'input', {bubbles: true}));
    }
  };
  const tick = (doc, ids) => ids.forEach(id => { const box = field(doc, id); box.checked = true; box.dispatchEvent(makeEvent('change', {bubbles: true})); });
  const submit = doc => field(doc, 'bd-submit').click();
  const pricingWith = (routes, extra = {}) => mountPricing({profile: PROFILE, details: collectBillingDetails, routes: {
    'POST /api/billing/checkout': checkoutRoute, 'GET /api/billing/profile': detailsPayload(), ...routes}, ...extra});

  // ── First purchase: the form, its accessibility, validation, the order summary ──
  {
    const t = await pricingWith({'PUT /api/billing/profile': call => json(200, {profile: {...call.body, business_name: null, address_line1: null, address_line2: null, phone: null, state: call.body.state || null}, complete: true, missing: []})},
      {local: makeStorage({'zx-currency': 'INR'})});
    const {doc, calls} = t;
    FakeRazorpay.instances.length = 0;
    doc.querySelector('[data-upgrade="pro"]').click();
    await settle();
    const dialog = dialogOf(doc);
    assert.ok(dialog && dialog.open, 'the details step opens before anything is created');
    assert.equal(dialog.getAttribute('aria-labelledby'), 'bd-title');
    assert.equal(dialog.getAttribute('aria-describedby'), 'bd-intro');
    assert.equal(field(doc, 'bd-title').textContent, 'Billing details');
    assert.ok(calls.some(call => call.path === '/api/billing/profile' && call.method === 'GET' && call.headers.Authorization === 'Bearer sb-access-token'));
    assert.ok(!calls.some(call => call.path === '/api/billing/checkout'), 'no subscription is created until the details are given');
    assert.equal(FakeRazorpay.instances.length, 0, 'Razorpay is not opened yet');
    // Every control has a visible label and the right autocomplete token.
    const labels = new Map(dialog.querySelectorAll('label').map(label => [label.getAttribute('for'), label.textContent]));
    const expectations = {'bd-full-name': ['Full name', 'name'], 'bd-business-name': ['Business name', 'organization'], 'bd-country': ['Country', 'country'],
      'bd-city': ['City', 'address-level2'], 'bd-postal-code': ['Postal code', 'postal-code'], 'bd-address-line1': ['Address line 1', 'address-line1'],
      'bd-address-line2': ['Address line 2', 'address-line2'], 'bd-tax-id': ['GSTIN', 'off'], 'bd-phone': ['Phone number', 'tel']};
    for (const [id, [label, token]] of Object.entries(expectations)) {
      assert.ok(labels.get(id) && labels.get(id).startsWith(label), `${id} has the label ${label}`);
      assert.equal(field(doc, id).getAttribute('autocomplete'), token, `${id} autocomplete`);
      assert.ok(field(doc, id + '-error') && field(doc, id).getAttribute('aria-describedby').includes(id + '-error'), `${id} is described by its error`);
    }
    assert.ok(labels.get('bd-type-individual') && labels.get('bd-type-business') && dialog.querySelector('fieldset legend'), 'Individual or Business is a labelled group');
    assert.match(labels.get('bd-full-name'), /\(required\)/);
    assert.match(labels.get('bd-address-line1'), /\(optional\)/, 'the street address is optional for an individual');
    assert.match(labels.get('bd-phone'), /\(optional\)/);
    // The optional tax id, for individuals too: "GSTIN (optional)" in India, with the honest note about GST.
    assert.equal(labels.get('bd-tax-id'), 'GSTIN (optional)');
    assert.equal(field(doc, 'bd-tax-id-field').hidden, false, 'an individual can give a tax id too');
    assert.equal(field(doc, 'bd-tax-id').getAttribute('maxlength'), '40');
    // A code, not words: capitals on a phone keyboard, no autocorrect, no spelling underline.
    assert.equal(field(doc, 'bd-tax-id').getAttribute('autocapitalize'), 'characters');
    assert.equal(field(doc, 'bd-tax-id').getAttribute('autocorrect'), 'off');
    assert.equal(field(doc, 'bd-tax-id').getAttribute('spellcheck'), 'false');
    assert.equal(field(doc, 'bd-tax-id-hint').textContent,
      "Optional. Zero-X keeps it with your billing details for its billing records; it is not sent to Razorpay and does not appear on Razorpay's receipt. Zero-X is not registered for GST, so no GST is charged and no GST invoice is issued.");
    assert.ok(field(doc, 'bd-tax-id').getAttribute('aria-describedby').includes('bd-tax-id-hint'), 'the note describes the field');
    assert.equal(field(doc, 'bd-business-name-field').hidden, true, 'business fields appear only for a business');
    assert.equal(field(doc, 'bd-country').value, 'IN', 'paying in rupees: India is preselected (a guess the buyer can change)');
    fill(doc, {'bd-country': ''});
    assert.equal(field(doc, 'bd-tax-id-label').textContent, 'VAT or tax ID', 'outside India the field asks for a VAT or tax ID');
    // The order summary is a description list with the price and renewal terms; no GST line unless the server says so.
    const summary = field(doc, 'bd-summary');
    const rows = Object.fromEntries(summary.querySelectorAll('dt').map((term, index) => [term.textContent, summary.querySelectorAll('dd')[index].textContent]));
    assert.equal(rows.Plan, 'Neuron Pro');
    assert.equal(rows.Price, '₹899 per month');
    assert.equal(rows['Due today'], '₹899');
    assert.equal(rows.Billing, 'Monthly, renews until you cancel');
    assert.match(rows['First renewal'], /^About \d{1,2} \w+ 20\d\d, then monthly$/);
    assert.ok(!('Tax' in rows) && !/GST/i.test(summary.textContent), 'the order summary does not mention GST until the owner turns the notice on');
    const taxField = field(doc, 'bd-tax-id-field');
    assert.ok(!/GST/i.test(dialog.textContent.replace(taxField.textContent, '')), 'outside the tax id field, the dialog says nothing about GST');
    assert.match(field(doc, 'bd-notice').textContent, /renews monthly until you cancel.*Your bank or Razorpay may notify you before each charge.*Zero-X never sees your card details/);
    assert.equal(dialog.querySelectorAll('input[type="checkbox"]').length, 4, 'terms, privacy, renewal notice and refund policy, all unticked');
    assert.ok(dialog.querySelectorAll('input[type="checkbox"]').every(box => !box.checked));
    assert.match(field(doc, 'bd-consent-auto-renewal').parentNode.textContent, /Pro plan renews every month at ₹899 until I cancel.*authorise Razorpay/);
    const hrefs = dialog.querySelectorAll('a').map(anchor => anchor.getAttribute('href'));
    for (const path of ['/terms', '/privacy', '/refund', '/terms#billing']) assert.ok(hrefs.includes('https://zero-x.live' + path), `links to ${path}`);
    assert.ok(dialog.querySelectorAll('a').every(anchor => anchor.getAttribute('rel') === 'noopener noreferrer'));
    assert.match(field(doc, 'bd-data-notice').textContent, /Razorpay receives only your name, e-mail address and phone number/);

    // Submitting nothing: an error summary (role=alert), invalid fields, nothing saved, nothing created.
    submit(doc);
    await settle();
    const errors = field(doc, 'bd-errors');
    assert.equal(errors.getAttribute('role'), 'alert');
    assert.match(errors.textContent, /things need your attention/);
    for (const id of ['bd-full-name', 'bd-country', 'bd-city']) assert.equal(field(doc, id).getAttribute('aria-invalid'), 'true', `${id} is marked invalid`);
    assert.equal(field(doc, 'bd-full-name-error').hidden, false);
    assert.equal(field(doc, 'bd-consent-terms').getAttribute('aria-invalid'), 'true');
    assert.ok(errors.querySelectorAll('a').length >= 6 && doc.activeElement === errors, 'the summary takes focus and links to each problem');
    assert.ok(!calls.some(call => call.method === 'PUT') && !calls.some(call => call.path === '/api/billing/checkout'));

    // India: the state is a list; fill in, tick, continue.
    fill(doc, {'bd-full-name': 'Asha Kumar', 'bd-country': 'IN'});
    const state = field(doc, 'bd-state');
    assert.equal(state.localName, 'select');
    assert.deepEqual(state.querySelectorAll('option').map(option => option.textContent), ['Choose…', 'Karnataka', 'Tamil Nadu']);
    assert.match(labels.get('bd-state') || '', /^State|^$/);
    assert.match(field(doc, 'bd-state-marker').textContent, /required/);
    fill(doc, {'bd-state': 'TN', 'bd-city': 'Karur', 'bd-postal-code': '639113'});
    assert.equal(field(doc, 'bd-tax-id-label').textContent, 'GSTIN');
    // The GSTIN is checked in the browser with the server's rule: a Karnataka GSTIN for a Tamil Nadu address, then a typo.
    fill(doc, {'bd-tax-id': GSTIN_KA});
    submit(doc);
    await settle();
    assert.equal(field(doc, 'bd-tax-id-error').textContent, 'This GSTIN starts with 29, but the GST state code of Tamil Nadu is 33. Check the GSTIN or the state.');
    // The error summary names the field with its own label ("GSTIN" in India), not a generic one.
    assert.ok(field(doc, 'bd-errors').textContent.includes('GSTIN: This GSTIN starts with 29'), 'the summary uses the label of the field');
    assert.ok(!field(doc, 'bd-errors').textContent.includes('GSTIN or tax ID'), 'no generic label in the summary');
    assert.equal(field(doc, 'bd-tax-id').getAttribute('aria-invalid'), 'true');
    fill(doc, {'bd-tax-id': GSTIN_TN.slice(0, 14) + 'A'});
    submit(doc);
    await settle();
    assert.equal(field(doc, 'bd-tax-id-error').textContent, 'This GSTIN\'s last character does not match the rest. Check it for a typo.');
    assert.ok(!calls.some(call => call.method === 'PUT'), 'a bad GSTIN is never sent');
    fill(doc, {'bd-tax-id': ' ' + GSTIN_TN.slice(0, 7).toLowerCase() + ' ' + GSTIN_TN.slice(7) + ' '});
    submit(doc);
    await settle();
    assert.equal(field(doc, 'bd-tax-id-error').hidden, true, 'lower case and spaces are fine (the server normalises them)');
    assert.equal(field(doc, 'bd-consent-terms').getAttribute('aria-invalid'), 'true', 'the boxes still have to be ticked');
    assert.ok(!calls.some(call => call.method === 'PUT'), 'nothing is saved until the boxes are ticked too');
    tick(doc, ['bd-consent-terms', 'bd-consent-privacy', 'bd-consent-auto-renewal', 'bd-consent-refund']);
    submit(doc);
    await settle();
    assert.deepEqual(calls.find(call => call.method === 'PUT').body, {customer_type: 'individual', full_name: 'Asha Kumar', country: 'IN', state: 'TN', city: 'Karur', postal_code: '639113',
      tax_id: GSTIN_TN.slice(0, 7).toLowerCase() + ' ' + GSTIN_TN.slice(7)}, 'only what was filled in is sent, trimmed');
    assert.deepEqual(calls.find(call => call.path === '/api/billing/checkout').body, {plan: 'pro', currency: 'INR', consent: consentFor('subscription')});
    assert.equal(dialogOf(doc), null, 'the dialog is removed');
    const razorpay = FakeRazorpay.instances[0];
    assert.equal(razorpay.options.subscription_id, 'sub_TEST12345');
    assert.deepEqual(razorpay.options.prefill, {email: 'owner@example.com', name: 'Asha Kumar', contact: '+919876543210'}, 'name, e-mail and phone only');
    assert.ok(!JSON.stringify(razorpay.options).includes('639113') && !JSON.stringify(razorpay.options).includes('Karur'), 'no address reaches Razorpay');
    assert.ok(!JSON.stringify(razorpay.options).includes(GSTIN_TN.slice(7)), 'no tax id reaches Razorpay');
    assert.ok(![...t.win.localStorage.map.values(), ...t.win.sessionStorage.map.values()].some(value => /639113|Asha|Karur/.test(value)), 'details are never written to browser storage');
  }

  // ── The server's own messages (postal codes, phone numbers) are shown on their fields ──
  {
    let attempts = 0;
    const t = await pricingWith({'PUT /api/billing/profile': () => (++attempts === 1
      ? apiError(400, 'invalid_request', 'Enter a 6 digit PIN code.', {param: 'postal_code', fields: {postal_code: 'Enter a 6 digit PIN code.', phone: 'Enter the number with its country code.'}})
      : json(200, {profile: SAVED, complete: true, missing: []}))});
    t.doc.querySelector('[data-upgrade="max"]').click();
    await settle();
    const {doc, calls} = t;
    fill(doc, {'bd-full-name': 'Asha Kumar', 'bd-country': 'IN'});
    fill(doc, {'bd-state': 'TN', 'bd-city': 'Karur', 'bd-postal-code': '12345', 'bd-phone': '123'});
    tick(doc, ['bd-consent-terms', 'bd-consent-privacy', 'bd-consent-auto-renewal', 'bd-consent-refund']);
    submit(doc);
    await settle();
    assert.ok(dialogOf(doc) && dialogOf(doc).open, 'the dialog stays open on a refusal');
    assert.equal(field(doc, 'bd-postal-code-error').textContent, 'Enter a 6 digit PIN code.');
    assert.equal(field(doc, 'bd-phone-error').textContent, 'Enter the number with its country code.');
    assert.equal(field(doc, 'bd-postal-code').getAttribute('aria-invalid'), 'true');
    assert.equal(field(doc, 'bd-submit').disabled, false, 'the buyer can correct and retry');
    assert.ok(!calls.some(call => call.path === '/api/billing/checkout'));
    fill(doc, {'bd-postal-code': '639113', 'bd-phone': ''});
    submit(doc);
    await settle();
    assert.equal(calls.filter(call => call.method === 'PUT').length, 2);
    assert.deepEqual(calls.find(call => call.path === '/api/billing/checkout').body, {plan: 'max', currency: 'USD', consent: consentFor('subscription')});
  }

  // ── A business, outside India: type toggle, free-text state, no postal code needed in the UAE ──
  {
    const t = await pricingWith({'PUT /api/billing/profile': json(200, {profile: SAVED, complete: true, missing: []})});
    t.doc.querySelector('[data-upgrade="pro"]').click();
    await settle();
    const {doc, calls} = t;
    assert.equal(field(doc, 'bd-country').value, '', 'paying in dollars: no country is guessed');
    const business = field(doc, 'bd-type-business');
    business.checked = true;
    business.dispatchEvent(makeEvent('change', {bubbles: true}));
    assert.equal(field(doc, 'bd-business-name-field').hidden, false);
    assert.match(field(doc, 'bd-address-line1-marker').textContent, /required/, 'a business gives its address');
    fill(doc, {'bd-country': 'AE'});
    assert.equal(field(doc, 'bd-tax-id-label').textContent, 'VAT or tax ID');
    assert.equal(field(doc, 'bd-state').localName, 'input', 'free text where there is no list');
    assert.equal(field(doc, 'bd-postal-code-field').hidden, true, 'no postal code where there are none');
    submit(doc);
    await settle();
    assert.ok(field(doc, 'bd-business-name-error').textContent && field(doc, 'bd-address-line1-error').textContent);
    assert.equal(field(doc, 'bd-postal-code-error').hidden, true);
    fill(doc, {'bd-full-name': 'Asha Kumar', 'bd-business-name': 'Zero X Labs', 'bd-city': 'Dubai', 'bd-address-line1': 'Office 4', 'bd-state': 'Dubai'});
    tick(doc, ['bd-consent-terms', 'bd-consent-privacy', 'bd-consent-auto-renewal', 'bd-consent-refund']);
    fill(doc, {'bd-tax-id': 'TRN_1'});
    submit(doc);
    await settle();
    assert.equal(field(doc, 'bd-tax-id-error').textContent, 'Enter a VAT or tax ID of 2 to 20 letters, digits or hyphens.');
    assert.ok(field(doc, 'bd-errors').textContent.includes('VAT or tax ID: Enter a VAT or tax ID'), 'outside India the summary says VAT or tax ID');
    assert.ok(!calls.some(call => call.method === 'PUT'));
    fill(doc, {'bd-tax-id': '100 2345 6789 0003'});
    submit(doc);
    await settle();
    assert.deepEqual(calls.find(call => call.method === 'PUT').body, {customer_type: 'business', full_name: 'Asha Kumar', business_name: 'Zero X Labs', country: 'AE', state: 'Dubai',
      city: 'Dubai', address_line1: 'Office 4', tax_id: '100 2345 6789 0003'});
  }

  // ── Returning buyer: a one-click review; ticks only for what is new ──
  {
    const t = await pricingWith({'GET /api/billing/profile': returning(), 'PUT /api/billing/profile': json(200, {profile: SAVED, complete: true, missing: []})});
    t.doc.querySelector('[data-upgrade="pro"]').click();
    await settle();
    const {doc, calls} = t;
    const review = field(doc, 'bd-review');
    assert.ok(review && !field(doc, 'bd-full-name'), 'the saved details are shown, not the form');
    assert.match(review.textContent, /Asha Kumar/);
    assert.match(review.textContent, /6\/2 N\. Pugalur/);
    assert.match(review.textContent, /Karur, Tamil Nadu 639113/);
    assert.match(review.textContent, /\+919876543210/);
    assert.ok(!/GSTIN|tax ID/.test(review.textContent), 'no tax id row when none was given');
    assert.equal(field(doc, 'bd-submit').textContent, 'Continue to payment');
    assert.deepEqual(dialogOf(doc).querySelectorAll('input[type="checkbox"]').map(box => box.getAttribute('id')), ['bd-consent-auto-renewal'],
      'only the renewal notice has to be ticked: it is about this purchase');
    assert.match(field(doc, 'bd-earlier').textContent, /already accepted the Terms of Service, Privacy Policy and Cancellation and Refund Policy in their current versions/);
    submit(doc);
    await settle();
    assert.equal(field(doc, 'bd-consent-auto-renewal').getAttribute('aria-invalid'), 'true');
    assert.ok(!calls.some(call => call.path === '/api/billing/checkout'));
    tick(doc, ['bd-consent-auto-renewal']);
    submit(doc);
    await settle();
    assert.ok(!calls.some(call => call.method === 'PUT'), 'nothing is saved again when nothing was edited');
    assert.deepEqual(calls.find(call => call.path === '/api/billing/checkout').body, {plan: 'pro', currency: 'USD', consent: {auto_renewal: '2026-11-03'}});
  }
  {
    // Editing from the review screen shows the form with the saved values (the GSTIN too) and saves them.
    const t = await pricingWith({'GET /api/billing/profile': returning({profile: {...SAVED, tax_id: GSTIN_TN}}), 'PUT /api/billing/profile': json(200, {profile: SAVED, complete: true, missing: []})});
    t.doc.querySelector('[data-upgrade="pro"]').click();
    await settle();
    const {doc, calls} = t;
    const reviewRows = Object.fromEntries(field(doc, 'bd-review').querySelectorAll('dt').map((term, index) => [term.textContent, field(doc, 'bd-review').querySelectorAll('dd')[index].textContent]));
    assert.equal(reviewRows.GSTIN, GSTIN_TN, 'the saved GSTIN is shown for review');
    field(doc, 'bd-edit').click();
    assert.equal(field(doc, 'bd-tax-id').value, GSTIN_TN, 'and prefilled in the form');
    assert.equal(field(doc, 'bd-full-name').value, 'Asha Kumar');
    assert.equal(field(doc, 'bd-country').value, 'IN');
    assert.equal(field(doc, 'bd-state').value, 'TN');
    assert.equal(field(doc, 'bd-postal-code').value, '639113');
    assert.equal(field(doc, 'bd-phone').value, '+919876543210');
    fill(doc, {'bd-city': 'Chennai'});
    tick(doc, ['bd-consent-auto-renewal']);
    submit(doc);
    await settle();
    assert.equal(calls.find(call => call.method === 'PUT').body.city, 'Chennai');
    assert.equal(calls.find(call => call.path === '/api/billing/checkout').body.consent.auto_renewal, '2026-11-03');
  }
  // A top-up for a returning buyer is one click (dashboard), with no consent to resend beyond what is new.
  {
    const t = await mountDashboard({details: collectBillingDetails, hash: '#billing', routes: {'GET /api/billing/profile': returning()}});
    FakeRazorpay.instances.length = 0;
    t.doc.querySelector('[data-topup="credits_5"]').click();
    await settle();
    assert.ok(dialogOf(t.doc) && dialogOf(t.doc).querySelectorAll('input[type="checkbox"]').length === 0, 'nothing to tick on a top-up once the documents are accepted');
    assert.equal(field(t.doc, 'bd-title').textContent, 'Billing details for your top-up');
    const rows = Object.fromEntries(field(t.doc, 'bd-summary').querySelectorAll('dt').map((term, index) => [term.textContent, field(t.doc, 'bd-summary').querySelectorAll('dd')[index].textContent]));
    assert.deepEqual(rows, {Item: '$5 of Neuron credits', Payment: 'One time, no renewal', Price: '$5', 'Due today': '$5'});
    assert.match(field(t.doc, 'bd-notice').textContent, /one-time payment/);
    submit(t.doc);
    await settle();
    assert.deepEqual(t.calls.find(call => call.path === '/api/billing/topup').body, {pack: 'credits_5', currency: 'USD', consent: {}});
    assert.equal(FakeRazorpay.instances[0].options.order_id, 'order_TEST123456');
  }

  // ── Closing the dialog: nothing is created, the buyer is told, and Esc counts ──
  {
    const t = await pricingWith({});
    t.doc.querySelector('[data-upgrade="pro"]').click();
    await settle();
    field(t.doc, 'bd-cancel').click();
    await settle();
    assert.equal(dialogOf(t.doc), null);
    assert.equal(t.$('pricing-status').textContent, 'Checkout closed. You have not been charged.');
    assert.ok(!t.calls.some(call => call.path === '/api/billing/checkout'));
    assert.equal(t.doc.querySelector('[data-upgrade="pro"]').disabled, false, 'the button works again');
    t.doc.querySelector('[data-upgrade="pro"]').click();
    await settle();
    dialogOf(t.doc).dispatchEvent(makeEvent('cancel', {cancelable: true}));
    await settle();
    assert.equal(dialogOf(t.doc), null, 'Esc closes it too');
    assert.ok(!t.calls.some(call => call.path === '/api/billing/checkout'));
  }

  // ── The owner's "No GST charged" notice appears only when the server says so ──
  {
    const t = await pricingWith({'GET /api/billing/profile': detailsPayload({tax: {no_gst_notice: true}})});
    t.doc.querySelector('[data-upgrade="pro"]').click();
    await settle();
    const summary = field(t.doc, 'bd-summary');
    const rows = Object.fromEntries(summary.querySelectorAll('dt').map((term, index) => [term.textContent, summary.querySelectorAll('dd')[index].textContent]));
    assert.equal(rows.Tax, 'No GST charged');
  }

  // ── A document changed while the dialog was open: the step runs again with fresh data, once ──
  {
    let posts = 0;
    let gets = 0;
    const t = await pricingWith({'GET /api/billing/profile': () => { gets += 1; return returning(); },
      'POST /api/billing/checkout': call => (++posts === 1 ? apiError(409, 'consent_required', 'Accept the current Terms of Service to continue.', {missing: ['terms']}) : checkoutRoute(call))});
    t.doc.querySelector('[data-upgrade="pro"]').click();
    await settle();
    tick(t.doc, ['bd-consent-auto-renewal']);
    submit(t.doc);
    await settle();
    assert.equal(posts, 1);
    assert.ok(dialogOf(t.doc), 'the step reopens');
    tick(t.doc, ['bd-consent-auto-renewal']);
    submit(t.doc);
    await settle();
    assert.equal(gets, 2, 'with fresh details and documents');
    assert.equal(posts, 2);
    assert.equal(FakeRazorpay.instances.at(-1).options.subscription_id, 'sub_TEST12345');
    // A second refusal is final: no loop.
    let refusals = 0;
    const loop = await pricingWith({'GET /api/billing/profile': returning(), 'POST /api/billing/checkout': () => { refusals += 1; return apiError(409, 'billing_profile_required', 'Add your billing details before you pay.', {missing: ['city']}); }});
    loop.doc.querySelector('[data-upgrade="pro"]').click();
    await settle();
    tick(loop.doc, ['bd-consent-auto-renewal']);
    submit(loop.doc);
    await settle();
    tick(loop.doc, ['bd-consent-auto-renewal']);
    submit(loop.doc);
    await settle();
    assert.equal(refusals, 2, 'one reopen, then the refusal is shown');
    assert.equal(dialogOf(loop.doc), null);
    assert.match(loop.$('pricing-error').textContent, /Add your billing details to continue/);
  }

  // ── Untrusted data is text; a failed profile load is reported, not hidden ──
  {
    const t = await pricingWith({'GET /api/billing/profile': returning({profile: {...SAVED, full_name: XSS, address_line1: XSS, city: XSS}})});
    t.doc.querySelector('[data-upgrade="pro"]').click();
    await settle();
    assert.equal(dialogOf(t.doc).querySelectorAll('img').length, 0);
    assert.ok(field(t.doc, 'bd-review').textContent.includes(XSS), 'shown as text');
    const failing = await pricingWith({'GET /api/billing/profile': apiError(503, 'service_unavailable', 'Zero-X is temporarily unavailable. Please retry shortly.')});
    failing.doc.querySelector('[data-upgrade="pro"]').click();
    await settle();
    assert.equal(dialogOf(failing.doc), null);
    assert.match(failing.$('pricing-error').textContent, /temporarily unavailable/);
    assert.ok(!failing.calls.some(call => call.path === '/api/billing/checkout'));
    const noPlan = await pricingWith({'GET /api/billing/profile': returning(), 'POST /api/billing/checkout': apiError(503, 'billing_plan_missing', 'Checkout for the Pro plan in USD is not set up yet.')});
    noPlan.doc.querySelector('[data-upgrade="pro"]').click();
    await settle();
    tick(noPlan.doc, ['bd-consent-auto-renewal']);
    submit(noPlan.doc);
    await settle();
    assert.match(noPlan.$('pricing-error').textContent, /Checkout for this plan is not set up yet\. Email support@zero-x\.live/);
    assert.equal(noPlan.$('pricing-error').querySelector('a').getAttribute('href'), 'mailto:support@zero-x.live');
  }
}

console.log('PASS: dashboard gate, contract-driven overview, hash tabs and keyboard, usage chart/table/pagination, key create-once/copy/revoke-confirm, billing cancel/top-up/verify, sessions, sign-out dev-token cleanup, 401/500 recovery, pricing currency/hydration/checkout/409/503/forged payloads, install bar menu and copy, zerox-auth dev identity and pinned SDK; untrusted data never reached innerHTML, the billing details dialog (labelled controls, validation, server messages, review for returning buyers, one-click top-up, cancel, retry once, no GST line unless enabled)');

/* ───────────── Console restyle: drawer, trend card, account and sign-in pages ───────────── */

{
  // Markup: breadcrumb bar, a vertical tablist drawer with mono-caps section labels and sprite icons.
  assert.match(DASHBOARD_HTML, /<link rel="stylesheet" href="\/dashboard\.css">/);
  assert.match(DASHBOARD_HTML, /<ol class="zx-crumbs">/);
  assert.match(DASHBOARD_HTML, /id="dash-tabs"/);
  assert.match(DASHBOARD_HTML, /role="tablist"[^>]*aria-orientation="vertical"/);
  const doc = parseDocument(DASHBOARD_HTML);
  assert.deepEqual(doc.querySelectorAll('.zx-drawer__label').map(node => node.textContent), ['Workspace', 'Developer', 'Settings']);
  assert.deepEqual(doc.querySelectorAll('.zx-drawer__item').map(node => node.getAttribute('id')), TABS.map(tab => 'tab-' + tab), 'drawer items follow TABS order');
  assert.equal(doc.querySelectorAll('[data-metric]').map(node => node.getAttribute('data-metric')).join(), 'spend,requests,tokens,spend,requests,tokens', 'both trend controls offer Spend, Requests, Tokens');
  assert.ok(!/Anthropic|OpenRouter|Groq|NVIDIA|Cerebras/.test(DASHBOARD_HTML.replace(/<code[^>]*>[\s\S]*?<\/code>/g, '')), 'no provider names on the dashboard');
  assert.ok(!/ style="/.test(DASHBOARD_HTML) && !/<style/.test(DASHBOARD_HTML), 'dashboard uses classes, not inline styles');
}

// The breadcrumb avatar and the header account chip follow the signed-in profile and reset on sign-out.
{
  const crumbAvatar = doc => doc.querySelector('.zx-crumbs__avatar');
  const chip = doc => doc.querySelector('.zx-header .zx-nav a.zx-btn');
  // Static HTML: the 'zx' crumb and a pending Account chip: laid out but invisible (data-pending),
  // so the nav does not jump left when the profile arrives; never hidden in the markup.
  const html = parseDocument(DASHBOARD_HTML);
  assert.equal(crumbAvatar(html).textContent, 'zx');
  assert.deepEqual([chip(html).getAttribute('href'), chip(html).hidden, chip(html).hasAttribute('data-pending'), chip(html).textContent], ['https://dashboard.zero-x.live/#account', false, true, 'Account']);
  assert.match(read('zx-tokens.css'), /^\.zx-btn\[data-pending\] \{ visibility: hidden; \}$/m, 'a pending button keeps its space but is invisible (and out of the tab order)');
  // Unsafe image (PROFILE.imageUrl is javascript:) and an HTML-ish name: initials as text.
  const xss = await mountDashboard();
  assert.deepEqual([crumbAvatar(xss.doc).querySelectorAll('img').length, crumbAvatar(xss.doc).textContent], [0, 'OW'], 'initials from the first name, no element from the name');
  assert.deepEqual([chip(xss.doc).hidden, chip(xss.doc).hasAttribute('data-pending')], [false, false], 'signed in: the chip shows in its reserved space');
  assert.equal(chip(xss.doc).getAttribute('href'), '#account', 'the chip opens the Account tab in place');
  assert.equal(chip(xss.doc).getAttribute('aria-label'), 'Account, signed in as ' + XSS);
  assert.equal(chip(xss.doc).getAttribute('title'), 'owner@example.com');
  assert.equal(chip(xss.doc).querySelector('.zx-nav-avatar').textContent, 'OW');
  // An allowed Google avatar: the same image in the crumb and the chip.
  const GOOGLE = 'https://lh3.googleusercontent.com/a/photo=s96-c';
  const t = await mountDashboard({profile: {...PROFILE, fullName: 'Ada Lovelace', firstName: 'Ada', imageUrl: GOOGLE}});
  const crumbImg = crumbAvatar(t.doc).querySelector('img');
  assert.deepEqual([crumbImg.getAttribute('src'), crumbImg.getAttribute('alt'), crumbImg.getAttribute('referrerpolicy')], [GOOGLE, '', 'no-referrer']);
  assert.equal(chip(t.doc).querySelector('.zx-nav-avatar img').getAttribute('src'), GOOGLE);
  assert.equal(chip(t.doc).getAttribute('aria-label'), 'Account, signed in as Ada Lovelace');
  // Sign-out elsewhere: the crumb goes back to 'zx' and the chip is hidden and reset.
  t.auth.emit('SIGNED_OUT');
  assert.deepEqual([crumbAvatar(t.doc).querySelectorAll('img').length, crumbAvatar(t.doc).textContent], [0, 'zx'], 'SIGNED_OUT resets the crumb avatar');
  assert.deepEqual([chip(t.doc).hidden, chip(t.doc).hasAttribute('data-signed-in'), chip(t.doc).getAttribute('aria-label'), chip(t.doc).querySelectorAll('.zx-nav-avatar').length], [true, false, null, 0], 'SIGNED_OUT hides and resets the chip');
  // Signed out from the start: the 'zx' crumb and no chip.
  const gate = await mountDashboard({profile: null});
  assert.deepEqual([crumbAvatar(gate.doc).textContent, chip(gate.doc).hidden, chip(gate.doc).hasAttribute('data-pending')], ['zx', true, false]);
  console.log('ok - dashboard: breadcrumb avatar and header account chip follow the profile (allowed image or initials) and reset on SIGNED_OUT');
}

{
  const {$, doc, win, calls} = await mountDashboard();
  assert.equal($('crumb-tab').textContent, 'Overview');
  assert.equal($('crumb-account').textContent, 'owner@example.com');
  assert.ok(calls.some(call => call.path === '/api/usage'), 'Overview loads the usage series for its trend card');
  assert.ok(!calls.some(call => call.path === '/api/usage/events?limit=25'), 'recent requests wait for the Usage tab');
  const trend = $('trend-chart').querySelector('svg');
  assert.equal(trend.getAttribute('role'), 'img');
  assert.equal(trend.querySelectorAll('rect').length, 2);
  assert.equal(trend.querySelectorAll('.zx-grid-line').length, 3, 'a dotted grid of three lines');
  assert.match($('trend-caption').textContent, /^Peak 40 \/ Oct 16 · Total 52 · Sep 17 to Oct 16, 2026$/);
  assert.equal($('lim-daily-requests').textContent, '2,000');
  assert.equal($('lim-daily-tokens').textContent, '10M');
  assert.equal($('lim-rpm').textContent, '30');
  assert.equal($('lim-concurrency').textContent, '4');
  // Spend is drawn from the same series (cost_usd) and shared with the Usage chart.
  doc.querySelector('[data-metric="spend"]').click();
  assert.deepEqual(doc.querySelectorAll('[data-metric="spend"]').map(node => node.getAttribute('aria-pressed')), ['true', 'true']);
  assert.deepEqual(doc.querySelectorAll('[data-metric="requests"]').map(node => node.getAttribute('aria-pressed')), ['false', 'false']);
  assert.match($('usage-chart-caption').textContent, /^Spend per day/);
  assert.match($('trend-caption').textContent, /^Peak \$/);
  // Vertical and horizontal arrows both move through the drawer; the breadcrumb follows the tab.
  $('tab-overview').focus();
  $('dash-tabs').dispatchEvent(makeEvent('keydown', {key: 'ArrowDown', bubbles: true}));
  await settle();
  assert.equal(win.location.hash, '#usage');
  assert.equal($('crumb-tab').textContent, 'Usage');
  assert.ok(calls.some(call => call.path === '/api/usage/events?limit=25'));
  assert.equal(calls.filter(call => call.path === '/api/usage').length, 1, 'Usage reuses the series Overview loaded');
  $('dash-tabs').dispatchEvent(makeEvent('keydown', {key: 'ArrowUp', bubbles: true}));
  await settle();
  assert.equal($('crumb-tab').textContent, 'Overview');
}

{
  // The look: tokens only, one accent, no gradients, glass, violet or glow, no inline colours.
  const files = ['dashboard.css', 'auth.css', 'auth-pages.css', 'neuroncli/admin/keys/keys.css', 'neuroncli/admin/models/models.css'];
  for (const file of files) {
    const css = read(file).replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(css, /gradient\(/i, file + ': no gradients');
    assert.doesNotMatch(css, /backdrop-filter|filter:\s*blur/i, file + ': no glass or blur');
    assert.doesNotMatch(css, /violet|purple|#(?:7C4DFF|A58AFF|5B3FD0)/i, file + ': no violet or purple');
    assert.doesNotMatch(css, /#00e5ff|#0a0a0c|#111114/i, file + ': none of the old cyan-on-black palette');
    assert.doesNotMatch(css, /box-shadow:[^;{}]*\),\s*[^;{}]*\)/i, file + ': no stacked drop shadows');
  }
  const authJs = read('zerox-auth.js');
  assert.doesNotMatch(authJs, /style="|\.style\.|cssText|#00e5ff|#111114|#17171B/i, 'zerox-auth.js carries no inline colours or styles');
  assert.equal(CHECKOUT_THEME_COLOR, '#3B82F6', 'Razorpay checkout uses the site accent');
  for (const file of ['neuroncli/login/index.html', 'neuroncli/device/index.html', 'neuroncli/callback/index.html', 'neuroncli/admin/keys/index.html', 'neuroncli/admin/models/index.html']) {
    const html = read(file);
    assert.doesNotMatch(html, /<style\b| style="/, file + ': no inline style');
    assert.match(html, /href="\/zx-tokens\.css"/, file + ': uses the design tokens');
    assert.match(html, /<meta name="theme-color" content="#FFFFFF" media="\(prefers-color-scheme: light\)">/, file + ': theme-color for light');
    assert.doesNotMatch(html, /fontshare|fonts\.googleapis/i, file + ': no hotlinked fonts');
  }
  for (const file of ['neuroncli/login/index.html', 'neuroncli/device/index.html', 'neuroncli/callback/index.html']) {
    assert.match(read(file), /href="\/auth-pages\.css"/, file + ': shared sign-in card styles');
  }
  // The new stylesheets are deployed: present, and not hidden by .assetsignore.
  const ignore = read('.assetsignore').split(String.fromCharCode(10)).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  for (const file of ['dashboard.css', 'auth.css', 'auth-pages.css']) {
    assert.ok(readFileSync(new URL(file, root)).length > 200, file + ' exists');
    assert.ok(!ignore.some(pattern => pattern === file || pattern === '*.css'), file + ' is not excluded from the Worker assets');
  }
  assert.doesNotMatch(read('neuroncli/callback/index.html').replace(/openrouter(?=['/])/g, ''), /OpenRouter/, 'the callback page shows no provider name');
}

console.log('PASS: dashboard gate, contract-driven overview, hash tabs and keyboard, usage chart/table/pagination, key create-once/copy/revoke-confirm, billing cancel/top-up/verify, sessions, sign-out dev-token cleanup, 401/500 recovery, pricing currency/hydration/checkout/409/503/forged payloads, install bar menu and copy, zerox-auth dev identity and pinned SDK; untrusted data never reached innerHTML');
process.exit(0);

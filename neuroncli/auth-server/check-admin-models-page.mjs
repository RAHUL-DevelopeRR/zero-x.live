// Model catalog page (neuroncli/admin/models/models.js) in a fake DOM: the admin token stays in
// memory and in the Authorization header only (never in storage, cookies or URLs), names, notes,
// authors and diffs are text (never markup), approve sends exactly the reviewed revision and the
// active revision it was compared with (and the typed model id for risky changes), reject, disable
// and enable ask first, the editor posts the spec to validate and propose, a refused token locks
// the page. Plus the HTML: no inline script or style, nothing from another origin, forms that
// cannot submit anywhere.
//   node check-admin-models-page.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { apiFromSpec } from './src/catalog-guardrails.js';
import { CLAUDE_MODEL_SPECS } from './src/catalog-claude.js';

const source = readFileSync(new URL('../admin/models/models.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../admin/models/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../admin/models/models.css', import.meta.url), 'utf8');
const drain = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)); };
const TOKEN = 'operator-token-'.padEnd(40, 'x');
const XSS = '<img src=x onerror=alert(1)>';
const OPUS_ID = 'anthropic/claude-opus-5-5';
const DRAFT_ID = 'groq/acme/fast-1';
const opusSpec = apiFromSpec(CLAUDE_MODEL_SPECS[1]);
const raisedSpec = structuredClone(opusSpec);
raisedSpec.pools[0].daily_spend_cap_usd = 8;
const draftSpec = { provider_type: 'groq', upstream_model: 'acme/fast-1', display_name: 'Acme Fast 1', context_window: 131072,
  max_output_tokens: 8192, default_max_tokens: null, supports_tools: true, supports_vision: false, reasoning_efforts: [],
  reasoning_effort_map: {}, default_reasoning_effort: null, aliases: [], geo_block_free: [], auto_rank: null, position: 1000,
  default_enabled: true, pools: [{ tier: 'free', key_slot: 'groq.free', price: null, limits: { rpm: 30, rpd: 1000, tpm: 8000, tpd: 200000 },
    daily_spend_cap_usd: null }] };

const TYPES = { markup: 1.25, types: [
  { id: 'anthropic', id_prefix: 'anthropic/', max_daily_spend_usd: 50, paid_pricing: 'listed_only',
    slots: { free: [], paid: [{ id: 'anthropic.paid', env: 'ANTHROPIC_API_KEY', configured: true }] },
    list_prices: { 'claude-opus-5-5': { input_usd_per_mtok: 4, output_usd_per_mtok: 20, cache_read_usd_per_mtok: 0.2,
      cache_write_usd_per_mtok: 5, cache_write_1h_usd_per_mtok: 8 } } },
  { id: 'groq', id_prefix: 'groq/', max_daily_spend_usd: 100, paid_pricing: 'listed_only',
    slots: { free: [{ id: 'groq.free', configured: true }], paid: [{ id: 'groq.paid', configured: false }] }, list_prices: {} },
] };
const MODELS = {
  catalog: { source: 'database', version: '0123456789abcdef', failing: false }, access_configured: true, warnings: [],
  models: [
    { id: OPUS_ID, provider_type: 'anthropic', status: 'active', source: 'seed', served_from: 'database', matches_code: true,
      served_tiers: ['paid'], pending: { revision: 2, revision_id: 41, risky: ['pools.paid.daily_spend_cap_usd'] } },
    { id: DRAFT_ID, provider_type: 'groq', status: 'draft', source: 'operator', served_from: 'none', matches_code: false,
      served_tiers: [], pending: { revision: 1, revision_id: 50, risky: [] } },
  ],
  code_only: [{ id: 'cohere/north-mini-code:free', provider_type: 'openrouter', served_from: 'code', preview: { tiers: ['free'] } }],
};
const OPUS_DETAIL = { model: {
  id: OPUS_ID, provider_type: 'anthropic', status: 'active', source: 'seed', served_from: 'database', matches_code: true,
  updated_at: '2026-10-25T10:00:00Z', loader_reasons: [], dropped_pools: [],
  active: { revision_id: 16, revision: 1, spec: opusSpec, preview: { pricing: { input_per_mtok_usd: 5 } } },
  pending: { revision_id: 41, revision: 2, author: XSS, note: 'raise the cap', spec: raisedSpec, preview: { pricing: null },
    validation: { model: [], pools: { paid: [] } },
    diff: [{ path: 'pools.paid.daily_spend_cap_usd', from: 6, to: 8, flag: 'cap_up' },
      { path: 'display_name', from: 'Claude Opus 5.5', to: XSS, flag: 'changed' }],
    risky: ['pools.paid.daily_spend_cap_usd'] },
}, events: [{ at: '2026-10-25T09:00:00Z', actor: 'migration', action: 'seed', from_status: null, to_status: 'active', note: '<script>alert(1)</script>' }] };
const DRAFT_DETAIL = { model: {
  id: DRAFT_ID, provider_type: 'groq', status: 'draft', source: 'operator', served_from: 'none', matches_code: false,
  updated_at: '2026-10-25T10:00:00Z', loader_reasons: [], dropped_pools: [], active: null,
  pending: { revision_id: 50, revision: 1, author: 'operator', note: null, spec: draftSpec, preview: { pricing: null },
    validation: { model: [], pools: { free: [] } }, diff: [{ path: 'model', from: null, to: 'groq:acme/fast-1', flag: 'new_model' }], risky: [] },
}, events: [] };

function element(tag, id) {
  return {
    tag, id, textContent: '', className: '', hidden: ['catalog', 'empty', 'detail', 'pending', 'editor'].includes(id), disabled: false,
    value: '', checked: false, type: '', children: [], listeners: {},
    addEventListener(event, fn) { this.listeners[event] = fn; },
    appendChild(child) { this.children.push(child); return child; },
    replaceChildren() { this.children = []; },
    focus() {},
    get innerHTML() { throw new Error('innerHTML is never read or written'); },
    set innerHTML(_) { throw new Error('innerHTML is never read or written'); },
    get outerHTML() { throw new Error('outerHTML is never used'); },
    insertAdjacentHTML() { throw new Error('insertAdjacentHTML is never used'); },
  };
}

const forbiddenStore = name => new Proxy({}, { get() { throw new Error(`${name} is never touched`); }, set() { throw new Error(`${name} is never touched`); } });

async function run({ respond, confirmAnswer = true, promptAnswer = null, search = '' } = {}) {
  const elements = new Map();
  const el = id => {
    if (!elements.has(id)) elements.set(id, element('div', id));
    return elements.get(id);
  };
  const calls = [];
  const prompts = [];
  const document = { getElementById: el, createElement: tag => element(tag) };
  Object.defineProperty(document, 'cookie', { get() { throw new Error('cookies are never read'); }, set() { throw new Error('cookies are never set'); } });
  const context = vm.createContext({
    console, JSON, Object, String, Number, Date, AbortSignal, Promise, Array, Boolean, Math, URLSearchParams, encodeURIComponent,
    document, localStorage: forbiddenStore('localStorage'), sessionStorage: forbiddenStore('sessionStorage'),
    window: {
      confirm: () => confirmAnswer, prompt: text => { prompts.push(text); return promptAnswer; }, location: { search },
      localStorage: forbiddenStore('localStorage'), sessionStorage: forbiddenStore('sessionStorage'),
    },
    fetch: async (path, options) => {
      calls.push({ path, method: options.method, headers: options.headers, body: options.body ? JSON.parse(options.body) : undefined,
        credentials: options.credentials, cache: options.cache });
      const [status, body] = respond(path, options);
      return { ok: status < 300, status, json: async () => body };
    },
  });
  vm.runInContext(source, context);
  return { el, calls, prompts };
}

const text = node => node.textContent + node.children.map(text).join('');
const okRespond = (overrides = {}) => (path, options) => {
  if (overrides[`${options.method} ${path.split('?')[0]}`]) return overrides[`${options.method} ${path.split('?')[0]}`](path, options);
  if (path === '/admin/catalog/types') return [200, structuredClone(TYPES)];
  if (path === '/admin/catalog/models') return [200, structuredClone(MODELS)];
  if (path === `/admin/catalog/model?id=${encodeURIComponent(OPUS_ID)}`) return [200, structuredClone(OPUS_DETAIL)];
  if (path === `/admin/catalog/model?id=${encodeURIComponent(DRAFT_ID)}`) return [200, structuredClone(DRAFT_DETAIL)];
  if (options.method === 'POST' && path === '/admin/catalog/approve') return [200, { served_within_seconds: 60, catalog_version: 'f'.repeat(16) }];
  if (options.method === 'POST') return [200, { model: {} }];
  if (path.startsWith('/admin/catalog/audit')) return [200, { events: [{ at: '2026-10-25T09:00:00Z', subject_kind: 'offer', subject_id: 'anthropic.paid', actor: XSS, action: 'create' }] }];
  return [404, null];
};
const unlock = async page => {
  page.el('admin-token').value = TOKEN;
  await page.el('unlock').listeners.submit({ preventDefault() {} });
  await drain();
};
const reviewRow = (page, index) => page.el('models').children[index].children[6].children[0].listeners.click();

// Unlock: the token goes only into the header; the list renders as text.
const page = await run({ respond: okRespond() });
assert.equal(page.calls.length, 0, 'nothing is fetched before the token is entered');
await unlock(page);
assert.equal(page.el('admin-token').value, '', 'the token leaves the input');
assert.deepEqual(page.calls.map(call => call.path).sort(), ['/admin/catalog/models', '/admin/catalog/types']);
for (const call of page.calls) {
  assert.equal(call.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(call.cache, 'no-store');
  assert.equal(call.credentials, 'same-origin');
  assert.ok(!call.path.includes(TOKEN), 'the token is never in a URL');
}
assert.equal(page.el('catalog').hidden, false);
assert.equal(page.el('unlock').hidden, true);
assert.equal(page.el('models').children.length, 3, 'two rows plus the code-only model');
assert.equal(page.el('models').children[0].children[0].textContent, OPUS_ID);
assert.match(text(page.el('models').children[0].children[5]), /pending r2/);
assert.equal(page.el('models').children[0].children[5].children[0].className, 'zx-badge zx-badge--danger', 'a risky pending change stands out');
assert.match(page.el('catalog-status').textContent, /database catalog, version 0123456789abcdef/);
assert.equal(page.el('message').textContent, '', 'Access verified: no warning');
const typeOptions = page.el('f-type').children.map(option => option.value);
assert.deepEqual(typeOptions, ['anthropic', 'groq']);

// Review: the detail renders every value as text; risky rows are marked.
await reviewRow(page, 0);
await drain();
assert.equal(page.calls.at(-1).path, `/admin/catalog/model?id=${encodeURIComponent(OPUS_ID)}`, 'ids travel URL-encoded in the query');
assert.equal(page.el('detail').hidden, false);
assert.equal(page.el('detail-title').textContent, OPUS_ID);
assert.equal(page.el('pending').hidden, false);
assert.match(page.el('pending-title').textContent, new RegExp(`by ${XSS.replace(/[()]/g, '\\$&')}`), 'the author is text');
const diffRows = page.el('diff').children;
assert.equal(diffRows.length, 2);
assert.equal(diffRows[0].className, 'models-risky');
assert.equal(diffRows[1].className, '');
assert.equal(diffRows[1].children[2].textContent, XSS, 'a proposed name is text, never markup');
assert.match(page.el('events').children[0].textContent, /<script>alert\(1\)<\/script>/);
assert.equal(page.el('approve').disabled, false);
assert.equal(page.el('enable').hidden, true);

// Risky approve: the model id must be typed; a wrong answer sends nothing.
const wrong = await run({ respond: okRespond(), promptAnswer: 'anthropic/claude-sonnet-5-5' });
await unlock(wrong);
await reviewRow(wrong, 0);
await drain();
await wrong.el('approve').listeners.click();
await drain();
assert.ok(!wrong.calls.some(call => call.method === 'POST'), 'no approval without the typed id');
assert.match(wrong.prompts[0], /pools\.paid\.daily_spend_cap_usd/);
const typed = await run({ respond: okRespond(), promptAnswer: OPUS_ID });
await unlock(typed);
await reviewRow(typed, 0);
await drain();
typed.el('decision-note').value = 'checked the Anthropic console limit';
await typed.el('approve').listeners.click();
await drain();
const approval = typed.calls.find(call => call.method === 'POST');
assert.equal(approval.path, '/admin/catalog/approve');
assert.deepEqual(approval.body, { model_id: OPUS_ID, revision_id: 41, expected_active_revision_id: 16, confirm: OPUS_ID,
  note: 'checked the Anthropic console limit' }, 'approve sends the reviewed revision and the active revision it was compared with');
assert.equal(approval.headers['Content-Type'], 'application/json');
assert.match(typed.el('message').textContent, /within 60 seconds/);

// A first approval (nothing active) sends expected_active_revision_id null; confirm is asked first.
const draft = await run({ respond: okRespond() });
await unlock(draft);
await reviewRow(draft, 1);
await drain();
await draft.el('approve').listeners.click();
await drain();
assert.deepEqual(draft.calls.find(call => call.method === 'POST').body,
  { model_id: DRAFT_ID, revision_id: 50, expected_active_revision_id: null, note: null });
const cautious = await run({ respond: okRespond(), confirmAnswer: false });
await unlock(cautious);
await reviewRow(cautious, 1);
await drain();
for (const action of ['approve', 'reject', 'disable']) await cautious.el(action).listeners.click();
await drain();
assert.ok(!cautious.calls.some(call => call.method === 'POST'), 'nothing is sent without confirmation');

// Reject and disable send the model and revision.
const decisions = await run({ respond: okRespond() });
await unlock(decisions);
await reviewRow(decisions, 0);
await drain();
await decisions.el('reject').listeners.click();
await drain();
await decisions.el('disable').listeners.click();
await drain();
const posts = decisions.calls.filter(call => call.method === 'POST');
assert.deepEqual(posts.map(call => [call.path, call.body.model_id, call.body.revision_id]),
  [['/admin/catalog/reject', OPUS_ID, 41], ['/admin/catalog/disable', OPUS_ID, undefined]]);

// Editor: a new model is checked, then saved as a draft; an existing one locks type and upstream.
const editor = await run({ respond: okRespond({
  'POST /admin/catalog/validate': () => [200, { ok: true, id: 'groq/acme/fast-2', errors: [], validation: { model: [], pools: { free: [] } },
    diff: [{ path: 'model', from: null, to: XSS, flag: 'new_model' }], risky: [], preview: { id: 'groq/acme/fast-2', tiers: ['free'], pricing: null, chosen_by_auto: false } }],
  'POST /admin/catalog/propose': () => [201, { model_id: 'groq/acme/fast-2', revision_id: 77, revision: 1, status: 'draft' }],
}) });
await unlock(editor);
await editor.el('new-model').listeners.click();
assert.equal(editor.el('editor').hidden, false);
editor.el('f-type').value = 'groq';
editor.el('f-type').listeners.change();
assert.deepEqual(editor.el('f-free-slot').children.map(option => option.value), ['groq.free']);
assert.match(editor.el('f-paid-slot').children[0].textContent, /not configured/);
editor.el('f-upstream').value = 'acme/fast-2';
editor.el('f-upstream').listeners.input();
assert.equal(editor.el('f-id').textContent, 'groq/acme/fast-2', 'the public id is derived, not typed');
editor.el('f-name').value = 'Acme Fast 2';
editor.el('f-free-on').checked = true;
editor.el('f-free-rpm').value = '30';
editor.el('f-free-tpd').value = '200000';
await editor.el('check').listeners.click();
await drain();
const validate = editor.calls.find(call => call.path === '/admin/catalog/validate');
assert.equal(validate.body.spec.provider_type, 'groq');
assert.equal(validate.body.spec.upstream_model, 'acme/fast-2');
assert.deepEqual(validate.body.spec.pools, [{ tier: 'free', key_slot: 'groq.free', price: null,
  limits: { rpm: 30, rpd: null, tpm: null, tpd: 200000 }, daily_spend_cap_usd: null }]);
assert.ok(editor.el('check-result').children.some(item => item.textContent.includes(XSS)), 'diff values render as text');
await editor.el('editor').listeners.submit({ preventDefault() {} });
await drain();
const propose = editor.calls.find(call => call.path === '/admin/catalog/propose');
assert.equal(propose.body.spec.display_name, 'Acme Fast 2');
assert.equal(editor.el('editor').hidden, true);
assert.match(editor.el('message').textContent, /Saved revision 1 of groq\/acme\/fast-2 as a draft/);
await reviewRow(editor, 0);
await drain();
await editor.el('edit').listeners.click();
assert.equal(editor.el('f-type').disabled, true, 'type and upstream are locked when changing an existing model');
assert.equal(editor.el('f-upstream').disabled, true);
assert.equal(editor.el('f-paid-cap').value, '8', 'the editor starts from the pending revision');
assert.equal(editor.el('f-paid-cache-write').value, '5');
await editor.el('load-audit').listeners.click();
await drain();
assert.match(editor.el('audit').children[0].textContent, /offer anthropic\.paid/);
assert.ok(editor.el('audit').children[0].textContent.includes(XSS), 'audit actors render as text');

// A deep link opens the model after unlocking; a refused token locks the page again.
const linked = await run({ respond: okRespond(), search: `?id=${encodeURIComponent(OPUS_ID)}` });
await unlock(linked);
assert.equal(linked.el('detail-title').textContent, OPUS_ID);
const refused = await run({ respond: () => [401, { error: { code: 'invalid_session', message: 'Operator authentication required.' } }] });
refused.el('admin-token').value = 'wrong-token'.padEnd(40, 'y');
await refused.el('unlock').listeners.submit({ preventDefault() {} });
await drain();
assert.equal(refused.el('catalog').hidden, true);
assert.equal(refused.el('unlock').hidden, false);
assert.match(refused.el('message').textContent, /not accepted/);
const expiring = await run({ respond: okRespond({ 'POST /admin/catalog/approve': () => [401, { error: { message: 'no' } }] }), promptAnswer: OPUS_ID });
await unlock(expiring);
await reviewRow(expiring, 0);
await drain();
await expiring.el('approve').listeners.click();
await drain();
assert.equal(expiring.el('catalog').hidden, true, 'a token refused mid-session locks the page');
assert.equal(expiring.el('models').children.length, 0);

// The script: no markup sinks, no storage, no eval.
for (const pattern of [/innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\.write/, /\beval\(/, /new Function/, /localStorage/,
  /sessionStorage/, /document\.cookie/, /indexedDB/]) assert.ok(!pattern.test(source), `models.js never uses ${pattern}`);
// The HTML: scripts and styles only from files, nothing from another origin, forms that cannot submit anywhere.
assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'no inline script');
assert.ok(!/<style\b/i.test(html) && !/\sstyle=/i.test(html), 'no inline style');
assert.ok(!/\son[a-z]+=/i.test(html), 'no inline event handlers');
assert.match(html, /<script defer src="\/admin\/models\/models\.js"><\/script>/);
assert.match(html, /<link rel="stylesheet" href="\/admin\/models\/models\.css">/);
assert.match(html, /<meta name="referrer" content="no-referrer">/);
assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
for (const url of html.match(/(?:src|href)="[^"]+"/g)) {
  assert.match(url, /="(\/|#|https:\/\/dashboard\.zero-x\.live\/)/, `${url}: same site only (the admin CSP allows nothing else)`);
}
for (const form of html.match(/<form[^>]*>/g)) {
  assert.match(form, /method="post"/, 'a form never puts values in a URL');
  assert.ok(!/action=/.test(form));
}
assert.match(html, /id="admin-token"[^>]*type="password"[^>]*autocomplete="off"/);
const ids = [...source.matchAll(/\$\('([a-z0-9-]+)'\)/g)].map(match => match[1]);
for (const id of new Set(ids)) assert.match(html, new RegExp(`id="${id}"`), `models.js element #${id} exists in index.html`);
assert.ok(!/url\(|@import|https?:/.test(css.replace(/\/\*[\s\S]*?\*\//g, '')), 'the stylesheet loads nothing');
console.log('PASS: model catalog page: token in memory and headers only, values as text, approve sends the reviewed revision ids (typed id for risky changes), confirmed decisions, editor validates then proposes, 401 locks, no inline script or style');

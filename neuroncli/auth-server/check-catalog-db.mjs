// Data-driven catalog: provider-type registry (src/catalog-types.js), guardrails
// (src/catalog-guardrails.js, src/list-prices.js), loader (src/catalog-db.js), operator API
// (src/routes/catalog-admin.js) and migrations 20261025000000_catalog_models.sql and
// 20261025000100_catalog_seed.sql. Offline: PGlite for the database, no outbound requests.
//   node check-catalog-db.mjs
//
// src/catalog.js reads the loader, so the /v1/models and routing parity sections use the real
// catalog.js and router.js. On a tree where catalog.js does not import catalog-db.js they load a
// copy whose catalogEntries, catalogEntry and lookup read catalogSnapshot(env) instead.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { PGlite } from '@electric-sql/pglite';
import { rpcRows } from './src/account-store.js';
import { closeAllPglite, getPgliteHandle } from './src/db/pglite.js';
import { DEV_BOOTSTRAP_SQL } from './src/db/bootstrap.js';
import { listMigrations } from './src/db/migrations.js';
import { CATALOG, MODELS_VARS as CODE_MODELS_VARS, VAULT_KEY_VARS as CODE_VAULT_KEY_VARS } from './src/catalog.js';
import { RoutingEngine as CodeRoutingEngine } from './src/router.js';
import { ProviderHealthTracker } from './src/provider-health.js';
import { ADAPTERS } from './src/providers.js';
import { MARKUP, priceFromCost } from './src/pricing.js';
import { LIST_PRICES, listPriceFor, listPriceMicro, MAX_DAILY_SPEND_CAP_USD } from './src/list-prices.js';
import {
  baseUrlFor, CATALOG_ACTIONS, CATALOG_STATUSES, catalogCan, KEY_SLOTS, MODELS_VARS, poolSource, PROVIDER_TYPE_IDS,
  PROVIDER_TYPES, publicIdFor, slotAllowed, TIERS, typeMaxCapMicrousd, upstreamAllowed, VAULT_KEY_VARS,
} from './src/catalog-types.js';
import {
  apiFromSpec, billedDailyCapMicrousd, canonicalSpec, codeSpec, effectiveSpendCapUsd, entryFromSpec, priceFromSpec,
  riskyChanges, specDiff, specFromApi, specValid, validateSpec,
} from './src/catalog-guardrails.js';
import {
  buildSnapshot, catalogSnapshot, catalogStatus, codeCatalog, codeSnapshot, loadCatalog, resetCatalogCache,
} from './src/catalog-db.js';
import { ANTHROPIC_PAID_OFFER, CLAUDE_MODEL_SPECS } from './src/catalog-claude.js';
import { previewModel, proposeCandidateDraft, registerCatalogAdminRoutes } from './src/routes/catalog-admin.js';
import { buildManifest, canonicalJson, validateManifest } from './src/oiop/manifest.js';
import { SEED_FILE, seedSql } from './scripts/catalog-seed-sql.mjs';

const passed = [];
function ok(name) { passed.push(name); console.log(`ok - ${name}`); }
const DB = { DATABASE_DRIVER: 'pglite' };
const ADMIN = 'catalog-admin-token-0123456789abcdef0123';
const SRC = new URL('./src/', import.meta.url);
const fixture = JSON.parse(readFileSync(new URL('./fixtures/v1-models-baseline.json', import.meta.url), 'utf8'));
const handle = () => getPgliteHandle(DB);
const sql = async (text, params) => (await (await handle()).db.query(text, params)).rows;
const asRole = async (role, text, params) => (await handle()).db.transaction(async tx => {
  await tx.exec(`SET LOCAL ROLE ${role}`);
  return (await tx.query(text, params)).rows;
});
const clone = value => structuredClone(value);
const SONNET = CLAUDE_MODEL_SPECS[0];
const OPUS = CLAUDE_MODEL_SPECS[1];
const SONNET_ID = 'anthropic/claude-sonnet-5-5';
const OPUS_ID = 'anthropic/claude-opus-5-5';
const realFetch = globalThis.fetch;
globalThis.fetch = async input => { throw new Error(`Unexpected outbound request: ${String(input?.url ?? input)}`); };

// Fields of a catalog entry and its pools that src/catalog.js, the router and /v1/models read.
const ENTRY_FIELDS = ['id', 'display_name', 'provider', 'upstream_model', 'context_window', 'max_output_tokens', 'supports_tools',
  'supports_streaming', 'supports_vision', 'auto_rank', 'default_enabled', 'hosted_flag', 'geo_block_free', 'aliases',
  'reasoning_efforts', 'reasoning_effort_map'];
const POOL_FIELDS = ['tier', 'key_var', 'binding', 'limits', 'price', 'requires_flag'];
const pick = (object, keys) => Object.fromEntries(keys.filter(key => object[key] !== undefined).map(key => [key, clone(object[key])]));
const entryView = entry => ({ ...pick(entry, ENTRY_FIELDS), pools: entry.pools.map(pool => pick(pool, POOL_FIELDS)) });

// ── Module views for the parity sections (see the header) ──
async function catalogModules() {
  const source = readFileSync(new URL('catalog.js', SRC), 'utf8');
  if (/from '\.\/catalog-db\.js'/.test(source)) {
    return { integrated: true, catalog: await import('./src/catalog.js'), router: await import('./src/router.js') };
  }
  const absolute = text => text.replace(/from '\.\/([^']+)'/g, (_, path) => `from '${new URL(path, SRC).href}'`);
  let view = `import { catalogSnapshot as viewSnapshot } from '${new URL('catalog-db.js', SRC).href}';\n${absolute(source)}`;
  const patch = (from, to) => {
    assert.ok(view.includes(from), `catalog view: "${from}" is still in src/catalog.js`);
    view = view.replace(from, to);
  };
  patch('export function catalogEntries(env) {', 'export function catalogEntries(env) {\n  return viewSnapshot(env).entries;');
  patch('export function catalogEntry(id, env) {',
    "export function catalogEntry(id, env) {\n  return typeof id === 'string' ? viewSnapshot(env).byId.get(id.toLowerCase()) ?? null : null;");
  patch('function lookup(value, env) {', 'function lookup(value, env) {\n  if (value === AUTO_MODEL_ID) return AUTO_MODEL_ID;\n' +
    '  { const snapshot = viewSnapshot(env); return snapshot.byId.get(value)?.id ?? snapshot.aliases.get(value) ?? null; }');
  patch('function describeAuto(models) {', 'function describeAuto(models, env) {');
  patch('catalogEntry(model.id)?.auto_rank', 'catalogEntry(model.id, env)?.auto_rank');
  patch('[describeAuto(data), ...data]', '[describeAuto(data, env), ...data]');
  const catalogUrl = `data:text/javascript;base64,${Buffer.from(view).toString('base64')}`;
  const routerSource = absolute(readFileSync(new URL('router.js', SRC), 'utf8'))
    .replaceAll(`from '${new URL('catalog.js', SRC).href}'`, `from '${catalogUrl}'`);
  return {
    integrated: false, catalog: await import(catalogUrl),
    router: await import(`data:text/javascript;base64,${Buffer.from(routerSource).toString('base64')}`),
  };
}

try {
  // ── 1. Registry and its SQL mirrors ──
  {
    const corpus = ['gemini-2.5-flash', 'gemini-3.6-flash', 'gemini-', 'gemini-2.5-flash/../x', 'gemini-ABC', 'gemini-1.5-pro-002',
      'openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'gpt-oss-20b', 'openai/gpt-oss-120b/extra', 'a/b/c', 'org/model:tag',
      '@cf/openai/gpt-oss-120b', '@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/../../accounts/x', '@cf/meta/../x',
      '@cf/meta/llama%2f..', '@cf/meta/llama 3', '@CF/a/b', '@cf/a', '@cf/a/b', 'cohere/north-mini-code:free',
      'minimax/minimax-m3.1-flash:free', 'cohere/north-mini-code', 'cohere/north:free:free', 'a/b/c:free', '0/0:free',
      'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-', 'claude-x/../../v1/files', 'claude-sonnet-5-5?x=1', 'Claude-sonnet',
      'claude-3-5-sonnet-20241022', 'nvidia/nemotron-3-ultra-550b-a55b', 'stepfun-ai/step-5-preview', 'model:latest',
      'a..b', '', ' ', 'x'.repeat(201), 'a'.repeat(81), `org/${'m'.repeat(81)}`, 'https://evil.example/v1', '//evil',
      '../etc/passwd', 'ok-model', 'openai/gpt-oss-120b\n', 'café', 'gemini-2.5-flash#x', 'groq/openai/gpt-oss-120b',
      'omniroute/x', 'a/b:free', '-x', '_x', 'x_', 'm', 'nvidia/x', 'org/model?x', 'org\\model'];
    const rows = await sql(`SELECT t, u, public.zerox_catalog_upstream_ok(t, u) AS ok, public.zerox_catalog_public_id(t, u) AS id
      FROM unnest($1::text[]) AS t CROSS JOIN unnest($2::text[]) AS u`, [[...PROVIDER_TYPE_IDS, 'evil'], corpus]);
    assert.equal(rows.length, (PROVIDER_TYPE_IDS.length + 1) * corpus.length);
    for (const row of rows) {
      assert.equal(row.ok, upstreamAllowed(row.t, row.u), `upstream_ok(${row.t}, ${JSON.stringify(row.u)})`);
      assert.equal(row.ok ? row.id : null, publicIdFor(row.t, row.u), `public_id(${row.t}, ${JSON.stringify(row.u)})`);
    }
    for (const injected of ['@cf/../../accounts/x', '@cf/meta/../x', 'claude-x/../../v1/files', 'openai/gpt-oss-120b/extra']) {
      assert.ok(PROVIDER_TYPE_IDS.every(type => type === 'omniroute' || !upstreamAllowed(type, injected)), `${injected} is refused`);
    }
    const slots = [...Object.keys(KEY_SLOTS), 'SUPABASE_SECRET_KEY', 'GATEWAY_ADMIN_TOKEN', 'anthropic.free', 'groq'];
    const slotRows = await sql(`SELECT t, tier, s, public.zerox_catalog_slot_ok(t, tier, s) AS ok
      FROM unnest($1::text[]) AS t CROSS JOIN unnest($2::text[]) AS tier CROSS JOIN unnest($3::text[]) AS s`,
    [PROVIDER_TYPE_IDS, [...TIERS, 'gold'], slots]);
    for (const row of slotRows) assert.equal(row.ok, slotAllowed(row.t, row.tier, row.s), `slot_ok(${row.t}, ${row.tier}, ${row.s})`);
    for (const type of [...PROVIDER_TYPE_IDS, 'evil']) {
      const [{ cap }] = await sql('SELECT public.zerox_catalog_type_max_cap_microusd($1)::bigint AS cap', [type]);
      assert.equal(Number(cap), typeMaxCapMicrousd(type), `type max cap of ${type}`);
    }
    assert.deepEqual((await sql('SELECT public.zerox_catalog_provider_types() AS t'))[0].t, PROVIDER_TYPE_IDS);
    const actions = ['propose', 'approve', 'reject', 'disable', 'enable', 'delete'];
    const can = await sql(`SELECT s, a, public.zerox_catalog_can(s, a) AS ok FROM unnest($1::text[]) AS s CROSS JOIN unnest($2::text[]) AS a`,
      [[...CATALOG_STATUSES, 'gone'], actions]);
    for (const row of can) assert.equal(row.ok, catalogCan(row.s, row.a), `can(${row.s}, ${row.a})`);
    assert.deepEqual(Object.keys(CATALOG_ACTIONS), CATALOG_STATUSES);
    assert.equal(typeMaxCapMicrousd('anthropic'), 50_000_000, 'anthropic pools: at most $50 a day');
    assert.equal(typeMaxCapMicrousd('gemini'), MAX_DAILY_SPEND_CAP_USD * 1e6, 'other paid pools: at most the $100 code maximum');
    assert.equal(MAX_DAILY_SPEND_CAP_USD, 100);
    for (const type of ['nvidia', 'openrouter', 'omniroute']) assert.equal(typeMaxCapMicrousd(type), 0, `${type} has no paid pools`);
    ok(`SQL mirrors equal the code registry: upstream grammar and public ids on ${rows.length} pairs, key slots on ${slotRows.length}, type caps, provider types, lifecycle actions`);

    for (const [id, slot] of Object.entries(KEY_SLOTS)) {
      assert.ok(slot.binding === 'cloudflare' || /^[A-Z]+_(PAID_)?API_KEY$/.test(slot.env), `${id} names a provider API key only`);
      assert.deepEqual(poolSource(id), slot.binding ? { binding: 'cloudflare' } : { key_var: slot.env });
    }
    for (const name of ['SUPABASE_SECRET_KEY', 'GATEWAY_ADMIN_TOKEN', 'PROVIDER_KEYS_KEK', 'ANTHROPIC_API_KEY', '__proto__']) {
      assert.equal(poolSource(name), null, `${name} is not a slot id`);
    }
    assert.deepEqual(Object.entries(VAULT_KEY_VARS).sort(), Object.entries(CODE_VAULT_KEY_VARS).sort(), 'vault slots = catalog.js VAULT_KEY_VARS');
    for (const [provider, variable] of Object.entries(CODE_MODELS_VARS)) assert.equal(MODELS_VARS[provider], variable);
    for (const type of ['gemini', 'groq', 'nvidia', 'openrouter']) {
      assert.equal(ADAPTERS[type].getBaseUrl({}), PROVIDER_TYPES[type].base_url, `${type}: the adapter calls the registry's base URL`);
      assert.equal(baseUrlFor(type, { [`${type.toUpperCase()}_BASE_URL`]: 'https://evil.example' }), PROVIDER_TYPES[type].base_url);
    }
    const omni = { OMNIROUTE_BASE_URL: 'https://omni.example/v1/' };
    assert.equal(baseUrlFor('omniroute', omni), 'https://omni.example/v1');
    assert.equal(baseUrlFor('omniroute', omni), ADAPTERS.omniroute.getBaseUrl(omni));
    for (const bad of ['https://u:p@omni.example', 'http://omni.example', 'https://omni.example/?x=1', 'not a url']) {
      assert.equal(baseUrlFor('omniroute', { OMNIROUTE_BASE_URL: bad }), null, `${bad} is refused`);
    }
    assert.equal(baseUrlFor('cloudflare', {}), null, 'Workers AI goes through the binding');
    try {
      const { ANTHROPIC, UPSTREAM_MODEL } = await import('./src/anthropic-request.js');
      assert.equal(PROVIDER_TYPES.anthropic.base_url, ANTHROPIC.baseURL, 'the Claude adapter calls the registry base URL');
      assert.equal(PROVIDER_TYPES.anthropic.upstream.source, UPSTREAM_MODEL.source);
      assert.ok(PROVIDER_TYPES.anthropic.slots.paid.includes(ANTHROPIC.keySlot));
    } catch (error) {
      if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    }
    ok('key slots name provider API keys only (no Worker secret can be reached from a row); base URLs come from code (omniroute: a validated secret)');
  }

  // ── 2. List prices and billed prices ──
  {
    const sonnet = listPriceFor('anthropic', 'claude-sonnet-5-5');
    const opus = listPriceFor('anthropic', 'claude-opus-5-5');
    assert.deepEqual({ ...sonnet }, { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5, cache_write_1h: 4 });
    assert.deepEqual({ ...opus }, { input: 4, output: 20, cache_read: 0.2, cache_write: 5, cache_write_1h: 8 });
    for (const price of [sonnet, opus]) {
      assert.equal(price.cache_write, price.input * 1.25, '5-minute cache writes are 1.25x input');
      assert.equal(price.cache_write_1h, price.input * 2, '1-hour cache writes are 2x input');
    }
    assert.equal(listPriceFor('gemini', 'gemini-3.6-flash', Date.UTC(2026, 11, 31, 23)).input, 0.75);
    assert.equal(listPriceFor('gemini', 'gemini-3.6-flash', Date.UTC(2027, 0, 1)).input, 1.5, 'the scheduled price applies from its date');
    assert.equal(listPriceFor('anthropic', 'claude-unknown'), null);
    const billed = spec => { const price = priceFromSpec(spec.pools[0].price);
      return [price.input_microusd_per_mtok, price.output_microusd_per_mtok, price.cache_read_microusd_per_mtok,
        price.cache_write_microusd_per_mtok, price.cache_write_1h_microusd_per_mtok]; };
    assert.deepEqual(billed(SONNET), [2_500_000, 12_500_000, 250_000, 3_125_000, 5_000_000], 'Sonnet billed at list x 1.25');
    assert.deepEqual(billed(OPUS), [5_000_000, 25_000_000, 250_000, 6_250_000, 10_000_000], 'Opus billed at list x 1.25');
    assert.deepEqual(priceFromSpec(SONNET.pools[0].price).upstream_cost_usd_per_mtok,
      { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5, cache_write_1h: 4 });
    let paidPools = 0;
    for (const entry of CATALOG) {
      for (const pool of entry.pools.filter(item => item.tier === 'paid')) {
        paidPools++;
        assert.ok(listPriceFor(entry.provider, entry.upstream_model), `${entry.id} has a list price`);
        assert.deepEqual(priceFromSpec(listPriceMicro(entry.provider, entry.upstream_model)), pool.price,
          `${entry.id}: the code price is the list price`);
      }
    }
    assert.deepEqual(priceFromSpec({ input: 293000, output: 2253000, cache_read: null, cache_write: null, cache_write_1h: null, long: null }),
      priceFromCost(0.293, 2.253), 'micro-USD rows rebuild the exact code price');
    for (const key of Object.keys(LIST_PRICES)) assert.match(key, /^[a-z]+:[a-z0-9@][a-z0-9@./:_-]*$/);
    const offenders = readdirSync(SRC, { recursive: true }).map(String).filter(file => file.endsWith('.js'))
      .filter(file => /\bMARKUP\s*=/.test(readFileSync(new URL(file.replaceAll('\\', '/'), SRC), 'utf8')));
    assert.deepEqual(offenders, ['pricing.js'], 'MARKUP is defined in src/pricing.js only');
    assert.equal(MARKUP, 1.25);
    const fresh = ['catalog-types.js', 'catalog-guardrails.js', 'catalog-db.js', 'catalog-claude.js', 'list-prices.js', 'routes/catalog-admin.js'];
    for (const file of fresh) {
      const text = readFileSync(new URL(file, SRC), 'utf8');
      assert.ok(!/from 'node:|require\(|\bprocess\.|\bBuffer\b/.test(text), `src/${file} stays Workers-only`);
      assert.ok(!/CATALOG_APPROVAL_KEY/.test(text), `src/${file} has no approval MAC`);
      assert.ok(!/redirect:\s*['"]error['"]/.test(text));
    }
    for (const file of ['20261025000000_catalog_models.sql', '20261025000100_catalog_seed.sql']) {
      const code = readFileSync(new URL(`./migrations/${file}`, import.meta.url), 'utf8').replace(/--[^\n]*/g, '');
      assert.ok(!/approval_mac|CATALOG_APPROVAL_KEY|markup|\b1\.25\b/i.test(code), `${file}: no MAC and no markup in SQL`);
    }
    ok(`list prices: Claude from the skill docs (cache writes 1.25x/2x input), effective-dated changes, all ${paidPools} code paid pools priced from the table; MARKUP only in pricing.js; new modules Workers-only, no approval MAC`);
  }

  // ── 3. Guardrails accept the code catalog and rebuild it exactly ──
  {
    const { items } = codeCatalog();
    assert.equal(items.length, CATALOG.length, 'code catalog = src/catalog.js CATALOG');
    assert.deepEqual(CATALOG.slice(-2).map(entry => entry.id), [SONNET_ID, OPUS_ID], 'src/catalog.js lists the two Claude rows from src/catalog-claude.js');
    for (const item of items) {
      const validation = validateSpec(item.id, item.spec);
      assert.ok(specValid(validation), `${item.id}: ${JSON.stringify(validation)}`);
      assert.equal(canonicalSpec(specFromApi(apiFromSpec(item.spec)).spec), canonicalSpec(item.spec), `${item.id}: API form round trip`);
    }
    CATALOG.forEach((entry, index) => {
      const spec = codeSpec(entry, { position: (index + 1) * 10 });
      assert.deepEqual(entryView(entryFromSpec(entry.id, spec)), entryView(entry), `${entry.id}: a row rebuilds the code entry`);
    });
    for (const spec of CLAUDE_MODEL_SPECS) {
      const id = publicIdFor(spec.provider_type, spec.upstream_model);
      const entry = entryFromSpec(id, spec, { source: 'code' });
      assert.equal(canonicalSpec(codeSpec(entry)), canonicalSpec(spec), `${id}: entry and spec round trip`);
      assert.deepEqual([entry.auto_rank, entry.context_window, entry.max_output_tokens, entry.default_max_tokens, entry.default_reasoning_effort],
        [null, 200000, 32000, 16000, 'medium']);
      assert.deepEqual(entry.pools.map(pool => [pool.tier, pool.key_var, pool.key_slot]), [['paid', 'ANTHROPIC_API_KEY', 'anthropic.paid']]);
    }
    const sonnetEntry = codeCatalog().byId.get(SONNET_ID).entry;
    const opusEntry = codeCatalog().byId.get(OPUS_ID).entry;
    assert.equal(effectiveSpendCapUsd({}, sonnetEntry, sonnetEntry.pools[0]), 10);
    assert.equal(effectiveSpendCapUsd({}, opusEntry, opusEntry.pools[0]), 6);
    assert.equal(billedDailyCapMicrousd({}, sonnetEntry, sonnetEntry.pools[0]), 12_500_000, 'p_pool.cpd is billed micro-USD');
    assert.equal(effectiveSpendCapUsd({ PAID_DAILY_SPEND_CAP_USD: '4' }, sonnetEntry, sonnetEntry.pools[0]), 4);
    const codeCap = id => { const entry = CATALOG.find(item => item.id === id); return effectiveSpendCapUsd({}, entry, entry.pools.find(pool => pool.tier === 'paid')); };
    assert.deepEqual(['gemini/gemini-2.5-flash', 'gemini/gemini-2.5-pro', 'groq/openai/gpt-oss-120b', '@cf/meta/llama-3.3-70b-instruct-fp8-fast']
      .map(codeCap), [10, 10, 5, 5], 'existing paid pools: Gemini $10, Groq and Workers AI $5 a day');
    assert.equal(effectiveSpendCapUsd({}, sonnetEntry, { ...sonnetEntry.pools[0], daily_spend_cap_usd: 80 }), 50, 'clamped to the anthropic maximum');
    assert.equal(effectiveSpendCapUsd({}, CATALOG[0], { tier: 'paid', key_var: 'GEMINI_PAID_API_KEY', daily_spend_cap_usd: 500 }), 100, 'clamped to $100');
    assert.equal(effectiveSpendCapUsd({}, CATALOG[0], CATALOG[0].pools[0]), null, 'free pools have no spend cap');
    assert.equal(effectiveSpendCapUsd({}, { provider: 'nvidia' }, { tier: 'paid', daily_spend_cap_usd: 5 }), null, 'no paid pools for nvidia');
    ok(`all ${items.length} code models pass the guardrails, rebuild their code entries field for field, and carry daily caps (Sonnet $10, Opus $6)`);
  }

  // ── 4. Guardrail attacks ──
  {
    const variant = (base, change) => { const spec = clone(base); change(spec); return spec; };
    const paid = spec => spec.pools.find(pool => pool.tier === 'paid');
    const reasons = (id, spec) => { const result = validateSpec(id, spec); return [...result.model, ...Object.entries(result.pools)
      .flatMap(([tier, list]) => list.map(reason => `${tier}:${reason}`))]; };
    const cases = [
      ['foreign key slot', SONNET_ID, variant(SONNET, s => { paid(s).key_slot = 'groq.free'; }), 'paid:key_slot_not_allowed'],
      ['a Worker secret as slot', SONNET_ID, variant(SONNET, s => { paid(s).key_slot = 'SUPABASE_SECRET_KEY'; }), 'paid:key_slot_not_allowed'],
      ['$0 paid pool', SONNET_ID, variant(SONNET, s => { paid(s).price.input = 0; }), 'paid:paid_without_price'],
      ['unpriced paid pool', SONNET_ID, variant(SONNET, s => { paid(s).price = null; }), 'paid:paid_without_price'],
      ['below list', SONNET_ID, variant(SONNET, s => { paid(s).price.output = 9_000_000; }), 'paid:price_mismatch_list'],
      ['above list', SONNET_ID, variant(SONNET, s => { paid(s).price.input = 6_000_000; }), 'paid:price_mismatch_list'],
      ['cheap cache read', SONNET_ID, variant(SONNET, s => { paid(s).price.cache_read = 1; }), 'paid:price_mismatch_list'],
      ['missing cache prices', SONNET_ID, variant(SONNET, s => { Object.assign(paid(s).price, { cache_read: null, cache_write: null }); }),
        'paid:cache_price_missing'],
      ['cap above the code maximum', SONNET_ID, variant(SONNET, s => { paid(s).daily_spend_cap_microusd = 1_000_000 * 1_000_000; }), 'paid:cap_above_max'],
      ['cap above the anthropic maximum', SONNET_ID, variant(SONNET, s => { paid(s).daily_spend_cap_microusd = 51_000_000; }), 'paid:cap_above_max'],
      ['no cap', SONNET_ID, variant(SONNET, s => { paid(s).daily_spend_cap_microusd = null; }), 'paid:cap_missing'],
      ['an anthropic free pool', SONNET_ID, variant(SONNET, s => { s.pools.unshift({ tier: 'free', key_slot: 'anthropic.paid', price: null,
        limits: {}, daily_spend_cap_microusd: null }); }), 'free:tier_not_offered'],
      ['unlisted Claude model', 'anthropic/claude-sonnet-9', variant(SONNET, s => { s.upstream_model = 'claude-sonnet-9'; s.aliases = []; }),
        'paid:unlisted_paid_not_allowed'],
      ['path injection', '@cf/../../accounts/x', variant(codeCatalog().byId.get('@cf/openai/gpt-oss-120b').spec, s => {
        s.upstream_model = '@cf/../../accounts/x'; }), 'upstream_pattern'],
      ['path injection (Claude)', SONNET_ID, variant(SONNET, s => { s.upstream_model = 'claude-x/../../v1/files'; }), 'upstream_pattern'],
      ['id squatting', OPUS_ID, SONNET, 'id_mismatch'],
      ['alias squatting another id space', SONNET_ID, variant(SONNET, s => { s.aliases = ['gemini/gemini-2.5-flash']; }), 'alias_invalid'],
      ['alias auto', SONNET_ID, variant(SONNET, s => { s.aliases = ['auto']; }), 'alias_invalid'],
      ['markup in the name', SONNET_ID, variant(SONNET, s => { s.display_name = '<img src=x onerror=alert(1)>'; }), 'display_name_invalid'],
      ['unknown provider type', SONNET_ID, variant(SONNET, s => { s.provider_type = 'evil'; }), 'unknown_provider_type'],
      ['priced free pool', 'gemini/gemini-2.5-flash', variant(codeCatalog().byId.get('gemini/gemini-2.5-flash').spec, s => {
        s.pools[0].daily_spend_cap_microusd = 5_000_000; }), 'free:free_pool_priced'],
      ['unlisted Gemini price out of band', 'gemini/gemini-9-flash', variant(codeCatalog().byId.get('gemini/gemini-2.5-flash').spec, s => {
        s.upstream_model = 'gemini-9-flash'; s.aliases = []; paid(s).price.input = 1; }), 'paid:unlisted_price_out_of_band'],
      ['default max_tokens above the output limit', SONNET_ID, variant(SONNET, s => { s.default_max_tokens = 64000; }), 'default_max_tokens_invalid'],
      ['default effort not offered', OPUS_ID, variant(OPUS, s => { s.default_reasoning_effort = 'none'; }), 'effort_invalid'],
    ];
    for (const [name, id, spec, expected] of cases) assert.ok(reasons(id, spec).includes(expected), `${name}: ${reasons(id, spec)}`);
    const unlisted = variant(codeCatalog().byId.get('gemini/gemini-2.5-flash').spec, s => { s.upstream_model = 'gemini-9-flash'; s.aliases = []; });
    assert.ok(specValid(validateSpec('gemini/gemini-9-flash', unlisted)), 'an unlisted Gemini model inside the band passes');
    // No URL can ride along: the API form refuses unknown fields, and specs drop them.
    const api = apiFromSpec(SONNET);
    assert.ok(specFromApi({ ...api, base_url: 'https://evil.example/v1' }).errors.includes('unknown_field:base_url'));
    assert.ok(specFromApi({ ...api, pools: [{ ...api.pools[0], key_var: 'SUPABASE_SECRET_KEY' }] }).errors.includes('unknown_field:pools.paid.key_var'));
    assert.ok(specFromApi({ ...api, pools: [{ ...api.pools[0], daily_spend_cap_usd: 0.0000001 }] }).errors
      .includes('too_many_decimals:pools.paid.daily_spend_cap_usd'));
    const smuggled = { ...clone(SONNET), base_url: 'https://evil.example', pools: [{ ...clone(SONNET.pools[0]), key_var: 'SUPABASE_SECRET_KEY' }] };
    const entry = entryFromSpec(SONNET_ID, smuggled);
    assert.ok(!JSON.stringify(entry).includes('evil.example') && entry.pools[0].key_var === 'ANTHROPIC_API_KEY', 'extra fields never reach an entry');
    assert.equal(canonicalSpec(smuggled), canonicalSpec(SONNET), 'specs keep known fields only');
    const columns = await sql(`SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name LIKE 'zerox_catalog_%'`);
    assert.ok(columns.length > 40);
    assert.ok(!columns.some(column => /url|host|endpoint|key_var|env|secret/.test(column.column_name)), 'no catalog column can hold a URL or env var');
    ok(`${cases.length} guardrail attacks rejected with their reason (foreign slot, $0 and off-list prices, caps above the code maximum, path injection, id and alias squatting); no URL or env var can enter a row`);
  }

  // ── 5. The seed equals code ──
  {
    assert.equal(readFileSync(SEED_FILE, 'utf8').replace(/\r\n/g, '\n'), seedSql(),
      'migrations/20261025000100_catalog_seed.sql is what scripts/catalog-seed-sql.mjs generates');
    const rows = await rpcRows(DB, 'zerox_catalog_snapshot', {});
    const { items } = codeCatalog();
    assert.deepEqual(rows.map(row => row.id), items.map(item => item.id), 'seeded in code order');
    for (const item of items) {
      const row = rows.find(candidate => candidate.id === item.id);
      assert.deepEqual([row.status, row.revision], ['active', 1]);
      assert.equal(canonicalSpec(row.spec), canonicalSpec(item.spec), `${item.id}: seeded spec = code spec`);
    }
    const revisions = await sql("SELECT count(*)::int AS n FROM public.zerox_catalog_revisions WHERE approved_by = 'migration' AND revision = 1");
    assert.equal(revisions[0].n, items.length);
    const events = await sql(`SELECT e.model_id, e.action, e.actor, e.revision_id = m.active_revision_id AS same
      FROM public.zerox_catalog_events AS e JOIN public.zerox_catalog_models AS m ON m.id = e.model_id`);
    assert.equal(events.length, items.length);
    assert.ok(events.every(event => event.action === 'seed' && event.actor === 'migration' && event.same), 'one seed audit row per model');
    const offer = (await rpcRows(DB, 'zerox_offers_list', {})).find(row => row.id === 'anthropic.paid');
    for (const [field, value] of Object.entries(ANTHROPIC_PAID_OFFER)) {
      if (field === 'terms_fetched_at') continue;
      assert.equal(canonicalJson(offer[field] ?? null), canonicalJson(value ?? null), `anthropic.paid.${field}`);
    }
    assert.deepEqual(validateManifest(buildManifest(offer, [])), [], 'the anthropic.paid offer has a valid OIOP manifest');
    const offerEvents = await sql("SELECT count(*)::int AS n FROM public.zerox_offer_events WHERE offer_id = 'anthropic.paid' AND action = 'create' AND actor = 'migration'");
    assert.equal(offerEvents[0].n, 1);
    ok(`seed: ${items.length} active rows equal to their code specs (generated file up to date), one seed audit row each; anthropic.paid offer equals src/catalog-claude.js`);
  }

  // ── 6. /v1/models from the rows equals the code catalog and the captured baseline ──
  const modules = await catalogModules();
  {
    const withoutClaude = list => list.filter(item => !item.id.startsWith('anthropic/'));
    const items = fixture.items;
    const dbEnvs = new Map();
    const codeEnvs = new Map();
    let compared = 0;
    for (const testCase of fixture.cases) {
      const key = JSON.stringify(testCase.env);
      if (!dbEnvs.has(key)) {
        dbEnvs.set(key, { ...clone(testCase.env), DATABASE_DRIVER: 'pglite' });
        codeEnvs.set(key, { ...clone(testCase.env), DATABASE_DRIVER: 'pglite', CATALOG_SOURCE: 'code' });
        const snapshot = await loadCatalog(dbEnvs.get(key), { wait: Infinity });
        assert.equal(snapshot.source, 'database');
        assert.ok([...snapshot.verdicts.values()].every(verdict => verdict.served_from === 'database' && !verdict.reasons.length));
      }
      const fromRows = JSON.parse(JSON.stringify(modules.catalog.listModelsForCaller(dbEnvs.get(key), testCase.options).data));
      const fromCode = JSON.parse(JSON.stringify(modules.catalog.listModelsForCaller(codeEnvs.get(key), testCase.options).data));
      assert.deepEqual(fromRows, fromCode, `${testCase.name}: rows and CATALOG_SOURCE=code agree`);
      assert.deepEqual(withoutClaude(fromRows), testCase.data.map(index => items[index]), `${testCase.name}: equals the baseline`);
      assert.deepEqual(fromRows.filter(item => item.id.startsWith('anthropic/')).map(item => item.id), [SONNET_ID, OPUS_ID]);
      compared++;
    }
    const keys = dbEnvs.get(JSON.stringify(fixture.cases.find(item => item.name.startsWith('keys/')).env));
    const claude = modules.catalog.listModelsForCaller(keys, { plan: 'max', tiers: ['free', 'paid'], country: 'US' }).data
      .filter(item => item.id.startsWith('anthropic/'));
    assert.deepEqual(claude.map(item => [item.tiers, item.context_window, item.max_output_tokens, item.capabilities.vision]),
      [[['paid'], 200000, 32000, true], [['paid'], 200000, 32000, true]]);
    const auto = modules.catalog.listModelsForCaller(keys, { plan: 'max', tiers: ['free', 'paid'], country: 'US' }).data[0];
    assert.equal(auto.id, 'auto');
    ok(`/v1/models from the seeded rows equals CATALOG_SOURCE=code and fixtures/v1-models-baseline.json (minus the two Claude rows) on all ${compared} cases${modules.integrated ? '' : ' (catalog view; src/catalog.js not wired yet)'}`);
  }

  // ── 7. Routing from the rows equals routing from code ──
  {
    const summary = result => result.ok
      ? { ok: true, model: result.model, candidates: result.candidates.map(item => [item.entry.id, item.pool.tier, item.key, item.offer?.id ?? null, item.maxTokens]) }
      : { ok: false, error: result.error, message: result.message ?? null };
    const route = (Engine, env, request) => summary(new Engine(new ProviderHealthTracker()).route({ env, promptTokens: 2000, maxTokens: 4096,
      affinity: 'caller-1', ...request }));
    const ids = codeCatalog().items.map(item => item.id);
    const aliases = codeCatalog().items.flatMap(item => item.spec.aliases);
    const requests = ['auto', 'default', 'AUTO', ...ids, ...aliases, ...ids.slice(0, 6).map(id => `openai/${id}`), 'nope/unknown'];
    let checked = 0;
    for (const envName of ['keys', 'narrowed', 'free_only']) {
      const base = fixture.cases.find(item => item.name.startsWith(`${envName}/`)).env;
      const dbEnv = { ...clone(base), DATABASE_DRIVER: 'pglite' };
      const codeEnv = { ...clone(base), DATABASE_DRIVER: 'pglite', CATALOG_SOURCE: 'code' };
      await loadCatalog(dbEnv, { wait: Infinity });
      for (const requestedModel of requests) {
        for (const tiers of [['free'], ['free', 'paid']]) {
          for (const country of ['US', 'DE']) {
            for (const needs of [{}, { tools: true, vision: true }]) {
              const request = { requestedModel, tiers, country, needs };
              const fromRows = route(modules.router.RoutingEngine, dbEnv, request);
              assert.deepEqual(fromRows, route(modules.router.RoutingEngine, codeEnv, request), `${envName} ${requestedModel}: rows = code`);
              if (!requestedModel.includes('claude')) {
                assert.deepEqual(fromRows, route(CodeRoutingEngine, { ...clone(base) }, request), `${envName} ${requestedModel}: rows = today's router`);
              }
              checked++;
            }
          }
        }
      }
    }
    const keys = { ...clone(fixture.cases.find(item => item.name.startsWith('keys/')).env), DATABASE_DRIVER: 'pglite' };
    await loadCatalog(keys, { wait: Infinity });
    const sonnet = route(modules.router.RoutingEngine, keys, { requestedModel: 'claude-sonnet-5-5', tiers: ['free', 'paid'], country: 'US' });
    const freeOnly = route(modules.router.RoutingEngine, keys, { requestedModel: SONNET_ID, tiers: ['free'], country: 'US' });
    assert.ok(sonnet.ok ? sonnet.candidates.every(item => item[1] === 'paid') : sonnet.error === 'model_not_found' || sonnet.error === 'upgrade_required',
      'Claude routes through paid pools only');
    assert.equal(freeOnly.ok, false, 'Free plans never reach Claude');
    const autoRoute = route(modules.router.RoutingEngine, keys, { requestedModel: 'auto', tiers: ['free', 'paid'], country: 'US' });
    assert.ok(autoRoute.ok && autoRoute.candidates.every(item => !item[0].startsWith('anthropic/')), 'auto never picks Claude');
    ok(`routing from the rows equals routing from code on ${checked} requests (auto, every id and alias, openai/ prefix, tools and vision), and today's router for every non-Claude request; auto never picks Claude`);
  }

  // ── 8. Lifecycle, immutability, audit and privileges in SQL ──
  {
    const eventCount = async () => (await sql('SELECT count(*)::int AS n FROM public.zerox_catalog_events'))[0].n;
    const coder = { provider_type: 'nvidia', upstream_model: 'acme/coder-9', display_name: 'Acme Coder 9 (NVIDIA)', context_window: 131072,
      max_output_tokens: 16384, pools: [{ tier: 'free', key_slot: 'nvidia.free', price: null, limits: { rpm: 40, rpd: 10000, tpm: null, tpd: null },
        daily_spend_cap_microusd: null }] };
    let before = await eventCount();
    const [proposed] = await rpcRows(DB, 'zerox_catalog_propose', { p_spec: coder, p_actor: 'rahul@zero-x.live', p_note: 'first', p_detail: { diff: [] } });
    assert.deepEqual([proposed.model_id, proposed.revision, proposed.status], ['nvidia/acme/coder-9', 1, 'draft']);
    assert.equal(await eventCount(), before + 1, 'propose writes one audit row');
    const [event] = await rpcRows(DB, 'zerox_catalog_events_list', { p_id: 'nvidia/acme/coder-9', p_limit: 1 });
    assert.deepEqual([event.action, event.actor, event.revision_id, event.to_status], ['propose', 'rahul@zero-x.live', proposed.revision_id, 'draft']);
    const draftRow = (await rpcRows(DB, 'zerox_catalog_snapshot', {})).find(row => row.id === 'nvidia/acme/coder-9');
    assert.deepEqual([draftRow.status, draftRow.spec], ['draft', null], 'a draft has no served spec');
    assert.ok(!buildSnapshot(await rpcRows(DB, 'zerox_catalog_snapshot', {})).byId.has('nvidia/acme/coder-9'), 'draft rows are never served');
    await assert.rejects(rpcRows(DB, 'zerox_catalog_approve', { p_model_id: 'nvidia/acme/coder-9', p_revision_id: proposed.revision_id + 999,
      p_expected_active: null, p_actor: 'rahul@zero-x.live' }), /stale_revision/);
    await assert.rejects(rpcRows(DB, 'zerox_catalog_approve', { p_model_id: 'nvidia/acme/coder-9', p_revision_id: proposed.revision_id,
      p_expected_active: 1, p_actor: 'rahul@zero-x.live' }), /stale_revision/);
    // A model can only point at an approved revision: activating the draft by hand is refused.
    await assert.rejects(asRole('service_role', `UPDATE public.zerox_catalog_models SET active_revision_id = pending_revision_id,
      pending_revision_id = NULL, status = 'active' WHERE id = 'nvidia/acme/coder-9'`), /catalog_unapproved/);
    before = await eventCount();
    const [approved] = await rpcRows(DB, 'zerox_catalog_approve', { p_model_id: 'nvidia/acme/coder-9', p_revision_id: proposed.revision_id,
      p_expected_active: null, p_actor: 'rahul@zero-x.live', p_note: 'looks right' });
    assert.deepEqual([approved.status, approved.active_revision_id, approved.pending_revision_id], ['active', proposed.revision_id, null]);
    assert.equal(await eventCount(), before + 1, 'approve writes one audit row');
    const [revision] = await sql('SELECT approved_by, approved_at FROM public.zerox_catalog_revisions WHERE id = $1', [proposed.revision_id]);
    assert.equal(revision.approved_by, 'rahul@zero-x.live', 'the approver is recorded');
    assert.ok(buildSnapshot(await rpcRows(DB, 'zerox_catalog_snapshot', {})).byId.get('nvidia/acme/coder-9').source === 'database');
    // Immutability and the append-only audit log.
    await assert.rejects(sql("UPDATE public.zerox_catalog_revisions SET display_name = 'Changed' WHERE id = $1", [proposed.revision_id]), /catalog_immutable/);
    await assert.rejects(sql("UPDATE public.zerox_catalog_revisions SET approved_by = 'someone-else' WHERE id = $1", [proposed.revision_id]), /catalog_immutable/);
    await assert.rejects(sql('UPDATE public.zerox_catalog_revision_pools SET rpm = 1000 WHERE revision_id = $1', [proposed.revision_id]), /catalog_immutable/);
    await assert.rejects(sql("DELETE FROM public.zerox_catalog_models WHERE id = 'nvidia/acme/coder-9'"), /catalog_immutable/);
    await assert.rejects(sql('DELETE FROM public.zerox_catalog_revisions WHERE id = $1', [proposed.revision_id]), /catalog_immutable/);
    await assert.rejects(sql("UPDATE public.zerox_catalog_events SET actor = 'x'"), /catalog_immutable/);
    await assert.rejects(sql('DELETE FROM public.zerox_catalog_events'), /catalog_immutable/);
    await assert.rejects(sql('TRUNCATE public.zerox_catalog_events'), /catalog_immutable/);
    await assert.rejects(sql("UPDATE public.zerox_catalog_models SET provider_type = 'groq' WHERE id = 'nvidia/acme/coder-9'"), /catalog_immutable/);
    // A change made outside the catalog functions is still audited.
    before = await eventCount();
    await asRole('service_role', "UPDATE public.zerox_catalog_models SET status = 'disabled' WHERE id = 'nvidia/acme/coder-9'");
    const [direct] = await rpcRows(DB, 'zerox_catalog_events_list', { p_id: 'nvidia/acme/coder-9', p_limit: 1 });
    assert.deepEqual([direct.action, direct.from_status, direct.to_status], ['direct', 'active', 'disabled']);
    assert.match(direct.actor, /^sql:/);
    assert.equal(await eventCount(), before + 1);
    await rpcRows(DB, 'zerox_catalog_set_status', { p_model_id: 'nvidia/acme/coder-9', p_to: 'active', p_actor: 'rahul@zero-x.live' });
    await assert.rejects(rpcRows(DB, 'zerox_catalog_set_status', { p_model_id: 'nvidia/acme/coder-9', p_to: 'active', p_actor: 'x' }),
      /invalid_transition: active -> active/);
    // Reject keeps the active revision; a replaced pending revision stays as history.
    const [second] = await rpcRows(DB, 'zerox_catalog_propose', { p_spec: { ...coder, display_name: 'Acme Coder 9 v2' }, p_actor: 'a' });
    const [third] = await rpcRows(DB, 'zerox_catalog_propose', { p_spec: { ...coder, display_name: 'Acme Coder 9 v3' }, p_actor: 'a' });
    assert.deepEqual([second.revision, third.revision, third.status], [2, 3, 'active']);
    const [replaced] = await rpcRows(DB, 'zerox_catalog_events_list', { p_id: 'nvidia/acme/coder-9', p_limit: 1 });
    assert.equal(replaced.detail.replaced_pending_revision_id, second.revision_id);
    await assert.rejects(rpcRows(DB, 'zerox_catalog_reject', { p_model_id: 'nvidia/acme/coder-9', p_revision_id: second.revision_id, p_actor: 'a' }), /stale_revision/);
    const [rejected] = await rpcRows(DB, 'zerox_catalog_reject', { p_model_id: 'nvidia/acme/coder-9', p_revision_id: third.revision_id, p_actor: 'a' });
    assert.deepEqual([rejected.status, rejected.active_revision_id, rejected.pending_revision_id], ['active', proposed.revision_id, null]);
    // SQL refuses what the JS guardrails refuse, even when called directly.
    const sonnetSpec = clone(SONNET);
    const refusals = [
      [{ ...sonnetSpec, pools: [{ ...sonnetSpec.pools[0], key_slot: 'groq.free' }] }, /key slot groq.free is not allowed/],
      [{ ...sonnetSpec, pools: [{ ...sonnetSpec.pools[0], key_slot: 'SUPABASE_SECRET_KEY' }] }, /check constraint|not allowed/],
      [{ ...sonnetSpec, pools: [{ ...sonnetSpec.pools[0], daily_spend_cap_microusd: 60_000_000 }] }, /above the anthropic maximum/],
      [{ ...sonnetSpec, pools: [{ ...sonnetSpec.pools[0], daily_spend_cap_microusd: 1e12 }] }, /check constraint|above the anthropic maximum/],
      [{ ...sonnetSpec, pools: [{ ...sonnetSpec.pools[0], daily_spend_cap_microusd: null }] }, /check constraint/],
      [{ ...sonnetSpec, pools: [{ ...sonnetSpec.pools[0], price: { ...sonnetSpec.pools[0].price, input: 0 } }] }, /check constraint/],
      [{ ...sonnetSpec, pools: [{ ...sonnetSpec.pools[0], tier: 'free' }] }, /check constraint|not allowed/],
      [{ ...sonnetSpec, upstream_model: 'claude-x/../../v1/files' }, /not a valid anthropic model id/],
      [{ ...sonnetSpec, provider_type: 'evil' }, /unknown provider type/],
      [{ ...sonnetSpec, display_name: '<script>' }, /check constraint/],
      [{ ...sonnetSpec, pools: [sonnetSpec.pools[0], sonnetSpec.pools[0]] }, /one pool per tier/],
    ];
    before = await eventCount();
    const revisionsBefore = (await sql('SELECT count(*)::int AS n FROM public.zerox_catalog_revisions'))[0].n;
    for (const [spec, pattern] of refusals) await assert.rejects(rpcRows(DB, 'zerox_catalog_propose', { p_spec: spec, p_actor: 'a' }), pattern);
    assert.equal(await eventCount(), before, 'refused proposals leave no trace');
    assert.equal((await sql('SELECT count(*)::int AS n FROM public.zerox_catalog_revisions'))[0].n, revisionsBefore);
    await assert.rejects(rpcRows(DB, 'zerox_catalog_propose', { p_spec: coder, p_actor: 'a', p_source: 'seed' }), /p_source/);
    const [candidate] = await sql(`INSERT INTO public.zerox_provider_candidates (source, provider, model_id, status)
      VALUES ('check', 'nvidia', 'acme/unverified-1', 'approved') RETURNING id`);
    await assert.rejects(rpcRows(DB, 'zerox_catalog_propose', { p_spec: { ...coder, upstream_model: 'acme/unverified-1' }, p_actor: 'a',
      p_source: 'discovery', p_candidate_id: candidate.id }), /candidate_not_verified/);
    // Privileges: nothing for anon and authenticated; service_role cannot delete.
    for (const role of ['anon', 'authenticated']) {
      for (const table of ['zerox_catalog_models', 'zerox_catalog_revisions', 'zerox_catalog_revision_pools', 'zerox_catalog_events', 'zerox_operator_audit']) {
        const [privilege] = await sql(`SELECT has_table_privilege($1, $2, 'SELECT') OR has_table_privilege($1, $2, 'INSERT')
          OR has_table_privilege($1, $2, 'UPDATE') OR has_table_privilege($1, $2, 'DELETE') AS any`, [role, `public.${table}`]);
        assert.equal(privilege.any, false, `${role} has no access to ${table}`);
      }
      const functions = await sql(`SELECT p.oid::regprocedure::text AS name, has_function_privilege($1, p.oid, 'EXECUTE') AS can
        FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND (p.proname LIKE 'zerox_catalog%' OR p.proname = 'zerox_operator_audit_list')`, [role]);
      assert.ok(functions.length >= 25);
      assert.deepEqual(functions.filter(fn => fn.can).map(fn => fn.name), [], `${role} executes no catalog function`);
    }
    for (const table of ['zerox_catalog_models', 'zerox_catalog_revisions', 'zerox_catalog_revision_pools', 'zerox_catalog_events']) {
      await assert.rejects(asRole('service_role', `DELETE FROM public.${table}`), /catalog_immutable/, `service_role cannot delete from ${table}`);
    }
    const audit = await rpcRows(DB, 'zerox_operator_audit_list', { p_limit: 500 });
    assert.ok(audit.some(row => row.subject_kind === 'offer') && audit.some(row => row.subject_kind === 'model'), 'one operator feed for offers and models');
    ok('SQL: propose makes a draft (never served), approve needs the reviewed revision ids and records the approver, a model cannot point at an unapproved revision, revisions/pools/events are immutable, models are never deleted, every change (direct SQL included) writes one audit row, no privileges for anon/authenticated, deletes refused even for service_role');
  }

  // ── 9. Loader: merge rules, effective dates, failures, kill switch ──
  {
    const rows = await rpcRows(DB, 'zerox_catalog_snapshot', {});
    const row = id => clone(rows.find(item => item.id === id));
    const synthetic = [
      { ...row('groq/openai/gpt-oss-20b'), status: 'disabled', revision_id: null, spec: null },
      { ...row('groq/qwen/qwen3.8-27b'), status: 'draft', revision_id: null, spec: null },
      (() => { const r = row(SONNET_ID); r.spec.upstream_model = 'claude-opus-5-5'; return r; })(),
      (() => { const r = row('gemini/gemini-2.5-flash'); r.spec.pools[1].key_slot = 'groq.paid'; r.spec.aliases.push('openai/gpt-oss-120b'); return r; })(),
      (() => { const r = row('@cf/openai/gpt-oss-120b'); r.spec.pools[1].daily_spend_cap_microusd = 1e12; return r; })(),
      (() => { const r = row('nvidia/acme/coder-9'); r.spec.aliases = ['gemini-2.5-flash']; return r; })(),
    ];
    const snapshot = buildSnapshot(synthetic);
    assert.ok(!snapshot.byId.has('groq/openai/gpt-oss-20b'), 'a disabled row hides its code entry too');
    assert.equal(snapshot.verdicts.get('groq/openai/gpt-oss-20b').served_from, 'none');
    assert.equal(snapshot.byId.get('groq/qwen/qwen3.8-27b'), codeCatalog().byId.get('groq/qwen/qwen3.8-27b').entry, 'a draft row leaves the code entry serving');
    assert.equal(snapshot.verdicts.get(SONNET_ID).served_from, 'code', 'a model-level failure falls back to code');
    assert.ok(snapshot.verdicts.get(SONNET_ID).reasons.includes('id_mismatch'));
    assert.equal(snapshot.byId.get(SONNET_ID).upstream_model, 'claude-sonnet-5-5');
    const flash = snapshot.byId.get('gemini/gemini-2.5-flash');
    assert.deepEqual([flash.source, flash.pools.map(pool => pool.tier)], ['database', ['free']], 'a foreign slot drops only that pool');
    assert.deepEqual(snapshot.verdicts.get('gemini/gemini-2.5-flash').reasons, ['paid:key_slot_not_allowed']);
    assert.deepEqual(snapshot.byId.get('@cf/openai/gpt-oss-120b').pools.map(pool => pool.tier), ['free'], 'a cap above the maximum drops the paid pool');
    assert.equal(snapshot.byId.get('nvidia/acme/coder-9').source, 'database', 'a valid row without a code entry serves from the database');
    assert.ok(snapshot.warnings.some(item => item.alias === 'gemini-2.5-flash' && item.reason === 'alias_conflict'), 'an alias taken by another model is dropped');
    assert.ok(snapshot.warnings.some(item => item.alias === 'openai/gpt-oss-120b'));
    assert.equal(snapshot.aliases.get('gemini-2.5-flash'), 'gemini/gemini-2.5-flash');
    assert.equal(snapshot.aliases.get('default'), 'auto');
    assert.equal(snapshot.byId.get('cohere/north-mini-code:free'), codeCatalog().byId.get('cohere/north-mini-code:free').entry,
      'code models without a row serve from code');
    assert.deepEqual(buildSnapshot([]).entries.map(entry => entry.id), codeSnapshot().entries.map(entry => entry.id));
    const later = buildSnapshot(rows, { now: Date.UTC(2027, 0, 2) });
    assert.deepEqual(later.byId.get('gemini/gemini-3.6-flash').pools.map(pool => pool.tier), ['free'], '2027-01-02: the old 3.6 Flash price is no longer list');
    assert.deepEqual(later.verdicts.get('gemini/gemini-3.6-flash').reasons, ['paid:price_mismatch_list']);
    assert.deepEqual(codeSnapshot(Date.UTC(2027, 0, 2)).byId.get('gemini/gemini-3.6-flash').pools.map(pool => pool.tier), ['free'],
      'the code catalog fails safe the same way');
    assert.notEqual(snapshot.version, buildSnapshot(rows).version);
    assert.equal(buildSnapshot(rows).version, buildSnapshot(clone(rows)).version);

    // Kill switch and no database.
    assert.equal((await loadCatalog({ ...DB, CATALOG_SOURCE: 'code' })).source, 'code');
    assert.equal(catalogSnapshot({ ...DB, CATALOG_SOURCE: 'CODE ' }).source, 'code');
    assert.equal((await loadCatalog({})).source, 'code');
    // PostgREST failures: last good, then the code catalog on a cold isolate; logged once per streak.
    const pg = { SUPABASE_URL: 'https://db.example.invalid', SUPABASE_SECRET_KEY: 'sb_secret_check', CATALOG_DB_MODELS: 'true' };
    let mode = 'ok';
    let calls = 0;
    globalThis.fetch = async input => {
      calls++;
      assert.equal(String(input), 'https://db.example.invalid/rest/v1/rpc/zerox_catalog_snapshot');
      if (mode === 'down') throw new TypeError('fetch failed');
      if (mode === 'slow') await new Promise(resolve => setTimeout(resolve, 150));
      return Response.json(rows);
    };
    const errors = [];
    const warnings = [];
    const realError = console.error;
    const realWarn = console.warn;
    console.error = (...args) => errors.push(args);
    console.warn = (...args) => warnings.push(args);
    try {
      const loaded = await loadCatalog(pg);
      assert.equal(loaded.source, 'database');
      assert.equal(await loadCatalog(pg), loaded, 'cached for the TTL');
      assert.equal(calls, 1);
      mode = 'down';
      assert.equal(await loadCatalog(pg, { force: true }), loaded, 'the last good snapshot keeps serving');
      assert.equal(catalogStatus(pg).failing, true);
      await loadCatalog(pg, { force: true });
      assert.equal(errors.length, 1, 'logged once per failure streak');
      const cold = { ...pg };
      assert.equal((await loadCatalog(cold)).source, 'code', 'a cold isolate without the database serves code');
      await loadCatalog(cold, { force: true });
      assert.equal(errors.length, 2, 'the cold env logs the start of its own streak, once');
      mode = 'ok';
      await loadCatalog(pg, { force: true });
      assert.equal(catalogStatus(pg).failing, false);
      mode = 'slow';
      const slow = { ...pg };
      const started = Date.now();
      assert.equal((await loadCatalog(slow, { wait: 20 })).source, 'code', 'a slow database does not hold the caller');
      assert.ok(Date.now() - started < 140);
      assert.equal((await loadCatalog(slow, { wait: Infinity })).source, 'database', 'the load finishes in the background');
      assert.equal(warnings.filter(args => String(args[0]).includes('CATALOG_DB_MODELS')).length, 3, 'CATALOG_DB_MODELS is ignored with one warning per env');
    } finally {
      console.error = realError;
      console.warn = realWarn;
      globalThis.fetch = async input => { throw new Error(`Unexpected outbound request: ${String(input?.url ?? input)}`); };
    }
    ok('loader: disabled rows hide code entries, drafts change nothing, failing models fall back to code, failing pools are dropped, alias conflicts dropped; effective-dated list prices fail safe per pool; last good / code fallback, logged once per streak; CATALOG_SOURCE=code kill switch');
  }

  // ── 10. Operator API ──
  {
    const app = new Hono();
    registerCatalogAdminRoutes(app);
    const env = { ...DB, GATEWAY_ADMIN_TOKEN: ADMIN, ANTHROPIC_API_KEY: 'sk-ant-api03-check-secret-value' };
    const call = async (path, { method = 'GET', body, token = ADMIN, target = env } = {}) => {
      const response = await app.request(path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }, target);
      return { status: response.status, body: await response.json(), headers: response.headers };
    };
    assert.equal((await call('/admin/catalog/types', { token: null })).status, 401);
    assert.equal((await call('/admin/catalog/types', { token: 'wrong-token'.padEnd(40, 'x') })).status, 401);
    const accessEnv = { ...env, CF_ACCESS_TEAM_DOMAIN: 'zerox.cloudflareaccess.com', CF_ACCESS_AUD: 'a'.repeat(32) };
    assert.equal((await call('/admin/catalog/models', { target: accessEnv })).status, 403, 'Cloudflare Access is required when configured');
    const types = await call('/admin/catalog/types');
    assert.equal(types.status, 200);
    assert.equal(types.headers.get('cache-control'), 'no-store');
    assert.ok(!JSON.stringify(types.body).includes('sk-ant-api03-check-secret-value'), 'no secret value is ever returned');
    const anthropic = types.body.types.find(type => type.id === 'anthropic');
    assert.deepEqual(anthropic.slots, { free: [], paid: [{ id: 'anthropic.paid', env: 'ANTHROPIC_API_KEY', binding: null, configured: true }] });
    assert.equal(anthropic.list_prices['claude-sonnet-5-5'].billed.input_usd_per_mtok, 2.5);
    assert.deepEqual([types.body.markup, anthropic.max_daily_spend_usd], [1.25, 50]);

    const listed = await call('/admin/catalog/models');
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.code_only, [], 'every code model has a row');
    const sonnetRow = listed.body.models.find(model => model.id === SONNET_ID);
    assert.deepEqual([sonnetRow.status, sonnetRow.matches_code, sonnetRow.served_from], ['active', true, 'database']);

    const counts = async () => (await sql(`SELECT (SELECT count(*) FROM public.zerox_catalog_events)::int AS events,
      (SELECT count(*) FROM public.zerox_catalog_revisions)::int AS revisions`))[0];
    const start = await counts();
    const renamed = { ...apiFromSpec(SONNET), display_name: 'Claude Sonnet 5.5 (Zero-X)' };
    const dry = await call('/admin/catalog/validate', { method: 'POST', body: { spec: renamed } });
    assert.deepEqual([dry.status, dry.body.ok, dry.body.id, dry.body.risky], [200, true, SONNET_ID, []]);
    assert.deepEqual(dry.body.diff.map(item => [item.path, item.flag]), [['display_name', 'changed']]);
    assert.deepEqual(dry.body.preview.pricing, { input_per_mtok_usd: 2.5, output_per_mtok_usd: 12.5, cache_read_per_mtok_usd: 0.25,
      cache_write_per_mtok_usd: 3.125 });
    const cheap = clone(renamed);
    cheap.pools[0].price.input_usd_per_mtok = 1.5;
    const refused = await call('/admin/catalog/validate', { method: 'POST', body: { spec: cheap } });
    assert.equal(refused.body.ok, false);
    assert.ok(refused.body.validation.pools.paid.includes('price_mismatch_list'));
    assert.equal((await call('/admin/catalog/propose', { method: 'POST', body: { spec: cheap } })).status, 400, 'an off-list price is never stored');
    assert.equal((await call('/admin/catalog/propose', { method: 'POST', body: { spec: { ...renamed, base_url: 'https://evil.example' } } })).status, 400);
    assert.equal((await call('/admin/catalog/propose', { method: 'POST', body: { spec: apiFromSpec(SONNET) } })).status, 409, 'no change, no revision');
    assert.deepEqual(await counts(), start, 'validate and refused proposals write nothing');

    const proposed = await call('/admin/catalog/propose', { method: 'POST', body: { spec: renamed, note: 'brand the name' } });
    assert.deepEqual([proposed.status, proposed.body.model_id, proposed.body.revision, proposed.body.status], [201, SONNET_ID, 2, 'active']);
    const [proposeEvent] = await rpcRows(DB, 'zerox_catalog_events_list', { p_id: SONNET_ID, p_limit: 1 });
    assert.deepEqual([proposeEvent.action, proposeEvent.actor, proposeEvent.note], ['propose', 'operator', 'brand the name']);
    assert.deepEqual(proposeEvent.detail.diff.map(item => item.path), ['display_name'], 'the diff is in the audit log');
    assert.equal(catalogSnapshot(env).byId.get(SONNET_ID).display_name, 'Claude Sonnet 5.5', 'a pending revision does not serve');
    const versionBefore = (await loadCatalog(env, { force: true, wait: Infinity })).version;
    const detail = await call(`/admin/catalog/model?id=${encodeURIComponent(SONNET_ID)}`);
    assert.equal(detail.body.model.pending.revision_id, proposed.body.revision_id);
    const activeId = detail.body.model.active.revision_id;
    assert.equal((await call('/admin/catalog/approve', { method: 'POST', body: { model_id: SONNET_ID, revision_id: proposed.body.revision_id } })).status, 400,
      'the active revision that was reviewed must be named');
    assert.equal((await call('/admin/catalog/approve', { method: 'POST', body: { model_id: SONNET_ID, revision_id: proposed.body.revision_id,
      expected_active_revision_id: activeId + 1 } })).status, 409, 'approving against another active revision is stale');
    const approved = await call('/admin/catalog/approve', { method: 'POST', body: { model_id: SONNET_ID, revision_id: proposed.body.revision_id,
      expected_active_revision_id: activeId, note: 'ok' } });
    assert.equal(approved.status, 200);
    assert.notEqual(approved.body.catalog_version, versionBefore, 'an approval changes catalog_version');
    assert.equal(approved.body.served_within_seconds, 60);
    assert.equal(catalogSnapshot(env).byId.get(SONNET_ID).display_name, 'Claude Sonnet 5.5 (Zero-X)', 'served at once in this isolate');
    assert.equal(approved.body.model.matches_code, false);

    // A risky change (higher cap) needs the model id typed.
    const raised = apiFromSpec(OPUS);
    raised.pools[0].daily_spend_cap_usd = 8;
    const riskyProposal = await call('/admin/catalog/propose', { method: 'POST', body: { spec: raised } });
    assert.deepEqual(riskyProposal.body.risky, ['pools.paid.daily_spend_cap_usd']);
    const opusActive = (await call(`/admin/catalog/model?id=${encodeURIComponent(OPUS_ID)}`)).body.model.active.revision_id;
    const approval = { model_id: OPUS_ID, revision_id: riskyProposal.body.revision_id, expected_active_revision_id: opusActive };
    const unconfirmed = await call('/admin/catalog/approve', { method: 'POST', body: approval });
    assert.deepEqual([unconfirmed.status, unconfirmed.body.error.code], [422, 'confirmation_required']);
    assert.equal((await call('/admin/catalog/approve', { method: 'POST', body: { ...approval, confirm: OPUS_ID } })).status, 200);
    assert.equal(catalogSnapshot(env).byId.get(OPUS_ID).pools[0].daily_spend_cap_usd, 8);
    assert.equal(riskyChanges(specDiff(OPUS, specFromApi(raised).spec)).length, 1);

    // Reject, disable, enable, a brand-new draft, the audit feed.
    const renamedOpus = { ...apiFromSpec(OPUS), display_name: 'Opus' };
    renamedOpus.pools[0].daily_spend_cap_usd = 8;
    const toReject = await call('/admin/catalog/propose', { method: 'POST', body: { spec: renamedOpus } });
    const rejected = await call('/admin/catalog/reject', { method: 'POST', body: { model_id: OPUS_ID, revision_id: toReject.body.revision_id } });
    assert.deepEqual([rejected.status, rejected.body.model.pending, rejected.body.model.status], [200, null, 'active']);
    const disabled = await call('/admin/catalog/disable', { method: 'POST', body: { model_id: 'groq/openai/gpt-oss-20b', note: 'pause' } });
    assert.equal(disabled.status, 200);
    assert.ok(!catalogSnapshot(env).byId.has('groq/openai/gpt-oss-20b'), 'a disabled code model stops serving');
    assert.equal((await call('/admin/catalog/disable', { method: 'POST', body: { model_id: 'groq/openai/gpt-oss-20b' } })).status, 409);
    assert.equal((await call('/admin/catalog/enable', { method: 'POST', body: { model_id: 'groq/openai/gpt-oss-20b' } })).status, 200);
    assert.ok(catalogSnapshot(env).byId.has('groq/openai/gpt-oss-20b'));
    const fresh = await call('/admin/catalog/propose', { method: 'POST', body: { spec: apiFromSpec({ provider_type: 'groq', upstream_model: 'acme/fast-1',
      display_name: 'Acme Fast 1 (Groq)', context_window: 131072, max_output_tokens: 8192,
      pools: [{ tier: 'free', key_slot: 'groq.free', price: null, limits: { rpm: 30, rpd: 1000, tpm: 8000, tpd: 200000 }, daily_spend_cap_microusd: null }] }) } });
    assert.deepEqual([fresh.status, fresh.body.model_id, fresh.body.status], [201, 'groq/acme/fast-1', 'draft']);
    await loadCatalog(env, { force: true, wait: Infinity });
    assert.ok(!catalogSnapshot(env).byId.has('groq/acme/fast-1'), 'a new draft is not served');
    const modelAudit = await call(`/admin/catalog/audit?id=${encodeURIComponent('groq/openai/gpt-oss-20b')}`);
    assert.deepEqual(modelAudit.body.events.slice(0, 2).map(item => item.action), ['enable', 'disable']);
    const feed = await call('/admin/catalog/audit?limit=500');
    assert.ok(feed.body.events.some(item => item.subject_kind === 'offer') && feed.body.events.some(item => item.subject_id === SONNET_ID));
    assert.equal((await call('/admin/catalog/model?id=..%2F..%2Fetc')).status, 400);
    assert.equal((await call('/admin/catalog/model?id=nope%2Fnothing')).status, 404);
    assert.equal((await call('/admin/catalog/propose', { method: 'POST', body: { spec: renamed }, target: { GATEWAY_ADMIN_TOKEN: ADMIN } })).status, 503,
      'without a database the code catalog is read-only');
    assert.equal(previewModel(SONNET_ID, SONNET).chosen_by_auto, false);

    // Discovery promote creates a draft only.
    const [verified] = await sql(`INSERT INTO public.zerox_provider_candidates (source, provider, model_id, display_name, context_window,
      max_output_tokens, supports_vision, status) VALUES ('check', 'openrouter', 'acme/coder-2:free', 'Acme <b>Coder</b> 2', 131072, 8192, true, 'verified')
      RETURNING *`);
    const draft = await proposeCandidateDraft(env, verified, {}, 'rahul@zero-x.live');
    assert.deepEqual([draft.model_id, draft.status, draft.admin_url], ['acme/coder-2:free', 'draft', '/admin/models?id=acme%2Fcoder-2%3Afree']);
    const [stored] = await sql("SELECT source, candidate_id FROM public.zerox_catalog_models WHERE id = 'acme/coder-2:free'");
    assert.deepEqual([stored.source, Number(stored.candidate_id)], ['discovery', Number(verified.id)]);
    const draftDetail = await call(`/admin/catalog/model?id=${encodeURIComponent('acme/coder-2:free')}`);
    assert.equal(draftDetail.body.model.pending.spec.display_name, 'Acme bCoder/b 2', 'markup is stripped from discovered names');
    await loadCatalog(env, { force: true, wait: Infinity });
    assert.ok(!catalogSnapshot(env).byId.has('acme/coder-2:free'), 'a promoted candidate is not served until approved');
    await assert.rejects(proposeCandidateDraft(env, { ...verified, provider: 'cloudflare', model_id: '@cf/acme/x' }), error => error.code === 'no_catalog_type');
    await assert.rejects(proposeCandidateDraft(env, { ...verified, model_id: 'acme/other-3:free' }), /already belongs to another catalog model/);
    ok('operator API: token and Access required, no secret values returned, validate is a dry run, propose stores a pending revision with its diff, approve needs the reviewed revision ids and confirm for risky changes, changes catalog_version and serves at once; reject/disable/enable; drafts and promoted candidates never serve');
  }

  // ── 11. Discovery import, down scripts, re-apply ──
  {
    const db = await PGlite.create();
    try {
      await db.exec(DEV_BOOTSTRAP_SQL);
      const migrations = await listMigrations();
      for (const migration of migrations) {
        if (migration.file === '20261025000100_catalog_seed.sql') {
          const [candidate] = (await db.query(`INSERT INTO public.zerox_provider_candidates (source, provider, model_id, status)
            VALUES ('check', 'openrouter', 'acme/legacy-1:free', 'verified') RETURNING id`)).rows;
          const [bad] = (await db.query(`INSERT INTO public.zerox_provider_candidates (source, provider, model_id, status)
            VALUES ('check', 'nvidia', 'acme/../legacy', 'verified') RETURNING id`)).rows;
          await db.query(`INSERT INTO public.gateway_provider_models (public_model_id, provider_id, provider_model_id, candidate_id, display_name,
            context_window, max_output_tokens, supports_vision, input_cost_per_million, output_cost_per_million, tier)
            VALUES ('acme/legacy-1:free', 'openrouter', 'acme/legacy-1:free', $1, 'Legacy <i>1</i>', 65536, 100000, true, 0, 0, 'free'),
                   ('nvidia/acme/../legacy', 'nvidia', 'acme/../legacy', $2, 'Bad', 65536, 8192, false, 0, 0, 'free')`, [candidate.id, bad.id]);
        }
        await db.exec(readFileSync(migration.path, 'utf8'));
      }
      const imported = (await db.query(`SELECT m.id, m.status, m.source, r.revision, r.display_name, r.max_output_tokens, r.approved_at
        FROM public.zerox_catalog_models AS m JOIN public.zerox_catalog_revisions AS r ON r.id = m.pending_revision_id
        WHERE m.source = 'discovery'`)).rows;
      assert.deepEqual(imported.map(item => [item.id, item.status, item.revision, item.display_name, item.max_output_tokens, item.approved_at]),
        [['acme/legacy-1:free', 'draft', 1, 'Legacy i1/i', 65536, null]], 'only the valid promoted row is imported, as a draft');
      const [importEvent] = (await db.query("SELECT action, actor FROM public.zerox_catalog_events WHERE model_id = 'acme/legacy-1:free'")).rows;
      assert.deepEqual([importEvent.action, importEvent.actor], ['import', 'migration']);
      const [pool] = (await db.query(`SELECT p.key_slot, p.rpm, p.rpd FROM public.zerox_catalog_revision_pools AS p
        JOIN public.zerox_catalog_models AS m ON m.pending_revision_id = p.revision_id WHERE m.id = 'acme/legacy-1:free'`)).rows;
      assert.deepEqual([pool.key_slot, pool.rpm, pool.rpd], ['openrouter.free', 20, 50]);
      const snap = (await db.query("SELECT status, spec FROM public.zerox_catalog_snapshot() WHERE id = 'acme/legacy-1:free'")).rows[0];
      assert.deepEqual([snap.status, snap.spec], ['draft', null]);
      // Down scripts, newest first, then the up migrations again.
      const down = name => readFileSync(new URL(`./migrations/down/${name}`, import.meta.url), 'utf8');
      await db.exec(down('20261025000100_catalog_seed.down.sql'));
      assert.equal((await db.query("SELECT count(*)::int AS n FROM public.zerox_catalog_models WHERE source IN ('seed', 'discovery')")).rows[0].n, 0);
      assert.equal((await db.query("SELECT count(*)::int AS n FROM public.zerox_offers WHERE id = 'anthropic.paid'")).rows[0].n, 0);
      await assert.rejects(db.query("TRUNCATE public.zerox_catalog_events"), /catalog_immutable/, "the guards are back on");
      await db.exec(down('20261025000000_catalog_models.down.sql'));
      const left = (await db.query(`SELECT count(*)::int AS n FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname LIKE 'zerox_catalog%' AND p.proname <> 'zerox_catalog_db_models'`)).rows[0].n;
      const tables = (await db.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'zerox_catalog%'")).rows[0].n;
      assert.deepEqual([left, tables], [0, 0], 'the down scripts remove every catalog table and function');
      assert.equal((await db.query("SELECT count(*)::int AS n FROM supabase_migrations.schema_migrations WHERE version IN ('20261025000000', '20261025000100')")).rows[0].n, 0);
      for (const file of ['20261025000000_catalog_models.sql', '20261025000100_catalog_seed.sql']) {
        await db.exec(readFileSync(new URL(`./migrations/${file}`, import.meta.url), 'utf8'));
      }
      assert.equal((await db.query("SELECT count(*)::int AS n FROM public.zerox_catalog_snapshot() WHERE status = 'active'")).rows[0].n, codeCatalog().items.length,
        'the migrations apply again after the down scripts');
    } finally {
      await db.close();
    }
    ok('seed imports promoted discovery candidates as drafts (invalid ones skipped); down scripts remove everything and the migrations re-apply');
  }

  console.log(`PASS: ${passed.length} data-driven catalog checks`);
} finally {
  globalThis.fetch = realFetch;
  resetCatalogCache(DB);
  await closeAllPglite();
}

// OIOP offers, manifests and routing policy (src/oiop/, migration 20261024000200_oiop_offers.sql),
// offline: PGlite for the database, no outbound requests.
//   node check-oiop.mjs
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { rpcRows } from './src/account-store.js';
import { closeAllPglite, getPgliteHandle } from './src/db/pglite.js';
import { CATALOG, catalogEntry, listModelsForCaller, poolKey } from './src/catalog.js';
import { RoutingEngine } from './src/router.js';
import { FailureKind, globalHealthTracker, HealthState, ProviderHealthTracker } from './src/provider-health.js';
import { canaryBudget, canaryIntervalMs, HealthHub, PROBE_DAILY_CAPS } from './src/health-hub.js';
import { classifyUpstreamFailure } from './src/providers.js';
import { refreshModelsDevFacts, resetModelsDevCache } from './src/oiop/models-dev.js';
import { conversationKey, createChatHandler, requestNeeds } from './src/chat-handler.js';
import { callerPolicy, DEFAULT_TRUST_TIERS, TRAINING_HEADER, TRUST_HEADER } from './src/oiop/policy.js';
import { findSecrets, scrubMode, scrubRequest, scrubsOffer, SecretRestorer } from './src/oiop/scrub.js';
import {
  BUILTIN_OFFERS, canTransition, LIFECYCLES, loadOffers, offerById, offerIdFor, resetOfferCache, servesOperatorPools,
  servesOwnKeys, TRANSITIONS,
} from './src/oiop/offers.js';
import {
  buildManifest, canonicalJson, keyId, MANIFEST_SCHEMA, OFFER_FACTS_SCHEMA, publicJwkOf, signManifest, validateManifest,
  verifyManifest,
} from './src/oiop/manifest.js';
import app from './src/index.js';

const passed = [];
function ok(name) { passed.push(name); console.log(`ok - ${name}`); }
const DB = { DATABASE_DRIVER: 'pglite' };
const ADMIN = 'oiop-admin-token-0123456789abcdef0123';
const sql = async (text, params) => (await (await getPgliteHandle(DB)).db.query(text, params)).rows;
const messages = [{ role: 'user', content: 'Read a.js and b.js' }];
const tools = [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];
const realFetch = globalThis.fetch;
globalThis.fetch = async input => { throw new Error(`Unexpected outbound request: ${String(input?.url ?? input)}`); };

async function newSigningKey() {
  const { privateKey } = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', privateKey);
  return { kty: 'OKP', crv: 'Ed25519', d: jwk.d, x: jwk.x };
}

try {
  // ── Built-in offers and the catalog ──
  {
    for (const entry of CATALOG) {
      for (const pool of entry.pools) {
        const offer = offerById({}, offerIdFor(entry, pool));
        assert.ok(offer, `${entry.id} ${pool.tier} belongs to a known offer`);
        assert.equal(offer.provider, entry.provider);
        assert.ok(servesOperatorPools(offer), `${offer.id} keeps serving (backfilled as permitted)`);
      }
    }
    assert.ok(!servesOperatorPools(offerById({}, 'openrouter.byok')), 'the BYOK offer never serves operator pools');
    assert.ok(servesOwnKeys(offerById({}, 'openrouter.byok')));
    for (const offer of BUILTIN_OFFERS) assert.deepEqual(validateManifest(buildManifest(offer, [])), [], `${offer.id} manifest`);
    ok('every catalog pool maps to a built-in offer that serves today; every built-in offer has a valid manifest');
  }

  // ── Migration: backfill equals the built-ins; lifecycle matrix equals TRANSITIONS ──
  {
    const rows = await rpcRows(DB, 'zerox_offers_list', {});
    const facts = ['id', 'provider', 'name', 'homepage', 'logo_url', 'base_url', 'protocol', 'access_kind', 'owner',
      'trust_tier', 'redistribution', 'trains_on_inputs', 'commercial_use', 'expires_after_days', 'terms_url',
      'terms_sha256', 'prerequisites', 'limits', 'evidence', 'lifecycle', 'verified_by', 'manifest_version', 'notes'];
    assert.deepEqual(rows.map(row => row.id).sort(), BUILTIN_OFFERS.map(offer => offer.id).sort());
    for (const offer of BUILTIN_OFFERS) {
      const row = rows.find(item => item.id === offer.id);
      for (const field of facts) {
        assert.equal(canonicalJson(row[field] ?? null), canonicalJson(offer[field] ?? null), `${offer.id}.${field}`);
      }
    }
    const events = await sql("SELECT count(*)::int AS n FROM public.zerox_offer_events WHERE action = 'create' AND actor = 'migration'");
    assert.equal(events[0].n, BUILTIN_OFFERS.length, 'one audit row per backfilled offer');
    const matrix = await sql(`SELECT f.s AS from_state, t.s AS to_state, public.zerox_offer_can_transition(f.s, t.s) AS allowed
      FROM unnest($1::text[]) AS f(s) CROSS JOIN unnest($1::text[]) AS t(s)`, [LIFECYCLES]);
    for (const { from_state: from, to_state: to, allowed } of matrix) {
      assert.equal(allowed, canTransition(from, to), `${from} -> ${to}`);
    }
    assert.deepEqual(Object.keys(TRANSITIONS).sort(), [...LIFECYCLES].sort());
    ok(`migration backfills the ${BUILTIN_OFFERS.length} built-in offers exactly (audited); SQL and JS lifecycle matrices agree on all ${matrix.length} pairs`);
  }

  // ── Lifecycle guards, approval, terms-hash review, audit log ──
  {
    const upsert = (offer, actor = 'check') => rpcRows(DB, 'zerox_offer_upsert', { p_offer: offer, p_actor: actor });
    const move = (to, actor = 'check') => rpcRows(DB, 'zerox_offer_transition', { p_id: 'acme.free', p_to: to, p_actor: actor });
    const [created] = await upsert({ id: 'acme.free', provider: 'acme', name: 'Acme (free)', lifecycle: 'pending_approval',
      base_url: 'https://api.acme.test/v1' });
    assert.deepEqual([created.lifecycle, created.trust_tier, created.redistribution, created.trains_on_inputs],
      ['pending_approval', 'T3', 'unknown', 'unknown'], 'new offers start untrusted, unknown terms');
    await assert.rejects(upsert({ id: 'bad.free', provider: 'bad', name: 'Bad', lifecycle: 'active' }), /a new offer starts as/);
    await assert.rejects(move('active'), /invalid_transition: pending_approval -> active/);
    const [approved] = await move('awaiting_credentials', 'rahul@zero-x.live');
    assert.equal(approved.verified_by, 'rahul@zero-x.live', 'approval records the approver');
    await assert.rejects(move('active'), /invalid_transition: awaiting_credentials -> active/, 'no skipping the probe');
    await move('probing');
    const [active] = await move('active');
    assert.equal(active.lifecycle, 'active');
    let [row] = await upsert({ id: 'acme.free', terms_sha256: 'a'.repeat(64), terms_url: 'https://acme.test/terms' }, 'crawler');
    assert.deepEqual([row.lifecycle, row.manifest_version], ['active', 2], 'the first hash is recorded without review');
    [row] = await upsert({ id: 'acme.free', terms_sha256: 'a'.repeat(64) }, 'crawler');
    assert.equal(row.manifest_version, 2, 'an unchanged upsert changes nothing');
    [row] = await upsert({ id: 'acme.free', terms_sha256: 'b'.repeat(64) }, 'crawler');
    assert.deepEqual([row.lifecycle, row.manifest_version], ['review', 3], 'a new terms hash pauses the offer for review');
    assert.ok(!servesOperatorPools(row), 'an offer in review serves nothing');
    await assert.rejects(move('active'), /invalid_transition: review -> active/, 'review goes back through approval');
    await move('pending_approval');
    [row] = await upsert({ id: 'acme.free', lifecycle: 'active', trust_tier: 'T2' });
    assert.deepEqual([row.lifecycle, row.trust_tier], ['pending_approval', 'T2'], 'an update never moves the lifecycle');
    await assert.rejects(upsert({ id: 'acme.free', trust_tier: 'T9' }), /check constraint/);
    const events = await rpcRows(DB, 'zerox_offer_events_list', { p_id: 'acme.free', p_limit: 50 });
    assert.deepEqual(events.map(event => event.action).reverse(), ['create', 'transition', 'transition', 'transition', 'update',
      'terms_changed', 'transition', 'update']);
    assert.deepEqual(events.find(event => event.action === 'terms_changed').detail,
      { old_sha256: 'a'.repeat(64), new_sha256: 'b'.repeat(64) });
    await assert.rejects(sql("UPDATE public.zerox_offers SET lifecycle = 'flying' WHERE id = 'acme.free'"), /check constraint/);
    ok('lifecycle: new offers start T3/unknown; no skipping approval or probing; approval records its actor; a new terms hash moves an active offer to review (version bumped); updates never move the lifecycle; every step audited');
  }

  // ── Manifests: canonical JSON, schema, Ed25519 ──
  {
    assert.equal(canonicalJson({ b: [1, 'x', null], a: { d: true, c: undefined } }), '{"a":{"d":true},"b":[1,"x",null]}');
    assert.throws(() => canonicalJson({ a: Number.NaN }), /non-finite/);
    const jwk = await newSigningKey();
    const offer = offerById({}, 'openrouter.free');
    const entries = CATALOG.filter(entry => entry.provider === 'openrouter');
    const manifest = buildManifest(offer, entries, { now: Date.UTC(2026, 9, 24) });
    assert.deepEqual(validateManifest(manifest), []);
    assert.equal(manifest.access.prerequisites[1].type, 'wallet_balance', 'the "$10 in the wallet" condition is machine-readable');
    assert.equal(manifest.models.length, 2);
    const signed = await signManifest(manifest, jwk);
    assert.equal(signed.signature.key_id, await keyId(jwk));
    assert.ok(await verifyManifest(signed, publicJwkOf(jwk)));
    assert.ok(await verifyManifest(JSON.parse(JSON.stringify(signed)), publicJwkOf(jwk)), 'survives a JSON round trip');
    const reordered = Object.fromEntries(Object.entries(signed).reverse());
    assert.ok(await verifyManifest(reordered, publicJwkOf(jwk)), 'member order does not matter');
    assert.ok(!await verifyManifest({ ...signed, terms: { ...signed.terms, redistribution: 'prohibited' } }, publicJwkOf(jwk)));
    assert.ok(!await verifyManifest(signed, publicJwkOf(await newSigningKey())), 'another key does not verify');
    await assert.rejects(signManifest({ ...manifest, lifecycle: 'flying' }, jwk), /Invalid manifest/);
    assert.ok(validateManifest({ ...manifest, extra: 1 }).some(error => error.includes('$.extra: is not allowed')));
    assert.ok(validateManifest({ ...manifest, terms: { ...manifest.terms, redistribution: 'maybe' } })
      .some(error => error.startsWith('$.terms.redistribution')));
    assert.deepEqual(validateManifest({ trust_tier: 'T1', redistribution: 'byok_only', lifecycle: 'pending_approval' }, OFFER_FACTS_SCHEMA), []);
    assert.ok(validateManifest({ lifecycle: 'active' }, OFFER_FACTS_SCHEMA).length, 'facts cannot set a served lifecycle');
    ok('manifests: canonical JSON, schema validation (enums, unknown members), Ed25519 sign/verify incl. reordering, tampering and the wrong key');
  }

  // ── Admin and public routes ──
  {
    const jwk = await newSigningKey();
    const env = { ...DB, GATEWAY_ADMIN_TOKEN: ADMIN, OIOP_SIGNING_JWK: JSON.stringify(jwk) };
    const call = async (path, { method = 'GET', body, token = ADMIN, callEnv = env } = {}) => {
      const response = await app.request(`https://zero-x.live${path}`, { method, headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}),
      }, body: body ? JSON.stringify(body) : undefined }, callEnv);
      return { status: response.status, body: await response.json(), headers: response.headers };
    };
    assert.equal((await call('/admin/offers', { token: null })).status, 401);
    assert.equal((await call('/admin/offers', { token: 'wrong-token-wrong-token-wrong-token' })).status, 401);
    const list = await call('/admin/offers');
    assert.equal(list.status, 200);
    assert.equal(list.headers.get('cache-control'), 'no-store');
    const groq = list.body.offers.find(offer => offer.id === 'groq.free');
    assert.ok(groq.models.includes('groq/openai/gpt-oss-120b'));
    assert.deepEqual(groq.next_states, TRANSITIONS.active);
    const created = await call('/admin/offers/newco.free', { method: 'PUT', body: { provider: 'newco', name: 'NewCo (free)',
      base_url: 'https://api.newco.test/v1', lifecycle: 'pending_approval',
      prerequisites: [{ type: 'wallet_balance', amount: 2, currency: 'USD', unlocks: 'free models',
        source: { url: 'https://newco.test/pricing', quote: 'Add $2 to your wallet to unlock free models.' } }] } });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.offer.redistribution, 'unknown');
    assert.equal((await call('/admin/offers/newco.free', { method: 'PUT', body: { lifecycle: 'active' } })).status, 400);
    assert.equal((await call('/admin/offers/newco.free', { method: 'PUT', body: { trust_tier: 'T9' } })).status, 400);
    assert.equal((await call('/admin/offers/Bad%20Id', { method: 'PUT', body: { name: 'x' } })).status, 404);
    const skip = await call('/admin/offers/newco.free/transition', { method: 'POST', body: { to: 'active' } });
    assert.deepEqual([skip.status, skip.body.error.code], [409, 'invalid_transition']);
    const approve = await call('/admin/offers/newco.free/transition', { method: 'POST',
      body: { to: 'awaiting_credentials', note: 'Signed up; key pending' } });
    assert.deepEqual([approve.status, approve.body.offer.lifecycle, approve.body.offer.verified_by],
      [200, 'awaiting_credentials', 'operator']);
    const detail = await call('/admin/offers/newco.free');
    assert.deepEqual(detail.body.events.map(event => event.action), ['transition', 'create']);
    assert.equal(detail.body.events[0].note, 'Signed up; key pending');
    assert.equal((await call('/admin/offers/nothing.here')).status, 404);
    const unsigned = await call('/admin/offers/groq.free/manifest');
    assert.equal(unsigned.body.signed, false);
    const signed = await call('/admin/offers/groq.free/manifest', { method: 'POST' });
    assert.equal(signed.status, 200, JSON.stringify(signed.body));
    assert.ok(await verifyManifest(signed.body.manifest, publicJwkOf(jwk)));
    const stored = await call('/admin/offers/groq.free/manifest');
    assert.deepEqual([stored.body.signed, stored.body.manifest.signature], [true, signed.body.manifest.signature]);
    await call('/admin/offers/groq.free', { method: 'PUT', body: { notes: 'checked 2026-10-24' } });
    assert.equal((await call('/admin/offers/groq.free/manifest')).body.signed, false, 'a change drops the stored signature');
    const noKey = await call('/admin/offers/groq.free/manifest', { method: 'POST', callEnv: { ...env, OIOP_SIGNING_JWK: undefined } });
    assert.deepEqual([noKey.status, noKey.body.error.code], [503, 'signing_not_configured']);
    const schema = await call('/oiop/schema/0.1.json', { token: null });
    assert.deepEqual(schema.body, JSON.parse(JSON.stringify(MANIFEST_SCHEMA)));
    const keys = await call('/oiop/keys.json', { token: null });
    assert.deepEqual(keys.body.keys.map(key => [key.kid, key.x, key.d]), [[await keyId(jwk), jwk.x, undefined]],
      'only the public half is published');
    const builtinOnly = await call('/admin/offers/newco.free', { method: 'PUT', body: { name: 'x' }, callEnv: { GATEWAY_ADMIN_TOKEN: ADMIN } });
    assert.deepEqual([builtinOnly.status, builtinOnly.body.error.code], [503, 'offers_not_configured']);
    const builtinList = await call('/admin/offers', { callEnv: { GATEWAY_ADMIN_TOKEN: ADMIN } });
    assert.deepEqual(builtinList.body.offers.map(offer => offer.id).sort(), BUILTIN_OFFERS.map(offer => offer.id).sort());
    ok('admin API: operator token required; list with models and next states; create, refuse served lifecycles and bad enums, approve with note, audit, sign/store/verify, changes drop the signature; public schema and public key only; read-only without a database');
  }

  // ── The gateway's offer cache reads the database ──
  {
    resetOfferCache(DB);
    await rpcRows(DB, 'zerox_offer_transition', { p_id: 'nvidia.free', p_to: 'suspended', p_actor: 'check' });
    assert.ok(servesOperatorPools(offerById(DB, 'nvidia.free')), 'before loading, the built-in row answers');
    await loadOffers(DB);
    assert.equal(offerById(DB, 'nvidia.free').lifecycle, 'suspended');
    assert.ok(!servesOperatorPools(offerById(DB, 'nvidia.free')));
    assert.ok(offerById(DB, 'newco.free'), 'offers created in the database are visible');
    const broken = { DATABASE_DRIVER: 'pglite', AUTH_HOST: 'example.com' };
    const warn = console.error;
    console.error = () => {};
    try { await loadOffers(broken); } finally { console.error = warn; }
    assert.ok(servesOperatorPools(offerById(broken, 'nvidia.free')), 'no database: the built-in offers keep routing');
    await rpcRows(DB, 'zerox_offer_transition', { p_id: 'nvidia.free', p_to: 'probing', p_actor: 'check' });
    await rpcRows(DB, 'zerox_offer_transition', { p_id: 'nvidia.free', p_to: 'active', p_actor: 'check' });
    resetOfferCache(DB);
    ok('offer cache: database rows replace the built-ins once loaded (a suspended offer stops serving); without a database the built-ins route');
  }

  // ── Routing: policy, capabilities, offer state, shared health, ordering, stickiness ──
  {
    const tracker = new ProviderHealthTracker();
    const router = new RoutingEngine(tracker);
    const env = { GROQ_API_KEY: 'groq-key', GEMINI_API_KEY: 'gemini-key', GEMINI_PAID_API_KEY: 'gemini-paid',
      ALLOW_UNKNOWN_COUNTRY: 'true' };
    const base = { env, requestedModel: 'auto', promptTokens: 1000, maxTokens: 2048, tiers: ['free'], needs: { tools: true } };
    const models = route => [...new Set(route.candidates.map(candidate => candidate.entry.id))];
    const policy = (tiers, training) => callerPolicy(new Headers({ ...(tiers ? { [TRUST_HEADER]: tiers } : {}),
      ...(training ? { [TRAINING_HEADER]: training } : {}) }));
    const all = router.route(base);
    assert.equal(all.candidates[0].entry.id, 'gemini/gemini-2.5-flash');
    assert.equal(all.candidates[0].offer.id, 'gemini.free', 'candidates carry their offer');
    assert.deepEqual(policy('t1, T9,T0').trustTiers, ['T0', 'T1']);
    assert.deepEqual(policy('T9').trustTiers, DEFAULT_TRUST_TIERS, 'a header naming no known tier keeps the default');
    assert.ok(!DEFAULT_TRUST_TIERS.includes('T3'), 'T3 never by default');
    const t1 = router.route({ ...base, policy: policy('T1') });
    assert.ok(t1.ok && models(t1).every(id => !id.startsWith('gemini/')), 'T1 only: the T0 Gemini offers are left out');
    const explicit = router.route({ ...base, requestedModel: 'gemini/gemini-2.5-flash', policy: policy('T1') });
    assert.equal(explicit.error, 'policy_restricted');
    assert.match(explicit.message, /trust tiers T1/);
    const noTraining = router.route({ ...base, requestedModel: 'gemini/gemini-2.5-flash', tiers: ['free', 'paid'],
      policy: policy(null, 'false') });
    assert.deepEqual(noTraining.candidates.map(candidate => candidate.offer.id), ['gemini.paid'],
      'training opt-out: the free tier (trains on inputs) is skipped, the paid tier serves');
    // groq.free is trains_on_inputs=unknown until a quote is captured, so with only Groq and Gemini
    // keys a free-plan caller who opts out of training has no model left.
    const { GEMINI_PAID_API_KEY: _paid, ...freeKeys } = env;
    assert.equal(router.route({ ...base, env: freeKeys, policy: policy(null, 'false') }).error, 'policy_restricted');
    assert.equal(router.route({ ...base, policy: policy(null, 'false') }).error, 'upgrade_required',
      'with a paid pool that does not train, the caller is told to upgrade instead');
    const withWorkers = router.route({ ...base, env: { ...freeKeys, AI: {} }, policy: policy(null, 'false') });
    assert.ok(withWorkers.ok && models(withWorkers).every(id => id.startsWith('@cf/')), 'Workers AI (no training) still serves');
    const vision = router.route({ ...base, needs: { tools: true, vision: true } });
    assert.ok(models(vision).length && models(vision).every(id => catalogEntry(id).supports_vision), 'images: vision models only');
    const groqVision = router.route({ ...base, requestedModel: 'groq/openai/gpt-oss-120b', needs: { vision: true } });
    assert.deepEqual([groqVision.error, groqVision.message], ['invalid_request', 'This model does not accept images; choose a vision model.']);
    assert.equal(requestNeeds({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:' } }] }] }).vision, true);
    assert.equal(requestNeeds({ messages, response_format: { type: 'json_object' } }).json, true);

    const flashKey = poolKey(catalogEntry('gemini/gemini-2.5-flash'), catalogEntry('gemini/gemini-2.5-flash').pools[0]);
    const later = Date.now() + 60_000;
    const blurred = router.route({ ...base, sharedHealth: new Map([[flashKey, { status: 'blurred', until: later }]]) });
    assert.ok(!models(blurred).includes('gemini/gemini-2.5-flash'), 'a pool another isolate saw fail is skipped');
    const expired = router.route({ ...base, sharedHealth: new Map([[flashKey, { status: 'blurred', until: Date.now() - 1 }]]) });
    assert.equal(expired.candidates[0].entry.id, 'gemini/gemini-2.5-flash', 'an ended cooldown no longer counts');
    const degraded = router.route({ ...base, sharedHealth: new Map([[flashKey, { status: 'degraded', until: 0 }]]) });
    assert.notEqual(degraded.candidates[0].entry.id, 'gemini/gemini-2.5-flash');
    assert.equal(degraded.candidates.at(-1).entry.id, 'gemini/gemini-2.5-flash', 'a degraded pool is tried after the healthy ones');
    const spent = router.route({ ...base, budgetState: key => (key === flashKey ? { until: later } : null) });
    assert.equal(spent.candidates.at(-1).entry.id, 'gemini/gemini-2.5-flash', 'a spent budget goes last');

    const sticky = router.route({ ...base, affinity: 'user-1', conversation: 'c:task-42' });
    assert.equal(sticky.sticky, 'user-1|c:task-42');
    router.remember(sticky.sticky, 'groq/openai/gpt-oss-120b');
    assert.equal(router.route({ ...base, affinity: 'user-1', conversation: 'c:task-42' }).candidates[0].entry.id,
      'groq/openai/gpt-oss-120b', 'the conversation stays on the model that served it');
    assert.equal(router.route({ ...base, affinity: 'user-1', conversation: 'c:other' }).candidates[0].entry.id,
      'gemini/gemini-2.5-flash', 'other conversations are not affected');
    assert.equal(router.route({ ...base, affinity: 'user-1', conversation: 'c:task-42', tiers: ['free', 'paid'] })
      .candidates.find(candidate => candidate.pool.tier === 'paid')?.pool.tier, 'paid', 'stickiness never moves paid pools ahead of free ones');
    assert.equal(conversationKey(' task-42 ', messages), 'c:task-42');
    assert.equal(conversationKey(null, [{ role: 'system', content: 'You are Neuron.' }, ...messages]),
      conversationKey(undefined, [{ role: 'system', content: 'You are Neuron.' }, ...messages, { role: 'assistant', content: 'ok' }]),
      'later turns of a conversation hash the same');

    const dbEnv = { ...env, ...DB };
    await rpcRows(DB, 'zerox_offer_transition', { p_id: 'groq.free', p_to: 'suspended', p_actor: 'check' });
    resetOfferCache(dbEnv);
    await loadOffers(dbEnv);
    assert.equal(router.route({ ...base, env: dbEnv, requestedModel: 'groq/openai/gpt-oss-120b' }).error, 'model_not_found',
      'a suspended offer serves nothing');
    assert.ok(models(router.route({ ...base, env: dbEnv })).every(id => !id.startsWith('groq/')));
    const listed = listModelsForCaller(dbEnv, { tiers: ['free'] }).data.find(model => model.id === 'groq/openai/gpt-oss-120b');
    assert.deepEqual([listed.available, listed.unavailable_reason], [false, 'not_configured'], '/v1/models agrees');
    await rpcRows(DB, 'zerox_offer_transition', { p_id: 'groq.free', p_to: 'probing', p_actor: 'check' });
    await rpcRows(DB, 'zerox_offer_transition', { p_id: 'groq.free', p_to: 'active', p_actor: 'check' });
    resetOfferCache(dbEnv);
    ok('routing: trust tiers and training opt-out per request (T3 never by default), vision/streaming/json needs, suspended offers serve nothing (also in /v1/models), shared busy/blurred pools skipped, degraded and spent pools demoted, per-conversation stickiness within the free tier');
  }

  // ── Chat handler: X-OIOP-Offer, X-OIOP-Fallback, policy errors ──
  {
    const tracker = new ProviderHealthTracker();
    const router = new RoutingEngine(tracker);
    const store = new Map();
    const chat = new Hono();
    chat.post('/v1/chat/completions', createChatHandler({
      validateSession: async c => {
        const token = (c.req.header('Authorization') || '').replace(/^Bearer /, '');
        return store.has(token) ? { token, session: store.get(token) } : null;
      },
      setSession: async (c, token, value) => { store.set(token, value); },
      getSession: async (c, token) => store.get(token) || null,
      planLimits: async () => ({ free: { name: 'Free', daily_tokens: 256000, daily_requests: 2000, price_usd: 0 } }),
      router, healthTracker: tracker,
    }));
    store.set('ses_anon', { created: Date.now(), plan: 'free', requests: 0, tokens_used: 0, usage_day: new Date().toISOString().slice(0, 10) });
    const env = { GROQ_API_KEY: 'groq-key', GEMINI_API_KEY: 'gemini-key', ALLOW_UNKNOWN_COUNTRY: 'true' };
    const upstreamModels = [];
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input?.url ?? input);
      if (!url.startsWith('https://generativelanguage.googleapis.com/') && !url.startsWith('https://api.groq.com/')) {
        throw new Error(`Unexpected outbound request: ${url}`);
      }
      const { model } = JSON.parse(init.body);
      upstreamModels.push(model);
      if (model === 'gemini-2.5-flash') {
        return Response.json({ error: { message: 'quota', code: 429 } }, { status: 429, headers: { 'Retry-After': '30' } });
      }
      return Response.json({ id: 'up', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } });
    };
    const send = (extra = {}, body = {}) => chat.request('https://zero-x.live/v1/chat/completions', { method: 'POST',
      headers: { Authorization: 'Bearer ses_anon', 'Content-Type': 'application/json', ...extra },
      body: JSON.stringify({ model: 'auto', messages, tools, ...body }) }, env);
    const quiet = async fn => {
      const saved = [console.warn, console.error];
      console.warn = () => {}; console.error = () => {};
      try { return await fn(); } finally { [console.warn, console.error] = saved; }
    };
    const rerouted = await quiet(() => send());
    assert.equal(rerouted.status, 200);
    assert.deepEqual(upstreamModels, ['gemini-2.5-flash', 'gemini-3.5-flash']);
    assert.equal(rerouted.headers.get('x-oiop-offer'), 'gemini.free');
    assert.equal(rerouted.headers.get('x-oiop-fallback'), 'gemini/gemini-2.5-flash; offer=gemini.free; reason=rate_limited');
    assert.equal(rerouted.headers.get('x-neuron-model'), 'gemini/gemini-3.5-flash');
    assert.equal(router.sticky.get(`ses_anon|${conversationKey(null, messages)}`), 'gemini/gemini-3.5-flash',
      'the model that served is remembered for the conversation');
    upstreamModels.length = 0;
    const direct = await send({ [TRUST_HEADER]: 'T1' });
    assert.equal(direct.status, 200);
    assert.deepEqual([upstreamModels, direct.headers.get('x-oiop-offer'), direct.headers.get('x-oiop-fallback')],
      [['openai/gpt-oss-120b'], 'groq.free', null], 'T1 only: served by Groq first, no fallback header');
    const refused = await send({ [TRUST_HEADER]: 'T3' });
    assert.equal(refused.status, 403);
    assert.equal((await refused.json()).error.code, 'policy_restricted');
    assert.equal(refused.headers.get('x-oiop-offer'), null, 'errors name no offer');
    globalThis.fetch = async input => { throw new Error(`Unexpected outbound request: ${String(input?.url ?? input)}`); };
    ok('chat handler: X-OIOP-Offer names the serving offer, X-OIOP-Fallback the first choice and why it did not serve; the served model sticks to the conversation; trust-tier headers route and refuse (403 policy_restricted)');
  }

  // ── Secret scrubber: detection ──
  {
    const secretsIn = text => findSecrets(text).map(([start, end]) => text.slice(start, end));
    const openai = `sk-proj-${'a1B2'.repeat(10)}`;
    const groq = `gsk_${'Q9w8'.repeat(13)}`;
    const pem = `-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\n-----END PRIVATE KEY-----`;
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const positives = [
      [`client = OpenAI(api_key="${openai}")`, openai],
      [`GROQ_API_KEY=${groq}`, groq],
      ['key: AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY', 'AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY'],
      ['AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE', 'AKIAIOSFODNN7EXAMPLE'],
      [`token ghp_${'x1Y2'.repeat(9)} end`, `ghp_${'x1Y2'.repeat(9)}`],
      [pem, pem],
      [`Authorization: ${jwt}`, jwt],
      ['DATABASE_URL=postgres://app:s3cr3t-Pa55@db.internal:5432/app', 's3cr3t-Pa55'],
      ['export STRIPE_WEBHOOK_SECRET="whsec_7f3a9c21b0d4e5f6"', 'whsec_7f3a9c21b0d4e5f6'],
      ['{ "password": "hunter2hunter2" }', 'hunter2hunter2'],
      ['db:\n  password: Zx81qPlm0Nn\n', 'Zx81qPlm0Nn'],
    ];
    for (const [text, secret] of positives) assert.ok(secretsIn(text).includes(secret), `finds ${secret.slice(0, 24)} in ${text.slice(0, 40)}`);
    const negatives = [
      'API_KEY=process.env.API_KEY', 'API_KEY=your-api-key-here', 'password: ${DB_PASSWORD}', 'token = "xxxxxxxxxxxx"',
      'const apiKey = config.openai.apiKey;', 'Fixed the password reset flow in auth.js', 'commit 9fceb02d0ae598e95dc970b74767f19372d61af8',
      'SECRET_NAME=short', 'PASSWORD=<your password>', 'OPENAI_API_KEY=changeme',
    ];
    for (const text of negatives) assert.deepEqual(secretsIn(text), [], `nothing in ${text}`);
    ok(`scrubber detection: ${positives.length} credential forms found (provider keys, PEM, JWT, connection-string and assignment values); ${negatives.length} look-alikes (env references, placeholders, prose, hashes) left alone`);
  }

  // ── Secret scrubber: requests, placeholders, restoring ──
  {
    const groq = `gsk_${'Q9w8'.repeat(13)}`;
    const dotenv = `GROQ_API_KEY=${groq}\nDEBUG=true\n`;
    const body = { model: 'auto', messages: [
      { role: 'system', content: 'You are Neuron.' },
      { role: 'user', content: [{ type: 'text', text: `Rotate this: ${groq}` }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function',
        function: { name: 'write_file', arguments: JSON.stringify({ path: '.env', content: dotenv }) } }] },
      { role: 'tool', tool_call_id: 'call_1', content: `wrote .env:\n${dotenv}` },
    ] };
    const { body: sent, secrets, count } = await scrubRequest(body);
    const wire = JSON.stringify(sent);
    assert.equal(count, 1);
    assert.ok(!wire.includes(groq), 'the key never reaches the upstream');
    const [placeholder] = secrets.keys();
    assert.match(placeholder, /^zxsecret_[0-9a-f]{12}$/);
    assert.equal(wire.split(placeholder).length - 1, 3, 'the same placeholder everywhere the key appears');
    assert.deepEqual(JSON.parse(sent.messages[2].tool_calls[0].function.arguments),
      { path: '.env', content: `GROQ_API_KEY=${placeholder}\nDEBUG=true\n` }, 'arguments stay valid JSON');
    assert.equal(sent.messages[0], body.messages[0], 'untouched messages are reused as is');
    assert.equal((await scrubRequest(body)).secrets.keys().next().value, placeholder, 'stable across turns (prompt caches still match)');
    const clean = { model: 'auto', messages };
    assert.equal((await scrubRequest(clean)).body, clean, 'a request without secrets is passed through');

    const tricky = 'line1\n"quoted"\\end';
    const restorer = new SecretRestorer(new Map([['zxsecret_0123456789ab', tricky], [placeholder, groq]]));
    const completion = restorer.completion({ choices: [{ index: 0, message: { role: 'assistant',
      content: `Use ${placeholder}.`, tool_calls: [{ id: 'c', type: 'function',
        function: { name: 'write_file', arguments: '{"content":"K=zxsecret_0123456789ab"}' } }] } }] });
    assert.equal(completion.choices[0].message.content, `Use ${groq}.`);
    assert.deepEqual(JSON.parse(completion.choices[0].message.tool_calls[0].function.arguments), { content: `K=${tricky}` },
      'secrets go back JSON-escaped into tool arguments');

    const streamed = new SecretRestorer(new Map([[placeholder, groq]]));
    const pieces = ['Key: zxse', 'cret_', placeholder.slice(9, 15), `${placeholder.slice(15)} done`];
    const out = pieces.map(text => streamed.chunk({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })
      .choices[0].delta.content).join('');
    assert.equal(out, `Key: ${groq} done`, 'a placeholder split over four chunks is restored');
    const args = new SecretRestorer(new Map([[placeholder, groq]]));
    const argText = [`{"k":"${placeholder.slice(0, 5)}`, `${placeholder.slice(5)}"}`].map(text =>
      args.chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: text } }] }, finish_reason: null }] })
        .choices[0].delta.tool_calls[0].function.arguments).join('');
    assert.equal(argText, `{"k":"${groq}"}`);
    const tail = new SecretRestorer(new Map([[placeholder, groq]]));
    assert.equal(tail.chunk({ choices: [{ index: 0, delta: { content: 'ends with zxsecret_0' }, finish_reason: null }] }).choices[0].delta.content, 'ends with ');
    assert.equal(tail.chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }).choices[0].delta.content, 'zxsecret_0',
      'held text that never became a placeholder is released when the choice ends');
    const open = new SecretRestorer(new Map([[placeholder, groq]]));
    open.chunk({ choices: [{ index: 0, delta: { content: 'x zxsec' }, finish_reason: null }] });
    assert.deepEqual(open.finalChunk({ id: 'c' }).choices[0].delta, { content: 'zxsec' }, 'and at the end of a stream without a finish');
    assert.equal(scrubMode({}), 'all');
    assert.equal(scrubMode({ OIOP_SCRUB: 'nonsense' }), 'all');
    assert.ok(!scrubsOffer('untrusted', offerById({}, 'groq.free')) && scrubsOffer('untrusted', { trust_tier: 'T3' }));
    assert.ok(!scrubsOffer('off', { trust_tier: 'T3' }));
    ok('scrubber requests: text, parts, tool results and tool-call arguments (still valid JSON) carry one stable placeholder per secret; answers get the secrets back, JSON-escaped in arguments, across split stream chunks, with held text released at the end');
  }

  // ── Secret scrubber: through the chat handler ──
  {
    const groq = `gsk_${'Q9w8'.repeat(13)}`;
    const store = new Map([['ses_anon', { created: Date.now(), plan: 'free', requests: 0, tokens_used: 0,
      usage_day: new Date().toISOString().slice(0, 10) }]]);
    const tracker = new ProviderHealthTracker();
    const chat = new Hono();
    chat.post('/v1/chat/completions', createChatHandler({
      validateSession: async c => ({ token: 'ses_anon', session: store.get('ses_anon') }),
      setSession: async (c, token, value) => { store.set(token, value); },
      getSession: async () => store.get('ses_anon'),
      planLimits: async () => ({ free: { name: 'Free', daily_tokens: 256000, daily_requests: 2000, price_usd: 0 } }),
      router: new RoutingEngine(tracker), healthTracker: tracker,
    }));
    const env = { GROQ_API_KEY: 'groq-upstream-key' };
    let upstreamBody = null;
    const encoder = new TextEncoder();
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input?.url ?? input);
      if (!url.startsWith('https://api.groq.com/')) throw new Error(`Unexpected outbound request: ${url}`);
      upstreamBody = init.body;
      const sentBody = JSON.parse(init.body);
      const placeholder = init.body.match(/zxsecret_[0-9a-f]{12}/)?.[0] || 'none';
      if (!sentBody.stream) {
        return Response.json({ id: 'up', choices: [{ index: 0, message: { role: 'assistant', content: `Saved ${placeholder}` },
          finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } });
      }
      const events = [
        { choices: [{ index: 0, delta: { role: 'assistant', content: `Key ${placeholder.slice(0, 11)}` }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { content: placeholder.slice(11) }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_9', type: 'function',
          function: { name: 'write_file', arguments: `{"content":"K=${placeholder}"}` } }] }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } },
      ];
      return new Response(new ReadableStream({ start(controller) {
        for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      } }), { headers: { 'Content-Type': 'text/event-stream' } });
    };
    const send = (extra = {}, callEnv = env) => chat.request('https://zero-x.live/v1/chat/completions', { method: 'POST',
      headers: { Authorization: 'Bearer ses_anon', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'groq/openai/gpt-oss-120b', messages: [{ role: 'user', content: `My key is ${groq}` }], ...extra }) }, callEnv);
    const plain = await send();
    assert.equal(plain.status, 200);
    assert.ok(!upstreamBody.includes(groq), 'the upstream got the placeholder');
    assert.equal(plain.headers.get('x-oiop-redacted'), '1');
    assert.equal((await plain.json()).choices[0].message.content, `Saved ${groq}`, 'the client got the key back');
    const streamed = await send({ stream: true, tools });
    const text = await streamed.text();
    assert.ok(!upstreamBody.includes(groq));
    const chunks = text.split('\n\n').filter(Boolean).map(event => event.slice(6)).filter(data => data !== '[DONE]').map(JSON.parse);
    const content = chunks.map(chunk => chunk.choices?.[0]?.delta?.content || '').join('');
    const argumentsText = chunks.flatMap(chunk => chunk.choices?.[0]?.delta?.tool_calls || []).map(call => call.function?.arguments || '').join('');
    assert.equal(content, `Key ${groq}`);
    assert.deepEqual(JSON.parse(argumentsText), { content: `K=${groq}` });
    assert.ok(!text.includes('zxsecret_'), 'no placeholder reaches the client');
    await send({}, { ...env, OIOP_SCRUB: 'off' });
    assert.ok(upstreamBody.includes(groq), 'OIOP_SCRUB=off sends the prompt as is');
    await send({}, { ...env, OIOP_SCRUB: 'untrusted' });
    assert.ok(upstreamBody.includes(groq), 'untrusted: a T1 offer gets the prompt as is');
    globalThis.fetch = async input => { throw new Error(`Unexpected outbound request: ${String(input?.url ?? input)}`); };
    ok('scrubber end to end: the upstream sees placeholders, the client sees its own secrets (JSON and streamed content and tool arguments), X-OIOP-Redacted counts them; OIOP_SCRUB off/untrusted respected');
  }

  // ── Catalog: providers, logos, offers, policy, models.dev facts ──
  {
    const kvData = new Map();
    const kv = {
      get: async (key, type) => (kvData.has(key) ? (type === 'json' ? JSON.parse(kvData.get(key)) : kvData.get(key)) : null),
      put: async (key, value) => { kvData.set(key, value); },
    };
    const env = { GROQ_API_KEY: 'groq-key', GEMINI_API_KEY: 'gemini-key', ALLOW_UNKNOWN_COUNTRY: 'true', SESSIONS_KV: kv };
    const list = async (headers = {}, callEnv = env) => (await app.request('https://zero-x.live/v1/models', { headers }, callEnv)).json();
    resetModelsDevCache();
    const before = await list();
    const groq = before.data.find(model => model.id === 'groq/openai/gpt-oss-120b');
    assert.deepEqual(groq.provider, { id: 'groq', name: 'Groq', logo_url: 'https://models.dev/logos/groq.svg',
      logo_fallback_url: 'https://groq.com/favicon.ico' });
    assert.deepEqual(groq.offers, [{ id: 'groq.free', tier: 'free', owner: 'operator', trust_tier: 'T1', trains_on_inputs: 'unknown' }]);
    assert.equal(groq.models_dev_id, 'groq/openai/gpt-oss-120b');
    assert.equal(groq.facts, null, 'no facts until the cron stored them');
    assert.equal(before.data.find(model => model.id === 'gemini/gemini-2.5-flash').provider.logo_url, 'https://models.dev/logos/google.svg');
    const t1 = await list({ [TRUST_HEADER]: 'T1' });
    const flash = t1.data.find(model => model.id === 'gemini/gemini-2.5-flash');
    assert.deepEqual([flash.available, flash.unavailable_reason], [false, 'policy_restricted']);
    assert.equal(t1.data.find(model => model.id === 'auto').available, true, 'auto still has Groq');

    const document = {
      groq: { models: { 'openai/gpt-oss-120b': { name: 'GPT OSS 120B', family: 'gpt-oss', release_date: '2025-08-05',
        knowledge: '2024-06', open_weights: true, reasoning: true, structured_output: true,
        modalities: { input: ['text'], output: ['text'] }, cost: { input: 0.15, output: 0.6 }, extra: 'dropped' } } },
      google: { models: { 'gemini-2.5-flash': { name: 'Gemini 2.5 Flash', open_weights: false } } },
    };
    let fetches = 0;
    const fetchImpl = async url => {
      fetches++;
      assert.equal(url, 'https://models.dev/api.json');
      return Response.json(document);
    };
    const refreshed = await refreshModelsDevFacts(env, CATALOG, { fetchImpl });
    assert.deepEqual(refreshed, { refreshed: true, models: 2 });
    assert.deepEqual(await refreshModelsDevFacts(env, CATALOG, { fetchImpl }), { skipped: 'fresh' });
    assert.equal(fetches, 1, 'once a day');
    const withFacts = await list();
    assert.deepEqual(withFacts.data.find(model => model.id === 'groq/openai/gpt-oss-120b').facts, {
      models_dev_id: 'groq/openai/gpt-oss-120b', name: 'GPT OSS 120B', family: 'gpt-oss', canonical_model_id: null,
      release_date: '2025-08-05', knowledge: '2024-06', open_weights: true, reasoning: true, structured_output: true,
      modalities: { input: ['text'], output: ['text'] }, list_price_per_million: { input: 0.15, output: 0.6 } });
    const day = Date.now() + 25 * 3600_000;
    const warn = console.warn;
    console.warn = () => {};
    try {
      assert.deepEqual(await refreshModelsDevFacts(env, CATALOG, { now: day, fetchImpl: async () => new Response('', { status: 502 }) }),
        { refreshed: false });
    } finally { console.warn = warn; }
    resetModelsDevCache();
    assert.equal((await list()).data.find(model => model.id === 'groq/openai/gpt-oss-120b').facts.name, 'GPT OSS 120B',
      'a failed refresh keeps the last facts');
    assert.deepEqual(await refreshModelsDevFacts(env, CATALOG, { now: day + 60_000, fetchImpl }), { skipped: 'fresh' }, 'retried after an hour');
    assert.deepEqual(await refreshModelsDevFacts(env, CATALOG, { now: day + 3601_000, fetchImpl }), { refreshed: true, models: 2 });
    assert.deepEqual(await refreshModelsDevFacts({}, CATALOG, { fetchImpl }), { skipped: 'no_kv' });
    resetModelsDevCache();
    ok('catalog: every model names its provider with a models.dev logo and favicon fallback, its offers (tier, trust tier, training) and models.dev id; the caller policy marks ruled-out models policy_restricted; models.dev facts refreshed daily into KV, kept on failure, retried after an hour');
  }

  // ── Catalog push: GET /v1/models/stream ──
  {
    const env = { GROQ_API_KEY: 'groq-key', GEMINI_API_KEY: 'gemini-key', ALLOW_UNKNOWN_COUNTRY: 'true',
      MODELS_STREAM_INTERVAL_MS: '40', MODELS_STREAM_LIFETIME_MS: '600' };
    const groqEntry = catalogEntry('groq/openai/gpt-oss-120b');
    const groqKey = poolKey(groqEntry, groqEntry.pools[0]);
    const readEvents = async (response, onEvent) => {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const events = [];
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let cut;
        while ((cut = buffer.indexOf('\n\n')) >= 0) {
          const raw = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const event = Object.fromEntries(raw.split('\n').filter(line => !line.startsWith(':') && line.includes(':'))
            .map(line => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1).trim()]));
          event.comment = raw.startsWith(':');
          events.push(event);
          await onEvent?.(event, events);
        }
      }
      return events;
    };
    const response = await app.request('https://zero-x.live/v1/models/stream', {}, env);
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    let failed = false;
    const events = await readEvents(response, event => {
      if (event.event === 'catalog.updated' && !failed) {
        failed = true;
        globalHealthTracker.recordFailure(groqKey, { kind: FailureKind.AUTH });
      }
    });
    globalHealthTracker.reset(groqKey);
    const updates = events.filter(event => event.event === 'catalog.updated');
    assert.equal(events[0].retry, '5000');
    assert.equal(updates.length, 2, 'one event at the start, one when Groq went down; keep-alives in between');
    assert.ok(events.some(event => event.comment), 'keep-alive comments while nothing changes');
    const [firstUpdate, secondUpdate] = updates.map(event => JSON.parse(event.data));
    assert.equal(firstUpdate.data.find(model => model.id === groqEntry.id).status, 'available');
    assert.equal(secondUpdate.data.find(model => model.id === groqEntry.id).status, 'blurred');
    assert.notEqual(updates[0].id, updates[1].id, 'each event carries the status ETag as its id');
    const resumed = await readEvents(await app.request('https://zero-x.live/v1/models/stream',
      { headers: { 'Last-Event-ID': updates[0].id } }, env));
    assert.equal(resumed.filter(event => event.event === 'catalog.updated').length, 0, 'a reconnect with the current ETag gets no repeat');
    const t1 = await readEvents(await app.request('https://zero-x.live/v1/models/stream', { headers: { [TRUST_HEADER]: 'T1' } },
      { ...env, MODELS_STREAM_LIFETIME_MS: '50' }));
    assert.equal(JSON.parse(t1.find(event => event.event === 'catalog.updated').data).data
      .find(model => model.id === 'gemini/gemini-2.5-flash').unavailable_reason, 'policy_restricted', 'the stream follows the caller policy');
    ok('catalog push: /v1/models/stream emits catalog.updated (id = status ETag) at start and on every change, keep-alives otherwise, ends after its lifetime, resumes by Last-Event-ID and follows the caller policy');
  }

  // ── Health: canaries, rolling metrics, spent daily quotas ──
  {
    const env = { GROQ_API_KEY: 'groq-key', GROQ_MODELS: 'openai/gpt-oss-120b' };
    const entry = catalogEntry('groq/openai/gpt-oss-120b');
    const key = poolKey(entry, entry.pools[0]);
    const saved = new Map();
    const state = { blockConcurrencyWhile: fn => fn(), storage: { get: async name => saved.get(name),
      put: async (name, value) => { saved.set(name, structuredClone(value)); }, getAlarm: async () => 1, setAlarm: async () => {} } };
    const base = Date.UTC(2026, 9, 24, 6);
    let offset = 0;
    let canaryReply = 'tool';
    const canaryBodies = [];
    const encoder = new TextEncoder();
    const sse = events => new Response(new ReadableStream({ start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
    const upstream = async (input, init = {}) => {
      const url = String(input?.url ?? input);
      if (url === 'https://api.groq.com/openai/v1/models') return Response.json({ data: [{ id: 'openai/gpt-oss-120b' }] });
      if (url === 'https://groqstatus.com/api/v2/summary.json') return Response.json({ components: [] });
      if (url === 'https://api.groq.com/openai/v1/chat/completions') {
        canaryBodies.push(JSON.parse(init.body));
        if (canaryReply === 'text') return sse([{ choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: 'stop' }] }]);
        return sse([
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function',
            function: { name: 'record_result', arguments: '{"status":"ok",' } }] }, finish_reason: null }] },
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"value":42}' } }] }, finish_reason: 'tool_calls' }] },
        ]);
      }
      throw new Error(`Unexpected outbound request: ${url}`);
    };
    globalThis.fetch = upstream;
    const hub = new HealthHub(state, env, { fetchImpl: upstream, now: () => base + offset });
    await hub.ready;
    await hub.alarm();
    assert.equal(canaryBodies.length, 1, 'one canary for the idle pool');
    assert.equal(canaryBodies[0].stream, true);
    assert.equal(canaryBodies[0].tools[0].function.name, 'record_result');
    let row = hub.snapshot().pools[key];
    assert.deepEqual([row.status, row.canary.ok, row.canary.tool_call], ['available', true, true]);
    offset += 30_000;
    await hub.alarm();
    assert.equal(canaryBodies.length, 1, 'not again within the interval');
    assert.equal(canaryIntervalMs(PROBE_DAILY_CAPS.groq), 2 * 3600_000, 'Groq: 12 canaries a day, every 2 h');
    assert.equal(canaryIntervalMs(PROBE_DAILY_CAPS.gemini), 8 * 3600_000, 'Gemini: 3 a day, every 8 h');
    offset += 2 * 3600_000;
    hub.report([{ key, success: true, latencyMs: 400 }]);
    await hub.alarm();
    assert.equal(canaryBodies.length, 1, 'real traffic in the last 15 minutes already proves the pool');
    offset += 16 * 60_000;
    canaryReply = 'text';
    await hub.alarm();
    assert.equal(canaryBodies.length, 2);
    row = hub.snapshot().pools[key];
    assert.deepEqual([row.canary.ok, row.canary.tool_call, row.status], [false, false, 'degraded'],
      'a stream without the tool call degrades the pool');
    hub.tracker.recordSuccess(key);
    hub.probes.canaries[key] = canaryBudget(PROBE_DAILY_CAPS.groq);
    offset += 3 * 3600_000;
    canaryReply = 'tool';
    await hub.alarm();
    assert.equal(canaryBodies.length, 2, 'never more than half the daily cap');
    const restored = new HealthHub(state, env, { fetchImpl: upstream, now: () => base + offset });
    await restored.ready;
    assert.equal(restored.snapshot().pools[key].canary.ok, false, 'canary results survive a restart');
    const quiet = new HealthHub({ ...state, storage: { ...state.storage, get: async () => undefined } },
      { ...env, HEALTH_CANARIES: 'false' }, { fetchImpl: upstream, now: () => base + offset });
    await quiet.ready;
    await quiet.alarm();
    assert.equal(canaryBodies.length, 2, 'HEALTH_CANARIES=false sends none');

    const metrics = new HealthHub({ ...state, storage: { ...state.storage, get: async () => undefined } }, env,
      { fetchImpl: upstream, now: () => base });
    await metrics.ready;
    metrics.report([100, 200, 300, 400, 500, 600, 700, 800].map(latencyMs => ({ key, success: true, latencyMs })));
    metrics.report([{ key, success: false, kind: FailureKind.SERVER }, { key, success: false, kind: FailureKind.SERVER },
      { key, success: false, kind: FailureKind.INVALID }]);
    row = metrics.snapshot().pools[key];
    assert.deepEqual([row.samples, row.error_rate, row.p50_ms, row.p95_ms], [10, 0.2, 500, 800],
      'error rate over pool-level outcomes only (an invalid request is the caller\'s)');
    const router = new RoutingEngine(new ProviderHealthTracker());
    const routed = router.route({ env: { GROQ_API_KEY: 'k' }, requestedModel: 'auto', promptTokens: 1000, maxTokens: 2048,
      needs: { tools: true }, sharedHealth: new Map([[key, { status: 'available', until: 0, samples: 20, error_rate: 0.3 }]]) });
    assert.notEqual(routed.candidates[0].entry.id, 'groq/openai/gpt-oss-120b', 'a pool failing 30% of recent requests goes after the others');

    const perDay = JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota', details: [
      { '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaValue: '250' }] }] } });
    const daily = classifyUpstreamFailure(429, perDay);
    assert.deepEqual([daily.kind, daily.dailyQuota], [FailureKind.RATE_LIMITED, true]);
    assert.equal(classifyUpstreamFailure(429, '{"error":{"message":"slow down"}}').dailyQuota, false);
    const tracker = new ProviderHealthTracker();
    tracker.recordFailure('gemini:gemini-2.5-flash:free', { kind: daily.kind, retryAfterSeconds: daily.retryAfterSeconds, dailyQuota: true });
    tracker.recordFailure('groq:x:free', { kind: FailureKind.RATE_LIMITED, retryAfterSeconds: 20 });
    assert.deepEqual([tracker.getRecord('gemini:gemini-2.5-flash:free').status, tracker.getRecord('groq:x:free').status],
      [HealthState.QUOTA_EXHAUSTED, HealthState.RATE_LIMITED]);
    const spentRouter = new RoutingEngine(tracker);
    assert.equal(spentRouter.route({ env: { GEMINI_API_KEY: 'g', ALLOW_UNKNOWN_COUNTRY: 'true' }, requestedModel: 'gemini/gemini-2.5-flash',
      promptTokens: 100, maxTokens: 1024 }).error, 'capacity_exhausted', 'a spent daily quota answers capacity_exhausted');
    globalThis.fetch = async input => { throw new Error(`Unexpected outbound request: ${String(input?.url ?? input)}`); };
    ok('health: idle healthy pools get a streamed tool-call canary within half the daily cap (Groq every 2 h, Gemini 8 h), skipped while real traffic flows, degrading on failure, persisted, switchable off; rolling p50/p95 and error rate feed routing; per-day 429s mark QUOTA_EXHAUSTED');
  }

  console.log(`\nPASS: OIOP (${passed.length} groups): offers, lifecycle, terms review, audit, manifests, signing, admin API, routing policy, headers, secret scrubber, catalog, push, health`);
} finally {
  globalThis.fetch = realFetch;
  await closeAllPglite();
}

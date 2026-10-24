// OIOP offers, manifests and routing policy (src/oiop/, migration 20261024000200_oiop_offers.sql),
// offline: PGlite for the database, no outbound requests.
//   node check-oiop.mjs
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { rpcRows } from './src/account-store.js';
import { closeAllPglite, getPgliteHandle } from './src/db/pglite.js';
import { CATALOG, catalogEntry, listModelsForCaller, poolKey } from './src/catalog.js';
import { RoutingEngine } from './src/router.js';
import { ProviderHealthTracker } from './src/provider-health.js';
import { conversationKey, createChatHandler, requestNeeds } from './src/chat-handler.js';
import { callerPolicy, DEFAULT_TRUST_TIERS, TRAINING_HEADER, TRUST_HEADER } from './src/oiop/policy.js';
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

  console.log(`\nPASS: OIOP (${passed.length} groups): offers, lifecycle, terms review, audit, manifests, signing, admin API, routing policy, headers`);
} finally {
  globalThis.fetch = realFetch;
  await closeAllPglite();
}

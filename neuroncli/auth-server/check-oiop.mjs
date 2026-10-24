// OIOP offers, manifests and routing policy (src/oiop/, migration 20261024000200_oiop_offers.sql),
// offline: PGlite for the database, no outbound requests.
//   node check-oiop.mjs
import assert from 'node:assert/strict';
import { rpcRows } from './src/account-store.js';
import { closeAllPglite, getPgliteHandle } from './src/db/pglite.js';
import { CATALOG } from './src/catalog.js';
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

  console.log(`\nPASS: OIOP (${passed.length} groups): offers, lifecycle, terms review, audit, manifests, signing, admin API`);
} finally {
  globalThis.fetch = realFetch;
  await closeAllPglite();
}

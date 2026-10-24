// OIOP offers (docs/PLATFORM_CONTRACT.md §12.1, docs/OIOP.md). The /admin routes are operator
// only: Bearer GATEWAY_ADMIN_TOKEN, plus a valid Cloudflare Access JWT when CF_ACCESS_* is
// configured. Every change goes through the zerox_offer_* functions, which enforce the lifecycle
// and write the audit log (zerox_offer_events); the actor is the Access e-mail address when there
// is one, else "operator". The schema and the registry's public key are public.
import { databaseConfigured, rpcRows } from '../account-store.js';
import { ApiError, errorResponse, sendApiError } from '../auth-context.js';
import { isOperator } from '../operator-auth.js';
import { accessConfigured, passedAccess, verifyAccessJwt } from '../access-auth.js';
import { catalogEntries, entryPools, loadCatalogDbModels } from '../catalog.js';
import {
  loadOffers, offerById, offerIdFor, offersList, resetOfferCache, TRANSITIONS,
} from '../oiop/offers.js';
import {
  buildManifest, keyId, MANIFEST_SCHEMA, OFFER_FACTS_SCHEMA, publicJwkOf, signingJwk, signManifest, validateManifest,
} from '../oiop/manifest.js';

const OFFER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_BODY_BYTES = 65536;

// Postgres exceptions raised by the offer functions.
function databaseFailure(error) {
  const message = String(error?.message || '');
  if (message.includes('offer_not_found')) return new ApiError(404, 'not_found', 'No offer with this id.');
  if (message.includes('stale_manifest')) return new ApiError(409, 'stale_manifest', 'The offer changed while it was being signed; sign it again.');
  const transition = message.match(/invalid_transition: [a-z_]+ -> [a-z_]+/);
  if (transition) return new ApiError(409, 'invalid_transition', transition[0]);
  const invalid = message.indexOf('invalid_offer:');
  if (invalid >= 0) return new ApiError(400, 'invalid_request', message.slice(invalid).slice(0, 300));
  if (/violates (check|not-null) constraint/.test(message)) return new ApiError(400, 'invalid_request', 'The offer facts are not valid.');
  return error;
}

async function actorOf(c) {
  if (!accessConfigured(c.env)) return 'operator';
  const identity = await verifyAccessJwt(c.env, c.req.header('Cf-Access-Jwt-Assertion'));
  return (identity?.email || identity?.sub || 'operator').slice(0, 64);
}

async function readJson(c) {
  const raw = await c.req.text();
  if (raw.length > MAX_BODY_BYTES) throw new ApiError(413, 'request_too_large', 'The request body is too large.');
  let body;
  try { body = raw ? JSON.parse(raw) : {}; } catch { throw new ApiError(400, 'invalid_request', 'The body must be JSON.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'invalid_request', 'The body must be a JSON object.');
  return body;
}

function offerIdParam(c) {
  const id = c.req.param('id');
  if (!OFFER_ID.test(id || '')) throw new ApiError(404, 'not_found', 'No offer with this id.');
  return id;
}

// Catalog entries with at least one pool in the offer.
export function offerEntries(env, id) {
  return catalogEntries(env).filter(entry => entryPools(env, entry).some(pool => offerIdFor(entry, pool) === id));
}

function publicOffer(env, offer) {
  return {
    ...offer,
    next_states: TRANSITIONS[offer.lifecycle] || [],
    models: offerEntries(env, offer.id).map(entry => entry.id),
    source: databaseConfigured(env) ? 'database' : 'builtin',
  };
}

function requireDatabase(env) {
  if (!databaseConfigured(env)) {
    throw new ApiError(503, 'offers_not_configured', 'The account database is not configured; built-in offers are read-only.');
  }
}

export function registerOfferRoutes(api) {
  const operatorOnly = handler => async c => {
    if (!await isOperator(c)) return errorResponse(c, 401, 'invalid_session', 'Operator authentication required.');
    if (!await passedAccess(c)) return errorResponse(c, 403, 'access_required', 'Cloudflare Access authentication required.');
    c.header('Cache-Control', 'no-store');
    try {
      return await handler(c);
    } catch (error) {
      return sendApiError(c, databaseFailure(error));
    }
  };

  // ── Public ──

  api.get('/oiop/schema/0.1.json', c => {
    c.header('Cache-Control', 'public, max-age=3600');
    return c.json(MANIFEST_SCHEMA);
  });

  // The public half of the registry signing key, to verify signed manifests.
  api.get('/oiop/keys.json', async c => {
    const jwk = signingJwk(c.env);
    c.header('Cache-Control', 'public, max-age=300');
    return c.json({ keys: jwk ? [{ ...publicJwkOf(jwk), kid: await keyId(jwk), alg: 'EdDSA', use: 'sig' }] : [] });
  });

  // ── Operator ──

  api.get('/admin/offers', operatorOnly(async c => {
    await Promise.all([loadOffers(c.env), loadCatalogDbModels(c.env)]);
    return c.json({ offers: offersList(c.env).map(offer => publicOffer(c.env, offer)) });
  }));

  api.get('/admin/offers/:id', operatorOnly(async c => {
    const id = offerIdParam(c);
    await Promise.all([loadOffers(c.env), loadCatalogDbModels(c.env)]);
    const offer = offerById(c.env, id);
    if (!offer) throw new ApiError(404, 'not_found', 'No offer with this id.');
    const events = databaseConfigured(c.env) ? await rpcRows(c.env, 'zerox_offer_events_list', { p_id: id, p_limit: 50 }) : [];
    return c.json({ offer: publicOffer(c.env, offer), events });
  }));

  // Creates an offer or changes its facts. A new terms_sha256 on an offer in service moves it to
  // review (the database decides; see zerox_offer_upsert).
  api.put('/admin/offers/:id', operatorOnly(async c => {
    const id = offerIdParam(c);
    requireDatabase(c.env);
    const body = await readJson(c);
    const errors = validateManifest(body, OFFER_FACTS_SCHEMA);
    if (errors.length) throw new ApiError(400, 'invalid_request', errors.slice(0, 5).join('; '));
    const [row] = await rpcRows(c.env, 'zerox_offer_upsert', { p_offer: { ...body, id }, p_actor: await actorOf(c) });
    resetOfferCache(c.env);
    await loadOffers(c.env);
    return c.json({ offer: publicOffer(c.env, row) });
  }));

  api.post('/admin/offers/:id/transition', operatorOnly(async c => {
    const id = offerIdParam(c);
    requireDatabase(c.env);
    const body = await readJson(c);
    const to = typeof body.to === 'string' ? body.to : '';
    if (!Object.hasOwn(TRANSITIONS, to)) throw new ApiError(400, 'invalid_request', 'to must be a lifecycle state.', { param: 'to' });
    const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 2000) : null;
    const [row] = await rpcRows(c.env, 'zerox_offer_transition', { p_id: id, p_to: to, p_actor: await actorOf(c), p_note: note });
    resetOfferCache(c.env);
    await loadOffers(c.env);
    return c.json({ offer: publicOffer(c.env, row) });
  }));

  // The stored signed manifest, or the current one unsigned when it has not been signed since
  // the facts last changed.
  api.get('/admin/offers/:id/manifest', operatorOnly(async c => {
    const id = offerIdParam(c);
    await Promise.all([loadOffers(c.env), loadCatalogDbModels(c.env)]);
    const offer = offerById(c.env, id);
    if (!offer) throw new ApiError(404, 'not_found', 'No offer with this id.');
    if (offer.manifest) return c.json({ signed: true, manifest: offer.manifest });
    return c.json({ signed: false, manifest: buildManifest(offer, offerEntries(c.env, id)) });
  }));

  // Builds, signs (OIOP_SIGNING_JWK) and stores the manifest of the offer's current version.
  api.post('/admin/offers/:id/manifest', operatorOnly(async c => {
    const id = offerIdParam(c);
    requireDatabase(c.env);
    const jwk = signingJwk(c.env);
    if (!jwk) {
      throw new ApiError(503, 'signing_not_configured',
        'Set the Worker secret OIOP_SIGNING_JWK (node scripts/oiop-keygen.mjs) to sign manifests.');
    }
    resetOfferCache(c.env);
    await Promise.all([loadOffers(c.env), loadCatalogDbModels(c.env)]);
    const offer = offerById(c.env, id);
    if (!offer) throw new ApiError(404, 'not_found', 'No offer with this id.');
    const manifest = await signManifest(buildManifest(offer, offerEntries(c.env, id)), jwk);
    await rpcRows(c.env, 'zerox_offer_store_manifest', { p_id: id, p_version: manifest.version, p_manifest: manifest,
      p_signature: manifest.signature.value, p_actor: await actorOf(c) });
    resetOfferCache(c.env);
    return c.json({ signed: true, manifest });
  }));
}

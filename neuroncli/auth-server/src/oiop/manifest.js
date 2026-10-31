// OIOP offer manifest v0.1 (docs/OIOP.md): the JSON Schema, a validator with no dependencies,
// canonical JSON and Ed25519 signatures (WebCrypto, so the same code runs in the Worker and in
// Node). A manifest describes one offer: who serves it, how it is reached, what it costs to get
// (prerequisites), its limits, its terms with their evidence, its trust tier and its models.
// The signature covers the canonical JSON of the manifest without its `signature` member.
import {
  COMMERCIAL_USE, LIFECYCLES, PROTOCOLS, REDISTRIBUTION, TRAINING, TRUST_TIERS,
} from './offers.js';

export const OIOP_VERSION = '0.1';
export const PREREQUISITE_TYPES = Object.freeze(['account', 'api_key', 'billing', 'card', 'wallet_balance', 'phone',
  'kyc', 'waitlist', 'deployment']);

const HTTPS = '^https://[^\\s]{1,2040}$';
const SLUG = '^[a-z0-9][a-z0-9._-]{0,63}$';
const text = max => ({ type: 'string', minLength: 1, maxLength: max });
const nullable = schema => ({ anyOf: [schema, { type: 'null' }] });
const count = { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }] };
const source = { type: 'object', additionalProperties: false, required: ['url'],
  properties: { url: { type: 'string', pattern: HTTPS }, quote: text(2000) } };

export const MANIFEST_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://zero-x.live/oiop/schema/0.1.json',
  title: 'OIOP offer manifest',
  type: 'object',
  additionalProperties: false,
  required: ['oiop', 'offer_id', 'version', 'issued_at', 'provider', 'endpoint', 'access', 'limits', 'terms', 'trust',
    'models', 'lifecycle'],
  properties: {
    oiop: { const: OIOP_VERSION },
    offer_id: { type: 'string', pattern: SLUG },
    version: { type: 'integer', minimum: 1 },
    issued_at: { type: 'string', format: 'date-time' },
    provider: { type: 'object', additionalProperties: false, required: ['id', 'name'], properties: {
      id: { type: 'string', pattern: SLUG }, name: text(120),
      homepage: nullable({ type: 'string', pattern: HTTPS }), logo: nullable({ type: 'string', pattern: HTTPS }),
    } },
    endpoint: { type: 'object', additionalProperties: false, required: ['protocol', 'auth'], properties: {
      base_url: nullable({ type: 'string', pattern: HTTPS }),
      protocol: { enum: [...PROTOCOLS] },
      auth: { enum: ['bearer', 'binding', 'none'] },
    } },
    access: { type: 'object', additionalProperties: false, required: ['kind', 'owner', 'prerequisites'], properties: {
      kind: { enum: ['hosted', 'self_deploy'] },
      owner: { enum: ['operator', 'user'] },
      prerequisites: { type: 'array', maxItems: 16, items: { type: 'object', additionalProperties: false,
        required: ['type'], properties: {
          type: { enum: [...PREREQUISITE_TYPES] }, detail: text(500), amount: { type: 'number', minimum: 0 },
          currency: { type: 'string', pattern: '^[A-Z]{3}$' }, unlocks: text(500), source,
        } } },
    } },
    limits: { type: 'array', maxItems: 16, items: { type: 'object', additionalProperties: false, required: ['scope'],
      properties: {
        scope: { enum: ['key', 'model', 'account'] }, rpm: count, rpd: count, tpm: count, tpd: count,
        monthly_tokens: count, neurons_per_day: count, reset_tz: text(64),
      } } },
    terms: { type: 'object', additionalProperties: false,
      required: ['redistribution', 'trains_on_inputs', 'commercial_use', 'evidence'], properties: {
        url: nullable({ type: 'string', pattern: HTTPS }),
        sha256: nullable({ type: 'string', pattern: '^[0-9a-f]{64}$' }),
        fetched_at: nullable({ type: 'string', format: 'date-time' }),
        redistribution: { enum: [...REDISTRIBUTION] },
        trains_on_inputs: { enum: [...TRAINING] },
        commercial_use: { enum: [...COMMERCIAL_USE] },
        expires_after_days: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
        evidence: { type: 'array', maxItems: 64, items: { type: 'object', additionalProperties: false,
          required: ['field', 'source'], properties: {
            field: text(64), source: { enum: ['page', 'operator', 'provider'] },
            url: { type: 'string', pattern: HTTPS }, quote: text(2000), note: text(2000),
          } } },
      } },
    trust: { type: 'object', additionalProperties: false, required: ['tier'], properties: {
      tier: { enum: [...TRUST_TIERS] }, verified_by: nullable(text(64)),
      verified_at: nullable({ type: 'string', format: 'date-time' }),
    } },
    models: { type: 'array', maxItems: 500, items: { type: 'object', additionalProperties: false,
      required: ['id', 'upstream', 'verified'], properties: {
        id: text(200), upstream: text(200), base_model: nullable(text(200)),
        verified: { type: 'object', additionalProperties: false, properties: {
          tool_call: { type: 'boolean' }, streaming: { type: 'boolean' }, vision: { type: 'boolean' },
          json_mode: { type: 'boolean' }, context: { type: 'integer', minimum: 1 },
          max_output: { type: 'integer', minimum: 1 },
        } },
      } } },
    lifecycle: { enum: [...LIFECYCLES] },
    signature: { type: 'object', additionalProperties: false, required: ['alg', 'key_id', 'value'], properties: {
      alg: { const: 'Ed25519' }, key_id: { type: 'string', pattern: '^[A-Za-z0-9_-]{16}$' },
      value: { type: 'string', pattern: '^[A-Za-z0-9_-]{86}$' },
    } },
  },
});

// The facts an operator may set on an offer (PUT /admin/offers/:id, zerox_offer_upsert). The
// lifecycle moves only through transitions; manifest fields only through signing.
const manifestProps = MANIFEST_SCHEMA.properties;
export const OFFER_FACTS_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    provider: manifestProps.provider.properties.id,
    name: manifestProps.provider.properties.name,
    homepage: manifestProps.provider.properties.homepage,
    logo_url: manifestProps.provider.properties.logo,
    base_url: manifestProps.endpoint.properties.base_url,
    protocol: manifestProps.endpoint.properties.protocol,
    access_kind: manifestProps.access.properties.kind,
    owner: manifestProps.access.properties.owner,
    trust_tier: manifestProps.trust.properties.tier,
    redistribution: manifestProps.terms.properties.redistribution,
    trains_on_inputs: manifestProps.terms.properties.trains_on_inputs,
    commercial_use: manifestProps.terms.properties.commercial_use,
    expires_after_days: manifestProps.terms.properties.expires_after_days,
    terms_url: manifestProps.terms.properties.url,
    terms_sha256: manifestProps.terms.properties.sha256,
    terms_fetched_at: manifestProps.terms.properties.fetched_at,
    prerequisites: manifestProps.access.properties.prerequisites,
    limits: manifestProps.limits,
    evidence: manifestProps.terms.properties.evidence,
    notes: nullable(text(4000)),
    // Only when the offer is created: discovered (default), analysed or pending_approval.
    lifecycle: { enum: ['discovered', 'analysed', 'pending_approval'] },
  },
});

// ── Validation (the subset of JSON Schema the schemas here use) ──

const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function typeOk(type, value) {
  if (type === 'integer') return Number.isSafeInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  return typeof value === type;
}

function check(schema, value, path, errors) {
  if (schema.anyOf) {
    if (!schema.anyOf.some(option => { const found = []; check(option, value, path, found); return !found.length; })) {
      errors.push(`${path}: does not match any allowed form`);
    }
    return;
  }
  if ('const' in schema && value !== schema.const) { errors.push(`${path}: must be ${JSON.stringify(schema.const)}`); return; }
  if (schema.enum && !schema.enum.includes(value)) { errors.push(`${path}: must be one of ${schema.enum.join(', ')}`); return; }
  if (schema.type && !typeOk(schema.type, value)) { errors.push(`${path}: must be ${schema.type}`); return; }
  if (typeof value === 'string') {
    if (schema.minLength && value.length < schema.minLength) errors.push(`${path}: is empty`);
    if (schema.maxLength && value.length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: has an invalid format`);
    if (schema.format === 'date-time' && !(DATE_TIME.test(value) && Number.isFinite(Date.parse(value)))) {
      errors.push(`${path}: must be an RFC 3339 date-time`);
    }
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`${path}: below ${schema.minimum}`);
  }
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, index) => check(schema.items, item, `${path}[${index}]`, errors));
  }
  if (typeOk('object', value) && schema.properties) {
    for (const key of schema.required || []) if (!(key in value)) errors.push(`${path}.${key}: is required`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties[key]) check(schema.properties[key], item, `${path}.${key}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}: is not allowed`);
    }
  }
}

// The problems with a manifest (empty when it is valid).
export function validateManifest(manifest, schema = MANIFEST_SCHEMA) {
  const errors = [];
  check(schema, manifest, '$', errors);
  return errors;
}

// ── Canonical JSON ──

// RFC 8785 (JCS) style: object members sorted by key (UTF-16 code units), no whitespace, numbers
// and strings as JSON.stringify writes them. Undefined members are dropped; non-finite numbers,
// functions and other non-JSON values throw.
export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item === undefined ? null : item)).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter(key => value[key] !== undefined).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new TypeError(`canonicalJson: unsupported ${typeof value}`);
}

// ── Building ──

const iso = value => (value ? new Date(value).toISOString() : null);
const pick = (object, keys) => Object.fromEntries(keys.filter(key => object?.[key] !== undefined && object?.[key] !== null)
  .map(key => [key, object[key]]));

// The manifest of an offer row (zerox_offers or BUILTIN_OFFERS) and the catalog entries it
// serves (src/catalog.js shape). `models` facts are the catalog's verified flags.
export function buildManifest(offer, entries = [], { now = Date.now() } = {}) {
  return {
    oiop: OIOP_VERSION,
    offer_id: offer.id,
    version: offer.manifest_version || 1,
    issued_at: new Date(now).toISOString(),
    provider: { id: offer.provider, name: offer.name, homepage: offer.homepage ?? null, logo: offer.logo_url ?? null },
    endpoint: {
      base_url: offer.base_url ?? null, protocol: offer.protocol,
      auth: offer.protocol === 'workers-ai' ? 'binding' : 'bearer',
    },
    access: {
      kind: offer.access_kind, owner: offer.owner,
      prerequisites: (offer.prerequisites || []).map(item => pick(item, ['type', 'detail', 'amount', 'currency', 'unlocks', 'source'])),
    },
    limits: (offer.limits || []).map(item => pick(item, ['scope', 'rpm', 'rpd', 'tpm', 'tpd', 'monthly_tokens', 'neurons_per_day', 'reset_tz'])),
    terms: {
      url: offer.terms_url ?? null, sha256: offer.terms_sha256 ?? null, fetched_at: iso(offer.terms_fetched_at),
      redistribution: offer.redistribution, trains_on_inputs: offer.trains_on_inputs, commercial_use: offer.commercial_use,
      expires_after_days: offer.expires_after_days ?? null,
      evidence: (offer.evidence || []).map(item => pick(item, ['field', 'source', 'url', 'quote', 'note'])),
    },
    trust: { tier: offer.trust_tier, verified_by: offer.verified_by ?? null, verified_at: iso(offer.verified_at) },
    models: entries.map(entry => ({
      id: entry.id, upstream: entry.upstream_model, base_model: entry.base_model ?? null,
      verified: {
        tool_call: entry.supports_tools === true, streaming: entry.supports_streaming === true,
        vision: entry.supports_vision === true, context: entry.context_window, max_output: entry.max_output_tokens,
      },
    })),
    lifecycle: offer.lifecycle,
  };
}

// ── Ed25519 signatures ──

const ED25519 = { name: 'Ed25519' };
const toBase64Url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromBase64Url = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), ch => ch.charCodeAt(0));
const signedBytes = manifest => {
  const { signature: _signature, ...body } = manifest;
  return new TextEncoder().encode(canonicalJson(body));
};

// The key id: the first 16 characters of base64url(SHA-256(raw public key)).
export async function keyId(publicJwk) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', fromBase64Url(publicJwk.x)));
  return toBase64Url(digest).slice(0, 16);
}

// The registry signing key: OIOP_SIGNING_JWK, an Ed25519 private JWK ({kty:'OKP', crv:'Ed25519',
// d, x}; scripts/oiop-keygen.mjs makes one). Null when unset or not such a key.
export function signingJwk(env) {
  try {
    const jwk = JSON.parse(env?.OIOP_SIGNING_JWK || 'null');
    return jwk?.kty === 'OKP' && jwk.crv === 'Ed25519' && typeof jwk.d === 'string' && typeof jwk.x === 'string' ? jwk : null;
  } catch {
    return null;
  }
}

export function publicJwkOf(jwk) {
  return { kty: 'OKP', crv: 'Ed25519', x: jwk.x };
}

// Returns a copy of the manifest with `signature` set. Throws when the manifest is invalid.
export async function signManifest(manifest, privateJwk) {
  const { signature: _old, ...body } = manifest;
  const errors = validateManifest(body);
  if (errors.length) throw new TypeError(`Invalid manifest: ${errors.slice(0, 5).join('; ')}`);
  const key = await crypto.subtle.importKey('jwk', { ...privateJwk, key_ops: ['sign'], ext: true }, ED25519, false, ['sign']);
  const value = new Uint8Array(await crypto.subtle.sign(ED25519, key, signedBytes(body)));
  return { ...body, signature: { alg: 'Ed25519', key_id: await keyId(privateJwk), value: toBase64Url(value) } };
}

// True when the manifest is valid and signed by the key `publicJwk`.
export async function verifyManifest(manifest, publicJwk) {
  if (validateManifest(manifest).length || !manifest.signature) return false;
  if (manifest.signature.key_id !== await keyId(publicJwk)) return false;
  try {
    const key = await crypto.subtle.importKey('jwk', publicJwkOf(publicJwk), ED25519, false, ['verify']);
    return await crypto.subtle.verify(ED25519, key, fromBase64Url(manifest.signature.value), signedBytes(manifest));
  } catch {
    return false;
  }
}

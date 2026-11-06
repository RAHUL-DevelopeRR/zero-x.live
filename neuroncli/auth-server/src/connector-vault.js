/**
 * Envelope encryption for hosted connector tokens (migration 20261105000100_connector_accounts.sql,
 * docs/PLATFORM_CONTRACT.md section 18.4).
 *
 * zerox_connector_accounts.enc_refresh_token holds JSON text:
 *   {"v":1,"dek":<b64>,"dek_iv":<b64>,"iv":<b64>,"ct":<b64>}
 * The vendor token bundle ({refresh_token, access_token, expires_at, token_type}) is sealed with
 * AES-256-GCM under a random 32-byte data key made for this row; the data key is sealed under the
 * gateway secret CONNECTOR_TOKENS_KEK (32 random bytes, base64; a different secret from the
 * provider key vault's PROVIDER_KEYS_KEK). Both seals carry
 * `zerox_connector_accounts:v1:<row id>:<user id>:<connector>` as additional data, so a value
 * copied to another row, user or connector does not open. The base64 helpers are the provider key
 * vault's (src/provider-keys.js).
 *
 * Plaintext tokens exist only in memory while a request is proxied: no endpoint returns them,
 * nothing logs them, and errors from this module never include them.
 */
import { base64ToBytes, bytesToBase64 } from './provider-keys.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function kekBytes(env) {
  const raw = typeof env?.CONNECTOR_TOKENS_KEK === 'string' ? env.CONNECTOR_TOKENS_KEK : '';
  const bytes = raw ? base64ToBytes(raw) : null;
  return bytes?.length === 32 ? bytes : null;
}

export function connectorKekConfigured(env) {
  return kekBytes(env) !== null;
}

const kekCache = new WeakMap(); // env -> { raw, key: Promise<CryptoKey> }
function importKek(env) {
  const bytes = kekBytes(env);
  if (!bytes) throw new Error('CONNECTOR_TOKENS_KEK must be 32 bytes of base64');
  let cached = kekCache.get(env);
  if (!cached || cached.raw !== env.CONNECTOR_TOKENS_KEK) {
    cached = { raw: env.CONNECTOR_TOKENS_KEK,
      key: crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']) };
    kekCache.set(env, cached);
  }
  return cached.key;
}

const additionalData = ({ id, userId, connector }) =>
  encoder.encode(`zerox_connector_accounts:v1:${id}:${userId}:${connector}`);

async function seal(key, plain, aad) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, plain);
  return { iv: bytesToBase64(iv), ct: bytesToBase64(new Uint8Array(sealed)) };
}

async function open(key, iv, ct, aad) {
  const nonce = base64ToBytes(iv);
  const sealed = base64ToBytes(ct);
  if (nonce?.length !== 12 || !sealed) throw new Error('Malformed connector token envelope');
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, key, sealed));
}

// Only these fields of a token bundle are kept.
function cleanBundle(bundle) {
  const out = {};
  for (const name of ['access_token', 'refresh_token', 'token_type']) {
    if (typeof bundle?.[name] === 'string' && bundle[name]) out[name] = bundle[name];
  }
  if (Number.isSafeInteger(bundle?.expires_at) && bundle.expires_at > 0) out.expires_at = bundle.expires_at;
  return out;
}

// Seals a token bundle for one row; returns the enc_refresh_token text.
export async function sealConnectorTokens(env, { id, userId, connector }, bundle) {
  const clean = cleanBundle(bundle);
  if (!clean.access_token && !clean.refresh_token) throw new Error('A connector token bundle needs a token');
  const aad = additionalData({ id, userId, connector });
  const dek = crypto.getRandomValues(new Uint8Array(32));
  try {
    const dataKey = await crypto.subtle.importKey('raw', dek, 'AES-GCM', false, ['encrypt']);
    const body = await seal(dataKey, encoder.encode(JSON.stringify(clean)), aad);
    const wrapped = await seal(await importKek(env), dek, aad);
    return JSON.stringify({ v: 1, dek: wrapped.ct, dek_iv: wrapped.iv, iv: body.iv, ct: body.ct });
  } finally {
    dek.fill(0);
  }
}

// Opens a row's enc_refresh_token. Throws (without any token text) when the KEK, the row id, the
// user or the connector differ from sealing, or the value was altered.
export async function openConnectorTokens(env, { id, userId, connector }, enc) {
  let envelope;
  try { envelope = JSON.parse(enc); } catch { throw new Error('Malformed connector token envelope'); }
  if (envelope?.v !== 1) throw new Error('Unknown connector token envelope version');
  const aad = additionalData({ id, userId, connector });
  const dek = await open(await importKek(env), envelope.dek_iv, envelope.dek, aad);
  try {
    if (dek.length !== 32) throw new Error('Malformed connector token envelope');
    const dataKey = await crypto.subtle.importKey('raw', dek, 'AES-GCM', false, ['decrypt']);
    const plain = await open(dataKey, envelope.iv, envelope.ct, aad);
    return cleanBundle(JSON.parse(decoder.decode(plain)));
  } finally {
    dek.fill(0);
  }
}

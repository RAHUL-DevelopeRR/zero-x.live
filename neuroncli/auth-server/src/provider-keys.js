/**
 * Provider key vault (docs/PLATFORM_CONTRACT.md section 11.1,
 * migrations/20261029000200_provider_keys.sql).
 *
 * The operator adds free-tier provider API keys on https://dashboard.zero-x.live/admin/keys
 * (src/routes/provider-keys.js). Postgres holds only AES-256-GCM ciphertext under the Worker
 * secret PROVIDER_KEYS_KEK (32 random bytes, base64), with `zerox_provider_keys:v1:<id>:<provider>`
 * as additional data, so a ciphertext moved to another row or provider does not open. Each
 * isolate decrypts the active keys at most once a minute; src/catalog.js turns every key into its
 * own free pool. Plaintext lives only in isolate memory: no endpoint returns it, and pools carry
 * it in a WeakMap rather than a property, so serializing a pool can never include it.
 */
import { databaseConfigured, rpc, rpcRows } from './account-store.js';

export const VAULT_PROVIDERS = Object.freeze(['groq', 'gemini', 'nvidia', 'openrouter']);
export const MAX_ACTIVE_KEYS = 20; // per provider, enforced by zerox_provider_key_add
const VAULT_TTL_MS = 60_000;
const VAULT_RETRY_MS = 10_000;
// After this long without a successful load the previous keys stop serving: a key disabled while
// the database was unreachable must not stay in use indefinitely.
const VAULT_STALE_MS = 600_000;
const LOAD_WAIT_MS = 3_000;
const TOUCH_INTERVAL_MS = 600_000;
const EMPTY = Object.freeze([]);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Standard or URL-safe base64 to bytes; null when the text is not base64.
export function base64ToBytes(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.replace(/=+$/, '').length % 4 === 1) return null;
  try {
    const binary = atob(text.padEnd(Math.ceil(text.length / 4) * 4, '='));
    return Uint8Array.from(binary, char => char.charCodeAt(0));
  } catch {
    return null;
  }
}

export function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function kekBytes(env) {
  const raw = typeof env?.PROVIDER_KEYS_KEK === 'string' ? env.PROVIDER_KEYS_KEK : '';
  const bytes = raw ? base64ToBytes(raw) : null;
  return bytes?.length === 32 ? bytes : null;
}

export function kekConfigured(env) {
  return kekBytes(env) !== null;
}

// The vault needs the account database and a valid key-encryption key.
export function vaultConfigured(env) {
  return Boolean(env) && databaseConfigured(env) && kekConfigured(env);
}

const kekCache = new WeakMap(); // env -> { raw, key: Promise<CryptoKey> }
function importKek(env) {
  const bytes = kekBytes(env);
  if (!bytes) throw new Error('PROVIDER_KEYS_KEK must be 32 bytes of base64');
  let cached = kekCache.get(env);
  if (!cached || cached.raw !== env.PROVIDER_KEYS_KEK) {
    cached = { raw: env.PROVIDER_KEYS_KEK,
      key: crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']) };
    kekCache.set(env, cached);
  }
  return cached.key;
}

const additionalData = (id, provider) => encoder.encode(`zerox_provider_keys:v1:${id}:${provider}`);

export async function sealProviderKey(env, { id, provider, secret }) {
  const key = await importKek(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: additionalData(id, provider) },
    key, encoder.encode(secret));
  return { ciphertext: bytesToBase64(new Uint8Array(sealed)), iv: bytesToBase64(iv) };
}

// Throws when the KEK, the row id or the provider differ from sealing, or the row was altered.
export async function openProviderKey(env, { id, provider, ciphertext, iv }) {
  const key = await importKek(env);
  const nonce = base64ToBytes(iv);
  const sealed = base64ToBytes(ciphertext);
  if (nonce?.length !== 12 || !sealed) throw new Error('Malformed provider key ciphertext');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: additionalData(id, provider) },
    key, sealed);
  return decoder.decode(plain);
}

export const lastFour = secret => String(secret).slice(-4);

// ── Active keys per isolate ──

const vaults = new WeakMap(); // env -> { keys, expires, loadedAt, pending, generation }
const SECRETS = new WeakMap(); // key record -> plaintext

// Active keys as last loaded ({id, provider, label, last4}, frozen); empty until loadVaultKeys
// has run in this isolate. The array is replaced, never mutated, so callers may cache on it.
export function vaultKeys(env) {
  return (env && typeof env === 'object' && vaults.get(env)?.keys) || EMPTY;
}

export function vaultKeySecret(key) {
  return (key && typeof key === 'object' && SECRETS.get(key)) || null;
}

async function fetchActiveKeys(env) {
  const rows = await rpcRows(env, 'zerox_provider_keys_active', {});
  const keys = [];
  for (const row of rows) {
    if (!VAULT_PROVIDERS.includes(row?.provider)) continue;
    let secret;
    try {
      secret = await openProviderKey(env, row);
    } catch {
      // A different KEK or an altered row: the key is skipped, never served.
      console.error('Provider key could not be decrypted and is skipped', { id: String(row?.id ?? '').slice(0, 36) });
      continue;
    }
    const key = Object.freeze({ id: String(row.id), provider: row.provider, label: String(row.label ?? ''),
      last4: String(row.last4 ?? '') });
    SECRETS.set(key, secret);
    keys.push(key);
  }
  return Object.freeze(keys);
}

/**
 * Loads the active keys into this isolate (60 s cache, 10 s after a failure) and returns them.
 * Never throws: when the database is unreachable the previous keys keep serving for up to ten
 * minutes. Waits at most `wait` ms; a slower load finishes in the background. `force` starts a
 * fresh load (after the admin API changed the vault).
 */
export async function loadVaultKeys(env, { wait = LOAD_WAIT_MS, force = false } = {}) {
  if (!env || typeof env !== 'object' || !vaultConfigured(env)) return EMPTY;
  let state = vaults.get(env);
  if (!state) vaults.set(env, state = { keys: EMPTY, expires: 0, loadedAt: 0, pending: null, generation: 0 });
  if (!force && state.expires > Date.now()) return state.keys;
  if (force || !state.pending) {
    const generation = ++state.generation;
    state.pending = fetchActiveKeys(env).then(keys => {
      if (generation !== state.generation) return;
      state.keys = keys;
      state.loadedAt = Date.now();
      state.expires = state.loadedAt + VAULT_TTL_MS;
    }, error => {
      if (generation !== state.generation) return;
      state.expires = Date.now() + VAULT_RETRY_MS;
      if (state.keys.length && Date.now() - state.loadedAt > VAULT_STALE_MS) state.keys = EMPTY;
      console.error('Provider key vault unavailable', { name: error?.name, message: error?.message });
    }).finally(() => {
      if (generation === state.generation) state.pending = null;
    });
  }
  const pending = state.pending;
  if (pending) {
    if (wait === Infinity) await pending;
    else {
      let timer;
      await Promise.race([pending, new Promise(resolve => { timer = setTimeout(resolve, wait); })]);
      clearTimeout(timer);
    }
  }
  return state.keys;
}

// ── last_used_at ──

const touched = new Map(); // key id -> last write from this isolate

// Records that a vault key served a request, at most once per key every 10 minutes per isolate.
// Returns the write (never rejects) or null when nothing is written.
export function touchVaultKey(env, keyId, now = Date.now()) {
  if (!keyId || !vaultConfigured(env)) return null;
  if (now - (touched.get(keyId) || 0) < TOUCH_INTERVAL_MS) return null;
  if (!touched.has(keyId) && touched.size >= 1000) touched.delete(touched.keys().next().value);
  touched.set(keyId, now);
  return rpc(env, 'zerox_provider_key_touch', { p_id: keyId }).catch(error => {
    touched.delete(keyId);
    console.warn('Provider key last-used update failed', { message: error?.message });
  });
}

// Test hook: forget loaded keys and last-used writes.
export function resetVaultCache(env) {
  if (env && typeof env === 'object') vaults.delete(env);
  touched.clear();
}

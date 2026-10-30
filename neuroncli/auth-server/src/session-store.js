import { accountRpc, databaseConfigured } from './account-store.js';

const stores = new WeakMap();
const encoder = new TextEncoder();

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
const storageKey = sha256Hex;

// Raw key/value store: Cloudflare KV, or the Postgres store (which hashes keys itself).
export function persistentSessionStore(env) {
  if (env.SESSIONS_KV) return env.SESSIONS_KV;
  return databaseRecordStore(env);
}

// The Postgres store alone (gateway_session_store, TTLs of at most seven days), whether or not
// SESSIONS_KV is bound, for records both runtimes must share (src/oiop/models-dev.js). Null
// without a database.
export function databaseRecordStore(env) {
  if (!databaseConfigured(env)) return null;
  if (!stores.has(env)) stores.set(env, {
    get: async key => (await accountRpc(env, 'zerox_session_get', { p_key: await storageKey(key) }))?.value ?? null,
    put: async (key, value, { expirationTtl }) => accountRpc(env, 'zerox_session_put', {
      p_key: await storageKey(key), p_value: value, p_ttl: expirationTtl,
    }),
    delete: async key => accountRpc(env, 'zerox_session_delete', { p_key: await storageKey(key) }),
    // Rewrites the record only while it still exists (never recreates a deleted session).
    rearm: async (key, value, { expirationTtl }) => (await accountRpc(env, 'zerox_session_rearm', {
      p_key: await storageKey(key), p_value: value, p_ttl: expirationTtl,
    }))?.rearmed === true,
  });
  return stores.get(env);
}

// ── Lifetimes ──
const HOUR = 3600;
const boundedHours = (value, fallback) => {
  const hours = Number.parseInt(value, 10);
  return Number.isSafeInteger(hours) && hours >= 1 && hours <= 8760 ? hours : fallback;
};
// CLI sessions created by this version (stored hashed with an explicit `expires`).
export function sessionTtlSeconds(env) {
  return boundedHours(env.CLI_SESSION_TTL_HOURS, 720) * HOUR;
}
// Sessions created before hashed storage keep their original lifetime.
export function legacySessionTtlSeconds(env) {
  return boundedHours(env.SESSION_TTL_HOURS, 24) * HOUR;
}
export function sessionExpiry(env, session) {
  if (Number.isFinite(session?.expires)) return session.expires;
  return Number(session?.created) + legacySessionTtlSeconds(env) * 1000;
}
// The Postgres store rejects TTLs above seven days; long-lived sessions are re-armed on write.
const DATABASE_TTL_LIMIT = 7 * 24 * HOUR;

// ── Hashed records with a raw-key read fallback for sessions created before hashing ──
// Records are stored under sha256(token). A record found only under its raw key is marked
// legacy (a symbol, so it never serialises) and keeps being written to that key until its
// original lifetime ends; new records are never written under a raw key.
export const LEGACY_RECORD = Symbol('zerox.legacyRecord');
const memory = new Map();

function memoryStore(env) {
  if (env.ALLOW_ANONYMOUS_SESSIONS !== 'true') throw new Error('Session persistence unavailable');
  return {
    get: async key => {
      const entry = memory.get(key);
      if (!entry) return null;
      if (entry.expires <= Date.now()) { memory.delete(key); return null; }
      return entry.value;
    },
    put: async (key, value, { expirationTtl }) => {
      if (memory.size >= 10000) memory.delete(memory.keys().next().value);
      memory.set(key, { value, expires: Date.now() + expirationTtl * 1000 });
    },
    delete: async key => { memory.delete(key); },
    rearm: async (key, value, { expirationTtl }) => {
      const entry = memory.get(key);
      if (!entry || entry.expires <= Date.now()) return false;
      memory.set(key, { value, expires: Date.now() + expirationTtl * 1000 });
      return true;
    },
  };
}
const recordStore = env => persistentSessionStore(env) || memoryStore(env);

export async function readRecord(env, key) {
  const store = recordStore(env);
  const hashed = await store.get(await sha256Hex(key));
  if (hashed) return JSON.parse(hashed);
  const raw = await store.get(key);
  if (!raw) return null;
  const record = JSON.parse(raw);
  if (record && typeof record === 'object') record[LEGACY_RECORD] = true;
  return record;
}

async function recordTarget(env, key, record, ttlSeconds) {
  const limit = env.SESSIONS_KV ? Infinity : DATABASE_TTL_LIMIT;
  return {
    target: record?.[LEGACY_RECORD] ? key : await sha256Hex(key),
    ttl: Math.max(60, Math.min(Math.ceil(ttlSeconds), limit)),
  };
}

export async function writeRecord(env, key, record, ttlSeconds) {
  const { target, ttl } = await recordTarget(env, key, record, ttlSeconds);
  await recordStore(env).put(target, JSON.stringify(record), { expirationTtl: ttl });
}

export async function deleteRecord(env, key) {
  const store = recordStore(env);
  await Promise.all([store.delete(await sha256Hex(key)), store.delete(key)]);
}

// Without SESSIONS_KV the Postgres store caps each write at seven days, while CLI sessions
// last CLI_SESSION_TTL_HOURS (720 h). A session still in use is therefore re-armed (rewritten
// as stored, sealed fields included, with its remaining lifetime) at most once a day when it
// is read; only a session left unused for seven days ends before its expires_at. The rewrite
// is conditional (zerox_session_rearm): a sign-out or revoke-all that deleted the record after
// it was read is never undone.
const REARM_INTERVAL_MS = 24 * HOUR * 1000;
export async function rearmRecord(env, key, record, now = Date.now()) {
  if (env.SESSIONS_KV || !record || typeof record !== 'object') return false;
  const last = Number(record.rearmed_at ?? record.created);
  if (Number.isFinite(last) && now - last < REARM_INTERVAL_MS) return false;
  const remaining = (sessionExpiry(env, record) - now) / 1000;
  if (!(remaining > 60)) return false;
  const rearmed = { ...record, rearmed_at: now };
  const { target, ttl } = await recordTarget(env, key, record, remaining);
  const done = await recordStore(env).rearm(target, JSON.stringify(rearmed), { expirationTtl: ttl });
  if (done) record.rearmed_at = now;
  return done;
}

// Rewrites a session record with a later `expires` (sliding expiry, src/session-activity.js).
// The Postgres store's write is conditional and never recreates a deleted session. KV has no
// conditional write, so the caller must re-check the session index afterwards and delete the
// record when the session was signed out meanwhile. Returns whether the record was written.
export async function extendRecord(env, key, record, now = Date.now()) {
  const remaining = (sessionExpiry(env, record) - now) / 1000;
  if (!(remaining > 60)) return false;
  const { target, ttl } = await recordTarget(env, key, record, remaining);
  const value = JSON.stringify(record);
  if (env.SESSIONS_KV) {
    await env.SESSIONS_KV.put(target, value, { expirationTtl: ttl });
    return true;
  }
  return recordStore(env).rearm(target, value, { expirationTtl: ttl });
}

// Revoke-all only knows token hashes (from the session index).
export async function deleteRecordByHash(env, hash) {
  if (!/^[0-9a-f]{64}$/.test(hash)) return;
  await recordStore(env).delete(hash);
}

// ── Owned provider keys are sealed with AES-256-GCM when SESSION_ENCRYPTION_KEY is set ──
const SEALED_FIELDS = ['openrouter_key'];
const keyCache = new Map();
let plaintextWarningShown = false;

const toBase64Url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromBase64Url = text => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));

async function encryptionKey(env) {
  const secret = typeof env.SESSION_ENCRYPTION_KEY === 'string' ? env.SESSION_ENCRYPTION_KEY.trim() : '';
  if (secret.length < 32) return null;
  if (!keyCache.has(secret)) {
    // The secret is high-entropy (openssl rand -base64 32); SHA-256 maps it to an AES-256 key.
    const material = await crypto.subtle.digest('SHA-256', encoder.encode(secret));
    keyCache.set(secret, crypto.subtle.importKey('raw', material, 'AES-GCM', false, ['encrypt', 'decrypt']));
  }
  return keyCache.get(secret);
}

export function sessionEncryptionConfigured(env) {
  return typeof env.SESSION_ENCRYPTION_KEY === 'string' && env.SESSION_ENCRYPTION_KEY.trim().length >= 32;
}

// Returns a copy safe to persist. The ciphertext is bound to the token hash so it cannot be
// replayed into another session record.
export async function sealSession(env, token, session) {
  const fields = SEALED_FIELDS.filter(field => typeof session?.[field] === 'string' && session[field]);
  if (!fields.length) return session;
  const key = await encryptionKey(env);
  if (!key) {
    if (!plaintextWarningShown) {
      plaintextWarningShown = true;
      console.warn('SESSION_ENCRYPTION_KEY is not set; owned provider keys are stored without encryption');
    }
    return session;
  }
  const sealed = { ...session };
  const additionalData = encoder.encode(await sha256Hex(token));
  for (const field of fields) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData }, key, encoder.encode(session[field])));
    sealed[`${field}_enc`] = `v1.${toBase64Url(iv)}.${toBase64Url(ciphertext)}`;
    delete sealed[field];
  }
  return sealed;
}

// Returns the session with sealed fields decrypted. Undecryptable fields (rotated key,
// tampering) are dropped, which leaves the session without its owned key.
export async function openSession(env, token, stored) {
  if (!stored || typeof stored !== 'object') return stored;
  const fields = SEALED_FIELDS.filter(field => typeof stored[`${field}_enc`] === 'string');
  if (!fields.length) return stored;
  const session = { ...stored };
  const key = await encryptionKey(env);
  const additionalData = encoder.encode(await sha256Hex(token));
  for (const field of fields) {
    const sealed = session[`${field}_enc`];
    delete session[`${field}_enc`];
    if (!key) continue;
    try {
      const [version, iv, ciphertext] = sealed.split('.');
      if (version !== 'v1') continue;
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64Url(iv), additionalData }, key, fromBase64Url(ciphertext));
      session[field] = new TextDecoder().decode(plain);
    } catch {
      console.warn('Sealed session field could not be decrypted', { field });
    }
  }
  return session;
}

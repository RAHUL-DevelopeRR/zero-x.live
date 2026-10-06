import { accountRpc, databaseConfigured } from './account-store.js';

const stores = new WeakMap();
async function storageKey(key) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function persistentSessionStore(env) {
  if (env.SESSIONS_KV) return env.SESSIONS_KV;
  if (!databaseConfigured(env)) return null;
  if (!stores.has(env)) stores.set(env, {
    get: async key => (await accountRpc(env, 'zerox_session_get', { p_key: await storageKey(key) }))?.value ?? null,
    put: async (key, value, { expirationTtl }) => accountRpc(env, 'zerox_session_put', {
      p_key: await storageKey(key), p_value: value, p_ttl: expirationTtl,
    }),
    delete: async key => accountRpc(env, 'zerox_session_delete', { p_key: await storageKey(key) }),
  });
  return stores.get(env);
}

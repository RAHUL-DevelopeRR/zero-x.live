import { databaseConfigured, rpc, rpcRows } from '../account-store.js';
import { ApiError, INTERACTIVE_CREDENTIALS, withCaller } from '../auth-context.js';
import { deleteRecordByHash, sha256Hex } from '../session-store.js';

// Records a CLI session in the per-user index so revoke-all can reach it. Tried twice; false
// means the session is not indexed and must not be handed out (the caller deletes it).
export async function registerSessionIndex(env, userId, token, expiresAt, { attempts = 2 } = {}) {
  const args = { p_user_id: userId, p_token_hash: await sha256Hex(token), p_expires_at: new Date(expiresAt).toISOString() };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await rpc(env, 'zerox_session_index_add', args);
      return true;
    } catch (error) {
      console.warn('Session index write failed', { attempt, message: error?.message });
    }
  }
  return false;
}

const tokenHash = row => row?.token_hash ?? row?.p_token_hash ?? row?.hash;
const validHashes = rows => rows.map(tokenHash).filter(hash => typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash));

// Deletes every indexed CLI session record for the user and clears the index. The index is
// listed first (so records go before their index rows), then zerox_session_index_revoke_all
// removes the rows and returns their hashes; records of sessions indexed in between are
// deleted too. Returns the number of distinct sessions revoked.
export async function revokeAllSessions(env, userId) {
  const listed = new Set(validHashes(await rpcRows(env, 'zerox_session_index_list', { p_user_id: userId })));
  await Promise.all([...listed].map(hash => deleteRecordByHash(env, hash)));
  const removed = validHashes(await rpcRows(env, 'zerox_session_index_revoke_all', { p_user_id: userId }));
  const late = removed.filter(hash => !listed.has(hash));
  await Promise.all(late.map(hash => deleteRecordByHash(env, hash)));
  return new Set([...listed, ...removed]).size;
}

// Single sign-out: drops the session's index row (best effort; the record itself is deleted).
export async function unregisterSessionIndex(env, token) {
  if (!databaseConfigured(env)) return;
  try {
    await rpc(env, 'zerox_session_index_remove', { p_token_hash: await sha256Hex(token) });
  } catch (error) {
    console.warn('Session index entry could not be removed', { message: error?.message });
  }
}

// Revokes every active API key of the user (keys outlive sessions, including keys a leaked
// session created). Returns how many were revoked.
export async function revokeAllApiKeys(env, userId) {
  const keys = await rpcRows(env, 'zerox_api_key_list', { p_user_id: userId });
  let revoked = 0;
  for (const key of keys.filter(entry => !entry.revoked_at && entry.id)) {
    const row = await rpc(env, 'zerox_api_key_revoke', { p_user_id: userId, p_key_id: key.id });
    if (row?.revoked === true) revoked++;
  }
  return revoked;
}

// POST /api/sessions/revoke-all {api_keys?: boolean} → {revoked, api_keys_revoked?}
export function registerSessionRoutes(api) {
  api.post('/api/sessions/revoke-all', withCaller(INTERACTIVE_CREDENTIALS, async (c, caller) => {
    const body = await c.req.json().catch(() => ({}));
    const options = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    if (options.api_keys !== undefined && typeof options.api_keys !== 'boolean') {
      throw new ApiError(400, 'invalid_request', '`api_keys` must be a boolean.', { param: 'api_keys' });
    }
    const revoked = await revokeAllSessions(c.env, caller.user_id);
    if (options.api_keys !== true) return c.json({ revoked });
    return c.json({ revoked, api_keys_revoked: await revokeAllApiKeys(c.env, caller.user_id) });
  }));
}

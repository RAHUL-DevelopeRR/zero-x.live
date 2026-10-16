import { databaseConfigured, rpc, rpcRows } from '../account-store.js';
import { INTERACTIVE_CREDENTIALS, withCaller } from '../auth-context.js';
import { deleteRecordByHash, sha256Hex } from '../session-store.js';

// Records a CLI session in the per-user index so it can be revoked with revoke-all.
// Best effort: a missing index must not block sign-in, but it is logged.
export async function registerSessionIndex(env, userId, token, expiresAt) {
  try {
    await rpc(env, 'zerox_session_index_add', {
      p_user_id: userId, p_token_hash: await sha256Hex(token), p_expires_at: new Date(expiresAt).toISOString(),
    });
    return true;
  } catch (error) {
    console.warn('Session index unavailable; revoke-all will not cover this session', { message: error?.message });
    return false;
  }
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

export function registerSessionRoutes(api) {
  api.post('/api/sessions/revoke-all', withCaller(INTERACTIVE_CREDENTIALS, async (c, caller) =>
    c.json({ revoked: await revokeAllSessions(c.env, caller.user_id) })));
}

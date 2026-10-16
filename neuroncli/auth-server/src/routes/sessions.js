import { rpc, rpcRows } from '../account-store.js';
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

// Deletes every indexed CLI session record for the user, then clears the index.
export async function revokeAllSessions(env, userId) {
  const rows = await rpcRows(env, 'zerox_session_index_list', { p_user_id: userId });
  const hashes = [...new Set(rows.map(tokenHash).filter(hash => typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash)))];
  await Promise.all(hashes.map(hash => deleteRecordByHash(env, hash)));
  const result = await rpc(env, 'zerox_session_index_revoke_all', { p_user_id: userId });
  const revoked = Number(result?.revoked);
  return Number.isSafeInteger(revoked) && revoked >= 0 ? revoked : hashes.length;
}

export function registerSessionRoutes(api) {
  api.post('/api/sessions/revoke-all', withCaller(INTERACTIVE_CREDENTIALS, async (c, caller) =>
    c.json({ revoked: await revokeAllSessions(c.env, caller.user_id) })));
}

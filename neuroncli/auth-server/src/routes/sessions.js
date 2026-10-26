import { databaseConfigured, missingFunction, rpc, rpcRows } from '../account-store.js';
import { ApiError, bearerToken, INTERACTIVE_CREDENTIALS, SESSION_TOKEN_PATTERN, withCaller } from '../auth-context.js';
import { deleteRecordByHash, sha256Hex } from '../session-store.js';
import { closeRelaySessions } from './relay.js';

// Device details a client reports at sign-in (display only; never trusted for anything else).
const deviceText = (value, max) => typeof value === 'string'
  ? value.replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim().slice(0, max) || null : null;
export function sessionClient(body = {}) {
  return {
    device_name: deviceText(body.device_name, 128), os: deviceText(body.os, 64),
    client_name: deviceText(body.client_name ?? body.client_id, 64), client_version: deviceText(body.client_version ?? body.version, 64),
  };
}

// Records a CLI session in the per-user index so revoke-all and the linked-devices list can
// reach it, with the device it belongs to (A9). Tried twice; false means the session is not
// indexed and must not be handed out (the caller deletes it).
export async function registerSessionIndex(env, userId, token, expiresAt, { attempts = 2, client = null, deviceGrantId = null } = {}) {
  const args = { p_user_id: userId, p_token_hash: await sha256Hex(token), p_expires_at: new Date(expiresAt).toISOString() };
  let registerExists = true;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      if (registerExists) {
        try {
          await rpc(env, 'zerox_session_register', { ...args, p_client: client, p_device_grant_id: deviceGrantId });
          return true;
        } catch (error) {
          if (!missingFunction(error)) throw error;
          registerExists = false;
        }
      }
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
// removes the rows and returns their hashes, whose records are deleted again: a session whose
// expiry was being extended (A10) may have rewritten its record in between. Returns the number
// of distinct sessions revoked.
export async function revokeAllSessions(env, userId) {
  const listed = new Set(validHashes(await rpcRows(env, 'zerox_session_index_list', { p_user_id: userId })));
  await Promise.all([...listed].map(hash => deleteRecordByHash(env, hash)));
  const removed = validHashes(await rpcRows(env, 'zerox_session_index_revoke_all', { p_user_id: userId }));
  await Promise.all(removed.map(hash => deleteRecordByHash(env, hash)));
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

// ── Linked devices (A9) ──
// A session's public id is derived from its token hash, so the list never exposes the storage key.
export const SESSION_ID_PATTERN = /^[0-9a-f]{24}$/;
export const sessionId = async hash => (await sha256Hex(`zerox-session-id\n${hash}`)).slice(0, 24);
const isoOrNull = value => {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};

async function sessionRows(env, userId) {
  try {
    return await rpcRows(env, 'zerox_session_list', { p_user_id: userId });
  } catch (error) {
    if (!missingFunction(error)) throw error;
    return rpcRows(env, 'zerox_session_index_list', { p_user_id: userId });
  }
}

export async function listSessions(env, userId, currentHash = null) {
  const rows = (await sessionRows(env, userId)).filter(row => /^[0-9a-f]{64}$/.test(String(tokenHash(row))));
  return Promise.all(rows.map(async row => ({
    id: await sessionId(row.token_hash),
    device_name: row.device_name ?? null,
    os: row.device_os ?? null,
    client: { name: row.client_name ?? null, version: row.client_version ?? null },
    created_at: isoOrNull(row.created_at),
    last_used_at: isoOrNull(row.last_used_at),
    expires_at: isoOrNull(row.expires_at),
    current: row.token_hash === currentHash,
  })));
}

// Signs out one of the user's sessions: the index row goes first, then the stored record, so a
// concurrent expiry extension (which re-checks the index after writing) cannot bring it back.
export async function revokeSession(env, userId, id) {
  const rows = (await sessionRows(env, userId)).filter(row => /^[0-9a-f]{64}$/.test(String(tokenHash(row))));
  let hash = null;
  for (const row of rows) if (await sessionId(row.token_hash) === id) { hash = row.token_hash; break; }
  if (!hash) return null;
  try {
    await rpc(env, 'zerox_session_revoke', { p_user_id: userId, p_token_hash: hash });
  } catch (error) {
    if (!missingFunction(error)) throw error;
    await rpc(env, 'zerox_session_index_remove', { p_token_hash: hash });
  }
  await deleteRecordByHash(env, hash);
  return { hash };
}

// POST /api/sessions/revoke-all {api_keys?: boolean} → {revoked, api_keys_revoked?}
// GET /api/sessions → {sessions:[{id, device_name, os, client:{name, version}, created_at,
//   last_used_at, expires_at, current}]}
// DELETE /api/sessions/:id → {status:'revoked', current}; DELETE /api/sessions/current signs out
// the calling Neuron session (the phone app's sign-out).
export function registerSessionRoutes(api) {
  api.post('/api/sessions/revoke-all', withCaller(INTERACTIVE_CREDENTIALS, async (c, caller) => {
    const body = await c.req.json().catch(() => ({}));
    const options = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    if (options.api_keys !== undefined && typeof options.api_keys !== 'boolean') {
      throw new ApiError(400, 'invalid_request', '`api_keys` must be a boolean.', { param: 'api_keys' });
    }
    const revoked = await revokeAllSessions(c.env, caller.user_id);
    await closeRelaySessions(c.env, caller.user_id, 'all');
    if (options.api_keys !== true) return c.json({ revoked });
    return c.json({ revoked, api_keys_revoked: await revokeAllApiKeys(c.env, caller.user_id) });
  }));

  const currentHash = async c => {
    const token = bearerToken(c);
    return SESSION_TOKEN_PATTERN.test(token) ? sha256Hex(token) : null;
  };

  api.get('/api/sessions', withCaller(INTERACTIVE_CREDENTIALS, async (c, caller) =>
    c.json({ sessions: await listSessions(c.env, caller.user_id, await currentHash(c)) })));

  api.delete('/api/sessions/:id', withCaller(INTERACTIVE_CREDENTIALS, async (c, caller) => {
    let id = c.req.param('id');
    if (id === 'current') {
      const hash = await currentHash(c);
      if (!hash) throw new ApiError(400, 'invalid_request', '`current` signs out a Neuron (ses_) session; sign out of the website on the website.', { param: 'id' });
      id = await sessionId(hash);
    }
    if (!SESSION_ID_PATTERN.test(id)) throw new ApiError(400, 'invalid_request', '`id` must be a session id from GET /api/sessions.', { param: 'id' });
    const revoked = await revokeSession(c.env, caller.user_id, id);
    if (!revoked) throw new ApiError(404, 'not_found', 'No such session. It may already be signed out.');
    await closeRelaySessions(c.env, caller.user_id, [id]);
    return c.json({ status: 'revoked', current: revoked.hash === await currentHash(c) });
  }));
}

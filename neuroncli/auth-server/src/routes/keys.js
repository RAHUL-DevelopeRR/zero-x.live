import { rpc, rpcRows } from '../account-store.js';
import { ApiError, INTERACTIVE_CREDENTIALS, withCaller } from '../auth-context.js';
import { sha256Hex } from '../session-store.js';

export const MAX_ACTIVE_KEYS = 10;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const base64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// secret = 'nzx_' + base64url(32 random bytes); prefix = first 8 characters after 'nzx_';
// only sha256(secret) (lowercase hex) is stored.
export async function generateApiKey() {
  const secret = 'nzx_' + base64url(crypto.getRandomValues(new Uint8Array(32)));
  return { secret, prefix: secret.slice(4, 12), hash: await sha256Hex(secret) };
}

const keyView = row => ({
  id: row.id ?? row.key_id,
  name: row.name ?? '',
  prefix: row.prefix ?? '',
  created_at: row.created_at ?? null,
  last_used_at: row.last_used_at ?? null,
  revoked_at: row.revoked_at ?? null,
});

function keyName(body) {
  if (body?.name === undefined || body?.name === null) return 'API key';
  if (typeof body.name !== 'string') throw new ApiError(400, 'invalid_request', '`name` must be a string.', { param: 'name' });
  const name = body.name.replace(/\s+/g, ' ').trim();
  if (!name || name.length > 64 || /[\u0000-\u001f\u007f<>]/.test(name)) {
    throw new ApiError(400, 'invalid_request', '`name` must be 1-64 printable characters without angle brackets.', { param: 'name' });
  }
  return name;
}

const tooManyKeys = () => new ApiError(409, 'too_many_keys',
  `You already have ${MAX_ACTIVE_KEYS} active API keys. Revoke one before creating another.`);
const isTooManyKeys = error => [error?.code, error?.message, error?.details, error?.hint]
  .some(value => typeof value === 'string' && value.includes('too_many_keys'));

export function registerKeyRoutes(api) {
  api.get('/api/keys', withCaller(INTERACTIVE_CREDENTIALS, async (c, caller) => {
    const rows = await rpcRows(c.env, 'zerox_api_key_list', { p_user_id: caller.user_id });
    return c.json({ keys: rows.filter(row => row && (row.id ?? row.key_id)).map(keyView) });
  }));

  api.post('/api/keys', withCaller(INTERACTIVE_CREDENTIALS, async (c, caller) => {
    const body = await c.req.json().catch(() => null);
    if (body !== null && (typeof body !== 'object' || Array.isArray(body))) {
      throw new ApiError(400, 'invalid_request', 'Send a JSON object such as {"name":"CI"}.');
    }
    const name = keyName(body);
    const existing = await rpcRows(c.env, 'zerox_api_key_list', { p_user_id: caller.user_id });
    if (existing.filter(row => row && !row.revoked_at).length >= MAX_ACTIVE_KEYS) throw tooManyKeys();
    const { secret, prefix, hash } = await generateApiKey();
    let row;
    try {
      row = await rpc(c.env, 'zerox_api_key_create', { p_user_id: caller.user_id, p_name: name, p_prefix: prefix, p_hash: hash });
    } catch (error) {
      // The database enforces the limit atomically; the list check above covers the common case.
      if (isTooManyKeys(error)) throw tooManyKeys();
      throw error;
    }
    if (!row) throw new Error('API key was not created');
    c.header('Cache-Control', 'no-store');
    return c.json({ key: { id: row.id ?? row.key_id, name: row.name ?? name, prefix: row.prefix ?? prefix, created_at: row.created_at ?? null }, secret }, 201);
  }));

  api.delete('/api/keys/:id', withCaller(INTERACTIVE_CREDENTIALS, async (c, caller) => {
    const id = c.req.param('id');
    if (!UUID_PATTERN.test(id)) throw new ApiError(400, 'invalid_request', 'Unknown API key id.', { param: 'id' });
    const result = await rpc(c.env, 'zerox_api_key_revoke', { p_user_id: caller.user_id, p_key_id: id.toLowerCase() });
    if (result?.revoked !== true) throw new ApiError(404, 'not_found', 'No active API key with this id exists on your account.');
    return c.json({ status: 'revoked' });
  }));
}

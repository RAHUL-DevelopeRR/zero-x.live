import { rpc, rpcRows } from '../account-store.js';
import { ApiError, INTERACTIVE_CREDENTIALS, withCaller } from '../auth-context.js';
import { EXPO_TOKEN } from '../push.js';

// Phone push tokens (A12, docs/RELAY.md section 5). The token itself is never returned.
//   POST /api/push/tokens {token, platform:'ios'|'android', device_name?, notify?:{needs_input?, finished?}} → 201 {token}
//   GET /api/push/tokens → {tokens:[{id, platform, device_name, notify:{needs_input, finished}, created_at, updated_at, last_sent_at}]}
//   DELETE /api/push/tokens/:id → {status:'deleted'}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = value => {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};
const tokenView = row => ({
  id: row.id, platform: row.platform, device_name: row.device_name ?? null,
  notify: { needs_input: row.notify_needs_input !== false, finished: row.notify_finished !== false },
  created_at: iso(row.created_at), updated_at: iso(row.updated_at), last_sent_at: iso(row.last_sent_at),
});
const invalid = (message, param) => new ApiError(400, 'invalid_request', message, { param });

export function registerPushRoutes(api) {
  api.post('/api/push/tokens', withCaller(INTERACTIVE_CREDENTIALS, async (c, caller) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('Send a JSON object.', null);
    if (typeof body.token !== 'string' || !EXPO_TOKEN.test(body.token)) throw invalid('`token` must be an Expo push token.', 'token');
    if (!['ios', 'android'].includes(body.platform)) throw invalid('`platform` must be ios or android.', 'platform');
    if (body.device_name !== undefined && (typeof body.device_name !== 'string' || body.device_name.length > 128)) {
      throw invalid('`device_name` must be a string of at most 128 characters.', 'device_name');
    }
    const notify = body.notify ?? {};
    if (typeof notify !== 'object' || Array.isArray(notify) || Object.values(notify).some(value => typeof value !== 'boolean')) {
      throw invalid('`notify` must be {needs_input?: boolean, finished?: boolean}.', 'notify');
    }
    const row = await rpc(c.env, 'zerox_push_register', {
      p_user_id: caller.user_id, p_token: body.token, p_platform: body.platform,
      p_device_name: typeof body.device_name === 'string' ? body.device_name.replace(/[\p{Cc}\p{Cf}]/gu, '') : null,
      p_needs_input: notify.needs_input ?? true, p_finished: notify.finished ?? true,
    });
    return c.json({ token: tokenView(row) }, 201);
  }));

  api.get('/api/push/tokens', withCaller(INTERACTIVE_CREDENTIALS, async (c, caller) =>
    c.json({ tokens: (await rpcRows(c.env, 'zerox_push_list', { p_user_id: caller.user_id })).map(tokenView) })));

  api.delete('/api/push/tokens/:id', withCaller(INTERACTIVE_CREDENTIALS, async (c, caller) => {
    const id = c.req.param('id');
    if (!UUID.test(id)) throw invalid('`id` must be a token id from GET /api/push/tokens.', 'id');
    const row = await rpc(c.env, 'zerox_push_delete', { p_user_id: caller.user_id, p_id: id });
    if (row?.deleted !== true) throw new ApiError(404, 'not_found', 'No such push token.');
    return c.json({ status: 'deleted' });
  }));
}

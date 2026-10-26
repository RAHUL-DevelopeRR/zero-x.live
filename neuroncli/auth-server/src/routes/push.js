import { rpc, rpcRows } from '../account-store.js';
import { ApiError, INTERACTIVE_CREDENTIALS, withCaller } from '../auth-context.js';
import { EXPO_TOKEN } from '../push.js';

// Phones' push registrations (A12, docs/RELAY.md section 7), one per account and phone, keyed by
// the phone's relay device id. The Expo token itself is never returned.
//   POST /api/push/devices {device_id, expo_push_token, platform:'ios'|'android', needs_me?, finished?}
//        → {status:'registered'} (registering again replaces the token and the switches)
//   GET /api/push/devices → {devices:[{device_id, platform, needs_me, finished, created_at, updated_at, last_sent_at}]}
//   DELETE /api/push/devices/:device_id → {status:'removed'} (also when there was none)
const DEVICE_ID = /^[A-Za-z0-9_-]{8,64}$/;
const iso = value => {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};
const deviceView = row => ({
  device_id: row.device_id, platform: row.platform,
  needs_me: row.notify_needs_input !== false, finished: row.notify_finished !== false,
  created_at: iso(row.created_at), updated_at: iso(row.updated_at), last_sent_at: iso(row.last_sent_at),
});
const invalid = (message, param) => new ApiError(400, 'invalid_request', message, { param });

export function registerPushRoutes(api) {
  api.post('/api/push/devices', withCaller(INTERACTIVE_CREDENTIALS, async (c, caller) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('Send a JSON object.', null);
    if (typeof body.device_id !== 'string' || !DEVICE_ID.test(body.device_id)) throw invalid('`device_id` must be the phone\'s relay device id.', 'device_id');
    if (typeof body.expo_push_token !== 'string' || !EXPO_TOKEN.test(body.expo_push_token)) throw invalid('`expo_push_token` must be an Expo push token.', 'expo_push_token');
    if (!['ios', 'android'].includes(body.platform)) throw invalid('`platform` must be ios or android.', 'platform');
    for (const name of ['needs_me', 'finished']) {
      if (body[name] !== undefined && typeof body[name] !== 'boolean') throw invalid(`\`${name}\` must be a boolean.`, name);
    }
    await rpc(c.env, 'zerox_push_device_register', {
      p_user_id: caller.user_id, p_device_id: body.device_id, p_token: body.expo_push_token, p_platform: body.platform,
      p_needs_me: body.needs_me ?? true, p_finished: body.finished ?? true,
    });
    return c.json({ status: 'registered' });
  }));

  api.get('/api/push/devices', withCaller(INTERACTIVE_CREDENTIALS, async (c, caller) =>
    c.json({ devices: (await rpcRows(c.env, 'zerox_push_device_list', { p_user_id: caller.user_id })).map(deviceView) })));

  api.delete('/api/push/devices/:device_id', withCaller(INTERACTIVE_CREDENTIALS, async (c, caller) => {
    const deviceId = c.req.param('device_id');
    if (!DEVICE_ID.test(deviceId)) throw invalid('`device_id` must be the phone\'s relay device id.', 'device_id');
    await rpc(c.env, 'zerox_push_device_delete', { p_user_id: caller.user_id, p_device_id: deviceId });
    return c.json({ status: 'removed' });
  }));
}

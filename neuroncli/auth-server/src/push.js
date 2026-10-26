import { rpc, rpcRows } from './account-store.js';

// Push notifications to the Neuron mobile app through Expo's push service (A12, docs/RELAY.md
// section 7). They say only that a session on a computer needs the user or finished; the session
// content stays end-to-end encrypted and never reaches the gateway.
export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
export const EXPO_TOKEN = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{10,200}\]$/;
const MESSAGES_PER_REQUEST = 100;
// The Android notification channel each kind uses (the app creates them).
const CHANNELS = { needs_me: 'needs-me', finished: 'finished' };

export function pushMessage(kind, hostName) {
  const where = String(hostName || 'your computer').slice(0, 64);
  return kind === 'needs_me'
    ? { title: 'Neuron needs you', body: `A session on ${where} is waiting for your answer.` }
    : { title: 'Neuron finished', body: `A session on ${where} finished its turn.` };
}

// Sends `kind` ('needs_me' | 'finished') to the user's phones among `phone_ids` (the relay device
// ids of the phones paired with the computer) that have that switch on. Returns {sent, failed,
// removed}. Tokens Expo reports as DeviceNotRegistered are deleted.
export async function sendPush(env, userId, { kind, host_id: hostId, host_name: hostName, share_id: shareId, phone_ids: phoneIds = [] },
  { fetchImpl = (...args) => fetch(...args) } = {}) {
  if (!CHANNELS[kind] || !phoneIds.length) return { sent: 0, failed: 0, removed: 0 };
  const field = kind === 'needs_me' ? 'notify_needs_input' : 'notify_finished';
  const targets = (await rpcRows(env, 'zerox_push_device_targets', { p_user_id: userId, p_device_ids: phoneIds }))
    .filter(row => row?.[field] === true && EXPO_TOKEN.test(String(row.token)));
  if (!targets.length) return { sent: 0, failed: 0, removed: 0 };
  const { title, body } = pushMessage(kind, hostName);
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
  // Optional: required only when "enhanced push security" is on for the Expo project.
  if (typeof env.EXPO_ACCESS_TOKEN === 'string' && env.EXPO_ACCESS_TOKEN) headers.Authorization = `Bearer ${env.EXPO_ACCESS_TOKEN}`;
  const sent = [];
  const unregistered = [];
  let failed = 0;
  for (let start = 0; start < targets.length; start += MESSAGES_PER_REQUEST) {
    const batch = targets.slice(start, start + MESSAGES_PER_REQUEST);
    const messages = batch.map(row => ({
      to: row.token, title, body, sound: 'default', priority: kind === 'needs_me' ? 'high' : 'default',
      channelId: CHANNELS[kind], data: { neuron: { host_id: hostId ?? null, share_id: shareId ?? null, kind } },
    }));
    let tickets = [];
    try {
      const response = await fetchImpl(EXPO_PUSH_URL, { method: 'POST', headers, body: JSON.stringify(messages), signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error(`Expo push answered ${response.status}`);
      tickets = (await response.json())?.data;
      if (!Array.isArray(tickets)) throw new Error('Expo push returned no tickets');
    } catch (error) {
      failed += batch.length;
      console.warn('Push delivery failed', { count: batch.length, message: String(error?.message).slice(0, 120) });
      continue;
    }
    batch.forEach((row, index) => {
      const ticket = tickets[index];
      if (ticket?.status === 'ok') sent.push(row.id);
      else {
        failed++;
        if (ticket?.details?.error === 'DeviceNotRegistered') unregistered.push(row.token);
      }
    });
  }
  let removed = 0;
  if (sent.length || unregistered.length) {
    removed = Number((await rpc(env, 'zerox_push_delivered', { p_sent: sent, p_unregistered: unregistered }))?.removed) || 0;
  }
  return { sent: sent.length, failed, removed };
}

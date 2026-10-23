import { ApiError, bearerToken, errorResponse, INTERACTIVE_CREDENTIALS, resolveCaller, sendApiError, SESSION_TOKEN_PATTERN, withCaller } from '../auth-context.js';
import { deleteRecord, readRecord, sha256Hex, writeRecord } from '../session-store.js';
import { sessionId } from './sessions.js';

// Relay entry points (A11, docs/RELAY.md). The Worker authenticates, then hands the WebSocket to
// the account's RelayRoom Durable Object (src/relay.js), named after the user id.
//   GET  /relay/v1/host, /relay/v1/client  WebSocket; Authorization: Bearer <ses_ | website token>,
//                                          or ?ticket=rt_… from POST /relay/v1/ticket (browsers)
//   POST /relay/v1/ticket {role}           → {ticket, expires_at} (60 s, single use)
//   GET  /relay/v1/hosts                   → {hosts:[{host_id, name, public_key, online, last_seen_at}]}
// API keys are refused: an nzx_ key must never be able to drive someone's computer.
const TICKET_TTL_SECONDS = 60;
const TICKET_PATTERN = /^rt_[A-Za-z0-9_-]{43}$/;
const INTERNAL = 'https://relay.internal';

const room = (env, userId) => env.RELAY.get(env.RELAY.idFromName(`user:${userId}`));
const relayUnavailable = () => new ApiError(503, 'relay_unavailable', 'Remote control is not available on this server yet.');

function newTicket() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return 'rt_' + btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// The caller's session id (as listed by GET /api/sessions), so revoking it closes its sockets.
async function callerSession(c, caller) {
  const token = bearerToken(c);
  return caller.kind === 'session' && SESSION_TOKEN_PATTERN.test(token) ? sessionId(await sha256Hex(token)) : null;
}

// Closes the relay sockets of revoked sessions: a list of session ids, or 'all' after revoke-all
// (best effort; the sessions themselves are already gone).
export async function closeRelaySessions(env, userId, sessionIds) {
  if (!env?.RELAY || !sessionIds?.length) return;
  const body = sessionIds === 'all' ? { all_sessions: true } : { sessions: sessionIds };
  try {
    await room(env, userId).fetch(`${INTERNAL}/revoke`, { method: 'POST', headers: { 'X-Relay-User': userId }, body: JSON.stringify(body) });
  } catch (error) {
    console.warn('Relay sockets could not be closed', { message: String(error?.message).slice(0, 120) });
  }
}

async function connect(c, role) {
  try {
    if (!c.env?.RELAY) throw relayUnavailable();
    if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
      throw new ApiError(426, 'upgrade_required', 'Connect with a WebSocket.', { headers: { Upgrade: 'websocket' } });
    }
    let userId;
    let session = null;
    const ticket = c.req.query('ticket');
    if (ticket !== undefined) {
      if (!TICKET_PATTERN.test(ticket)) throw new ApiError(401, 'invalid_session', 'This connection ticket is not valid. Request a new one.');
      const record = await readRecord(c.env, `relay-ticket:${ticket}`).catch(() => null);
      if (!record || record.role !== role || !(record.expires > Date.now())) {
        throw new ApiError(401, 'invalid_session', 'This connection ticket expired or is for another role. Request a new one.');
      }
      await deleteRecord(c.env, `relay-ticket:${ticket}`).catch(() => {});
      // KV deletes are not atomic: the account's Durable Object enforces single use.
      const used = await room(c.env, record.user_id).fetch(`${INTERNAL}/ticket`, {
        method: 'POST', headers: { 'X-Relay-User': record.user_id },
        body: JSON.stringify({ hash: await sha256Hex(ticket), expires: record.expires }),
      });
      if ((await used.json())?.ok !== true) throw new ApiError(401, 'invalid_session', 'This connection ticket was already used. Request a new one.');
      userId = record.user_id;
      session = record.session ?? null;
    } else {
      const caller = await resolveCaller(c, { allow: INTERACTIVE_CREDENTIALS });
      userId = caller.user_id;
      session = await callerSession(c, caller);
    }
    const headers = new Headers(c.req.raw.headers);
    headers.delete('Authorization');
    headers.set('X-Relay-Role', role);
    headers.set('X-Relay-User', userId);
    if (session) headers.set('X-Relay-Session', session); else headers.delete('X-Relay-Session');
    return await room(c.env, userId).fetch(new Request(`${INTERNAL}/connect`, { method: 'GET', headers }));
  } catch (error) {
    return sendApiError(c, error);
  }
}

export function registerRelayRoutes(api) {
  api.get('/relay/v1/host', c => connect(c, 'host'));
  api.get('/relay/v1/client', c => connect(c, 'client'));

  api.post('/relay/v1/ticket', withCaller(INTERACTIVE_CREDENTIALS, async (c, caller) => {
    if (!c.env?.RELAY) throw relayUnavailable();
    const body = await c.req.json().catch(() => ({}));
    const role = body?.role ?? 'client';
    if (!['host', 'client'].includes(role)) throw new ApiError(400, 'invalid_request', '`role` must be host or client.', { param: 'role' });
    const ticket = newTicket();
    const expires = Date.now() + TICKET_TTL_SECONDS * 1000;
    await writeRecord(c.env, `relay-ticket:${ticket}`, { user_id: caller.user_id, role, session: await callerSession(c, caller), expires }, TICKET_TTL_SECONDS);
    return c.json({ ticket, role, expires_at: new Date(expires).toISOString() });
  }));

  api.get('/relay/v1/hosts', withCaller(INTERACTIVE_CREDENTIALS, async (c, caller) => {
    if (!c.env?.RELAY) throw relayUnavailable();
    const response = await room(c.env, caller.user_id).fetch(`${INTERNAL}/hosts`, { headers: { 'X-Relay-User': caller.user_id } });
    return c.json(await response.json());
  }));

  api.all('/relay/*', c => errorResponse(c, 404, 'not_found', 'Unknown relay route. See https://zero-x.live/docs/trust for remote control.'));
}

import { ApiError, bearerToken, errorResponse, INTERACTIVE_CREDENTIALS, resolveCaller, sendApiError, SESSION_TOKEN_PATTERN, withCaller } from '../auth-context.js';
import { CLOSE, RELAY_SUBPROTOCOL } from '../relay.js';
import { deleteRecord, readRecord, sha256Hex, writeRecord } from '../session-store.js';
import { sessionId } from './sessions.js';

// Relay entry points (A11, docs/RELAY.md). The Worker authenticates, then hands the WebSocket to
// the account's RelayRoom Durable Object (src/relay.js), named after the user id.
//   GET  /v1/relay                WebSocket (`neuron-relay/1`) on zero-x.live and relay.zero-x.live.
//                                 Credential: the subprotocol `neuron-auth.<ses_ | website token>`
//                                 next to `neuron-relay.v1`, or `Authorization: Bearer …` (native
//                                 clients), or ?ticket=rt_… from POST /relay/v1/ticket.
//   POST /relay/v1/ticket {role}  → {ticket, role, expires_at} (60 s, single use)
//   GET  /relay/v1/hosts          → {hosts:[{host_id, name, online, last_seen_at}]}
// A refused credential still gets the upgrade, then a close code (4401 sign in again, 4403 not
// allowed): a browser can read a close code, while an HTTP 401 looks like a network error to it.
// API keys are refused: an nzx_ key must never be able to drive someone's computer.
export const AUTH_SUBPROTOCOL_PREFIX = 'neuron-auth.';
const TICKET_TTL_SECONDS = 60;
const TICKET_PATTERN = /^rt_[A-Za-z0-9_-]{43}$/;
const INTERNAL = 'https://relay.internal';
const ROLES = { host: 'host', phone: 'phone', client: 'phone' };

const room = (env, userId) => env.RELAY.get(env.RELAY.idFromName(`user:${userId}`));
const relayUnavailable = () => new ApiError(503, 'relay_unavailable', 'Remote control is not available on this server yet.');
const offeredProtocols = c => (c.req.header('Sec-WebSocket-Protocol') || '').split(',').map(part => part.trim()).filter(Boolean);

function newTicket() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return 'rt_' + btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// The caller's session id (as listed by GET /api/sessions), so revoking it closes its sockets.
async function callerSession(token, caller) {
  return caller.kind === 'session' && SESSION_TOKEN_PATTERN.test(token) ? sessionId(await sha256Hex(token)) : null;
}

// Accepts the upgrade and closes it at once with `code`. Without WebSocketPair (the Node server)
// there is no socket to close, and the status says the same.
function refuse(code, reason, offered) {
  if (typeof WebSocketPair !== 'function') {
    const forbidden = code === CLOSE.forbidden;
    return Response.json({ error: { code: forbidden ? 'forbidden' : 'invalid_session', message: reason } }, { status: forbidden ? 403 : 401 });
  }
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  server.close(code, reason);
  return new Response(null, { status: 101, webSocket: client,
    headers: offered.includes(RELAY_SUBPROTOCOL) ? { 'Sec-WebSocket-Protocol': RELAY_SUBPROTOCOL } : {} });
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

// Who is connecting: {userId, session, ticketRole}, or a Response refusing the socket.
async function authenticate(c, offered) {
  const ticket = c.req.query('ticket');
  if (ticket === undefined) {
    const token = bearerToken(c) || offered.find(part => part.startsWith(AUTH_SUBPROTOCOL_PREFIX))?.slice(AUTH_SUBPROTOCOL_PREFIX.length) || '';
    const caller = await resolveCaller(c, { allow: INTERACTIVE_CREDENTIALS, token });
    if (caller.suspended) return refuse(CLOSE.forbidden, 'This account is suspended.', offered);
    return { userId: caller.user_id, session: await callerSession(token, caller), ticketRole: null };
  }
  if (!TICKET_PATTERN.test(ticket)) return refuse(CLOSE.unauthorized, 'This connection ticket is not valid. Request a new one.', offered);
  const record = await readRecord(c.env, `relay-ticket:${ticket}`).catch(() => null);
  if (!record || !ROLES[record.role] || !(record.expires > Date.now())) {
    return refuse(CLOSE.unauthorized, 'This connection ticket expired. Request a new one.', offered);
  }
  await deleteRecord(c.env, `relay-ticket:${ticket}`).catch(() => {});
  // KV deletes are not atomic: the account's Durable Object enforces single use.
  const used = await room(c.env, record.user_id).fetch(`${INTERNAL}/ticket`, {
    method: 'POST', headers: { 'X-Relay-User': record.user_id },
    body: JSON.stringify({ hash: await sha256Hex(ticket), expires: record.expires }),
  });
  if ((await used.json())?.ok !== true) return refuse(CLOSE.unauthorized, 'This connection ticket was already used. Request a new one.', offered);
  return { userId: record.user_id, session: record.session ?? null, ticketRole: ROLES[record.role] };
}

async function connect(c) {
  try {
    if (!c.env?.RELAY) throw relayUnavailable();
    if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
      throw new ApiError(426, 'upgrade_required', 'Connect with a WebSocket.', { headers: { Upgrade: 'websocket' } });
    }
    const offered = offeredProtocols(c);
    let who;
    try {
      who = await authenticate(c, offered);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return refuse(CLOSE.unauthorized, 'Sign in to Zero-X again.', offered);
      if (error instanceof ApiError && error.status === 403) return refuse(CLOSE.forbidden, 'API keys cannot use the relay.', offered);
      // The account database is down: an HTTP error, so the device retries.
      throw error;
    }
    if (who instanceof Response) return who;
    // The credential stays here: the room gets the account, the session id and the subprotocol.
    const headers = new Headers(c.req.raw.headers);
    for (const name of ['Authorization', 'Sec-WebSocket-Protocol', 'X-Relay-User', 'X-Relay-Session', 'X-Relay-Ticket-Role', 'X-Relay-Subprotocol']) headers.delete(name);
    headers.set('X-Relay-User', who.userId);
    if (who.session) headers.set('X-Relay-Session', who.session);
    if (who.ticketRole) headers.set('X-Relay-Ticket-Role', who.ticketRole);
    if (offered.includes(RELAY_SUBPROTOCOL)) headers.set('X-Relay-Subprotocol', RELAY_SUBPROTOCOL);
    return await room(c.env, who.userId).fetch(new Request(`${INTERNAL}/connect`, { method: 'GET', headers }));
  } catch (error) {
    return sendApiError(c, error);
  }
}

export function registerRelayRoutes(api) {
  api.get('/v1/relay', connect);

  api.post('/relay/v1/ticket', withCaller(INTERACTIVE_CREDENTIALS, async (c, caller) => {
    if (!c.env?.RELAY) throw relayUnavailable();
    const body = await c.req.json().catch(() => ({}));
    const role = body?.role ?? 'phone';
    if (!Object.hasOwn(ROLES, role)) throw new ApiError(400, 'invalid_request', '`role` must be host or phone.', { param: 'role' });
    const ticket = newTicket();
    const expires = Date.now() + TICKET_TTL_SECONDS * 1000;
    await writeRecord(c.env, `relay-ticket:${ticket}`, { user_id: caller.user_id, role: ROLES[role], session: await callerSession(bearerToken(c), caller), expires }, TICKET_TTL_SECONDS);
    return c.json({ ticket, role: ROLES[role], expires_at: new Date(expires).toISOString() });
  }));

  api.get('/relay/v1/hosts', withCaller(INTERACTIVE_CREDENTIALS, async (c, caller) => {
    if (!c.env?.RELAY) throw relayUnavailable();
    const response = await room(c.env, caller.user_id).fetch(`${INTERNAL}/hosts`, { headers: { 'X-Relay-User': caller.user_id } });
    return c.json(await response.json());
  }));

  api.all('/relay/*', c => errorResponse(c, 404, 'not_found', 'Unknown relay route. Devices connect to wss://relay.zero-x.live/v1/relay (docs/RELAY.md).'));
}

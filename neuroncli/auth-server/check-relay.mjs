// Relay (A11) and push (A12), offline: the RelayRoom Durable Object with a fake hibernation API,
// the Worker's relay routes with a fake namespace, and push tokens and delivery on PGlite with a
// fake Expo push service (docs/RELAY.md). Run: node check-relay.mjs
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import app from './src/index.js';
import { rpc, rpcRows } from './src/account-store.js';
import { closeAllPglite, getPgliteHandle } from './src/db/pglite.js';
import { devToken } from './src/auth-context.js';
import { CLOSE, LIMITS, NEEDS_INPUT_DELAY_MS, NOTIFY_DEDUPE_MS, RelayRoom } from './src/relay.js';
import { EXPO_PUSH_URL, pushMessage, sendPush } from './src/push.js';
import { sessionId } from './src/routes/sessions.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const passed = [];
const ok = name => { passed.push(name); console.log(`ok - ${name}`); };
const KEY_A = randomBytes(32).toString('base64url');
const KEY_B = randomBytes(32).toString('base64url');
const USER_A = '11111111-1111-4111-8111-111111111111';

// ── Fake Durable Object state with the WebSocket hibernation API ──
function fakeState() {
  const storage = new Map();
  let alarm = null;
  const sockets = [];
  return {
    storage: {
      map: storage,
      get: async key => structuredClone(storage.get(key)),
      put: async (key, value) => { storage.set(key, structuredClone(value)); },
      getAlarm: async () => alarm,
      setAlarm: async at => { alarm = at; },
    },
    get alarm() { return alarm; },
    blockConcurrencyWhile: fn => fn(),
    acceptWebSocket(socket, tags) { socket.tags = tags; sockets.push(socket); },
    getWebSockets(tag) { return sockets.filter(socket => !socket.closed && (!tag || socket.tags.includes(tag))); },
  };
}
function fakeSocket() {
  let attachment = null;
  return {
    sent: [], closed: false, closeCode: null,
    send(message) { if (this.closed) throw new Error('closed'); this.sent.push(typeof message === 'string' ? JSON.parse(message) : message); },
    close(code) { this.closed = true; this.closeCode = code; },
    serializeAttachment(value) { attachment = structuredClone(value); },
    deserializeAttachment() { return structuredClone(attachment); },
    last() { return this.sent.at(-1); },
    take() { const all = this.sent; this.sent = []; return all; },
  };
}
function makeRoom({ now = () => clock.now } = {}) {
  const state = fakeState();
  const pushes = [];
  const room = new RelayRoom(state, {}, {
    now, upgrade: socket => ({ status: 101, webSocket: socket }),
    socketPair: () => { const pair = [fakeSocket(), fakeSocket()]; return { 0: pair[0], 1: pair[1] }; },
    push: async (env, userId, message) => { pushes.push({ userId, ...message }); },
  });
  return { room, state, pushes };
}
const clock = { now: Date.parse('2026-11-02T09:00:00Z') };
const connect = async (room, role, { session = null, user = USER_A } = {}) => {
  const headers = new Headers({ Upgrade: 'websocket', 'X-Relay-Role': role, 'X-Relay-User': user, ...(session ? { 'X-Relay-Session': session } : {}) });
  const response = await room.fetch(new Request('https://relay.internal/connect', { headers }));
  if (response.status !== 101) return { response };
  // The server end is the one the object accepted; the test drives it directly.
  const server = room.state.getWebSockets(role).at(-1);
  return { response, socket: server, welcome: server.last() };
};
const say = (room, socket, frame) => room.webSocketMessage(socket, typeof frame === 'string' ? frame : JSON.stringify(frame));

try {
  // ── 1. Hosts register; clients attach; frames pass through unread ──
  {
    const { room, state } = makeRoom();
    const host = await connect(room, 'host');
    assert.equal(host.welcome.type, 'welcome');
    assert.equal(host.welcome.protocol, 1);
    await say(room, host.socket, { type: 'frame', data: 'x' });
    assert.equal(host.socket.last().code, 'not_registered');
    await say(room, host.socket, { type: 'register', name: 'rahul-laptop\u0007', public_key: 'too-short' });
    assert.equal(host.socket.closeCode, CLOSE.badFrame, 'a malformed key closes the socket');
    const host2 = await connect(room, 'host');
    await say(room, host2.socket, { type: 'register', name: 'rahul-laptop\u0007', public_key: KEY_A });
    const registered = host2.socket.last();
    assert.equal(registered.type, 'registered');
    assert.match(registered.host_id, /^h_[0-9a-f]{16}$/);
    assert.deepEqual(Object.values(state.storage.map.get('hosts')).map(h => [h.name, h.public_key]), [['rahul-laptop', KEY_A]],
      'the registry is the only thing stored');
    assert.equal(state.storage.map.get('user_id'), USER_A);

    const phone = await connect(room, 'client', { session: 'aaaaaaaaaaaaaaaaaaaaaaaa' });
    assert.match(phone.welcome.client_id, /^c_[0-9a-f]{12}$/);
    assert.deepEqual(phone.welcome.hosts.map(h => [h.host_id, h.name, h.online]), [[registered.host_id, 'rahul-laptop', true]]);
    await say(room, phone.socket, { type: 'frame', data: 'x' });
    assert.equal(phone.socket.last().code, 'not_attached');
    await say(room, phone.socket, { type: 'attach', host_id: 'h_0000000000000000' });
    assert.equal(phone.socket.last().code, 'unknown_host');
    await say(room, phone.socket, { type: 'attach', host_id: registered.host_id });
    assert.deepEqual(phone.socket.last(), { type: 'attached', host_id: registered.host_id, online: true, epoch: registered.epoch, seq: 0 });
    assert.deepEqual(host2.socket.last(), { type: 'client', event: 'attached', client_id: phone.welcome.client_id });

    // Ciphertext is forwarded byte for byte; the relay never parses it.
    const ciphertext = randomBytes(600).toString('base64url') + '{"not":"json"';
    await say(room, host2.socket, { type: 'frame', to: '*', data: ciphertext });
    assert.deepEqual(phone.socket.last(), { type: 'frame', from: 'host', host_id: registered.host_id, epoch: registered.epoch, seq: 1, data: ciphertext });
    await say(room, phone.socket, { type: 'frame', data: 'reply-ciphertext' });
    assert.deepEqual(host2.socket.last(), { type: 'frame', from: phone.welcome.client_id, data: 'reply-ciphertext' });
    const tablet = await connect(room, 'client');
    await say(room, tablet.socket, { type: 'attach', host_id: registered.host_id });
    tablet.socket.take();
    await say(room, host2.socket, { type: 'frame', to: phone.welcome.client_id, data: 'just-for-the-phone' });
    assert.equal(phone.socket.last().data, 'just-for-the-phone');
    assert.deepEqual(tablet.socket.take(), [], 'directed frames reach only their client');
    assert.equal(host2.socket.deserializeAttachment().seq, 1, 'directed frames take no seq');
    await say(room, host2.socket, { type: 'frame', to: 'c_bad', data: 'x' });
    assert.equal(host2.socket.last().code, 'bad_frame');
    ok('hosts register (key checked, name cleaned, registry stored), clients attach, ciphertext is forwarded unread, directed and broadcast frames');

    // ── 2. Replay by seq within an epoch ──
    for (let index = 2; index <= 5; index++) await say(room, host2.socket, { type: 'frame', data: `f${index}` });
    const late = await connect(room, 'client');
    await say(room, late.socket, { type: 'attach', host_id: registered.host_id, epoch: registered.epoch, since: 2 });
    assert.deepEqual(late.socket.take().slice(1).filter(f => f.type === 'frame').map(f => [f.seq, f.data]), [[3, 'f3'], [4, 'f4'], [5, 'f5']]);
    await say(room, late.socket, { type: 'attach', host_id: registered.host_id, epoch: 'deadbeefdeadbeef', since: 2 });
    assert.equal(late.socket.last().type, 'replay_gap', 'another epoch means the client needs a snapshot');
    for (let index = 6; index <= LIMITS.replayFrames + 10; index++) {
      clock.now += 100; // 10 frames a second, under the rate limit
      await say(room, host2.socket, { type: 'frame', data: `f${index}` });
    }
    assert.equal(host2.socket.deserializeAttachment().seq, LIMITS.replayFrames + 10);
    await say(room, late.socket, { type: 'attach', host_id: registered.host_id, epoch: registered.epoch, since: 3 });
    assert.equal(late.socket.last().type, 'replay_gap', 'frames older than the buffer are gone');
    late.socket.take();
    await say(room, late.socket, { type: 'attach', host_id: registered.host_id, epoch: registered.epoch, since: LIMITS.replayFrames + 8 });
    assert.deepEqual(late.socket.take().filter(f => f.type === 'frame').map(f => f.seq), [LIMITS.replayFrames + 9, LIMITS.replayFrames + 10]);
    ok(`replay by seq within an epoch, replay_gap for another epoch or frames past the ${LIMITS.replayFrames}-frame buffer`);

    // ── 3. Presence and reconnection ──
    host2.socket.close(1000);
    await room.webSocketClose(host2.socket, 1000, 'bye');
    assert.deepEqual(phone.socket.last(), { type: 'presence', host_id: registered.host_id, online: false });
    assert.equal(room.hostList()[0].online, false);
    const again = await connect(room, 'host');
    await say(room, again.socket, { type: 'register', host_id: registered.host_id, name: 'rahul-laptop', public_key: KEY_B });
    assert.equal(again.socket.last().code, 'key_changed', 'a new key needs a new pairing');
    const back = await connect(room, 'host');
    await say(room, back.socket, { type: 'register', host_id: registered.host_id, name: 'rahul-laptop', public_key: KEY_A });
    assert.equal(back.socket.last().host_id, registered.host_id);
    assert.notEqual(back.socket.last().epoch, registered.epoch, 'a reconnection starts a new epoch');
    assert.deepEqual(back.socket.last().clients.sort(), [phone.welcome.client_id, tablet.welcome.client_id, late.welcome.client_id].sort());
    assert.deepEqual(phone.socket.last(), { type: 'presence', host_id: registered.host_id, online: true, epoch: back.socket.last().epoch });
    const twin = await connect(room, 'host');
    await say(room, twin.socket, { type: 'register', host_id: registered.host_id, name: 'rahul-laptop', public_key: KEY_A });
    assert.equal(back.socket.closeCode, CLOSE.replaced, 'the same computer connecting again replaces the old socket');
    await room.webSocketClose(back.socket, CLOSE.replaced, 'replaced');
    assert.notDeepEqual(phone.socket.last(), { type: 'presence', host_id: registered.host_id, online: false }, 'no offline flicker when replaced');
    const stranger = await connect(room, 'host');
    await say(room, stranger.socket, { type: 'register', host_id: 'h_ffffffffffffffff', name: 'x', public_key: KEY_B });
    assert.equal(stranger.socket.closeCode, CLOSE.unknownHost);
    ok('presence on disconnect and reconnect, new epoch, key change refused, replaced sockets, unknown host ids refused');

    // ── 4. Revocation closes the sockets of signed-out sessions ──
    assert.equal(room.revoke({ sessions: ['bbbbbbbbbbbbbbbbbbbbbbbb'] }), 0);
    assert.equal(room.revoke({ sessions: ['aaaaaaaaaaaaaaaaaaaaaaaa'] }), 1);
    assert.equal(phone.socket.closeCode, CLOSE.revoked);
    assert.equal(phone.socket.last().code, 'session_revoked');
    assert.equal(tablet.socket.closed, false, 'sockets opened with a website token stay open');
    const cli = await connect(room, 'client', { session: 'cccccccccccccccccccccccc' });
    assert.equal(room.revoke({ all_sessions: true }), 1, 'revoke-all closes every CLI-session socket');
    assert.equal(cli.socket.closeCode, CLOSE.revoked);
    assert.equal(tablet.socket.closed, false, 'but not website-token sockets');
    assert.ok(room.revoke({ all: true }) >= 2);
    ok('revoking a session closes its relay sockets (4403); revoke-all closes CLI-session sockets');
  }

  // ── 5. Limits and malformed frames ──
  {
    const { room } = makeRoom();
    for (let index = 0; index < LIMITS.hosts; index++) assert.equal((await connect(room, 'host')).response.status, 101);
    const extraHost = await connect(room, 'host');
    assert.equal(extraHost.response.status, 429);
    for (let index = 0; index < LIMITS.clients; index++) assert.equal((await connect(room, 'client')).response.status, 101);
    assert.equal((await connect(room, 'client')).response.status, 429);
    assert.equal((await room.fetch(new Request('https://relay.internal/connect', { headers: { 'X-Relay-Role': 'client' } }))).status, 426);
    assert.equal((await room.fetch(new Request('https://relay.internal/connect', { headers: { Upgrade: 'websocket', 'X-Relay-Role': 'admin' } }))).status, 400);
    const [client] = room.state.getWebSockets('client');
    await say(room, client, 'not json');
    assert.equal(client.closeCode, CLOSE.badFrame);
    const [, second] = room.state.getWebSockets('client');
    await say(room, second, ['array']);
    assert.equal(second.closeCode, CLOSE.badFrame);
    const [third] = room.state.getWebSockets('client');
    await say(room, third, JSON.stringify({ type: 'frame', data: 'x'.repeat(LIMITS.frameBytes) }));
    assert.equal(third.closeCode, CLOSE.tooLarge);
    const [fourth] = room.state.getWebSockets('client');
    await say(room, fourth, { type: 'ping' });
    assert.deepEqual(fourth.last(), { type: 'pong' });
    let limited = 0;
    for (let index = 0; index < LIMITS.burst + 20; index++) {
      await say(room, fourth, { type: 'detach' });
      if (fourth.last()?.code === 'rate_limited') limited++;
    }
    assert.ok(limited >= 19, 'frames beyond the burst are refused');
    ok(`limits: ${LIMITS.hosts} hosts and ${LIMITS.clients} clients per account (429), 1 MB frames (4413), JSON objects only (4400), rate limit`);
  }

  // ── 6. Push notifications from contentless notify frames ──
  {
    clock.now = Date.parse('2026-11-02T10:00:00Z');
    const { room, state, pushes } = makeRoom();
    const host = await connect(room, 'host');
    await say(room, host.socket, { type: 'register', name: 'studio', public_key: KEY_A });
    const hostId = host.socket.last().host_id;
    await say(room, host.socket, { type: 'notify', kind: 'finished' });
    assert.deepEqual(pushes, [{ userId: USER_A, kind: 'finished', host_id: hostId, host_name: 'studio' }]);
    await say(room, host.socket, { type: 'notify', kind: 'finished' });
    assert.equal(pushes.length, 1, `deduplicated for ${NOTIFY_DEDUPE_MS / 1000} s`);
    await say(room, host.socket, { type: 'notify', kind: 'needs_input' });
    assert.equal(state.alarm, clock.now + NEEDS_INPUT_DELAY_MS, 'needs_input waits 30 s for a client');
    clock.now += 10_000;
    await room.alarm();
    assert.equal(pushes.length, 1);
    clock.now += NEEDS_INPUT_DELAY_MS;
    await room.alarm();
    assert.deepEqual(pushes.at(-1), { userId: USER_A, kind: 'needs_input', host_id: hostId, host_name: 'studio' });
    clock.now += NOTIFY_DEDUPE_MS;
    await say(room, host.socket, { type: 'notify', kind: 'needs_input' });
    await say(room, host.socket, { type: 'notify', kind: 'resolved' });
    clock.now += NEEDS_INPUT_DELAY_MS;
    await room.alarm();
    assert.equal(pushes.length, 2, 'answered on the computer: no push');
    await say(room, host.socket, { type: 'notify', kind: 'needs_input' });
    const phone = await connect(room, 'client');
    await say(room, phone.socket, { type: 'attach', host_id: hostId });
    clock.now += NEEDS_INPUT_DELAY_MS;
    await room.alarm();
    assert.equal(pushes.length, 2, 'a client attached in time: no push');
    clock.now += NOTIFY_DEDUPE_MS;
    await say(room, host.socket, { type: 'notify', kind: 'finished' });
    assert.equal(pushes.length, 2, 'quiet while a client is attached');
    await say(room, host.socket, { type: 'notify', kind: 'shout' });
    assert.equal(host.socket.last().code, 'bad_frame');
    ok('push: finished at once, needs_input after 30 s without a client, deduplicated, cancelled by resolved or an attaching client, quiet while attached');
  }

  // ── 7. Tickets are single use ──
  {
    const { room } = makeRoom();
    const ticket = { hash: sha('rt_x'), expires: clock.now + 60_000 };
    assert.equal(await room.useTicket(ticket), true);
    assert.equal(await room.useTicket(ticket), false);
    assert.equal(await room.useTicket({ hash: sha('rt_y'), expires: clock.now - 1 }), false);
    ok('connection tickets are single use and expire');
  }

  // ── 8. Worker routes: authentication, isolation, tickets, API keys refused ──
  {
    const pgEnv = { DATABASE_DRIVER: 'pglite', DEV_AUTH_ENABLED: 'true', NEURON_RUNTIME: 'node' };
    await getPgliteHandle(pgEnv);
    const records = new Map();
    const kv = { get: async key => records.get(key) ?? null, put: async (key, value) => { records.set(key, value); }, delete: async key => { records.delete(key); } };
    const rooms = new Map();
    const forwarded = [];
    const RELAY = {
      idFromName: name => ({ name }),
      get: id => {
        if (!rooms.has(id.name)) rooms.set(id.name, makeRoom({ now: () => Date.now() }).room);
        const room = rooms.get(id.name);
        return {
          fetch: async (input, init) => {
            const request = input instanceof Request ? input : new Request(input, init);
            if (new URL(request.url).pathname === '/connect') {
              forwarded.push({ name: id.name, headers: Object.fromEntries(request.headers) });
              const result = await room.fetch(request);
              return result.status === 101 ? new Response('upgraded', { status: 200, headers: { 'x-upgraded': 'true' } }) : result;
            }
            return room.fetch(request);
          },
        };
      },
    };
    const env = { ...pgEnv, SESSIONS_KV: kv, RELAY };
    const base = 'http://127.0.0.1:8787';
    const call = async (path, { method = 'GET', token, body, headers = {}, bindings = env } = {}) => app.request(base + path, {
      method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }, bindings);
    const upgrade = { Upgrade: 'websocket' };
    const alice = await (await call('/auth/cli/session', { method: 'POST', token: devToken('alice.relay@example.test'), body: { device_name: 'laptop' } })).json();
    const bob = await (await call('/auth/cli/session', { method: 'POST', token: devToken('bob.relay@example.test'), body: {} })).json();

    assert.equal((await call('/relay/v1/host', { headers: upgrade })).status, 401, 'no credential');
    assert.equal((await call('/relay/v1/host', { token: alice.session_token })).status, 426, 'not a WebSocket');
    let response = await call('/relay/v1/host', { token: alice.session_token, headers: upgrade });
    assert.equal(response.headers.get('x-upgraded'), 'true');
    const aliceRoom = `user:${alice.user_id}`;
    const first = forwarded.at(-1);
    assert.equal(first.name, aliceRoom, "the socket goes to the caller's own room");
    assert.equal(first.headers['x-relay-role'], 'host');
    assert.equal(first.headers['x-relay-user'], alice.user_id);
    assert.equal(first.headers['x-relay-session'], await sessionId(sha(alice.session_token)));
    assert.equal(first.headers.authorization, undefined, 'the credential is not passed on');
    const hostSocket = rooms.get(aliceRoom).state.getWebSockets('host')[0];
    await rooms.get(aliceRoom).webSocketMessage(hostSocket, JSON.stringify({ type: 'register', name: 'laptop', public_key: KEY_A }));
    const aliceHost = hostSocket.last().host_id;

    // Bob's client lands in Bob's room and cannot see or attach to Alice's computer.
    response = await call('/relay/v1/client', { token: bob.session_token, headers: upgrade });
    assert.equal(response.status, 200);
    const bobRoom = rooms.get(`user:${bob.user_id}`);
    const bobClient = bobRoom.state.getWebSockets('client')[0];
    assert.deepEqual(bobClient.last().hosts, [], "another account's computers are invisible");
    await bobRoom.webSocketMessage(bobClient, JSON.stringify({ type: 'attach', host_id: aliceHost }));
    assert.equal(bobClient.last().code, 'unknown_host', 'and cannot be attached to');
    assert.deepEqual((await (await call('/relay/v1/hosts', { token: bob.session_token })).json()).hosts, []);
    const aliceHosts = (await (await call('/relay/v1/hosts', { token: alice.session_token })).json()).hosts;
    assert.deepEqual(aliceHosts.map(h => [h.host_id, h.online]), [[aliceHost, true]]);

    // API keys never reach the relay.
    const key = await (await call('/api/keys', { method: 'POST', token: devToken('alice.relay@example.test'), body: { name: 'ci' } })).json();
    response = await call('/relay/v1/client', { token: key.secret, headers: upgrade });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'api_key_not_allowed');

    // Browsers: a single-use ticket instead of a header.
    const ticket = await (await call('/relay/v1/ticket', { method: 'POST', token: alice.session_token, body: { role: 'client' } })).json();
    assert.match(ticket.ticket, /^rt_[A-Za-z0-9_-]{43}$/);
    assert.equal((await call(`/relay/v1/host?ticket=${ticket.ticket}`, { headers: upgrade })).status, 401, 'a ticket is for one role');
    const ticket2 = await (await call('/relay/v1/ticket', { method: 'POST', token: alice.session_token, body: { role: 'client' } })).json();
    const stash = new Map(records);
    response = await call(`/relay/v1/client?ticket=${ticket2.ticket}`, { headers: upgrade });
    assert.equal(response.headers.get('x-upgraded'), 'true');
    assert.equal(forwarded.at(-1).headers['x-relay-session'], await sessionId(sha(alice.session_token)), 'the ticket keeps the session for revocation');
    for (const [k, v] of stash) records.set(k, v); // replay the deleted KV record: the room still refuses
    assert.equal((await call(`/relay/v1/client?ticket=${ticket2.ticket}`, { headers: upgrade })).status, 401, 'a ticket works once');
    assert.equal((await call('/relay/v1/client?ticket=rt_nope', { headers: upgrade })).status, 401);
    assert.equal((await call('/relay/v1/ticket', { method: 'POST', token: alice.session_token, body: { role: 'admin' } })).status, 400);

    // Signing out a device closes its relay sockets.
    const sessions = (await (await call('/api/sessions', { token: alice.session_token })).json()).sessions;
    const aliceClient = rooms.get(aliceRoom).state.getWebSockets('client')[0];
    response = await call(`/api/sessions/${sessions.find(s => s.current).id}`, { method: 'DELETE', token: devToken('alice.relay@example.test') });
    assert.equal(response.status, 200);
    assert.equal(hostSocket.closeCode, CLOSE.revoked, 'the revoked session’s host socket is closed');
    assert.equal(aliceClient.closeCode, CLOSE.revoked, 'and its ticket-opened client socket');

    // On Cloudflare the upgrade response from the Durable Object has immutable headers: no
    // middleware (security headers, CORS for a browser origin) may touch it.
    const immutableUpgrade = {
      idFromName: name => ({ name }),
      get: () => ({ fetch: async () => {
        const upgraded = new Response(null, { status: 200 });
        Object.defineProperty(upgraded, 'webSocket', { value: {} });
        upgraded.headers.set = () => { throw new TypeError("Can't modify immutable headers."); };
        upgraded.headers.append = upgraded.headers.set;
        upgraded.headers.delete = upgraded.headers.set;
        return upgraded;
      } }),
    };
    response = await call('/relay/v1/client', { token: bob.session_token, headers: { ...upgrade, Origin: 'https://zero-x.live' },
      bindings: { ...env, RELAY: immutableUpgrade } });
    assert.equal(response.status, 200, 'the upgrade passes through untouched');
    assert.ok(response.webSocket, 'with its WebSocket');

    // Without the binding (the Worker as deployed now, the Node server, the API-only Worker)
    // every relay route says so, and signing a device out still works.
    const unbound = { ...env, RELAY: undefined };
    for (const [path, init] of [
      ['/relay/v1/host', { headers: upgrade }], ['/relay/v1/client', { headers: upgrade }],
      ['/relay/v1/ticket', { method: 'POST', body: { role: 'client' } }], ['/relay/v1/hosts', {}],
    ]) {
      response = await call(path, { token: bob.session_token, bindings: unbound, ...init });
      assert.equal(response.status, 503, path);
      assert.equal((await response.json()).error.code, 'relay_unavailable', path);
    }
    const spare = await (await call('/auth/cli/session', { method: 'POST', token: devToken('bob.relay@example.test'), body: {}, bindings: unbound })).json();
    const bobSessions = (await (await call('/api/sessions', { token: spare.session_token, bindings: unbound })).json()).sessions;
    response = await call(`/api/sessions/${bobSessions.find(s => s.current).id}`, { method: 'DELETE', token: devToken('bob.relay@example.test'), bindings: unbound });
    assert.equal(response.status, 200, 'revocation needs no relay');
    assert.equal((await call('/relay/v2/anything')).status, 404);
    ok('Worker: header or single-use ticket auth, API keys refused (403), per-account rooms (another account cannot see or attach), revocation closes sockets, 503 relay_unavailable on every route without the binding');

    // ── 9. Push tokens and delivery ──
    const owner = alice.user_id;
    const token = (n = 'A') => `ExponentPushToken[${n.repeat(22)}]`;
    response = await call('/api/push/tokens', { method: 'POST', token: alice.session_token, body: { token: token('A'), platform: 'ios', device_name: 'iPhone\u0000', notify: { finished: false } } });
    assert.equal(response.status, 401, 'the revoked session can no longer register');
    const fresh = await (await call('/auth/cli/session', { method: 'POST', token: devToken('alice.relay@example.test'), body: {} })).json();
    response = await call('/api/push/tokens', { method: 'POST', token: fresh.session_token, body: { token: token('A'), platform: 'ios', device_name: 'iPhone\u0000', notify: { finished: false } } });
    assert.equal(response.status, 201);
    const registered = (await response.json()).token;
    assert.deepEqual([registered.platform, registered.device_name, registered.notify], ['ios', 'iPhone', { needs_input: true, finished: false }]);
    assert.ok(!('token' in registered), 'the push token is never returned');
    for (const body of [{ token: 'not-a-token', platform: 'ios' }, { token: token('B'), platform: 'web' }, { token: token('B'), platform: 'ios', notify: { finished: 'yes' } }]) {
      assert.equal((await call('/api/push/tokens', { method: 'POST', token: fresh.session_token, body })).status, 400, JSON.stringify(body));
    }
    assert.equal((await call('/api/push/tokens', { method: 'POST', token: key.secret, body: { token: token('B'), platform: 'ios' } })).status, 403);
    await call('/api/push/tokens', { method: 'POST', token: fresh.session_token, body: { token: token('C'), platform: 'android' } });
    const listed = (await (await call('/api/push/tokens', { token: fresh.session_token })).json()).tokens;
    assert.equal(listed.length, 2);
    assert.ok(!JSON.stringify(listed).includes('ExponentPushToken'));

    const sentBatches = [];
    const expo = async (url, init) => {
      assert.equal(url, EXPO_PUSH_URL);
      const messages = JSON.parse(init.body);
      sentBatches.push(messages);
      return Response.json({ data: messages.map(message => message.to === token('C')
        ? { status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered' } } : { status: 'ok', id: 'ticket' }) });
    };
    let result = await sendPush(pgEnv, owner, { kind: 'needs_input', host_id: 'h_1', host_name: 'studio' }, { fetchImpl: expo });
    assert.deepEqual(result, { sent: 1, failed: 1, removed: 1 });
    assert.deepEqual(sentBatches[0].map(message => message.to).sort(), [token('A'), token('C')].sort());
    assert.equal(sentBatches[0][0].body, pushMessage('needs_input', 'studio').body);
    assert.deepEqual(Object.keys(sentBatches[0][0].data).sort(), ['host_id', 'kind'], 'no session content in a push');
    assert.equal((await rpcRows(pgEnv, 'zerox_push_list', { p_user_id: owner })).length, 1, 'unregistered devices are forgotten');
    result = await sendPush(pgEnv, owner, { kind: 'finished', host_id: 'h_1', host_name: 'studio' }, { fetchImpl: expo });
    assert.deepEqual(result, { sent: 0, failed: 0, removed: 0 }, 'the iPhone turned "finished" off');
    result = await sendPush(pgEnv, owner, { kind: 'needs_input' }, { fetchImpl: async () => new Response('down', { status: 503 }) });
    assert.deepEqual(result, { sent: 0, failed: 1, removed: 0 });
    // A phone that signs in to another account moves its token there.
    await call('/api/push/tokens', { method: 'POST', token: bob.session_token, body: { token: token('A'), platform: 'ios' } });
    assert.equal((await rpcRows(pgEnv, 'zerox_push_list', { p_user_id: owner })).length, 0);
    assert.equal((await rpcRows(pgEnv, 'zerox_push_list', { p_user_id: bob.user_id })).length, 1);
    const bobToken = (await (await call('/api/push/tokens', { token: bob.session_token })).json()).tokens[0];
    assert.equal((await call(`/api/push/tokens/${bobToken.id}`, { method: 'DELETE', token: fresh.session_token })).status, 404, "another account's token");
    assert.equal((await call(`/api/push/tokens/${bobToken.id}`, { method: 'DELETE', token: bob.session_token })).status, 200);
    assert.equal((await call('/api/push/tokens/not-a-uuid', { method: 'DELETE', token: bob.session_token })).status, 400);
    for (let index = 0; index < 12; index++) await rpc(pgEnv, 'zerox_push_register', { p_user_id: owner, p_token: token(String.fromCharCode(68 + index)), p_platform: 'android', p_device_name: null });
    assert.equal((await rpcRows(pgEnv, 'zerox_push_list', { p_user_id: owner })).length, 10, 'at most 10 phones per account');
    ok('push tokens: register (token never returned), validation, API keys refused, per-preference delivery, DeviceNotRegistered pruned, tokens move between accounts, 10 per account');
  }

  // ── 10. The Worker is deployed without the RelayRoom (owner decision, 2026-10-30) ──
  // No RELAY binding and no migration that creates the class, so the relay routes answer
  // relay_unavailable (above) until the relay runs on the Node server. Every Durable Object class
  // the Worker exports is bound, and every bound class exported (a binding to a missing export
  // fails the deploy).
  {
    const config = name => readFileSync(new URL(name, import.meta.url), 'utf8').replace(/^\s*#.*$/gm, '');
    for (const name of ['wrangler.toml', 'wrangler.api.toml']) {
      assert.doesNotMatch(config(name), /"RELAY"|RelayRoom|v2-relay/, `${name} binds and creates no RelayRoom`);
    }
    const bound = [...config('wrangler.toml').matchAll(/^\s*class_name\s*=\s*"([^"]+)"/gm)].map(match => match[1]).sort();
    const created = [...config('wrangler.toml').matchAll(/^\s*new_sqlite_classes\s*=\s*\[([^\]]*)\]/gm)]
      .flatMap(match => [...match[1].matchAll(/"([^"]+)"/g)].map(name => name[1])).sort();
    const exported = Object.keys(await import('./src/index.js')).filter(name => name !== 'default').sort();
    assert.deepEqual(bound, ['HealthHub']);
    assert.deepEqual(created, ['HealthHub']);
    assert.deepEqual(exported, bound, 'the exported Durable Object classes are the bound ones');
    ok('wrangler.toml and wrangler.api.toml bind no RelayRoom and create none; the Worker exports exactly its bound Durable Object classes (HealthHub)');
  }
} finally {
  await closeAllPglite();
}

console.log(`PASS: relay and push (${passed.length} groups): registration, opaque forwarding, replay by seq, presence, limits, account isolation, ticket and header auth, revocation, contentless push with delay and dedupe, push tokens on Postgres, no RelayRoom on the deployed Worker`);

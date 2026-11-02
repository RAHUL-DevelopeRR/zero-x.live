/**
 * RelayRoom: one Durable Object per Zero-X account that lets a phone or browser reach a Neuron
 * engine on the user's computer without an inbound port (A11, docs/RELAY.md).
 *
 * - Hosts (computers, `neuron --share`) and clients (phone, web) connect with WebSockets that the
 *   Worker has already authenticated as this account (src/routes/relay.js). Another account's
 *   sockets live in another object, so they can never meet.
 * - The relay routes frames by small JSON envelopes and never reads `data`: it is end-to-end
 *   encrypted between host and client (X25519 + HKDF + XChaCha20-Poly1305, key from the QR code).
 * - Broadcast frames from a host get a `seq` and stay in a memory-only replay buffer, so a client
 *   that reconnects receives what it missed, or `replay_gap` when the buffer no longer has it (the
 *   client then asks the host for a snapshot). Frames are never written to storage.
 * - Presence: clients learn when a host goes on- or offline. The registry of hosts (id, name,
 *   public key) is the only thing stored.
 * - `notify` frames from a host carry no content and become push notifications (A12) when no
 *   client is attached: "needs input" after 30 s without a client, "finished" at once.
 *
 * Classic Durable Object API (constructor(state, env), fetch, webSocket*, alarm) with WebSocket
 * hibernation, like src/health-hub.js, so src/index.js can export it without cloudflare:workers.
 */
import { sendPush } from './push.js';

export const RELAY_PROTOCOL = 1;
export const LIMITS = Object.freeze({
  hosts: 3, clients: 5, registeredHosts: 10, frameBytes: 1_048_576,
  replayFrames: 500, replayBytes: 4_194_304, framesPerSecond: 50, burst: 200,
});
export const NEEDS_INPUT_DELAY_MS = 30_000;
export const NOTIFY_DEDUPE_MS = 60_000;
const HOST_ID = /^h_[0-9a-f]{16}$/;
const PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/; // 32-byte X25519 key, base64url without padding
const CLIENT_ID = /^c_[0-9a-f]{12}$/;
const NOTIFY_KINDS = ['needs_input', 'finished', 'resolved'];
const encoder = new TextEncoder();

const randomHex = bytes => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
const cleanName = value => typeof value === 'string' ? value.replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 64) : '';

// Close codes (4000-4999 are the application's).
export const CLOSE = Object.freeze({
  normal: 1000, badFrame: 4400, unauthorized: 4401, revoked: 4403, unknownHost: 4404, tooLarge: 4413, tooMany: 4429, replaced: 4409,
});

export class RelayRoom {
  constructor(state, env, { now = () => Date.now(), upgrade = socket => new Response(null, { status: 101, webSocket: socket }),
    socketPair = () => new WebSocketPair(), push = sendPush } = {}) {
    this.state = state;
    this.env = env;
    this.now = now;
    this.upgrade = upgrade;
    this.socketPair = socketPair;
    this.push = push;
    this.replay = new Map(); // host_id -> {epoch, frames: [{seq, text, bytes}], bytes}
    this.buckets = new Map(); // socket id -> {tokens, at}
    this.hosts = null; // registry, loaded lazily: host_id -> {name, public_key, created_at, last_seen_at}
    this.ready = state.blockConcurrencyWhile(async () => {
      this.hosts = new Map(Object.entries(await state.storage.get('hosts') || {}));
      this.notify = await state.storage.get('notify') || {}; // host_id -> {kind, due, last: {kind: time}}
    });
    // Answered by the runtime without waking the object.
    if (typeof state.setWebSocketAutoResponse === 'function' && typeof WebSocketRequestResponsePair === 'function') {
      state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
    }
  }

  async saveHosts() { await this.state.storage.put('hosts', Object.fromEntries(this.hosts)); }
  async saveNotify() { await this.state.storage.put('notify', this.notify); }

  sockets(role) { return this.state.getWebSockets(role); }
  info(socket) { return socket.deserializeAttachment() || {}; }
  hostSocket(hostId) { return this.sockets('host').find(socket => this.info(socket).host_id === hostId) || null; }
  clientsOf(hostId) { return this.sockets('client').filter(socket => this.info(socket).host_id === hostId); }

  send(socket, message) {
    try { socket.send(typeof message === 'string' ? message : JSON.stringify(message)); }
    catch { /* the socket closed meanwhile */ }
  }
  fail(socket, code, message, close = null) {
    this.send(socket, { type: 'error', code, message, fatal: close !== null });
    if (close !== null) { try { socket.close(close, code); } catch { /* already closed */ } }
  }

  // Internal requests from the Worker (src/routes/relay.js); never reachable from the internet.
  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    await this.rememberUser(request.headers.get('X-Relay-User'));
    if (url.pathname === '/hosts' && request.method === 'GET') return Response.json({ hosts: this.hostList() });
    if (url.pathname === '/revoke' && request.method === 'POST') return Response.json({ closed: this.revoke(await request.json().catch(() => ({}))) });
    if (url.pathname === '/ticket' && request.method === 'POST') return Response.json({ ok: await this.useTicket(await request.json().catch(() => ({}))) });
    if (url.pathname !== '/connect') return new Response('Not found', { status: 404 });
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected a WebSocket upgrade', { status: 426 });
    const role = request.headers.get('X-Relay-Role');
    if (!['host', 'client'].includes(role)) return new Response('Unknown role', { status: 400 });
    if (this.sockets(role).length >= (role === 'host' ? LIMITS.hosts : LIMITS.clients)) {
      return Response.json({ error: { code: 'too_many_connections', message: `At most ${role === 'host' ? LIMITS.hosts : LIMITS.clients} ${role}s can be connected at once.` } }, { status: 429 });
    }
    const pair = this.socketPair();
    const [client, server] = Object.values(pair);
    const id = role === 'client' ? `c_${randomHex(6)}` : `x_${randomHex(6)}`;
    server.serializeAttachment({ role, id, session: request.headers.get('X-Relay-Session') || null, connected_at: this.now(), host_id: null });
    this.state.acceptWebSocket(server, [role]);
    this.send(server, { type: 'welcome', protocol: RELAY_PROTOCOL, role, ...(role === 'client' ? { client_id: id, hosts: this.hostList() } : {}) });
    return this.upgrade(client);
  }

  // The account this object belongs to (the Worker names it after the user id), for push.
  async rememberUser(userId) {
    if (typeof userId !== 'string' || !/^[0-9a-f-]{36}$/i.test(userId) || this.userId === userId) return;
    this.userId = await this.state.storage.get('user_id');
    if (!this.userId) { this.userId = userId; await this.state.storage.put('user_id', userId); }
  }

  hostList() {
    const online = new Set(this.sockets('host').map(socket => this.info(socket).host_id).filter(Boolean));
    return [...this.hosts.entries()].map(([id, host]) => ({ host_id: id, name: host.name, public_key: host.public_key,
      online: online.has(id), last_seen_at: new Date(online.has(id) ? this.now() : host.last_seen_at).toISOString() }))
      .sort((left, right) => Number(right.online) - Number(left.online) || right.last_seen_at.localeCompare(left.last_seen_at));
  }

  // Closes the sockets of revoked CLI sessions: body.sessions (session ids), or every socket opened
  // with a CLI session (body.all_sessions, after revoke-all), or every socket (body.all).
  revoke(body) {
    let closed = 0;
    for (const socket of [...this.sockets('host'), ...this.sockets('client')]) {
      const { session } = this.info(socket);
      if (body?.all === true || (session && (body?.all_sessions === true || (Array.isArray(body?.sessions) && body.sessions.includes(session))))) {
        this.fail(socket, 'session_revoked', 'This session was signed out.', CLOSE.revoked);
        closed++;
      }
    }
    return closed;
  }

  // Single use of a browser connection ticket (by its hash), remembered until it expires.
  async useTicket({ hash, expires }) {
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash) || !(expires > this.now())) return false;
    const used = await this.state.storage.get('tickets') || {};
    for (const [key, until] of Object.entries(used)) if (until <= this.now()) delete used[key];
    if (used[hash]) return false;
    used[hash] = expires;
    await this.state.storage.put('tickets', used);
    return true;
  }

  allowFrame(socket, id) {
    const now = this.now();
    const bucket = this.buckets.get(id) || { tokens: LIMITS.burst, at: now };
    bucket.tokens = Math.min(LIMITS.burst, bucket.tokens + (now - bucket.at) / 1000 * LIMITS.framesPerSecond);
    bucket.at = now;
    if (bucket.tokens < 1) { this.buckets.set(id, bucket); return false; }
    bucket.tokens -= 1;
    this.buckets.set(id, bucket);
    return true;
  }

  async webSocketMessage(socket, message) {
    await this.ready;
    const info = this.info(socket);
    const size = typeof message === 'string' ? encoder.encode(message).length : message.byteLength;
    if (size > LIMITS.frameBytes) return this.fail(socket, 'frame_too_large', `Frames are limited to ${LIMITS.frameBytes} bytes.`, CLOSE.tooLarge);
    if (typeof message !== 'string') return this.fail(socket, 'bad_frame', 'Frames are JSON text.', CLOSE.badFrame);
    if (!this.allowFrame(socket, info.id)) return this.fail(socket, 'rate_limited', 'Too many frames; slow down.');
    let frame;
    try { frame = JSON.parse(message); } catch { return this.fail(socket, 'bad_frame', 'Frames are JSON objects.', CLOSE.badFrame); }
    if (!frame || typeof frame !== 'object' || Array.isArray(frame) || typeof frame.type !== 'string') {
      return this.fail(socket, 'bad_frame', 'Frames are JSON objects with a type.', CLOSE.badFrame);
    }
    if (frame.type === 'ping') return this.send(socket, { type: 'pong' });
    return info.role === 'host' ? this.fromHost(socket, info, frame) : this.fromClient(socket, info, frame);
  }

  async fromHost(socket, info, frame) {
    if (frame.type === 'register') return this.register(socket, info, frame);
    if (!info.host_id) return this.fail(socket, 'not_registered', 'Send register first.', CLOSE.badFrame);
    if (frame.type === 'frame') {
      if (typeof frame.data !== 'string' || !frame.data) return this.fail(socket, 'bad_frame', '`data` must be a non-empty string.');
      if (frame.to !== undefined && frame.to !== '*' && !CLIENT_ID.test(String(frame.to))) return this.fail(socket, 'bad_frame', '`to` must be a client id or "*".');
      if (frame.to && frame.to !== '*') {
        const target = this.clientsOf(info.host_id).find(client => this.info(client).id === frame.to);
        if (target) this.send(target, { type: 'frame', from: 'host', host_id: info.host_id, data: frame.data });
        return;
      }
      info.seq += 1;
      socket.serializeAttachment(info);
      const text = JSON.stringify({ type: 'frame', from: 'host', host_id: info.host_id, epoch: info.epoch, seq: info.seq, data: frame.data });
      this.remember(info.host_id, info.epoch, info.seq, text);
      for (const client of this.clientsOf(info.host_id)) this.send(client, text);
      return;
    }
    if (frame.type === 'notify') {
      if (!NOTIFY_KINDS.includes(frame.kind)) return this.fail(socket, 'bad_frame', '`kind` must be needs_input, finished or resolved.');
      return this.hostNotify(info.host_id, frame.kind);
    }
    return this.fail(socket, 'bad_frame', `Unknown frame type "${String(frame.type).slice(0, 32)}".`);
  }

  async register(socket, info, frame) {
    if (info.host_id) return this.fail(socket, 'bad_frame', 'Already registered.');
    const name = cleanName(frame.name) || 'Computer';
    if (!PUBLIC_KEY.test(String(frame.public_key))) return this.fail(socket, 'bad_frame', '`public_key` must be a base64url X25519 key.', CLOSE.badFrame);
    let hostId = frame.host_id;
    if (hostId !== undefined && (!HOST_ID.test(String(hostId)) || !this.hosts.has(hostId))) {
      return this.fail(socket, 'unknown_host', 'This computer is not registered on this account. Register again without host_id.', CLOSE.unknownHost);
    }
    if (hostId && this.hosts.get(hostId).public_key !== frame.public_key) {
      // A new key means a new pairing: phones paired with the old key must scan again.
      return this.fail(socket, 'key_changed', 'The public key changed. Register as a new computer.', CLOSE.badFrame);
    }
    if (!hostId) {
      hostId = `h_${randomHex(8)}`;
      if (this.hosts.size >= LIMITS.registeredHosts) {
        const online = new Set(this.sockets('host').map(other => this.info(other).host_id));
        const oldest = [...this.hosts.entries()].filter(([id]) => !online.has(id)).sort((a, b) => a[1].last_seen_at - b[1].last_seen_at)[0];
        if (!oldest) return this.fail(socket, 'too_many_hosts', 'Too many computers are registered.', CLOSE.tooMany);
        this.hosts.delete(oldest[0]);
      }
    }
    const previous = this.hostSocket(hostId);
    if (previous && previous !== socket) this.fail(previous, 'replaced', 'This computer connected again.', CLOSE.replaced);
    const now = this.now();
    this.hosts.set(hostId, { name, public_key: frame.public_key, created_at: this.hosts.get(hostId)?.created_at ?? now, last_seen_at: now });
    await this.saveHosts();
    const epoch = randomHex(8);
    socket.serializeAttachment({ ...info, host_id: hostId, epoch, seq: 0 });
    this.replay.set(hostId, { epoch, frames: [], bytes: 0 });
    this.send(socket, { type: 'registered', host_id: hostId, epoch, clients: this.clientsOf(hostId).map(client => this.info(client).id) });
    for (const client of this.clientsOf(hostId)) this.send(client, { type: 'presence', host_id: hostId, online: true, epoch });
  }

  remember(hostId, epoch, seq, text) {
    let buffer = this.replay.get(hostId);
    if (!buffer || buffer.epoch !== epoch) this.replay.set(hostId, buffer = { epoch, frames: [], bytes: 0 });
    const bytes = encoder.encode(text).length;
    buffer.frames.push({ seq, text, bytes });
    buffer.bytes += bytes;
    while (buffer.frames.length > LIMITS.replayFrames || buffer.bytes > LIMITS.replayBytes) buffer.bytes -= buffer.frames.shift().bytes;
  }

  async fromClient(socket, info, frame) {
    if (frame.type === 'attach') {
      const hostId = frame.host_id;
      if (!HOST_ID.test(String(hostId)) || !this.hosts.has(hostId)) return this.fail(socket, 'unknown_host', 'No such computer on this account.');
      const previous = info.host_id;
      socket.serializeAttachment({ ...info, host_id: hostId });
      const host = this.hostSocket(hostId);
      const hostInfo = host ? this.info(host) : null;
      this.send(socket, { type: 'attached', host_id: hostId, online: Boolean(host), epoch: hostInfo?.epoch ?? null, seq: hostInfo?.seq ?? 0 });
      if (host) {
        this.replayTo(socket, hostId, hostInfo.epoch, frame);
        this.send(host, { type: 'client', event: 'attached', client_id: info.id });
      }
      if (previous && previous !== hostId) this.clientLeft(previous, info.id);
      await this.cancelPendingNotify(hostId);
      return;
    }
    if (!info.host_id) return this.fail(socket, 'not_attached', 'Send attach first.');
    if (frame.type === 'frame') {
      if (typeof frame.data !== 'string' || !frame.data) return this.fail(socket, 'bad_frame', '`data` must be a non-empty string.');
      const host = this.hostSocket(info.host_id);
      if (!host) return this.fail(socket, 'host_offline', 'That computer is offline.');
      return this.send(host, { type: 'frame', from: info.id, data: frame.data });
    }
    if (frame.type === 'detach') {
      socket.serializeAttachment({ ...info, host_id: null });
      return this.clientLeft(info.host_id, info.id);
    }
    return this.fail(socket, 'bad_frame', `Unknown frame type "${String(frame.type).slice(0, 32)}".`);
  }

  // Sends the frames after `since` from the same epoch, or replay_gap when they are gone.
  replayTo(socket, hostId, epoch, frame) {
    if (frame.since === undefined) return;
    const since = Number(frame.since);
    const buffer = this.replay.get(hostId);
    if (frame.epoch !== epoch || !Number.isSafeInteger(since) || since < 0 || !buffer || buffer.epoch !== epoch) {
      return this.send(socket, { type: 'replay_gap', host_id: hostId, epoch });
    }
    const missed = buffer.frames.filter(item => item.seq > since);
    if (missed.length && missed[0].seq !== since + 1) return this.send(socket, { type: 'replay_gap', host_id: hostId, epoch });
    for (const item of missed) this.send(socket, item.text);
  }

  clientLeft(hostId, clientId) {
    const host = this.hostSocket(hostId);
    if (host) this.send(host, { type: 'client', event: 'detached', client_id: clientId });
  }

  async webSocketClose(socket, code, reason) {
    await this.ready;
    const info = this.info(socket);
    this.buckets.delete(info.id);
    if (info.role === 'client' && info.host_id) return this.clientLeft(info.host_id, info.id);
    const replacedBy = this.sockets('host').some(other => other !== socket && this.info(other).host_id === info.host_id);
    if (info.role === 'host' && info.host_id && !replacedBy) {
      const host = this.hosts.get(info.host_id);
      if (host) { host.last_seen_at = this.now(); await this.saveHosts(); }
      for (const client of this.clientsOf(info.host_id)) this.send(client, { type: 'presence', host_id: info.host_id, online: false });
    }
  }

  async webSocketError(socket) {
    try { socket.close(1011, 'error'); } catch { /* already closed */ }
  }

  // ── Push (A12): contentless notify frames ──
  async hostNotify(hostId, kind) {
    const now = this.now();
    const state = this.notify[hostId] || { last: {} };
    if (kind === 'resolved') {
      delete state.due;
      delete state.kind;
    } else if (this.clientsOf(hostId).length) {
      // Someone is watching: no push.
    } else if (now - (state.last[kind] || 0) < NOTIFY_DEDUPE_MS) {
      // Deduplicated.
    } else if (kind === 'finished') {
      state.last[kind] = now;
      await this.deliver(hostId, kind);
    } else if (!state.due) {
      state.kind = kind;
      state.due = now + NEEDS_INPUT_DELAY_MS;
      await this.scheduleAlarm(state.due);
    }
    this.notify[hostId] = state;
    await this.saveNotify();
  }

  async cancelPendingNotify(hostId) {
    const state = this.notify[hostId];
    if (!state?.due) return;
    delete state.due;
    delete state.kind;
    await this.saveNotify();
  }

  async scheduleAlarm(at) {
    const current = await this.state.storage.getAlarm();
    if (!current || current > at) await this.state.storage.setAlarm(at);
  }

  async alarm() {
    await this.ready;
    const now = this.now();
    let next = null;
    for (const [hostId, state] of Object.entries(this.notify)) {
      if (!state.due) continue;
      if (state.due > now) { next = Math.min(next ?? Infinity, state.due); continue; }
      const kind = state.kind;
      delete state.due;
      delete state.kind;
      if (!this.clientsOf(hostId).length) {
        state.last[kind] = now;
        await this.deliver(hostId, kind);
      }
    }
    await this.saveNotify();
    if (next !== null) await this.state.storage.setAlarm(next);
  }

  async deliver(hostId, kind) {
    const userId = this.userId || await this.state.storage.get('user_id');
    if (!userId) return;
    try {
      await this.push(this.env, userId, { kind, host_id: hostId, host_name: this.hosts.get(hostId)?.name || 'your computer' });
    } catch (error) {
      console.warn('Relay push failed', { kind, message: String(error?.message).slice(0, 120) });
    }
  }
}

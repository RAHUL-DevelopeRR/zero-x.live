/**
 * RelayRoom: one Durable Object per Zero-X account that lets the Neuron phone app reach a Neuron
 * session on the user's computer without an inbound port (A11). It speaks `neuron-relay/1`, the
 * contract the apps implement (docs/RELAY.md; neuron-v2 `ui/neuron-mobile/docs/RELAY_CONTRACT.md`).
 *
 * - Computers (`neuron engine --share`) and phones open one WebSocket each to `/v1/relay`. The
 *   Worker (src/routes/relay.js) has already authenticated it as this account; the device says
 *   who it is in its first frame, `join`. Another account's devices live in another object, so
 *   they can never pair with, attach to or send into this one.
 * - The relay routes small JSON envelopes. What a session says travels sealed end to end between
 *   phone and computer (X25519, HKDF-SHA256, AES-256-GCM): the relay sees channel ids, counters,
 *   device ids, sizes and times, never a key or plaintext. Pairing goes by `pair_id`, a hash of
 *   the one-time code, so the relay cannot pair in a phone's place either.
 * - Storage keeps what must outlive hibernation or a restart: the account's devices, pairings,
 *   pairing offers, sealed presence blobs, the routing state of open channels and pending pushes.
 *   Replay buffers of sealed frames stay in memory: a phone that missed frames the relay no
 *   longer holds gets `resume_failed` and takes a fresh snapshot.
 * - WebSocket hibernation: the runtime answers `{"t":"ping"}` with `{"t":"pong"}` without waking
 *   the room, and every timer is the object's alarm.
 * - A computer's contentless `notify` becomes a push (src/push.js) when no phone is attached.
 *
 * Classic Durable Object API (constructor(state, env), fetch, webSocket*, alarm) with WebSocket
 * hibernation, like src/health-hub.js, so src/index.js can export it without cloudflare:workers.
 */
import { sendPush } from './push.js';

export const RELAY_PROTOCOL = 1;
export const RELAY_SUBPROTOCOL = 'neuron-relay.v1';
export const LIMITS = Object.freeze({
  hosts: 3, phones: 5, knownDevices: 10, sockets: 12, sharesPerHost: 16, offersPerHost: 5, channelsPerPhone: 16,
  frameBytes: 1_000_000, sealedPresence: 8_192, replayFrames: 512, replayBytes: 4_000_000, pairTtlMaxS: 600,
  joinTimeoutMs: 10_000, channelAwayMs: 10 * 60_000,
});
// Frames per second per socket, and the burst allowed. A computer streams every session it shares.
export const RATES = Object.freeze({ host: { perSecond: 200, burst: 1000 }, phone: { perSecond: 50, burst: 200 } });
export const NEEDS_ME_DELAY_MS = 30_000;
export const NOTIFY_DEDUPE_MS = 60_000;

// Close codes (docs/RELAY.md section 4.2).
export const CLOSE = Object.freeze({
  protocol: 4400, unauthorized: 4401, forbidden: 4403, joinTimeout: 4408, replaced: 4409, limited: 4429,
});

const PING = '{"t":"ping"}';
const PONG = '{"t":"pong"}';
const encoder = new TextEncoder();
const ID = /^[A-Za-z0-9_-]{8,64}$/;
const isId = value => typeof value === 'string' && ID.test(value);
const isB64 = (value, max = 2_000_000) => typeof value === 'string' && value.length <= max && /^[A-Za-z0-9_-]*$/.test(value);
const isCounter = value => Number.isSafeInteger(value) && value >= 0;
const text = (value, max) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, max) : null;
const randomHex = bytes => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), byte => byte.toString(16).padStart(2, '0')).join('');

/**
 * Checks a frame a device sent (`role` null before `join`); null when the role may not send it.
 * The same rules as the apps' `parseDeviceFrame` (ui/neuron-mobile/src/relay/contract.ts).
 */
export function parseDeviceFrame(data, role) {
  if (typeof data !== 'string' || data.length > LIMITS.frameBytes) return null;
  let f;
  try { f = JSON.parse(data); } catch { return null; }
  if (!f || typeof f !== 'object' || Array.isArray(f) || typeof f.t !== 'string') return null;
  if (f.t === 'ping') return { t: 'ping' };
  if (f.t === 'join') {
    const device = f.device && typeof f.device === 'object' ? f.device : {};
    if ((f.role !== 'host' && f.role !== 'phone') || !isId(device.id)) return null;
    return { t: 'join', role: f.role, device: { id: device.id, name: text(device.name, 64) || 'device', platform: text(device.platform, 32) || 'unknown' } };
  }
  if (role === null) return null;
  if (f.t === 'data') return isId(f.ch) && isCounter(f.n) && isB64(f.c) ? { t: 'data', ch: f.ch, n: f.n, c: f.c } : null;
  if (f.t === 'close') return isId(f.ch) ? { t: 'close', ch: f.ch, ...(typeof f.code === 'string' ? { code: f.code.slice(0, 32) } : {}) } : null;
  if (role === 'host') {
    switch (f.t) {
      case 'share':
        return isId(f.share_id) && (f.sealed === null || isB64(f.sealed, LIMITS.sealedPresence)) ? { t: 'share', share_id: f.share_id, sealed: f.sealed ?? null } : null;
      case 'unshare':
        return isId(f.share_id) ? { t: 'unshare', share_id: f.share_id } : null;
      case 'pair_offer':
        return isB64(f.pair_id, 64) && Number.isSafeInteger(f.ttl_s) && f.ttl_s > 0
          ? { t: 'pair_offer', pair_id: f.pair_id, ttl_s: Math.min(f.ttl_s, LIMITS.pairTtlMaxS) } : null;
      case 'pair_cancel':
        return isB64(f.pair_id, 64) ? { t: 'pair_cancel', pair_id: f.pair_id } : null;
      case 'paired':
        return isB64(f.pair_id, 64) && isId(f.phone_id) && isB64(f.proof, 64) && isB64(f.sealed, 4_096)
          ? { t: 'paired', pair_id: f.pair_id, phone_id: f.phone_id, proof: f.proof, sealed: f.sealed } : null;
      case 'pair_denied':
        return isB64(f.pair_id, 64) && isId(f.phone_id) && typeof f.code === 'string'
          ? { t: 'pair_denied', pair_id: f.pair_id, phone_id: f.phone_id, code: f.code.slice(0, 32) } : null;
      case 'accept':
        return isId(f.ch) && isB64(f.e, 64) && isB64(f.confirm, 64) ? { t: 'accept', ch: f.ch, e: f.e, confirm: f.confirm } : null;
      case 'reject':
        return isId(f.ch) && typeof f.code === 'string' ? { t: 'reject', ch: f.ch, code: f.code.slice(0, 32) } : null;
      case 'notify':
        return isId(f.share_id) && (f.kind === 'needs_me' || f.kind === 'finished') ? { t: 'notify', share_id: f.share_id, kind: f.kind } : null;
      default:
        return null;
    }
  }
  switch (f.t) {
    case 'list':
      return { t: 'list' };
    case 'pair':
      return isB64(f.pair_id, 64) && isB64(f.pub, 64) && isB64(f.proof, 64)
        ? { t: 'pair', pair_id: f.pair_id, pub: f.pub, proof: f.proof, name: text(f.name, 64) || 'phone' } : null;
    case 'open':
      return isId(f.ch) && isId(f.host_id) && isId(f.share_id) && isB64(f.e, 64)
        ? { t: 'open', ch: f.ch, host_id: f.host_id, share_id: f.share_id, e: f.e } : null;
    case 'resume':
      return isId(f.ch) && Number.isSafeInteger(f.after) && f.after >= -1 ? { t: 'resume', ch: f.ch, after: f.after } : null;
    case 'unpair':
      return isId(f.host_id) ? { t: 'unpair', host_id: f.host_id } : null;
    default:
      return null;
  }
}

/** The tag a pairing link carries to show which account a computer is on; not reversible to the id. */
export async function accountTag(accountId) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`neuron-relay/1 account|${accountId}`));
  return Array.from(new Uint8Array(digest).slice(0, 8), byte => byte.toString(16).padStart(2, '0')).join('');
}

export class RelayRoom {
  constructor(state, env, { now = () => Date.now(), upgrade = (socket, headers) => new Response(null, { status: 101, webSocket: socket, headers }),
    socketPair = () => new WebSocketPair(), push = sendPush } = {}) {
    this.state = state;
    this.env = env;
    this.now = now;
    this.upgrade = upgrade;
    this.socketPair = socketPair;
    this.push = push;
    this.buffers = new Map(); // ch -> {frames: [{n, text, bytes}], bytes}: sealed computer-to-phone frames, memory only
    this.buckets = new Map(); // socket id -> {tokens, at}
    this.ready = state.blockConcurrencyWhile(() => this.load());
    // Answered by the runtime without waking the object.
    if (typeof state.setWebSocketAutoResponse === 'function' && typeof WebSocketRequestResponsePair === 'function') {
      state.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
    }
  }

  async load() {
    const storage = this.state.storage;
    this.userId = await storage.get('user_id') || null;
    this.tag = null;
    this.devices = new Map(Object.entries(await storage.get('devices') || {})); // id -> {role, name, platform, last_seen_at}
    this.pairings = new Map(Object.entries(await storage.get('pairings') || {})); // `${host}|${phone}` -> {at}
    this.offers = new Map(Object.entries(await storage.get('offers') || {})); // pair_id -> {host, expires_at, phone}
    this.notifyState = await storage.get('notify') || { due: {}, last: {} }; // keys `${host}|${share}|${kind}`
    this.shares = new Map(); // host -> Map(share_id -> {sealed, at})
    for (const [key, share] of await storage.list({ prefix: 'share:' })) {
      const [, host, shareId] = key.split(':');
      if (!this.shares.has(host)) this.shares.set(host, new Map());
      this.shares.get(host).set(shareId, share);
    }
    // Channels outlive hibernation; their replay buffers do not (`lost`).
    this.channels = new Map();
    for (const [, channel] of await storage.list({ prefix: 'ch:' })) this.channels.set(channel.ch, { ...channel, lost: true });
  }

  // ── Storage ──
  saveDevices() { return this.state.storage.put('devices', Object.fromEntries(this.devices)); }
  savePairings() { return this.state.storage.put('pairings', Object.fromEntries(this.pairings)); }
  saveOffers() { return this.state.storage.put('offers', Object.fromEntries(this.offers)); }
  saveNotify() { return this.state.storage.put('notify', this.notifyState); }
  saveChannel(channel) {
    const { lost: _lost, ...stored } = channel;
    return this.state.storage.put(`ch:${channel.ch}`, stored);
  }
  async saveShare(host, shareId, share) {
    if (share) await this.state.storage.put(`share:${host}:${shareId}`, share);
    else await this.state.storage.delete(`share:${host}:${shareId}`);
  }

  // ── Sockets ──
  info(socket) { return socket.deserializeAttachment() || {}; }
  live(socket) { const info = this.info(socket); return !info.gone && !info.replaced; }
  socketsOf(deviceId) { return this.state.getWebSockets().filter(socket => this.live(socket) && this.info(socket).device === deviceId); }
  online(deviceId) { return this.socketsOf(deviceId).length > 0; }
  onlineDevices(role) {
    return [...new Set(this.state.getWebSockets().filter(socket => this.live(socket) && this.info(socket).role === role)
      .map(socket => this.info(socket).device))];
  }

  send(socket, frame) {
    try { socket.send(typeof frame === 'string' ? frame : JSON.stringify(frame)); }
    catch { /* the socket closed meanwhile */ }
  }
  out(deviceId, frame) {
    const [socket] = this.socketsOf(deviceId);
    if (!socket) return false;
    this.send(socket, frame);
    return true;
  }
  error(socket, code, message, extra = {}) { this.send(socket, { t: 'error', code, message, ...extra }); }

  // Closes a socket and, when it was the device's live one, does what its leaving does.
  async close(socket, code, reason) {
    const info = this.info(socket);
    if (info.gone) return;
    socket.serializeAttachment({ ...info, gone: true });
    try { socket.close(code, reason); } catch { /* already closed */ }
    await this.leave(info, socket);
  }

  // ── Internal requests from the Worker (src/routes/relay.js); never reachable from the internet ──
  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    await this.rememberUser(request.headers.get('X-Relay-User'));
    if (url.pathname === '/hosts' && request.method === 'GET') return Response.json({ hosts: this.hostList() });
    if (url.pathname === '/revoke' && request.method === 'POST') return Response.json({ closed: await this.revoke(await request.json().catch(() => ({}))) });
    if (url.pathname === '/ticket' && request.method === 'POST') return Response.json({ ok: await this.useTicket(await request.json().catch(() => ({}))) });
    if (url.pathname !== '/connect') return new Response('Not found', { status: 404 });
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected a WebSocket upgrade', { status: 426 });
    const ticketRole = request.headers.get('X-Relay-Ticket-Role');
    const crowded = this.state.getWebSockets().filter(socket => this.live(socket)).length >= LIMITS.sockets;
    const [client, server] = Object.values(this.socketPair());
    server.serializeAttachment({ sid: randomHex(6), session: request.headers.get('X-Relay-Session') || null,
      ticket_role: ['host', 'phone'].includes(ticketRole) ? ticketRole : null, at: this.now(), role: null, device: null });
    this.state.acceptWebSocket(server);
    // Refusals are close codes after the upgrade, which a browser can read; an HTTP error is not.
    if (crowded) await this.close(server, CLOSE.limited, 'Too many connections on this account.');
    else await this.scheduleAlarm(this.now() + LIMITS.joinTimeoutMs);
    const headers = request.headers.get('X-Relay-Subprotocol') === RELAY_SUBPROTOCOL ? { 'Sec-WebSocket-Protocol': RELAY_SUBPROTOCOL } : {};
    return this.upgrade(client, headers);
  }

  // The account this object belongs to (the Worker names it after the user id), for push and the tag.
  async rememberUser(userId) {
    if (typeof userId !== 'string' || !/^[0-9a-f-]{36}$/i.test(userId) || this.userId === userId) return;
    this.userId = await this.state.storage.get('user_id');
    if (!this.userId) { this.userId = userId; await this.state.storage.put('user_id', userId); }
  }

  async accountTag() {
    if (!this.tag) this.tag = await accountTag(this.userId || await this.state.storage.get('user_id') || 'unknown');
    return this.tag;
  }

  hostList() {
    return [...this.devices.entries()].filter(([, device]) => device.role === 'host')
      .map(([id, device]) => ({ host_id: id, name: device.name, online: this.online(id),
        last_seen_at: new Date(this.online(id) ? this.now() : device.last_seen_at).toISOString() }))
      .sort((left, right) => Number(right.online) - Number(left.online) || right.last_seen_at.localeCompare(left.last_seen_at));
  }

  // Closes the sockets of signed-out sessions: body.sessions (session ids), or every socket
  // opened with a CLI session (body.all_sessions, after revoke-all), or every socket (body.all).
  async revoke(body) {
    let closed = 0;
    for (const socket of this.state.getWebSockets()) {
      const { session, gone } = this.info(socket);
      if (gone) continue;
      if (body?.all === true || (session && (body?.all_sessions === true || (Array.isArray(body?.sessions) && body.sessions.includes(session))))) {
        this.error(socket, 'session_revoked', 'This device was signed out of Zero-X.');
        await this.close(socket, CLOSE.unauthorized, 'Signed out.');
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

  allowFrame(info) {
    const now = this.now();
    const rate = RATES[info.role] || RATES.phone;
    const bucket = this.buckets.get(info.sid) || { tokens: rate.burst, at: now };
    bucket.tokens = Math.min(rate.burst, bucket.tokens + (now - bucket.at) / 1000 * rate.perSecond);
    bucket.at = now;
    this.buckets.set(info.sid, bucket);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  // ── WebSocket events ──
  async webSocketMessage(socket, message) {
    await this.ready;
    const info = this.info(socket);
    if (info.gone || info.replaced) return;
    if (typeof message !== 'string') return this.close(socket, CLOSE.protocol, 'Frames are JSON text.');
    if (encoder.encode(message).length > LIMITS.frameBytes) return this.close(socket, CLOSE.limited, 'Frames are limited to 1 MB.');
    if (!this.allowFrame(info)) return this.close(socket, CLOSE.limited, 'Too many frames; slow down.');
    if (!info.role) return this.join(socket, info, message);
    const frame = parseDeviceFrame(message, info.role);
    if (!frame) return this.error(socket, 'bad_frame', 'The relay did not understand that frame.');
    // Without the runtime's auto-response (tests, the first ping after a wake-up race).
    if (frame.t === 'ping') return this.send(socket, PONG);
    if (frame.t === 'join') return this.error(socket, 'bad_frame', 'Already joined.');
    return info.role === 'host' ? this.fromHost(info.device, frame) : this.fromPhone(info.device, frame);
  }

  async webSocketClose(socket) {
    await this.ready;
    const info = this.info(socket);
    this.buckets.delete(info.sid);
    if (info.gone) return;
    socket.serializeAttachment({ ...info, gone: true });
    await this.leave(info, socket);
  }

  async webSocketError(socket) {
    await this.ready;
    await this.close(socket, 1011, 'error');
  }

  // A socket's first frame. The device it names joins the room, replacing an older socket of it.
  async join(socket, info, message) {
    const frame = parseDeviceFrame(message, null);
    if (!frame || frame.t !== 'join') return this.close(socket, CLOSE.protocol, 'The first frame must be join.');
    const { role, device } = frame;
    if (info.ticket_role && info.ticket_role !== role) return this.close(socket, CLOSE.unauthorized, 'This connection ticket is for another role.');
    const known = this.devices.get(device.id);
    if (known && known.role !== role) return this.close(socket, CLOSE.protocol, 'This device id belongs to another role.');
    if (this.onlineDevices(role).filter(id => id !== device.id).length >= (role === 'host' ? LIMITS.hosts : LIMITS.phones)) {
      return this.close(socket, CLOSE.limited, role === 'host' ? 'Too many computers are connected on this account.' : 'Too many phones are connected on this account.');
    }
    if (!known && !await this.makeRoom(role)) return this.close(socket, CLOSE.limited, 'Too many devices are known on this account.');
    // The same device again: the newer socket wins.
    for (const other of this.socketsOf(device.id)) {
      other.serializeAttachment({ ...this.info(other), replaced: true });
      try { other.close(CLOSE.replaced, 'This device connected again.'); } catch { /* already closed */ }
    }
    socket.serializeAttachment({ ...info, role, device: device.id });
    this.devices.set(device.id, { role, name: device.name, platform: device.platform, last_seen_at: this.now() });
    await this.saveDevices();
    this.send(socket, { t: 'joined', relay: RELAY_PROTOCOL, role, device_id: device.id, account: { tag: await this.accountTag() } });
    if (role !== 'host') return;
    // A computer's channels and shares do not outlive its socket; it shares again after joining.
    await this.endHostChannels(device.id);
    await this.clearShares(device.id);
    for (const phoneId of this.phonesOf(device.id)) this.out(phoneId, { t: 'host', host_id: device.id, name: device.name, online: true });
  }

  // Forgets the least recently seen offline device of the role (and its pairings) when the
  // account knows too many. False when every one of them is online.
  async makeRoom(role) {
    const same = [...this.devices.entries()].filter(([, device]) => device.role === role);
    if (same.length < LIMITS.knownDevices) return true;
    const oldest = same.filter(([id]) => !this.online(id)).sort((a, b) => a[1].last_seen_at - b[1].last_seen_at)[0];
    if (!oldest) return false;
    this.devices.delete(oldest[0]);
    for (const key of [...this.pairings.keys()]) if (key.split('|').includes(oldest[0])) this.pairings.delete(key);
    await this.savePairings();
    return true;
  }

  async leave(info, socket) {
    if (!info.role || info.replaced) return;
    // A newer socket of the same device took over: nothing left.
    if (this.socketsOf(info.device).some(other => other !== socket)) return;
    const device = this.devices.get(info.device);
    if (device) { device.last_seen_at = this.now(); await this.saveDevices(); }
    if (info.role === 'host') {
      await this.endHostChannels(info.device);
      await this.clearShares(info.device);
      for (const phoneId of this.phonesOf(info.device)) this.out(phoneId, { t: 'host', host_id: info.device, name: device?.name ?? 'Computer', online: false });
      let changed = false;
      for (const [pairId, offer] of this.offers) if (offer.host === info.device) { this.offers.delete(pairId); changed = true; }
      if (changed) await this.saveOffers();
      return;
    }
    // A phone's socket dropped: its channels wait for it, buffering what the computer sends.
    const now = this.now();
    for (const channel of this.channels.values()) {
      if (channel.phone !== info.device || !channel.attached) continue;
      Object.assign(channel, { attached: false, away_at: now, missed: false });
      await this.saveChannel(channel);
      this.out(channel.host, { t: 'peer', ch: channel.ch, state: 'away' });
    }
    let changed = false;
    for (const offer of this.offers.values()) if (offer.phone === info.device) { offer.phone = null; changed = true; }
    if (changed) await this.saveOffers();
    await this.scheduleAlarm(now + LIMITS.channelAwayMs);
  }

  async endHostChannels(hostId) {
    for (const channel of [...this.channels.values()]) {
      if (channel.host !== hostId) continue;
      this.out(channel.phone, { t: 'close', ch: channel.ch, code: 'host_gone' });
      await this.dropChannel(channel);
    }
  }

  async clearShares(hostId) {
    for (const shareId of this.shares.get(hostId)?.keys() ?? []) await this.saveShare(hostId, shareId, null);
    this.shares.delete(hostId);
  }

  async dropChannel(channel) {
    this.channels.delete(channel.ch);
    this.buffers.delete(channel.ch);
    await this.state.storage.delete(`ch:${channel.ch}`);
  }

  paired(hostId, phoneId) { return this.pairings.has(`${hostId}|${phoneId}`); }
  phonesOf(hostId) { return [...this.pairings.keys()].filter(key => key.startsWith(`${hostId}|`)).map(key => key.slice(hostId.length + 1)); }
  hostsOf(phoneId) { return [...this.pairings.keys()].filter(key => key.endsWith(`|${phoneId}`)).map(key => key.slice(0, key.length - phoneId.length - 1)); }

  // ── Computer → relay ──
  async fromHost(hostId, frame) {
    const name = this.devices.get(hostId)?.name ?? 'Computer';
    switch (frame.t) {
      case 'share': {
        const shares = this.shares.get(hostId) ?? new Map();
        if (!shares.has(frame.share_id) && shares.size >= LIMITS.sharesPerHost) {
          return this.out(hostId, { t: 'error', code: 'limit', message: 'This computer shares too many sessions.' });
        }
        const share = { sealed: frame.sealed, at: this.now() };
        shares.set(frame.share_id, share);
        this.shares.set(hostId, shares);
        await this.saveShare(hostId, frame.share_id, share);
        for (const phoneId of this.phonesOf(hostId)) this.out(phoneId, { t: 'presence', host_id: hostId, share_id: frame.share_id, ...share });
        return;
      }
      case 'unshare':
        this.shares.get(hostId)?.delete(frame.share_id);
        await this.saveShare(hostId, frame.share_id, null);
        for (const phoneId of this.phonesOf(hostId)) this.out(phoneId, { t: 'presence', host_id: hostId, share_id: frame.share_id, sealed: null, at: this.now() });
        return;
      case 'pair_offer': {
        const now = this.now();
        const live = [...this.offers.values()].filter(offer => offer.host === hostId && offer.expires_at > now).length;
        if (live >= LIMITS.offersPerHost) return this.out(hostId, { t: 'error', code: 'limit', message: 'Too many pairing codes are waiting.', pair_id: frame.pair_id });
        const expiresAt = now + frame.ttl_s * 1000;
        this.offers.set(frame.pair_id, { host: hostId, expires_at: expiresAt, phone: null });
        await this.saveOffers();
        return this.out(hostId, { t: 'pair_offer_ok', pair_id: frame.pair_id, expires_at: expiresAt });
      }
      case 'pair_cancel':
        if (this.offers.get(frame.pair_id)?.host === hostId) { this.offers.delete(frame.pair_id); await this.saveOffers(); }
        return;
      case 'paired': {
        const offer = this.offers.get(frame.pair_id);
        if (offer?.host !== hostId || offer.phone !== frame.phone_id) return;
        this.offers.delete(frame.pair_id);
        await this.saveOffers();
        this.pairings.set(`${hostId}|${frame.phone_id}`, { at: this.now() });
        await this.savePairings();
        this.out(frame.phone_id, { t: 'paired', pair_id: frame.pair_id, host_id: hostId, name, proof: frame.proof, sealed: frame.sealed });
        this.out(frame.phone_id, { t: 'host', host_id: hostId, name, online: true });
        for (const [shareId, share] of this.shares.get(hostId) ?? []) this.out(frame.phone_id, { t: 'presence', host_id: hostId, share_id: shareId, ...share });
        return;
      }
      case 'pair_denied': {
        const offer = this.offers.get(frame.pair_id);
        if (offer?.host !== hostId || offer.phone !== frame.phone_id) return;
        offer.phone = null;
        await this.saveOffers();
        return this.out(frame.phone_id, { t: 'pair_denied', pair_id: frame.pair_id, code: frame.code });
      }
      case 'accept':
      case 'reject': {
        const channel = this.channels.get(frame.ch);
        if (channel?.host !== hostId) return;
        if (frame.t === 'reject') await this.dropChannel(channel);
        else { channel.accepted = true; await this.saveChannel(channel); }
        this.out(channel.phone, frame);
        if (frame.t === 'accept') await this.cancelPush(hostId, channel.share);
        return;
      }
      case 'data': {
        const channel = this.channels.get(frame.ch);
        if (channel?.host !== hostId) return this.out(hostId, { t: 'error', code: 'unknown_channel', message: 'No such channel.', ch: frame.ch });
        const textFrame = JSON.stringify(frame);
        const buffer = this.buffers.get(frame.ch) ?? { frames: [], bytes: 0 };
        this.buffers.set(frame.ch, buffer);
        buffer.frames.push({ n: frame.n, text: textFrame, bytes: textFrame.length });
        buffer.bytes += textFrame.length;
        while (buffer.frames.length > LIMITS.replayFrames || buffer.bytes > LIMITS.replayBytes) buffer.bytes -= buffer.frames.shift().bytes;
        if (channel.attached) this.out(channel.phone, textFrame);
        else if (!channel.missed) { channel.missed = true; await this.saveChannel(channel); }
        return;
      }
      case 'close': {
        const channel = this.channels.get(frame.ch);
        if (channel?.host !== hostId) return;
        await this.dropChannel(channel);
        return this.out(channel.phone, { t: 'close', ch: frame.ch, ...(frame.code ? { code: frame.code } : {}) });
      }
      case 'notify':
        return this.notify(hostId, frame.share_id, frame.kind);
    }
  }

  // ── Phone → relay ──
  async fromPhone(phoneId, frame) {
    switch (frame.t) {
      case 'list': {
        const hosts = this.hostsOf(phoneId).map(hostId => {
          const online = this.online(hostId);
          return { host_id: hostId, name: this.devices.get(hostId)?.name ?? 'Computer', online,
            shares: online ? [...this.shares.get(hostId) ?? []].map(([shareId, share]) => ({ share_id: shareId, ...share })) : [] };
        });
        return this.out(phoneId, { t: 'hosts', hosts });
      }
      case 'pair': {
        const offer = this.offers.get(frame.pair_id);
        if (!offer || offer.expires_at <= this.now()) {
          return this.out(phoneId, { t: 'error', code: 'pair_not_found', message: 'No computer on this account is waiting for that code.', pair_id: frame.pair_id });
        }
        if (!this.online(offer.host)) return this.out(phoneId, { t: 'error', code: 'host_offline', message: 'The computer went offline.', pair_id: frame.pair_id });
        if (offer.phone) return this.out(phoneId, { t: 'error', code: 'pair_not_found', message: 'That code is already being used.', pair_id: frame.pair_id });
        offer.phone = phoneId;
        await this.saveOffers();
        return this.out(offer.host, { t: 'pair', pair_id: frame.pair_id, phone_id: phoneId, pub: frame.pub, proof: frame.proof, name: frame.name });
      }
      case 'open': {
        const fail = (code, message) => this.out(phoneId, { t: 'error', code, message, ch: frame.ch });
        if (!this.paired(frame.host_id, phoneId)) return fail('not_paired', 'This phone is not paired with that computer.');
        if (!this.online(frame.host_id)) return fail('host_offline', 'The computer is offline.');
        if (this.channels.has(frame.ch)) return fail('bad_frame', 'That channel id is taken.');
        if ([...this.channels.values()].filter(channel => channel.phone === phoneId).length >= LIMITS.channelsPerPhone) {
          return fail('limit', 'This phone has too many sessions open.');
        }
        const channel = { ch: frame.ch, host: frame.host_id, phone: phoneId, share: frame.share_id, p2h: -1,
          accepted: false, attached: true, away_at: null, missed: false };
        this.channels.set(frame.ch, channel);
        await this.saveChannel(channel);
        return this.out(frame.host_id, { t: 'open', ch: frame.ch, phone_id: phoneId, share_id: frame.share_id, e: frame.e });
      }
      case 'resume':
        return this.resume(phoneId, frame);
      case 'data': {
        const channel = this.channels.get(frame.ch);
        if (channel?.phone !== phoneId) return this.out(phoneId, { t: 'error', code: 'unknown_channel', message: 'No such channel.', ch: frame.ch });
        if (!this.online(channel.host)) return this.out(phoneId, { t: 'error', code: 'host_offline', message: 'The computer is offline.', ch: frame.ch });
        if (frame.n > channel.p2h) { channel.p2h = frame.n; await this.saveChannel(channel); }
        return this.out(channel.host, frame);
      }
      case 'close': {
        const channel = this.channels.get(frame.ch);
        if (channel?.phone !== phoneId) return;
        await this.dropChannel(channel);
        return this.out(channel.host, { t: 'close', ch: frame.ch });
      }
      case 'unpair': {
        if (!this.paired(frame.host_id, phoneId)) return;
        this.pairings.delete(`${frame.host_id}|${phoneId}`);
        await this.savePairings();
        for (const channel of [...this.channels.values()]) {
          if (channel.host !== frame.host_id || channel.phone !== phoneId) continue;
          this.out(channel.host, { t: 'close', ch: channel.ch });
          await this.dropChannel(channel);
        }
        return this.out(frame.host_id, { t: 'unpaired', phone_id: phoneId });
      }
    }
  }

  // The phone is back on a channel: replay what it missed, or say it must take a fresh snapshot.
  async resume(phoneId, frame) {
    const channel = this.channels.get(frame.ch);
    if (channel?.phone !== phoneId || !channel.accepted) return this.out(phoneId, { t: 'resume_failed', ch: frame.ch, code: 'unknown_channel' });
    const buffer = this.buffers.get(frame.ch) ?? { frames: [], bytes: 0 };
    const missed = buffer.frames.filter(entry => entry.n > frame.after);
    const oldest = buffer.frames[0]?.n;
    const covered = oldest === undefined || oldest <= frame.after + 1;
    // A gap: frames the phone needs are gone (the buffer overflowed, or the room restarted after
    // the computer sent some while the phone was away). The channel is over; the phone attaches again.
    if ((missed.length > 0 && !covered) || (channel.lost && channel.missed && !(oldest !== undefined && covered))) {
      await this.dropChannel(channel);
      this.out(channel.host, { t: 'close', ch: frame.ch, code: 'lost' });
      return this.out(phoneId, { t: 'resume_failed', ch: frame.ch, code: 'gap' });
    }
    const wasAway = !channel.attached;
    Object.assign(channel, { attached: true, away_at: null, missed: false });
    await this.saveChannel(channel);
    this.out(phoneId, { t: 'resumed', ch: frame.ch, received: channel.p2h });
    for (const entry of missed) this.out(phoneId, entry.text);
    if (wasAway) this.out(channel.host, { t: 'peer', ch: frame.ch, state: 'back' });
    await this.cancelPush(channel.host, channel.share);
  }

  // ── Push (A12): contentless notify frames ──
  attachedTo(hostId, shareId) {
    return [...this.channels.values()].some(channel => channel.host === hostId && channel.share === shareId && channel.attached);
  }

  async cancelPush(hostId, shareId) {
    const key = `${hostId}|${shareId}|needs_me`;
    if (!(key in this.notifyState.due)) return;
    delete this.notifyState.due[key];
    await this.saveNotify();
  }

  async notify(hostId, shareId, kind) {
    // Someone is looking at it: no push.
    if (this.attachedTo(hostId, shareId)) return;
    const key = `${hostId}|${shareId}|${kind}`;
    if (key in this.notifyState.due) return;
    if (kind === 'finished') return this.firePush(key);
    const due = this.now() + NEEDS_ME_DELAY_MS;
    this.notifyState.due[key] = due;
    await this.saveNotify();
    await this.scheduleAlarm(due);
  }

  async firePush(key) {
    delete this.notifyState.due[key];
    const now = this.now();
    for (const [other, at] of Object.entries(this.notifyState.last)) if (now - at >= NOTIFY_DEDUPE_MS) delete this.notifyState.last[other];
    const [hostId, shareId, kind] = key.split('|');
    const phoneIds = this.phonesOf(hostId);
    if (this.attachedTo(hostId, shareId) || key in this.notifyState.last || !phoneIds.length) return this.saveNotify();
    this.notifyState.last[key] = now;
    await this.saveNotify();
    const userId = this.userId || await this.state.storage.get('user_id');
    if (!userId) return;
    try {
      await this.push(this.env, userId, { kind, host_id: hostId, host_name: this.devices.get(hostId)?.name || 'your computer', share_id: shareId, phone_ids: phoneIds });
    } catch (error) {
      console.warn('Relay push failed', { kind, message: String(error?.message).slice(0, 120) });
    }
  }

  // ── Timers: one alarm for join timeouts, phones away too long, delayed pushes and offers ──
  nextDue() {
    const times = [];
    for (const socket of this.state.getWebSockets()) {
      const info = this.info(socket);
      if (!info.gone && !info.role) times.push(info.at + LIMITS.joinTimeoutMs);
    }
    for (const channel of this.channels.values()) if (!channel.attached && channel.away_at !== null) times.push(channel.away_at + LIMITS.channelAwayMs);
    times.push(...Object.values(this.notifyState.due));
    return times.length ? Math.min(...times) : null;
  }

  async scheduleAlarm(at) {
    const current = await this.state.storage.getAlarm();
    if (!current || current > at) await this.state.storage.setAlarm(at);
  }

  async alarm() {
    await this.ready;
    const now = this.now();
    for (const socket of this.state.getWebSockets()) {
      const info = this.info(socket);
      if (!info.gone && !info.role && info.at + LIMITS.joinTimeoutMs <= now) await this.close(socket, CLOSE.joinTimeout, 'No join in time.');
    }
    for (const channel of [...this.channels.values()]) {
      if (channel.attached || channel.away_at === null || channel.away_at + LIMITS.channelAwayMs > now) continue;
      this.out(channel.host, { t: 'close', ch: channel.ch, code: 'phone_gone' });
      await this.dropChannel(channel);
    }
    for (const [key, due] of Object.entries(this.notifyState.due)) if (due <= now) await this.firePush(key);
    let expired = false;
    for (const [pairId, offer] of this.offers) if (offer.expires_at <= now) { this.offers.delete(pairId); expired = true; }
    if (expired) await this.saveOffers();
    const next = this.nextDue();
    if (next !== null) await this.state.storage.setAlarm(Math.max(next, now + 1));
  }
}

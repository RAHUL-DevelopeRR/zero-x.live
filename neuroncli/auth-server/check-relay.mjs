// Relay (A11) and push (A12), offline: the RelayRoom Durable Object speaking `neuron-relay/1` with a
// fake hibernation API, driven by a computer and phones that do the real end-to-end cryptography
// (checked against the apps' test vectors first); the Worker's relay routes with a fake namespace;
// and push registrations and delivery on PGlite with a fake Expo push service (docs/RELAY.md).
// Run: node check-relay.mjs
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, hkdfSync, randomBytes } from 'node:crypto';
import app from './src/index.js';
import { rpc, rpcRows } from './src/account-store.js';
import { closeAllPglite, getPgliteHandle } from './src/db/pglite.js';
import { devToken } from './src/auth-context.js';
import { accountTag, CLOSE, LIMITS, NEEDS_ME_DELAY_MS, NOTIFY_DEDUPE_MS, parseDeviceFrame, RelayRoom } from './src/relay.js';
import { EXPO_PUSH_URL, pushMessage, sendPush } from './src/push.js';
import { sessionId } from './src/routes/sessions.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const passed = [];
const ok = name => { passed.push(name); console.log(`ok - ${name}`); };
const USER_A = '11111111-1111-4111-8111-111111111111';

// ── The end-to-end cryptography of the apps (ui/neuron-mobile/src/relay/crypto.ts), in Node ──
const LABEL = 'neuron-relay/1';
const b64u = bytes => Buffer.from(bytes).toString('base64url');
const unb64u = text => Buffer.from(text, 'base64url');
const utf8 = text => Buffer.from(text, 'utf8');
const PKCS8_X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const SPKI_X25519 = Buffer.from('302a300506032b656e032100', 'hex');
const privateKey = secret => createPrivateKey({ key: Buffer.concat([PKCS8_X25519, secret]), format: 'der', type: 'pkcs8' });
const publicOf = secret => createPublicKey(privateKey(secret)).export({ format: 'der', type: 'spki' }).subarray(-32);
const x25519 = (secret, peer) => diffieHellman({ privateKey: privateKey(secret),
  publicKey: createPublicKey({ key: Buffer.concat([SPKI_X25519, peer]), format: 'der', type: 'spki' }) });
const hkdf = (ikm, salt, info, length) => Buffer.from(hkdfSync('sha256', ikm, salt, info, length));
const mac16 = (key, message) => createHmac('sha256', key).update(message).digest().subarray(0, 16);
const pairIdFor = code => b64u(createHash('sha256').update(Buffer.concat([utf8(`${LABEL} pair-id`), unb64u(code)])).digest().subarray(0, 16));
const pairKeyOf = (secret, peer, code, hostPublic, phonePublic) =>
  hkdf(x25519(secret, peer), unb64u(code), Buffer.concat([utf8(`${LABEL} pair`), hostPublic, phonePublic]), 32);
const proofOf = (pairKey, role, pairId) => b64u(mac16(pairKey, utf8(`${LABEL} ${role}-proof ${pairId}`)));
const subkey = (pairKey, purpose) => hkdf(pairKey, Buffer.alloc(0), utf8(`${LABEL} ${purpose}`), 32);
const channelKeys = (secret, peer, pairKey, phoneEphemeral, hostEphemeral, ch) => {
  const okm = hkdf(x25519(secret, peer), pairKey, Buffer.concat([utf8(`${LABEL} channel ${ch}`), phoneEphemeral, hostEphemeral]), 64);
  return { p2h: okm.subarray(0, 32), h2p: okm.subarray(32, 64) };
};
const confirmOf = (keys, ch) => b64u(mac16(keys.h2p, utf8(`${LABEL} accept ${ch}`)));
const nonceOf = n => { const nonce = Buffer.alloc(12); nonce.writeBigUInt64BE(BigInt(n), 4); return nonce; };
const gcmSeal = (key, nonce, aad, text) => {
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);
  return Buffer.concat([cipher.update(utf8(text)), cipher.final(), cipher.getAuthTag()]);
};
const gcmOpen = (key, nonce, aad, sealed) => {
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(sealed.subarray(-16));
  return Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]).toString('utf8');
};
const sealFrame = (key, ch, dir, n, text) => b64u(gcmSeal(key, nonceOf(n), utf8(`${LABEL}|${ch}|${dir}`), text));
const openFrame = (key, ch, dir, n, c) => gcmOpen(key, nonceOf(n), utf8(`${LABEL}|${ch}|${dir}`), unb64u(c));
const sealBlob = (key, aad, text) => { const nonce = randomBytes(12); return b64u(Buffer.concat([nonce, gcmSeal(key, nonce, utf8(aad), text)])); };
const openBlob = (key, aad, sealed) => { const bytes = unb64u(sealed); return gcmOpen(key, bytes.subarray(0, 12), utf8(aad), bytes.subarray(12)); };
const range = (start, count) => Buffer.from(Array.from({ length: count }, (_, index) => start + index));
const randomId = () => b64u(randomBytes(16));

// ── Fake Durable Object state with the WebSocket hibernation API ──
// Like the runtime, getWebSockets() still lists a socket the object closed until its close
// event (webSocketClose) has run.
function fakeState(storage = new Map()) {
  let alarm = null;
  const sockets = [];
  return {
    storage: {
      map: storage,
      get: async key => structuredClone(storage.get(key)),
      put: async (key, value) => { storage.set(key, structuredClone(value)); },
      delete: async key => storage.delete(key),
      list: async ({ prefix = '' } = {}) => new Map([...storage].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => [key, structuredClone(value)])),
      getAlarm: async () => alarm,
      setAlarm: async at => { alarm = at; },
    },
    get alarm() { return alarm; },
    blockConcurrencyWhile: fn => fn(),
    acceptWebSocket(socket, tags = []) { socket.tags = tags; sockets.push(socket); },
    getWebSockets(tag) { return sockets.filter(socket => !socket.dropped && (!tag || socket.tags.includes(tag))); },
  };
}
function fakeSocket() {
  let attachment = null;
  return {
    sent: [], closed: false, dropped: false, closeCode: null, closeReason: null,
    send(message) { if (this.closed) throw new Error('closed'); this.sent.push(message); },
    close(code, reason) { if (!this.closed) { this.closed = true; this.closeCode = code; this.closeReason = reason; } },
    serializeAttachment(value) { attachment = structuredClone(value); },
    deserializeAttachment() { return structuredClone(attachment); },
  };
}
const clock = { now: Date.parse('2026-11-02T09:00:00Z') };
const roomOptions = now => ({
  now, upgrade: (socket, headers) => ({ status: 101, webSocket: socket, headers }),
  socketPair: () => ({ 0: fakeSocket(), 1: fakeSocket() }),
});
function makeRoom({ storage, now = () => clock.now } = {}) {
  const state = fakeState(storage);
  const pushes = [];
  const room = new RelayRoom(state, {}, { ...roomOptions(now), push: async (_env, userId, message) => { pushes.push({ userId, ...message }); } });
  return { room, state, pushes };
}

// Every frame any socket sent or got, for the "no plaintext crosses the relay" check.
const wire = [];

// One device's socket into a room, as the Worker hands it over.
class Device {
  constructor(room, { user = USER_A, session = null, ticketRole = null, subprotocol = true } = {}) {
    Object.assign(this, { room, user, session, ticketRole, subprotocol });
  }
  async connect() {
    const headers = new Headers({ Upgrade: 'websocket', 'X-Relay-User': this.user });
    if (this.session) headers.set('X-Relay-Session', this.session);
    if (this.ticketRole) headers.set('X-Relay-Ticket-Role', this.ticketRole);
    if (this.subprotocol) headers.set('X-Relay-Subprotocol', 'neuron-relay.v1');
    this.response = await this.room.fetch(new Request('https://relay.internal/connect', { headers }));
    this.adopt(this.room.state.getWebSockets().at(-1));
    return this;
  }
  // Takes over a socket the room accepted (through the Worker).
  adopt(socket) {
    this.socket = socket;
    this.read = 0;
  }
  async say(frame) {
    const text = typeof frame === 'string' ? frame : JSON.stringify(frame);
    wire.push(text);
    await this.room.webSocketMessage(this.socket, text);
  }
  // Frames the relay sent since the last call.
  take() {
    const fresh = this.socket.sent.slice(this.read).map(text => { wire.push(text); return JSON.parse(text); });
    this.read = this.socket.sent.length;
    return fresh;
  }
  // The newest frame (reading everything up to it).
  last() { return this.take().at(-1) ?? JSON.parse(this.socket.sent.at(-1)); }
  // The network drops the socket (the close event reaches the room).
  async drop() {
    this.socket.closed = true;
    this.socket.dropped = true;
    await this.room.webSocketClose(this.socket, 1006, '');
  }
  // The room closed the socket; its close event follows.
  async closedByRoom() {
    assert.ok(this.socket.closed, 'the room closed the socket');
    this.socket.dropped = true;
    await this.room.webSocketClose(this.socket, this.socket.closeCode, '');
    return this.socket.closeCode;
  }
}

// A computer: its identity and its side of pairing and channels.
class Computer {
  constructor(room, { id = randomId(), name = 'Studio', user = USER_A, session = null } = {}) {
    this.device = new Device(room, { user, session });
    Object.assign(this, { id, name, secret: randomBytes(32), presenceKey: randomBytes(32), phones: new Map(), channels: new Map(), offers: new Map() });
    this.publicKey = publicOf(this.secret);
  }
  async join({ connect = true } = {}) {
    if (connect) await this.device.connect();
    await this.device.say({ t: 'join', role: 'host', device: { id: this.id, name: this.name, platform: 'linux' } });
    this.joined = this.device.take().find(frame => frame.t === 'joined');
    return this;
  }
  async offer() {
    const code = b64u(randomBytes(16));
    const pairId = pairIdFor(code);
    this.offers.set(pairId, code);
    await this.device.say({ t: 'pair_offer', pair_id: pairId, ttl_s: 600 });
    return { code, pairId, answer: this.device.take().at(-1) };
  }
  async share(shareId, presence) {
    await this.device.say({ t: 'share', share_id: shareId, sealed: sealBlob(this.presenceKey, `${LABEL} presence|${this.id}|${shareId}`, JSON.stringify(presence)) });
  }
  // Answers what the relay passed on: pairings, channel opens, phone frames.
  async serve() {
    for (const frame of this.device.take()) {
      if (frame.t === 'pair') {
        const code = this.offers.get(frame.pair_id);
        this.offers.delete(frame.pair_id);
        const phonePublic = unb64u(frame.pub);
        const pairKey = pairKeyOf(this.secret, phonePublic, code, this.publicKey, phonePublic);
        if (proofOf(pairKey, 'phone', frame.pair_id) !== frame.proof) {
          await this.device.say({ t: 'pair_denied', pair_id: frame.pair_id, phone_id: frame.phone_id, code: 'bad_proof' });
          continue;
        }
        this.phones.set(frame.phone_id, pairKey);
        await this.device.say({ t: 'paired', pair_id: frame.pair_id, phone_id: frame.phone_id, proof: proofOf(pairKey, 'host', frame.pair_id),
          sealed: sealBlob(subkey(pairKey, 'pair-secrets'), `${LABEL} pair-secrets|${frame.pair_id}`, JSON.stringify({ presence_key: b64u(this.presenceKey), name: this.name })) });
      } else if (frame.t === 'open') {
        const pairKey = this.phones.get(frame.phone_id);
        if (!pairKey) { await this.device.say({ t: 'reject', ch: frame.ch, code: 'not_paired' }); continue; }
        const ephemeral = randomBytes(32);
        const keys = channelKeys(ephemeral, unb64u(frame.e), pairKey, unb64u(frame.e), publicOf(ephemeral), frame.ch);
        this.channels.set(frame.ch, { keys, sent: 0, received: -1, inbox: [] });
        await this.device.say({ t: 'accept', ch: frame.ch, e: b64u(publicOf(ephemeral)), confirm: confirmOf(keys, frame.ch) });
      } else if (frame.t === 'data') {
        const channel = this.channels.get(frame.ch);
        assert.equal(frame.n, channel.received + 1, 'the computer gets phone frames in order');
        channel.received = frame.n;
        channel.inbox.push(openFrame(channel.keys.p2h, frame.ch, 'p2h', frame.n, frame.c));
      } else if (frame.t === 'close') {
        this.channels.delete(frame.ch);
      }
    }
  }
  async send(ch, inner) {
    const channel = this.channels.get(ch);
    const n = channel.sent++;
    await this.device.say({ t: 'data', ch, n, c: sealFrame(channel.keys.h2p, ch, 'h2p', n, JSON.stringify(inner)) });
  }
}

// A phone: pairs from a QR's fields, opens channels and reads them.
class Phone {
  constructor(room, { id = randomId(), user = USER_A, session = null } = {}) {
    Object.assign(this, { id, hosts: new Map(), channels: new Map() });
    this.device = new Device(room, { user, session });
  }
  async join({ connect = true } = {}) {
    if (connect) await this.device.connect();
    await this.device.say({ t: 'join', role: 'phone', device: { id: this.id, name: 'Pixel', platform: 'android' } });
    this.joined = this.device.take().find(frame => frame.t === 'joined');
    return this;
  }
  async pair(computer, code) {
    const secret = randomBytes(32);
    const phonePublic = publicOf(secret);
    const pairKey = pairKeyOf(secret, computer.publicKey, code, computer.publicKey, phonePublic);
    const pairId = pairIdFor(code);
    this.pending = { computer, pairKey, pairId };
    await this.device.say({ t: 'pair', pair_id: pairId, pub: b64u(phonePublic), proof: proofOf(pairKey, 'phone', pairId), name: 'Pixel' });
  }
  // Reads `paired`: checks the computer's proof and opens the secrets.
  finishPairing() {
    const frames = this.device.take();
    const paired = frames.find(frame => frame.t === 'paired');
    if (!paired) return frames;
    const { computer, pairKey, pairId } = this.pending;
    assert.equal(paired.proof, proofOf(pairKey, 'host', pairId), "the computer's proof checks out");
    const secrets = JSON.parse(openBlob(subkey(pairKey, 'pair-secrets'), `${LABEL} pair-secrets|${pairId}`, paired.sealed));
    this.hosts.set(computer.id, { pairKey, presenceKey: unb64u(secrets.presence_key), name: secrets.name });
    return frames;
  }
  async open(hostId, shareId, ch = `ch-${randomId()}`) {
    const ephemeral = randomBytes(32);
    this.channels.set(ch, { hostId, ephemeral, keys: null, sent: 0, received: -1, inbox: [] });
    await this.device.say({ t: 'open', ch, host_id: hostId, share_id: shareId, e: b64u(publicOf(ephemeral)) });
    return ch;
  }
  // Reads accepts (checking the confirm) and data on the phone's channels.
  read() {
    const frames = this.device.take();
    for (const frame of frames) {
      const channel = this.channels.get(frame.ch);
      if (!channel) continue;
      if (frame.t === 'accept') {
        const { pairKey } = this.hosts.get(channel.hostId);
        channel.keys = channelKeys(channel.ephemeral, unb64u(frame.e), pairKey, publicOf(channel.ephemeral), unb64u(frame.e), frame.ch);
        assert.equal(frame.confirm, confirmOf(channel.keys, frame.ch), 'the accept confirm checks out');
      } else if (frame.t === 'data') {
        if (frame.n <= channel.received) continue;
        assert.equal(frame.n, channel.received + 1, 'the phone gets computer frames in order');
        channel.received = frame.n;
        channel.inbox.push(JSON.parse(openFrame(channel.keys.h2p, frame.ch, 'h2p', frame.n, frame.c)));
      }
    }
    return frames;
  }
  async send(ch, inner) {
    const channel = this.channels.get(ch);
    const n = channel.sent++;
    await this.device.say({ t: 'data', ch, n, c: sealFrame(channel.keys.p2h, ch, 'p2h', n, JSON.stringify(inner)) });
  }
  async reconnect() {
    await this.device.drop();
    return this.join();
  }
}

// Pairs a phone with a computer and opens a channel on `shareId`.
async function pairAndOpen(computer, phone, shareId) {
  const { code } = await computer.offer();
  await phone.pair(computer, code);
  await computer.serve();
  phone.finishPairing();
  const ch = await phone.open(computer.id, shareId);
  await computer.serve();
  phone.read();
  return ch;
}

try {
  // ── 0. The test's cryptography is the apps': their vectors (RELAY_CONTRACT.md §3.7) ──
  {
    const h = range(1, 32);
    const p = range(0x40, 32);
    const b = range(0x80, 32);
    const a = range(0xa0, 32);
    const code = b64u(range(0xc0, 16));
    const ch = 'channel-0000000001';
    const K = publicOf(h);
    const P = publicOf(p);
    assert.equal(b64u(K), 'B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9_AsrhtHHw');
    assert.equal(b64u(P), 'eaYx7t4b-cmPEgMs3q3Q56B5OY_HhriMyEbsia-FpRo');
    const pairId = pairIdFor(code);
    assert.equal(pairId, 'xMm4z_g3jDfuYMKwidZHBg');
    const pairKey = pairKeyOf(p, K, code, K, P);
    assert.equal(b64u(pairKey), '4D5wivpGleJpH83D0sn-YabpzY7zC8PG-6GXqDdUalk');
    assert.deepEqual(pairKeyOf(h, P, code, K, P), pairKey, 'both ends derive the same pair key');
    assert.equal(proofOf(pairKey, 'phone', pairId), 'cbwHSSkvuXNM06i3rkMJkw');
    assert.equal(proofOf(pairKey, 'host', pairId), 'A9pJGL2ru9oPNO9AkqUO9A');
    assert.equal(b64u(subkey(pairKey, 'pair-secrets')), 'ml4UAMqUKZdHGLgVhmj2Kn-ArGEsmn2CFyoqF-3mJmo');
    const A = publicOf(a);
    const B = publicOf(b);
    const keys = channelKeys(a, B, pairKey, A, B, ch);
    assert.deepEqual(channelKeys(b, A, pairKey, A, B, ch), keys);
    assert.equal(b64u(keys.p2h), 'N174o0i91fATCDiCxybPvW1IVSik5YrI1VXfwhySPl8');
    assert.equal(b64u(keys.h2p), 'CqAUf_LDYB8oW3HicMS7OV03SzZQgPpuGpyutLS3Ii4');
    assert.equal(confirmOf(keys, ch), 'WmXZ4JoZr6XvkScveQ9llQ');
    assert.equal(sealFrame(keys.p2h, ch, 'p2h', 0, '{"t":"ping"}'), 'FHfS93E8PCTjaHu3pzTqB3pme1Hi1W-Z3o793A');
    assert.equal(sealFrame(keys.h2p, ch, 'h2p', 1, '{"t":"pong"}'), '7-VzfWIbvw7QbuxBgJrSWrbWheJ1f2hUUvjEfA');
    assert.equal(openFrame(keys.h2p, ch, 'h2p', 1, '7-VzfWIbvw7QbuxBgJrSWrbWheJ1f2hUUvjEfA'), '{"t":"pong"}');
    ok("the test devices match the apps' cryptography vectors (X25519, pair id, HKDF pair and channel keys, proofs, confirm, AES-GCM frames)");
  }

  // ── 1. Joining: the first frame, the account tag, roles, replacement, limits ──
  {
    const { room, state } = makeRoom();
    const stranger = await new Device(room).connect();
    assert.equal(stranger.response.status, 101);
    assert.deepEqual(stranger.response.headers, { 'Sec-WebSocket-Protocol': 'neuron-relay.v1' }, 'the subprotocol is echoed');
    await stranger.say({ t: 'list' });
    assert.equal(await stranger.closedByRoom(), CLOSE.protocol, 'the first frame must be join');
    const computer = await new Computer(room, { name: 'Studio\u0007' }).join();
    assert.deepEqual(computer.joined, { t: 'joined', relay: 1, role: 'host', device_id: computer.id, account: { tag: await accountTag(USER_A) } });
    assert.equal(computer.joined.account.tag, sha(`neuron-relay/1 account|${USER_A}`).slice(0, 16), "the tag is the contract's hash of the account");
    assert.equal(state.storage.map.get('devices')[computer.id].name, 'Studio', 'control characters are dropped from names');
    assert.equal(state.storage.map.get('user_id'), USER_A);
    const impostor = await new Device(room).connect();
    await impostor.say({ t: 'join', role: 'phone', device: { id: computer.id, name: 'x', platform: 'ios' } });
    assert.equal(await impostor.closedByRoom(), CLOSE.protocol, 'a device id keeps its role');
    await computer.device.say('{"t":"ping"}');
    assert.equal(computer.device.socket.sent.at(-1), '{"t":"pong"}', 'ping and pong are the exact strings');
    await computer.device.say({ t: 'join', role: 'host', device: { id: computer.id } });
    assert.equal(computer.device.last().code, 'bad_frame');
    await computer.device.say({ t: 'pair', pair_id: 'x', pub: 'y', proof: 'z' });
    assert.equal(computer.device.last().code, 'bad_frame', 'a computer cannot send phone frames');

    // The same device again: the newer socket wins, and the old one leaving changes nothing.
    const phone = await new Phone(room).join();
    const again = await new Device(room).connect();
    await again.say({ t: 'join', role: 'phone', device: { id: phone.id, name: 'Pixel', platform: 'android' } });
    assert.equal(phone.device.socket.closeCode, CLOSE.replaced);
    await phone.device.closedByRoom();
    assert.equal(again.take()[0].t, 'joined');
    assert.deepEqual(room.onlineDevices('phone'), [phone.id]);

    // At most 3 computers and 5 phones online.
    for (let index = 0; index < LIMITS.hosts - 1; index++) await new Computer(room).join();
    const fourth = await new Computer(room).join();
    assert.equal(fourth.device.socket.closeCode, CLOSE.limited, `at most ${LIMITS.hosts} computers`);
    await fourth.device.closedByRoom();
    for (let index = 0; index < LIMITS.phones - 1; index++) await new Phone(room).join();
    const sixth = await new Phone(room).join();
    assert.equal(sixth.device.socket.closeCode, CLOSE.limited, `at most ${LIMITS.phones} phones`);
    await sixth.device.closedByRoom();

    // Frames: JSON text, at most 1 MB, and a rate limit.
    const big = await new Phone(makeRoom().room).join();
    await big.device.say(JSON.stringify({ t: 'list', pad: 'x'.repeat(LIMITS.frameBytes) }));
    assert.equal(big.device.socket.closeCode, CLOSE.limited, 'frames over 1 MB close with 4429');
    const chatty = await new Phone(makeRoom().room).join();
    for (let index = 0; index < 250 && !chatty.device.socket.closed; index++) await chatty.device.say({ t: 'list' });
    assert.equal(chatty.device.socket.closeCode, CLOSE.limited, 'a phone over its frame rate is closed (4429)');
    const binary = await new Phone(makeRoom().room).join();
    await binary.device.room.webSocketMessage(binary.device.socket, new Uint8Array([1, 2]).buffer);
    assert.equal(binary.device.socket.closeCode, CLOSE.protocol, 'binary frames close with 4400');

    // No join within 10 s: the alarm closes the socket.
    const { room: quiet, state: quietState } = makeRoom();
    const silent = await new Device(quiet).connect();
    assert.equal(quietState.alarm, clock.now + LIMITS.joinTimeoutMs);
    clock.now += LIMITS.joinTimeoutMs;
    await quiet.alarm();
    assert.equal(silent.socket.closeCode, CLOSE.joinTimeout);
    ok('join: first frame join (4400), joined with the account tag, roles kept, the newer socket replaces (4409), 3 computers and 5 phones (4429), 1 MB and rate limits, join timeout by alarm (4408)');
  }

  // ── 2. One account, two sockets: pairing, presence, a channel, ciphertext only ──
  const { room, state } = makeRoom();
  const computer = await new Computer(room, { name: 'Studio' }).join();
  const phone = await new Phone(room).join();
  const shareId = randomId();
  await computer.share(shareId, { v: 1, project: 'neuron-v2', title: 'Fix the build', status: 'running' });
  assert.deepEqual(phone.device.take(), [], 'an unpaired phone hears nothing of the computer');
  const { code, pairId, answer } = await computer.offer();
  assert.deepEqual(answer, { t: 'pair_offer_ok', pair_id: pairId, expires_at: clock.now + 600_000 });
  assert.ok(!JSON.stringify([...state.storage.map]).includes(code), 'the relay never sees the code');
  await phone.device.say({ t: 'pair', pair_id: pairIdFor(b64u(randomBytes(16))), pub: b64u(randomBytes(32)), proof: 'AAAA', name: 'x' });
  assert.equal(phone.device.last().code, 'pair_not_found');
  await phone.pair(computer, code);
  await computer.serve();
  const pairedFrames = phone.finishPairing();
  assert.deepEqual(pairedFrames.map(frame => frame.t), ['paired', 'host', 'presence']);
  assert.equal(pairedFrames[0].host_id, computer.id);
  assert.deepEqual(pairedFrames[1], { t: 'host', host_id: computer.id, name: 'Studio', online: true });
  const presence = JSON.parse(openBlob(phone.hosts.get(computer.id).presenceKey, `${LABEL} presence|${computer.id}|${shareId}`, pairedFrames[2].sealed));
  assert.equal(presence.title, 'Fix the build', 'presence opens with the key from the pairing secrets');
  assert.deepEqual(Object.keys(state.storage.map.get('pairings')), [`${computer.id}|${phone.id}`], 'the pairing is stored');
  assert.deepEqual(state.storage.map.get('offers'), {}, 'the code is spent');
  const late = await new Phone(room).join();
  await late.pair(computer, code);
  assert.equal(late.device.last().code, 'pair_not_found', 'a code works once');
  await phone.device.say({ t: 'list' });
  assert.deepEqual(phone.device.last().hosts.map(host => [host.host_id, host.name, host.online, host.shares.map(share => share.share_id)]),
    [[computer.id, 'Studio', true, [shareId]]]);
  await late.device.say({ t: 'list' });
  assert.deepEqual(late.device.last(), { t: 'hosts', hosts: [] }, 'only paired computers are listed');

  const ch = await phone.open(computer.id, shareId);
  await computer.serve();
  assert.equal(phone.read()[0].t, 'accept');
  await phone.send(ch, { t: 'hello', protocol: 1, token: '', client: { name: 'Pixel', kind: 'mobile' } });
  await computer.serve();
  assert.equal(JSON.parse(computer.channels.get(ch).inbox[0]).t, 'hello');
  await computer.send(ch, { t: 'snapshot', seq: 7, state: { secret: 'the transcript says hunter2' } });
  await computer.send(ch, { t: 'action', seq: 8, action: { type: 'text_delta', text: 'more plaintext' } });
  phone.read();
  assert.deepEqual(phone.channels.get(ch).inbox.map(frame => frame.seq), [7, 8]);
  await late.device.say({ t: 'open', ch: 'ch-late-000000', host_id: computer.id, share_id: shareId, e: b64u(randomBytes(32)) });
  assert.equal(late.device.last().code, 'not_paired');
  await late.device.say({ t: 'data', ch, n: 0, c: 'AAAA' });
  assert.equal(late.device.last().code, 'unknown_channel', "another phone cannot write into this phone's channel");
  ok('two sockets on one account: pairing by hashed code with proofs both ways, sealed presence, a channel with a checked confirm, sealed frames both ways, unpaired phones refused');

  // ── 3. Resume after the phone's socket drops; a gap means a fresh snapshot ──
  await phone.reconnect();
  assert.deepEqual(computer.device.take().filter(frame => frame.t === 'peer'), [{ t: 'peer', ch, state: 'away' }]);
  for (let index = 0; index < 5; index++) await computer.send(ch, { t: 'action', seq: 9 + index, action: { type: 'text_delta', text: `while away ${index}` } });
  await phone.device.say({ t: 'resume', ch, after: 1 });
  const resumed = phone.read();
  assert.deepEqual(resumed[0], { t: 'resumed', ch, received: 0 }, "the computer got the phone's frame 0");
  assert.deepEqual(phone.channels.get(ch).inbox.map(frame => frame.seq), [7, 8, 9, 10, 11, 12, 13], 'missed frames are replayed in order');
  assert.deepEqual(computer.device.take().filter(frame => frame.t === 'peer'), [{ t: 'peer', ch, state: 'back' }]);
  await phone.device.say({ t: 'resume', ch: 'ch-unknown-0000', after: 3 });
  assert.deepEqual(phone.device.last(), { t: 'resume_failed', ch: 'ch-unknown-0000', code: 'unknown_channel' });
  // More than the buffer holds while the phone is away.
  await phone.reconnect();
  computer.device.take();
  for (let index = 0; index < LIMITS.replayFrames + 3; index++) {
    clock.now += 5;
    await computer.send(ch, { t: 'action', seq: 100 + index, action: { type: 'text_delta', text: 'x' } });
  }
  await phone.device.say({ t: 'resume', ch, after: phone.channels.get(ch).received });
  assert.deepEqual(phone.device.last(), { t: 'resume_failed', ch, code: 'gap' });
  assert.deepEqual(computer.device.take().at(-1), { t: 'close', ch, code: 'lost' });
  ok(`resume: away and back reach the computer, missed frames replay, received tells the phone what to resend, a gap past ${LIMITS.replayFrames} frames ends the channel (resume_failed gap, close lost)`);

  // ── 4. The room restarts (hibernation, deploy): stored state survives, buffers do not ──
  const ch2 = await phone.open(computer.id, shareId);
  await computer.serve();
  phone.read();
  const ch3 = await phone.open(computer.id, shareId);
  await computer.serve();
  phone.read();
  await phone.device.drop();
  await computer.send(ch2, { t: 'pong' }); // missed while away, then lost with the room's memory
  const live = new RelayRoom(state, {}, { ...roomOptions(() => clock.now), push: async () => {} });
  await live.ready;
  assert.deepEqual([...live.channels.keys()].sort(), [ch2, ch3].sort(), 'channels are restored');
  assert.equal(live.paired(computer.id, phone.id), true, 'pairings are restored');
  assert.equal(live.shares.get(computer.id).has(shareId), true, 'presence is restored');
  assert.equal(live.online(computer.id), true, 'the computer is still connected');
  phone.device.room = live;
  computer.device.room = live;
  await phone.join();
  await phone.device.say({ t: 'resume', ch: ch2, after: -1 });
  assert.deepEqual(phone.device.last(), { t: 'resume_failed', ch: ch2, code: 'gap' }, 'frames sent while away were in the lost buffer');
  await phone.device.say({ t: 'resume', ch: ch3, after: -1 });
  assert.deepEqual(phone.device.last(), { t: 'resumed', ch: ch3, received: -1 }, 'nothing was missed on the other channel');
  computer.device.take();
  ok('a restarted room keeps devices, pairings, presence and channels; a channel whose missed frames were only in memory falls back to a snapshot');

  // ── 5. Push: contentless notify, delay, dedupe, quiet while attached ──
  {
    const pushed = [];
    live.push = async (_env, userId, message) => { pushed.push({ userId, ...message }); };
    const otherShare = randomId();
    await computer.share(otherShare, { v: 1, status: 'idle' });
    await computer.device.say({ t: 'notify', share_id: otherShare, kind: 'finished' });
    assert.deepEqual(pushed, [{ userId: USER_A, kind: 'finished', host_id: computer.id, host_name: 'Studio', share_id: otherShare, phone_ids: [phone.id] }]);
    await computer.device.say({ t: 'notify', share_id: otherShare, kind: 'finished' });
    assert.equal(pushed.length, 1, `the same push at most once in ${NOTIFY_DEDUPE_MS / 1000} s`);
    await computer.device.say({ t: 'notify', share_id: otherShare, kind: 'needs_me' });
    assert.ok(await live.state.storage.getAlarm() <= clock.now + NEEDS_ME_DELAY_MS, 'needs_me waits for an alarm');
    clock.now += 10_000;
    await live.alarm();
    assert.equal(pushed.length, 1, 'not before 30 s');
    clock.now += NEEDS_ME_DELAY_MS;
    await live.alarm();
    assert.equal(pushed.at(-1).kind, 'needs_me');
    clock.now += NOTIFY_DEDUPE_MS;
    await computer.device.say({ t: 'notify', share_id: otherShare, kind: 'needs_me' });
    const watching = await phone.open(computer.id, otherShare);
    await computer.serve();
    phone.read();
    clock.now += NEEDS_ME_DELAY_MS;
    await live.alarm();
    assert.equal(pushed.length, 2, 'a phone attached in time: no push');
    await computer.device.say({ t: 'notify', share_id: otherShare, kind: 'finished' });
    assert.equal(pushed.length, 2, 'quiet while a phone is attached');
    await computer.device.say({ t: 'notify', share_id: otherShare, kind: 'shout' });
    assert.equal(computer.device.last().code, 'bad_frame');
    await phone.device.say({ t: 'close', ch: watching });
    assert.deepEqual(computer.device.take().at(-1), { t: 'close', ch: watching });
    ok('push: finished at once, needs_me after 30 s, deduplicated per session and kind, cancelled by a phone attaching, quiet while attached, only to paired phones');
  }

  // ── 6. Phones away too long, the computer leaving, unpairing ──
  {
    const away = await phone.open(computer.id, shareId);
    await computer.serve();
    phone.read();
    await phone.device.drop();
    computer.device.take();
    clock.now += LIMITS.channelAwayMs;
    await live.alarm();
    assert.deepEqual(computer.device.take().filter(frame => frame.ch === away).at(-1), { t: 'close', ch: away, code: 'phone_gone' });
    assert.equal(live.channels.has(away), false);
    await phone.join();
    const kept = await phone.open(computer.id, shareId);
    await computer.serve();
    phone.read();
    await computer.device.drop();
    assert.deepEqual(phone.device.take(), [{ t: 'close', ch: kept, code: 'host_gone' }, { t: 'host', host_id: computer.id, name: 'Studio', online: false }]);
    await phone.device.say({ t: 'open', ch: 'ch-offline-000', host_id: computer.id, share_id: shareId, e: b64u(randomBytes(32)) });
    assert.equal(phone.device.last().code, 'host_offline');
    await computer.join();
    assert.deepEqual(phone.device.take(), [{ t: 'host', host_id: computer.id, name: 'Studio', online: true }]);
    await phone.device.say({ t: 'list' });
    assert.deepEqual(phone.device.last().hosts[0].shares, [], 'a returning computer shares again before phones see its sessions');
    await phone.device.say({ t: 'unpair', host_id: computer.id });
    assert.deepEqual(computer.device.take().at(-1), { t: 'unpaired', phone_id: phone.id });
    assert.equal(live.paired(computer.id, phone.id), false);
    await phone.device.say({ t: 'open', ch: 'ch-unpaired-00', host_id: computer.id, share_id: shareId, e: b64u(randomBytes(32)) });
    assert.equal(phone.device.last().code, 'not_paired');
    ok('a phone away 10 minutes ends its channels (phone_gone), a leaving computer ends its channels (host_gone) and goes offline, unpairing tells the computer');
  }

  // ── 7. Revoking a session closes its sockets (4401) ──
  {
    const { room: revocable } = makeRoom();
    const signedIn = await new Phone(revocable, { session: 'aaaaaaaaaaaaaaaaaaaaaaaa' }).join();
    const website = await new Phone(revocable).join();
    const cli = await new Computer(revocable, { session: 'cccccccccccccccccccccccc' }).join();
    assert.equal(await revocable.revoke({ sessions: ['bbbbbbbbbbbbbbbbbbbbbbbb'] }), 0);
    assert.equal(await revocable.revoke({ sessions: ['aaaaaaaaaaaaaaaaaaaaaaaa'] }), 1);
    assert.equal(signedIn.device.socket.closeCode, CLOSE.unauthorized);
    assert.equal(JSON.parse(signedIn.device.socket.sent.at(-1)).code, 'session_revoked');
    assert.equal(website.device.socket.closed, false, 'sockets opened with a website token stay open');
    assert.equal(await revocable.revoke({ all_sessions: true }), 1, 'revoke-all closes every CLI-session socket');
    assert.equal(cli.device.socket.closeCode, CLOSE.unauthorized);
    assert.equal(website.device.socket.closed, false);
    assert.equal(revocable.onlineDevices('host').length, 0, 'a revoked computer is offline at once');
    ok('revoking a session closes its relay sockets (4401, session_revoked); revoke-all closes CLI-session sockets only');
  }

  // ── 8. Tickets are single use and bound to a role ──
  {
    const { room: ticketed } = makeRoom();
    const ticket = { hash: sha('rt_x'), expires: clock.now + 60_000 };
    assert.equal(await ticketed.useTicket(ticket), true);
    assert.equal(await ticketed.useTicket(ticket), false);
    assert.equal(await ticketed.useTicket({ hash: sha('rt_y'), expires: clock.now - 1 }), false);
    const wrongRole = await new Device(ticketed, { ticketRole: 'phone' }).connect();
    await wrongRole.say({ t: 'join', role: 'host', device: { id: randomId(), name: 'x', platform: 'linux' } });
    assert.equal(wrongRole.socket.closeCode, CLOSE.unauthorized, 'a phone ticket cannot join as a computer');
    ok('connection tickets are single use, expire, and are bound to a role');
  }

  // ── 9. No plaintext crossed the relay; frame shapes match the apps' parser ──
  {
    const everything = wire.join('\n');
    for (const secret of ['hunter2', 'more plaintext', 'while away', 'Fix the build', '"hello"', code]) {
      assert.ok(!everything.includes(secret), `"${secret}" never crossed the relay`);
    }
    assert.equal(parseDeviceFrame('{"t":"data","ch":"short","n":0,"c":"x"}', 'phone'), null, 'ids are 8-64 characters');
    assert.equal(parseDeviceFrame('{"t":"data","ch":"channel-1","n":-1,"c":"x"}', 'phone'), null);
    assert.equal(parseDeviceFrame('{"t":"resume","ch":"channel-1","after":-1}', 'phone').after, -1);
    assert.equal(parseDeviceFrame('{"t":"share","share_id":"share-001","sealed":null}', 'phone'), null, 'phones cannot share');
    assert.equal(parseDeviceFrame('{"t":"pair_offer","pair_id":"abc","ttl_s":9999}', 'host').ttl_s, LIMITS.pairTtlMaxS);
    ok("no plaintext, code or presence crossed the relay; frames are checked like the apps' parseDeviceFrame");
  }

  // ── 10. Worker routes: subprotocol or header credentials, refusals as close codes, isolation ──
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
        const target = rooms.get(id.name);
        return {
          fetch: async (input, init) => {
            const request = input instanceof Request ? input : new Request(input, init);
            if (new URL(request.url).pathname === '/connect') {
              forwarded.push({ name: id.name, headers: Object.fromEntries(request.headers) });
              const result = await target.fetch(request);
              return result.status === 101 ? new Response('upgraded', { status: 200, headers: { 'x-upgraded': 'true', ...result.headers } }) : result;
            }
            return target.fetch(request);
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
    const protocols = token => ({ ...upgrade, 'Sec-WebSocket-Protocol': `neuron-relay.v1, neuron-auth.${token}` });
    const alice = await (await call('/auth/cli/session', { method: 'POST', token: devToken('alice.relay@example.test'), body: { device_name: 'laptop' } })).json();
    const bob = await (await call('/auth/cli/session', { method: 'POST', token: devToken('bob.relay@example.test'), body: {} })).json();
    const apiKey = await (await call('/api/keys', { method: 'POST', token: devToken('alice.relay@example.test'), body: { name: 'ci' } })).json();

    // Refusals are an accepted upgrade closed with a code (the Workers runtime), or its status (Node).
    const RealResponse = globalThis.Response;
    class UpgradeResponse extends RealResponse {
      constructor(body, init = {}) {
        super(body, init.status === 101 ? { ...init, status: 200 } : init);
        if (init.webSocket) Object.defineProperty(this, 'webSocket', { value: init.webSocket });
      }
    }
    const refusals = [];
    globalThis.WebSocketPair = class { constructor() { const server = fakeSocket(); server.accept = () => {}; refusals.push(server); this[0] = fakeSocket(); this[1] = server; } };
    globalThis.Response = UpgradeResponse;
    let response;
    try {
      response = await call('/v1/relay', { headers: { ...upgrade, 'Sec-WebSocket-Protocol': 'neuron-relay.v1' } });
      assert.ok(response.webSocket, 'no credential: the upgrade is accepted');
      assert.equal(refusals.at(-1).closeCode, CLOSE.unauthorized, 'and closed with 4401');
      assert.equal(response.headers.get('sec-websocket-protocol'), 'neuron-relay.v1');
      await call('/v1/relay', { headers: protocols('ses_nobodyhasthistokenatall') });
      assert.equal(refusals.at(-1).closeCode, CLOSE.unauthorized, 'an unknown session: 4401');
      await call('/v1/relay', { headers: protocols(apiKey.secret) });
      assert.equal(refusals.at(-1).closeCode, CLOSE.forbidden, 'API keys: 4403');
      await call('/v1/relay?ticket=rt_nope', { headers: upgrade });
      assert.equal(refusals.at(-1).closeCode, CLOSE.unauthorized, 'a bad ticket: 4401');
    } finally {
      globalThis.Response = RealResponse;
      delete globalThis.WebSocketPair;
    }
    assert.equal((await call('/v1/relay', { headers: upgrade })).status, 401, 'without WebSocketPair (Node) the refusal is its status');

    assert.equal((await call('/v1/relay', { headers: { 'Sec-WebSocket-Protocol': `neuron-auth.${alice.session_token}` } })).status, 426, 'not a WebSocket');
    response = await call('/v1/relay', { headers: protocols(alice.session_token) });
    assert.equal(response.headers.get('x-upgraded'), 'true');
    assert.equal(response.headers.get('sec-websocket-protocol'), 'neuron-relay.v1', 'the relay subprotocol is echoed');
    const aliceRoomName = `user:${alice.user_id}`;
    const first = forwarded.at(-1);
    assert.equal(first.name, aliceRoomName, "the socket goes to the caller's own room");
    assert.equal(first.headers['x-relay-user'], alice.user_id);
    assert.equal(first.headers['x-relay-session'], await sessionId(sha(alice.session_token)));
    assert.equal(first.headers['x-relay-subprotocol'], 'neuron-relay.v1');
    assert.equal(first.headers.authorization, undefined, 'the credential is not passed on');
    assert.equal(first.headers['sec-websocket-protocol'], undefined, 'nor the subprotocol that carries it');
    const aliceRoom = rooms.get(aliceRoomName);
    const aliceComputer = new Computer(aliceRoom, { user: alice.user_id });
    aliceComputer.device.adopt(aliceRoom.state.getWebSockets().at(-1));
    await aliceComputer.join({ connect: false });
    assert.equal(aliceComputer.joined.account.tag, await accountTag(alice.user_id));

    await call('/v1/relay', { token: bob.session_token, headers: upgrade });
    assert.equal(forwarded.at(-1).name, `user:${bob.user_id}`, 'a native client may use the Authorization header');
    assert.equal(forwarded.at(-1).headers['x-relay-subprotocol'], undefined);
    const bobRoom = rooms.get(`user:${bob.user_id}`);
    const bobPhone = new Phone(bobRoom, { user: bob.user_id });
    bobPhone.device.adopt(bobRoom.state.getWebSockets().at(-1));
    await bobPhone.join({ connect: false });
    assert.notEqual(bobPhone.joined.account.tag, aliceComputer.joined.account.tag, 'another account has another tag');

    // Alice's computer and phone pair in her room; Bob's phone in his cannot pair, attach or write.
    const alicePhone = await new Phone(aliceRoom, { user: alice.user_id }).join();
    const aliceShare = randomId();
    await aliceComputer.share(aliceShare, { v: 1, status: 'idle' });
    const aliceChannel = await pairAndOpen(aliceComputer, alicePhone, aliceShare);
    assert.ok(alicePhone.channels.get(aliceChannel).keys, "Alice's phone attached to her computer");
    const { code: aliceCode } = await aliceComputer.offer();
    await bobPhone.pair(aliceComputer, aliceCode);
    assert.equal(bobPhone.device.last().code, 'pair_not_found', "another account cannot use this account's code");
    await bobPhone.device.say({ t: 'open', ch: 'ch-bob-0000000', host_id: aliceComputer.id, share_id: aliceShare, e: b64u(randomBytes(32)) });
    assert.equal(bobPhone.device.last().code, 'not_paired', "nor attach to this account's computer");
    await bobPhone.device.say({ t: 'data', ch: aliceChannel, n: 0, c: 'AAAA' });
    assert.equal(bobPhone.device.last().code, 'unknown_channel', "nor write into this account's channel");
    await bobPhone.device.say({ t: 'list' });
    assert.deepEqual(bobPhone.device.last().hosts, []);
    assert.deepEqual((await (await call('/relay/v1/hosts', { token: bob.session_token })).json()).hosts, []);
    assert.deepEqual((await (await call('/relay/v1/hosts', { token: alice.session_token })).json()).hosts.map(host => [host.host_id, host.online]), [[aliceComputer.id, true]]);

    // Browsers may use a single-use ticket bound to a role.
    const ticket = await (await call('/relay/v1/ticket', { method: 'POST', token: alice.session_token, body: { role: 'phone' } })).json();
    assert.match(ticket.ticket, /^rt_[A-Za-z0-9_-]{43}$/);
    assert.equal(ticket.role, 'phone');
    const stash = new Map(records);
    response = await call(`/v1/relay?ticket=${ticket.ticket}`, { headers: upgrade });
    assert.equal(response.headers.get('x-upgraded'), 'true');
    assert.equal(forwarded.at(-1).headers['x-relay-ticket-role'], 'phone');
    assert.equal(forwarded.at(-1).headers['x-relay-session'], await sessionId(sha(alice.session_token)), 'the ticket keeps the session for revocation');
    for (const [k, v] of stash) records.set(k, v); // replay the deleted KV record: the room still refuses
    assert.equal((await call(`/v1/relay?ticket=${ticket.ticket}`, { headers: upgrade })).status, 401, 'a ticket works once');
    assert.equal((await call('/relay/v1/ticket', { method: 'POST', token: alice.session_token, body: { role: 'admin' } })).status, 400);
    assert.equal((await call('/relay/v1/ticket', { method: 'POST', token: apiKey.secret, body: { role: 'phone' } })).status, 403);

    // Signing out a device closes its relay sockets; DELETE /api/sessions/current is the phone's sign-out.
    const sessions = (await (await call('/api/sessions', { token: alice.session_token })).json()).sessions;
    response = await call(`/api/sessions/${sessions.find(s => s.current).id}`, { method: 'DELETE', token: devToken('alice.relay@example.test') });
    assert.equal(response.status, 200);
    assert.equal(aliceComputer.device.socket.closeCode, CLOSE.unauthorized, "the revoked session's computer socket is closed");
    const phoneSession = await (await call('/auth/cli/session', { method: 'POST', token: devToken('alice.relay@example.test'), body: { device_name: 'Pixel' } })).json();
    await call('/v1/relay', { headers: protocols(phoneSession.session_token) });
    const phoneSocket = aliceRoom.state.getWebSockets().at(-1);
    response = await call('/api/sessions/current', { method: 'DELETE', token: phoneSession.session_token });
    assert.deepEqual(await response.json(), { status: 'revoked', current: true });
    assert.equal(phoneSocket.closeCode, CLOSE.unauthorized, 'signing out from the phone closes its socket');
    assert.equal((await call('/api/account', { token: phoneSession.session_token })).status, 401, 'and the session is gone');
    assert.equal((await call('/api/sessions/current', { method: 'DELETE', token: devToken('alice.relay@example.test') })).status, 400,
      'current is for Neuron sessions');

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
    response = await call('/v1/relay', { headers: { ...protocols(bob.session_token), Origin: 'https://zero-x.live' }, bindings: { ...env, RELAY: immutableUpgrade } });
    assert.equal(response.status, 200, 'the upgrade passes through untouched');
    assert.ok(response.webSocket, 'with its WebSocket');

    // relay.zero-x.live serves the relay and nothing else.
    const relayHost = path => app.request(`https://relay.zero-x.live${path}`, { headers: protocols(bob.session_token) }, env);
    assert.equal((await relayHost('/v1/relay')).headers.get('x-upgraded'), 'true');
    assert.equal((await relayHost('/')).status, 404);
    assert.equal((await relayHost('/api/account')).status, 404);
    assert.equal((await relayHost('/health')).status, 200);

    // Without the binding (Node server, API-only Worker) the relay says so.
    response = await call('/v1/relay', { headers: protocols(bob.session_token), bindings: { ...env, RELAY: undefined } });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'relay_unavailable');
    assert.equal((await call('/relay/v1/host', { token: bob.session_token, headers: upgrade })).status, 404, 'the old endpoints are gone');
    ok('Worker: subprotocol, header or ticket credentials, refusals as 4401/4403 close codes, the subprotocol echoed and the credential kept back, per-account rooms (another account gets pair_not_found, not_paired, unknown_channel), sign-out closes sockets, relay host, 503 without the binding');

    // ── 11. Push registrations and delivery ──
    const owner = alice.user_id;
    const token = (n = 'A') => `ExponentPushToken[${n.repeat(22)}]`;
    const fresh = await (await call('/auth/cli/session', { method: 'POST', token: devToken('alice.relay@example.test'), body: {} })).json();
    const register = (body, as = fresh.session_token) => call('/api/push/devices', { method: 'POST', token: as, body });
    response = await register({ device_id: 'phone-aaaaaaaa', expo_push_token: token('A'), platform: 'ios', needs_me: true, finished: false });
    assert.deepEqual(await response.json(), { status: 'registered' });
    for (const body of [{ device_id: 'short', expo_push_token: token('B'), platform: 'ios' }, { device_id: 'phone-bbbbbbbb', expo_push_token: 'nope', platform: 'ios' },
      { device_id: 'phone-bbbbbbbb', expo_push_token: token('B'), platform: 'web' }, { device_id: 'phone-bbbbbbbb', expo_push_token: token('B'), platform: 'ios', needs_me: 'yes' }]) {
      assert.equal((await register(body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await register({ device_id: 'phone-bbbbbbbb', expo_push_token: token('B'), platform: 'ios' }, apiKey.secret)).status, 403, 'API keys cannot register phones');
    await register({ device_id: 'phone-cccccccc', expo_push_token: token('C'), platform: 'android' });
    await register({ device_id: 'phone-dddddddd', expo_push_token: token('D'), platform: 'android' });
    const listed = (await (await call('/api/push/devices', { token: fresh.session_token })).json()).devices;
    assert.deepEqual(listed.map(device => [device.device_id, device.needs_me, device.finished]).sort(),
      [['phone-aaaaaaaa', true, false], ['phone-cccccccc', true, true], ['phone-dddddddd', true, true]]);
    assert.ok(!JSON.stringify(listed).includes('ExponentPushToken'), 'the token is never returned');
    // Registering again replaces the phone's token.
    await register({ device_id: 'phone-dddddddd', expo_push_token: token('E'), platform: 'android' });
    assert.deepEqual((await rpcRows(pgEnv, 'zerox_push_device_targets', { p_user_id: owner, p_device_ids: ['phone-dddddddd'] })).map(row => row.token), [token('E')]);

    const sentBatches = [];
    const expo = async (url, init) => {
      assert.equal(url, EXPO_PUSH_URL);
      const messages = JSON.parse(init.body);
      sentBatches.push(messages);
      return Response.json({ data: messages.map(message => message.to === token('C')
        ? { status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered' } } : { status: 'ok', id: 'ticket' }) });
    };
    const notice = { host_id: 'host-0001', host_name: 'studio', share_id: 'share-0001' };
    let result = await sendPush(pgEnv, owner, { ...notice, kind: 'needs_me', phone_ids: ['phone-aaaaaaaa', 'phone-cccccccc'] }, { fetchImpl: expo });
    assert.deepEqual(result, { sent: 1, failed: 1, removed: 1 });
    assert.deepEqual(sentBatches[0].map(message => message.to).sort(), [token('A'), token('C')].sort(), 'only the paired phones, not phone-dddddddd');
    assert.equal(sentBatches[0][0].body, pushMessage('needs_me', 'studio').body);
    assert.equal(sentBatches[0][0].body, 'A session on studio is waiting for your answer.');
    assert.deepEqual(sentBatches[0][0].data, { neuron: { host_id: 'host-0001', share_id: 'share-0001', kind: 'needs_me' } }, 'no session content in a push');
    assert.equal(sentBatches[0][0].channelId, 'needs-me');
    assert.equal((await rpcRows(pgEnv, 'zerox_push_device_targets', { p_user_id: owner, p_device_ids: ['phone-cccccccc'] })).length, 0, 'unregistered phones are forgotten');
    result = await sendPush(pgEnv, owner, { ...notice, kind: 'finished', phone_ids: ['phone-aaaaaaaa'] }, { fetchImpl: expo });
    assert.deepEqual(result, { sent: 0, failed: 0, removed: 0 }, 'the iPhone turned "finished" off');
    await sendPush(pgEnv, owner, { ...notice, kind: 'finished', phone_ids: ['phone-dddddddd'] }, { fetchImpl: expo });
    assert.equal(sentBatches.at(-1)[0].body, 'A session on studio finished its turn.');
    assert.equal(sentBatches.at(-1)[0].channelId, 'finished');
    result = await sendPush(pgEnv, owner, { ...notice, kind: 'needs_me', phone_ids: ['phone-aaaaaaaa'] }, { fetchImpl: async () => new Response('down', { status: 503 }) });
    assert.deepEqual(result, { sent: 0, failed: 1, removed: 0 });
    assert.deepEqual(await sendPush(pgEnv, owner, { ...notice, kind: 'needs_me', phone_ids: [] }, { fetchImpl: expo }), { sent: 0, failed: 0, removed: 0 });
    // A phone that signs in to another account moves its token there.
    await register({ device_id: 'phone-aaaaaaaa', expo_push_token: token('A'), platform: 'ios' }, bob.session_token);
    assert.equal((await rpcRows(pgEnv, 'zerox_push_device_targets', { p_user_id: owner, p_device_ids: ['phone-aaaaaaaa'] })).length, 0);
    assert.equal((await rpcRows(pgEnv, 'zerox_push_device_targets', { p_user_id: bob.user_id, p_device_ids: ['phone-aaaaaaaa'] })).length, 1);
    response = await call('/api/push/devices/phone-aaaaaaaa', { method: 'DELETE', token: fresh.session_token });
    assert.deepEqual(await response.json(), { status: 'removed' });
    assert.equal((await rpcRows(pgEnv, 'zerox_push_device_targets', { p_user_id: bob.user_id, p_device_ids: ['phone-aaaaaaaa'] })).length, 1, "another account's phone is untouched");
    assert.equal((await call('/api/push/devices/phone-aaaaaaaa', { method: 'DELETE', token: bob.session_token })).status, 200);
    assert.equal((await rpcRows(pgEnv, 'zerox_push_device_targets', { p_user_id: bob.user_id, p_device_ids: ['phone-aaaaaaaa'] })).length, 0);
    assert.equal((await call('/api/push/devices/x', { method: 'DELETE', token: bob.session_token })).status, 400);
    for (let index = 0; index < 12; index++) {
      await rpc(pgEnv, 'zerox_push_device_register', { p_user_id: owner, p_device_id: `phone-${String(index).padStart(8, '0')}`,
        p_token: token(String.fromCharCode(70 + index)), p_platform: 'android' });
    }
    assert.equal((await rpcRows(pgEnv, 'zerox_push_device_list', { p_user_id: owner })).length, 10, 'at most 10 phones per account');
    ok('push devices: register by relay device id (token never returned, replaced on re-register), validation, API keys refused, delivery only to the paired phones with the switch on, DeviceNotRegistered pruned, phones move between accounts, 10 per account');
  }
} finally {
  await closeAllPglite();
}

console.log(`PASS: relay and push (${passed.length} groups): neuron-relay/1 join and limits, pairing with proofs, sealed channels, resume and gaps, restart, push delay and dedupe, revocation, tickets, account isolation, Worker credentials and close codes, push devices on Postgres`);

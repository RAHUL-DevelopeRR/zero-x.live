# Neuron relay and push (protocol 1)

The relay lets a phone or a browser reach a Neuron engine on the user's computer from anywhere,
with no inbound port on the computer (feature-parity plan rows A11, A12, M1–M4, D26; design in
`neuron-apps-wt/docs/NEURON_APPS_PLAN.md` §5). Code: `src/relay.js` (the `RelayRoom` Durable
Object), `src/routes/relay.js` (Worker entry points), `src/push.js` and `src/routes/push.js`.
Tests: `check-relay.mjs`.

## 1. Shape

- One `RelayRoom` Durable Object per Zero-X account (`idFromName('user:<user_id>')`). A socket is
  handed to the room only after the Worker authenticated it as that account, so sockets of two
  accounts can never meet.
- **Hosts** are computers running the engine with sharing on (`neuron --share`, WP1 R1).
  **Clients** are the phone app (WP4) or a browser.
- The relay routes frames by a small JSON envelope and **never reads `data`**: host and client
  encrypt it end to end (section 4). Frames are never written to storage; the only stored data is
  the registry of the account's computers (id, name, public key, last seen), the account id, the
  pending-notification state and used-ticket hashes.
- WebSocket hibernation: idle rooms cost nothing. `{"type":"ping"}` is answered with
  `{"type":"pong"}` without waking the room.

## 2. Connecting

| Endpoint | Use |
|---|---|
| `GET wss://zero-x.live/relay/v1/host` | WebSocket for a computer |
| `GET wss://zero-x.live/relay/v1/client` | WebSocket for a phone or browser |
| `POST /relay/v1/ticket {role:'host'\|'client'}` | `{ticket, role, expires_at}`: a 60-second, single-use ticket, for browsers |
| `GET /relay/v1/hosts` | `{hosts:[{host_id, name, public_key, online, last_seen_at}]}` |

- Authenticate the upgrade with `Authorization: Bearer <ses_… CLI session or website token>`.
  Browsers cannot set headers on a WebSocket: they get a ticket with a normal `fetch` and connect
  to `…/client?ticket=rt_…`. Tickets are bound to the account, the role and the session, expire
  after 60 s and work once (the room remembers used ones). Long-lived tokens never go in a URL.
- `nzx_` API keys are refused (`403 api_key_not_allowed`): an API key must never be able to drive
  someone's computer.
- Signing out a device (`DELETE /api/sessions/:id`) or every device (`POST /api/sessions/revoke-all`)
  closes the relay sockets opened with those CLI sessions (close code 4403). Clients must not
  reconnect after 4403; they ask the user to sign in again.
- Without the `RELAY` binding (the Worker as deployed now, the Node server, the API-only Worker)
  every relay route answers `503 relay_unavailable`.

## 3. Frames

JSON text frames, at most 1 MB each. The first frame from the relay is
`{type:'welcome', protocol:1, role, client_id?, hosts?}` (clients get their id and the hosts list).

**Host → relay**
- `{type:'register', name, public_key, host_id?}`: first frame. `public_key` is the host's X25519
  public key (32 bytes, base64url without padding). Without `host_id` the relay creates
  `h_<16 hex>`; with it, the computer reconnects as itself (the key must be unchanged: a new key
  is a new pairing). Answer: `{type:'registered', host_id, epoch, clients:[client_id]}`. A second
  socket registering the same `host_id` replaces the first (close 4409). At most 10 computers are
  registered per account; the least recently seen offline one is dropped.
- `{type:'frame', data, to?}`: `to` omitted or `'*'` broadcasts to every attached client and gets a
  `seq`; `to:'c_…'` goes to one client with no `seq` (for answers to one client).
- `{type:'notify', kind:'needs_input'|'finished'|'resolved'}`: content-free push trigger (section 5).

**Client → relay**
- `{type:'attach', host_id, epoch?, since?}`: follow one computer. Answer
  `{type:'attached', host_id, online, epoch, seq}`. With `epoch` and `since`, the relay first
  replays the broadcast frames after `since` from its memory-only buffer (last 500 frames or 4 MB per
  computer), or sends `{type:'replay_gap', host_id, epoch}` when they are gone or the epoch changed.
  After a gap, ask the host for a snapshot (inside the encrypted channel).
- `{type:'frame', data}`: to the attached computer; it arrives as `{type:'frame', from:'c_…', data}`.
- `{type:'detach'}`.

**Relay → both**
- `{type:'frame', from:'host', host_id, epoch, seq, data}` (broadcast) or without `epoch`/`seq`
  (directed).
- `{type:'presence', host_id, online, epoch?}` to clients when their computer connects or leaves.
- `{type:'client', event:'attached'|'detached', client_id}` to the host.
- `{type:'error', code, message, fatal}`; fatal errors close the socket.

`epoch` changes every time a computer registers, and `seq` counts its broadcast frames within the
epoch, so (`epoch`, `seq`) identifies a frame for resuming (M4).

| Close code | Meaning |
|---|---|
| 4400 | malformed frame (not a JSON object, bad register) |
| 4403 | the session was signed out |
| 4404 | `host_id` unknown on this account |
| 4409 | the same computer connected again |
| 4413 | frame over 1 MB |
| 4429 | too many computers registered |
| HTTP 429 | more than 3 computers or 5 clients connected at once |

Each socket may send 50 frames a second (bursts of 200); extra frames get `rate_limited`.

## 4. End-to-end encryption (clients' job)

The relay sees only envelopes. Pairing (M1, D26): the computer shows a QR code with its
`public_key`, its `host_id` and a one-time code. The phone checks that the key from the QR code
matches `GET /relay/v1/hosts` (the QR code is the trust anchor; a different key there means do not
pair), derives a shared key with X25519 and HKDF-SHA256 (salt: the one-time code, info:
`neuron-relay-v1`), and seals each `data` with XChaCha20-Poly1305 (random 24-byte nonce
prepended). Inside, the frames are remote protocol 1 (`ui/neuron-client/src/remote.ts`).

## 5. Push notifications (A12)

Phones register their Expo push token:

- `POST /api/push/tokens {token:'ExponentPushToken[…]', platform:'ios'|'android', device_name?,
  notify?:{needs_input?, finished?}}` → `201 {token:{id, platform, device_name, notify, created_at,
  updated_at, last_sent_at}}`. Registering again updates the switches; a token registered by
  another account moves to it. At most 10 per account.
- `GET /api/push/tokens`, `DELETE /api/push/tokens/:id`. The token itself is never returned.
- Website and CLI sign-ins only (API keys get 403).

The host sends `notify` frames, never content:

- `finished`: pushed at once if no client is attached to that computer.
- `needs_input` (an approval or a question is waiting): pushed after 30 s if still no client is
  attached; cancelled by `resolved` (answered on the computer) or by a client attaching.
- The same kind is pushed at most once a minute per computer, and never while a client is attached.

Pushes go through `https://exp.host/--/api/v2/push/send` with a fixed text ("A session on
<computer name> is waiting for your answer." / "… finished its task."), the push `data`
`{kind, host_id}` and no session content. Tokens Expo reports as `DeviceNotRegistered` are deleted.
The optional Worker secret `EXPO_ACCESS_TOKEN` is needed only if the Expo project turns on
enhanced push security.

## 6. Deploying

- Not bound for now (owner decision, 2026-10-30): `wrangler.toml` has no `RELAY` binding and no
  migration that creates `RelayRoom`, and `src/index.js` does not export the class, so the Worker
  answers `503 relay_unavailable` on every relay route. The relay comes later on the Node server.
  Binding it on the Worker again takes all three: the export, the binding and a new
  `[[migrations]]` tag with `new_sqlite_classes = ["RelayRoom"]` (`check-relay.mjs` checks they agree).
- Apply `migrations/20261029000100_push_tokens.sql` (and `20261029000000_session_devices.sql`)
  before deploying, like every migration (see `deploy.yml`).
- Optional later: a `relay.zero-x.live` custom domain routed to the same Worker paths.

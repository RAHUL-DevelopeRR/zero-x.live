# Neuron relay and push (`neuron-relay/1`)

The relay lets the Neuron phone app reach a Neuron session on the user's computer from anywhere,
with no inbound port on the computer (feature-parity plan rows A11, A12, M1–M4, D26). It speaks
`neuron-relay/1`, the contract the apps implement: neuron-v2 `ui/neuron-mobile/docs/RELAY_CONTRACT.md`
(frame shapes in `src/relay/contract.ts`, cryptography and test vectors in `src/relay/crypto.ts`).
This page is the gateway's side of it. Code: `src/relay.js` (the `RelayRoom` Durable Object),
`src/routes/relay.js` (Worker entry points), `src/push.js` and `src/routes/push.js`. Tests:
`check-relay.mjs`, which drives the room with a computer and phones doing the apps' real
cryptography (checked against the contract's vectors first).

## 1. Shape

```
 phone ──wss──▶ relay (one room per Zero-X account) ◀──wss── computer ──loopback──▶ session host
        sealed data frames, routing headers only          (neuron engine --share)
```

- One `RelayRoom` Durable Object per Zero-X account (`idFromName('user:<user_id>')`). A socket is
  handed to the room only after the Worker authenticated it as that account, so devices of two
  accounts never meet: a device on another account gets `pair_not_found`, `not_paired` or
  `unknown_channel` for anything of this one.
- Each device keeps **one WebSocket**: the phone for all its paired computers, the computer for
  every session it shares. Inside a **channel** (one phone attached to one shared session) phone
  and computer run remote protocol 1, sealed end to end with X25519, HKDF-SHA256 and AES-256-GCM.
  The relay sees channel ids, counters, device ids, sizes and times; never a key or plaintext.
- Pairing goes by `pair_id`, a hash of the one-time code in the QR. The relay never sees the code,
  so it cannot pair in a phone's place, and the QR carries the computer's key, so it cannot sit in
  the middle either.
- **Stored** (Durable Object storage, so it outlives hibernation and restarts): the account id,
  the account's devices (id, role, name, platform, last seen; at most 10 computers and 10 phones,
  the least recently seen offline one goes first), pairings, pairing offers, each shared session's
  sealed presence blob, the routing state of open channels (ids, the last phone counter, away
  since), pending pushes and used-ticket hashes. **Memory only:** the replay buffers of sealed
  frames and the rate-limit buckets.
- WebSocket hibernation: the runtime answers the exact text `{"t":"ping"}` with `{"t":"pong"}`
  without waking the room. Every timer (join timeout, phones away too long, delayed pushes) is the
  room's alarm, never `setTimeout`.

## 2. Connecting

| Endpoint | Use |
|---|---|
| `GET wss://relay.zero-x.live/v1/relay` | the WebSocket of a phone or a computer (also served on `zero-x.live`) |
| `POST /relay/v1/ticket {role:'phone'\|'host'}` | `{ticket, role, expires_at}`: a 60-second, single-use ticket |
| `GET /relay/v1/hosts` | `{hosts:[{host_id, name, online, last_seen_at}]}`, the account's computers |

- **Credential:** the client offers two subprotocols, `neuron-relay.v1` and `neuron-auth.<token>`
  (a `ses_` CLI session or a website token). Browsers cannot set headers on a WebSocket, and the
  Worker needs the account before it picks the room. Native clients may send
  `Authorization: Bearer ses_…` instead; a browser may also use `?ticket=rt_…` (bound to the
  account, the role and the session; 60 s; once).
- The Worker answers with `Sec-WebSocket-Protocol: neuron-relay.v1` and passes the room the account
  id, the session id (for revocation) and the ticket's role, never the credential itself. Neither
  header nor any frame body is logged.
- **Refusals are close codes:** a missing, unknown or expired session gets the upgrade and then
  close `4401`; an `nzx_` API key or a suspended account `4403`. A plain HTTP 401 would look like a
  network error to a browser, which would retry instead of asking the user to sign in. (The Node
  server has no WebSockets: it answers 401/403.) Without the `RELAY` binding the relay answers
  `503 relay_unavailable`; when the account database is down, `503` so the device retries.
- `relay.zero-x.live` answers only `/v1/relay` and `/health`; everything else is 404 there.
- Signing out a device (`DELETE /api/sessions/:id`, the phone's `DELETE /api/sessions/current`) or
  every device (`POST /api/sessions/revoke-all`) closes the relay sockets opened with those CLI
  sessions: an `error {code: 'session_revoked'}`, then close `4401`.

### 2.1 Close codes

| Code | Meaning | Client |
|---|---|---|
| 4400 | the first frame was not `join`, a device id changed role, or a binary frame | stop: update the app |
| 4401 | no session, or expired, revoked or signed out; a ticket for another role | stop: sign in again |
| 4403 | the credential may not use the relay (API key, suspended account) | stop |
| 4408 | no `join` within 10 s | reconnect |
| 4409 | the same device joined again on another socket | stop (this socket was replaced) |
| 4429 | over a limit: computers or phones online, sockets, frame size (1 MB) or frame rate | reconnect after the longest backoff |

Limits: 3 computers and 5 phones online per account (12 sockets including ones that have not
joined yet), 16 shared sessions per computer, 5 waiting pairing codes per computer (600 s at most),
16 channels per phone. Frame rate per socket: a computer 200 a second (bursts of 1,000, since it
streams every session it shares), a phone 50 (bursts of 200).

## 3. Frames

JSON text, at most 1 MB. Binary values are base64url without padding; ids are 8–64 of
`[A-Za-z0-9_-]`. `parseDeviceFrame` in `src/relay.js` checks every frame with the apps' rules.

**Join.** The first frame is `{"t":"join","role":"host"|"phone","device":{"id","name","platform"}}`.
The answer is `{"t":"joined","relay":1,"role","device_id","account":{"tag"}}`; `tag` is the first
16 hex characters of `SHA-256("neuron-relay/1 account|" ‖ user_id)`, which the pairing QR carries
so a phone can say "different account" before trying. A device id keeps the role it first joined
with. The same device on a new socket replaces the old one (4409).

**Computer → relay**

| Frame | The relay |
|---|---|
| `share {share_id, sealed}` | stores the presence blob and sends `presence` to the computer's paired phones |
| `unshare {share_id}` | forgets it; `presence` with `sealed: null` |
| `pair_offer {pair_id, ttl_s}` | keeps the offer; answers `pair_offer_ok {pair_id, expires_at}` (ms) |
| `pair_cancel {pair_id}` | drops the offer |
| `paired {pair_id, phone_id, proof, sealed}` | stores the pairing, spends the offer, sends the phone `paired {pair_id, host_id, name, proof, sealed}`, then `host` and the computer's `presence` |
| `pair_denied {pair_id, phone_id, code}` | sends the phone `pair_denied {pair_id, code}` |
| `accept {ch, e, confirm}` / `reject {ch, code}` | passes it to the channel's phone; `reject` drops the channel |
| `data {ch, n, c}` | keeps it in the channel's replay buffer; passes it on if the phone is attached |
| `close {ch, code?}` | drops the channel; tells the phone |
| `notify {share_id, kind}` | section 5 |

**Phone → relay**

| Frame | The relay |
|---|---|
| `list` | `hosts {hosts:[{host_id, name, online, shares:[{share_id, sealed, at}]}]}`, paired computers only |
| `pair {pair_id, pub, proof, name}` | passes `pair {pair_id, phone_id, pub, proof, name}` to the offering computer; else `error pair_not_found` (unknown, expired, in use) or `host_offline` |
| `open {ch, host_id, share_id, e}` | needs a pairing (`error not_paired`) and the computer online (`error host_offline`); passes `open {ch, phone_id, share_id, e}` on |
| `resume {ch, after}` | section 4 |
| `data {ch, n, c}` | passes it to the computer and remembers the highest `n` |
| `close {ch}` | drops the channel; tells the computer |
| `unpair {host_id}` | drops the pairing and its channels; tells the computer `unpaired {phone_id}` |

The relay also sends phones `host {host_id, name, online}` when a paired computer joins or leaves,
and computers `peer {ch, state:'away'|'back'}` when a phone's socket drops or resumes. Errors are
`{"t":"error","code","message","ch"?,"pair_id"?}`; `message` is for logs.

## 4. Channels, the replay buffer and resume

- A channel lives from `open` until a `close`, a `reject`, the computer leaving (`close {code:
  'host_gone'}` to the phone) or the phone being away for 10 minutes (`close {code: 'phone_gone'}`
  to the computer). A computer that joins again starts with no channels and no shares: it shares
  again, and phones attach again.
- The relay keeps each channel's last **512 computer-to-phone frames (at most 4 MB)** in memory,
  whether or not the phone is attached.
- After its socket reconnects, the phone sends `resume {ch, after}` (`after` is the last `n` it
  opened, −1 for none). The relay answers `resumed {ch, received}` (the highest phone `n` it passed
  on), replays every buffered frame with `n > after`, and tells the computer `peer back`.
- When the buffer no longer holds `after + 1` (it overflowed, or the room restarted after the
  computer sent frames while the phone was away), the relay drops the channel, tells the computer
  `close {code: 'lost'}` and answers `resume_failed {code: 'gap'}`: the phone opens a new channel
  and the computer's fresh snapshot replaces its state. An unknown channel answers
  `resume_failed {code: 'unknown_channel'}`.

## 5. Push notifications (A12)

Phones register with their relay device id:

- `POST /api/push/devices {device_id, expo_push_token, platform:'ios'|'android', needs_me?, finished?}`
  → `{status:'registered'}`. One row per account and phone: registering again replaces the token
  and the switches, and a token registered by another account or phone moves here. At most 10
  phones per account.
- `GET /api/push/devices` → `{devices:[{device_id, platform, needs_me, finished, created_at,
  updated_at, last_sent_at}]}`; `DELETE /api/push/devices/:device_id` → `{status:'removed'}`. The
  token itself is never returned.
- Website and CLI sign-ins only (API keys get 403).

The computer sends `notify {share_id, kind}` and nothing else: `needs_me` when a session starts
waiting for the user, `finished` when a turn ends. The relay:

- ignores it while any phone is attached to that session;
- pushes `finished` at once, and `needs_me` after **30 s** (an alarm), cancelled if a phone attaches
  first;
- pushes the same session and kind at most once a minute;
- pushes only to the computer's **paired** phones that registered, for the switches they turned on.

Pushes go through `https://exp.host/--/api/v2/push/send` with no session content:

| kind | title | body | Android channel |
|---|---|---|---|
| `needs_me` | Neuron needs you | A session on <computer name> is waiting for your answer. | `needs-me` |
| `finished` | Neuron finished | A session on <computer name> finished its turn. | `finished` |

`data: {"neuron": {"host_id", "share_id", "kind"}}`; tapping it opens that session. Tokens Expo
reports as `DeviceNotRegistered` are deleted. The optional Worker secret `EXPO_ACCESS_TOKEN` is
needed only if the Expo project turns on enhanced push security.

## 6. Deploying

- `wrangler.toml` binds `RELAY` to `RelayRoom` (migration tag `v2-relay`; the class is created on
  deploy) and routes the custom domain `relay.zero-x.live` to the Worker. Deploying creates its
  DNS record; it fails if `relay.zero-x.live` already has one.
- Apply `migrations/20261026000000_push_devices.sql` (after `20261023000100_push_tokens.sql` and
  `20261023000000_session_devices.sql`) before deploying, like every migration (see `deploy.yml`).
  `migrations/down/20261026000000_push_devices.down.sql` reverts it.
- The first draft of this relay (`/relay/v1/host|client`, `register`/`attach` envelopes,
  XChaCha20, `/api/push/tokens`) was never deployed and is replaced by this page.

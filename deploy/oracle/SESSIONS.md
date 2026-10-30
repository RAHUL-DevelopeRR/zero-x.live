# Sessions in the hybrid (Worker + Oracle VM)

In phase 2 a CLI signs in through the Worker (`zero-x.live/auth/*`) and then sends every
completion to the VM (`zero-x.live/v1/*`). Both must find the same session for the same token.
Today they would not.

## How the store is chosen (code)

`persistentSessionStore(env)` in `neuroncli/auth-server/src/session-store.js`:

1. `env.SESSIONS_KV` bound: Workers KV. The Worker has it (`wrangler.toml` `[[kv_namespaces]]`).
2. Otherwise, when the database is configured (`SUPABASE_URL` and an `sb_secret_` key in
   `SUPABASE_SECRET_KEY`): the Postgres store, through RPCs. The Node server on the VM has no KV
   binding, so it always lands here.
3. Otherwise an in-memory store, only with `ALLOW_ANONYMOUS_SESSIONS=true` (development).

Every record goes through `writeRecord` / `readRecord`: CLI sessions (`ses_` tokens), PKCE
records (`pkce:<state>`), relay tickets and the changelog cache. KV stores a record under
`sha256(key)`; the Postgres store hashes the key it is given once more, so the same record sits
at `sha256(sha256(key))` in `gateway_session_store`. The session **index** (linked devices,
sliding expiry, sign-out and revoke-all: `zerox_session_index`, `zerox_session_touch`) is
already in Postgres for both runtimes.

So a session minted by the Worker lives in KV, and the VM answers 401 for it.

## The RPCs exist (migrations)

| Migration | Provides |
|---|---|
| `20261006042200_gateway_session_store.sql` | table `gateway_session_store` (64-hex keys, RLS, service role only), `zerox_session_get`, `zerox_session_put` (TTL 1 s to 7 days), `zerox_session_delete` |
| `20261016000300_business_sessions_admin.sql` | `zerox_session_rearm` (conditional rewrite that never recreates a deleted session), `zerox_session_index_list` (read-only, used by the copy script) |
| `20261029000000_session_devices.sql` | `zerox_session_touch` (index and sliding expiry, used by both runtimes today) |

`check-session-store.mjs` covers the store and `check-session-copy.mjs` the copy below.
Confirm the first two are applied in Supabase before the switch (`node scripts/apply-migrations.mjs --status`).

## Plan: one store, Postgres, for both

Unbind `SESSIONS_KV` on the Worker. With the binding gone the Worker falls back to the Postgres
store exactly like the VM, so both read and write the same rows. No code change. What changes on
the Worker:

- Session reads and writes become PostgREST calls (one or two subrequests per authenticated
  request instead of KV reads). Sessions still in use are re-armed once a day, since Postgres
  caps each write at seven days (`rearmRecord`).
- KV's free-plan write limit (1,000 a day) stops applying to sessions.
- The two KV-only caches stop: the cross-isolate health share (`health-share.js`; the HealthHub
  Durable Object still shares pool health on the Worker) and the models.dev facts in
  `/v1/models` (`oiop/models-dev.js`), which the VM never had either. `/v1/models` keeps working
  without those extra facts. Moving the facts to Postgres is a separate change if they matter.

Not chosen: a code switch that makes `session-store.js` ignore KV for records while the caches
keep it (smaller blast radius, but a code change in four places of the store); and a forced
re-login of every CLI user (no copy, simplest, acceptable for a small alpha; it is the fallback
if the copy fails).

## Copy script: `neuroncli/auth-server/scripts/kv-sessions-to-postgres.mjs` (not run yet)

Dry run by default. It lists the namespace with `wrangler kv key list`, reads each record with
`wrangler kv key get` and writes it with `zerox_session_put` under the key the Postgres store
uses, with the KV expiration as TTL (at most seven days). It never overwrites a row Postgres
already has, and copies an account session only while the session index still lists it
(`zerox_session_index_list`, read-only; the KV key is the index's token hash), so a sign-out or
revoke-all is never undone. It skips records with under a minute left, values that are not JSON
objects and every key that is not a record hash (raw pre-hashing keys, which lived 24 hours, and
the KV caches). It prints counts only, never keys or values (`not_indexed` counts the signed-out
sessions it left out, along with account sessions from before the index, whose users sign in
again).

Needs: `SUPABASE_URL` and `SUPABASE_SECRET_KEY` in the environment (not on the command line),
and wrangler logged in (`npx wrangler login`) or `CLOUDFLARE_API_TOKEN` with Workers KV read.

## Switch, in this order

1. **Dry run** (from `neuroncli/auth-server`, binding still in `wrangler.toml`):
   `node scripts/kv-sessions-to-postgres.mjs --wrangler "npx wrangler@4.147.0"`
   Expect `would_copy` close to the number of signed-in CLI users, `failed: 0`, `invalid: 0`.
   Note the namespace id (`npx wrangler kv namespace list`): the binding leaves `wrangler.toml`
   in the next step.
2. **Unbind**: remove the `SESSIONS_KV` `[[kv_namespaces]]` block from `wrangler.toml` (keep the
   namespace itself) and merge; `deploy.yml` deploys the Worker, which now uses Postgres.
3. **Copy, as soon as the deploy is done**:
   `node scripts/kv-sessions-to-postgres.mjs --apply --namespace-id <id> --wrangler "npx wrangler@4.147.0"`
   Sessions minted on the Worker since step 2 are already in Postgres and stay as they are.
4. **Check**: an existing login still works against the Worker (`neuron auth status`) and, with
   `NEURON_API_BASE=https://gw.zero-x.live/v1`, against the VM; full `/health` on the Worker shows
   `kv_bound: false`. Run the same `--apply` again if `failed` was not 0 (it only adds what is
   missing).

Between steps 2 and 3 (minutes), a CLI signed in before the switch gets 401 `invalid_session` and
works again after the copy; the CLI keeps its stored login on a 401 (only `logout` deletes it).
Do not copy before the unbind as well: a session signed out between that copy and the unbind
would keep its Postgres copy, and nothing on the request path checks the index (`noteSessionUse`
only declines to extend a session that is no longer indexed), so it would work until it expires.

## Rollback

Keep Postgres: rolling the VM back (phase 2 rollback in README.md) does not need KV, since the
Worker serves sessions from Postgres as well. Only if Postgres sessions themselves are the
problem: restore the `[[kv_namespaces]]` block and redeploy. Records written to KV before the
switch are still there until their TTL; sessions created after it exist only in Postgres, and
those users sign in again.

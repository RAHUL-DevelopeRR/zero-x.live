# Phase 1 cutover: production traffic to the EC2 gateway

The production hostnames (`zero-x.live`, `www`, `dashboard`, `neuron`) stay Worker Custom Domains
throughout: **no DNS record changes**. Deleting a Custom Domain to put a CNAME in its place would
open a gap that resolvers cache for up to 30 minutes (the zone's SOA negative TTL is 1800 s), and
a Worker route cannot roll that back.

Instead the Worker forwards, as the first thing in its `fetch()`, every request whose
`host + path` starts with an entry of its secret **`EC2_PROXY_PREFIXES`** to
`https://aws.zero-x.live` (the tunnel to the VM), with its proxy secret and the caller's host,
scheme, address and location in `x-zerox-*` headers. The response comes straight back, so even a
90 s stream costs the Worker almost no CPU. Everything else, and everything when the secret is
unset, is served by the Worker exactly as before: it stays the instant fallback.

`EC2_PROXY_PREFIXES` is the switch. It is a Worker secret only because `wrangler secret put` takes
effect in seconds without a commit and `deploy.yml` never overwrites a secret it does not list.
The value is not sensitive; since secrets cannot be read back, note each value you set.

```bash
cd neuroncli/auth-server        # on the laptop, signed in with `npx wrangler@4.147.0 login`
printf '%s' 'zero-x.live/v1/' | npx wrangler@4.147.0 secret put EC2_PROXY_PREFIXES   # set or replace
npx wrangler@4.147.0 secret delete EC2_PROXY_PREFIXES      # everything back to the Worker (answer y)
```

Entries are comma separated, without spaces or a scheme, matched as plain prefixes of
`host + path`: `zero-x.live/` covers every path of the apex, `/v1/` included, and no other host.

VM-side commands below run on the VM as `ubuntu`:
`aws ec2-instance-connect ssh --instance-id <id> --connection-type eice --os-user ubuntu $P`
(README.md, "Connecting"). `$P` is `--profile zerox --region ap-south-1`.

## Pre-flight: all of these hold before step 1

| | Check | How |
|---|---|---|
| a | **One commit on both runtimes**, both deployed by `deploy.yml` (job `ec2` on), and production's database has every migration | Job `ec2` green on the latest push to `main` (it compares the commits); `node scripts/apply-migrations.mjs --status` lists nothing pending. The relay decision is applied: `wrangler.toml` has no `RELAY` binding, relay routes answer 503 `relay_unavailable`. |
| b | **The models.dev facts are in Postgres** on both runtimes (C5), or you accept `/v1/models` without them after step 1 | `/v1/models` on the Worker and on `aws.zero-x.live` show the same extra facts. |
| c | **Secrets reconciled**: `SESSION_ENCRYPTION_KEY`, `DEVICE_APPROVAL_SECRET`, `PROVIDER_KEYS_KEK` and `EC2_PROXY_SECRET` come from GitHub for both runtimes (job `ec2` requires them); the VM has its own `SUPABASE_SECRET_KEY_EC2` | Feature flags equal (below). Otherwise sealed sessions, device approvals and vault keys written by one runtime fail on the other. |
| d | **24 h healthy on `https://aws.zero-x.live`** | CLI streams of 30-90 s complete with `NEURON_API_BASE=https://aws.zero-x.live/v1`; `/v1/models` and `/health` answer; error rate flat in the journal; `loadtest.mjs` passes on the VM at low concurrency; memory under 60 % (`free -m`); **a deploy during a stream drops nothing**: start a 90 s stream, run `push-release.sh` for the same commit, the stream completes and `/health` never fails. |
| e | **Every browser flow passed on `aws.zero-x.live`** (`EXTRA_WEB_HOSTS=aws.zero-x.live`, and `https://aws.zero-x.live/**` in Supabase's redirect allow-list) | Google, GitHub, Microsoft and email sign-in; CLI loopback login; device flow; dashboard; Razorpay checkout opens (no payment); admin pages with the token. |
| f | **Exactly one cron, on the Worker** | `wrangler.toml` has `[triggers] crons`; on the VM `systemctl is-enabled zerox-cron.timer` prints `disabled`. |
| g | **Rollback branches staged and their push approved** for each window | Below, "Pre-staged rollback branches". |
| h | **Mumbai to Supabase round trip measured** | 20 timed `curl -o /dev/null -s -w '%{time_total}\n' <SUPABASE_URL>/auth/v1/health` from the VM. |

Feature flags, both runtimes (`admin-header.txt`, mode 0600, holds
`Authorization: Bearer <GATEWAY_ADMIN_TOKEN>`, so the token stays out of history and process lists):

```bash
flags='{database_configured, billing_configured, webhook_configured, session_encryption, provider_key_vault, admin_access_configured, csp_enforced, providers}'
diff <(curl -s -H @admin-header.txt https://zero-x.live/health | jq -S "$flags") \
     <(curl -s -H @admin-header.txt https://aws.zero-x.live/health | jq -S "$flags") && echo 'same flags'
```

## Pre-staged rollback branches

Two steps change `wrangler.toml` through a commit, so their rollback is a commit too. Prepare it
right after the step's commit is on `main`, before the window, and approve its push in advance:
rolling back then takes one CI run (2-3 minutes) instead of waiting for a review.

- **`rollback/kv-rebind`** (step 1): `git switch -c rollback/kv-rebind origin/main && git revert --no-edit <unbind commit>`.
  It puts the `SESSIONS_KV` `[[kv_namespaces]]` block back.
- **`rollback/cron-trigger`** (step 5): `git switch -c rollback/cron-trigger origin/main && git revert --no-edit <cron commit>`.
  It puts `[triggers] crons = ["*/10 * * * *"]` back.

Pushing the branch itself deploys nothing (`deploy.yml` runs on `main` only). To roll back:
`git push origin rollback/<name>:main` (a fast-forward while nothing else was merged; keep `main`
frozen during the window), then approve job `ec2` of that run. Delete the branch after the window.

## Steps (one per quiet window, across 3-4 days)

Each step lists what you approve, what to run, what to check and how to undo it.

### 1. Sessions from KV to Postgres (about 15 minutes, [SESSIONS.md](SESSIONS.md))

- **You approve**: merging and pushing the unbind commit, job `ec2` of that run, and the copy.
- Dry run, from `neuroncli/auth-server`, with `SUPABASE_URL` and `SUPABASE_SECRET_KEY` in the
  environment: `node scripts/kv-sessions-to-postgres.mjs --wrangler "npx wrangler@4.147.0"`.
  Expect `failed: 0` and `invalid: 0`; note the namespace id (`npx wrangler@4.147.0 kv namespace list`).
- Commit the removal of the `SESSIONS_KV` `[[kv_namespaces]]` block, merge and push. The Worker now
  uses the Postgres store, like the VM. Stage `rollback/kv-rebind`.
- Straight after the deploy: `node scripts/kv-sessions-to-postgres.mjs --apply --namespace-id <id> --wrangler "npx wrangler@4.147.0"`.
  Never copy before the unbind: a sign-out made in between would be undone.
- **Check**: `neuron auth status` against the Worker, and with
  `NEURON_API_BASE=https://aws.zero-x.live/v1` against the VM; the full `/health` shows
  `kv_bound: false`; `/v1/models` statuses look right on the Worker. Between the unbind and the copy
  (minutes) older CLI sessions get 401 and recover after the copy (the CLI keeps its login on 401).
- **Undo**: only if the Postgres store itself fails, push `rollback/kv-rebind`. Sessions created
  after the switch sign in again.

### 2. `/v1` to EC2 (the CPU cap)

- **You approve**: the `secret put`.
- `printf '%s' 'zero-x.live/v1/' | npx wrangler@4.147.0 secret put EC2_PROXY_PREFIXES`.
  If old CLIs still use the legacy aliases, use
  `zero-x.live/v1/,zero-x.live/auth/azure/,zero-x.live/neuroncli/auth-server/v1/`.
- **Watch for 30-60 minutes**: streams complete; no new 5xx; usage shows matching
  `zerox_reserve_v2` / `zerox_settle_v2` pairs; `journalctl -u 'zerox-gateway@*'` on the VM has no
  errors; the Worker's request count stays under Workers Free's 100,000 a day (every forwarded
  request still counts once on the Worker).
- **Undo**: `npx wrangler@4.147.0 secret delete EC2_PROXY_PREFIXES` (seconds). Streams in flight
  are cut; their reservation lease expires and the next cron run frees it.

### 3. The whole apex (day +1 or +2)

- **You approve**: the `secret put`.
- `printf '%s' 'zero-x.live/' | npx wrangler@4.147.0 secret put EC2_PROXY_PREFIXES` (covers `/v1/`).
- **Check**: pages, clean URLs and the 301s, http to https, HSTS, the CSP header, the 404 page,
  `/pricing`; `cf-cache-status` on `/Assets/*` (`curl -sI https://zero-x.live/Assets/<file>`);
  Razorpay checkout, and the next real webhook in the VM's journal; Google, GitHub, Microsoft and
  email sign-in and the CLI loopback login; `/releases/*/latest.json`, `/oiop/keys.json`,
  `sitemap.xml`, `robots.txt` and the IndexNow key file. From now on `https://zero-x.live/health`
  answers from the VM, so job `ec2`'s commit check reads the VM there.
- **Undo**: put back `zero-x.live/v1/` (step 2), or delete the secret.

### 4. The other hostnames, one at a time

- **You approve**: each `secret put`.
- Add one entry per window, keeping the earlier ones:
  1. `zero-x.live/,www.zero-x.live/`: check the 301 to the apex.
  2. `zero-x.live/,www.zero-x.live/,dashboard.zero-x.live/`: check `dashboard.html`, the robots
     `Disallow`, the admin pages.
  3. `zero-x.live/,www.zero-x.live/,dashboard.zero-x.live/,neuron.zero-x.live/`: check the redirect
     from `/`, then a real device-flow sign-in at `/device`.
- **Undo**: put the previous value back.

### 5. Cron switch, in one window

- **You approve**: merging and pushing the cron commit and job `ec2` of that run; enabling the timer.
- Commit the removal of `[triggers] crons` from `wrangler.toml`, merge and push. Stage
  `rollback/cron-trigger`.
- After the run finishes, on the VM: `sudo systemctl enable --now zerox-cron.timer`.
- **Check**: `journalctl -u zerox-cron --since -15min` shows one `{"cron":"ok",...}` line per tick;
  stale reservations are released (usage and `/admin/overview`); `systemctl list-timers zerox-cron.timer`.
- **Undo**: on the VM `sudo systemctl disable --now zerox-cron.timer`, then push
  `rollback/cron-trigger`. (Two crons for a few minutes are safe: the release is idempotent and
  discovery jobs are claimed in Postgres.)

### 6. `relay.zero-x.live` (after C7)

Until the Node relay (C7) ships, relay routes answer 503 `relay_unavailable` on both runtimes and
there is nothing to switch. Then: add `relay.zero-x.live` to the tunnel's public hostnames
(README.md, "Cloudflare Tunnel") and its proxied CNAME, with no Worker in front; the mobile app's
`wss://relay.zero-x.live/v1/relay` does not change. Test 10+ minutes idle in both directions. The
relay has no Worker fallback.

### 7. Close out the test host

- **You approve**: the variable change and the next run of job `ec2`.
- Delete the repository variable `EXTRA_WEB_HOSTS` (`gh variable delete EXTRA_WEB_HOSTS`) and
  re-run the latest deploy (or wait for the next push). The VM then serves `aws.zero-x.live` only to
  the Worker (requests carrying the proxy secret), plus `/health` and `/ready`; everything else
  there answers 403. Keep the `aws.zero-x.live` tunnel hostname: it is the Worker's forward target.
- Remove `https://aws.zero-x.live/**` from Supabase's redirect allow-list.
- **Check**: `curl -s -o /dev/null -w '%{http_code}\n' https://aws.zero-x.live/` prints 403, and
  `https://zero-x.live/` still serves the site.

### 8. 14-day rollback window

- The Worker keeps receiving every commit through the same workflow, and its HealthHub keeps
  probing, which keeps the fallback warm.
- After the window: the Worker stays a pure proxy until Phase 3; delete the KV namespace after 30
  days; when the Worker is finally retired, remove HealthHub with a `deleted_classes` migration.

## Rollback summary

| What went wrong | Action | Time |
|---|---|---|
| One path or host misbehaves on the VM | `secret put EC2_PROXY_PREFIXES` without that entry | seconds |
| The VM is down | `secret delete EC2_PROXY_PREFIXES`; in-flight streams are cut, their leases expire and the next cron frees them | seconds |
| A bad release on the VM | Re-run the workflow for the previous commit, `push-release.sh --ref <commit>`, or activate a release still on the VM (README.md, "Rollback"); the Worker: `wrangler rollback` | 1-3 minutes |
| Cron | `sudo systemctl disable --now zerox-cron.timer`, push `rollback/cron-trigger` | about 3 minutes |
| Session store | Push `rollback/kv-rebind` (only if the Postgres store itself fails) | about 3 minutes |
| Razorpay webhook | Nothing: both runtimes dedupe through `zerox_webhook_claim`, Razorpay retries 5xx | - |
| Schema | Never rolled back: migrations are additive | - |

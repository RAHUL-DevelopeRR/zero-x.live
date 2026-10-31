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

Every push to `main` runs job `verify` first, then waits for one approval in the environment
`production`, which starts the Worker deploy and job `ec2` together (README.md, "Deploys"); job
`same-commit` then compares the commits. Nothing ships before that approval, so a push that waits
leaves both runtimes on the previous commit. From step 2 until the close-out, approve each run
promptly or not at all (reject it), and keep `main` frozen during a window.

## Before this kit reaches `main` (once)

The EC2 smoke test left the VM on main's code (66f29a1) under the single unit
`zerox-gateway.service`, and the environment `production` set up for the one-off workflow
`ec2-smoke-env.yml` on branch `ops/ec2-smoke`. In this order:

1. **Let `main` deploy to `production`** (you, in GitHub). Its deployment branch policy allows only
   `ops/ec2-smoke` today, and with this `deploy.yml` the Worker job runs in `production` too: until
   `main` is added, every push to `main` stops at the Worker deploy ("not allowed to deploy to
   production"). Settings > Environments > production > Deployment branches and tags > add `main`,
   or `gh api -X POST repos/RAHUL-DevelopeRR/zero-x.live/environments/production/deployment-branch-policies -f name=main -f type=branch`.
   From then on every push to `main` waits for your approval (required reviewer, no admin bypass),
   the Worker included.
2. **Secrets and variables for job `ec2`** (README.md, "Deploys"). Already in `production` since the
   smoke test: the secret `AWS_DEPLOY_ROLE_ARN` and the variables `EC2_INSTANCE_ID` and
   `EC2_HOST_KEY`. New, both as secrets **of the environment `production`**, never of the
   repository (a repository secret is readable by a workflow pushed on any branch, outside the
   environment's required reviewer): `SUPABASE_SECRET_KEY_EC2` (a Supabase secret key of the VM's
   own, not the Worker's) and `EC2_PROXY_SECRET`, generated without echoing it:
   `openssl rand -hex 32 | gh secret set EC2_PROXY_SECRET --env production`. The Worker job runs
   in `production` too and gets the same value. If a repository-level `EC2_PROXY_SECRET` exists
   (`gh secret list`), delete it: `gh secret delete EC2_PROXY_SECRET`. The smoke test's
   `DEVICE_VERIFICATION_URL` is not needed any more: forwarded requests carry the visitor's host,
   so device sign-ins point at `https://neuron.zero-x.live/device` (or at the test host's own page
   on the test host).
3. **Move the VM to the two-instance layout** (you, from the laptop, signed in with `aws login`).
   If the running tunnel was installed with `cloudflared service install <token>`, that token has
   been on the unit's command line and in the journal, both readable by `deploy` (README.md,
   "Cloudflare Tunnel"), so it is replaced, not copied:
   1. In the Cloudflare dashboard, tunnel `zerox-aws` > Overview > **Refresh token**, and copy only
      the new token (the long string at the end of the install command it shows). The running
      connector stays connected (Cloudflare: existing connectors remain active; the old token only
      stops opening new connections), so nothing drops yet.
   2. On the VM, as `ubuntu`, write only the new token, from the keyboard:
      `read -rs -p 'tunnel token: ' T; echo; printf '%s' "$T" | sudo install -o root -g root -m 0600 /dev/stdin /etc/cloudflared/token; unset T`.
   3. Remove the old unit: `sudo cloudflared service uninstall` (it stops the connector:
      `aws.zero-x.live` is down until the kit's unit starts below; only the test host is affected).
   4. Drop every connection the old token still holds. A connector someone started elsewhere with
      the old token stays connected after the refresh, and keeps receiving part of the tunnel's
      traffic, until the tunnel's connections are deleted (Cloudflare, "Rotate a compromised
      token"). From the laptop, with an API token that has the permission "Cloudflare Tunnel Write"
      (create one for this and delete it afterwards; the account and tunnel ids are on the
      tunnel's Overview):

      ```bash
      read -rs -p 'API token: ' CF; echo
      printf 'header = "Authorization: Bearer %s"\n' "$CF" |
        curl -fsS -K - -X DELETE "https://api.cloudflare.com/client/v4/accounts/<account id>/cfd_tunnel/<tunnel id>/connections"
      unset CF
      ```

      (`printf` is a shell builtin and `-K -` reads the header from stdin, so the API token is on
      no command line.) The tunnel's Overview then lists no connector until `push-release.sh`
      below starts the kit's, and from then on exactly one: the VM's.

   Then: `deploy/aws/push-release.sh --profile zerox --setup`. It installs and starts the kit's
   `cloudflared.service` (token file, nothing on a command line), stops and removes
   `zerox-gateway.service` and `/opt/zerox/gateway`, makes `/etc/zerox` and the environment file
   root's (the deploy user changes it only through `zerox-install-env` from now on), installs
   `zerox-gateway@.service` and the deploy user's sudoers, and
   activates the commit on `zerox-gateway@0` with the environment file the smoke test wrote. Then,
   on the VM, drop the journal that held the old token (this deletes all journal history, every
   unit's): `sudo journalctl --rotate && sudo journalctl --vacuum-time=1s`. Only
   the test host is affected: `aws.zero-x.live` is down from the stop until `@0` is ready (a
   minute or two), and then answers only `/health` and `/ready` until job `ec2` writes
   `EXTRA_WEB_HOSTS` and `EC2_PROXY_SECRET` (the smoke test's file has neither). Until this step
   job `ec2` cannot deploy: `activate-release.sh` refuses while `zerox-gateway.service` runs or
   `/opt/zerox/gateway` is left (that unit holds port 8787 without reusePort, and the deploy user's
   old sudo rule covers it only), and changes nothing, the environment file included.
   `/opt/zerox/releases/66f29a1` (installed by hand for the smoke test) becomes the deploy user's
   in `host-setup.sh`, and later activations prune it like any other release (a release that
   cannot be pruned is reported, not fatal: `sudo find /opt/zerox/releases ! -user deploy | head`).
4. **Turn job `ec2` on**: `gh variable set EC2_DEPLOY --body true` (and `EXTRA_WEB_HOSTS` to
   `aws.zero-x.live` for the test window). The next approved push writes the whole environment
   file from GitHub (`gateway-env.mjs`), replacing the smoke test's.
5. **Retire the smoke workflow**: remove `ops/ec2-smoke` from the environment's deployment
   branches and delete the branch, so it can no longer write `/etc/zerox/gateway.env` behind the
   deploy's back.

## Pre-flight: all of these hold before step 1

| | Check | How |
|---|---|---|
| a | **One commit on both runtimes**, both deployed by `deploy.yml` (job `ec2` on), and production's database has every migration | Jobs `ec2` and `same-commit` green on the latest push to `main` (`same-commit` compares the commits); the migrations check in README.md, "Deploys" (`apply-migrations.mjs --status` with `DATABASE_URL` and `psql`, or the SQL-editor query there) lists nothing pending. The relay decision is applied: `wrangler.toml` has no `RELAY` binding, relay routes answer 503 `relay_unavailable`. |
| b | **The models.dev facts are in Postgres** on both runtimes (C5), or you accept `/v1/models` without them after step 1 | `/v1/models` on the Worker and on `aws.zero-x.live` show the same extra facts. |
| c | **Secrets reconciled**: `SESSION_ENCRYPTION_KEY`, `DEVICE_APPROVAL_SECRET`, `PROVIDER_KEYS_KEK` and `EC2_PROXY_SECRET` come from GitHub for both runtimes (job `ec2` requires them); the VM has its own `SUPABASE_SECRET_KEY_EC2` | Feature flags equal (below). Otherwise sealed sessions, device approvals and vault keys written by one runtime fail on the other. |
| d | **24 h healthy on `https://aws.zero-x.live`** | CLI streams of 30-90 s complete with `NEURON_API_BASE=https://aws.zero-x.live/v1`; `/v1/models` and `/health` answer; error rate flat in the journal; `loadtest.mjs` passes on the VM at low concurrency; memory under 60 % (`free -m`); **a deploy during a stream drops nothing**: start a 90 s stream, run `push-release.sh` for the same commit, the stream completes and `/health` never fails. |
| e | **Every browser flow passed on `aws.zero-x.live`** (`EXTRA_WEB_HOSTS=aws.zero-x.live`, and `https://aws.zero-x.live/**` in Supabase's redirect allow-list) | Google, GitHub, Microsoft and email sign-in; CLI loopback login; device flow; dashboard; Razorpay checkout opens (no payment); admin pages with the token. |
| f | **Exactly one cron, on the Worker** | `wrangler.toml` has `[triggers] crons = ["*/10 * * * *"]`; on the VM `systemctl is-enabled zerox-cron.timer` prints `disabled`. |
| g | **Rollback branches staged and reviewed** for each window | Below, "Pre-staged rollback branches". |
| h | **Mumbai to Supabase round trip measured** | 20 timed `curl -o /dev/null -s -w '%{time_total}\n' <SUPABASE_URL>/auth/v1/health` from the VM. |

Feature flags, both runtimes (`admin-header.txt`, mode 0600, holds
`Authorization: Bearer <GATEWAY_ADMIN_TOKEN>`, so the token stays out of history and process lists).
Node does the extraction (Git Bash has no `jq`), and an empty or failed answer on either side
fails the check instead of comparing nothing:

```bash
flags() {
  curl -fsS -H @admin-header.txt "https://$1/health" | node -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      const h = JSON.parse(s), keys = ["database_configured", "billing_configured", "webhook_configured", "session_encryption",
        "provider_key_vault", "admin_access_configured", "csp_enforced", "providers"];
      if (!keys.every(k => k in h)) { console.error("not the full /health: is admin-header.txt right?"); process.exit(1); }
      console.log(JSON.stringify(Object.fromEntries(keys.map(k => [k, k === "providers" ? [...h[k]].sort() : h[k]])), null, 1));
    });'
}
worker="$(flags zero-x.live)" && vm="$(flags aws.zero-x.live)" && [ -n "$worker" ] && [ -n "$vm" ] &&
  diff <(echo "$worker") <(echo "$vm") && echo 'same flags'
```

## Pre-staged rollback branches

Two steps change `wrangler.toml` through a commit, so their rollback is a commit too. Prepare and
review it right after the step's commit is on `main`, before the window. The approval itself
cannot be given ahead: GitHub asks for it per run, so during a rollback you push, wait for job
`verify` (about 2 minutes: `npm ci`, the checks, `npm audit`), click approve, and wait for both
deploys (about 2 more): 5 minutes or so, more if the approval waits.

- **`rollback/kv-rebind`** (step 1): `git switch -c rollback/kv-rebind origin/main && git revert --no-edit <unbind commit>`.
  It puts the `SESSIONS_KV` `[[kv_namespaces]]` block back.
- **`rollback/cron-trigger`** (step 5): `git switch -c rollback/cron-trigger origin/main && git revert --no-edit <cron commit>`.
  It puts `[triggers] crons = ["*/10 * * * *"]` back.

Pushing the branch itself deploys nothing (`deploy.yml` runs on `main` only). To roll back:
`git push origin rollback/<name>:main` (a fast-forward while nothing else was merged; keep `main`
frozen during the window), then approve that run (one approval: the Worker and job `ec2`). Delete
the branch after the window.

Job `verify` can stop a rollback: `npm audit --omit=dev` fails on an advisory published that day,
and nothing deploys. The paths that skip CI, from the laptop (`cd neuroncli/auth-server`, signed in
with `npx wrangler@4.147.0 login`), until CI passes again:

- **The Worker's previous version**: `npx wrangler@4.147.0 rollback` (the version before the latest
  one; `npx wrangler@4.147.0 deployments list` shows them). For step 1 this puts the
  `SESSIONS_KV` binding back with the code. Do not count on it for the cron: Cloudflare's rollback
  documentation does not say that a rollback restores Cron Triggers, and Wrangler applies them
  apart from versions (`triggers deploy`, next item).
- **The cron trigger back**: from a checkout of `rollback/cron-trigger`, in
  `neuroncli/auth-server`, `npx wrangler@4.147.0 triggers deploy` applies its
  `crons = ["*/10 * * * *"]` to the deployed Worker without uploading a version (Wrangler marks the
  command experimental; check Settings > Trigger events afterwards). Then push the branch as above,
  so `main` says the same.

## Steps (one per quiet window, across 3-4 days)

Each step lists what you approve, what to run, what to check and how to undo it.

### 1. Sessions from KV to Postgres (about 15 minutes, [SESSIONS.md](SESSIONS.md))

- **You approve**: merging and pushing the unbind commit, that run (the Worker and job `ec2`), and the copy.
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
  errors (and no `Refused ... x-zerox-proxy-secret` line: the two runtimes hold different
  secrets); the Worker's request count stays under Workers Free's 100,000 a day (every forwarded
  request still counts once on the Worker).
- **VM or tunnel down** (watch for it here and through the 14-day window): the Worker then answers
  forwarded paths with its own JSON 503 `service_unavailable` (Retry-After 5) and logs
  `EC2 origin unreachable` with the status, 530 when the tunnel has no connector, 502 when nothing
  listens on 127.0.0.1:8787 (`npx wrangler@4.147.0 tail` on the laptop shows it). From outside:
  `curl -s -o /dev/null -w '%{http_code}\n' https://aws.zero-x.live/health` prints 200 while the VM
  serves, 530 or 502 when it does not. A few minutes of it: delete `EC2_PROXY_PREFIXES` (Undo,
  below), then look at the VM (`systemctl status cloudflared 'zerox-gateway@*'`).
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
  answers from the VM, so job `same-commit` reads the VM there.
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

- **You approve**: merging and pushing the cron commit and that run (the Worker and job `ec2`); enabling the timer.
- Commit `[triggers]` with `crons = []` in `wrangler.toml` (the comment above it says why), merge
  and push. **Not** a deleted or commented-out `crons`: Cloudflare's wrangler configuration docs
  say "To disable a Cron Trigger, set `crons = []`. Commenting out the `crons` key will not disable
  a Cron Trigger." With the key gone the deploy leaves the `*/10` schedule attached, and both
  runtimes would run maintenance and discovery from then on. Stage `rollback/cron-trigger`.
- **Check the Worker has no schedule left** before the timer starts: the run's "Deploy Worker"
  log lists no `schedule:` under the deployed triggers, and the dashboard (Workers & Pages >
  the Worker > Settings > Trigger events) shows no Cron Triggers.
- Only then, on the VM: `sudo systemctl enable --now zerox-cron.timer`.
- **Check**: `journalctl -u zerox-cron --since -15min` shows one `{"cron":"ok",...}` line per tick;
  stale reservations are released (usage and `/admin/overview`); `systemctl list-timers zerox-cron.timer`.
- **Undo**: on the VM `sudo systemctl disable --now zerox-cron.timer`, then push
  `rollback/cron-trigger` (or, if job `verify` cannot pass, `npx wrangler@4.147.0 triggers deploy`
  from its checkout: "Pre-staged rollback branches"). (Two crons for a few minutes are safe: the
  release is idempotent and discovery jobs are claimed in Postgres.)

### 6. `relay.zero-x.live` (after C7)

Until the Node relay (C7) ships, relay routes answer 503 `relay_unavailable` on both runtimes and
there is nothing to switch. Then: add `relay.zero-x.live` to the tunnel's public hostnames
(README.md, "Cloudflare Tunnel") and its proxied CNAME, with no Worker in front; the mobile app's
`wss://relay.zero-x.live/v1/relay` does not change. Test 10+ minutes idle in both directions. The
relay has no Worker fallback.

### 7. Close out the test host

- **You approve**: the variable change and the next run (the Worker and job `ec2`).
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
| One of the two deploy jobs failed (`same-commit` did not run: the runtimes may be on different commits) | Re-run the failed job once its cause is fixed. If the VM job failed, its activation already put the previous release back, so the Worker is ahead: from step 2, `wrangler rollback` the Worker, or take the forwarded prefixes off the VM (`secret put`/`secret delete EC2_PROXY_PREFIXES`) until both match | minutes |
| Cron | `sudo systemctl disable --now zerox-cron.timer`, push `rollback/cron-trigger` (or `wrangler triggers deploy` from its checkout) | about 5 minutes |
| Session store | Push `rollback/kv-rebind` (only if the Postgres store itself fails) | about 5 minutes |
| Every forward answers 403 `proxy_secret_mismatch` (the runtimes hold different `EC2_PROXY_SECRET`s) | `secret delete EC2_PROXY_PREFIXES`, then the rotation in README.md, "Rotating the proxy secret" | seconds |
| Razorpay webhook | Nothing: both runtimes dedupe through `zerox_webhook_claim`, Razorpay retries 5xx | - |
| Schema | Never rolled back: migrations are additive | - |

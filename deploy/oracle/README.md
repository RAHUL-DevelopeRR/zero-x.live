# Zero-X gateway API on an Oracle Cloud A1 VM, behind Cloudflare Tunnel

The Workers Free plan stops an invocation after 10 ms of CPU, and a long token stream spends
more than that relaying chunks (`check-stream-cpu.mjs`). This kit runs the same Hono app on a
Node server (`neuroncli/auth-server/server.js`) on an Oracle Cloud Always Free Ampere A1 VM.
cloudflared on the VM dials out to Cloudflare, so the VM opens no port except SSH.

Hybrid target: the Worker keeps the website, sign-in (`/auth/*`), accounts, billing webhooks,
the catalog admin, the relay and its own cron on `zero-x.live`. Only `/v1/*` moves to the VM.

- **Phase 1**: the VM serves what the Neuron CLI calls at a test hostname, `gw.zero-x.live`, for
  real users who opt in with `NEURON_API_BASE=https://gw.zero-x.live/v1`.
- **Phase 2**: `zero-x.live/v1/*` goes to the VM. Sessions must be in one store first
  ([SESSIONS.md](SESSIONS.md)).

The CLI's base URL always ends in `/v1`: it appends `/chat/completions` and `/models` to it, and
strips `/v1` for the account endpoints (`/auth/device/*`, `/auth/session`, `/api/account`). A base
without `/v1` signs in fine and then gets 404 for every completion.

## Files

| File | What it is |
|---|---|
| `cloud-init.yaml` | First boot: users `zerox` (runs the gateway) and `deploy` (CI), Node.js 22 (arm64) from NodeSource's signed apt repo, cloudflared from Cloudflare's signed apt repo, unattended-upgrades in a night window, key-only sshd, journald limits, `/opt/zerox` and `/etc/zerox`. The firewall is the image's own iptables rules; no UFW (section 2). |
| `zerox-gateway.service` | systemd unit: `EnvironmentFile=/etc/zerox/gateway.env`, production settings, `Restart=always`, `TimeoutStopSec=120`, ordered after cloudflared, sandboxing that leaves V8's JIT alone. |
| `zerox-cron.service`, `zerox-cron.timer` | `scripts/cron.mjs` every 10 minutes (`Persistent=true`): the Worker cron's maintenance and discovery. |
| `cloudflared-config.yml` | Tunnel config template: `gw.zero-x.live` limited to the CLI's paths and the health checks (phase 1), `zero-x.live` `^/v1/` (phase 2, commented), operator paths never, then 404. |
| `gateway.env.example` | Every variable the gateway reads in production, names only, grouped, with where each value comes from. |
| `gateway-env.mjs` | Builds `/etc/zerox/gateway.env` in CI from `wrangler.toml` `[vars]` and the deploy secrets; refuses the unit's own settings and development switches. |
| `activate-release.sh` | Runs on the VM in CI (and for a manual rollback): switch release, restart, `/ready`, roll back on failure, prune. |
| `apex-cutover.mjs` | Phase 2 DNS switch through the Cloudflare API: Custom Domain off and tunnel CNAME on back to back (and the reverse), plus lowering the zone's negative-caching TTL. |
| `loadtest.mjs`, `loadtest-probe.mjs` | Capacity check: N concurrent streams of a given request size and length against a fake upstream; CPU per request and per token. |
| `SESSIONS.md` | How the session store is chosen, and the plan and copy script for one store. |
| `../../.github/workflows/deploy-oracle.yml` | Manual deploy: verify, build the environment, rsync a release, `npm ci --omit=dev`, restart, readiness check. |

What changed in the gateway for this (all Node-only, Worker behaviour unchanged): `TRUST_CLOUDFLARE`
(visitor address from `CF-Connecting-IP`, only from the loopback peer; the dev identity is refused
with it), SSE keep-alive comments on quiet streams, a SIGTERM drain (`SHUTDOWN_GRACE_MS`, then 5 s
for the settlements of streams it had to cut) and `scripts/cron.mjs` (`check-node-lifecycle.cjs`,
`check-cron.mjs`, `check-oracle-deploy.mjs`).

## Capacity

**The VM.** Always Free A1 in the tenancy's home region: 2 OCPUs (2 Arm cores) and 12 GB in total,
200 GB of boot plus block volume, 10 TB of outbound data a month (Oracle's Always Free page,
checked 2026-10-30). Node runs the gateway's JavaScript on one core, so one gateway process is
bounded by one core; the other core is left to cloudflared (which carries every byte), GC
threads and the OS.

**Measured on the development machine** (Windows x64, Node 24, `loadtest.mjs`, 2026-10-30; fake
upstream over plain HTTP on loopback, no database, one SSE event per token; Windows timers held
the nominal 50 tokens/s to about 32). The request body is padded with an agent's history
(`--body-kb`); the largest that passes the free Groq pool's 8,000-token per-minute budget, which
the gateway enforces per request, is about 27 KB.

| Request | Answer | Concurrent streams | Gateway CPU per request | Per token | Requests/s per core at 80 % busy | Event loop busy | RSS |
|---|---|---|---|---|---|---|---|
| 0.1 KB | 100 tokens | 100 to 400 | 6 to 12 ms | 62 to 119 µs | 67 to 129 | 18 to 50 % | 109 to 269 MB |
| 9 KB | 100 tokens | 100 to 400 | 7 to 13 ms | 73 to 130 µs | 62 to 110 | 19 to 52 % | 137 to 302 MB |
| 27 KB | 100 tokens | 100 to 400 | 8 to 12 ms | 79 to 122 µs | 66 to 102 | 20 to 58 % | 147 to 319 MB |
| 23 KB | 1,000 tokens | 100, 200 | 60 to 65 ms | 60 to 65 µs | 12 to 13 | 18 %, 35 % | 143, 221 MB |
| 23 KB | 1,000 tokens | 400 | 54 ms | 54 µs | | 91 % (over the 80 % line) | 301 MB |

A review run on the same machine measured 144 to 165 µs per token with 100-token streams (14 to
17 ms per request), about 100 streams per core. So a request costs a fixed 6 to
17 ms here (reading and checking the body, routing, the upstream request, the settlement) plus
about 55 µs per relayed token; short answers are dominated by the fixed part. CPU per stream
falls as concurrency rises (timers and GC are shared), so the low-concurrency rows are the
cautious ones.

**Not measured, and all of it adds CPU per request in production:** TLS to the provider (here
plain HTTP), the Supabase RPCs over TLS (session read, reservation, a renewal every 30 s,
settlement, session activity), real providers' chunking, and bodies above 27 KB. Paid Claude
requests can carry hundreds of KB of history (the server accepts up to 2 MB); parsing and
re-serialising grow with the body.

**Planning figures for one gateway process on an A1 core**, until `loadtest.mjs` has run on the
VM (an A1 core is slower per thread than this x64 machine; assume half, then leave room for TLS
and the database): **about 20 requests/s, and about 100 concurrent streams at 50 tokens/s**,
whichever comes first. Memory is not the limit (12 GB). Replace these with the VM's numbers.

**Bandwidth.** A relayed token is one SSE event of about 200 bytes, so a 50 tokens/s stream is
about 10 KB/s and 300 streams about 3 MB/s (24 Mbit/s). Outbound data also counts the prompts
sent to providers (a coding agent's request can be hundreds of KB). 10 TB a month is about
3.8 MB/s averaged over the month.

**Running it on the VM** (before go-live, or with `zerox-gateway` stopped, since it shares the CPU;
the gateway under test is a separate process on a random loopback port, nothing leaves the VM):

```bash
rsync -a --exclude node_modules --exclude '.env*' --exclude '.dev.vars*' neuroncli/auth-server deploy ubuntu@$IP:loadtest/
ssh ubuntu@$IP 'cd loadtest/auth-server && npm ci && for kb in 0 24; do node ../deploy/oracle/loadtest.mjs --gateway-dir . \
  --streams 25,50,100,200 --tokens 100 --body-kb $kb --rate 50 --json ../result-$kb.json; done \
  && node ../deploy/oracle/loadtest.mjs --gateway-dir . --streams 50,100,200 --tokens 1000 --body-kb 20 --json ../result-long.json'
```

A step passes when every stream ends with `[DONE]`, the event loop is busy under 80 % of the time
(`--max-elu`) and its p99 delay stays under 100 ms (`--max-lag-ms`). The summary prints the
largest passing step, `est_requests_per_s_per_core` and `est_streams_per_core`.

## 1. Create the VM (OCI CLI)

Prerequisites: `oci setup config` done, the home region set (`ap-mumbai-1` or `ap-hyderabad-1`;
Always Free resources exist only in the home region), your own SSH key, and a deploy key pair:

```bash
ssh-keygen -t ed25519 -N '' -C zerox-deploy -f zerox-deploy     # private half becomes ORACLE_SSH_KEY
sed "s|REPLACE_WITH_DEPLOY_PUBLIC_KEY|$(cat zerox-deploy.pub)|" deploy/oracle/cloud-init.yaml > /tmp/zerox-cloud-init.yaml
```

Network (a VCN with an internet gateway and a subnet whose security list lets in SSH only) and
the instance:

```bash
C=<compartment OCID>        # the tenancy OCID for the root compartment
AD=$(oci iam availability-domain list -c "$C" --query 'data[0].name' --raw-output)
VCN=$(oci network vcn create -c "$C" --cidr-blocks '["10.0.0.0/16"]' --display-name zerox-vcn --dns-label zerox \
  --wait-for-state AVAILABLE --query data.id --raw-output)
IGW=$(oci network internet-gateway create -c "$C" --vcn-id "$VCN" --is-enabled true --display-name zerox-igw \
  --wait-for-state AVAILABLE --query data.id --raw-output)
RT=$(oci network vcn get --vcn-id "$VCN" --query 'data."default-route-table-id"' --raw-output)
oci network route-table update --rt-id "$RT" --force \
  --route-rules "[{\"destination\":\"0.0.0.0/0\",\"destinationType\":\"CIDR_BLOCK\",\"networkEntityId\":\"$IGW\"}]"
# SSH from anywhere (GitHub runners have no fixed address); keys only (cloud-init's sshd settings).
SL=$(oci network security-list create -c "$C" --vcn-id "$VCN" --display-name zerox-ssh-only \
  --egress-security-rules '[{"destination":"0.0.0.0/0","protocol":"all","isStateless":false}]' \
  --ingress-security-rules '[{"source":"0.0.0.0/0","protocol":"6","isStateless":false,"tcpOptions":{"destinationPortRange":{"min":22,"max":22}}}]' \
  --wait-for-state AVAILABLE --query data.id --raw-output)
SUBNET=$(oci network subnet create -c "$C" --vcn-id "$VCN" --cidr-block 10.0.0.0/24 --display-name zerox-public \
  --dns-label pub --route-table-id "$RT" --security-list-ids "[\"$SL\"]" \
  --wait-for-state AVAILABLE --query data.id --raw-output)
IMAGE=$(oci compute image list -c "$C" --operating-system "Canonical Ubuntu" --operating-system-version "24.04" \
  --shape VM.Standard.A1.Flex --sort-by TIMECREATED --sort-order DESC \
  --query "data[?!contains(\"display-name\", 'Minimal')] | [0].id" --raw-output)
INSTANCE=$(oci compute instance launch -c "$C" --availability-domain "$AD" --display-name zerox-gw \
  --shape VM.Standard.A1.Flex --shape-config '{"ocpus":2,"memoryInGBs":12}' \
  --image-id "$IMAGE" --subnet-id "$SUBNET" --assign-public-ip true --boot-volume-size-in-gbs 50 \
  --ssh-authorized-keys-file ~/.ssh/id_ed25519.pub --user-data-file /tmp/zerox-cloud-init.yaml \
  --wait-for-state RUNNING --query data.id --raw-output)
IP=$(oci compute instance list-vnics --instance-id "$INSTANCE" --query 'data[0]."public-ip"' --raw-output)
```

"Out of host capacity" is common for A1 in the Indian regions: retry the launch later (a loop
with a few minutes between attempts) or with another `--fault-domain`.

Host key, checked out of band, then pinned for CI:

```bash
oci compute console-history capture --instance-id "$INSTANCE" --wait-for-state SUCCEEDED --query data.id --raw-output > /tmp/h
oci compute console-history get-content --instance-console-history-id "$(cat /tmp/h)" --length 10000000 --file - \
  | grep -A8 'BEGIN SSH HOST KEY FINGERPRINTS'
ssh-keyscan -t ed25519 "$IP" > zerox-known-hosts && ssh-keygen -lf zerox-known-hosts   # must match the ED25519 line
```

## 2. First boot

```bash
ssh ubuntu@$IP 'cloud-init status --wait; cat /var/log/zerox-bootstrap.txt; cat /var/log/zerox-apt-keys.txt; \
  systemctl list-timers apt-daily-upgrade.timer --no-pager'
```

Expect `status: done`, `node v22.x`, a cloudflared version, the image's iptables `INPUT` rules
(established replies, ICMP, loopback, NTP replies, `--dport 22` accepted, then `REJECT`), the two
repository key fingerprints (compare them with what NodeSource and Cloudflare publish) and the
next upgrade run between 20:45 and 20:55 UTC.

**Firewall: never UFW on this image.** Oracle's Ubuntu image documentation says not to use UFW:
it can remove the preinstalled iptables rules that reach the boot and block volumes, and the
instance may then not boot (an unattended kernel reboot would leave the gateway down). The
image's `/etc/iptables/rules.v4` (SSH only) and the SSH-only security list are the policy; the
gateway needs no inbound rule (cloudflared dials out, loopback is accepted). Any change goes in
`/etc/iptables/rules.v4`, then `sudo iptables-restore < /etc/iptables/rules.v4`.

Install the units (enabled, started by the first deploy):

```bash
scp deploy/oracle/zerox-gateway.service deploy/oracle/zerox-cron.service deploy/oracle/zerox-cron.timer ubuntu@$IP:/tmp/
ssh ubuntu@$IP 'sudo install -m 0644 /tmp/zerox-gateway.service /tmp/zerox-cron.service /tmp/zerox-cron.timer /etc/systemd/system/ \
  && sudo systemctl daemon-reload && sudo systemctl enable zerox-gateway.service zerox-cron.timer'
```

## 3. Cloudflare Tunnel

Create the tunnel on your own machine (cloudflared installed there), so the account certificate
never lands on the VM. The credentials file is the tunnel's secret: it goes over SSH's stdin
straight to its 0600 place, never through the VM's world-readable `/tmp`.

```bash
cloudflared tunnel login                          # browser: choose the zero-x.live zone
cloudflared tunnel create zerox-gw                # prints <TUNNEL_ID>, writes ~/.cloudflared/<TUNNEL_ID>.json
TUNNEL_ID=<the id it printed>
cloudflared tunnel route dns zerox-gw gw.zero-x.live
ssh ubuntu@$IP "sudo install -o root -g root -m 0600 /dev/stdin /etc/cloudflared/$TUNNEL_ID.json" < ~/.cloudflared/$TUNNEL_ID.json
sed "s/<TUNNEL_ID>/$TUNNEL_ID/g" deploy/oracle/cloudflared-config.yml \
  | ssh ubuntu@$IP 'sudo install -o root -g root -m 0644 /dev/stdin /etc/cloudflared/config.yml'
ssh ubuntu@$IP 'sudo cloudflared tunnel --config /etc/cloudflared/config.yml ingress validate \
  && sudo cloudflared tunnel --config /etc/cloudflared/config.yml ingress rule https://gw.zero-x.live/admin/overview \
  && sudo cloudflared service install && sudo systemctl enable --now cloudflared'
```

`ingress rule` must name the `http_status:404` rule for `/admin/overview`: `gw` carries only the
CLI's paths (`/v1/*` except `/v1/providers/*`, `/auth/device/code`, `/auth/device/token`,
`/auth/session`, `/api/account`) and `/health` and `/ready`. The operator APIs, the relay,
`/releases`, billing and webhooks stay on the Worker. The gateway unit is ordered after
cloudflared, so on a reboot or shutdown the gateway drains its streams before cloudflared stops.

Zone settings the gateway relies on:

- **Network > IP Geolocation** on (adds `CF-IPCountry`, read with `TRUST_CF_IPCOUNTRY=true` for
  the free-pool region rules; the "Add visitor location headers" managed transform is optional,
  the gateway reads only the country). Cloudflare sets `CF-Connecting-IP` on every proxied
  request (`TRUST_CLOUDFLARE=true`).
- **SSL/TLS > Edge Certificates > Always Use HTTPS** on, so plain-HTTP requests to `gw` (and to
  `/v1` in phase 2) are redirected at the edge. The VM itself never sends HSTS: `server.js` sees
  every request as `http://127.0.0.1`, and the app sends HSTS only on HTTPS URLs. The Worker's
  HSTS header (one year, `includeSubDomains`) covers `gw` for browsers that have visited
  `zero-x.live`; to send it from the edge on `gw` too, turn on HSTS on the same page with the
  same max-age and `includeSubDomains`.

## 4. Secrets and the environment file

The workflow writes `/etc/zerox/gateway.env` on every deploy: `wrangler.toml` `[vars]` plus the
secrets `deploy.yml` already binds to the Worker, the same values the Worker has. A `[vars]` entry
or secret named like one of the unit's own settings (`NODE_ENV`, `AUTH_HOST`, `TRUST_CLOUDFLARE`,
...) or a development switch (`DEV_AUTH_ENABLED`, `ALLOW_ANONYMOUS_SESSIONS`, ...) fails the
build, since systemd would let the file override the unit.

**Required here, unlike in `deploy.yml`:** `SUPABASE_SECRET_KEY` and the three secrets the VM must
share with the Worker to behave like it. `deploy.yml` skips a missing one, so a value the Worker
got with `wrangler secret put` but that is not in GitHub would leave the VM without it, silently;
this workflow fails instead, before anything reaches the VM.

| Secret | Without the Worker's value on the VM |
|---|---|
| `SESSION_ENCRYPTION_KEY` | Users' own OpenRouter keys, sealed in their session records, cannot be opened and are dropped. |
| `PROVIDER_KEYS_KEK` | The provider key vault is off: its keys' pools do not serve. |
| `DEVICE_APPROVAL_SECRET` | Device approvals made on the Worker do not verify. |

Each GitHub secret must hold the Worker's current value. If a value exists only on the Worker
and is lost, set a new one in GitHub and run `deploy.yml`, then this workflow: a new
`SESSION_ENCRYPTION_KEY` makes users link OpenRouter again, a new `PROVIDER_KEYS_KEK` means adding
the vault's keys again, a new `DEVICE_APPROVAL_SECRET` only fails sign-ins in progress. Section 6
compares the VM's feature flags with the Worker's after a deploy.

**Cloudflare Access on the operator APIs:** if the Worker's full `/health` shows
`admin_access_configured: true`, put `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` in `wrangler.toml`
`[vars]` (where `GATEWAY_SETUP.md` puts them), so the VM enforces Access as the Worker does. Without
them the VM's operator APIs answer to the operator token alone; the tunnel keeps every operator
path off the VM anyway, so this is the second layer.

Add the three VM secrets once (owner, from a shell that does not log history):

```bash
gh secret set ORACLE_SSH_KEY < zerox-deploy
gh secret set ORACLE_HOST --body "$IP"
gh secret set ORACLE_KNOWN_HOSTS < zerox-known-hosts
shred -u zerox-deploy                              # or keep it only in a password manager
```

The deploy key is then only in GitHub: commands below that act as `deploy` go through your own
`ubuntu` login and `sudo -u deploy`.

A variable the workflow does not write (marked `manual` in `gateway.env.example`) belongs in
`wrangler.toml` `[vars]` (plain values, then the Worker gets it too), in both workflows (secrets),
or as an `Environment=` line in `zerox-gateway.service` (VM only). Hand edits of the file are
replaced by the next deploy.

## 5. Deploy

**Before each deploy:**

- Production's database has every migration of the commit being deployed: from
  `neuroncli/auth-server`, `DATABASE_URL=... node scripts/apply-migrations.mjs --status` lists none
  pending. The VM shares the database with the Worker: a branch whose migrations production lacks
  (or whose migrations were renumbered) fails `/ready` at best, and at worst passes it and fails on
  the RPCs it changed.
- The VM and the Worker run the same commit: deploy `main` to both (`deploy.yml` runs on merge,
  then this workflow on `main`). The run warns when the ref is not `main`.

```bash
gh workflow run deploy-oracle.yml --ref main       # or Actions > Deploy gateway to Oracle VM
gh run watch
```

It runs `npm run check:server`, builds the environment file (a missing required secret stops the
run here), uploads `neuroncli/auth-server` (no tests, fixtures, `node_modules`, `.env*`,
`.dev.vars*` or wrangler files) to `/opt/zerox/releases/<UTC time>-<commit>`, runs
`npm ci --omit=dev` there, sends the environment, points `/opt/zerox/gateway` at the release and
restarts the gateway. The restart returns once the old process has drained (up to 110 s, plus 5 s
when streams had to be cut); then `http://127.0.0.1:8787/ready` is polled up to 30 times, 2 s
apart, each poll at most 3 s: 60 to 150 s. `/ready` answers 200 only when plan limits, the session
store and the catalog load from the database, so a wrong `SUPABASE_SECRET_KEY`, a missing RPC or an
unreachable database fails the run (anonymous `/health` would still say ok). A failed check
restores the previous release and environment and fails the run. The three newest older releases
are kept.

After the first deploy: `ssh ubuntu@$IP sudo systemctl start zerox-cron.timer`.

A restart refuses new connections while it drains (cloudflared answers 502 for that time), so
deploy when traffic is low.

## 6. Health checks

```bash
ssh ubuntu@$IP 'curl -s http://127.0.0.1:8787/ready; echo; curl -s -o /dev/null -w "tunnel %{http_code}\n" http://127.0.0.1:20241/ready'
curl -s https://gw.zero-x.live/health                                        # {"status":"ok","service":...}
curl -s -o /dev/null -w '%{http_code}\n' https://gw.zero-x.live/admin/overview   # 404: operator paths stay on the Worker
# The VM reports the same features as the Worker (flags only, no values); a difference is a missing secret or var.
flags='{database_configured, billing_configured, webhook_configured, session_encryption, provider_key_vault, admin_access_configured, csp_enforced, providers}'
diff <(curl -s -H @admin-header.txt https://zero-x.live/health | jq -S "$flags") \
     <(curl -s -H @admin-header.txt https://gw.zero-x.live/health | jq -S "$flags") && echo 'same flags'
ssh ubuntu@$IP 'systemctl status zerox-gateway cloudflared --no-pager; systemctl list-timers zerox-cron.timer apt-daily-upgrade.timer --no-pager'
NEURON_API_BASE=https://gw.zero-x.live/v1 neuron login && NEURON_API_BASE=https://gw.zero-x.live/v1 neuron
```

`admin-header.txt` (mode 0600) holds `Authorization: Bearer <GATEWAY_ADMIN_TOKEN>`, so the token
stays out of shell history and process lists.

## 7. Logs

```bash
ssh ubuntu@$IP journalctl -u zerox-gateway -f      # ubuntu, or deploy (systemd-journal group)
ssh ubuntu@$IP journalctl -u zerox-cron --since -1h # one JSON line per tick: {"cron":"ok","maintenance":...}
ssh ubuntu@$IP journalctl -u cloudflared --since -1h
```

journald keeps at most 1 GB and 14 days (`/etc/systemd/journald.conf.d/zerox.conf`). The gateway
logs no prompts, keys or request bodies.

## 8. Rollback

- **Release**: run the workflow on the previous commit, or re-activate an earlier release from
  your machine with the same script CI uses (restart, `/ready`, and back to the current release
  if the old one is not ready). The deploy key is not on your machine, so through `ubuntu`:
  ```bash
  ssh ubuntu@$IP 'sudo -u deploy ls -1 /opt/zerox/releases'                     # oldest first
  ssh ubuntu@$IP 'sudo -u deploy cp -p /etc/zerox/gateway.env.prev /etc/zerox/gateway.env.next'   # only if the environment changed
  ssh ubuntu@$IP 'sudo -u deploy bash -s -- <release id>' < deploy/oracle/activate-release.sh
  ```
- **Phase 1**: testers unset `NEURON_API_BASE` and run `neuron login` again (a login made on `gw`
  lives in Postgres, which the Worker does not read while it has KV). To take `gw` down, delete
  its DNS record or stop cloudflared.
- **Phase 2**: see the end of this file.

## Upgrades and restarts

unattended-upgrades installs Ubuntu's security updates and new `nodejs` (NodeSource) and
`cloudflared` packages once a day, between 20:45 and 20:55 UTC (02:15 IST): cloud-init moves
`apt-daily-upgrade.timer` off Ubuntu's 06:00 UTC plus up to 60 minutes, which is 11:30 to 12:30
IST, around Indian midday traffic. needrestart then restarts every service whose binary or
libraries changed (`$nrconf{restart} = 'a'`, set explicitly): `zerox-gateway` drains (new
requests get 502 from cloudflared for up to 110 s), and `cloudflared` cuts open streams after its
30 s grace. A kernel update reboots the VM at 21:30 UTC (03:00 IST); the gateway stops before
cloudflared. Check with `systemctl list-timers apt-daily-upgrade.timer`, `sudo needrestart -b`
and `ls /var/run/reboot-required`. To take an update at another quiet hour:
`sudo apt-get update && sudo apt-get install --only-upgrade nodejs cloudflared`.

## Timeouts: Cloudflare's 125 s

Cloudflare closes a proxied request (Tunnel included) when the origin sends nothing for 125 s
(error 524). What the gateway does:

- **Streaming, before the first byte**: every failover attempt fits in
  `UPSTREAM_FAILOVER_BUDGET_MS` (50 s); the response starts at the first upstream event, so the
  worst first byte is about 50 s plus the reservation calls. Keep that budget well under 125 s.
- **Streaming, mid-stream**: the gateway forwards data events only. Claude's thinking phase
  sends only pings, so a client could see nothing for longer than 125 s. `server.js` now writes
  an SSE comment (`: keep-alive`) after `SSE_HEARTBEAT_MS` (30 s) without output, only between
  whole events; the Neuron CLI and SSE clients skip comments. The upstream idle limit (90 s) still
  ends a dead stream.
- **Non-streaming**: the answer comes whole, after at most the failover budget plus
  `UPSTREAM_IDLE_TIMEOUT_MS` (50 + 90 = 140 s), which can pass 125 s: Cloudflare then answers 524
  and the gateway settles the attempt as cancelled. If that shows up, add
  `Environment=UPSTREAM_IDLE_TIMEOUT_MS=70000` to `zerox-gateway.service` (worst case 120 s; it
  also cuts streams whose upstream is silent for 70 s instead of 90 s).

## Keeping the Always Free instance

Oracle deems an Always Free instance idle, and may reclaim it, when over 7 days the 95th
percentile CPU is under 20 %, network utilisation under 20 % and (A1 only) memory under 20 %. An
alpha gateway sits under all three. What may help: upgrading the tenancy to Pay As You Go (Always
Free resources stay free) with a budget alert at a small amount; check Oracle's current Free Tier
FAQ for whether idle reclamation still applies after the upgrade before relying on it. Nothing on the VM is state:
cloud-init, the tunnel credentials file and a deploy rebuild it in about 15 minutes, so keep the
tunnel credentials file and this runbook at hand.

## Phase 1: test hostname

1. Steps 1 to 6 with `gw.zero-x.live` in the tunnel config.
2. Testers: `NEURON_API_BASE=https://gw.zero-x.live/v1 neuron login`, then use the CLI with the
   same variable. The device code is approved on the usual page (the Worker writes the approval
   to Postgres); the VM mints the session into the Postgres session store, so the login works
   only against `gw` until phase 2. What works on `gw`: chat, models, sign-in, `/usage`,
   `neuron auth status`. What does not, so tell testers: the relay (`neuron engine --share`, the
   mobile app; the VM has no relay Durable Object and `server.js` no WebSocket server), release
   and update checks (`/releases`), the website and billing. They use the default base for those.
3. Watch: `journalctl -u zerox-gateway` (upstream errors, settlement failures), the Worker's
   `/admin/overview` (usage lands in the same database), `loadtest.mjs` numbers versus real CPU
   (`top`, the OCI console metrics).

## Phase 2: `zero-x.live/v1/*` to the VM

`zero-x.live` is a Workers Custom Domain today: every request for that hostname goes to the
Worker. Sending one path elsewhere needs the hostname on a proxied DNS record (the tunnel), the
Worker on a route for `zero-x.live/*`, and a route **without a Worker** for `zero-x.live/v1/*`
(the more specific route wins, so those requests go to the origin: the tunnel).

**The DNS gap.** Removing the Custom Domain deletes its DNS record. A resolver that asks for
`zero-x.live` before the tunnel CNAME exists gets "no such record" and caches that for
min(SOA TTL, SOA minimum): 1800 s on the zone today. For its users the whole site, sign-in and the
API are then down for up to 30 minutes, not a minute. So: lower the negative-caching TTL a day
ahead, and make the two DNS changes back to back through the API (`apex-cutover.mjs`), not by hand
in the dashboard. Its token comes from `CLOUDFLARE_API_TOKEN` only: a short-lived token with
Workers Scripts Write (account), and DNS Write, Zone DNS Settings Write and Workers Routes Write
on the `zero-x.live` zone; delete it afterwards.

Before: phase 1 healthy for real users; sessions in one store ([SESSIONS.md](SESSIONS.md), done
and checked); production migrations applied and the VM and the Worker on the same commit
(section 5); no other merge to `main` until step 6; the tunnel id, account id, zone id and the
Worker's name at hand.

0. **A day ahead**: check the SOA, then lower its minimum TTL (dry run first, then `--apply`):
   ```bash
   curl -s -H 'accept: application/dns-json' 'https://cloudflare-dns.com/dns-query?name=zero-x.live&type=SOA'   # last field: the minimum
   CLOUDFLARE_API_TOKEN=... node deploy/oracle/apex-cutover.mjs --negative-ttl 60 --zone <zone id> --apply
   ```
   The next day the SOA's last field reads 60. If Cloudflare refuses the change for the zone's
   plan, the gap is still cached for up to 1800 s by resolvers that asked during it: do steps 4
   and 5 at a quiet hour (03:00 IST), where the script keeps the gap to about a second.
1. VM: uncomment the two `zero-x.live` ingress rules in `/etc/cloudflared/config.yml`, then
   `sudo cloudflared tunnel --config /etc/cloudflared/config.yml ingress validate` and
   `sudo systemctl restart cloudflared`. Nothing reaches them yet.
2. Dashboard, Workers & Pages > the zero-x.live Worker > Settings > Domains & Routes > Add >
   Route: `zero-x.live/*`, zone `zero-x.live`. The custom domain keeps serving meanwhile.
3. Dashboard, the `zero-x.live` zone > Workers Routes > Add route: `zero-x.live/v1/*`, Worker:
   **None**. If the dashboard refuses either route while the custom domain exists, skip them and
   pass `--create-routes` in step 4: the script adds them right after the CNAME (for that second
   every path reaches the tunnel, which answers 404 outside `/v1/`).
4. Custom Domain off and CNAME `@` to `<TUNNEL_ID>.cfargotunnel.com` (proxied) on, back to back
   (the dry run prints the state and the plan; `--apply` reports the milliseconds between the two
   writes and, if the CNAME never lands, restores the Custom Domain):
   ```bash
   export CLOUDFLARE_API_TOKEN=...      # from a shell that does not log history
   node deploy/oracle/apex-cutover.mjs --to tunnel --account <account id> --zone <zone id> --worker <Worker name> --tunnel $TUNNEL_ID
   node deploy/oracle/apex-cutover.mjs --to tunnel --account <account id> --zone <zone id> --worker <Worker name> --tunnel $TUNNEL_ID --apply
   ```
5. Check:
   ```bash
   curl -sI https://zero-x.live/ | head -1                      # 200 from the Worker (website)
   ssh ubuntu@$IP 'curl -s http://127.0.0.1:20241/metrics | grep -E "^cloudflared_tunnel_total_requests"'
   curl -s https://zero-x.live/v1/models | head -c 200         # the counter above grows by one
   neuron auth status && neuron                                # default base, no NEURON_API_BASE
   ```
   Then watch the zone's Security > Events for WAF or bot rules that now see `/v1` traffic at the
   origin, and the gateway journal.
6. Make `wrangler.toml` match: replace the `zero-x.live` custom-domain entry in `routes` with
   `{ pattern = "zero-x.live/*", zone_name = "zero-x.live" }` and merge. After `deploy.yml` runs,
   Domains & Routes must still show the route, no custom domain for `zero-x.live`, and
   `zero-x.live/v1/*` with no Worker. The other custom domains stay as they are.

**Rollback** (the same DNS gap applies, so the same script, back to back; keep the SOA minimum
lowered until phase 2 has settled):
`node deploy/oracle/apex-cutover.mjs --to worker --account <account id> --zone <zone id> --worker <Worker name> --tunnel $TUNNEL_ID --apply`
deletes the CNAME and attaches the Custom Domain at once (and puts the CNAME back if the attach
never lands). Then delete the `zero-x.live/v1/*` (None) and `zero-x.live/*` routes, and revert the
`wrangler.toml` commit if step 6 was merged. Sessions need nothing: both sides read Postgres.
The tunnel and VM can stay up for phase 1 on `gw`.

## Differences from the Worker on the VM

- No HealthHub Durable Object and no KV: pool health is per process (one process, so it is the
  whole picture), and the models.dev facts in `/v1/models` are empty (KV-only cache).
- No `AI` binding: Workers AI only over REST with `CLOUDFLARE_ACCOUNT_ID` and a token scoped to
  Workers AI (optional; the lineup switches Workers AI off).
- No relay (no `RELAY` Durable Object, no WebSocket server in `server.js`) and no `/releases`
  (no `RELEASES` binding); the tunnel does not route them to the VM.
- No HSTS from the VM itself (section 3).
- The Worker's cron keeps running; `zerox-cron.timer` runs the same jobs from the VM. Both are
  safe together (idempotent release, discovery jobs claimed in Postgres).

The kit is not Oracle-specific apart from section 1 and the firewall note in section 2: the units,
cloud-init and tunnel work the same on any Ubuntu 24.04 VM (arm64 or x64, since NodeSource and
Cloudflare publish both).

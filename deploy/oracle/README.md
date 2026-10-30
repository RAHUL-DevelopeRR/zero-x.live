# Zero-X gateway API on an Oracle Cloud A1 VM, behind Cloudflare Tunnel

The Workers Free plan stops an invocation after 10 ms of CPU, and a long token stream spends
more than that relaying chunks (`check-stream-cpu.mjs`). This kit runs the same Hono app on a
Node server (`neuroncli/auth-server/server.js`) on an Oracle Cloud Always Free Ampere A1 VM.
cloudflared on the VM dials out to Cloudflare, so the VM opens no port except SSH.

Hybrid target: the Worker keeps the website, sign-in (`/auth/*`), accounts, billing webhooks,
the catalog admin, the relay and its own cron on `zero-x.live`. Only `/v1/*` moves to the VM.

- **Phase 1**: the VM serves the whole API at a test hostname, `gw.zero-x.live`, for real users
  who opt in with `NEURON_API_BASE`.
- **Phase 2**: `zero-x.live/v1/*` goes to the VM. Sessions must be in one store first
  ([SESSIONS.md](SESSIONS.md)).

## Files

| File | What it is |
|---|---|
| `cloud-init.yaml` | First boot: users `zerox` (runs the gateway) and `deploy` (CI), Node.js 22 (arm64) from NodeSource's signed apt repo, cloudflared from Cloudflare's signed apt repo, unattended-upgrades, ufw (SSH only), key-only sshd, journald limits, `/opt/zerox` and `/etc/zerox`. |
| `zerox-gateway.service` | systemd unit: `EnvironmentFile=/etc/zerox/gateway.env`, production settings, `Restart=always`, `TimeoutStopSec=120`, sandboxing that leaves V8's JIT alone. |
| `zerox-cron.service`, `zerox-cron.timer` | `scripts/cron.mjs` every 10 minutes (`Persistent=true`): the Worker cron's maintenance and discovery. |
| `cloudflared-config.yml` | Tunnel config template: `gw.zero-x.live` (phase 1), `zero-x.live` `^/v1/` (phase 2, commented), then 404. |
| `gateway.env.example` | Every variable the gateway reads in production, names only, grouped, with where each value comes from. |
| `gateway-env.mjs` | Builds `/etc/zerox/gateway.env` in CI from `wrangler.toml` `[vars]` and the deploy secrets. |
| `activate-release.sh` | Runs on the VM in CI: switch release, restart, `/health`, roll back on failure, prune. |
| `loadtest.mjs`, `loadtest-probe.mjs` | Capacity check: N concurrent long streams against a fake upstream; CPU per stream and the most streams carried. |
| `SESSIONS.md` | How the session store is chosen, and the plan and copy script for one store. |
| `../../.github/workflows/deploy-oracle.yml` | Manual deploy: verify, rsync a release, `npm ci --omit=dev`, environment, restart, health check. |

What changed in the gateway for this (all Node-only, Worker behaviour unchanged): `TRUST_CLOUDFLARE`
(visitor address from `CF-Connecting-IP`, only from the loopback peer), SSE keep-alive comments on
quiet streams, a SIGTERM drain (`SHUTDOWN_GRACE_MS`) and `scripts/cron.mjs`
(`check-node-lifecycle.cjs`, `check-cron.mjs`, `check-oracle-deploy.mjs`).

## Capacity

**The VM.** Always Free A1 in the tenancy's home region: 2 OCPUs (2 Arm cores) and 12 GB in total,
200 GB of boot plus block volume, 10 TB of outbound data a month (Oracle's Always Free page,
checked 2026-10-30). Node runs the gateway's JavaScript on one core, so one gateway process is
bounded by one core; the other core is left to cloudflared (which carries every byte), GC
threads and the OS.

**Measured on the development machine** (Windows x64, Node 24, `loadtest.mjs`, fake upstream, no
database, one SSE event per token; Windows timers held the nominal 50 tokens/s to 31 to 49):

| Concurrent streams | Tokens each | Gateway CPU per token | Event loop busy | TTFB p95 | RSS |
|---|---|---|---|---|---|
| 100 | 1,000 | 53 µs | 17 % | 9 ms | 133 MB |
| 200 | 1,000 | 53 µs | 33 % | 11 ms | 203 MB |
| 400 | 1,000 | 50 µs | 78 % | 95 ms | 242 MB |
| 600 | 500 | 40 µs | 88 % (over the 80 % line, all streams completed) | 147 ms | 262 MB |

So one fast x64 core relays about 20,000 tokens/s, about 400 streams at 50 tokens/s, in about
250 MB. An A1 core is slower per thread: plan on roughly half of that per gateway process
(about 200 concurrent streams at 50 tokens/s) until `loadtest.mjs` has run on the VM, and replace
these numbers with that run. Memory is not the limit (12 GB). Production adds a few Supabase
round trips per request (reservation, renewals, settlement): latency, little CPU here.

**Bandwidth.** A relayed token is one SSE event of about 200 bytes, so a 50 tokens/s stream is
about 10 KB/s and 300 streams about 3 MB/s (24 Mbit/s). Outbound data also counts the prompts
sent to providers (a coding agent's request can be hundreds of KB). 10 TB a month is about
3.8 MB/s averaged over the month.

**Running it on the VM** (before go-live, or with `zerox-gateway` stopped, since it shares the CPU;
the gateway under test is a separate process on a random loopback port, nothing leaves the VM):

```bash
rsync -a --exclude node_modules --exclude '.env*' --exclude '.dev.vars*' neuroncli/auth-server deploy ubuntu@$IP:loadtest/
ssh ubuntu@$IP 'cd loadtest/auth-server && npm ci && node ../deploy/oracle/loadtest.mjs --gateway-dir . --streams 50,100,200,300,400 --tokens 1000 --rate 50 --json ../result.json'
```

A step passes when every stream ends with `[DONE]`, the event loop is busy under 80 % of the time
(`--max-elu`) and its p99 delay stays under 100 ms (`--max-lag-ms`). The summary prints the
largest passing step and `est_streams_per_core`.

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
ssh ubuntu@$IP 'cloud-init status --wait; cat /var/log/zerox-bootstrap.txt; cat /var/log/zerox-apt-keys.txt; sudo ufw status'
```

Expect `status: done`, `node v22.x`, a cloudflared version, the two repository key fingerprints
(compare them with what NodeSource and Cloudflare publish) and ufw allowing OpenSSH only. OCI's
Ubuntu images also ship their own iptables rules (SSH only); ufw sits on top.

Install the units (enabled, started by the first deploy):

```bash
scp deploy/oracle/zerox-gateway.service deploy/oracle/zerox-cron.service deploy/oracle/zerox-cron.timer ubuntu@$IP:/tmp/
ssh ubuntu@$IP 'sudo install -m 0644 /tmp/zerox-gateway.service /tmp/zerox-cron.service /tmp/zerox-cron.timer /etc/systemd/system/ \
  && sudo systemctl daemon-reload && sudo systemctl enable zerox-gateway.service zerox-cron.timer'
```

## 3. Cloudflare Tunnel

Create the tunnel on your own machine (cloudflared installed there), so the account certificate
never lands on the VM:

```bash
cloudflared tunnel login                          # browser: choose the zero-x.live zone
cloudflared tunnel create zerox-gw                # prints <TUNNEL_ID>, writes ~/.cloudflared/<TUNNEL_ID>.json
TUNNEL_ID=<the id it printed>
cloudflared tunnel route dns zerox-gw gw.zero-x.live
sed "s/<TUNNEL_ID>/$TUNNEL_ID/g" deploy/oracle/cloudflared-config.yml > /tmp/config.yml
scp ~/.cloudflared/$TUNNEL_ID.json /tmp/config.yml ubuntu@$IP:/tmp/
ssh ubuntu@$IP "sudo install -o root -g root -m 0600 /tmp/$TUNNEL_ID.json /etc/cloudflared/ \
  && sudo install -m 0644 /tmp/config.yml /etc/cloudflared/config.yml && rm /tmp/$TUNNEL_ID.json /tmp/config.yml \
  && sudo cloudflared tunnel --config /etc/cloudflared/config.yml ingress validate \
  && sudo cloudflared service install && sudo systemctl enable --now cloudflared"
```

Zone settings the gateway relies on: **Network > IP Geolocation** on (adds `CF-IPCountry`, read
with `TRUST_CF_IPCOUNTRY=true` for the free-pool region rules; the "Add visitor location headers"
managed transform is optional, the gateway reads only the country). Cloudflare sets
`CF-Connecting-IP` on every proxied request (`TRUST_CLOUDFLARE=true`).

## 4. Secrets and the environment file

The workflow writes `/etc/zerox/gateway.env` on every deploy: `wrangler.toml` `[vars]` plus the
secrets `deploy.yml` already binds to the Worker (`SUPABASE_SECRET_KEY` required, the rest
optional), the same values the Worker has. Add the three VM secrets once (owner, from a shell
that does not log history):

```bash
gh secret set ORACLE_SSH_KEY < zerox-deploy
gh secret set ORACLE_HOST --body "$IP"
gh secret set ORACLE_KNOWN_HOSTS < zerox-known-hosts
shred -u zerox-deploy                              # or keep it only in a password manager
```

A variable the workflow does not write (marked `manual` in `gateway.env.example`) belongs in
`wrangler.toml` `[vars]` (plain values, then the Worker gets it too), in both workflows (secrets),
or as an `Environment=` line in `zerox-gateway.service` (VM only). Hand edits of the file are
replaced by the next deploy.

## 5. Deploy

```bash
gh workflow run deploy-oracle.yml --ref <branch>   # or Actions > Deploy gateway to Oracle VM
gh run watch
```

It runs `npm run check:server`, uploads `neuroncli/auth-server` (no tests, fixtures, `node_modules`,
`.env*`, `.dev.vars*` or wrangler files) to `/opt/zerox/releases/<UTC time>-<commit>`, runs
`npm ci --omit=dev` there, writes the environment, points `/opt/zerox/gateway` at the release,
restarts the gateway (in-flight streams drain first, up to 110 s) and polls
`http://127.0.0.1:8787/health` on the VM for 60 s. A failed check restores the previous release and
environment and fails the run. The three newest older releases are kept.

After the first deploy: `ssh ubuntu@$IP sudo systemctl start zerox-cron.timer`.

A restart refuses new connections while it drains (cloudflared answers 502 for that time), so
deploy when traffic is low.

## 6. Health checks

```bash
ssh ubuntu@$IP 'curl -s http://127.0.0.1:8787/health; echo; curl -s -o /dev/null -w "tunnel %{http_code}\n" http://127.0.0.1:20241/ready'
curl -s https://gw.zero-x.live/health             # {"status":"ok","service":...}
curl -s -H @admin-header.txt https://gw.zero-x.live/health | jq '{database_configured, provider_key_vault, session_encryption}'
ssh ubuntu@$IP 'systemctl status zerox-gateway cloudflared --no-pager; systemctl list-timers zerox-cron.timer'
NEURON_API_BASE=https://gw.zero-x.live neuron login && NEURON_API_BASE=https://gw.zero-x.live neuron
```

`admin-header.txt` (mode 0600) holds `Authorization: Bearer <GATEWAY_ADMIN_TOKEN>`, so the token
stays out of shell history and process lists.

## 7. Logs

```bash
journalctl -u zerox-gateway -f                     # as deploy or ubuntu (systemd-journal group)
journalctl -u zerox-cron --since -1h               # one JSON line per tick: {"cron":"ok","maintenance":...}
journalctl -u cloudflared --since -1h
```

journald keeps at most 1 GB and 14 days (`/etc/systemd/journald.conf.d/zerox.conf`). The gateway
logs no prompts, keys or request bodies.

## 8. Rollback

- **Release**: run the workflow on the previous commit, or on the VM as `deploy`:
  ```bash
  ls -1 /opt/zerox/releases                        # oldest first
  ln -sfn /opt/zerox/releases/<previous> /opt/zerox/gateway.next && mv -Tf /opt/zerox/gateway.next /opt/zerox/gateway
  cp -p /etc/zerox/gateway.env.prev /etc/zerox/gateway.env   # only if the environment changed
  sudo systemctl restart zerox-gateway.service
  ```
- **Phase 1**: testers unset `NEURON_API_BASE` and run `neuron login` again (a login made on `gw`
  lives in Postgres, which the Worker does not read while it has KV). To take `gw` down, delete
  its DNS record or stop cloudflared.
- **Phase 2**: see the end of this file.

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
2. Testers: `NEURON_API_BASE=https://gw.zero-x.live neuron login`, then use the CLI with the same
   variable. The device code is approved on the usual page (the Worker writes the approval to
   Postgres); the VM mints the session into the Postgres session store, so the login works only
   against `gw` until phase 2.
3. Watch: `journalctl -u zerox-gateway` (upstream errors, settlement failures), the Worker's
   `/admin/overview` (usage lands in the same database), `loadtest.mjs` numbers versus real CPU
   (`top`, the OCI console metrics).

## Phase 2: `zero-x.live/v1/*` to the VM

`zero-x.live` is a Workers Custom Domain today: every request for that hostname goes to the
Worker. Sending one path elsewhere needs the hostname on a proxied DNS record (the tunnel), the
Worker on a route for `zero-x.live/*`, and a route **without a Worker** for `zero-x.live/v1/*`
(the more specific route wins, so those requests go to the origin: the tunnel).

Before: phase 1 healthy for real users; sessions in one store ([SESSIONS.md](SESSIONS.md), done
and checked); no other merge to `main` until step 7; the tunnel id at hand.

1. VM: uncomment the `zero-x.live` `^/v1/` ingress rule in `/etc/cloudflared/config.yml`, then
   `sudo cloudflared tunnel --config /etc/cloudflared/config.yml ingress validate` and
   `sudo systemctl restart cloudflared`. Nothing reaches it yet.
2. Dashboard, Workers & Pages > the zero-x.live Worker > Settings > Domains & Routes > Add >
   Route: `zero-x.live/*`, zone `zero-x.live`. The custom domain keeps serving meanwhile.
3. Dashboard, the `zero-x.live` zone > Workers Routes > Add route: `zero-x.live/v1/*`, Worker:
   **None**. If the dashboard refuses either route while the custom domain exists, do steps 4
   and 5 first and these two right after: until then every `zero-x.live` path reaches the
   tunnel, which answers 404 outside `/v1/`, so the website is down for that minute.
4. Same Domains & Routes page: remove the **Custom Domain** `zero-x.live`. This deletes its DNS
   record: `zero-x.live` does not resolve until step 5, so do step 5 at once.
5. Point the hostname at the tunnel: `cloudflared tunnel route dns zerox-gw zero-x.live` from your
   machine, or DNS > Add record: CNAME `@` to `<TUNNEL_ID>.cfargotunnel.com`, **Proxied**.
6. Check:
   ```bash
   curl -sI https://zero-x.live/ | head -1                      # 200 from the Worker (website)
   ssh ubuntu@$IP 'curl -s http://127.0.0.1:20241/metrics | grep -E "^cloudflared_tunnel_total_requests"'
   curl -s https://zero-x.live/v1/models | head -c 200         # the counter above grows by one
   neuron auth status && neuron                                # default base, no NEURON_API_BASE
   ```
   Then watch the zone's Security > Events for WAF or bot rules that now see `/v1` traffic at the
   origin, and the gateway journal.
7. Make `wrangler.toml` match: replace the `zero-x.live` custom-domain entry in `routes` with
   `{ pattern = "zero-x.live/*", zone_name = "zero-x.live" }` and merge. After `deploy.yml` runs,
   Domains & Routes must still show the route, no custom domain for `zero-x.live`, and
   `zero-x.live/v1/*` with no Worker. The other custom domains stay as they are.

**Rollback** (minutes): delete the `@` CNAME to the tunnel; Domains & Routes: add the Custom
Domain `zero-x.live` back; delete the `zero-x.live/v1/*` (None) and `zero-x.live/*` routes; revert
the `wrangler.toml` commit if step 7 was merged. Sessions need nothing: both sides read Postgres.
The tunnel and VM can stay up for phase 1 on `gw`.

## Differences from the Worker on the VM

- No HealthHub Durable Object and no KV: pool health is per process (one process, so it is the
  whole picture), and the models.dev facts in `/v1/models` are empty (KV-only cache).
- No `AI` binding: Workers AI only over REST with `CLOUDFLARE_ACCOUNT_ID` and a token scoped to
  Workers AI (optional; the lineup switches Workers AI off).
- The Worker's cron keeps running; `zerox-cron.timer` runs the same jobs from the VM. Both are
  safe together (idempotent release, discovery jobs claimed in Postgres).

The kit is not Oracle-specific apart from section 1: the units, cloud-init and tunnel work the
same on any Ubuntu 24.04 VM (arm64 or x64, since NodeSource and Cloudflare publish both).

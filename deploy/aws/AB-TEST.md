# A/B test: Worker vs EC2 for `/v1` chat

The Worker ran the whole chat pipeline and requests died on its CPU budget (error 1102, outcome
`exceededCpu`) before the first token. With the proxy switch (`src/ec2-proxy.js`) the Worker only
forwards, and the Node server on EC2 runs the pipeline. This harness measures both side by side and
says, criterion by criterion, whether that is true on a real Cloudflare edge, tunnel and database.

- **Arm A**: a staging Worker with no `EC2_PROXY_PREFIXES` (the pipeline on the Worker).
- **Arm B**: a staging Worker of the same commit whose `EC2_PROXY_PREFIXES` covers `/v1/`
  (forwarded to the staging VM). Two Workers, because once chat is routed every chat alias is
  forwarded too: one Worker cannot keep an arm A path.

Files: `abtest.mjs` (the CLI), `abtest-guard.mjs` (safety rules), `abtest-sse.mjs` (the timed
client), `abtest-payloads.mjs` (request bodies), `synth-upstream.mjs` and `zerox-synth.staging.service`
(the synthetic provider and witness), `abtest-tail.mjs` (Workers CPU from `wrangler tail`),
`vm-sampler.mjs` (the VM, read-only), `abtest-local.mjs` (the offline target),
`abtest-targets.example.json`. `neuroncli/auth-server/check-abtest.mjs` tests the rules and runs a
local A/B (part of `npm run check:proxy`).

## What proves the CPU problem is gone

Each run writes `summary.json` with these criteria (`abtest.mjs report <runDir>` recomputes them):

| | Criterion | What it proves |
|---|---|---|
| P1 | Every arm B 2xx carries `X-Zerox-Runtime: node`; the synthetic upstream saw the VM (no `CF-Worker` header) for every B request | Forwarded `/v1` runs on EC2, the provider call included |
| P2 | B's Workers `cpuTime` p99 at most 2 ms, its slope against body size and tokens about 0, outcomes only `ok` (or `canceled` in S8), tail coverage at least 95 % | The Worker never runs chat-handler for forwarded requests: its CPU is proxy overhead only |
| P3 | A's baseline recorded (S3-S5 reproduce `exceededCpu` or 1102 pages) | The problem existed on this commit and these payloads |
| P4 | B completes at least 99.5 % of steady streams, no 5xx, event-stream and `x-request-id` as A | The first token arrives reliably, long streams complete (S7) |
| P5 | B's first-token p50 at most 150 ms above A's (S1, S2) | The extra hop costs little |
| P6 | On the VM: CPU p95 at most 80 %, MemAvailable at least 40 %, steal about 0 | EC2 has headroom at the tested concurrency |
| P7 | Every cancelled stream closed at the upstream within 5 s; one usage event per `x-request-id` | Disconnects reach the provider; billing and settlement stay correct |
| P8 | During S11-S13 B answers only node 2xx or the Worker's JSON 503 with Retry-After; never HTML, never a Worker 2xx | A failed EC2 route cannot reactivate the Worker inference path |
| P9 | Every stream completes across a VM deploy (S10a) | Streams survive a rolling deploy |

S14 (the switch drill) shows the only way back: B turns `worker` only while
`EC2_PROXY_PREFIXES` is deleted, and `node` again once it is put back.

## Offline first (no staging needed)

```bash
cd neuroncli/auth-server && node check-abtest.mjs
node ../../deploy/aws/abtest.mjs run --target local --scenarios S1,S2,S6,S7,S8,S9 --execute --confirm local
```

`local` runs the Worker entry in two processes (A and B), `server.js` as EC2 and the synthetic
upstream, all on loopback. Workers CPU cannot be measured off Cloudflare: P2 there compares B's
forwarding decision (under 1 ms) and each Worker process's event-loop time, a stand-in.

## Staging setup (once)

Nothing here touches production; every name below ends in `-staging`.

1. **Database**: a separate Supabase project, in production's region. Apply the migrations
   (`DATABASE_URL=<staging> node scripts/apply-migrations.mjs`), then seed: a plan-policy row that
   raises the test plan's concurrency and rpm above the run's caps, two approved catalog rows
   `omniroute/synth-primary` and `omniroute/synth-secondary` (with a context window above 1M
   tokens, or S3 answers `context_length_exceeded` on both arms), and a dedicated test user.
   Production's database is never used for this harness (the `shared-production` profile is a
   two-stream smoke test with real providers only, S1, S2 and S7).
2. **VM**: a separate staging instance and stack (`gateway-vm.yaml` names its key pair and
   launch template, so a copy needs `zerox-staging` names; review it with cfn-lint before a change
   set). Its own tunnel `zerox-aws-staging`: `aws-staging.zero-x.live` to `127.0.0.1:8787` and
   `synth-staging.zero-x.live` to `127.0.0.1:8899`. Its `gateway.env`: the staging Supabase,
   `EC2_PROXY_SECRET` (a staging value), `EXTRA_WEB_HOSTS=zerox-b-staging.<subdomain>.workers.dev`
   (the host arm B forwards), `OMNIROUTE_BASE_URL=https://synth-staging.zero-x.live/v1` and
   `OMNIROUTE_API_KEY` = the synth key. Deploy with
   `push-release.sh --instance-id <staging> --known-hosts <staging> --env-file <staging>`.
   Install the synthetic upstream as `zerox-synth.staging.service` says (started by hand, never enabled).
3. **Workers**: one config, `neuroncli/auth-server/wrangler.staging.toml` (gitignored), deployed
   under two names:
   ```toml
   name = "zerox-a-staging"
   main = "src/index.js"
   compatibility_date = "2024-05-02"
   compatibility_flags = ["enable_request_signal"]
   workers_dev = true
   preview_urls = false
   [triggers]
   crons = []
   [observability]
   enabled = true
   [vars]
   SUPABASE_URL = "https://<staging project>.supabase.co"
   SUPABASE_PUBLISHABLE_KEY = "<staging publishable key>"
   OMNIROUTE_BASE_URL = "https://synth-staging.zero-x.live/v1"
   NVIDIA_HOSTED = "false"
   [[durable_objects.bindings]]
   name = "HEALTH_HUB"
   class_name = "HealthHub"
   [[migrations]]
   tag = "v1-health-hub"
   new_sqlite_classes = ["HealthHub"]
   ```
   No routes, no `SESSIONS_KV` (sessions live in Postgres, as after CUTOVER.md step 1: with KV
   bound, arm B refuses with `session_store_split`), no AI binding. Check the bundle first with
   `npx wrangler@4.147.0 deploy --config wrangler.staging.toml --dry-run --outdir <tmp>`, then
   `npx wrangler@4.147.0 deploy --config wrangler.staging.toml --name zerox-a-staging --var GIT_COMMIT:<sha>`
   and the same with `--name zerox-b-staging`. Secrets on both (`secret put <NAME> --name <worker>`,
   staging values): `SUPABASE_SECRET_KEY`, `SESSION_ENCRYPTION_KEY`, `DEVICE_APPROVAL_SECRET`,
   `OMNIROUTE_API_KEY`, `GATEWAY_ADMIN_TOKEN`. On `zerox-b-staging` only: `EC2_PROXY_SECRET`,
   `EC2_PROXY_ORIGIN` = `https://aws-staging.zero-x.live` (a secret here, so S13 can change it)
   and `EC2_PROXY_PREFIXES` = `zerox-b-staging.<subdomain>.workers.dev/v1/`.
4. **Credential**: an `nzx_` API key of the test user (or its `ses_` token, typed at the hidden
   prompt only). `ZEROX_AB_TOKEN` takes an `nzx_` key; never pass one on the command line.
5. **Targets**: copy `abtest-targets.example.json` to `abtest-targets.local.json` and fill it in.

## A run

```bash
node deploy/aws/abtest.mjs plan --target staging --scenarios S1,S2,S3,S4,S5,S6,S7,S8,S9   # read the plan
# on the VM, in a second terminal: node vm-sampler.mjs --seconds 5400 --out ~/samples.jsonl
ZEROX_AB_TOKEN=... node deploy/aws/abtest.mjs run --target staging --scenarios S1,S2,S3,S4,S5,S6,S7,S8,S9 \
  --tail --execute --confirm zerox-b-staging.<subdomain>.workers.dev
node deploy/aws/abtest.mjs run --target staging --scenarios S10,S11,S12,S13,S14 --execute --confirm zerox-b-staging.<subdomain>.workers.dev
node deploy/aws/abtest.mjs report <runDir> --ec2 samples.jsonl [--workers-logs <export>]
```

- `--tail` runs `npx wrangler@4.147.0 tail` on both staging Workers and joins each event to its
  request by the `?ab=<run>.<seq>` query (the proxy forwards the query; Hono ignores it). If tail
  events carry no `cpuTime`, `tail-fields.jsonl` says so: export the run's window from Workers Logs
  and pass it with `--workers-logs`.
- Operator scenarios (S10-S14) print the exact staging command, wait for Enter, record the time
  and probe arm B once a second for 60 s. The harness never runs them.
- P7's settlement half: after a run, `GET /api/usage/events` with the test credential lists one
  event per `x-request-id` in `requests.jsonl`; a cancelled request shows `error` with partial
  usage or `refunded`.

## Safety (not switchable)

Dry run unless `--execute`; a remote run also needs `--confirm` with arm B's host. Targets are
names, never URLs; hosts must be https, without port or userinfo, not an IP, with a first label
that is `staging` or ends in `-staging`; the production hosts and Workers are refused in every
spelling. Fetch reaches only the run's origins and never follows a redirect. Caps: 64 streams,
120 s streams, 2,000 requests a run, 10 new requests a second, 10,000 a UTC day on this machine
(defaults 4, 300, 2 and 3,000; Workers Free's 100,000 a day are shared with production).
Circuit breakers stop a run on a B 2xx from the Worker (fail open), a 401 or 403, or B failing 5 %
of 20 outside the failure scenarios. Results hold counts, timings and allow-listed headers only.

## Cleanup

Revoke the test credential, stop `zerox-synth` and the staging VM, and disable workers.dev on both
staging Workers (or delete them) between windows.

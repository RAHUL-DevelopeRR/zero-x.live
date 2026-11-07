# Gateway configuration, rollout and launch checklist

The Worker (`wrangler.toml`: website + API on zero-x.live, `wrangler.api.toml`: API-only Worker)
and `node server.js` run the same Hono application (`src/index.js`). Routes, errors, plans and
RPCs are defined in [docs/PLATFORM_CONTRACT.md](docs/PLATFORM_CONTRACT.md). The local
development runbook is in [README.md](README.md#local-development). The Node server on the EC2
VM behind Cloudflare Tunnel, which the Worker forwards to during the Phase 1 cutover, has its own
runbooks in [deploy/aws/README.md](../../deploy/aws/README.md) and
[deploy/aws/CUTOVER.md](../../deploy/aws/CUTOVER.md).

## Environment and secrets

Plain values go in `wrangler.toml` `[vars]` (or `.env` for Node). **Secrets** go in Worker
secrets (bound by `.github/workflows/deploy.yml` from GitHub Actions secrets) or the container's
secret store, never in a committed file. `.dev.vars.example` lists them with comments.

**Hosted lineup (owner decision, 2026-10-29):** Groq, Claude, OpenRouter, NVIDIA and Z.ai; Gemini
and Workers AI off by configuration (`GEMINI_MODELS` and `CLOUDFLARE_MODELS` empty). The lineup
files carry it alike: `wrangler.toml` and `wrangler.api.toml` `[vars]`, `.dev.vars.example` and
`.env.example` (the Node server, e.g. the planned `/v1` host). `check-routing-v2.mjs` keeps them
equal. Leave `GROQ_MODELS`, `NVIDIA_MODELS` and `ZAI_MODELS` unset: an empty list switches its
provider off.

### Runtime, identity and database

| Variable | Kind | Default | Purpose |
|---|---|---|---|
| `SUPABASE_URL` | var | — | Supabase project URL (Auth and PostgREST RPCs). |
| `SUPABASE_PUBLISHABLE_KEY` | var | — | Public browser key (`sb_publishable_…`; legacy `SUPABASE_ANON_KEY` JWT accepted). |
| `SUPABASE_SECRET_KEY` | **secret** | — | Server-only `sb_secret_…` key for every RPC. Without it the database counts as not configured. |
| `SUPABASE_AUTH_PROVIDERS` | var | `google,email,phone,azure,github` | Sign-in providers offered when enabled in Supabase. |
| `SUPABASE_STORAGE_KEY` | var | `zerox-supabase-auth` | Browser storage key shared by the site pages. |
| `DATABASE_DRIVER` | var | `postgrest` | `pglite` = in-process Postgres for local Node development and tests only. |
| `PGLITE_DATA_DIR` | var | in memory | PGlite directory (`npm run db:dev` prepares it). |
| `ALLOW_LOCAL_DATABASE` | var | unset | `true` lets PGlite serve a non-loopback `AUTH_HOST`. PGlite is always refused under `NODE_ENV=production` and in Workers. |
| `DATABASE_URL` | **secret** | — | Operator machine only: `scripts/apply-migrations.mjs --status/--apply` (passed to psql through PG* variables, never argv). |
| `SESSIONS_KV` | binding | — | Worker KV for sessions and PKCE records. Without it sessions use the hashed Postgres store (7-day write cap; sessions in use are re-armed daily). |
| `AI` | binding | — | Workers AI (free pool for Llama 3.3 70B). Node: `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` (**secret**). |
| `AUTH_HOST` / `AUTH_PORT` | var (Node) | `127.0.0.1` / `8787` | Bind address and port (`0` = any free port, logged at start). |
| `AUTH_REUSE_PORT` | var (Node) | unset | `true` binds `AUTH_PORT` with `SO_REUSEPORT` (Linux, Node 22.12 or later; an older Node is refused at start), so the next release's instance listens before the old one drains (`zerox-gateway@0` and `@1` on EC2). |
| `READY_PORT` | var (Node) | unset | A second listener on `127.0.0.1:<port>` that answers only `GET /ready` and `GET /health`, so a deploy can check one instance while both share `AUTH_PORT`. It drains with the main listener. |
| `ASSETS_DIR` | var (Node) | the repository root | The website files: exactly what the Worker uploads from that directory under `.assetsignore` (never the release's `REVISION`). On EC2 the instance's link `/opt/zerox/instance-N` (`zerox-gateway@.service`); the link is resolved at start, so an instance keeps serving the release it started with. |
| `NEURON_API_ONLY` | var (Node) | unset | `true` = API only, no website assets. |
| `NEURON_RUNTIME` | set by server.js | — | Marks the Node runtime; never set it on the Worker. |
| `TRUST_CLOUDFLARE` | var (Node) | unset | `true` behind Cloudflare Tunnel: the per-IP limits use `CF-Connecting-IP`, honoured only from a loopback peer (cloudflared) and only when it is one valid address. Unset: the socket address, so every tunnel visitor would share one bucket. |
| `SHUTDOWN_GRACE_MS` | var (Node) | `110000` | On SIGTERM the listener closes and requests in flight get this long to finish (and settle) before they are cut. Keep systemd's `TimeoutStopSec` above it. |
| `SSE_HEARTBEAT_MS` | var (Node) | `30000` | An event stream with no output for this long gets an SSE comment, so Cloudflare's 125 s origin read timeout never ends a quiet stream. |
| `DEV_AUTH_ENABLED` | var (Node) | unset | Local dev identity (`dev_<base64url(email)>`). Ignored unless the Node server is bound to loopback; never in wrangler files. |
| `ALLOW_ANONYMOUS_SESSIONS` | var | unset | Development only: account-less sessions with an in-memory store. |
| `NODE_ENV` | var (Node) | — | `production` refuses the PGlite driver, and makes the server an origin, as `EC2_PROXY_SECRET`, `EXTRA_WEB_HOSTS` or `TRUST_CLOUDFLARE=true` do. An origin answers requests the Worker forwards with `EC2_PROXY_SECRET` (at least 32 characters, or the server does not start; a forward carrying another value, or naming a host this server does not serve, gets the gateway's 503 `service_unavailable` with Retry-After and `X-Zerox-Refused: proxy_secret_mismatch` or `misdirected_request`, logged at most once a minute), the hosts in `EXTRA_WEB_HOSTS` directly, the relay paths (`/v1/relay`, `/relay/…`) on `relay.zero-x.live`, and `GET /health` and `/ready`. Anything else gets a 403. Behind your own TLS proxy, list its public host in `EXTRA_WEB_HOSTS`. |

### Sessions, security and operator access

| Variable | Kind | Default | Purpose |
|---|---|---|---|
| `CLI_SESSION_TTL_HOURS` | var | `720` | CLI session lifetime (reported as `expires_at`). |
| `SESSION_TTL_HOURS` | var | `24` | Lifetime of sessions created before hashed storage. |
| `SESSION_ENCRYPTION_KEY` | **secret** | unset | ≥ 32 chars (`openssl rand -base64 32`); seals users' own OpenRouter keys (AES-GCM). Rotating it disconnects those keys. |
| `GATEWAY_ADMIN_TOKEN` | **secret** | unset | ≥ 32 random chars; `/admin/overview`, `/admin/discovery/*`, `/admin/providers/keys`, `/admin/catalog/*`, `/v1/providers/health`, full `/health`. With Cloudflare Access configured, every one of these except full `/health` also needs an Access JWT. |
| `PROVIDER_KEYS_KEK` | **secret** | unset | 32 random bytes, base64 (`openssl rand -base64 32`): encrypts the provider key vault (contract §11.1). Unset = no vault; the admin page answers 503. Losing or rotating it means re-adding the keys. |
| `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` | var | unset | Cloudflare Access team domain (`<team>.cloudflareaccess.com`) and the audience tag of the Access application on `dashboard.zero-x.live/admin`. When both are set, the key vault and model catalog pages and every operator API (`/admin/*`, `/v1/providers/health`) also require a valid Access JWT, on every host (workers.dev included). Full `/health` stays on the operator token alone. |
| `OIOP_SIGNING_JWK` | **secret** | unset | Ed25519 private JWK for signing offer manifests (`node scripts/oiop-keygen.mjs`); its public half is served at `/oiop/keys.json`. Unset: manifests can be viewed but not signed. |
| `OIOP_SCRUB` | var | `all` | Prompt secret scrubber: `all`, `untrusted` (T2/T3 offers only) or `off` (contract §12.3). |
| `HEALTH_CANARIES` | var | on | `false` stops HealthHub's canary requests (contract §12.5). |
| `DISCOVERY_CREDITS` | var | on | With `ANTHROPIC_API_KEY`, the weekly job that finds free cloud and AI credit programs (contract §12.6); `false` turns it off. |
| `DISCOVERY_RESEARCH` | var | on | With `ANTHROPIC_API_KEY`, the weekly research and credits jobs (Claude with web search, capped by `DISCOVERY_RESEARCH_MAX_USD`); `false` turns both off. |
| `CSP_ENFORCE` | var | `true` | The Content-Security-Policy is enforced; `false` is the kill switch and sends it as `Content-Security-Policy-Report-Only`. Inline scripts and styles are allowed by sha256 (`src/csp-hashes.js`, rebuilt with `npm run build:csp`), never by `'unsafe-inline'`. |
| `PRICING_URL` | var | `https://zero-x.live/pricing` | `upgrade_url` in errors (https only). |

### Moving to the Node server on EC2

The Worker keeps every Custom Domain and forwards chosen paths to the Node server (`server.js`)
on EC2, which runs the same app behind Cloudflare Tunnel. The switch is the first thing in the
Worker's `fetch`, before Hono and any middleware (`src/ec2-proxy.js`); a forward returns EC2's
answer untouched (streams, redirects and WebSocket upgrades included), so it costs the Worker
almost no CPU.

| Variable | Kind | Default | Purpose |
|---|---|---|---|
| `EC2_PROXY_PREFIXES` | **Worker secret** | unset | Comma list of host + path prefixes to forward, e.g. `zero-x.live/v1/,dashboard.zero-x.live/` (an entry without a path covers its host; `zero-x.live/v1/` covers `/v1/models` but not `/v1`; an entry written as a URL, `https://zero-x.live/v1/`, means its host + path). Once an entry covers `/v1/chat/completions`, chat goes to EC2 under every alias and host, and `/v1/models/health` with it. An entry that is not a host + path (a port, a wildcard, quotes, spaces, `/V1/`) is invalid: chat and inference then answer 503. Empty or unset: nothing is forwarded. Set it only with `wrangler secret put EC2_PROXY_PREFIXES`: it takes effect in seconds without a commit, and `deploy.yml` never lists it, so a deploy never overwrites it. Emptying it is the rollback. |
| `EC2_PROXY_SECRET` | **secret** (Worker and EC2) | unset | Sent as `x-zerox-proxy-secret` with every forward; the Node server trusts the forwarded `x-zerox-*` headers (host, scheme, client IP, country, city, region, ASN, network name) only when it matches its own value. Visible ASCII only, with no surrounding whitespace or newline: without it, or when a header cannot carry it exactly, every routed path answers the JSON 503 `service_unavailable` with Retry-After (logged per request with the ray and the reason, never the value); the Worker never serves a routed path itself. Bound by the deploy from one GitHub secret, so both runtimes hold the same value. |
| `EC2_PROXY_ORIGIN` | var (Worker) | `https://aws.zero-x.live` | Where forwards go (https only; a host the Worker itself serves is a loop). Anything else: routed paths answer 503. |
| `EXTRA_WEB_HOSTS` | var (EC2 only) | unset | Comma list of test hosts, e.g. `aws.zero-x.live`. A test host serves the whole site on its own origin, like the local Node server: site pages and clean URLs, `/dashboard`, `/device` and the operator pages `/admin/keys` and `/admin/models` (behind Cloudflare Access when `CF_ACCESS_*` are set, so the Access application must then cover `<test host>/admin` too), with relative redirects, `noindex` on its pages and a `Disallow: /` robots.txt, but never the dev identity. Its https pages may call the identity APIs (CORS) and approve device sign-ins like the production hosts; a device sign-in started there is approved there. Never set it on the Worker, and remove it on EC2 when the test window closes. |
| `GIT_COMMIT` | set by the deploy | unset | The short commit SHA `/health` reports as `commit` (null when unset): `deploy.yml` passes it to the Worker with `--var`; on EC2 `server.js` reads the release's `REVISION` file. Once a prefix covers a host, that host's `/health` is EC2's: compare the Worker's commit through a URL no prefix covers. |

Every forward fetches `EC2_PROXY_ORIGIN` + path, so in Cloudflare's cache all visitor hosts and
schemes share one key per path. The app keeps static files the same on every host and marks what
depends on the host or scheme `Cache-Control: private` (robots.txt, every redirect). Never put a
cache-everything rule on the `EC2_PROXY_ORIGIN` host: it would store pages and answers of one host
for all of them.

### Billing (Razorpay)

| Variable | Kind | Purpose |
|---|---|---|
| `RAZORPAY_KEY_ID` | var | Public key id (`rzp_test_…` outside production, `rzp_live_…` at launch). |
| `RAZORPAY_KEY_SECRET` | **secret** | API secret: REST calls and checkout signatures. Billing answers `503 billing_not_configured` without it. |
| `RAZORPAY_WEBHOOK_SECRET` | **secret** | Webhook signing secret (HMAC-SHA256 of the raw body). |
| `RAZORPAY_API_BASE` | tests only | Loopback fake server (`check-billing.mjs`, `check-e2e-local.mjs`); https or loopback http only. |

Razorpay plan ids are not variables: `scripts/razorpay-bootstrap.mjs` prints the SQL that stores
them in `zerox_plan_policy.razorpay_plan_id_inr/usd`.

### Upstream pools and routing

| Variable | Kind | Default | Purpose |
|---|---|---|---|
| `GROQ_API_KEY`, `GEMINI_API_KEY` | **secret** | unset | Free pools (Groq free org; Gemini free tier, refused for EEA/GB/CH callers). Optional once the provider key vault holds keys: each vault key is its own pool and these serve last. |
| `GROQ_PAID_API_KEY`, `GEMINI_PAID_API_KEY` | **secret** | unset | Paid pools for Pro/Max (Groq Developer plan, billing-linked Gemini project). Unset = no paid pool. |
| `GLM_API_KEY` | **secret** | unset | Z.ai's free GLM-4.7-Flash and GLM-4.5-Flash (key slot `zai.free`; owner lineup 2026-10-29). Already a GitHub secret; deploy pushes it to the Worker. Free models answer one request at a time (concurrency 1 per model in the console; the health checker treats it as one slot for the whole account, since that is not established): apply `20261029001000_pool_concurrency.sql` so the gateway holds the second request back instead of getting 429s. Unset: both list as `not_configured`. |
| `ANTHROPIC_API_KEY` | **secret** | unset | Claude Sonnet 5.5 and Claude Opus 5.5 paid pools (Pro and Max, billed from credits; key slot `anthropic.paid`) and the weekly discovery research agent. Set it with `gh secret set ANTHROPIC_API_KEY`; deploy pushes it to the Worker. Unset: both Claude models list as `not_configured`. Also set a monthly spend limit for the key's workspace in the Anthropic console (see "Model catalog and Claude"). |
| `ANTHROPIC_THINKING_REPLAY` | var | on | `false` stops replaying Claude's signed thinking blocks into the next turn and stops sending the thinking-binding beta (contract §13.3). |
| `PAID_DAILY_SPEND_CAP_USD` | var | unset | A number above 0 lowers every paid pool's daily spend cap (upstream USD per UTC day) to at most this value; it can never raise one (contract §13.4). |
| `CATALOG_SOURCE` | var | unset | Unset: the approved catalog rows when the database is configured, over the code catalog. `code`: kill switch, `src/catalog.js` only (contract §13.1). |
| `CLOUDFLARE_PAID` | var | unset | `true` adds paid Workers AI pools (Workers Paid accounts only). |
| `HOSTED_CONNECTORS` | var | unset = `false` | `true`: serves `/api/connectors/*`, the dashboard Connectors tab and `/mcp/<id>` (contract section 18.4), and `/api/account` reports each plan's hosted connector ids (`policy.connectors.hosted`, section 18.1). Unset: every one of those routes answers 404, every plan reports `hosted: []` and clients offer local connectors only. See "Hosted connectors" below before switching it on. |
| `CONNECTOR_TOKENS_KEK` | **secret** | unset | 32 random bytes, base64 (`openssl rand -base64 32`). Seals the vendor OAuth tokens of linked connector accounts (`src/connector-vault.js`). Never reuse `PROVIDER_KEYS_KEK`. Losing it loses every link (users connect again). Without it hosted connectors answer 503. |
| `CONNECTOR_<ID>_*` | var + **secret** | unset | Per hosted connector (`ATLASSIAN`, `GITHUB`, `LINEAR`, `NOTION`, `SLACK`): `CLIENT_ID`, `CLIENT_SECRET` (secret), `SCOPES`, and overrides `MCP_URL`, `AUTHORIZE_URL`, `TOKEN_URL`, `REVOKE_URL` (https only). A connector is offered only when its client id and every URL are known (`src/connector-catalog.js` lists the defaults and what is missing). |
| `NVIDIA_HOSTED` + `NVIDIA_API_KEY` | var + **secret** | unset = `false` (`"true"` in the lineup files) | `true`: the NVIDIA trial key serves users' free models, the owner's decision (2026-10-19, kept in the 2026-10-29 lineup; trial terms in [docs/PROVIDER_TERMS.md](docs/PROVIDER_TERMS.md)). `false`: NVIDIA is not offered. |
| `OPENROUTER_HOSTED` + `OPENROUTER_API_KEY` | var + **secret** | unset = `false` (`"true"` in the lineup files) | `true`: the operator key serves the OpenRouter free models in `OPENROUTER_MODELS`, the owner's decision. `false`: users' own keys (BYOK) only, which work regardless. |
| `OPENROUTER_MODELS` | var | `cohere/north-mini-code:free` (the lineup files too; `minimax/minimax-m3.1-flash:free` left them on 2026-11-04, when OpenRouter no longer listed it and every request answered service_unavailable) | Narrows the OpenRouter models offered, hosted and BYOK alike. |
| `OPENROUTER_FREE_ONLY`, `OPENROUTER_CALLBACK_URL` | var | —, `https://zero-x.live/neuroncli/callback/` | BYOK discovery filter and PKCE callback. |
| `GROQ_MODELS`, `GEMINI_MODELS`, `CLOUDFLARE_MODELS`, `NVIDIA_MODELS`, `ANTHROPIC_MODELS` | var | unset (`ANTHROPIC_MODELS`: Sonnet 5.5, Opus 5.5 and Haiku 5.5 in `wrangler.toml`; `GEMINI_MODELS` and `CLOUDFLARE_MODELS`: `""` there) | Can only **narrow** the verified catalog (the approved rows over `src/catalog.js`); unknown ids are ignored and reported. An empty list offers none of the provider's models: the owner lineup of 2026-10-29 switches Gemini and Workers AI off this way, keys and binding unchanged (delete the line to serve them again). `CLOUDFLARE_MODELS` can opt in `@cf/openai/gpt-oss-120b`. `ANTHROPIC_MODELS` keeps the `anthropic.paid` key on the three Claude models even if a catalog row names another. |
| `TRUST_CF_IPCOUNTRY` | var (Node) | unset | `true` only when the Node origin is reachable exclusively through Cloudflare. Workers use `request.cf.country`. |
| `ALLOW_UNKNOWN_COUNTRY` | var | unset | Local development only: serve free Gemini when the caller's country is unknown (fails closed otherwise). |
| `UPSTREAM_TTFB_TIMEOUT_MS` / `UPSTREAM_IDLE_TIMEOUT_MS` | var | `45000` / `90000` | First byte / gap between bytes (SSE keep-alives count). The first data event is due within their sum. |
| `UPSTREAM_RESPONSE_TIMEOUT_MS` | var | `90000` | A non-streaming completion is due this long after the request arrived, whatever its attempts' own timeouts and the budget plus `UPSTREAM_IDLE_TIMEOUT_MS` would allow (up to 140 s): its JSON body has no byte before it, and the proxy in front of the gateway (Cloudflare, later CloudFront) ends a response whose first byte is later than its own limit. No attempt starts too close to it; the cut answers `504 upstream_timeout` and is not counted against the pool. Streams are not affected. |
| `UPSTREAM_FAILOVER_BUDGET_MS` | var | `50000` | Failover time of one request before its stream is committed: a stream's first byte and first data event are due within what is left of it (a non-streaming response within what is left plus `UPSTREAM_IDLE_TIMEOUT_MS`), no attempt starts with under min(5 s, a tenth of it) left, and a spent budget answers `upstream_timeout` (client errors and capacity refusals keep their own answer). Plans with paid capacity keep its last 30 % (15 s) for their paid attempt while the account can pay for one (the reservation shows its plan and credit balance): their free attempts are due within the first 70 %, and each non-streaming paid attempt starts while its share of the budget plus `UPSTREAM_IDLE_TIMEOUT_MS` is left (free pools with no time left are passed over). Once the paid attempt is made (a 429 does not make it while another paid pool is left), refused or ruled out (every paid pool's budget spent, or its model rejected the request), the free pools skipped for it are tried next with what is left, before any further paid pool. So after a paid 5xx, a free pool that hangs or fails can take the rest of the budget, or the last attempt, and the next paid pool is not tried. An attempt the budget cut is not counted against its pool's health; a stream that got its whole share and sent no data event (SSE keep-alives at most) only marks its pool slow, on any plan. Keep it under the CLI's 60 s retry. |
| `ROUTER_MAX_ATTEMPTS` | var | `3` | Upstream attempts per request; plans with paid capacity keep the last one (and the end of the failover budget) for a paid pool while the account can pay for it and until the paid attempt is made or ruled out. A 429 does not count as an attempt: after a paid 429 the next paid pool gets the kept attempt. |
| `ROUTER_MAX_RATE_LIMITED` | var | `6` | Upstream 429s per request; they do not count against `ROUTER_MAX_ATTEMPTS`. |
| `RESERVATION_RENEW_MS` / `RESERVATION_LEASE_SECONDS` | var | `30000` / `90` | A running attempt renews its concurrency lease this often (at most a third of the lease), for this long (Postgres `zerox_renew_reservation`; docs/PLATFORM_CONTRACT.md section 8.5). A killed request frees its slot when the lease lapses. |
| `OMNIROUTE_*`, `BEDROCK_*`, `AZURE_*` | var + **secret** | unset | Optional adapters for operator health probes; not part of the hosted catalog (see PROVIDERS.md). |

No new variables control request shaping or 429 handling; both are always on:

- **Request shaping** (`src/provider-request.js`, docs/PROVIDER_TERMS.md "Request
  compatibility"). Every upstream body passes through a provider normalizer: `is_error` on tool
  results is removed (a failed result becomes `Error: …`), Groq and Gemini get only the OpenAI
  message and tool-call fields, and Gemini gets its thought signatures back. Gemini 3 rejects
  tool-call history without them; the gateway keeps the signatures Gemini returns in memory
  (per isolate, per caller and upstream model, 6 h, at most 2,000) and never sends them to
  clients. On a miss (another isolate, a restart, history from another model) it sends Google's
  placeholder, which Gemini accepts. Tool schemas are forwarded unchanged.
- **Upstream error diagnostics.** Each rejected attempt logs `Neuron upstream rejected request`
  (error: provider, model, tier, request id, HTTP status, failure kind) and `Neuron upstream
  error detail` (warn) with a sanitized summary: HTTP status, the provider's code, status and
  type, google.rpc reasons and quota violations, the retry delay and at most 300 characters of
  the provider's message with keys, e-mail addresses, opaque blobs and quoted text replaced.
  In-stream error events log the same summary. Request bodies and keys are never logged, and
  clients keep the masked contract errors.
- **429 backoff.** A rate-limited pool is parked for the upstream's delay (or 30 s) and backs off
  further while it keeps answering 429 (docs/PROVIDER_TERMS.md "Free-pool limits and 429
  handling"). The circuit is per isolate; the shared per-minute budgets in Postgres are what all
  isolates have in common, so keep `POOL_LIMITS` below what the upstream enforces.

No longer read: `*_TOOL_MODELS` (tool support comes from the catalog), `MAX_REQUESTS_PER_SESSION`,
`OPENROUTER_CLIENT_ID`. Test-only: `E2E_*` (read by `e2e-upstream-shim.mjs`), `PGLITE_ENTRY`
(`check-session-store.mjs`, `check-quota.mjs`).

### Gateway limits

Security audit 2026-11-05 (F2, F5, F16). Every limit is a variable with a default; a value that is not a
positive integer keeps the default. The limits are per process (isolate on the Worker, instance on the VM).

| Variable | Default | What |
|---|---|---|
| `BODY_LIMIT_BYTES` | 65536 | Request body limit of every route except the chat routes (`/v1/chat/completions`, `/v1/messages`, the `/auth/azure/*` aliases), the relay (2 MiB) and the Razorpay webhook (256 KiB). Over it: 413 `request_too_large` before any route or database call; on the VM the bytes are counted as they arrive, on the Worker the declared `Content-Length` is checked. |
| `CHAT_BODY_LIMIT_BYTES` | 2097152 | Chat and relay body limit (2 MiB is what production enforced before; Neuron 7.0.0-alpha.4 sends 15-20 KB per turn). The chat handler's own 1 MiB cap still applies. |
| `BODY_READ_TIMEOUT_MS` | 30000 | Longest a client may take to deliver a request body the gateway buffers before auth; slower bodies answer 408 request_timeout. |
| `REQUEST_TIMEOUT_MS` | 120000 | The whole request (headers and body) must arrive within this time (Node's own default is 5 minutes; never below the headers timeout plus 1 s). A response is never cut by it: token streams run as long as before. |
| `MAX_CONNECTIONS` | 2000 | Open sockets per VM instance. |
| `MODELS_STREAM_PER_IP`, `MODELS_STREAM_MAX` | 4, 500 | Anonymous `/v1/models/stream` connections per address and in all (credentialed streams count in the total only): 429 with `Retry-After`. The status payload is computed once per tick and serialised once for all connections with the same view. |
| `AUTH_NEGATIVE_CACHE_SECONDS`, `AUTH_NEGATIVE_CACHE_MAX` | 60, 10000 | A session, API key or device code the store has just said does not exist is answered from memory for this long. Not used when `SESSIONS_KV` is bound (KV is eventually consistent). A store outage caches nothing. |
| `AUTH_REJECTIONS_PER_MINUTE` | 30 | An address that presented this many new rejected credentials in a minute gets 429 on the account routes, the device poll and `/v1/models` with a credential, before any lookup. The chat routes and anonymous model lists are never refused by it. |
| `MAX_JSON_DEPTH` | 128 | Levels of nested objects and arrays a chat request body may have; deeper is 400 `invalid_request` (a 1 MiB body can nest 100,000 levels, which used to end in 503). Real tool schemas nest a few levels. |
| `READY_CACHE_SECONDS` | 5 | A "ready" answer of `GET /ready` is remembered this long; a failure never is. |

The edge rules stay the owner's (Cloudflare rate-limit and body-size rules on `/v1/*`, `/auth/*`, `/ready`
and `/v1/models/stream`); these limits are the second layer behind them.

### Active model health checks

The live status on `/v1/models`, `/v1/models/status` and the website's model list comes from an
active checker on the Node gateway (`src/health-probes.js`, contract section 15), not only from
real requests that failed. Every instance runs it; each tick (15 s) it asks Postgres for the
`health_probes` lease (90 s, renewed every tick), and only the holder sends test requests, so
the two EC2 instances (and any later host) never probe twice. A stopping instance hands the lease
back (SIGTERM), so after a deploy the new instance leads within one tick; after a crash, within
90 s. Every instance reads the shared verdicts (`zerox_pool_health`) back, so both answer the same.

What the leader checks, cheapest first: the free model lists every 10 minutes (Groq, Gemini and
Claude with each key; NVIDIA and OpenRouter public; OpenRouter's key endpoint), which mark a
delisted model or a rejected key unavailable without spending a request; the one-at-a-time slots
(Z.ai's GLM Flash) every tick, from Postgres only, which mark a model busy with
`available_again_at` while users hold its slot; then tiny test requests (3 output tokens; a tool
call of 160 tokens less often; 12 s and 24 s timeouts). `zerox_probe_take` counts each test
request in the pool's shared minute and day budgets (the ones users' reservations are checked
against), refuses it while users are busy on the pool (its slot is taken, or users already used
half the minute's requests or tokens), and reports users' outcomes of the last ten minutes from
any instance: a recent success is the observation and no test request is sent. The leader also
reads users' outcomes of every pool once a minute: an upstream failure newer than any success (a
missing model, a 5xx, a timeout, a rejected key) makes the model `degraded` (`unavailable` after
three with no success, `last_failure_class` `upstream_errors`) on both instances, and its next chat
test is due at once, within the daily cap. A model list only records that a model is still
offered (`listed_at`); it never renews a verdict, so a listed model whose last test request is
older than its stale horizon (below) reports `unknown`. On a one-at-a-time pool (Z.ai's GLM Flash) a
test request holds the slot like a user's request (a reservation without a user, plan `probe`,
freed by `zerox_probe_release` as soon as the request ends), so a user who arrives meanwhile waits
for the slot instead of getting Z.ai's 429. The checker treats Z.ai's free slot as one per
account (it is not established that Z.ai counts it per model): it tests a Z.ai model only while
no request runs on any Z.ai free model of that key, holds all of their slots while the test runs,
and ends the test within 15 s, inside the 20 s a user waits for a slot (`POOL_SLOT_WAIT_MS`).
Claude tests use each model's lowest setting: Sonnet 5.5 with thinking off (`between_tools`,
3 tokens); Opus 5.5, which cannot turn thinking off, at effort low with 64 tokens (512 for the tool
call). A test request the provider refuses with a 400 is logged once per pool and recorded as
`probe_misconfigured`, never as the model being down.

| Pool | Published free budget | Chat test | Tool-call test | Requests a day | Share |
|---|---|---|---|---|---|
| Groq free (per model and key) | 1,000 a day, 30 a minute, 200K tokens a day | every 60 min | every 6 h | 28 | 2.8 % (about 1 % of the tokens) |
| NVIDIA trial (per account) | 10,000 a day, 40 a minute | every 15 min | every 3 h | 104 per model, 312 for three | 3.1 % |
| OpenRouter free (per account, every `:free` model together) | 50 a day | every 8 h | every 24 h | at most 4 for all of them | 8 % (the free list every 10 min finds delisting) |
| Z.ai GLM Flash free (per model) | none published; one request at a time (treated as per account) | every 15 min, only while no Z.ai free request runs | every 6 h | 100 | n/a (the slot check spends nothing) |
| Gemini free (per model) | 20 a day | once a day | none | 1 | 5 % (the keyed list every 10 min) |
| Workers AI free | 200-300 a day | 8-12 a day | 2-3 a day | 10-15 | 5 % |
| Paid pools (Groq, Gemini, Workers AI, Claude) | daily spend cap | every 30 min | every 6 h | 52 | under $0.03 a day for Claude Opus 5.5, counted in the cap |

`probePlan` keeps every pool with a published daily request budget at 5 % of it or less (the
schedule stretches when it would not), except OpenRouter's account-wide cap of 4. After a failure
the next chat test comes sooner (a quarter of the interval, 2 minutes to 2 hours), within the same
daily cap, so a recovery shows quickly. Counts per pool and day are stored with the verdicts, so a
restart or a new leader continues them.

Verdicts: `available`; `busy` (a slot or rate limit in use, with `available_again_at`);
`degraded` (a 3-token answer slower than 8 s, a first 5xx or timeout, or tool calls that stopped
working, or users' requests failing upstream); `unavailable` (two failures in a row, delisted,
the key rejected, the quota spent, or three users' upstream failures and no success). A model
whose newest observation (a test request, real traffic, a slot or rate limit in use) is older than
its route's stale horizon reports `unknown`, never `available`. The horizon is the larger of
`HEALTH_STALE_SECONDS` and 1.5 times the route's chat test interval: Groq free 90 min, paid pools
45 min, NVIDIA and Z.ai 22.5 min, OpenRouter 12 h. Each row of `/v1/models/status` says its own
(`stale_after_seconds`), and the website expires each row by it; a real failure on an instance still
flips its model at once, since the freshest observation wins. Routing on the Node gateway skips
busy and unavailable pools from the same rows. Logs are metadata only (`Health probe` with the
pool key, kind, outcome class, HTTP status and milliseconds; `Health list check failed` with the
check id); bodies, provider messages and keys are never logged or stored.

| Variable | Kind | Default | Purpose |
|---|---|---|---|
| `HEALTH_PROBES` | var | `on` | `off` (also `false`, `0`) is the kill switch: no list checks, slot checks or test requests. Models without recent real traffic then report `unknown`. |
| `HEALTH_PROBE_TICK_SECONDS` | var | `15` (5-300) | How often each instance renews or asks for the lease and reads the verdicts again. The lease lasts 90 s. |
| `HEALTH_PROBE_TIMEOUT_SECONDS` | var | `12` (3-60) | Timeout of a chat test request; a tool-call test gets twice as long. |
| `HEALTH_STALE_SECONDS` | var | `1200` (120-86400) | The floor of every route's stale horizon (above): a verdict nobody confirmed for the longer of this and 1.5 times its route's test interval reads `unknown`. Keep it above the 10-minute list interval. The Worker's `/v1/models` uses it for every route until it reads the checker's rows (`HEALTH_PROBES_DB_ROWS`, below). |
| `HEALTH_PROBES_DB_ROWS` | var | `on` | The Worker (no checker of its own) reads the Node checker's verdict rows (`zerox_pool_health_get`) when it builds `/v1/models`, `/v1/models/status` and `/v1/models/stream`, cached 30 s per isolate (contract section 19.5), so `neuron.zero-x.live` shows the same verdicts, latency and stale horizons as `zero-x.live`. `off` keeps the previous behaviour (HealthHub rows and the isolate's own attempts). Without the RPC it falls back silently, logging once.

It needs migration `20261104000000_health_probes.sql` (below) and the database (`SUPABASE_*`);
without either, the gateway logs it once at start and runs no checks. The Worker keeps its
HealthHub Durable Object (`HEALTH_CANARIES`) for the paths it still serves; the checker runs only
on the Node gateway. One checker tests a pool: while `EC2_PROXY_PREFIXES` routes chat to the Node
gateway, the HealthHub sends no test requests or canaries (its free list, key and status-page
checks and the isolates' reports go on), and when the secret is deleted they resume.
`HEALTH_HUB_PROBES` (Worker var: `on`, `off`, default `auto`) overrides that. `auto` does not know
whether the Node checker actually runs: while it is off on the VM (`HEALTH_PROBES=off`, no
database, or the migration missing), set `HEALTH_HUB_PROBES=on` on the Worker, or no checker tests
the pools at all. The operator's `/health` shows it: on Node, `health_checker.node_probes` is
`running`, or `off`, `no_database`, `migration_missing` with a warning; on the Worker,
`health_checker.hub_test_requests` says whether the hub tests.

### Provider discovery

Daily and weekly jobs on the existing cron queue new free models and providers for review at
`/admin/discovery` (contract §8.4). They need migration `20261019120000_provider_discovery.sql`;
without it the cron logs "Discovery is unavailable" once per isolate and carries on.

| Variable | Kind | Default | Purpose |
|---|---|---|---|
| `DISCOVERY_ENABLED` | var | on | `false` stops the discovery jobs (the review page still works). |
| `ANTHROPIC_API_KEY` | **secret** | unset | Also enables the weekly research agent (Claude Haiku 5.5 with web search) and the credits job; `DISCOVERY_RESEARCH=false` turns both off. |
| `DISCOVERY_RESEARCH_MAX_USD` | var | `0.25` | Spending cap per research run (0.02 to 2); searches and output tokens are sized to it. |
| `CATALOG_DB_MODELS` | var | unset | No longer read (a warning is logged once): promoting a verified candidate creates a draft catalog row, served once approved on `/admin/models`. |
| `DISCOVERY_KEY_<ID>` + `DISCOVERY_BASE_<ID>` | **secret** + var | unset | Key and https base URL for verifying candidates of a provider the gateway has no adapter for (`<ID>`: provider id in upper case, `-` as `_`). Built-in providers use their own keys. |

The jobs parse up to ~10 MB of JSON a day in one cron invocation (models.dev is ~6 MB), which
needs the Workers Paid CPU allowance.

## Model catalog and Claude

The served catalog is the data-driven one (contract §13): approved model rows in Postgres,
reviewed on `https://dashboard.zero-x.live/admin/models`, each bounded by the code guardrails
(provider types, key slots, list prices and spend ceilings live in `src/catalog-types.js`,
`src/list-prices.js` and `src/catalog-guardrails.js`) and falling back to `src/catalog.js`.
Claude Sonnet 5.5 and Claude Opus 5.5 are two of those rows: paid only (Pro and Max), billed from
credits at Anthropic's list price plus 25 % with cache reads and writes at their own rates.

**Migration order.** The new Worker calls the 11-argument `zerox_settle_v2` and reads
`zerox_catalog_snapshot`, so apply every migration **before** the deploy. See which ones production is missing with
`node scripts/apply-migrations.mjs --status` (or `SELECT version FROM supabase_migrations.schema_migrations ORDER BY version;`)
and apply the missing ones, in order (the ten catalog and app migrations were renumbered from 20261023-20261025 to
20261029 so that they come after the reservation leases, whose functions they keep):

0. `20261028000000_reservation_leases.sql` (concurrency leases, section 8.5 of the contract)
1. `20261029000000_session_devices.sql`
2. `20261029000100_push_tokens.sql`
3. `20261029000200_provider_keys.sql`
4. `20261029000300_provider_key_budgets.sql`
5. `20261029000400_oiop_offers.sql`
6. `20261029000500_credit_programs.sql`
7. `20261029000600_catalog_models.sql` (model rows, revisions, audit log, draft → active approval)
8. `20261029000700_catalog_seed.sql` (the 18 code models, Z.ai's two included, active at revision 1, the `anthropic.paid` offer, earlier promoted discovery models as drafts)
9. `20261029000800_paid_billing_caps.sql` (per-pool daily spend caps `p_pool.cpd`, cache-aware settlement, abandoned paid reservations keep their credit hold for 60 minutes)
10. `20261029000900_plan_features_claude.sql` (plan feature strings; tiers, limits and credits unchanged)
11. `20261029001000_pool_concurrency.sql` (`p_pool.concurrency`: requests of a pool key running at once, for Z.ai's one-at-a-time free models)
12. `20261102000000_free_token_window.sql` (Free: 1,000,000 tokens per rolling 5-hour window instead of 500K a day; see below)
13. `20261104000000_health_probes.sql` (the active health checker's lease, verdict rows and `zerox_probe_take`; see below)
14. `20261104300000_free_plan_features_lineup.sql` (the Free plan's feature line on the pricing page; no restart needed if applied late)
15. `20261106000000_pool_fair_share.sql` (per-user fair share of the free pools, security audit F6; see below)
16. `20261106000100_billing_details.sql` (billing profiles and consent records; see below)
17. `20261106000200_billing_tax_id.sql` (an optional `tax_id` on `zerox_billing_profiles` with its CHECK, and the two profile functions returning it; applies after `20261106000100`; see below)
18. `20261106000300_connector_policy.sql` (connector policy per plan, `/api/account` `policy.connectors`; see below)
19. `20261106000400_connector_accounts.sql` (hosted connector links and their audit log; unused while `HOSTED_CONNECTORS` is off; see below)
20. `20261106000500_search_quota.sql` (daily web search and research-run counters for `POST /v1/search`; see below)
21. `20261106000600_sponsored_pools.sql` (Claude Haiku 5.5's monthly allowance and sponsored pools; see below)
22. `20261106000700_haiku_catalog.sql` (the Haiku catalog row, generated by `scripts/catalog-seed-sql.mjs`)
23. `20261106000800_plan_features_haiku.sql` (the Haiku line in every plan's features; no restart needed if applied late)
24. `20261107000000_pool_user_cost_share.sql` (one free account may use at most 25 percent of a sponsored pool's daily spend cap `cpd`; later requests read `user_pool_share` and the gateway tries the next pool; the pool cap itself is unchanged; apply any time, no gateway change)
25. `20261107000100_pool_share_refunds.sql` (a refunded attempt no longer counts toward the per-user share of a free pool, and a pool with rpd 0 or tpd 0 answers pool_exhausted; replaces `zerox_reserve_v2` again, same arguments; apply any time, no gateway change)

**Billing details (`20261106000100_billing_details.sql`).** Two new tables (`zerox_billing_profiles`,
`zerox_billing_consents`) and four functions; nothing existing changes, and it does not depend on
`20261029000900_plan_features_claude.sql`. **Apply this migration before deploying the gateway
that knows it**: that gateway answers checkout and top-up with 503 `service_unavailable` until the
functions exist. (An older gateway keeps working against the new database. The old site script, which
sends no `consent`, gets 409 `billing_profile_required` from the new gateway until the page is
reloaded.) After the deploy:

- the operator `/health` shows `plans_configured` `{inr: true, usd: true, missing: []}` once every paid
  plan has its Razorpay plan id for both currencies (a `missing` entry such as `pro:USD` is what makes
  checkout answer 503 `billing_plan_missing`; store the ids with the SQL `scripts/razorpay-bootstrap.mjs`
  prints);
- `BILLING_NO_GST_NOTICE` (a `[vars]` entry in `wrangler.toml` and `wrangler.api.toml`, commented out
  by default) turns on the line "No GST charged" in the checkout order summary. Leave it off until the
  owner has confirmed with the CA that no GST is charged; the checkout says nothing about GST before.

Verify: `SELECT count(*) FROM pg_proc WHERE proname LIKE 'zerox_billing_%' AND proname IN
('zerox_billing_profile_get', 'zerox_billing_profile_upsert', 'zerox_billing_record_consents',
'zerox_billing_consents_latest');` returns 4. Roll back with
`migrations/down/20261106000100_billing_details.down.sql` (psql -X -v ON_ERROR_STOP=1 -f, or paste
it); that deletes every saved profile and consent record. If `20261106000200_billing_tax_id.sql` is
applied, run its down script first.

**Optional tax id (`20261106000200_billing_tax_id.sql`).** Adds the nullable column
`zerox_billing_profiles.tax_id` with the CHECK `zerox_billing_profiles_tax_id_check` (a GSTIN shape
for India, 2 to 20 of `[A-Z0-9-]` elsewhere) and replaces `zerox_billing_profile_get` /
`zerox_billing_profile_upsert` so they return and save it (same SECURITY INVOKER, pinned search_path
and service_role-only grants). Existing profiles keep everything and get `NULL`. **Apply it before
deploying the gateway that knows it**: until then a buyer who types a tax id gets 503
`service_unavailable` on saving (the old upsert refuses the unknown key); a buyer who leaves it empty
is not affected, because the gateway then leaves the key out. The privacy policy changes with it
(version `2026-11-04`), so every buyer is asked to agree again at their next checkout. Contract §16.6.
Verify: `SELECT column_name FROM information_schema.columns WHERE table_name = 'zerox_billing_profiles'
AND column_name = 'tax_id';` returns one row. Roll back with
`migrations/down/20261106000200_billing_tax_id.down.sql`; that deletes every saved tax id and keeps
every other billing detail and consent record.

**Fair share of the free pools (`20261106000000_pool_fair_share.sql`).** One user may take at most a
quarter of a free pool's daily request budget (`rpd`) and of its daily token budget (`tpd`); paid pools
and pools without a daily budget are not affected. A user over its share gets the new reservation status
`user_pool_share`: the gateway skips that pool for the request (the next pool of the model serves it), does
not mark the pool as spent for anyone else, and answers `capacity_exhausted` with `Retry-After` until 00:00
UTC when every pool refuses. Deploy the gateway that knows the status (both runtimes) **before** pasting
this migration: an older gateway answers an unknown reservation status with 503 `service_unavailable` for
that one request. The share is the constant `v_share_pct` (25) inside the function; change it with a new
migration. Roll back with `migrations/down/20261106000000_pool_fair_share.sql`.

**Claude Haiku 5.5 on every plan (migrations 21 to 23, contract section 19).** Deploy the gateway
**first** (both runtimes): it sends `p_cap` only for the sponsored pool and fails closed against the
old database (Haiku lists `not_configured`, "Sponsored pools need migration
20261106000600_sponsored_pools.sql" is logged once), and the old gateway works against the new
functions (`zerox_reserve_v2` keeps its 8-argument call; `zerox_settle_v2` has the same arguments).
Then apply 21, 22 and 23 in that order (`node scripts/apply-migrations.mjs --status`, then `--apply`).
Migration 21 adds the table `zerox_family_month_usage`, the `cap_family`/`cap_month` columns on
`zerox_reservations`, `sponsored_cost_microusd` on the usage tables, and recreates
`zerox_reserve_v2` (9 arguments), `zerox_usage_by_model` and `zerox_account_overview` (`p_caps`,
`usage_month`); `zerox_settle_v2` and `zerox_release_stale_reservations` are replaced in place. 22 lets
the free tier of `anthropic.paid` carry a price and a spend cap (`zerox_catalog_slot_sponsors`, the
check `zerox_catalog_revision_pools_free_terms`) and inserts the Haiku row at revision 1. Verify:

- `SELECT pg_get_function_identity_arguments('public.zerox_reserve_v2'::regproc);` lists 9 arguments, the last `p_cap jsonb`;
- `SELECT count(*) FROM public.zerox_catalog_snapshot() WHERE status = 'active';` returns 19, and one row has `id = 'anthropic/claude-haiku-5-5'`;
- `SELECT plan, jsonb_array_length(features) FROM public.zerox_plan_policy ORDER BY sort;` returns free 5, pro 6, max 6, ultrawork 6;
- `SELECT public.zerox_catalog_slot_ok('anthropic', 'free', 'anthropic.paid');` returns true.

Roll back newest first with `migrations/down/20261107000100_pool_share_refunds.sql`,
`migrations/down/20261107000000_pool_user_cost_share.sql`, `migrations/down/20261106000800_plan_features_haiku.sql`,
`20261106000700_haiku_catalog.sql` and `20261106000600_sponsored_pools.sql` (psql -X -v
ON_ERROR_STOP=1 -f), or hide the row at once with `CATALOG_SOURCE=code`. The sponsored pool's
daily spend cap ($5 upstream, `cpd` 6,250,000 billed) is a plain row value raised by catalog
revision up to the $50 type maximum; `PAID_DAILY_SPEND_CAP_USD` lowers every cap, Haiku's included.

**Free's 5-hour token window (`20261102000000_free_token_window.sql`).** Deploy the gateway that
knows `user_window_tokens` (both runtimes: the Worker and the EC2 Node server) **before** pasting
this migration: an older gateway answers that unknown reservation status with 503
`service_unavailable` instead of 429 `insufficient_quota`. The new gateway works against the
old database (no window columns: no window is shown or enforced).

The site ships in the same deploy: the Worker serves the repo root (`wrangler.toml` `[assets]
directory = "../../"`), so the gateway deploy also publishes the "1M tokens every 5 hours" copy.
**Paste the migration right after that deploy**, in the same sitting. Until it is applied the
database still enforces 500K tokens per UTC day. In that gap the pricing table and the hydrated
plan phrases (`data-plan-limit="free:token_phrase"`, `free:token_allowance`, the feature lists
on the home, Neuron CLI and pricing pages) follow `/api/plans` and say "500K tokens per day".
The text that is not hydrated still says 1M every 5 hours: `ai-coding-agent.html`, the docs
limits section, `llms.txt`, the FAQ sentence on the home page, and the static fallback catalog
(`src/plan-policy.js`, `pricing.js`) shown when `/api/plans` cannot be reached. To avoid the gap
completely, deploy the gateway with the site copy of `main` first, paste the migration, then
deploy this branch's site copy. The migration adds
`zerox_plan_policy.window_tokens`/`window_seconds`, sets Free to 1,000,000 / 18,000 with
`daily_tokens` 5,000,000 and the feature "100 requests per day and 1M tokens every 5 hours" (or
"1M tokens every 5 hours" where the older seed strings are still in place), adds
`zerox_window_usage`, and recreates `zerox_reserve_v2`, `zerox_plan_policies_v2` and
`zerox_account_overview` with extra result columns (same arguments and grants). It is
independent of the held-back `20261029000900_plan_features_claude.sql`, whose Free string now
says the same, so the two can be applied in either order. Verify:

- `SELECT plan, daily_tokens, window_tokens, window_seconds FROM public.zerox_plan_policy ORDER BY sort;`
  returns free 5000000 1000000 18000 and null windows for pro, max and ultrawork;
- `SELECT count(*) FROM pg_proc WHERE proname = 'zerox_reserve_v2';` returns 1.

Roll back with `migrations/down/20261102000000_free_token_window.sql` (psql -X -v ON_ERROR_STOP=1 -f,
or paste it): Free gets 500,000 tokens a day back. It must run before
`down/20261029001000_pool_concurrency.sql` if both are rolled back.

**Web search (`20261106000500_search_quota.sql`, contract section 17).** New tables
`zerox_search_usage` and `zerox_search_research_runs` and the functions `zerox_search_reserve` and
`zerox_search_settle` (service_role only); nothing existing changes, so it can be applied before
or after the deploy. The step-by-step switch-on (Brave or a loopback SearXNG on the VM, the read-only
`scripts/search-preflight.mjs`, a smoke test and an owner checklist) is `docs/SEARCH_SETUP.md`.
Until it is applied, and while neither `SEARXNG_URL` nor `BRAVE_API_KEY` is
set, `POST /v1/search` answers 503 `search_unavailable` (never unmetered); `/api/account` gains
`limits.search` and `limits.colony` either way. Owner steps to switch search on:

Both values reach the runtimes only through `.github/workflows/deploy.yml` (already wired): job
ec2 rewrites `/etc/zerox/gateway.env` on every deploy, so a hand edit on the VM is gone at the next
deploy. Add them as secrets of the GitHub environment "production", never of the repository, and
never to `wrangler.toml` `[vars]` (`gateway-env.mjs` refuses a name that is both).

1. Run SearXNG on its own host (not the gateway VM), with `search.formats: [html, json]` in its
   `settings.yml`, its own `server.secret_key`, the limiter on, and reachable from the VM only
   (private network, security group or tunnel). Add the environment secret `SEARXNG_URL` with its
   base URL (`/search` is appended). It is VM-only (job ec2): a Worker cannot reach a private
   host, so SearXNG answers only the searches the Worker forwards, which needs
   `EC2_PROXY_PREFIXES` to cover `/v1/` (deploy/aws/CUTOVER.md). With forwarding off (the
   rollback), the Worker serves search with Brave alone, or answers 503 `search_unavailable`
   without a Brave key; it never waits on an unreachable SearXNG. Do not also set `SEARXNG_URL`
   as a Worker secret: the Worker would wait up to 8 s on the unreachable host before every fallback.
2. Optionally create a Brave Search API key (paid per query beyond the free allowance) and add the
   environment secret `BRAVE_API_KEY`. The workflow binds it to the Worker and writes it to the
   VM. Before forwarding covers `/v1/`, Brave is the only backend search can use, so set it
   if search should work on the Worker.
3. Apply the migration, then verify with
   `SELECT proname FROM pg_proc WHERE proname LIKE 'zerox_search%';` (two rows).
4. Deploy (the workflow picks both secrets up; an unset one is skipped with a warning), then
   check `POST /v1/search` answers 200 with `provider` `searxng` through the forward and
   `brave` otherwise.

Roll back with `migrations/down/20261106000500_search_quota.down.sql` (drops the counters).
**Connector policy (`20261106000300_connector_policy.sql`).** Adds
`zerox_plan_policy.connector_policy jsonb` (contract section 18.1) and recreates
`zerox_plan_policies_v2` with that column (same arguments and grants). Free gets local connectors
only; Pro, Max and ultrawork get the hosted connector ids, which `/api/account` reports only while
`HOSTED_CONNECTORS=true`. A plan whose policy is already set keeps it, so the file is safe to
re-run. The gateway works on either side of it (without the column, `/api/account` has no
`policy` block), so it can be pasted before or after the deploy. Verify:

- `SELECT plan, connector_policy->'hosted' FROM public.zerox_plan_policy ORDER BY sort;` returns free
  `[]` and the five hosted ids for pro, max and ultrawork.

Edit a plan's policy with `UPDATE public.zerox_plan_policy SET connector_policy = '{...}'::jsonb
WHERE plan = 'pro';` (ids are connector catalog ids; `"catalog:*"` in `allowed` allows the whole
catalog). Roll back with `migrations/down/20261106000300_connector_policy.sql`; it must run before
`down/20261102000000_free_token_window.sql` if both are rolled back.

**Connector accounts (`20261106000400_connector_accounts.sql`).** New tables only:
`zerox_connector_accounts` (one row per linked vendor account; `enc_refresh_token` is the sealed
token envelope, never readable without `CONNECTOR_TOKENS_KEK`; disconnecting, or the vendor
refusing the link, deletes the row, so no token is kept after its link ends),
`zerox_connector_audit` (metadata of each `/mcp/<id>` call, purged after 30 days by the scheduled
maintenance while hosted connectors are on) and `zerox_connector_rate` (one per-user request
counter for `/mcp/`, shared by every runtime). Nothing uses them while `HOSTED_CONNECTORS` is off,
so it can be pasted before or after any deploy. Verify:
`SELECT count(*) FROM pg_proc WHERE proname LIKE 'zerox_connector_%';` returns 8. Roll back with `migrations/down/20261106000400_connector_accounts.sql` (switch hosted
connectors off first; it deletes every link and audit row).

Owner checklist, key script, preflight, per-vendor OAuth apps and rollback: `docs/CONNECTORS_OWNER_CHECKLIST.md`
(`scripts/connector-kek.mjs`, `scripts/connector-preflight.mjs`; the deploy workflow passes the connector
secrets to both runtimes).

**Hosted connectors (contract section 18.4; off until every step below is done).** Users link a
SaaS account on the dashboard (Connectors tab) and Neuron reaches it through
`https://zero-x.live/mcp/<id>`, which proxies to the vendor's official remote MCP server with the
user's stored token (`src/routes/connectors.js`, `src/mcp-proxy.js`). Owner steps before
`HOSTED_CONNECTORS=true` on production:

1. Staging first: a test host (`EXTRA_WEB_HOSTS`, e.g. `staging.zero-x.live`) on its own database
   with the migrations above, `HOSTED_CONNECTORS=true` there only, and test OAuth apps. Set
   `CONNECTORS_CALLBACK_URL`, `CONNECTORS_RETURN_URL` and `HOSTED_CONNECTORS_BASE_URL` to the
   staging origin. Production keeps the flag unset until staging passes the acceptance run (link
   GitHub, `neuron` shows it ready with no local secret, disconnect turns it to needs_connect, a
   Free account sees no hosted connector, a destructive tool asks before it runs).
2. `CONNECTOR_TOKENS_KEK` as a secret on every runtime that serves `/mcp/` and `/api/connectors`
   (Worker and EC2), the same value on both.
3. One OAuth app per vendor, owned by the Zero-X organisation, redirect URI
   `https://dashboard.zero-x.live/api/connectors/callback` (or the staging one), then
   `CONNECTOR_<ID>_CLIENT_ID` / `CONNECTOR_<ID>_CLIENT_SECRET`:
   - GitHub: an OAuth app (or a GitHub App with user tokens, which adds refresh tokens). Scopes
     default to `repo read:org`; narrow them if the toolsets you allow need less. Confirm on
     staging that the remote server `https://api.githubcopilot.com/mcp/` accepts the app's user
     token for the toolsets you want.
   - Linear: an OAuth application (Linear settings, API); default scopes `read,write`.
   - Slack: a Slack app with user scopes for the MCP tools you allow (set `CONNECTOR_SLACK_SCOPES`,
     there is no default). Slack allows MCP only for Marketplace-published or internal apps, so a
     public alpha needs the Marketplace listing first.
   - Notion: register a client with the authorization server that `https://mcp.notion.com/mcp`
     advertises (its protected-resource metadata), then set `CONNECTOR_NOTION_AUTHORIZE_URL`,
     `CONNECTOR_NOTION_TOKEN_URL` and the client id.
   - Atlassian: the MCP URL defaults to `https://mcp.atlassian.com/v2/mcp`, which the
     atlassian/atlassian-mcp-server README recommended on 2026-11-04. Register an OAuth 2.1 client
     with the authorization server that endpoint advertises, then set
     `CONNECTOR_ATLASSIAN_AUTHORIZE_URL`, `_TOKEN_URL`, `_SCOPES` and the client id. Delete tools
     (`delete_jira`) are off by default on Atlassian's side; the gateway asks before any it allows.
   - Check each vendor's tools/list on staging against `src/connector-catalog.js`: Atlassian's map
     follows its published tool list, Notion's names come from third-party listings, and Linear
     publishes no tool names (name rules only).
   Set `CONNECTOR_<ID>_REVOKE_URL` where the vendor offers RFC 7009 revocation, so Disconnect also
   revokes the refresh token (then the access token) at the vendor; without it Disconnect deletes
   the stored tokens but the vendor's grant stays until the user removes the app there.
   `/api/account` reports a connector as hosted only once its OAuth app is configured, so vendors
   can be switched on one at a time.
4. Decide where `/mcp/` runs. Both runtimes serve it; on the Worker a long tool call counts
   against the request limits, on EC2 it does not. If EC2 should serve it, add `/mcp/` to
   `EC2_PROXY_PREFIXES`.
5. Legal and privacy text before launch: the privacy policy must say that Zero-X stores linked
   accounts' OAuth tokens (encrypted, deleted when the user disconnects, when the vendor refuses
   the link, or with the account; revoked at the vendor where it supports revocation), which
   vendors receive the user's requests, that call metadata (tool name, time, sizes, a hash of the
   arguments, never their content) is kept 30 days, and how to disconnect. The terms should
   cover acting on the user's behalf in third-party services. Each vendor's developer terms apply
   to its app (Slack's Marketplace rules, GitHub's OAuth app terms, Atlassian and Notion app
   terms, Linear's API terms).
6. Gateway-served connector catalog updates for the CLI need an ed25519 signing key held by the
   owner; by the owner decision the CLI (neuron-v2) rejects every remote update until its public
   key constant is set. This gateway does not serve catalog updates yet.

`DATABASE_URL=… node scripts/apply-migrations.mjs --status`, then `--apply`; or run each file in the
Supabase SQL editor followed by
`INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('<version>', '<name>') ON CONFLICT DO NOTHING;`.
The old Worker keeps working against the new functions: `zerox_reserve_v2` keeps its signature
(the old Worker sends no `cpd`, so no cap applies to it) and `zerox_settle_v2` defaults the two
cache arguments. Verify:

- `SELECT pg_get_function_identity_arguments('public.zerox_settle_v2'::regproc);` lists 11 arguments;
- `SELECT id, lifecycle FROM public.zerox_offers WHERE id = 'anthropic.paid';` returns `active`;
- `SELECT id, status FROM public.zerox_catalog_snapshot() WHERE status = 'active';` returns 18 rows (19 once migration 16 is applied);
- `SELECT plan, allowed_tiers, monthly_credit_microusd, jsonb_array_length(features) FROM public.zerox_plan_policy ORDER BY sort;`
  returns free `{free}` 0 4 (5 after migration 17), pro `{free,paid}` 8000000 5, max `{free,paid}` 35000000 5, ultrawork `{free,paid}` 8000000 5 (one more line each after migration 17).

**Active health checks (`20261104000000_health_probes.sql`).** New tables and functions
(the tables `zerox_pool_health` and `zerox_health_lease`; the functions `zerox_health_lease`, `zerox_probe_take`,
`zerox_probe_release`, `zerox_pool_health_put`, `zerox_pool_health_get`, service_role only), and two
metadata-only changes to `zerox_reservations` so a test request can hold a one-at-a-time slot:
`user_id` allows null, and the check constraint `zerox_reservations_user_or_probe` (`NOT VALID`, so
no scan) allows it only for probe rows (plan `probe`). Every per-user query filters by `user_id`,
so it can be pasted before or after the deploy. A gateway that runs before it is applied logs
"Health probes need migration 20261104000000_health_probes.sql" once and reports models without
recent traffic as `unknown` until the migration is applied and the gateway restarts. Verify:

- `SELECT count(*) FROM pg_proc WHERE proname IN ('zerox_health_lease', 'zerox_probe_take', 'zerox_probe_release', 'zerox_pool_health_put', 'zerox_pool_health_get');` returns 5;
- after the next deploy, `SELECT holder, expires_at FROM public.zerox_health_lease;` names one
  instance (`<host>:<pid>:<id>`) with an expiry under 90 s ahead, and
  `SELECT pool, status, failure_class, checked_at, listed_at FROM public.zerox_pool_health ORDER BY pool;`
  fills within a few minutes.

Roll back with `migrations/down/20261104000000_health_probes.sql` after setting `HEALTH_PROBES=off`
(or rolling the gateway back).

**Branches that still have the old migration names (fix before they merge).** Two pushed branches
carry PR #27's migrations under their 20261023-20261025 versions:

- `feat/relay-neuron-v1` has all ten (unchanged, so a git merge carries this branch's renames)
  plus `20261026000000_push_devices.sql` and `down/20261026000000_push_devices.down.sql`, which
  run `ALTER TABLE public.zerox_push_tokens`. Merged as is, push_devices sorts before
  `20261029000100_push_tokens.sql` and a fresh apply fails (`relation "public.zerox_push_tokens"
  does not exist`; `check-business-db.mjs` fails the same way). Before it merges, rename both
  files to a version after `20261029001000` (for example `20261029001100_push_devices.sql`) and
  their references (docs/RELAY.md, docs/PLATFORM_CONTRACT.md, check-business-db.mjs, the down
  file's history row), and drop any old-named copy of the ten that a rebase or cherry-pick brings
  back.
- `feat/account-devices-relay` has `20261023000000_session_devices.sql` and
  `20261023000100_push_tokens.sql`. PR #27 already contains that branch, so merging it adds
  nothing; a rebased or cherry-picked copy must drop the two files (here `20261029000000` and
  `20261029000100`).
- Never apply those branches' 20261023-20261026 files to Supabase: this branch would run the
  same migrations again under their 20261029 versions (each `CREATE TABLE` twice), and the
  20261029 files are not plain copies (leased reservation functions, Z.ai rows), so they cannot
  just be recorded as applied either.

`src/db/migrations.js` refuses two migrations of the same name (`Duplicate migration name`), so
the checks and `scripts/apply-migrations.mjs` stop before an old copy runs twice.

**Spend limits, three layers.** (1) Postgres: each paid pool has a daily spend cap, checked
atomically with every reservation (`p_pool.cpd`, billed micro-USD per UTC day; holds count while
requests run): Claude Sonnet 5.5 $10, Claude Opus 5.5 $6, the Gemini paid pools $10, Groq and
Workers AI $5 (upstream USD). Code clamps every cap to $100 a pool ($50 for Claude) and to
`PAID_DAILY_SPEND_CAP_USD` when set. (2) Each Claude request holds its worst case in credits
before it starts (every prompt token at the cache-write rate plus all of `max_tokens`), so a
stream never runs past the user's balance. (3) In the Anthropic console, set a monthly spend
limit on the workspace of `ANTHROPIC_API_KEY` (about $500 covers both daily caps for a month)
and an alert below it; this also bounds the weekly discovery research.

**Approvals.** `/admin/models` lists every row, its served source and validation, and the diff of
a pending revision. Approving needs the operator token plus Cloudflare Access (the same Access
application on `dashboard.zero-x.live/admin` as the key vault) and the reviewed revision ids;
price, cap-up, key-slot, paid-pool and auto-rank changes also need the model id typed. The
database requires the approver fields and keeps an append-only audit log; nothing is ever
deleted. An approved change serves at once in the approving isolate and within a minute
everywhere; `/v1/models/stream` tells clients through `catalog_version`.

**Rollback.** Set `CATALOG_SOURCE = "code"` (wrangler.toml `[vars]`) and deploy: the gateway serves
`src/catalog.js` only, whatever the rows say. The down scripts are in `migrations/down/` (the
runner skips that directory) and run newest first by hand. The catalog ones (`20261029000700`,
`20261029000600`) are safe once `CATALOG_SOURCE = "code"` is deployed. The billing ones
(`20261029000900`, `20261029000800`) restore the 9-argument `zerox_settle_v2`, which this gateway
version no longer calls: revert the Worker to the previous version first. The leases' down script
(`20261028000000`) stops while `zerox_reserve_v2` has the 8 arguments of `20261029000300`, which
keep the leases.

**Smoke test after deploy.** `/v1/models` as Pro lists both Claude models `available: true`; as Free
they show `upgrade_required`. A Pro request to `claude-sonnet-5-5` with `max_tokens` 1024 produces a
usage event with `cache_read_tokens`/`cache_write_tokens` and the cost the dashboard shows.
`node check-live-providers.mjs --claude` (with `ANTHROPIC_API_KEY` in `.dev.vars`, about $0.05)
checks one streamed tool call per Claude model and a prompt-cache read on the repeat.

## Deploy gate

`.github/workflows/deploy.yml` runs `npm ci`, `check:production`, `check:database` and
`npm audit --omit=dev` on pushes to `main`, then deploys `wrangler.toml`. It does not run
`check:platform` (routing, account API, billing, web and the end-to-end journey): run
`npm test` before merging, or add `npm run check:platform` to the "Verify production code" step.
The workflow never applies migrations.

## Operator launch checklist

Work through these in order; nothing in this repository does them for you.

1. **Restore the Supabase project.** The host in `wrangler.toml` (`norrtosjwcossxrhhtvd.supabase.co`)
   does not resolve (NXDOMAIN, checked 2026-10-16), so sign-in and every account RPC fail. Restore
   the paused project from the Supabase dashboard, or create a new one and update `SUPABASE_URL`
   and `SUPABASE_PUBLISHABLE_KEY` in `wrangler.toml` and the `SUPABASE_SECRET_KEY` secret.
   Configure Auth providers and the redirect URLs `https://zero-x.live/**`,
   `https://dashboard.zero-x.live/**` and `https://zero-x.live/neuroncli/login/`.
2. **Apply the migrations** in `migrations/` in order (`supabase db push`, or
   `DATABASE_URL=… node scripts/apply-migrations.mjs --status` then `--apply`; psql required).
   The business migrations reseed the plans per contract §1 at once (Free becomes 100 requests /
   500K tokens a day, then 1M tokens per rolling 5 hours with `20261102000000_free_token_window.sql`),
   so apply them together with this gateway version. Before production
   traffic, run one parallel reserve/settle burst against the real Postgres (PGlite tests are
   single-connection).
3. **Razorpay.** Complete account activation (it reviews the About, Contact, Pricing, Terms,
   Privacy, Refund and Shipping pages, which are live on the site). With **test-mode** keys:
   `node --env-file=.dev.vars scripts/razorpay-bootstrap.mjs`, then `--apply`, then run the
   printed `UPDATE public.zerox_plan_policy …` SQL. Add the webhook
   `https://zero-x.live/webhooks/razorpay` with secret = `RAZORPAY_WEBHOOK_SECRET` and the events
   `subscription.authenticated`, `subscription.activated`, `subscription.charged`,
   `subscription.pending`, `subscription.halted`, `subscription.cancelled`,
   `subscription.completed`, `payment.captured`, `payment.failed`, `order.paid`,
   `refund.processed` and the `payment.dispute.*` events. Test a Pro checkout, a top-up, a refund
   and a cancellation end to end in test mode, then repeat the bootstrap with live keys
   (`--allow-live`) and set `RAZORPAY_KEY_ID` to the `rzp_live_` id. Read "Refunds and disputes"
   below before taking live payments. The step-by-step owner list, with test cards and the CSP checkout test, is
   `docs/RAZORPAY_OWNER_CHECKLIST.md`.
4. **Paid upstream capacity.** Create a Groq Developer-plan key and a billing-linked Gemini
   project key and store them as `GROQ_PAID_API_KEY` and `GEMINI_PAID_API_KEY`, and an Anthropic
   API key as `ANTHROPIC_API_KEY` (`gh secret set ANTHROPIC_API_KEY`; set the console spend limit
   first, see "Model catalog and Claude"). Without them Pro and Max have no paid pool (credits
   cannot be spent). Check the real Gemini free-tier limits in
   AI Studio (or the `quotas` field of `Neuron upstream error detail` log lines) against
   `POOL_LIMITS` in `src/catalog.js`; the free Gemini budget is 5 rpm / 120K tpm per model after
   the project was rate limited below its published limits on 2026-10-16.
5. **Operator secrets.** Set `GATEWAY_ADMIN_TOKEN` (≥ 32 random characters),
   `SESSION_ENCRYPTION_KEY` and `PROVIDER_KEYS_KEK` (each `openssl rand -base64 32`) as GitHub
   Actions secrets. Keep a copy of `PROVIDER_KEYS_KEK`: without it the vault's keys cannot be read.
   **OIOP offers:** apply `migrations/20261029000400_oiop_offers.sql` (backfills the offers of the
   code catalog, so nothing stops serving) and `migrations/20261029000500_credit_programs.sql`
   (credit programs, seeded), and set `OIOP_SIGNING_JWK` to sign manifests.
   **Provider key vault:** apply `migrations/20261029000200_provider_keys.sql` and
   `migrations/20261029000300_provider_key_budgets.sql` (per-key budgets) before deploying. In Cloudflare Zero
   Trust, add a self-hosted Access application for `dashboard.zero-x.live` with path `admin` (it
   covers the key vault and model catalog pages, their scripts and every `/admin/*` API), add
   `dashboard.zero-x.live` path `v1/providers/health` as a second hostname of the same application
   (one audience tag), and a policy allowing only your identity; put its audience tag in `CF_ACCESS_AUD` and the team domain in
   `CF_ACCESS_TEAM_DOMAIN` (`wrangler.toml` `[vars]`). Then open
   `https://dashboard.zero-x.live/admin/keys`, unlock it with `GATEWAY_ADMIN_TOKEN` and add keys;
   each is checked with one free request first. Free-tier terms and quotas apply per provider
   account; how many accounts to pool is the operator's call. Once the vault serves, the
   `GROQ_API_KEY`/`GEMINI_API_KEY`/`NVIDIA_API_KEY`/`OPENROUTER_API_KEY` secrets are only the
   fallback and may be removed.
6. **Legal and support review (owner).** Confirm the refund windows in `refund.html` and remove
   its owner-review note before taking live payments; review `privacy.html` (processor list,
   free-tier training notice, grievance officer) and `terms.html` (liability cap, governing law,
   renewal wording); create and monitor `support@zero-x.live`; consider replacing the personal
   Gmail address still shown on `index.html`, `neuron.html`, `legacy.html`, `about.html` and
   `find-files-by-content.html`.
7. **Rotate the provider keys that were shared in chat** (Groq, Gemini, NVIDIA, OpenRouter):
   revoke them at each provider, then store the new values as Worker secrets and in your local,
   gitignored `.dev.vars`.
8. **Workers specifics.** Confirm every `*.zero-x.live` subdomain serves HTTPS before deploying
   (HSTS `includeSubDomains`). Client disconnects before the first upstream byte are only seen on
   Workers when request signals are enabled: test `compatibility_flags = ["enable_request_signal"]`
   (or a newer `compatibility_date`) with `wrangler dev` before relying on it. After the first
   deploy, confirm the cron trigger in the Workers dashboard, and set `CSP_ENFORCE = "true"`
   once browser consoles show no CSP report-only violations.
9. **Canary.** `npm test`, deploy, then check `/ready`, `/health` with the operator token, a
   dashboard sign-in, `neuron auth login`, a streamed tool call with the matching Neuron build,
   and `https://dashboard.zero-x.live/admin/overview` through Access (once Access is configured,
   the operator APIs refuse the token alone on every host).

## Refunds and disputes

What the gateway does by itself (contract section 7):

- **Duplicate subscriptions.** An account holds at most one payable subscription: checkout reuses
  an unpaid one and refuses a second while one is live. If two still end up paid (parallel
  checkouts, a subscription created in the Razorpay dashboard), the second is revoked, cancelled
  at Razorpay at once and refunded in full, with the log line "Duplicate Razorpay subscription
  cancelled and refunded". When the cancellation or refund fails, verify answers 502 and the
  webhook 503 (Razorpay retries); the duplicate never entitles meanwhile, and the dashboard's
  cancel ends it too.
- **Refunds you issue in the Razorpay dashboard** arrive as `refund.processed`. The payment is
  marked refunded once refunded in full, and credits granted with it are taken back in proportion
  (top-up credits, or the monthly credits of a subscription payment; balances stop at zero and
  the ledger records the shortfall). A full refund of a subscription payment also ends that
  subscription at once (it is revoked and cancelled at Razorpay), as `refund.html` promises. For a
  goodwill refund that should keep the plan, refund part of the payment instead.

What stays manual:

- **Disputes and chargebacks.** `payment.dispute.*` events are only logged ("Razorpay dispute needs
  operator review"). Respond in the Razorpay dashboard. If the dispute is lost, take the credits
  back and end the plan with SQL (service role), using the payment id from the dispute:

  ```sql
  SELECT * FROM public.zerox_payment_by_provider_id('razorpay', 'pay_…');   -- user, kind, credits granted
  SELECT * FROM public.zerox_credit_grant('<user_id>', -<granted_microusd>, 'refund', 'dispute:<dispute id>');
  SELECT * FROM public.zerox_billing_revoke_subscription('razorpay', '<subscription_id>', 'refunded');
  ```

  then cancel the subscription in the Razorpay dashboard.
- **Refunds for payments the gateway never recorded** are logged ("Razorpay refund for a payment
  this gateway never recorded") and ignored; check them by hand.

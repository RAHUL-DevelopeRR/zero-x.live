# Gateway configuration, rollout and launch checklist

The Worker (`wrangler.toml`: website + API on zero-x.live, `wrangler.api.toml`: API-only Worker)
and `node server.js` run the same Hono application (`src/index.js`). Routes, errors, plans and
RPCs are defined in [docs/PLATFORM_CONTRACT.md](docs/PLATFORM_CONTRACT.md). The local
development runbook is in [README.md](README.md#local-development).

## Environment and secrets

Plain values go in `wrangler.toml` `[vars]` (or `.env` for Node). **Secrets** go in Worker
secrets (bound by `.github/workflows/deploy.yml` from GitHub Actions secrets) or the container's
secret store, never in a committed file. `.dev.vars.example` lists them with comments.

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
| `NEURON_API_ONLY` | var (Node) | unset | `true` = API only, no website assets. |
| `NEURON_RUNTIME` | set by server.js | — | Marks the Node runtime; never set it on the Worker. |
| `DEV_AUTH_ENABLED` | var (Node) | unset | Local dev identity (`dev_<base64url(email)>`). Ignored unless the Node server is bound to loopback; never in wrangler files. |
| `ALLOW_ANONYMOUS_SESSIONS` | var | unset | Development only: account-less sessions with an in-memory store. |
| `NODE_ENV` | var (Node) | — | `production` refuses the PGlite driver. |

### Sessions, security and operator access

| Variable | Kind | Default | Purpose |
|---|---|---|---|
| `CLI_SESSION_TTL_HOURS` | var | `720` | CLI session lifetime (reported as `expires_at`). |
| `SESSION_TTL_HOURS` | var | `24` | Lifetime of sessions created before hashed storage. |
| `SESSION_ENCRYPTION_KEY` | **secret** | unset | ≥ 32 chars (`openssl rand -base64 32`); seals users' own OpenRouter keys (AES-GCM). Rotating it disconnects those keys. |
| `GATEWAY_ADMIN_TOKEN` | **secret** | unset | ≥ 32 random chars; `/admin/overview`, `/admin/discovery/*`, `/admin/providers/keys`, `/admin/catalog/*`, `/v1/providers/health`, full `/health`. |
| `PROVIDER_KEYS_KEK` | **secret** | unset | 32 random bytes, base64 (`openssl rand -base64 32`): encrypts the provider key vault (contract §11.1). Unset = no vault; the admin page answers 503. Losing or rotating it means re-adding the keys. |
| `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` | var | unset | Cloudflare Access team domain (`<team>.cloudflareaccess.com`) and the audience tag of the Access application on `dashboard.zero-x.live/admin`. When both are set, the key vault and model catalog pages and their APIs (`/admin/providers/keys`, `/admin/catalog/*`) also require a valid Access JWT. |
| `OIOP_SIGNING_JWK` | **secret** | unset | Ed25519 private JWK for signing offer manifests (`node scripts/oiop-keygen.mjs`); its public half is served at `/oiop/keys.json`. Unset: manifests can be viewed but not signed. |
| `OIOP_SCRUB` | var | `all` | Prompt secret scrubber: `all`, `untrusted` (T2/T3 offers only) or `off` (contract §12.3). |
| `HEALTH_CANARIES` | var | on | `false` stops HealthHub's canary requests (contract §12.5). |
| `DISCOVERY_CREDITS` | var | on | With `ANTHROPIC_API_KEY`, the weekly job that finds free cloud and AI credit programs (contract §12.6); `false` turns it off. |
| `DISCOVERY_RESEARCH` | var | on | With `ANTHROPIC_API_KEY`, the weekly research and credits jobs (Claude with web search, capped by `DISCOVERY_RESEARCH_MAX_USD`); `false` turns both off. |
| `CSP_ENFORCE` | var | `false` | `true` sends `Content-Security-Policy` instead of `-Report-Only`. |
| `PRICING_URL` | var | `https://zero-x.live/pricing` | `upgrade_url` in errors (https only). |

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
| `ANTHROPIC_API_KEY` | **secret** | unset | Claude Sonnet 5.5 and Claude Opus 5.5 paid pools (Pro and Max, billed from credits; key slot `anthropic.paid`) and the weekly discovery research agent. Set it with `gh secret set ANTHROPIC_API_KEY`; deploy pushes it to the Worker. Unset: both Claude models list as `not_configured`. Also set a monthly spend limit for the key's workspace in the Anthropic console (see "Model catalog and Claude"). |
| `ANTHROPIC_THINKING_REPLAY` | var | on | `false` stops replaying Claude's signed thinking blocks into the next turn and stops sending the thinking-binding beta (contract §13.3). |
| `PAID_DAILY_SPEND_CAP_USD` | var | unset | A number above 0 lowers every paid pool's daily spend cap (upstream USD per UTC day) to at most this value; it can never raise one (contract §13.4). |
| `CATALOG_SOURCE` | var | unset | Unset: the approved catalog rows when the database is configured, over the code catalog. `code`: kill switch, `src/catalog.js` only (contract §13.1). |
| `CLOUDFLARE_PAID` | var | unset | `true` adds paid Workers AI pools (Workers Paid accounts only). |
| `NVIDIA_HOSTED` + `NVIDIA_API_KEY` | var + **secret** | `false` | NVIDIA trial keys are evaluation-only: keep `false` in production. |
| `OPENROUTER_HOSTED` + `OPENROUTER_API_KEY` | var + **secret** | `false` | The operator key is not resold: keep `false`. Users' own keys (BYOK) work regardless. |
| `OPENROUTER_MODELS` | var | `cohere/north-mini-code:free` | Allowlist for users' own OpenRouter keys. |
| `OPENROUTER_FREE_ONLY`, `OPENROUTER_CALLBACK_URL` | var | —, `https://zero-x.live/neuroncli/callback/` | BYOK discovery filter and PKCE callback. |
| `GROQ_MODELS`, `GEMINI_MODELS`, `CLOUDFLARE_MODELS`, `NVIDIA_MODELS`, `ANTHROPIC_MODELS` | var | unset | Can only **narrow** the verified catalog (the approved rows over `src/catalog.js`); unknown ids are ignored and reported. `CLOUDFLARE_MODELS` can opt in `@cf/openai/gpt-oss-120b`. |
| `TRUST_CF_IPCOUNTRY` | var (Node) | unset | `true` only when the Node origin is reachable exclusively through Cloudflare. Workers use `request.cf.country`. |
| `ALLOW_UNKNOWN_COUNTRY` | var | unset | Local development only: serve free Gemini when the caller's country is unknown (fails closed otherwise). |
| `UPSTREAM_TTFB_TIMEOUT_MS` / `UPSTREAM_IDLE_TIMEOUT_MS` | var | `45000` / `90000` | First byte / gap between bytes (SSE keep-alives count). The first data event is due within their sum. |
| `ROUTER_MAX_ATTEMPTS` | var | `3` | Upstream attempts per request; plans with paid capacity keep the last one for a paid pool. |
| `ROUTER_MAX_RATE_LIMITED` | var | `6` | Upstream 429s per request; they do not count against `ROUTER_MAX_ATTEMPTS`. |
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
`zerox_catalog_snapshot`, so apply every migration **before** the deploy. Production main stops at
`20261021000000`; check with `SELECT version FROM supabase_migrations.schema_migrations ORDER BY version;`
and apply, in order:

1. `20261023000000_session_devices.sql`
2. `20261023000100_push_tokens.sql`
3. `20261024000000_provider_keys.sql`
4. `20261024000100_provider_key_budgets.sql`
5. `20261024000200_oiop_offers.sql`
6. `20261024000300_credit_programs.sql`
7. `20261025000000_catalog_models.sql` (model rows, revisions, audit log, draft → active approval)
8. `20261025000100_catalog_seed.sql` (the 16 code models active at revision 1, the `anthropic.paid` offer, earlier promoted discovery models as drafts)
9. `20261025000200_paid_billing_caps.sql` (per-pool daily spend caps `p_pool.cpd`, cache-aware settlement, rpm per client request, paid holds released after 60 minutes)
10. `20261025000300_plan_features_claude.sql` (plan feature strings; tiers, limits and credits unchanged)

`DATABASE_URL=… node scripts/apply-migrations.mjs --status`, then `--apply`; or run each file in the
Supabase SQL editor followed by
`INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('<version>', '<name>') ON CONFLICT DO NOTHING;`.
The old Worker keeps working against the new functions: `zerox_reserve_v2` keeps its signature
(the old Worker sends no `cpd`, so no cap applies to it) and `zerox_settle_v2` defaults the two
cache arguments. Verify:

- `SELECT pg_get_function_identity_arguments('public.zerox_settle_v2'::regproc);` lists 11 arguments;
- `SELECT id, lifecycle FROM public.zerox_offers WHERE id = 'anthropic.paid';` returns `active`;
- `SELECT id, status FROM public.zerox_catalog_snapshot() WHERE status = 'active';` returns 16 rows;
- `SELECT plan, allowed_tiers, monthly_credit_microusd, jsonb_array_length(features) FROM public.zerox_plan_policy ORDER BY sort;`
  returns free `{free}` 0 4, pro `{free,paid}` 8000000 5, max `{free,paid}` 35000000 5, ultrawork `{free,paid}` 8000000 5.

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
runner skips that directory) and run newest first by hand. The catalog ones (`20261025000100`,
`20261025000000`) are safe once `CATALOG_SOURCE = "code"` is deployed. The billing ones
(`20261025000300`, `20261025000200`) restore the 9-argument `zerox_settle_v2`, which this gateway
version no longer calls: revert the Worker to the previous version first.

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
   500K tokens a day), so apply them together with this gateway version. Before production
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
   below before taking live payments.
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
   **OIOP offers:** apply `migrations/20261024000200_oiop_offers.sql` (backfills the offers of the
   code catalog, so nothing stops serving) and `migrations/20261024000300_credit_programs.sql`
   (credit programs, seeded), and set `OIOP_SIGNING_JWK` to sign manifests.
   **Provider key vault:** apply `migrations/20261024000000_provider_keys.sql` and
   `migrations/20261024000100_provider_key_budgets.sql` (per-key budgets) before deploying. In Cloudflare Zero
   Trust, add a self-hosted Access application for `dashboard.zero-x.live` with path `admin` (it
   covers the key vault and model catalog pages, their scripts, `/admin/providers/keys` and
   `/admin/catalog/*`) and a policy allowing only your identity; put its audience tag in `CF_ACCESS_AUD` and the team domain in
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
   and `/admin/overview`.

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

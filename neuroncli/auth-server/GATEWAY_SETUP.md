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
| `GATEWAY_ADMIN_TOKEN` | **secret** | unset | ≥ 32 random chars; `/admin/overview`, `/admin/discovery/*`, `/v1/providers/health`, full `/health`. |
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
| `GROQ_API_KEY`, `GEMINI_API_KEY` | **secret** | — | Free pools (Groq free org; Gemini free tier, refused for EEA/GB/CH callers). |
| `GROQ_PAID_API_KEY`, `GEMINI_PAID_API_KEY` | **secret** | unset | Paid pools for Pro/Max (Groq Developer plan, billing-linked Gemini project). Unset = no paid pool. |
| `CLOUDFLARE_PAID` | var | unset | `true` adds paid Workers AI pools (Workers Paid accounts only). |
| `NVIDIA_HOSTED` + `NVIDIA_API_KEY` | var + **secret** | `false` | NVIDIA trial keys are evaluation-only: keep `false` in production. |
| `OPENROUTER_HOSTED` + `OPENROUTER_API_KEY` | var + **secret** | `false` | The operator key is not resold: keep `false`. Users' own keys (BYOK) work regardless. |
| `OPENROUTER_MODELS` | var | `cohere/north-mini-code:free` | Allowlist for users' own OpenRouter keys. |
| `OPENROUTER_FREE_ONLY`, `OPENROUTER_CALLBACK_URL` | var | —, `https://zero-x.live/neuroncli/callback/` | BYOK discovery filter and PKCE callback. |
| `GROQ_MODELS`, `GEMINI_MODELS`, `CLOUDFLARE_MODELS`, `NVIDIA_MODELS` | var | unset | Can only **narrow** the verified catalog in `src/catalog.js`; unknown ids are ignored and reported. `CLOUDFLARE_MODELS` can opt in `@cf/openai/gpt-oss-120b`. |
| `TRUST_CF_IPCOUNTRY` | var (Node) | unset | `true` only when the Node origin is reachable exclusively through Cloudflare. Workers use `request.cf.country`. |
| `ALLOW_UNKNOWN_COUNTRY` | var | unset | Local development only: serve free Gemini when the caller's country is unknown (fails closed otherwise). |
| `UPSTREAM_TTFB_TIMEOUT_MS` / `UPSTREAM_IDLE_TIMEOUT_MS` | var | `45000` / `90000` | First byte / gap between bytes (SSE keep-alives count). The first data event is due within their sum. |
| `UPSTREAM_FAILOVER_BUDGET_MS` | var | `50000` | Failover time of one request before its stream is committed: a stream's first byte and first data event are due within what is left of it (a non-streaming response within what is left plus `UPSTREAM_IDLE_TIMEOUT_MS`), no attempt starts with under min(5 s, a tenth of it) left, and a spent budget answers `upstream_timeout` (client errors and capacity refusals keep their own answer). Plans with paid capacity keep its last 30 % (15 s) for their paid attempt while the account can pay for one (the reservation shows its plan and credit balance): their free attempts are due within the first 70 %, and each non-streaming paid attempt starts while its share of the budget plus `UPSTREAM_IDLE_TIMEOUT_MS` is left (free pools with no time left are passed over). Once the paid attempt is made (a 429 does not make it while another paid pool is left), refused or ruled out (every paid pool's budget spent, or its model rejected the request), the free pools skipped for it are tried next with what is left, before any further paid pool. So after a paid 5xx, a free pool that hangs or fails can take the rest of the budget, or the last attempt, and the next paid pool is not tried. An attempt the budget cut is not counted against its pool's health; a stream that got its whole share and sent no data event (SSE keep-alives at most) only marks its pool slow, on any plan. Keep it under the CLI's 60 s retry. |
| `ROUTER_MAX_ATTEMPTS` | var | `3` | Upstream attempts per request; plans with paid capacity keep the last one (and the end of the failover budget) for a paid pool while the account can pay for it and until the paid attempt is made or ruled out. A 429 does not count as an attempt: after a paid 429 the next paid pool gets the kept attempt. |
| `RESERVATION_RENEW_MS` / `RESERVATION_LEASE_SECONDS` | var | `30000` / `90` | A running attempt renews its concurrency lease this often, for this long (Postgres `zerox_renew_reservation`; docs/PLATFORM_CONTRACT.md section 8.5). A killed request frees its slot when the lease lapses. |
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
| `ANTHROPIC_API_KEY` | **secret** | unset | Enables the weekly research agent (Claude Haiku 5.5 with web search). |
| `DISCOVERY_RESEARCH_MAX_USD` | var | `0.25` | Spending cap per research run (0.02 to 2); searches and output tokens are sized to it. |
| `CATALOG_DB_MODELS` | var | unset | `true` serves promoted (verified) discovery models alongside `src/catalog.js`. |
| `DISCOVERY_KEY_<ID>` + `DISCOVERY_BASE_<ID>` | **secret** + var | unset | Key and https base URL for verifying candidates of a provider the gateway has no adapter for (`<ID>`: provider id in upper case, `-` as `_`). Built-in providers use their own keys. |

The jobs parse up to ~10 MB of JSON a day in one cron invocation (models.dev is ~6 MB), which
needs the Workers Paid CPU allowance.

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
   project key and store them as `GROQ_PAID_API_KEY` and `GEMINI_PAID_API_KEY`. Without them Pro
   and Max have no paid pool (credits cannot be spent). Check the real Gemini free-tier limits in
   AI Studio (or the `quotas` field of `Neuron upstream error detail` log lines) against
   `POOL_LIMITS` in `src/catalog.js`; the free Gemini budget is 5 rpm / 120K tpm per model after
   the project was rate limited below its published limits on 2026-10-16.
5. **Operator secrets.** Set `GATEWAY_ADMIN_TOKEN` (≥ 32 random characters) and
   `SESSION_ENCRYPTION_KEY` (`openssl rand -base64 32`) as GitHub Actions secrets.
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

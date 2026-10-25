# Zero-X gateway (Neuron server)

This directory is the Zero-X gateway: one Hono application that runs as a Cloudflare Worker
(`wrangler.toml`, which also serves the website from the repository root) and as a Node server
(`server.js`). It signs users in, issues CLI sessions and API keys, serves the OpenAI-compatible
`/v1` API with server-side provider keys, enforces per-user quotas and shared upstream budgets in
Postgres, and runs the paid plans (credits, Razorpay subscriptions and top-ups).

The source of truth for every route, error code, plan and RPC is
[docs/PLATFORM_CONTRACT.md](docs/PLATFORM_CONTRACT.md). Upstream terms that constrain routing
are summarised in [docs/PROVIDER_TERMS.md](docs/PROVIDER_TERMS.md). Configuration, the full
environment/secret reference and the launch checklist are in [GATEWAY_SETUP.md](GATEWAY_SETUP.md).

## How it fits together

- **Identity.** The website signs in with Supabase Auth. `POST /auth/cli/session` exchanges a
  Supabase token for a `ses_` CLI session (720 h, stored under SHA-256 of the token).
  `POST /api/keys` mints `nzx_` API keys for CI (only their hash is stored). On a loopback Node
  server with `DEV_AUTH_ENABLED=true`, `dev_<base64url(email)>` tokens stand in for Supabase.
- **Catalog and routing** (`src/catalog.js`, `src/router.js`, `src/chat-handler.js`). Only
  live-verified models are hosted. A route is a (model, pool) pair: free pools first, then paid
  pools for plans with the `paid` tier. Free Gemini is refused for EEA/GB/CH callers and for
  callers whose country is unknown. Health is tracked per pool; a pool that answers 429 is
  parked for the upstream's delay and backs off further while it keeps doing so.
- **Request shaping** (`src/provider-request.js`). Each upstream gets the request in the subset
  it accepts: Groq and Gemini only the OpenAI message fields (Neuron's `is_error` is folded into
  the tool result), Gemini 3 its thought signatures back on tool-call history (kept in the
  gateway, never sent to clients; a placeholder when unknown). See docs/PROVIDER_TERMS.md
  "Request compatibility".
- **Quota and credits** (`migrations/2026101600*`). Every upstream attempt is reserved with
  `zerox_reserve_v2` (per-user daily caps, rpm, concurrency, credits and the shared pool budget,
  atomically) and settled with `zerox_settle_v2` (real usage). Provider failures the upstream
  did not count (429, 5xx, network) are refunded to the caller and the pool; model errors and
  timeouts keep their pool share and are refunded to the caller within a daily allowance.
- **Billing** (`src/routes/billing.js`, `src/routes/webhooks.js`). Razorpay subscriptions
  (Pro/Max, INR and USD) and credit top-ups; `subscription.charged` webhooks grant the monthly
  credits once per payment. An account holds one payable subscription (duplicates are cancelled
  and refunded) and `refund.processed` takes refunded credits back (GATEWAY_SETUP.md, "Refunds and
  disputes").
- **Website** (repository root). `pricing.html`, `dashboard.html`, the legal pages and the
  checkout client (`billing-checkout.js`) talk to the same-origin `/api/*` routes.

## Local development

Requirements: Node 22 or later (development uses Node 24) and `npm ci` in this directory.
Nothing below needs Supabase, Razorpay or provider accounts.

1. **Database.** Create a local Postgres (PGlite) with every migration applied, and optionally
   seed your dev identity with a plan and credits:

   ```sh
   npm run db:dev -- --data-dir D:/zerox-dev-db --email you@example.test --plan pro --credits-usd 5
   ```

   PGlite allows one process per directory: stop the server before re-running `db:dev`. The
   seeded user has the id of the dev identity for that address, so signing in as
   `you@example.test` uses the seeded plan and credits. Without `--email` the dev identity is
   created on first sign-in (its `auth.users` row is provisioned on the PGlite driver only).

2. **Environment.** Copy `.dev.vars.example` to `.env` (server.js loads it with dotenv; or run
   `node --env-file=.dev.vars server.js`; both files are gitignored) and set at least:

   ```sh
   AUTH_HOST=127.0.0.1
   DATABASE_DRIVER=pglite
   PGLITE_DATA_DIR=D:/zerox-dev-db
   DEV_AUTH_ENABLED=true          # loopback Node server only
   ALLOW_UNKNOWN_COUNTRY=true     # local only: Node has no caller country, free Gemini needs one
   GROQ_API_KEY=...               # free pools you want to use locally
   GEMINI_API_KEY=...
   ```

   For billing locally, use Razorpay test-mode keys (`rzp_test_...`) or point
   `RAZORPAY_API_BASE` at a fake server, as `check-e2e-local.mjs` does.

3. **Server.** `npm start` (or `node server.js`) listens on `127.0.0.1:8787` and serves the
   website too. Open `http://127.0.0.1:8787/pricing` or `/dashboard`; the sign-in modal offers
   the developer email form when `/auth/config` reports `provider: "dev"`. A CLI can use
   `http://127.0.0.1:8787/v1` with a `ses_` token from `POST /auth/cli/session`
   (`Authorization: Bearer dev_<base64url(email)>`). `NEURON_API_ONLY=true` serves the API only.

4. **Checks.**

   ```sh
   npm test                 # check:server + check:database + check:platform (includes check:e2e)
   npm run check:e2e        # end-to-end journey against the real server.js, fully offline
   npm run check:e2e:live   # same journey; chat steps use the real Groq/Gemini free pools
                            # (keys from .dev.vars, at most 10 calls)
   npm run check:vault      # provider key vault: crypto, RPCs, admin API and page, per-key pools
   npm run check:oiop       # OIOP offers, lifecycle, manifests, routing policy, scrubber, catalog, health
   RACE_DATABASE_URL=postgresql://... npm run check:race   # 100 parallel reservations on a real,
                            # disposable Postgres (npm i --no-save pg); skips without one
   node check-worker.mjs && node check-node-server.cjs && node check-auth-storage.mjs \
     && node check-callback.mjs && node check-cli-login.mjs && node check-dashboard.mjs && node check-seo.mjs
   ```

   `check-e2e-local.mjs` starts `server.js` on a random port with a fresh PGlite directory under
   `os.tmpdir()` (set `TMP`/`TEMP` to move it), a fake OpenAI-compatible upstream and a fake
   Razorpay, and walks sign-in, models, streamed tool calls, usage, API keys, the daily cap,
   checkout, the charged webhook, paid-pool credits, a top-up, cancellation, revoke-all, the
   admin overview, the provider key vault (add a key, serve with it, disable it) and a
   static-site/CSP smoke test. `e2e-upstream-shim.mjs` (preloaded only by
   that test) refuses every non-loopback request. `check-seo.mjs --live` and
   `npm run check:production` contact the live site.

## Operations

- `GET /health` answers `{status, service, version}`; with `Authorization: Bearer
  $GATEWAY_ADMIN_TOKEN` it adds the configuration flags. `GET /ready` checks plan policies,
  session storage and the catalog.
- `GET /admin/overview` (operator token, plus Cloudflare Access when configured, like every
  operator API) returns users, revenue, today's usage and every pool
  with its counters, shared budget and circuit state.
- `https://dashboard.zero-x.live/admin/keys` (Cloudflare Access + operator token) adds, lists and
  disables free-tier provider keys (`/admin/providers/keys`, contract §11.1). Keys are stored
  AES-GCM-encrypted under `PROVIDER_KEYS_KEK`, become one pool each, and never leave the server. `GET /v1/providers/health` adds upstream
  discovery, per-pool health and ignored `*_MODELS` entries.
- Free credit programs (contract §12.6): `GET /admin/credits` lists what the weekly discovery
  found, with quoted evidence and the next step for each; record applications and grants with
  `POST /admin/credits/:id/transition`.
- OIOP offers (`docs/OIOP.md`, contract §12): `GET /admin/offers` lists the offers behind every
  pool with their terms, trust tier and lifecycle; `POST /admin/offers/:id/transition` suspends,
  approves or retires one (audited in `zerox_offer_events`); `POST /admin/offers/:id/manifest`
  signs its manifest with `OIOP_SIGNING_JWK`.
- Upstream rejections are logged as `Neuron upstream rejected request` (error) plus `Neuron
  upstream error detail` (warn): a sanitized summary with the provider's error code/status,
  quota violations, retry delay and a redacted excerpt of its message (GATEWAY_SETUP.md,
  "Upstream pools and routing"). An error body cut off at 16 KB is read up to its last complete
  field (`truncated: true`); its raw text is never logged. Search the logs by the response's
  `x-request-id`.
- The Worker cron (`*/10 * * * *`) releases stale reservations and applies subscription expiry.
  A production Node deployment (PostgREST driver) must run the same jobs from its own scheduler:
  `node -e "import('./src/routes/admin.js').then(m => m.runScheduledMaintenance(process.env))"`
  every 10 minutes.
- Plans live in `public.zerox_plan_policy` (`daily_requests`, `daily_tokens`, `rpm_limit`,
  `concurrency_limit`, `allowed_tiers`, `monthly_credit_microusd`, prices and Razorpay plan
  ids). Edits apply to enforcement immediately and to the gateway's cached view within 60 s.
- Containers: `docker build -t neuron-server .` then `docker run --env-file .env -p 8787:8787
  neuron-server`. Put a TLS proxy in front; never enable `DEV_AUTH_ENABLED` or the PGlite driver
  there (both are refused outside loopback and under `NODE_ENV=production`, and dev tokens are
  also refused on browser requests from a non-loopback `Origin`).

See [PROVIDERS.md](PROVIDERS.md) for upstream adapters and operator health probes.

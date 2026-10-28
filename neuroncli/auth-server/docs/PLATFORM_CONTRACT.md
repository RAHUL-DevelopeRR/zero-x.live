# Neuron × Zero-X platform contract

Status: v1.2 (2026-10-16; v1.1 amendments in section 6, v1.2 amendments in section 7). This document is the source of truth shared by the Neuron CLI
(`RAHUL-DevelopeRR/neuron-v2`) and the Zero-X gateway + website
(`RAHUL-DevelopeRR/zero-x.live`, `neuroncli/auth-server`). A copy lives in both repos;
change both together.

## 0. Principles

1. Provider API keys live only on the gateway (Worker secrets / `.dev.vars`). The CLI,
   npm package, PyPI wheel and website never contain them.
2. Compliance-first upstream routing (see `docs/PROVIDER_TERMS.md` in zero-x.live):
   - **Free plan** traffic uses free upstream tiers that permit serving end users of an
     application: Groq (free org), Gemini API free tier (blocked for EEA/UK/CH callers),
     Cloudflare Workers AI free allocation.
   - **NVIDIA API Catalog** trial keys are evaluation-only: `hosted=false` by default
     (`NVIDIA_HOSTED=true` enables it for internal evaluation only).
   - **OpenRouter** operator keys are not resold: OpenRouter is available only through the
     user's own key/OAuth (BYOK). `OPENROUTER_HOSTED=true` re-enables the operator key.
   - **Paid plans** draw on paid upstream capacity (`*_PAID_API_KEY`) and consume credits.
3. One global budget per upstream pool (rpm/rpd/tpm/tpd) shared by all users, enforced
   atomically in Postgres together with the per-user quota.
4. Every error is OpenAI-shaped and actionable (`code`, `upgrade_url`, `retry_after_seconds`).

## 1. Plans (seeded in migration, editable in `zerox_plan_policy`)

| id | name | price | daily_requests | daily_tokens | rpm | concurrency | tiers | monthly credits |
|----|------|-------|----------------|--------------|-----|-------------|-------|-----------------|
| free | Free | $0 | 100 | 500,000 | 10 | 2 | free | $0 |
| pro | Pro | $10 / ₹899 per month | 2,000 | 10,000,000 | 30 | 4 | free, paid | $8 |
| max | Max | $40 / ₹3,499 per month | 10,000 | 50,000,000 | 60 | 8 | free, paid | $35 |
| ultrawork | Pro (legacy) | same as pro | | | | | | |

Credits are stored in micro-USD (`1 USD = 1_000_000`). Paid-pool usage is billed at the
catalog price (upstream cost × 1.25 markup). Free-pool usage costs 0 credits but counts
toward daily request/token caps. Top-up packs: `credits_5` ($5 credit, $5 / ₹449),
`credits_20` ($20 credit, $20 / ₹1,749).

## 2. Model catalog (gateway `src/catalog.js`)

Each public model has one or more pools:

```js
{
  id: 'gemini/gemini-2.5-flash',          // public id, also accepted with an `openai/` prefix
  display_name: 'Gemini 2.5 Flash',
  provider: 'gemini',
  upstream_model: 'gemini-2.5-flash',
  context_window: 1048576, max_output_tokens: 65536,
  supports_tools: true, supports_streaming: true,
  geo_block_free: ['EEA','GB','CH'],       // free pool unavailable for these caller countries
  pools: [
    { tier: 'free', key_var: 'GEMINI_API_KEY', limits: { rpm: 5, rpd: 250, tpm: 120000, tpd: 5000000 } },
    { tier: 'paid', key_var: 'GEMINI_PAID_API_KEY',
      price: { input_microusd_per_mtok: 375000, output_microusd_per_mtok: 3125000 } },
  ],
}
```

A pool is usable only when its key/binding is configured and `hosted` is not disabled.
Routing for plan tiers `T`: prefer a usable `free` pool with remaining budget; otherwise a
usable `paid` pool if `paid ∈ T` and the user has credits. `model: "auto"` picks the best
tool-capable model whose context window fits the estimated request.

Verified free catalog (live probe 2026-10-16): `groq/openai/gpt-oss-120b`,
`groq/openai/gpt-oss-20b`, `groq/qwen/qwen3.8-27b` (Groq free org: 30 rpm, 1K rpd,
8K tpm, 200K tpd — small prompts only), `gemini/gemini-2.5-flash`,
`gemini/gemini-3.5-flash`, Cloudflare `@cf/meta/llama-3.3-70b-instruct-fp8-fast`.
Not hosted by default: NVIDIA (`nvidia/nvidia/nemotron-3-super-120b-a12b`,
`nvidia/stepfun-ai/step-5-preview`, `nvidia/openai/gpt-oss-20b`), OpenRouter
(`cohere/north-mini-code:free`, `poolside/laguna-s-2.1:free`). Removed (dead upstream):
`gemini/gemini-2.5-pro` free pool, `nvidia/deepseek-ai/deepseek-coder-6.7b-instruct`.

## 3. HTTP API

Base: `https://zero-x.live` (local: `http://127.0.0.1:8787`). JSON everywhere.

### 3.1 Authentication

`Authorization: Bearer <credential>` where credential is one of:

| prefix | meaning | accepted on |
|--------|---------|-------------|
| `ses_` | CLI session from `/auth/cli/session` (TTL `CLI_SESSION_TTL_HOURS`, default 720) | `/v1/*`, `/auth/*`, `/api/*` |
| `nzx_` | personal API key (for headless/CI Neuron runs) | `/v1/*`, `GET /api/account`, `GET /api/usage*` |
| other | Supabase access token (browser dashboard) | `/auth/cli/session`, `/auth/sync`, `/auth/me`, `/api/*` |
| `dev_` | local dev identity, only when `DEV_AUTH_ENABLED=true` on the Node server bound to loopback | all |

Creating/revoking API keys and billing actions require a Supabase token, `ses_` or `dev_`
credential (never an `nzx_` key). Session tokens are stored hashed (SHA-256) in KV/DB.

### 3.2 OpenAI-compatible

- `GET /v1/models` (optional auth). `data[]` items:
  `{id, object:'model', created:0, owned_by, display_name, context_window, max_output_tokens,
  capabilities:{tools, streaming}, tiers:['free'|'paid'], available:boolean,
  unavailable_reason:null|'upgrade_required'|'region_unavailable'|'not_configured',
  pricing:null|{input_per_mtok_usd, output_per_mtok_usd}}`. Includes a pseudo-model
  `auto`. `available` is computed for the caller's plan (anonymous = free).
- `POST /v1/chat/completions` — OpenAI body; `model` may be `auto`. Streaming SSE with
  `data: [DONE]`. Every streamed `tool_calls[]` delta carries `index`. Response headers:
  `x-request-id`, `x-neuron-plan`, `x-neuron-model` (resolved public id),
  `x-neuron-quota-remaining-requests`, `x-neuron-quota-remaining-tokens`.

### 3.3 Errors

`{ "error": { "message", "type", "code", "param": null, "request_id",
"upgrade_url"?, "retry_after_seconds"?, "resets_at"? } }` plus `Retry-After` when relevant.

| HTTP | code | type | when |
|------|------|------|------|
| 400 | `invalid_request` | invalid_request_error | malformed body |
| 400 | `context_length_exceeded` | invalid_request_error | no candidate fits the request, including a prompt above the free per-minute token budget (`upgrade_url` when a paid pool would take it) |
| 401 | `invalid_session` | authentication_error | missing/expired/revoked credential — message tells CLI users to run `neuron auth login` |
| 402 | `insufficient_credits` | insufficient_quota | paid pool needed, credit balance too low (`upgrade_url`) |
| 403 | `upgrade_required` | permission_error | model not in plan (`upgrade_url`) |
| 403 | `region_unavailable` | permission_error | geo-blocked free pool and no paid option |
| 403 | `account_suspended` | permission_error | account suspended |
| 429 | `insufficient_quota` | insufficient_quota | daily request/token cap reached (`resets_at`, `upgrade_url`) — clients must NOT retry |
| 429 | `rate_limited` | rate_limit_error | per-user rpm/concurrency (`retry_after_seconds`) — clients may retry after the delay |
| 503 | `capacity_exhausted` | server_error | shared free pool exhausted (`retry_after_seconds`, `upgrade_url`) |
| 502 | `upstream_error` | server_error | upstream failure after failover; request count refunded |
| 504 | `upstream_timeout` | server_error | no first byte within 45 s or idle > 90 s |

`upgrade_url` = `https://zero-x.live/pricing` (env `PRICING_URL`).

### 3.4 Account & usage (`/api/*`)

- `GET /api/plans` (public) → `{currency_default:'USD', plans:[{id, name, price:{usd_cents, inr_paise},
  interval:'month', limits:{daily_requests, daily_tokens, rpm, concurrency},
  monthly_credit_usd, tiers, features:[string], highlighted}], topups:[{id, credit_usd,
  price:{usd_cents, inr_paise}}]}`
- `GET /api/account` → `{user:{id,email,name,image_url}, plan:{id,name}, limits:{...},
  usage_today:{requests, tokens, resets_at}, credits:{balance_usd, monthly_grant_usd},
  subscription:null|{status, current_period_end, cancel_at_period_end},
  flags:{suspended}}`
- `GET /api/usage?from=YYYY-MM-DD&to=YYYY-MM-DD` (max 92 days, default last 30) →
  `{from, to, series:[{day, requests, prompt_tokens, completion_tokens, cost_usd}],
  by_model:[{model, requests, prompt_tokens, completion_tokens, cost_usd}], totals:{requests,
  prompt_tokens, completion_tokens, cost_usd}}`
- `GET /api/usage/events?limit=50&before=<id>` → `{events:[{id, created_at, model,
  provider, tier, status, prompt_tokens, completion_tokens, cost_usd, latency_ms,
  request_id}], next_before}`
- `GET /api/keys` → `{keys:[{id, name, prefix, created_at, last_used_at, revoked_at}]}`
- `POST /api/keys {name}` → `201 {key:{id,name,prefix,created_at}, secret:'nzx_…'}` (secret
  shown once; max 10 active keys; `prefix` = `'nzx_'` + the first 8 characters of the key body)
- `DELETE /api/keys/:id` → `{status:'revoked'}`
- `POST /api/sessions/revoke-all` → `{revoked:<n>}` (signs out all CLI sessions)

### 3.5 Billing (Razorpay primary; provider-agnostic schema)

- `GET /api/billing` → `{provider_configured, subscription:null|{id, plan, status,
  current_period_end, cancel_at_period_end, provider:'razorpay'}, payments:[{id, kind:
  'subscription'|'topup', amount_minor, currency, status, created_at, invoice_url}]}`
- `POST /api/billing/checkout {plan:'pro'|'max', currency:'INR'|'USD'}` → `{provider:
  'razorpay', key_id, subscription_id, name, description, prefill:{email,name}, notes}`
  (409 `already_subscribed`, 503 `billing_not_configured`)
- `POST /api/billing/topup {pack, currency}` → `{provider, key_id, order_id, amount_minor,
  currency, name, description, prefill}`
- `POST /api/billing/verify {razorpay_payment_id, razorpay_signature,
  razorpay_subscription_id? | razorpay_order_id?}` → `{status:'ok', account}`. Signature =
  HMAC-SHA256(`payment_id|subscription_id` or `order_id|payment_id`, key secret).
- `POST /api/billing/cancel` → `{status:'cancel_scheduled', current_period_end}`
- `POST /webhooks/razorpay` — verifies `X-Razorpay-Signature` (HMAC-SHA256 of the raw body
  with `RAZORPAY_WEBHOOK_SECRET`), dedupes by `x-razorpay-event-id`. Handles
  `subscription.authenticated|activated|charged|pending|halted|cancelled|completed`,
  `payment.captured|failed`, `order.paid`. `subscription.charged` grants the plan's monthly
  credits once per invoice/payment id.
- Env: `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` (secret), `RAZORPAY_WEBHOOK_SECRET` (secret),
  plan ids in `zerox_plan_policy.razorpay_plan_id_inr/usd` (created by
  `scripts/razorpay-bootstrap.mjs`).

### 3.6 Admin

`GET /admin/overview` (Bearer `GATEWAY_ADMIN_TOKEN`) → `{users:{total, active_today,
by_plan}, revenue:{active_subscriptions, mrr_usd_estimate}, usage_today:{requests, tokens,
cost_usd}, pools:[{model, tier, requests_today, tokens_today, limits, health}]}`

### 3.7 Existing endpoints kept

`/health`, `/ready`, `/auth/config`, `/auth/cli/session`, `/auth/session` (GET/DELETE),
`/auth/usage`, `/auth/plan`, `/auth/sync`, `/auth/me`, CLI loopback login
(`/neuroncli/login/?callback_url=http://127.0.0.1:<port>/callback&state=…`).
`/auth/session` additionally returns `expires_at`.

## 4. Database RPCs (Postgres, `SECURITY INVOKER`, `service_role` only)

All called through `rpc(env, name, args)` / `rpcRows(env, name, args)` in
`src/account-store.js` (PostgREST in production; PGlite when `DATABASE_DRIVER=pglite`).

| RPC | args | returns (row) |
|-----|------|---------------|
| `zerox_reserve_v2` | `p_user_id uuid, p_request_id text, p_model text, p_tier text, p_tokens bigint, p_cost_microusd bigint, p_pool jsonb` (`{rpm,rpd,tpm,tpd}` or null) | `{status, reservation_id, plan, remaining_requests, remaining_tokens, credit_balance_microusd, resets_at, retry_after_seconds}`; status ∈ `ok, no_account, suspended, upgrade_required, user_daily_requests, user_daily_tokens, user_rpm, user_concurrency, insufficient_credits, pool_exhausted` |
| `zerox_settle_v2` | `p_reservation_id uuid, p_prompt_tokens bigint, p_completion_tokens bigint, p_cost_microusd bigint, p_status text ('ok','error','refunded','failed_upstream'), p_latency_ms int, p_provider text, p_upstream_model text, p_error_code text` | `{status:'settled'|'already_settled'|'not_found', credit_balance_microusd}` |
| `zerox_release_stale_reservations` | — | `{released}` |
| `zerox_plan_policies_v2` | — | one row per plan: `plan, name, price_usd, price_usd_cents, price_inr_paise, daily_requests, daily_tokens, rpm_limit, concurrency_limit, allowed_tiers text[], monthly_credit_microusd, features, sort, public, highlighted, razorpay_plan_id_inr, razorpay_plan_id_usd` |
| `zerox_account_overview` | `p_user_id` | account + policy + credits + subscription + today usage (jsonb columns) |
| `zerox_usage_series` | `p_user_id, p_from date, p_to date` | rows `{day, requests, prompt_tokens, completion_tokens, cost_microusd}` |
| `zerox_usage_by_model` | `p_user_id, p_from, p_to` | rows `{model, requests, prompt_tokens, completion_tokens, cost_microusd}` |
| `zerox_usage_events` | `p_user_id, p_limit int, p_before bigint` | rows of `zerox_usage_events` |
| `zerox_api_key_create` | `p_user_id, p_name, p_prefix, p_hash` (`p_prefix` ~ `^nzx_[A-Za-z0-9_-]{0,28}$`, `p_hash` = lowercase hex SHA-256 of the secret) | `{id, name, prefix, created_at}` (raises `too_many_keys`) |
| `zerox_api_key_list` | `p_user_id` | rows |
| `zerox_api_key_revoke` | `p_user_id, p_key_id uuid` | `{revoked boolean}` |
| `zerox_api_key_verify` | `p_hash` | `{key_id, user_id}` or no row |
| `zerox_billing_upsert_subscription` | `p_user_id, p_provider, p_provider_subscription_id, p_plan, p_status, p_current_period_start timestamptz, p_current_period_end timestamptz, p_cancel_at_period_end boolean, p_raw jsonb` | subscription row; sets account plan when status ∈ (authenticated, active), reverts to free when ended |
| `zerox_billing_record_payment` | `p_user_id, p_provider, p_provider_payment_id, p_kind, p_amount_minor bigint, p_currency, p_status, p_invoice_url, p_raw jsonb` | payment row (idempotent on provider+payment id) |
| `zerox_credit_grant` | `p_user_id, p_delta_microusd bigint, p_reason text` (~ `^[a-z][a-z0-9_]{0,63}$`, e.g. `topup_credits_5`, `subscription_pro`), `p_ref text` (unique; the `usage:` prefix is reserved) | `{granted boolean, balance_microusd}` (idempotent on ref) |
| `zerox_webhook_claim` | `p_provider, p_event_id, p_event_type, p_payload_sha256, p_lease_seconds int = 120` | `{claimed boolean, in_progress boolean}` (a lease, see section 7) |
| `zerox_webhook_complete` | `p_provider, p_event_id` | `{completed boolean}` (marks a claimed delivery processed) |
| `zerox_webhook_release` | `p_provider, p_event_id` | `{released boolean}` (drop a claim whose processing failed so the retry is processed) |
| `zerox_billing_get` | `p_user_id` | `{subscription jsonb, payments jsonb}` |
| `zerox_billing_subscriptions` | `p_user_id` | rows of the user's subscriptions that have not ended, newest first, plus `provider_plan_id` and `payments` (recorded payments that did not fail) |
| `zerox_billing_record_checkout` | `p_user_id, p_provider, p_provider_subscription_id, p_plan, p_raw` | `{recorded boolean, blocking_subscription_id, blocking_status, blocking_plan_id}` (records a checkout as 'created' unless a live subscription or another unpaid checkout from the last 24 h exists) |
| `zerox_billing_revoke_subscription` | `p_provider, p_provider_subscription_id, p_reason ('duplicate'|'refunded')` | subscription row (never entitles again) |
| `zerox_payment_by_provider_id` | `p_provider, p_provider_payment_id` | `{id, user_id, kind, amount_minor, currency, status, subscription_id, granted_microusd, granted_reason}` |
| `zerox_subscription_by_provider_id` | `p_provider, p_provider_subscription_id` | subscription row incl. `user_id` |
| `zerox_apply_subscription_expiry` | — | `{downgraded, reconciled}` |
| `zerox_session_index_add/list/revoke_all` | `p_user_id, p_token_hash, p_expires_at` | session index for revoke-all; `revoke_all` returns one `{token_hash}` row per removed entry |
| `zerox_session_index_remove` | `p_token_hash` | `{removed boolean}` (single sign-out) |
| `zerox_session_rearm` | `p_key, p_value, p_ttl` | `{rearmed boolean}` (rewrites a stored session only while it still exists) |
| `zerox_admin_overview` | — | `{overview jsonb}` |

Legacy RPCs (`zerox_reserve_usage`, `zerox_settle_usage`, …) remain for rollback.

## 5. CLI obligations (neuron-v2)

- Default provider is the stored Zero-X login; ambient `OPENAI_API_KEY`/`OPENROUTER_API_KEY`
  only win with `--provider`/config `provider` or when not logged in.
- Never export the session token into the process environment; scrub credential env vars
  from tool/MCP/hook subprocesses.
- Fetch `GET /v1/models` once per process (cache 10 min) and register capabilities in
  `runtime::model_registry`; `/model` validates against the catalog.
- Render error `message` + `upgrade_url`/`resets_at`; never retry `insufficient_quota`,
  `insufficient_credits`, `upgrade_required`, `invalid_session`; retry `rate_limited`,
  `capacity_exhausted`, `upstream_*` at most 2 times honoring `Retry-After`, printing progress.
- `/usage` calls `GET /api/account`; `/upgrade` opens `upgrade_url`; `/login`, `/logout` run
  the gateway login flow.

## 6. v1.1 amendments (integration of the business platform, 2026-10-16)

Resolved while integrating the gateway, database, API and website packages; the side the
database or this contract already enforced won. Sync the copy in `neuron-v2`.

- **Plans (§1).** Credit top-ups need a plan whose tiers include `paid`; Free accounts get
  `403 upgrade_required` from `POST /api/billing/topup`. Plan rows are read through the
  `zerox_plan_policies_v2` column names (`rpm_limit`, `concurrency_limit`, `allowed_tiers`).
- **Geo rule (§2).** Free Gemini pools are refused when the caller's country is in EEA/GB/CH,
  is a Cloudflare unknown jurisdiction (`T1`, `XX`) or is not known at all (Node without
  `TRUST_CF_IPCOUNTRY`). `ALLOW_UNKNOWN_COUNTRY=true` exists for local development only.
- **Dev identity (§3.1).** `dev_` tokens create their account on the PGlite driver, which
  provisions the identity's `auth.users` row; on PostgREST they cannot (no Supabase Auth user).
- **Models (§3.2).** `data[]` lists every offered model, unconfigured ones with
  `available:false, unavailable_reason:'not_configured'`. Paid tiers count only for sessions
  backed by an account ledger, exactly as routing does.
- **Errors (§3.3).** `param` is `null` or names the offending field. Additional codes:
  `model_not_found` (404), `service_unavailable` (503), `api_key_not_allowed` (403),
  `session_not_allowed` (403: creating an API key needs the website sign-in, not a CLI session),
  `too_many_keys` (409), `not_found` (404), `billing_not_configured` (503),
  `already_subscribed` (409), `no_active_subscription` (409), `invalid_signature` (400),
  `payment_mismatch` (400/403), `payment_failed` (402), `payment_provider_error` (502); suspended
  accounts also get `403 account_suspended` from checkout, top-up and key creation. An upstream
  429 is reported as `503 capacity_exhausted` (shared pool) with `retry_after_seconds`. Upstream
  timeouts count bytes, SSE comments included; the first data event is due within the first-byte
  plus idle budgets. Timestamps (`resets_at`, `current_period_end`, `created_at`) are ISO 8601 UTC
  as produced by `toISOString()`.
- **Account (§3.4).** `GET /api/usage/events` accepts `limit` 1–200.
- **Billing (§3.5).** `POST /api/billing/verify` answers `{status:'pending', account}` while
  Razorpay has not confirmed the payment, and never clears a scheduled cancellation. Ledger
  reasons are `topup_<pack>` and `subscription_<plan>` with the Razorpay payment id as `ref`.
- **Admin (§3.6).** `pools[]` items also carry `provider`, `configured`, `requests_this_minute`
  and `tokens_this_minute`; `limits` is `null` for pools without a shared budget (paid pools);
  `health` is `{status, circuit_open, cooldown_remaining_ms, last_failure_kind}` for the serving
  isolate.

## 7. v1.2 amendments (integration review fixes, 2026-10-16)

Sync the copy in `neuron-v2`; nothing here changes what the CLI sends or must handle.

- **One payable subscription per account (§3.5).** `POST /api/billing/checkout` records the
  Razorpay subscription as `created` and, while it is unpaid (24 h), answers the same
  `subscription_id` for the same plan and currency; an unpaid checkout for another plan or
  currency is cancelled at Razorpay first. It answers `409 checkout_in_progress` while a payment
  for the open checkout is being confirmed (or a parallel checkout for another plan was recorded
  first), and `409 already_subscribed` while any subscription is live. A subscription that becomes
  live (authenticated, active, pending) while another one is live is a duplicate: it is revoked
  (`revoked_reason 'duplicate'`), never entitles, gets no monthly credits, and verify or the
  webhook cancels it at Razorpay at once and refunds its payments in full (verify answers
  `409 already_subscribed`). `POST /api/billing/cancel` acts on every live subscription: entitled
  ones end with their period, live duplicates now; unpaid checkouts are closed.
- **Unconfirmed payments (§3.5).** Verify's `{status:'pending'}` records the payment attempt.
  Clients show it as awaiting confirmation (never as confirmed) and offer no new purchase until
  Billing lists the payment as captured, refunded or failed (the website keeps this lock for
  30 minutes across reloads).
- **Webhooks (§3.5).** Claims are leases: a claimed delivery stays `processing` for
  `p_lease_seconds` (120) until `zerox_webhook_complete`, a retry claims it again once the lease
  expired, and a delivery whose lease is live answers `503` (Razorpay retries). Handled in
  addition: `refund.processed` (the payment becomes `refunded` once refunded in full; credits
  granted for it are taken back in proportion to the refund, ledger reason `refund`, ref
  `refund:<refund id>`, balances clamp at zero; a full refund of a subscription payment revokes that
  subscription with `revoked_reason 'refunded'` and cancels it at Razorpay at once).
  `payment.dispute.*` events are logged for the operator (GATEWAY_SETUP.md, "Refunds and disputes").
- **Refunded failures (§3.3).** `upstream_error` and `upstream_timeout` still return the request
  to the caller. An attempt that reached the model (a model-side rejection such as Groq's
  `tool_use_failed`, a first-byte, idle or response timeout) is settled as `failed_upstream`: it
  keeps its request and prompt tokens in the shared pool budget, and the caller's refund is
  limited to a tenth of the plan's daily requests per UTC day (at least 5); further ones count like
  errors. Rejections the upstream did not count (429, 5xx, network and auth failures) stay full
  refunds of user and pool. Sessions without an account ledger are unchanged.
- **Circuit (§2).** A first-byte or idle timeout parks a shared pool only once two distinct callers
  timed out on it within 60 s; one caller's slow prompts cannot park a pool for everyone. Each such
  timeout marks the pool slow for five minutes (until a success clears it): `auto` still offers it,
  after the healthy pools of its tier. Before a stream is committed, failover is bounded by
  `UPSTREAM_FAILOVER_BUDGET_MS` (50 s); an attempt that budget cut is not counted against its pool.
- **Dev identity (§3.1).** `dev_` credentials are refused under `NODE_ENV=production` and on
  requests whose `Origin` is not a loopback origin (`http://127.0.0.1`, `localhost`, `[::1]`).
- **Sessions (§3.4, §3.7).** `POST /api/sessions/revoke-all` accepts `{api_keys: true}` to also
  revoke every API key of the user and then answers `{revoked, api_keys_revoked}`.
  `POST /auth/cli/session` answers `503 service_unavailable` (and keeps no session) when the session
  cannot be added to the revoke-all index. Re-arming a stored session never recreates one that a
  sign-out or revoke-all deleted (`zerox_session_rearm`).
- **Health probes.** `POST /v1/models/health` applies the caller's country (geo rules) exactly as
  `POST /v1/chat/completions` does.
- **Errors (§3.3).** Additional code: `checkout_in_progress` (409).
- **Free per-minute budgets (§2, §3.3).** The free Gemini pools budget rpm 5 / tpm 120K per model.
  A prompt that the caller's free pools could take only without their per-minute token budget
  (prompt plus `max_tokens` above it) answers `400 context_length_exceeded`, whose message names
  the budget, with `upgrade_url` when a paid pool would take it, instead of
  `403 upgrade_required` ("model not in plan"). Clients handle it like any other
  `context_length_exceeded` (compact or shorten).
- **Reservation size (§4, 2026-10-21).** `zerox_reserve_v2`'s `p_tokens` (the user's daily tokens
  and the shared pool budget) is the prompt estimate plus `min(max_tokens, 1024)`, settled to the
  real usage; paid credits still hold the cost of the full `max_tokens`. Holding all of
  `max_tokens` let one Groq request take the whole 8K-token minute of every user. A request can
  therefore run past the daily token cap by its own output; the next one is refused.

## 8. v1.3 amendments (production alpha, 2026-10-19)

### 8.1 Model status (`/v1/models`, `/v1/models/status`)

- `/v1/models` items also carry `context_length` (equal to `context_window`, for OpenAI-style
  clients), `reasoning_efforts[]`, `capabilities.vision`, `capabilities.reasoning`, and runtime
  health: `status` (`available` | `degraded` | `busy` | `blurred`), `available_again_at`
  (ISO time or `null`) and `checked_at` (ISO time of the newest observation, or `null`).
  - `busy`: a short rate-limit cooldown (60 s or less); keep the model selectable and show the wait.
  - `blurred`: grey the model out until `available_again_at` (quota spent, model gone, provider down).
  - `available` stays the plan/region/configuration verdict; a client greys out a model when
    `available` is false or `status` is `blurred`.
  - Pool health comes from the HealthHub Durable Object (src/health-hub.js): real outcomes from
    every isolate, plus a 30 s alarm that reads provider model lists and status pages and sends a
    one-line test request only to idle pools whose cooldown ended (daily caps: Groq 24, Gemini 6,
    Workers AI 48 per model; NVIDIA and OpenRouter none). A recovered model returns to
    `available`. Isolates cache the snapshot for 5 s. Without the binding (the Node server) health
    is shared through KV instead, up to about a minute old.
  - A pool whose shared budget refused a reservation (`pool_exhausted`) is `busy` until the next
    minute (rpm/tpm) or `blurred` until UTC midnight (rpd/tpd), with that time as
    `available_again_at`, until a reservation on it succeeds again. Each isolate knows the refusals
    it saw (src/pool-budget.js): exact on the Node server, per isolate on Workers. A model's status
    considers only the tiers the caller can use.
- `auto` advertises the smallest context window among its candidates (it can fail over to any).
- `GET /v1/models/status` (same optional auth as `/v1/models`) returns
  `{object:'list', checked_at, poll_interval_seconds:30, data:[{id, available, unavailable_reason,
  status, available_again_at}]}` with a weak `ETag`; `If-None-Match` answers `304`. Clients poll it
  every `poll_interval_seconds`.

### 8.2 Device sign-in (`neuron login` without a localhost callback)

RFC 8628 shape. Errors use the §3.3 envelope with `error.code` set to the RFC name.

| Endpoint | Auth | Body → response |
|---|---|---|
| `POST /auth/device/code` | none | `{client_id, client_version, device_name, os}` → `{device_code:'zdc_…', user_code:'XXXX-XXXX', verification_uri, verification_uri_complete, expires_in:600, interval:5}` |
| `POST /auth/device/token` | none | `{grant_type:'urn:ietf:params:oauth:grant-type:device_code', device_code}` → `{access_token:'ses_…', token_type:'Bearer', expires_in, expires_at, session_token, …account}` |
| `POST /auth/device/lookup` | website identity, approval page only | `{user_code}` → `{grant_id, user_code, account:{email}, client, requester, browser_country, created_at, expires_at, approval_nonce}` |
| `POST /auth/device/approve` | website identity, approval page only | `{grant_id, approval_nonce, decision:'approve'\|'deny'}` → `{status}` |

- `verification_uri` is `https://neuron.zero-x.live/device` (the loopback origin plus
  `/neuroncli/device/` on a local dev server). The CLI prints it and the code, opens a browser
  when it can, and never needs a local listener.
- Polling: `400 authorization_pending` (keep polling every `interval` s), `400 slow_down` with
  `error.interval` (the new interval; +5 s, at most 60 s), `400 expired_token`, `400 access_denied`,
  `400 invalid_grant` (unknown or already used: a device code yields exactly one session).
  `/auth/device/code` answers `429 rate_limited` with `Retry-After` when an IP asks too often, or
  holds 5 unexpired pending codes (then `Retry-After` is the time until the oldest one expires).
  The local Node server also serves the approval page at `/device`.
- The session is the same account-backed `ses_` session as `/auth/cli/session` (same TTL, listed
  for revoke-all). Refresh tokens are a later amendment; until then an expired session means
  running `neuron login` again.
- `user_code`: 8 letters from `BCDFGHJKLMNPQRSTVWXZ`; input is case-insensitive and separators are
  ignored. The approval page shows the device as reported, the requester's IP and location, and a
  warning when the requester's country differs from the browser's; approval needs an explicit click.
- `/auth/device/lookup` and `/approve` require `Origin` `https://neuron.zero-x.live` (or
  `https://zero-x.live`), JSON, and a website identity in `Authorization` (`ses_`/`nzx_` → 401);
  `approval_nonce` binds the approval to that user and grant for 5 minutes. Production needs the
  Worker secret `DEVICE_APPROVAL_SECRET`.

### 8.3 Credentials

- `POST /api/keys` requires the website identity; a CLI session gets `403 session_not_allowed`.

### 8.4 Provider discovery (operator only)

Finds new free models and providers and queues them for the operator; it never enables anything
by itself, and signing up to a provider stays manual. Code: `src/discovery/`, review routes
`src/routes/discovery.js`, migration `20261019120000_provider_discovery.sql`.

- **Candidates** (`zerox_provider_candidates`, unique per provider and model id; `model_id ''` is
  the provider's own record in the provider database shape). Status: `new` (queued), `approved`
  (operator yes), `verified` (the live tool call passed: proposed for the catalog), `rejected`
  (operator no; with no reviewer it means filtered by the policy), `excluded` (never offered).
  Seeded from the 2026-10-19 provider database (186 providers): models in `src/catalog.js` are
  `verified`, free tool-capable models with at least 64K context are `new`, the rest filtered.
- **Jobs** on the 10-minute cron, each claimed with a lease (`zerox_discovery_claim`), state in
  `zerox_discovery_state`:
  - `list:<source>`, daily: the public no-key lists of OpenRouter (`:free` ids), Kilo Gateway,
    OpenCode Zen, Vercel AI Gateway, Requesty, AIHubMix, NVIDIA and LLM7 (bare lists completed
    from models.dev). A free, tool-capable id with at least 64K context becomes a candidate;
    candidates no longer listed get `gone_at`; a `src/catalog.js` (or promoted) model whose
    upstream id is gone is marked `model_unavailable` in HealthHub (`POST /mark`), unless the list
    dropped more than half of them. A failed list retries in an hour.
  - `omniroute`, weekly: diff of OmniRoute's MIT free-tier catalog
    (`raw.githubusercontent.com/diegosouzapw/OmniRoute/main/open-sse/config/freeModelCatalog.data.ts`);
    the first run records a baseline.
  - `research`, weekly, only with `ANTHROPIC_API_KEY`: one Claude Haiku 5.5 call with web search,
    given the current list, returning records in the provider database shape with sources.
    Searches and output tokens are sized to `DISCOVERY_RESEARCH_MAX_USD` (default $0.25 a run);
    the list-price spend is recorded, a paused answer is not resumed, and a run over the cap halves
    the next run's searches.
- **Exclusion filter**: access that needs CAPTCHA solving, scraping a consumer chat website, a
  spoofed client or another product's login is `excluded`, also for every model of an excluded
  provider; excluded candidates cannot be approved.
- **Review** (`Bearer GATEWAY_ADMIN_TOKEN`; page `GET /admin/discovery`):
  `GET /admin/discovery/candidates?status=&provider=&q=&limit=&offset=`, `GET …/candidates/{id}`,
  `POST …/{id}/approve` (runs one live streamed tool call when this deployment holds a key for the
  provider: the provider's own secret, or `DISCOVERY_KEY_<ID>` with `DISCOVERY_BASE_<ID>`),
  `POST …/{id}/verify`, `POST …/{id}/reject`, `POST …/candidates/reject` (`{ids}`),
  `POST …/{id}/promote`, `POST …/{id}/demote`, `POST /admin/discovery/run` (`{jobs}`; research
  only when named).
- **Catalog join**: promotion writes `gateway_provider_models` (with `candidate_id`). With
  `CATALOG_DB_MODELS=true` the gateway adds those rows to the code-defined catalog (60 s cache)
  through a template per provider in `src/catalog.js` (OpenRouter and NVIDIA today), which fixes
  the adapter, key, hosting flag and shared budget. They are free pools only, never chosen by
  `auto`, never replace a code-defined id, and `*_MODELS` still narrows them. A demoted, rejected or
  failed candidate stops being offered within the 60 s cache.

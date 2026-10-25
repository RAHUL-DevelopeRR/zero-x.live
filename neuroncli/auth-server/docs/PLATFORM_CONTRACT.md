# Neuron × Zero-X platform contract

Status: v1.8 (2026-10-25; amendments v1.1 to v1.8 in sections 6 to 13). This document is the source of truth shared by the Neuron CLI
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

## 2. Model catalog (gateway `src/catalog.js`, data-driven rows since v1.8: section 13.1)

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
    { tier: 'free', key_slot: 'gemini.free', key_var: 'GEMINI_API_KEY', limits: { rpm: 5, rpd: 250, tpm: 120000, tpd: 5000000 } },
    { tier: 'paid', key_slot: 'gemini.paid', key_var: 'GEMINI_PAID_API_KEY', daily_spend_cap_usd: 10,
      price: { input_microusd_per_mtok: 375000, output_microusd_per_mtok: 3125000 } },
  ],
}
```

`key_var` comes only from the key slot (`src/catalog-types.js` `KEY_SLOTS`). Paid pools carry a
price and a daily spend cap (section 13.4); Claude prices add `cache_read_microusd_per_mtok`,
`cache_write_microusd_per_mtok` and `cache_write_1h_microusd_per_mtok`. `/v1/models` `pricing` is
`{input_per_mtok_usd, output_per_mtok_usd}` plus, for Claude, `cache_read_per_mtok_usd` and
`cache_write_per_mtok_usd`.

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
  unavailable_reason:null|'upgrade_required'|'region_unavailable'|'policy_restricted'|'not_configured',
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
| 403 | `policy_restricted` | permission_error | no offer of the model meets the caller's data policy (§12.2) |
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
- `GET /api/account` → `{user:{id,email,name,display_name,initials,image_url},
  session_expires_at, plan:{id,name}, limits:{...},
  usage_today:{requests, tokens, resets_at}, credits:{balance_usd, monthly_grant_usd},
  subscription:null|{status, current_period_end, cancel_at_period_end},
  flags:{suspended}}` (`display_name`, `initials` and `session_expires_at`: §9.1)
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
cost_usd}, pools:[{model, tier, requests_today, tokens_today, limits, health, keys?}]}` (`keys`: vault
keys, section 8.4)

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
| `zerox_reserve_v2` | `p_user_id uuid, p_request_id text, p_model text, p_tier text, p_tokens bigint, p_cost_microusd bigint, p_pool jsonb` (`{rpm,rpd,tpm,tpd,cpd}` or null; `cpd` = a paid pool's daily spend cap in billed micro-USD per UTC day, section 13.4), `p_pool_key text = null` (a provider key vault pool's key, 1-300 characters: `p_pool` is then that key's budget, counted in its own buckets; null = the model's default bucket, §11.1) | `{status, reservation_id, plan, remaining_requests, remaining_tokens, credit_balance_microusd, resets_at, retry_after_seconds}`; status ∈ `ok, no_account, suspended, upgrade_required, user_daily_requests, user_daily_tokens, user_rpm, user_concurrency, insufficient_credits, pool_exhausted` |
| `zerox_settle_v2` | `p_reservation_id uuid, p_prompt_tokens bigint, p_completion_tokens bigint, p_cost_microusd bigint, p_status text ('ok','error','refunded','failed_upstream'), p_latency_ms int, p_provider text, p_upstream_model text, p_error_code text, p_cache_read_tokens bigint = 0, p_cache_write_tokens bigint = 0` (cache tokens are part of `p_prompt_tokens`, section 13.4) | `{status:'settled'|'already_settled'|'not_found', credit_balance_microusd}`; reconciles the pool bucket stored on the reservation (model, tier, pool key) |
| `zerox_release_stale_reservations` | — | `{released}` |
| `zerox_plan_policies_v2` | — | one row per plan: `plan, name, price_usd, price_usd_cents, price_inr_paise, daily_requests, daily_tokens, rpm_limit, concurrency_limit, allowed_tiers text[], monthly_credit_microusd, features, sort, public, highlighted, razorpay_plan_id_inr, razorpay_plan_id_usd` |
| `zerox_account_overview` | `p_user_id` | account + policy + credits + subscription + today usage (jsonb columns) |
| `zerox_usage_series` | `p_user_id, p_from date, p_to date` | rows `{day, requests, prompt_tokens, completion_tokens, cost_microusd}` |
| `zerox_usage_by_model` | `p_user_id, p_from, p_to` | rows `{model, requests, prompt_tokens, cache_read_tokens, cache_write_tokens, completion_tokens, cost_microusd}` |
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
| `zerox_admin_overview` | — | `{overview jsonb}`; `overview.pools` has one row per model and tier, summed over its pool keys, with `keys:[{pool_key (null = default bucket), requests_today, tokens_today, requests_this_minute, tokens_this_minute}]` |
| `zerox_provider_key_add` | `p_id uuid` (chosen by the gateway: the ciphertext is bound to it), `p_provider` (`groq`, `gemini`, `nvidia`, `openrouter`), `p_label`, `p_ciphertext`, `p_iv` (base64), `p_last4` | key metadata row (raises `too_many_keys` at 20 active keys per provider) |
| `zerox_provider_keys_list` | — | metadata rows `{id, provider, label, last4, status, created_at, disabled_at, last_used_at}`, never ciphertext |
| `zerox_provider_keys_active` | — | active rows with `ciphertext, iv` for the gateway to decrypt |
| `zerox_provider_key_disable` | `p_id` | the key's metadata row (idempotent; no row = unknown id) |
| `zerox_provider_key_touch` | `p_id` | `{touched boolean}` (`last_used_at`) |

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
  timed out on it within 60 s; one caller's slow prompts cannot park a pool for everyone.
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
  only when named). Since v1.8 demote only disables a legacy `gateway_provider_models` row, which
  is never served; a candidate with a catalog row answers 409 `catalog_managed` (disable the row
  on `/admin/models`).
- **Catalog join** (until v1.8; since v1.8 promotion creates a draft catalog row, section 13.2):
  promotion writes `gateway_provider_models` (with `candidate_id`). With
  `CATALOG_DB_MODELS=true` the gateway adds those rows to the code-defined catalog (60 s cache)
  through a template per provider in `src/catalog.js` (OpenRouter and NVIDIA today), which fixes
  the adapter, key, hosting flag and shared budget. They are free pools only, never chosen by
  `auto`, never replace a code-defined id, and `*_MODELS` still narrows them. A demoted, rejected or
  failed candidate stops being offered within the 60 s cache.

## 9. v1.4 amendments (Neuron apps, 2026-10-23)

For the account row and menu, update notices, downloads and trust screens in the terminal UI,
desktop and mobile apps (feature-parity plan WP5, rows A3, A6, A7, A8, A17).

### 9.1 Account fields (`GET /api/account`)

- `user.display_name`: the profile name, else first and last name, else the username, else the
  email's local part, else `"Zero-X user"`. Control and format characters are removed, whitespace
  is collapsed, and it is capped at 80 characters. Clients render it as text.
- `user.initials`: one letter for a one-word name, otherwise the first letters of the first and
  last words, upper-cased (`"Alice Example"` → `AE`, `"rahul.s"` → `RS`; dots, dashes and
  underscores separate words). `"?"` when the name has no letter or digit.
- `session_expires_at`: ISO time when the credential used for this request stops working, for
  "sign in again" warnings (warn 3 days before). A `ses_` CLI session reports its stored expiry
  (720 h after sign-in by default); a website access token reports its JWT `exp`; API keys and
  dev identities report `null` (they do not expire). `user.name` keeps its old meaning.

### 9.2 Release manifests

`GET /releases/cli/latest.json` and `GET /releases/desktop/latest.json`: public, no
credentials, `Cache-Control: public, max-age=300`, `Access-Control-Allow-Origin: *`. Schema,
validation, serving order (R2 bucket `RELEASES`, then the committed copy, then a built-in
"nothing released" manifest) and the publishing steps for the release workflows are in
`docs/RELEASE_MANIFESTS.md`. `version: null` means nothing is published yet: clients show no
update notice.

### 9.3 Public pages the clients link to

| URL | Used by |
|---|---|
| `https://zero-x.live/download` | account menu *Download Neuron*, update notices (D6, D23, T23) |
| `https://zero-x.live/docs/trust` | folder trust screens (T1, D9) |
| `https://zero-x.live/docs#support` | *Help and support* (D6) |
| `https://zero-x.live/privacy#gateway-logging` | privacy screens (T30, D35, M8) |

`/download` used to redirect to the NeuCockpit downloads; `/start` still does. The privacy
policy states that the gateway stores usage metadata only, never prompt or response text, and
the retention of each record type.

## 10. v1.5 amendments (linked devices, changelog, relay, 2026-10-23)

Feature-parity plan rows A9, A10, A12, A13 and A11. Migrations
`20261023000000_session_devices.sql` and `20261023000100_push_tokens.sql`.

### 10.1 Linked devices (`/api/sessions`)

- `GET /api/sessions` (website or CLI sign-in; API keys get 403) →
  `{sessions:[{id, device_name, os, client:{name, version}, created_at, last_used_at, expires_at,
  current}]}`, most recently used first. `id` is 24 hex characters derived from the token hash;
  `current` marks the CLI session making the request.
- `DELETE /api/sessions/:id` → `{status:'revoked', current}`; `404 not_found` for an unknown or
  another account's session. It also closes that session's relay sockets.
- Sign-in records the device: `POST /auth/cli/session` accepts optional `device_name`, `os`,
  `client_name`, `client_version` (or `version`); the device flow uses what `/auth/device/code`
  reported. Display data only.
- Without the migration the list falls back to `zerox_session_index_list` (device fields `null`).

### 10.2 Sliding session expiry

A CLI session in use stays `CLI_SESSION_TTL_HOURS` (720 h) ahead of its last use: on use it is
extended at most once a day, never beyond `CLI_SESSION_MAX_DAYS` (90) after sign-in. The new
expiry shows in `GET /auth/session` `expires_at` and `GET /api/account` `session_expires_at`.
"Last used" updates at most every 5 minutes. Both run after the response (`waitUntil`). The
session index decides: the record is rewritten only while the index row exists, and checked again
afterwards, so a sign-out or revoke that races an extension always wins. Without the migration,
sessions keep their fixed lifetime. (Rotating refresh tokens remain unnecessary.)

### 10.3 Changelog

`GET /api/changelog.json?product=cli|desktop|mobile&limit=1..50` (public, `max-age=300`) →
`{object:'list', repository, updated_at, stale, data:[{product, version, tag, title,
published_at, prerelease, url, notes}]}` from the `RAHUL-DevelopeRR/neuron-v2` GitHub releases:
tag `v<semver>` is the CLI, `desktop-v<semver>` and `mobile-v<semver>` the apps. `notes` is the
release's Markdown as plain text (max 20,000 characters). GitHub is read at most every 15 minutes;
the last copy is served for a day when it fails (`stale: true`), else `503` with `Retry-After`.
The page is `https://zero-x.live/changelog`. Optional secret `GITHUB_RELEASES_TOKEN`.

### 10.4 Relay and push

Protocol, limits, close codes and push rules: `docs/RELAY.md`. Endpoints `wss://zero-x.live/relay/v1/host`,
`/relay/v1/client`, `POST /relay/v1/ticket`, `GET /relay/v1/hosts`, and `POST|GET /api/push/tokens`,
`DELETE /api/push/tokens/:id`. Durable Object binding `RELAY` (class `RelayRoom`). Optional secret
`EXPO_ACCESS_TOKEN`.

### 10.5 RPCs

| RPC | args | returns (row) |
|-----|------|---------------|
| `zerox_session_register` | `p_user_id, p_token_hash, p_expires_at, p_client jsonb {device_name, os, client_name, client_version}, p_device_grant_id uuid` | like `zerox_session_index_add`; stores the device |
| `zerox_session_list` | `p_user_id` | rows `{token_hash, created_at, last_used_at, expires_at, device_name, device_os, client_name, client_version}` |
| `zerox_session_touch` | `p_token_hash, p_expires_at timestamptz = null` | `{present, expires_at}` (marks use; extends, never shortens, max 400 days after sign-in) |
| `zerox_session_revoke` | `p_user_id, p_token_hash` | `{revoked boolean}` |
| `zerox_push_register` | `p_user_id, p_token, p_platform, p_device_name, p_needs_input, p_finished` | token row without the token |
| `zerox_push_list` | `p_user_id` | rows including `token` (server use only) |
| `zerox_push_delete` | `p_user_id, p_id` | `{deleted boolean}` |
| `zerox_push_delivered` | `p_sent uuid[], p_unregistered text[]` | `{sent, removed}` |

## 11. v1.6 amendments (provider key vault, 2026-10-24)

### 11.1 Provider key vault (operator)

Free-tier provider keys are added and rotated on `https://dashboard.zero-x.live/admin/keys`
instead of Worker secrets. Keys stay on the server: no endpoint returns one, and the Neuron CLI
never sees them.

| Endpoint | Body → response |
|---|---|
| `GET /admin/providers/keys` | → `{vault_configured, access_configured, providers:[{provider, active_keys, max_keys, env_key:{variable, last4, fallback, duplicate_of} or null}], keys:[{id, provider, label, last4, status, created_at, disabled_at, last_used_at, health:{pools, available, degraded, busy, blurred} or null}]}` |
| `POST /admin/providers/keys` | `{provider, label, key}` → `201 {key}` (metadata). `400 invalid_request`, `409 duplicate_key`, `409 too_many_keys`, `422 invalid_provider_key` (the provider rejected it), `502 upstream_error` (the provider could not be reached; nothing saved) |
| `DELETE /admin/providers/keys/{id}` | → `{key}` with `status:'disabled'` (idempotent), `404 not_found` |

- **Auth.** `Authorization: Bearer GATEWAY_ADMIN_TOKEN`; when `CF_ACCESS_TEAM_DOMAIN` and
  `CF_ACCESS_AUD` are set, also a valid Cloudflare Access JWT (`Cf-Access-Jwt-Assertion`, RS256,
  audience, issuer and expiry checked) on the API and the page (`403 access_required`). `503
  vault_not_configured` without `PROVIDER_KEYS_KEK` or a database.
- **Validation.** One free request before saving: Groq and Gemini model lists with the key,
  OpenRouter `GET /api/v1/key`; NVIDIA's list is public, so a 1-token completion. A rate-limited
  answer counts as valid (the key authenticated).
- **Storage.** AES-256-GCM under `PROVIDER_KEYS_KEK` (32 bytes, base64) with a random 96-bit IV
  and `zerox_provider_keys:v1:<id>:<provider>` as additional data. Rotating the KEK means
  re-adding the keys (old rows no longer open and are skipped).
- **Pools.** Each isolate decrypts the active keys at most once a minute. Every key is its own
  free pool, `<provider>:<upstream_model>:free#<key id>`, with its own health; the environment
  key (`GROQ_API_KEY`, …) stays as the last pool unless the vault holds the same key. A caller
  starts on one key per model (stable per caller) and fails over to the others. Disabled keys
  leave every isolate within a minute.
- **Budgets.** Each key has its own shared Postgres budget (its org's or project's free limits)
  in its own `zerox_pool_usage` buckets: the gateway reserves with `p_pool_key` = the pool key and
  `p_pool` = one key's limits, and the reservation keeps the pool key so settlement reconciles the
  same bucket. A key whose budget is spent returns `pool_exhausted` and is skipped without an
  upstream call or an attempt (`ROUTER_MAX_ATTEMPTS`), like any exhausted pool, while the model's
  other keys serve; once every key is spent the request gets `capacity_exhausted`. The
  environment key (and every pool outside the vault) keeps the model's default bucket, without
  `p_pool_key`. Pool keys contain key ids, so they stay out of usage events, `zerox_usage_daily`,
  `zerox_usage_by_model` and every user-facing response, which remain per model. Migration
  `20261024000100_provider_key_budgets.sql`.
- **Health.** HealthHub reads the Groq and Gemini model lists once per key and OpenRouter's key
  endpoint per key, so a rejected key greys out only its own pools; a model stays available while
  any key can serve it. NVIDIA and OpenRouter model lists are public and read once.
- **Admin overview (§3.6).** A pool served by vault keys also carries `keys:[{key_id, source,
  requests_today, tokens_today, requests_this_minute, tokens_this_minute, limits, health}]`
  (`source` is `vault` or `env`; counters and `limits` are the key's own). The pool's counters
  are the sums over its keys, its `limits` the summed budget and its `health` the best key's. A
  key disabled after serving today stays listed with its counters and `limits`/`health` null.

## 12. v1.7 amendments (OIOP Phase 1, 2026-10-24)

The Open Inference Offer Protocol (`docs/OIOP.md`): offers, their terms and lifecycle, the caller's
data policy, secret scrubbing, catalog provenance and health. Code: `src/oiop/`, `src/routes/offers.js`;
migration `20261024000200_oiop_offers.sql`; checks `check-oiop.mjs`, `check-quota-race.mjs`.

### 12.1 Offers (operator)

- Every catalog pool belongs to an offer (`<provider>.<tier>`). A pool counts as configured only
  while its offer is `active`/`degraded` with `redistribution = permitted`; BYOK offers need only
  the lifecycle. The nine offers behind the code catalog are backfilled `active`/`permitted`.
- `GET /admin/offers`, `GET /admin/offers/:id` (with `events`), `PUT /admin/offers/:id` (create or
  change facts; validated against the offer schema; a new offer starts `discovered`, `analysed` or
  `pending_approval`), `POST /admin/offers/:id/transition {to, note}` (409 `invalid_transition`),
  `GET|POST /admin/offers/:id/manifest` (POST signs with `OIOP_SIGNING_JWK`; 503
  `signing_not_configured`). Bearer `GATEWAY_ADMIN_TOKEN` plus Cloudflare Access when configured;
  the actor recorded is the Access e-mail or `operator`. Without a database the built-in offers are
  listed read-only (503 `offers_not_configured` on writes).
- Public: `GET /oiop/schema/0.1.json`, `GET /oiop/keys.json` (public signing key only).
- RPCs (`service_role`): `zerox_offers_list()`, `zerox_offer_upsert(p_offer jsonb, p_actor text)`,
  `zerox_offer_transition(p_id, p_to, p_actor, p_note)`, `zerox_offer_store_manifest(p_id, p_version,
  p_manifest, p_signature, p_actor)`, `zerox_offer_events_list(p_id, p_limit)`,
  `zerox_offer_can_transition(p_from, p_to)`. Errors: `offer_not_found`, `invalid_transition: a -> b`,
  `invalid_offer: ...`, `stale_manifest`.

### 12.2 Caller data policy (`/v1/chat/completions`, `/v1/models`, `/v1/models/stream`)

- Request headers: `X-Neuron-Trust-Tiers` (default `T0,T1,T2`; `T3` never by default; unknown
  values ignored), `X-Neuron-Allow-Training: false` (only `trains_on_inputs = no`),
  `X-Neuron-Conversation` (sticky routing key; default: hash of the first system and user message).
  All three are allowed CORS request headers.
- A model whose configured pools the policy rules out is `available:false`,
  `unavailable_reason:'policy_restricted'`; completions answer `403 policy_restricted` (or
  `upgrade_required` when a paid pool complies).

### 12.3 Completions

- Capability filter: tools, image parts (`image_url`/`input_image`), `stream`, JSON
  `response_format` (entries with `supports_json_mode:false`). `invalid_request` names the missing
  capability for an explicit model; `auto` keeps only capable models, so failover stays in class.
- Response headers (exposed via CORS): `X-OIOP-Offer`, `X-OIOP-Fallback` (`<first model>;
  offer=<offer>; reason=<kind or reserve status>`) after a reroute, `X-OIOP-Redacted` (count of
  secrets withheld). None of them on error responses.
- Secrets in prompts are replaced by `zxsecret_<12 hex>` placeholders upstream and restored in the
  answer (streamed and not, JSON-escaped in tool arguments). `OIOP_SCRUB`: `all` (default) |
  `untrusted` | `off`.
- Ordering within a tier: the conversation's previous model (`auto`), then pools without penalties
  (degraded here or in HealthHub, error rate >= 20 % over >= 10 recent outcomes, budget seen spent).
  HealthHub's busy/blurred pools are skipped (snapshot read with a 300 ms budget, <= 60 s stale).

### 12.4 Catalog

- `/v1/models` items add `provider:{id, name, logo_url, logo_fallback_url}`,
  `offers:[{id, tier, owner, trust_tier, trains_on_inputs}]`, `models_dev_id` and
  `facts:null|{models_dev_id, name, family, canonical_model_id, release_date, knowledge, open_weights,
  reasoning, structured_output, modalities:{input, output}, list_price_per_million:{input, output}}`
  (`auto`: provider `zero-x`, empty offers, null ids and facts). Facts come from models.dev via the
  cron (at most daily; KV key `oiop:models-dev:v1`).
- `GET /v1/models/stream` (same auth as `/v1/models`): `text/event-stream`; `retry: 5000`, then
  `event: catalog.updated` with `id: <status ETag>` and the `/v1/models/status` body at start and
  on every change, `: keepalive` comments every 15 s, closed after 10 minutes; `Last-Event-ID`
  equal to the current ETag suppresses the first event.

### 12.5 Health

- HealthHub snapshot rows add `samples`, `error_rate`, `p50_ms`, `p95_ms` (time to first byte of
  successful real requests, last 50) and `canary:{at, ok, tool_call, first_byte_ms}`.
- Canaries: a healthy free pool with no real traffic for 15 minutes gets one streamed tool call
  (Groq, Gemini) or one-line request (Workers AI), at most half of `PROBE_DAILY_CAPS` per pool per
  UTC day. `HEALTH_CANARIES=false` disables them.
- `QUOTA_EXHAUSTED` marks a spent daily quota (Gemini per-day `QuotaFailure`, Workers AI 3036);
  routing answers `capacity_exhausted` for it like a rate limit.

### 12.6 Credit programs (operator)

- Weekly `credits` discovery job (with `ANTHROPIC_API_KEY`; `DISCOVERY_CREDITS=false` turns it
  off; spend capped with the research by `DISCOVERY_RESEARCH_MAX_USD`): a web-search call with
  citations, then a tool-free `json_schema` extraction. Rows (`zerox_credit_programs`) carry
  `kind` (`startup_credits | trial_credit | free_tier | grant | subsidized_compute |
  developer_program | other`), `amount_usd`/`amount_text`, `validity_days`, `self_serve`,
  `requires_funding`, `requires_card`, `india_eligible`, `usable_for` (`gpu | managed_llm_api |
  free_llm_api | cpu | storage | other`), `gpu_access` (`yes | no | quota_gated | unknown`) and
  `evidence[{field, source, url, quote}]` with page quotes. Seeded with 14 programs (2026-10-24).
- Status: `new → approved | rejected | excluded`, `approved → applied | rejected`,
  `applied → granted | rejected`, `granted → expired`; `rejected | expired | excluded → new`.
  A program reported as ended moves from `new`/`approved` to `expired`; decisions are kept.
- `GET /admin/credits[?status=]` (programs with `next_states`, `next_step`; `totals.granted_usd`,
  `to_review`, `self_serve_unclaimed_usd`), `GET /admin/credits/:id` (with `events`),
  `PUT /admin/credits/:id` (add or correct facts by hand), `POST /admin/credits/:id/transition
  {to, note, granted_usd, expires_at}` (409 `invalid_transition`). Same operator auth as §12.1.
- RPCs: `zerox_credit_programs_upsert(p_rows, p_source, p_actor)`,
  `zerox_credit_program_transition(p_id, p_to, p_actor, p_note, p_granted_usd, p_expires_at)`,
  `zerox_credit_programs_list(p_status)`, `zerox_credit_program_events_list(p_id, p_limit)`,
  `zerox_credit_can_transition(p_from, p_to)`.
- Provider research also proposes offers: each provider it finds becomes `<provider>.free` in
  `discovered` (`T3`, unknown terms) unless an offer with that id exists.

## 13. v1.8 amendments (data-driven catalog, Claude, paid spend caps, 2026-10-25)

Code: `src/catalog-types.js`, `src/list-prices.js`, `src/catalog-guardrails.js`, `src/catalog-db.js`,
`src/catalog-claude.js`, `src/routes/catalog-admin.js`, `neuroncli/admin/models/`,
`src/anthropic-*.js`; migrations `20261025000000_catalog_models.sql`, `20261025000100_catalog_seed.sql`,
`20261025000200_paid_billing_caps.sql`, `20261025000300_plan_features_claude.sql` (down scripts in
`migrations/down/`); checks `check-catalog-db.mjs`, `check-admin-models-page.mjs`,
`check-anthropic-adapter.mjs`, `check-billing-caps.mjs`.

### 13.1 Catalog rows

- Models are rows (`zerox_catalog_models`: `draft | active | disabled`, never deleted) with
  immutable revisions (`zerox_catalog_revisions`, pools in `zerox_catalog_revision_pools`) and an
  append-only audit log (`zerox_catalog_events`; a change made outside the catalog functions is
  logged as `direct`). The seed makes the 16 code models active at revision 1, equal to their code
  specs.
- Code bounds every row: provider types (adapter, base URL, public id prefix, upstream id
  grammar, allowed key slots per tier, hosting flag, spend ceiling) in `src/catalog-types.js`; a
  row names a key slot id (`anthropic.paid` → `ANTHROPIC_API_KEY`), never an env var or a URL.
  A paid pool serves only for a model listed in `LIST_PRICES` (`src/list-prices.js`), at exactly
  that price (cache rates included; effective-dated changes apply on their date), for every
  provider type: a new paid model is a reviewed code change. The `anthropic` entries are Sonnet 5.5
  and Opus 5.5 only, and `ANTHROPIC_MODELS` in `wrangler.toml` names the same two. A free pool on
  the Workers AI binding (key slot `cloudflare.binding`, which bills past the free allowance)
  serves only for a model in `BILLED_FREE_LIMITS` (`src/catalog-types.js`), with rpm, rpd, tpm and
  tpd all set and none above the code ceiling. `MARKUP` (1.25) exists only in `src/pricing.js`.
- Loader (`src/catalog-db.js`): `zerox_catalog_snapshot()` every 45 s per isolate (at once after an
  approval in that isolate). An active row serves its approved revision once it passes the
  guardrails; a failing pool is dropped, a failing model falls back to its code entry. A disabled
  row hides the code entry with its id; a draft changes nothing. Code models without a row serve
  from code. The database failing keeps the last snapshot that loaded, else the code catalog.
  `CATALOG_SOURCE=code` (kill switch) and a gateway without a database serve the code catalog.
  `CATALOG_DB_MODELS` is no longer read. Aliases go to models with a code entry first, then to
  the others in list order; a code model's ids and aliases always name that model (or nothing
  while it is disabled), whatever another row's `position`, and the admin API refuses them as
  another model's alias (`alias_reserved`). The same holds for each of those names behind the
  `openai/` transport prefix (a request for `openai/X` resolves as `X` when no model names
  `openai/X`), and an alias `openai/X` on any row is dropped when `X` names another model. Aliases
  never end in `/` or contain `//`.
- `/v1/models` and routing read the served snapshot; for the code-seeded rows they are identical to
  the code catalog (`fixtures/v1-models-baseline.json`). `GET /v1/models/status` adds
  `catalog_version` (16 hex characters, changes with every approved revision), and the ETag hashes
  it with the availability data, so `/v1/models/stream` emits `catalog.updated` after an approval
  that keeps every model's availability (a price or a display name).

### 13.2 Catalog admin (operator)

- Bearer `GATEWAY_ADMIN_TOKEN` plus Cloudflare Access when configured (as §11.1); actor = Access
  e-mail or `operator`; `Cache-Control: no-store`. Model ids travel in query strings and bodies.
- `GET /admin/catalog/types` (provider types, key slots with `configured` only, list prices, billed
  prices), `GET /admin/catalog/models` (rows with served source, loader reasons, active and pending
  revisions, diff and validation; code models without a row), `GET /admin/catalog/model?id=`
  (revisions and events), `POST /admin/catalog/validate {spec}` (dry run: validation, diff,
  `/v1/models` preview), `POST /admin/catalog/propose {spec, note}` (guardrails first; nothing is
  stored when they fail; 409 `no_change`), `POST /admin/catalog/approve {model_id, revision_id,
  expected_active_revision_id, confirm?, note}` (409 `stale_revision`, 422 `validation_failed`,
  422 `confirmation_required` unless `confirm` = the model id for price, cap-up, key-slot,
  paid-pool, auto-rank or alias changes; answers `catalog_version` and `served_within_seconds: 60`),
  `POST /admin/catalog/reject`, `/disable`, `/enable`, `GET /admin/catalog/audit[?id=]` (one model,
  or the operator feed over offers and models). Specs use USD decimals; unknown fields are errors.
- Page: `https://dashboard.zero-x.live/admin/models` (strict admin CSP, token in memory only).
- Discovery promote (`POST /admin/discovery/candidates/:id/promote`, verified candidates only)
  creates a draft row (source `discovery`) with the provider type's free pool and default limits
  and answers `{promoted: {public_model_id, status: 'draft', revision_id}, admin_url, notes}`; it is
  served only once approved. Candidate rows add `catalog_model_id` and `catalog_status`.
- RPCs (`service_role` only): `zerox_catalog_propose(p_spec, p_actor, p_note, p_detail, p_source,
  p_candidate_id)`, `zerox_catalog_approve(p_model_id, p_revision_id, p_expected_active, p_actor,
  p_note, p_detail)`, `zerox_catalog_reject(p_model_id, p_revision_id, p_actor, p_note)`,
  `zerox_catalog_set_status(p_model_id, p_to, p_actor, p_note)`, `zerox_catalog_snapshot()`,
  `zerox_catalog_list()`, `zerox_catalog_model(p_id)`, `zerox_catalog_events_list(p_id, p_limit,
  p_before)`, `zerox_operator_audit_list(p_limit, p_before)`. Errors: `catalog_model_not_found`,
  `stale_revision`, `invalid_transition: a -> b`, `invalid_catalog: ...`, `candidate_not_verified`,
  `catalog_immutable`, `catalog_unapproved`.

### 13.3 Claude (`anthropic/claude-sonnet-5-5`, `anthropic/claude-opus-5-5`)

- Paid tier only (Pro and Max, billed from credits), offer `anthropic.paid`, key slot
  `anthropic.paid`, `auto_rank` null (`auto` never picks them; aliases `claude-sonnet-5-5`,
  `claude-opus-5-5`). `context_window` 200,000, `max_output_tokens` 32,000; without `max_tokens`
  a request gets `default_max_tokens` 16,000 (thinking counts inside `max_tokens`). Free sees
  them as `upgrade_required`.
- `reasoning_effort`: Sonnet `none | low | medium | high` (`minimal` → `low`; `none` keeps
  thinking off between tool calls), Opus `low | medium | high` (`minimal`, `none` → `low`); absent
  or `default` = `medium`. Thinking summaries stream as `delta.reasoning_content` (non-streaming:
  `message.reasoning_content`), separated from the answer by a blank line.
- Ignored for Claude: `temperature`, `top_p`, `top_k`, `seed`, penalties, `user`. A forced
  `tool_choice` (`required` or a named function) is sent as `auto` with an instruction to call
  the tool, as a last top-level system block (after the client's system and its cache breakpoint,
  never inside the conversation; `response_format: json_object` likewise);
  `parallel_tool_calls: false` is kept.
- A refusal is `finish_reason: content_filter` with a fixed `delta.refusal` / `message.refusal`
  note (no server-side fallback model). `usage` carries `prompt_tokens` = input + cache writes +
  cache reads and `prompt_tokens_details: {cached_tokens, cache_write_tokens,
  cache_write_1h_tokens}`.
- The gateway sends `metadata.user_id` = the first 32 hex digits of SHA-256(`zx-user:` + user id),
  replays Claude's signed thinking blocks per caller for up to 2 h after last use (per isolate,
  `ANTHROPIC_THINKING_REPLAY=false` turns it off) and uses 5-minute prompt caching. Upstream errors:
  429 `rate_limited` (does not count against `ROUTER_MAX_ATTEMPTS`), 529 and 5xx `upstream_error`,
  401/402/403 park the pool (402: the Anthropic account is out of credit).

### 13.4 Billing

- Settled cost = plain prompt tokens × input + cache reads × cache read + cache writes ×
  cache write (5-minute; 1-hour writes at their rate) + completion × output, all at list price ×
  1.25. Prices without cache rates bill cache tokens at the input rate (unchanged for every other
  model). Claude per million tokens, billed: Sonnet 5.5 $2.50 / $12.50, Opus 5.5 $5 / $25, cache
  reads $0.25, cache writes $3.125 (Sonnet) and $6.25 (Opus).
- Credit hold (reservation): every prompt token at max(input, cache write) plus all of the fitted
  `max_tokens` at the output rate; a running request never exceeds its hold.
- A Claude stream that ends before `message_delta` (the client disconnects, or Claude sends an
  error event mid-stream) settles with the usage so far: the input and cache counts of
  `message_start`, each at its own rate, and completion = max(reported output tokens,
  ceil(streamed output bytes / 3.5)). Only without any reported counts does it fall back to the
  byte estimate.
- Paid pools carry a daily spend cap, enforced in Postgres: `p_pool.cpd` = effective cap (upstream
  USD) × 1e6 × 1.25. `zerox_reserve_v2` refuses with `pool_exhausted` (retry at 00:00 UTC) once the
  pool's held plus settled cost for the UTC day would pass it; `zerox_settle_v2` reconciles to the
  settled cost (refunds return the hold, `failed_upstream` keeps its cost). Caps: Claude Sonnet 5.5
  $10, Claude Opus 5.5 $6, Gemini paid $10, Groq and Workers AI paid $5; code maximum $100 a pool
  ($50 for anthropic), lowered further by `PAID_DAILY_SPEND_CAP_USD`. A paid pool without a price or
  cap is never offered. The pool budget name is `cpd` (blurred until midnight on `/v1/models`); when
  only caps refused, `capacity_exhausted` says "<model> has reached today's spending limit on Zero-X.
  It resets at 00:00 UTC; choose another model until then."
- `zerox_reserve_v2` counts `user_rpm` per client request (failover attempts `<id>.<n>` share one).
  `zerox_release_stale_reservations` frees paid holds after 60 minutes, free ones after 15.
  `zerox_admin_overview` pools and keys add `cost_today_microusd`; `GET /admin/overview` pools and
  keys carry it too, and paid pools add `spend_cap_microusd` (the billed daily cap).
- `/api/usage` `by_model` rows and `/api/usage/events` events add `cache_read_tokens` and
  `cache_write_tokens` (part of `prompt_tokens`). `insufficient_credits` explains that held credits
  count as used and to lower `max_tokens`, top up or wait for renewal.

### 13.5 Plans

Tiers, limits, prices and credits are unchanged (section 1). The plan features
(`zerox_plan_policy.features`, `/api/plans`, the site fallback) name Claude Sonnet 5.5 and Claude
Opus 5.5 billed from credits on Pro and Max, and say every plan has the same Neuron features.

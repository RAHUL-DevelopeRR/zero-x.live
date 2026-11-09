# Neuron × Zero-X platform contract

Status: v1.11 (2026-11-06; amendments v1.1 to v1.11 in sections 6 to 19). This document is the source of truth shared by the Neuron CLI
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

| id | name | price | daily_requests | daily_tokens | rpm | concurrency | tiers | monthly credits | window_tokens | window_seconds |
|----|------|-------|----------------|--------------|-----|-------------|-------|-----------------|---------------|----------------|
| free | Free | $0 | 100 | 5,000,000 | 10 | 2 | free | $0 | 3,000,000 | 18,000 |
| athlete | Athlete | $1 / ₹89 per month | 300 | 6,000,000 | 15 | 2 | free, paid | $0.75 | — | — |
| speed | Speed | $5 / ₹449 per month | 1,000 | 8,000,000 | 20 | 3 | free, paid | $4 | — | — |
| pro | Pro | $10 / ₹899 per month | 2,000 | 10,000,000 | 30 | 4 | free, paid | $8 | — | — |
| max | Max | $40 / ₹3,499 per month | 10,000 | 50,000,000 | 60 | 8 | free, paid | $35 | — | — |
| ultrawork | Pro (legacy) | same as pro | | | | | | | | |

**Athlete and Speed** (migration `20261108000000_athlete_speed_plans.sql`, approved by the owner
2026-11-08) are paid plans priced below Pro: same tiers as Pro and Max, sort 12 and 15 (between
Free 10 and Pro 20), public, not highlighted (Pro stays highlighted), the hosted connectors of
Pro. The migration widens the plan CHECK constraints (`zerox_accounts.plan` and `.manual_plan`,
`zerox_plan_policy.plan`, `zerox_subscriptions.plan`) and the plan check of
`zerox_billing_upsert_subscription` and `zerox_billing_record_checkout`; a re-run keeps stored
Razorpay plan ids. Plans rank by `price_usd` (upgrade, downgrade, `zerox_billing_plan_target`).
Until the rows exist the gateway leaves both plans out of `/api/plans` (`ROW_REQUIRED_PLAN_IDS`
in `src/plan-policy.js`; a row with `public = false` hides them too), the pricing page hides their
cards and comparison columns, and checkout answers 409 `plan_unavailable`. Without their Razorpay
plan ids checkout answers 503 `billing_plan_missing`. The Razorpay account has no international
payments, so `scripts/razorpay-bootstrap.mjs --plan athlete,speed --currency INR` creates INR plans
only and their USD ids stay null. Search: Athlete 100 searches and 8 research runs a day, Speed 200
and 15; colony: Athlete 2 workers and 600,000 tokens a run, Speed 3 and 1,000,000.

**Rolling token window** (migration `20261102000000_free_token_window.sql`, 2026-11-02). A plan
with `window_tokens` and `window_seconds` (set together; `—` = none) allows at most
`window_tokens` tokens in any `window_seconds`, per user: Free gets 3,000,000 tokens every 5
hours (1,000,000 until `20261109000000_cache_weighted_limits.sql`). A window counts each reservation from when it was made for `window_seconds`: settled ones
with the tokens they were charged (refunds count 0), running and released ones with what they
reserved. With a window, `daily_tokens` refuses nothing; it is the most the window allows in a
UTC day (five windows, 5,000,000 on Free), kept so clients that show tokens per day stay
well-formed. `daily_requests`, rpm, concurrency and credits apply as before. A refusal is
`user_window_tokens` → 429 `insufficient_quota`, `resets_at` and `Retry-After` = when enough of
the window has expired for that request. The message names the figures: "You've used your
3,000,000 tokens for this 5-hour window; it frees up at HH:MM UTC." once the window is full, else
"This request needs N tokens but only R of your 3,000,000 tokens for this 5-hour window are left;
enough frees up at HH:MM UTC.". A request larger than the whole window never fits: its message
says so and it carries no `resets_at` or `Retry-After`. The window counts every reservation of
the user made after now minus `window_seconds`, with no upper bound, so a reservation committed
by a transaction that began later but locked the account first is counted too. Any plan can opt
in by setting both columns. Sessions without an account ledger (anonymous dev sessions,
owned-provider sessions; session-KV allocation) cannot count a rolling window: a plan with a
window holds them to `window_tokens` per UTC day (`zerox_plan_policies` carries the window
keys).

**Counted tokens** (migration `20261109000000_cache_weighted_limits.sql`, 2026-11-09). Every user
token limit (the rolling window, `daily_tokens`, the session-KV allocation and a family's monthly
allowance) counts a settled attempt as its uncached prompt tokens (cache writes included) plus
ceil(0.1 x cache-read tokens) plus completion tokens: 1,000,000 prompt tokens of which 600,000 are
cache reads, with 8,000 completion tokens, count 468,000. The weight is
`TOKEN_LIMIT_CACHE_READ_WEIGHT` (0 to 1, default 0.1; src/pricing.js `countedTokens`). The gateway
passes it as `zerox_settle_v2` `p_counted_tokens` (only when it differs from prompt + completion),
which is stored on the reservation (`counted_tokens`) for the window. Usage without a cache split
counts prompt + completion as before. Reservations still hold the raw prompt plus up to 1,024
output tokens until they settle. Pool budgets (`zerox_pool_usage`, upstream TPM and TPD caps, the
per-user pool share), usage events and daily rows stay on raw tokens, and credits stay on cost.
`/api/account` `usage_today` and `usage_window` carry `token_split` (`input_tokens` uncached,
`cached_input_tokens`, `output_tokens`) when the database reports it.

Released clients: Neuron CLI alpha.2 shows `/api/account` `usage_today.tokens / limits.daily_tokens`
as "Tokens today" with a 00:00 UTC reset, which for Free reads e.g. "3,000,000 / 5,000,000"
while the window refuses requests. Those fields stay true for the UTC day; clients should show
`usage_window` (and `limits.window_tokens`) when it is not null. `quota.remaining` of `/auth/me`,
`/auth/sync`, sign-in, `/auth/session` and `/auth/usage` is what can be spent now (the window's
remaining tokens for a windowed plan), and `quota.window` / `limits.window_tokens` describe the
window.

Credits are stored in micro-USD (`1 USD = 1_000_000`). Paid-pool usage is billed at the
catalog price (upstream cost × 1.25 markup). Free-pool usage costs 0 credits but counts
toward daily request/token caps (on Free: the daily request cap and the 5-hour token window). Claude Haiku 5.5 is the one free-tier model with a price: a sponsored pool (section 16), also free of credits, with a monthly token allowance per user. Top-up packs: `credits_5` ($5 credit, $5 / ₹449),
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
    { tier: 'free', key_slot: 'gemini.free', key_var: 'GEMINI_API_KEY', limits: { rpm: 5, rpd: 20, tpm: 120000, tpd: 5000000 } },
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
tool-capable model whose context window fits the estimated request; for an agentic request it
leaves out models with a poor tool-call record (section 18.2).

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
  `auto`. `available` is computed for the caller's plan (anonymous = free). Since v1.9 the list
  has one entry per model family, not per route (section 14).
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
| 429 | `insufficient_quota` | insufficient_quota | daily request/token cap reached, or the plan's rolling token window is full (`resets_at` = when enough frees, with `Retry-After`; `upgrade_url`) — clients must NOT retry before `resets_at` |
| 429 | `rate_limited` | rate_limit_error | per-user rpm/concurrency (`retry_after_seconds`) — clients may retry after the delay |
| 503 | `capacity_exhausted` | server_error | shared free pool exhausted (`retry_after_seconds`, `upgrade_url`) |
| 502 | `upstream_error` | server_error | upstream failure after failover; request count refunded |
| 504 | `upstream_timeout` | server_error | no first byte within 45 s or idle > 90 s; a non-streaming completion not ready 90 s after the request |

`upgrade_url` = `https://zero-x.live/pricing` (env `PRICING_URL`).

### 3.4 Account & usage (`/api/*`)

- `GET /api/plans` (public) → `{currency_default:'USD', plans:[{id, name, price:{usd_cents, inr_paise},
  interval:'month', limits:{daily_requests, daily_tokens, window_tokens, window_seconds, rpm, concurrency},
  monthly_credit_usd, tiers, features:[string], highlighted}], topups:[{id, credit_usd,
  price:{usd_cents, inr_paise}}]}`
- `GET /api/account` → `{user:{id,email,name,display_name,initials,image_url},
  session_expires_at, plan:{id,name}, limits:{...},
  usage_today:{requests, tokens, resets_at}, usage_window:null|{tokens, limit_tokens, remaining_tokens,
  window_seconds, resets_at}, credits:{balance_usd, monthly_grant_usd},
  subscription:null|{status, current_period_end, cancel_at_period_end},
  flags:{suspended}, policy?:{connectors:{allowed, denied, required, hosted, allow_unvetted,
  catalog_version}}}` (`display_name`, `initials` and `session_expires_at`: §9.1; `policy`: §18.1,
  left out when the plan has no gateway policy)
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
- `POST /api/billing/checkout {plan:'athlete'|'speed'|'pro'|'max', currency:'INR'|'USD'}` → `{provider:
  'razorpay', key_id, subscription_id, name, description, prefill:{email,name}, notes}`
  (409 `already_subscribed`, 409 `plan_unavailable` for a plan `/api/plans` does not list, 503
  `billing_not_configured`; section 16 adds the billing details
  gate, `consent`, `billing_plan_missing` and the phone in `prefill`)
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

`GET /admin/overview` (Bearer `GATEWAY_ADMIN_TOKEN` plus Cloudflare Access when configured, as
§11.1) → `{users:{total, active_today, by_plan}, revenue:{active_subscriptions,
mrr_usd_estimate}, usage_today:{requests, tokens, cost_usd}, pools:[{model, tier,
requests_today, tokens_today, limits, health, keys?}]}` (`keys`: vault keys, section 8.4)

Every operator API (`/admin/*` and `GET /v1/providers/health`) needs the operator token and, when
`CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` are set, a valid Access JWT on every host the Worker
answers, workers.dev included (`401 invalid_session` without the token, `403 access_required`
without the JWT). `GET /admin/discovery` is a static page shell with no data. The operator
branch of `GET /health` (configuration flags only) stays on the token alone, so the deploy
canary can read it on any host.

### 3.7 Existing endpoints kept

`/health`, `/ready`, `/auth/config`, `/auth/cli/session`, `/auth/session` (GET/DELETE),
`/auth/usage`, `/auth/plan`, `/auth/sync`, `/auth/me`, CLI loopback login
(`/neuroncli/login/?callback_url=http://127.0.0.1:<port>/callback&state=…`).
`/auth/session` additionally returns `expires_at`. Their `quota` gains `window` (null, or
`{limit_tokens, window_seconds, tokens, remaining_tokens, resets_at}`; `tokens` and `resets_at`
are null when the live count is not available) and their `limits` gains `window_tokens` and
`window_seconds` (null without a window); for a windowed plan `quota.remaining` is the window's
remaining tokens (at most the day's).

## 4. Database RPCs (Postgres, `SECURITY INVOKER`, `service_role` only)

All called through `rpc(env, name, args)` / `rpcRows(env, name, args)` in
`src/account-store.js` (PostgREST in production; PGlite when `DATABASE_DRIVER=pglite`).

| RPC | args | returns (row) |
|-----|------|---------------|
| `zerox_reserve_v2` | `p_user_id uuid, p_request_id text, p_model text, p_tier text, p_tokens bigint, p_cost_microusd bigint, p_pool jsonb` (`{rpm,rpd,tpm,tpd,cpd,concurrency}` or null; `cpd` = a paid pool's daily spend cap in billed micro-USD per UTC day, section 13.4; `concurrency` = requests of the pool key running at once, section 8.6), `p_pool_key text = null` (a provider key vault pool's key, 1-300 characters: `p_pool` is then that key's budget, counted in its own buckets; null = the model's default bucket, §11.1) | `{status, reservation_id, plan, remaining_requests, remaining_tokens, credit_balance_microusd, resets_at, retry_after_seconds, window_tokens, window_seconds, window_used_tokens, window_resets_at}` (window columns null without a window; with one, `remaining_tokens` is the window's; `user_window_tokens`: `resets_at` = when enough frees); status ∈ `ok, no_account, suspended, user_window_tokens, upgrade_required, user_daily_requests, user_daily_tokens, user_rpm, user_concurrency, insufficient_credits, pool_exhausted` |
| `zerox_settle_v2` | `p_reservation_id uuid, p_prompt_tokens bigint, p_completion_tokens bigint, p_cost_microusd bigint, p_status text ('ok','error','refunded','failed_upstream'), p_latency_ms int, p_provider text, p_upstream_model text, p_error_code text, p_cache_read_tokens bigint = 0, p_cache_write_tokens bigint = 0` (cache tokens are part of `p_prompt_tokens`, section 13.4) | `{status:'settled'|'already_settled'|'not_found', credit_balance_microusd}`; reconciles the pool bucket stored on the reservation (model, tier, pool key) |
| `zerox_renew_reservation` | `p_reservation_id uuid, p_lease_seconds int` (1-3600) | `boolean`: the lease now runs at least `p_lease_seconds` from now; `false` once the reservation is settled or released (section 8.5) |
| `zerox_release_stale_reservations` | — | `{released}` |
| `zerox_plan_policies_v2` | — | one row per plan: `plan, name, price_usd, price_usd_cents, price_inr_paise, daily_requests, daily_tokens, rpm_limit, concurrency_limit, allowed_tiers text[], monthly_credit_microusd, features, sort, public, highlighted, razorpay_plan_id_inr, razorpay_plan_id_usd, window_tokens, window_seconds, connector_policy jsonb` (null = no connector policy, §14.1) |
| `zerox_account_overview` | `p_user_id` | account + policy + credits + subscription + today usage + `usage_window` (`{window_seconds, limit_tokens, tokens, remaining_tokens, resets_at}` or null) (jsonb columns) |
| `zerox_window_usage` | `p_user_id uuid, p_window_seconds int, p_now timestamptz = now()` | rows `{created_at, tokens}`: the user's reservations in the window and the tokens each counts |
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
  timed out on it within 60 s; one caller's slow prompts cannot park a pool for everyone. Each such
  timeout marks the pool slow for five minutes (until a success clears it): `auto` still offers it,
  after the healthy pools of its tier. Before a stream is committed, failover is bounded by
  `UPSTREAM_FAILOVER_BUDGET_MS` (50 s); an attempt that budget cut is not counted against its pool
  (a stream that got its whole share of it and sent no data event, SSE keep-alives at most, only
  marks the pool slow).
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
  Section 15 (v1.10) adds `unknown` and the field `availability`, in which `blurred` reads
  `unavailable`; `status` keeps these words for the clients that read them (section 15.1).
  - `busy`: a short rate-limit cooldown (60 s or less); keep the model selectable and show the wait.
  - `blurred`: grey the model out until `available_again_at` (quota spent, model gone, provider down).
  - `available` stays the plan/region/configuration verdict; a client greys out a model when
    `available` is false or `status` is `blurred`.
  - Pool health comes from the HealthHub Durable Object (src/health-hub.js): real outcomes from
    every isolate, plus a 30 s alarm that reads provider model lists and status pages and sends a
    one-line test request only to idle pools whose cooldown ended (daily caps: Groq 24, Workers AI
    48 per model; Gemini, NVIDIA and OpenRouter none). Failed checks and every test request log one
    line (check or pool, outcome or status, time). A recovered model returns to `available`. Isolates cache the snapshot for 5 s. Without the binding (the Node server) health
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
- **Review** (`Bearer GATEWAY_ADMIN_TOKEN` plus Cloudflare Access when configured, as §11.1,
  `Cache-Control: no-store`; page `GET /admin/discovery`):
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

### 8.5 Concurrency leases and requests per minute (2026-10-28)

E2E finding (2026-10-27): when Cloudflare killed a Worker isolate mid-stream (`exceededCpu`),
nothing settled the attempt's reservation, so it held one of the user's concurrency slots for
10 minutes while every refusal said `retry_after_seconds: 5`. Migration
`20261028000000_reservation_leases.sql`:

- **Leases.** An active reservation holds a slot until `lease_expires_at`, 90 s after
  `zerox_reserve_v2`. The gateway renews it with `zerox_renew_reservation` every
  `RESERVATION_RENEW_MS` (30 s, clamped to at most a third of the lease) for
  `RESERVATION_LEASE_SECONDS` (90 s) while the attempt runs, and stops before settling. A lease that lapsed (its isolate died) is released by the user's next
  `zerox_reserve_v2`, or by `zerox_release_stale_reservations` 5 minutes after it lapsed (rows
  without a lease: 10 minutes after they were created). A released reservation keeps what it was
  charged, holds no credits any more, and a late settle still reconciles it.
- **`user_concurrency`** answers `retry_after_seconds` = the time until the first lease lapses
  (1-90 s); a settle can free a slot sooner.
- **Retry-After change (clients).** This refusal always said 5 s before. Renewals keep a running
  attempt's lease 60-90 s ahead, so while running streams hold every slot of the user it now says
  60-90 s, also when one of them finishes a second later; only slots held by killed requests give
  shorter waits. A client that sleeps the whole `Retry-After` (the Neuron CLI waits up to 90 s and
  retries at most twice) can wait up to 90 s for a slot that freed sooner, for example when an
  agent and its subagents share the Free plan's 2 slots. Open owner decision: report a short
  retry while the leases are being renewed, or have clients poll.
- **`user_rpm`** counts client requests in the last 60 s, not reservations: failover attempts
  reserve as `<request_id>.<n>`, count as their request, and are never refused for the rate of
  a request that is already counted.
- **Rollback.** Only before `20261029000300_provider_key_budgets.sql`, whose 8-argument
  `zerox_reserve_v2` (and that of `20261029000800_paid_billing_caps.sql`) keeps the leases; the
  script stops while it exists. `migrations/down/20261028000000_reservation_leases.sql`, run by hand with
  `psql -X -v ON_ERROR_STOP=1 -f` (the migration runner never reads `migrations/down/`), restores
  both functions with `CREATE OR REPLACE` and the `(user_id, created_at)` index, drops
  `zerox_renew_reservation` and the column, and removes the history row. Both files set
  `lock_timeout` (5 s) for their transaction.

### 8.6 Per-pool concurrency (2026-10-29)

Some free tiers limit requests in flight instead of (or as well as) requests per minute: Z.ai's
free GLM Flash models serve one request at a time, and answer a second one with HTTP 429 (code
1302). Users' reservations count the limit per model (below). Whether Z.ai counts it per model or
for the whole account is not established, so the health checker treats it as per account (section
15.3). Migration `20261029001000_pool_concurrency.sql`:

- **`p_pool.concurrency`** (`zerox_reserve_v2`): at most that many reservations of the pool key
  may be running at once, across every user. Running means active with a running lease (section
  8.5): a settle frees the slot at once, a request whose isolate died frees it when its lease
  lapses. The count is taken under a transaction advisory lock on the pool key (after its bucket
  rows, which two requests on either side of 00:00 UTC do not share), so two requests cannot both
  take the last slot. Null is unlimited; 0 serves nothing.
- **A full pool** answers `pool_exhausted` with `retry_after_seconds` until its first lease lapses
  (1-60 s). The gateway moves on to its next candidate without calling the upstream, and
  /v1/models shows the model busy until then (budget name `concurrency`).
- **Where the limit comes from.** Reviewed code only: a provider type's `free_concurrency`
  (`src/catalog-types.js`) applies to each free pool of that type, one per model and key. Catalog
  rows cannot set or lift it.
- **Routing.** Such pools are the free tier's last resort (`src/router.js` `lastResort`): `auto`
  tries them after every other free pool, also degraded or spent ones, and never remembers them
  as a conversation's model, so one fallback does not put the next turns on a single slot.
- **Rollback.** `migrations/down/20261029001000_pool_concurrency.sql` (`psql -X -v ON_ERROR_STOP=1
  -f`) restores the `20261029000800` function; such pools then get the upstream's 429s instead.

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
`20261029000000_session_devices.sql` and `20261029000100_push_tokens.sql`.

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
`DELETE /api/push/tokens/:id`. Durable Object binding `RELAY` (class `RelayRoom`), not bound on the
Worker for now (every relay route answers `503 relay_unavailable`). Optional secret
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
  `20261029000300_provider_key_budgets.sql`.
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
migration `20261029000400_oiop_offers.sql`; checks `check-oiop.mjs`, `check-quota-race.mjs`.

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
  cron (at most daily; record `oiop:models-dev:v1` in the Postgres record store
  `gateway_session_store`, or in KV without a database; KV is read only while Postgres has none).
- `GET /v1/models/stream` (same auth as `/v1/models`): `text/event-stream`; `retry: 5000`, then
  `event: catalog.updated` with `id: <status ETag>` and the `/v1/models/status` body at start and
  on every change, `: keepalive` comments every 15 s, closed after 10 minutes; `Last-Event-ID`
  equal to the current ETag suppresses the first event.

### 12.5 Health

- HealthHub snapshot rows add `samples`, `error_rate`, `p50_ms`, `p95_ms` (time to first byte of
  successful real requests, last 50) and `canary:{at, ok, tool_call, first_byte_ms}`.
- Canaries: a healthy free pool with no real traffic for 15 minutes gets one streamed tool call
  (Groq) or one-line request (Workers AI), at most half of `PROBE_DAILY_CAPS` per pool per UTC day
  (Gemini's cap is 0: its free tier allows 20 requests per model a day). `HEALTH_CANARIES=false`
  disables them.
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
`src/anthropic-*.js`; migrations `20261029000600_catalog_models.sql`, `20261029000700_catalog_seed.sql`,
`20261029000800_paid_billing_caps.sql`, `20261029000900_plan_features_claude.sql` (down scripts in
`migrations/down/`); checks `check-catalog-db.mjs`, `check-admin-models-page.mjs`,
`check-anthropic-adapter.mjs`, `check-billing-caps.mjs`.

### 13.1 Catalog rows

- Models are rows (`zerox_catalog_models`: `draft | active | disabled`, never deleted) with
  immutable revisions (`zerox_catalog_revisions`, pools in `zerox_catalog_revision_pools`) and an
  append-only audit log (`zerox_catalog_events`; a change made outside the catalog functions is
  logged as `direct`). The seed makes the 18 code models (Z.ai's two since 2026-10-29) active at
  revision 1, equal to their code specs. Provider type `zai` (2026-10-29): `zai/` ids, base URL
  `https://api.z.ai/api/paas/v4`, free key slot `zai.free` (`GLM_API_KEY`), no paid slot, one
  request at a time per free pool (section 8.6).
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
  replays Claude's signed thinking blocks per caller for up to 2 h after last use (each turn's
  leading thinking blocks, before the turn rebuilt from the client's echo; per isolate,
  `ANTHROPIC_THINKING_REPLAY=false` turns it off; `input_transformations` is logged as counts)
  and uses 5-minute prompt caching. The cache is per isolate: it matches exact bytes, replayed
  thinking included, so a request reads only what its own isolate's earlier requests wrote; the
  first request after a switch to another isolate writes the conversation again from the first
  assistant turn whose records differ. Upstream errors: 429 `rate_limited` (does not count against `ROUTER_MAX_ATTEMPTS`), 529 and 5xx `upstream_error`,
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
  ceil(generated output bytes / 3.5), counting the text, thinking and raw tool-input JSON Claude
  sent, not the serialized OpenAI deltas). Only without any reported counts does it fall back to the
  byte estimate. A Claude attempt that fails after `message_start` before it commits (a
  non-streaming call, which is streamed upstream too, or a stream whose first event is an error)
  is settled from the same counts: `failed_upstream` for an error event or a timeout (the model
  ran, whatever the error kind; the caller is refunded within the daily allowance), `error` for a
  client abort. A Claude attempt that ends before `message_start` (an HTTP error, an error event
  first, a first-byte or response timeout with or without response headers, a client abort) is
  `refunded`, user and pool alike: Claude sends `message_start` before the model runs, so for
  Claude the §7 rule that a timeout is `failed_upstream` from the prompt estimate does not apply.
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
  A paid reservation whose lease lapsed (section 8.5) frees its concurrency slot but keeps its
  credits held: the caller's next reservation releases lapsed free leases only, and
  `zerox_release_stale_reservations` frees an abandoned paid reservation 5 minutes after its lease
  lapsed and not before it is 60 minutes old (free ones 5 minutes after their lease lapsed). A
  running request renews its lease and is never released.
  `zerox_admin_overview` pools and keys add `cost_today_microusd`; `GET /admin/overview` pools and
  keys carry it too, and paid pools add `spend_cap_microusd` (the billed daily cap).
- `/api/usage` `by_model` rows and `/api/usage/events` events add `cache_read_tokens` and
  `cache_write_tokens` (part of `prompt_tokens`). `insufficient_credits` explains that held credits
  count as used and to lower `max_tokens`, top up or wait for renewal.

### 13.5 Plans

Tiers, limits, prices and credits are unchanged (section 1). The plan features
(`zerox_plan_policy.features`, `/api/plans`, the site fallback) name Claude Sonnet 5.5 and Claude
Opus 5.5 billed from credits on Pro and Max, and say every plan has the same Neuron features.

## 14. v1.9 amendments (model families, usable context, 2026-11-04)

Code: `src/model-families.js` (identity), `src/catalog.js` (`familyModels`, `withIdentity`,
`isFamilyId`, `familyMembers`), `src/router.js` (family routing), `src/routes/plans.js`
(`/v1/models`, `/v1/models/status`, `/v1/models/stream`); checks `check-routing-v2.mjs`,
`check-health-share.mjs`, `check-e2e-local.mjs`.

A catalog entry is a route: one model behind one provider type (`groq/openai/gpt-oss-120b` is
GPT-OSS 120B served by Groq). Several routes can serve the same model. The public list names the
model and the company that made it, never the route or the provider that serves it.

### 14.1 Model identity

Every route has an identity derived from its `upstream_model` (database rows included):

- `maker`: slug of the company that made the model: `openai`, `anthropic`, `google`, `meta`,
  `alibaba` (Qwen), `nvidia`, `stepfun`, `cohere`, `zhipu` (Z.ai, GLM), `minimax`, `deepseek`,
  `moonshot`, `mistral`, `xai`, `microsoft`, `ibm`, `poolside`, `thinkingmachines`, or `other`.
  Clients pick the logo by this slug. `maker_name` is its display name (`OpenAI`, `Z.ai`, ...).
- `model_name`: the clean name without a route or provider suffix (`GPT-OSS 120B`, `Qwen 3.8 27B`,
  `Nemotron 3 Ultra 550B`, `North Mini Code`, `GLM-4.7 Flash`, `Claude Sonnet 5.5`).
- `family`: the model id without the route (`openai/gpt-oss-120b`, `qwen/qwen3.8-27b`,
  `nvidia/nemotron-3-ultra-550b`, `cohere/north-mini-code`, `zhipu/glm-4.7-flash`,
  `anthropic/claude-sonnet-5-5`). Quantized or provider-specific variants share the family of the
  model they serve (`@cf/meta/llama-3.3-70b-instruct-fp8-fast` is `meta/llama-3.3-70b`).

### 14.2 Context windows

- `context_window` (and `context_length`) is the window the caller can actually use on its plan:
  the largest prompt plus output any pool the caller can use takes, after per-minute token
  budgets. Groq's free org takes about 8K tokens per minute, so a Free caller sees 8,000 for a
  Groq-only model whose own window is 131,072.
- `native_context_window` is the model's own window.

### 14.3 `GET /v1/models`

- `data[]` has `auto` first, then one entry per family, in catalog order of its first route.
  A family entry has every field of section 3.2, 8.1 and 12.4 plus `maker`, `maker_name`,
  `model_name` and `family`, rolled up from the routes the caller can use (all routes when none
  can):
  - `id` = `family`; `display_name` = `model_name`; `owned_by` = `maker`;
    `provider` = `{id: maker, name: maker_name, logo_url: null, logo_fallback_url: null}`.
  - `context_window` (and `context_length`): the largest window of those routes that can serve
    now, that is, routes not `busy` or `blurred` (when every route is, the routes with the best
    status). The router skips routes a request does not fit, so a busy route never advertises a
    window the healthy ones cannot serve: GPT-OSS 20B with NVIDIA busy shows Groq free's 8,000,
    not 131,072. `max_output_tokens`: the largest of the same routes, at most `context_window`.
    `native_context_window`: the largest of all those routes (the model's own window does not
    change with health).
  - `capabilities`: a capability any of those routes has; `tiers`, `reasoning_efforts`: the union.
  - `available`: true when any route is usable; otherwise `unavailable_reason` is the first of
    `upgrade_required`, `region_unavailable`, `policy_restricted`, `not_configured` that a route
    reports.
  - `status`: the best route status (`available` > `degraded` > `busy` > `blurred`), with that
    route's `available_again_at` (the earliest among equals); `checked_at`: the newest observation.
    One busy route therefore does not grey out a model another route still serves. Section 15
    (v1.10) adds `unknown` and `availability` (where `blurred` reads `unavailable`; `status` keeps
    `blurred`, section 15.1) and takes `checked_at` from the
    best route.
  - `pricing`: the highest-priced usable route (credits are never under-held).
  - Nothing names a serving provider. `offers`: the data-policy fields of those routes' offers
    (section 12.4: `{tier, owner, trust_tier, trains_on_inputs}`, duplicates removed) without the
    offer `id`, which names the provider (`groq.free`). `models_dev_id` is `null` (models.dev ids
    are provider-qualified, `groq/openai/gpt-oss-120b`), and so is `facts.models_dev_id`. Route
    ids, offer ids and models.dev ids stay on `?routes=1`.
- `auto` carries `maker: 'zero-x'`, `maker_name: 'Zero-X'`, `family: 'auto'`, `model_name: 'Auto'`.
- `?routes=1` (also `true`, `yes`) lists the routes instead, for diagnostics: one entry per route
  with its route id, provider and display name, plus `maker`, `maker_name`, `family` and
  `model_name`. BYOK sessions (own OpenRouter key) list their own models as before.

### 14.4 `GET /v1/models/status` and `/v1/models/stream`

Rows follow the same view as `/v1/models` (families, or routes with `?routes=1`) and add the fields
a live list needs, so a page can draw it from this endpoint alone:
`{id, family, maker, display_name, context_window, native_context_window, available,
unavailable_reason, status, availability, available_again_at, checked_at, stale_after_seconds}`
(`availability` and the per-row `stale_after_seconds`: sections 15.1 and 15.2). `checked_at` is left out of the ETag
(it moves with every observation), so `If-None-Match` still answers `304` while nothing else
changed. The website's model list polls this endpoint every `poll_interval_seconds`.

### 14.5 Routing

- `model` in `/v1/chat/completions` may be a family id. Lookup order: route
  id, then family id, then alias; all case-insensitive, with the optional `openai/` transport
  prefix. Route ids keep working and keep their route (old clients).
- An alias equal to the leaf of its route's family names the model, not that route:
  `gpt-oss-20b`, `gpt-oss-120b`, `qwen3.8-27b`, `gemini-2.5-flash`, `glm-4.7-flash` and
  `llama-3.3-70b` resolve to their families (`openai/gpt-oss-20b`, ...). This matters because the
  `openai/` transport prefix and the `openai/` family prefix look alike: Neuron strips `openai/`
  (and `xai/`) before sending, so the listed family `openai/gpt-oss-20b` arrives as
  `gpt-oss-20b`, and must fall back from a rate-limited or too-small Groq route to NVIDIA like the
  family id does. A bare name that is no route, family or alias resolves to the family
  `openai/<name>` or `xai/<name>` when one exists. Provider-qualified aliases
  (`workers-ai/gpt-oss-120b`, `openrouter/cohere/north-mini-code:free`) keep their route.
- A family id is served by every offered route of the family that has the capabilities the
  request needs (routes that can force a tool call first when the request forces one), ranked by
  `auto_rank` (routes `auto` never picks after the others, then catalog order). The usual order
  then applies: free pools before paid, last-resort pools after the others, the conversation's
  previous route first, healthier pools first. A route the request does not fit, or that is
  rate-limited or down, is skipped; when none is left the error is the same as for a route id
  (`capacity_exhausted`, `context_length_exceeded`, `upgrade_required`, ...). An unknown or
  unserved family answers `model_not_found`.
- Family requests are sticky per conversation like `auto` (the route that served it keeps its
  prompt cache).
- `x-neuron-model` and the completion's `model` name the route that served the request, as for
  `auto`.
- A family whose id is also its only route id (Claude) is that route.

### 14.6 Clients

Neuron's TUI already strips route suffixes from display names client-side; with `maker` and
`family` it can show the maker's logo, list one row per model and send the family id, so a request
follows the healthiest route instead of failing on one busy provider. Clients that send route ids
are unaffected.

## 15. v1.10 amendments (active health checks, 2026-11-04)

The 2026-11-04 status said MiniMax M3.1 Flash and both GLM Flash models were available while
OpenRouter had delisted MiniMax and GLM refused requests while its one free slot was busy: on the
Node gateway a status came only from real requests that failed on that instance, and a model
nobody had used counted as available.

### 15.1 Statuses

Every model on `/v1/models`, `/v1/models/status` and `/v1/models/stream` carries two fields with
the same verdict:

- **`availability`** (added 2026-11-05): the statuses below, in these words. The website and
  clients written for this section read it.
- **`status`**: the same verdict in the words of section 8.1 (v1.3), which Neuron
  7.0.0-alpha.4 and every Neuron release so far read: it greys a model out (and warns on
  `/model` and `--model`) only when `status` is `blurred`, and treats every other word as usable.
  So `unavailable` is sent as `blurred` here, with the same `available_again_at`; `available`,
  `degraded`, `busy` and `unknown` are sent as they are (a v1.3 client shows `unknown` like
  `available`, which is what `unknown` means: selectable, tried by routing). A client reads
  `availability` when present and falls back to `status`, reading `blurred` as `unavailable`.
  `status` keeps the v1.3 words for as long as releases that read only it are supported.

The statuses (`availability`):

- `available`: the newest observation (a test request or real traffic) says it answers. A model
  list only shows the model is still offered; it never renews a verdict.
- `degraded`: it answers, but slowly (a 3-token test answer over 8 s), after a first 5xx or
  timeout, without calling tools any more, or users' requests failed upstream more recently than
  one succeeded.
- `busy`: a one-at-a-time slot or a rate limit is in use; `available_again_at` says when it frees.
  Keep the model selectable and show the wait.
- `unknown`: no observation within the route's `stale_after_seconds` (section 15.2). Never
  reported as `available`. Selectable; routing still tries it after the known-good routes.
- `unavailable` (`status`: `blurred`): failing (two failures in a row, or three users' upstream failures
  in ten minutes with no success), delisted by its provider, its key rejected or its quota spent; grey it out until `available_again_at` when there is one.

A family (section 18.3) takes the best status of the routes the caller can use, in the order
`available` > `degraded` > `unknown` > `busy` > `unavailable` (a busy route is skipped by routing,
an unknown one is tried), and that route's `available_again_at`, `checked_at`, `latency_ms`,
`last_success_at` and `last_failure_class`. `auto` takes its best candidate's.

### 15.2 Fields

Every model on `/v1/models` and every row of `/v1/models/status` (and its stream) adds:

- `checked_at`: when the verdict in `status` was last confirmed by a test request, real traffic or
  a slot or rate limit in use (null: never); a model list never moves it, and an observation from
  users' traffic carries the time of their request. Per model, not the newest observation of any
  of its routes.
- `latency_ms`: the latency of the last test request (or real attempt on this instance), or null.
- `last_success_at`: the last successful test request or user request, or null.
- `last_failure_class`: the class of the last failure, or null: `rate_limited`, `quota`,
  `delisted`, `model_unavailable`, `auth`, `server`, `timeout`, `slow`, `tool_call`,
  `upstream_errors` (users' requests failed upstream) or `probe_misconfigured` (the provider
  refused the checker's own test request with a 400: the request needs fixing, and no verdict was
  recorded from it). Never a provider name or message.
- `stale_after_seconds`: how long the verdict in `availability` stands without a new observation
  before the model reads `unknown`. Per route on the Node gateway while its checker runs: the
  larger of `HEALTH_STALE_SECONDS` (1,200 by default) and 1.5 times the route's own chat test
  interval (section 15.3), rounded up to the second, so a verdict outlives the next scheduled test
  with room for a late or skipped turn: Groq free (hourly) 5,400 s, paid pools and Claude (every
  30 min) 2,700 s, NVIDIA and Z.ai free (every 15 min) 1,350 s, OpenRouter free (every 8 h)
  43,200 s, Gemini free (daily) 129,600 s. Without the checker (the Worker, `HEALTH_PROBES=off`)
  every route uses `HEALTH_STALE_SECONDS`. A family and `auto` take the horizon of the route whose
  verdict they show.

`/v1/models/status` also sends `stale_after_seconds` at the top level: `HEALTH_STALE_SECONDS`, the
floor of every row's horizon (pages written before the per-row field read it). A page applies each
row's own horizon between polls (`checked_at` + `stale_after_seconds` in the past, and no timed
state running until a later `available_again_at`: show it as not checked), and shows every row as
not checked once the gateway has not answered for two poll intervals. `checked_at`, `latency_ms`
and `last_success_at` stay out of the ETag, so `If-None-Match` answers `304` while the verdicts
are unchanged.

### 15.3 The checker

On the Node gateway every instance runs `src/health-probes.js`; only the holder of the
`health_probes` lease in Postgres (`zerox_health_lease`, 90 s, renewed every 15 s) checks model
lists every 10 minutes, one-at-a-time slots every tick (from Postgres, without a request) and sends
test requests on a schedule sized to each pool's free quota (GATEWAY_SETUP.md, "Active model health
checks"): 3 output tokens for a chat test, 160 for a tool-call test. `zerox_probe_take` counts each
test request in the pool's shared budget (`zerox_pool_usage`), refuses it while users are busy on
the pool, and reports users' outcomes of the last ten minutes, which count as observations (read
for every pool once a minute; an upstream failure newer than any success brings the next test
forward). On a one-at-a-time pool a test request holds the slot until it ends.

- **Z.ai's free slot is one per account for the checker.** Users' reservations count the
  one-request limit per model (section 8.6), but whether Z.ai's limit spans the account is not
  established. A test request on a Z.ai free model is sent only while no request (a user's or a
  test) runs on any Z.ai free model of the same key; while it runs it holds the slot of every one
  of them (`zerox_probe_take` with `p_take` on each; each hold counts one request in that model's
  buckets, which have no budget), and it ends within 15 s (`HEALTH_PROBE_TIMEOUT_SECONDS`, capped
  at 15 s and at 5 s under `POOL_SLOT_WAIT_MS`), with a slot lease of that plus 5 s. A user
  request that arrives meanwhile, on either model, waits for the slot as for another user's
  (`POOL_SLOT_WAIT_MS`, 20 s) and never reaches Z.ai beside a test request.
- **Claude.** Neither 5.5 model accepts `thinking: {type: 'disabled'}` or `budget_tokens`, and a
  forced `tool_choice` is a 400. A test request uses the model's lowest setting: Sonnet 5.5
  `{type: 'between_tools'}` at effort `low` (thinking off, 3 output tokens for the chat test, 160
  for the tool call); Opus 5.5 adaptive thinking at effort `low` (thinking cannot be turned off and
  counts toward `max_tokens`, so 64 tokens for the chat test and 512 for the tool call). Tool calls
  use `tool_choice: 'auto'`.
- **A plain 400 to a test request** (kind `invalid` or `context`, see below) says the request needs fixing, not that the model is down: it is
  logged once per pool (until a test request passes again), recorded as `probe_misconfigured`, and
  changes no verdict. Verdicts
are stored in `zerox_pool_health` and read by every instance; the freshest of a verdict and this
instance's own attempts wins, so a real failure flips a model at once. Routing on the Node gateway
skips pools the verdicts mark busy or unavailable until their time ends, judging staleness per
route as above. `HEALTH_PROBES=off` turns the checker off. The Worker keeps its HealthHub (section
8.1) with the same statuses and the `HEALTH_STALE_SECONDS` horizon. One checker probes a pool in
production: while the Worker forwards chat to the Node gateway (`EC2_PROXY_PREFIXES` covers
`/v1/chat/completions`), the HealthHub sends no test requests or canaries and keeps its free list,
key and status-page checks and the isolates' reports; when the forward is removed (the rollback),
its test requests resume at the next alarm. `HEALTH_HUB_PROBES` (`on`, `off`, default `auto`)
overrides that; `auto` cannot see whether the Node checker runs, so it must be set to `on` while
that checker is off. The operator's `/health` adds `health_checker`: on Node
`{ node_probes: "running" }`, or `node_probes` `off`, `no_database`, `migration_missing` or
`not_started` with a `warning`; on the Worker `{ hub_test_requests, chat_routed_to_node }` (booleans).

A probe's 400 is classified like a user's request (`classifyUpstreamFailure`): only a plain request rejection (`invalid`
or `context`) is `probe_misconfigured`. A 400 the classifier names more precisely keeps its verdict:
`model_decommissioned` or `model_not_found` is `model_unavailable`, Gemini `API_KEY_INVALID` or
`FAILED_PRECONDITION` is `auth` (both unavailable at once), and Groq `tool_use_failed` is the
model's own error (no verdict, not a misconfigured test).

### 15.4 RPCs (migration 20261104000000_health_probes.sql, service_role only)

| Function | Arguments → result |
|---|---|
| `zerox_health_lease` | `(p_holder text, p_ttl_seconds int)` → `{leader, holder, expires_at}`. Takes or renews the lease; `p_ttl_seconds = 0` releases it. |
| `zerox_probe_take` | `(p_model, p_tier, p_pool_key, p_pool jsonb, p_tokens, p_cost_microusd, p_take boolean, p_lease_seconds int = 60)` → `{status: ok \| pool_full \| pool_exhausted \| pool_busy, retry_after_seconds, running, minute_requests, minute_tokens, day_requests, recent_ok, recent_failed, last_ok_at, last_failed_at, slot_id}`. `p_take` counts the request when `ok`; on a pool with a concurrency limit it also holds a slot for `p_lease_seconds` (5-300), `slot_id`. `recent_failed` counts users' attempts whose error code is `model_unavailable`, `upstream_error`, `upstream_timeout` or `upstream_auth`. |
| `zerox_probe_release` | `(p_slot_id uuid)` → true when the test request's slot was still held and is now free. |
| `zerox_pool_health_put` | `(p_rows jsonb)` → rows written (at most 500; rows not written for 7 days are deleted). A row carries `verdict_at` (the last request-level verdict), `checked_at` (when the state in `status` was observed) and `listed_at` (the last model list that showed it). |
| `zerox_pool_health_get` | `(p_since_seconds int)` → the rows written within that time. |

## 16. v1.11 amendments (billing details, 2026-11-03)

Migration `20261106000100_billing_details.sql`; code `src/billing/profile.js`,
`src/billing/legal-versions.js`, `src/routes/billing-profile.js`; browser `billing-details.js`.

### 16.1 Profile (`GET`/`PUT /api/billing/profile`, interactive credentials only)

What a buyer gives Zero-X before Razorpay opens. Card, UPI and bank details are never collected
here (they go into Razorpay's own window). The 2026-11-03 version had no tax id field because
Zero-X is not registered for GST; 16.6 adds an optional one (`tax_id`), kept for the buyer's own
records only.

- `GET` → `{profile: null | {customer_type: 'individual'|'business', full_name, business_name,
  country (ISO 3166-1 alpha-2), state, city, postal_code, address_line1, address_line2, phone
  (E.164), tax_id (16.6)}, complete, missing: [field…], documents: {terms|privacy|refund|auto_renewal: {version:
  'YYYY-MM-DD', path}}, accepted: {document: {version, accepted_at, current}}, tax:
  {no_gst_notice}, options: {countries: [{code, name}] (India first), states: {IN: [{code,
  name}]}, no_postal: [country…]}}`. `tax.no_gst_notice` is `BILLING_NO_GST_NOTICE=true`
  (default off): the owner turns it on only once it is confirmed that no GST is charged; the
  browser then shows "No GST charged" in the order summary, and the order summary says nothing
  about GST before. (The tax id field's label and note, 16.6, are shown either way.)
- `PUT {customer_type?, full_name, business_name?, country, state?, city, postal_code?,
  address_line1?, address_line2?, tax_id?, phone?}` replaces the profile (absent optional fields are
  cleared) → `{profile, complete: true, missing: []}`. Required: `full_name`, `country`, `city`,
  `state` (a state or union territory of India, by code or name), `postal_code` (not in countries
  without postal codes; per-country shape for common countries), and for `business`:
  `business_name` and `address_line1`. The street address is optional for an individual. Unknown
  fields are refused. A refusal is 400 `invalid_request` with `param` (the first field in form
  order) and `fields` (`{field: message}`).

### 16.2 Checkout gate

`POST /api/billing/checkout` and `/topup` accept `consent: {document: version}` (the versions the
buyer was shown) and refuse, before anything is created at Razorpay:

- 409 `billing_profile_required` `{missing}`: no saved profile, or one that no longer meets the
  rules;
- 409 `consent_required` `{missing, documents}`: for each document the purchase needs (a
  subscription: terms, privacy, auto_renewal, refund; a top-up: terms, privacy, refund) the current
  version must be in `consent`, or, for terms, privacy and refund only, already agreed to at the
  current version (`accepted`). `auto_renewal` is about this purchase and is always required in the
  request. Versions are in `src/billing/legal-versions.js` and equal the "Effective date" of
  `terms.html`, `privacy.html` and `refund.html` (a test fails otherwise).

The agreements made in the request are appended to `zerox_billing_consents` (document, version,
context, accepted_at; append-only) when a payable subscription or order is handed out. Razorpay
Checkout is prefilled with `{email, name (at most 50 characters), contact?}` only; Razorpay `notes`
stay `{user_id, plan}` / `{user_id, pack}` (they are copied back into `zerox_payments.raw`), and no
address, state, business name or tax id is sent to Razorpay at all.

### 16.3 Errors and health

- 503 `billing_plan_missing`: the keys are set but the plan's Razorpay plan id for that currency is
  not stored (`zerox_plan_policy.razorpay_plan_id_inr` / `_usd`); distinct from
  `billing_not_configured` (keys missing). The gateway logs `Razorpay plan id missing` with the plan
  and currency.
- Operator `GET /health` adds `plans_configured: {inr, usd, missing: ['pro:USD', …]} | null`
  (every paid plan has an id for the currency; `null` when the catalogue cannot be read).

### 16.4 First month's credits

`POST /api/billing/verify` grants the plan's monthly credits when the first payment of a
subscription is `captured` (ledger `ref` = the Razorpay payment id, reason `subscription_<plan>`),
instead of waiting for `subscription.charged`. The webhook for the same payment, and a second
verify, grant nothing more (`zerox_credit_grant` is idempotent on `ref`); an `authorized` payment
is granted by the webhook once captured.

### 16.5 RPCs

`zerox_billing_profile_get(user)`, `zerox_billing_profile_upsert(user, jsonb)` (both return
`tax_id` since 20261106000200, 16.6), `zerox_billing_record_consents(user, context, jsonb)`,
`zerox_billing_consents_latest(user)`.
Profiles and consents are deleted with their account (`ON DELETE CASCADE`), like the payment
records (which means deleting an account also deletes its payment records; see the open items in
the release notes).

### 16.6 Optional tax id (2026-11-04)

Migration `20261106000200_billing_tax_id.sql` (down script in `migrations/down/`); owner decision
of 2026-11-04. Zero-X is still not registered for GST: the tax id is kept with the buyer's billing
details for Zero-X's billing records only (the purpose the privacy policy gives). No GST is charged
and no GST invoice is issued, and the tax id is never sent to Razorpay (not in the prefill, not in
`notes`, which hold only ids), so it is not on Razorpay's receipt either.

- `profile.tax_id`: `null` or the stored value. `PUT` accepts an optional `tax_id` for individuals
  and businesses alike; absent, `null` or blank clears it (the `PUT` replaces the profile). The
  gateway leaves the key out of the RPC call when there is none, so a profile without one still
  saves on a database without this migration.
- Normalised: control and invisible characters dropped, spaces removed, upper case. What is typed
  may be at most 40 characters ("GSTIN or tax ID must be at most 40 characters.").
- `country` `IN`: a GSTIN. 15 characters ("A GSTIN has 15 letters and digits."), the shape
  `^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$` ("Enter a valid GSTIN: a 2 digit state code,
  the 10 character PAN, then 3 more characters."), the GSTN's mod-36 check character as the 15th
  ("This GSTIN's last character does not match the rest. Check it for a typo."), and, when the
  state is one from the list, its first two digits equal that state's GST state code
  (`GST_STATE_CODES` in `src/billing/profile.js`; Dadra and Nagar Haveli and Daman and Diu accepts
  26 and the pre-2020 25): "This GSTIN starts with 29, but the GST state code of Tamil Nadu is 33.
  Check the GSTIN or the state."
- Any other country: a VAT or tax id of 2 to 20 letters, digits or hyphens that starts and ends with
  a letter or digit ("Enter a VAT or tax ID of 2 to 20 letters, digits or hyphens.").
- A refusal is the usual 400 `invalid_request` with `param: 'tax_id'` and `fields.tax_id`. A stored
  tax id that fails today's rule makes the profile incomplete (`missing: ['tax_id']`, 409
  `billing_profile_required` at checkout).
- The database CHECK `zerox_billing_profiles_tax_id_check` is the last line: 2 to 20 characters of
  `[A-Z0-9-]` (no leading or trailing hyphen) and, for `IN`, the GSTIN shape; it does not repeat
  the check character or the state match.
- Browser (`billing-details.js`): an optional field labelled "GSTIN (optional)" in India and "VAT or
  tax ID (optional)" elsewhere, full width after the address lines, with the note "Optional. Zero-X
  keeps it with your billing details for its billing records; it is not sent to Razorpay and does
  not appear on Razorpay's receipt. Zero-X is not registered for GST, so no GST is charged and no
  GST invoice is issued." The input has `autocapitalize="characters"`, `autocorrect="off"` and
  `spellcheck="false"`, and the error summary names it with the same country-specific label. The
  browser checks the same rule with the same messages before saving (`check-billing-profile.mjs`
  compares the two for every country, customer type and Indian state).
- The privacy policy names the optional GSTIN or tax ID; its version (`legal-versions.js`) is
  `2026-11-04`, so every buyer agrees to it again at their next checkout.
## 17. v1.11 amendments (web search and colony budgets, 2026-11-05)

### 17.1 `POST /v1/search`

`Authorization: Bearer <ses_ session, nzx_ key or website token>`; JSON body (at most 8 KB):

| field | type | |
|---|---|---|
| `query` | string, 1-400 characters after trimming | required |
| `count` | integer 1-10 | default 8 |
| `purpose` | `"search"` or `"research"` | default `"search"` |
| `freshness` | `"day"`, `"week"`, `"month"` or `"year"` | optional |

A search with `purpose: "research"` must send `x-neuron-research-run: <run id>` (8-128 of
`A-Z a-z 0-9 . _ : -`); the header is ignored on plain searches.

`200`: `{"results": [{"title", "url", "snippet", "published"?}], "provider": "searxng" | "brave",
"cached": bool, "quota": {"remaining", "limit", "resets_at", "research": {"remaining", "limit"}}}`.
`quota` counts searches per UTC day (`resets_at` is the next 00:00 UTC); `research` is additive.
`published` is an ISO 8601 time when the backend gives one. Results are http(s) URLs only,
de-duplicated, with HTML removed from titles (300 characters) and snippets (600).

Errors are flat JSON, `{"error": code, "message", "request_id", ...}`:

- `400 invalid_request` with `param` (`query`, `count`, `purpose`, `freshness` or
  `x-neuron-research-run`);
- `401 invalid_session`: sign in again;
- `403 account_suspended`;
- `429 search_quota_exhausted` with `resets_at`, `exhausted` (`"searches"` or `"research_runs"`)
  and `Retry-After` (`quota` appears only in a `200`, always as the object above);
- `503 search_unavailable`: no backend configured (the default until the operator sets
  `SEARXNG_URL` or `BRAVE_API_KEY`), every backend failed, or the quota database (migration
  `20261106000500_search_quota.sql`) is missing or down. Search is never served unmetered.

**Backends.** A self-hosted SearXNG (`SEARXNG_URL`, its JSON API: `categories=general`,
`safesearch=1`, `time_range` from `freshness`) is asked first; the Brave Search API
(`BRAVE_API_KEY`, `freshness` as `pd`/`pw`/`pm`/`py`) is the fallback when SearXNG fails,
times out (8 s), answers non-JSON or answers no results. An empty answer from every backend is a
`200` with `results: []`.

**Cache.** Answers are cached in the gateway's memory (per Node process or Worker isolate) for 10
minutes, keyed by sha256 of the user id, `freshness` and the normalized query (NFKC, lower case,
single spaces), at most 1000 entries. The cache is per user, so `"cached": true` (or a faster
answer) only ever reflects the caller's own earlier search, never another user's. Empty answers
are not cached. A cached answer says `"cached": true` and still counts as a search.

**Quotas** (per UTC day, enforced in Postgres by `zerox_search_reserve` before any backend call):

| plan | searches | research runs |
|---|---|---|
| Free | 40 | 3 |
| Athlete | 100 | 8 |
| Speed | 200 | 15 |
| Pro | 400 | 30 |
| Max | 2000 | 150 |

A research run is a distinct `x-neuron-research-run` id of the day: the first search of a new run
takes one research run (and one search); later searches of that run take one search each. A run
opened today keeps working after the research runs are used up. A search no backend answered is
given back (`zerox_search_settle` with `failed`), with the run it opened.

**Metering is metadata only.** `zerox_search_usage` keeps per-user daily counters (`searches`,
`research_runs`, `cache_hits`, `searxng_calls`, `brave_calls`) and `zerox_search_research_runs`
the sha256 of today's run ids. No query text, result or raw run id is stored or logged; the query
leaves the gateway only to the backend, and the in-memory cache forgets it after 10 minutes. A
user's run hashes from earlier days and counters older than 92 days are deleted by their next
search.

**Runtimes.** Both the Worker and the Node server serve the route; with `EC2_PROXY_PREFIXES`
covering `/v1/`, the Worker forwards it to the VM like the other `/v1` routes.

### 17.2 `GET /api/account` limits

`limits` gains two objects, from the plan (static, src/search.js):

- `search`: `{"daily_searches", "daily_research_runs"}`: Free 40/3, Pro 400/30, Max 2000/150;
- `colony`: `{"max_workers", "max_tokens_per_run"}` for Neuron's multi-agent mode, enforced by the
  CLI: Free 1 / 300,000, Pro 4 / 2,000,000, Max 8 / 6,000,000.

### 17.3 RPCs

- `zerox_search_reserve(p_user_id uuid, p_daily_searches int, p_daily_research_runs int,
  p_run_hash text DEFAULT NULL)` → `(status, day, searches, research_runs, run_added, resets_at)`;
  `status` is `ok`, `search_quota_exhausted` or `research_quota_exhausted` (nothing taken).
- `zerox_search_settle(p_user_id uuid, p_day date, p_outcome text, p_run_hash text DEFAULT NULL,
  p_run_added boolean DEFAULT false)` → `(searches, research_runs)`; `p_outcome` is `searxng`,
  `brave`, `cached` or `failed` (gives the search, and the run when `p_run_added`, back).

## 18. v1.11 amendments (connectors, agentic routing, prompt cache key, 2026-11-03)

The neuron-v2 copy (`docs/GATEWAY_CONTRACT.md`) records the same changes as its v1.3 amendment;
the CLI and the gateway implement exactly what follows. Code: `src/connector-policy.js`,
`src/routes/account.js` (18.1), `src/router.js` and `src/catalog.js` `POOR_TOOL_CALLERS` (18.2),
`src/chat-handler.js` and `src/providers.js` `PROVIDER_PARAMS` (18.2, 18.3); migration
`20261106000300_connector_policy.sql` (down script in `migrations/down/`); checks
`check-account-api.mjs`, `check-business-db.mjs`, `check-routing-v2.mjs`.

### 18.1 Connector policy (`GET /api/account` `policy.connectors`)

Connectors are MCP servers. There are no organisations yet, so gateway policy is per plan
(`zerox_plan_policy.connector_policy jsonb`); machine policy is the CLI's `managed-settings.json`.

```json
"policy": {"connectors": {"allowed": ["catalog:*"], "denied": [], "required": [],
  "hosted": [], "allow_unvetted": true, "catalog_version": "2026-11-03"}}
```

- `allowed`: connector catalog ids, or `"catalog:*"` for every entry of the catalog. `denied`: ids
  the CLI must not start; deny wins over `allowed`, `required` and `hosted`. `required`: ids the
  CLI starts with managed scope (also in one-shot runs) and the user cannot disable. `hosted`: ids
  the plan may use through the hosted endpoint (section 18.4). `allow_unvetted`: whether servers
  that are not in the catalog may run. `catalog_version`: the catalog version the ids were written
  against.
- A missing `policy` block (or `policy` without `connectors`) means no gateway policy: the CLI
  applies its managed and user settings only. The gateway leaves it out when the plan's column is
  null or not a JSON object, and against a database without the migration.
- The gateway validates the stored value: ids are `^[a-z0-9][a-z0-9._-]{0,63}$` (others are
  dropped), lists are de-duplicated and capped at 100, a denied id is removed from `required` and
  `hosted`, a missing `allowed` is `["catalog:*"]`, a missing `allow_unvetted` is `true`, and a
  missing or malformed `catalog_version` is the gateway's (`2026-11-03`). A policy only restricts
  what it says.
- `hosted` is reported only while the gateway serves hosted connectors (`HOSTED_CONNECTORS=true`,
  off by default); otherwise it is `[]` whatever the plan allows. Even then it lists only the
  plan's ids the gateway can serve now: a catalog entry whose vendor OAuth app is configured
  (client id, every URL, scopes), with the database and `CONNECTOR_TOKENS_KEK` in place. An id the
  plan grants but the operator has not configured is left out, so a client never sets up a
  connector that could only answer 503.
- Seed (migration `20261106000300_connector_policy.sql`, kept if an operator already set a
  policy): every plan `allowed: ["catalog:*"]`, `denied: []`, `required: []`,
  `allow_unvetted: true`, `catalog_version: "2026-11-03"`; Free `hosted: []` (local connectors
  only); Pro, Max and ultrawork (and Athlete and Speed, migration `20261108000000`) `hosted: ["atlassian", "github", "linear", "notion", "slack"]`
  (vendors with an official remote MCP server). The ids must equal the CLI catalog's ids. Not yet
  checked: the CLI's compiled-in catalog (`assets/mcp-catalog.json`) is on no neuron-v2 branch as
  of 2026-11-04, so these five ids are provisional. When it lands, compare them and fix either
  side (a new migration, or an operator update of `connector_policy`). Nothing depends on them
  yet: `hosted` is reported only with `HOSTED_CONNECTORS=true`.
- CLI behaviour (neuron-v2): the block is cached with its expiry; offline or when the gateway
  cannot be reached, the CLI uses the last cached policy and warns (fail open), unless managed
  settings set `mcpPolicy.failClosed: true`.


### 18.2 Agentic routing hint (`x-neuron-route: agentic`)

- The Neuron CLI sends `x-neuron-route: agentic` on turns that attach tools when the model is
  `auto`. The gateway treats a request as agentic when it carries that header (any case, trimmed)
  or attaches at least one tool, whoever the client is.
- For an agentic request `auto` considers only catalog models with `capabilities.tools = true`
  and leaves out models with a poor tool-call record, including as fallbacks. The catalog keeps no
  per-model tool-call rate, so the record is an explicit list in `src/catalog.js`
  (`POOR_TOOL_CALLERS`, matched on the upstream model with any provider prefix and any
  OpenRouter `:variant` suffix such as `:free`): today the gpt-oss family
  (`groq/openai/gpt-oss-120b`, `groq/openai/gpt-oss-20b`, `nvidia/openai/gpt-oss-20b`,
  `@cf/openai/gpt-oss-120b`, and catalog rows or BYOK OpenRouter models of the same models), after
  `groq/openai/gpt-oss-120b` answered a build request in chat without calling a tool (2026-11-03).
  The same rule applies to `auto` on a BYOK session's own OpenRouter models; when only listed
  models could serve, it answers 400 `invalid_request` ("None of your OpenRouter models reliably
  calls tools; choose a model by name.").
- The header only narrows `auto`. A model asked for by id is served as before, agentic or not: the
  header alone never makes it need tools (only attached tools do). A request without tools and
  without the header routes as before.
- When no other tool-capable model is configured, the request answers 503 `service_unavailable`
  ("No model that reliably calls tools is configured on this gateway; choose a model by name.").

### 18.3 `prompt_cache_key` (`POST /v1/chat/completions`)

- The CLI may send `prompt_cache_key` in an OpenAI-compatible chat body: a hash of its session
  id, never the raw id. The gateway accepts 1 to 128 characters of `[A-Za-z0-9._:-]` (otherwise
  400 `invalid_request`).
- The gateway never forwards the key as sent. It forwards `SHA-256("zx-cache:" + caller + NUL +
  key)` (the first 32 hex digits; caller = the account id, or the session for sessions without
  an account), which is stable for the conversation and cannot collide with or reveal another
  caller's key on the shared upstream account.
- It goes only to upstreams that accept the field: OpenRouter (its sticky routing key, which
  keeps the conversation on the provider that holds its prompt cache). It is stripped for Groq,
  Gemini (its OpenAI-compatible endpoint answers 400 to unknown fields), NVIDIA, Workers AI, Z.ai
  and Claude (whose adapter caches with its own `cache_control` blocks).
- Quota accounting is unchanged: cached input tokens count like other prompt tokens.

### 18.4 Hosted connector endpoint (implemented; off unless `HOSTED_CONNECTORS=true`)

Code: `src/mcp-proxy.js`, `src/routes/connectors.js`, `src/connector-accounts.js`,
`src/connector-catalog.js`, `src/connector-vault.js`; migration
`20261106000400_connector_accounts.sql` (down script in `migrations/down/`); check
`check-connectors.mjs`. With `HOSTED_CONNECTORS` unset every route below answers 404.

- `https://zero-x.live/mcp/<connector_id>`: Streamable HTTP (MCP 2025-06-18), `Authorization:
  Bearer <ses_ session token or nzx_ key>`. Served only for ids in the caller's
  `policy.connectors.hosted` (and allowed, not denied). Methods: `POST` (one JSON-RPC message;
  batches answer 400), `GET` (the server-to-client stream; needs a session) and `DELETE` (ends the
  session). The answer is `application/json` or `text/event-stream`, as the vendor sends it.
- `401` (`{"error":"invalid_session"}`, `WWW-Authenticate: Bearer`) = sign in again. `403` with
  `{"error":"needs_connect","connect_url":"https://zero-x.live/dashboard#connectors"}` = the user
  has not linked that connector, or the vendor no longer accepts the link: it refused the refresh
  grant (`invalid_grant` and the like), the token expired without a refresh token, or a freshly
  refreshed token was refused too (the gateway then deletes the link). A token endpoint that
  cannot be reached or answers 5xx (or an operator error such as `invalid_client`) is
  `502 upstream_unreachable` and keeps the link. Other answers, all
  `{"error": <code>, "message": ...}`: `403 not_in_plan` (the plan does not include the
  connector; `upgrade_url`), `403 account_suspended`, `404 not_found` (unknown connector),
  `404 session_not_found` (initialize again), `413 request_too_large` (over 1 MiB),
  `429 rate_limited` (`Retry-After`; 120 requests per user per minute, counted in the database
  so the Worker, the EC2 server and every isolate share one budget), `502 upstream_error` /
  `upstream_unreachable`, `503 connector_not_configured` or `connectors_unavailable`.
- Sessions: the client sees `Mcp-Session-Id: zxs_<43 characters>`, which the gateway maps to the
  vendor's session id, the user and the connector (24 hours). Another user's id answers 404.
- A call to a destructive-tier tool must carry `x-neuron-confirmed: 1`, which the CLI sends only
  after the user approved that call in its permission prompt; without it the proxy answers HTTP
  200 with JSON-RPC error `-32010` (`data.reason: "confirmation_required"`, `data.tool`,
  `data.tier`). The header is not passed to the vendor. Tools the catalog marks `blocked` answer
  `-32011` and are left out of `tools/list`. An answer over the size cap (4 MiB) ends with
  `-32012` for the pending request. The gateway forwards the JSON-RPC message it checked
  (re-serialized), never the raw request body.
- A tool's tier is the gateway catalog's (an explicit per-vendor map from the vendor's published
  tool list where there is one, else name rules on the name split into words without the vendor
  prefix, so `deleteConfluencePage` and `notion-delete-page` are destructive), made stricter, never
  looser, by the vendor's own annotations: an explicit `destructiveHint: true` makes it
  destructive, an explicit `readOnlyHint: false` takes it out of `read`. `tools/list` answers
  carry that tier: `annotations.readOnlyHint` (read), `annotations.destructiveHint`
  (destructive), `annotations.openWorldHint: true`, and `_meta["live.zero-x/tier"]` = `read`,
  `write`, `external` or `destructive`. Tiers the vendor made stricter are remembered per user
  and connector (seven days) and applied to `tools/call`, so a call is checked against the tier
  the client was shown; a tool whose stricter tier cannot be stored is left out of the list.
- Every message the proxy handles writes one audit row with metadata only (method, tool, tier,
  decision, status, duration, byte counts, sha256 of the tool arguments), kept 30 days; no
  argument or result text is stored. Vendor tokens never reach a client or a log.
- Neuron settings name a hosted connector with server `type: "zerox"`. The managed-proxy type
  string the CLI inherited stays only as a silent parse alias and appears in no docs or UI.

### 18.5 Connector accounts (`/api/connectors`, website and CLI sessions; not API keys)

- `GET /api/connectors` → `{catalog_version, connect_url, connectors: [{id, name, publisher,
  source, endpoint, status, in_plan, configured, scopes, connected_at}]}`; `status` is
  `connected`, `not_connected`, `not_in_plan` or `unavailable` (the operator has not configured
  the vendor's OAuth app). No token is ever returned.
- `POST /api/connectors/<id>/connect` → `{authorize_url, expires_in: 600}` and an HttpOnly
  `zx_connect` cookie; the browser goes to `authorize_url` (OAuth 2.0 code flow with PKCE S256
  and a single-use `state`). For a vendor whose MCP server is an MCP 2025-06-18 authorization
  server (Notion, Atlassian) the authorize URL, the code exchange and every refresh grant carry
  `resource=<the MCP server URL>` (RFC 8707). Linking again replaces the previous link.
  `403 not_in_plan`, `503 connector_not_configured`.
- `GET /api/connectors/callback` (the vendor's redirect) → `303` to the dashboard with
  `?connector=<id>&connect=ok#connectors`, or `connect=error&reason=` `invalid_state`, `expired`,
  `browser_mismatch` (no matching cookie: the flow was started in another browser), `denied`,
  `vendor_error`, `invalid_code`, `not_in_plan`, `token_exchange` or `unavailable`.
- `DELETE /api/connectors/<id>` → `{status: "disconnected", connector}`; `404` when not connected.
  Where the operator set `CONNECTOR_<ID>_REVOKE_URL` the stored refresh token
  (`token_type_hint=refresh_token`), then the access token, are revoked at the vendor (RFC 7009,
  best effort); the link's row and its sealed tokens are then deleted, not kept. The CLI sees
  `needs_connect` on its next call.

## 19. v1.11 amendments (Claude Haiku 5.5 on every plan, sponsored pools, checker verdicts on the Worker, 2026-11-06)

Code: `src/catalog-types.js` (`SPONSORED_FREE_MODELS`, `KEY_SLOTS.anthropic.paid.sponsors`, the
anthropic free slot, `SLOT_OFFERS`, `sponsoredCaps`), `src/list-prices.js`, `src/catalog-claude.js`,
`src/catalog-guardrails.js`, `src/capacity.js`, `src/chat-handler.js`, `src/sponsored.js` (new),
`src/router.js`, `src/catalog.js`, `src/anthropic-request.js` (Haiku traits), `src/health-probes.js`
(schedule), `src/probe-rows-db.js` (new), `src/routes/plans.js`, `src/routes/account.js`,
`src/routes/admin.js`, `src/plan-policy.js`; migrations `20261106000600_sponsored_pools.sql`,
`20261106000700_haiku_catalog.sql` (generated by `scripts/catalog-seed-sql.mjs`),
`20261106000800_plan_features_haiku.sql` (down scripts in `migrations/down/`); checks
`check-sponsored-cap.mjs`, `check-probe-rows-db.mjs` and the extended `check-catalog-db.mjs`,
`check-anthropic-adapter.mjs`, `check-health-probes.mjs`, `check-routing-v2.mjs`,
`check-e2e-local.mjs`, `check-account-api.mjs`, `check-billing-caps.mjs`, `check-pages.mjs`.

### 19.1 Sponsored pools

A sponsored pool is a `free`-tier pool on a key slot the operator pays for (`anthropic.paid`;
`KEY_SLOTS` marks such slots `sponsors: true`). Users pay nothing; the pool carries the upstream
list price so Zero-X's own cost is recorded and capped. Reviewed code bounds it: only a
(provider type, upstream model) in `SPONSORED_FREE_MODELS` may have one, its price must equal the
list price exactly (cache rates and the long-context rate included), every limit (rpm, rpd, tpm,
tpd) must be set and at most the code ceiling, it needs a daily spend cap at most the type maximum,
and it carries the family's per-user monthly token allowance (`user_month_tokens`) and
`requires_ledger`. Guardrail reasons: `sponsored_not_listed`, `sponsored_price_required`,
`price_mismatch_list`, `cache_price_missing`, `cap_missing`, `cap_above_max`,
`free_limits_required`, `free_limits_above_max`; `free_pool_priced` applies only to free pools on
slots that do not sponsor. A sponsored pool keeps the offer of its slot (`anthropic.paid`), whose
data-policy facts it reports. In the database the table check that kept every free pool unpriced
and uncapped (`zerox_catalog_revision_pools_free_terms`) makes an exception for slots named by
`zerox_catalog_slot_sponsors`; which models may use it is decided by the code guardrails, which
every proposal passes first.

Billing: a sponsored reservation holds its worst case in the pool's day bucket
(`zerox_reserve_v2` `p_cost_microusd`, counted against `p_pool.cpd` whatever the tier) but never
in credits; settlement charges the user 0 and records the sponsored cost on
`zerox_usage_events.sponsored_cost_microusd`, `zerox_usage_daily.sponsored_cost_microusd`, the
month row and the pool's day bucket (`cost_today_microusd` on `/admin/overview`, with
`spend_cap_microusd` and `sponsored: true`). The recorded figure is billed micro-USD, the
marked-up equivalent every pool's cap counts (list price x `MARKUP`, 1.25), not the raw upstream
bill. Refunds return the hold; `failed_upstream` keeps the sponsored cost and refunds the user as
in 13.4. A spent cap answers `pool_exhausted`: blurred until 00:00 UTC, and `capacity_exhausted`
"has reached today's spending limit on Zero-X" when it is the only candidate (the budget is named
`rpd|tpd|cpd`, all of which reset at 00:00 UTC). Sessions without an account ledger cannot use a
sponsored pool (`upgrade_required`; an anonymous `/v1/models` caller is shown the Free view).

### 19.2 Claude Haiku 5.5 (`anthropic/claude-haiku-5-5`)

- One route, one sponsored pool: provider type `anthropic`, key slot `anthropic.paid`, upstream
  `claude-haiku-5-5`, alias `claude-haiku-5-5`, on every plan at no charge to the user.
  `context_window` 100,000 (so every request is on the lower rate card), `max_output_tokens` 32,000,
  `default_max_tokens` 16,000, tools and vision, `auto_rank` null (`auto` never picks it; a user
  selects it by name or family id), list position 165 (after Opus 5.5). `/v1/models` lists it with
  `tiers: ["free"]`, `pricing: null` and `allowance: {month_tokens: 10000000}` (a field alpha.4
  ignores). Pool limits: rpm 50, rpd 10,000, tpm 400,000, tpd 60,000,000 (the rpm and tpm are
  unverified against the key's Anthropic tier: lower them by revision if the workspace's limits are
  under them).
- Prices (list, upstream): $0.10 / $0.50 per MTok for prompts of 100K tokens or fewer, $0.50 /
  $2.50 above, cache reads $0.01, 5-minute cache writes $0.125, 1-hour $0.20. Recorded cost is list
  price x 1.25, like every pool; the user is charged nothing. Daily spend cap $5 (upstream;
  `cpd` 6,250,000 billed micro-USD), a plain row value the operator raises by revision up to the
  type maximum ($50). Worst case per user: 10M tokens a month is about $1.60 at an 85/15
  input/output split, $5 if all output.
- `reasoning_effort`: `none | low | medium | high` (`minimal` -> `low`); `none` sends
  `thinking: {"type": "disabled"}` at effort low (accepted at effort high or below, with no
  `block_binding`, beta or replay); absent or `default` = `medium` with adaptive thinking. No
  `budget_tokens`, no sampling parameters, no prefill (all 400 upstream); a forced `tool_choice` is
  sent as `auto` with an instruction as for the other Claude models. Refusals and usage as in 13.3
  (Haiku has no server-side refusal fallback); thinking replay only with thinking on.

### 19.3 Monthly family allowance

- Every user may use at most `user_month_tokens` (Haiku: 10,000,000) tokens per calendar month
  (UTC) on a sponsored family: prompt tokens (plain input, cache writes and cache reads at their
  token count) plus completion tokens, summed over every route of the family. It is checked and
  held atomically in `zerox_reserve_v2` (`p_cap` `{family, month_tokens}`, table
  `zerox_family_month_usage` keyed by user, family and month), after the plan's daily and window
  checks and before rpm, concurrency, credits and the pool budgets: a request must pass all of
  them. A reservation holds its reserved tokens (prompt + min(max_tokens, 1024)); settlement
  corrects the month row to the settled tokens (a refund counts 0); a released reservation keeps
  its hold until a late settle corrects it, as the daily and window counters do.
- Refusal: status `user_family_month_tokens` -> 429 `insufficient_quota` with `resets_at` and
  `Retry-After` = the first of the next month 00:00 UTC and no `upgrade_url`. Headers
  `x-neuron-quota-family`, `x-neuron-quota-month-limit-tokens`, `x-neuron-quota-month-used-tokens`,
  `x-neuron-quota-month-resets-at`. The message names the figures: "You've used your 10,000,000
  Claude Haiku 5.5 tokens for November; the allowance renews on Dec 1, 00:00 UTC. Other models keep
  working." / "This request needs N tokens but only R of your 10,000,000 Claude Haiku 5.5 tokens
  for November are left; the allowance renews on Dec 1, 00:00 UTC. Choose another model until
  then."; a request larger than the whole allowance carries no `resets_at` or `Retry-After`.
  The refusal is per family: the chat handler skips the family's other candidates and tries the
  rest, failing with it only when nothing else could serve (with the current catalog the Haiku family
  has one route and `auto` never picks it, so a Haiku request fails with it directly); every other
  model keeps working. A successful sponsored completion adds
  `x-neuron-quota-month-remaining-tokens`.
- `zerox_reserve_v2` keeps its 8-argument call (`p_cap` defaults to null; old gateways are
  unaffected) and gains `cap_family`, `cap_tokens`, `cap_used_tokens`, `cap_resets_at`. A gateway
  that sends `p_cap` to a database without the migration gets no function (PostgREST `PGRST202`,
  Postgres `42883`) and fails closed: the pool is `not_configured` in that isolate for 10 minutes,
  logged once, a direct Haiku request answers 503 `service_unavailable`, and nothing is served
  uncapped.
- `GET /api/account` adds `usage_month: [{family, model_name, tokens, limit_tokens,
  remaining_tokens, resets_at}]` (empty when unused; the gateway passes the allowances as
  `zerox_account_overview(p_user_id, p_caps)` and retries without `p_caps` against a database that
  lacks the migration); `zerox_usage_by_model` and `/api/usage` `by_model` rows add
  `sponsored_cost_microusd`.
- Released clients: Neuron 7.0.0-alpha.4 shows the 429 as it shows the window refusal (message
  and reset time); the new fields and headers are ignored. Whether alpha.4 sleeps the whole
  `Retry-After` of an `insufficient_quota` was not re-read for this change.

### 19.4 Plans

Tiers, limits, prices and credits are unchanged (section 1). The feature strings
(`zerox_plan_policy.features`, `/api/plans`, the site fallback, the pricing page) add "Claude
Haiku 5.5 included: 10M tokens a month at no charge" to every plan (second line of Free, first line
of Pro, Max and ultrawork).

### 19.5 Health

- The Worker (`neuron.zero-x.live`) reads the checker's verdict rows (`zerox_pool_health_get`,
  the rows the Node prober writes, section 15.4) when it builds `/v1/models`, `/v1/models/status`
  and `/v1/models/stream`: per isolate, cached for `poll_interval_seconds` (30 s), the last rows
  kept for 10 minutes when a read fails, with the per-route stale horizons of 15.2 computed from
  the catalog (once rows exist; with none the horizon is `HEALTH_STALE_SECONDS`). The freshest
  observation still wins, so the isolate's own attempts and the HealthHub flip a model at once.
  Without the RPC (migration missing), without a database or with `HEALTH_PROBES_DB_ROWS=off`, the
  Worker answers as before (HealthHub and its own attempts). Both hosts therefore show the same
  verdicts, latency and `stale_after_seconds`. The operator's `/health` on the Worker adds
  `health_checker.verdict_rows` (`source`, `rows`, `read_at`, `missing_migration`, `disabled`).
- Why the two hosts differed (2026-11-06): a family's `context_window` is the largest window among
  the routes that can serve now (section 14), so it follows the routes' health. The Node server
  knew from the checker which routes were out; the Worker saw only the HealthHub's list checks and
  listed a larger window (GPT-OSS 20B: 131,072 against 8,000), and `unknown` and no latency for
  Claude and GLM. Reading the same rows makes the hosts agree.
- Haiku test requests: thinking disabled at effort low, 3 output tokens for the chat test, 160 for
  the tool call (`tool_choice: 'auto'`), every 30 minutes / 6 hours like the paid Claude pools,
  horizon 2,700 s; not counted against the pool's spend cap (under $0.01 a day).

### 19.6 RPCs

| RPC | change |
|---|---|
| `zerox_reserve_v2` | `+ p_cap jsonb = null` (`{family, month_tokens}`); result `+ cap_family, cap_tokens, cap_used_tokens, cap_resets_at`; status `+ user_family_month_tokens`; `cpd` applies to any tier |
| `zerox_settle_v2` | same arguments; pool cost for any tier, user charge paid only, sponsored cost recorded, month row corrected |
| `zerox_account_overview` | `+ p_caps jsonb = null` (array of `{family, month_tokens}`); `+ usage_month jsonb` |
| `zerox_usage_by_model` | `+ sponsored_cost_microusd` |
| `zerox_release_stale_reservations` | also deletes month rows older than 13 months |

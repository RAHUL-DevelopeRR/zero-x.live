# Neuron × Zero-X platform contract

Status: v1 (2026-10-16). This document is the source of truth shared by the Neuron CLI
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
    { tier: 'free', key_var: 'GEMINI_API_KEY', limits: { rpm: 10, rpd: 250, tpm: 250000, tpd: 5000000 } },
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
| 400 | `context_length_exceeded` | invalid_request_error | no candidate fits the request |
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
  shown once; max 10 active keys)
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
| `zerox_settle_v2` | `p_reservation_id uuid, p_prompt_tokens bigint, p_completion_tokens bigint, p_cost_microusd bigint, p_status text ('ok','error','refunded'), p_latency_ms int, p_provider text, p_upstream_model text, p_error_code text` | `{status:'settled'|'already_settled'|'not_found', credit_balance_microusd}` |
| `zerox_release_stale_reservations` | — | `{released}` |
| `zerox_plan_policies_v2` | — | one row per plan with all policy columns |
| `zerox_account_overview` | `p_user_id` | account + policy + credits + subscription + today usage (jsonb columns) |
| `zerox_usage_series` | `p_user_id, p_from date, p_to date` | rows `{day, requests, prompt_tokens, completion_tokens, cost_microusd}` |
| `zerox_usage_by_model` | `p_user_id, p_from, p_to` | rows `{model, requests, prompt_tokens, completion_tokens, cost_microusd}` |
| `zerox_usage_events` | `p_user_id, p_limit int, p_before bigint` | rows of `zerox_usage_events` |
| `zerox_api_key_create` | `p_user_id, p_name, p_prefix, p_hash` | `{id, name, prefix, created_at}` (raises `too_many_keys`) |
| `zerox_api_key_list` | `p_user_id` | rows |
| `zerox_api_key_revoke` | `p_user_id, p_key_id uuid` | `{revoked boolean}` |
| `zerox_api_key_verify` | `p_hash` | `{key_id, user_id}` or no row |
| `zerox_billing_upsert_subscription` | `p_user_id, p_provider, p_provider_subscription_id, p_plan, p_status, p_current_period_start timestamptz, p_current_period_end timestamptz, p_cancel_at_period_end boolean, p_raw jsonb` | subscription row; sets account plan when status ∈ (authenticated, active), reverts to free when ended |
| `zerox_billing_record_payment` | `p_user_id, p_provider, p_provider_payment_id, p_kind, p_amount_minor bigint, p_currency, p_status, p_invoice_url, p_raw jsonb` | payment row (idempotent on provider+payment id) |
| `zerox_credit_grant` | `p_user_id, p_delta_microusd bigint, p_reason text, p_ref text` | `{granted boolean, balance_microusd}` (idempotent on ref) |
| `zerox_webhook_claim` | `p_provider, p_event_id, p_event_type, p_payload_sha256` | `{claimed boolean}` |
| `zerox_billing_get` | `p_user_id` | `{subscription jsonb, payments jsonb}` |
| `zerox_subscription_by_provider_id` | `p_provider, p_provider_subscription_id` | subscription row incl. `user_id` |
| `zerox_apply_subscription_expiry` | — | `{downgraded}` |
| `zerox_session_index_add/list/revoke_all` | `p_user_id, p_token_hash, p_expires_at` | session index for revoke-all |
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

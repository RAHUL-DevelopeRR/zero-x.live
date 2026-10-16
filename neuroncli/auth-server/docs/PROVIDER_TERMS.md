# Upstream provider terms and limits (checked 2026-10-16)

Summary of official sources that constrain how the hosted gateway may use each upstream.
This is an engineering summary, not legal advice; confirm with counsel before launch.

| Provider | Free-tier limits (observed / documented) | Can a free key serve a paid multi-user product? | Gateway default |
|----------|-------------------------------------------|-----------------------------------------------|-----------------|
| Groq | Org-wide: gpt-oss-120b 30 RPM, 1K RPD, 8K TPM, 200K TPD (headers confirmed 1000 req/day, 8000 tok/min; 10.5K-token request → 413) | Services Agreement §3.1 allows End Users via Customer Applications; §6.3(c) bars resale without approval; AUP bans multi-account/org orchestration | Free pool for small prompts; paid plans use `GROQ_PAID_API_KEY` (Developer plan) |
| Google Gemini API | Per project, shown only in AI Studio; Pro models have 0 free quota for this key; 2.5 Pro 404 for new users. Observed 2026-10-16: free 2.5 Flash answered 429 after 6 Neuron requests (~125K input tokens) within 16 s, well below the published 10 RPM / 250K TPM | Allowed for API clients, but "only Paid Services" for users in EEA/UK/CH; free-tier prompts may train and be human-reviewed | Free pool geo-blocked for EEA/GB/CH; free budget per model rpm 5, tpm 100K (rpd 250 / tpd 5M unverified); paid plans use `GEMINI_PAID_API_KEY` (billing-linked project) |
| NVIDIA API Catalog | ~40 RPM community-observed, no published table | Trial Terms §1.2/§1.4: trial and internal evaluation only, not production; §4.2 no making Generated Content available to others | `hosted=false` (`NVIDIA_HOSTED=true` for internal evaluation only) |
| OpenRouter | Free models 20 RPM; 50 RPD (<$10 credits) or 1,000 RPD; this key is free tier (limit $0, 50/day) | Terms §7.4 bans "reselling API access to Models"; §7.3 bans extra accounts to bypass limits | BYOK only (user OAuth / own key); `OPENROUTER_HOSTED=true` re-enables operator key; send `provider.data_collection:'deny'` |
| Cloudflare Workers AI | 10,000 Neurons/day free; $0.011 / 1K Neurons on Workers Paid | Customer responsible for End Users; no training on customer content | Free pool within allocation; paid overage only on Workers Paid |

Business consequences:

- Total free capacity is on the order of 1–3M tokens/day for the whole service. Free plan
  quotas must be sized from the shared pool, and the gateway enforces global per-pool
  budgets (`zerox_reserve_v2`).
- Paid plans must be backed by paid upstream capacity; the $10 Pro plan includes $8 of
  credits billed at 1.25× upstream cost.
- Payments: Stripe is invite-only for Indian businesses; Razorpay Subscriptions is the
  primary processor. Razorpay requires About, Contact, Pricing, Terms, Privacy and
  Refund/Cancellation pages (plus a digital-delivery/shipping statement).
- Privacy policy must list every upstream processor and the free-tier training/retention
  practices.

## Free-pool limits and 429 handling

The shared budgets in `POOL_LIMITS` (`src/catalog.js`) are enforced per model for all users by
`zerox_reserve_v2` before any upstream call (each attempt reserves its prompt estimate plus
`max_tokens`). They are set below what the upstreams were seen to accept:

| Pool | rpm | rpd | tpm | tpd | Basis |
|------|-----|-----|-----|-----|-------|
| `gemini_free` (2.5 Flash, 3.5 Flash; each model separately) | 5 | 250 | 100,000 | 5,000,000 | 2026-10-16: 429 after 6 requests / ~125K input tokens in 16 s on 2.5 Flash (published: 10 RPM, 250K TPM). rpd/tpd not observed yet. |
| `groq_free` (each model) | 30 | 1,000 | 8,000 | 200,000 | Groq `x-ratelimit-*` headers. |

When an upstream still answers 429, the pool is parked (per gateway isolate) for the delay the
upstream names: `Retry-After`, Groq's `x-ratelimit-reset-*` for the exhausted dimension, Gemini's
`google.rpc.RetryInfo.retryDelay`, or at least an hour for a Gemini per-day quota
(`QuotaFailure` quota ids containing `PerDay`); without a delay, 30 s. If the pool is rate
limited again within 10 minutes after its cooldown ended, the backoff doubles each time (at
least half the escalated backoff when the upstream names a shorter delay; at most 15 minutes for
unnamed delays) until a request succeeds. 429s from requests already in flight do not escalate.
The operator log line `Neuron upstream error detail` (warn) records the tripped quota
(`quotas: [{id, value}]`) and the retry delay, so these limits can be checked against what
Google enforces for the project.

## Request compatibility (observed 2026-10-16 with real Neuron requests)

`src/provider-request.js` adapts each request to what the upstream accepts; see its header for
details. Verified directly against the live endpoints with a captured Neuron 6.2.5 request
(~23K-token system prompt, 22 tool schemas, parallel tool calls and tool results):

- **Gemini 3.5 Flash** rejects a history whose assistant tool calls carry no thought signature
  (`400 INVALID_ARGUMENT: Function call is missing a thought_signature in functionCall parts`)
  and rejects signatures it did not issue (`Corrupted thought signature.`). Neuron (and most
  OpenAI clients) drop the signature, so the gateway keeps the signatures Gemini returns (per
  caller and upstream model, in memory, 6 h, never sent to clients) and puts them back on the
  next turn; calls it has no signature for (another model, another isolate, older history) get
  Google's documented placeholder `skip_thought_signature_validator`. Gemini 2.5 Flash needs no
  signature and accepts the placeholder.
- **Groq** rejects message properties outside the OpenAI schema (`property 'is_error' is
  unsupported`): messages and tool calls are reduced to the OpenAI fields for Groq and Gemini.
  Every provider gets `is_error` removed; a failed tool result keeps its meaning as an `Error: `
  prefix on its content.
- Accepted unchanged by Gemini 2.5/3.5 Flash and Groq (gpt-oss-120b, qwen3.8-27b): JSON-Schema
  keywords in tool parameters (`$schema`, `$ref`/`$defs`, `additionalProperties`, `default`,
  `format`, `anyOf`/`oneOf`/`allOf`, `const`, type arrays, empty `properties`, boolean
  schemas), `tool_choice: "auto"`, `stream_options` and tool messages without `name`; by Gemini
  also `tool_choice: "required"` and the named-function form, and `content: null` next to tool
  calls. Schemas are therefore forwarded as sent. Parameters a provider rejects are dropped by
  `PROVIDER_PARAMS` in `src/providers.js` (e.g. penalties, `parallel_tool_calls` and `user` for
  Gemini).

Sources: console.groq.com/docs/rate-limits, console.groq.com/docs/legal/services-agreement,
ai.google.dev/gemini-api/terms, ai.google.dev/gemini-api/docs/pricing,
ai.google.dev/gemini-api/docs/rate-limits, ai.google.dev/gemini-api/docs/thought-signatures,
assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA API Trial Terms of Service.pdf,
openrouter.ai/terms, openrouter.ai/docs/api-reference/limits,
developers.cloudflare.com/workers-ai/platform/pricing,
razorpay.com/docs/payments/dashboard/account-settings/business-website-details,
support.stripe.com/questions/how-can-i-open-a-stripe-account-in-india.

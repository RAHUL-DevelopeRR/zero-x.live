# Upstream provider terms and limits (checked 2026-10-16)

Summary of official sources that constrain how the hosted gateway may use each upstream.
This is an engineering summary, not legal advice; confirm with counsel before launch.

| Provider | Free-tier limits (observed / documented) | Can a free key serve a paid multi-user product? | Gateway default |
|----------|-------------------------------------------|-----------------------------------------------|-----------------|
| Groq | Org-wide: gpt-oss-120b 30 RPM, 1K RPD, 8K TPM, 200K TPD (headers confirmed 1000 req/day, 8000 tok/min; 10.5K-token request → 413) | Services Agreement §3.1 allows End Users via Customer Applications; §6.3(c) bars resale without approval; AUP bans multi-account/org orchestration | Free pool for small prompts; paid plans use `GROQ_PAID_API_KEY` (Developer plan) |
| Google Gemini API | Per project, shown only in AI Studio; Pro models have 0 free quota for this key; 2.5 Pro 404 for new users | Allowed for API clients, but "only Paid Services" for users in EEA/UK/CH; free-tier prompts may train and be human-reviewed | Free pool geo-blocked for EEA/GB/CH; paid plans use `GEMINI_PAID_API_KEY` (billing-linked project) |
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

Sources: console.groq.com/docs/rate-limits, console.groq.com/docs/legal/services-agreement,
ai.google.dev/gemini-api/terms, ai.google.dev/gemini-api/docs/pricing,
assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA API Trial Terms of Service.pdf,
openrouter.ai/terms, openrouter.ai/docs/api-reference/limits,
developers.cloudflare.com/workers-ai/platform/pricing,
razorpay.com/docs/payments/dashboard/account-settings/business-website-details,
support.stripe.com/questions/how-can-i-open-a-stripe-account-in-india.

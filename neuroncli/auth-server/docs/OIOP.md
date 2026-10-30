# OIOP — Open Inference Offer Protocol (v0.1, Phase 1)

OIOP describes **free and low-cost inference offers** the way MCP describes tools: one manifest
format, a lifecycle, a runtime contract. Inference itself stays OpenAI-compatible
(`/v1/chat/completions`); OIOP standardises everything around it — who serves a model, on what
terms, whether those terms let the gateway serve other people, how much code-sensitive trust the
offer deserves, and whether it is healthy right now.

Phase 1 (this document) is implemented in the Zero-X gateway (`neuroncli/auth-server`). The
discovery crawler and terms analyser that feed it already exist in part (`src/discovery/`, contract
§8.4) and are extended in Phase 2.

| MCP concept | OIOP equivalent | Where |
|---|---|---|
| Server manifest | Offer manifest (provider, endpoint, access, limits, terms, trust, models) | `src/oiop/manifest.js`, `GET /oiop/schema/0.1.json` |
| Server registry | `zerox_offers` + signed manifests | migration `20261029000400_oiop_offers.sql` |
| Capability negotiation | Verified catalog flags + canaries (tool call, streaming) | `src/catalog.js`, `src/health-hub.js` |
| Transport | OpenAI-compatible HTTP + SSE | `src/chat-handler.js` |
| `tools/list_changed` | `catalog.updated` server-sent events | `GET /v1/models/stream` |

## 1. Offers

An **offer** is one way to reach a provider's models. Every catalog pool belongs to exactly one
(`offerIdFor(entry, pool)` = the pool's `offer`, else `<provider>.<tier>`), e.g. `groq.free`,
`gemini.paid`, `openrouter.byok`.

| Field | Values | Meaning |
|---|---|---|
| `owner` | `operator` \| `user` | the gateway's keys/deployment, or each caller's own key (BYOK) |
| `access_kind` | `hosted` \| `self_deploy` | a provider endpoint, or a model the operator deploys |
| `trust_tier` | `T0` model lab first-party · `T1` established aggregator/inference provider · `T2` smaller known provider · `T3` unknown or reseller | how far prompts (source code) may be trusted to it |
| `redistribution` | `permitted` \| `byok_only` \| `prohibited` \| `unknown` | may the operator's account serve other people; **`unknown` is treated as `byok_only`** |
| `trains_on_inputs` | `no` \| `yes` \| `varies_by_model` \| `unknown` | whether prompts may be used for training |
| `commercial_use` | `allowed` \| `prohibited` \| `unknown` | |
| `prerequisites[]` | `{type: account\|api_key\|billing\|card\|wallet_balance\|phone\|kyc\|waitlist\|deployment, detail, amount, currency, unlocks, source:{url, quote}}` | what "free" really requires (e.g. OpenRouter: `$10` balance unlocks 1,000 req/day) |
| `limits[]` | `{scope: key\|model\|account, rpm, rpd, tpm, tpd, monthly_tokens, neurons_per_day, reset_tz}` | published or observed limits |
| `terms_url`, `terms_sha256`, `terms_fetched_at` | | the terms page and the hash of its text when last read |
| `evidence[]` | `{field, source: page\|operator\|provider, url, quote, note}` | where each term comes from; `page` evidence carries the exact quote |

**Serving rule.** Operator pools of an offer serve only while its lifecycle is `active` or
`degraded` **and** `redistribution = permitted`. BYOK pools (the caller's own key) need only the
lifecycle. Everything else is routed around and listed as unavailable.

**Backfill (2026-10-24).** The nine offers behind the code catalog were backfilled `active` and
`permitted` by operator decision so the alpha keeps serving. For `nvidia.free` and
`openrouter.free` the evidence records this as an operator override of the terms summarised in
`docs/PROVIDER_TERMS.md`; their hosted flags still gate them.

## 2. Lifecycle

```
discovered → analysed → pending_approval → rejected
                              │
                              ├─→ awaiting_credentials ─┐
                              └─→ awaiting_deployment ──┴→ probing → active ⇄ degraded
                                                                       │
                                     review ←── (new terms hash) ──────┤
                                       │                               ├→ suspended → probing | review | retired
                                       └→ pending_approval             └→ retired
```

Enforced by `zerox_offer_can_transition` / `zerox_offer_transition` (and mirrored in
`src/oiop/offers.js TRANSITIONS`). The operator acts at three points: **approve** (leaving
`pending_approval`, recorded as `verified_by`), **add a key**, **deploy**. Nothing is
auto-approved; page text never moves an offer past `pending_approval`. Every change is written to
`zerox_offer_events` (audit log). A new `terms_sha256` on an offer that is being onboarded or
served moves it to `review`, which serves nothing, and it goes back through approval.

## 3. Manifest

`GET /oiop/schema/0.1.json` is the JSON Schema. Shape:

```json
{
  "oiop": "0.1", "offer_id": "openrouter.free", "version": 3, "issued_at": "2026-10-24T00:00:00.000Z",
  "provider": { "id": "openrouter", "name": "OpenRouter (free models)", "homepage": "https://openrouter.ai",
                "logo": "https://models.dev/logos/openrouter.svg" },
  "endpoint": { "base_url": "https://openrouter.ai/api/v1", "protocol": "openai-chat", "auth": "bearer" },
  "access": { "kind": "hosted", "owner": "operator", "prerequisites": [
    { "type": "wallet_balance", "amount": 10, "currency": "USD", "unlocks": "1,000 free-model requests per day instead of 50",
      "source": { "url": "https://openrouter.ai/docs/api-reference/limits" } } ] },
  "limits": [ { "scope": "account", "rpm": 20, "rpd": 50 } ],
  "terms": { "url": "https://openrouter.ai/terms", "sha256": null, "fetched_at": null, "redistribution": "permitted",
             "trains_on_inputs": "no", "commercial_use": "allowed", "expires_after_days": null, "evidence": [ … ] },
  "trust": { "tier": "T1", "verified_by": "operator", "verified_at": "…" },
  "models": [ { "id": "cohere/north-mini-code:free", "upstream": "cohere/north-mini-code:free", "base_model": null,
                "verified": { "tool_call": true, "streaming": true, "vision": false, "context": 256000, "max_output": 64000 } } ],
  "lifecycle": "active",
  "signature": { "alg": "Ed25519", "key_id": "<16 chars>", "value": "<base64url, 86 chars>" }
}
```

- **Canonical JSON** (RFC 8785 style): members sorted, no whitespace; the signature covers the
  canonical JSON of the manifest without `signature`.
- **Signing**: Ed25519 with the registry key `OIOP_SIGNING_JWK` (`node scripts/oiop-keygen.mjs`);
  the public half is at `GET /oiop/keys.json`; `key_id` = first 16 characters of
  base64url(SHA-256(public key)).
- **Versioning**: any change to an offer's facts bumps `manifest_version` and drops the stored
  signature; `POST /admin/offers/:id/manifest` signs the current version.

## 4. Runtime contract

Requests (all optional):

| Header | Default | Effect |
|---|---|---|
| `X-Neuron-Trust-Tiers: T0,T1` | `T0,T1,T2` | only offers in these tiers see the prompt; **T3 never by default** |
| `X-Neuron-Allow-Training: false` | `true` | only offers with `trains_on_inputs = no` |
| `X-Neuron-Conversation: <id>` | hash of the first system and user message | keys sticky routing |

Responses:

| Header | When |
|---|---|
| `X-OIOP-Offer: groq.free` | the offer that served the request |
| `X-OIOP-Fallback: <first model>; offer=<its offer>; reason=<rate_limited\|pool_exhausted\|…>` | the first choice did not serve |
| `X-OIOP-Redacted: <n>` | n distinct secrets were withheld from the upstream (§6) |

A request no offer may serve under the caller's policy answers `403 policy_restricted`
(`upgrade_required` when a paid pool would comply).

## 5. Routing

Per request, in order: **capability** (tools, image input, streaming, JSON `response_format`) →
**offer** (lifecycle + redistribution) → **caller policy** (trust tier, training) → **plan and
region** → **size** (context, per-minute token budget) → **health** (this isolate's circuit breaker
and HealthHub's shared busy/blurred pools) → **order**: free before paid; within a tier the
conversation's previous model (sticky, `auto` only), then fewer penalties (degraded here or in the
hub, ≥ 20 % recent errors, budget seen spent), then catalog quality order. Failover walks the same
list, so a fallback never leaves the capability class. Quota is reserved atomically in Postgres
before each attempt (`zerox_reserve_v2`, row locks; `check-quota-race.mjs` proves it on a real
Postgres) and settled with the provider's usage.

## 6. Secrets

Before a prompt leaves the gateway, credentials in message text, text parts, tool results and
tool-call arguments are replaced with `zxsecret_<12 hex>` (HMAC under a per-isolate key: stable
across turns, so prompt caches still match). The answer gets the real values back — streamed or
not, JSON-escaped inside tool-call arguments, even when a placeholder is split across chunks — so a
model that rewrites a `.env` file writes the real key. Detection favours precision: provider key
formats, PEM private keys, JWTs, connection-string passwords and secret-named assignments whose
value looks like a secret. `OIOP_SCRUB=all` (default) \| `untrusted` (T2/T3 only) \| `off`.

## 7. Health

HealthHub (one Durable Object) keeps every pool's state: real outcomes from all isolates, free
model-list and status-page checks, half-open probes, and **canaries** — one streamed tool call
(Groq) or one-line request (Workers AI) for a healthy pool idle for 15 minutes, within half its
daily probe cap (Groq every 2 h; Gemini, NVIDIA and OpenRouter get none, their free quotas are too
small; `HEALTH_CANARIES=false` turns them off). The
snapshot carries `status`, `samples`, `error_rate`, `p50_ms`, `p95_ms` (time to first byte) and the
last canary. States: `HEALTHY`, `DEGRADED`, `RATE_LIMITED`, `QUOTA_EXHAUSTED` (a spent daily quota:
Gemini per-day, Workers AI 3036), `MODEL_UNAVAILABLE`, `AUTH_FAILED`, `DOWN`.

## 8. Catalog

`/v1/models` entries add `provider {id, name, logo_url, logo_fallback_url}` (models.dev logos,
favicon fallback), `offers [{id, tier, owner, trust_tier, trains_on_inputs}]`, `models_dev_id` and
`facts` (models.dev: family, release date, knowledge cutoff, open weights, structured output,
modalities, list prices; refreshed by the cron at most daily into KV). The caller policy applies:
a ruled-out model is `unavailable_reason: policy_restricted`. `GET /v1/models/stream` pushes
`catalog.updated` events (id = `/v1/models/status` ETag) on every change.

**Model rows (contract §13.1, §13.2).** The catalog is data: model rows in Postgres, each change a
reviewed revision, approved draft → active on `/admin/models` by the operator (token plus
Cloudflare Access), with an append-only audit log that `GET /admin/catalog/audit` shows together
with the offer events. Offers and rows are two separate gates: an offer decides whether a
provider's terms let the operator's keys serve anyone (lifecycle, redistribution), a row decides
which of that provider's models serve and at what price. A row's pools still map to
`<provider>.<tier>` offers, so a row cannot move a model to a more permissive offer, and a row
can never name a URL or a secret: base URLs, key slots, list prices and spend ceilings live in
code. Discovery only ever creates draft rows. `catalog_version` in the `/v1/models/status` ETag
makes every approval a `catalog.updated` event.

**Claude.** `anthropic.paid` (protocol `anthropic-messages`, `T0`, `trains_on_inputs: no`,
redistribution `permitted` as an operator decision of 2026-10-24) serves Claude Sonnet 5.5 and
Claude Opus 5.5 to Pro and Max through the native Messages adapter, billed from credits. The
built-in offer mirrors the seed migration's row.

## 9. Discovery: endpoints and credits

Discovery (`src/discovery/`, contract §8.4) runs on the 10-minute cron and only ever proposes:

- **Free endpoints.** Daily public model lists and the weekly Claude web-search research queue
  free models as candidates; providers the research finds are also created as offers
  (`<provider>.free`) in `discovered`, untrusted (`T3`) with unknown terms, so they serve
  nothing until the operator approves them through the lifecycle.
- **Credit programs.** The weekly `credits` job (`src/discovery/credits.js`) finds free cloud
  and AI credit programs (startup programs, trial credits, developer programs, subsidised
  compute). It runs in two calls so that page text never drives the extraction: a search call
  whose answer carries citations (page URL + up to 150 characters quoted verbatim), then a
  tool-free call under a fixed JSON schema that names citation numbers per fact. Stored evidence
  quotes are the citations' own text; programs with no cited fact are dropped; a program on a
  known page keeps its row. The operator reviews `GET /admin/credits` (each program with its next
  step), applies outside the gateway (never automated), and records `approved` → `applied` →
  `granted` (amount, expiry) or `rejected`; `expired` when it ends. Granted credits then fund an
  offer: an LLM API key for the vendor's offer, or a GPU for a `self_deploy` offer.
  `DISCOVERY_CREDITS=false` turns the job off; it shares the research spend cap.

## 10. Not in Phase 1

- **Phase 2 — onboarding from the web**: the provider research moves to the same
  search-then-extract pattern as the credits job (exact quotes per term), the terms analyser
  hashes terms pages and re-crawls them daily; legitimacy checks (domain age, company identity, scam lists,
  pay-before-access); the admin queue shows quoted clauses and a next-step checklist, with e-mail
  or webhook notices; self-deploy plans (vLLM/Ollama image, GPU, monthly cost); keys for any
  OpenAI-compatible offer through a generic adapter (the vault and the catalog's provider types
  cover Groq, Gemini, NVIDIA, OpenRouter, Workers AI and Anthropic today); providers' own `/.well-known/oiop.json`.
- **Phase 3 — quality and limits**: nightly identity/quality eval against model swapping; limits
  learned from 429s and rate-limit headers; reset windows on the provider's clock.
- **Phase 4 — the standard**: publish the spec and a signed public registry.
- **Clients**: the Neuron client renders `provider.logo_url` and sends the policy headers (Neuron
  repository).

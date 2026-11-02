// Upstream list prices: the one table every paid price is checked against (catalog guardrails,
// src/catalog-guardrails.js) and built from (src/catalog-claude.js). USD per million tokens, as
// the providers publish them; MARKUP stays in src/pricing.js and is applied there only.
//
// src/pricing.js re-exports LIST_PRICES, LIST_PRICE_SCHEDULE, listPriceFor, listPriceMicro and
// MAX_DAILY_SPEND_CAP_USD from this module (billing design §1.2), so callers may import them from
// either file and there is still a single table.
//
// Every key here is a model a paid catalog row may serve, and only these: a paid pool serves only
// when its (provider type, upstream model) is listed, at exactly these prices, cache rates
// included (catalog-guardrails.js, 'unlisted_paid_not_allowed' otherwise). So add a row only for
// a model meant to be sold on the paid tier; prices kept for any other purpose do not belong here.

// Per paid pool and UTC day, in upstream USD: no catalog row, provider type or environment
// setting can raise a pool's daily spend cap above this (catalog-types.js max_daily_spend_usd
// may set a lower one per provider type).
export const MAX_DAILY_SPEND_CAP_USD = 100;

const row = fields => Object.freeze({ ...fields, ...(fields.long_context ? { long_context: Object.freeze({ ...fields.long_context }) } : {}) });

export const LIST_PRICES = Object.freeze({
  // Claude (Anthropic API). Skill docs (claude-api SKILL.md and shared/models.md): Sonnet 5.5
  // $2 / $10, Opus 5.5 $4 / $20, cache reads $0.20 on both. shared/prompt-caching.md: cache
  // writes cost 1.25x input for the 5-minute TTL and 2x for the 1-hour TTL. No long-context rate.
  'anthropic:claude-sonnet-5-5': row({ input: 2, output: 10, cache_read: 0.20, cache_write: 2.50, cache_write_1h: 4 }),
  'anthropic:claude-opus-5-5': row({ input: 4, output: 20, cache_read: 0.20, cache_write: 5, cache_write_1h: 8 }),
  // Not listed: Claude's server-side refusal fallback targets. The adapter never sends
  // `fallbacks`, so they are never billed, and a list price here would let a catalog row serve them.
  // The existing paid pools of src/catalog.js (same numbers as its priceFromCost calls).
  'gemini:gemini-2.5-flash': row({ input: 0.30, output: 2.50 }),
  'gemini:gemini-3.6-flash': row({ input: 0.75, output: 3.75 }),
  'gemini:gemini-2.5-pro': row({ input: 1.25, output: 10, long_context: { threshold: 200000, input: 2.50, output: 15 } }),
  'groq:openai/gpt-oss-120b': row({ input: 0.15, output: 0.60 }),
  'cloudflare:@cf/openai/gpt-oss-120b': row({ input: 0.35, output: 0.75 }),
  // Workers AI: 26,668 / 204,805 neurons per million tokens at $0.011 per 1K neurons.
  'cloudflare:@cf/meta/llama-3.3-70b-instruct-fp8-fast': row({ input: 0.293, output: 2.253 }),
  // Z.ai's free Flash models cost nothing (docs.z.ai pricing). The type has no paid slot
  // (catalog-types.js), so these rows can never price a paid pool; they record the upstream price.
  'zai:glm-4.7-flash': row({ input: 0, output: 0 }),
  'zai:glm-4.5-flash': row({ input: 0, output: 0 }),
});

// Announced list-price changes: from the UTC date `from`, the entry replaces LIST_PRICES for
// that model. A row still carrying the old price then fails the exact-match guardrail and its
// paid pool stops serving until a revision with the new price is approved (fail safe).
export const LIST_PRICE_SCHEDULE = Object.freeze({
  // src/catalog.js: "Paid list price through 2026-12-31 (doubles from 2027-01-01)".
  'gemini:gemini-3.6-flash': Object.freeze([row({ from: '2027-01-01', input: 1.50, output: 7.50 })]),
});

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// The list price of `typeId:upstream` in force at `at` (ms), or null when the model is not listed.
export function listPriceFor(typeId, upstream, at = Date.now()) {
  const key = `${typeId}:${upstream}`;
  if (!Object.hasOwn(LIST_PRICES, key)) return null;
  let price = LIST_PRICES[key];
  for (const change of LIST_PRICE_SCHEDULE[key] || []) {
    if (DATE.test(change.from) && Date.parse(`${change.from}T00:00:00Z`) <= at) {
      const { from: _from, ...rest } = change;
      price = Object.freeze(rest);
    }
  }
  return price;
}

const micro = usd => (usd === undefined || usd === null ? null : Math.round(usd * 1_000_000));

// The same price in upstream micro-USD per million tokens (the catalog row unit), with every
// component present (null when the provider has no such rate).
export function listPriceMicro(typeId, upstream, at = Date.now()) {
  const price = listPriceFor(typeId, upstream, at);
  if (!price) return null;
  return {
    input: micro(price.input), output: micro(price.output), cache_read: micro(price.cache_read),
    cache_write: micro(price.cache_write), cache_write_1h: micro(price.cache_write_1h),
    long: price.long_context ? { threshold: price.long_context.threshold, input: micro(price.long_context.input),
      output: micro(price.long_context.output) } : null,
  };
}

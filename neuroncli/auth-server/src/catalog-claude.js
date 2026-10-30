// Claude in the code catalog: the reviewed definition of the two Claude rows (seeded by
// migration 20261029000700_catalog_seed.sql) and of the OIOP offer their pools belong to.
// src/catalog-db.js serves these from code whenever the database has no row for them, and
// check-catalog-db.mjs proves the seeded rows equal them exactly.
//
// src/oiop/offers.js BUILTIN_OFFERS lists offer(ANTHROPIC_PAID_OFFER) (without it
// servesOperatorPools would keep the pools unconfigured), and src/catalog.js builds its code
// entries for Claude with entryFromSpec(id, spec, { source: 'code' }) from CLAUDE_MODEL_SPECS.
//
// Paid tier only (Pro and Max), key slot anthropic.paid (ANTHROPIC_API_KEY), never chosen by
// `auto`. Context and output are kept to what the gateway can carry: MAX_BODY_BYTES (1 MiB) holds
// roughly 300K tokens, so the rows advertise 200,000 rather than Claude's 1M. Prices are the list
// prices in src/list-prices.js; the daily spend caps ($10 Sonnet, $6 Opus, upstream USD) are
// enforced in Postgres (zerox_reserve_v2, p_pool.cpd).
import { listPriceMicro } from './list-prices.js';

const deepFreeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
};

const claude = ({ upstream, name, efforts, map, position, capUsd }) => ({
  provider_type: 'anthropic', upstream_model: upstream, display_name: name,
  context_window: 200000, max_output_tokens: 32000, default_max_tokens: 16000,
  supports_tools: true, supports_vision: true,
  reasoning_efforts: efforts, reasoning_effort_map: map, default_reasoning_effort: 'medium',
  aliases: [upstream], geo_block_free: [], auto_rank: null, position, default_enabled: true,
  pools: [{
    tier: 'paid', key_slot: 'anthropic.paid',
    // Prices as listed today; a later list change makes this spec differ from the seeded row, and
    // check-catalog-db.mjs then asks for a new revision.
    price: listPriceMicro('anthropic', upstream, Date.parse('2026-10-25T00:00:00Z')),
    limits: { rpm: null, rpd: null, tpm: null, tpd: null },
    daily_spend_cap_microusd: capUsd * 1_000_000,
  }],
});

// Sonnet 5.5 turns thinking off between tool calls for reasoning_effort 'none' (the adapter sends
// {type:'between_tools'} at effort low); Opus 5.5 cannot disable thinking, so 'none' maps to low.
export const CLAUDE_MODEL_SPECS = deepFreeze([
  claude({ upstream: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', efforts: ['none', 'low', 'medium', 'high'],
    map: { minimal: 'low' }, position: 150, capUsd: 10 }),
  claude({ upstream: 'claude-opus-5-5', name: 'Claude Opus 5.5', efforts: ['low', 'medium', 'high'],
    map: { minimal: 'low', none: 'low' }, position: 160, capUsd: 6 }),
]);

const COMMERCIAL_TERMS = 'https://www.anthropic.com/legal/commercial-terms';

// The anthropic.paid offer exactly as the seed migration stores it (every zerox_offers fact, the
// way src/oiop/offers.js offer() fills its defaults).
export const ANTHROPIC_PAID_OFFER = deepFreeze({
  id: 'anthropic.paid', provider: 'anthropic', name: 'Claude API (paid)', homepage: 'https://www.anthropic.com',
  logo_url: 'https://models.dev/logos/anthropic.svg', base_url: 'https://api.anthropic.com', protocol: 'anthropic-messages',
  access_kind: 'hosted', owner: 'operator', trust_tier: 'T0', redistribution: 'permitted', trains_on_inputs: 'no',
  commercial_use: 'allowed', expires_after_days: null, terms_url: COMMERCIAL_TERMS, terms_sha256: null, terms_fetched_at: null,
  prerequisites: [{ type: 'billing', detail: 'Anthropic API account with credit' }],
  limits: [],
  evidence: [
    { field: 'trains_on_inputs', source: 'operator', url: COMMERCIAL_TERMS,
      note: 'Commercial Terms: Anthropic does not train models on API inputs and outputs by default' },
    { field: 'redistribution', source: 'operator', url: COMMERCIAL_TERMS,
      note: 'Operator decision (2026-10-24): Claude serves Pro and Max subscribers through the gateway, billed from their credits. Recorded as an operator decision, not a verified reading of the terms.' },
  ],
  lifecycle: 'active', verified_by: 'operator', manifest_version: 1, notes: null,
});

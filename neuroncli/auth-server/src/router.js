import { globalHealthTracker, HealthState } from './provider-health.js';
import {
  AUTO_MODEL_ID, loadPlanPolicies, offeredEntries, planPolicy, poolKey, poolVerdicts, resolveModelId,
} from './catalog.js';
import { providerType } from './catalog-types.js';
import { BYOK_OFFERS, offerById, servesOwnKeys } from './oiop/offers.js';
import { DEFAULT_POLICY, describePolicy, policyBlock } from './oiop/policy.js';

export { loadPlanPolicies, planPolicy };

// A pool is only worth trying when it leaves room for a useful answer.
export const MIN_OUTPUT_TOKENS = 1024;
const TIER_RANK = { free: 0, byok: 0, paid: 1 };

// Largest max_tokens a pool can take for this prompt (0 = does not fit). Bounded by the
// model's output limit, the context window and the pool's tokens-per-minute budget
// (Groq's free org refuses a request whose prompt + max_tokens exceeds 8K TPM). The pool
// reservation holds less than this (capacity.js reservedTokens).
export function fitMaxTokens(entry, pool, promptTokens, requestedMaxTokens) {
  const requested = Math.min(requestedMaxTokens, entry.max_output_tokens);
  let room = entry.context_window - promptTokens;
  if (pool.limits?.tpm) room = Math.min(room, pool.limits.tpm - promptTokens);
  const allowed = Math.min(requested, room);
  return allowed >= 1 && allowed >= Math.min(requested, MIN_OUTPUT_TOKENS) ? allowed : 0;
}

function failure(error, extra = {}) {
  return { ok: false, error, ...extra };
}

// What a request needs from a model (chat-handler.js requestNeeds): tool calls, image input,
// streaming, a JSON response_format. Catalog entries declare supports_tools, supports_vision,
// supports_streaming and (where verified) supports_json_mode; an entry without a json flag is
// assumed to accept response_format, as every catalog upstream does today.
function lacks(entry, needs) {
  if (needs.tools && !entry.supports_tools) return 'tools';
  if (needs.vision && !entry.supports_vision) return 'vision';
  if (needs.stream && entry.supports_streaming === false) return 'streaming';
  if (needs.json && entry.supports_json_mode === false) return 'json_mode';
  return null;
}

const LACKS_MESSAGE = {
  tools: 'This model does not support tools; choose a tool-capable model.',
  vision: 'This model does not accept images; choose a vision model.',
  streaming: 'This model does not support streaming.',
  json_mode: 'This model does not support response_format JSON output.',
};

// A request that forces a tool call (requestNeeds forcedTool) is never given by auto to a provider
// type that takes tool_choice "auto" only (catalog-types.js tool_choice_auto_only: Z.ai), which
// could answer without the call. Asked for by name, such a model serves it unforced (providers.js
// buildUpstreamPayload).
function cannotForce(entry, needs) {
  return Boolean(needs.forcedTool) && Boolean(providerType(entry.provider)?.tool_choice_auto_only);
}

// A free pool of a provider type that runs a fixed number of requests at once (catalog-types.js
// free_concurrency: Z.ai's free GLM models, one per account) is the last resort of its tier: it
// goes after every other pool, degraded or spent ones included, and a conversation it served is
// not pinned to it (StickyChoices; chat-handler.js remembers only other models). Pinned, one
// fallback to it (say while Groq was busy) would put the conversation's next turns on a single
// slot ahead of every other pool, each turn reserving it first.
export function lastResort({ entry, pool }) {
  return pool.tier === 'free' && (providerType(entry.provider)?.free_concurrency ?? null) !== null;
}

// Shared health from the HealthHub snapshot ({status, until} per pool key): busy and blurred
// pools are skipped until their cooldown ends, so one isolate learns what another saw.
function sharedUnavailable(row, now) {
  return Boolean(row) && (row.status === 'busy' || row.status === 'blurred') && (row.until || 0) > now;
}

// FNV-1a: a stable 32-bit number for a caller id.
function hashText(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

// Rotates a model's vault-key pools (src/catalog.js entryPools) by `turn`, leaving every other
// pool where it is. Each caller starts on its own key, so callers spread over the keys while one
// conversation stays on one org or project (its prompt cache); failover reaches the others.
export function rotateKeyPools(verdicts, turn) {
  const slots = verdicts.map((verdict, index) => verdict.pool.key_id ? index : -1).filter(index => index >= 0);
  if (slots.length < 2) return verdicts;
  const shift = turn % slots.length;
  const rotated = [...verdicts];
  slots.forEach((slot, position) => { rotated[slot] = verdicts[slots[(position + shift) % slots.length]]; });
  return rotated;
}

// Conversations remember the model that served them, so a coding task does not switch models
// between turns while that model can still serve (per isolate, best effort).
export class StickyChoices {
  constructor({ ttlMs = 30 * 60_000, max = 5000 } = {}) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.choices = new Map(); // key -> { model, at }
  }

  get(key, now = Date.now()) {
    const choice = key ? this.choices.get(key) : null;
    if (!choice) return null;
    if (now - choice.at > this.ttlMs) { this.choices.delete(key); return null; }
    return choice.model;
  }

  remember(key, model, now = Date.now()) {
    if (!key || !model) return;
    this.choices.delete(key);
    if (this.choices.size >= this.max) this.choices.delete(this.choices.keys().next().value);
    this.choices.set(key, { model, at: now });
  }
}

/**
 * RoutingEngine - capability-, policy-, plan-, region-, size- and health-aware candidate
 * selection (docs/OIOP.md "Routing"). Returns ordered (model, pool) candidates; the chat handler
 * reserves capacity and fails over through them in order, so every fallback stays within the
 * capabilities the request needs.
 */
export class RoutingEngine {
  constructor(healthTracker = globalHealthTracker, sticky = new StickyChoices()) {
    this.healthTracker = healthTracker;
    this.sticky = sticky;
    this.turn = 0;
  }

  // Ordering penalty within a tier (lower first): pools that are degraded here or in the shared
  // snapshot, whose budget this isolate saw spent, or that fail often go after healthier ones.
  penalty(item, sharedHealth, budgetState, now) {
    let score = 0;
    const record = this.healthTracker.records?.get(item.key);
    const shared = sharedHealth?.get(item.key);
    if (record?.status === HealthState.DEGRADED || shared?.status === 'degraded') score += 2;
    // Error rate over the hub's recent window (every isolate's traffic), else this isolate's.
    if (shared?.samples >= 10 ? shared.error_rate >= 0.2
      : record && record.total_attempts >= 5 && record.successful_attempts / record.total_attempts < 0.8) score += 1;
    if ((budgetState?.(item.key, now)?.until || 0) > now) score += 3;
    return score;
  }

  // `maxTokens` is the client's max_tokens, or the gateway default when `maxTokensExplicit` is
  // false: then a model's own default_max_tokens applies instead (Claude counts thinking inside
  // max_tokens, so 4,096 would cut answers short), before the pool fit and the credit hold.
  // `affinity` (the caller) picks which vault key of a model is tried first; without one the
  // keys are taken in turn. `conversation` (chat-handler.js conversationKey) with the caller keys
  // the sticky model choice of `auto`. `policy` is the
  // caller's data policy (src/oiop/policy.js), `needs` what the request requires (lacks()),
  // `sharedHealth` the HealthHub rows by pool key and `budgetState` pool-budget.js's view.
  route({ env = {}, requestedModel, needsTools = false, needs = {}, promptTokens, maxTokens, maxTokensExplicit = true,
    tiers = ['free'], country = null, ownedCatalog = null, affinity = null, conversation = null, policy = DEFAULT_POLICY,
    sharedHealth = null, budgetState = null, now = Date.now() }) {
    const required = { ...needs, tools: Boolean(needs.tools || needsTools) };
    if (ownedCatalog) return this.routeOwned({ env, requestedModel, needs: required, maxTokens, ownedCatalog, policy });
    const resolved = resolveModelId(requestedModel, env);
    if (!resolved) return failure('model_not_found');
    const auto = resolved === AUTO_MODEL_ID;
    const offered = offeredEntries(env);
    let entries;
    if (auto) {
      entries = offered.filter(entry => entry.auto_rank != null && !lacks(entry, required) && !cannotForce(entry, required))
        .sort((left, right) => left.auto_rank - right.auto_rank);
    } else {
      const entry = offered.find(item => item.id === resolved);
      if (!entry) return failure('model_not_found');
      const missing = lacks(entry, required);
      if (missing) return failure('invalid_request', { message: LACKS_MESSAGE[missing] });
      entries = [entry];
    }

    const evaluated = [];
    const turn = affinity ? hashText(String(affinity)) : this.turn++;
    for (const entry of entries) {
      const requested = !maxTokensExplicit && entry.default_max_tokens > 0 ? entry.default_max_tokens : maxTokens;
      for (const verdict of rotateKeyPools(poolVerdicts(env, entry, tiers, country), turn)) {
        const key = poolKey(entry, verdict.pool);
        const fit = fitMaxTokens(entry, verdict.pool, promptTokens, requested);
        // Ruled out only by the pool's per-minute token budget, not by the context window.
        const overBudget = fit === 0 && Boolean(verdict.pool.limits?.tpm) &&
          fitMaxTokens(entry, { ...verdict.pool, limits: null }, promptTokens, requested) > 0;
        evaluated.push({ ...verdict, entry, key, fits: fit > 0, overBudget, maxTokens: fit,
          blocked: policyBlock(verdict.offer, policy),
          healthy: this.healthTracker.isAvailable(key, now) && !sharedUnavailable(sharedHealth?.get(key), now) });
      }
    }
    const sticky = auto && affinity && conversation ? `${affinity}|${conversation}` : null;
    const stickyModel = this.sticky.get(sticky, now);
    const usable = evaluated
      .filter(item => item.configured && !item.blocked && item.inPlan && item.region && item.fits && item.healthy)
      .map((item, index) => ({ item, index, penalty: this.penalty(item, sharedHealth, budgetState, now) }))
      // Free pools first, then paid; within a tier last-resort pools after the others, the
      // conversation's previous model first, then the healthier pools, then quality/pool order.
      .sort((left, right) => TIER_RANK[left.item.pool.tier] - TIER_RANK[right.item.pool.tier]
        || Number(lastResort(left.item)) - Number(lastResort(right.item))
        || Number(right.item.entry.id === stickyModel) - Number(left.item.entry.id === stickyModel)
        || left.penalty - right.penalty || left.index - right.index)
      .map(({ item }) => item);
    if (usable.length) {
      return {
        ok: true, auto, model: auto ? AUTO_MODEL_ID : entries[0].id, sticky,
        candidates: usable.map(({ entry, pool, key, offer, maxTokens: max }) => ({ entry, pool, key, offer, maxTokens: max })),
      };
    }
    return this.explain(evaluated, auto, now, policy);
  }

  // Remembers the model that served a conversation (`route().sticky`; chat-handler.js, after a
  // success).
  remember(sticky, model, now = Date.now()) {
    this.sticky.remember(sticky, model, now);
  }

  explain(evaluated, auto, now, policy = DEFAULT_POLICY) {
    const served = evaluated.filter(item => item.configured);
    if (!served.length) {
      return auto
        ? failure('service_unavailable', { message: 'No model is configured on this gateway.' })
        : failure('model_not_found', { message: 'This model is not available on this deployment.' });
    }
    // Everything that could serve is kept away by the caller's own data policy.
    const configured = served.filter(item => !item.blocked);
    if (!configured.length) {
      return failure('policy_restricted', {
        message: `No provider of ${auto ? 'any tool-capable model' : 'this model'} meets your data policy (${describePolicy(policy)}). ` +
          'Allow more trust tiers or training, or choose another model.',
      });
    }
    const unhealthy = configured.filter(item => item.inPlan && item.region && item.fits && !item.healthy);
    if (unhealthy.length) {
      const waits = unhealthy.map(item => this.healthTracker.cooldownRemainingMs(item.key, now));
      const retryAfterSeconds = Math.max(1, Math.ceil(Math.min(...waits) / 1000));
      const limited = unhealthy.some(item => [HealthState.RATE_LIMITED, HealthState.QUOTA_EXHAUSTED]
        .includes(this.healthTracker.getRecord(item.key).status));
      return failure(limited ? 'capacity_exhausted' : 'upstream_error', { retryAfterSeconds, pools: unhealthy.map(item => item.key) });
    }
    const locked = configured.filter(item => item.fits && !(item.inPlan && item.region));
    const paidWouldFit = locked.some(item => !item.inPlan && item.region);
    // The caller's own (free) pools would take the model but not a prompt this large within
    // their per-minute token budget: the request is too large, the model is not outside the plan.
    const overBudget = configured.filter(item => item.inPlan && item.region && item.overBudget);
    if (overBudget.length) {
      const budget = Math.max(...overBudget.map(item => item.pool.limits.tpm));
      return failure('context_length_exceeded', {
        upgrade: paidWouldFit,
        message: `This request is too large for the free per-minute token budget (${budget.toLocaleString('en-US')} tokens, prompt plus max_tokens). ` +
          `Shorten the conversation or lower max_tokens${paidWouldFit ? ', or upgrade for paid capacity' : ''}.`,
      });
    }
    if (paidWouldFit) {
      const regional = configured.some(item => item.inPlan && !item.region);
      return failure('upgrade_required', regional
        ? { message: 'The free tier of this model is not available in your region. Upgrade to use paid capacity.' }
        : {});
    }
    if (locked.length) return failure('region_unavailable');
    return failure('context_length_exceeded');
  }

  // Sessions using the caller's own OpenRouter key (BYOK): exact ids only, no budgets. The
  // offer's redistribution does not apply (the caller holds the account); its lifecycle and the
  // caller's data policy do.
  routeOwned({ env = {}, requestedModel, needs = {}, maxTokens, ownedCatalog, policy = DEFAULT_POLICY }) {
    const offer = offerById(env, BYOK_OFFERS.openrouter);
    if (!servesOwnKeys(offer)) return failure('service_unavailable', { message: 'Your own OpenRouter key cannot be used right now.' });
    if (policyBlock(offer, policy)) {
      return failure('policy_restricted', { message: `OpenRouter does not meet your data policy (${describePolicy(policy)}).` });
    }
    const value = typeof requestedModel === 'string' ? requestedModel.trim() : '';
    const bare = value.toLowerCase().startsWith('openai/') ? value.slice('openai/'.length) : value;
    const eligible = ownedCatalog.filter(entry => !lacks(entry, needs));
    const auto = [value, bare].some(id => id === AUTO_MODEL_ID || id === 'default');
    let entries;
    if (auto) {
      entries = eligible.slice(0, 2);
      if (!entries.length) return failure(ownedCatalog.length ? 'invalid_request' : 'model_not_found',
        ownedCatalog.length ? { message: 'None of your OpenRouter models support tools.' } : {});
    } else {
      const entry = ownedCatalog.find(item => item.id === value) || ownedCatalog.find(item => item.id === bare);
      if (!entry) return failure('model_not_found');
      const missing = lacks(entry, needs);
      if (missing) return failure('invalid_request', { message: LACKS_MESSAGE[missing] });
      entries = [entry];
    }
    return {
      ok: true, auto, model: auto ? AUTO_MODEL_ID : entries[0].id,
      candidates: entries.map(entry => ({ entry, pool: entry.pools[0], key: null, offer,
        maxTokens: Math.min(maxTokens, entry.max_output_tokens) })),
    };
  }
}

export const globalRouter = new RoutingEngine();

import { globalHealthTracker, HealthState } from './provider-health.js';
import {
  AUTO_MODEL_ID, loadPlanPolicies, offeredEntries, planPolicy, poolKey, poolVerdicts, resolveModelId,
} from './catalog.js';

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

/**
 * RoutingEngine - plan-, region-, size- and health-aware candidate selection.
 * Returns ordered (model, pool) candidates; the chat handler reserves capacity and
 * fails over through them in order.
 */
export class RoutingEngine {
  constructor(healthTracker = globalHealthTracker) {
    this.healthTracker = healthTracker;
    this.turn = 0;
  }

  // `affinity` (the caller) picks which vault key of a model is tried first; without one the
  // keys are taken in turn.
  route({ env = {}, requestedModel, needsTools = false, promptTokens, maxTokens, tiers = ['free'],
    country = null, ownedCatalog = null, affinity = null, now = Date.now() }) {
    if (ownedCatalog) return this.routeOwned({ requestedModel, needsTools, maxTokens, ownedCatalog });
    const resolved = resolveModelId(requestedModel, env);
    if (!resolved) return failure('model_not_found');
    const auto = resolved === AUTO_MODEL_ID;
    const offered = offeredEntries(env);
    let entries;
    if (auto) {
      entries = offered.filter(entry => entry.auto_rank != null && entry.supports_tools)
        .sort((left, right) => left.auto_rank - right.auto_rank);
    } else {
      const entry = offered.find(item => item.id === resolved);
      if (!entry) return failure('model_not_found');
      if (needsTools && !entry.supports_tools) {
        return failure('invalid_request', { message: 'This model does not support tools; choose a tool-capable model.' });
      }
      entries = [entry];
    }

    const evaluated = [];
    const turn = affinity ? hashText(String(affinity)) : this.turn++;
    for (const entry of entries) {
      for (const verdict of rotateKeyPools(poolVerdicts(env, entry, tiers, country), turn)) {
        const key = poolKey(entry, verdict.pool);
        const fit = fitMaxTokens(entry, verdict.pool, promptTokens, maxTokens);
        // Ruled out only by the pool's per-minute token budget, not by the context window.
        const overBudget = fit === 0 && Boolean(verdict.pool.limits?.tpm) &&
          fitMaxTokens(entry, { ...verdict.pool, limits: null }, promptTokens, maxTokens) > 0;
        evaluated.push({ ...verdict, entry, key, fits: fit > 0, overBudget, maxTokens: fit,
          healthy: this.healthTracker.isAvailable(key, now) });
      }
    }
    const usable = evaluated.filter(item => item.configured && item.inPlan && item.region && item.fits && item.healthy)
      // Stable sort: free pools first, then paid; within a tier keep quality/pool order.
      .sort((left, right) => TIER_RANK[left.pool.tier] - TIER_RANK[right.pool.tier]);
    if (usable.length) {
      return {
        ok: true, auto, model: auto ? AUTO_MODEL_ID : entries[0].id,
        candidates: usable.map(({ entry, pool, key, maxTokens: max }) => ({ entry, pool, key, maxTokens: max })),
      };
    }
    return this.explain(evaluated, auto, now);
  }

  explain(evaluated, auto, now) {
    const configured = evaluated.filter(item => item.configured);
    if (!configured.length) {
      return auto
        ? failure('service_unavailable', { message: 'No model is configured on this gateway.' })
        : failure('model_not_found', { message: 'This model is not available on this deployment.' });
    }
    const unhealthy = configured.filter(item => item.inPlan && item.region && item.fits && !item.healthy);
    if (unhealthy.length) {
      const waits = unhealthy.map(item => this.healthTracker.cooldownRemainingMs(item.key, now));
      const retryAfterSeconds = Math.max(1, Math.ceil(Math.min(...waits) / 1000));
      const limited = unhealthy.some(item => this.healthTracker.getRecord(item.key).status === HealthState.RATE_LIMITED);
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

  // Sessions using the caller's own OpenRouter key (BYOK): exact ids only, no budgets.
  routeOwned({ requestedModel, needsTools, maxTokens, ownedCatalog }) {
    const value = typeof requestedModel === 'string' ? requestedModel.trim() : '';
    const bare = value.toLowerCase().startsWith('openai/') ? value.slice('openai/'.length) : value;
    const eligible = ownedCatalog.filter(entry => !needsTools || entry.supports_tools);
    const auto = [value, bare].some(id => id === AUTO_MODEL_ID || id === 'default');
    let entries;
    if (auto) {
      entries = eligible.slice(0, 2);
      if (!entries.length) return failure(ownedCatalog.length ? 'invalid_request' : 'model_not_found',
        ownedCatalog.length ? { message: 'None of your OpenRouter models support tools.' } : {});
    } else {
      const entry = ownedCatalog.find(item => item.id === value) || ownedCatalog.find(item => item.id === bare);
      if (!entry) return failure('model_not_found');
      if (needsTools && !entry.supports_tools) {
        return failure('invalid_request', { message: 'This model does not support tools; choose a tool-capable model.' });
      }
      entries = [entry];
    }
    return {
      ok: true, auto, model: auto ? AUTO_MODEL_ID : entries[0].id,
      candidates: entries.map(entry => ({ entry, pool: entry.pools[0], key: null,
        maxTokens: Math.min(maxTokens, entry.max_output_tokens) })),
    };
  }
}

export const globalRouter = new RoutingEngine();

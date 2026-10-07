import { globalHealthTracker, HealthState } from './provider-health.js';

/**
 * RoutingEngine - Deterministic capability-aware model and provider router with failover for auto routes.
 */
export class RoutingEngine {
  constructor(healthTracker = globalHealthTracker) {
    this.healthTracker = healthTracker;
  }

  selectCandidates({ requestedModel, needsTools = false, catalog = [], allowFailover = true }) {
    if (!catalog.length) {
      return { primary: null, fallbacks: [], error: 'model_not_found' };
    }

    const isAuto = ['auto', 'default'].includes(requestedModel);

    if (isAuto) {
      // Filter models that support tools if tools are needed
      const eligible = catalog.filter(m => {
        if (needsTools && !m.tools) return false;
        return true;
      });

      if (!eligible.length) {
        return { primary: null, fallbacks: [], error: 'capability_unsupported' };
      }

      // Rank eligible models based on health and priority
      const ranked = this.rankCandidates(eligible);
      if (!ranked.length) {
        return { primary: null, fallbacks: [], error: 'all_providers_unavailable' };
      }

      const primary = ranked[0];
      const fallbacks = allowFailover ? ranked.slice(1) : [];
      return { primary, fallbacks, error: null };
    }

    // Specific model requested - do not silently fall back to a different model.
    // Normalize OpenAI transport prefix (e.g., openai/gemini/gemini-2.5-flash -> gemini/gemini-2.5-flash).
    const cleanRequested = (requestedModel || '').replace(/^openai\//, '');
    const specific = catalog.find(m =>
      m.id === requestedModel ||
      m.id === cleanRequested ||
      m.upstream === cleanRequested ||
      m.upstream === requestedModel ||
      (m.id.includes('/') && m.id.split('/')[1] === cleanRequested)
    );
    if (!specific) {
      return { primary: null, fallbacks: [], error: 'model_not_found' };
    }

    if (needsTools && !specific.tools) {
      return { primary: null, fallbacks: [], error: 'capability_unsupported' };
    }

    return { primary: specific, fallbacks: [], error: null };
  }

  rankCandidates(candidates) {
    return [...candidates].sort((a, b) => {
      const aAvail = this.healthTracker.isAvailable(a.provider) ? 1 : 0;
      const bAvail = this.healthTracker.isAvailable(b.provider) ? 1 : 0;
      if (aAvail !== bAvail) return bAvail - aAvail;

      const aRec = this.healthTracker.getRecord(a.provider);
      const bRec = this.healthTracker.getRecord(b.provider);

      // Prefer HEALTHY over DEGRADED
      const stateScore = state => (state === HealthState.HEALTHY ? 2 : state === HealthState.DEGRADED ? 1 : 0);
      const aScore = stateScore(aRec.status);
      const bScore = stateScore(bRec.status);
      if (aScore !== bScore) return bScore - aScore;

      // Prefer tool-capable models
      if (a.tools !== b.tools) return (b.tools ? 1 : 0) - (a.tools ? 1 : 0);

      // Deterministic priority: Cloudflare first, then others in catalog order
      if (a.provider === 'cloudflare' && b.provider !== 'cloudflare') return -1;
      if (b.provider === 'cloudflare' && a.provider !== 'cloudflare') return 1;

      return 0;
    });
  }
}

export const globalRouter = new RoutingEngine();

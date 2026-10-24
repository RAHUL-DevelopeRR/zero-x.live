// Model facts and logos from models.dev (docs/OIOP.md "Catalog"). The catalog keeps its own
// verified flags (tools, streaming, vision, context) for routing; models.dev adds what clients
// show: family, release date, knowledge cutoff, open weights, structured output, list prices.
// The cron refreshes a compact copy for catalog models once a day into KV
// (refreshModelsDevFacts); /v1/models reads it (modelsDevFacts, 10 min per isolate) and never
// fetches models.dev itself. Logos are models.dev/logos/<provider>.svg, falling back to the
// provider's favicon.
import { MODELS_DEV_URL } from '../discovery/sources.js';

// Gateway provider -> models.dev provider id (the catalog's upstream ids match models.dev's).
export const MODELS_DEV_PROVIDERS = Object.freeze({
  gemini: 'google', groq: 'groq', cloudflare: 'cloudflare-workers-ai', nvidia: 'nvidia', openrouter: 'openrouter',
});

export const PROVIDER_INFO = Object.freeze({
  gemini: Object.freeze({ name: 'Google', homepage: 'https://ai.google.dev' }),
  groq: Object.freeze({ name: 'Groq', homepage: 'https://groq.com' }),
  cloudflare: Object.freeze({ name: 'Cloudflare Workers AI', homepage: 'https://developers.cloudflare.com/workers-ai/' }),
  nvidia: Object.freeze({ name: 'NVIDIA', homepage: 'https://build.nvidia.com' }),
  openrouter: Object.freeze({ name: 'OpenRouter', homepage: 'https://openrouter.ai' }),
});

export const FACTS_KV_KEY = 'oiop:models-dev:v1';
const REFRESH_MS = 24 * 3600_000;
const RETRY_MS = 3600_000;
const READ_TTL_MS = 10 * 60_000;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function modelsDevId(entry) {
  const provider = MODELS_DEV_PROVIDERS[entry?.provider];
  return provider ? `${provider}/${entry.upstream_model}` : null;
}

// Provider block of a /v1/models entry: display name, logo and a favicon fallback.
export function providerInfo(provider, offer = null) {
  const info = PROVIDER_INFO[provider];
  const slug = MODELS_DEV_PROVIDERS[provider] || (SLUG.test(provider) ? provider : null);
  const homepage = info?.homepage || offer?.homepage || null;
  let favicon = null;
  try { favicon = homepage ? new URL('/favicon.ico', homepage).href : null; } catch { /* no fallback */ }
  return {
    id: provider,
    name: info?.name || offer?.name || provider,
    logo_url: offer?.logo_url || (slug ? `https://models.dev/logos/${slug}.svg` : null),
    logo_fallback_url: favicon,
  };
}

const text = (value, max = 120) => (typeof value === 'string' && value ? value.slice(0, max) : null);
const bool = value => (typeof value === 'boolean' ? value : null);
const price = value => (Number.isFinite(value) && value >= 0 ? value : null);

// The facts kept for one models.dev model record.
export function compactFact(model) {
  return {
    name: text(model.name), family: text(model.family), canonical_model_id: text(model.canonical_model_id, 200),
    release_date: text(model.release_date, 10), knowledge: text(model.knowledge, 10),
    open_weights: bool(model.open_weights), reasoning: bool(model.reasoning), structured_output: bool(model.structured_output),
    modalities: {
      input: Array.isArray(model.modalities?.input) ? model.modalities.input.filter(item => typeof item === 'string').slice(0, 8) : [],
      output: Array.isArray(model.modalities?.output) ? model.modalities.output.filter(item => typeof item === 'string').slice(0, 8) : [],
    },
    list_price_per_million: { input: price(model.cost?.input), output: price(model.cost?.output) },
  };
}

// Facts for the catalog entries found in a models.dev api.json document, by public model id.
export function factsForEntries(document, entries) {
  const facts = {};
  for (const entry of entries) {
    const provider = MODELS_DEV_PROVIDERS[entry.provider];
    const model = provider ? document?.[provider]?.models?.[entry.upstream_model] : null;
    if (model && typeof model === 'object') facts[entry.id] = { models_dev_id: modelsDevId(entry), ...compactFact(model) };
  }
  return facts;
}

/**
 * Cron: refreshes the stored facts when they are older than a day (an hour after a failure).
 * Returns { refreshed, models } or { skipped }. Without KV there is nowhere to keep them.
 */
export async function refreshModelsDevFacts(env, entries, { now = Date.now(), fetchImpl = (...args) => fetch(...args) } = {}) {
  const kv = env?.SESSIONS_KV;
  if (!kv) return { skipped: 'no_kv' };
  const stored = await kv.get(FACTS_KV_KEY, 'json').catch(() => null);
  const due = stored?.failed_at ? Date.parse(stored.failed_at) + RETRY_MS : Date.parse(stored?.fetched_at || 0) + REFRESH_MS;
  if (stored && Number.isFinite(due) && due > now) return { skipped: 'fresh' };
  try {
    const response = await fetchImpl(MODELS_DEV_URL, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`models.dev answered ${response.status}`);
    const facts = factsForEntries(await response.json(), entries);
    await kv.put(FACTS_KV_KEY, JSON.stringify({ fetched_at: new Date(now).toISOString(), facts }));
    cache = null;
    return { refreshed: true, models: Object.keys(facts).length };
  } catch (error) {
    await kv.put(FACTS_KV_KEY, JSON.stringify({ ...(stored || { facts: {} }), failed_at: new Date(now).toISOString() })).catch(() => {});
    console.warn('models.dev facts refresh failed', { message: String(error?.message).slice(0, 200) });
    return { refreshed: false };
  }
}

let cache = null; // { at, facts }

// The stored facts by public model id ({} until the cron has stored them).
export async function modelsDevFacts(env, now = Date.now()) {
  const kv = env?.SESSIONS_KV;
  if (!kv) return {};
  if (cache && now - cache.at < READ_TTL_MS) return cache.facts;
  const stored = await kv.get(FACTS_KV_KEY, 'json').catch(() => null);
  cache = { at: now, facts: stored?.facts && typeof stored.facts === 'object' ? stored.facts : {} };
  return cache.facts;
}

// Test hook.
export function resetModelsDevCache() {
  cache = null;
}

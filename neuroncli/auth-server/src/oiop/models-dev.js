// Model facts and logos from models.dev (docs/OIOP.md "Catalog"). The catalog keeps its own
// verified flags (tools, streaming, vision, context) for routing; models.dev adds what clients
// show: family, release date, knowledge cutoff, open weights, structured output, list prices.
// The cron refreshes a compact copy for catalog models once a day (refreshModelsDevFacts);
// /v1/models reads it (modelsDevFacts, 10 min per isolate) and never fetches models.dev itself.
// Logos are models.dev/logos/<provider>.svg, falling back to the provider's favicon.
//
// The copy lives in the Postgres record store (gateway_session_store, src/session-store.js)
// whenever the database is configured, so the Node server and a Worker whose SESSIONS_KV is
// unbound share it; in KV only without a database. While a Worker has both (the move off KV), it
// writes Postgres and reads KV only as long as Postgres holds no facts: the first refresh after the
// deploy fills Postgres at once, however fresh KV's copy is, and a failed one carries KV's facts over.
import { MODELS_DEV_URL } from '../discovery/sources.js';
import { PROVIDER_TYPES } from '../catalog-types.js';
import { databaseRecordStore } from '../session-store.js';

// Gateway provider -> models.dev provider id (the catalog's upstream ids match models.dev's) and
// the provider's display name and homepage, both from the provider-type registry
// (src/catalog-types.js), so a new provider type is described in one place.
export const MODELS_DEV_PROVIDERS = Object.freeze(Object.fromEntries(Object.entries(PROVIDER_TYPES)
  .filter(([, registry]) => registry.models_dev).map(([id, registry]) => [id, registry.models_dev])));

export const PROVIDER_INFO = Object.freeze(Object.fromEntries(Object.entries(PROVIDER_TYPES)
  .filter(([, registry]) => registry.info).map(([id, registry]) => [id, registry.info])));

// The record's key in either store (the Postgres store hashes it, like every key it holds).
export const FACTS_KV_KEY = 'oiop:models-dev:v1';
const REFRESH_MS = 24 * 3600_000;
const RETRY_MS = 3600_000;
const READ_TTL_MS = 10 * 60_000;
// The Postgres store's longest TTL; every daily refresh (or hourly retry) writes it again.
const FACTS_TTL_SECONDS = 7 * 24 * 3600;
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

// Where the facts are kept (`primary`, written and read first) and where older facts may still be
// (`fallback`: KV while a Worker still has it beside the database).
function factStores(env) {
  const database = databaseRecordStore(env ?? {});
  const kv = env?.SESSIONS_KV || null;
  return { primary: database || kv, fallback: database ? kv : null };
}

// A store's record, or null when it has none or cannot be read.
async function readStored(store) {
  if (!store) return null;
  try {
    const text = await store.get(FACTS_KV_KEY);
    const stored = text ? JSON.parse(text) : null;
    return stored && typeof stored === 'object' ? stored : null;
  } catch {
    return null;
  }
}

const hasFacts = stored => Boolean(stored?.facts && typeof stored.facts === 'object' && Object.keys(stored.facts).length);

/**
 * Cron: refreshes the stored facts when they are older than a day (an hour after a failure).
 * Returns { refreshed, models } or { skipped }. Without a database or KV there is nowhere to keep them.
 */
export async function refreshModelsDevFacts(env, entries, { now = Date.now(), fetchImpl = (...args) => fetch(...args) } = {}) {
  const { primary, fallback } = factStores(env);
  if (!primary) return { skipped: 'no_store' };
  const stored = await readStored(primary);
  const due = stored?.failed_at ? Date.parse(stored.failed_at) + RETRY_MS : Date.parse(stored?.fetched_at || 0) + REFRESH_MS;
  if (stored && Number.isFinite(due) && due > now) return { skipped: 'fresh' };
  const write = record => primary.put(FACTS_KV_KEY, JSON.stringify(record), { expirationTtl: FACTS_TTL_SECONDS });
  try {
    const response = await fetchImpl(MODELS_DEV_URL, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`models.dev answered ${response.status}`);
    const facts = factsForEntries(await response.json(), entries);
    await write({ fetched_at: new Date(now).toISOString(), facts });
    cache = null;
    return { refreshed: true, models: Object.keys(facts).length };
  } catch (error) {
    // The last facts stay (KV's, while Postgres has none yet) and the refresh is retried in an hour.
    const kept = stored || await readStored(fallback) || { facts: {} };
    await write({ ...kept, failed_at: new Date(now).toISOString() }).catch(() => {});
    console.warn('models.dev facts refresh failed', { message: String(error?.message).slice(0, 200) });
    return { refreshed: false };
  }
}

let cache = null; // { at, facts }

// The stored facts by public model id ({} until the cron has stored them).
export async function modelsDevFacts(env, now = Date.now()) {
  const { primary, fallback } = factStores(env);
  if (!primary) return {};
  if (cache && now - cache.at < READ_TTL_MS) return cache.facts;
  let stored = await readStored(primary);
  if (!hasFacts(stored)) stored = (await readStored(fallback)) || stored;
  cache = { at: now, facts: stored?.facts && typeof stored.facts === 'object' ? stored.facts : {} };
  return cache.facts;
}

// Test hook.
export function resetModelsDevCache() {
  cache = null;
}

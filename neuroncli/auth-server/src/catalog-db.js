// Data-driven catalog loader (docs/PLATFORM_CONTRACT.md §2). Model rows live in Postgres
// (migration 20261029000600_catalog_models.sql) and are read through zerox_catalog_snapshot every
// 45 s per isolate (a change is visible everywhere within a minute, at once in the isolate that
// approved it). Code stays the floor:
//   - CATALOG_SOURCE=code (kill switch) or no database: the code catalog, exactly as before.
//   - The database does not answer: the last snapshot that loaded, else the code catalog
//     (retried every 10 s, logged once per failure streak).
//   - Merge, per model id: an active row is served from its approved revision once it passes the
//     guardrails (src/catalog-guardrails.js); a pool that fails is dropped, a model that fails
//     falls back to its code entry (or is not served). A disabled row is not served and hides the
//     code entry with its id too, so disabling works for code models. A draft row (never
//     approved) changes nothing: the code entry, if any, keeps serving. Code models without a row
//     are served from code.
//
// src/catalog.js accessors (catalogEntries, catalogEntry, lookup and so resolveModelId, describeAuto
// with env) read catalogSnapshot(env); callers that route or list models await loadCatalog(env)
// first (loadCatalogDbModels is kept as an alias). This module reads CATALOG only inside
// functions, so catalog.js imports it back without a cycle problem.
import { databaseConfigured, rpcRows } from './account-store.js';
import { CATALOG } from './catalog.js';
import { CLAUDE_MODEL_SPECS } from './catalog-claude.js';
import { publicIdFor } from './catalog-types.js';
import { canonicalSpec, codeSpec, droppedTiers, entryFromSpec, normalizeSpec, specFromRow, validateSpec } from './catalog-guardrails.js';

export const CATALOG_TTL_MS = 45_000;
export const CATALOG_RETRY_MS = 10_000;
export const LOAD_WAIT_MS = 3_000;

// FNV-1a over two lanes: 16 hex characters that change whenever what is served changes.
function hash64(text) {
  let a = 0x811c9dc5;
  let b = 0xcbf29ce4;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x01000197) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

// ── Code catalog ──

let codeCache = null;

// The code catalog as { items: [{ id, entry, spec }], byId: Map<lower id, item>, hash }: src/catalog.js
// CATALOG (position = catalog order x 10) plus the Claude specs it does not list itself.
export function codeCatalog() {
  if (codeCache?.catalog === CATALOG) return codeCache;
  const items = CATALOG.map((entry, index) => ({ id: entry.id, entry, spec: codeSpec(entry, { position: (index + 1) * 10 }) }));
  const ids = new Set(items.map(item => item.id.toLowerCase()));
  for (const spec of CLAUDE_MODEL_SPECS) {
    const id = publicIdFor(spec.provider_type, spec.upstream_model);
    if (!id || ids.has(id)) continue;
    ids.add(id);
    items.push({ id, entry: entryFromSpec(id, spec, { source: 'code' }), spec: normalizeSpec(spec) });
  }
  const hash = hash64(items.map(item => `${item.id}=${canonicalSpec(item.spec)}`).join('\n'));
  codeCache = { catalog: CATALOG, items, byId: new Map(items.map(item => [item.id.toLowerCase(), item])), hash };
  return codeCache;
}

// A code item as it may serve at `now`: the entry itself, or rebuilt without pools that fail the
// guardrails (for example a paid pool after its list price changed). null when nothing may serve.
function servedCodeItem(item, now) {
  const validation = validateSpec(item.id, item.spec, { now });
  const dropped = droppedTiers(validation);
  const usable = item.spec.pools.filter(pool => !dropped.includes(pool.tier));
  if (validation.model.length || !usable.length) return { entry: null, reasons: validation.model, dropped };
  const entry = dropped.length ? entryFromSpec(item.id, item.spec, { dropPools: dropped, source: 'code' }) : item.entry;
  return { entry, reasons: [], dropped };
}

const positionOf = spec => (Number.isSafeInteger(spec?.position) ? spec.position : 100_000);

// resolveModelId (src/catalog.js) reads `openai/X` as X whenever `openai/X` itself names nothing.
export const TRANSPORT_PREFIX = 'openai/';

// Ids and aliases of the code catalog -> the code model they name. They always resolve to that
// model (or to nothing while it is disabled), never to another row, whatever its position. The
// same names behind the `openai/` transport prefix are reserved too: without them a row could take
// the alias `openai/<code alias>` and catch requests the code model answers today.
export function reservedAliases(code = codeCatalog()) {
  if (code.reserved) return code.reserved;
  const reserved = new Map();
  for (const item of code.items) {
    reserved.set(item.id.toLowerCase(), item.id);
    for (const alias of item.spec.aliases) if (!reserved.has(String(alias).toLowerCase())) reserved.set(String(alias).toLowerCase(), item.id);
  }
  for (const [name, owner] of [...reserved]) {
    if (!reserved.has(TRANSPORT_PREFIX + name)) reserved.set(TRANSPORT_PREFIX + name, owner);
  }
  code.reserved = reserved;
  return reserved;
}

function finalize({ source, served, verdicts, warnings, failing, now, code }) {
  // served: [{ entry, position }] in merge order; listed by position, then merge order.
  const entries = served.map((item, index) => ({ ...item, index }))
    .sort((a, b) => a.position - b.position || a.index - b.index).map(item => item.entry);
  const byId = new Map(entries.map(entry => [entry.id.toLowerCase(), entry]));
  // Aliases: models with a code entry first, then the others, each in list order. A row's
  // position orders /v1/models only; it can never take a code id or alias from its model.
  const reserved = reservedAliases(code);
  const aliases = new Map([['default', 'auto']]);
  const isCode = entry => code.byId.has(entry.id.toLowerCase());
  for (const entry of [...entries.filter(isCode), ...entries.filter(entry => !isCode(entry))]) {
    for (const alias of entry.aliases) {
      const lower = String(alias).toLowerCase();
      const owner = reserved.get(lower);
      if (byId.has(lower) || lower === 'auto' || aliases.has(lower) || (owner && owner !== entry.id)) {
        warnings.push({ model: entry.id, alias, reason: 'alias_conflict' });
        continue;
      }
      aliases.set(lower, entry.id);
    }
  }
  // An alias `openai/X` may only point where X does (for rows without a code entry too): otherwise
  // it takes the requests OpenAI-compatible clients send for X with the transport prefix.
  for (const [lower, owner] of [...aliases]) {
    if (!lower.startsWith(TRANSPORT_PREFIX)) continue;
    const rest = lower.slice(TRANSPORT_PREFIX.length);
    const target = rest === 'auto' ? 'auto' : byId.get(rest)?.id ?? aliases.get(rest);
    if (target && target !== owner) {
      aliases.delete(lower);
      warnings.push({ model: owner, alias: lower, reason: 'alias_conflict' });
    }
  }
  const version = hash64([source, code.hash, ...entries.map(entry =>
    `${entry.id}:${entry.source ?? 'code'}:${entry.revision_id ?? ''}:${entry.pools.map(pool => pool.tier).join('+')}`)].join('|'));
  return Object.freeze({
    source, version, entries: Object.freeze(entries), byId, aliases, verdicts, warnings: Object.freeze(warnings),
    loadedAt: now, failing,
  });
}

/**
 * Builds the served catalog from zerox_catalog_snapshot rows (see the header for the merge
 * rules). Pure: no I/O. Rows: { id, provider_type, status, revision_id, revision, spec }.
 */
export function buildSnapshot(rows, { now = Date.now(), failing = false } = {}) {
  const code = codeCatalog();
  const seen = new Set();
  const served = [];
  const verdicts = new Map();
  const warnings = [];
  const ordered = (Array.isArray(rows) ? rows : []).filter(row => row && typeof row.id === 'string')
    .map((row, index) => ({ row, index, position: positionOf(row.spec) }))
    .sort((a, b) => a.position - b.position || a.index - b.index).map(item => item.row);
  for (const row of ordered) {
    const id = row.id;
    const lower = id.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    const fallback = code.byId.get(lower);
    const verdict = { status: row.status, revision_id: row.revision_id ?? null, served_from: 'none', reasons: [], dropped_pools: [] };
    verdicts.set(id, verdict);
    if (row.status === 'disabled') continue;
    if (row.status !== 'active') {
      // Never approved: the row is a proposal only.
      if (fallback) {
        const item = servedCodeItem(fallback, now);
        if (item.entry) {
          served.push({ entry: item.entry, position: positionOf(fallback.spec) });
          Object.assign(verdict, { served_from: 'code', dropped_pools: item.dropped });
        }
      }
      continue;
    }
    const spec = specFromRow(row);
    const validation = validateSpec(id, spec, { now });
    const dropped = droppedTiers(validation);
    const usable = Array.isArray(spec.pools) ? spec.pools.filter(pool => !dropped.includes(pool.tier)) : [];
    if (validation.model.length || !usable.length) {
      verdict.reasons = validation.model.length ? validation.model : ['no_usable_pools'];
      verdict.dropped_pools = dropped;
      if (fallback) {
        const item = servedCodeItem(fallback, now);
        if (item.entry) { served.push({ entry: item.entry, position: positionOf(fallback.spec) }); verdict.served_from = 'code'; }
      }
      continue;
    }
    served.push({ entry: entryFromSpec(id, spec, { dropPools: dropped, source: 'database', revisionId: row.revision_id ?? null }),
      position: positionOf(spec) });
    Object.assign(verdict, { served_from: 'database', dropped_pools: dropped,
      reasons: dropped.flatMap(tier => validation.pools[tier].map(reason => `${tier}:${reason}`)) });
  }
  for (const item of code.items) {
    if (seen.has(item.id.toLowerCase())) continue;
    const codeServed = servedCodeItem(item, now);
    verdicts.set(item.id, { status: 'code', revision_id: null, served_from: codeServed.entry ? 'code' : 'none',
      reasons: codeServed.reasons, dropped_pools: codeServed.dropped });
    if (codeServed.entry) served.push({ entry: codeServed.entry, position: positionOf(item.spec) });
  }
  return finalize({ source: 'database', served, verdicts, warnings, failing, now, code });
}

const codeSnapshots = new Map(); // UTC day -> snapshot (list prices are effective-dated per day)

// The code catalog as a snapshot (CATALOG_SOURCE=code, no database, or nothing loaded yet).
export function codeSnapshot(now = Date.now()) {
  const day = Math.floor(now / 86_400_000);
  const code = codeCatalog();
  const cached = codeSnapshots.get(day);
  if (cached?.code === code) return cached.snapshot;
  const served = [];
  const verdicts = new Map();
  for (const item of code.items) {
    const result = servedCodeItem(item, now);
    verdicts.set(item.id, { status: 'code', revision_id: null, served_from: result.entry ? 'code' : 'none',
      reasons: result.reasons, dropped_pools: result.dropped });
    if (result.entry) served.push({ entry: result.entry, position: positionOf(item.spec) });
  }
  const snapshot = finalize({ source: 'code', served, verdicts, warnings: [], failing: false, now, code });
  codeSnapshots.clear();
  codeSnapshots.set(day, { code, snapshot });
  return snapshot;
}

// ── Per-isolate cache ──

const states = new WeakMap(); // env -> { snapshot, expires, pending, seq, applied, failing }
const warnedDbModels = new WeakSet();

// 'code' with CATALOG_SOURCE=code or without a database, otherwise 'database'.
export function catalogSource(env) {
  if (String(env?.CATALOG_SOURCE ?? '').trim().toLowerCase() === 'code') return 'code';
  return env && typeof env === 'object' && databaseConfigured(env) ? 'database' : 'code';
}

// The catalog this isolate serves for `env` right now (synchronous; never throws).
export function catalogSnapshot(env) {
  if (catalogSource(env) === 'code') return codeSnapshot();
  return states.get(env)?.snapshot || codeSnapshot();
}

// { source, version, loaded_at, failing } for the admin page and /v1/models/status.
export function catalogStatus(env) {
  const snapshot = catalogSnapshot(env);
  const state = catalogSource(env) === 'database' ? states.get(env) : null;
  return { source: snapshot.source, version: snapshot.version, loaded_at: new Date(snapshot.loadedAt).toISOString(),
    failing: Boolean(state?.failing) };
}

async function settle(env, pending, wait) {
  if (!Number.isFinite(wait)) return pending;
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(catalogSnapshot(env)), Math.max(0, wait)); });
  try { return await Promise.race([pending, timeout]); } finally { clearTimeout(timer); }
}

/**
 * Loads the catalog rows for `env` (45 s cache, deduplicated per isolate) and returns the served
 * snapshot. Never throws. `force` starts a fresh load (after an approval); `wait` bounds how long
 * a slow database may delay the caller, who then gets the current snapshot while the load
 * finishes in the background.
 */
export async function loadCatalog(env, { force = false, wait = LOAD_WAIT_MS, now } = {}) {
  if (env && typeof env === 'object' && env.CATALOG_DB_MODELS === 'true' && !warnedDbModels.has(env)) {
    warnedDbModels.add(env);
    console.warn('Neuron catalog ignores CATALOG_DB_MODELS: promoted discovery models are catalog rows now, served once approved on /admin/models');
  }
  if (catalogSource(env) === 'code') return codeSnapshot();
  let state = states.get(env);
  if (!state) states.set(env, state = { snapshot: null, expires: 0, pending: null, seq: 0, applied: 0, failing: false });
  if (!force && state.snapshot && state.expires > Date.now()) return state.snapshot;
  if (!force && state.pending) return settle(env, state.pending, wait);
  const seq = ++state.seq;
  const pending = (async () => {
    try {
      const rows = await rpcRows(env, 'zerox_catalog_snapshot', {});
      const snapshot = buildSnapshot(rows, { now: now ?? Date.now() });
      if (seq > state.applied) {
        state.snapshot = snapshot;
        state.applied = seq;
      }
      state.expires = Date.now() + CATALOG_TTL_MS;
      state.failing = false;
    } catch (error) {
      if (!state.failing) {
        console.error('Neuron catalog rows unavailable; serving the last catalog that loaded', { name: error?.name });
      }
      state.failing = true;
      state.expires = Date.now() + CATALOG_RETRY_MS;
    } finally {
      if (state.pending === pending) state.pending = null;
    }
    return catalogSnapshot(env);
  })();
  state.pending = pending;
  return settle(env, pending, wait);
}

// Drops this isolate's cached rows for `env` (tests, admin changes).
export function resetCatalogCache(env) {
  if (env && typeof env === 'object') states.delete(env);
}

// Compatibility with the discovery-model loader it replaces: resolves to the served entries.
export async function loadCatalogDbModels(env) {
  return (await loadCatalog(env)).entries;
}

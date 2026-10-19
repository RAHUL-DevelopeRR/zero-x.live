// Discovery jobs on the existing 10-minute cron (src/index.js scheduled). Each tick claims the
// jobs that are due (zerox_discovery_claim) and runs them:
//   list:<source>  daily   public no-key model lists (sources.js): queue new free, tool-capable
//                          models with >= 64K context; mark catalog entries whose upstream id is
//                          gone in HealthHub
//   omniroute      weekly  OmniRoute's MIT free-tier catalog (omniroute.js)
//   research       weekly  Claude with web search, only with ANTHROPIC_API_KEY (research.js)
// Jobs only ever create or refresh candidates. Approval, verification and promotion are
// operator actions (src/routes/discovery.js); signing up to a provider stays manual.
import { databaseConfigured, rpcRows } from '../account-store.js';
import { entryPools, loadCatalogDbModels, offeredEntries, poolKey } from '../catalog.js';
import { markPoolsUnavailable } from '../health-hub-client.js';
import { globalHealthTracker } from '../provider-health.js';
import { loadVaultKeys } from '../provider-keys.js';
import { candidateRow, evaluateOffer } from './policy.js';
import { LIST_SOURCES, MODELS_DEV_URL } from './sources.js';
import { OMNIROUTE_CATALOG_URL, MIN_ENTRIES, omnirouteDiff, parseOmnirouteCatalog } from './omniroute.js';
import { runResearch } from './research.js';

const HOUR = 3600;
export const DAY = 24 * HOUR;
export const WEEK = 7 * DAY;
// Retry delays after a failure: a list soon, a paid research call only the next day.
const RETRY_SECONDS = { list: HOUR, omniroute: 6 * HOUR, research: DAY };
const FETCH_TIMEOUT_MS = 20_000;
const MAX_LIST_BYTES = 16 * 1024 * 1024;
const UPSERT_CHUNK = 500;
const SUMMARY_IDS = 50;

export const JOB_INTERVALS = Object.freeze({
  ...Object.fromEntries(LIST_SOURCES.map(source => [source.job, DAY])), omniroute: WEEK, research: WEEK,
});

export function discoveryJobs(env) {
  return [...LIST_SOURCES.map(source => source.job), 'omniroute', ...(env?.ANTHROPIC_API_KEY ? ['research'] : [])];
}

async function fetchBody(url, kind = 'json') {
  const response = await fetch(url, {
    headers: { Accept: kind === 'json' ? 'application/json' : 'text/plain', 'User-Agent': 'zero-x-discovery/1.0' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow',
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`${new URL(url).host} answered ${response.status}`);
  }
  const length = Number(response.headers.get('content-length'));
  if (length > MAX_LIST_BYTES) {
    await response.body?.cancel();
    throw new Error(`${new URL(url).host} sent ${length} bytes`);
  }
  const text = await response.text();
  if (text.length > MAX_LIST_BYTES) throw new Error(`${new URL(url).host} sent more than 16 MB`);
  if (kind !== 'json') return text;
  try { return JSON.parse(text); } catch { throw new Error(`${new URL(url).host} sent invalid JSON`); }
}

async function upsert(env, rows) {
  const results = [];
  for (let index = 0; index < rows.length; index += UPSERT_CHUNK) {
    results.push(...await rpcRows(env, 'zerox_candidates_upsert', { p_rows: rows.slice(index, index + UPSERT_CHUNK) }));
  }
  return results;
}

const label = row => (row.model_id ? `${row.provider}/${row.model_id}` : row.provider);
const firstIds = list => list.slice(0, SUMMARY_IDS);

/**
 * Catalog entries of `provider` (code-defined and promoted) whose upstream id is not in `ids`
 * are marked model_unavailable in HealthHub. A list that drops more than half of them (and
 * more than one) is treated as broken and marks nothing.
 */
export async function markMissingCatalogModels(env, provider, ids) {
  await Promise.all([loadCatalogDbModels(env), loadVaultKeys(env)]);
  const entries = offeredEntries(env).filter(entry => entry.provider === provider);
  const missing = entries.filter(entry => !ids.has(entry.upstream_model));
  if (!missing.length) return { missing: [], marked: 0 };
  if (missing.length > 1 && missing.length > entries.length / 2) {
    return { missing: missing.map(entry => entry.id), marked: 0, skipped: 'list dropped most catalog models; not trusted' };
  }
  // Every pool of the entry, including one per vault key.
  const keys = missing.flatMap(entry => entryPools(env, entry).map(pool => poolKey(entry, pool)));
  const marked = await markPoolsUnavailable(env, keys, globalHealthTracker);
  return { missing: missing.map(entry => entry.id), marked };
}

export async function runListJob(env, source, state, context) {
  const [body, catalog] = await Promise.all([fetchBody(source.url),
    source.modelsDev ? context.modelsDev().catch(() => null) : null]);
  const modelsDev = catalog?.[source.modelsDev] ?? null;
  const items = source.parse(body, modelsDev);
  if (!items.length) throw new Error('the list is empty');
  const free = items.filter(item => item.chat && item.free);
  const qualifying = free.filter(item => evaluateOffer({ tools: item.tools, context: item.context }).status === 'new');
  const rows = qualifying.map(item => candidateRow({
    source: source.job, provider: source.provider, model: item.id, displayName: item.name, context: item.context,
    maxOutput: item.maxOutput, tools: item.tools, vision: item.vision,
    evidenceUrl: source.page ? source.page(item.id) : source.url,
    notes: item.deprecated ? 'models.dev marks this model deprecated.' : null, record: { list: source.url },
  }, { status: 'new', reason: null })).filter(Boolean);
  const upserted = await upsert(env, rows);
  const listed = free.map(item => item.id);
  const sync = listed.length
    ? (await rpcRows(env, 'zerox_candidates_sync_listed', { p_provider: source.provider, p_model_ids: listed }))[0] : null;

  const previous = Array.isArray(state.snapshot?.qualifying) ? new Set(state.snapshot.qualifying) : null;
  const current = qualifying.map(item => item.id).sort();
  const summary = {
    listed: items.length, free: free.length, qualifying: current.length,
    added: previous ? firstIds(current.filter(id => !previous.has(id))) : null,
    removed: previous ? firstIds([...previous].filter(id => !current.includes(id))) : null,
    new_candidates: firstIds(upserted.filter(row => row.inserted && row.status === 'new').map(label)),
    seen: sync?.seen ?? 0, gone: sync?.gone ?? 0,
  };
  if (source.modelsDev && !modelsDev) summary.enrichment = 'models.dev unavailable: capabilities unknown, nothing queued';
  if (source.catalog) {
    try {
      Object.assign(summary, await markMissingCatalogModels(env, source.catalog, new Set(items.map(item => item.id))));
    } catch (error) {
      summary.health_hub_error = String(error?.message || error).slice(0, 200);
    }
  }
  // Without models.dev the bare lists qualify nothing; keep the last real snapshot.
  const snapshot = source.modelsDev && !modelsDev ? null : { qualifying: current };
  return { summary, snapshot };
}

export async function runOmnirouteJob(env, state) {
  const parsed = parseOmnirouteCatalog(await fetchBody(OMNIROUTE_CATALOG_URL, 'text'));
  if (parsed.entries.length < MIN_ENTRIES) {
    throw new Error(`OmniRoute catalog has ${parsed.entries.length} entries; it may have moved (${OMNIROUTE_CATALOG_URL})`);
  }
  const known = new Set((await rpcRows(env, 'zerox_candidates_research_context', {})).map(row => row.provider));
  const diff = omnirouteDiff(parsed, state.snapshot, known);
  const upserted = diff.rows.length ? await upsert(env, diff.rows) : [];
  return {
    snapshot: diff.snapshot,
    summary: {
      curated_at: parsed.curatedAt, entries: parsed.entries.length, baseline: diff.baseline,
      added: firstIds(diff.added), removed: firstIds(diff.removed),
      new_candidates: firstIds(upserted.filter(row => row.inserted && row.status === 'new').map(label)),
      excluded: upserted.filter(row => row.status === 'excluded').length,
    },
  };
}

export async function runResearchJob(env, state, { now = Date.now() } = {}) {
  const known = await rpcRows(env, 'zerox_candidates_research_context', {});
  const today = new Date(now).toISOString().slice(0, 10);
  const result = await runResearch(env, known, { today, snapshot: state.snapshot });
  const upserted = result.rows.length ? await upsert(env, result.rows) : [];
  return {
    snapshot: result.nextSnapshot, spentMicrousd: result.spentMicrousd,
    summary: {
      spent_usd: result.spentMicrousd / 1e6, cap_usd: result.capUsd, over_budget: result.overBudget, searches: result.searches,
      records: result.rows.filter(row => !row.model_id).length, dropped_without_sources: result.dropped,
      new_candidates: firstIds(upserted.filter(row => row.inserted && row.status === 'new').map(label)),
      excluded: upserted.filter(row => row.status === 'excluded').length,
      removed: result.removed.slice(0, 20),
    },
  };
}

function jobKind(job) {
  return job.startsWith('list:') ? 'list' : job;
}

async function runJob(env, claim, context) {
  if (claim.job.startsWith('list:')) {
    const source = LIST_SOURCES.find(item => item.job === claim.job);
    if (!source) throw new Error(`unknown list ${claim.job}`);
    return runListJob(env, source, claim, context);
  }
  if (claim.job === 'omniroute') return runOmnirouteJob(env, claim);
  if (claim.job === 'research') {
    if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
    return runResearchJob(env, claim, context);
  }
  throw new Error(`unknown job ${claim.job}`);
}

let warnedUnavailable = false;

/**
 * One cron tick. Returns { ran: [{ job, ok, summary | error }] }, or { skipped } when discovery
 * is off (DISCOVERY_ENABLED=false), there is no database, or its RPCs are missing (migration not
 * applied). `force` runs the named jobs even when they are not due (operator "run now").
 */
export async function runDiscoveryTick(env, { force = false, jobs = null, now = Date.now() } = {}) {
  if (env?.DISCOVERY_ENABLED === 'false') return { skipped: 'disabled' };
  if (!databaseConfigured(env)) return { skipped: 'no_database' };
  const wanted = (jobs || discoveryJobs(env)).filter(job => Object.hasOwn(JOB_INTERVALS, job));
  if (!wanted.length) return { ran: [] };
  let claimed;
  try {
    claimed = await rpcRows(env, 'zerox_discovery_claim', { p_jobs: wanted, p_force: Boolean(force) });
  } catch (error) {
    if (!warnedUnavailable) console.warn('Discovery is unavailable', { message: String(error?.message).slice(0, 200) });
    warnedUnavailable = true;
    return { skipped: 'unavailable' };
  }
  let modelsDev;
  const context = { now, modelsDev: () => (modelsDev ||= fetchBody(MODELS_DEV_URL)) };
  const ran = await Promise.all(claimed.map(async claim => {
    const kind = jobKind(claim.job);
    try {
      const { summary, snapshot, spentMicrousd = 0 } = await runJob(env, claim, context);
      await rpcRows(env, 'zerox_discovery_finish', { p_job: claim.job, p_ok: true, p_next_run_seconds: JOB_INTERVALS[claim.job],
        p_snapshot: snapshot ?? null, p_summary: summary, p_error: null, p_spent_microusd: spentMicrousd });
      if (summary.new_candidates?.length) console.log('Discovery queued candidates', { job: claim.job, candidates: summary.new_candidates });
      return { job: claim.job, ok: true, summary };
    } catch (error) {
      const message = String(error?.message || error).slice(0, 500);
      console.warn('Discovery job failed', { job: claim.job, message });
      await rpcRows(env, 'zerox_discovery_finish', { p_job: claim.job, p_ok: false, p_next_run_seconds: RETRY_SECONDS[kind],
        p_snapshot: error?.nextSnapshot ?? null, p_summary: null, p_error: message,
        p_spent_microusd: error?.spentMicrousd ?? 0 }).catch(() => {});
      return { job: claim.job, ok: false, error: message };
    }
  }));
  return { ran };
}

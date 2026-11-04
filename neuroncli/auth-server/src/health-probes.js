/**
 * Active model health checks on the Node gateway (EC2): the source of the live status that
 * /v1/models and /v1/models/status report (docs/PLATFORM_CONTRACT.md section 15).
 *
 * Without them the Node gateway only knew what failed real requests had taught one instance
 * (provider-health.js), and a model nobody had used counted as available: on 2026-11-04 the
 * status said MiniMax M3.1 Flash and both GLM Flash models were available while OpenRouter had
 * delisted MiniMax and GLM refused requests while its single free slot was busy.
 *
 * One process probes. Every gateway instance runs a HealthProber; on each tick (15 s) it asks
 * Postgres for the `health_probes` lease (zerox_health_lease, 90 s, renewed every tick). The
 * holder is the leader: it checks model lists, the one-at-a-time slots and sends test requests,
 * and writes one row per pool to zerox_pool_health. Every instance, leader or not, reads those
 * rows back into a cache that /v1/models and routing read (probeHealthRows). A stopping leader
 * releases the lease (stop()); a crashed one loses it when it expires, and the next instance
 * takes over within 90 s. Migration 20261104000000_health_probes.sql adds the lease, the rows and
 * zerox_probe_take; without it the prober logs once and stays idle.
 *
 * What the leader does, cheapest first:
 *   1. Model lists, every 10 minutes per list (free: they count against no model's request quota):
 *      Groq, Gemini and Anthropic with each key (a rejected key marks that key's pools
 *      unavailable: auth), NVIDIA and OpenRouter once (public), plus OpenRouter's key endpoint.
 *      A model missing from its provider's list is unavailable (delisted) until it is listed
 *      again; a listed model counts as an observation (checked_at) without changing its verdict.
 *   2. One-at-a-time slots (Z.ai's free GLM Flash), every tick, from Postgres only: while users'
 *      requests hold every slot the model is busy until the first lease lapses
 *      (available_again_at). No upstream request is spent on it.
 *   3. Test requests on a schedule sized to each pool's free quota (PROBE_SCHEDULES, probePlan):
 *      a chat request for 3 output tokens and, less often, a tool-call request (160 tokens), with
 *      12 s and 24 s timeouts. Before each one the leader asks zerox_probe_take, which
 *        - reports users' settled outcomes of the last ten minutes on that pool from any instance:
 *          a recent success with no newer upstream failure is the observation, and no test
 *          request is sent;
 *        - refuses while the pool is busy with users (its slot is taken, or users already used
 *          half of the minute's requests or tokens), or when the request would pass the pool's
 *          budget (the model is then busy until the next minute, or unavailable until 00:00 UTC);
 *        - otherwise counts the test request in the pool's shared minute and day buckets, the
 *          ones users' reservations are checked against, so test requests never let users'
 *          requests pass the upstream's limits.
 *
 * Quota math (requests per pool per UTC day; the published budgets are catalog.js POOL_LIMITS):
 *   Groq free (1,000 a day per model and key, 30 a minute): chat hourly (24) + tools every 6 h (4)
 *     = 28, 2.8 %; about 2,000 of its 200,000 daily tokens (1 %).
 *   NVIDIA trial (10,000 a day per account, 40 a minute): chat every 15 min (96) + tools every
 *     3 h (8) = 104 per model, 312 for the three models, 3.1 % of the account's day.
 *   OpenRouter free (50 a day for the whole account, every :free model together): the list every
 *     10 min detects delisting for free; test requests every 8 h (chat) and 24 h (tools), at most
 *     4 a day for all OpenRouter models together (provider_daily_cap), 8 %.
 *   Z.ai free (no published request budget, one request at a time per model): chat every 15 min
 *     (96) + tools every 6 h (4), each only while no user request holds the slot.
 *   Gemini free (20 a day per model): the keyed list every 10 min and one chat a day (5 %).
 *   Workers AI free (200-300 a day): the 5 % cap stretches the schedule to 8-12 chats and 2-3
 *     tool calls a day.
 *   Paid pools (Groq, Gemini, Workers AI, Claude): chat every 30 min (48) + tools every 6 h (4);
 *     their cost (under $0.03 a day for Claude Opus 5.5) counts against the pool's daily spend cap.
 * probePlan never lets a pool with a published daily request budget spend more than 5 % of it
 * (MAX_PROBE_SHARE), except OpenRouter's shared account cap above. After a failure the next chat
 * comes sooner (a quarter of the interval, 2 min to 2 h) so a recovery shows quickly, still
 * within the same daily cap. Counts per pool and day live in the rows, so a restart or a new
 * leader continues them.
 *
 * Verdicts per pool (row.status): available; busy (a slot or rate limit in use, with
 * available_again_at); degraded (slow: a 3-token answer took over 8 s, a first 5xx or timeout, or
 * tool calls stopped working); unavailable (two failures in a row, delisted, key rejected, quota
 * spent). Readers (probeView) turn a row nobody has confirmed for HEALTH_STALE_SECONDS into
 * unknown, never available, and merge it with what real requests taught this instance
 * (health-share.js withHealth): the freshest observation wins, so a real failure still flips a
 * model at once.
 *
 * Logs are metadata only: pool key, check kind, outcome class, HTTP status and milliseconds.
 * Never a prompt, a completion, a provider message or a key.
 */
import { databaseConfigured, missingFunction, rpc, rpcRows } from './account-store.js';
import { entryPools, loadCatalog, offeredEntries, poolConfigured, poolKey, poolSecret } from './catalog.js';
import { reservationArgs, reservedTokens } from './capacity.js';
import { KEY_CHECKS, LIST_CHECKS } from './health-hub.js';
import { estimatePromptTokens, reserveCostMicrousd } from './pricing.js';
import { loadVaultKeys } from './provider-keys.js';
import { FailureKind } from './provider-health.js';
import { buildUpstreamPayload, classifyUpstreamFailure, requestCompletion } from './providers.js';
import { TEST_TOOL } from './discovery/verify.js';
import { clampInt, healthStaleMs, probeView, timeMs as ms } from './probe-view.js';

export { healthStaleMs, probeView };

const MINUTE = 60_000;
const DAY = 86_400_000;

export const PROBE_SCHEDULES = Object.freeze({
  'groq:free': Object.freeze({ chat_minutes: 60, tool_minutes: 360 }),
  'nvidia:free': Object.freeze({ chat_minutes: 15, tool_minutes: 180 }),
  'openrouter:free': Object.freeze({ chat_minutes: 480, tool_minutes: 1440, provider_daily_cap: 4 }),
  'zai:free': Object.freeze({ chat_minutes: 15, tool_minutes: 360 }),
  'gemini:free': Object.freeze({ chat_minutes: 1440, tool_minutes: 0 }),
  'cloudflare:free': Object.freeze({ chat_minutes: 60, tool_minutes: 360 }),
  paid: Object.freeze({ chat_minutes: 30, tool_minutes: 360 }),
});
const DEFAULT_FREE_SCHEDULE = Object.freeze({ chat_minutes: 60, tool_minutes: 360 });
// Test requests never take more than this share of a pool's published daily requests.
export const MAX_PROBE_SHARE = 0.05;
export const LIST_INTERVAL_MS = 10 * MINUTE;
export const CHAT_MAX_TOKENS = 3;
export const TOOL_MAX_TOKENS = 160;
// A 3-token answer slower than this is degraded.
export const SLOW_PROBE_MS = 8_000;
const LEASE_SECONDS = 90;
const PROBES_PER_TICK = 2;
// A slot check rewrites an unchanged row at most this often (it still refreshes checked_at).
const SLOT_WRITE_MS = MINUTE;
const LIST_TIMEOUT_MS = 8_000;
const ROWS_SINCE_SECONDS = 86_400;

const CHAT_MESSAGES = Object.freeze([{ role: 'user', content: 'Reply with the single word OK.' }]);
const TOOL_MESSAGES = Object.freeze([
  { role: 'system', content: 'You are a connectivity test. Answer only by calling the record_result tool.' },
  { role: 'user', content: 'Call record_result with status "ok" and value 42.' },
]);


// HEALTH_PROBES=on|off (default on), HEALTH_PROBE_TICK_SECONDS (15, 5-300),
// HEALTH_STALE_SECONDS (1200, 120-86400), HEALTH_PROBE_TIMEOUT_SECONDS (12, 3-60; tool calls get
// twice as long).
export function probeSettings(env = {}) {
  const switch_ = String(env.HEALTH_PROBES ?? 'on').trim().toLowerCase();
  const timeoutMs = clampInt(env.HEALTH_PROBE_TIMEOUT_SECONDS, 12, 3, 60) * 1000;
  return {
    enabled: !['off', 'false', '0', 'no'].includes(switch_),
    tickMs: clampInt(env.HEALTH_PROBE_TICK_SECONDS, 15, 5, 300) * 1000,
    staleMs: healthStaleMs(env),
    chatTimeoutMs: timeoutMs,
    toolTimeoutMs: timeoutMs * 2,
  };
}

/**
 * The test-request plan of one pool: { chatMs, toolMs, dailyCap, providerDailyCap }. The
 * schedule's daily total is capped at MAX_PROBE_SHARE of the pool's published daily requests:
 * tool calls go down to a quarter of what is left, and chat requests are spread over the rest.
 */
export function probePlan(entry, pool) {
  const schedule = pool.tier === 'paid' ? PROBE_SCHEDULES.paid
    : PROBE_SCHEDULES[`${entry.provider}:free`] ?? DEFAULT_FREE_SCHEDULE;
  let chatPerDay = Math.ceil(1440 / schedule.chat_minutes);
  let toolPerDay = schedule.tool_minutes ? Math.ceil(1440 / schedule.tool_minutes) : 0;
  const rpd = Number(pool.limits?.rpd);
  if (!schedule.provider_daily_cap && Number.isFinite(rpd) && rpd > 0) {
    const allowed = Math.max(1, Math.floor(rpd * MAX_PROBE_SHARE));
    if (chatPerDay + toolPerDay > allowed) {
      toolPerDay = Math.min(toolPerDay, Math.floor(allowed / 4));
      chatPerDay = Math.max(1, allowed - toolPerDay);
    }
  }
  return {
    chatMs: Math.ceil(1440 / chatPerDay) * MINUTE,
    toolMs: toolPerDay ? Math.ceil(1440 / toolPerDay) * MINUTE : 0,
    dailyCap: chatPerDay + toolPerDay,
    providerDailyCap: schedule.provider_daily_cap ?? null,
  };
}

// The lowest reasoning setting the model takes, so a test request spends its few tokens answering.
function lowestEffort(entry) {
  const efforts = entry.reasoning_efforts || [];
  return efforts.includes('none') ? 'none' : efforts.includes('low') ? 'low' : efforts.includes('minimal') ? 'minimal' : null;
}

const utcDay = now => new Date(now).toISOString().slice(0, 10);
const midnightAfter = now => (Math.floor(now / DAY) + 1) * DAY;
const iso = value => (Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : null);

// Database row <-> the prober's row (times in ms).
function fromDb(row) {
  return {
    pool: row.pool, model: row.model, tier: row.tier, status: row.status, base_status: row.base_status || 'unknown',
    until: ms(row.available_again_at), latency_ms: row.latency_ms ?? null, last_success_at: ms(row.last_success_at),
    last_failure_at: ms(row.last_failure_at), failure_class: row.failure_class ?? null,
    consecutive_failures: Number(row.consecutive_failures) || 0, tool_ok: row.tool_ok ?? null,
    tool_checked_at: ms(row.tool_checked_at), probed_at: ms(row.probed_at), probe_day: row.probe_day ?? null,
    probe_count: Number(row.probe_count) || 0, source: row.source, checked_at: ms(row.checked_at),
  };
}

function toDb(row) {
  return {
    pool: row.pool, model: row.model, tier: row.tier, status: row.status, base_status: row.base_status,
    available_again_at: iso(row.until), latency_ms: row.latency_ms == null ? null : Math.max(0, Math.round(row.latency_ms)),
    last_success_at: iso(row.last_success_at), last_failure_at: iso(row.last_failure_at), failure_class: row.failure_class,
    consecutive_failures: row.consecutive_failures, tool_ok: row.tool_ok, tool_checked_at: iso(row.tool_checked_at),
    probed_at: iso(row.probed_at), probe_day: row.probe_day, probe_count: row.probe_count, source: row.source,
    checked_at: iso(row.checked_at),
  };
}

/* ───────────── Stores ───────────── */

// Postgres through the gateway's RPC path (PostgREST in production, PGlite in tests).
export function databaseProbeStore(env) {
  return {
    async lease(holder, ttlSeconds) {
      const row = await rpc(env, 'zerox_health_lease', { p_holder: holder, p_ttl_seconds: ttlSeconds });
      return row?.leader === true;
    },
    async take({ model, tier, poolKey: key, budget, tokens, costMicrousd, take }) {
      return rpc(env, 'zerox_probe_take', { p_model: model, p_tier: tier, p_pool_key: key ?? null, p_pool: budget,
        p_tokens: tokens, p_cost_microusd: costMicrousd, p_take: take });
    },
    async put(rows) {
      for (let index = 0; index < rows.length; index += 500) {
        await rpc(env, 'zerox_pool_health_put', { p_rows: rows.slice(index, index + 500) });
      }
    },
    async rows() {
      return rpcRows(env, 'zerox_pool_health_get', { p_since_seconds: ROWS_SINCE_SECONDS });
    },
  };
}

/* ───────────── The prober ───────────── */

let active = null; // the prober running in this process (server.js)

export class HealthProber {
  constructor(env, { store = databaseProbeStore(env), holder = `gateway-${Math.random().toString(36).slice(2, 10)}`,
    now = () => Date.now(), fetchImpl = (...args) => fetch(...args), settings = probeSettings(env), log = console } = {}) {
    this.env = env;
    this.store = store;
    this.holder = String(holder).slice(0, 200);
    this.now = now;
    this.fetch_ = fetchImpl;
    this.settings = settings;
    this.log = log;
    this.rows = new Map();      // pool key -> prober row (the leader's working copy)
    this.cache = new Map();     // pool key -> row as last read from the store (every instance)
    this.cacheAt = 0;
    this.leader = false;
    this.loaded = false;        // the leader read the stored rows (counts, last probe times)
    this.lists = {};            // list or key check id -> last run
    this.slotWrites = {};       // pool key -> last slot-check write
    this.disabled = null;       // why the prober stopped for good (missing migration)
    this.running = null;
    this.timer = null;
  }

  // One pass: lease, then (as leader) lists, slots and due test requests, then the cache.
  async tick() {
    if (this.disabled) return { leader: false, disabled: this.disabled };
    if (this.running) return this.running;
    this.running = (async () => {
      const summary = { leader: false, lists: 0, slots: 0, probes: 0, written: 0 };
      try {
        this.leader = await this.store.lease(this.holder, LEASE_SECONDS);
        summary.leader = this.leader;
        if (this.leader) Object.assign(summary, await this.lead());
        else this.loaded = false;
        await this.refresh();
      } catch (error) {
        if (missingFunction(error)) {
          this.disabled = 'migration_missing';
          this.log.warn('Health probes need migration 20261104000000_health_probes.sql; probes are off until it is applied and the gateway restarts');
        } else {
          this.log.warn('Health probe tick failed', { name: error?.name ?? null, code: error?.code ?? null });
        }
      }
      return summary;
    })();
    try { return await this.running; } finally { this.running = null; }
  }

  async refresh() {
    const rows = await this.store.rows();
    this.cache = new Map(rows.map(row => [row.pool, fromDb(row)]));
    this.cacheAt = this.now();
  }

  // Configured pools of offered models (both tiers), one per key.
  pools() {
    const list = [];
    for (const entry of offeredEntries(this.env)) {
      for (const pool of entryPools(this.env, entry)) {
        if (!poolConfigured(this.env, entry, pool)) continue;
        list.push({ entry, pool, key: poolKey(entry, pool), plan: probePlan(entry, pool) });
      }
    }
    return list;
  }

  row(item) {
    let row = this.rows.get(item.key);
    if (!row) {
      row = { pool: item.key, model: item.entry.id, tier: item.pool.tier, status: 'unknown', base_status: 'unknown', until: null,
        latency_ms: null, last_success_at: null, last_failure_at: null, failure_class: null, consecutive_failures: 0,
        tool_ok: null, tool_checked_at: null, probed_at: null, probe_day: null, probe_count: 0, source: 'probe', checked_at: null };
      this.rows.set(item.key, row);
    }
    return row;
  }

  async lead() {
    await loadCatalog(this.env);
    await loadVaultKeys(this.env).catch(() => null);
    if (!this.loaded) {
      for (const row of await this.store.rows()) this.rows.set(row.pool, fromDb(row));
      this.loaded = true;
    }
    const pools = this.pools();
    const changed = new Set();
    const lists = await this.checkLists(pools, changed);
    const slots = await this.checkSlots(pools, changed);
    const probes = await this.runProbes(pools, changed);
    // A row never confirmed (its first test request was refused as a request) is kept in memory
    // until it has an observation to store.
    const rows = [...changed].map(key => this.rows.get(key)).filter(row => row.checked_at).map(toDb);
    if (rows.length) await this.store.put(rows);
    return { lists, slots, probes, written: rows.length };
  }

  /* ── 1. Model lists and key checks ── */

  listUnits(pools) {
    const units = [];
    const byProvider = new Map();
    for (const item of pools) {
      if (!byProvider.has(item.entry.provider)) byProvider.set(item.entry.provider, []);
      byProvider.get(item.entry.provider).push(item);
    }
    for (const [provider, items] of byProvider) {
      const list = PROBE_LIST_CHECKS[provider];
      const keyed = new Map();
      for (const item of items) {
        const ref = item.pool.key_id || item.pool.key_var || item.pool.key_slot || item.pool.binding;
        if (!ref || !poolSecret(this.env, item.pool)) continue;
        if (!keyed.has(ref)) keyed.set(ref, []);
        keyed.get(ref).push(item);
      }
      if (list?.header) for (const [ref, group] of keyed) units.push({ id: `list:${provider}:${ref}`, type: 'list', provider, items: group });
      else if (list) units.push({ id: `list:${provider}`, type: 'list', provider, items });
      if (KEY_CHECKS[provider]) for (const [ref, group] of keyed) units.push({ id: `key:${provider}:${ref}`, type: 'key', provider, items: group });
    }
    return units;
  }

  async checkLists(pools, changed) {
    const now = this.now();
    const due = this.listUnits(pools).filter(unit => now - (this.lists[unit.id] || 0) >= LIST_INTERVAL_MS);
    for (const unit of due) this.lists[unit.id] = now;
    await Promise.all(due.map(unit => (unit.type === 'list' ? this.checkList(unit, now, changed) : this.checkKey(unit, now, changed))));
    return due.length;
  }

  async getJson(id, url, headers) {
    const started = this.now();
    try {
      const response = await this.fetch_(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
      const text = (await response.text().catch(() => '')).slice(0, 8_000_000);
      let body = null;
      if (response.ok) { try { body = JSON.parse(text); } catch { body = null; } }
      if (response.status !== 200 || !body) {
        this.log.warn('Health list check failed', { check: id, status: response.status, ms: this.now() - started });
      }
      return { status: response.status, body, text: response.ok ? '' : text.slice(0, 16384) };
    } catch (error) {
      this.log.warn('Health list check failed', { check: id, status: null, error: error?.name ?? null, ms: this.now() - started });
      return null;
    }
  }

  rejected(result) {
    if (result.status === 401 || result.status === 403) return true;
    return result.status >= 400 && classifyUpstreamFailure(result.status, result.text).kind === FailureKind.AUTH;
  }

  async checkList(unit, now, changed) {
    const check = PROBE_LIST_CHECKS[unit.provider];
    const secret = check.header ? poolSecret(this.env, unit.items[0].pool) : null;
    const result = await this.getJson(unit.id, check.url, listHeaders(check.header, secret));
    if (!result) return; // a slow list says nothing about the models
    if (check.header && this.rejected(result)) {
      for (const item of unit.items) this.markOverlay(item, now, 'unavailable', 'auth', null, changed, 'list', 'unavailable');
      return;
    }
    const ids = result.status === 200 ? check.ids(result.body) : null;
    if (!Array.isArray(ids) || !ids.length) return;
    const listed = new Set(ids);
    for (const item of unit.items) {
      const row = this.row(item);
      if (!listed.has(item.entry.upstream_model)) {
        if (row.failure_class !== 'delisted') this.log.info('Health list: model not listed', { pool: item.key });
        this.markOverlay(item, now, 'unavailable', 'delisted', null, changed, 'list', 'unavailable');
        continue;
      }
      if (row.failure_class === 'delisted' || (row.failure_class === 'auth' && row.status === 'unavailable')) {
        // Listed again (or the key works again): the verdict waits for a test request, due now.
        Object.assign(row, { status: 'unknown', base_status: 'unknown', until: null, probed_at: null, consecutive_failures: 0 });
      }
      row.checked_at = now;
      row.source = 'list';
      changed.add(item.key);
    }
  }

  async checkKey(unit, now, changed) {
    const check = KEY_CHECKS[unit.provider];
    const result = await this.getJson(unit.id, check.url, listHeaders(check.header, poolSecret(this.env, unit.items[0].pool)));
    if (!result) return;
    if (this.rejected(result)) {
      for (const item of unit.items) this.markOverlay(item, now, 'unavailable', 'auth', null, changed, 'list', 'unavailable');
    }
  }

  // A timed state over the row's base verdict (busy or unavailable until `until`, or unavailable
  // until the next list says otherwise when until is null).
  markOverlay(item, now, status, failureClass, until, changed, source, base = null) {
    const row = this.row(item);
    row.status = status;
    row.until = until;
    if (base) row.base_status = base;
    if (failureClass) {
      row.failure_class = failureClass;
      row.last_failure_at = now;
    }
    row.source = source;
    row.checked_at = now;
    changed.add(item.key);
  }

  /* ── 2. One-at-a-time slots ── */

  async checkSlots(pools, changed) {
    let checked = 0;
    for (const item of pools) {
      const budget = this.budget(item);
      if (budget?.concurrency == null) continue;
      const row = this.row(item);
      if (row.status === 'unavailable' && ['delisted', 'auth'].includes(row.failure_class)) continue;
      const now = this.now();
      let result;
      try {
        result = await this.take(item, budget, CHAT_MAX_TOKENS, CHAT_MESSAGES, null, false);
      } catch (error) {
        if (missingFunction(error)) throw error;
        continue;
      }
      checked++;
      if (result?.status === 'pool_full') {
        const until = now + (Number(result.retry_after_seconds) || 60) * 1000;
        const same = row.status === 'busy' && Math.abs((row.until || 0) - until) < 5_000;
        if (!same || now - (this.slotWrites[item.key] || 0) >= SLOT_WRITE_MS) {
          this.markOverlay(item, now, 'busy', null, until, changed, 'budget');
          this.slotWrites[item.key] = now;
        }
      } else if (row.status === 'busy' && row.source === 'budget') {
        // The slot is free again: the last request-level verdict applies.
        row.status = row.base_status;
        row.until = null;
        row.checked_at = now;
        changed.add(item.key);
      }
    }
    return checked;
  }

  /* ── 3. Test requests ── */

  // The pool's p_pool object, exactly as users' reservations send it (capacity.js).
  budget(item) {
    try {
      return reservationArgs({ env: this.env, session: { user_id: null }, requestId: 'probe', entry: item.entry, pool: item.pool,
        promptTokens: 1, maxTokens: 1 }).p_pool;
    } catch {
      return undefined; // a paid pool without a price or cap is never offered anyway
    }
  }

  take(item, budget, maxTokens, messages, tools, take) {
    const prompt = estimatePromptTokens(messages, tools);
    return this.store.take({
      model: item.entry.id, tier: item.pool.tier, poolKey: item.pool.key_id ? item.key : null, budget: budget ?? null,
      tokens: reservedTokens(prompt, maxTokens),
      costMicrousd: item.pool.tier === 'paid' ? reserveCostMicrousd(item.pool.price, prompt, maxTokens) : 0, take,
    });
  }

  usedToday(row, today) {
    return row.probe_day === today ? row.probe_count : 0;
  }

  // What is due for one pool now: 'chat', 'tool' or null.
  due(item, now) {
    const row = this.row(item);
    const { plan } = item;
    // A delisted model waits for its list; anything else is asked again after the failure interval.
    if (row.status === 'unavailable' && row.failure_class === 'delisted') return null;
    if ((row.status === 'busy' || row.status === 'unavailable') && row.until && row.until > now) return null;
    const failing = row.base_status === 'degraded' || row.base_status === 'unavailable';
    const chatEvery = failing ? Math.min(plan.chatMs, Math.max(2 * MINUTE, Math.min(2 * 60 * MINUTE, plan.chatMs / 4))) : plan.chatMs;
    if (!row.probed_at || now - row.probed_at >= chatEvery) return 'chat';
    if (plan.toolMs && row.base_status === 'available' && (!row.tool_checked_at || now - row.tool_checked_at >= plan.toolMs)) return 'tool';
    return null;
  }

  async runProbes(pools, changed) {
    const now = this.now();
    const today = utcDay(now);
    const providerUse = new Map();
    for (const item of pools) {
      const row = this.row(item);
      providerUse.set(item.entry.provider, (providerUse.get(item.entry.provider) || 0) + this.usedToday(row, today));
    }
    const due = pools.map(item => ({ item, kind: this.due(item, now) })).filter(({ kind }) => kind)
      .sort((a, b) => (this.row(a.item).probed_at || 0) - (this.row(b.item).probed_at || 0));
    let sent = 0;
    for (const { item, kind } of due) {
      if (sent >= PROBES_PER_TICK) break;
      const row = this.row(item);
      if (this.usedToday(row, today) >= item.plan.dailyCap) continue;
      if (item.plan.providerDailyCap != null && (providerUse.get(item.entry.provider) || 0) >= item.plan.providerDailyCap) continue;
      const budget = this.budget(item);
      if (budget === undefined) continue;
      const maxTokens = kind === 'tool' ? TOOL_MAX_TOKENS : CHAT_MAX_TOKENS;
      const messages = kind === 'tool' ? TOOL_MESSAGES : CHAT_MESSAGES;
      const tools = kind === 'tool' ? [TEST_TOOL] : null;
      let ticket;
      try {
        // Users' traffic first: a recent success anywhere is the observation, for free.
        const seen = await this.take(item, budget, maxTokens, messages, tools, false);
        if (this.observeTraffic(item, seen, now, changed) && kind === 'chat') continue;
        ticket = await this.take(item, budget, maxTokens, messages, tools, true);
      } catch (error) {
        if (missingFunction(error)) throw error;
        this.log.warn('Health probe budget check failed', { pool: item.key, name: error?.name ?? null });
        continue;
      }
      if (ticket?.status !== 'ok') {
        this.observeBudget(item, ticket, now, changed);
        continue;
      }
      sent++;
      row.probe_day = today;
      row.probe_count = this.usedToday(row, today) + 1;
      providerUse.set(item.entry.provider, (providerUse.get(item.entry.provider) || 0) + 1);
      if (kind === 'tool') await this.toolProbe(item, changed);
      else await this.chatProbe(item, changed);
    }
    return sent;
  }

  // Users' settled outcomes of the last ten minutes (zerox_probe_take recent_*): a success with no
  // newer upstream failure proves the pool answers. Returns true when it counted.
  observeTraffic(item, seen, now, changed) {
    const lastOk = ms(seen?.last_ok_at);
    const lastFailed = ms(seen?.last_failed_at);
    if (!lastOk || (lastFailed && lastFailed > lastOk) || Number(seen?.recent_ok) < 1) return false;
    const row = this.row(item);
    if (row.last_failure_at && row.last_failure_at > lastOk) return false;
    Object.assign(row, { base_status: 'available', consecutive_failures: 0, last_success_at: Math.max(row.last_success_at || 0, lastOk),
      probed_at: now, source: 'traffic', checked_at: now });
    if (!(row.status === 'busy' && row.until > now)) { row.status = 'available'; row.until = null; }
    changed.add(item.key);
    return true;
  }

  // zerox_probe_take refused: the pool's slot or budget is what users would hit as well.
  observeBudget(item, ticket, now, changed) {
    const retry = (Number(ticket?.retry_after_seconds) || 60) * 1000;
    if (ticket?.status === 'pool_full') this.markOverlay(item, now, 'busy', null, now + retry, changed, 'budget');
    else if (ticket?.status === 'pool_exhausted') {
      if (retry > MINUTE) this.markOverlay(item, now, 'unavailable', 'quota', now + retry, changed, 'budget');
      else this.markOverlay(item, now, 'busy', 'rate_limited', now + retry, changed, 'budget');
    } else if (ticket?.status === 'pool_busy') {
      // Users are busy on it: their traffic is the observation when it succeeded.
      this.observeTraffic(item, ticket, now, changed);
    }
  }

  async send(item, kind) {
    const tool = kind === 'tool';
    const body = { model: item.entry.id, stream: false, messages: tool ? TOOL_MESSAGES : CHAT_MESSAGES };
    if (tool) Object.assign(body, { tools: [TEST_TOOL], tool_choice: 'auto' });
    const effort = lowestEffort(item.entry);
    if (effort) body.reasoning_effort = effort;
    const payload = buildUpstreamPayload(item.entry, body, tool ? TOOL_MAX_TOKENS : CHAT_MAX_TOKENS);
    const started = this.now();
    const timeoutMs = tool ? this.settings.toolTimeoutMs : this.settings.chatTimeoutMs;
    try {
      const response = await requestCompletion(this.env, {}, item.entry, payload, AbortSignal.timeout(timeoutMs), item.pool);
      const text = await response.text();
      const latencyMs = this.now() - started;
      if (!response.ok) {
        return { ok: false, status: response.status, latencyMs, ...classifyUpstreamFailure(response.status, text, response.headers) };
      }
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { /* checked below */ }
      const choices = Array.isArray(parsed?.choices) ? parsed.choices : [];
      // A 200 alone is not health: a retired endpoint can answer 200 to anything.
      if (!choices.length) return { ok: false, status: 200, latencyMs, kind: FailureKind.SERVER, empty: true };
      const call = choices.flatMap(choice => choice?.message?.tool_calls || [])
        .find(item_ => item_?.function?.name === TEST_TOOL.function.name);
      return { ok: true, status: 200, latencyMs, toolCall: Boolean(call) };
    } catch (error) {
      const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      return { ok: false, status: null, latencyMs: this.now() - started, kind: timeout ? FailureKind.TIMEOUT : FailureKind.SERVER };
    }
  }

  async chatProbe(item, changed) {
    const outcome = await this.send(item, 'chat');
    const now = this.now();
    const row = this.row(item);
    row.probed_at = now;
    if (outcome.ok) this.succeeded(row, outcome.latencyMs, now);
    else this.failed(item, row, outcome, now);
    changed.add(item.key);
    this.log.info('Health probe', { pool: item.key, kind: 'chat', outcome: outcome.ok ? 'ok' : outcome.kind,
      status: outcome.status, ms: outcome.latencyMs, verdict: row.status });
  }

  async toolProbe(item, changed) {
    const outcome = await this.send(item, 'tool');
    const now = this.now();
    const row = this.row(item);
    row.tool_checked_at = now;
    if (outcome.ok) {
      row.tool_ok = outcome.toolCall;
      row.consecutive_failures = 0;
      row.last_success_at = now;
      if (outcome.toolCall) {
        if (row.failure_class === 'tool_call' && row.base_status === 'degraded') row.base_status = 'available';
      } else {
        // It answers, but no longer calls tools: degraded until a tool call passes again.
        row.base_status = 'degraded';
        row.failure_class = 'tool_call';
        row.last_failure_at = now;
      }
      if (!(row.until && row.until > now && (row.status === 'busy' || row.status === 'unavailable'))) {
        row.status = row.base_status;
        row.until = null;
      }
      row.source = 'probe';
      row.checked_at = now;
    } else {
      this.failed(item, row, outcome, now);
    }
    changed.add(item.key);
    this.log.info('Health probe', { pool: item.key, kind: 'tool', outcome: outcome.ok ? (outcome.toolCall ? 'ok' : 'no_tool_call') : outcome.kind,
      status: outcome.status, ms: outcome.latencyMs, verdict: row.status });
  }

  succeeded(row, latencyMs, now) {
    const slow = latencyMs > SLOW_PROBE_MS;
    const toolsBroken = row.tool_ok === false && row.failure_class === 'tool_call';
    row.base_status = slow || toolsBroken ? 'degraded' : 'available';
    if (slow) { row.failure_class = 'slow'; row.last_failure_at = now; }
    row.status = row.base_status;
    row.until = null;
    row.latency_ms = latencyMs;
    row.last_success_at = now;
    row.consecutive_failures = 0;
    row.source = 'probe';
    row.checked_at = now;
  }

  failed(item, row, outcome, now) {
    const kind = outcome.kind;
    row.source = 'probe';
    if ([FailureKind.CONTEXT, FailureKind.INVALID, FailureKind.MODEL_ERROR].includes(kind)) {
      // The upstream refused the test request itself: that says nothing about the model, and no
      // verdict is recorded (the row is not confirmed, so it goes unknown in time).
      this.log.warn('Health probe rejected by the upstream', { pool: item.key, status: outcome.status, kind });
      return;
    }
    row.latency_ms = outcome.latencyMs;
    row.last_failure_at = now;
    row.checked_at = now;
    if (kind === FailureKind.RATE_LIMITED) {
      const retry = Number(outcome.retryAfterSeconds) > 0 ? Number(outcome.retryAfterSeconds) * 1000 : MINUTE;
      if (outcome.dailyQuota) {
        row.failure_class = 'quota';
        row.status = 'unavailable';
        row.until = outcome.retryAfterSeconds ? now + retry : midnightAfter(now);
      } else {
        row.failure_class = 'rate_limited';
        row.status = 'busy';
        row.until = now + retry;
      }
      return;
    }
    if (kind === FailureKind.MODEL_UNAVAILABLE || kind === FailureKind.AUTH) {
      row.failure_class = kind === FailureKind.AUTH ? 'auth' : 'model_unavailable';
      row.base_status = 'unavailable';
      row.status = 'unavailable';
      // Rejected keys wait for the next list or key check; a missing model is asked again after
      // the failure interval (some providers answer 404 while a model is being redeployed).
      row.until = null;
      row.consecutive_failures++;
      return;
    }
    // 5xx, network failures, timeouts and empty answers: intermittent first, down when repeated.
    row.failure_class = kind === FailureKind.TIMEOUT ? 'timeout' : 'server';
    row.consecutive_failures++;
    row.base_status = row.consecutive_failures >= 2 ? 'unavailable' : 'degraded';
    row.status = row.base_status;
    row.until = null;
  }

  start() {
    if (this.timer) return this;
    const run = () => { this.tick().catch(() => {}); };
    // The first tick waits a few seconds, so a restart is serving before it probes.
    this.first = setTimeout(run, Math.min(5_000, this.settings.tickMs));
    this.first.unref?.();
    this.timer = setInterval(run, this.settings.tickMs);
    this.timer.unref?.();
    return this;
  }

  // Stops the timer and hands the lease back, so the next instance takes over at its next tick.
  async stop() {
    clearTimeout(this.first);
    clearInterval(this.timer);
    this.timer = null;
    if (this.running) await this.running.catch(() => {});
    if (this.leader) {
      this.leader = false;
      await this.store.lease(this.holder, 0).catch(() => {});
    }
    if (active === this) active = null;
  }
}

// List checks of the Node prober: the HealthHub's lists plus Claude's (keyed). A paged answer
// (has_more) is not judged, since a model could sit on a later page.
export const PROBE_LIST_CHECKS = Object.freeze({
  ...LIST_CHECKS,
  anthropic: Object.freeze({ url: 'https://api.anthropic.com/v1/models?limit=1000', header: 'anthropic',
    ids: body => (body?.has_more ? null : body?.data?.map(model => model.id)) }),
});

function listHeaders(header, secret) {
  if (!secret) return {};
  if (header === 'bearer') return { Authorization: `Bearer ${secret}` };
  if (header === 'goog') return { 'x-goog-api-key': secret };
  if (header === 'anthropic') return { 'x-api-key': secret, 'anthropic-version': '2023-06-01' };
  return {};
}

/**
 * Starts this process's prober (server.js), or returns null when HEALTH_PROBES is off or the
 * gateway has no database. Logs which.
 */
export function startHealthProbes(env, options = {}) {
  const settings = probeSettings(env);
  if (!settings.enabled) {
    console.log('Health probes off (HEALTH_PROBES=off): models without recent traffic report unknown');
    return null;
  }
  if (!databaseConfigured(env)) {
    console.log('Health probes off: no database (they share one leader and their results through Postgres)');
    return null;
  }
  if (active) return active;
  active = new HealthProber(env, { ...options, settings }).start();
  console.log('Health probes on', { tick_seconds: settings.tickMs / 1000, stale_seconds: settings.staleMs / 1000 });
  return active;
}

// The rows this process last read (pool key -> row), or null when no prober runs here.
export function probeHealthRows() {
  return active ? active.cache : null;
}

// Rows in the pool-row shape for routing (router.js and chat-handler.js skip busy and blurred
// pools until `until`), or null when no prober runs here.
export function probeRoutingRows(now = Date.now()) {
  if (!active) return null;
  const rows = new Map();
  for (const [key, row] of active.cache) {
    const view = probeView(row, now, active.settings.staleMs);
    if (view && view.status !== 'unknown') rows.set(key, view);
  }
  return rows;
}

// Test hook: make `prober` this process's prober (null to clear).
export function setActiveProber(prober) {
  active = prober;
}

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
 *      again. A listed model only records that it is still offered (listed_at): a list says
 *      nothing about whether requests succeed, so it never refreshes a verdict's checked_at.
 *   2. One-at-a-time slots (Z.ai's free GLM Flash), every tick, from Postgres only: while users'
 *      requests hold every slot the model is busy until the first lease lapses
 *      (available_again_at). No upstream request is spent on it.
 *   3. Test requests on a schedule sized to each pool's free quota (PROBE_SCHEDULES, probePlan):
 *      a chat request for 3 output tokens and, less often, a tool-call request (160 tokens), with
 *      12 s and 24 s timeouts. Before each one the leader asks zerox_probe_take, which
 *        - reports users' settled outcomes of the last ten minutes on that pool from any instance:
 *          a recent success with no newer upstream failure is the observation, and no test
 *          request is sent. Users' outcomes are also read every minute for every pool
 *          (TRAFFIC_CHECK_MS): an upstream failure newer than any success (a missing model, a
 *          5xx, a timeout, a rejected key) makes the pool degraded (unavailable after three with no
 *          success) and brings its next chat test forward, so both instances report it at once
 *          instead of the old verdict until the next scheduled test;
 *        - refuses while the pool is busy with users (its slot is taken, or users already used
 *          half of the minute's requests or tokens), or when the request would pass the pool's
 *          budget (the model is then busy until the next minute, or unavailable until 00:00 UTC);
 *        - otherwise counts the test request in the pool's shared minute and day buckets, the
 *          ones users' reservations are checked against, so test requests never let users'
 *          requests pass the upstream's limits. On a one-at-a-time pool it also holds the slot
 *          (a reservation without a user, freed by zerox_probe_release when the request ends), so
 *          a user's request that arrives meanwhile waits for the slot instead of getting a 429.
 *      Z.ai's free slot is treated as one per ACCOUNT (slotSiblings): users' reservations are
 *      limited per model in Postgres, but whether Z.ai counts per model or per account is not
 *      established. So a test request on one Z.ai free model is sent only while no request runs on
 *      any Z.ai free model of that key, holds every one of their slots while it runs, and ends
 *      within slotProbeTimeoutMs (15 s), inside the 20 s a user waits for a slot: a user request
 *      never meets a test request upstream, and waits for one no longer than for another user's.
 *
 * Quota math (requests per pool per UTC day; the published budgets are catalog.js POOL_LIMITS):
 *   Groq free (1,000 a day per model and key, 30 a minute): chat hourly (24) + tools every 6 h (4)
 *     = 28, 2.8 %; about 2,000 of its 200,000 daily tokens (1 %).
 *   NVIDIA trial (10,000 a day per account, 40 a minute): chat every 15 min (96) + tools every
 *     3 h (8) = 104 per model, 312 for the three models, 3.1 % of the account's day.
 *   OpenRouter free (50 a day for the whole account, every :free model together): the list every
 *     10 min detects delisting for free; test requests every 8 h (chat) and 24 h (tools), at most
 *     4 a day for all OpenRouter models together (provider_daily_cap), 8 %.
 *   Z.ai free (no published request budget, one request at a time, treated as per account):
 *     chat every 15 min (96) + tools every 6 h (4) per model, each only while no request runs on
 *     any of the account's Z.ai free models.
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
 * spent). Each row keeps when its request-level verdict was made (verdict_at) apart from when its
 * current state was observed (checked_at) and when a list last showed the model (listed_at).
 * Readers (probeView) turn a row whose state nobody has observed for its stale horizon
 * (routeStaleMs: 1.5 times the pool's chat interval, at least HEALTH_STALE_SECONDS) into
 * unknown, never available, and merge it with what real requests taught this instance
 * (health-share.js withHealth): the freshest observation wins, so a real failure still flips a
 * model at once.
 *
 * Logs are metadata only: pool key, check kind, outcome class, HTTP status and milliseconds.
 * Never a prompt, a completion, a provider message or a key.
 */
import { databaseConfigured, missingFunction, rpc, rpcRows } from './account-store.js';
import { claudeEffort, claudeTraits } from './anthropic-request.js';
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
  // Claude Haiku 5.5, a sponsored free pool on the operator's paid Claude key (contract section 19.5): the
  // paid Claude pools' schedule, 48 chats and 4 tool calls a day, about $0.01 a day in all.
  'anthropic:free': Object.freeze({ chat_minutes: 30, tool_minutes: 360 }),
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
// Users' settled outcomes are read for every pool at most this often (one Postgres call each).
export const TRAFFIC_CHECK_MS = MINUTE;
// Users' upstream failures in ten minutes, with no success, that make a pool unavailable.
const USER_FAILURES_UNAVAILABLE = 3;

// One-at-a-time pools (a provider type's free_concurrency: Z.ai's free GLM Flash). A user request
// that finds the slot taken waits for it up to POOL_SLOT_WAIT_MS (chat-handler.js, 20 s by
// default), so a test request on such a pool ends well inside that wait: at most 15 s, and 5 s
// under a lower POOL_SLOT_WAIT_MS. Its slot lease is that timeout plus 5 s, so a prober that dies
// mid-request frees the slot about when a waiting user would give up anyway.
export const SLOT_PROBE_TIMEOUT_MS = 15_000;
const SLOT_WAIT_DEFAULT_MS = 20_000;
export function slotProbeTimeoutMs(env = {}) {
  const wait = Number(env.POOL_SLOT_WAIT_MS);
  const waitMs = Number.isSafeInteger(wait) && wait > 0 ? wait : SLOT_WAIT_DEFAULT_MS;
  return Math.max(3_000, Math.min(SLOT_PROBE_TIMEOUT_MS, waitMs - 5_000));
}

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

// A verdict stays current for 1.5 times its pool's chat test interval (the next scheduled test
// plus room for a late tick, a refused take or a skipped turn), never less than
// HEALTH_STALE_SECONDS: Groq free 90 min, NVIDIA and Z.ai free 22.5 min, paid pools 45 min,
// OpenRouter free 12 h, Gemini free 36 h (docs/PLATFORM_CONTRACT.md section 15.2).
export const STALE_INTERVAL_FACTOR = 1.5;
export function routeStaleMs(env, entry, pool) {
  return Math.max(healthStaleMs(env), Math.ceil(probePlan(entry, pool).chatMs * STALE_INTERVAL_FACTOR));
}

// Pool key -> stale horizon for every offered pool, rebuilt at most once a minute per env (the
// catalog changes rarely, and a pool missing from the map falls back to HEALTH_STALE_SECONDS).
const STALE_MAP_TTL_MS = MINUTE;
const staleMaps = new WeakMap();
export function routeStaleMap(env = {}, now = Date.now()) {
  const cached = staleMaps.get(env);
  if (cached && now - cached.at < STALE_MAP_TTL_MS) return cached.map;
  const map = new Map();
  try {
    for (const entry of offeredEntries(env)) {
      for (const pool of entryPools(env, entry)) map.set(poolKey(entry, pool), routeStaleMs(env, entry, pool));
    }
  } catch {
    // No catalog yet: every pool reads HEALTH_STALE_SECONDS.
  }
  staleMaps.set(env, { at: now, map });
  return map;
}

// The lowest reasoning setting the model takes, so a test request spends its few tokens answering.
export function lowestEffort(entry) {
  const efforts = entry.reasoning_efforts || [];
  return efforts.includes('none') ? 'none' : efforts.includes('low') ? 'low' : efforts.includes('minimal') ? 'minimal' : null;
}

// Claude (contract section 13.3; Anthropic's rules for the 5.5 models, checked 2026-11-05): neither
// model accepts thinking {type: 'disabled'} or budget_tokens (both 400), forced tool_choice is a
// 400, and sampling parameters are refused. Sonnet 5.5's lowest setting, {type: 'between_tools'} at
// effort low (what reasoning_effort 'none' maps to, src/anthropic-request.js), turns thinking off,
// so 3 tokens answer. Opus 5.5 cannot turn thinking off: effort low with adaptive thinking is its
// lowest setting, and thinking counts toward max_tokens, so a 3-token cap can end inside the
// thinking block. Haiku 5.5 turns thinking off with {type: 'disabled'} at effort low (what
// reasoning_effort 'none' maps to), so its test requests take 3 and 160 tokens like Sonnet's; if
// Anthropic ever rejected that (a 400 is logged as probe_misconfigured), thinkingOff: null in
// anthropic-request.js CLAUDE_TRAITS gives it Opus's room instead. No minimum max_tokens is documented, but its test requests get room for a short
// think and the answer: 64 tokens for chat, 512 for the tool call (at Opus 5.5's $20 per million
// output tokens, at most about $0.06 a day for 48 chats and 4 tool calls).
export const THINKING_CHAT_MAX_TOKENS = 64;
export const THINKING_TOOL_MAX_TOKENS = 512;

// True when the model keeps thinking at its lowest setting (Claude Opus 5.5).
export function probeThinks(entry) {
  if (entry?.provider !== 'anthropic') return false;
  const traits = claudeTraits(entry.upstream_model);
  return traits.adaptive === true && !claudeEffort(traits, lowestEffort(entry)).thinkingOff;
}

export function probeMaxTokens(entry, kind) {
  if (probeThinks(entry)) return kind === 'tool' ? THINKING_TOOL_MAX_TOKENS : THINKING_CHAT_MAX_TOKENS;
  return kind === 'tool' ? TOOL_MAX_TOKENS : CHAT_MAX_TOKENS;
}

/**
 * The upstream payload of one test request (what requestCompletion sends through the provider's
 * adapter, which turns it into the provider's own request): the fixed messages, the lowest
 * reasoning setting the model takes, the test tool with tool_choice 'auto' for a tool call (never a
 * forced one), and probeMaxTokens.
 */
export function probePayload(entry, kind) {
  const tool = kind === 'tool';
  const body = { model: entry.id, stream: false, messages: tool ? TOOL_MESSAGES : CHAT_MESSAGES };
  if (tool) Object.assign(body, { tools: [TEST_TOOL], tool_choice: 'auto' });
  const effort = lowestEffort(entry);
  if (effort) body.reasoning_effort = effort;
  return buildUpstreamPayload(entry, body, probeMaxTokens(entry, kind));
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
    probe_count: Number(row.probe_count) || 0, source: row.source, verdict_at: ms(row.verdict_at),
    listed_at: ms(row.listed_at), checked_at: ms(row.checked_at),
  };
}

function toDb(row) {
  return {
    pool: row.pool, model: row.model, tier: row.tier, status: row.status, base_status: row.base_status,
    available_again_at: iso(row.until), latency_ms: row.latency_ms == null ? null : Math.max(0, Math.round(row.latency_ms)),
    last_success_at: iso(row.last_success_at), last_failure_at: iso(row.last_failure_at), failure_class: row.failure_class,
    consecutive_failures: row.consecutive_failures, tool_ok: row.tool_ok, tool_checked_at: iso(row.tool_checked_at),
    probed_at: iso(row.probed_at), probe_day: row.probe_day, probe_count: row.probe_count, source: row.source,
    verdict_at: iso(row.verdict_at), listed_at: iso(row.listed_at), checked_at: iso(row.checked_at),
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
    async take({ model, tier, poolKey: key, budget, tokens, costMicrousd, take, leaseSeconds = 60 }) {
      return rpc(env, 'zerox_probe_take', { p_model: model, p_tier: tier, p_pool_key: key ?? null, p_pool: budget,
        p_tokens: tokens, p_cost_microusd: costMicrousd, p_take: take, p_lease_seconds: leaseSeconds });
    },
    // Frees the one-at-a-time slot a test request held (zerox_probe_take slot_id).
    async release(slotId) {
      return rpc(env, 'zerox_probe_release', { p_slot_id: slotId });
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
    this.trafficChecks = {};    // pool key -> last read of users' outcomes
    this.disabled = null;       // why the prober stopped for good (missing migration)
    this.misconfigured = new Set(); // pools whose test request got a 400 (logged once)
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
          this.log.warn('Health probes need migration 20261104000000_health_probes.sql; probes are off until it is applied and the gateway restarts; set HEALTH_HUB_PROBES=on on the Worker meanwhile');
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
        tool_ok: null, tool_checked_at: null, probed_at: null, probe_day: null, probe_count: 0, source: 'probe',
        verdict_at: null, listed_at: null, checked_at: null };
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
    // A row with neither an observation nor a list entry (its first test request was refused as a
    // request) is kept in memory until it has something to store.
    const rows = [...changed].map(key => this.rows.get(key)).filter(row => row.checked_at || row.listed_at).map(toDb);
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
        Object.assign(row, { status: 'unknown', base_status: 'unknown', until: null, probed_at: null, consecutive_failures: 0,
          verdict_at: null, checked_at: null, source: 'list' });
      }
      // Still offered, which says nothing about whether requests succeed: the verdict and its
      // checked_at stay as they are, and go stale on their own.
      row.listed_at = now;
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
  // until the next list says otherwise when until is null), observed now.
  markOverlay(item, now, status, failureClass, until, changed, source, base = null) {
    const row = this.row(item);
    row.status = status;
    row.until = until;
    if (base) { row.base_status = base; row.verdict_at = now; }
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
        // The slot is free again: the last request-level verdict applies, as old as it is (a free
        // slot says nothing about whether requests succeed).
        row.status = row.base_status;
        row.until = null;
        row.checked_at = row.verdict_at;
        row.source = 'probe';
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

  // A test request's timeout: the settings', and on a one-at-a-time pool at most
  // slotProbeTimeoutMs, so a user waiting for the slot it holds is served within the slot wait.
  probeTimeoutMs(item, tool, budget = this.budget(item)) {
    const base = tool ? this.settings.toolTimeoutMs : this.settings.chatTimeoutMs;
    return budget?.concurrency != null ? Math.min(base, slotProbeTimeoutMs(this.env)) : base;
  }

  take(item, budget, maxTokens, messages, tools, take) {
    const prompt = estimatePromptTokens(messages, tools);
    // A one-at-a-time slot is held for the request's timeout and a margin (it is freed sooner).
    const timeoutMs = this.probeTimeoutMs(item, Boolean(tools), budget);
    const margin = budget?.concurrency != null ? 5 : 10;
    return this.store.take({
      model: item.entry.id, tier: item.pool.tier, poolKey: item.pool.key_id ? item.key : null, budget: budget ?? null,
      tokens: reservedTokens(prompt, maxTokens),
      costMicrousd: item.pool.tier === 'paid' ? reserveCostMicrousd(item.pool.price, prompt, maxTokens) : 0, take,
      leaseSeconds: Math.min(300, Math.max(5, Math.ceil(timeoutMs / 1000) + margin)),
    });
  }

  /*
   * The account a one-at-a-time slot belongs to. Users' reservations are limited per model and key
   * (zerox_reserve_v2 counts p_pool.concurrency per pool key), but whether Z.ai's limit is per model
   * or for the whole account is not established, so the prober treats it as per account: every
   * other free pool of the same provider on the same key that has a concurrency limit shares it.
   */
  slotSiblings(item, pools) {
    const ref = pool => pool.key_id || pool.key_var || pool.key_slot || pool.binding || null;
    return pools.filter(other => other.key !== item.key && other.entry.provider === item.entry.provider
      && other.pool.tier === item.pool.tier && ref(other.pool) === ref(item.pool) && this.budget(other)?.concurrency != null);
  }

  // Before a test request on a one-at-a-time pool: true when no request (a user's or a test) runs on
  // any other pool of the account (slotSiblings), read without counting or locking anything.
  async accountSlotsFree(siblings, maxTokens, messages, tools) {
    for (const sibling of siblings) {
      const budget = this.budget(sibling);
      const seen = await this.take(sibling, budget, maxTokens, messages, tools, false);
      if (seen?.status === 'pool_full' || Number(seen?.running) >= Number(budget.concurrency)) return false;
    }
    return true;
  }

  // While a test request runs on a one-at-a-time pool, it also holds the slot of every other pool
  // of the account, so a user request there waits for it (as for another user) instead of reaching
  // Z.ai beside the test and getting a 429. Returns the slot ids held, or null when a user took one
  // meanwhile (everything held is released, and no test request is sent). Each hold counts one
  // request in that pool's minute and day buckets; Z.ai's free pools have no request or token
  // budget, so nothing is refused for it.
  async holdAccountSlots(item, siblings, maxTokens, messages, tools) {
    const held = [];
    for (const sibling of siblings) {
      const ticket = await this.take(sibling, this.budget(sibling), maxTokens, messages, tools, true).catch(error => {
        if (missingFunction(error)) throw error;
        return null;
      });
      if (ticket?.status === 'ok' && ticket.slot_id) { held.push(ticket.slot_id); continue; }
      await this.releaseSlots(held, item);
      return null;
    }
    return held;
  }

  async releaseSlots(slotIds, item) {
    for (const slotId of slotIds) {
      await this.store.release(slotId).catch(error => {
        this.log.warn('Health probe slot release failed', { pool: item.key, name: error?.name ?? null });
      });
    }
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
    // Users' outcomes on the pools that are not due: a failure brings the pool's chat test forward.
    await this.watchTraffic(pools.filter(item => !this.due(item, now)), now, changed);
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
      const maxTokens = probeMaxTokens(item.entry, kind);
      const messages = kind === 'tool' ? TOOL_MESSAGES : CHAT_MESSAGES;
      const tools = kind === 'tool' ? [TEST_TOOL] : null;
      let ticket;
      let siblingSlots = [];
      const siblings = budget?.concurrency != null ? this.slotSiblings(item, pools) : [];
      try {
        // Users' traffic first: a recent success anywhere is the observation, for free (a recent
        // failure is recorded, and the test request confirms it).
        const seen = await this.take(item, budget, maxTokens, messages, tools, false);
        this.trafficChecks[item.key] = now;
        if (this.observeTraffic(item, seen, now, changed) === 'ok' && kind === 'chat') continue;
        // A one-at-a-time slot is per account here: no test request while a request runs on any
        // other model of the account (users first; the pool's own verdict is unchanged).
        if (siblings.length && !await this.accountSlotsFree(siblings, maxTokens, messages, tools)) continue;
        ticket = await this.take(item, budget, maxTokens, messages, tools, true);
        if (ticket?.status === 'ok' && siblings.length) {
          siblingSlots = await this.holdAccountSlots(item, siblings, maxTokens, messages, tools);
          if (!siblingSlots) {
            await this.releaseSlots(ticket.slot_id ? [ticket.slot_id] : [], item);
            continue;
          }
        }
      } catch (error) {
        if (missingFunction(error)) throw error;
        this.log.warn('Health probe budget check failed', { pool: item.key, name: error?.name ?? null });
        if (ticket?.slot_id) await this.releaseSlots([ticket.slot_id], item);
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
      try {
        if (kind === 'tool') await this.toolProbe(item, changed);
        else await this.chatProbe(item, changed);
      } finally {
        // The one-at-a-time slots the test request held go back to users at once.
        await this.releaseSlots([...(ticket.slot_id ? [ticket.slot_id] : []), ...siblingSlots], item);
      }
    }
    return sent;
  }

  // Reads users' outcomes for pools whose last read is TRAFFIC_CHECK_MS old (nothing is counted).
  async watchTraffic(pools, now, changed) {
    for (const item of pools) {
      const row = this.row(item);
      if (row.status === 'unavailable' && ['delisted', 'auth'].includes(row.failure_class)) continue;
      if (now - (this.trafficChecks[item.key] || 0) < TRAFFIC_CHECK_MS) continue;
      const budget = this.budget(item);
      if (budget === undefined) continue;
      this.trafficChecks[item.key] = now;
      try {
        this.observeTraffic(item, await this.take(item, budget, CHAT_MAX_TOKENS, CHAT_MESSAGES, null, false), now, changed);
      } catch (error) {
        if (missingFunction(error)) throw error;
      }
    }
  }

  // Users' settled outcomes of the last ten minutes (zerox_probe_take recent_* and last_*_at), when
  // newer than the row's verdict. A success with no newer upstream failure proves the pool answers
  // ('ok'); an upstream failure newer than any success makes it degraded, or unavailable after
  // USER_FAILURES_UNAVAILABLE with no success, and makes its next chat test due now ('failed').
  // The observation is dated by the users' request, never by this check. Returns null otherwise.
  observeTraffic(item, seen, now, changed) {
    const lastOk = ms(seen?.last_ok_at);
    const lastFailed = ms(seen?.last_failed_at);
    const row = this.row(item);
    const overlay = (row.status === 'busy' || row.status === 'unavailable') && row.until > now;
    if (lastFailed && Number(seen?.recent_failed) >= 1 && lastFailed > (lastOk || 0)) {
      if (row.verdict_at && row.verdict_at >= lastFailed) return null;
      const down = !lastOk && Number(seen.recent_failed) >= USER_FAILURES_UNAVAILABLE;
      Object.assign(row, { base_status: down ? 'unavailable' : 'degraded', failure_class: 'upstream_errors',
        last_failure_at: Math.max(row.last_failure_at || 0, lastFailed), verdict_at: lastFailed, source: 'traffic',
        probed_at: null });
      if (!overlay) Object.assign(row, { status: row.base_status, until: null, checked_at: lastFailed });
      changed.add(item.key);
      return 'failed';
    }
    if (!lastOk || Number(seen?.recent_ok) < 1) return null;
    if ((row.last_failure_at && row.last_failure_at > lastOk) || (row.verdict_at && row.verdict_at >= lastOk)) return null;
    Object.assign(row, { base_status: 'available', consecutive_failures: 0, last_success_at: Math.max(row.last_success_at || 0, lastOk),
      probed_at: Math.max(row.probed_at || 0, lastOk), source: 'traffic', verdict_at: lastOk });
    if (!overlay) Object.assign(row, { status: 'available', until: null, checked_at: lastOk });
    changed.add(item.key);
    return 'ok';
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
    const payload = probePayload(item.entry, kind);
    const started = this.now();
    const timeoutMs = this.probeTimeoutMs(item, tool);
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
      row.verdict_at = now;
      if (!(row.until && row.until > now && (row.status === 'busy' || row.status === 'unavailable'))) {
        row.status = row.base_status;
        row.until = null;
        row.checked_at = now;
      }
      row.source = 'probe';
    } else {
      this.failed(item, row, outcome, now);
    }
    changed.add(item.key);
    this.log.info('Health probe', { pool: item.key, kind: 'tool', outcome: outcome.ok ? (outcome.toolCall ? 'ok' : 'no_tool_call') : outcome.kind,
      status: outcome.status, ms: outcome.latencyMs, verdict: row.status });
  }

  succeeded(row, latencyMs, now) {
    this.misconfigured.delete(row.pool);
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
    row.verdict_at = now;
    row.checked_at = now;
  }

  failed(item, row, outcome, now) {
    const kind = outcome.kind;
    row.source = 'probe';
    // The kind decides first: classifyUpstreamFailure already gives some 400s a specific kind
    // (Groq model_decommissioned: model_unavailable; Gemini API_KEY_INVALID or
    // FAILED_PRECONDITION: auth; Groq tool_use_failed: model_error), and those keep their own
    // branches below. Only a 400 the classifier left as a plain request rejection (or unclassified)
    // means the test request needs fixing.
    if ([FailureKind.CONTEXT, FailureKind.INVALID].includes(kind) || (outcome.status === 400 && kind == null)) {
      // The upstream refused the test request itself: the request needs fixing, which says
      // nothing about the model. No verdict is recorded (status, its time and the failure count
      // stay, so the row goes unknown in time, never down); the row says probe_misconfigured, and
      // the warning is logged once per pool until a test request passes again.
      row.failure_class = 'probe_misconfigured';
      if (!this.misconfigured.has(item.key)) {
        this.misconfigured.add(item.key);
        this.log.warn('Health probe rejected by the upstream as a request; fix the test request', { pool: item.key,
          status: outcome.status, kind });
      }
      return;
    }
    if (kind === FailureKind.MODEL_ERROR) {
      // The model's own output failed (a malformed tool call): no verdict either.
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
      row.verdict_at = now;
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
    row.verdict_at = now;
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

// Why startHealthProbes started no prober in this process (probeCheckerState).
let starting = 'not_started';

/**
 * Starts this process's prober (server.js), or returns null when HEALTH_PROBES is off or the
 * gateway has no database. Logs which.
 */
export function startHealthProbes(env, options = {}) {
  const settings = probeSettings(env);
  // The Worker's HealthHub sends no test requests while chat is routed here (HEALTH_HUB_PROBES
  // auto), so with this checker off nothing probes the pools unless that var is set to "on".
  const hubHint = 'the Worker HealthHub sends no test requests while chat is routed here, so set HEALTH_HUB_PROBES=on on the Worker to keep one checker';
  if (!settings.enabled) {
    starting = 'off';
    console.log(`Health probes off (HEALTH_PROBES=off): models without recent traffic report unknown; ${hubHint}`);
    return null;
  }
  if (!databaseConfigured(env)) {
    starting = 'no_database';
    console.log(`Health probes off: no database (they share one leader and their results through Postgres); ${hubHint}`);
    return null;
  }
  if (active) return active;
  active = new HealthProber(env, { ...options, settings }).start();
  console.log('Health probes on', { tick_seconds: settings.tickMs / 1000, stale_seconds: settings.staleMs / 1000 });
  return active;
}

/**
 * What this process's checker does, for the operator's /health: "running", "off"
 * (HEALTH_PROBES=off), "no_database", "migration_missing" (it stopped itself) or "not_started"
 * (the Worker, which has no Node checker, or a process that has not started one).
 */
export function probeCheckerState() {
  if (active) return active.disabled || 'running';
  return starting;
}

// The rows this process last read (pool key -> row), or null when no prober runs here.
export function probeHealthRows() {
  return active ? active.cache : null;
}

// Pool key -> stale horizon (routeStaleMs) while a prober runs here, for withHealth; null otherwise
// (without the checker's schedule every observation goes stale after HEALTH_STALE_SECONDS).
export function probeStaleMsFor() {
  if (!active) return null;
  // The prober's env: the process configuration, one object (a request's env may be a copy).
  const map = routeStaleMap(active.env);
  const floor = healthStaleMs(active.env);
  return key => map.get(key) ?? floor;
}

// Rows in the pool-row shape for routing (router.js and chat-handler.js skip busy and blurred
// pools until `until`), or null when no prober runs here.
export function probeRoutingRows(now = Date.now()) {
  if (!active) return null;
  const rows = new Map();
  const staleFor = probeStaleMsFor();
  for (const [key, row] of active.cache) {
    const view = probeView(row, now, Math.max(active.settings.staleMs, staleFor(key)));
    if (view && view.status !== 'unknown') rows.set(key, view);
  }
  return rows;
}

// Test hook: make `prober` this process's prober (null to clear).
export function setActiveProber(prober) {
  active = prober;
}

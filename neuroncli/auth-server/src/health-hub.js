/**
 * HealthHub: one Durable Object that holds every pool's health for the whole gateway
 * (docs/PLATFORM_CONTRACT.md section 8.1; plan section 2).
 *
 * Isolates report real attempt outcomes to it (src/health-hub-client.js), and every 30 s an
 * alarm adds what real traffic cannot show, cheapest first:
 *   1. model lists (free), read once per key (the environment key and every provider key vault
 *      key, src/provider-keys.js): a model missing from the list is gone (blurred) and a
 *      rejected key greys out only that key's pools. NVIDIA and OpenRouter publish their lists
 *      without a key, so those are read once; OpenRouter keys are checked on its key endpoint,
 *      and a dead NVIDIA key shows up from real traffic;
 *   2. provider status pages (free): Groq lists each model, Cloudflare lists Workers AI;
 *   3. a real one-line request, only for a pool whose cooldown has ended (half-open) and that
 *      no real request has touched for two minutes, within a small daily cap per model.
 *      Gemini, NVIDIA and OpenRouter get none: their free quotas are too small to spend on checks;
 *   4. a canary (OIOP, docs/OIOP.md "Health") for a healthy pool that real traffic has left alone
 *      for 15 minutes: one streamed tool call (Groq), which proves streaming and tool calling
 *      together, or a one-line request (Workers AI). Canaries use at most half of the pool's
 *      daily cap, spread over the day (Groq about every 2 h); a provider without test requests
 *      gets none. HEALTH_CANARIES=false turns them off.
 * Real outcomes also feed a rolling window per pool (last 50): p50/p95 latency to the first
 * byte and the error rate, which the snapshot carries for routing (router.js penalty).
 * A failed list, key or status-page check and every test request log one line (no bodies or headers).
 * /v1/models reads a snapshot from here; the KV path in health-share.js remains for the Node
 * server, which has no Durable Objects.
 *
 * Written against the classic Durable Object API (constructor(state, env), fetch, alarm) so
 * that src/index.js can export it without importing `cloudflare:workers`, which Node lacks.
 */
import { FailureKind, HealthState, ProviderHealthTracker } from './provider-health.js';
import { publicStatus } from './health-share.js';
import { entryPools, loadCatalog, offeredEntries, poolConfigured, poolKey, poolSecret } from './catalog.js';
import { ADAPTERS, buildUpstreamPayload, classifyUpstreamFailure, requestCompletion, upstreamErrorSummary } from './providers.js';
import { loadVaultKeys } from './provider-keys.js';
import { readStream, TEST_TOOL } from './discovery/verify.js';

export const ALARM_INTERVAL_MS = 30_000;
const CHECK_INTERVAL_MS = 60_000; // each list, key or status page check at most once a minute
const CHECKS_PER_ALARM = 4;       // staggered, oldest first: with many keys a check runs less often
const IDLE_MS = 120_000;          // no real request for this long before a test request
const PROBES_PER_ALARM = 2;
const STATUS_HOLD_MS = 90_000;    // an outage on a status page holds until the next check
const FETCH_TIMEOUT_MS = 8_000;
// Test requests per pool (model and key) per UTC day: about 2.4% of Groq's 1,000 requests, under
// 4% of the Workers AI daily neurons. 0 = never: Gemini's free tier allows 20 requests per model
// per day (catalog.js POOL_LIMITS), so its free model list is its only check.
export const PROBE_DAILY_CAPS = Object.freeze({ groq: 24, gemini: 0, cloudflare: 48, nvidia: 0, openrouter: 0 });
const CANARY_IDLE_MS = 15 * 60_000; // real traffic within this already proves the pool
const CANARIES_PER_ALARM = 1;
const WINDOW = 50;                  // outcomes and latencies kept per pool
// Failures that say something about the request, not the pool.
const REQUEST_KINDS = new Set([FailureKind.CONTEXT, FailureKind.INVALID, FailureKind.MODEL_ERROR, FailureKind.ABORTED]);

// Canaries per pool per day (half the cap) and the spacing between them.
export const canaryBudget = cap => Math.floor(cap / 2);
export const canaryIntervalMs = cap => Math.max(CANARY_IDLE_MS, Math.floor(86_400_000 / Math.max(1, canaryBudget(cap))));

const percentile = (values, fraction) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
};

// Free model lists. A `header` list is read with each key and judges only that key's free pools
// (a paid key's pool is not checked); a public list (no header) is read once for all of them.
const LIST_CHECKS = Object.freeze({
  groq: { url: 'https://api.groq.com/openai/v1/models', header: 'bearer',
    ids: body => body?.data?.map(model => model.id) },
  gemini: { url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200',
    header: 'goog', ids: body => body?.models?.map(model => String(model.name).replace(/^models\//, '')) },
  // Public: an invalid key still gets the list (checked 2026-10-19).
  nvidia: { url: 'https://integrate.api.nvidia.com/v1/models', header: null,
    ids: body => body?.data?.map(model => model.id) },
  openrouter: { url: 'https://openrouter.ai/api/v1/models', header: null,
    ids: body => body?.data?.map(model => model.id) },
});

// Free endpoints that tell a live key from a dead one where the model list is public.
const KEY_CHECKS = Object.freeze({
  openrouter: { url: 'https://openrouter.ai/api/v1/key', header: 'bearer' },
});

const authHeaders = (header, secret) => !secret ? {}
  : header === 'bearer' ? { Authorization: `Bearer ${secret}` } : header === 'goog' ? { 'x-goog-api-key': secret } : {};

// Free pools grouped by the key that serves them: 'env' or a vault key id.
function byKey(pools) {
  const groups = new Map();
  for (const item of pools) {
    if (!item.pool.key_id && !item.pool.key_var) continue;
    const ref = item.pool.key_id || 'env';
    if (!groups.has(ref)) groups.set(ref, []);
    groups.get(ref).push(item);
  }
  return groups;
}

// Statuspage summaries: which component speaks for a catalog entry.
const STATUS_CHECKS = Object.freeze({
  groq: { url: 'https://groqstatus.com/api/v2/summary.json', component: entry => entry.upstream_model },
  cloudflare: { url: 'https://www.cloudflarestatus.com/api/v2/summary.json', component: () => 'Workers AI' },
});

const utcDay = now => new Date(now).toISOString().slice(0, 10);

export class HealthHub {
  constructor(state, env, { fetchImpl = (...args) => fetch(...args), now = () => Date.now(),
    fetchTimeoutMs = FETCH_TIMEOUT_MS } = {}) {
    this.state = state;
    this.env = env;
    this.fetch_ = fetchImpl;
    this.now = now;
    this.fetchTimeoutMs = fetchTimeoutMs;
    this.tracker = new ProviderHealthTracker();
    // Last observation per pool (real outcome, list, status page or test request).
    this.seen = new Map();
    // Last real (user) attempt per pool: test requests wait for idleness.
    this.realAt = new Map();
    this.checks = {};
    this.probes = { day: null, counts: {}, canaries: {} };
    // OIOP: last canary per pool and rolling windows of real outcomes ({ out: [1|0], lat: [ms] }).
    this.canaries = {};
    this.windows = {};
    this.dirty = false;
    this.ready = state.blockConcurrencyWhile(async () => {
      const saved = await state.storage.get('hub');
      if (saved?.records) for (const [key, record] of Object.entries(saved.records)) this.tracker.records.set(key, record);
      if (saved?.seen) for (const [key, at] of Object.entries(saved.seen)) this.seen.set(key, at);
      if (saved?.realAt) for (const [key, at] of Object.entries(saved.realAt)) this.realAt.set(key, at);
      if (saved?.checks) this.checks = saved.checks;
      if (saved?.probes) this.probes = { canaries: {}, ...saved.probes };
      if (saved?.canaries) this.canaries = saved.canaries;
      if (saved?.windows) this.windows = saved.windows;
      if (!await state.storage.getAlarm()) await state.storage.setAlarm(this.now() + ALARM_INTERVAL_MS);
    });
  }

  async persist() {
    if (!this.dirty) return;
    this.dirty = false;
    await this.state.storage.put('hub', {
      records: Object.fromEntries(this.tracker.records),
      seen: Object.fromEntries(this.seen),
      realAt: Object.fromEntries(this.realAt),
      checks: this.checks,
      probes: this.probes,
      canaries: this.canaries,
      windows: this.windows,
    });
  }

  // Outcomes reported by isolates: { key, success, kind, retryAfterSeconds, latencyMs, phase, caller, at }.
  report(outcomes) {
    const now = this.now();
    for (const outcome of outcomes) {
      if (typeof outcome?.key !== 'string' || outcome.key.length > 200) continue;
      if (outcome.success) this.tracker.recordSuccess(outcome.key, { latencyMs: Number(outcome.latencyMs) || 0 });
      else {
        this.tracker.recordFailure(outcome.key, {
          kind: outcome.kind || FailureKind.SERVER, retryAfterSeconds: Number(outcome.retryAfterSeconds) || 0,
          dailyQuota: outcome.dailyQuota === true,
          latencyMs: Number(outcome.latencyMs) || 0, phase: outcome.phase ?? null, caller: outcome.caller ?? null,
        });
      }
      this.seen.set(outcome.key, now);
      this.realAt.set(outcome.key, now);
      if (outcome.success || !REQUEST_KINDS.has(outcome.kind)) {
        const window = this.windows[outcome.key] ||= { out: [], lat: [] };
        window.out = [...window.out, outcome.success ? 0 : 1].slice(-WINDOW);
        if (outcome.success && Number(outcome.latencyMs) > 0) window.lat = [...window.lat, Number(outcome.latencyMs)].slice(-WINDOW);
      }
      this.dirty = true;
    }
  }

  // Rolling metrics of a pool for the snapshot (nothing until there are samples).
  metrics(key) {
    const window = this.windows[key];
    const out = {};
    if (window?.out.length) {
      out.samples = window.out.length;
      out.error_rate = Number((window.out.reduce((sum, value) => sum + value, 0) / window.out.length).toFixed(3));
    }
    if (window?.lat.length) {
      out.p50_ms = percentile(window.lat, 0.5);
      out.p95_ms = percentile(window.lat, 0.95);
    }
    const canary = this.canaries[key];
    if (canary) out.canary = { at: canary.at, ok: canary.ok, tool_call: canary.tool_call ?? null, first_byte_ms: canary.first_byte_ms ?? null };
    return out;
  }

  snapshot() {
    const now = this.now();
    const pools = {};
    for (const [key, record] of this.tracker.records) {
      // { status, until, slow_until? }: chat-handler.js orders `auto` candidates by them.
      pools[key] = { ...publicStatus(record, now), at: this.seen.get(key) ?? record.last_attempt_at ?? null, ...this.metrics(key) };
    }
    for (const key of Object.keys(this.canaries)) {
      pools[key] ||= { status: 'available', until: 0, at: this.seen.get(key) ?? null, ...this.metrics(key) };
    }
    return { generated_at: now, pools };
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/report') {
      const body = await request.json().catch(() => null);
      if (!Array.isArray(body?.outcomes) || body.outcomes.length > 50) return new Response('bad request', { status: 400 });
      this.report(body.outcomes);
      await this.persist();
      return Response.json({ ok: true });
    }
    if (request.method === 'GET' && url.pathname === '/snapshot') return Response.json(this.snapshot());
    // The daily discovery job (src/discovery/jobs.js) found these pools' models missing from
    // their provider's public list. Not a real request: idle-time test requests are unaffected.
    if (request.method === 'POST' && url.pathname === '/mark') {
      const body = await request.json().catch(() => null);
      const keys = Array.isArray(body?.keys) ? body.keys.filter(key => typeof key === 'string' && key.length <= 200) : [];
      if (!keys.length || keys.length > 50 || body.kind !== FailureKind.MODEL_UNAVAILABLE) {
        return new Response('bad request', { status: 400 });
      }
      const now = this.now();
      for (const key of keys) this.mark(key, now, { kind: FailureKind.MODEL_UNAVAILABLE });
      await this.persist();
      return Response.json({ ok: true, marked: keys.length });
    }
    return new Response('not found', { status: 404 });
  }

  async alarm() {
    await this.ready;
    const now = this.now();
    try {
      // Vault keys (60 s cache in this object): each key's pools are checked like the env key's.
      await loadVaultKeys(this.env);
      await this.runChecks(now);
    } catch (error) {
      console.warn('HealthHub checks failed', { message: error?.message });
    } finally {
      await this.persist();
      await this.state.storage.setAlarm(now + ALARM_INTERVAL_MS);
    }
  }

  // Configured free pools of offered models (one per key), grouped by provider.
  pools() {
    const byProvider = new Map();
    for (const entry of offeredEntries(this.env)) {
      for (const pool of entryPools(this.env, entry)) {
        if (pool.tier !== 'free' || !poolConfigured(this.env, entry, pool)) continue;
        if (!byProvider.has(entry.provider)) byProvider.set(entry.provider, []);
        byProvider.get(entry.provider).push({ entry, pool, key: poolKey(entry, pool) });
      }
    }
    return byProvider;
  }

  // Every check this deployment needs now: { id, type, provider, pools }. Keyed checks are
  // named after the key (`list:groq:env`, `list:groq:<vault key id>`), never the key itself.
  checkUnits(byProvider) {
    const units = [];
    for (const [provider, pools] of byProvider) {
      const list = LIST_CHECKS[provider];
      if (list?.header) {
        for (const [ref, keyed] of byKey(pools)) units.push({ id: `list:${provider}:${ref}`, type: 'list', provider, pools: keyed });
      } else if (list) units.push({ id: `list:${provider}`, type: 'list', provider, pools });
      if (KEY_CHECKS[provider]) {
        for (const [ref, keyed] of byKey(pools)) units.push({ id: `key:${provider}:${ref}`, type: 'key', provider, pools: keyed });
      }
      if (STATUS_CHECKS[provider]) units.push({ id: `status:${provider}`, type: 'status', provider, pools });
    }
    return units;
  }

  async runChecks(now) {
    await loadCatalog(this.env);
    const byProvider = this.pools();
    const units = this.checkUnits(byProvider);
    // Forget the checks of keys disabled since.
    const known = new Set(units.map(unit => unit.id));
    for (const id of Object.keys(this.checks)) {
      if (!known.has(id)) { delete this.checks[id]; this.dirty = true; }
    }
    const due = units.filter(unit => now - (this.checks[unit.id] || 0) >= CHECK_INTERVAL_MS)
      .sort((a, b) => (this.checks[a.id] || 0) - (this.checks[b.id] || 0))
      .slice(0, CHECKS_PER_ALARM);
    for (const unit of due) {
      this.checks[unit.id] = now;
      this.dirty = true;
      if (unit.type === 'list') await this.checkList(unit, now);
      else if (unit.type === 'key') await this.checkKey(unit, now);
      else await this.checkStatusPage(unit.provider, unit.pools, now);
    }
    await this.runProbes(byProvider, now);
    await this.runCanaries(byProvider, now);
  }

  // A failed check (thrown, timed out, not 200 or an unreadable body) logs its id, time and
  // status, never the body or headers; a throw returns null. An error body is kept (16 KiB) for
  // rejected() only.
  async getJson(id, url, headers = {}) {
    const started = this.now();
    try {
      const response = await this.fetch_(url, { headers, signal: AbortSignal.timeout(this.fetchTimeoutMs) });
      let bodyError = null;
      const body = response.ok ? await response.json().catch(error => { bodyError = error; return null; }) : null;
      const text = response.ok ? '' : (await response.text().catch(() => '')).slice(0, 16384);
      if (response.status !== 200 || bodyError) {
        console.warn('HealthHub check failed', { check: id, ms: this.now() - started, status: response.status,
          ...(bodyError ? { error: bodyError.name ?? null } : {}) });
      }
      return { status: response.status, body, text };
    } catch (error) {
      console.warn('HealthHub check failed', { check: id, ms: this.now() - started, status: null, error: error?.name ?? null });
      return null;
    }
  }

  // 401/403, or a structured reason that the key cannot serve (Gemini answers an invalid key
  // with 400 API_KEY_INVALID).
  rejected(result) {
    if (result.status === 401 || result.status === 403) return true;
    return result.status >= 400 && classifyUpstreamFailure(result.status, result.text).kind === FailureKind.AUTH;
  }

  async checkList(unit, now) {
    const check = LIST_CHECKS[unit.provider];
    const secret = check.header ? poolSecret(this.env, unit.pools[0].pool) : null;
    const result = await this.getJson(unit.id, check.url, authHeaders(check.header, secret));
    if (!result) return; // the list endpoint being slow says nothing about the models
    if (check.header && this.rejected(result)) {
      for (const { key } of unit.pools) this.mark(key, now, { kind: FailureKind.AUTH });
      return;
    }
    const ids = result.status === 200 ? check.ids(result.body) : null;
    if (!Array.isArray(ids) || !ids.length) return;
    const listed = new Set(ids);
    for (const { entry, key } of unit.pools) {
      if (!listed.has(entry.upstream_model)) this.mark(key, now, { kind: FailureKind.MODEL_UNAVAILABLE });
      else this.seen.set(key, now);
    }
  }

  async checkKey(unit, now) {
    const check = KEY_CHECKS[unit.provider];
    const result = await this.getJson(unit.id, check.url, authHeaders(check.header, poolSecret(this.env, unit.pools[0].pool)));
    if (!result) return;
    if (this.rejected(result)) {
      for (const { key } of unit.pools) this.mark(key, now, { kind: FailureKind.AUTH });
    } else if (result.status === 200) {
      for (const { key } of unit.pools) this.seen.set(key, now);
    }
  }

  async checkStatusPage(provider, pools, now) {
    const check = STATUS_CHECKS[provider];
    const result = await this.getJson(`status:${provider}`, check.url);
    if (!result) return;
    const components = new Map((result.body?.components || []).map(component => [component.name, component.status]));
    if (!components.size) return;
    for (const { entry, key } of pools) {
      const status = components.get(check.component(entry));
      if (!status) continue;
      const record = this.tracker.getRecord(key);
      if (status === 'major_outage') {
        record.status = HealthState.DOWN;
        record.circuit_open_until = Math.max(record.circuit_open_until || 0, now + STATUS_HOLD_MS);
        record.status_source = 'status_page';
      } else if (status === 'partial_outage' || status === 'degraded_performance' || status === 'under_maintenance') {
        if (record.status === HealthState.HEALTHY) record.status = HealthState.DEGRADED;
        record.status_source = 'status_page';
      } else if (status === 'operational' && record.status_source === 'status_page') {
        // The page put this pool down or degraded; it no longer says so.
        record.status = HealthState.HEALTHY;
        record.circuit_open_until = 0;
        record.status_source = null;
      }
      this.seen.set(key, now);
      this.dirty = true;
    }
  }

  mark(key, now, failure) {
    this.tracker.recordFailure(key, { kind: failure.kind, retryAfterSeconds: failure.retryAfterSeconds || 0,
      dailyQuota: failure.dailyQuota === true });
    this.seen.set(key, now);
    this.dirty = true;
  }

  async runProbes(byProvider, now) {
    const day = utcDay(now);
    if (this.probes.day !== day) this.probes = { day, counts: {} };
    let sent = 0;
    for (const [provider, pools] of byProvider) {
      const cap = PROBE_DAILY_CAPS[provider] ?? 0;
      if (!cap) continue;
      for (const { entry, pool, key } of pools) {
        if (sent >= PROBES_PER_ALARM) return;
        const record = this.tracker.records.get(key);
        // Only a pool that failed, whose cooldown is over (half-open), that real traffic has
        // left alone for a while: everything else is already known from real requests.
        if (!record || record.status === HealthState.HEALTHY || record.circuit_open_until > now) continue;
        if (record.status_source === 'status_page') continue;
        if (now - (this.realAt.get(key) || 0) < IDLE_MS) continue;
        if ((this.probes.counts[key] || 0) >= cap) continue;
        this.probes.counts[key] = (this.probes.counts[key] || 0) + 1;
        sent++;
        const started = this.now();
        const outcome = await this.probe(entry, pool, key, now);
        console.info('HealthHub probe', { pool: key, outcome, ms: this.now() - started });
      }
    }
  }

  // Canaries for healthy pools nobody has used for 15 minutes, oldest first, within half the
  // daily cap (the other half stays for half-open probes).
  async runCanaries(byProvider, now) {
    if (this.env?.HEALTH_CANARIES === 'false') return;
    const day = utcDay(now);
    if (this.probes.day !== day) this.probes = { day, counts: {}, canaries: {} };
    this.probes.canaries ||= {};
    const due = [];
    for (const [provider, pools] of byProvider) {
      const cap = PROBE_DAILY_CAPS[provider] ?? 0;
      if (!canaryBudget(cap)) continue;
      for (const item of pools) {
        const record = this.tracker.records.get(item.key);
        if (record && (record.status !== HealthState.HEALTHY || record.circuit_open_until > now)) continue;
        if (now - (this.realAt.get(item.key) || 0) < CANARY_IDLE_MS) continue;
        const last = this.canaries[item.key]?.at || 0;
        if (now - last < canaryIntervalMs(cap)) continue;
        if ((this.probes.canaries[item.key] || 0) >= canaryBudget(cap) || (this.probes.counts[item.key] || 0) >= cap) continue;
        due.push({ ...item, last });
      }
    }
    for (const item of due.sort((a, b) => a.last - b.last).slice(0, CANARIES_PER_ALARM)) {
      this.probes.canaries[item.key] = (this.probes.canaries[item.key] || 0) + 1;
      this.probes.counts[item.key] = (this.probes.counts[item.key] || 0) + 1;
      this.dirty = true;
      await this.canary(item.entry, item.pool, item.key, now);
    }
  }

  // One streamed tool call through the adapter real traffic uses: passes when the stream carries
  // the test tool call with valid arguments. Workers AI streams a native format, so it gets the
  // one-line request instead.
  async canary(entry, pool, key, now) {
    if (entry.provider === 'cloudflare' || !ADAPTERS[entry.provider]) {
      await this.probe(entry, pool, key, now);
      const record = this.tracker.records.get(key);
      this.canaries[key] = { at: now, ok: record?.status === HealthState.HEALTHY, kind: 'completion' };
      return;
    }
    const payload = buildUpstreamPayload(entry, {
      messages: [
        { role: 'system', content: 'You are a connectivity test. Answer only by calling the record_result tool.' },
        { role: 'user', content: 'Call record_result with status "ok" and value 42.' },
      ],
      tools: [TEST_TOOL], tool_choice: 'auto', stream: true,
    }, 256);
    const started = this.now();
    const result = { at: now, ok: false, kind: 'stream_tool_call' };
    try {
      const response = await ADAPTERS[entry.provider].chatCompletion(this.env, {}, entry, payload, AbortSignal.timeout(30_000), pool);
      if (!response.ok) {
        const text = (await response.text().catch(() => '')).slice(0, 8192);
        const failure = classifyUpstreamFailure(response.status, text, response.headers);
        this.mark(key, now, failure);
        this.canaries[key] = { ...result, http_status: response.status,
          error: upstreamErrorSummary(response.status, text, { secrets: [poolSecret(this.env, pool)] }) };
        return;
      }
      const stream = await readStream(response, started);
      const call = stream.calls.find(item => item.name === TEST_TOOL.function.name);
      let args = null;
      try { args = call ? JSON.parse(call.arguments || '{}') : null; } catch { /* reported below */ }
      const ok = args?.status === 'ok';
      this.canaries[key] = { ...result, ok, tool_call: Boolean(call), first_byte_ms: stream.firstByteMs,
        latency_ms: this.now() - started, finish_reason: stream.finish,
        ...(ok ? {} : { error: { message: call ? 'The tool call arguments were not valid.' : 'The stream ended without the test tool call.' } }) };
      if (ok) {
        this.tracker.recordSuccess(key, { latencyMs: stream.firstByteMs ?? this.now() - started });
        this.seen.set(key, now);
      } else {
        // Tools stopped working on this pool: degraded first, down after repeated failures.
        this.mark(key, now, { kind: FailureKind.SERVER });
      }
    } catch (error) {
      const timeout = error?.name === 'TimeoutError';
      this.mark(key, now, { kind: timeout ? FailureKind.TIMEOUT : FailureKind.SERVER });
      this.canaries[key] = { ...result, error: { message: timeout ? 'No complete answer within 30 s.' : 'The request failed.' } };
    }
  }

  // One minimal non-streaming request through the same adapter real traffic uses, so every
  // provider-specific error mapping (Workers AI 3036/3040, Gemini RPC reasons, ...) applies.
  // Returns the outcome: 'ok', 'no_choices' or the failure kind.
  async probe(entry, pool, key, now) {
    const body = { model: entry.id, stream: false, max_tokens: 8,
      messages: [{ role: 'user', content: 'Reply with the single word OK.' }] };
    const started = this.now();
    try {
      const response = await requestCompletion(this.env, {}, entry, body, AbortSignal.timeout(20_000), pool);
      const text = await response.text();
      if (response.ok) {
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* checked below */ }
        // A 200 alone is not health (a retired API can answer 200 to everything).
        if (Array.isArray(parsed?.choices) && parsed.choices.length) {
          this.tracker.recordSuccess(key, { latencyMs: this.now() - started });
          this.seen.set(key, now);
          this.dirty = true;
          return 'ok';
        }
        this.mark(key, now, { kind: FailureKind.SERVER });
        return 'no_choices';
      }
      const failure = classifyUpstreamFailure(response.status, text, response.headers);
      this.mark(key, now, failure);
      return failure.kind;
    } catch (error) {
      const kind = error?.name === 'TimeoutError' ? FailureKind.TIMEOUT : FailureKind.SERVER;
      this.mark(key, now, { kind });
      return kind;
    }
  }
}

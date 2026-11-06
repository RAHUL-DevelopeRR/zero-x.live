// The checker's verdict rows on the Worker (src/probe-rows-db.js, docs/PLATFORM_CONTRACT.md section
// 16.5): offline, a stubbed reader and a stubbed PostgREST.
//   * dbProbeRows: the rows as a Map, cached per isolate and env for 30 s, one shared read for
//     concurrent callers, the last rows kept for 10 minutes when a read fails and then dropped, a
//     missing RPC (PGRST202) or HEALTH_PROBES_DB_ROWS=off answering null without a retry for 10
//     minutes (one log line), no database answering null;
//   * through /v1/models, /v1/models/status and /v1/models/stream's payload: a Worker with no checker
//     shows the checker's verdict, latency, checked_at and per-route stale horizon, a fresher
//     observation of its own wins, a Worker without the RPC answers as before, the ETag ignores latency.
import assert from 'node:assert/strict';
import { dbProbeRows, dbProbeRowsState, resetProbeRows, ROWS_KEEP_MS, ROWS_TTL_MS, setProbeRowsReader } from './src/probe-rows-db.js';
import { v1ModelsPayload, v1ModelStatusPayload } from './src/routes/plans.js';
import { catalogEntry, poolKey } from './src/catalog.js';
import { globalHealthTracker, FailureKind } from './src/provider-health.js';
import { resetSharedHealthCache } from './src/health-share.js';

const passed = [];
const ok = name => { passed.push(name); console.log(`ok - ${name}`); };
const DB = { SUPABASE_URL: 'https://rows.supabase.test', SUPABASE_SECRET_KEY: 'sb_secret_probe_rows_test' };
const logged = [];
const realError = console.error;
console.error = (...args) => { logged.push(args.join(' ')); };
const now = Date.UTC(2026, 10, 6, 12, 0, 0);
const iso = ms => new Date(ms).toISOString();

const row = (pool, extra = {}) => ({ pool, model: 'x', tier: 'free', status: 'available', base_status: 'available', available_again_at: null,
  latency_ms: 410, last_success_at: iso(now - 60_000), failure_class: null, checked_at: iso(now - 30_000), verdict_at: iso(now - 30_000),
  listed_at: iso(now - 30_000), ...extra });

// 1. dbProbeRows.
{
  let calls = 0;
  let rows = [row('groq:openai/gpt-oss-120b:free'), row('zai:glm-4.7-flash:free', { status: 'busy', available_again_at: iso(now + 20_000), latency_ms: null })];
  const previous = setProbeRowsReader(async (env, args) => { calls += 1; assert.deepEqual(args, { p_since_seconds: 86400 }); return rows; });
  try {
    const env = { ...DB };
    const first = await dbProbeRows(env, now);
    assert.ok(first instanceof Map);
    assert.deepEqual([...first.keys()], ['groq:openai/gpt-oss-120b:free', 'zai:glm-4.7-flash:free']);
    assert.equal(first.get('groq:openai/gpt-oss-120b:free').latency_ms, 410);
    assert.equal(calls, 1);
    assert.equal(await dbProbeRows(env, now + ROWS_TTL_MS - 1_000), first, 'within 30 s: the cached rows, no read');
    assert.equal(calls, 1);
    const second = await dbProbeRows(env, now + ROWS_TTL_MS + 1_000);
    assert.notEqual(second, first);
    assert.equal(calls, 2, 'after 30 s: one more read');
    assert.deepEqual(dbProbeRowsState(env, now + ROWS_TTL_MS + 2_000), { source: 'database', rows: 2, read_at: iso(now + ROWS_TTL_MS + 1_000),
      missing_migration: false, disabled: false });
    ok('dbProbeRows: the rows as a Map, cached for 30 s per isolate, then read again');

    // Concurrent callers share one read.
    const shared = { ...DB };
    calls = 0;
    const results = await Promise.all(Array.from({ length: 6 }, () => dbProbeRows(shared, now)));
    assert.equal(calls, 1);
    assert.ok(results.every(map => map === results[0]));
    // Another isolate's env object has its own cache.
    await dbProbeRows({ ...DB }, now);
    assert.equal(calls, 2);
    ok('dbProbeRows: concurrent callers share one read; each env object has its own cache');

    // A failing read keeps the last rows for 10 minutes, then drops them.
    const flaky = { ...DB };
    calls = 0;
    const good = await dbProbeRows(flaky, now);
    calls = 0;
    setProbeRowsReader(async () => { calls += 1; throw new Error('database down'); });
    const during = await dbProbeRows(flaky, now + ROWS_TTL_MS + 1_000);
    assert.equal(during, good, 'a failed read keeps the last rows');
    assert.equal(calls, 1);
    assert.equal(await dbProbeRows(flaky, now + ROWS_TTL_MS + 3_000), good, 'not retried for a few seconds');
    assert.equal(calls, 1);
    assert.equal(await dbProbeRows(flaky, now + ROWS_KEEP_MS - 1_000), good, 'still kept just under 10 minutes');
    assert.equal(await dbProbeRows(flaky, now + ROWS_KEEP_MS + 60_000), null, 'then nothing');
    ok('dbProbeRows: a failing read keeps the last rows for 10 minutes, then null');

    // A missing RPC: null, remembered for 10 minutes, one log line.
    logged.length = 0;
    const old = { ...DB };
    calls = 0;
    setProbeRowsReader(async () => { calls += 1; throw Object.assign(new Error('Could not find the function'), { code: 'PGRST202' }); });
    assert.equal(await dbProbeRows(old, now), null);
    assert.equal(await dbProbeRows(old, now + 60_000), null);
    assert.equal(await dbProbeRows(old, now + ROWS_KEEP_MS - 1_000), null);
    assert.equal(calls, 1, 'no retry for 10 minutes');
    assert.deepEqual(logged.filter(line => /20261104000000_health_probes/.test(line)).length, 1, 'one log line');
    assert.equal(dbProbeRowsState(old, now + 1_000).missing_migration, true);
    assert.equal(await dbProbeRows(old, now + ROWS_KEEP_MS + 1_000), null);
    assert.equal(calls, 2, 'tried again afterwards');
    // Postgres reports the same thing as 42883 (PGlite, a direct connection).
    setProbeRowsReader(async () => { throw Object.assign(new Error('function does not exist'), { code: '42883' }); });
    assert.equal(await dbProbeRows({ ...DB }, now), null);
    ok('dbProbeRows: a missing RPC (PGRST202 or 42883) is null with no retry for 10 minutes and one log line');

    // Off and no database: null without a read.
    calls = 0;
    setProbeRowsReader(async () => { calls += 1; return rows; });
    assert.equal(await dbProbeRows({ ...DB, HEALTH_PROBES_DB_ROWS: 'off' }, now), null);
    assert.equal(await dbProbeRows({}, now), null);
    assert.equal(await dbProbeRows(null, now), null);
    assert.equal(calls, 0);
    assert.equal(dbProbeRowsState({ ...DB, HEALTH_PROBES_DB_ROWS: 'off' }).disabled, true);
    ok('dbProbeRows: HEALTH_PROBES_DB_ROWS=off, no database or no env answer null without a read');
  } finally {
    setProbeRowsReader(previous === undefined ? null : null);
  }
}

// 2. Through the models payloads of a Worker: a stubbed PostgREST holds the checker's rows.
{
  setProbeRowsReader(null);
  const sonnet = catalogEntry('anthropic/claude-sonnet-5-5');
  const groq = catalogEntry('groq/openai/gpt-oss-120b');
  const glm = catalogEntry('zai/glm-4.7-flash');
  const haiku = catalogEntry('anthropic/claude-haiku-5-5');
  const keyOf = (entry, tier) => poolKey(entry, entry.pools.find(pool => pool.tier === tier));
  const at = Date.now();
  const stored = [
    row(keyOf(sonnet, 'paid'), { latency_ms: 1200, checked_at: iso(at - 60_000), verdict_at: iso(at - 60_000) }),
    row(keyOf(groq, 'free'), { latency_ms: 410, checked_at: iso(at - 120_000), verdict_at: iso(at - 120_000) }),
    row(keyOf(glm, 'free'), { status: 'unavailable', base_status: 'available', available_again_at: iso(at + 600_000), failure_class: 'rate_limited',
      latency_ms: null, checked_at: iso(at - 30_000), verdict_at: iso(at - 3_600_000) }),
    row(keyOf(haiku, 'free'), { latency_ms: 880, checked_at: iso(at - 10_000), verdict_at: iso(at - 10_000) }),
  ];
  let reads = 0;
  let behaviour = 'rows';
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input?.url ?? input);
    if (!url.startsWith(`${DB.SUPABASE_URL}/rest/v1/rpc/`)) throw new Error(`Unexpected outbound request: ${url}`);
    const name = url.split('/').at(-1);
    if (name === 'zerox_pool_health_get') {
      reads += 1;
      if (behaviour === 'missing') return Response.json({ code: 'PGRST202', message: 'Could not find the function' }, { status: 404 });
      return Response.json(stored);
    }
    return Response.json({ code: 'PGRST202', message: `Could not find the function ${name}` }, { status: 404 });
  };
  try {
    const worker = () => ({ ...DB, ANTHROPIC_API_KEY: 'k1', GROQ_API_KEY: 'k2', GLM_API_KEY: 'k3', NVIDIA_API_KEY: 'k4', NVIDIA_HOSTED: 'true', ALLOW_UNKNOWN_COUNTRY: 'true',
      HEALTH_HUB: undefined, SESSIONS_KV: undefined });
    const c = env => ({ env, req: { raw: new Request('https://neuron.zero-x.live/v1/models') } });
    const env = worker();
    resetSharedHealthCache();
    globalHealthTracker.records?.clear?.();
    const payload = await v1ModelsPayload(c(env), {}, { routes: true });
    const byId = Object.fromEntries(payload.data.map(model => [model.id, model]));
    assert.equal(byId['anthropic/claude-sonnet-5-5'].status, 'available', 'the checker says available, not unknown');
    assert.equal(byId['anthropic/claude-sonnet-5-5'].latency_ms, 1200);
    assert.equal(byId['anthropic/claude-sonnet-5-5'].checked_at, iso(at - 60_000));
    assert.equal(byId['anthropic/claude-sonnet-5-5'].stale_after_seconds, 2700, 'Claude: 1.5 x its 30-minute test interval');
    assert.equal(byId['groq/openai/gpt-oss-120b'].latency_ms, 410);
    assert.equal(byId['groq/openai/gpt-oss-120b'].stale_after_seconds, 5400, 'Groq free: 1.5 x hourly');
    assert.equal(byId['anthropic/claude-haiku-5-5'].stale_after_seconds, 2700, 'Haiku 5.5 (sponsored free pool): the paid Claude schedule');
    assert.equal(byId['anthropic/claude-haiku-5-5'].latency_ms, 880);
    assert.deepEqual([byId['zai/glm-4.7-flash'].status, byId['zai/glm-4.7-flash'].availability, byId['zai/glm-4.7-flash'].last_failure_class],
      ['blurred', 'unavailable', 'rate_limited'], 'an unavailable verdict reads blurred in the v1.3 words and unavailable in section 15');
    assert.ok(byId['zai/glm-4.7-flash'].available_again_at);
    assert.equal(reads, 1);
    // The three endpoints go through one payload: a second call within 30 s does not read again.
    const status = await v1ModelStatusPayload(c(env), {}, { routes: true });
    assert.equal(reads, 1, 'cached for 30 s');
    const sonnetRow = status.body.data.find(item => item.id === 'anthropic/claude-sonnet-5-5');
    assert.deepEqual([sonnetRow.status, sonnetRow.latency_ms, sonnetRow.checked_at, sonnetRow.stale_after_seconds], ['available', 1200, iso(at - 60_000), 2700]);
    assert.equal(status.body.stale_after_seconds, 1200, 'the top-level figure is still the floor');
    // The ETag ignores latency and checked_at: a new latency is the same state.
    stored[0] = { ...stored[0], latency_ms: 1500, checked_at: iso(at - 5_000) };
    const later = await v1ModelStatusPayload(c(worker()), {}, { routes: true });
    assert.equal(later.etag, status.etag, 'the ETag ignores latency_ms and checked_at');
    ok('a Worker with no checker shows the checker\'s verdicts, latency, checked_at and per-route stale horizons from the rows; one read per 30 s; ETag ignores latency');

    // The families view agrees with the VM: GLM is unavailable, Claude available, with latency.
    const families = await v1ModelsPayload(c(worker()), {});
    const family = Object.fromEntries(families.data.map(model => [model.id, model]));
    assert.equal(family['anthropic/claude-sonnet-5-5'].latency_ms, 1500);
    assert.equal(family['zhipu/glm-4.7-flash'].status, 'blurred');
    ok('the family view of the Worker carries the same verdict and latency');

    // The root cause of the 2026-11-06 difference between the hosts (GPT-OSS 20B listed with 131,072 on the Worker and
    // 8,000 on the VM): a family's usable window is the largest of the routes that can serve now (catalog.js describeFamily),
    // so it follows the routes' health. The VM knew NVIDIA's route was out; the Worker, without the checker's rows, did not.
    const nvidia20 = catalogEntry('nvidia/openai/gpt-oss-20b');
    const groq20 = catalogEntry('groq/openai/gpt-oss-20b');
    stored.push(row(keyOf(groq20, 'free'), { checked_at: iso(at - 20_000), verdict_at: iso(at - 20_000) }),
      row(keyOf(nvidia20, 'free'), { status: 'unavailable', base_status: 'unavailable', available_again_at: iso(at + 600_000), failure_class: 'busy',
        latency_ms: null, checked_at: iso(at - 20_000), verdict_at: iso(at - 20_000) }));
    const withRows = Object.fromEntries((await v1ModelsPayload(c(worker()), {})).data.map(model => [model.id, model]));
    assert.deepEqual([withRows['openai/gpt-oss-20b'].context_window, withRows['openai/gpt-oss-20b'].max_output_tokens], [8000, 2000],
      'with the rows of the checker the Worker lists what the VM lists: only the Groq route can serve');
    behaviour = 'missing';
    const withoutRows = Object.fromEntries((await v1ModelsPayload(c(worker()), {})).data.map(model => [model.id, model]));
    assert.equal(withoutRows['openai/gpt-oss-20b'].context_window, 131072, 'without them both routes read unknown and the larger window is listed (the old Worker answer)');
    behaviour = 'rows';
    ok('root cause: the family window follows the health of its routes, so the Worker lists the window of the VM once it reads the rows of the checker');

    // This isolate's own fresher failure wins over the checker's older verdict.
    const fresh = worker();
    resetProbeRows(fresh);
    globalHealthTracker.recordFailure(keyOf(groq, 'free'), { success: false, kind: FailureKind.RATE_LIMITED, retryAfterSeconds: 300, latencyMs: 50, phase: null, caller: 'c', dailyQuota: false });
    const flipped = Object.fromEntries((await v1ModelsPayload(c(fresh), {}, { routes: true })).data.map(model => [model.id, model]));
    assert.notEqual(flipped['groq/openai/gpt-oss-120b'].status, 'available', 'a real failure seen by this isolate flips the model at once');
    globalHealthTracker.records?.clear?.();
    ok('the freshest observation wins: a failure this isolate saw beats the checker\'s older available');

    // Without the RPC (migration missing) the Worker answers as before: flat horizon, nothing from the checker.
    behaviour = 'missing';
    const noRpc = worker();
    const before = await v1ModelsPayload(c(noRpc), {}, { routes: true });
    const plain = Object.fromEntries(before.data.map(model => [model.id, model]));
    assert.equal(plain['anthropic/claude-sonnet-5-5'].status, 'unknown');
    assert.equal(plain['anthropic/claude-sonnet-5-5'].latency_ms, null);
    assert.equal(plain['anthropic/claude-sonnet-5-5'].stale_after_seconds, 1200, 'HEALTH_STALE_SECONDS for every route, as before');
    assert.equal(dbProbeRowsState(noRpc).missing_migration, true);
    const off = { ...worker(), HEALTH_PROBES_DB_ROWS: 'off' };
    const offRows = Object.fromEntries((await v1ModelsPayload(c(off), {}, { routes: true })).data.map(model => [model.id, model]));
    assert.equal(offRows['anthropic/claude-sonnet-5-5'].status, 'unknown');
    ok('without the RPC or with HEALTH_PROBES_DB_ROWS=off the Worker answers exactly as before (unknown, no latency, flat horizon)');
  } finally {
    globalThis.fetch = realFetch;
    console.error = realError;
  }
}

console.log(`PASS: ${passed.length} Worker verdict-row checks`);

// Business data model checks: applies every migration to a fresh PGlite through the
// DATABASE_DRIVER=pglite account-store path and exercises every RPC in
// docs/PLATFORM_CONTRACT.md section 4, the access controls and the operator scripts.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { AccountDatabaseError, databaseConfigured, databaseDriver, localDatabaseRefusal, rpc, rpcRows } from './src/account-store.js';
import { closeAllPglite, closePglite, getPgliteHandle, migrate } from './src/db/pglite.js';
import { DEV_BOOTSTRAP_SQL } from './src/db/bootstrap.js';
import { listMigrations, readMigration } from './src/db/migrations.js';
import { connectionEnv, maskUrl, migrationScript } from './scripts/apply-migrations.mjs';
import { Hono } from 'hono';
import { createChatHandler } from './src/chat-handler.js';
import { RoutingEngine } from './src/router.js';
import { ProviderHealthTracker } from './src/provider-health.js';
import { estimatePromptTokens } from './src/pricing.js';
import { RESERVED_OUTPUT_TOKENS } from './src/capacity.js';
import { resetPoolBudgets } from './src/pool-budget.js';
import { v1ModelsPayload } from './src/routes/plans.js';

const root = dirname(fileURLToPath(import.meta.url));
const env = { DATABASE_DRIVER: 'pglite' };
const sha = value => createHash('sha256').update(value).digest('hex');
const sleep = ms => new Promise(done => setTimeout(done, ms));
const utcDay = offset => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const passed = [];
function ok(name) { passed.push(name); console.log(`ok - ${name}`); }

// Minute buckets and UTC days roll over on the wall clock; keep each timed section clear of a boundary.
async function clockHeadroom(seconds = 12) {
  const now = new Date();
  const intoMinute = now.getUTCSeconds() + now.getUTCMilliseconds() / 1000;
  if (intoMinute > 60 - seconds) await sleep((60 - intoMinute + 0.5) * 1000);
  const toMidnight = 86400 - (Date.now() / 1000) % 86400;
  if (toMidnight < 60) await sleep((toMidnight + 1) * 1000);
}

await clockHeadroom();
const handle = await getPgliteHandle(env);
const db = handle.db;
const sql = async (text, params) => (await db.query(text, params)).rows;
const nextResets = new Date(`${utcDay(1)}T00:00:00Z`).toISOString();
const todayUtc = utcDay(0);

let userCounter = 0;
async function newUser(plan = 'free', { credits = 0, suspended = false } = {}) {
  userCounter += 1;
  const email = `user${userCounter}-${randomUUID().slice(0, 8)}@example.test`;
  const [{ id }] = await sql('INSERT INTO auth.users (email) VALUES ($1) RETURNING id', [email]);
  await rpc(env, 'zerox_sync_account', { p_user_id: id, p_profile: { email, name: `User ${userCounter}` } });
  await sql(`UPDATE public.zerox_accounts SET plan = $2, credit_balance_microusd = $3, suspended = $4,
    plan_source = CASE WHEN $2 = 'free' THEN 'default' ELSE 'manual' END WHERE clerk_id = $1`,
  [id, plan, credits, suspended]);
  return id;
}
const account = async id => (await sql('SELECT * FROM public.zerox_accounts WHERE clerk_id = $1', [id]))[0];
const reserve = (userId, overrides = {}) => rpc(env, 'zerox_reserve_v2', {
  p_user_id: userId, p_request_id: `req_${randomUUID()}`, p_model: 'test/model', p_tier: 'free',
  p_tokens: 100, p_cost_microusd: 0, p_pool: null, ...overrides,
});
const settle = (reservationId, overrides = {}) => rpc(env, 'zerox_settle_v2', {
  p_reservation_id: reservationId, p_prompt_tokens: 10, p_completion_tokens: 5, p_cost_microusd: 0,
  p_status: 'ok', p_latency_ms: 20, p_provider: 'test', p_upstream_model: 'model', p_error_code: null, ...overrides,
});
const poolRow = async (model, tier, bucket) => (await sql(`SELECT * FROM public.zerox_pool_usage
  WHERE model = $1 AND tier = $2 AND bucket = $3 ORDER BY bucket_start DESC LIMIT 1`, [model, tier, bucket]))[0];

try {
  // ---------------------------------------------------------------- driver and migrations
  assert.equal(databaseDriver(env), 'pglite');
  assert.equal(databaseConfigured(env), true, 'pglite driver counts as configured');
  assert.equal(databaseConfigured({}), false);
  assert.equal(databaseConfigured({ DATABASE_DRIVER: 'mysql', SUPABASE_URL: 'https://x', SUPABASE_SECRET_KEY: 'sb_secret_x' }), false);
  assert.equal(databaseConfigured({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_x' }), true);
  // The local driver is refused wherever it could silently serve real users.
  for (const [extra, reason] of [
    [{ NODE_ENV: 'production' }, /refused when NODE_ENV=production/],
    [{ NODE_ENV: 'production', ALLOW_LOCAL_DATABASE: 'true' }, /refused when NODE_ENV=production/],
    [{ AUTH_HOST: '0.0.0.0' }, /only serves a gateway bound to loopback \(AUTH_HOST=0\.0\.0\.0\)/],
    [{ AUTH_HOST: '192.168.1.20' }, /ALLOW_LOCAL_DATABASE=true/],
  ]) {
    const refusedEnv = { ...env, ...extra };
    assert.equal(databaseConfigured(refusedEnv), false, JSON.stringify(extra));
    assert.match(localDatabaseRefusal(refusedEnv), reason);
    await assert.rejects(rpc(refusedEnv, 'zerox_plan_policies_v2', {}), error =>
      error instanceof AccountDatabaseError && reason.test(error.message));
  }
  for (const extra of [{ AUTH_HOST: '127.0.0.1' }, { AUTH_HOST: 'localhost' }, { AUTH_HOST: '::1' }, { AUTH_HOST: '127.0.0.2' },
    { AUTH_HOST: '0.0.0.0', ALLOW_LOCAL_DATABASE: 'true' }, { NODE_ENV: 'development' }]) {
    assert.equal(databaseConfigured({ ...env, ...extra }), true, JSON.stringify(extra));
    assert.equal(localDatabaseRefusal({ ...env, ...extra }), null);
  }
  const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'Cloudflare-Workers' }, configurable: true });
  try {
    assert.equal(databaseConfigured(env), false, 'pglite is never configured inside Cloudflare Workers');
    await assert.rejects(rpc(env, 'zerox_plan_policies_v2', {}), /not available in Cloudflare Workers/);
  } finally { Object.defineProperty(globalThis, 'navigator', realNavigator); }
  assert.equal(databaseConfigured(env), true);
  const storeSource = await readFile(join(root, 'src/account-store.js'), 'utf8');
  assert.ok(!/\b(?:from|import)\s*\(?\s*['"][^'"]*pglite[^'"]*['"]/.test(storeSource),
    'account-store never imports the PGlite driver statically or with a bundler-visible specifier');
  assert.ok(!/node:/.test(storeSource) && !/node:/.test(await readFile(join(root, 'src/db/errors.js'), 'utf8')),
    'Worker-bundled modules stay free of Node built-ins');
  const migrations = await listMigrations();
  assert.deepEqual(handle.applied, migrations.map(migration => migration.version), 'all migrations applied in version order');
  assert.deepEqual(migrations.slice(-8).map(migration => migration.file), [
    '20261016000000_business_schema.sql', '20261016000100_business_quota.sql',
    '20261016000200_business_billing.sql', '20261016000300_business_sessions_admin.sql',
    '20261019000000_device_auth.sql', '20261019120000_provider_discovery.sql', '20261021000000_device_pending_retry.sql',
    '20261028000000_reservation_leases.sql']);
  assert.equal((await sql('SELECT count(*)::int AS n FROM supabase_migrations.schema_migrations'))[0].n, migrations.length);
  await assert.rejects(rpc(env, 'zerox_does_not_exist', {}), error =>
    error instanceof AccountDatabaseError && error.code === 'PGRST202');
  await assert.rejects(rpc(env, 'zerox_plan_policies_v2', { p_unknown: 1 }), /Could not find the function/);
  await assert.rejects(rpc(env, 'zerox_reserve_v2; DROP TABLE x', {}), /Invalid database function name/);
  await assert.rejects(reserve(randomUUID(), { p_tier: 'gold' }), error =>
    error instanceof AccountDatabaseError && /invalid_reservation: p_tier/.test(error.message) && error.code === 'P0001' &&
    error.cause === undefined && !JSON.stringify(error).includes('req_'), 'errors carry the Postgres message but not the arguments');
  assert.deepEqual(await rpcRows(env, 'zerox_session_put', { p_key: 'c'.repeat(64), p_value: 'v', p_ttl: 60 }), [],
    'void functions yield no rows');
  assert.deepEqual(await rpcRows(env, 'zerox_session_get', { p_key: 'c'.repeat(64) }), [{ value: 'v' }],
    'single-column TABLE functions yield objects, as with PostgREST');
  // zerox_session_rearm only rewrites a record that still exists (review P3, integration).
  assert.deepEqual(await rpc(env, 'zerox_session_rearm', { p_key: 'c'.repeat(64), p_value: 'v2', p_ttl: 120 }), { rearmed: true });
  assert.deepEqual(await rpcRows(env, 'zerox_session_get', { p_key: 'c'.repeat(64) }), [{ value: 'v2' }]);
  await rpc(env, 'zerox_session_delete', { p_key: 'c'.repeat(64) });
  assert.deepEqual(await rpc(env, 'zerox_session_rearm', { p_key: 'c'.repeat(64), p_value: 'v3', p_ttl: 120 }), { rearmed: false });
  assert.deepEqual(await rpcRows(env, 'zerox_session_get', { p_key: 'c'.repeat(64) }), [], 'a deleted session is never recreated');
  await assert.rejects(rpc(env, 'zerox_session_rearm', { p_key: 'c'.repeat(64), p_value: 'v', p_ttl: 604801 }), /Invalid session TTL/);
  assert.equal(await rpc(env, 'zerox_subscription_effective_plan', { p_user_id: randomUUID() }), null,
    'a NULL scalar result yields no row');
  assert.equal(await rpc(env, 'zerox_subscription_grants_plan', { p_status: 'active',
    p_current_period_end: new Date(Date.now() + 86400000).toISOString(), p_cancel_at_period_end: false, p_updated_at: null }), true,
    'scalar functions yield bare values');
  ok('pglite driver: configuration, migration order, PostgREST-style errors, void, scalar and row results');

  // ---------------------------------------------------------------- PostgREST path (production)
  const restEnv = { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_check' };
  const realFetch = globalThis.fetch;
  const calls = [];
  const respond = response => async (url, options) => { calls.push({ url, options }); return response(); };
  try {
    globalThis.fetch = respond(() => Response.json([{ claimed: true }]));
    assert.deepEqual(await rpc(restEnv, 'zerox_webhook_claim', { p_provider: 'razorpay', p_event_id: 'e' }), { claimed: true });
    assert.equal(calls[0].url, 'https://project.supabase.co/rest/v1/rpc/zerox_webhook_claim');
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.headers.apikey, 'sb_secret_check');
    assert.deepEqual(JSON.parse(calls[0].options.body), { p_provider: 'razorpay', p_event_id: 'e' });
    globalThis.fetch = respond(() => Response.json({ id: 'single' }));
    assert.deepEqual(await rpcRows(restEnv, 'zerox_get_account', {}), [{ id: 'single' }]);
    globalThis.fetch = respond(() => new Response(null, { status: 204 }));
    assert.deepEqual(await rpcRows(restEnv, 'zerox_session_put', {}), [], '204 from void functions yields no rows');
    globalThis.fetch = respond(() => new Response('null', { status: 200 }));
    assert.equal(await rpc(restEnv, 'zerox_subscription_effective_plan', {}), null);
    globalThis.fetch = respond(() => Response.json({ code: 'P0001', message: 'too_many_keys: an account can have at most 10 active API keys',
      details: null, hint: 'Revoke an existing API key before creating a new one.' }, { status: 400 }));
    await assert.rejects(rpc(restEnv, 'zerox_api_key_create', {}), error => error instanceof AccountDatabaseError &&
      /^Account database request failed \(400\): too_many_keys/.test(error.message) && error.code === 'P0001' &&
      error.status === 400 && /Revoke/.test(error.hint));
    globalThis.fetch = respond(() => new Response('<html>bad gateway</html>', { status: 502 }));
    await assert.rejects(rpc(restEnv, 'zerox_get_account', {}), error => error.message === 'Account database request failed (502)' && error.status === 502);
    await assert.rejects(rpc({}, 'zerox_get_account', {}), /Account database is not configured/);
  } finally { globalThis.fetch = realFetch; }
  ok('PostgREST driver: request shape, object/void/null bodies, Postgres error messages and codes surfaced');

  // ---------------------------------------------------------------- plans
  const plans = await rpcRows(env, 'zerox_plan_policies_v2', {});
  const pick = ({ plan, name, price_usd, price_usd_cents, price_inr_paise, daily_requests, daily_tokens, rpm_limit,
    concurrency_limit, allowed_tiers, monthly_credit_microusd, public: listed }) => ({ plan, name, price_usd,
    price_usd_cents, price_inr_paise, daily_requests, daily_tokens, rpm_limit, concurrency_limit, allowed_tiers,
    monthly_credit_microusd, listed });
  assert.deepEqual(plans.map(pick), [
    { plan: 'free', name: 'Free', price_usd: 0, price_usd_cents: 0, price_inr_paise: 0, daily_requests: 100, daily_tokens: 500000,
      rpm_limit: 10, concurrency_limit: 2, allowed_tiers: ['free'], monthly_credit_microusd: 0, listed: true },
    { plan: 'pro', name: 'Pro', price_usd: 10, price_usd_cents: 1000, price_inr_paise: 89900, daily_requests: 2000,
      daily_tokens: 10000000, rpm_limit: 30, concurrency_limit: 4, allowed_tiers: ['free', 'paid'],
      monthly_credit_microusd: 8000000, listed: true },
    { plan: 'max', name: 'Max', price_usd: 40, price_usd_cents: 4000, price_inr_paise: 349900, daily_requests: 10000,
      daily_tokens: 50000000, rpm_limit: 60, concurrency_limit: 8, allowed_tiers: ['free', 'paid'],
      monthly_credit_microusd: 35000000, listed: true },
    { plan: 'ultrawork', name: 'Pro (legacy)', price_usd: 10, price_usd_cents: 1000, price_inr_paise: 89900,
      daily_requests: 2000, daily_tokens: 10000000, rpm_limit: 30, concurrency_limit: 4, allowed_tiers: ['free', 'paid'],
      monthly_credit_microusd: 8000000, listed: false },
  ]);
  assert.ok(plans.every(plan => Array.isArray(plan.features) && plan.features.length >= 4 && plan.features.every(f => typeof f === 'string')));
  assert.deepEqual(plans.map(plan => plan.highlighted), [false, true, false, false]);
  assert.ok(plans.every(plan => plan.razorpay_plan_id_inr === null && plan.razorpay_plan_id_usd === null));
  const legacy = (await rpc(env, 'zerox_plan_policies', {})).policies;
  assert.deepEqual(Object.keys(legacy).sort(), ['free', 'max', 'pro', 'ultrawork'], 'legacy policy RPC includes max');
  assert.equal(legacy.max.daily_tokens, 50000000);
  await assert.rejects(sql(`INSERT INTO public.zerox_plan_policy (plan, name, daily_tokens, daily_requests, price_usd)
    VALUES ('enterprise', 'Enterprise', 1, 1, 1)`), /zerox_plan_policy_plan_check/);
  ok('plans seeded exactly per contract section 1 (free/pro/max/ultrawork) with features and legacy RPC compatibility');

  // ---------------------------------------------------------------- reserve and settle happy path
  await clockHeadroom();
  const alice = await newUser('free');
  await assert.rejects(sql("UPDATE public.zerox_accounts SET plan = 'enterprise' WHERE clerk_id = $1", [alice]), /zerox_accounts_plan_check/);
  await sql("UPDATE public.zerox_accounts SET plan = 'max' WHERE clerk_id = $1", [alice]);
  await sql("UPDATE public.zerox_accounts SET plan = 'free' WHERE clerk_id = $1", [alice]);
  const pool = { rpm: 30, rpd: 1000, tpm: 8000, tpd: 200000 };
  const first = await reserve(alice, { p_model: 'groq/openai/gpt-oss-120b', p_tokens: 1000, p_pool: pool });
  assert.equal(first.status, 'ok');
  assert.match(first.reservation_id, /^[0-9a-f-]{36}$/);
  assert.equal(first.plan, 'free');
  assert.equal(first.remaining_requests, 99);
  assert.equal(first.remaining_tokens, 499000);
  assert.equal(first.credit_balance_microusd, 0);
  assert.equal(new Date(first.resets_at).toISOString(), nextResets);
  assert.equal(first.retry_after_seconds, null);
  assert.equal((await poolRow('groq/openai/gpt-oss-120b', 'free', 'minute')).tokens, 1000);
  const settled = await settle(first.reservation_id, { p_prompt_tokens: 300, p_completion_tokens: 200, p_latency_ms: 812,
    p_provider: 'groq', p_upstream_model: 'openai/gpt-oss-120b' });
  assert.deepEqual(settled, { status: 'settled', credit_balance_microusd: 0 });
  const aliceRow = await account(alice);
  assert.equal(aliceRow.daily_requests, 1);
  assert.equal(aliceRow.daily_tokens_used, 500, 'tokens reconciled to actual usage');
  assert.equal(aliceRow.total_tokens_used, 500);
  for (const bucket of ['minute', 'day']) {
    const row = await poolRow('groq/openai/gpt-oss-120b', 'free', bucket);
    assert.equal(row.tokens, 500); assert.equal(row.requests, 1);
  }
  const [event] = await rpcRows(env, 'zerox_usage_events', { p_user_id: alice, p_limit: 10, p_before: null });
  assert.equal(event.reservation_id, first.reservation_id);
  assert.equal(event.model, 'groq/openai/gpt-oss-120b');
  assert.equal(event.provider, 'groq');
  assert.equal(event.upstream_model, 'openai/gpt-oss-120b');
  assert.equal(event.status, 'ok');
  assert.equal(event.prompt_tokens, 300); assert.equal(event.completion_tokens, 200); assert.equal(event.latency_ms, 812);
  assert.equal(event.tier, 'free'); assert.equal(event.cost_microusd, 0); assert.equal(typeof event.id, 'number');
  assert.deepEqual(await settle(first.reservation_id, { p_prompt_tokens: 9999 }), { status: 'already_settled', credit_balance_microusd: 0 });
  assert.equal((await account(alice)).daily_tokens_used, 500, 'repeated settle changes nothing');
  assert.equal((await sql('SELECT count(*)::int AS n FROM public.zerox_usage_events WHERE user_id = $1', [alice]))[0].n, 1);
  assert.deepEqual(await settle(randomUUID()), { status: 'not_found', credit_balance_microusd: null });
  await assert.rejects(settle(first.reservation_id, { p_status: 'done' }), /invalid_settlement/);
  await assert.rejects(settle(first.reservation_id, { p_prompt_tokens: -1 }), /invalid_settlement/);
  await assert.rejects(reserve(alice, { p_tokens: 0 }), /invalid_reservation: p_tokens/);
  await assert.rejects(reserve(alice, { p_pool: { rpm: -1 } }), /invalid_pool_budget: rpm/);
  await assert.rejects(reserve(alice, { p_pool: { tpm: 'lots' } }), /invalid_pool_budget: tpm/);
  await assert.rejects(reserve(alice, { p_pool: [1] }), /invalid_pool_budget/);
  ok('reserve/settle happy path, counters reconciled, usage event, idempotent settle, not_found, input validation');

  // ---------------------------------------------------------------- failure statuses
  const missing = await reserve(randomUUID());
  assert.deepEqual(missing, { status: 'no_account', reservation_id: null, plan: null, remaining_requests: null,
    remaining_tokens: null, credit_balance_microusd: null, resets_at: null, retry_after_seconds: null });
  const suspendedUser = await newUser('pro', { suspended: true, credits: 5000000 });
  const suspended = await reserve(suspendedUser);
  assert.equal(suspended.status, 'suspended');
  assert.equal(suspended.reservation_id, null);
  const freeUser = await newUser('free');
  const upgrade = await reserve(freeUser, { p_tier: 'paid', p_cost_microusd: 10 });
  assert.equal(upgrade.status, 'upgrade_required');
  assert.equal(upgrade.reservation_id, null);
  assert.equal(upgrade.plan, 'free');
  await sql('UPDATE public.zerox_accounts SET daily_requests = 100 WHERE clerk_id = $1', [freeUser]);
  const dailyRequests = await reserve(freeUser);
  assert.equal(dailyRequests.status, 'user_daily_requests');
  assert.equal(dailyRequests.remaining_requests, 0);
  assert.equal(new Date(dailyRequests.resets_at).toISOString(), nextResets);
  assert.equal(dailyRequests.retry_after_seconds, null);
  await sql("UPDATE public.zerox_accounts SET daily_requests = 100, daily_tokens_used = 400000, last_usage_reset = '2000-01-01' WHERE clerk_id = $1", [freeUser]);
  const reset = await reserve(freeUser, { p_tokens: 1000 });
  assert.equal(reset.status, 'ok', 'UTC daily reset applies before the cap check');
  assert.equal(reset.remaining_requests, 99);
  assert.equal(reset.remaining_tokens, 499000);
  const resetRow = await account(freeUser);
  assert.equal(resetRow.last_usage_reset.toISOString().slice(0, 10), todayUtc);
  assert.equal(resetRow.daily_requests, 1);
  await settle(reset.reservation_id, { p_prompt_tokens: 1000, p_completion_tokens: 0 });
  const dailyTokens = await reserve(freeUser, { p_tokens: 499001 });
  assert.equal(dailyTokens.status, 'user_daily_tokens');
  assert.equal(dailyTokens.remaining_tokens, 499000);
  assert.equal(new Date(dailyTokens.resets_at).toISOString(), nextResets);
  assert.equal((await reserve(freeUser, { p_tokens: 499000 })).status, 'ok', 'exactly the remaining tokens fit');
  // A reservation from yesterday settled today leaves today's counters alone.
  await sql("UPDATE public.zerox_reservations SET usage_day = usage_day - 1 WHERE user_id = $1 AND status = 'active'", [freeUser]);
  const [yesterday] = await sql("SELECT id FROM public.zerox_reservations WHERE user_id = $1 AND status = 'active'", [freeUser]);
  const beforeSettle = await account(freeUser);
  await settle(yesterday.id, { p_status: 'refunded', p_prompt_tokens: 0, p_completion_tokens: 0 });
  const afterSettle = await account(freeUser);
  assert.equal(afterSettle.daily_requests, beforeSettle.daily_requests);
  assert.equal(afterSettle.daily_tokens_used, beforeSettle.daily_tokens_used);
  ok('no_account, suspended, upgrade_required, user_daily_requests, user_daily_tokens, UTC reset, cross-day settle');

  // ---------------------------------------------------------------- rpm and concurrency
  const rpmUser = await newUser('free');
  for (let index = 0; index < 10; index += 1) {
    const result = await reserve(rpmUser);
    assert.equal(result.status, 'ok');
    await settle(result.reservation_id);
  }
  const limited = await reserve(rpmUser);
  assert.equal(limited.status, 'user_rpm');
  assert.ok(limited.retry_after_seconds >= 1 && limited.retry_after_seconds <= 60, `rpm retry ${limited.retry_after_seconds}`);
  assert.equal(limited.reservation_id, null);
  await sql("UPDATE public.zerox_reservations SET created_at = created_at - interval '61 seconds' WHERE user_id = $1", [rpmUser]);
  assert.equal((await reserve(rpmUser)).status, 'ok', 'rolling 60 s window frees the rpm budget');

  const concurrentUser = await newUser('free');
  const slotA = await reserve(concurrentUser);
  const slotB = await reserve(concurrentUser);
  assert.equal(slotA.status, 'ok'); assert.equal(slotB.status, 'ok');
  const busy = await reserve(concurrentUser);
  assert.equal(busy.status, 'user_concurrency');
  assert.equal(busy.reservation_id, null);
  // A slot is a 90 s lease, and the refusal reports the wait until the first one lapses (it
  // said 5 s while a leaked slot was held for 10 minutes, E2E finding 2026-10-27).
  assert.ok(busy.retry_after_seconds >= 85 && busy.retry_after_seconds <= 90, `concurrency retry ${busy.retry_after_seconds}`);
  await sql("UPDATE public.zerox_reservations SET lease_expires_at = now() + interval '30 seconds' WHERE id = $1", [slotA.reservation_id]);
  const shortLease = await reserve(concurrentUser);
  assert.equal(shortLease.status, 'user_concurrency');
  assert.ok(shortLease.retry_after_seconds >= 29 && shortLease.retry_after_seconds <= 30, `retry ${shortLease.retry_after_seconds}`);
  // Rows reserved under the 10 minute horizon (backfilled leases) never ask for more than 90 s.
  await sql("UPDATE public.zerox_reservations SET lease_expires_at = now() + interval '9 minutes' WHERE user_id = $1 AND status = 'active'",
    [concurrentUser]);
  assert.equal((await reserve(concurrentUser)).retry_after_seconds, 90);
  await settle(slotA.reservation_id);
  const slotC = await reserve(concurrentUser);
  assert.equal(slotC.status, 'ok', 'settling frees a concurrency slot');
  const leaseSeconds = async (id, from = 'now()') => (await sql(`SELECT round(extract(epoch FROM lease_expires_at - ${from}))::int AS s
    FROM public.zerox_reservations WHERE id = $1`, [id]))[0].s;
  assert.equal(await leaseSeconds(slotC.reservation_id, 'created_at'), 90, 'a new reservation leases its slot for 90 s');
  // A lapsed lease (the isolate died: nothing renewed or settled it) is released by the user's
  // next reservation, without the cron, and keeps what it was charged.
  await sql("UPDATE public.zerox_reservations SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [slotB.reservation_id]);
  const beforeHeal = await account(concurrentUser);
  const healed = await reserve(concurrentUser);
  assert.equal(healed.status, 'ok', 'a lapsed lease does not hold a slot');
  assert.deepEqual(await sql(`SELECT status, outcome, settled_at IS NOT NULL AS closed, prompt_tokens, completion_tokens
    FROM public.zerox_reservations WHERE id = $1`, [slotB.reservation_id]),
  [{ status: 'released', outcome: null, closed: true, prompt_tokens: null, completion_tokens: null }]);
  const afterHeal = await account(concurrentUser);
  assert.equal(afterHeal.daily_requests, beforeHeal.daily_requests + 1, 'releasing a lapsed lease refunds nothing');
  assert.equal(afterHeal.daily_tokens_used, beforeHeal.daily_tokens_used + 100);
  const renew = (id, seconds) => rpc(env, 'zerox_renew_reservation', { p_reservation_id: id, p_lease_seconds: seconds });
  assert.equal(await renew(slotB.reservation_id, 90), false, 'a released reservation is not renewed');
  await sql("UPDATE public.zerox_reservations SET lease_expires_at = now() + interval '5 seconds' WHERE id = $1", [slotC.reservation_id]);
  assert.equal(await renew(slotC.reservation_id, 90), true);
  const renewedFor = await leaseSeconds(slotC.reservation_id);
  assert.ok(renewedFor >= 89 && renewedFor <= 90, `a renewal extends the lease to 90 s from now (${renewedFor})`);
  assert.equal(await renew(slotC.reservation_id, 1), true);
  assert.ok(await leaseSeconds(slotC.reservation_id) >= 88, 'a renewal never shortens a lease');
  await settle(slotC.reservation_id);
  assert.equal(await renew(slotC.reservation_id, 90), false, 'a settled reservation is not renewed');
  assert.equal(await renew(randomUUID(), 90), false);
  await assert.rejects(renew(healed.reservation_id, 0), /invalid_lease/);
  await assert.rejects(renew(healed.reservation_id, 3601), /invalid_lease/);
  ok('user_rpm with retry_after_seconds and rolling window, user_concurrency as renewable 90 s leases with the real wait, lapsed leases released by the next reservation');

  // ---------------------------------------------------------------- credits
  const proUser = await newUser('pro');
  const broke = await reserve(proUser, { p_tier: 'paid', p_cost_microusd: 100 });
  assert.equal(broke.status, 'insufficient_credits');
  assert.equal(broke.credit_balance_microusd, 0);
  assert.equal((await reserve(proUser, { p_tier: 'paid', p_cost_microusd: 0 })).status, 'insufficient_credits',
    'paid tier needs a positive balance even for a zero estimate');
  assert.deepEqual(await rpc(env, 'zerox_credit_grant', { p_user_id: proUser, p_delta_microusd: 1000, p_reason: 'topup', p_ref: `test:${proUser}:1` }),
    { granted: true, balance_microusd: 1000 });
  const paidA = await reserve(proUser, { p_tier: 'paid', p_cost_microusd: 600, p_model: 'gemini/gemini-2.5-flash' });
  assert.equal(paidA.status, 'ok');
  assert.equal(paidA.credit_balance_microusd, 1000);
  assert.equal((await reserve(proUser, { p_tier: 'paid', p_cost_microusd: 500 })).status, 'insufficient_credits',
    'credits held by in-flight paid reservations are unavailable');
  assert.equal((await reserve(proUser, { p_tier: 'free' })).status, 'ok', 'free tier needs no credits');
  assert.deepEqual(await settle(paidA.reservation_id, { p_cost_microusd: 400 }), { status: 'settled', credit_balance_microusd: 600 });
  const paidB = await reserve(proUser, { p_tier: 'paid', p_cost_microusd: 500 });
  assert.equal(paidB.status, 'ok');
  assert.deepEqual(await settle(paidB.reservation_id, { p_cost_microusd: 2600 }), { status: 'settled', credit_balance_microusd: 0 },
    'balance clamps at zero');
  const ledger = await sql('SELECT * FROM public.zerox_credit_ledger WHERE user_id = $1 ORDER BY id', [proUser]);
  assert.deepEqual(ledger.map(row => [row.reason, row.delta_microusd, row.balance_after_microusd, row.shortfall_microusd]),
    [['topup', 1000, 1000, 0], ['usage', -400, 600, 0], ['usage', -600, 0, 2000]]);
  assert.equal(ledger[2].ref, `usage:${paidB.reservation_id}`);
  const [paidEvent] = await rpcRows(env, 'zerox_usage_events', { p_user_id: proUser, p_limit: 1 });
  assert.equal(paidEvent.cost_microusd, 2600, 'usage event records the billed cost');
  assert.equal(paidEvent.tier, 'paid');
  await rpc(env, 'zerox_credit_grant', { p_user_id: proUser, p_delta_microusd: 5000, p_reason: 'topup', p_ref: `test:${proUser}:2` });
  const refundedPaid = await reserve(proUser, { p_tier: 'paid', p_cost_microusd: 100 });
  assert.deepEqual(await settle(refundedPaid.reservation_id, { p_status: 'refunded', p_cost_microusd: 100 }),
    { status: 'settled', credit_balance_microusd: 5000 }, 'refunded requests are not billed');
  const freeTierCost = await reserve(proUser, { p_tier: 'free' });
  assert.deepEqual(await settle(freeTierCost.reservation_id, { p_cost_microusd: 999 }),
    { status: 'settled', credit_balance_microusd: 5000 }, 'free pool usage costs no credits');
  // A long-running paid request keeps its credits held for as long as its lease is renewed, until
  // it is settled or released (its lease lapsed).
  const longRunner = await newUser('pro', { credits: 1000 });
  const longPaid = await reserve(longRunner, { p_tier: 'paid', p_cost_microusd: 1000 });
  assert.equal(longPaid.status, 'ok');
  await sql("UPDATE public.zerox_reservations SET created_at = now() - interval '11 minutes' WHERE id = $1", [longPaid.reservation_id]);
  assert.equal((await reserve(longRunner, { p_tier: 'paid', p_cost_microusd: 1000 })).status, 'insufficient_credits',
    'credits stay held while the lease runs, also past the former 10 minute horizon');
  await sql(`UPDATE public.zerox_reservations SET created_at = now() - interval '16 minutes',
    lease_expires_at = now() - interval '6 minutes' WHERE id = $1`, [longPaid.reservation_id]);
  await rpc(env, 'zerox_release_stale_reservations', {});
  assert.equal((await reserve(longRunner, { p_tier: 'paid', p_cost_microusd: 1000 })).status, 'ok', 'release returns the held credits');
  // The usage: ref namespace belongs to settlements, so a grant can never block one.
  const reservedRef = await reserve(longRunner, { p_tier: 'free' });
  await assert.rejects(rpc(env, 'zerox_credit_grant', { p_user_id: longRunner, p_delta_microusd: 5, p_reason: 'topup',
    p_ref: `usage:${reservedRef.reservation_id}` }), /invalid_credit_ref: the usage: prefix is reserved/);
  await assert.rejects(rpc(env, 'zerox_credit_grant', { p_user_id: longRunner, p_delta_microusd: 5, p_reason: 'topup',
    p_ref: 'USAGE:anything' }), /invalid_credit_ref/);
  assert.equal((await settle(reservedRef.reservation_id)).status, 'settled');
  ok('insufficient_credits, credit holds until settle or release, deduction, clamp at zero with ledger shortfall, refunds, free pool not billed, reserved usage: refs');

  // ---------------------------------------------------------------- refund path
  await clockHeadroom();
  const refundUser = await newUser('free');
  const kept = await reserve(refundUser, { p_model: 'refund/model', p_pool: { rpm: 100 } });
  await settle(kept.reservation_id);
  const failed = await reserve(refundUser, { p_model: 'refund/model', p_tokens: 4000, p_pool: { rpm: 100 } });
  assert.equal((await account(refundUser)).daily_requests, 2);
  assert.equal((await poolRow('refund/model', 'free', 'day')).requests, 2);
  assert.deepEqual(await settle(failed.reservation_id, { p_status: 'refunded', p_prompt_tokens: 0, p_completion_tokens: 0, p_error_code: 'upstream_error' }),
    { status: 'settled', credit_balance_microusd: 0 });
  const refundRow = await account(refundUser);
  assert.equal(refundRow.daily_requests, 1, 'refund returns the request');
  assert.equal(refundRow.daily_tokens_used, 15, 'refund returns the reserved tokens');
  assert.equal(refundRow.total_requests, 1);
  for (const bucket of ['minute', 'day']) {
    const row = await poolRow('refund/model', 'free', bucket);
    assert.equal(row.requests, 1); assert.equal(row.tokens, 15);
  }
  const [refundEvent] = await rpcRows(env, 'zerox_usage_events', { p_user_id: refundUser, p_limit: 1 });
  assert.equal(refundEvent.status, 'refunded'); assert.equal(refundEvent.error_code, 'upstream_error');
  const [refundDaily] = await sql('SELECT * FROM public.zerox_usage_daily WHERE user_id = $1', [refundUser]);
  assert.equal(refundDaily.requests, 1); assert.equal(refundDaily.errors, 1);
  const errored = await reserve(refundUser, { p_model: 'refund/model' });
  await settle(errored.reservation_id, { p_status: 'error', p_prompt_tokens: 50, p_completion_tokens: 0, p_error_code: 'upstream_timeout' });
  assert.equal((await account(refundUser)).daily_requests, 2, 'errors (not refunded) keep the request counted');
  ok('refund path returns request and tokens to user and pool counters, error path keeps the request');

  // ---------------------------------------------------------------- failed_upstream (review P2, integration)
  // An attempt that reached the model (tool_use_failed, timeouts) keeps its request and processed
  // tokens in the shared pool; the user is refunded while refunds are left for the day (a tenth of
  // the plan's daily requests, at least 5), then such attempts count like errors.
  await clockHeadroom(20);
  const drainUser = await newUser('free');
  const drainPool = { rpm: 1000, rpd: 1000, tpm: null, tpd: null };
  const failUpstream = async (overrides = {}) => {
    const reservation = await reserve(drainUser, { p_model: 'drain/model', p_pool: drainPool, p_tokens: 500 });
    assert.equal(reservation.status, 'ok');
    return settle(reservation.reservation_id, { p_status: 'failed_upstream', p_prompt_tokens: 40, p_completion_tokens: 0,
      p_error_code: 'model_error', ...overrides });
  };
  for (let i = 0; i < 10; i++) assert.equal((await failUpstream()).status, 'settled');
  let drained = await account(drainUser);
  assert.deepEqual([drained.daily_requests, drained.daily_tokens_used, drained.upstream_refunds, drained.total_requests], [0, 0, 10, 0],
    'within the allowance (10 on Free) the user is refunded in full');
  for (const bucket of ['minute', 'day']) {
    const row = await poolRow('drain/model', 'free', bucket);
    assert.deepEqual([row.requests, row.tokens], [10, 400], `the ${bucket} pool keeps every request and its prompt tokens`);
  }
  const refundedEvents = await rpcRows(env, 'zerox_usage_events', { p_user_id: drainUser, p_limit: 20 });
  assert.ok(refundedEvents.every(event => event.status === 'refunded' && event.prompt_tokens === 0 && event.error_code === 'model_error'));
  await sql("UPDATE public.zerox_reservations SET created_at = now() - interval '2 minutes' WHERE user_id = $1", [drainUser]); // rpm 10
  await failUpstream();
  drained = await account(drainUser);
  assert.deepEqual([drained.daily_requests, drained.daily_tokens_used, drained.upstream_refunds], [1, 40, 10],
    'past the allowance the attempt counts like an error');
  const [counted] = await rpcRows(env, 'zerox_usage_events', { p_user_id: drainUser, p_limit: 1 });
  assert.deepEqual([counted.status, counted.prompt_tokens], ['error', 40]);
  assert.equal((await poolRow('drain/model', 'free', 'day')).requests, 11);
  const [drainDaily] = await sql('SELECT * FROM public.zerox_usage_daily WHERE user_id = $1', [drainUser]);
  assert.deepEqual([drainDaily.requests, drainDaily.errors, drainDaily.prompt_tokens], [1, 11, 40]);
  // A plain refund still returns the pool's request (the upstream did not count it).
  const rejected = await reserve(drainUser, { p_model: 'drain/model', p_pool: drainPool, p_tokens: 500 });
  await settle(rejected.reservation_id, { p_status: 'refunded', p_prompt_tokens: 0, p_completion_tokens: 0, p_error_code: 'upstream_error' });
  assert.equal((await poolRow('drain/model', 'free', 'day')).requests, 11);
  // The allowance is per UTC day and per plan (Pro: 200).
  await sql('UPDATE public.zerox_accounts SET upstream_refund_day = $2::date WHERE clerk_id = $1', [drainUser, utcDay(-1)]);
  await failUpstream();
  assert.deepEqual([(await account(drainUser)).upstream_refunds, (await account(drainUser)).daily_requests], [1, 1], 'a new day starts a new allowance');
  // A reservation from the previous UTC day settled after midnight is not counted against (and
  // never resets) the current day's allowance.
  const lateAttempt = await reserve(drainUser, { p_model: 'drain/model', p_pool: drainPool, p_tokens: 500 });
  await sql('UPDATE public.zerox_reservations SET usage_day = $2::date WHERE id = $1', [lateAttempt.reservation_id, utcDay(-1)]);
  await settle(lateAttempt.reservation_id, { p_status: 'failed_upstream', p_prompt_tokens: 40, p_completion_tokens: 0 });
  const [afterLate] = await sql('SELECT upstream_refunds, upstream_refund_day = $2::date AS today FROM public.zerox_accounts WHERE clerk_id = $1',
    [drainUser, todayUtc]);
  assert.deepEqual(afterLate, { upstream_refunds: 1, today: true }, 'a late settle from the previous day keeps the refund count of the current day');
  const proDrain = await newUser('pro');
  await sql('UPDATE public.zerox_accounts SET upstream_refunds = 199, upstream_refund_day = $2::date WHERE clerk_id = $1', [proDrain, todayUtc]);
  const proAttempt = await reserve(proDrain, { p_model: 'drain/pro', p_tokens: 500 });
  await settle(proAttempt.reservation_id, { p_status: 'failed_upstream', p_prompt_tokens: 40, p_completion_tokens: 0 });
  assert.deepEqual([(await account(proDrain)).daily_requests, (await account(proDrain)).upstream_refunds], [0, 200]);
  // Paid pools: a refunded failed_upstream attempt bills nothing; past the allowance it is billed.
  const paidDrain = await newUser('pro', { credits: 100000 });
  await sql('UPDATE public.zerox_accounts SET upstream_refunds = 200, upstream_refund_day = $2::date WHERE clerk_id = $1', [paidDrain, todayUtc]);
  const paidAttempt = await reserve(paidDrain, { p_model: 'drain/paid', p_tier: 'paid', p_cost_microusd: 500, p_tokens: 500 });
  assert.deepEqual(await settle(paidAttempt.reservation_id, { p_status: 'failed_upstream', p_prompt_tokens: 40, p_completion_tokens: 0, p_cost_microusd: 30 }),
    { status: 'settled', credit_balance_microusd: 99970 });
  await assert.rejects(settle(paidAttempt.reservation_id, { p_status: 'partial' }), /invalid_settlement/);
  ok('failed_upstream keeps the pool share, refunds the user within a daily allowance (a tenth of daily requests, min 5), then counts');

  // ---------------------------------------------------------------- shared pool budgets
  await clockHeadroom();
  const poolUsers = [await newUser('max'), await newUser('max'), await newUser('max', { credits: 1000000 })];
  const rpmPool = { rpm: 2, rpd: null, tpm: null, tpd: null };
  assert.equal((await reserve(poolUsers[0], { p_model: 'pool/rpm', p_pool: rpmPool })).status, 'ok');
  assert.equal((await reserve(poolUsers[1], { p_model: 'pool/rpm', p_pool: rpmPool })).status, 'ok');
  const beforeDenied = (await account(poolUsers[2])).daily_requests;
  const rpmExhausted = await reserve(poolUsers[2], { p_model: 'pool/rpm', p_pool: rpmPool });
  assert.equal(rpmExhausted.status, 'pool_exhausted', 'pool rpm is shared by all users');
  assert.ok(rpmExhausted.retry_after_seconds >= 1 && rpmExhausted.retry_after_seconds <= 60);
  assert.equal(rpmExhausted.reservation_id, null);
  assert.equal((await reserve(poolUsers[2], { p_model: 'pool/rpm', p_tier: 'paid', p_cost_microusd: 10, p_pool: rpmPool })).status,
    'ok', 'each tier of a model has its own pool');
  const tpmPool = { tpm: 1000 };
  assert.equal((await reserve(poolUsers[0], { p_model: 'pool/tpm', p_tokens: 600, p_pool: tpmPool })).status, 'ok');
  assert.equal((await reserve(poolUsers[1], { p_model: 'pool/tpm', p_tokens: 600, p_pool: tpmPool })).status, 'pool_exhausted');
  assert.equal((await reserve(poolUsers[1], { p_model: 'pool/tpm', p_tokens: 400, p_pool: tpmPool })).status, 'ok');
  const rpdPool = { rpd: 1 };
  assert.equal((await reserve(poolUsers[0], { p_model: 'pool/rpd', p_pool: rpdPool })).status, 'ok');
  const rpdExhausted = await reserve(poolUsers[1], { p_model: 'pool/rpd', p_pool: rpdPool });
  assert.equal(rpdExhausted.status, 'pool_exhausted');
  const toMidnight = Math.ceil((Date.parse(nextResets) - Date.now()) / 1000);
  assert.ok(Math.abs(rpdExhausted.retry_after_seconds - toMidnight) <= 5, 'daily pool budgets retry at UTC midnight');
  const tpdExhausted = await reserve(poolUsers[2], { p_model: 'pool/tpd', p_tokens: 5001, p_pool: { tpd: 5000 } });
  assert.equal(tpdExhausted.status, 'pool_exhausted');
  assert.ok(Math.abs(tpdExhausted.retry_after_seconds - toMidnight) <= 5);
  assert.equal((await account(poolUsers[2])).daily_requests, beforeDenied + 1, 'denied reservations do not count against the user');
  assert.equal((await reserve(poolUsers[2], { p_model: 'pool/unlimited', p_pool: {} })).status, 'ok', 'empty budget is unlimited');
  assert.equal((await reserve(poolUsers[2], { p_model: 'pool/unlimited', p_pool: { rpm: null, tpd: null } })).status, 'ok');
  assert.equal((await poolRow('pool/unlimited', 'free', 'day')).requests, 2, 'counters are kept even without limits');
  ok('pool_exhausted for rpm/tpm/rpd/tpd shared across users, retry hints, per-tier pools, unlimited budgets');

  // ---------------------------------------------------------------- Groq free pool: turns per minute
  // E2E finding (2026-10-21): a Groq reservation held the prompt plus max_tokens fitted to the
  // 8K TPM budget, i.e. the whole minute for every user, so a 3-turn tool task on gpt-oss-120b got
  // 503 capacity_exhausted from its second turn. Through the chat handler and the real RPCs: each
  // turn holds its prompt plus a bounded output allowance and settles to the real usage.
  await clockHeadroom(20);
  {
    resetPoolBudgets();
    // An unused minute for the model: the RPC section above reserved on it and the admin overview
    // section below counts that, so its counters are set aside and put back afterwards.
    await db.exec(`CREATE TEMP TABLE groq_pool_saved AS SELECT * FROM public.zerox_pool_usage
      WHERE model = 'groq/openai/gpt-oss-120b' AND tier = 'free';
      DELETE FROM public.zerox_pool_usage WHERE model = 'groq/openai/gpt-oss-120b' AND tier = 'free';`);
    const groqUser = await newUser('max');
    const chatEnv = { ...env, GROQ_API_KEY: 'groq-free-test-key' };
    const session = { account_backed: true, user_id: groqUser, plan: 'max' };
    const tracker = new ProviderHealthTracker();
    const app = new Hono();
    app.post('/v1/chat/completions', createChatHandler({
      validateSession: async c => (c.req.header('Authorization') === 'Bearer ses_groq' ? { token: 'ses_groq', session } : null),
      setSession: async () => {}, getSession: async () => null, planLimits: async () => ({}),
      router: new RoutingEngine(tracker), healthTracker: tracker,
    }));
    const realFetch = globalThis.fetch;
    const upstreamMax = [];
    globalThis.fetch = async (input, options = {}) => {
      if (!String(input).startsWith('https://api.groq.com/')) return realFetch(input, options);
      const body = JSON.parse(options.body);
      upstreamMax.push(body.max_completion_tokens ?? body.max_tokens);
      return Response.json({ id: 'up', object: 'chat.completion', choices: [{ index: 0,
        message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500 } });
    };
    const turn = [{ role: 'system', content: 'You are Neuron. '.repeat(300) }, { role: 'user', content: 'Read a.js and b.js.' }];
    const prompt = estimatePromptTokens(turn);
    const warnings = [];
    const warn = console.warn;
    console.warn = (...args) => warnings.push(args);
    const statuses = [];
    let refused = null;
    try {
      for (let index = 0; index < 5; index++) {
        const response = await app.request('http://127.0.0.1/v1/chat/completions', { method: 'POST',
          headers: { Authorization: 'Bearer ses_groq', 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'groq/openai/gpt-oss-120b', messages: turn, max_tokens: 8192 }) }, chatEnv);
        statuses.push(response.status);
        if (response.status !== 200) refused = (await response.json()).error;
      }
    } finally {
      globalThis.fetch = realFetch;
      console.warn = warn;
    }
    assert.ok(prompt > 1000 && prompt < 2400, `a Neuron-sized prompt (${prompt} tokens)`);
    assert.deepEqual(upstreamMax, Array(4).fill(8000 - prompt), 'the upstream max_tokens still fits the 8K minute');
    assert.deepEqual(statuses, [200, 200, 200, 200, 503], 'four turns fit in one minute; the fifth exceeds 8K TPM');
    const reserved = await sql('SELECT reserved_tokens FROM public.zerox_reservations WHERE user_id = $1', [groqUser]);
    assert.deepEqual(reserved.map(row => Number(row.reserved_tokens)), Array(4).fill(prompt + RESERVED_OUTPUT_TOKENS),
      `each turn holds its prompt plus ${RESERVED_OUTPUT_TOKENS} output tokens, not the whole 8,000-token minute it held before`);
    const minute = await poolRow('groq/openai/gpt-oss-120b', 'free', 'minute');
    assert.deepEqual([Number(minute.requests), Number(minute.tokens)], [4, 6000], 'settled to the real usage (4 x 1,500)');
    assert.equal(refused.code, 'capacity_exhausted');
    assert.ok(refused.retry_after_seconds >= 1 && refused.retry_after_seconds <= 60);
    const logged = warnings.filter(([message]) => message === 'Neuron pool budget exhausted');
    assert.equal(logged.length, 1);
    assert.deepEqual({ ...logged[0][1], request_id: undefined }, { pool: 'groq:openai/gpt-oss-120b:free',
      model: 'groq/openai/gpt-oss-120b', budget: 'rpm|tpm', retry_after_seconds: refused.retry_after_seconds, request_id: undefined });
    assert.ok(!JSON.stringify(warnings).includes('groq-free-test-key'), 'no key in the logs');
    // /v1/models shows the spent budget until the next minute.
    const listed = await v1ModelsPayload({ env: chatEnv, req: { raw: new Request('http://127.0.0.1/v1/models') } }, session);
    const groqModel = listed.data.find(model => model.id === 'groq/openai/gpt-oss-120b');
    assert.equal(groqModel.status, 'busy');
    assert.ok(Math.abs(Date.parse(groqModel.available_again_at) - (Date.now() + refused.retry_after_seconds * 1000)) < 2000);
    resetPoolBudgets();
    await db.exec(`DELETE FROM public.zerox_pool_usage WHERE model = 'groq/openai/gpt-oss-120b' AND tier = 'free';
      INSERT INTO public.zerox_pool_usage SELECT * FROM groq_pool_saved; DROP TABLE groq_pool_saved;`);
  }
  ok('Groq free pool: four Neuron-sized turns in one minute (prompt + 1,024 held, settled to usage); the fifth is refused, logged with its pool and budget, and shown busy');

  // ---------------------------------------------------------------- concurrency leases through the chat handler
  // E2E finding (2026-10-27): when Cloudflare killed an isolate mid-stream (exceededCpu, 1102),
  // nothing settled its reservation (no cancel(), no onFinish, waitUntil died with it) and the slot
  // stayed taken for 10 minutes. The CLI's immediate retry was killed too, so one kill pair filled
  // both Free slots, and every refusal said "retry in 5 s". A slot is now a 90 s lease that the
  // handler renews while the attempt runs.
  await clockHeadroom(20);
  {
    resetPoolBudgets();
    // Each part runs on an unused minute of the Groq free pool (8K TPM); the counters are put back afterwards.
    await db.exec(`CREATE TEMP TABLE lease_pool_saved AS SELECT * FROM public.zerox_pool_usage
      WHERE model = 'groq/openai/gpt-oss-120b' AND tier = 'free';`);
    const freshPool = () => db.exec("DELETE FROM public.zerox_pool_usage WHERE model = 'groq/openai/gpt-oss-120b' AND tier = 'free'");
    const encoder = new TextEncoder();
    const sse = value => encoder.encode(`data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`);
    const delta = (content, finish = null) => ({ id: 'up', object: 'chat.completion.chunk', created: 1, model: 'openai/gpt-oss-120b',
      choices: [{ index: 0, delta: content ? { role: 'assistant', content } : {}, finish_reason: finish }] });
    const completeUpstream = controller => {
      controller.enqueue(sse(delta(null, 'stop')));
      controller.enqueue(sse('[DONE]'));
      controller.close();
    };
    // 'hang': the generation is still running (its controller is kept); 'complete': a whole
    // answer; 'no-done': the upstream ends without finish_reason or [DONE].
    let upstreamMode = 'hang';
    const upstreams = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, options = {}) => {
      if (!String(input).startsWith('https://api.groq.com/')) return realFetch(input, options);
      const mode = upstreamMode;
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(sse(delta('partial')));
        if (mode === 'complete') completeUpstream(controller);
        else if (mode === 'no-done') controller.close();
        else upstreams.push(controller);
      } }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    // Counts zerox_renew_reservation calls (the PGlite driver runs every RPC in a transaction).
    const realTransaction = db.transaction;
    let renewals = 0;
    db.transaction = callback => realTransaction.call(db, tx => {
      const query = tx.query.bind(tx);
      tx.query = (text, ...rest) => {
        if (String(text).includes('zerox_renew_reservation')) renewals++;
        return query(text, ...rest);
      };
      return callback(tx);
    });
    const leaseChat = (userId, extra = {}) => {
      const session = { account_backed: true, user_id: userId, plan: 'free' };
      const tracker = new ProviderHealthTracker();
      const app = new Hono();
      app.post('/v1/chat/completions', createChatHandler({
        validateSession: async () => ({ token: 'ses_lease', session }),
        setSession: async () => {}, getSession: async () => null, planLimits: async () => ({}),
        router: new RoutingEngine(tracker), healthTracker: tracker,
      }));
      const leaseEnv = { ...env, GROQ_API_KEY: 'groq-free-test-key', UPSTREAM_IDLE_TIMEOUT_MS: '600000', ...extra };
      return () => app.request('http://127.0.0.1/v1/chat/completions', { method: 'POST',
        headers: { Authorization: 'Bearer ses_lease', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'groq/openai/gpt-oss-120b', stream: true, messages: [{ role: 'user', content: 'hi' }] }) }, leaseEnv);
    };
    // Starts a stream and reads its first chunk.
    const open = async chat => {
      const response = await chat();
      assert.equal(response.status, 200);
      const reader = response.body.getReader();
      assert.equal((await reader.read()).done, false, 'the first chunk reached the client');
      return reader;
    };
    const drain = async reader => {
      let text = '';
      for (let read = await reader.read(); !read.done; read = await reader.read()) text += new TextDecoder().decode(read.value);
      return text;
    };
    const reservationsOf = async userId => (await sql(`SELECT status, outcome FROM public.zerox_reservations
      WHERE user_id = $1 ORDER BY created_at, id`, [userId])).map(row => `${row.status}/${row.outcome}`);
    const abandoned = [];
    try {
      // (a) The isolate dies mid-stream: the client got one chunk, then nothing of the request
      // runs again (no cancel(), no onFinish, no renewal). The refusal reports the real wait, and
      // once the leases lapse the user's next request releases them, without the cron.
      await freshPool();
      const killedUser = await newUser('free');
      const killedChat = leaseChat(killedUser, { RESERVATION_RENEW_MS: '600000' });
      upstreamMode = 'hang';
      abandoned.push(await open(killedChat), await open(killedChat));
      const killedUpstreams = upstreams.splice(0);
      const locked = await killedChat();
      assert.equal(locked.status, 429);
      const lockError = (await locked.json()).error;
      assert.equal(lockError.code, 'rate_limited');
      assert.ok(lockError.retry_after_seconds > 0 && lockError.retry_after_seconds <= 90 && lockError.retry_after_seconds >= 85,
        `Retry-After is the wait until the first lease lapses (${lockError.retry_after_seconds} s), not 5 s`);
      assert.equal(locked.headers.get('retry-after'), String(lockError.retry_after_seconds));
      assert.deepEqual(await reservationsOf(killedUser), ['active/null', 'active/null']);
      await sql("UPDATE public.zerox_reservations SET lease_expires_at = now() - interval '1 second' WHERE user_id = $1 AND status = 'active'",
        [killedUser]);
      upstreamMode = 'complete';
      const recovered = await killedChat();
      assert.equal(recovered.status, 200, 'lapsed leases free their slots without the cron');
      assert.match(await recovered.text(), /\[DONE\]/);
      assert.deepEqual(await reservationsOf(killedUser), ['released/null', 'released/null', 'settled/ok']);
      upstreams.push(...killedUpstreams);

      // (b) A generation that runs past its lease keeps its slot: the handler renews the lease every
      // RESERVATION_RENEW_MS while the attempt runs, and stops once the attempt is settled.
      await freshPool();
      const longUser = await newUser('free');
      const longChat = leaseChat(longUser, { RESERVATION_RENEW_MS: '50', RESERVATION_LEASE_SECONDS: '1' });
      upstreamMode = 'hang';
      const running = [await open(longChat), await open(longChat)];
      const runningUpstreams = upstreams.splice(-2);
      // From here only the renewals keep these leases.
      await sql("UPDATE public.zerox_reservations SET lease_expires_at = now() + interval '1 second' WHERE user_id = $1", [longUser]);
      renewals = 0;
      await sleep(1500);
      assert.ok(renewals >= 10, `the leases were renewed while the generations ran (${renewals} renewals)`);
      const stillBusy = await longChat();
      assert.equal(stillBusy.status, 429, 'running generations keep their slots past the 1 s lease');
      assert.equal((await stillBusy.json()).error.retry_after_seconds, 1);
      assert.deepEqual(await reservationsOf(longUser), ['active/null', 'active/null']);
      for (const controller of runningUpstreams) completeUpstream(controller);
      for (const reader of running) assert.match(await drain(reader), /\[DONE\]/);
      assert.deepEqual(await reservationsOf(longUser), ['settled/ok', 'settled/ok']);
      const afterSettle = renewals;
      await sleep(300);
      assert.equal(renewals, afterSettle, 'renewals stop once the attempts are settled');
      upstreamMode = 'complete';
      const freed = await longChat();
      assert.equal(freed.status, 200, 'finished generations free their slots');
      await freed.text();

      // (c) Regressions: a client cancel and an upstream that ends without [DONE] settle at once
      // and stop renewing.
      await freshPool();
      const endedUser = await newUser('free');
      const endedChat = leaseChat(endedUser, { RESERVATION_RENEW_MS: '50' });
      upstreamMode = 'hang';
      const cancelled = await open(endedChat);
      await cancelled.cancel();
      upstreamMode = 'no-done';
      const cut = await endedChat();
      assert.equal(cut.status, 200);
      assert.match(await cut.text(), /upstream_error/);
      await sleep(50);
      assert.deepEqual(await reservationsOf(endedUser), ['settled/error', 'settled/error']);
      const afterEnded = renewals;
      await sleep(200);
      assert.equal(renewals, afterEnded, 'no renewals after a cancel or an interrupted stream');

      // (d) A renew interval as long as the lease or longer (RESERVATION_RENEW_MS=90000 with the
      // default 90 s lease, scaled down here) is clamped to a third of the lease, so running
      // generations renew before their leases lapse and are never released under them.
      await freshPool();
      const clampedUser = await newUser('free');
      const clampedChat = leaseChat(clampedUser, { RESERVATION_RENEW_MS: '600000', RESERVATION_LEASE_SECONDS: '1' });
      upstreamMode = 'hang';
      const clamped = [await open(clampedChat), await open(clampedChat)];
      const clampedUpstreams = upstreams.splice(-2);
      await sql("UPDATE public.zerox_reservations SET lease_expires_at = now() + interval '1 second' WHERE user_id = $1", [clampedUser]);
      renewals = 0;
      await sleep(1500);
      assert.ok(renewals >= 4, `renewals at most a third of the lease apart (${renewals} renewals)`);
      const clampedBusy = await clampedChat();
      assert.equal(clampedBusy.status, 429, 'a renew interval longer than the lease does not cost running generations their slots');
      await clampedBusy.json();
      for (const controller of clampedUpstreams) completeUpstream(controller);
      for (const reader of clamped) assert.match(await drain(reader), /\[DONE\]/);
      assert.deepEqual(await reservationsOf(clampedUser), ['settled/ok', 'settled/ok']);
    } finally {
      for (const reader of abandoned) await reader.cancel().catch(() => {});
      for (const controller of upstreams) try { controller.close(); } catch { /* already cancelled */ }
      db.transaction = realTransaction;
      globalThis.fetch = realFetch;
      resetPoolBudgets();
      await db.exec(`DELETE FROM public.zerox_pool_usage WHERE model = 'groq/openai/gpt-oss-120b' AND tier = 'free';
        INSERT INTO public.zerox_pool_usage SELECT * FROM lease_pool_saved; DROP TABLE lease_pool_saved;`);
    }
  }
  ok('concurrency leases: a killed stream frees its slot once its lease lapses, without the cron (Retry-After is the real wait); running streams renew their leases (at least three times per lease) and stop once settled; cancel and cut streams settle at once');

  // ---------------------------------------------------------------- stale release and housekeeping
  const staleUser = await newUser('free');
  const abandoned = await reserve(staleUser);
  const fresh = await reserve(staleUser);
  // The cron releases what the user's own next reservation did not: leases that lapsed more than
  // 5 minutes ago, and rows without a lease 10 minutes after they were created.
  await sql(`UPDATE public.zerox_reservations SET created_at = now() - interval '8 minutes',
    lease_expires_at = now() - interval '6 minutes' WHERE id = $1`, [abandoned.reservation_id]);
  const [unleased, recentlyLapsed] = await sql(`INSERT INTO public.zerox_reservations (user_id, request_id, model, tier, plan,
      reserved_tokens, usage_day, pool_minute, pool_day, created_at, lease_expires_at)
    VALUES ($1, 'stale_unleased', 'test/model', 'free', 'free', 10, current_date, now(), now(), now() - interval '16 minutes', NULL),
      ($1, 'stale_recent', 'test/model', 'free', 'free', 10, current_date, now(), now(), now() - interval '3 minutes', now() - interval '1 minute')
    RETURNING id`, [staleUser]);
  await sql(`INSERT INTO public.zerox_pool_usage (model, tier, bucket, bucket_start, requests, tokens)
    VALUES ('old/model', 'free', 'minute', now() - interval '2 days', 1, 1), ('old/model', 'free', 'day', now() - interval '120 days', 1, 1)`);
  const sessionOwner = await newUser('free');
  await sql("INSERT INTO public.zerox_session_index (token_hash, user_id, expires_at) VALUES ($1, $2, now() - interval '1 hour')", [sha('expired-session'), sessionOwner]);
  const { released } = await rpc(env, 'zerox_release_stale_reservations', {});
  assert.ok(released >= 2);
  const statuses = Object.fromEntries((await sql('SELECT id, status FROM public.zerox_reservations WHERE user_id = $1', [staleUser])).map(row => [row.id, row.status]));
  assert.equal(statuses[abandoned.reservation_id], 'released', 'lease lapsed 6 minutes ago');
  assert.equal(statuses[unleased.id], 'released', 'no lease, created 16 minutes ago');
  assert.equal(statuses[recentlyLapsed.id], 'active', 'lease lapsed only a minute ago');
  assert.equal(statuses[fresh.reservation_id], 'active');
  assert.equal((await sql("SELECT count(*)::int AS n FROM public.zerox_pool_usage WHERE model = 'old/model'"))[0].n, 0);
  assert.equal((await sql('SELECT count(*)::int AS n FROM public.zerox_session_index WHERE user_id = $1', [sessionOwner]))[0].n, 0);
  assert.equal((await rpc(env, 'zerox_release_stale_reservations', {})).released, 0, 'release is idempotent');
  assert.equal((await reserve(staleUser)).status, 'ok', 'released reservation frees its concurrency slot');
  assert.equal((await sql('SELECT status FROM public.zerox_reservations WHERE id = $1', [recentlyLapsed.id]))[0].status, 'released',
    'the next reservation of the user released the lapsed lease the cron left');
  assert.equal((await settle(abandoned.reservation_id)).status, 'settled', 'a late settle still reconciles a released reservation');
  assert.equal((await settle(abandoned.reservation_id)).status, 'already_settled');
  // Every reservation query of the quota path and the housekeeping job has a supporting index,
  // also for a heavy user with weeks of finished reservations.
  const historyUser = await newUser('max');
  await sql(`INSERT INTO public.zerox_reservations (user_id, request_id, model, tier, plan, reserved_tokens, usage_day,
      pool_minute, pool_day, status, created_at)
    SELECT $1, 'hist_' || n, 'hist/model', 'free', 'max', 10, current_date, now(), now(),
      CASE WHEN n <= 2 THEN 'active' ELSE 'settled' END, now() - (n || ' minutes')::interval * CASE WHEN n <= 2 THEN 0 ELSE 5 END
    FROM generate_series(1, 6000) AS n`, [historyUser]);
  await db.exec('ANALYZE public.zerox_reservations');
  const planFor = async query => {
    await db.exec('SET enable_seqscan = off');
    try { return (await sql(`EXPLAIN ${query}`)).map(row => row['QUERY PLAN']).join('\n'); }
    finally { await db.exec('RESET enable_seqscan'); }
  };
  assert.match(await planFor(`DELETE FROM public.zerox_reservations AS r WHERE r.id IN (SELECT old.id FROM public.zerox_reservations AS old
    WHERE old.status <> 'active' AND old.created_at < now() - interval '30 days' LIMIT 10000)`), /zerox_reservations_finished_idx/);
  assert.match(await planFor(`SELECT r.id FROM public.zerox_reservations AS r WHERE r.status = 'active'
    AND coalesce(r.lease_expires_at, r.created_at + interval '10 minutes') < now() - interval '5 minutes'
    ORDER BY r.created_at LIMIT 10000`), /zerox_reservations_active_idx/);
  assert.match(await planFor(`SELECT count(*) FILTER (WHERE r.lease_expires_at > now()),
      min(r.lease_expires_at) FILTER (WHERE r.lease_expires_at > now()), sum(r.reserved_cost_microusd)
    FROM public.zerox_reservations AS r WHERE r.user_id = '${historyUser}' AND r.status = 'active'`),
  /zerox_reservations_(?:user_)?active_idx/, 'concurrency leases are read from in-flight rows only');
  assert.match(await planFor(`UPDATE public.zerox_reservations AS r SET status = 'released' WHERE r.id IN (
      SELECT l.id FROM public.zerox_reservations AS l WHERE l.user_id = '${historyUser}' AND l.status = 'active'
        AND l.lease_expires_at <= now() FOR UPDATE SKIP LOCKED)`), /zerox_reservations_(?:user_)?active_idx/,
  'releasing lapsed leases reads in-flight rows only');
  assert.match(await planFor(`SELECT count(*), sum(r.reserved_cost_microusd) FROM public.zerox_reservations AS r
    WHERE r.user_id = '${historyUser}' AND r.status = 'active'`), /zerox_reservations_(?:user_)?active_idx/,
  'credit holds and concurrency read only in-flight rows (partial indexes), never the finished history');
  assert.equal((await reserve(historyUser)).status, 'ok', 'finished history does not hold concurrency slots');
  await sql("DELETE FROM public.zerox_reservations WHERE user_id = $1 AND request_id LIKE 'hist_%'", [historyUser]);
  ok('stale reservations released 5 minutes after their lease lapsed (10 minutes after creation without one), late settle, bounded and indexed housekeeping');

  // ---------------------------------------------------------------- API keys
  const keyUser = await newUser('pro');
  const otherKeyUser = await newUser('free');
  const secrets = Array.from({ length: 11 }, (_, index) => `nzx_${randomUUID().replaceAll('-', '')}${index}`);
  const created = [];
  for (const [index, secret] of secrets.slice(0, 10).entries()) {
    const key = await rpc(env, 'zerox_api_key_create', { p_user_id: keyUser, p_name: ` CI key ${index} `, p_prefix: secret.slice(0, 12), p_hash: sha(secret) });
    assert.deepEqual(Object.keys(key).sort(), ['created_at', 'id', 'name', 'prefix']);
    assert.equal(key.name, `CI key ${index}`);
    created.push(key);
  }
  await assert.rejects(rpc(env, 'zerox_api_key_create', { p_user_id: keyUser, p_name: 'eleventh', p_prefix: 'nzx_eleventh', p_hash: sha(secrets[10]) }),
    error => error instanceof AccountDatabaseError && /too_many_keys/.test(error.message));
  await assert.rejects(rpc(env, 'zerox_api_key_create', { p_user_id: otherKeyUser, p_name: '  ', p_prefix: 'nzx_x', p_hash: sha('x') }), /invalid_key_name/);
  await assert.rejects(rpc(env, 'zerox_api_key_create', { p_user_id: otherKeyUser, p_name: 'k', p_prefix: 'sk_live', p_hash: sha('x') }), /invalid_key_prefix/);
  await assert.rejects(rpc(env, 'zerox_api_key_create', { p_user_id: otherKeyUser, p_name: 'k', p_prefix: 'nzx_x', p_hash: 'not-a-hash' }), /invalid_key_hash/);
  await assert.rejects(rpc(env, 'zerox_api_key_create', { p_user_id: randomUUID(), p_name: 'k', p_prefix: 'nzx_x', p_hash: sha('y') }), /account_not_found/);
  const listed = await rpcRows(env, 'zerox_api_key_list', { p_user_id: keyUser });
  assert.equal(listed.length, 10);
  assert.deepEqual(Object.keys(listed[0]).sort(), ['created_at', 'id', 'last_used_at', 'name', 'prefix', 'revoked_at']);
  assert.ok(!JSON.stringify(listed).includes(sha(secrets[0])), 'hashes never leave the database through list');
  assert.deepEqual(await rpcRows(env, 'zerox_api_key_list', { p_user_id: otherKeyUser }), []);
  assert.deepEqual(await rpc(env, 'zerox_api_key_revoke', { p_user_id: otherKeyUser, p_key_id: created[0].id }), { revoked: false }, 'cannot revoke another user key');
  assert.deepEqual(await rpc(env, 'zerox_api_key_revoke', { p_user_id: keyUser, p_key_id: created[0].id }), { revoked: true });
  assert.deepEqual(await rpc(env, 'zerox_api_key_revoke', { p_user_id: keyUser, p_key_id: created[0].id }), { revoked: false });
  assert.ok((await rpcRows(env, 'zerox_api_key_list', { p_user_id: keyUser })).find(key => key.id === created[0].id).revoked_at);
  assert.equal(await rpc(env, 'zerox_api_key_verify', { p_hash: sha(secrets[0]) }), null, 'revoked keys do not verify');
  const replacement = await rpc(env, 'zerox_api_key_create', { p_user_id: keyUser, p_name: 'replacement', p_prefix: 'nzx_repl', p_hash: sha(secrets[10]) });
  assert.equal(replacement.name, 'replacement', 'revoking frees a slot');
  assert.deepEqual(await rpc(env, 'zerox_api_key_verify', { p_hash: sha(secrets[1]) }), { key_id: created[1].id, user_id: keyUser });
  const lastUsed = async id => (await sql('SELECT last_used_at FROM public.zerox_api_keys WHERE id = $1', [id]))[0].last_used_at;
  assert.ok(await lastUsed(created[1].id));
  await sql("UPDATE public.zerox_api_keys SET last_used_at = '2026-01-01T00:00:00Z' WHERE id = $1", [created[1].id]);
  await rpc(env, 'zerox_api_key_verify', { p_hash: sha(secrets[1]) });
  assert.ok((await lastUsed(created[1].id)).getTime() > Date.now() - 60000, 'stale last_used_at is refreshed');
  await sql("UPDATE public.zerox_api_keys SET last_used_at = now() - interval '30 seconds' WHERE id = $1", [created[1].id]);
  const recent = (await lastUsed(created[1].id)).getTime();
  assert.deepEqual(await rpc(env, 'zerox_api_key_verify', { p_hash: sha(secrets[1]) }), { key_id: created[1].id, user_id: keyUser });
  assert.equal((await lastUsed(created[1].id)).getTime(), recent, 'last_used_at written at most once per minute');
  assert.equal(await rpc(env, 'zerox_api_key_verify', { p_hash: sha('unknown') }), null);
  assert.equal(await rpc(env, 'zerox_api_key_verify', { p_hash: 'NOT HEX' }), null);
  ok('API keys: create/list/revoke/verify, 10 active key limit (too_many_keys), ownership, last_used_at throttle');

  // ---------------------------------------------------------------- subscriptions
  const subscriber = await newUser('free');
  const upsert = (overrides = {}) => rpc(env, 'zerox_billing_upsert_subscription', {
    p_user_id: subscriber, p_provider: 'razorpay', p_provider_subscription_id: 'sub_TEST1', p_plan: 'pro',
    p_status: 'created', p_current_period_start: null, p_current_period_end: null, p_cancel_at_period_end: false,
    p_raw: { entity: 'subscription', notes: { user: 'x' }, items: [1, 2] }, ...overrides,
  });
  const createdSub = await upsert();
  assert.equal(createdSub.status, 'created');
  assert.equal(createdSub.user_id, subscriber);
  assert.deepEqual(createdSub.raw, { entity: 'subscription', notes: { user: 'x' }, items: [1, 2] }, 'jsonb arguments round-trip');
  assert.equal((await account(subscriber)).plan, 'free', 'created subscriptions grant nothing');
  const periodStart = new Date(Date.now() - 86400000).toISOString();
  const periodEnd = new Date(Date.now() + 29 * 86400000).toISOString();
  const authenticated = await upsert({ p_status: 'authenticated', p_current_period_start: periodStart, p_current_period_end: periodEnd });
  assert.equal(authenticated.id, createdSub.id, 'upsert keeps one row per provider subscription');
  let subAccount = await account(subscriber);
  assert.equal(subAccount.plan, 'pro'); assert.equal(subAccount.plan_source, 'subscription');
  const activeSub = await upsert({ p_status: 'active', p_current_period_start: null, p_current_period_end: null, p_raw: null });
  assert.equal(activeSub.current_period_end, authenticated.current_period_end, 'missing period fields keep stored values');
  assert.deepEqual(activeSub.raw, createdSub.raw);
  const byProvider = await rpc(env, 'zerox_subscription_by_provider_id', { p_provider: 'razorpay', p_provider_subscription_id: 'sub_TEST1' });
  assert.equal(byProvider.user_id, subscriber); assert.equal(byProvider.status, 'active');
  assert.equal(await rpc(env, 'zerox_subscription_by_provider_id', { p_provider: 'razorpay', p_provider_subscription_id: 'sub_missing' }), null);
  const billing = await rpc(env, 'zerox_billing_get', { p_user_id: subscriber });
  assert.equal(billing.subscription.id, createdSub.id);
  assert.equal(billing.subscription.plan, 'pro'); assert.equal(billing.subscription.status, 'active');
  assert.equal(billing.subscription.provider, 'razorpay');
  assert.equal(billing.subscription.cancel_at_period_end, false);
  assert.equal(billing.subscription.raw, undefined, 'raw provider payloads are not exposed');
  assert.deepEqual(billing.payments, []);
  const overview = await rpc(env, 'zerox_account_overview', { p_user_id: subscriber });
  assert.equal(overview.account.plan, 'pro');
  assert.equal(overview.policy.plan, 'pro');
  assert.equal(overview.credits.monthly_grant_microusd, 8000000);
  assert.equal(overview.subscription.status, 'active');
  await assert.rejects(upsert({ p_user_id: freeUser, p_status: 'active' }), /subscription_owner_mismatch/);
  await assert.rejects(upsert({ p_plan: 'free' }), /invalid_plan/);
  await assert.rejects(upsert({ p_status: 'mystery' }), /invalid_subscription_status/);
  await assert.rejects(upsert({ p_user_id: randomUUID() }), /account_not_found/);
  // Review P2 (integration): a second subscription that becomes live while another one is live
  // (two checkouts paid in parallel) is a duplicate. It is revoked and never entitles. This used to
  // be modelled as an upgrade path; the gateway never creates one (checkout answers 409).
  const duplicateSub = await upsert({ p_provider_subscription_id: 'sub_DUP1', p_plan: 'max', p_status: 'active', p_current_period_end: periodEnd });
  assert.equal(duplicateSub.revoked_reason, 'duplicate');
  assert.ok(duplicateSub.revoked_at);
  assert.equal((await account(subscriber)).plan, 'pro', 'a duplicate never entitles, even for a higher plan');
  assert.equal((await rpc(env, 'zerox_billing_get', { p_user_id: subscriber })).subscription.provider_subscription_id, 'sub_TEST1',
    'Billing shows the entitled subscription');
  assert.equal((await upsert({ p_provider_subscription_id: 'sub_DUP1', p_plan: 'max', p_status: 'active', p_current_period_end: periodEnd })).revoked_reason,
    'duplicate', 'later events keep the revocation');
  await upsert({ p_provider_subscription_id: 'sub_DUP1', p_plan: 'max', p_status: 'cancelled', p_current_period_end: periodEnd });
  assert.equal((await account(subscriber)).plan, 'pro', 'a cancelled duplicate with paid time left grants nothing');
  const subscriptionList = await rpcRows(env, 'zerox_billing_subscriptions', { p_user_id: subscriber });
  assert.deepEqual(subscriptionList.map(row => [row.provider_subscription_id, row.status, row.revoked_reason]), [['sub_TEST1', 'active', null]],
    'zerox_billing_subscriptions lists the subscriptions that have not ended');
  // Upgrade to max once pro is cancelled (its paid period still running), then end pro.
  await upsert({ p_status: 'cancelled', p_current_period_end: periodEnd });
  assert.equal((await account(subscriber)).plan, 'pro', 'the cancelled pro keeps its plan until the period ends');
  const upgraded = await upsert({ p_provider_subscription_id: 'sub_TEST2', p_plan: 'max', p_status: 'active', p_current_period_end: periodEnd });
  assert.equal(upgraded.revoked_reason, null, 'a subscription after the previous one ended is no duplicate');
  assert.equal((await account(subscriber)).plan, 'max', 'highest entitling subscription wins');
  await upsert({ p_status: 'cancelled', p_current_period_end: new Date(Date.now() - 1000).toISOString() });
  assert.equal((await account(subscriber)).plan, 'max', 'ending the cheaper subscription keeps max');
  // Cancel max at period end: the plan stays until the period ends, then the expiry job downgrades.
  await upsert({ p_provider_subscription_id: 'sub_TEST2', p_plan: 'max', p_status: 'cancelled', p_current_period_end: periodEnd, p_cancel_at_period_end: true });
  assert.equal((await account(subscriber)).plan, 'max', 'cancelled subscriptions keep the plan until current_period_end');
  assert.deepEqual(await rpc(env, 'zerox_apply_subscription_expiry', {}), { downgraded: 0, reconciled: 0 });
  await sql("UPDATE public.zerox_subscriptions SET current_period_end = now() - interval '1 minute' WHERE provider_subscription_id = 'sub_TEST2'");
  const manualPro = await newUser('pro');
  assert.deepEqual(await rpc(env, 'zerox_apply_subscription_expiry', {}), { downgraded: 1, reconciled: 1 });
  subAccount = await account(subscriber);
  assert.equal(subAccount.plan, 'free'); assert.equal(subAccount.plan_source, 'default');
  assert.equal((await account(manualPro)).plan, 'pro', 'operator-granted plans are never downgraded by billing');
  assert.deepEqual(await rpc(env, 'zerox_apply_subscription_expiry', {}), { downgraded: 0, reconciled: 0 });
  const replayed = await upsert({ p_provider_subscription_id: 'sub_TEST2', p_plan: 'pro', p_status: 'active',
    p_current_period_end: new Date(Date.now() + 60 * 86400000).toISOString(), p_cancel_at_period_end: false, p_raw: { late: true } });
  assert.equal(replayed.status, 'cancelled', 'out-of-order webhooks cannot resurrect a cancelled subscription');
  assert.equal(replayed.plan, 'max', 'nor change its plan');
  assert.ok(new Date(replayed.current_period_end) < new Date(), 'nor extend its period');
  assert.equal(replayed.cancel_at_period_end, true);
  assert.equal(replayed.raw.late, undefined, 'the late payload is not stored');
  assert.equal((await account(subscriber)).plan, 'free');
  const ended = await upsert({ p_provider_subscription_id: 'sub_TEST2', p_plan: 'pro', p_status: 'completed', p_raw: { done: true } });
  assert.equal(ended.status, 'completed', 'ended subscriptions still accept ending updates');
  assert.equal(ended.plan, 'max', 'but keep their plan');
  assert.deepEqual(ended.raw, { done: true });
  await upsert({ p_provider_subscription_id: 'sub_TEST3', p_plan: 'pro', p_status: 'active', p_current_period_end: periodEnd });
  assert.equal((await account(subscriber)).plan, 'pro');
  await upsert({ p_provider_subscription_id: 'sub_TEST3', p_plan: 'pro', p_status: 'halted', p_current_period_end: new Date(Date.now() - 60000).toISOString() });
  assert.equal((await account(subscriber)).plan, 'free', 'halted after period end reverts to free immediately');
  ok('subscription upsert: plan grant on authenticated/active, duplicates revoked, upgrade, cancel at period end, expiry downgrade, ended subscriptions frozen');

  // ---------------------------------------------------------------- checkout guard, revocation (review P2/P3, integration)
  const shopper = await newUser('free');
  const recordCheckout = (id, plan = 'pro', planId = 'plan_ProInr') => rpc(env, 'zerox_billing_record_checkout', {
    p_user_id: shopper, p_provider: 'razorpay', p_provider_subscription_id: id, p_plan: plan, p_raw: { id, plan_id: planId } });
  assert.deepEqual(await recordCheckout('sub_SHOP1'), { recorded: true, blocking_subscription_id: 'sub_SHOP1', blocking_status: 'created',
    blocking_plan_id: 'plan_ProInr' });
  assert.deepEqual(await recordCheckout('sub_SHOP1'), { recorded: true, blocking_subscription_id: 'sub_SHOP1', blocking_status: 'created',
    blocking_plan_id: 'plan_ProInr' }, 'recording the same checkout again is idempotent');
  assert.deepEqual(await recordCheckout('sub_SHOP2', 'max', 'plan_MaxUsd'), { recorded: false, blocking_subscription_id: 'sub_SHOP1',
    blocking_status: 'created', blocking_plan_id: 'plan_ProInr' }, 'an unpaid checkout from the last day blocks a parallel one');
  assert.equal(await rpc(env, 'zerox_subscription_by_provider_id', { p_provider: 'razorpay', p_provider_subscription_id: 'sub_SHOP2' }), null);
  assert.equal((await account(shopper)).plan, 'free', 'a recorded checkout grants nothing');
  assert.equal((await rpc(env, 'zerox_billing_get', { p_user_id: shopper })).subscription.status, 'created', 'Billing shows the open checkout');
  await sql("UPDATE public.zerox_subscriptions SET created_at = now() - interval '25 hours' WHERE provider_subscription_id = 'sub_SHOP1'");
  assert.equal((await rpc(env, 'zerox_billing_get', { p_user_id: shopper })).subscription, null, 'an abandoned checkout disappears after a day');
  assert.equal((await recordCheckout('sub_SHOP2', 'max', 'plan_MaxUsd')).recorded, true, 'and no longer blocks');
  await rpc(env, 'zerox_billing_upsert_subscription', { p_user_id: shopper, p_provider: 'razorpay', p_provider_subscription_id: 'sub_SHOP2',
    p_plan: 'max', p_status: 'active', p_current_period_start: null, p_current_period_end: periodEnd, p_cancel_at_period_end: null, p_raw: null });
  assert.equal((await account(shopper)).plan, 'max');
  assert.deepEqual(await recordCheckout('sub_SHOP3'), { recorded: false, blocking_subscription_id: 'sub_SHOP2', blocking_status: 'active',
    blocking_plan_id: 'plan_MaxUsd' }, 'a live subscription blocks every checkout');
  const shopPayment = await rpc(env, 'zerox_billing_record_payment', { p_user_id: shopper, p_provider: 'razorpay', p_provider_payment_id: 'pay_SHOP2',
    p_kind: 'subscription', p_amount_minor: 4000, p_currency: 'USD', p_status: 'captured', p_invoice_url: null,
    p_raw: { id: 'pay_SHOP2', subscription_id: 'sub_SHOP2' } });
  assert.equal(shopPayment.raw.subscription_id, 'sub_SHOP2');
  const refundedPayment = await rpc(env, 'zerox_billing_record_payment', { p_user_id: shopper, p_provider: 'razorpay', p_provider_payment_id: 'pay_SHOP2',
    p_kind: 'subscription', p_amount_minor: 4000, p_currency: 'USD', p_status: 'refunded', p_invoice_url: null, p_raw: { id: 'pay_SHOP2', status: 'refunded' } });
  assert.deepEqual(refundedPayment.raw, { id: 'pay_SHOP2', status: 'refunded', subscription_id: 'sub_SHOP2' }, 'raw objects are merged');
  assert.equal((await rpcRows(env, 'zerox_billing_subscriptions', { p_user_id: shopper })).find(row => row.provider_subscription_id === 'sub_SHOP2').payments, 1);
  await rpc(env, 'zerox_credit_grant', { p_user_id: shopper, p_delta_microusd: 35000000, p_reason: 'subscription_max', p_ref: 'pay_SHOP2' });
  assert.deepEqual(await rpc(env, 'zerox_payment_by_provider_id', { p_provider: 'razorpay', p_provider_payment_id: 'pay_SHOP2' }), {
    id: shopPayment.id, user_id: shopper, kind: 'subscription', amount_minor: 4000, currency: 'USD', status: 'refunded',
    subscription_id: 'sub_SHOP2', granted_microusd: 35000000, granted_reason: 'subscription_max' });
  assert.equal(await rpc(env, 'zerox_payment_by_provider_id', { p_provider: 'razorpay', p_provider_payment_id: 'pay_UNKNOWN' }), null);
  const revokedSub = await rpc(env, 'zerox_billing_revoke_subscription', { p_provider: 'razorpay', p_provider_subscription_id: 'sub_SHOP2', p_reason: 'refunded' });
  assert.equal(revokedSub.revoked_reason, 'refunded');
  assert.equal((await account(shopper)).plan, 'free', 'a refunded subscription stops entitling at once');
  await rpc(env, 'zerox_billing_upsert_subscription', { p_user_id: shopper, p_provider: 'razorpay', p_provider_subscription_id: 'sub_SHOP2',
    p_plan: 'max', p_status: 'cancelled', p_current_period_start: null, p_current_period_end: periodEnd, p_cancel_at_period_end: false, p_raw: null });
  assert.equal((await account(shopper)).plan, 'free', 'not even when Razorpay reports paid time left');
  assert.equal((await rpc(env, 'zerox_billing_revoke_subscription', { p_provider: 'razorpay', p_provider_subscription_id: 'sub_SHOP2',
    p_reason: 'duplicate' })).revoked_reason, 'refunded', 'the first revocation is kept');
  assert.equal(await rpc(env, 'zerox_billing_revoke_subscription', { p_provider: 'razorpay', p_provider_subscription_id: 'sub_NOPE', p_reason: 'refunded' }), null);
  await assert.rejects(rpc(env, 'zerox_billing_revoke_subscription', { p_provider: 'razorpay', p_provider_subscription_id: 'sub_SHOP2', p_reason: 'whim' }),
    /invalid_revoke_reason/);
  await assert.rejects(recordCheckout('sub_SHOP4', 'free'), /invalid_plan/);
  ok('checkout guard: one unpaid checkout or live subscription per account; revoked subscriptions never entitle; payment lookup and raw merge');

  // ---------------------------------------------------------------- subscription grants are bounded in time
  const hoursAgo = hours => new Date(Date.now() - hours * 3600000).toISOString();
  const grantsPlan = (status, end, cancel = false, updated = hoursAgo(1)) => rpc(env, 'zerox_subscription_grants_plan', {
    p_status: status, p_current_period_end: end, p_cancel_at_period_end: cancel, p_updated_at: updated });
  for (const status of ['authenticated', 'active', 'pending']) {
    assert.equal(await grantsPlan(status, hoursAgo(-24)), true, `${status} grants during the period`);
    assert.equal(await grantsPlan(status, hoursAgo(48)), true, `${status} grants within the 3 day grace window`);
    assert.equal(await grantsPlan(status, hoursAgo(73)), false, `${status} stops granting after the grace window`);
    assert.equal(await grantsPlan(status, hoursAgo(1), true), false, `${status} set to cancel at period end gets no grace`);
    assert.equal(await grantsPlan(status, null, false, hoursAgo(48)), true, `${status} without a period end grants briefly`);
    assert.equal(await grantsPlan(status, null, false, hoursAgo(73)), false, `${status} without a period end lapses after 3 days`);
    assert.equal(await grantsPlan(status, null, false, null), false);
  }
  for (const status of ['halted', 'paused', 'cancelled', 'completed', 'expired']) {
    assert.equal(await grantsPlan(status, hoursAgo(-1)), true, `${status} grants until current_period_end`);
    assert.equal(await grantsPlan(status, hoursAgo(1)), false, `${status} gets no grace`);
    assert.equal(await grantsPlan(status, null), false);
  }
  assert.equal(await grantsPlan('created', hoursAgo(-24)), false, 'created grants nothing');
  // A paid plan whose renewal was never recorded (lost halted/cancelled webhook) lapses.
  const revenueBefore = (await rpc(env, 'zerox_admin_overview', {})).overview.revenue;
  const lapsed = {};
  for (const [status, end] of [['active', true], ['pending', true], ['authenticated', false]]) {
    const user = await newUser('free');
    lapsed[status] = user;
    await rpc(env, 'zerox_billing_upsert_subscription', { p_user_id: user, p_provider: 'razorpay',
      p_provider_subscription_id: `sub_LAPSE_${status}`, p_plan: 'pro', p_status: status, p_current_period_start: null,
      p_current_period_end: end ? hoursAgo(-24) : null, p_cancel_at_period_end: false, p_raw: null });
    assert.equal((await account(user)).plan, 'pro', `${status} grants the plan`);
  }
  const grantingRevenue = (await rpc(env, 'zerox_admin_overview', {})).overview.revenue;
  assert.equal(grantingRevenue.active_subscriptions, revenueBefore.active_subscriptions + 2, 'authenticated and active count in MRR');
  assert.equal(grantingRevenue.mrr_usd_estimate, revenueBefore.mrr_usd_estimate + 20);
  for (const [status, aged] of [['active', false], ['pending', false], ['authenticated', true]]) {
    await sql(`UPDATE public.zerox_subscriptions SET current_period_end = CASE WHEN $2 THEN NULL ELSE now() - interval '90 days' END,
      updated_at = now() - interval '90 days', created_at = now() - interval '90 days' WHERE provider_subscription_id = $1`,
    [`sub_LAPSE_${status}`, aged]);
  }
  const lapsedRevenue = (await rpc(env, 'zerox_admin_overview', {})).overview.revenue;
  assert.deepEqual(lapsedRevenue, revenueBefore, 'lapsed authenticated/active subscriptions drop out of MRR');
  assert.deepEqual(await rpc(env, 'zerox_apply_subscription_expiry', {}), { downgraded: 3, reconciled: 3 },
    'the expiry job catches subscriptions whose period ended without a renewal');
  for (const user of Object.values(lapsed)) {
    const row = await account(user);
    assert.equal(row.plan, 'free'); assert.equal(row.plan_source, 'default');
    assert.equal((await rpc(env, 'zerox_billing_get', { p_user_id: user })).subscription.plan, 'pro', 'the lapsed subscription stays visible');
  }
  const stale = await newUser('free');
  await rpc(env, 'zerox_billing_upsert_subscription', { p_user_id: stale, p_provider: 'razorpay', p_provider_subscription_id: 'sub_STALE',
    p_plan: 'max', p_status: 'active', p_current_period_start: null, p_current_period_end: hoursAgo(24 * 90),
    p_cancel_at_period_end: false, p_raw: null });
  assert.equal((await account(stale)).plan, 'free', 'an active webhook for a long-ended period grants nothing');
  ok('subscription grants bounded: 3 day grace for renewing statuses, none when cancelling or ended, lapsed grants downgraded and excluded from MRR');

  // ---------------------------------------------------------------- operator plans survive billing
  const subscribe = (user, id, plan, status, end) => rpc(env, 'zerox_billing_upsert_subscription', { p_user_id: user,
    p_provider: 'razorpay', p_provider_subscription_id: id, p_plan: plan, p_status: status, p_current_period_start: null,
    p_current_period_end: end, p_cancel_at_period_end: false, p_raw: null });
  const planOf = async user => { const row = await account(user); return [row.plan, row.plan_source, row.manual_plan]; };
  const compMax = await newUser('max');
  await subscribe(compMax, 'sub_COMP1', 'pro', 'active', periodEnd);
  assert.deepEqual(await planOf(compMax), ['max', 'manual', null], 'a higher-priced operator plan is kept while subscribed');
  await subscribe(compMax, 'sub_COMP1', 'pro', 'cancelled', hoursAgo(1));
  assert.deepEqual(await planOf(compMax), ['max', 'manual', null], 'and survives the subscription ending');
  const compPro = await newUser('pro');
  await subscribe(compPro, 'sub_COMP2', 'max', 'active', periodEnd);
  assert.deepEqual(await planOf(compPro), ['max', 'subscription', 'pro'], 'a higher-priced subscription applies and remembers the operator plan');
  await subscribe(compPro, 'sub_COMP2', 'max', 'cancelled', periodEnd);
  assert.deepEqual(await planOf(compPro), ['max', 'subscription', 'pro']);
  await sql("UPDATE public.zerox_subscriptions SET current_period_end = now() - interval '1 minute' WHERE provider_subscription_id = 'sub_COMP2'");
  assert.deepEqual(await rpc(env, 'zerox_apply_subscription_expiry', {}), { downgraded: 1, reconciled: 1 });
  assert.deepEqual(await planOf(compPro), ['pro', 'manual', null], 'the operator plan is restored when billing ends');
  const legacyComp = await newUser('free');
  await sql("UPDATE public.zerox_accounts SET plan = 'ultrawork', plan_source = 'default' WHERE clerk_id = $1", [legacyComp]);
  await subscribe(legacyComp, 'sub_COMP3', 'pro', 'active', periodEnd);
  assert.deepEqual(await planOf(legacyComp), ['pro', 'subscription', 'ultrawork'],
    'an equally priced subscription applies; a paid plan set without a source counts as an operator plan');
  await subscribe(legacyComp, 'sub_COMP3', 'pro', 'halted', hoursAgo(1));
  assert.deepEqual(await planOf(legacyComp), ['ultrawork', 'manual', null]);
  const withdrawn = await newUser('pro');
  await subscribe(withdrawn, 'sub_COMP4', 'max', 'active', periodEnd);
  await sql('UPDATE public.zerox_accounts SET manual_plan = NULL WHERE clerk_id = $1', [withdrawn]);
  await subscribe(withdrawn, 'sub_COMP4', 'max', 'expired', hoursAgo(1));
  assert.deepEqual(await planOf(withdrawn), ['free', 'default', null], 'clearing manual_plan withdraws the operator grant');
  // The expiry job also corrects billing plans changed out of band, counting only downgrades as such.
  const drifted = await newUser('free');
  await subscribe(drifted, 'sub_DRIFT', 'pro', 'active', periodEnd);
  await sql("UPDATE public.zerox_subscriptions SET plan = 'max' WHERE provider_subscription_id = 'sub_DRIFT'");
  assert.deepEqual(await rpc(env, 'zerox_apply_subscription_expiry', {}), { downgraded: 0, reconciled: 1 },
    'an upgrade is reconciled but not reported as a downgrade');
  assert.deepEqual(await planOf(drifted), ['max', 'subscription', null]);
  await sql("UPDATE public.zerox_accounts SET manual_plan = 'max' WHERE clerk_id = $1", [drifted]);
  await sql("UPDATE public.zerox_subscriptions SET plan = 'pro' WHERE provider_subscription_id = 'sub_DRIFT'");
  assert.deepEqual(await rpc(env, 'zerox_apply_subscription_expiry', {}), { downgraded: 0, reconciled: 0 },
    'a newly granted higher operator plan is applied without counting a plan change');
  assert.deepEqual(await planOf(drifted), ['max', 'manual', null]);
  for (const id of ['sub_COMP1', 'sub_COMP2', 'sub_COMP3', 'sub_COMP4', 'sub_DRIFT']) {
    await sql("UPDATE public.zerox_subscriptions SET status = 'expired', current_period_end = now() - interval '1 day' WHERE provider_subscription_id = $1", [id]);
  }
  assert.deepEqual(await rpc(env, 'zerox_apply_subscription_expiry', {}), { downgraded: 0, reconciled: 0 });
  ok('operator plans: kept when priced higher, remembered and restored when billing ends, withdrawable; expiry reports downgrades only as downgrades');

  // ---------------------------------------------------------------- payments, credits, webhooks
  const payer = await newUser('pro');
  const payment = (overrides = {}) => rpc(env, 'zerox_billing_record_payment', {
    p_user_id: payer, p_provider: 'razorpay', p_provider_payment_id: 'pay_TEST1', p_kind: 'topup',
    p_amount_minor: 44900, p_currency: 'INR', p_status: 'created', p_invoice_url: null, p_raw: { id: 'pay_TEST1' }, ...overrides,
  });
  const recorded = await payment();
  assert.equal(recorded.status, 'created'); assert.equal(recorded.amount_minor, 44900); assert.equal(recorded.user_id, payer);
  const captured = await payment({ p_status: 'captured', p_invoice_url: 'https://rzp.io/i/test' });
  assert.equal(captured.id, recorded.id); assert.equal(captured.status, 'captured'); assert.equal(captured.invoice_url, 'https://rzp.io/i/test');
  assert.equal((await payment({ p_status: 'authorized', p_invoice_url: null })).status, 'captured', 'status never moves backwards');
  assert.equal((await payment({ p_status: 'failed' })).invoice_url, 'https://rzp.io/i/test');
  assert.equal((await payment({ p_status: 'failed' })).status, 'captured');
  assert.equal((await sql("SELECT count(*)::int AS n FROM public.zerox_payments WHERE provider_payment_id = 'pay_TEST1'"))[0].n, 1);
  await assert.rejects(payment({ p_user_id: subscriber }), /payment_owner_mismatch/);
  await assert.rejects(payment({ p_provider_payment_id: 'pay_TEST2', p_invoice_url: 'javascript:alert(1)' }), /invalid_invoice_url/);
  await assert.rejects(payment({ p_provider_payment_id: 'pay_TEST2', p_currency: 'inr' }), /invalid_currency/);
  await assert.rejects(payment({ p_provider_payment_id: 'pay_TEST2', p_kind: 'gift' }), /invalid_payment_kind/);
  await payment({ p_provider_payment_id: 'pay_TEST3', p_kind: 'subscription', p_amount_minor: 89900, p_status: 'captured' });
  const payerBilling = await rpc(env, 'zerox_billing_get', { p_user_id: payer });
  assert.equal(payerBilling.subscription, null);
  assert.equal(payerBilling.payments.length, 2);
  assert.deepEqual(new Set(payerBilling.payments.map(row => row.provider_payment_id)), new Set(['pay_TEST1', 'pay_TEST3']));
  assert.ok(payerBilling.payments.every(row => row.raw === undefined && row.user_id === undefined && row.kind && row.amount_minor && row.currency));
  assert.deepEqual(await rpc(env, 'zerox_credit_grant', { p_user_id: payer, p_delta_microusd: 5000000, p_reason: 'topup', p_ref: 'razorpay:pay_TEST1' }),
    { granted: true, balance_microusd: 5000000 });
  assert.deepEqual(await rpc(env, 'zerox_credit_grant', { p_user_id: payer, p_delta_microusd: 5000000, p_reason: 'topup', p_ref: 'razorpay:pay_TEST1' }),
    { granted: false, balance_microusd: 5000000 }, 'credit grants are idempotent on ref');
  assert.deepEqual(await rpc(env, 'zerox_credit_grant', { p_user_id: payer, p_delta_microusd: -7000000, p_reason: 'refund', p_ref: 'razorpay:rfnd_1' }),
    { granted: true, balance_microusd: 0 });
  const [clamped] = await sql("SELECT * FROM public.zerox_credit_ledger WHERE ref = 'razorpay:rfnd_1'");
  assert.equal(clamped.delta_microusd, -5000000); assert.equal(clamped.shortfall_microusd, 2000000);
  await assert.rejects(rpc(env, 'zerox_credit_grant', { p_user_id: payer, p_delta_microusd: 0, p_reason: 'topup', p_ref: 'zero' }), /invalid_credit_delta/);
  await assert.rejects(rpc(env, 'zerox_credit_grant', { p_user_id: payer, p_delta_microusd: 1, p_reason: 'Top Up', p_ref: 'bad' }), /invalid_credit_reason/);
  await assert.rejects(rpc(env, 'zerox_credit_grant', { p_user_id: randomUUID(), p_delta_microusd: 1, p_reason: 'topup', p_ref: 'nobody' }), /account_not_found/);
  const claim = args => rpc(env, 'zerox_webhook_claim', { p_provider: 'razorpay', p_event_id: 'evt_TEST1',
    p_event_type: 'subscription.charged', p_payload_sha256: sha('{"event":"subscription.charged"}'), ...args });
  const complete = (provider = 'razorpay') => rpc(env, 'zerox_webhook_complete', { p_provider: provider, p_event_id: 'evt_TEST1' });
  const leaseOf = async () => (await sql(`SELECT status, attempts, lease_expires_at > now() AS live, processed_at IS NOT NULL AS done
    FROM public.zerox_webhook_events WHERE provider = 'razorpay' AND event_id = 'evt_TEST1'`))[0];
  assert.deepEqual(await claim(), { claimed: true, in_progress: false });
  assert.deepEqual(await leaseOf(), { status: 'processing', attempts: 1, live: true, done: false });
  assert.deepEqual(await claim(), { claimed: false, in_progress: true }, 'a delivery being processed is not claimed twice');
  assert.deepEqual(await complete(), { completed: true });
  assert.deepEqual(await leaseOf(), { status: 'processed', attempts: 1, live: null, done: true });
  assert.deepEqual(await claim(), { claimed: false, in_progress: false }, 'processed deliveries are deduplicated');
  assert.deepEqual(await claim({ p_provider: 'stripe' }), { claimed: true, in_progress: false }, 'event ids are scoped per provider');
  assert.deepEqual(await rpc(env, 'zerox_webhook_release', { p_provider: 'razorpay', p_event_id: 'evt_TEST1' }), { released: true });
  assert.deepEqual(await claim(), { claimed: true, in_progress: false }, 'a released claim can be processed again');
  // Review P3 (integration): a claim held by an invocation that died (CPU or wall-time limit,
  // eviction) is claimed again once its lease expires, so Razorpay's retry is processed.
  await sql("UPDATE public.zerox_webhook_events SET lease_expires_at = now() - interval '1 second' WHERE provider = 'razorpay' AND event_id = 'evt_TEST1'");
  assert.deepEqual(await claim({ p_lease_seconds: 300 }), { claimed: true, in_progress: false }, 'an expired lease is claimed again');
  const renewed = await leaseOf();
  assert.deepEqual([renewed.status, renewed.attempts, renewed.live], ['processing', 2, true]);
  assert.ok((await sql("SELECT lease_expires_at > now() + interval '200 seconds' AS long FROM public.zerox_webhook_events WHERE provider = 'razorpay' AND event_id = 'evt_TEST1'"))[0].long);
  await complete();
  await sql("UPDATE public.zerox_webhook_events SET lease_expires_at = now() - interval '1 second' WHERE provider = 'razorpay' AND event_id = 'evt_TEST1'");
  assert.deepEqual(await claim(), { claimed: false, in_progress: false }, 'a processed delivery is never claimed again');
  assert.deepEqual(await rpc(env, 'zerox_webhook_complete', { p_provider: 'razorpay', p_event_id: 'evt_NEVER' }), { completed: false });
  await assert.rejects(claim({ p_event_id: 'evt_2', p_payload_sha256: 'xyz' }), /invalid_payload_sha256/);
  await assert.rejects(claim({ p_event_id: 'evt_3', p_lease_seconds: 5 }), /invalid_lease/);
  ok('payments idempotent with forward-only status, credit grants idempotent with clamp, webhook claims are leases (dedupe, release, expiry, complete)');

  // ---------------------------------------------------------------- usage series, by model, events
  const statsUser = await newUser('max', { credits: 10000000 });
  const usageFor = async (model, day, prompt, completion, cost, tier = 'free') => {
    const reservation = await reserve(statsUser, { p_model: model, p_tier: tier, p_cost_microusd: cost });
    assert.equal(reservation.status, 'ok');
    await sql('UPDATE public.zerox_reservations SET usage_day = $2::date WHERE id = $1', [reservation.reservation_id, day]);
    await settle(reservation.reservation_id, { p_prompt_tokens: prompt, p_completion_tokens: completion, p_cost_microusd: cost });
  };
  await usageFor('m/a', utcDay(-2), 100, 10, 0);
  await usageFor('m/a', utcDay(-2), 200, 20, 0);
  await usageFor('m/b', utcDay(-2), 50, 5, 1500, 'paid');
  await usageFor('m/b', utcDay(0), 1, 1, 2500, 'paid');
  await usageFor('m/a', utcDay(0), 7, 3, 0);
  const series = await rpcRows(env, 'zerox_usage_series', { p_user_id: statsUser, p_from: utcDay(-3), p_to: utcDay(0) });
  assert.deepEqual(series, [
    { day: utcDay(-3), requests: 0, prompt_tokens: 0, completion_tokens: 0, cost_microusd: 0 },
    { day: utcDay(-2), requests: 3, prompt_tokens: 350, completion_tokens: 35, cost_microusd: 1500 },
    { day: utcDay(-1), requests: 0, prompt_tokens: 0, completion_tokens: 0, cost_microusd: 0 },
    { day: utcDay(0), requests: 2, prompt_tokens: 8, completion_tokens: 4, cost_microusd: 2500 },
  ], 'series is zero-filled per UTC day');
  assert.deepEqual(await rpcRows(env, 'zerox_usage_by_model', { p_user_id: statsUser, p_from: utcDay(-3), p_to: utcDay(0) }), [
    { model: 'm/a', requests: 3, prompt_tokens: 307, completion_tokens: 33, cost_microusd: 0 },
    { model: 'm/b', requests: 2, prompt_tokens: 51, completion_tokens: 6, cost_microusd: 4000 },
  ]);
  assert.deepEqual(await rpcRows(env, 'zerox_usage_by_model', { p_user_id: statsUser, p_from: utcDay(-1), p_to: utcDay(-1) }), []);
  await assert.rejects(rpcRows(env, 'zerox_usage_series', { p_user_id: statsUser, p_from: utcDay(0), p_to: utcDay(-1) }), /invalid_range/);
  await assert.rejects(rpcRows(env, 'zerox_usage_series', { p_user_id: statsUser, p_from: utcDay(-400), p_to: utcDay(0) }), /invalid_range/);
  await assert.rejects(rpcRows(env, 'zerox_usage_by_model', { p_user_id: statsUser, p_from: null, p_to: utcDay(0) }), /invalid_range/);
  const page1 = await rpcRows(env, 'zerox_usage_events', { p_user_id: statsUser, p_limit: 2, p_before: null });
  const page2 = await rpcRows(env, 'zerox_usage_events', { p_user_id: statsUser, p_limit: 2, p_before: page1.at(-1).id });
  const page3 = await rpcRows(env, 'zerox_usage_events', { p_user_id: statsUser, p_limit: 2, p_before: page2.at(-1).id });
  assert.deepEqual([page1.length, page2.length, page3.length], [2, 2, 1]);
  const ids = [...page1, ...page2, ...page3].map(row => row.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => b - a), 'events are newest first');
  assert.equal(new Set(ids).size, 5, 'pages do not overlap');
  assert.equal((await rpcRows(env, 'zerox_usage_events', { p_user_id: statsUser, p_limit: 1000 })).length, 5);
  assert.equal((await rpcRows(env, 'zerox_usage_events', { p_user_id: statsUser, p_limit: 0 })).length, 1, 'limit is clamped to 1..200');
  assert.equal((await rpcRows(env, 'zerox_usage_events', { p_user_id: statsUser })).length, 5, 'limit and before have defaults');
  assert.ok((await rpcRows(env, 'zerox_usage_events', { p_user_id: alice, p_limit: 50 })).every(row => row.user_id === alice));
  ok('usage series (zero-filled), usage by model, events pagination with p_before and limit clamp');

  // ---------------------------------------------------------------- account overview and admin overview
  const statsOverview = await rpc(env, 'zerox_account_overview', { p_user_id: statsUser });
  assert.deepEqual(Object.keys(statsOverview).sort(), ['account', 'credits', 'policy', 'subscription', 'usage_today']);
  assert.equal(statsOverview.account.id, statsUser);
  assert.equal(statsOverview.policy.daily_requests, 10000);
  assert.equal(statsOverview.credits.balance_microusd, 10000000 - 4000);
  assert.equal(statsOverview.subscription, null);
  assert.equal(statsOverview.usage_today.requests, 5);
  assert.equal(statsOverview.usage_today.remaining_requests, 9995);
  assert.equal(new Date(statsOverview.usage_today.resets_at).toISOString(), nextResets);
  await sql("UPDATE public.zerox_accounts SET last_usage_reset = '2000-01-01' WHERE clerk_id = $1", [statsUser]);
  assert.equal((await rpc(env, 'zerox_account_overview', { p_user_id: statsUser })).usage_today.requests, 0, 'overview applies the UTC reset');
  assert.equal(await rpc(env, 'zerox_account_overview', { p_user_id: randomUUID() }), null);
  const { overview: admin } = await rpc(env, 'zerox_admin_overview', {});
  const [counts] = await sql('SELECT count(*)::int AS total, count(*) FILTER (WHERE suspended)::int AS suspended FROM public.zerox_accounts');
  assert.equal(admin.users.total, counts.total);
  assert.equal(admin.users.suspended, counts.suspended);
  assert.equal(Object.values(admin.users.by_plan).reduce((sum, value) => sum + value, 0), counts.total);
  // The subscriber's halted sub_TEST3 is still live (Razorpay can resume it): a subscription activated
  // meanwhile is a duplicate and adds no revenue. Once sub_TEST3 is cancelled a new one counts.
  const haltedDuplicate = await upsert({ p_provider_subscription_id: 'sub_TEST4', p_plan: 'max', p_status: 'active', p_current_period_end: periodEnd });
  assert.equal(haltedDuplicate.revoked_reason, 'duplicate');
  assert.deepEqual((await rpc(env, 'zerox_admin_overview', {})).overview.revenue, admin.revenue, 'a revoked duplicate is not revenue');
  await upsert({ p_provider_subscription_id: 'sub_TEST3', p_plan: 'pro', p_status: 'cancelled', p_current_period_end: new Date(Date.now() - 60000).toISOString() });
  await upsert({ p_provider_subscription_id: 'sub_TEST5', p_plan: 'max', p_status: 'active', p_current_period_end: periodEnd });
  const { overview: adminWithRevenue } = await rpc(env, 'zerox_admin_overview', {});
  assert.equal(adminWithRevenue.revenue.active_subscriptions, admin.revenue.active_subscriptions + 1);
  assert.equal(adminWithRevenue.revenue.mrr_usd_estimate, admin.revenue.mrr_usd_estimate + 40);
  assert.deepEqual(adminWithRevenue.revenue, { active_subscriptions: 1, mrr_usd_estimate: 40, by_plan: { max: 1 } },
    'only the one current subscription counts; ended and lapsed ones do not');
  const [todayUsage] = await sql(`SELECT coalesce(sum(requests), 0)::int AS requests, coalesce(sum(cost_microusd), 0)::int AS cost
    FROM public.zerox_usage_daily WHERE day = (now() AT TIME ZONE 'UTC')::date`);
  assert.ok(todayUsage.requests > 0 && todayUsage.cost > 0);
  assert.equal(admin.usage_today.requests, todayUsage.requests);
  assert.equal(admin.usage_today.cost_microusd, todayUsage.cost);
  assert.equal(admin.usage_today.cost_usd, todayUsage.cost / 1e6);
  const groqPool = admin.pools.find(row => row.model === 'groq/openai/gpt-oss-120b' && row.tier === 'free');
  assert.equal(groqPool.requests_today, 1); assert.equal(groqPool.tokens_today, 500);
  assert.ok(admin.users.active_today >= 1);
  ok('account overview (jsonb columns, UTC reset) and admin overview totals, revenue and pool counters');

  // ---------------------------------------------------------------- session index
  const cliUser = await newUser('free');
  const expires = new Date(Date.now() + 30 * 86400000).toISOString();
  const hashes = ['one', 'two', 'three'].map(token => sha(`ses_${token}`));
  for (const hash of hashes) {
    const row = await rpc(env, 'zerox_session_index_add', { p_user_id: cliUser, p_token_hash: hash, p_expires_at: expires });
    assert.equal(row.token_hash, hash); assert.equal(row.user_id, cliUser);
  }
  assert.equal((await rpc(env, 'zerox_session_index_add', { p_user_id: cliUser, p_token_hash: hashes[0], p_expires_at: expires })).token_hash, hashes[0], 're-adding is an upsert');
  await assert.rejects(rpc(env, 'zerox_session_index_add', { p_user_id: freeUser, p_token_hash: hashes[0], p_expires_at: expires }), /session_owner_mismatch/);
  await assert.rejects(rpc(env, 'zerox_session_index_add', { p_user_id: cliUser, p_token_hash: 'ses_raw_token', p_expires_at: expires }), /invalid_session_index/);
  await assert.rejects(rpc(env, 'zerox_session_index_add', { p_user_id: cliUser, p_token_hash: sha('x'), p_expires_at: new Date(Date.now() - 1000).toISOString() }), /invalid_session_index/);
  assert.deepEqual(new Set((await rpcRows(env, 'zerox_session_index_list', { p_user_id: cliUser })).map(row => row.token_hash)), new Set(hashes));
  assert.deepEqual(await rpc(env, 'zerox_session_index_remove', { p_token_hash: hashes[2] }), { removed: true });
  const revoked = await rpcRows(env, 'zerox_session_index_revoke_all', { p_user_id: cliUser });
  assert.deepEqual(new Set(revoked.map(row => row.token_hash)), new Set(hashes.slice(0, 2)), 'revoke_all returns the hashes to delete from KV');
  assert.deepEqual(await rpcRows(env, 'zerox_session_index_list', { p_user_id: cliUser }), []);
  assert.deepEqual(await rpcRows(env, 'zerox_session_index_revoke_all', { p_user_id: cliUser }), []);
  ok('session index add/list/remove/revoke_all with hashed ids and ownership checks');

  // ---------------------------------------------------------------- bursts (serialized by PGlite)
  // PGlite has a single connection and runs each RPC in its own transaction one after another, so
  // these bursts check the limit logic and exactly-once results under many queued calls, not lock
  // contention. Row locks (FOR UPDATE, INSERT ... ON CONFLICT) are what make the same calls safe on
  // multi-connection Postgres; run an equivalent burst against a real Postgres before release.
  await clockHeadroom();
  const parallelUser = await newUser('free');
  const burst = await Promise.all(Array.from({ length: 12 }, () => reserve(parallelUser)));
  assert.equal(burst.filter(row => row.status === 'ok').length, 2, 'parallel reservations respect concurrency');
  assert.ok(burst.filter(row => row.status !== 'ok').every(row => row.status === 'user_concurrency'));
  const poolBurstUsers = [];
  for (let index = 0; index < 20; index += 1) poolBurstUsers.push(await newUser('pro'));
  const shared = await Promise.all(poolBurstUsers.map(user => reserve(user, { p_model: 'burst/pool', p_pool: { rpm: 7, tpm: 100000 } })));
  assert.equal(shared.filter(row => row.status === 'ok').length, 7, 'parallel reservations never exceed the shared pool');
  assert.ok(shared.filter(row => row.status !== 'ok').every(row => row.status === 'pool_exhausted'));
  assert.equal((await poolRow('burst/pool', 'free', 'minute')).requests, 7);
  const capUser = await newUser('max');
  await sql('UPDATE public.zerox_accounts SET daily_requests = 9997 WHERE clerk_id = $1', [capUser]);
  const capped = await Promise.all(Array.from({ length: 8 }, () => reserve(capUser)));
  assert.equal(capped.filter(row => row.status === 'ok').length, 3, 'parallel reservations never exceed the daily cap');
  assert.equal((await account(capUser)).daily_requests, 10000);
  const creditUser = await newUser('max', { credits: 1000 });
  const spend = await Promise.all(Array.from({ length: 8 }, () => reserve(creditUser, { p_tier: 'paid', p_cost_microusd: 300 })));
  const spent = spend.filter(row => row.status === 'ok');
  assert.equal(spent.length, 3, 'parallel paid reservations cannot overspend credits');
  const settles = await Promise.all([...spent, spent[0], spent[0]].map(row => settle(row.reservation_id, { p_cost_microusd: 300 })));
  assert.equal(settles.filter(row => row.status === 'settled').length, 3);
  assert.equal(settles.filter(row => row.status === 'already_settled').length, 2, 'parallel settles bill exactly once');
  assert.equal((await account(creditUser)).credit_balance_microusd, 100);
  const claims = await Promise.all(Array.from({ length: 6 }, () => rpc(env, 'zerox_webhook_claim', {
    p_provider: 'razorpay', p_event_id: 'evt_PARALLEL', p_event_type: 'payment.captured', p_payload_sha256: null })));
  assert.equal(claims.filter(row => row.claimed).length, 1);
  const grants = await Promise.all(Array.from({ length: 6 }, () => rpc(env, 'zerox_credit_grant', {
    p_user_id: creditUser, p_delta_microusd: 1000, p_reason: 'subscription_grant', p_ref: 'invoice:parallel' })));
  assert.equal(grants.filter(row => row.granted).length, 1);
  assert.equal((await account(creditUser)).credit_balance_microusd, 1100);
  const keyBurstUser = await newUser('pro');
  const keyBurst = await Promise.allSettled(Array.from({ length: 15 }, (_, index) => rpc(env, 'zerox_api_key_create', {
    p_user_id: keyBurstUser, p_name: `k${index}`, p_prefix: 'nzx_burst', p_hash: sha(`burst-${index}`) })));
  assert.equal(keyBurst.filter(result => result.status === 'fulfilled').length, 10);
  assert.ok(keyBurst.filter(result => result.status === 'rejected').every(result => /too_many_keys/.test(result.reason.message)));
  ok('serialized bursts (one PGlite connection, so no lock contention): reserves never exceed concurrency, pool, daily or credit limits; settles, claims, grants and key creation are exactly-once');

  // ---------------------------------------------------------------- legacy RPCs still work
  const legacyUser = await newUser('pro');
  const legacyReserve = await rpc(env, 'zerox_reserve_usage', { p_user_id: legacyUser, p_tokens: 1000 });
  assert.equal(legacyReserve.daily_requests, 1);
  assert.equal(legacyReserve.credit_balance_microusd, 0, 'legacy RPCs return the widened account row');
  assert.equal((await rpc(env, 'zerox_settle_usage', { p_user_id: legacyUser, p_reserved: 1000, p_actual: 10, p_day: todayUtc })).daily_tokens_used, 10);
  assert.equal((await rpc(env, 'zerox_get_account', { p_user_id: legacyUser })).plan, 'pro');
  ok('legacy zerox_reserve_usage/zerox_settle_usage/zerox_get_account keep working for rollback');

  // ---------------------------------------------------------------- access control
  const functions = await sql(`SELECT p.oid::regprocedure::text AS signature, p.proname, p.prosecdef, p.proconfig,
      has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
      has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_exec
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'`);
  const contractRpcs = ['zerox_reserve_v2', 'zerox_settle_v2', 'zerox_release_stale_reservations', 'zerox_plan_policies_v2',
    'zerox_account_overview', 'zerox_usage_series', 'zerox_usage_by_model', 'zerox_usage_events', 'zerox_api_key_create',
    'zerox_api_key_list', 'zerox_api_key_revoke', 'zerox_api_key_verify', 'zerox_billing_upsert_subscription',
    'zerox_billing_record_payment', 'zerox_credit_grant', 'zerox_webhook_claim', 'zerox_billing_get',
    'zerox_subscription_by_provider_id', 'zerox_apply_subscription_expiry', 'zerox_session_index_add',
    'zerox_session_index_list', 'zerox_session_index_revoke_all', 'zerox_admin_overview',
    // v1.1 extensions (contract section 6)
    'zerox_webhook_release', 'zerox_webhook_complete', 'zerox_billing_subscriptions', 'zerox_billing_record_checkout',
    'zerox_billing_revoke_subscription', 'zerox_payment_by_provider_id', 'zerox_session_index_remove', 'zerox_session_rearm',
    // concurrency leases (migrations/20261028000000_reservation_leases.sql)
    'zerox_renew_reservation'];
  for (const name of contractRpcs) assert.ok(functions.some(row => row.proname === name), `${name} exists`);
  for (const row of functions) {
    assert.equal(row.prosecdef, false, `${row.signature} is SECURITY INVOKER`);
    assert.ok(row.proconfig?.includes('search_path=""'), `${row.signature} pins search_path`);
    assert.equal(row.anon_exec, false, `${row.signature} not executable by anon`);
    assert.equal(row.auth_exec, false, `${row.signature} not executable by authenticated`);
    assert.equal(row.service_exec, true, `${row.signature} executable by service_role`);
  }
  const tables = await sql(`SELECT c.relname, c.relrowsecurity,
      has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS anon_any,
      has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS auth_any,
      has_table_privilege('service_role', c.oid, 'SELECT') AND has_table_privilege('service_role', c.oid, 'INSERT')
        AND has_table_privilege('service_role', c.oid, 'UPDATE') AND has_table_privilege('service_role', c.oid, 'DELETE') AS service_all
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'`);
  for (const name of ['zerox_reservations', 'zerox_usage_events', 'zerox_usage_daily', 'zerox_pool_usage', 'zerox_api_keys',
    'zerox_subscriptions', 'zerox_payments', 'zerox_credit_ledger', 'zerox_webhook_events', 'zerox_session_index']) {
    assert.ok(tables.some(row => row.relname === name), `${name} exists`);
  }
  for (const row of tables) {
    assert.equal(row.relrowsecurity, true, `${row.relname} has RLS enabled`);
    assert.equal(row.anon_any, false, `${row.relname} hidden from anon`);
    assert.equal(row.auth_any, false, `${row.relname} hidden from authenticated`);
    assert.equal(row.service_all, true, `${row.relname} usable by service_role`);
  }
  const sequences = await sql(`SELECT c.relname, has_sequence_privilege('anon', c.oid, 'USAGE,SELECT,UPDATE') AS anon_use,
      has_sequence_privilege('authenticated', c.oid, 'USAGE,SELECT,UPDATE') AS auth_use
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'S'`);
  assert.ok(sequences.length >= 2 && sequences.every(row => !row.anon_use && !row.auth_use));
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`SET ROLE ${role}`);
    try {
      for (const row of tables) {
        await assert.rejects(db.query(`SELECT * FROM public.${row.relname} LIMIT 1`), /permission denied/, `${role} reads ${row.relname}`);
      }
      await assert.rejects(db.query('SELECT * FROM public.zerox_reserve_v2($1, $2, $3, $4, $5, $6, $7)',
        [alice, 'r', 'm', 'free', 1, 0, null]), /permission denied/);
      await assert.rejects(db.query('SELECT * FROM public.zerox_credit_grant($1, $2, $3, $4)', [alice, 1, 'topup', 'x']), /permission denied/);
      await assert.rejects(db.query('SELECT * FROM public.zerox_admin_overview()'), /permission denied/);
      await assert.rejects(db.query('SELECT * FROM public.zerox_api_key_verify($1)', [sha('x')]), /permission denied/);
      await assert.rejects(db.query('SELECT * FROM public.zerox_session_index_revoke_all($1)', [alice]), /permission denied/);
    } finally { await db.exec('RESET ROLE'); }
  }
  ok(`access control: ${functions.length} functions SECURITY INVOKER with pinned search_path and service_role-only EXECUTE; ${tables.length} tables with RLS, hidden from anon/authenticated`);

  // ---------------------------------------------------------------- gateway on the local driver
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => { throw new Error(`network disabled in check-business-db: ${url}`); };
  try {
    const { default: app } = await import('./src/index.js');
    // Anonymous /health is trimmed to {status, service, version} (WP-B3), so the database
    // configuration is read with the operator token.
    const ADMIN = 'check-business-db-operator-token-0123456789';
    const operator = { headers: { Authorization: `Bearer ${ADMIN}` } };
    const gatewayEnv = { DATABASE_DRIVER: 'pglite', GROQ_API_KEY: 'gsk_check_only', GROQ_MODELS: 'openai/gpt-oss-120b',
      GROQ_TOOL_MODELS: 'openai/gpt-oss-120b', GATEWAY_ADMIN_TOKEN: ADMIN };
    const anonymousHealth = await (await app.request('https://zero-x.live/health', {}, gatewayEnv)).json();
    assert.equal(anonymousHealth.database_configured, undefined, 'anonymous callers do not see the configuration');
    const health = await (await app.request('https://zero-x.live/health', operator, gatewayEnv)).json();
    assert.equal(health.database_configured, true);
    const ready = await app.request('https://zero-x.live/ready', {}, gatewayEnv);
    assert.equal(ready.status, 200, 'plan policies and the session store load through DATABASE_DRIVER=pglite');
    assert.deepEqual(await ready.json(), { ready: true });
    for (const misconfigured of [{ NODE_ENV: 'production' }, { AUTH_HOST: '0.0.0.0' }]) {
      const exposedEnv = { ...gatewayEnv, ...misconfigured };
      const exposedHealth = await (await app.request('https://zero-x.live/health', operator, exposedEnv)).json();
      assert.equal(exposedHealth.database_configured, false, `${JSON.stringify(misconfigured)} does not count as a configured database`);
      assert.equal((await app.request('https://zero-x.live/ready', {}, exposedEnv)).status, 503, 'and the gateway does not report ready');
    }
  } finally { globalThis.fetch = originalFetch; }
  ok('gateway /health and /ready run against DATABASE_DRIVER=pglite, and refuse it in production or beyond loopback');

  // ---------------------------------------------------------------- operator scripts
  const node = process.execPath;
  const cleanEnv = { ...process.env };
  delete cleanEnv.DATABASE_URL;
  const dry = spawnSync(node, ['scripts/apply-migrations.mjs'], { cwd: root, env: cleanEnv, encoding: 'utf8' });
  assert.equal(dry.status, 0, dry.stderr);
  const listedFiles = dry.stdout.split(/\r?\n/).filter(line => /^\s+\d{8,14}\s/.test(line)).map(line => line.trim().split(/\s+/)[1]);
  assert.deepEqual(listedFiles, migrations.map(migration => migration.file), 'dry run lists migrations in apply order');
  assert.match(dry.stdout, /dry run/);
  const refused = spawnSync(node, ['scripts/apply-migrations.mjs', '--apply'], { cwd: root, env: cleanEnv, encoding: 'utf8' });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /DATABASE_URL/);
  const argvUrl = spawnSync(node, ['scripts/apply-migrations.mjs', '--status', '--database-url', 'postgresql://u:secret@db.example.invalid/x'],
    { cwd: root, env: cleanEnv, encoding: 'utf8' });
  assert.equal(argvUrl.status, 2, 'a connection string in argv is refused before connecting');
  assert.match(argvUrl.stderr, /--database-url is not supported because it exposes the password in the process list; set DATABASE_URL instead/);
  assert.ok(!`${argvUrl.stdout}${argvUrl.stderr}`.includes('secret'));
  // Each file and its history row run as one psql script, the row inside the file's transaction.
  for (const migration of await Promise.all(migrations.map(readMigration))) {
    const script = migrationScript(migration);
    assert.ok(script.trimEnd().endsWith(`VALUES ('${migration.version}', '${migration.name}') ON CONFLICT (version) DO NOTHING;\nCOMMIT;`),
      `${migration.file}: history row inserted just before the final COMMIT`);
    assert.equal(script.split(/\bCOMMIT\s*;/i).length, migration.sql.split(/\bCOMMIT\s*;/i).length, 'no extra COMMIT');
  }
  assert.match(migrationScript({ version: '20990101000000', name: 'no_tx', file: '20990101000000_no_tx.sql', sql: 'SELECT 1;' }),
    /SELECT 1;\nINSERT INTO supabase_migrations\.schema_migrations/, 'files without a final COMMIT get the row appended');
  assert.throws(() => migrationScript({ version: "1'; DROP", name: 'x', file: 'x.sql', sql: '' }), /Unexpected migration identity/);
  const psqlStandIn = await PGlite.create();
  try {
    // Running the generated scripts in order (as psql would) applies and records every migration.
    await psqlStandIn.exec(DEV_BOOTSTRAP_SQL);
    for (const migration of await Promise.all(migrations.map(readMigration))) await psqlStandIn.exec(migrationScript(migration));
    assert.deepEqual((await psqlStandIn.query('SELECT version FROM supabase_migrations.schema_migrations ORDER BY version')).rows
      .map(row => row.version), migrations.map(migration => migration.version).sort());
    const failing = { version: '20990101000100', name: 'failing', file: '20990101000100_failing.sql',
      sql: 'BEGIN;\nCREATE TABLE public.half_applied (id int);\nSELECT 1/0;\nCOMMIT;\n' };
    await assert.rejects(psqlStandIn.exec(migrationScript(failing)), /division by zero/);
    await psqlStandIn.exec('ROLLBACK');
    assert.equal((await psqlStandIn.query("SELECT count(*)::int AS n FROM supabase_migrations.schema_migrations WHERE version = '20990101000100'")).rows[0].n, 0,
      'a failed migration is never recorded');
    assert.equal((await psqlStandIn.query("SELECT to_regclass('public.half_applied') AS t")).rows[0].t, null);
    // Migrations that lock busy tables give up instead of queueing reserves and settles behind a
    // long transaction, and the timeout ends with their transaction.
    assert.match(await readFile(join(root, 'migrations/20261028000000_reservation_leases.sql'), 'utf8'),
      /^BEGIN;\s+(?:--.*\s+)*SET LOCAL lock_timeout = '\d+s';/);
    assert.equal((await psqlStandIn.query('SHOW lock_timeout')).rows[0].lock_timeout, '0');
  } finally { await psqlStandIn.close(); }
  // migrations/down/<file> undoes one migration by hand (psql -f; the runner reads
  // migrations/*.sql only). It restores what the migration replaced exactly as the migrations
  // before it left it and drops its history row, so the runner can apply it again.
  // Function bodies are compared without CRs: a checkout may give the files either line ending.
  const schemaOf = async database => (await database.query(`
    SELECT 'function' AS kind, p.oid::regprocedure::text AS name,
        replace(pg_get_functiondef(p.oid), chr(13), '') || coalesce(p.proacl::text, '') AS def
      FROM pg_proc AS p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'
    UNION ALL SELECT 'column', c.table_name || '.' || c.column_name, concat_ws(' ', c.data_type, c.is_nullable, c.column_default)
      FROM information_schema.columns AS c WHERE c.table_schema = 'public'
    UNION ALL SELECT 'index', i.indexname, i.indexdef FROM pg_indexes AS i WHERE i.schemaname = 'public'
    UNION ALL SELECT 'history', h.version, h.name FROM supabase_migrations.schema_migrations AS h
    ORDER BY 1, 2`)).rows;
  const downFiles = (await readdir(join(root, 'migrations/down'))).sort();
  assert.deepEqual(downFiles, ['20261028000000_reservation_leases.sql']);
  for (const file of downFiles) {
    const migration = migrations.find(candidate => candidate.file === file);
    assert.ok(migration, `${file} undoes a migration of the same name`);
    const down = await readFile(join(root, 'migrations/down', file), 'utf8');
    assert.ok(!/^CREATE\s+FUNCTION\b/im.test(down), `${file}: functions are restored with CREATE OR REPLACE`);
    assert.match(down, /^BEGIN;\s+(?:--.*\s+)*SET LOCAL lock_timeout = '\d+s';[\s\S]*\bCOMMIT;\s*$/,
      `${file}: one transaction with a lock timeout`);
    // Applies the migrations in order up to (and without) the one at index `end`.
    const upTo = async (database, end) => {
      await database.exec(DEV_BOOTSTRAP_SQL);
      for (const earlier of migrations.slice(0, end)) await database.exec(migrationScript(await readMigration(earlier)));
    };
    const before = await PGlite.create();
    const rolled = await PGlite.create();
    try {
      await upTo(before, migrations.indexOf(migration));
      await upTo(rolled, migrations.indexOf(migration) + 1);
      const applied = await schemaOf(rolled);
      await rolled.exec(down);
      assert.deepEqual(await schemaOf(rolled), await schemaOf(before), `${file} restores the schema the migrations before it left`);
      await rolled.exec(migrationScript(await readMigration(migration)));
      assert.deepEqual(await schemaOf(rolled), applied, `${file}: the migration applies again after its rollback`);
    } finally {
      await before.close();
      await rolled.close();
    }
  }
  assert.deepEqual(connectionEnv('postgresql://postgres.ref:p%40ss@db.example.invalid:6543/postgres'), {
    PGHOST: 'db.example.invalid', PGPORT: '6543', PGUSER: 'postgres.ref', PGPASSWORD: 'p@ss', PGDATABASE: 'postgres',
    PGSSLMODE: 'require', PGCONNECT_TIMEOUT: '15', PGAPPNAME: 'zerox-apply-migrations' });
  assert.equal(connectionEnv('postgres://u@localhost/db').PGSSLMODE, 'prefer');
  assert.throws(() => connectionEnv('mysql://x@y/z'), /postgresql/);
  assert.equal(maskUrl('postgresql://u:secret@h:5432/d?sslmode=require'), 'postgresql://u:***@h:5432/d');

  const brokenDir = await mkdtemp(join(tmpdir(), 'zerox-migrations-'));
  const scratch = await PGlite.create();
  try {
    await writeFile(join(brokenDir, '20990101000000_good.sql'), 'BEGIN; CREATE TABLE public.good_table (id int); COMMIT;');
    await writeFile(join(brokenDir, '20990101000100_broken.sql'), 'BEGIN; CREATE TABLE public.half_table (id int); SELECT 1/0; COMMIT;');
    await assert.rejects(migrate(scratch, { directory: brokenDir }), error => error instanceof AccountDatabaseError &&
      /^Migration 20990101000100_broken\.sql failed: division by zero$/.test(error.message) && error.code === '22012');
    assert.deepEqual((await scratch.query('SELECT version FROM supabase_migrations.schema_migrations')).rows.map(row => row.version),
      ['20990101000000'], 'a failed migration is not recorded');
    assert.equal((await scratch.query("SELECT to_regclass('public.half_table') AS t")).rows[0].t, null, 'a failed migration is rolled back');
    await writeFile(join(brokenDir, '20990101000100_broken.sql'), 'BEGIN; CREATE TABLE public.half_table (id int); COMMIT;');
    assert.deepEqual(await migrate(scratch, { directory: brokenDir }), ['20990101000100'], 'the fixed migration applies on the next open');
    await writeFile(join(brokenDir, 'notes.sql'), '');
    await assert.rejects(listMigrations(brokenDir), /Unexpected migration file name: notes\.sql/);
  } finally {
    await scratch.close();
    assert.equal(dirname(resolve(brokenDir)), resolve(tmpdir()));
    await rm(brokenDir, { recursive: true, force: true });
  }

  const dataDir = await mkdtemp(join(tmpdir(), 'zerox-dev-db-'));
  const diskEnv = { DATABASE_DRIVER: 'pglite', PGLITE_DATA_DIR: dataDir };
  try {
    const seedArgs = ['scripts/dev-db.mjs', '--data-dir', dataDir, '--email', 'dev@example.test', '--plan', 'pro', '--credits-usd', '5'];
    const seeded = spawnSync(node, seedArgs, { cwd: root, encoding: 'utf8' });
    assert.equal(seeded.status, 0, seeded.stderr);
    assert.match(seeded.stdout, /applied migrations: /);
    const userId = seeded.stdout.match(/user: ([0-9a-f-]{36}) dev@example\.test plan=pro credits_usd=5\r?\n/)?.[1];
    assert.ok(userId, seeded.stdout);
    const { devUserId } = await import('./src/auth-context.js');
    assert.equal(userId, await devUserId('dev@example.test'), 'the seeded user is the local dev identity of that e-mail address');
    const again = spawnSync(node, seedArgs, { cwd: root, encoding: 'utf8' });
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /migrations: up to date/);
    assert.match(again.stdout, new RegExp(`user: ${userId} dev@example\\.test plan=pro credits_usd=10\\r?\\n`), 'reseeding keeps the user');
    const bad = spawnSync(node, ['scripts/dev-db.mjs', '--data-dir', dataDir, '--plan', 'pro'], { cwd: root, encoding: 'utf8' });
    assert.equal(bad.status, 2);
    const diskHandle = await getPgliteHandle(diskEnv);
    assert.deepEqual(diskHandle.applied, [], 'persisted database is already migrated');
    const persisted = await rpc(diskEnv, 'zerox_account_overview', { p_user_id: userId });
    assert.equal(persisted.account.plan, 'pro');
    assert.equal(persisted.account.plan_source, 'manual');
    assert.equal(persisted.credits.balance_microusd, 10000000);
  } finally {
    await closePglite(diskEnv);
    assert.equal(dirname(resolve(dataDir)), resolve(tmpdir()));
    await rm(dataDir, { recursive: true, force: true });
  }
  ok('operator scripts and migration runner: dry run, DATABASE_URL only (argv refused), history row inside each migration transaction, failed-migration rollback, lock timeouts, down files that restore the prior schema and let the migration re-apply, dev-db create, seed, reseed and on-disk persistence');

  console.log(`PASS: business data model (${passed.length} groups): every contract RPC, quota/credit/pool atomicity, billing idempotency, access control and the PGlite driver`);
} finally {
  await closeAllPglite();
}

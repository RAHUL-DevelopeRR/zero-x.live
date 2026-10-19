// Provider key vault (src/provider-keys.js, src/routes/provider-keys.js,
// migrations/20261024000000_provider_keys.sql), offline: in-memory PGlite, fake upstreams, a
// test Cloudflare Access signing key, a controlled HealthHub clock.
//   node check-provider-keys.mjs
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { closeAllPglite, getPgliteHandle } from './src/db/pglite.js';
import {
  base64ToBytes, kekConfigured, loadVaultKeys, openProviderKey, resetVaultCache, sealProviderKey, touchVaultKey,
  vaultConfigured, vaultKeys,
} from './src/provider-keys.js';
import { catalogEntry, entryPools, poolConfigured, poolKey, poolSecret } from './src/catalog.js';
import { RoutingEngine } from './src/router.js';
import { reservationArgs } from './src/capacity.js';
import { ADAPTERS, requestCompletion } from './src/providers.js';
import { FailureKind, HealthState, ProviderHealthTracker } from './src/provider-health.js';
import { HealthHub } from './src/health-hub.js';
import { overviewPools } from './src/routes/admin.js';
import { resetAccessCache, verifyAccessJwt } from './src/access-auth.js';

const b64 = bytes => Buffer.from(bytes).toString('base64');
const b64url = value => Buffer.from(value).toString('base64url');
const KEK = b64(randomBytes(32));
const ADMIN = randomBytes(30).toString('base64url');
const SECRETS = {
  groqEnv: 'gsk_env_groq_key_0000000000000001', geminiEnv: 'AIza_env_gemini_key_000000000002',
  groqA: 'gsk_vault_groq_key_A_00000000003', groqB: 'gsk_vault_groq_key_B_00000000004',
  groqBad: 'gsk_vault_groq_key_bad_000000005', geminiV: 'AIza_vault_gemini_key_0000000006',
  geminiBad: 'AIza_vault_gemini_bad_0000000007', openrouter: 'sk-or-v1-vault-openrouter-00000008',
  nvidia: 'nvapi-vault-nvidia-key-000000009', flaky: 'gsk_vault_groq_flaky_0000000010',
};
const env = {
  DATABASE_DRIVER: 'pglite', PROVIDER_KEYS_KEK: KEK, GATEWAY_ADMIN_TOKEN: ADMIN, ALLOW_UNKNOWN_COUNTRY: 'true',
  GROQ_API_KEY: SECRETS.groqEnv, GEMINI_API_KEY: SECRETS.geminiEnv, NVIDIA_HOSTED: 'true', OPENROUTER_HOSTED: 'true',
};
const ok = name => console.log(`ok - ${name}`);
const leaks = text => Object.values(SECRETS).filter(secret => text.includes(secret));

const handle = await getPgliteHandle(env);
const sql = async (text, params) => (await handle.db.query(text, params)).rows;
const { default: app } = await import('./src/index.js');

// ── Fake upstreams: every outbound call is recorded; anything unexpected throws ──
const calls = [];
const revoked = new Set();
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const groqKeys = new Set([SECRETS.groqEnv, SECRETS.groqA, SECRETS.groqB, SECRETS.flaky]);
const geminiKeys = new Set([SECRETS.geminiEnv, SECRETS.geminiV]);
let flakyStatus = 503;
let access = null; // { team, jwks }
const upstream = {
  'https://api.groq.com/openai/v1/models': (url, headers) => {
    const key = headers.get('authorization')?.replace(/^Bearer /, '');
    if (key === SECRETS.flaky) return json({ error: { message: 'busy' } }, flakyStatus);
    if (!groqKeys.has(key) || revoked.has(key)) return json({ error: { message: 'Invalid API Key', code: 'invalid_api_key' } }, 401);
    return json({ data: [{ id: 'openai/gpt-oss-120b' }, { id: 'openai/gpt-oss-20b' }, { id: 'qwen/qwen3.8-27b' }] });
  },
  'https://api.groq.com/openai/v1/chat/completions': () => json({ choices: [{ message: { role: 'assistant', content: 'OK' } }] }),
  'https://generativelanguage.googleapis.com/v1beta/models': (url, headers) => {
    if (!geminiKeys.has(headers.get('x-goog-api-key'))) {
      return json({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT',
        details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com' }] } }, 400);
    }
    return json({ models: ['gemini-2.5-flash', 'gemini-3.5-flash', 'gemini-3.6-flash'].map(id => ({ name: `models/${id}` })) });
  },
  'https://openrouter.ai/api/v1/key': (url, headers) => headers.get('authorization') === `Bearer ${SECRETS.openrouter}`
    && !revoked.has(SECRETS.openrouter) ? json({ data: { label: 'vault' } }) : json({ error: { message: 'User not found.', code: 401 } }, 401),
  'https://openrouter.ai/api/v1/models': () => json({ data: [{ id: 'cohere/north-mini-code:free' }, { id: 'minimax/minimax-m3.1-flash:free' }] }),
  'https://integrate.api.nvidia.com/v1/chat/completions': (url, headers) => headers.get('authorization') === `Bearer ${SECRETS.nvidia}`
    ? json({ choices: [{ message: { role: 'assistant', content: 'O' } }] }) : json({ detail: 'Authorization failed' }, 401),
  'https://integrate.api.nvidia.com/v1/models': () => json({ data: [{ id: 'openai/gpt-oss-20b' },
    { id: 'nvidia/nemotron-3-ultra-550b-a55b' }, { id: 'stepfun-ai/step-5-preview' }] }),
  'https://groqstatus.com/api/v2/summary.json': () => json({ components: [] }),
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input?.url ?? input);
  const headers = new Headers(init.headers || input?.headers || {});
  calls.push({ url, method: init.method || 'GET', authorization: headers.get('authorization'), goog: headers.get('x-goog-api-key'),
    body: typeof init.body === 'string' ? init.body : null });
  if (access && url === `https://${access.team}/cdn-cgi/access/certs`) return json(access.jwks);
  for (const [prefix, handler] of Object.entries(upstream)) if (url.startsWith(prefix)) return handler(url, headers);
  throw new TypeError(`check-provider-keys: unexpected request to ${url}`);
};

const admin = (path, { method = 'GET', body, headers = {}, host = 'dashboard.zero-x.live', token = ADMIN, target = env } = {}) =>
  app.request(`https://${host}${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
  body: body === undefined ? undefined : JSON.stringify(body) }, target);
const addKey = (provider, label, key, options = {}) => admin('/admin/providers/keys', { method: 'POST', body: { provider, label, key }, ...options });

try {
  // 1. Envelope encryption: AES-256-GCM under the KEK, bound to row id and provider.
  assert.equal(kekConfigured(env), true);
  assert.equal(vaultConfigured(env), true);
  assert.equal(kekConfigured({ PROVIDER_KEYS_KEK: b64(randomBytes(16)) }), false, 'a 16-byte KEK is refused');
  assert.equal(kekConfigured({ PROVIDER_KEYS_KEK: 'not base64 !!' }), false);
  assert.equal(kekConfigured({ PROVIDER_KEYS_KEK: b64url(randomBytes(32)) }), true, 'base64url is accepted');
  assert.equal(vaultConfigured({ PROVIDER_KEYS_KEK: KEK }), false, 'no database: no vault');
  const id = crypto.randomUUID();
  const sealed = await sealProviderKey(env, { id, provider: 'groq', secret: SECRETS.groqA });
  const again = await sealProviderKey(env, { id, provider: 'groq', secret: SECRETS.groqA });
  assert.notEqual(sealed.ciphertext, again.ciphertext, 'a fresh IV every time');
  assert.equal(base64ToBytes(sealed.iv).length, 12);
  assert.ok(!Buffer.from(sealed.ciphertext, 'base64').toString('latin1').includes(SECRETS.groqA));
  assert.equal(await openProviderKey(env, { id, provider: 'groq', ...sealed }), SECRETS.groqA);
  await assert.rejects(openProviderKey(env, { id: crypto.randomUUID(), provider: 'groq', ...sealed }), 'another row id does not open');
  await assert.rejects(openProviderKey(env, { id, provider: 'gemini', ...sealed }), 'another provider does not open');
  await assert.rejects(openProviderKey({ ...env, PROVIDER_KEYS_KEK: b64(randomBytes(32)) }, { id, provider: 'groq', ...sealed }),
    'another KEK does not open');
  ok('envelope: AES-256-GCM with a fresh IV, bound to row id and provider; 32-byte KEK required');

  // 2. Database: RLS, no access for anon/authenticated, service_role-only RPCs.
  const [table] = await sql(`SELECT c.relrowsecurity FROM pg_class c WHERE c.relname = 'zerox_provider_keys'`);
  assert.equal(table.relrowsecurity, true);
  const functions = await sql(`SELECT p.proname, p.prosecdef, p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname LIKE 'zerox_provider_key%'`);
  assert.equal(functions.length, 5);
  for (const fn of functions) {
    assert.equal(fn.prosecdef, false, `${fn.proname} is SECURITY INVOKER`);
    assert.deepEqual(fn.proconfig, ['search_path=""'], `${fn.proname} pins search_path`);
  }
  for (const role of ['anon', 'authenticated']) {
    await handle.db.exec(`SET ROLE ${role}`);
    try {
      await assert.rejects(handle.db.query('SELECT * FROM public.zerox_provider_keys'), /permission denied/);
      await assert.rejects(handle.db.query('SELECT * FROM public.zerox_provider_keys_active()'), /permission denied/);
      await assert.rejects(handle.db.query('SELECT * FROM public.zerox_provider_keys_list()'), /permission denied/);
      await assert.rejects(handle.db.query('SELECT * FROM public.zerox_provider_key_disable($1)', [id]), /permission denied/);
    } finally { await handle.db.exec('RESET ROLE'); }
  }
  ok('database: RLS on, hidden from anon/authenticated, five SECURITY INVOKER RPCs with a pinned search_path');

  // 3. Admin API: operator token, validation before saving, metadata only.
  assert.equal((await admin('/admin/providers/keys', { token: null })).status, 401);
  assert.equal((await admin('/admin/providers/keys', { token: 'x'.repeat(40) })).status, 401);
  const noKek = await admin('/admin/providers/keys', { target: { ...env, PROVIDER_KEYS_KEK: undefined } });
  assert.equal(noKek.status, 503);
  assert.equal((await noKek.json()).error.code, 'vault_not_configured');
  for (const [body, param] of [[{ provider: 'azure', label: 'x', key: SECRETS.groqA }, 'provider'],
    [{ provider: 'groq', label: '', key: SECRETS.groqA }, 'label'], [{ provider: 'groq', label: 'x', key: 'short' }, 'key'],
    [{ provider: 'groq', label: 'x', key: 'has a space in it 123456' }, 'key']]) {
    const response = await admin('/admin/providers/keys', { method: 'POST', body });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.param, param);
  }
  const addedA = await addKey('groq', 'groq-org-a', SECRETS.groqA);
  assert.equal(addedA.status, 201);
  const keyA = (await addedA.json()).key;
  assert.deepEqual(Object.keys(keyA).sort(), ['created_at', 'disabled_at', 'id', 'label', 'last4', 'last_used_at', 'provider', 'status']);
  assert.equal(keyA.last4, SECRETS.groqA.slice(-4));
  assert.equal(calls.at(-1).url, 'https://api.groq.com/openai/v1/models', 'validated with one free /models call');
  assert.equal(calls.at(-1).authorization, `Bearer ${SECRETS.groqA}`);
  const keyB = (await (await addKey('groq', 'groq-org-b', SECRETS.groqB)).json()).key;
  const [stored] = await sql('SELECT * FROM public.zerox_provider_keys WHERE id = $1', [keyA.id]);
  assert.ok(!JSON.stringify(stored).includes(SECRETS.groqA), 'only ciphertext in the database');
  assert.equal(await openProviderKey(env, stored), SECRETS.groqA);

  const rejected = await addKey('groq', 'bad', SECRETS.groqBad);
  assert.equal(rejected.status, 422);
  assert.equal((await rejected.json()).error.code, 'invalid_provider_key');
  const geminiRejected = await addKey('gemini', 'bad', SECRETS.geminiBad);
  assert.equal(geminiRejected.status, 422, 'Gemini 400 API_KEY_INVALID is a rejected key');
  const flaky = await addKey('groq', 'flaky', SECRETS.flaky);
  assert.equal(flaky.status, 502, 'a provider outage saves nothing');
  flakyStatus = 429;
  assert.equal((await addKey('groq', 'flaky', SECRETS.flaky)).status, 201, 'a rate-limited key authenticated: saved');
  const duplicate = await addKey('groq', 'again', SECRETS.groqA);
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).error.code, 'duplicate_key');
  const keyGemini = (await (await addKey('gemini', 'gemini-project-2', SECRETS.geminiV)).json()).key;
  const keyOr = (await (await addKey('openrouter', 'openrouter-acct', SECRETS.openrouter)).json()).key;
  assert.equal(calls.at(-1).url, 'https://openrouter.ai/api/v1/key', 'OpenRouter keys are checked on its key endpoint');
  const keyNv = (await (await addKey('nvidia', 'nvidia-trial', SECRETS.nvidia)).json()).key;
  const nvidiaCheck = calls.at(-1);
  assert.equal(nvidiaCheck.url, 'https://integrate.api.nvidia.com/v1/chat/completions', 'NVIDIA lists models without a key');
  assert.equal(JSON.parse(nvidiaCheck.body).max_tokens, 1);
  assert.equal((await sql('SELECT count(*)::int AS n FROM public.zerox_provider_keys'))[0].n, 6, 'rejected keys were not saved');
  assert.ok(!calls.some(call => leaks(call.url).length), 'no key in any URL');

  const listed = await admin('/admin/providers/keys');
  assert.equal(listed.status, 200);
  assert.equal(listed.headers.get('cache-control'), 'no-store');
  const listText = await listed.text();
  assert.deepEqual(leaks(listText), [], 'the list never carries a key');
  assert.ok(!listText.includes(stored.ciphertext) && !listText.includes(stored.iv), 'nor a ciphertext or IV');
  const list = JSON.parse(listText);
  assert.equal(list.keys.length, 6);
  assert.deepEqual(list.keys.find(key => key.id === keyA.id).health, { pools: 3, available: 3, degraded: 0, busy: 0, blurred: 0 });
  const groqRow = list.providers.find(item => item.provider === 'groq');
  assert.deepEqual(groqRow.env_key, { variable: 'GROQ_API_KEY', last4: SECRETS.groqEnv.slice(-4), fallback: true, duplicate_of: null });
  assert.equal(groqRow.active_keys, 3);
  assert.equal(list.providers.find(item => item.provider === 'nvidia').env_key, null);
  ok('admin API: token required, invalid input 400, one free check before saving (401/400 API_KEY_INVALID -> 422, outage -> 502), duplicates 409, list shows metadata only');

  // 4. Pools: one per vault key, env key last; budgets add up; secrets only through poolSecret.
  const gpt = catalogEntry('groq/openai/gpt-oss-120b');
  const free = entryPools(env, gpt).filter(pool => pool.tier === 'free');
  const flakyKey = vaultKeys(env).find(key => key.label === 'flaky');
  assert.deepEqual(free.map(pool => poolKey(gpt, pool)), [
    `groq:openai/gpt-oss-120b:free#${keyA.id}`, `groq:openai/gpt-oss-120b:free#${keyB.id}`,
    `groq:openai/gpt-oss-120b:free#${flakyKey.id}`, 'groq:openai/gpt-oss-120b:free']);
  assert.deepEqual(free.map(pool => poolSecret(env, pool)), [SECRETS.groqA, SECRETS.groqB, SECRETS.flaky, SECRETS.groqEnv]);
  assert.ok(free.every(pool => poolConfigured(env, gpt, pool)));
  assert.deepEqual(leaks(JSON.stringify(free)), [], 'a serialized pool carries no key');
  assert.equal(free[0].limits.rpm, 30, 'one key: its own per-minute budget (prompt sizing)');
  assert.equal(free[0].shared_limits.rpm, 120, 'four keys: four budgets in the shared reservation');
  assert.equal(reservationArgs({ session: { user_id: 'u' }, requestId: 'r', entry: gpt, pool: free[1], promptTokens: 10, maxTokens: 10 })
    .p_pool.rpd, 4000);
  assert.equal(ADAPTERS.groq.getApiKey(env, {}, free[1]), SECRETS.groqB);
  assert.equal(entryPools(env, catalogEntry('@cf/meta/llama-3.3-70b-instruct-fp8-fast')), catalogEntry('@cf/meta/llama-3.3-70b-instruct-fp8-fast').pools);
  calls.length = 0;
  await requestCompletion(env, {}, gpt, { model: gpt.id, messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 }, undefined, free[1]);
  assert.equal(calls[0].authorization, `Bearer ${SECRETS.groqB}`, 'the vault pool sends its own key upstream');

  // Same caller -> same first key; callers spread over the keys; a parked key fails over.
  const router = new RoutingEngine(new ProviderHealthTracker());
  const firstKey = affinity => router.route({ env, requestedModel: gpt.id, promptTokens: 200, maxTokens: 1024, affinity })
    .candidates[0].pool.key_id;
  assert.equal(firstKey('user-1'), firstKey('user-1'));
  const firsts = new Set(Array.from({ length: 24 }, (_, index) => firstKey(`user-${index}`)));
  assert.equal(firsts.size, 3, 'callers start on every vault key');
  const route = router.route({ env, requestedModel: gpt.id, promptTokens: 200, maxTokens: 1024, affinity: 'user-1' });
  assert.equal(route.candidates.filter(candidate => candidate.entry.id === gpt.id).at(-1).pool.key_id, undefined, 'env key last');
  router.healthTracker.recordFailure(route.candidates[0].key, { kind: FailureKind.AUTH });
  const failover = router.route({ env, requestedModel: gpt.id, promptTokens: 200, maxTokens: 1024, affinity: 'user-1' });
  assert.notEqual(failover.candidates[0].key, route.candidates[0].key, 'a dead key is skipped');
  assert.equal(failover.candidates.length, route.candidates.length - 1);

  // The vault key equal to the env key replaces the env pool instead of doubling it.
  const geminiTwin = { ...env, GEMINI_API_KEY: SECRETS.geminiV };
  await loadVaultKeys(geminiTwin);
  const flash = catalogEntry('gemini/gemini-2.5-flash');
  assert.deepEqual(entryPools(geminiTwin, flash).filter(pool => pool.tier === 'free').map(pool => pool.key_id), [keyGemini.id]);
  const twinList = await (await admin('/admin/providers/keys', { target: geminiTwin })).json();
  assert.equal(twinList.providers.find(item => item.provider === 'gemini').env_key.duplicate_of, keyGemini.id);
  ok('pools: one per key (#id), env key last unless duplicated, budgets summed for reservations, callers spread, dead key fails over');

  // 5. /v1/models with vault keys only: the env-less deployment still serves; no key id leaks.
  const vaultOnly = { ...env, GROQ_API_KEY: undefined, GEMINI_API_KEY: undefined };
  const models = await app.request('https://zero-x.live/v1/models', {}, vaultOnly);
  const modelsText = await models.text();
  const byId = Object.fromEntries(JSON.parse(modelsText).data.map(model => [model.id, model]));
  assert.equal(byId['groq/openai/gpt-oss-120b'].available, true, 'vault keys alone configure the model');
  assert.equal(byId['nvidia/openai/gpt-oss-20b'].available, true);
  assert.ok(![keyA.id, keyB.id, keyNv.id].some(key => modelsText.includes(key)) && !leaks(modelsText).length);
  const overview = overviewPools(env, [], new ProviderHealthTracker());
  const groqFree = overview.find(row => row.model === gpt.id && row.tier === 'free');
  assert.equal(groqFree.limits.rpm, 120);
  assert.deepEqual(groqFree.keys.map(key => key.source), ['vault', 'vault', 'vault', 'env']);
  assert.deepEqual(leaks(JSON.stringify(overview)), []);
  ok('catalog: vault-only deployment lists the models; /v1/models and the overview carry no key or key id beyond operators');

  // 6. HealthHub: one list check per key; a dead key greys out only its own pools.
  revoked.add(SECRETS.groqA);
  revoked.add(SECRETS.openrouter);
  const saved = new Map();
  const state = { blockConcurrencyWhile: fn => fn(), storage: { get: async key => saved.get(key),
    put: async (key, value) => { saved.set(key, structuredClone(value)); }, getAlarm: async () => 1, setAlarm: async () => {} } };
  const base = Date.now();
  let offset = 0;
  const hub = new HealthHub(state, env, { now: () => base + offset });
  await hub.ready;
  calls.length = 0;
  for (let i = 0; i < 4; i++) { offset += 31_000; await hub.alarm(); }
  const lists = calls.filter(call => call.url === 'https://api.groq.com/openai/v1/models');
  assert.deepEqual(new Set(lists.map(call => call.authorization)), new Set([SECRETS.groqA, SECRETS.groqB, SECRETS.flaky, SECRETS.groqEnv]
    .map(secret => `Bearer ${secret}`)), 'the Groq list is read once with each key');
  assert.deepEqual(new Set(calls.filter(call => call.url.startsWith('https://generativelanguage')).map(call => call.goog)),
    new Set([SECRETS.geminiEnv, SECRETS.geminiV]));
  assert.ok(calls.every(call => !leaks(call.url).length), 'keys travel in headers only');
  const record = key => hub.tracker.records.get(key)?.status ?? HealthState.HEALTHY;
  for (const model of ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b']) {
    assert.equal(record(`groq:${model}:free#${keyA.id}`), HealthState.AUTH_FAILED, `revoked key A greys out ${model}`);
    assert.equal(record(`groq:${model}:free#${keyB.id}`), HealthState.HEALTHY, 'key B keeps serving');
    assert.equal(record(`groq:${model}:free`), HealthState.HEALTHY, 'the env key keeps serving');
  }
  assert.equal(record(`openrouter:cohere/north-mini-code:free:free#${keyOr.id}`), HealthState.AUTH_FAILED,
    'OpenRouter key endpoint 401 greys out that key');
  assert.equal(record(`nvidia:openai/gpt-oss-20b:free#${keyNv.id}`), HealthState.HEALTHY);
  assert.equal(hub.snapshot().pools[`groq:openai/gpt-oss-120b:free#${keyA.id}`].status, 'blurred');
  const checkIds = Object.keys(hub.checks);
  assert.ok(checkIds.includes(`list:groq:${keyA.id}`) && checkIds.includes('list:groq:env') && checkIds.includes(`key:openrouter:${keyOr.id}`));
  assert.deepEqual(leaks(JSON.stringify([...saved.values()])), [], 'no key in Durable Object storage');

  const keyHealth = (await (await admin('/admin/providers/keys')).json()).keys;
  // The admin list reads this isolate's tracker on the Node server; the hub's view is checked above.
  assert.ok(keyHealth.every(key => key.status !== 'active' || key.health));
  ok('HealthHub: lists read once per key (Groq, Gemini), OpenRouter key endpoint per key, dead keys grey out only their pools, nothing secret stored');

  // 7. Disable: gone from this isolate at once, and from the hub's checks.
  assert.equal((await admin('/admin/providers/keys/not-a-uuid', { method: 'DELETE' })).status, 400);
  assert.equal((await admin(`/admin/providers/keys/${crypto.randomUUID()}`, { method: 'DELETE' })).status, 404);
  const disabled = await admin(`/admin/providers/keys/${keyA.id}`, { method: 'DELETE' });
  assert.equal(disabled.status, 200);
  const disabledKey = (await disabled.json()).key;
  assert.equal(disabledKey.status, 'disabled');
  assert.ok(disabledKey.disabled_at);
  assert.equal((await admin(`/admin/providers/keys/${keyA.id}`, { method: 'DELETE' })).status, 200, 'idempotent');
  assert.ok(!entryPools(env, gpt).some(pool => pool.key_id === keyA.id), 'its pools are gone');
  offset += 61_000;
  await hub.alarm();
  assert.ok(!Object.keys(hub.checks).includes(`list:groq:${keyA.id}`), 'its checks are forgotten');
  const relisted = (await (await admin('/admin/providers/keys')).json()).keys;
  assert.equal(relisted.find(key => key.id === keyA.id).status, 'disabled');
  ok('disable: idempotent, 404 for unknown ids, pools leave this isolate at once and the hub drops its checks');

  // 8. Last used, decrypt failures and the cap.
  const touch = touchVaultKey(env, keyB.id);
  assert.ok(touch);
  assert.equal(touchVaultKey(env, keyB.id), null, 'at most every 10 minutes per isolate');
  await touch;
  assert.ok((await sql('SELECT last_used_at FROM public.zerox_provider_keys WHERE id = $1', [keyB.id]))[0].last_used_at);
  const otherKek = { ...env, PROVIDER_KEYS_KEK: b64(randomBytes(32)) };
  const errors = console.error;
  console.error = () => {};
  try { assert.deepEqual(await loadVaultKeys(otherKek), [], 'another KEK opens nothing and serves nothing'); }
  finally { console.error = errors; }
  resetVaultCache(otherKek);
  for (let index = 0; index < 18; index++) {
    groqKeys.add(`gsk_cap_test_key_${String(index).padStart(14, '0')}`);
    assert.equal((await addKey('groq', `cap-${index}`, `gsk_cap_test_key_${String(index).padStart(14, '0')}`)).status, 201);
  }
  groqKeys.add('gsk_cap_test_key_overflow_000001');
  const capped = await addKey('groq', 'one too many', 'gsk_cap_test_key_overflow_000001');
  assert.equal(capped.status, 409);
  assert.equal((await capped.json()).error.code, 'too_many_keys');
  ok('last_used_at written at most every 10 minutes; a wrong KEK serves nothing; at most 20 active keys per provider');

  // 9. Admin page: dashboard host only, strict enforced CSP, Cloudflare Access verified when configured.
  const assets = { fetch: async request => new Response(new URL(request.url).pathname, { headers: { 'Content-Type': 'text/html' } }) };
  const page = await app.request('https://dashboard.zero-x.live/admin/keys', {}, { ...env, ASSETS: assets });
  assert.equal(page.status, 200);
  assert.equal(await page.text(), '/neuroncli/admin/keys/index.html');
  const csp = page.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.ok(!csp.includes('unsafe-inline') && !csp.includes('unsafe-eval'), 'no inline script or style allowed');
  assert.equal(page.headers.get('content-security-policy-report-only'), null, 'enforced, not report-only');
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(await (await app.request('https://dashboard.zero-x.live/admin/keys/keys.js', {}, { ...env, ASSETS: assets })).text(),
    '/neuroncli/admin/keys/keys.js');
  assert.equal((await app.request('https://zero-x.live/admin/keys', {}, { ...env, ASSETS: assets })).status, 404, 'not on the main site');
  assert.equal((await app.request('https://dashboard.zero-x.live/neuroncli/admin/keys/index.html', {}, { ...env, ASSETS: assets })).status, 404,
    'the source folder is not served directly');

  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256' }, true, ['sign', 'verify']);
  const team = 'zerox-test.cloudflareaccess.com';
  const aud = 'a'.repeat(64);
  access = { team, jwks: { keys: [{ ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'kid-1' }] } };
  const sign = async (claims, kid = 'kid-1', key = pair.privateKey) => {
    const head = b64url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }));
    const body = b64url(JSON.stringify(claims));
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${head}.${body}`));
    return `${head}.${body}.${Buffer.from(signature).toString('base64url')}`;
  };
  const now = Math.floor(Date.now() / 1000);
  const claims = { aud: [aud], iss: `https://${team}`, email: 'rahul@zero-x.live', sub: 'u1', iat: now, exp: now + 600 };
  const guarded = { ...env, ASSETS: assets, CF_ACCESS_TEAM_DOMAIN: team, CF_ACCESS_AUD: aud };
  resetAccessCache();
  const good = await sign(claims);
  assert.deepEqual(await verifyAccessJwt(guarded, good), { email: 'rahul@zero-x.live', sub: 'u1' });
  assert.equal(await verifyAccessJwt(guarded, await sign({ ...claims, aud: ['b'.repeat(64)] })), null, 'other application');
  assert.equal(await verifyAccessJwt(guarded, await sign({ ...claims, exp: now - 120 })), null, 'expired');
  assert.equal(await verifyAccessJwt(guarded, await sign({ ...claims, iss: 'https://evil.cloudflareaccess.com' })), null, 'other team');
  assert.equal(await verifyAccessJwt(guarded, good.slice(0, -4) + 'AAAA'), null, 'bad signature');
  const stranger = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256' }, true, ['sign', 'verify']);
  assert.equal(await verifyAccessJwt(guarded, await sign(claims, 'kid-1', stranger.privateKey)), null, 'signed by another key');
  assert.equal((await app.request('https://dashboard.zero-x.live/admin/keys', {}, guarded)).status, 403, 'page: no Access JWT');
  assert.equal((await app.request('https://dashboard.zero-x.live/admin/keys', { headers: { 'Cf-Access-Jwt-Assertion': good } }, guarded)).status, 200);
  const apiNoJwt = await admin('/admin/providers/keys', { target: guarded });
  assert.equal(apiNoJwt.status, 403, 'API: the admin token alone is not enough once Access is configured');
  assert.equal((await apiNoJwt.json()).error.code, 'access_required');
  const apiWithJwt = await admin('/admin/providers/keys', { target: guarded, headers: { 'Cf-Access-Jwt-Assertion': good } });
  assert.equal(apiWithJwt.status, 200);
  assert.equal((await apiWithJwt.json()).access_configured, true);
  ok('admin page: dashboard host only, enforced CSP without inline script, Access JWT (signature, audience, issuer, expiry) required when configured');

  console.log('PASS: provider key vault: sealed keys, service_role RPCs, validated adds, per-key pools and health, Access-gated admin page');
} finally {
  globalThis.fetch = realFetch;
  await closeAllPglite();
}

import assert from 'node:assert/strict';
import { loadPlanLimits, DEVELOPMENT_PLANS } from './src/plan-policy.js';
import { persistentSessionStore } from './src/session-store.js';
import app from './src/index.js';

const originalFetch = globalThis.fetch;
try {
  await assert.rejects(loadPlanLimits({}), /unavailable/);
  assert.equal(await loadPlanLimits({ ALLOW_ANONYMOUS_SESSIONS: 'true' }), DEVELOPMENT_PLANS);
  const env = { SUPABASE_URL: 'https://server.test', SUPABASE_SECRET_KEY: 'sb_secret_operator' };
  let calls = 0;
  const records = new Map();
  globalThis.fetch = async (url, options) => {
    const args = JSON.parse(options.body);
    assert.equal(options.headers.apikey, env.SUPABASE_SECRET_KEY);
    if (url.endsWith('/zerox_plan_policies')) {
      calls++;
      return Response.json([{ policies: { free: { ...DEVELOPMENT_PLANS.free, daily_tokens: 12345 } } }]);
    }
    assert.match(args.p_key, /^[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(args).includes('ses_private'));
    if (url.endsWith('/zerox_session_put')) records.set(args.p_key, args.p_value);
    else if (url.endsWith('/zerox_session_delete')) records.delete(args.p_key);
    return Response.json(records.has(args.p_key) ? [{ value: records.get(args.p_key) }] : []);
  };
  assert.equal((await loadPlanLimits(env)).free.daily_tokens, 12345);
  await loadPlanLimits(env);
  assert.equal(calls, 1);
  const store = persistentSessionStore(env);
  await store.put('ses_private', '{}', { expirationTtl: 86400 });
  assert.equal(await store.get('ses_private'), '{}');
  await store.delete('ses_private');
  assert.equal(await store.get('ses_private'), null);
  const kv = { get: async () => null };
  assert.equal(persistentSessionStore({ SESSIONS_KV: kv }), kv);
  assert.equal(persistentSessionStore({}), null);
  globalThis.fetch = async () => Response.json([{ policies: {} }]);
  await assert.rejects(loadPlanLimits({ ...env }), /Invalid/);
  const unavailable = await app.request('https://server.test/ready', {}, {});
  assert.equal(unavailable.status, 503);
  assert.ok(!(await unavailable.text()).includes('policy'));
  const secretHealth = await app.request('https://server.test/v1/providers/health', {
    headers: { Authorization: 'Bearer ses_private' },
  }, env);
  assert.equal(secretHealth.status, 401);
  console.log('PASS: authoritative policy cache, fail-closed readiness, hashed persistent sessions and operator isolation');
} finally { globalThis.fetch = originalFetch; }

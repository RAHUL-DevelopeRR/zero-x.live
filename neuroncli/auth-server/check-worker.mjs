import assert from 'node:assert/strict';
import app from './src/index.js';

const env = {
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
  ASSETS: { fetch: request => new Response(new URL(request.url).pathname) },
};
for (const [host, page] of [
  ['www.zero-x.live', '/index.html'], ['zero-x.live', '/index.html'],
  ['neuron.zero-x.live', '/neuron.html'], ['dashboard.zero-x.live', '/dashboard.html'],
]) {
  for (const path of ['/', '/index.html']) {
    assert.equal(await (await app.request(`https://${host}${path}`, {}, env)).text(), page);
  }
}
assert.equal(await (await app.request('https://neuron.zero-x.live/site.min.css', {}, env)).text(), '/site.min.css');
const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async () => Response.json({ external: { email: true, google: false, phone: false, azure: false, github: false } });
  let config = await (await app.request('https://www.zero-x.live/auth/config', {}, env)).json();
  assert.equal(config.configured, true);
  assert.deepEqual(config.providers, ['email']);
  globalThis.fetch = async () => Response.json({ external: { email: true, google: true, phone: true, azure: true, github: true } });
  config = await (await app.request('https://www.zero-x.live/auth/config', {}, env)).json();
  assert.deepEqual(config.providers, ['google', 'email', 'phone', 'azure', 'github']);
  config = await (await app.request('https://www.zero-x.live/auth/config', {}, {
    ...env, SUPABASE_AUTH_PROVIDERS: 'email,github',
  })).json();
  assert.deepEqual(config.providers, ['email', 'github']);
  globalThis.fetch = async () => { throw new Error('Unavailable'); };
  config = await (await app.request('https://www.zero-x.live/auth/config', {}, env)).json();
  assert.equal(config.configured, false);
  assert.deepEqual(config.providers, []);
  const adminKey = `header.${btoa(JSON.stringify({role:'service_role'}))}.signature`;
  config = await (await app.request('https://www.zero-x.live/auth/config', {}, {...env, SUPABASE_PUBLISHABLE_KEY:adminKey})).json();
  assert.equal(config.supabase_key, '');
  assert.equal(config.configured, false);
  assert.equal((await app.request('https://www.zero-x.live/auth/me', {}, env)).status, 401);
  const userId = '12345678-1234-4234-8234-123456789abc';
  const records = new Map();
  const databaseEnv = {
    ...env, SUPABASE_SECRET_KEY: 'sb_secret_server_test',
    SESSIONS_KV: {
      get: async key => records.get(key),
      put: async (key, value) => records.set(key, value),
      delete: async key => records.delete(key),
    },
  };
  let account = { clerk_id: userId, email: 'verified@example.test', name: 'Verified User',
    plan: 'free', daily_requests: 7, daily_tokens_used: 123 };
  globalThis.fetch = async (url, options) => {
    if (url.endsWith('/auth/v1/user')) {
      assert.equal(options.headers.Authorization, 'Bearer verified-token');
      return Response.json({ id: userId, email: account.email, user_metadata: { name: account.name } });
    }
    assert.equal(options.headers.apikey, databaseEnv.SUPABASE_SECRET_KEY);
    assert.equal(options.headers.Authorization, undefined);
    const args = JSON.parse(options.body);
    assert.equal(args.p_user_id, userId);
    if (url.endsWith('/zerox_sync_account')) {
      assert.equal(args.p_plan, 'free');
      assert.equal(args.p_profile.email, 'verified@example.test');
      assert.equal(args.p_profile.name, 'Verified User');
    } else assert.ok(url.endsWith('/zerox_get_account'));
    return Response.json([account]);
  };
  const identityRequest = {
    method: 'POST', headers: { Authorization: 'Bearer verified-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan: 'pro', email: 'spoofed@example.test', name: 'Spoofed User' }),
  };
  const synced = await (await app.request('https://www.zero-x.live/auth/sync', identityRequest, databaseEnv)).json();
  assert.equal(synced.status, 'success');
  assert.equal(synced.plan, 'free');
  const created = await (await app.request('https://www.zero-x.live/auth/cli/session', identityRequest, databaseEnv)).json();
  assert.equal(created.usage.requests, 7);
  assert.equal(created.usage.tokens_used, 123);
  account = { ...account, daily_requests: 8, daily_tokens_used: 144 };
  const usage = await (await app.request('https://www.zero-x.live/auth/usage', {
    headers: { Authorization: `Bearer ${created.session_token}` },
  }, databaseEnv)).json();
  assert.equal(usage.usage.requests, 8);
  assert.equal(usage.usage.tokens_used, 144);
  const health = await (await app.request('https://www.zero-x.live/health', {}, databaseEnv)).json();
  assert.equal(health.database_configured, true);
  assert.ok(!JSON.stringify(health).includes(databaseEnv.SUPABASE_SECRET_KEY));
  globalThis.fetch = async () => new Response('down', { status: 503 });
  // Authenticate successfully, then fail database access: no fabricated account session.
  globalThis.fetch = async url => url.endsWith('/auth/v1/user')
    ? Response.json({ id: userId, email: account.email }) : new Response('down', { status: 503 });
  assert.equal((await app.request('https://www.zero-x.live/auth/cli/session', identityRequest, databaseEnv)).status, 503);
} finally { globalThis.fetch = originalFetch; }
console.log('PASS: routes, auth guards, server-only DB credentials, trusted profile/plan, persisted usage across sessions, and DB outage handling');

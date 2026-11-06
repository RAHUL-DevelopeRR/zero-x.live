import { DEVELOPMENT_PLANS } from './src/plan-policy.js';
import assert from 'node:assert/strict';
import app from './src/index.js';

const env = {
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
  ASSETS: { fetch: request => new Response(new URL(request.url).pathname) },
};
for (const [host, page] of [
  ['www.zero-x.live', '/index.html'], ['zero-x.live', '/index.html'], ['dashboard.zero-x.live', '/dashboard.html'],
]) {
  const root = await app.request(`https://${host}/`, {}, env);
  if (host === 'www.zero-x.live') {
    assert.equal(root.status, 301);
    assert.equal(root.headers.get('location'), 'https://zero-x.live/');
  } else assert.equal(await root.text(), page);
  const alias = await app.request(`https://${host}/index.html?utm_source=test`, {}, env);
  assert.equal(alias.status, 301);
  assert.equal(alias.headers.get('location'), `https://${host === 'www.zero-x.live' ? 'zero-x.live' : host}/?utm_source=test`);
}
// Hosts: neuron.zero-x.live is Neuron's (its home is the Neuron CLI page, /device is the sign-in
// page) and NeuCockpit lives at https://zero-x.live/neucockpit. /download and /docs/trust are site
// pages (the apps link to them, A6 and A8), so only their aliases redirect.
for (const [url, target] of [
  ['https://neuron.zero-x.live/', 'https://zero-x.live/neuron-cli'],
  ['https://neuron.zero-x.live/?utm_source=test', 'https://zero-x.live/neuron-cli?utm_source=test'],
  ['https://neuron.zero-x.live/index.html?utm_source=test', 'https://zero-x.live/neuron-cli?utm_source=test'],
  ['https://neuron.zero-x.live/index2.html', 'https://zero-x.live/neuron-cli'],
  ['https://zero-x.live/neuron', 'https://zero-x.live/neuron-cli'],
  ['https://zero-x.live/neuron/', 'https://zero-x.live/neuron-cli'],
  ['https://zero-x.live/neuron.html', 'https://zero-x.live/neuron-cli'],
  ['https://www.zero-x.live/neuron.html', 'https://zero-x.live/neuron-cli'],
  ['https://neuron.zero-x.live/neuron.html', 'https://zero-x.live/neuron-cli'],
  ['https://zero-x.live/neuroncli/', 'https://zero-x.live/neuron-cli'],
  ['https://neuron.zero-x.live/neuron-cli', 'https://zero-x.live/neuron-cli'],
  ['https://zero-x.live/neucockpit.html', 'https://zero-x.live/neucockpit'],
  ['https://zero-x.live/neucockpit/', 'https://zero-x.live/neucockpit'],
  ['https://www.zero-x.live/neucockpit', 'https://zero-x.live/neucockpit'],
  ['https://neuron.zero-x.live/neucockpit', 'https://zero-x.live/neucockpit'],
  ['https://neuron.zero-x.live/neucockpit.html?ref=1', 'https://zero-x.live/neucockpit?ref=1'],
  ['https://dashboard.zero-x.live/neucockpit', 'https://zero-x.live/neucockpit'],
  ['https://zero-x.live/legacy', 'https://zero-x.live/neucockpit'],
  ['https://zero-x.live/legacy.html', 'https://zero-x.live/neucockpit'],
  ['https://neuron.zero-x.live/legacy', 'https://zero-x.live/neucockpit'],
  ['https://zero-x.live/features', 'https://zero-x.live/neucockpit#features'],
  ['https://neuron.zero-x.live/features', 'https://zero-x.live/neucockpit#features'],
  ['https://zero-x.live/start', 'https://zero-x.live/neuron-cli#install'],
  ['https://zero-x.live/start.html', 'https://zero-x.live/neuron-cli#install'],
  ['https://neuron.zero-x.live/start', 'https://zero-x.live/neuron-cli#install'],
  ['https://zero-x.live/download.html', 'https://zero-x.live/download'],
  ['https://zero-x.live/download/', 'https://zero-x.live/download'],
  ['https://neuron.zero-x.live/download', 'https://zero-x.live/download'],
  ['https://zero-x.live/docs/trust.html', 'https://zero-x.live/docs/trust'],
  ['https://zero-x.live/docs/trust/', 'https://zero-x.live/docs/trust'],
  ['https://neuron.zero-x.live/find-files-by-content', 'https://zero-x.live/find-files-by-content'],
  ['https://zero-x.live/about/', 'https://zero-x.live/about'], ['https://zero-x.live/about.html', 'https://zero-x.live/about'],
  ['https://zero-x.live/ai-coding-agent.html', 'https://zero-x.live/ai-coding-agent'], ['https://www.zero-x.live/ai-coding-agent', 'https://zero-x.live/ai-coding-agent'],
  ['https://zero-x.live/free-ai-coding-agent.html', 'https://zero-x.live/free-ai-coding-agent'], ['https://neuron.zero-x.live/free-ai-coding-agent', 'https://zero-x.live/free-ai-coding-agent'],
  ['https://zero-x.live/claude-code-alternative/', 'https://zero-x.live/claude-code-alternative'], ['https://www.zero-x.live/claude-code-alternative', 'https://zero-x.live/claude-code-alternative'],
  ['https://zero-x.live/index2.html', 'https://zero-x.live/'],
]) {
  for (const method of ['GET', 'HEAD']) {
    const response = await app.request(url, { method }, env);
    assert.equal(response.status, 301, `${method} ${url}`);
    assert.equal(response.headers.get('location'), target, `${method} ${url}`);
  }
}
// The Neuron download page and the trust page the apps link to (A6, A8) are served, not redirected.
for (const [path, file] of [['/download', '/download.html'], ['/docs/trust', '/docs/trust.html']]) {
  const response = await app.request('https://zero-x.live' + path, {}, env);
  assert.equal(response.status, 200, path);
  assert.equal(await response.text(), file);
}
// The search landing pages are served on their clean URLs.
for (const [path, file] of [['/free-ai-coding-agent', '/free-ai-coding-agent.html'], ['/claude-code-alternative', '/claude-code-alternative.html']]) {
  const response = await app.request('https://zero-x.live' + path, {}, env);
  assert.equal(response.status, 200, path);
  assert.equal(await response.text(), file);
  assert.equal(response.headers.get('x-robots-tag'), null, path + ' is indexable');
}
// Only the canonical hosts may be indexed: the Worker's workers.dev address (or a staging Worker)
// serves the homepage too, so its pages say noindex. Its static files answer as on every host, and
// the Node server (where a forwarded request carries the proxy origin's host) never adds it.
{
  const stray = 'https://zero-x-callback-api.example.workers.dev';
  assert.equal((await app.request(stray + '/', {}, env)).headers.get('x-robots-tag'), 'noindex, nofollow', 'workers.dev homepage');
  assert.equal((await app.request(stray + '/Assets/zerox-mark.svg', {}, env)).headers.get('x-robots-tag'), null, 'static file');
  for (const url of ['https://zero-x.live/', 'https://zero-x.live/pricing', 'https://zero-x.live./', 'https://neuron.zero-x.live/device', 'http://127.0.0.1:8787/'])
    assert.equal((await app.request(url, {}, env)).headers.get('x-robots-tag'), null, url + ' stays indexable');
  assert.equal((await app.request(stray + '/', {}, { ...env, NEURON_RUNTIME: 'node' })).headers.get('x-robots-tag'), null, 'Node server');
}
const neucockpit = await app.request('https://zero-x.live/neucockpit', {}, env);
assert.equal(neucockpit.status, 200);
assert.equal(await neucockpit.text(), '/neucockpit.html');
for (const path of ['/device', '/device/', '/device?user_code=BDWP-HQPK']) {
  const device = await app.request('https://neuron.zero-x.live' + path, {}, env);
  assert.equal(device.status, 200, path);
  assert.equal(await device.text(), '/neuroncli/device/index.html', path);
  assert.equal(device.headers.get('cache-control'), 'no-store', path);
  assert.ok(device.headers.get('content-security-policy'), path + ': enforced CSP');
}
assert.equal(await (await app.request('https://neuron.zero-x.live/neuroncli/device/device.js', {}, env)).text(), '/neuroncli/device/device.js');
assert.equal(await (await app.request('https://neuron.zero-x.live/zx-tokens.css', {}, env)).text(), '/zx-tokens.css');
assert.equal(await (await app.request('https://neuron.zero-x.live/favicon.ico', {}, env)).text(), '/favicon.ico');
assert.equal(await (await app.request('https://zero-x.live/favicon.ico', {}, env)).text(), '/favicon.ico');
// Operator pages (key vault, model catalog) are served only on the dashboard host, under /admin/.
for (const [path, file] of [['/admin/keys', '/neuroncli/admin/keys/index.html'], ['/admin/models', '/neuroncli/admin/models/index.html'],
  ['/admin/models/models.js', '/neuroncli/admin/models/models.js']]) {
  const page = await app.request('https://dashboard.zero-x.live' + path, {}, env);
  assert.equal(await page.text(), file, path);
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/, path + ': strict admin CSP');
  assert.notEqual((await app.request('https://zero-x.live' + path, {}, env)).status, 200, path + ': not on the main site');
}
assert.equal((await app.request('https://dashboard.zero-x.live/neuroncli/admin/models/index.html', {}, env)).status, 404);
// The local Node server keeps every redirect on the loopback origin.
for (const [path, target] of [
  ['/neuron', '/neuron-cli'], ['/neuron.html', '/neuron-cli'], ['/neucockpit.html', '/neucockpit'],
  ['/legacy', '/neucockpit'], ['/start', '/neuron-cli#install'], ['/features', '/neucockpit#features'],
  ['/download.html', '/download'],
]) {
  const response = await app.request('http://127.0.0.1:8787' + path, {}, env);
  assert.equal(response.status, 301, path);
  assert.equal(response.headers.get('location'), target, path);
}
assert.equal(await (await app.request('http://127.0.0.1:8787/neucockpit', {}, env)).text(), '/neucockpit.html');
assert.equal(await (await app.request('http://127.0.0.1:8787/download', {}, env)).text(), '/download.html');
assert.equal(await (await app.request('http://127.0.0.1:8787/device', {}, env)).text(), '/neuroncli/device/index.html');
const https = await app.request('http://zero-x.live/auth/config?test=1', {}, env);
assert.equal(https.status,308); assert.equal(https.headers.get('location'),'https://zero-x.live/auth/config?test=1');
const models = await app.request('https://www.zero-x.live/v1/models', {}, env);
assert.equal(models.status,200); assert.ok(models.headers.get('x-robots-tag').includes('noindex'));
const dashboard = await app.request('https://dashboard.zero-x.live/', {}, env);
assert.equal(dashboard.headers.get('x-robots-tag'), 'noindex, nofollow');
assert.equal(dashboard.headers.get('x-frame-options'), 'DENY');
const callbackPage = await app.request('https://www.zero-x.live/neuroncli/callback/', {}, env);
assert.equal(await callbackPage.text(), '/neuroncli/callback/index.html');
assert.equal(callbackPage.headers.get('cache-control'), 'no-store');
const loginPage = await app.request('https://zero-x.live/neuroncli/login/?state=fixture', {}, env);
assert.equal(await loginPage.text(), '/neuroncli/login/index.html');
assert.equal(loginPage.headers.get('cache-control'), 'no-store');
assert.equal(loginPage.headers.get('referrer-policy'), 'origin');
for (const route of ['/auth/session', '/auth/azure/exchange']) {
  const blocked = await app.request('https://www.zero-x.live' + route, { method: 'POST' }, env);
  assert.equal(blocked.status, 403);
  const response = await app.request('https://www.zero-x.live' + route, {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({machine_fingerprint: 'test', plan: 'pro', user_id: 'spoofed', email: 'spoofed@test.invalid'}),
  }, { ...env, ALLOW_ANONYMOUS_SESSIONS: 'true' });
  const session = await response.json();
  assert.equal(session.plan, 'free');
  assert.equal(session.user_id, null);
  assert.equal(session.email, '');
  assert.equal(response.headers.get('cache-control'), 'no-store');
}
assert.equal(await (await app.request('https://neuron.zero-x.live/site.min.css', {}, env)).text(), '/site.min.css');
const originalFetch = globalThis.fetch;
try {
  // Provider settings are cached per environment for 60 s, so each scenario uses a fresh env.
  let settingsCalls = 0;
  globalThis.fetch = async () => { settingsCalls++; return Response.json({ external: { email: true, google: false, phone: false, azure: false, github: false } }); };
  const cachedEnv = { ...env };
  let config = await (await app.request('https://www.zero-x.live/auth/config', {}, cachedEnv)).json();
  assert.equal(config.configured, true);
  assert.deepEqual(config.providers, ['email']);
  await app.request('https://www.zero-x.live/auth/config', {}, cachedEnv);
  assert.equal(settingsCalls, 1, 'Supabase settings must be cached between requests');
  globalThis.fetch = async () => Response.json({ external: { email: true, google: true, phone: true, azure: true, github: true } });
  config = await (await app.request('https://www.zero-x.live/auth/config', {}, { ...env })).json();
  assert.deepEqual(config.providers, ['google', 'email', 'phone', 'azure', 'github']);
  config = await (await app.request('https://www.zero-x.live/auth/config', {}, {
    ...env, SUPABASE_AUTH_PROVIDERS: 'email,github',
  })).json();
  assert.deepEqual(config.providers, ['email', 'github']);
  globalThis.fetch = async () => { throw new Error('Unavailable'); };
  config = await (await app.request('https://www.zero-x.live/auth/config', {}, { ...env })).json();
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
    if (url.endsWith('/zerox_plan_policies')) return Response.json([{ policies: DEVELOPMENT_PLANS }]);
    const args = JSON.parse(options.body);
    // Session activity (last used, sliding expiry) runs after the response and is keyed by hash.
    if (url.endsWith('/zerox_session_touch')) return Response.json([{ present: true, expires_at: null }]);
    assert.equal(args.p_user_id, userId);
    if (url.endsWith('/zerox_session_register') || url.endsWith('/zerox_session_index_add')) {
      assert.match(args.p_token_hash, /^[0-9a-f]{64}$/);
      return Response.json([{ token_hash: args.p_token_hash }]);
    }
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
  assert.equal(usage.quota.window, null, 'no window in the policy: no window block');
  assert.equal(usage.quota.remaining, DEVELOPMENT_PLANS.free.daily_tokens - 144);
  // A plan with a rolling window (migration 20261102000000): the old fields keep the UTC-day
  // figures, quota.remaining is what the window still allows, quota.window carries the window.
  const windowPolicies = { ...DEVELOPMENT_PLANS,
    free: { ...DEVELOPMENT_PLANS.free, daily_tokens: 5000000, window_tokens: 1000000, window_seconds: 18000 } };
  const windowFetch = globalThis.fetch;
  let windowOverview = { tokens: 990000, limit_tokens: 1000000, window_seconds: 18000, remaining_tokens: 10000,
    resets_at: '2026-11-02T17:05:00Z' };
  globalThis.fetch = async (url, options) => {
    if (url.endsWith('/zerox_plan_policies')) return Response.json([{ policies: windowPolicies }]);
    if (url.endsWith('/zerox_account_overview')) {
      assert.equal(JSON.parse(options.body).p_user_id, userId);
      if (!windowOverview) return new Response('down', { status: 503 });
      return Response.json([{ account: {}, policy: {}, credits: {}, subscription: null, usage_today: {}, usage_window: windowOverview }]);
    }
    return windowFetch(url, options);
  };
  const windowed = await (await app.request('https://www.zero-x.live/auth/usage', {
    headers: { Authorization: `Bearer ${created.session_token}` },
  }, { ...databaseEnv })).json();
  assert.equal(windowed.quota.daily_limit, 5000000, 'released clients still read the UTC-day limit');
  assert.equal(windowed.quota.used, 144);
  assert.equal(windowed.quota.remaining, 10000, 'remaining is what the window still allows, not 5M - used');
  assert.deepEqual(windowed.quota.window, { limit_tokens: 1000000, window_seconds: 18000, tokens: 990000,
    remaining_tokens: 10000, resets_at: '2026-11-02T17:05:00.000Z' });
  assert.deepEqual([windowed.limits.tokens, windowed.limits.window_tokens, windowed.limits.window_seconds], [5000000, 1000000, 18000]);
  windowOverview = null;
  const unread = await (await app.request('https://www.zero-x.live/auth/usage', {
    headers: { Authorization: `Bearer ${created.session_token}` },
  }, { ...databaseEnv })).json();
  assert.equal(unread.quota.remaining, 1000000 - 144, 'without the live count: at most one window a day');
  assert.equal(unread.quota.window.tokens, null);
  assert.equal(unread.quota.window.resets_at, null);
  globalThis.fetch = windowFetch;
  const publicHealth = await (await app.request('https://www.zero-x.live/health', {}, databaseEnv)).json();
  assert.deepEqual(Object.keys(publicHealth).sort(), ['commit', 'runtime', 'service', 'status', 'version'], 'Anonymous health exposes no configuration');
  assert.equal(publicHealth.runtime, 'worker', 'which runtime answered, nothing else');
  const operatorToken = 'operator-token-'.padEnd(40, 'x');
  const health = await (await app.request('https://www.zero-x.live/health', {
    headers: { Authorization: `Bearer ${operatorToken}` },
  }, { ...databaseEnv, GATEWAY_ADMIN_TOKEN: operatorToken })).json();
  assert.equal(health.database_configured, true);
  assert.ok(!JSON.stringify(health).includes(databaseEnv.SUPABASE_SECRET_KEY));
  globalThis.fetch = async () => new Response('down', { status: 503 });
  // Authenticate successfully, then fail database access: no fabricated account session.
  globalThis.fetch = async url => url.endsWith('/auth/v1/user')
    ? Response.json({ id: userId, email: account.email }) : new Response('down', { status: 503 });
  assert.equal((await app.request('https://www.zero-x.live/auth/cli/session', identityRequest, databaseEnv)).status, 503);
} finally { globalThis.fetch = originalFetch; }
console.log('PASS: routes, auth guards, server-only DB credentials, trusted profile/plan, persisted usage across sessions, and DB outage handling');

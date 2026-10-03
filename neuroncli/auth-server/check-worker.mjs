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
} finally { globalThis.fetch = originalFetch; }
console.log('PASS: host routes, provider availability, outages, public-key boundary, and authentication guard');

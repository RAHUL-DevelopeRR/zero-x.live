// Changelog (A13): GET /api/changelog.json from the Neuron GitHub releases, with a shared cache,
// stale fallback, filters and headers; the /changelog page route. Run: node check-changelog.mjs
import assert from 'node:assert/strict';
import app from './src/index.js';
import { CHANGELOG_REPOSITORY, changelogEntries, releaseTag, resetChangelogCache } from './src/routes/changelog.js';

const release = (tag, overrides = {}) => ({
  tag_name: tag, name: `Neuron ${tag}`, draft: false, prerelease: false, published_at: '2026-11-02T09:30:00Z',
  html_url: `https://github.com/${CHANGELOG_REPOSITORY}/releases/tag/${tag}`, body: '## Added\n- Trust screen', ...overrides,
});

// ── Tags and entries ──
assert.deepEqual(releaseTag('v6.3.0'), { product: 'cli', version: '6.3.0' });
assert.deepEqual(releaseTag('desktop-v0.2.0'), { product: 'desktop', version: '0.2.0' });
assert.deepEqual(releaseTag('mobile-v0.1.0-beta.1'), { product: 'mobile', version: '0.1.0-beta.1' });
for (const tag of ['v1.0.0-build-202610051619!', 'neucockpit-v1.0.0', '6.3.0', 'vnext', '', null]) assert.equal(releaseTag(tag), null, String(tag));
const entries = changelogEntries([
  release('v6.2.0', { published_at: '2026-10-01T00:00:00Z' }),
  release('v6.3.0', { body: 'Line one\r\nLine two\u0007', name: '' }),
  release('desktop-v0.2.0', { prerelease: true, published_at: '2026-11-03T00:00:00Z' }),
  release('v9.9.9', { draft: true }),
  release('v7.0.0', { html_url: 'https://evil.example/release' }),
  release('v7.0.1', { published_at: 'soon' }),
  release('v7.0.2', { body: 'x'.repeat(30000) }),
  null,
]);
assert.deepEqual(entries.map(entry => entry.tag), ['desktop-v0.2.0', 'v6.3.0', 'v7.0.2', 'v6.2.0'], 'newest first; drafts, foreign links and bad dates dropped');
assert.equal(entries[1].title, 'Neuron 6.3.0', 'an untitled release gets a title');
assert.equal(entries[1].notes, 'Line one\nLine two', 'notes are plain text with control characters removed');
assert.equal(entries[2].notes.length, 20000, 'notes are capped');
assert.equal(entries[0].prerelease, true);
assert.equal(changelogEntries({ message: 'Not Found' }).length, 0);

// ── Route ──
let github = { calls: 0, respond: () => Response.json([release('v6.3.0'), release('desktop-v0.2.0', { published_at: '2026-11-03T00:00:00Z' })]) };
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input?.url ?? input);
  assert.equal(url, `https://api.github.com/repos/${CHANGELOG_REPOSITORY}/releases?per_page=50`);
  assert.equal(init.headers['User-Agent'], 'zero-x-gateway');
  github.calls++;
  github.lastHeaders = init.headers;
  return github.respond();
};
const kv = (() => { const records = new Map(); return { records, get: async key => records.get(key) ?? null, put: async (key, value) => { records.set(key, value); }, delete: async key => { records.delete(key); } }; })();
const env = { SESSIONS_KV: kv };
const get = async (path, bindings = env) => {
  const response = await app.request('https://zero-x.live' + path, {}, bindings);
  return { status: response.status, headers: response.headers, body: await response.json() };
};
const warnings = [];
const realWarn = console.warn;
console.warn = (...args) => warnings.push(args);
try {
  let result = await get('/api/changelog.json');
  assert.equal(result.status, 200);
  assert.equal(result.body.object, 'list');
  assert.equal(result.body.repository, CHANGELOG_REPOSITORY);
  assert.equal(result.body.stale, false);
  assert.deepEqual(result.body.data.map(entry => [entry.product, entry.version]), [['desktop', '0.2.0'], ['cli', '6.3.0']]);
  assert.deepEqual(Object.keys(result.body.data[0]).sort(), ['notes', 'prerelease', 'product', 'published_at', 'tag', 'title', 'url', 'version']);
  assert.equal(result.headers.get('cache-control'), 'public, max-age=300', 'public and cacheable, unlike the rest of /api/');
  assert.equal(github.lastHeaders.Authorization, undefined, 'no token unless one is configured');
  assert.equal((await get('/api/changelog.json?product=cli')).body.data.length, 1);
  assert.equal((await get('/api/changelog.json?limit=1')).body.data.length, 1);
  assert.equal(github.calls, 1, 'GitHub is asked once per 15 minutes');
  for (const query of ['product=neucockpit', 'limit=0', 'limit=51', 'limit=two']) {
    result = await get('/api/changelog.json?' + query);
    assert.equal(result.status, 400, query);
    assert.equal(result.body.error.code, 'invalid_request');
  }

  // Another isolate (empty memory) reads the shared copy instead of asking GitHub.
  resetChangelogCache();
  assert.equal((await get('/api/changelog.json')).body.data.length, 2);
  assert.equal(github.calls, 1, 'the shared copy is used');

  // GitHub down: the last copy is served as stale; with no copy at all, 503 with Retry-After.
  resetChangelogCache();
  kv.records.clear();
  github.respond = () => new Response('rate limited', { status: 403 });
  result = await get('/api/changelog.json');
  assert.equal(result.status, 503);
  assert.equal(result.body.error.code, 'service_unavailable');
  assert.equal(result.headers.get('retry-after'), '60');
  assert.ok(warnings.some(([message]) => message === 'Changelog refresh failed'));
  assert.equal((await get('/api/changelog.json')).status, 503);
  assert.equal(github.calls, 2, 'a failure is not retried for a minute');

  resetChangelogCache();
  github.respond = () => Response.json([release('v6.3.0')]);
  await get('/api/changelog.json', { ...env, GITHUB_RELEASES_TOKEN: 'ghp_test_token_value' });
  assert.equal(github.lastHeaders.Authorization, 'Bearer ghp_test_token_value', 'an optional token raises the rate limit');
  const fresh = JSON.parse([...kv.records.values()][0]);
  fresh.fetched -= 20 * 60_000; // older than 15 minutes, younger than a day
  kv.records.set([...kv.records.keys()][0], JSON.stringify(fresh));
  resetChangelogCache();
  github.respond = () => { throw new TypeError('fetch failed'); };
  result = await get('/api/changelog.json');
  assert.equal(result.status, 200);
  assert.equal(result.body.stale, true, 'stale when GitHub cannot be reached');
  assert.equal(result.headers.get('cache-control'), 'public, max-age=60');
  assert.equal(result.body.data[0].version, '6.3.0');

  // Without any store (API-only Node server, no database), the isolate copy still works.
  resetChangelogCache();
  github.respond = () => Response.json([release('v6.4.0')]);
  assert.equal((await get('/api/changelog.json', {})).body.data[0].version, '6.4.0');
} finally {
  console.warn = realWarn;
  globalThis.fetch = realFetch;
}

// ── The page ──
const assets = { fetch: async request => new Response(new URL(request.url).pathname) };
for (const [path, status, location, body] of [
  ['/changelog', 200, null, '/changelog.html'], ['/changelog.html', 301, 'https://zero-x.live/changelog', null],
  ['/changelog/', 301, 'https://zero-x.live/changelog', null],
]) {
  const response = await app.request('https://zero-x.live' + path, {}, { ASSETS: assets });
  assert.equal(response.status, status, path);
  if (location) assert.equal(response.headers.get('location'), location);
  if (body) assert.equal(await response.text(), body);
}

console.log('PASS: changelog from GitHub releases: tag parsing (cli, desktop, mobile), drafts and foreign links dropped, notes sanitised and capped, 15-minute shared cache, stale fallback, 503 with Retry-After, filters, public cache headers, /changelog page route');

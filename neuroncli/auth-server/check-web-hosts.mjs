// Test hosts and host-dependent answers, offline through the Worker entry (src/index.js):
// - A host in EXTRA_WEB_HOSTS (EC2 only, e.g. aws.zero-x.live, C10) serves the whole site on its
//   own origin, like the local Node server: site pages and clean URLs, /dashboard, /device and the
//   operator pages (behind Cloudflare Access as on the dashboard host), with relative redirects,
//   but never the dev identity. Unset, it is a foreign host as before, and the production hosts
//   answer the same with or without it.
// - Every forward from the Worker fetches EC2_PROXY_ORIGIN + path (src/ec2-proxy.js), so in
//   Cloudflare's cache all hosts and schemes share one key per path. A static file therefore
//   answers the same on every host, and what depends on the host or scheme (robots.txt,
//   redirects) is never stored by a shared cache.
//   node check-web-hosts.mjs
import assert from 'node:assert/strict';
import app from './src/index.js';

const passed = [];
const ok = name => { passed.push(name); console.log(`ok - ${name}`); };

// Static files the way the Node server on EC2 serves them (C4): typed, with a public Cache-Control.
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.mp4': 'video/mp4',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml',
};
const ASSETS = {
  fetch: request => {
    const { pathname } = new URL(request.url);
    const type = TYPES[pathname.match(/\.[a-z0-9]+$/)?.[0]] || 'application/octet-stream';
    return new Response(pathname, { headers: { 'Content-Type': type, 'Cache-Control': 'public, max-age=3600' } });
  },
};
const base = { SUPABASE_URL: 'https://test.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', ASSETS };
const TEST_HOST = 'https://aws.zero-x.live';
const ec2 = { ...base, NEURON_RUNTIME: 'node', EXTRA_WEB_HOSTS: 'aws.zero-x.live' };
// Request ids are random per answer.
const sameId = text => text.replace(/req_[0-9a-f]{32}/g, 'req_*');
const dump = async response => ({
  status: response.status, headers: [...response.headers].map(([name, value]) => [name, sameId(value)]).sort(),
  body: sameId(await response.text()),
});
const notStored = value => /(^|[\s,])(private|no-store)([\s,]|$)/.test(value || '');

// /auth/config reads the Supabase provider settings.
const realFetch = globalThis.fetch;
globalThis.fetch = async () => Response.json({ external: { email: true } });

try {
  // ── The test host is a whole site on one origin ──
  {
    for (const [path, file] of [
      ['/', '/index.html'], ['/pricing', '/pricing.html'], ['/about', '/about.html'], ['/neucockpit', '/neucockpit.html'],
      ['/docs/trust', '/docs/trust.html'], ['/download', '/download.html'], ['/dashboard', '/dashboard.html'],
      ['/device', '/neuroncli/device/index.html'], ['/device/?user_code=BDWP-HQPK', '/neuroncli/device/index.html'],
      ['/neuroncli/device/', '/neuroncli/device/index.html'], ['/neuroncli/login/?state=fixture', '/neuroncli/login/index.html'],
      ['/admin/keys', '/neuroncli/admin/keys/index.html'], ['/admin/models/', '/neuroncli/admin/models/index.html'],
      ['/admin/models/models.js', '/neuroncli/admin/models/models.js'],
      ['/Assets/neucockpit-semantic-search-480.webp', '/Assets/neucockpit-semantic-search-480.webp'], ['/pricing.js', '/pricing.js'],
    ]) {
      const response = await app.request(TEST_HOST + path, {}, ec2);
      assert.equal(response.status, 200, path);
      assert.equal(await response.text(), file, path);
      assert.equal((await app.request(TEST_HOST + path, { method: 'HEAD' }, ec2)).status, 200, `HEAD ${path}`);
    }
    // Redirects stay on the test host (relative targets), like the local Node server's.
    for (const [path, target] of [
      ['/pricing.html', '/pricing'], ['/pricing/', '/pricing'], ['/about.html?ref=1', '/about?ref=1'],
      ['/dashboard.html', '/dashboard'], ['/dashboard/', '/dashboard'], ['/index.html?utm_source=test', '/?utm_source=test'],
      ['/neuron', '/neuron-cli'], ['/start', '/neuron-cli#install'], ['/features', '/neucockpit#features'], ['/legacy', '/neucockpit'],
    ]) {
      const response = await app.request(TEST_HOST + path, {}, ec2);
      assert.equal(response.status, 301, path);
      assert.equal(response.headers.get('location'), target, path);
    }
    // The sign-in and operator pages keep their headers there.
    const device = await app.request(TEST_HOST + '/device', {}, ec2);
    assert.equal(device.headers.get('cache-control'), 'no-store');
    assert.ok(device.headers.get('content-security-policy'), '/device: enforced CSP');
    const admin = await app.request(TEST_HOST + '/admin/keys', {}, ec2);
    assert.match(admin.headers.get('content-security-policy'), /default-src 'none'/, '/admin/keys: strict admin CSP');
    assert.equal(admin.headers.get('cache-control'), 'no-store');
    // Behind Cloudflare Access as on the dashboard host: without its JWT the page is refused.
    const access = { CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', CF_ACCESS_AUD: 'a'.repeat(32) };
    for (const url of [TEST_HOST + '/admin/keys', 'https://dashboard.zero-x.live/admin/keys']) {
      const refused = await app.request(url, {}, { ...ec2, ...access });
      assert.equal(refused.status, 403, url);
      assert.equal(await refused.text(), 'Cloudflare Access authentication required.', url);
    }
    // The admin pages' own files stay hidden there too.
    assert.equal((await app.request(TEST_HOST + '/neuroncli/admin/keys/index.html', {}, ec2)).status, 404);
    // Like loopback for routing, but never the dev identity: that stays loopback-only (auth-context.js).
    const devEnv = { ...ec2, DEV_AUTH_ENABLED: 'true' };
    assert.equal((await (await app.request('http://127.0.0.1:8787/auth/config', {}, devEnv)).json()).dev, true, 'the probe sees the dev identity on loopback');
    const config = await (await app.request(TEST_HOST + '/auth/config', {}, devEnv)).json();
    assert.notEqual(config.dev, true, 'no dev identity on the test host');
    assert.notEqual(config.provider, 'dev');
    ok('EXTRA_WEB_HOSTS: the test host serves site pages, clean URLs, /dashboard, /device and the operator pages (behind Access) on its own origin, with relative redirects and no dev identity');
  }

  // ── Unset: the test host is a foreign host as before, and the production hosts do not change ──
  {
    for (const env of [base, { ...base, NEURON_RUNTIME: 'node' }, { ...ec2, EXTRA_WEB_HOSTS: '' }, { ...ec2, EXTRA_WEB_HOSTS: 'staging.example.test' }]) {
      const label = JSON.stringify(env.EXTRA_WEB_HOSTS ?? null);
      for (const [path, target] of [
        ['/pricing', 'https://zero-x.live/pricing'], ['/about', 'https://zero-x.live/about'],
        ['/dashboard', 'https://dashboard.zero-x.live/'], ['/dashboard.html', 'https://dashboard.zero-x.live/'],
        ['/pricing.html', 'https://zero-x.live/pricing'], ['/neuron', 'https://zero-x.live/neuron-cli'],
      ]) {
        const response = await app.request(TEST_HOST + path, {}, env);
        assert.equal(response.status, 301, `${path} with ${label}`);
        assert.equal(response.headers.get('location'), target, `${path} with ${label}`);
      }
      const admin = await app.request(TEST_HOST + '/admin/keys', {}, env);
      assert.equal(admin.status, 404, `/admin/keys with ${label}`);
      assert.notEqual(await (await app.request(TEST_HOST + '/device', {}, env)).text(), '/neuroncli/device/index.html', `/device with ${label}`);
    }
    const urls = [
      'https://zero-x.live/', 'https://zero-x.live/pricing', 'https://zero-x.live/pricing.html', 'https://zero-x.live/dashboard',
      'https://zero-x.live/admin/keys', 'https://zero-x.live/robots.txt', 'http://zero-x.live/about', 'https://www.zero-x.live/about',
      'https://dashboard.zero-x.live/', 'https://dashboard.zero-x.live/pricing', 'https://dashboard.zero-x.live/admin/keys',
      'https://dashboard.zero-x.live/robots.txt', 'https://neuron.zero-x.live/', 'https://neuron.zero-x.live/device',
      'https://zero-x.live/Assets/neucockpit-semantic-search-480.webp',
    ];
    // A production host listed by mistake keeps its own routing: it is never a test host.
    const listed = { ...ec2, EXTRA_WEB_HOSTS: 'aws.zero-x.live,zero-x.live,www.zero-x.live,dashboard.zero-x.live,neuron.zero-x.live,relay.zero-x.live' };
    for (const url of urls) {
      const reference = await dump(await app.request(url, {}, { ...base, NEURON_RUNTIME: 'node' }));
      assert.deepEqual(await dump(await app.request(url, {}, ec2)), reference, url);
      assert.deepEqual(await dump(await app.request(url, {}, listed)), reference, `${url} with the production hosts listed`);
    }
    ok('EXTRA_WEB_HOSTS unset, empty or another host: the test host redirects to the production hosts as before, and the production hosts answer the same either way, even when listed in it');
  }

  // ── One cache key per path: static files answer the same on every host ──
  {
    const hosts = ['zero-x.live', 'www.zero-x.live', 'dashboard.zero-x.live', 'neuron.zero-x.live', 'aws.zero-x.live'];
    for (const path of ['/Assets/neucockpit-semantic-search-480.webp', '/site.min.css', '/home.js', '/favicon.ico',
      '/videos/neucockpit-wheres-that-file.mp4', '/sitemap.xml', '/llms.txt', '/neuroncli/device/device.js']) {
      const reference = await dump(await app.request('https://zero-x.live' + path, {}, ec2));
      assert.equal(reference.status, 200, path);
      for (const host of hosts) {
        // www sends the sitemap and llms.txt to the apex: a redirect, checked with the others below.
        if (host === 'www.zero-x.live' && ['/sitemap.xml', '/llms.txt'].includes(path)) continue;
        assert.deepEqual(await dump(await app.request(`https://${host}${path}`, {}, ec2)), reference, host + path);
      }
    }
    // The noindex of the dashboard host (and the test host) stays on its pages and APIs.
    for (const url of ['https://dashboard.zero-x.live/', 'https://dashboard.zero-x.live/health', TEST_HOST + '/', TEST_HOST + '/pricing']) {
      assert.equal((await app.request(url, {}, ec2)).headers.get('x-robots-tag'), 'noindex, nofollow', url);
    }
    assert.equal((await app.request('https://zero-x.live/pricing', {}, ec2)).headers.get('x-robots-tag'), null);
    ok('static files (images, CSS, JS, video, sitemap, llms.txt) answer the same on every host: no host-dependent X-Robots-Tag; pages and APIs of the dashboard and test hosts keep noindex');
  }

  // ── What depends on the host or scheme is never stored by a shared cache ──
  {
    // robots.txt differs per host (the dashboard and the test host disallow everything).
    // (www sends it to the apex: a redirect, below.)
    for (const [host, body] of [['zero-x.live', '/robots.txt'], ['neuron.zero-x.live', '/robots.txt'],
      ['dashboard.zero-x.live', 'User-agent: *\nDisallow: /\n'], ['aws.zero-x.live', 'User-agent: *\nDisallow: /\n']]) {
      const response = await app.request(`https://${host}/robots.txt`, {}, ec2);
      assert.equal(response.status, 200, host);
      assert.equal(await response.text(), body, host);
      assert.equal(response.headers.get('cache-control'), 'private', host + ': robots.txt is never stored by a shared cache');
    }
    // Every redirect depends on the host or the scheme of the request.
    for (const [url, status] of [
      ['http://zero-x.live/Assets/neucockpit-semantic-search-480.webp', 308], ['http://dashboard.zero-x.live/robots.txt', 308],
      ['http://zero-x.live/auth/config', 308], ['https://www.zero-x.live/about', 301], ['https://www.zero-x.live/sitemap.xml', 301],
      ['https://www.zero-x.live/llms.txt', 301], ['https://www.zero-x.live/robots.txt', 301], ['https://dashboard.zero-x.live/pricing', 301],
      ['https://zero-x.live/pricing.html', 301], ['https://zero-x.live/dashboard', 301], ['https://neuron.zero-x.live/', 301],
      ['https://zero-x.live/index.html', 301], [TEST_HOST + '/pricing.html', 301],
    ]) {
      const response = await app.request(url, {}, ec2);
      assert.equal(response.status, status, url);
      assert.ok(notStored(response.headers.get('cache-control')), `${url}: ${response.headers.get('cache-control')}`);
    }
    ok('host- and scheme-dependent answers (robots.txt on every host, every redirect) carry Cache-Control private or no-store');
  }
} finally {
  globalThis.fetch = realFetch;
}

console.log(`PASS: web hosts (${passed.length} groups): the EXTRA_WEB_HOSTS test host as a whole site on its own origin, unset = unchanged, static files the same on every host, host-dependent answers never stored by a shared cache`);

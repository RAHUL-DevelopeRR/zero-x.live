// Release manifests (A7, docs/RELEASE_MANIFESTS.md): the validator, the committed placeholders
// and GET /releases/{cli,desktop}/latest.json with and without the RELEASES R2 bucket.
// Run: node check-releases.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import app from './src/index.js';
import { RELEASE_MANIFEST_PATH, unreleasedManifest, validateReleaseManifest } from './src/routes/releases.js';

const root = new URL('../../', import.meta.url);
const committed = product => JSON.parse(readFileSync(new URL(`releases/${product}/latest.json`, root), 'utf8'));
const sha = 'c0ffee'.padEnd(64, '0');
const tag = 'https://github.com/RAHUL-DevelopeRR/neuron-v2/releases/download/v6.3.0/';
const cliRelease = () => ({
  schema_version: 1, product: 'cli', channel: 'stable', version: '6.3.0', released_at: '2026-11-02T09:30:00Z',
  notes_url: 'https://github.com/RAHUL-DevelopeRR/neuron-v2/releases/tag/v6.3.0', minimum_version: null,
  downloads: [
    { platform: 'windows-x64', kind: 'cli', file: 'neuron-windows-x64.exe', url: tag + 'neuron-windows-x64.exe', sha256: sha, size: 31457280 },
    { platform: 'windows-x64', kind: 'tui', file: 'neuron-tui-windows-x64.exe', url: tag + 'neuron-tui-windows-x64.exe', sha256: sha },
    { platform: 'macos-arm64', kind: 'cli', file: 'neuron-macos-arm64', url: tag + 'neuron-macos-arm64', sha256: sha },
  ],
  checksums_url: tag + 'SHA256SUMS',
  install: {
    npm: 'npm install -g @zero-x.live/neuron', pip: 'python -m pip install neuroncli',
    powershell: 'irm https://github.com/RAHUL-DevelopeRR/neuron-v2/releases/latest/download/install.ps1 | iex',
    shell: 'curl -fsSL https://github.com/RAHUL-DevelopeRR/neuron-v2/releases/latest/download/install.sh | sh',
  },
});
const desktopRelease = () => ({
  schema_version: 1, product: 'desktop', channel: 'stable', version: '0.2.0', released_at: '2026-11-02T09:30:00Z',
  notes_url: null, minimum_version: null, checksums_url: null,
  downloads: [{ platform: 'windows-x64', kind: 'installer', file: 'Neuron_0.2.0_x64-setup.exe',
    url: 'https://github.com/RAHUL-DevelopeRR/neuron-v2/releases/download/desktop-v0.2.0/Neuron_0.2.0_x64-setup.exe', sha256: sha }],
});

// ── 1. Validator ──
for (const product of ['cli', 'desktop']) {
  assert.deepEqual(validateReleaseManifest(committed(product), product), [], `committed ${product} manifest is valid`);
  assert.equal(committed(product).version, null, `the committed ${product} manifest says nothing is released yet`);
  assert.deepEqual(validateReleaseManifest(unreleasedManifest(product), product), [], `built-in ${product} manifest is valid`);
}
assert.deepEqual(validateReleaseManifest(cliRelease(), 'cli'), []);
assert.deepEqual(validateReleaseManifest(desktopRelease(), 'desktop'), []);
assert.deepEqual(validateReleaseManifest({ ...cliRelease(), version: '6.3.0-beta.1', channel: 'beta' }, 'cli'), []);
const broken = (product, change) => {
  const manifest = product === 'cli' ? cliRelease() : desktopRelease();
  change(manifest);
  return validateReleaseManifest(manifest, product);
};
for (const [label, product, change, message] of [
  ['wrong product', 'desktop', m => { m.product = 'cli'; }, /product must be "desktop"/],
  ['schema version', 'cli', m => { m.schema_version = 2; }, /schema_version/],
  ['unknown field', 'cli', m => { m.verison = '6.3.1'; }, /unknown field "verison"/],
  ['leading v', 'cli', m => { m.version = 'v6.3.0'; }, /semantic version/],
  ['release time', 'cli', m => { m.released_at = '2 Nov 2026'; }, /released_at/],
  ['unreleased with a time', 'cli', m => { m.version = null; m.downloads = []; }, /released_at/],
  ['unreleased with downloads', 'cli', m => { m.version = null; m.released_at = null; }, /downloads must be empty/],
  ['http link', 'cli', m => { m.downloads[0].url = m.downloads[0].url.replace('https:', 'http:'); }, /downloads\[0\]\.url/],
  ['foreign host', 'cli', m => { m.downloads[0].url = 'https://evil.example/neuron-windows-x64.exe'; }, /downloads\[0\]\.url/],
  ['credentials in URL', 'cli', m => { m.downloads[0].url = 'https://user:pw@github.com/neuron-windows-x64.exe'; }, /downloads\[0\]\.url/],
  ['file mismatch', 'cli', m => { m.downloads[0].file = 'neuron.exe'; }, /must end with the file name/],
  ['path in file', 'cli', m => { m.downloads[0].file = '../neuron.exe'; }, /plain file name/],
  ['uppercase checksum', 'cli', m => { m.downloads[0].sha256 = sha.toUpperCase(); }, /sha256/],
  ['platform', 'cli', m => { m.downloads[0].platform = 'macos-universal'; }, /not a cli platform/],
  ['desktop kind on cli', 'cli', m => { m.downloads[0].kind = 'installer'; }, /kind must be one of cli, tui/],
  ['duplicate entry', 'cli', m => { m.downloads.push({ ...m.downloads[0] }); }, /repeats windows-x64\/cli/],
  ['size', 'cli', m => { m.downloads[0].size = -5; }, /size/],
  ['notes host', 'cli', m => { m.notes_url = 'https://evil.example/notes'; }, /notes_url/],
  ['install method', 'cli', m => { m.install.brew = 'brew install neuron'; }, /install\.brew/],
  ['multi-line install', 'cli', m => { m.install.shell = 'curl x |\nsh'; }, /one-line command/],
  ['install on desktop', 'desktop', m => { m.install = {}; }, /only for the cli manifest/],
  ['channel', 'desktop', m => { m.channel = 'nightly'; }, /channel/],
]) {
  const errors = broken(product, change);
  assert.ok(errors.some(error => message.test(error)), `${label}: ${JSON.stringify(errors)}`);
}
assert.deepEqual(validateReleaseManifest(null, 'cli'), ['the manifest must be a JSON object']);
assert.ok(validateReleaseManifest(cliRelease(), 'mobile').includes('unknown product'));

// ── 2. Route ──
assert.ok(RELEASE_MANIFEST_PATH.test('/releases/cli/latest.json') && !RELEASE_MANIFEST_PATH.test('/releases/cli/old.json'));
const assets = { requested: [], fetch: async request => {
  const path = new URL(request.url).pathname;
  assets.requested.push(path);
  try { return new Response(readFileSync(new URL('.' + path, root)), { headers: { 'Content-Type': 'application/json' } }); }
  catch { return new Response('Not found', { status: 404 }); }
} };
const bucket = objects => ({ gets: [], async get(key) {
  this.gets.push(key);
  if (objects[key] instanceof Error) throw objects[key];
  return key in objects ? { text: async () => objects[key] } : null;
} });
const get = async (path, env, init = {}) => {
  const response = await app.request('https://zero-x.live' + path, init, env);
  return { status: response.status, headers: response.headers, body: response.status === 200 && init.method !== 'HEAD' ? await response.json() : null };
};

let result = await get('/releases/cli/latest.json', { ASSETS: assets });
assert.equal(result.status, 200);
assert.deepEqual(result.body, committed('cli'), 'without the bucket the committed manifest is served');
assert.equal(result.headers.get('x-neuron-manifest-source'), 'assets');
assert.equal(result.headers.get('cache-control'), 'public, max-age=300');
assert.equal(result.headers.get('access-control-allow-origin'), '*');
assert.match(result.headers.get('content-type'), /application\/json/);
assert.equal(result.headers.get('x-content-type-options'), 'nosniff');

const released = bucket({ 'cli/latest.json': JSON.stringify(cliRelease()), 'desktop/latest.json': JSON.stringify(desktopRelease()) });
result = await get('/releases/cli/latest.json', { ASSETS: assets, RELEASES: released });
assert.deepEqual(result.body, cliRelease(), 'an uploaded release wins');
assert.equal(result.headers.get('x-neuron-manifest-source'), 'r2');
assert.deepEqual((await get('/releases/desktop/latest.json', { ASSETS: assets, RELEASES: released })).body, desktopRelease());
assert.deepEqual(released.gets, ['cli/latest.json', 'desktop/latest.json']);

const warnings = [];
const originalWarn = console.warn;
console.warn = (...args) => warnings.push(args);
try {
  for (const [label, objects] of [
    ['invalid upload', { 'cli/latest.json': JSON.stringify({ ...cliRelease(), version: 'latest' }) }],
    ['malformed JSON', { 'cli/latest.json': '{"schema_version": 1,' }],
    ['oversized upload', { 'cli/latest.json': JSON.stringify({ ...cliRelease(), padding: 'x'.repeat(70000) }) }],
    ['missing object', {}],
    ['bucket error', { 'cli/latest.json': new Error('R2 unavailable') }],
  ]) {
    result = await get('/releases/cli/latest.json', { ASSETS: assets, RELEASES: bucket(objects) });
    assert.equal(result.status, 200, label);
    assert.deepEqual(result.body, committed('cli'), `${label}: falls back to the committed manifest`);
    assert.equal(result.headers.get('x-neuron-manifest-source'), 'assets', label);
  }
  assert.ok(warnings.some(([message, detail]) => message === 'Release manifest rejected' && detail.errors.length), 'a rejected upload is logged with its problems');

  const noAssets = { fetch: async () => new Response('Not found', { status: 404 }) };
  result = await get('/releases/desktop/latest.json', { ASSETS: noAssets });
  assert.deepEqual(result.body, unreleasedManifest('desktop'), 'with nothing else, the built-in manifest');
  assert.equal(result.headers.get('x-neuron-manifest-source'), 'built-in');
  assert.deepEqual((await get('/releases/cli/latest.json', {})).body, unreleasedManifest('cli'), 'the Node API-only server answers too');
} finally { console.warn = originalWarn; }

result = await get('/releases/cli/latest.json', { ASSETS: assets }, { method: 'HEAD' });
assert.equal(result.status, 200, 'HEAD is answered');
assert.equal((await get('/releases/mobile/latest.json', { ASSETS: assets })).status, 404, 'unknown products are not served');
assert.equal((await get('/releases/cli/../desktop/latest.json', { ASSETS: assets })).status, 200, 'URL normalisation resolves dot segments');
const www = await app.request('https://www.zero-x.live/releases/cli/latest.json', {}, { ASSETS: assets });
assert.equal(www.status, 301);
assert.equal(www.headers.get('location'), 'https://zero-x.live/releases/cli/latest.json');
// Other files under /releases/ stay plain static assets.
assets.requested.length = 0;
assert.equal((await app.request('https://zero-x.live/releases/desktop/notes.txt', {}, { ASSETS: assets })).status, 404);
assert.deepEqual(assets.requested, ['/releases/desktop/notes.txt']);

console.log('PASS: release manifest validator (22 failure cases), committed and built-in manifests, /releases/{cli,desktop}/latest.json from R2 with fallback to the committed copy, cache and CORS headers');

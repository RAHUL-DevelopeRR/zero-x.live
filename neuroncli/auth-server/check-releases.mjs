// Release manifests (A7, docs/RELEASE_MANIFESTS.md): the validator, the committed placeholders
// and GET /releases/{cli,desktop}/latest.json with and without the RELEASES R2 bucket.
// Run: node check-releases.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import app from './src/index.js';
import { RELEASE_MANIFEST_PATH, unreleasedManifest, validateReleaseManifest } from './src/routes/releases.js';
import { NEURON_VERSION, NEURON_INSTALL } from './src/neuron-release.js';
import { buildCliManifest, parseSha256Sums } from './scripts/build-release-manifest.mjs';

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
  if (product === 'desktop') assert.equal(committed(product).version, null, 'the committed desktop manifest says nothing is released yet');
  assert.deepEqual(validateReleaseManifest(unreleasedManifest(product), product), [], `built-in ${product} manifest is valid`);
}
assert.deepEqual(validateReleaseManifest(cliRelease(), 'cli'), []);

// ── 1b. The generator (scripts/build-release-manifest.mjs) and the committed CLI manifest ──
{
  const platforms = ['linux-x64', 'linux-arm64', 'macos-arm64', 'macos-x64', 'windows-x64'];
  const fileOf = (kind, platform) => `neuron-${kind === 'tui' ? 'tui-' : ''}${platform}${platform.startsWith('windows') ? '.exe' : ''}`;
  const hex = n => n.toString(16).padStart(2, '0').repeat(32);
  const files = platforms.flatMap((platform, i) => ['cli', 'tui'].map((kind, j) => ({ file: fileOf(kind, platform), hash: hex(i * 2 + j + 1), size: 1000 + i * 10 + j })));
  const sums = [...files.map(f => `${f.hash}  ${f.file}`), `${hex(200)}  install.sh`, `${hex(201)}  THIRD_PARTY_NOTICES.md`].join('\n') + '\n';
  const assetList = [...files.map(f => ({ name: f.file, size: f.size, digest: 'sha256:' + f.hash })), { name: 'install.sh', size: 5 }, { name: 'SHA256SUMS', size: 9 }, { name: 'neuron-linux-x64.sha256', size: 83 }];
  const input = { tag: 'v7.0.0-alpha.4', publishedAt: '2026-11-03T18:27:37Z', assets: assetList, sums };
  const built = buildCliManifest(input);
  assert.deepEqual(validateReleaseManifest(built, 'cli'), [], 'a generated manifest passes the Worker validator');
  assert.equal(built.version, '7.0.0-alpha.4');
  assert.equal(built.released_at, '2026-11-03T18:27:37Z');
  assert.equal(built.downloads.length, 10, 'cli and tui for five platforms; scripts, notices and .sha256 files are not downloads');
  assert.deepEqual(built.downloads[0], { platform: 'linux-x64', kind: 'cli', file: 'neuron-linux-x64', url: 'https://github.com/RAHUL-DevelopeRR/neuron-v2/releases/download/v7.0.0-alpha.4/neuron-linux-x64', sha256: hex(1), size: 1000 });
  assert.equal(built.downloads.at(-1).file, 'neuron-tui-windows-x64.exe');
  assert.equal(built.checksums_url, 'https://github.com/RAHUL-DevelopeRR/neuron-v2/releases/download/v7.0.0-alpha.4/SHA256SUMS');
  assert.equal(built.notes_url, 'https://github.com/RAHUL-DevelopeRR/neuron-v2/releases/tag/v7.0.0-alpha.4');
  assert.deepEqual(buildCliManifest({ ...input, assets: [...assetList].reverse(), sums: sums.split('\n').reverse().join('\n') }), built, 'idempotent: the order of the inputs does not matter');
  assert.deepEqual(parseSha256Sums('ABCD'.padEnd(64, '0') + '  a\n\nnot a line\n'), new Map([['a', 'abcd'.padEnd(64, '0')]]));
  assert.throws(() => buildCliManifest({ ...input, sums: sums.replace(files[0].hash + '  ' + files[0].file, '') }), /no checksum/, 'a binary without a checksum fails');
  assert.throws(() => buildCliManifest({ ...input, assets: assetList.map(a => a.name === files[0].file ? { ...a, digest: 'sha256:' + hex(99) } : a) }), /does not match/, 'a GitHub digest that disagrees with SHA256SUMS fails');
  assert.throws(() => buildCliManifest({ ...input, tag: 'latest' }), /tag/);
  assert.throws(() => buildCliManifest({ ...input, assets: assetList.filter(a => a.name !== files[0].file) }), /missing/, 'a checksum for a binary that is not attached fails');

  const live = committed('cli');
  assert.equal(live.version, NEURON_VERSION, 'the committed CLI manifest is the release the site names');
  assert.equal(live.downloads.length, 10);
  assert.deepEqual(live.install, { npm: NEURON_INSTALL.npm, pip: NEURON_INSTALL.pip, powershell: NEURON_INSTALL.powershell, shell: NEURON_INSTALL.shell });
  for (const entry of live.downloads) assert.ok(entry.size > 0 && /^[0-9a-f]{64}$/.test(entry.sha256), entry.file);
}
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
  ['another github.com repository', 'cli', m => { m.downloads[0].url = 'https://github.com/someone-else/neuron-v2/releases/download/v6.3.0/neuron-windows-x64.exe'; }, /downloads\[0\]\.url/],
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

// Update manifests the Neuron clients read (A7, docs/RELEASE_MANIFESTS.md): the CLI update
// notice and the desktop "new version" notice, plus the /download page. The release workflows
// upload them to the RELEASES R2 bucket when it is bound; otherwise, or when the uploaded file
// is missing or invalid, the copy committed at releases/<product>/latest.json is served.
export const RELEASE_PRODUCTS = Object.freeze(['cli', 'desktop']);
export const RELEASE_MANIFEST_PATH = /^\/releases\/(cli|desktop)\/latest\.json$/;
export const MANIFEST_SCHEMA_VERSION = 1;
// Clients cache the manifest; a new release reaches them within this many seconds.
export const MANIFEST_MAX_AGE_SECONDS = 300;
const MANIFEST_BYTES_LIMIT = 65536;

const PLATFORMS = Object.freeze({
  cli: ['linux-x64', 'linux-arm64', 'macos-arm64', 'macos-x64', 'windows-x64', 'windows-arm64'],
  desktop: ['windows-x64', 'windows-arm64', 'macos-universal', 'macos-arm64', 'macos-x64', 'linux-x64', 'linux-arm64'],
});
const KINDS = Object.freeze({ cli: ['cli', 'tui'], desktop: ['installer', 'updater'] });
const DOWNLOAD_HOSTS = ['github.com', 'zero-x.live'];
const SEMVER = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})(?:-[0-9A-Za-z.-]{1,32})?$/;
const SHA256 = /^[0-9a-f]{64}$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const KNOWN_TOP_LEVEL = ['schema_version', 'product', 'channel', 'version', 'released_at', 'notes_url', 'minimum_version',
  'downloads', 'checksums_url', 'install'];
const INSTALL_METHODS = ['npm', 'pip', 'powershell', 'shell'];

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isIsoTime = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) &&
  Number.isFinite(Date.parse(value));

// An https URL on an allowed host (GitHub release assets, or zero-x.live), without credentials.
export function allowedReleaseUrl(value, hosts = DOWNLOAD_HOSTS) {
  if (typeof value !== 'string' || value.length > 512) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && hosts.includes(url.hostname);
  } catch { return false; }
}

// Returns the list of problems with a manifest (empty when it is valid). Unknown top-level keys
// are refused so a typo in a release workflow fails loudly instead of being ignored by clients.
export function validateReleaseManifest(manifest, product) {
  const errors = [];
  const fail = message => errors.push(message);
  if (!isObject(manifest)) return ['the manifest must be a JSON object'];
  for (const key of Object.keys(manifest)) if (!KNOWN_TOP_LEVEL.includes(key)) fail(`unknown field "${key}"`);
  if (manifest.schema_version !== MANIFEST_SCHEMA_VERSION) fail(`schema_version must be ${MANIFEST_SCHEMA_VERSION}`);
  if (!RELEASE_PRODUCTS.includes(product)) fail('unknown product');
  if (manifest.product !== product) fail(`product must be "${product}"`);
  if (!['stable', 'beta'].includes(manifest.channel)) fail('channel must be "stable" or "beta"');
  const released = manifest.version !== null;
  if (released && !SEMVER.test(String(manifest.version))) fail('version must be a semantic version such as 6.3.0, or null');
  if (released ? !isIsoTime(manifest.released_at) : manifest.released_at !== null) {
    fail('released_at must be an ISO UTC time when version is set, and null otherwise');
  }
  for (const field of ['notes_url', 'checksums_url']) {
    if (manifest[field] !== null && !allowedReleaseUrl(manifest[field])) fail(`${field} must be an https URL on github.com or zero-x.live, or null`);
  }
  if (manifest.minimum_version !== null && !SEMVER.test(String(manifest.minimum_version))) fail('minimum_version must be a semantic version or null');
  if (!Array.isArray(manifest.downloads) || manifest.downloads.length > 32) fail('downloads must be an array of at most 32 entries');
  else {
    if (!released && manifest.downloads.length) fail('downloads must be empty while version is null');
    const seen = new Set();
    manifest.downloads.forEach((entry, index) => {
      const where = `downloads[${index}]`;
      if (!isObject(entry)) { fail(`${where} must be an object`); return; }
      if (!PLATFORMS[product]?.includes(entry.platform)) fail(`${where}.platform is not a ${product} platform`);
      if (!KINDS[product]?.includes(entry.kind)) fail(`${where}.kind must be one of ${KINDS[product]?.join(', ')}`);
      if (!FILE_NAME.test(String(entry.file))) fail(`${where}.file must be a plain file name`);
      if (!allowedReleaseUrl(entry.url)) fail(`${where}.url must be an https URL on github.com or zero-x.live`);
      else if (!new URL(entry.url).pathname.endsWith('/' + entry.file)) fail(`${where}.url must end with the file name`);
      if (!SHA256.test(String(entry.sha256))) fail(`${where}.sha256 must be 64 lowercase hex characters`);
      if (entry.size !== undefined && !(Number.isSafeInteger(entry.size) && entry.size > 0)) fail(`${where}.size must be a positive integer`);
      if (entry.signature !== undefined && entry.signature !== null && (typeof entry.signature !== 'string' || entry.signature.length > 4096)) {
        fail(`${where}.signature must be a string of at most 4096 characters, or null`);
      }
      const key = `${entry.platform}/${entry.kind}`;
      if (seen.has(key)) fail(`${where} repeats ${key}`);
      seen.add(key);
    });
  }
  if (product === 'cli') {
    if (!isObject(manifest.install)) fail('install must be an object of install commands');
    else for (const [method, command] of Object.entries(manifest.install)) {
      if (!INSTALL_METHODS.includes(method)) fail(`install.${method} is not a known install method`);
      else if (typeof command !== 'string' || !command.trim() || command.length > 300 || /[\r\n]/.test(command)) {
        fail(`install.${method} must be a one-line command`);
      }
    }
  } else if (manifest.install !== undefined) fail('install is only for the cli manifest');
  return errors;
}

// Built in as the last resort, so the route always answers with a valid manifest.
export function unreleasedManifest(product) {
  return {
    schema_version: MANIFEST_SCHEMA_VERSION, product, channel: 'stable', version: null, released_at: null,
    notes_url: null, minimum_version: null, downloads: [], checksums_url: null,
    ...(product === 'cli' ? { install: { npm: 'npm install -g @zero-x.live/neuron', pip: 'python -m pip install neuroncli' } } : {}),
  };
}

async function parsedManifest(body, product, source) {
  try {
    if (typeof body !== 'string' || body.length > MANIFEST_BYTES_LIMIT) throw new Error('missing or too large');
    const manifest = JSON.parse(body);
    const errors = validateReleaseManifest(manifest, product);
    if (!errors.length) return manifest;
    console.warn('Release manifest rejected', { product, source, errors: errors.slice(0, 5) });
  } catch (error) {
    console.warn('Release manifest unreadable', { product, source, message: String(error?.message).slice(0, 120) });
  }
  return null;
}

export async function loadReleaseManifest(env, product, requestUrl) {
  if (env?.RELEASES && typeof env.RELEASES.get === 'function') {
    try {
      const object = await env.RELEASES.get(`${product}/latest.json`);
      if (object) {
        const manifest = await parsedManifest(await object.text(), product, 'r2');
        if (manifest) return { manifest, source: 'r2' };
      }
    } catch (error) {
      console.warn('Release bucket unavailable', { product, message: String(error?.message).slice(0, 120) });
    }
  }
  if (env?.ASSETS) {
    try {
      const response = await env.ASSETS.fetch(new Request(new URL(`/releases/${product}/latest.json`, requestUrl)));
      if (response.ok) {
        const manifest = await parsedManifest(await response.text(), product, 'assets');
        if (manifest) return { manifest, source: 'assets' };
      }
    } catch (error) {
      console.warn('Release manifest asset unavailable', { product, message: String(error?.message).slice(0, 120) });
    }
  }
  return { manifest: unreleasedManifest(product), source: 'built-in' };
}

// GET /releases/{cli,desktop}/latest.json: public, cacheable, readable from any origin. Other
// files under /releases/ are plain static assets.
export function registerReleaseRoutes(api) {
  api.get('/releases/:product/latest.json', async c => {
    const product = c.req.param('product');
    if (!RELEASE_PRODUCTS.includes(product)) return c.notFound();
    const { manifest, source } = await loadReleaseManifest(c.env, product, c.req.url);
    return c.json(manifest, 200, {
      'Cache-Control': `public, max-age=${MANIFEST_MAX_AGE_SECONDS}`,
      'Access-Control-Allow-Origin': '*',
      'X-Neuron-Manifest-Source': source,
    });
  });
}

import { ApiError, errorResponse, sendApiError } from '../auth-context.js';
import { readRecord, writeRecord } from '../session-store.js';

// Release notes for "What's new" in the apps and /release-notes in the terminal UI (A13,
// docs/PLATFORM_CONTRACT.md §10.3), generated from the Neuron repository's GitHub releases.
// GitHub is asked at most every 15 minutes per isolate and the copy is shared through the
// record store (KV or Postgres); when GitHub fails, the last copy is served for up to a day.
export const CHANGELOG_REPOSITORY = 'RAHUL-DevelopeRR/neuron-v2';
const RELEASES_URL = `https://api.github.com/repos/${CHANGELOG_REPOSITORY}/releases?per_page=50`;
const CACHE_KEY = 'changelog:v1';
const FRESH_MS = 15 * 60_000;
const STALE_MS = 24 * 3_600_000;
const RETRY_AFTER_FAILURE_MS = 60_000;
const NOTES_LIMIT = 20_000;
export const CHANGELOG_MAX_AGE_SECONDS = 300;
const PRODUCTS = ['cli', 'desktop', 'mobile'];
const SEMVER = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})(?:-[0-9A-Za-z.-]{1,32})?$/;

let memory = null; // {fetched, entries}
let lastFailure = 0;

// "v6.3.0" is a CLI release; "desktop-v0.2.0" and "mobile-v0.1.0" belong to those apps. Other
// tags (NeuCockpit builds, experiments) are not Neuron releases and are left out.
export function releaseTag(tag) {
  const match = /^(?:(desktop|mobile)-)?v(.+)$/.exec(String(tag || ''));
  if (!match || !SEMVER.test(match[2])) return null;
  return { product: match[1] || 'cli', version: match[2] };
}

const plain = (value, max) => typeof value === 'string' ? value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, max) : '';

export function changelogEntries(releases) {
  return (Array.isArray(releases) ? releases : []).flatMap(release => {
    if (!release || release.draft === true) return [];
    const tag = releaseTag(release.tag_name);
    const published = Date.parse(release.published_at);
    const url = typeof release.html_url === 'string' && release.html_url.startsWith(`https://github.com/${CHANGELOG_REPOSITORY}/releases/`)
      ? release.html_url : null;
    if (!tag || !Number.isFinite(published) || !url) return [];
    return [{
      product: tag.product, version: tag.version, tag: release.tag_name,
      title: plain(release.name, 200).trim() || `Neuron ${tag.version}`,
      published_at: new Date(published).toISOString(), prerelease: release.prerelease === true, url,
      notes: plain(release.body, NOTES_LIMIT),
    }];
  }).sort((left, right) => right.published_at.localeCompare(left.published_at));
}

async function fetchReleases(env) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'zero-x-gateway', 'X-GitHub-Api-Version': '2022-11-28' };
  // Optional read-only token for a higher rate limit; never logged or forwarded.
  if (typeof env.GITHUB_RELEASES_TOKEN === 'string' && env.GITHUB_RELEASES_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_RELEASES_TOKEN}`;
  const response = await fetch(RELEASES_URL, { headers, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`GitHub releases answered ${response.status}`);
  return changelogEntries(await response.json());
}

async function readShared(env) {
  try { return await readRecord(env, CACHE_KEY); }
  catch { return null; }
}

// Returns {entries, fetched, stale} or throws when nothing is available.
export async function loadChangelog(env, now = Date.now()) {
  if (memory && now - memory.fetched < FRESH_MS) return { ...memory, stale: false };
  const shared = await readShared(env);
  if (shared && Array.isArray(shared.entries) && Number.isFinite(shared.fetched) && (!memory || shared.fetched > memory.fetched)) {
    memory = { entries: shared.entries, fetched: shared.fetched };
    if (now - memory.fetched < FRESH_MS) return { ...memory, stale: false };
  }
  if (now - lastFailure >= RETRY_AFTER_FAILURE_MS) {
    try {
      const entries = await fetchReleases(env);
      memory = { entries, fetched: now };
      try { await writeRecord(env, CACHE_KEY, memory, STALE_MS / 1000); }
      catch (error) { console.warn('Changelog cache write failed', { message: String(error?.message).slice(0, 120) }); }
      return { ...memory, stale: false };
    } catch (error) {
      lastFailure = now;
      console.warn('Changelog refresh failed', { message: String(error?.message).slice(0, 120) });
    }
  }
  if (memory && now - memory.fetched < STALE_MS) return { ...memory, stale: true };
  throw new ApiError(503, 'service_unavailable', 'Release notes are temporarily unavailable. Please retry shortly.', { retry_after_seconds: 60 });
}

export function resetChangelogCache() {
  memory = null;
  lastFailure = 0;
}

// GET /api/changelog.json?product=cli|desktop|mobile&limit=1..50 (public)
export function registerChangelogRoutes(api) {
  api.get('/api/changelog.json', async c => {
    const product = c.req.query('product');
    const limitText = c.req.query('limit');
    if (product !== undefined && !PRODUCTS.includes(product)) {
      return errorResponse(c, 400, 'invalid_request', '`product` must be cli, desktop or mobile.', { param: 'product' });
    }
    if (limitText !== undefined && !(/^\d{1,2}$/.test(limitText) && Number(limitText) >= 1 && Number(limitText) <= 50)) {
      return errorResponse(c, 400, 'invalid_request', '`limit` must be an integer between 1 and 50.', { param: 'limit' });
    }
    try {
      const { entries, fetched, stale } = await loadChangelog(c.env);
      const selected = entries.filter(entry => !product || entry.product === product).slice(0, limitText ? Number(limitText) : 20);
      return c.json({ object: 'list', repository: CHANGELOG_REPOSITORY, updated_at: new Date(fetched).toISOString(), stale, data: selected }, 200, {
        'Cache-Control': `public, max-age=${stale ? 60 : CHANGELOG_MAX_AGE_SECONDS}`,
      });
    } catch (error) {
      return sendApiError(c, error);
    }
  });
}

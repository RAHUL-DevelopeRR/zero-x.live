// /download: fills the installer cards and checksum table from the release manifests
// (neuroncli/auth-server/docs/RELEASE_MANIFESTS.md). Until a release is published, or when the
// manifests cannot be loaded, the page keeps its static "coming soon" state. Every value is
// rendered with textContent, and only https links to GitHub or zero-x.live are used.
import { apiFetch } from './billing-checkout.js';
import { copyButtons } from './home.js';

export const MANIFEST_PATHS = Object.freeze({ cli: '/releases/cli/latest.json', desktop: '/releases/desktop/latest.json' });
const DOWNLOAD_HOSTS = ['github.com', 'zero-x.live'];
const SHA256 = /^[0-9a-f]{64}$/;
const SEMVER = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,32})?$/;

export const DESKTOP_PLATFORMS = Object.freeze({
  windows: ['windows-x64', 'windows-arm64'],
  macos: ['macos-universal', 'macos-arm64', 'macos-x64'],
  linux: ['linux-x64', 'linux-arm64'],
});
export const PLATFORM_LABELS = Object.freeze({
  'windows-x64': 'Windows (x64)', 'windows-arm64': 'Windows (Arm64)',
  'macos-universal': 'macOS (Apple silicon and Intel)', 'macos-arm64': 'macOS (Apple silicon)', 'macos-x64': 'macOS (Intel)',
  'linux-x64': 'Linux (x64)', 'linux-arm64': 'Linux (Arm64)',
});

// The visitor's operating system, from the user agent (client hints first). Phones are told
// apart so the desktop cards are not highlighted for them.
export function detectOs(userAgent = '', platform = '') {
  const text = `${platform} ${userAgent}`.toLowerCase();
  if (/android/.test(text)) return 'android';
  if (/iphone|ipad|ipod/.test(text)) return 'ios';
  if (/win/.test(text)) return 'windows';
  if (/mac/.test(text)) return 'macos';
  if (/linux|x11|cros/.test(text)) return 'linux';
  return null;
}

export function safeDownloadUrl(value) {
  if (typeof value !== 'string' || value.length > 512) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && DOWNLOAD_HOSTS.includes(url.hostname) ? url.href : '';
  } catch { return ''; }
}

export function formatBytes(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const megabytes = bytes / (1024 * 1024);
  return `${megabytes < 10 ? megabytes.toFixed(1) : Math.round(megabytes)} MB`;
}

export function formatReleaseDate(value) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '';
  return new Date(time).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// Reduces a manifest to what the page shows, or null when nothing usable is published. Entries
// with an unsafe URL or a malformed checksum are dropped, never shown.
export function releaseView(manifest, product) {
  if (!manifest || typeof manifest !== 'object' || manifest.schema_version !== 1 || manifest.product !== product) return null;
  if (typeof manifest.version !== 'string' || !SEMVER.test(manifest.version)) return null;
  const downloads = (Array.isArray(manifest.downloads) ? manifest.downloads : []).flatMap(entry => {
    const url = safeDownloadUrl(entry?.url);
    if (!url || typeof entry.platform !== 'string' || !PLATFORM_LABELS[entry.platform] || !SHA256.test(String(entry.sha256))) return [];
    if (typeof entry.file !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entry.file)) return [];
    return [{ platform: entry.platform, kind: String(entry.kind || ''), file: entry.file, url, sha256: entry.sha256, size: formatBytes(entry.size) }];
  });
  return {
    version: manifest.version,
    released: formatReleaseDate(manifest.released_at),
    notesUrl: safeDownloadUrl(manifest.notes_url),
    checksumsUrl: safeDownloadUrl(manifest.checksums_url),
    downloads,
  };
}

function element(doc, tag, text, className) {
  const node = doc.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function link(doc, href, text, className) {
  const anchor = element(doc, 'a', text, className);
  anchor.href = href;
  return anchor;
}

function markVisitorOs(doc, os) {
  const card = os && doc.getElementById(`desktop-${os}`);
  if (!card) return;
  card.classList.add('zx-card--highlight');
  const badge = card.querySelector('[data-your-os]');
  if (badge) badge.hidden = false;
}

function renderDesktop(doc, view) {
  if (!view) return;
  const note = doc.getElementById('desktop-note');
  if (note) note.textContent = `Neuron desktop ${view.version}${view.released ? `, released ${view.released}` : ''}.`;
  for (const [os, platforms] of Object.entries(DESKTOP_PLATFORMS)) {
    const card = doc.getElementById(`desktop-${os}`);
    const installers = view.downloads.filter(entry => entry.kind === 'installer' && platforms.includes(entry.platform));
    if (!card || !installers.length) continue;
    const status = card.querySelector('[data-status]');
    if (status) status.textContent = 'Available';
    const list = card.querySelector('[data-links]');
    const fragment = doc.createDocumentFragment();
    for (const entry of installers) {
      const item = element(doc, 'li');
      item.append(link(doc, entry.url, `Download for ${PLATFORM_LABELS[entry.platform]}`, 'zx-btn zx-btn--primary zx-btn--sm'));
      const detail = element(doc, 'p', '', 'zx-help');
      detail.append(`${entry.file}${entry.size ? ` · ${entry.size}` : ''} · SHA-256 `, element(doc, 'code', entry.sha256));
      item.append(detail);
      fragment.append(item);
    }
    list.replaceChildren(fragment);
  }
}

function renderCli(doc, view) {
  if (!view) return;
  const note = doc.getElementById('cli-release-note');
  if (note) {
    note.replaceChildren(`Latest release: Neuron ${view.version}${view.released ? `, ${view.released}` : ''}.`);
    if (view.notesUrl) note.append(' ', link(doc, view.notesUrl, 'Release notes'));
  }
  for (const pending of doc.querySelectorAll('[data-needs-release]')) pending.hidden = true;
  const body = doc.getElementById('cli-binaries');
  const binaries = view.downloads.filter(entry => entry.kind === 'cli' || entry.kind === 'tui');
  if (body && binaries.length) {
    const fragment = doc.createDocumentFragment();
    for (const entry of binaries) {
      const row = element(doc, 'tr');
      row.append(element(doc, 'th', PLATFORM_LABELS[entry.platform]));
      row.firstChild.scope = 'row';
      const file = element(doc, 'td');
      file.append(link(doc, entry.url, entry.file));
      row.append(file, element(doc, 'td', entry.kind === 'tui' ? 'Full-screen UI' : 'CLI'));
      const checksum = element(doc, 'td');
      checksum.append(element(doc, 'code', entry.sha256));
      row.append(checksum);
      fragment.append(row);
    }
    body.replaceChildren(fragment);
  }
  const sums = doc.getElementById('checksums-link');
  if (sums && view.checksumsUrl) {
    sums.replaceChildren('All checksums for this release: ', link(doc, view.checksumsUrl, 'SHA256SUMS'), '.');
  }
}

async function hydrate(doc, win) {
  const nav = win.navigator || {};
  markVisitorOs(doc, detectOs(nav.userAgent, nav.userAgentData?.platform || nav.platform));
  const [cli, desktop] = await Promise.allSettled([
    apiFetch(MANIFEST_PATHS.cli, { timeoutMs: 8000 }),
    apiFetch(MANIFEST_PATHS.desktop, { timeoutMs: 8000 }),
  ]);
  if (desktop.status === 'fulfilled') renderDesktop(doc, releaseView(desktop.value, 'desktop'));
  if (cli.status === 'fulfilled') renderCli(doc, releaseView(cli.value, 'cli'));
}

if (typeof document !== 'undefined' && typeof window !== 'undefined' && document.querySelector('[data-download]')) {
  copyButtons(document, window);
  hydrate(document, window);
}

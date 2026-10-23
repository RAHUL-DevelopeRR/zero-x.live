// Homepage: install tabs, copy buttons and the live model list. The list starts from the
// catalog rendered in index.html, is replaced by GET /v1/models, then follows
// GET /v1/models/status every poll interval, so a model that goes down greys out and
// brightens again when it recovers. Every value from the API is untrusted and rendered with
// textContent.
import { apiFetch } from './billing-checkout.js';

export const PROVIDER_NAMES = Object.freeze({
  'zero-x': 'Zero-X', gemini: 'Google Gemini', groq: 'Groq', cloudflare: 'Cloudflare Workers AI',
  nvidia: 'NVIDIA', openrouter: 'OpenRouter',
});
const MAX_MODELS = 60;
const DEFAULT_POLL_SECONDS = 30;

/** Short context size: 1048576 → "1M", 131072 → "131K"; "Fits request" for auto. */
export function formatContext(tokens, id) {
  if (id === 'auto') return 'Fits request';
  const value = Number(tokens);
  if (!Number.isFinite(value) || value <= 0) return '—';
  if (value >= 1000000) return (Math.round(value / 100000) / 10).toString().replace(/\.0$/, '') + 'M';
  return Math.round(value / 1000) + 'K';
}

/**
 * How a model is shown: `tone` drives the dot and dimming (ok, warn, busy, off, locked),
 * `label` is the visible status. Unavailable models stay listed, greyed out, with the reason.
 */
export function modelState(model, now = Date.now()) {
  if (!model || typeof model !== 'object') return { tone: 'off', label: 'Unavailable' };
  if (model.available === false) {
    if (model.unavailable_reason === 'upgrade_required') return { tone: 'locked', label: 'Pro and Max plans' };
    if (model.unavailable_reason === 'region_unavailable') return { tone: 'off', label: 'Not offered in your region' };
    return { tone: 'off', label: 'Not offered right now' };
  }
  if (model.status === 'degraded') return { tone: 'warn', label: 'Slower than usual' };
  if (model.status === 'busy') return { tone: 'busy', label: 'Busy, retry soon' };
  if (model.status === 'blurred') {
    const until = Date.parse(model.available_again_at || '');
    if (Number.isFinite(until) && until > now) {
      const minutes = Math.max(1, Math.ceil((until - now) / 60000));
      return { tone: 'off', label: minutes < 120 ? `Back in about ${minutes} min` : 'Temporarily unavailable' };
    }
    return { tone: 'off', label: 'Temporarily unavailable' };
  }
  return { tone: 'ok', label: 'Available' };
}

/** Validated rows from a GET /v1/models payload; null when the payload is unusable. */
export function modelRows(payload) {
  if (!payload || !Array.isArray(payload.data)) return null;
  const rows = [];
  for (const model of payload.data) {
    if (!model || typeof model.id !== 'string' || !model.id || model.id.length > 120) continue;
    const caps = model.capabilities && typeof model.capabilities === 'object' ? model.capabilities : {};
    const tiers = Array.isArray(model.tiers) ? model.tiers : [];
    rows.push({
      id: model.id,
      name: typeof model.display_name === 'string' && model.display_name.trim() ? model.display_name.trim().slice(0, 80) : model.id,
      provider: PROVIDER_NAMES[model.owned_by] || (typeof model.owned_by === 'string' ? model.owned_by.slice(0, 40) : '—'),
      context: formatContext(model.context_length ?? model.context_window, model.id),
      reasoning: caps.reasoning === true,
      vision: caps.vision === true,
      paidOnly: tiers.length > 0 && !tiers.includes('free'),
      available: model.available !== false,
      unavailable_reason: typeof model.unavailable_reason === 'string' ? model.unavailable_reason : null,
      status: typeof model.status === 'string' ? model.status : 'available',
      available_again_at: typeof model.available_again_at === 'string' ? model.available_again_at : null,
    });
    if (rows.length === MAX_MODELS) break;
  }
  return rows;
}

/** Applies a GET /v1/models/status payload to known rows (unknown ids are ignored). */
export function applyStatus(rows, payload) {
  if (!Array.isArray(rows) || !payload || !Array.isArray(payload.data)) return rows;
  const byId = new Map(payload.data.filter(entry => entry && typeof entry.id === 'string').map(entry => [entry.id, entry]));
  return rows.map(row => {
    const entry = byId.get(row.id);
    if (!entry) return row;
    return {
      ...row,
      available: entry.available !== false,
      unavailable_reason: typeof entry.unavailable_reason === 'string' ? entry.unavailable_reason : null,
      status: typeof entry.status === 'string' ? entry.status : 'available',
      available_again_at: typeof entry.available_again_at === 'string' ? entry.available_again_at : null,
    };
  });
}

export function pollSeconds(payload) {
  const value = Number(payload && payload.poll_interval_seconds);
  return Number.isFinite(value) && value >= 10 && value <= 600 ? value : DEFAULT_POLL_SECONDS;
}

/* ───────────── Browser wiring ───────────── */

function installTabs(doc) {
  const root = doc.querySelector('[data-install-tabs]');
  if (!root) return;
  const panels = Array.from(root.querySelectorAll('[data-tab-label]'));
  if (panels.length < 2) return;
  const list = doc.createElement('div');
  list.className = 'zx-tabs zx-home-tabs';
  list.setAttribute('role', 'tablist');
  list.setAttribute('aria-label', 'Install method');
  const tabs = panels.map((panel, index) => {
    const tab = doc.createElement('button');
    tab.type = 'button';
    tab.className = 'zx-tab';
    tab.id = panel.id + '-tab';
    tab.textContent = panel.dataset.tabLabel;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', panel.id);
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', tab.id);
    tab.addEventListener('click', () => select(index, false));
    list.append(tab);
    return tab;
  });
  const select = (index, focus) => {
    tabs.forEach((tab, i) => {
      const active = i === index;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      panels[i].hidden = !active;
    });
    if (focus) tabs[index].focus();
  };
  list.addEventListener('keydown', event => {
    const current = tabs.indexOf(doc.activeElement);
    if (current < 0) return;
    const next = { ArrowRight: (current + 1) % tabs.length, ArrowLeft: (current - 1 + tabs.length) % tabs.length, Home: 0, End: tabs.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    select(next, true);
  });
  root.prepend(list);
  select(0, false);
}

export function copyButtons(doc, win) {
  const live = doc.getElementById('copy-status');
  for (const button of doc.querySelectorAll('[data-copy-target]')) {
    const target = doc.getElementById(button.dataset.copyTarget);
    if (!target || !win.navigator.clipboard) { button.hidden = true; continue; }
    button.addEventListener('click', async () => {
      try {
        await win.navigator.clipboard.writeText(target.textContent.trim());
        button.textContent = 'Copied';
        if (live) live.textContent = (button.dataset.copyLabel || 'Command') + ' copied to the clipboard.';
      } catch {
        button.textContent = 'Selected';
        if (live) live.textContent = 'Copying is blocked here; the command is selected, so press Ctrl+C or Cmd+C.';
        const range = doc.createRange();
        range.selectNodeContents(target);
        const selection = win.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }
      win.setTimeout(() => { button.textContent = 'Copy'; }, 2000);
    });
  }
}

function renderModels(doc, body, rows, now) {
  const fragment = doc.createDocumentFragment();
  for (const row of rows) {
    const state = modelState(row, now);
    const item = doc.createElement('li');
    item.className = 'zx-model';
    item.dataset.tone = state.tone;
    const dot = doc.createElement('span');
    dot.className = 'zx-model__dot';
    dot.setAttribute('aria-hidden', 'true');
    const name = doc.createElement('span');
    name.className = 'zx-model__name';
    name.textContent = row.name;
    const id = doc.createElement('code');
    id.className = 'zx-model__id';
    id.textContent = row.id;
    const meta = doc.createElement('span');
    meta.className = 'zx-model__meta';
    meta.textContent = [row.provider, row.context === '—' ? null : row.context + (row.id === 'auto' ? '' : ' context')].filter(Boolean).join(' · ');
    const tags = doc.createElement('span');
    tags.className = 'zx-model__tags';
    for (const [on, label] of [[row.reasoning, 'Reasoning'], [row.vision, 'Images'], [row.paidOnly, 'Pro and Max']]) {
      if (!on) continue;
      const tag = doc.createElement('span');
      tag.className = 'zx-badge';
      tag.textContent = label;
      tags.append(tag);
    }
    const status = doc.createElement('span');
    status.className = 'zx-model__status';
    status.textContent = state.label;
    item.append(dot, name, id, meta, tags, status);
    fragment.append(item);
  }
  body.replaceChildren(fragment);
}

function liveModels(doc, win) {
  const body = doc.getElementById('models-list');
  const note = doc.getElementById('models-note');
  if (!body || !note) return;
  let rows = null;
  let timer = 0;
  const now = () => Date.now();
  const stamp = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const describe = () => {
    const up = rows.filter(row => modelState(row, now()).tone === 'ok').length;
    note.textContent = `Live from the Zero-X gateway: ${up} of ${rows.length} models available on the Free plan right now. Checked ${stamp()}.`;
  };
  const schedule = seconds => {
    win.clearTimeout(timer);
    timer = win.setTimeout(refresh, seconds * 1000);
  };
  async function refresh() {
    if (doc.hidden) { schedule(DEFAULT_POLL_SECONDS); return; }
    try {
      const status = await apiFetch('/v1/models/status', { timeoutMs: 8000 });
      rows = applyStatus(rows, status);
      renderModels(doc, body, rows, now());
      describe();
      schedule(pollSeconds(status));
    } catch {
      schedule(DEFAULT_POLL_SECONDS * 2);
    }
  }
  apiFetch('/v1/models', { timeoutMs: 8000 })
    .then(payload => {
      const parsed = modelRows(payload);
      if (!parsed || !parsed.length) { note.textContent = 'Showing the default catalog; the live list is empty right now.'; return; }
      rows = parsed;
      renderModels(doc, body, rows, now());
      describe();
      schedule(DEFAULT_POLL_SECONDS);
    })
    .catch(() => { note.textContent = 'Showing the default catalog; the live list could not be loaded.'; });
  doc.addEventListener('visibilitychange', () => { if (!doc.hidden && rows) refresh(); });
}

if (typeof document !== 'undefined' && typeof window !== 'undefined' && document.querySelector('[data-home]')) {
  installTabs(document);
  copyButtons(document, window);
  liveModels(document, window);
}

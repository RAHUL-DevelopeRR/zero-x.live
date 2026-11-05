// Homepage and Neuron CLI page: install tabs, copy buttons and the live model pane.
// The pane starts from the built-in list rendered in the HTML (every row "Not checked recently"),
// is replaced by GET /v1/models, then follows GET /v1/models/status every poll interval: the
// gateway's health checker (docs/PLATFORM_CONTRACT.md section 15) decides each model's status, so a
// model that goes down greys out and comes back when it recovers. One row per model family, shown
// as [maker logo] [model name] [usable context] [status]; no serving provider, route or route id is
// ever shown. Every value from the API is untrusted and rendered with textContent.
import { apiFetch } from './billing-checkout.js';

/** Companies that make models (GET /v1/models `maker`), by slug. */
export const MAKERS = Object.freeze({
  'zero-x': 'Zero-X', openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google', meta: 'Meta', alibaba: 'Alibaba',
  nvidia: 'NVIDIA', stepfun: 'StepFun', cohere: 'Cohere', zhipu: 'Z.ai', minimax: 'MiniMax', deepseek: 'DeepSeek',
  moonshot: 'Moonshot AI', mistral: 'Mistral AI', xai: 'xAI', microsoft: 'Microsoft', ibm: 'IBM', poolside: 'Poolside',
  thinkingmachines: 'Thinking Machines',
});
/** Makers with a vendored logo in Assets/makers/ (Simple Icons, CC0); the rest get a monogram. */
export const MAKER_LOGOS = Object.freeze(['zero-x', 'anthropic', 'google', 'meta', 'alibaba', 'nvidia', 'minimax', 'deepseek', 'moonshot', 'mistral']);
const MONOGRAMS = Object.freeze({ openai: 'O', stepfun: 'S', cohere: 'C', zhipu: 'Z', xai: 'x', microsoft: 'M', ibm: 'IBM', poolside: 'P', thinkingmachines: 'TM' });

// A gateway older than the family view (contract section 14) lists routes ("groq/openai/gpt-oss-120b",
// owned_by the serving provider). These map such a route to its model and maker, so the pane still
// shows one row per model and never a provider. Organisation segment -> [maker, family prefix].
const ROUTE_PREFIXES = new Set(['groq', 'gemini', 'cloudflare', 'nvidia', 'openrouter', 'zai', 'glm', 'azure', 'bedrock', 'omniroute']);
const ORGS = Object.freeze({
  openai: ['openai', 'openai'], anthropic: ['anthropic', 'anthropic'], google: ['google', 'google'], meta: ['meta', 'meta'],
  'meta-llama': ['meta', 'meta'], qwen: ['alibaba', 'qwen'], alibaba: ['alibaba', 'qwen'], nvidia: ['nvidia', 'nvidia'],
  'stepfun-ai': ['stepfun', 'stepfun'], stepfun: ['stepfun', 'stepfun'], cohere: ['cohere', 'cohere'], 'z-ai': ['zhipu', 'zhipu'],
  'zai-org': ['zhipu', 'zhipu'], zhipu: ['zhipu', 'zhipu'], minimax: ['minimax', 'minimax'], 'deepseek-ai': ['deepseek', 'deepseek'],
  deepseek: ['deepseek', 'deepseek'], moonshotai: ['moonshot', 'moonshot'], mistralai: ['mistral', 'mistral'], 'x-ai': ['xai', 'xai'],
});
const NAME_RULES = [[/^(gemini|gemma)/, 'google'], [/^claude/, 'anthropic'], [/^glm/, 'zhipu'], [/^(gpt|o\d|codex)/, 'openai'],
  [/^llama/, 'meta'], [/^(qwen|qwq)/, 'alibaba'], [/^deepseek/, 'deepseek'], [/^kimi/, 'moonshot'], [/^(mistral|codestral|devstral)/, 'mistral'],
  [/^minimax/, 'minimax'], [/^nemotron/, 'nvidia'], [/^grok/, 'xai'], [/^(command|north)/, 'cohere'], [/^step/, 'stepfun']];
const PREFIX_OF_MAKER = Object.freeze({ alibaba: 'qwen' });
const FAMILY_FIXES = Object.freeze({ 'nvidia/nemotron-3-ultra-550b-a55b': 'nvidia/nemotron-3-ultra-550b' });

const MAX_MODELS = 60;
const DEFAULT_POLL_SECONDS = 30;
const STATUS_RANK = Object.freeze({ available: 0, degraded: 1, unknown: 2, busy: 3, unavailable: 4, blurred: 4 });

/** Short context size: 1048576 → "1M", 131072 → "131K"; "Fits request" for auto. */
export function formatContext(tokens, id) {
  if (id === 'auto') return 'Fits request';
  const value = Number(tokens);
  if (!Number.isFinite(value) || value <= 0) return '—';
  if (value >= 1000000) return (Math.round(value / 100000) / 10).toString().replace(/\.0$/, '') + 'M';
  return Math.round(value / 1000) + 'K';
}

/** "GPT-OSS 120B (Groq)" → "GPT-OSS 120B"; "North Mini Code (OpenRouter, free)" → "North Mini Code". */
export function cleanName(name) {
  const value = String(name || '').trim();
  return value.replace(/\s*\([^()]*\)\s*$/, '').replace(/\s*[,:-]\s*free$/i, '').trim() || value;
}

const makerByName = leaf => NAME_RULES.find(([pattern]) => pattern.test(leaf))?.[1] ?? null;

/**
 * The model family and maker of a /v1/models entry. The family view names both; for a route id
 * from an older gateway the provider segment and any ":free" tag are dropped.
 */
export function identityOf(model) {
  const id = String(model?.id || '');
  if (id === 'auto') return { family: 'auto', maker: 'zero-x' };
  let family = typeof model?.family === 'string' && model.family ? model.family.toLowerCase() : '';
  if (!family) {
    let parts = id.toLowerCase().replace(/^@cf\//, '').replace(/:[a-z0-9._-]+$/, '').split('/').filter(Boolean);
    if (parts.length > 2 || (parts.length === 2 && ROUTE_PREFIXES.has(parts[0]) && !ORGS[parts[0]])) parts = parts.slice(1);
    const org = parts.length > 1 ? ORGS[parts[0]] : null;
    const leaf = parts.at(-1) || id.toLowerCase();
    const maker = org ? org[0] : makerByName(leaf);
    const prefix = org ? org[1] : maker ? PREFIX_OF_MAKER[maker] || maker : null;
    family = prefix ? `${prefix}/${leaf}` : leaf;
    family = FAMILY_FIXES[family] || family;
  }
  const named = typeof model?.maker === 'string' && MAKERS[model.maker] ? model.maker
    : typeof model?.owned_by === 'string' && MAKERS[model.owned_by] && !ROUTE_PREFIXES.has(model.owned_by) ? model.owned_by : null;
  const org = ORGS[family.split('/')[0]];
  const maker = named || (org ? org[0] : makerByName(family.split('/').at(-1))) || 'other';
  return { family, maker };
}

/**
 * How a model is shown: `tone` drives the dot and dimming (ok, warn, busy, unknown, off, locked),
 * `label` is the visible status. Unavailable models stay listed, greyed out, with the reason.
 * The gateway's health checker reports `unknown` for a model nobody has confirmed lately
 * (`stale_after_seconds`); it is never shown as available. `blurred` is the older word for
 * `unavailable`.
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
  if (model.status === 'unknown') return { tone: 'unknown', label: 'Not checked recently' };
  if (model.status === 'blurred' || model.status === 'unavailable') {
    const until = Date.parse(model.available_again_at || '');
    if (Number.isFinite(until) && until > now) {
      const minutes = Math.max(1, Math.ceil((until - now) / 60000));
      return { tone: 'off', label: minutes < 120 ? `Back in about ${minutes} min` : 'Temporarily unavailable' };
    }
    return { tone: 'off', label: 'Temporarily unavailable' };
  }
  if (model.status === 'available') return { tone: 'ok', label: 'Available' };
  return { tone: 'unknown', label: 'Not checked recently' };
}

const tokenCount = value => (Number.isFinite(Number(value)) && Number(value) > 0 ? Math.round(Number(value)) : 0);
const plainText = (value, max) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);

/** Validated rows from a GET /v1/models payload; null when the payload is unusable. */
export function modelRows(payload) {
  if (!payload || !Array.isArray(payload.data)) return null;
  const rows = [];
  for (const model of payload.data) {
    if (!model || typeof model.id !== 'string' || !model.id || model.id.length > 120) continue;
    const caps = model.capabilities && typeof model.capabilities === 'object' ? model.capabilities : {};
    const tiers = Array.isArray(model.tiers) ? model.tiers : [];
    const { family, maker } = identityOf(model);
    const context = tokenCount(model.context_length ?? model.context_window);
    rows.push({
      id: model.id,
      family,
      maker,
      name: model.id === 'auto' ? 'Auto' : cleanName(plainText(model.model_name, 80) || plainText(model.display_name, 80) || model.id),
      context,
      native: Math.max(context, tokenCount(model.native_context_window)),
      reasoning: caps.reasoning === true,
      vision: caps.vision === true,
      paidOnly: tiers.length > 0 && !tiers.includes('free'),
      available: model.available !== false,
      unavailable_reason: typeof model.unavailable_reason === 'string' ? model.unavailable_reason : null,
      status: typeof model.status === 'string' ? model.status : 'unknown',
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
    const context = tokenCount(entry.context_window);
    return {
      ...row,
      ...(context ? { context, native: Math.max(context, tokenCount(entry.native_context_window), row.native) } : {}),
      available: entry.available !== false,
      unavailable_reason: typeof entry.unavailable_reason === 'string' ? entry.unavailable_reason : null,
      status: typeof entry.status === 'string' ? entry.status : 'unknown',
      available_again_at: typeof entry.available_again_at === 'string' ? entry.available_again_at : null,
    };
  });
}

/**
 * One row per model family, in first-seen order. Routes of the same model (an older gateway
 * lists them separately) merge: the family is available when any route is, its status is the best
 * route's, and its context is the largest a route with that status takes.
 */
export function familyRows(rows) {
  const groups = new Map();
  for (const row of rows || []) {
    if (!groups.has(row.family)) groups.set(row.family, []);
    groups.get(row.family).push(row);
  }
  return [...groups.values()].map(routes => {
    if (routes.length === 1) return routes[0];
    const usable = routes.filter(route => route.available);
    const listed = usable.length ? usable : routes;
    const rank = route => STATUS_RANK[route.status] ?? STATUS_RANK.unknown;
    const best = [...listed].sort((a, b) => rank(a) - rank(b))[0];
    const serving = listed.filter(route => rank(route) === rank(best));
    return {
      ...best,
      context: Math.max(...serving.map(route => route.context)),
      native: Math.max(...routes.map(route => route.native)),
      reasoning: routes.some(route => route.reasoning),
      vision: routes.some(route => route.vision),
      paidOnly: routes.every(route => route.paidOnly),
    };
  });
}

export function pollSeconds(payload) {
  const value = Number(payload && payload.poll_interval_seconds);
  return Number.isFinite(value) && value >= 10 && value <= 600 ? value : DEFAULT_POLL_SECONDS;
}

/**
 * How long a health verdict stays good without a new check: the health checker's own
 * `stale_after_seconds`, or two poll intervals when the payload does not say.
 */
export function staleAfterSeconds(payload, poll = DEFAULT_POLL_SECONDS) {
  const value = Number(payload && payload.stale_after_seconds);
  return Number.isFinite(value) && value > 0 && value <= 86400 ? value : poll * 2;
}

/**
 * True once the verdicts on screen are no longer being checked: the gateway has not answered for
 * two poll intervals (or never has), or the health checker's newest verdict (`checkedAt`, 0 when
 * the gateway sent none) is older than `staleAfter` seconds. All times are in milliseconds.
 */
export function verdictsExpired({ checkedAt = 0, answeredAt = 0, staleAfter = DEFAULT_POLL_SECONDS * 2, poll = DEFAULT_POLL_SECONDS }, now = Date.now()) {
  if (!answeredAt || now - answeredAt > poll * 2 * 1000) return true;
  return checkedAt > 0 && now - checkedAt > staleAfter * 1000;
}

/** "just now", "12 s ago", "3 min ago", "2 h ago". */
export function sinceLabel(then, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  return `${Math.floor(seconds / 3600)} h ago`;
}

/**
 * What the context cell says on hover and to screen readers: the usable window on the plan and,
 * when the model itself takes more, its own window.
 */
export function contextNote(row) {
  if (row.id === 'auto') return 'Auto picks a model whose context fits each request.';
  const usable = formatContext(row.context, row.id);
  if (usable === '—') return 'Context window not reported.';
  const plan = row.paidOnly ? 'on Pro and Max' : 'on the Free plan';
  return row.native > row.context
    ? `Up to ${usable} tokens per request ${plan}. The model itself takes up to ${formatContext(row.native, row.id)}.`
    : `Up to ${usable} tokens per request ${plan}.`;
}

/**
 * The "Live · checked 12 s ago" indicator: live, reconnecting (last poll failed) or offline.
 * `checkedAt` is the health checker's own time, 0 when it has not checked any model yet.
 */
export function liveText(state, checkedAt, now = Date.now()) {
  if (state === 'live') return checkedAt ? `Live · checked ${sinceLabel(checkedAt, now)}` : 'Live · not checked yet';
  if (state === 'stale') return checkedAt ? `Reconnecting · last checked ${sinceLabel(checkedAt, now)}` : 'Reconnecting';
  if (state === 'offline') return 'Offline · built-in list, not checked';
  return 'Connecting to the gateway';
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

/** The maker badge: the vendored logo when there is one, otherwise a monogram. */
export function makerBadge(doc, maker) {
  const badge = doc.createElement('span');
  const known = Object.prototype.hasOwnProperty.call(MAKERS, maker) ? maker : 'other';
  const name = MAKERS[known] || 'Other maker';
  badge.className = 'zx-maker';
  badge.dataset.maker = known;
  badge.setAttribute('role', 'img');
  badge.setAttribute('aria-label', name);
  badge.title = name;
  if (MAKER_LOGOS.includes(known)) badge.dataset.logo = '';
  else {
    const letter = doc.createElement('span');
    letter.setAttribute('aria-hidden', 'true');
    letter.textContent = MONOGRAMS[known] || '?';
    badge.append(letter);
  }
  return badge;
}

function renderModels(doc, body, rows, now) {
  const fragment = doc.createDocumentFragment();
  for (const row of familyRows(rows)) {
    const state = modelState(row, now);
    const item = doc.createElement('li');
    item.className = 'zx-model';
    item.dataset.tone = state.tone;
    const main = doc.createElement('span');
    main.className = 'zx-model__main';
    const name = doc.createElement('span');
    name.className = 'zx-model__name';
    name.textContent = row.name;
    main.append(name);
    if (row.id === 'auto') {
      const sub = doc.createElement('span');
      sub.className = 'zx-model__sub';
      sub.textContent = 'Best available model';
      main.append(sub);
    } else if (row.paidOnly && state.tone !== 'locked') {
      const tag = doc.createElement('span');
      tag.className = 'zx-badge zx-badge--purple';
      tag.textContent = 'Pro and Max';
      main.append(tag);
    }
    const context = doc.createElement('span');
    context.className = row.id === 'auto' ? 'zx-model__ctx zx-model__ctx--fit' : 'zx-model__ctx';
    const note = contextNote(row);
    context.title = note;
    context.textContent = formatContext(row.context, row.id);
    const hidden = doc.createElement('span');
    hidden.className = 'zx-visually-hidden';
    hidden.textContent = ' context. ' + note;
    context.append(hidden);
    const status = doc.createElement('span');
    status.className = 'zx-model__status';
    const dot = doc.createElement('span');
    dot.className = 'zx-model__dot';
    dot.setAttribute('aria-hidden', 'true');
    status.append(dot, state.label);
    item.append(makerBadge(doc, row.maker), main, context, status);
    fragment.append(item);
  }
  body.replaceChildren(fragment);
}

/** Shows every row as not checked (no live status could be read), keeping names and contexts. */
export function markUnchecked(body) {
  for (const item of body.querySelectorAll('.zx-model')) {
    item.dataset.tone = 'unknown';
    const status = item.querySelector('.zx-model__status');
    if (!status) continue;
    const dot = status.querySelector('.zx-model__dot');
    status.replaceChildren(...(dot ? [dot] : []), 'Not checked recently');
  }
}

/**
 * Drives the pane. `fetchImpl` and `clock` exist for the checks; the browser uses fetch and Date.now.
 */
export function liveModels(doc, win, { fetchImpl, clock = () => Date.now() } = {}) {
  const body = doc.getElementById('models-list');
  const note = doc.getElementById('models-note');
  const live = doc.getElementById('models-live');
  const liveLabel = doc.getElementById('models-live-text');
  if (!body || !note) return;
  let rows = null;
  let timer = 0;
  let state = 'connecting';
  let checkedAt = 0;
  let answeredAt = 0;
  let poll = DEFAULT_POLL_SECONDS;
  let staleAfter = DEFAULT_POLL_SECONDS * 2;
  let expired = false;
  const now = clock;
  const get = path => apiFetch(path, { timeoutMs: 8000, fetchImpl });
  const paint = () => {
    if (live) live.dataset.state = state;
    if (liveLabel) liveLabel.textContent = liveText(state, checkedAt, now());
  };
  const describe = () => {
    const families = familyRows(rows);
    const up = families.filter(row => modelState(row, now()).tone === 'ok').length;
    note.textContent = `${up} of ${families.length} models available on the Free plan right now, from the Zero-X gateway's health checks.`;
  };
  // checked_at is when the health checker last confirmed a verdict. The gateway sends null when it
  // has checked nothing yet, and then the indicator shows no time rather than the poll's own.
  const stamp = payload => {
    const at = Date.parse((payload && payload.checked_at) || '');
    checkedAt = Number.isFinite(at) ? Math.min(at, now()) : 0;
    answeredAt = now();
    poll = pollSeconds(payload);
    staleAfter = staleAfterSeconds(payload, poll);
  };
  // While the gateway is not answering, the last verdicts stand only until they expire; after that
  // no row may claim to be available, as when the gateway could not be reached at all.
  const expire = () => {
    if (expired || state !== 'stale' || !verdictsExpired({ checkedAt, answeredAt, staleAfter, poll }, now())) return;
    expired = true;
    markUnchecked(body);
    note.textContent = 'The Zero-X gateway is not answering, so model availability is not being checked right now. Every model reads "Not checked recently" until it answers again.';
  };
  const schedule = (task, seconds) => {
    win.clearTimeout(timer);
    timer = win.setTimeout(task, seconds * 1000);
  };
  async function refresh() {
    if (doc.hidden) { schedule(refresh, DEFAULT_POLL_SECONDS); return; }
    try {
      const status = await get('/v1/models/status');
      rows = applyStatus(rows, status);
      renderModels(doc, body, rows, now());
      expired = false;
      describe();
      state = 'live';
      stamp(status);
      paint();
      schedule(refresh, poll);
    } catch {
      state = 'stale';
      paint();
      expire();
      schedule(refresh, DEFAULT_POLL_SECONDS * 2);
    }
  }
  const offline = message => {
    // Without the gateway nothing here was checked: no row may claim to be available.
    markUnchecked(body);
    state = 'offline';
    paint();
    note.textContent = message;
    schedule(load, DEFAULT_POLL_SECONDS * 2);
  };
  function load() {
    get('/v1/models')
      .then(payload => {
        const parsed = modelRows(payload);
        if (!parsed || !parsed.length) {
          offline('The gateway listed no models just now, so this is the built-in list and nothing in it was checked.');
          return;
        }
        rows = parsed;
        renderModels(doc, body, rows, now());
        expired = false;
        answeredAt = now();
        describe();
        // The status poll follows at once, so the indicator reports the health checker's own time.
        refresh();
      })
      .catch(() => offline('The Zero-X gateway could not be reached, so this is the built-in list and nothing in it was checked. It tries again every minute.'));
  }
  paint();
  win.setInterval(() => { if (!doc.hidden && (state === 'live' || state === 'stale')) { paint(); expire(); } }, 1000);
  load();
  doc.addEventListener('visibilitychange', () => { if (!doc.hidden && rows) refresh(); });
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  if (document.querySelector('[data-home]')) {
    installTabs(document);
    copyButtons(document, window);
  }
  if (document.querySelector('[data-live-models]')) liveModels(document, window);
}

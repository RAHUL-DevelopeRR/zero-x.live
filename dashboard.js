// Zero-X account dashboard (dashboard.zero-x.live). Contract §3.4–3.5.
// All API data is rendered with textContent / DOM nodes; nothing from the network reaches innerHTML.
import {
  ApiError, PAYMENT_LOCK_CODES, SUPPORT_EMAIL, apiFetch, clearPaymentLock, describeError, normalizeCurrency, readPaymentLock,
  rememberPaymentLock, safeHttpsUrl, siteUrl, startTopup,
} from './billing-checkout.js';
import { PLAN_CATALOG, formatCount, formatMoney, formatTokens, normalizeCatalog } from './pricing.js';

export const TABS = ['overview', 'usage', 'keys', 'billing', 'sessions', 'account'];
export const DEV_TOKEN_KEY = 'zx-dev-token';
export const EVENTS_PAGE_SIZE = 25;
export const MAX_ACTIVE_KEYS = 10;
const SVG_NS = 'http://www.w3.org/2000/svg';
const DAY_MS = 86400000;
const KEY_NAME_MAX = 64;

/* ───────────── Pure helpers (unit-tested in check-pages.mjs) ───────────── */

export function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function text(value, max = 200) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function titleCase(value) {
  return String(value || '').replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

export function parseTab(hash) {
  const id = String(hash || '').replace(/^#/, '').toLowerCase();
  return TABS.includes(id) ? id : 'overview';
}

/** Keyboard navigation for the tablist (WAI-ARIA tabs pattern). */
export function nextTab(current, key) {
  const index = Math.max(0, TABS.indexOf(current));
  if (key === 'ArrowRight') return TABS[(index + 1) % TABS.length];
  if (key === 'ArrowLeft') return TABS[(index - 1 + TABS.length) % TABS.length];
  if (key === 'Home') return TABS[0];
  if (key === 'End') return TABS[TABS.length - 1];
  return null;
}

/** USD amount (float) → "$7.42"; sub-cent costs keep four decimals ("$0.0012"). */
export function formatUsd(value) {
  const amount = toNumber(value);
  if (amount === null) return '—';
  if (amount === 0) return '$0.00';
  const abs = Math.abs(amount);
  if (abs < 0.0001) return (amount < 0 ? '-' : '') + '<$0.0001';
  const digits = abs < 0.01 ? 4 : 2;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(amount);
}

/** Minor units in any ISO currency → localized amount. */
export function formatMinor(amountMinor, currency) {
  const amount = toNumber(amountMinor);
  const code = /^[A-Z]{3}$/.test(currency || '') ? currency : '';
  if (amount === null) return '—';
  if (code === 'USD' || code === 'INR') return formatMoney(amount, code);
  if (!code) return formatCount(amount / 100);
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: code }).format(amount / 100); }
  catch { return (amount / 100).toFixed(2) + ' ' + code; }
}

export function percentUsed(used, limit) {
  const u = toNumber(used) || 0;
  const l = toNumber(limit);
  if (!(l > 0)) return 0;
  return Math.min(100, Math.max(0, Math.round((u / l) * 100)));
}

export function progressTone(percent) {
  return percent >= 90 ? 'danger' : percent >= 75 ? 'warn' : 'ok';
}

/** "Resets in 5 h 12 min" for an ISO timestamp, relative to `now` (ms). */
export function formatResetIn(resetsAt, now) {
  const at = Date.parse(resetsAt || '');
  if (!Number.isFinite(at)) return '';
  const minutes = Math.ceil((at - now) / 60000);
  if (minutes <= 1) return 'Resets in under a minute';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours >= 24) return 'Resets on ' + formatDate(resetsAt);
  return 'Resets in ' + (hours ? hours + ' h ' : '') + rest + ' min';
}

const dateFormat = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
const shortDayFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

export function formatDate(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? dateFormat.format(time) : '—';
}

export function formatShortDay(day) {
  const time = Date.parse(String(day || '') + (/^\d{4}-\d{2}-\d{2}$/.test(day || '') ? 'T00:00:00Z' : ''));
  return Number.isFinite(time) ? shortDayFormat.format(time) : '—';
}

export function formatDateTime(value, timeZone) {
  const time = Date.parse(value || '');
  if (!Number.isFinite(time)) return '—';
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, ...(timeZone ? { timeZone } : {}) }).format(time);
}

/** Rounds a chart maximum up to 1, 2, 2.5 or 5 × 10^n. */
export function niceMax(value) {
  const max = toNumber(value);
  if (!(max > 0)) return 1;
  const exponent = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 2.5, 5, 10]) if (step * exponent >= max) return step * exponent;
  return 10 * exponent;
}

/** Bar geometry for an SVG chart with a viewBox of width × height. */
export function chartScale(values, { width = 720, height = 200, gap = 2, minBar = 2 } = {}) {
  const clean = (Array.isArray(values) ? values : []).map(value => Math.max(0, toNumber(value) || 0));
  const max = niceMax(clean.length ? Math.max(...clean) : 0);
  const slot = clean.length ? width / clean.length : width;
  const barWidth = Math.max(1, slot - gap);
  const bars = clean.map((value, index) => {
    const barHeight = value > 0 ? Math.max(minBar, (value / max) * height) : 0;
    return { x: index * slot + (slot - barWidth) / 2, y: height - barHeight, width: barWidth, height: barHeight, value };
  });
  return { max, width, height, bars };
}

function isoDay(time) {
  return new Date(time).toISOString().slice(0, 10);
}

/** One row per UTC day in [from, to] (inclusive, at most 92), filling gaps with zeros. */
export function fillDays(series, from, to) {
  const start = Date.parse(from + 'T00:00:00Z');
  const end = Date.parse(to + 'T00:00:00Z');
  const byDay = new Map((Array.isArray(series) ? series : []).map(row => [row.day, row]));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  const rows = [];
  for (let time = start; time <= end && rows.length < 92; time += DAY_MS) {
    const day = isoDay(time);
    const row = byDay.get(day) || {};
    rows.push({
      day,
      requests: toNumber(row.requests) || 0,
      prompt_tokens: toNumber(row.prompt_tokens) || 0,
      completion_tokens: toNumber(row.completion_tokens) || 0,
      cost_usd: toNumber(row.cost_usd) || 0,
    });
  }
  return rows;
}

export function lastDaysRange(now, days = 30) {
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  return { from: isoDay(today - (days - 1) * DAY_MS), to: isoDay(today) };
}

export function normalizeAccount(data) {
  const source = data && typeof data === 'object' ? data : {};
  const user = source.user && typeof source.user === 'object' ? source.user : {};
  const plan = source.plan && typeof source.plan === 'object' ? source.plan : {};
  const limits = source.limits && typeof source.limits === 'object' ? source.limits : {};
  const usage = source.usage_today && typeof source.usage_today === 'object' ? source.usage_today : {};
  const credits = source.credits && typeof source.credits === 'object' ? source.credits : {};
  const sub = source.subscription && typeof source.subscription === 'object' ? source.subscription : null;
  const planId = /^[a-z0-9_-]{1,32}$/.test(plan.id || '') ? plan.id : 'free';
  return {
    user: { id: text(user.id, 64), email: text(user.email, 254), name: text(user.name, 120), image_url: safeHttpsUrl(user.image_url) },
    plan: { id: planId, name: text(plan.name, 40) || titleCase(planId) },
    limits: {
      daily_requests: toNumber(limits.daily_requests), daily_tokens: toNumber(limits.daily_tokens),
      rpm: toNumber(limits.rpm), concurrency: toNumber(limits.concurrency),
    },
    usage: { requests: toNumber(usage.requests) || 0, tokens: toNumber(usage.tokens) || 0, resets_at: text(usage.resets_at, 40) },
    credits: { balance_usd: toNumber(credits.balance_usd), monthly_grant_usd: toNumber(credits.monthly_grant_usd) },
    subscription: sub ? { status: text(sub.status, 32), current_period_end: text(sub.current_period_end, 40), cancel_at_period_end: sub.cancel_at_period_end === true } : null,
    suspended: !!(source.flags && source.flags.suspended === true),
  };
}

export function normalizeUsage(data, now) {
  const source = data && typeof data === 'object' ? data : {};
  const fallback = lastDaysRange(now);
  const valid = day => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day);
  const from = valid(source.from) ? source.from : fallback.from;
  const to = valid(source.to) ? source.to : fallback.to;
  const series = (Array.isArray(source.series) ? source.series : []).filter(row => row && valid(row.day));
  const byModel = (Array.isArray(source.by_model) ? source.by_model : []).filter(row => row && typeof row.model === 'string').map(row => ({
    model: row.model.slice(0, 120),
    requests: toNumber(row.requests) || 0,
    prompt_tokens: toNumber(row.prompt_tokens) || 0,
    completion_tokens: toNumber(row.completion_tokens) || 0,
    cost_usd: toNumber(row.cost_usd) || 0,
  })).sort((a, b) => b.requests - a.requests);
  const days = fillDays(series, from, to);
  const sum = key => days.reduce((total, row) => total + row[key], 0);
  const totals = source.totals && typeof source.totals === 'object' ? source.totals : {};
  return {
    from, to, days, byModel,
    totals: {
      requests: toNumber(totals.requests) ?? sum('requests'),
      prompt_tokens: toNumber(totals.prompt_tokens) ?? sum('prompt_tokens'),
      completion_tokens: toNumber(totals.completion_tokens) ?? sum('completion_tokens'),
      cost_usd: toNumber(totals.cost_usd) ?? sum('cost_usd'),
    },
  };
}

export function normalizeEvents(data) {
  const source = data && typeof data === 'object' ? data : {};
  const events = (Array.isArray(source.events) ? source.events : []).filter(event => event && typeof event === 'object').map(event => ({
    id: text(String(event.id ?? ''), 40),
    created_at: text(event.created_at, 40),
    model: text(event.model, 120),
    provider: text(event.provider, 40),
    tier: text(event.tier, 16),
    status: text(event.status, 24),
    prompt_tokens: toNumber(event.prompt_tokens) || 0,
    completion_tokens: toNumber(event.completion_tokens) || 0,
    cost_usd: toNumber(event.cost_usd) || 0,
    latency_ms: toNumber(event.latency_ms),
    request_id: text(event.request_id, 80),
  }));
  const cursor = source.next_before;
  const nextBefore = (typeof cursor === 'number' && Number.isSafeInteger(cursor)) || (typeof cursor === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(cursor)) ? String(cursor) : null;
  return { events, nextBefore };
}

export function normalizeKeys(data) {
  return (data && Array.isArray(data.keys) ? data.keys : []).filter(key => key && /^[A-Za-z0-9_-]{1,64}$/.test(key.id || '')).map(key => ({
    id: key.id,
    name: text(key.name, KEY_NAME_MAX) || 'Untitled key',
    prefix: text(key.prefix, 24),
    created_at: text(key.created_at, 40),
    last_used_at: text(key.last_used_at, 40),
    revoked_at: text(key.revoked_at, 40),
  }));
}

export function keyStatus(key) {
  return key && key.revoked_at ? 'revoked' : 'active';
}

export function validateKeyName(value) {
  const name = String(value || '').trim();
  if (!name) return { ok: false, error: 'Enter a name so you can recognise this key later.' };
  if (name.length > KEY_NAME_MAX) return { ok: false, error: 'Use ' + KEY_NAME_MAX + ' characters or fewer.' };
  if (/[\u0000-\u001f\u007f]/.test(name)) return { ok: false, error: 'Remove control characters from the name.' };
  return { ok: true, name };
}

export function normalizeBilling(data) {
  const source = data && typeof data === 'object' ? data : {};
  const sub = source.subscription && typeof source.subscription === 'object' ? source.subscription : null;
  return {
    providerConfigured: source.provider_configured === true,
    subscription: sub ? {
      plan: /^[a-z0-9_-]{1,32}$/.test(sub.plan || '') ? sub.plan : '',
      status: text(sub.status, 32),
      current_period_end: text(sub.current_period_end, 40),
      cancel_at_period_end: sub.cancel_at_period_end === true,
    } : null,
    payments: (Array.isArray(source.payments) ? source.payments : []).filter(payment => payment && typeof payment === 'object').map(payment => ({
      id: text(String(payment.id ?? ''), 64),
      kind: payment.kind === 'topup' ? 'topup' : 'subscription',
      amount_minor: toNumber(payment.amount_minor),
      currency: /^[A-Za-z]{3}$/.test(payment.currency || '') ? payment.currency.toUpperCase() : '',
      status: text(payment.status, 24),
      created_at: text(payment.created_at, 40),
      invoice_url: safeHttpsUrl(payment.invoice_url),
    })),
  };
}

/** Display state for a subscription row (Razorpay statuses). */
export function subscriptionSummary(subscription) {
  if (!subscription) return { label: 'No subscription', tone: '', periodLabel: '', periodText: '', canCancel: false, active: false };
  const status = subscription.status;
  const end = formatDate(subscription.current_period_end);
  if (['active', 'authenticated'].includes(status)) {
    if (subscription.cancel_at_period_end) return { label: 'Cancels at period end', tone: 'warning', periodLabel: 'Access until', periodText: end, canCancel: false, active: true };
    return { label: 'Active', tone: 'success', periodLabel: 'Renews on', periodText: end, canCancel: true, active: true };
  }
  if (['pending', 'halted'].includes(status)) return { label: 'Payment issue', tone: 'danger', periodLabel: 'Paid through', periodText: end, canCancel: true, active: true };
  if (['created'].includes(status)) return { label: 'Awaiting payment', tone: 'warning', periodLabel: '', periodText: '', canCancel: false, active: false };
  return { label: status === 'cancelled' ? 'Cancelled' : 'Ended', tone: '', periodLabel: 'Ended on', periodText: end, canCancel: false, active: false };
}

export function paymentStatusTone(status) {
  if (['captured', 'paid', 'authorized', 'ok'].includes(status)) return 'success';
  if (['failed'].includes(status)) return 'danger';
  if (['refunded', 'partially_refunded'].includes(status)) return 'warning';
  return '';
}

export function eventStatusTone(status) {
  return status === 'ok' ? 'success' : status === 'refunded' ? 'warning' : status ? 'danger' : '';
}

/* ───────────── Controller ───────────── */

export function createDashboard({ doc = globalThis.document, win = globalThis.window, auth, fetchImpl, now = () => Date.now() } = {}) {
  const $ = id => doc.getElementById(id);
  const getAuth = () => auth || win.ZeroXAuth || null;
  const host = () => (win.location ? win.location.hostname : '');
  const state = {
    tab: 'overview', profile: null, account: null, loaded: new Set(), metric: 'requests', usage: null,
    cursors: [null], page: 0, keys: [], billing: null, catalog: PLAN_CATALOG, revisions: {}, gated: false,
    paymentLocked: false, // a payment Razorpay took is not confirmed yet: no further purchases
    paymentLock: null, // the ApiError describing it (payment_unverified or payment_pending)
  };
  const api = (path, options = {}) => apiFetch(path, { ...options, auth: getAuth(), fetchImpl });

  function el(tag, props = {}, ...children) {
    const node = doc.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = String(value);
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else if (key === 'hidden' || key === 'disabled') node[key] = Boolean(value);
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child);
    return node;
  }

  function svg(tag, attrs = {}, ...children) {
    const node = doc.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'text') node.textContent = String(value);
      else node.setAttribute(key, String(value));
    }
    for (const child of children) node.append(child);
    return node;
  }

  function badge(label, tone) {
    return el('span', { class: 'zx-badge' + (tone ? ' zx-badge--' + tone : ''), text: label });
  }

  function cell(content, className) {
    return el('td', className ? { class: className } : {}, content);
  }

  function emptyRow(columns, message) {
    return el('tr', {}, el('td', { colspan: columns, class: 'zx-empty', text: message }));
  }

  function revision(name) {
    state.revisions[name] = (state.revisions[name] || 0) + 1;
    const current = state.revisions[name];
    return () => state.revisions[name] === current;
  }

  function setText(id, value) {
    const node = $(id);
    if (node) node.textContent = value;
  }

  function setAlert(id, message, retry) {
    const node = $(id);
    if (!node) return;
    node.replaceChildren();
    if (!message) return;
    node.append(el('p', { text: message }));
    if (retry) node.append(el('button', { class: 'zx-btn zx-btn--sm', type: 'button', text: 'Try again', onclick: () => retry() }));
  }

  function toast(message, tone) {
    const region = $('toasts');
    if (!region) return;
    const item = el('div', { class: 'zx-toast' + (tone === 'error' ? ' zx-toast--error' : ''), text: message });
    region.append(item);
    setTimeout(() => item.remove(), 5000);
  }

  function showGate(message) {
    state.gated = true;
    $('dash-loading').hidden = true;
    $('dash-app').hidden = true;
    $('dash-gate').hidden = false;
    setAlert('gate-error', message);
  }

  function handleError(error, alertId, retry) {
    if (error && (error.status === 401 || error.code === 'invalid_session')) {
      showGate('Your sign-in has expired. Sign in again to continue.');
      return;
    }
    if (error && error.code === 'account_suspended') setAlert('dash-alert', describeError(error));
    setAlert(alertId, describeError(error), retry);
  }

  async function copyText(value, label) {
    try {
      await win.navigator.clipboard.writeText(value);
      toast((label || 'Text') + ' copied to the clipboard.');
      return true;
    } catch {
      toast('Copy failed. Select the text and copy it manually.', 'error');
      return false;
    }
  }

  function confirmAction({ title, body, confirm }) {
    const dialog = $('confirm-dialog');
    setText('confirm-title', title);
    setText('confirm-body', body);
    setText('confirm-ok', confirm);
    if (!dialog || typeof dialog.showModal !== 'function') return Promise.resolve(false);
    return new Promise(resolve => {
      const ok = $('confirm-ok');
      const cancel = $('confirm-cancel');
      const finish = value => {
        ok.removeEventListener('click', onOk);
        cancel.removeEventListener('click', onCancel);
        dialog.removeEventListener('close', onClose);
        if (dialog.open) dialog.close();
        resolve(value);
      };
      const onOk = () => finish(true);
      const onCancel = () => finish(false);
      const onClose = () => finish(false);
      ok.addEventListener('click', onOk);
      cancel.addEventListener('click', onCancel);
      dialog.addEventListener('close', onClose);
      dialog.showModal();
      cancel.focus();
    });
  }

  /* Overview and account */

  function setProgress(id, used, limit, labelText) {
    const bar = $(id);
    if (!bar) return;
    const percent = percentUsed(used, limit);
    bar.setAttribute('aria-valuenow', String(percent));
    bar.setAttribute('aria-valuetext', labelText);
    bar.dataset.tone = progressTone(percent);
    const fill = bar.querySelector('.zx-progress__bar');
    if (fill) fill.style.width = percent + '%';
  }

  function renderAccount() {
    const account = state.account;
    if (!account) return;
    const { plan, limits, usage, credits, subscription } = account;
    setText('ov-plan', plan.name);
    const summary = subscriptionSummary(subscription);
    setText('ov-plan-detail', plan.id === 'free'
      ? 'Shared free model pools with daily caps.'
      : summary.periodLabel ? summary.label + ' · ' + summary.periodLabel.toLowerCase() + ' ' + summary.periodText : summary.label);
    $('ov-upgrade').hidden = plan.id !== 'free';

    const requestLimit = limits.daily_requests;
    setText('ov-requests', formatCount(usage.requests) + (requestLimit !== null ? ' / ' + formatCount(requestLimit) : ''));
    setProgress('ov-requests-bar', usage.requests, requestLimit, formatCount(usage.requests) + ' of ' + (requestLimit !== null ? formatCount(requestLimit) : 'unknown') + ' requests used today');
    setText('ov-requests-detail', requestLimit !== null ? formatCount(Math.max(0, requestLimit - usage.requests)) + ' requests left today' : 'Daily request limit unavailable');

    const tokenLimit = limits.daily_tokens;
    setText('ov-tokens', formatTokens(usage.tokens) + (tokenLimit !== null ? ' / ' + formatTokens(tokenLimit) : ''));
    setProgress('ov-tokens-bar', usage.tokens, tokenLimit, formatCount(usage.tokens) + ' of ' + (tokenLimit !== null ? formatCount(tokenLimit) : 'unknown') + ' tokens used today');
    setText('ov-tokens-detail', tokenLimit !== null ? formatTokens(Math.max(0, tokenLimit - usage.tokens)) + ' tokens left today' : 'Daily token limit unavailable');

    setText('ov-reset', formatResetIn(usage.resets_at, now()) || 'Daily limits reset at 00:00 UTC.');
    setText('ov-credits', formatUsd(credits.balance_usd));
    setText('ov-credits-detail', plan.id === 'free'
      ? 'Credits pay for paid-capacity models on Pro and Max.'
      : credits.monthly_grant_usd !== null ? formatUsd(credits.monthly_grant_usd) + ' added at each renewal.' : 'Used for paid-capacity requests.');
    setAlert('dash-alert', account.suspended ? 'This account is suspended, so requests are blocked. Email ' + SUPPORT_EMAIL + ' for help.' : '');

    setText('acct-id', account.user.id || '—');
    setText('acct-plan', plan.name);
    if (account.user.email) setText('acct-email', account.user.email);
    if (account.user.name) setText('acct-name', account.user.name);
    if (account.user.image_url) $('acct-avatar').setAttribute('src', account.user.image_url);
    if (state.billing) renderTopups();
  }

  function renderProfile() {
    const profile = state.profile || {};
    const name = text(profile.fullName, 120) || text(profile.email, 254) || 'Your account';
    setText('acct-name', name);
    setText('acct-email', text(profile.email, 254) || 'Signed in');
    setText('acct-provider', text(profile.providersDisplay, 80) || 'Email');
    setText('dash-subtitle', 'Signed in as ' + (text(profile.email, 254) || name) + '.');
    const avatar = safeHttpsUrl(profile.imageUrl);
    if (avatar) $('acct-avatar').setAttribute('src', avatar);
  }

  async function loadAccount() {
    const current = revision('account');
    setAlert('overview-error', '');
    try {
      const data = await api('/api/account');
      if (!current()) return;
      state.account = normalizeAccount(data);
      renderAccount();
    } catch (error) {
      if (current()) handleError(error, 'overview-error', loadAccount);
    }
  }

  /* Usage */

  function metricValue(row) {
    return state.metric === 'tokens' ? row.prompt_tokens + row.completion_tokens : row.requests;
  }

  function renderChart() {
    const usage = state.usage;
    const container = $('usage-chart');
    if (!usage || !container) return;
    const values = usage.days.map(metricValue);
    const unit = state.metric === 'tokens' ? 'tokens' : 'requests';
    const format = state.metric === 'tokens' ? formatTokens : formatCount;
    const scale = chartScale(values);
    const total = values.reduce((sum, value) => sum + value, 0);
    let peak = -1;
    values.forEach((value, index) => { if (peak < 0 || value > values[peak]) peak = index; });
    const range = formatShortDay(usage.from) + ' to ' + formatDate(usage.to + 'T00:00:00Z');
    const summary = usage.days.length + ' days, ' + range + '. Total ' + format(total) + ' ' + unit +
      (total > 0 ? '. Highest: ' + format(values[peak]) + ' on ' + formatShortDay(usage.days[peak].day) + '.' : '. No usage in this period.');
    setText('usage-chart-caption', (state.metric === 'tokens' ? 'Tokens' : 'Requests') + ' per day, ' + range);
    const chart = svg('svg', {
      viewBox: '0 0 ' + scale.width + ' ' + scale.height, preserveAspectRatio: 'none', role: 'img',
      'aria-labelledby': 'usage-svg-title usage-svg-desc', focusable: 'false',
    },
    svg('title', { id: 'usage-svg-title', text: (state.metric === 'tokens' ? 'Tokens' : 'Requests') + ' per day' }),
    svg('desc', { id: 'usage-svg-desc', text: summary }),
    svg('line', { class: 'zx-axis', x1: 0, y1: scale.height - 0.5, x2: scale.width, y2: scale.height - 0.5 }),
    ...scale.bars.map((bar, index) => ({ bar, day: usage.days[index].day })).filter(({ bar }) => bar.height > 0).map(({ bar, day }) => svg('rect', {
      class: 'zx-bar', x: bar.x.toFixed(2), y: bar.y.toFixed(2), width: bar.width.toFixed(2), height: bar.height.toFixed(2), rx: 2,
    }, svg('title', { text: formatShortDay(day) + ': ' + format(bar.value) + ' ' + unit }))));
    const axis = el('div', { class: 'zx-row zx-row--between zx-help' },
      el('span', { text: formatShortDay(usage.from) }),
      el('span', { text: 'Scale max ' + format(scale.max) + ' ' + unit }),
      el('span', { text: formatShortDay(usage.to) }));
    container.replaceChildren(chart, axis);
    for (const button of doc.querySelectorAll('[data-metric]')) button.setAttribute('aria-pressed', String(button.dataset.metric === state.metric));
  }

  function renderUsage() {
    const usage = state.usage;
    if (!usage) return;
    setText('usage-total-requests', formatCount(usage.totals.requests));
    setText('usage-total-prompt', formatTokens(usage.totals.prompt_tokens));
    setText('usage-total-completion', formatTokens(usage.totals.completion_tokens));
    setText('usage-total-cost', formatUsd(usage.totals.cost_usd));
    renderChart();
    const days = $('usage-days');
    days.replaceChildren(...usage.days.slice().reverse().map(row => el('tr', {},
      el('th', { scope: 'row', text: formatDate(row.day + 'T00:00:00Z') }),
      cell(formatCount(row.requests), 'zx-num'),
      cell(formatCount(row.prompt_tokens), 'zx-num'),
      cell(formatCount(row.completion_tokens), 'zx-num'),
      cell(formatUsd(row.cost_usd), 'zx-num'))));
    const models = $('usage-models');
    models.replaceChildren(...(usage.byModel.length ? usage.byModel.map(row => el('tr', {},
      el('th', { scope: 'row' }, el('code', { text: row.model })),
      cell(formatCount(row.requests), 'zx-num'),
      cell(formatCount(row.prompt_tokens), 'zx-num'),
      cell(formatCount(row.completion_tokens), 'zx-num'),
      cell(formatUsd(row.cost_usd), 'zx-num'))) : [emptyRow(5, 'No requests in the last 30 days.')]));
  }

  async function loadUsage() {
    const current = revision('usage');
    setAlert('usage-error', '');
    try {
      const data = await api('/api/usage');
      if (!current()) return;
      state.usage = normalizeUsage(data, now());
      renderUsage();
    } catch (error) {
      if (current()) handleError(error, 'usage-error', loadUsage);
    }
  }

  function renderEvents(events) {
    const body = $('usage-events');
    body.replaceChildren(...(events.length ? events.map(event => el('tr', {},
      cell(formatDateTime(event.created_at)),
      el('td', {}, el('code', { text: event.model || '—' })),
      cell(event.tier ? badge(event.tier, event.tier === 'paid' ? 'purple' : '') : '—'),
      cell(event.status ? badge(event.status, eventStatusTone(event.status)) : '—'),
      cell(formatCount(event.prompt_tokens + event.completion_tokens), 'zx-num'),
      cell(formatUsd(event.cost_usd), 'zx-num'),
      cell(event.latency_ms !== null ? formatCount(event.latency_ms) + ' ms' : '—', 'zx-num'),
      el('td', {}, el('code', { text: event.request_id || '—' })))) : [emptyRow(8, state.page ? 'No older requests.' : 'No requests yet. Run neuron in a project to get started.')]));
    $('events-newer').disabled = state.page === 0;
    $('events-older').disabled = state.cursors[state.page + 1] == null;
    setText('events-page', 'Page ' + (state.page + 1));
  }

  async function loadEvents(page = 0) {
    const current = revision('events');
    const cursor = state.cursors[page];
    const query = '?limit=' + EVENTS_PAGE_SIZE + (cursor != null ? '&before=' + encodeURIComponent(cursor) : '');
    setAlert('events-error', '');
    try {
      const data = normalizeEvents(await api('/api/usage/events' + query));
      if (!current()) return;
      state.page = page;
      state.cursors = state.cursors.slice(0, page + 1);
      if (data.nextBefore !== null && data.events.length) state.cursors[page + 1] = data.nextBefore;
      renderEvents(data.events);
    } catch (error) {
      if (current()) handleError(error, 'events-error', () => loadEvents(page));
    }
  }

  /* API keys */

  function hideSecret() {
    const box = $('key-secret');
    if (!box) return;
    setText('key-secret-value', '');
    box.hidden = true;
  }

  function renderKeys() {
    const body = $('keys-list');
    const active = state.keys.filter(key => keyStatus(key) === 'active').length;
    body.replaceChildren(...(state.keys.length ? state.keys.map(key => {
      const revoked = keyStatus(key) === 'revoked';
      return el('tr', {},
        el('th', { scope: 'row', text: key.name }),
        el('td', {}, el('code', { text: key.prefix ? key.prefix + '…' : '—' })),
        cell(formatDate(key.created_at)),
        cell(key.last_used_at ? formatDateTime(key.last_used_at) : 'Never'),
        cell(badge(revoked ? 'Revoked' : 'Active', revoked ? '' : 'success')),
        el('td', {}, revoked ? '—' : el('button', {
          class: 'zx-btn zx-btn--danger zx-btn--sm', type: 'button', text: 'Revoke',
          'aria-label': 'Revoke key ' + key.name, 'data-key-id': key.id, onclick: () => revokeKey(key),
        })));
    }) : [emptyRow(6, 'No API keys yet. Create one for CI or headless Neuron runs.')]));
    const full = active >= MAX_ACTIVE_KEYS;
    $('key-create').disabled = full;
    setText('keys-count', active + ' of ' + MAX_ACTIVE_KEYS + ' active keys' + (full ? '. Revoke a key to create another.' : '.'));
  }

  async function loadKeys() {
    const current = revision('keys');
    setAlert('keys-error', '');
    try {
      const data = await api('/api/keys');
      if (!current()) return;
      state.keys = normalizeKeys(data);
      renderKeys();
    } catch (error) {
      if (current()) handleError(error, 'keys-error', loadKeys);
    }
  }

  async function createKey(event) {
    if (event) event.preventDefault();
    const input = $('key-name');
    const result = validateKeyName(input.value);
    setText('key-name-error', result.ok ? '' : result.error);
    input.setAttribute('aria-invalid', String(!result.ok));
    if (!result.ok) { input.focus(); return; }
    const button = $('key-create');
    button.disabled = true;
    setAlert('keys-error', '');
    try {
      const data = await api('/api/keys', { method: 'POST', body: { name: result.name } });
      const secret = data && typeof data.secret === 'string' && /^nzx_[A-Za-z0-9_-]{16,200}$/.test(data.secret) ? data.secret : '';
      if (!secret) throw new ApiError('The key was created but its secret was not returned. Revoke it and try again.', { code: 'invalid_response' });
      input.value = '';
      setText('key-secret-value', secret);
      $('key-secret').hidden = false;
      $('key-secret-copy').focus();
      await loadKeys();
    } catch (error) {
      handleError(error, 'keys-error');
    } finally {
      button.disabled = state.keys.filter(key => keyStatus(key) === 'active').length >= MAX_ACTIVE_KEYS;
    }
  }

  async function revokeKey(key) {
    const confirmed = await confirmAction({
      title: 'Revoke this API key?',
      body: '"' + key.name + '" stops working immediately. Anything using it will get 401 errors.',
      confirm: 'Revoke key',
    });
    if (!confirmed) return;
    try {
      await api('/api/keys/' + encodeURIComponent(key.id), { method: 'DELETE' });
      toast('API key "' + key.name + '" revoked.');
      await loadKeys();
    } catch (error) {
      handleError(error, 'keys-error');
    }
  }

  /* Billing */

  function topupCurrency() {
    return normalizeCurrency($('topup-currency') ? $('topup-currency').value : 'USD');
  }

  // Credits are spent only on paid pools, so top-ups need a plan with the paid tier (the API
  // refuses them on Free too). Unknown while the account is still loading.
  function topupsAllowed() {
    const planId = state.account && state.account.plan ? state.account.plan.id : null;
    const plan = planId ? state.catalog.plans.find(item => item.id === planId) : null;
    return Boolean(plan && Array.isArray(plan.tiers) && plan.tiers.includes('paid'));
  }

  function renderTopups() {
    const currency = topupCurrency();
    const allowed = topupsAllowed() && !state.paymentLocked;
    for (const button of doc.querySelectorAll('[data-topup]')) {
      const pack = state.catalog.topups.find(item => item.id === button.dataset.topup);
      if (!pack) { button.hidden = true; continue; }
      const price = formatMoney(currency === 'INR' ? pack.price.inr_paise : pack.price.usd_cents, currency);
      button.textContent = 'Add ' + formatUsd(pack.credit_usd).replace('.00', '') + ' credit for ' + price;
      button.disabled = !allowed;
    }
    const note = $('topup-note');
    if (note) {
      const needsPlan = Boolean(state.account) && !topupsAllowed();
      note.hidden = !needsPlan;
      note.replaceChildren(...(needsPlan ? ['Top-ups need an active Pro or Max plan. ',
        el('a', { href: siteUrl('/pricing', host()), text: 'See plans' })] : []));
    }
  }

  function renderBilling() {
    const billing = state.billing;
    if (!billing) return;
    $('billing-notice').hidden = billing.providerConfigured;
    const sub = billing.subscription;
    const summary = subscriptionSummary(sub);
    const planId = sub && sub.plan ? sub.plan : state.account ? state.account.plan.id : 'free';
    const plan = state.catalog.plans.find(item => item.id === planId);
    setText('sub-plan', plan ? plan.name : titleCase(planId));
    const status = $('sub-status');
    status.replaceChildren(badge(summary.label, summary.tone));
    setText('sub-period-label', summary.periodLabel || 'Period');
    setText('sub-period', summary.periodText || '—');
    setText('sub-note', !sub ? 'You are on the Free plan. Upgrade for higher limits and paid-capacity models.'
      : sub.cancel_at_period_end ? 'Your plan will not renew. You keep access until the date above.'
        : summary.label === 'Payment issue' ? 'Razorpay could not collect the last payment. Update your payment method from the Razorpay email or cancel.'
          : summary.label === 'Awaiting payment' ? 'Checkout started. If you paid, your plan activates as soon as Razorpay confirms the payment; otherwise finish checkout from Pricing.'
            : summary.active ? 'Cancel any time. Access continues until the end of the paid period.' : '');
    $('sub-cancel').hidden = !summary.canCancel;
    // While a cancellation is scheduled the subscription is still live (checkout answers
    // already_subscribed), so plans are offered again only once it has ended.
    $('sub-upgrade').hidden = summary.active;
    if (sub && sub.cancel_at_period_end && summary.active) {
      setText('sub-note', 'Your plan will not renew. You keep access until the date above and can subscribe again after it ends.');
    }
    if (state.paymentLock) setText('billing-status', describeError(state.paymentLock));
    const body = $('payments-list');
    body.replaceChildren(...(billing.payments.length ? billing.payments.map(payment => el('tr', {},
      el('th', { scope: 'row', text: formatDate(payment.created_at) }),
      cell(payment.kind === 'topup' ? 'Credit top-up' : 'Subscription'),
      cell(formatMinor(payment.amount_minor, payment.currency), 'zx-num'),
      cell(payment.status ? badge(titleCase(payment.status), paymentStatusTone(payment.status)) : '—'),
      // The Razorpay payment ID (pay_…) that the refund and contact pages ask for.
      el('td', {}, payment.id ? el('code', { text: payment.id }) : '—',
        payment.id ? el('button', { type: 'button', class: 'zx-btn zx-btn--sm', 'aria-label': 'Copy payment ID ' + payment.id,
          text: 'Copy', onclick: () => copyText(payment.id, 'Payment ID') }) : null),
      el('td', {}, payment.invoice_url
        ? el('a', { href: payment.invoice_url, target: '_blank', rel: 'noopener noreferrer', text: 'Invoice' })
        : '—'))) : [emptyRow(6, 'No payments yet.')]));
    renderTopups();
  }

  async function loadBilling() {
    const current = revision('billing');
    setAlert('billing-error', '');
    try {
      const [billing, plans] = await Promise.all([
        api('/api/billing'),
        apiFetch('/api/plans', { fetchImpl, timeoutMs: 8000 }).catch(() => null),
      ]);
      if (!current()) return;
      const catalog = normalizeCatalog(plans);
      if (catalog) state.catalog = { ...catalog, topups: catalog.topups.length ? catalog.topups : PLAN_CATALOG.topups };
      state.billing = normalizeBilling(billing);
      releasePaymentLock();
      renderBilling();
    } catch (error) {
      if (current()) handleError(error, 'billing-error', loadBilling);
    }
  }

  async function cancelSubscription() {
    const confirmed = await confirmAction({
      title: 'Cancel your subscription?',
      body: 'Your plan stays active until the end of the current paid period and will not renew. You will not be charged again.',
      confirm: 'Cancel subscription',
    });
    if (!confirmed) return;
    const button = $('sub-cancel');
    button.disabled = true;
    try {
      const result = await api('/api/billing/cancel', { method: 'POST', body: {} });
      const end = formatDate(result && result.current_period_end);
      setText('billing-status', 'Cancellation scheduled. You keep your plan until ' + end + '.');
      await Promise.all([loadBilling(), loadAccount()]);
    } catch (error) {
      handleError(error, 'billing-error');
    } finally {
      button.disabled = false;
    }
  }

  function lockPayments(error) {
    state.paymentLocked = true;
    state.paymentLock = error;
    rememberPaymentLock(win, error, now());
  }

  // A remembered lock ends once Billing lists its payment with a final status.
  function releasePaymentLock() {
    const lock = state.paymentLock;
    if (!lock || !lock.paymentId || !state.billing) return;
    const payment = state.billing.payments.find(entry => entry.id === lock.paymentId);
    if (!payment || !['captured', 'refunded', 'failed'].includes(payment.status)) return;
    clearPaymentLock(win);
    state.paymentLocked = false;
    state.paymentLock = null;
    setText('billing-status', '');
  }

  async function buyTopup(pack) {
    if (!topupsAllowed() || state.paymentLocked) { renderTopups(); return; }
    const buttons = Array.from(doc.querySelectorAll('[data-topup]'));
    buttons.forEach(button => { button.disabled = true; });
    setAlert('billing-error', '');
    try {
      await startTopup({ pack, currency: topupCurrency(), auth: getAuth(), fetchImpl, win, doc, onStatus: message => setText('billing-status', message) });
      setText('billing-status', 'Payment confirmed. Credits have been added to your balance.');
      toast('Credits added.');
      await Promise.all([loadBilling(), loadAccount()]);
    } catch (error) {
      if (error && error.code === 'checkout_dismissed') setText('billing-status', describeError(error));
      else if (error && PAYMENT_LOCK_CODES.includes(error.code)) {
        // Razorpay took the payment: never offer a retry (or a sign-in that leads to one), and keep
        // purchases locked across reloads until Billing shows the payment confirmed.
        lockPayments(error);
        setText('billing-status', '');
        setAlert('billing-error', describeError(error));
      } else { setText('billing-status', ''); handleError(error, 'billing-error'); }
    } finally {
      renderTopups();
    }
  }

  /* Sessions and sign out */

  async function revokeSessions() {
    const withKeys = Boolean($('sessions-keys') && $('sessions-keys').checked);
    const confirmed = await confirmAction({
      title: withKeys ? 'Sign out all CLI sessions and revoke every API key?' : 'Sign out all CLI sessions?',
      body: withKeys ? 'Every computer signed in with neuron auth login is signed out and every API key stops working.'
        : 'Every computer signed in with neuron auth login is signed out. API keys keep working.',
      confirm: withKeys ? 'Sign out and revoke keys' : 'Sign out everywhere',
    });
    if (!confirmed) return;
    const button = $('sessions-revoke');
    button.disabled = true;
    setAlert('sessions-error', '');
    try {
      const result = await api('/api/sessions/revoke-all', { method: 'POST', body: withKeys ? { api_keys: true } : {} });
      const count = toNumber(result && result.revoked) || 0;
      const keys = toNumber(result && result.api_keys_revoked);
      setText('sessions-status', 'Signed out ' + formatCount(count) + ' CLI session' + (count === 1 ? '' : 's') +
        (withKeys && keys !== null ? ' and revoked ' + formatCount(keys) + ' API key' + (keys === 1 ? '' : 's') : '') +
        '. Run neuron auth login on each computer you still use.');
      if (withKeys) state.loaded.delete('keys'); // the API keys tab reloads when opened
    } catch (error) {
      handleError(error, 'sessions-error');
    } finally {
      button.disabled = false;
    }
  }

  function clearDevToken() {
    try { if (win.sessionStorage) win.sessionStorage.removeItem(DEV_TOKEN_KEY); }
    catch { /* Storage may be blocked. */ }
  }

  async function signOut() {
    clearDevToken();
    const button = $('acct-signout');
    button.disabled = true;
    setAlert('account-error', '');
    try {
      await getAuth().signOut({ redirectUrl: siteUrl('/', host()) });
    } catch (error) {
      setAlert('account-error', (error && error.message) || 'Sign out failed. Try again.');
      button.disabled = false;
    }
  }

  /* Tabs */

  const loaders = {
    overview: () => (state.account ? Promise.resolve() : loadAccount()),
    usage: () => Promise.all([loadUsage(), loadEvents(0)]),
    keys: loadKeys,
    billing: () => loadBilling(),
    sessions: () => Promise.resolve(),
    account: () => (state.account ? Promise.resolve() : loadAccount()),
  };

  async function showTab(tab, { focus = false } = {}) {
    state.tab = tab;
    for (const id of TABS) {
      const active = id === tab;
      const button = $('tab-' + id);
      button.setAttribute('aria-selected', String(active));
      button.setAttribute('tabindex', active ? '0' : '-1');
      $('panel-' + id).hidden = !active;
    }
    if (tab !== 'keys') hideSecret();
    if (focus) $('tab-' + tab).focus();
    if (!state.loaded.has(tab)) {
      state.loaded.add(tab);
      await loaders[tab]();
    }
  }

  function navigate(tab, focus) {
    if (win.location.hash === '#' + tab) return showTab(tab, { focus });
    win.location.hash = '#' + tab; // hashchange calls showTab
    if (focus) $('tab-' + tab).focus();
    return Promise.resolve();
  }

  function bind() {
    for (const id of TABS) $('tab-' + id).addEventListener('click', () => navigate(id, false));
    $('dash-tabs').addEventListener('keydown', event => {
      const target = nextTab(state.tab, event.key);
      if (!target) return;
      event.preventDefault();
      navigate(target, true);
    });
    win.addEventListener('hashchange', () => {
      // Only tab hashes route; other fragments (the skip link's #main) keep the current tab.
      const id = String(win.location.hash || '').slice(1);
      if (!state.gated && TABS.includes(id) && id !== state.tab) showTab(id);
    });
    $('gate-signin').addEventListener('click', async () => {
      setAlert('gate-error', '');
      try {
        await getAuth().openAuthModal({ title: 'Sign in', subtitle: 'to open your Zero-X dashboard' });
      } catch (error) {
        setAlert('gate-error', (error && error.message) || 'Sign-in could not open. Refresh and try again.');
      }
    });
    $('ov-refresh').addEventListener('click', loadAccount);
    $('usage-refresh').addEventListener('click', () => Promise.all([loadUsage(), loadEvents(0)]));
    $('events-older').addEventListener('click', () => loadEvents(state.page + 1));
    $('events-newer').addEventListener('click', () => loadEvents(Math.max(0, state.page - 1)));
    for (const button of doc.querySelectorAll('[data-metric]')) {
      button.addEventListener('click', () => { state.metric = button.dataset.metric === 'tokens' ? 'tokens' : 'requests'; renderChart(); });
    }
    $('key-form').addEventListener('submit', createKey);
    $('key-secret-copy').addEventListener('click', () => copyText($('key-secret-value').textContent, 'API key'));
    $('key-secret-done').addEventListener('click', () => { hideSecret(); $('key-name').focus(); });
    $('billing-refresh').addEventListener('click', loadBilling);
    $('sub-cancel').addEventListener('click', cancelSubscription);
    $('topup-currency').addEventListener('change', renderTopups);
    for (const button of doc.querySelectorAll('[data-topup]')) button.addEventListener('click', () => buyTopup(button.dataset.topup));
    $('sessions-revoke').addEventListener('click', revokeSessions);
    $('acct-signout').addEventListener('click', signOut);
    for (const button of doc.querySelectorAll('[data-copy-target]')) {
      button.addEventListener('click', () => {
        const target = $(button.dataset.copyTarget);
        if (target) copyText(target.textContent.trim(), button.dataset.copyLabel || 'Command');
      });
    }
    for (const link of doc.querySelectorAll('a[data-site-path]')) link.setAttribute('href', siteUrl(link.dataset.sitePath, host()));
  }

  async function boot() {
    bind();
    const client = getAuth();
    if (!client) { showGate('Sign-in could not load. Refresh the page to try again.'); return; }
    let profile = null;
    try {
      await client.init();
      profile = await client.getProfile();
    } catch {
      showGate('Sign-in is temporarily unavailable. Try again in a moment.');
      return;
    }
    if (typeof client.onAuthStateChange === 'function') {
      client.onAuthStateChange(({ event }) => {
        if (event === 'SIGNED_OUT') { state.profile = null; showGate(''); }
        else if (event === 'SIGNED_IN' && state.gated && win.location && typeof win.location.reload === 'function') win.location.reload();
      });
    }
    if (!profile) { showGate(''); return; }
    state.profile = profile;
    state.gated = false;
    const lock = readPaymentLock(win, now());
    if (lock) { state.paymentLocked = true; state.paymentLock = lock; }
    $('dash-loading').hidden = true;
    $('dash-gate').hidden = true;
    $('dash-app').hidden = false;
    renderProfile();
    renderTopups();
    await loadAccount();
    state.loaded.add('overview');
    state.loaded.add('account');
    await showTab(parseTab(win.location.hash));
  }

  return {
    boot, showTab, loadAccount, loadUsage, loadEvents, loadKeys, createKey, revokeKey, loadBilling,
    cancelSubscription, buyTopup, revokeSessions, signOut,
    get state() { return state; },
  };
}

if (typeof document !== 'undefined' && typeof window !== 'undefined' && document.querySelector('[data-dashboard-root]')) {
  createDashboard().boot();
}

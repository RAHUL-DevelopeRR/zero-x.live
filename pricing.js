// Pricing page: static plan catalog (contract §1), currency toggle, hydration from GET /api/plans,
// and upgrade/top-up buttons that run the Razorpay checkout in billing-checkout.js.
import {
  ApiError, PAYMENT_LOCK_CODES, SUPPORT_EMAIL, apiFetch, dashboardUrl, describeError, normalizeCurrency, readPaymentLock,
  rememberPaymentLock, siteUrl, startSubscription, startTopup,
} from './billing-checkout.js';

/** Mirrors PLATFORM_CONTRACT.md §1 and the GET /api/plans shape; used until the API responds. */
export const PLAN_CATALOG = Object.freeze({
  currency_default: 'USD',
  plans: [
    {
      id: 'free', name: 'Free', price: { usd_cents: 0, inr_paise: 0 }, interval: 'month',
      limits: { daily_requests: 100, daily_tokens: 500000, rpm: 10, concurrency: 2 },
      monthly_credit_usd: 0, tiers: ['free'], highlighted: false,
      features: ['Shared free model pools', '100 requests and 500K tokens per day', 'Best-effort availability'],
    },
    {
      id: 'pro', name: 'Pro', price: { usd_cents: 1000, inr_paise: 89900 }, interval: 'month',
      limits: { daily_requests: 2000, daily_tokens: 10000000, rpm: 30, concurrency: 4 },
      monthly_credit_usd: 8, tiers: ['free', 'paid'], highlighted: true,
      features: ['Free pools plus paid-capacity models', '2,000 requests and 10M tokens per day', '$8 of credits included every month'],
    },
    {
      id: 'max', name: 'Max', price: { usd_cents: 4000, inr_paise: 349900 }, interval: 'month',
      limits: { daily_requests: 10000, daily_tokens: 50000000, rpm: 60, concurrency: 8 },
      monthly_credit_usd: 35, tiers: ['free', 'paid'], highlighted: false,
      features: ['Free pools plus paid-capacity models', '10,000 requests and 50M tokens per day', '$35 of credits included every month'],
    },
  ],
  topups: [
    { id: 'credits_5', credit_usd: 5, price: { usd_cents: 500, inr_paise: 44900 } },
    { id: 'credits_20', credit_usd: 20, price: { usd_cents: 2000, inr_paise: 174900 } },
  ],
});

export const CURRENCY_STORAGE_KEY = 'zx-currency';
export const PENDING_CHECKOUT_KEY = 'zx-pending-checkout';
const PENDING_TTL_MS = 15 * 60 * 1000;
const ID_PATTERN = /^[a-z0-9_-]{1,32}$/;

const formatters = new Map();
function currencyFormatter(currency, fractionDigits) {
  const key = currency + fractionDigits;
  if (!formatters.has(key)) {
    formatters.set(key, new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', {
      style: 'currency', currency, minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits,
    }));
  }
  return formatters.get(key);
}

/** 1000 USD cents → "$10"; 89900 INR paise → "₹899"; 1050 → "$10.50". */
export function formatMoney(minor, currency) {
  const cur = normalizeCurrency(currency);
  if (!Number.isFinite(minor)) return '—';
  const whole = Math.round(minor) % 100 === 0;
  return currencyFormatter(cur, whole ? 0 : 2).format(Math.round(minor) / 100);
}

export function formatCount(value) {
  return Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : '—';
}

/** 500000 → "500K", 10000000 → "10M", 1500000 → "1.5M". */
export function formatTokens(value) {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const scale = abs >= 1e9 ? [1e9, 'B'] : abs >= 1e6 ? [1e6, 'M'] : abs >= 1e3 ? [1e3, 'K'] : [1, ''];
  const scaled = value / scale[0];
  const rounded = scaled >= 100 || Number.isInteger(scaled) ? Math.round(scaled) : Math.round(scaled * 10) / 10;
  return rounded + scale[1];
}

export function formatUsdAmount(value) {
  return Number.isFinite(value) ? formatMoney(Math.round(value * 100), 'USD') : '—';
}

export function planPrice(plan, currency) {
  if (!plan || !plan.price) return NaN;
  return normalizeCurrency(currency) === 'INR' ? plan.price.inr_paise : plan.price.usd_cents;
}

export function priceLabel(plan, currency) {
  return formatMoney(planPrice(plan, currency), currency);
}

/** Stored choice, then India time zone → INR, then the API default. */
export function defaultCurrency({ stored, timeZone, fallback } = {}) {
  if (stored === 'USD' || stored === 'INR') return stored;
  if (timeZone === 'Asia/Kolkata' || timeZone === 'Asia/Calcutta') return 'INR';
  return normalizeCurrency(fallback);
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function amount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function strings(value, max) {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim().slice(0, 140)).slice(0, max) : [];
}

/** Validates GET /api/plans. Returns null when the payload is unusable so callers keep the static catalog. */
export function normalizeCatalog(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.plans)) return null;
  const plans = [];
  for (const raw of data.plans) {
    if (!raw || typeof raw !== 'object' || !ID_PATTERN.test(raw.id || '')) continue;
    const price = { usd_cents: count(raw.price && raw.price.usd_cents), inr_paise: count(raw.price && raw.price.inr_paise) };
    if (price.usd_cents === null || price.inr_paise === null) continue;
    const limits = raw.limits && typeof raw.limits === 'object' ? raw.limits : {};
    plans.push({
      id: raw.id,
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 40) : raw.id,
      price,
      interval: raw.interval === 'year' ? 'year' : 'month',
      limits: {
        daily_requests: count(limits.daily_requests), daily_tokens: count(limits.daily_tokens),
        rpm: count(limits.rpm), concurrency: count(limits.concurrency),
      },
      monthly_credit_usd: amount(raw.monthly_credit_usd),
      tiers: strings(raw.tiers, 4),
      features: strings(raw.features, 8),
      highlighted: raw.highlighted === true,
    });
  }
  if (!plans.length) return null;
  const topups = [];
  for (const raw of Array.isArray(data.topups) ? data.topups : []) {
    if (!raw || typeof raw !== 'object' || !/^credits_[0-9]{1,6}$/.test(raw.id || '')) continue;
    const price = { usd_cents: count(raw.price && raw.price.usd_cents), inr_paise: count(raw.price && raw.price.inr_paise) };
    if (price.usd_cents === null || price.inr_paise === null) continue;
    topups.push({ id: raw.id, credit_usd: amount(raw.credit_usd), price });
  }
  return { currency_default: normalizeCurrency(data.currency_default), plans, topups };
}

export function findPlan(catalog, id) {
  return (catalog && catalog.plans || []).find(plan => plan.id === id) || null;
}

export function findTopup(catalog, id) {
  return (catalog && catalog.topups || []).find(pack => pack.id === id) || null;
}

/** Text for a [data-plan-limit="plan:field"] element. */
export function limitLabel(plan, field) {
  const value = plan && plan.limits ? plan.limits[field] : null;
  if (value === null || value === undefined) return null;
  return field === 'daily_tokens' ? formatTokens(value) : formatCount(value);
}

function safeStorage(win, kind) {
  try { return win && win[kind] ? win[kind] : null; }
  catch { return null; }
}

function storageGet(storage, key) {
  try { return storage ? storage.getItem(key) : null; }
  catch { return null; }
}

function storageSet(storage, key, value) {
  try { if (storage) storage.setItem(key, value); }
  catch { /* Preference storage is optional. */ }
}

function storageRemove(storage, key) {
  try { if (storage) storage.removeItem(key); }
  catch { /* Preference storage is optional. */ }
}

export function readPendingCheckout(storage, now = Date.now()) {
  let pending = null;
  try { pending = JSON.parse(storageGet(storage, PENDING_CHECKOUT_KEY) || 'null'); }
  catch { pending = null; }
  if (!pending || !['plan', 'topup'].includes(pending.kind) || !ID_PATTERN.test(pending.id || '') ||
      !Number.isFinite(pending.created) || now - pending.created > PENDING_TTL_MS || pending.created > now + 60000) return null;
  return { kind: pending.kind, id: pending.id, currency: normalizeCurrency(pending.currency) };
}

/**
 * Pricing controller. `root` is any element carrying [data-pricing-root]; buttons and price slots inside it
 * are found by data attributes so the same module hydrates the pricing page and the Neuron CLI teaser.
 */
export function createPricingPage({ doc = globalThis.document, win = globalThis.window, auth, fetchImpl, now = () => Date.now() } = {}) {
  const getAuth = () => auth || (win && win.ZeroXAuth) || null;
  const local = safeStorage(win, 'localStorage');
  const session = safeStorage(win, 'sessionStorage');
  const statusEl = doc.getElementById('pricing-status');
  const errorEl = doc.getElementById('pricing-error');
  let catalog = PLAN_CATALOG;
  let busy = false;
  let locked = false; // set while a payment Razorpay took is not confirmed (also after a reload)
  let currency = defaultCurrency({
    stored: storageGet(local, CURRENCY_STORAGE_KEY),
    timeZone: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return ''; } })(),
    fallback: PLAN_CATALOG.currency_default,
  });

  const all = selector => Array.from(doc.querySelectorAll(selector));

  function setStatus(message) {
    if (statusEl) statusEl.textContent = message || '';
  }

  function setError(message, link) {
    if (!errorEl) return;
    errorEl.replaceChildren();
    if (!message) return;
    const paragraph = doc.createElement('p');
    paragraph.textContent = message;
    if (link) {
      const anchor = doc.createElement('a');
      anchor.href = link.href;
      anchor.textContent = link.label;
      paragraph.append(' ', anchor);
    }
    errorEl.append(paragraph);
  }

  function render() {
    for (const button of all('[data-currency]')) button.setAttribute('aria-pressed', String(button.dataset.currency === currency));
    for (const plan of catalog.plans) {
      for (const el of all(`[data-plan-price="${plan.id}"]`)) el.textContent = priceLabel(plan, el.dataset.priceCurrency || currency);
      for (const el of all(`[data-plan-credit="${plan.id}"]`)) {
        if (plan.monthly_credit_usd !== null) el.textContent = formatUsdAmount(plan.monthly_credit_usd);
      }
      for (const el of all('[data-plan-limit]')) {
        const [id, field] = String(el.dataset.planLimit).split(':');
        if (id !== plan.id) continue;
        const label = limitLabel(plan, field);
        if (label !== null) el.textContent = label;
      }
      if (plan.features.length) {
        for (const list of all(`[data-plan-features="${plan.id}"]`)) {
          list.replaceChildren(...plan.features.map(feature => {
            const item = doc.createElement('li');
            item.textContent = feature;
            return item;
          }));
        }
      }
    }
    for (const pack of catalog.topups) {
      for (const el of all(`[data-topup-price="${pack.id}"]`)) {
        const cur = el.dataset.priceCurrency || currency;
        el.textContent = formatMoney(planPrice(pack, cur), cur);
      }
      for (const el of all(`[data-topup-credit="${pack.id}"]`)) {
        if (pack.credit_usd !== null) el.textContent = formatUsdAmount(pack.credit_usd);
      }
    }
    for (const el of all('[data-currency-label]')) el.textContent = currency;
  }

  function setCurrency(value) {
    currency = normalizeCurrency(value);
    storageSet(local, CURRENCY_STORAGE_KEY, currency);
    render();
  }

  async function hydrate() {
    try {
      const data = normalizeCatalog(await apiFetch('/api/plans', { fetchImpl, timeoutMs: 8000 }));
      if (!data) return false;
      // Only update plans the page already describes; unknown or legacy plans (e.g. ultrawork) stay hidden.
      catalog = {
        currency_default: data.currency_default,
        plans: PLAN_CATALOG.plans.map(plan => findPlan(data, plan.id) || plan),
        topups: PLAN_CATALOG.topups.map(pack => findTopup(data, pack.id) || pack),
      };
      render();
      return true;
    } catch {
      return false; // The static catalog already matches the contract.
    }
  }

  function setBusy(value) {
    busy = value;
    for (const button of all('[data-upgrade], [data-topup]')) {
      button.disabled = value || locked;
      if (value) button.setAttribute('aria-busy', 'true');
      else button.removeAttribute('aria-busy');
    }
  }

  async function signedInProfile() {
    const client = getAuth();
    if (!client) throw new ApiError('Sign-in is unavailable right now. Refresh the page and try again.', { code: 'auth_unavailable' });
    await client.init();
    return client.getProfile();
  }

  // The checkout intent lives in localStorage (15-minute TTL) so it survives zerox-auth's reload
  // after dev or SMS sign-in and reaches the new tab an email magic link opens. It is removed
  // once Razorpay opens or the checkout ends with an error, never merely because sign-in fired.
  const clearPending = () => { storageRemove(local, PENDING_CHECKOUT_KEY); storageRemove(session, PENDING_CHECKOUT_KEY); };

  async function requireSignIn(intent, planName) {
    storageSet(local, PENDING_CHECKOUT_KEY, JSON.stringify({ ...intent, currency, created: now() }));
    setStatus('Sign in to continue to checkout.');
    await getAuth().openAuthModal({
      title: 'Sign in to continue',
      subtitle: planName ? 'Then we will open ' + planName + ' checkout' : 'Then we will open checkout',
    });
  }

  function lockPurchases(error) {
    locked = true;
    rememberPaymentLock(win, error, now());
    setBusy(busy);
    const host = win && win.location ? win.location.hostname : '';
    setError(describeError(error), { href: dashboardUrl('#billing', host), label: 'Open billing' });
  }

  function handleFailure(error, intent, planName) {
    const host = win && win.location ? win.location.hostname : '';
    setStatus('');
    if (!(error && error.code === 'invalid_session')) clearPending();
    if (error && PAYMENT_LOCK_CODES.includes(error.code)) {
      // Razorpay already took the payment: no retry, no new checkout, buttons stay locked, here
      // and on reloads, until the dashboard sees the payment confirmed (or 30 minutes pass).
      lockPurchases(error);
      return;
    }
    if (error && (error.code === 'checkout_in_progress' || error.code === 'duplicate_refunded')) {
      setError(describeError(error), { href: dashboardUrl('#billing', host), label: 'Open billing' });
      return;
    }
    if (error && error.code === 'checkout_dismissed') { setStatus(describeError(error)); return; }
    if (error && (error.code === 'topup_requires_plan' || error.code === 'upgrade_required')) {
      setError(describeError(error), { href: siteUrl('/pricing#plans', host), label: 'Compare plans' });
      return;
    }
    if (error && error.code === 'already_subscribed') {
      setError(describeError(error), { href: dashboardUrl('#billing', host), label: 'Open billing' });
      return;
    }
    if (error && error.code === 'billing_not_configured') {
      setError(describeError(error), { href: 'mailto:' + SUPPORT_EMAIL, label: SUPPORT_EMAIL });
      return;
    }
    if (error && error.code === 'invalid_session') {
      setError(describeError(error));
      requireSignIn(intent, planName).catch(() => {});
      return;
    }
    setError(describeError(error));
  }

  // Credits are spent only on paid pools, so top-ups need a plan with the paid tier.
  async function requirePaidPlan() {
    const account = await apiFetch('/api/account', { auth: getAuth(), fetchImpl, timeoutMs: 8000 });
    const planId = account && account.plan && typeof account.plan.id === 'string' ? account.plan.id : 'free';
    const plan = findPlan(catalog, planId);
    if (!plan || !Array.isArray(plan.tiers) || !plan.tiers.includes('paid')) {
      throw new ApiError('Credit top-ups need an active Pro or Max plan.', { code: 'topup_requires_plan' });
    }
  }

  async function checkout(intent) {
    if (busy || locked) return;
    const plan = intent.kind === 'plan' ? findPlan(catalog, intent.id) : null;
    const pack = intent.kind === 'topup' ? findTopup(catalog, intent.id) : null;
    if (!plan && !pack) return;
    const planName = plan ? plan.name : '';
    setError('');
    setBusy(true);
    try {
      let profile;
      try { profile = await signedInProfile(); }
      catch { throw new ApiError('Sign-in is unavailable right now. Try again shortly.', { code: 'auth_unavailable' }); }
      if (!profile) {
        setBusy(false);
        await requireSignIn(intent, planName);
        return;
      }
      const deps = { auth: getAuth(), fetchImpl, win, doc, onStatus: setStatus, onOpen: clearPending };
      if (plan) await startSubscription({ plan: plan.id, currency, ...deps });
      else {
        await requirePaidPlan();
        await startTopup({ pack: pack.id, currency, ...deps });
      }
      setStatus('Payment confirmed. Opening your dashboard…');
      win.location.assign(dashboardUrl('#billing', win.location.hostname));
    } catch (error) {
      handleFailure(error, intent, planName);
    } finally {
      setBusy(false);
    }
  }

  async function resumePending() {
    const pending = readPendingCheckout(local, now()) || readPendingCheckout(session, now());
    if (!pending) return false;
    let profile = null;
    try { profile = await signedInProfile(); }
    catch { return false; }
    if (!profile) return false;
    currency = pending.currency;
    render();
    await checkout({ kind: pending.kind, id: pending.id });
    return true;
  }

  function bind() {
    for (const button of all('[data-currency]')) button.addEventListener('click', () => setCurrency(button.dataset.currency));
    for (const button of all('[data-upgrade]')) button.addEventListener('click', () => checkout({ kind: 'plan', id: button.dataset.upgrade }));
    for (const button of all('[data-topup]')) button.addEventListener('click', () => checkout({ kind: 'topup', id: button.dataset.topup }));
    const client = getAuth();
    if (client && typeof client.onAuthStateChange === 'function') {
      // zerox-auth reloads (or navigates) right after dev and SMS sign-in: the reloaded page
      // resumes from storage in init(), so this document must not start a checkout it abandons.
      client.onAuthStateChange(change => {
        const navigating = Boolean(change && change.navigating) ||
          (typeof client.isNavigating === 'function' && client.isNavigating());
        if (change && change.event === 'SIGNED_IN' && !navigating) resumePending().catch(() => {});
      });
    }
  }

  async function init() {
    bind();
    render();
    const lock = readPaymentLock(win, now());
    if (lock) lockPurchases(lock);
    await hydrate();
    if (all('[data-upgrade], [data-topup]').length) await resumePending().catch(() => false);
  }

  return {
    init, render, hydrate, setCurrency, checkout, resumePending,
    get currency() { return currency; },
    get catalog() { return catalog; },
  };
}

if (typeof document !== 'undefined' && typeof window !== 'undefined' && document.querySelector('[data-pricing-root]')) {
  createPricingPage().init();
}

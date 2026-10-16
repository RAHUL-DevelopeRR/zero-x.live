// Zero-X browser API client and Razorpay checkout flow.
// Contract: neuroncli/auth-server/docs/PLATFORM_CONTRACT.md §3.3 (errors), §3.4 (account), §3.5 (billing).
// Every value that comes back from the API is treated as untrusted data by callers (textContent only).

export const RAZORPAY_CHECKOUT_SRC = 'https://checkout.razorpay.com/v1/checkout.js';
export const SUPPORT_EMAIL = 'support@zero-x.live';
export const PRICING_URL = 'https://zero-x.live/pricing';
export const DASHBOARD_URL = 'https://dashboard.zero-x.live/';
export const CHECKOUT_THEME_COLOR = '#00E5FF';

const API_PATH = /^\/(?:api|v1|auth)\/[A-Za-z0-9/_.?=&%-]*$/;
const RAZORPAY_KEY = /^rzp_(?:live|test)_[A-Za-z0-9]{6,64}$/;
const PROVIDER_ID = /^[A-Za-z0-9_-]{4,128}$/;
const PACK_ID = /^credits_[0-9]{1,6}$/;

const FRIENDLY_MESSAGES = {
  invalid_session: 'Your sign-in has expired. Sign in again to continue.',
  already_subscribed: 'You already have an active subscription. Manage or cancel it from the Billing tab in your dashboard.',
  billing_not_configured: 'Online payments are not enabled yet. Email ' + SUPPORT_EMAIL + ' and we will upgrade your account manually.',
  checkout_dismissed: 'Checkout closed. You have not been charged.',
  checkout_unavailable: 'The payment window could not load. Allow checkout.razorpay.com in your content blocker and try again.',
  payment_unverified: 'We could not confirm the payment in your browser. If you were charged, it will appear in Billing within a few minutes; otherwise email ' + SUPPORT_EMAIL + ' with your payment ID.',
  network_error: 'Could not reach Zero-X. Check your connection and try again.',
  timeout: 'Zero-X took too long to respond. Try again.',
  account_suspended: 'This account is suspended. Email ' + SUPPORT_EMAIL + ' for help.',
};

export class ApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = Number.isInteger(details.status) ? details.status : 0;
    this.code = typeof details.code === 'string' ? details.code : '';
    this.type = typeof details.type === 'string' ? details.type : '';
    this.upgradeUrl = safeHttpsUrl(details.upgrade_url);
    this.retryAfterSeconds = nonNegativeInteger(details.retry_after_seconds);
    this.resetsAt = typeof details.resets_at === 'string' ? details.resets_at : '';
    this.requestId = typeof details.request_id === 'string' ? details.request_id : '';
  }
}

function nonNegativeInteger(value) {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return Number.isFinite(number) && number >= 0 ? Math.ceil(number) : null;
}

function text(value, max = 300) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/** Returns an https URL string, or '' for anything else (javascript:, data:, relative, malformed). */
export function safeHttpsUrl(value) {
  if (typeof value !== 'string' || !value) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

export function isLoopbackHost(hostname) {
  return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(String(hostname || ''));
}

/** Link to the marketing site: same-origin paths locally, the canonical host in production. */
export function siteUrl(path, hostname) {
  const clean = '/' + String(path || '').replace(/^\/+/, '');
  return isLoopbackHost(hostname) ? clean : 'https://zero-x.live' + (clean === '/' ? '/' : clean);
}

/** Link to the account dashboard with an optional tab hash such as '#billing'. */
export function dashboardUrl(hash, hostname) {
  const fragment = /^#[a-z]{1,20}$/.test(hash || '') ? hash : '';
  return (isLoopbackHost(hostname) ? '/dashboard' : DASHBOARD_URL) + fragment;
}

export function normalizeCurrency(value) {
  return String(value || '').toUpperCase() === 'INR' ? 'INR' : 'USD';
}

/** Builds an ApiError from an OpenAI-shaped error body (contract §3.3) or a legacy {error:'text'} body. */
export function parseApiError(status, body, retryAfterHeader) {
  const payload = body && typeof body === 'object' ? body : {};
  const error = payload.error;
  let details = { status };
  let message = '';
  if (error && typeof error === 'object') {
    details = { ...error, status };
    message = text(error.message);
  } else if (typeof error === 'string') {
    details = { status, code: payload.code };
    message = text(payload.message) || text(error);
  }
  if (details.retry_after_seconds == null && retryAfterHeader) details.retry_after_seconds = retryAfterHeader;
  if (!details.code) {
    if (status === 401) details.code = 'invalid_session';
    else if (status === 429) details.code = 'rate_limited';
  }
  if (!message) message = status >= 500 ? 'Zero-X is temporarily unavailable. Try again shortly.' : 'The request could not be completed.';
  return new ApiError(message, details);
}

/** A user-facing sentence for any thrown value. */
export function describeError(error) {
  if (!error) return 'Something went wrong. Try again.';
  if (error.code && FRIENDLY_MESSAGES[error.code]) return FRIENDLY_MESSAGES[error.code];
  if (error instanceof ApiError || error.name === 'ApiError') {
    let message = error.message;
    if (error.code === 'rate_limited' && error.retryAfterSeconds) message += ' Try again in ' + error.retryAfterSeconds + ' s.';
    return message;
  }
  return 'Something went wrong. Try again.';
}

/**
 * Calls a same-origin gateway path. With `auth`, a Bearer token from ZeroXAuth.getAccessToken()
 * is required and sent; without it the request is anonymous.
 */
export async function apiFetch(path, options = {}) {
  const { method = 'GET', body, auth, fetchImpl, timeoutMs = 15000 } = options;
  if (typeof path !== 'string' || !API_PATH.test(path) || path.includes('..')) throw new TypeError('apiFetch only calls same-origin gateway paths');
  const headers = { Accept: 'application/json' };
  if (auth) {
    let token = '';
    try { token = await auth.getAccessToken(); }
    catch { token = ''; }
    if (!token) throw new ApiError(FRIENDLY_MESSAGES.invalid_session, { status: 401, code: 'invalid_session' });
    headers.Authorization = 'Bearer ' + token;
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let response;
  try {
    response = await (fetchImpl || globalThis.fetch)(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timedOut = error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw new ApiError(FRIENDLY_MESSAGES[timedOut ? 'timeout' : 'network_error'], { code: timedOut ? 'timeout' : 'network_error' });
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) throw parseApiError(response.status, data, response.headers && response.headers.get ? response.headers.get('Retry-After') : null);
  return data && typeof data === 'object' ? data : {};
}

let razorpayLoader = null;

/** Loads Razorpay Checkout on demand (only when the visitor starts a payment). */
export function loadRazorpay({ win = globalThis.window, doc = globalThis.document, timeoutMs = 20000 } = {}) {
  if (win && typeof win.Razorpay === 'function') return Promise.resolve(win.Razorpay);
  if (!razorpayLoader) {
    razorpayLoader = new Promise((resolve, reject) => {
      const script = doc.createElement('script');
      const fail = () => reject(new ApiError(FRIENDLY_MESSAGES.checkout_unavailable, { code: 'checkout_unavailable' }));
      const timer = setTimeout(fail, timeoutMs);
      script.src = RAZORPAY_CHECKOUT_SRC;
      script.async = true;
      script.onload = () => {
        clearTimeout(timer);
        if (typeof win.Razorpay === 'function') resolve(win.Razorpay);
        else fail();
      };
      script.onerror = () => { clearTimeout(timer); fail(); };
      doc.head.appendChild(script);
    }).catch(error => {
      razorpayLoader = null;
      throw error;
    });
  }
  return razorpayLoader;
}

/** Validates a checkout/topup payload and builds Razorpay Checkout options. */
export function checkoutOptions(payload, { onPayment, onDismiss } = {}) {
  const unavailable = () => new ApiError(FRIENDLY_MESSAGES.billing_not_configured, { code: 'billing_not_configured' });
  if (!payload || payload.provider !== 'razorpay' || !RAZORPAY_KEY.test(payload.key_id || '')) throw unavailable();
  const prefill = payload.prefill && typeof payload.prefill === 'object' ? payload.prefill : {};
  const notes = {};
  if (payload.notes && typeof payload.notes === 'object') {
    for (const [key, value] of Object.entries(payload.notes).slice(0, 15)) {
      if (/^[A-Za-z0-9_]{1,40}$/.test(key) && ['string', 'number'].includes(typeof value)) notes[key] = String(value).slice(0, 256);
    }
  }
  const options = {
    key: payload.key_id,
    name: text(payload.name, 80) || 'Zero-X',
    description: text(payload.description, 255),
    prefill: { email: text(prefill.email, 254), name: text(prefill.name, 120) },
    notes,
    theme: { color: CHECKOUT_THEME_COLOR },
    handler: onPayment,
    modal: { ondismiss: onDismiss, escape: true, confirm_close: true },
  };
  if (PROVIDER_ID.test(payload.subscription_id || '')) {
    options.subscription_id = payload.subscription_id;
  } else if (PROVIDER_ID.test(payload.order_id || '')) {
    options.order_id = payload.order_id;
    if (Number.isSafeInteger(payload.amount_minor) && payload.amount_minor > 0) options.amount = payload.amount_minor;
    if (typeof payload.currency === 'string') options.currency = normalizeCurrency(payload.currency);
  } else {
    throw unavailable();
  }
  return options;
}

/** Keeps exactly the Razorpay fields the verify endpoint accepts (contract §3.5). */
export function verifyPayload(response) {
  const pick = key => (response && typeof response[key] === 'string' && PROVIDER_ID.test(response[key]) ? response[key] : '');
  const signature = response && typeof response.razorpay_signature === 'string' && /^[A-Fa-f0-9]{16,256}$/.test(response.razorpay_signature) ? response.razorpay_signature : '';
  const body = { razorpay_payment_id: pick('razorpay_payment_id'), razorpay_signature: signature };
  if (pick('razorpay_subscription_id')) body.razorpay_subscription_id = pick('razorpay_subscription_id');
  else if (pick('razorpay_order_id')) body.razorpay_order_id = pick('razorpay_order_id');
  if (!body.razorpay_payment_id || !body.razorpay_signature || Object.keys(body).length !== 3) {
    throw new ApiError(FRIENDLY_MESSAGES.payment_unverified, { code: 'payment_unverified' });
  }
  return body;
}

function paymentFailureMessage(event) {
  const description = event && event.error && typeof event.error.description === 'string' ? event.error.description.slice(0, 200) : '';
  return (description ? 'Payment failed: ' + description + '.' : 'Payment failed.') + ' You can retry in the payment window or close it.';
}

/** Opens Razorpay Checkout and resolves with the /api/billing/verify result. */
export async function runCheckout(payload, deps = {}) {
  const { auth, fetchImpl, win, doc, onStatus } = deps;
  const Razorpay = await loadRazorpay({ win, doc });
  return new Promise((resolve, reject) => {
    let settled = false;
    let lastFailure = '';
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const options = checkoutOptions(payload, {
      onPayment: async response => {
        try {
          if (onStatus) onStatus('Confirming your payment…');
          const result = await apiFetch('/api/billing/verify', { method: 'POST', body: verifyPayload(response), auth, fetchImpl });
          settle(resolve, result);
        } catch (error) {
          settle(reject, error);
        }
      },
      onDismiss: () => settle(reject, new ApiError(lastFailure || FRIENDLY_MESSAGES.checkout_dismissed, { code: lastFailure ? 'payment_failed' : 'checkout_dismissed' })),
    });
    const checkout = new Razorpay(options);
    if (typeof checkout.on === 'function') {
      // Razorpay keeps the window open after a failed attempt so the buyer can retry.
      checkout.on('payment.failed', event => {
        lastFailure = paymentFailureMessage(event);
        if (onStatus) onStatus(lastFailure);
      });
    }
    checkout.open();
  });
}

/** POST /api/billing/checkout → Razorpay subscription → verify. */
export async function startSubscription({ plan, currency, ...deps }) {
  if (!['pro', 'max'].includes(plan)) throw new ApiError('Choose the Pro or Max plan.', { code: 'invalid_request' });
  if (deps.onStatus) deps.onStatus('Preparing secure checkout…');
  const payload = await apiFetch('/api/billing/checkout', {
    method: 'POST', body: { plan, currency: normalizeCurrency(currency) }, auth: deps.auth, fetchImpl: deps.fetchImpl,
  });
  return runCheckout(payload, deps);
}

/** POST /api/billing/topup → Razorpay order → verify. */
export async function startTopup({ pack, currency, ...deps }) {
  if (!PACK_ID.test(pack || '')) throw new ApiError('Choose a credit pack.', { code: 'invalid_request' });
  if (deps.onStatus) deps.onStatus('Preparing secure checkout…');
  const payload = await apiFetch('/api/billing/topup', {
    method: 'POST', body: { pack, currency: normalizeCurrency(currency) }, auth: deps.auth, fetchImpl: deps.fetchImpl,
  });
  return runCheckout(payload, deps);
}

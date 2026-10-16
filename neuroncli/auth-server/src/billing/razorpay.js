// Minimal Razorpay REST client for Workers and Node (fetch + WebCrypto, no SDK).
// docs/PLATFORM_CONTRACT.md §3.5. Secrets: RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET.

const DEFAULT_BASE = 'https://api.razorpay.com/v1';
const encoder = new TextEncoder();

export class RazorpayError extends Error {
  constructor(status, code, description) {
    super(`Razorpay request failed (${status}${code ? ` ${code}` : ''})`);
    this.name = 'RazorpayError';
    this.status = status;
    this.code = code || null;
    this.description = description || null;
  }
}

export function razorpayConfigured(env) {
  return typeof env.RAZORPAY_KEY_ID === 'string' && /^rzp_(test|live)_[A-Za-z0-9]+$/.test(env.RAZORPAY_KEY_ID) &&
    typeof env.RAZORPAY_KEY_SECRET === 'string' && env.RAZORPAY_KEY_SECRET.length >= 8;
}

export function webhookConfigured(env) {
  return typeof env.RAZORPAY_WEBHOOK_SECRET === 'string' && env.RAZORPAY_WEBHOOK_SECRET.length >= 8;
}

// RAZORPAY_API_BASE exists for tests; only https or a loopback http origin is accepted.
export function razorpayBase(env) {
  if (!env.RAZORPAY_API_BASE) return DEFAULT_BASE;
  try {
    const url = new URL(env.RAZORPAY_API_BASE);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))) {
      throw new Error('unsafe');
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    throw new Error('RAZORPAY_API_BASE must be an https URL or a loopback http URL');
  }
}

export async function razorpayRequest(env, method, path, body) {
  if (!razorpayConfigured(env)) throw new RazorpayError(0, 'not_configured', 'Razorpay keys are not configured');
  const headers = {
    Authorization: 'Basic ' + btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`),
    Accept: 'application/json',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let response;
  try {
    response = await fetch(razorpayBase(env) + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    throw new RazorpayError(0, 'network_error', error?.name === 'TimeoutError' ? 'timeout' : 'unreachable');
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new RazorpayError(response.status, payload?.error?.code, payload?.error?.description);
  if (!payload || typeof payload !== 'object') throw new RazorpayError(response.status, 'invalid_response', 'Expected a JSON object');
  return payload;
}

const segment = id => encodeURIComponent(id);
export const createSubscription = (env, body) => razorpayRequest(env, 'POST', '/subscriptions', body);
export const fetchSubscription = (env, id) => razorpayRequest(env, 'GET', `/subscriptions/${segment(id)}`);
export const cancelSubscription = (env, id, atCycleEnd = true) =>
  razorpayRequest(env, 'POST', `/subscriptions/${segment(id)}/cancel`, { cancel_at_cycle_end: atCycleEnd ? 1 : 0 });
export const createOrder = (env, body) => razorpayRequest(env, 'POST', '/orders', body);
export const fetchOrder = (env, id) => razorpayRequest(env, 'GET', `/orders/${segment(id)}`);
export const fetchPayment = (env, id) => razorpayRequest(env, 'GET', `/payments/${segment(id)}`);
export const createPlan = (env, body) => razorpayRequest(env, 'POST', '/plans', body);
export const listPlans = (env, { count = 100, skip = 0 } = {}) => razorpayRequest(env, 'GET', `/plans?count=${count}&skip=${skip}`);

// ── Signatures ──
export async function hmacSha256(secret, message) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, typeof message === 'string' ? encoder.encode(message) : message));
}

export const toHex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');

function fromHex(text) {
  if (typeof text !== 'string' || !/^[0-9a-fA-F]{64}$/.test(text)) return null;
  const bytes = new Uint8Array(32);
  for (let index = 0; index < 32; index++) bytes[index] = Number.parseInt(text.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

// Compares every byte regardless of where the first difference is.
export function constantTimeEqual(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index];
  return difference === 0;
}

export async function verifySignature(secret, message, signatureHex) {
  if (typeof secret !== 'string' || !secret) return false;
  const supplied = fromHex(signatureHex);
  const expected = await hmacSha256(secret, message);
  return constantTimeEqual(expected, supplied || new Uint8Array(expected.length + 1));
}

// Checkout handler signatures (https://razorpay.com/docs/payments/subscriptions/integration-guide/):
// subscriptions sign `payment_id|subscription_id`, orders sign `order_id|payment_id`.
export function checkoutSignatureMessage({ paymentId, subscriptionId, orderId }) {
  if (subscriptionId) return `${paymentId}|${subscriptionId}`;
  return `${orderId}|${paymentId}`;
}

export async function verifyCheckoutSignature(env, { paymentId, subscriptionId, orderId, signature }) {
  return verifySignature(env.RAZORPAY_KEY_SECRET, checkoutSignatureMessage({ paymentId, subscriptionId, orderId }), signature);
}

export async function verifyWebhookSignature(env, rawBody, signature) {
  return verifySignature(env.RAZORPAY_WEBHOOK_SECRET, rawBody, signature);
}

// Razorpay timestamps are Unix seconds; the database stores timestamptz.
export function isoFromUnix(seconds) {
  const value = Number(seconds);
  return Number.isFinite(value) && value > 0 ? new Date(value * 1000).toISOString() : null;
}

export const SUBSCRIPTION_STATUSES = Object.freeze(['created', 'authenticated', 'active', 'pending', 'halted',
  'cancelled', 'completed', 'expired', 'paused']);
// Statuses that already entitle (or will soon entitle) the user, blocking a second checkout.
export const LIVE_SUBSCRIPTION_STATUSES = Object.freeze(['authenticated', 'active', 'pending', 'halted', 'paused']);

export function subscriptionStatus(value) {
  const status = String(value || '').toLowerCase();
  return SUBSCRIPTION_STATUSES.includes(status) ? status : null;
}

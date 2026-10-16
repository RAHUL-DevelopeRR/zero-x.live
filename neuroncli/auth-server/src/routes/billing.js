import { rpc } from '../account-store.js';
import { ApiError, INTERACTIVE_CREDENTIALS, requireActiveAccount, withCaller } from '../auth-context.js';
import { loadPlanCatalog, normalizePlanId, PAID_PLAN_IDS, topupPack } from '../plan-policy.js';
import {
  cancelSubscription, createOrder, createSubscription, fetchOrder, fetchPayment, fetchSubscription,
  isoFromUnix, LIVE_SUBSCRIPTION_STATUSES, razorpayConfigured, RazorpayError, subscriptionStatus, verifyCheckoutSignature,
} from '../billing/razorpay.js';
import { accountPayload, isoTime } from './account.js';

export const PROVIDER = 'razorpay';
const MERCHANT_NAME = 'Zero-X';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_PATTERNS = {
  payment: /^pay_[A-Za-z0-9]{6,40}$/,
  subscription: /^sub_[A-Za-z0-9]{6,40}$/,
  order: /^order_[A-Za-z0-9]{6,40}$/,
};
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
export const userIdFrom = value => typeof value === 'string' && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
const pricingUrl = env => env.PRICING_URL || 'https://zero-x.live/pricing';

export const billingNotConfigured = () => new ApiError(503, 'billing_not_configured',
  'Payments are not available on this gateway yet. Please try again later or contact https://zero-x.live/contact.');

export function providerFailure(error, message = 'The payment provider could not complete the request. Please retry.') {
  if (error instanceof ApiError) return error;
  if (error instanceof RazorpayError) {
    console.error('Razorpay request failed', { status: error.status, code: error.code, description: error.description });
    return new ApiError(502, 'payment_provider_error', message);
  }
  return error;
}

async function provider(call, message) {
  try { return await call(); }
  catch (error) { throw providerFailure(error, message); }
}

async function jsonObject(c) {
  const body = await c.req.json().catch(() => null);
  if (!object(body)) throw new ApiError(400, 'invalid_request', 'Send a JSON object body.');
  return body;
}

export function parseCurrency(value) {
  const currency = value === undefined || value === null ? 'USD' : String(value).toUpperCase();
  if (!['INR', 'USD'].includes(currency)) throw new ApiError(400, 'invalid_request', '`currency` must be INR or USD.', { param: 'currency' });
  return currency;
}

export const priceFor = (price, currency) => currency === 'INR' ? price.inr_paise : price.usd_cents;

export function planFromSubscription(plans, subscription) {
  const byId = plans.find(plan => subscription?.plan_id &&
    (plan.razorpay_plan_id_inr === subscription.plan_id || plan.razorpay_plan_id_usd === subscription.plan_id));
  if (byId && PAID_PLAN_IDS.includes(byId.id)) return byId;
  const noted = plans.find(plan => plan.id === subscription?.notes?.plan);
  return noted && PAID_PLAN_IDS.includes(noted.id) ? noted : null;
}

// Card, contact and e-mail details are not copied into our database.
export function paymentSummary(payment) {
  const keep = ['id', 'entity', 'amount', 'currency', 'status', 'order_id', 'invoice_id', 'method', 'captured',
    'amount_refunded', 'refund_status', 'error_code', 'error_reason', 'created_at'];
  const summary = Object.fromEntries(keep.filter(key => payment?.[key] !== undefined).map(key => [key, payment[key]]));
  if (object(payment?.notes)) summary.notes = payment.notes;
  return summary;
}
export function subscriptionSummary(subscription) {
  const keep = ['id', 'entity', 'plan_id', 'status', 'current_start', 'current_end', 'ended_at', 'charge_at', 'start_at',
    'end_at', 'paid_count', 'total_count', 'remaining_count', 'customer_notify', 'created_at'];
  const summary = Object.fromEntries(keep.filter(key => subscription?.[key] !== undefined).map(key => [key, subscription[key]]));
  if (object(subscription?.notes)) summary.notes = subscription.notes;
  return summary;
}

export const recordPayment = (env, { userId, paymentId, kind, amount, currency, status, raw }) =>
  rpc(env, 'zerox_billing_record_payment', {
    p_user_id: userId, p_provider: PROVIDER, p_provider_payment_id: paymentId, p_kind: kind,
    p_amount_minor: Number(amount) || 0, p_currency: String(currency || '').toUpperCase(), p_status: String(status || 'unknown'),
    p_invoice_url: null, p_raw: raw,
  });

// cancelAtPeriodEnd null (or omitted) keeps the stored flag: zerox_billing_upsert_subscription
// coalesces it, so a re-verified payment never clears a scheduled cancellation.
export const upsertSubscription = (env, { userId, subscriptionId, plan, status, periodStart, periodEnd, cancelAtPeriodEnd = null, raw }) =>
  rpc(env, 'zerox_billing_upsert_subscription', {
    p_user_id: userId, p_provider: PROVIDER, p_provider_subscription_id: subscriptionId, p_plan: plan, p_status: status,
    p_current_period_start: periodStart, p_current_period_end: periodEnd,
    p_cancel_at_period_end: cancelAtPeriodEnd === null ? null : cancelAtPeriodEnd === true, p_raw: raw,
  });

// zerox_credit_grant reasons are ledger categories matching ^[a-z][a-z0-9_]{0,63}$ (WP-B1).
export const CREDIT_REASON = /^[a-z][a-z0-9_]{0,63}$/;
export const creditReason = {
  topup: pack => `topup_${pack.id}`,
  subscription: plan => `subscription_${plan.id}`,
};

// Idempotent on ref: the same payment id never grants twice.
export const grantCredits = (env, { userId, microusd, reason, ref }) => {
  if (!CREDIT_REASON.test(reason)) throw new Error(`Invalid credit reason ${String(reason).slice(0, 80)}`);
  return rpc(env, 'zerox_credit_grant', { p_user_id: userId, p_delta_microusd: microusd, p_reason: reason, p_ref: ref });
};

async function billingState(env, userId) {
  const row = await rpc(env, 'zerox_billing_get', { p_user_id: userId });
  return {
    subscription: object(row?.subscription),
    payments: Array.isArray(row?.payments) ? row.payments.filter(object) : [],
  };
}

const subscriptionView = subscription => subscription ? {
  id: subscription.provider_subscription_id ?? subscription.id ?? null,
  plan: subscription.plan ?? null,
  status: subscription.status ?? null,
  current_period_end: isoTime(subscription.current_period_end),
  cancel_at_period_end: subscription.cancel_at_period_end === true,
  provider: subscription.provider ?? PROVIDER,
} : null;

const paymentView = payment => ({
  id: payment.provider_payment_id ?? payment.id ?? null,
  kind: payment.kind === 'topup' ? 'topup' : 'subscription',
  amount_minor: Number(payment.amount_minor) || 0,
  currency: payment.currency ?? null,
  status: payment.status ?? null,
  created_at: isoTime(payment.created_at),
  invoice_url: payment.invoice_url ?? null,
});

const liveSubscription = subscription => subscription && LIVE_SUBSCRIPTION_STATUSES.includes(subscription.status) ? subscription : null;

function checkoutPrefill(caller) {
  return { email: caller.email || '', name: caller.name || '' };
}

async function checkout(c, caller) {
  const body = await jsonObject(c);
  if (!PAID_PLAN_IDS.includes(body.plan)) throw new ApiError(400, 'invalid_request', '`plan` must be pro or max.', { param: 'plan' });
  const currency = parseCurrency(body.currency);
  if (!razorpayConfigured(c.env)) throw billingNotConfigured();
  await requireActiveAccount(c.env, caller);
  const plan = (await loadPlanCatalog(c.env)).plans.find(entry => entry.id === body.plan);
  const providerPlanId = currency === 'INR' ? plan?.razorpay_plan_id_inr : plan?.razorpay_plan_id_usd;
  if (!providerPlanId) throw billingNotConfigured();
  const current = liveSubscription((await billingState(c.env, caller.user_id)).subscription);
  if (current) {
    throw new ApiError(409, 'already_subscribed',
      `You already have a ${current.plan || 'paid'} subscription (${current.status}). Manage it from your dashboard.`);
  }
  const notes = { user_id: caller.user_id, plan: plan.id };
  const subscription = await provider(() => createSubscription(c.env, {
    plan_id: providerPlanId, total_count: 120, quantity: 1, customer_notify: 1, notes,
  }), 'Could not start checkout. No payment was taken; please retry.');
  if (!ID_PATTERNS.subscription.test(subscription.id || '')) throw new ApiError(502, 'payment_provider_error', 'Could not start checkout. Please retry.');
  return c.json({
    provider: PROVIDER, key_id: c.env.RAZORPAY_KEY_ID, subscription_id: subscription.id,
    name: MERCHANT_NAME, description: `Neuron ${plan.name} plan, billed monthly`, prefill: checkoutPrefill(caller), notes,
  });
}

async function topup(c, caller) {
  const body = await jsonObject(c);
  const pack = topupPack(body.pack);
  if (!pack) throw new ApiError(400, 'invalid_request', '`pack` must be credits_5 or credits_20.', { param: 'pack' });
  const currency = parseCurrency(body.currency);
  if (!razorpayConfigured(c.env)) throw billingNotConfigured();
  // Read the plan fresh: a subscription verified seconds ago must already allow top-ups.
  const current = await requireActiveAccount(c.env, caller);
  const plan = (await loadPlanCatalog(c.env)).plans.find(entry => entry.id === normalizePlanId(current?.plan ?? caller.plan));
  if (!plan?.tiers.includes('paid')) {
    // Credits are only spent on paid pools, which the Free plan cannot use.
    throw new ApiError(403, 'upgrade_required', 'Credit top-ups are available on the Pro and Max plans. Upgrade first.',
      { upgrade_url: pricingUrl(c.env) });
  }
  const amount = priceFor(pack.price, currency);
  const receipt = 'topup_' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
  const order = await provider(() => createOrder(c.env, { amount, currency, receipt, notes: { user_id: caller.user_id, pack: pack.id } }),
    'Could not start checkout. No payment was taken; please retry.');
  if (!ID_PATTERNS.order.test(order.id || '')) throw new ApiError(502, 'payment_provider_error', 'Could not start checkout. Please retry.');
  return c.json({
    provider: PROVIDER, key_id: c.env.RAZORPAY_KEY_ID, order_id: order.id, amount_minor: amount, currency,
    name: MERCHANT_NAME, description: `$${pack.credit_usd} Neuron credit top-up`, prefill: checkoutPrefill(caller),
  });
}

const mismatch = message => new ApiError(400, 'payment_mismatch', message);
const notYours = () => new ApiError(403, 'payment_mismatch', 'This payment does not belong to your account.');

async function verifySubscriptionPayment(env, caller, { paymentId, subscriptionId }) {
  const [subscription, payment] = await provider(() => Promise.all([fetchSubscription(env, subscriptionId), fetchPayment(env, paymentId)]),
    'Could not confirm the payment with Razorpay. If you were charged, your plan updates automatically within minutes.');
  if (userIdFrom(subscription.notes?.user_id) !== caller.user_id) throw notYours();
  const { plans } = await loadPlanCatalog(env);
  const plan = planFromSubscription(plans, subscription);
  if (!plan) throw mismatch('This subscription is not for a Zero-X plan.');
  const status = subscriptionStatus(subscription.status);
  if (!['authenticated', 'active'].includes(status) || !['captured', 'authorized'].includes(payment.status)) {
    return { pending: true };
  }
  const currency = String(payment.currency || '').toUpperCase();
  if (!['INR', 'USD'].includes(currency) || Number(payment.amount) !== priceFor(plan.price, currency)) {
    throw mismatch('The payment amount does not match the plan price.');
  }
  await recordPayment(env, { userId: caller.user_id, paymentId, kind: 'subscription', amount: payment.amount, currency,
    status: payment.status, raw: paymentSummary(payment) });
  await upsertSubscription(env, {
    userId: caller.user_id, subscriptionId, plan: plan.id, status,
    periodStart: isoFromUnix(subscription.current_start), periodEnd: isoFromUnix(subscription.current_end),
    // Keep a cancellation already scheduled from the dashboard (Razorpay still reports 'active').
    cancelAtPeriodEnd: null, raw: subscriptionSummary(subscription),
  });
  // Monthly credits are granted by the subscription.charged webhook (once per payment id).
  return { pending: false };
}

async function verifyTopupPayment(env, caller, { paymentId, orderId }) {
  const [order, payment] = await provider(() => Promise.all([fetchOrder(env, orderId), fetchPayment(env, paymentId)]),
    'Could not confirm the payment with Razorpay. If you were charged, your credits are added automatically within minutes.');
  if (userIdFrom(order.notes?.user_id) !== caller.user_id) throw notYours();
  const pack = topupPack(order.notes?.pack);
  const currency = String(order.currency || '').toUpperCase();
  if (!pack || !['INR', 'USD'].includes(currency) || Number(order.amount) !== priceFor(pack.price, currency) ||
      payment.order_id !== orderId || Number(payment.amount) !== Number(order.amount) || String(payment.currency).toUpperCase() !== currency) {
    throw mismatch('The payment does not match the top-up order.');
  }
  if (!['captured', 'authorized'].includes(payment.status)) {
    throw new ApiError(402, 'payment_failed', 'The payment was not completed. No credits were added.');
  }
  await recordPayment(env, { userId: caller.user_id, paymentId, kind: 'topup', amount: payment.amount, currency,
    status: payment.status, raw: paymentSummary(payment) });
  // An authorized (not yet captured) payment is granted by the payment.captured webhook.
  if (payment.status !== 'captured') return { pending: true };
  await grantCredits(env, { userId: caller.user_id, microusd: pack.credit_microusd, reason: creditReason.topup(pack), ref: paymentId });
  return { pending: false };
}

async function verify(c, caller) {
  const body = await jsonObject(c);
  const paymentId = body.razorpay_payment_id;
  const subscriptionId = body.razorpay_subscription_id;
  const orderId = body.razorpay_order_id;
  const signature = body.razorpay_signature;
  if (!ID_PATTERNS.payment.test(paymentId || '')) throw new ApiError(400, 'invalid_request', 'Missing or invalid razorpay_payment_id.', { param: 'razorpay_payment_id' });
  if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/i.test(signature)) {
    throw new ApiError(400, 'invalid_request', 'Missing or invalid razorpay_signature.', { param: 'razorpay_signature' });
  }
  if ((subscriptionId === undefined) === (orderId === undefined)) {
    throw new ApiError(400, 'invalid_request', 'Provide exactly one of razorpay_subscription_id or razorpay_order_id.');
  }
  if (subscriptionId !== undefined && !ID_PATTERNS.subscription.test(subscriptionId)) {
    throw new ApiError(400, 'invalid_request', 'Invalid razorpay_subscription_id.', { param: 'razorpay_subscription_id' });
  }
  if (orderId !== undefined && !ID_PATTERNS.order.test(orderId)) {
    throw new ApiError(400, 'invalid_request', 'Invalid razorpay_order_id.', { param: 'razorpay_order_id' });
  }
  if (!razorpayConfigured(c.env)) throw billingNotConfigured();
  if (!await verifyCheckoutSignature(c.env, { paymentId, subscriptionId, orderId, signature })) {
    throw new ApiError(400, 'invalid_signature', 'The payment signature is invalid.', { param: 'razorpay_signature' });
  }
  const result = subscriptionId
    ? await verifySubscriptionPayment(c.env, caller, { paymentId, subscriptionId })
    : await verifyTopupPayment(c.env, caller, { paymentId, orderId });
  return c.json({ status: result.pending ? 'pending' : 'ok', account: await accountPayload(c.env, caller) });
}

async function cancel(c, caller) {
  if (!razorpayConfigured(c.env)) throw billingNotConfigured();
  const current = liveSubscription((await billingState(c.env, caller.user_id)).subscription);
  if (!current || (current.provider && current.provider !== PROVIDER)) {
    throw new ApiError(409, 'no_active_subscription', 'You do not have an active subscription to cancel.');
  }
  if (current.cancel_at_period_end === true) {
    return c.json({ status: 'cancel_scheduled', current_period_end: isoTime(current.current_period_end) });
  }
  const subscriptionId = current.provider_subscription_id ?? current.id;
  if (!ID_PATTERNS.subscription.test(subscriptionId || '')) throw new Error('Stored subscription has no provider id');
  const updated = await provider(() => cancelSubscription(c.env, subscriptionId, true),
    'Could not schedule the cancellation. Your subscription is unchanged; please retry.');
  const periodEnd = isoFromUnix(updated.current_end) ?? isoTime(current.current_period_end);
  await upsertSubscription(c.env, {
    userId: caller.user_id, subscriptionId, plan: current.plan,
    status: subscriptionStatus(updated.status) ?? current.status,
    periodStart: isoFromUnix(updated.current_start) ?? current.current_period_start ?? null,
    periodEnd, cancelAtPeriodEnd: true, raw: subscriptionSummary(updated),
  });
  return c.json({ status: 'cancel_scheduled', current_period_end: periodEnd });
}

export function registerBillingRoutes(api) {
  api.get('/api/billing', withCaller(INTERACTIVE_CREDENTIALS, async (c, caller) => {
    const state = await billingState(c.env, caller.user_id);
    return c.json({
      provider_configured: razorpayConfigured(c.env),
      subscription: subscriptionView(state.subscription),
      payments: state.payments.map(paymentView),
    });
  }));
  api.post('/api/billing/checkout', withCaller(INTERACTIVE_CREDENTIALS, checkout));
  api.post('/api/billing/topup', withCaller(INTERACTIVE_CREDENTIALS, topup));
  api.post('/api/billing/verify', withCaller(INTERACTIVE_CREDENTIALS, verify));
  api.post('/api/billing/cancel', withCaller(INTERACTIVE_CREDENTIALS, cancel));
}

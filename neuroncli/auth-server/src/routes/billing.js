import { rpc, rpcRows } from '../account-store.js';
import { ApiError, INTERACTIVE_CREDENTIALS, requireActiveAccount, withCaller } from '../auth-context.js';
import { loadPlanCatalog, normalizePlanId, PAID_PLAN_IDS, topupPack } from '../plan-policy.js';
import {
  cancelSubscription, createOrder, createSubscription, ENDED_SUBSCRIPTION_STATUSES, fetchOrder, fetchPayment, fetchSubscription,
  isoFromUnix, LIVE_SUBSCRIPTION_STATUSES, razorpayConfigured, RazorpayError, refundPayment, subscriptionStatus, verifyCheckoutSignature,
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
const PAYMENT_STATUSES = ['created', 'authorized', 'captured', 'failed', 'refunded'];
// An unpaid checkout ('created' subscription) is reused or retired for this long.
const OPEN_CHECKOUT_MS = 24 * 60 * 60 * 1000;
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
// Subscription payments carry the subscription id, so a refund can find what it paid for.
export const subscriptionPaymentRaw = (payment, subscriptionId) => ({ ...paymentSummary(payment), subscription_id: subscriptionId });
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

// Every subscription of the user that has not ended (zerox_billing_subscriptions), newest first.
const userSubscriptions = async (env, userId) =>
  (await rpcRows(env, 'zerox_billing_subscriptions', { p_user_id: userId })).filter(row => !row.provider || row.provider === PROVIDER);
const isLive = subscription => LIVE_SUBSCRIPTION_STATUSES.includes(subscription?.status);
const isEnded = status => ENDED_SUBSCRIPTION_STATUSES.includes(status);
// Unpaid checkouts that can still be paid in an open payment window.
const openCheckouts = (subscriptions, now = Date.now()) => subscriptions.filter(entry => entry.status === 'created' && !entry.revoked_at &&
  now - Date.parse(entry.created_at) < OPEN_CHECKOUT_MS && ID_PATTERNS.subscription.test(entry.provider_subscription_id || '')).slice(0, 5);
// The status to store after asking Razorpay to end a subscription now.
const endedStatus = status => isEnded(subscriptionStatus(status)) ? subscriptionStatus(status) : 'cancelled';

const CHECKOUT_FAILED = 'Could not start checkout. No payment was taken; please retry.';
const CANCEL_FAILED = 'Could not schedule the cancellation. Your subscription is unchanged; please retry.';
const alreadySubscribed = subscription => new ApiError(409, 'already_subscribed',
  `You already have a ${subscription?.plan || 'paid'} subscription (${subscription?.status || 'active'}). Manage it from your dashboard.`);
const checkoutInProgress = () => new ApiError(409, 'checkout_in_progress',
  'A checkout for your account is already in progress or its payment is being confirmed. Check Billing in your dashboard before paying again.');
const duplicateSubscription = () => new ApiError(409, 'already_subscribed',
  'This subscription duplicates another subscription or checkout on your account, so it was cancelled and its payment is being refunded to your original payment method.');

function checkoutPrefill(caller) {
  return { email: caller.email || '', name: caller.name || '' };
}

// Ends a subscription at Razorpay now. A subscription that already ended (a retry after a
// partial failure) is answered with its current state.
export async function cancelImmediately(env, subscriptionId) {
  try {
    return await cancelSubscription(env, subscriptionId, false);
  } catch (error) {
    if (!(error instanceof RazorpayError)) throw error;
    const latest = await fetchSubscription(env, subscriptionId);
    if (isEnded(subscriptionStatus(latest.status))) return latest;
    throw error;
  }
}

// Records a subscription that Razorpay ended (or was asked to end) at once.
export async function recordEnded(env, { userId, plan, remote }) {
  await upsertSubscription(env, {
    userId, subscriptionId: remote.id, plan, status: endedStatus(remote.status),
    periodStart: isoFromUnix(remote.current_start), periodEnd: isoFromUnix(remote.current_end),
    cancelAtPeriodEnd: false, raw: subscriptionSummary(remote),
  });
}

async function cancelQuietly(env, subscriptionId) {
  try {
    await cancelImmediately(env, subscriptionId);
  } catch (error) {
    console.error('An unused Razorpay subscription could not be cancelled; cancel it in the Razorpay dashboard',
      { subscription: subscriptionId, message: error?.message });
  }
}

// Refunds a payment in full (idempotent: Razorpay never refunds more than was captured) and
// records it as refunded. Payments that were never captured are only recorded.
export async function refundInFull(env, { userId, kind, payment, subscriptionId = null, reason }) {
  let latest = await fetchPayment(env, payment.id);
  const fullyRefunded = entry => entry.status === 'refunded' || Number(entry.amount_refunded || 0) >= Number(entry.amount);
  if (latest.status === 'captured' && !fullyRefunded(latest)) {
    try {
      await refundPayment(env, payment.id, { notes: { reason, ...(subscriptionId ? { subscription_id: subscriptionId } : {}) } });
    } catch (error) {
      if (!(error instanceof RazorpayError)) throw error;
      if (!fullyRefunded(await fetchPayment(env, payment.id))) throw error;
    }
    latest = await fetchPayment(env, payment.id);
  }
  const status = fullyRefunded(latest) ? 'refunded' : PAYMENT_STATUSES.includes(latest.status) ? latest.status : null;
  if (status) {
    await recordPayment(env, { userId, paymentId: latest.id || payment.id, kind, amount: latest.amount, currency: latest.currency, status,
      raw: subscriptionId ? subscriptionPaymentRaw(latest, subscriptionId) : paymentSummary(latest) });
  }
  if (status !== 'refunded') {
    console.warn('A payment to refund was not captured; Razorpay releases uncaptured authorizations', { payment: payment.id });
  }
}

// A duplicate subscription (revoked by zerox_billing_upsert_subscription because another one was
// already live) never entitles: it is cancelled at Razorpay at once and its payment is refunded.
export async function settleDuplicate(env, { userId, subscription, plan, payment = null }) {
  const remote = isEnded(subscriptionStatus(subscription.status)) ? subscription : await cancelImmediately(env, subscription.id);
  await recordEnded(env, { userId, plan: plan.id, remote: { ...subscription, ...remote, id: subscription.id } });
  if (payment && /^pay_[A-Za-z0-9]{6,40}$/.test(payment.id || '')) {
    await refundInFull(env, { userId, kind: 'subscription', payment, subscriptionId: subscription.id, reason: 'duplicate_subscription' });
  }
  console.warn('Duplicate Razorpay subscription cancelled and refunded', { subscription: subscription.id });
}

// Retires an unpaid checkout for another plan or currency: cancelled at Razorpay when it allows
// that, otherwise revoked here as a duplicate, so that paying it later (a stale payment window)
// is cancelled and refunded instead of entitling next to the new subscription.
async function retireCheckout(env, userId, stored, remote) {
  let ended = null;
  try {
    ended = await cancelImmediately(env, remote.id);
  } catch (error) {
    if (!(error instanceof RazorpayError)) throw error;
    console.warn('Razorpay did not cancel an unpaid checkout; it is revoked instead', { subscription: remote.id, code: error.code });
  }
  if (ended) await recordEnded(env, { userId, plan: stored.plan, remote: { ...remote, ...ended, id: remote.id } });
  else await rpc(env, 'zerox_billing_revoke_subscription', { p_provider: PROVIDER, p_provider_subscription_id: remote.id, p_reason: 'duplicate' });
}

async function checkout(c, caller) {
  const body = await jsonObject(c);
  if (!PAID_PLAN_IDS.includes(body.plan)) throw new ApiError(400, 'invalid_request', '`plan` must be pro or max.', { param: 'plan' });
  const currency = parseCurrency(body.currency);
  const env = c.env;
  if (!razorpayConfigured(env)) throw billingNotConfigured();
  await requireActiveAccount(env, caller);
  const plan = (await loadPlanCatalog(env)).plans.find(entry => entry.id === body.plan);
  const providerPlanId = currency === 'INR' ? plan?.razorpay_plan_id_inr : plan?.razorpay_plan_id_usd;
  if (!providerPlanId) throw billingNotConfigured();
  const subscriptions = await userSubscriptions(env, caller.user_id);
  const live = subscriptions.find(entry => !entry.revoked_at && isLive(entry));
  if (live) throw alreadySubscribed(live);
  const notes = { user_id: caller.user_id, plan: plan.id };
  const respond = subscriptionId => c.json({
    provider: PROVIDER, key_id: env.RAZORPAY_KEY_ID, subscription_id: subscriptionId,
    name: MERCHANT_NAME, description: `Neuron ${plan.name} plan, billed monthly`, prefill: checkoutPrefill(caller), notes,
  });
  // An unpaid checkout (a second tab, a closed payment window) is reused for the same plan and
  // currency and retired for any other one, so the account never holds two payable subscriptions.
  for (const open of openCheckouts(subscriptions)) {
    const remote = await provider(() => fetchSubscription(env, open.provider_subscription_id), CHECKOUT_FAILED);
    const status = subscriptionStatus(remote.status);
    if (status === 'created') {
      if (remote.plan_id === providerPlanId && userIdFrom(remote.notes?.user_id) === caller.user_id) return respond(remote.id);
      // A payment for it is being confirmed: never cancel a subscription the user may have paid.
      if (Number(open.payments) > 0) throw checkoutInProgress();
      await retireCheckout(env, caller.user_id, open, remote);
    } else if (isEnded(status)) {
      await recordEnded(env, { userId: caller.user_id, plan: open.plan, remote });
    } else {
      // Paid meanwhile: verify or the webhook records it.
      throw checkoutInProgress();
    }
  }
  const subscription = await provider(() => createSubscription(env, {
    plan_id: providerPlanId, total_count: 120, quantity: 1, customer_notify: 1, notes,
  }), CHECKOUT_FAILED);
  if (!ID_PATTERNS.subscription.test(subscription.id || '')) throw new ApiError(502, 'payment_provider_error', 'Could not start checkout. Please retry.');
  let recorded;
  try {
    recorded = await rpc(env, 'zerox_billing_record_checkout', {
      p_user_id: caller.user_id, p_provider: PROVIDER, p_provider_subscription_id: subscription.id, p_plan: plan.id,
      p_raw: subscriptionSummary(subscription),
    });
  } catch (error) {
    await cancelQuietly(env, subscription.id);
    throw error;
  }
  if (recorded?.recorded !== true) {
    // A parallel checkout was recorded first: this subscription is retired and the other one is
    // answered when it is for the same plan and currency.
    await cancelQuietly(env, subscription.id);
    const blocking = recorded?.blocking_subscription_id;
    if (recorded?.blocking_status === 'created' && recorded.blocking_plan_id === providerPlanId && ID_PATTERNS.subscription.test(blocking || '')) {
      return respond(blocking);
    }
    throw isLive({ status: recorded?.blocking_status }) ? alreadySubscribed({ status: recorded.blocking_status }) : checkoutInProgress();
  }
  return respond(subscription.id);
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
  const currency = String(payment.currency || '').toUpperCase();
  const record = paymentStatus => recordPayment(env, { userId: caller.user_id, paymentId, kind: 'subscription', amount: payment.amount,
    currency, status: paymentStatus, raw: subscriptionPaymentRaw(payment, subscriptionId) });
  const duplicate = () => provider(() => settleDuplicate(env, { userId: caller.user_id, subscription, plan, payment }),
    'Your account already has a subscription. This second one does not change your plan and will be cancelled and refunded shortly.');
  const stored = await rpc(env, 'zerox_subscription_by_provider_id', { p_provider: PROVIDER, p_provider_subscription_id: subscriptionId });
  if (stored?.revoked_reason === 'duplicate') {
    await duplicate();
    throw duplicateSubscription();
  }
  if (!['authenticated', 'active'].includes(status) || !['captured', 'authorized'].includes(payment.status)) {
    // Not confirmed yet. The attempt is recorded so Billing shows it and a new checkout never
    // retires a subscription that may have been paid.
    if (PAYMENT_STATUSES.includes(payment.status) && ['INR', 'USD'].includes(currency)) await record(payment.status);
    return { pending: true };
  }
  if (!['INR', 'USD'].includes(currency) || Number(payment.amount) !== priceFor(plan.price, currency)) {
    throw mismatch('The payment amount does not match the plan price.');
  }
  await record(payment.status);
  const row = await upsertSubscription(env, {
    userId: caller.user_id, subscriptionId, plan: plan.id, status,
    periodStart: isoFromUnix(subscription.current_start), periodEnd: isoFromUnix(subscription.current_end),
    // Keep a cancellation already scheduled from the dashboard (Razorpay still reports 'active').
    cancelAtPeriodEnd: null, raw: subscriptionSummary(subscription),
  });
  if (row?.revoked_reason === 'duplicate') {
    await duplicate();
    throw duplicateSubscription();
  }
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

// Cancels every live subscription of the user: entitled ones at the end of their paid period,
// revoked duplicates at once, and unpaid checkouts are closed so an old payment window cannot
// start a new subscription.
async function cancel(c, caller) {
  const env = c.env;
  if (!razorpayConfigured(env)) throw billingNotConfigured();
  const subscriptions = await userSubscriptions(env, caller.user_id);
  const entitled = subscriptions.filter(entry => isLive(entry) && !entry.revoked_at);
  const duplicates = subscriptions.filter(entry => isLive(entry) && entry.revoked_at);
  if (!entitled.length && !duplicates.length) {
    throw new ApiError(409, 'no_active_subscription', 'You do not have an active subscription to cancel.');
  }
  let periodEnd = null;
  const later = value => (value && (!periodEnd || Date.parse(value) > Date.parse(periodEnd)) ? value : periodEnd);
  for (const current of entitled) {
    const subscriptionId = current.provider_subscription_id;
    if (!ID_PATTERNS.subscription.test(subscriptionId || '')) throw new Error('Stored subscription has no provider id');
    if (current.cancel_at_period_end === true) {
      periodEnd = later(isoTime(current.current_period_end));
      continue;
    }
    const updated = await provider(() => cancelSubscription(env, subscriptionId, true), CANCEL_FAILED);
    const end = isoFromUnix(updated.current_end) ?? isoTime(current.current_period_end);
    await upsertSubscription(env, {
      userId: caller.user_id, subscriptionId, plan: current.plan,
      status: subscriptionStatus(updated.status) ?? current.status,
      periodStart: isoFromUnix(updated.current_start) ?? current.current_period_start ?? null,
      periodEnd: end, cancelAtPeriodEnd: true, raw: subscriptionSummary(updated),
    });
    periodEnd = later(end);
  }
  for (const duplicate of duplicates) {
    const subscriptionId = duplicate.provider_subscription_id;
    if (!ID_PATTERNS.subscription.test(subscriptionId || '')) continue;
    const ended = await provider(() => cancelImmediately(env, subscriptionId), CANCEL_FAILED);
    await recordEnded(env, { userId: caller.user_id, plan: duplicate.plan, remote: { ...ended, id: subscriptionId } });
  }
  for (const open of openCheckouts(subscriptions)) {
    // Best effort, and recorded only once Razorpay confirms: a subscription stored as ended
    // ignores later activations, so one that might still be paid must stay 'created'.
    try {
      const ended = await cancelImmediately(env, open.provider_subscription_id);
      await recordEnded(env, { userId: caller.user_id, plan: open.plan, remote: { ...ended, id: open.provider_subscription_id } });
    } catch (error) {
      console.error('An unpaid Razorpay checkout could not be cancelled', { subscription: open.provider_subscription_id, message: error?.message });
    }
  }
  if (!entitled.length) throw new ApiError(409, 'no_active_subscription', 'You do not have an active subscription to cancel.');
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

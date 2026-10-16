import { rpc } from '../account-store.js';
import { errorResponse, sendApiError } from '../auth-context.js';
import { loadPlanCatalog, topupPack } from '../plan-policy.js';
import { sha256Hex } from '../session-store.js';
import {
  fetchOrder, fetchSubscription, isoFromUnix, razorpayConfigured, subscriptionStatus, verifyWebhookSignature, webhookConfigured,
} from '../billing/razorpay.js';
import {
  creditReason, grantCredits, paymentSummary, planFromSubscription, priceFor, PROVIDER, recordPayment, subscriptionSummary, upsertSubscription, userIdFrom,
} from './billing.js';

export const MAX_WEBHOOK_BYTES = 256 * 1024;
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null;

// Event → status when the entity carries none.
const EVENT_STATUS = {
  'subscription.authenticated': 'authenticated',
  'subscription.activated': 'active',
  'subscription.charged': 'active',
  'subscription.pending': 'pending',
  'subscription.halted': 'halted',
  'subscription.cancelled': 'cancelled',
  'subscription.completed': 'completed',
};
const ENDED_STATUSES = ['cancelled', 'completed', 'expired'];

async function handleSubscriptionEvent(env, type, payload) {
  let subscription = object(payload.subscription?.entity);
  if (!/^sub_[A-Za-z0-9]{6,40}$/.test(subscription?.id || '')) return 'ignored';
  const existing = await rpc(env, 'zerox_subscription_by_provider_id', {
    p_provider: PROVIDER, p_provider_subscription_id: subscription.id,
  });
  // Deliveries are unordered: with API keys configured, the current state is read back from
  // Razorpay so a late event can never regress the subscription.
  if (razorpayConfigured(env)) subscription = await fetchSubscription(env, subscription.id);
  const notedUser = userIdFrom(subscription.notes?.user_id);
  const storedUser = userIdFrom(existing?.user_id);
  if (notedUser && storedUser && notedUser !== storedUser) {
    console.error('Razorpay subscription owner mismatch; keeping the stored owner', { subscription: subscription.id });
  }
  const userId = storedUser || notedUser;
  if (!userId) {
    console.warn('Razorpay subscription event without a resolvable user', { type, subscription: subscription.id });
    return 'ignored';
  }
  const { plans } = await loadPlanCatalog(env);
  const plan = planFromSubscription(plans, subscription) || plans.find(entry => entry.id === existing?.plan && entry.id !== 'free');
  if (!plan) {
    console.warn('Razorpay subscription for an unknown plan', { type, subscription: subscription.id });
    return 'ignored';
  }
  const status = subscriptionStatus(subscription.status) || EVENT_STATUS[type];
  const ended = ENDED_STATUSES.includes(status);
  const cancelAtPeriodEnd = !ended && (subscription.cancel_at_cycle_end === true || subscription.cancel_at_cycle_end === 1 ||
    existing?.cancel_at_period_end === true);
  await upsertSubscription(env, {
    userId, subscriptionId: subscription.id, plan: plan.id, status,
    periodStart: isoFromUnix(subscription.current_start), periodEnd: isoFromUnix(subscription.current_end),
    cancelAtPeriodEnd, raw: subscriptionSummary(subscription),
  });

  const payment = object(payload.payment?.entity);
  if (type === 'subscription.charged' && /^pay_[A-Za-z0-9]{6,40}$/.test(payment?.id || '')) {
    await recordPayment(env, { userId, paymentId: payment.id, kind: 'subscription', amount: payment.amount,
      currency: payment.currency, status: payment.status || 'captured', raw: paymentSummary(payment) });
    if ((payment.status || 'captured') === 'captured' && plan.monthly_credit_microusd > 0) {
      await grantCredits(env, { userId, microusd: plan.monthly_credit_microusd, reason: creditReason.subscription(plan), ref: payment.id });
    }
  }
  return 'processed';
}

async function orderFor(env, payment, payload) {
  const order = object(payload.order?.entity);
  if (order?.id === payment.order_id) return order;
  return razorpayConfigured(env) ? fetchOrder(env, payment.order_id) : null;
}

async function handleTopupEvent(env, type, payload) {
  const payment = object(payload.payment?.entity);
  if (!/^pay_[A-Za-z0-9]{6,40}$/.test(payment?.id || '')) return 'ignored';
  // Subscription charges carry no order; subscription.charged handles them.
  if (!/^order_[A-Za-z0-9]{6,40}$/.test(payment.order_id || '')) return 'ignored';
  const order = await orderFor(env, payment, payload);
  const pack = topupPack(order?.notes?.pack);
  const userId = userIdFrom(order?.notes?.user_id);
  if (!order || !pack || !userId) return 'ignored';
  const currency = String(order.currency || '').toUpperCase();
  if (!['INR', 'USD'].includes(currency) || Number(order.amount) !== priceFor(pack.price, currency) ||
      Number(payment.amount) !== Number(order.amount) || String(payment.currency).toUpperCase() !== currency) {
    console.error('Razorpay top-up amount mismatch; no credits granted', { type, payment: payment.id });
    return 'ignored';
  }
  const status = type === 'payment.failed' ? 'failed' : payment.status || 'captured';
  await recordPayment(env, { userId, paymentId: payment.id, kind: 'topup', amount: payment.amount, currency, status, raw: paymentSummary(payment) });
  if (status === 'captured') {
    await grantCredits(env, { userId, microusd: pack.credit_microusd, reason: creditReason.topup(pack), ref: payment.id });
  }
  return 'processed';
}

async function handleSubscriptionPaymentFailure(env, payload) {
  const payment = object(payload.payment?.entity);
  const userId = userIdFrom(payment?.notes?.user_id);
  if (!/^pay_[A-Za-z0-9]{6,40}$/.test(payment?.id || '') || !userId) return 'ignored';
  await recordPayment(env, { userId, paymentId: payment.id, kind: 'subscription', amount: payment.amount,
    currency: payment.currency, status: 'failed', raw: paymentSummary(payment) });
  return 'processed';
}

export async function handleRazorpayEvent(env, type, payload) {
  if (EVENT_STATUS[type]) return handleSubscriptionEvent(env, type, payload);
  if (type === 'payment.captured' || type === 'order.paid') return handleTopupEvent(env, type, payload);
  if (type === 'payment.failed') {
    const payment = object(payload.payment?.entity);
    return payment?.order_id ? handleTopupEvent(env, type, payload) : handleSubscriptionPaymentFailure(env, payload);
  }
  return 'ignored';
}

// Releasing a claim lets Razorpay's retry reprocess an event whose handling failed.
async function releaseClaim(env, eventId) {
  try { await rpc(env, 'zerox_webhook_release', { p_provider: PROVIDER, p_event_id: eventId }); }
  catch { console.error('Webhook claim could not be released; replay the event manually', { eventId }); }
}

export function registerWebhookRoutes(api) {
  api.post('/webhooks/razorpay', async c => {
    try {
      if (!webhookConfigured(c.env)) {
        return errorResponse(c, 503, 'billing_not_configured', 'Webhook verification is not configured.');
      }
      const declared = Number(c.req.header('content-length') || 0);
      if (declared > MAX_WEBHOOK_BYTES) return errorResponse(c, 413, 'invalid_request', 'Webhook payload too large.');
      // The signature covers the exact bytes Razorpay sent, so the raw body is verified first.
      const raw = await c.req.text();
      if (new TextEncoder().encode(raw).byteLength > MAX_WEBHOOK_BYTES) return errorResponse(c, 413, 'invalid_request', 'Webhook payload too large.');
      if (!await verifyWebhookSignature(c.env, raw, c.req.header('x-razorpay-signature') || '')) {
        return errorResponse(c, 400, 'invalid_signature', 'Webhook signature verification failed.');
      }
      let event;
      try { event = JSON.parse(raw); } catch { event = null; }
      if (!object(event) || typeof event.event !== 'string') return errorResponse(c, 400, 'invalid_request', 'Webhook body is not a Razorpay event.');
      const payloadHash = await sha256Hex(raw);
      const header = c.req.header('x-razorpay-event-id') || '';
      const eventId = /^[A-Za-z0-9_-]{1,128}$/.test(header) ? header : `sha256:${payloadHash}`;
      const claim = await rpc(c.env, 'zerox_webhook_claim', {
        p_provider: PROVIDER, p_event_id: eventId, p_event_type: event.event.slice(0, 64), p_payload_sha256: payloadHash,
      });
      if (claim?.claimed !== true) return c.json({ received: true, duplicate: true });
      let outcome;
      try {
        outcome = await handleRazorpayEvent(c.env, event.event, object(event.payload) || {});
      } catch (error) {
        console.error('Razorpay webhook processing failed', { type: event.event, eventId, message: error?.message });
        await releaseClaim(c.env, eventId);
        return errorResponse(c, 503, 'service_unavailable', 'Webhook processing failed; Razorpay will retry.');
      }
      return c.json(outcome === 'ignored' ? { received: true, ignored: true } : { received: true });
    } catch (error) {
      return sendApiError(c, error);
    }
  });
}

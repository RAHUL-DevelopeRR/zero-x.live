// WP-B3: Razorpay billing (docs/PLATFORM_CONTRACT.md §3.5) against a fake Razorpay HTTP server and a
// stubbed PostgREST: signatures, checkout, top-ups, verify, cancel, webhooks and plan bootstrap.
// Run: node check-billing.mjs
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import app from './src/index.js';
import { DEVELOPMENT_PLANS } from './src/plan-policy.js';
import {
  checkoutSignatureMessage, constantTimeEqual, hmacSha256, razorpayBase, toHex, verifyCheckoutSignature, verifySignature, verifyWebhookSignature,
} from './src/billing/razorpay.js';
import { bootstrapPlans, planSql } from './scripts/razorpay-bootstrap.mjs';

const SUPABASE_URL = 'https://billing.supabase.test';
const SECRET = 'sb_secret_billing_test';
const KEY_ID = 'rzp_test_ZeroXKey123';
const KEY_SECRET = 'test_key_secret_' + 'q'.repeat(16);
const WEBHOOK_SECRET = 'whsec_test_' + 'w'.repeat(20);
const PLAN_IDS = { pro: { INR: 'plan_ProInr000001', USD: 'plan_ProUsd000001' }, max: { INR: 'plan_MaxInr000001', USD: 'plan_MaxUsd000001' } };
const hmac = (secret, message) => createHmac('sha256', secret).update(message).digest('hex');
const rid = prefix => `${prefix}_${randomBytes(7).toString('hex')}`;
const originalFetch = globalThis.fetch;

// ── 1. Signatures: HMAC-SHA256 via WebCrypto with a constant-time comparison ──
assert.equal(toHex(await hmacSha256('key', 'message')), hmac('key', 'message'));
assert.equal(checkoutSignatureMessage({ paymentId: 'pay_1', subscriptionId: 'sub_1' }), 'pay_1|sub_1');
assert.equal(checkoutSignatureMessage({ paymentId: 'pay_1', orderId: 'order_1' }), 'order_1|pay_1');
const signatureEnv = { RAZORPAY_KEY_SECRET: KEY_SECRET, RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET };
assert.equal(await verifyCheckoutSignature(signatureEnv, { paymentId: 'pay_A', subscriptionId: 'sub_B', signature: hmac(KEY_SECRET, 'pay_A|sub_B') }), true);
assert.equal(await verifyCheckoutSignature(signatureEnv, { paymentId: 'pay_A', subscriptionId: 'sub_B', signature: hmac(KEY_SECRET, 'sub_B|pay_A') }), false,
  'subscription signatures sign payment_id|subscription_id');
assert.equal(await verifyCheckoutSignature(signatureEnv, { paymentId: 'pay_A', orderId: 'order_C', signature: hmac(KEY_SECRET, 'order_C|pay_A') }), true);
assert.equal(await verifyCheckoutSignature(signatureEnv, { paymentId: 'pay_A', orderId: 'order_C', signature: hmac(KEY_SECRET, 'pay_A|order_C') }), false,
  'order signatures sign order_id|payment_id');
assert.equal(await verifyCheckoutSignature(signatureEnv, { paymentId: 'pay_A', orderId: 'order_C', signature: hmac('wrong-secret', 'order_C|pay_A') }), false);
assert.equal(await verifyCheckoutSignature(signatureEnv, { paymentId: 'pay_A', orderId: 'order_C', signature: hmac(KEY_SECRET, 'order_C|pay_A').toUpperCase() }), true,
  'hex case does not matter');
for (const bad of ['', 'zz', hmac(KEY_SECRET, 'order_C|pay_A').slice(0, 63), hmac(KEY_SECRET, 'order_C|pay_A') + '0', null, undefined, 42]) {
  assert.equal(await verifySignature(KEY_SECRET, 'order_C|pay_A', bad), false, String(bad));
}
assert.equal(await verifySignature('', 'message', hmac('', 'message')), false, 'an empty secret never verifies');
assert.equal(await verifyWebhookSignature(signatureEnv, '{"a":1}', hmac(WEBHOOK_SECRET, '{"a":1}')), true);
assert.equal(await verifyWebhookSignature(signatureEnv, '{"a": 1}', hmac(WEBHOOK_SECRET, '{"a":1}')), false, 'webhooks sign the exact raw body');
assert.equal(await verifyWebhookSignature(signatureEnv, '{"a":1}', hmac(KEY_SECRET, '{"a":1}')), false, 'the webhook secret is not the key secret');
// Constant-time: every byte is compared no matter where the first difference is.
const expected = Uint8Array.from({ length: 32 }, (_, index) => index);
const counted = bytes => {
  const reads = new Set();
  return { reads, array: new Proxy(bytes, { get(target, key) { if (/^\d+$/.test(String(key))) reads.add(Number(key)); return Reflect.get(target, key); } }) };
};
for (const position of [0, 15, 31]) {
  const other = Uint8Array.from(expected);
  other[position] ^= 0xff;
  const left = counted(expected);
  const right = counted(other);
  assert.equal(constantTimeEqual(left.array, right.array), false);
  assert.equal(left.reads.size, 32, `all bytes compared when byte ${position} differs`);
  assert.equal(right.reads.size, 32);
}
assert.equal(constantTimeEqual(expected, Uint8Array.from(expected)), true);
assert.equal(constantTimeEqual(expected, expected.slice(0, 31)), false);
assert.equal(constantTimeEqual(expected, null), false);
assert.equal(razorpayBase({}), 'https://api.razorpay.com/v1');
assert.equal(razorpayBase({ RAZORPAY_API_BASE: 'http://127.0.0.1:9/v1/' }), 'http://127.0.0.1:9/v1');
for (const unsafe of ['http://evil.example/v1', 'https://user:pass@api.example/v1', 'ftp://127.0.0.1/v1', 'not a url']) {
  assert.throws(() => razorpayBase({ RAZORPAY_API_BASE: unsafe }), /RAZORPAY_API_BASE/, unsafe);
}

// ── 2. Fake Razorpay API ──
const rzp = { subscriptions: new Map(), orders: new Map(), payments: new Map(), plans: new Map(), requests: [], down: false };
const fakeRazorpay = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
  const url = new URL(req.url, 'http://razorpay.test');
  rzp.requests.push({ method: req.method, path: url.pathname, body });
  const send = (status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
  if (rzp.down) return send(500, { error: { code: 'SERVER_ERROR', description: 'down' } });
  if (req.headers.authorization !== 'Basic ' + Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64')) {
    return send(401, { error: { code: 'BAD_REQUEST_ERROR', description: 'Authentication failed' } });
  }
  const parts = url.pathname.split('/').filter(Boolean); // ['v1', resource, id?, action?]
  const [, resource, id, action] = parts;
  const notFound = () => send(400, { error: { code: 'BAD_REQUEST_ERROR', description: 'The id provided does not exist' } });
  if (resource === 'subscriptions' && req.method === 'POST' && !id) {
    if (!Object.values(PLAN_IDS).some(ids => Object.values(ids).includes(body.plan_id))) return send(400, { error: { code: 'BAD_REQUEST_ERROR', description: 'plan' } });
    const subscription = { id: rid('sub'), entity: 'subscription', plan_id: body.plan_id, status: 'created', current_start: null, current_end: null,
      total_count: body.total_count, customer_notify: body.customer_notify, quantity: body.quantity, notes: body.notes, created_at: 1760000000 };
    rzp.subscriptions.set(subscription.id, subscription);
    return send(200, subscription);
  }
  if (resource === 'subscriptions' && id && action === 'cancel' && req.method === 'POST') {
    const subscription = rzp.subscriptions.get(id);
    if (!subscription) return notFound();
    subscription.cancel_requested = body;
    if (body.cancel_at_cycle_end !== 1) subscription.status = 'cancelled';
    return send(200, subscription);
  }
  if (resource === 'subscriptions' && id && req.method === 'GET') return rzp.subscriptions.has(id) ? send(200, rzp.subscriptions.get(id)) : notFound();
  if (resource === 'orders' && req.method === 'POST' && !id) {
    const order = { id: rid('order'), entity: 'order', amount: body.amount, currency: body.currency, receipt: body.receipt, notes: body.notes, status: 'created' };
    rzp.orders.set(order.id, order);
    return send(200, order);
  }
  if (resource === 'orders' && id && req.method === 'GET') return rzp.orders.has(id) ? send(200, rzp.orders.get(id)) : notFound();
  if (resource === 'payments' && id && req.method === 'GET') return rzp.payments.has(id) ? send(200, rzp.payments.get(id)) : notFound();
  if (resource === 'plans' && req.method === 'GET') {
    const items = [...rzp.plans.values()];
    const skip = Number(url.searchParams.get('skip') || 0);
    const count = Number(url.searchParams.get('count') || 10);
    return send(200, { entity: 'collection', count: items.length, items: items.slice(skip, skip + count) });
  }
  if (resource === 'plans' && req.method === 'POST') {
    const plan = { id: rid('plan'), entity: 'plan', period: body.period, interval: body.interval, item: { id: rid('item'), ...body.item }, notes: body.notes };
    rzp.plans.set(plan.id, plan);
    return send(200, plan);
  }
  return send(404, { error: { code: 'NOT_FOUND', description: url.pathname } });
});
fakeRazorpay.listen(0, '127.0.0.1');
await once(fakeRazorpay, 'listening');
const RAZORPAY_API_BASE = `http://127.0.0.1:${fakeRazorpay.address().port}/v1`;
const now = () => Math.floor(Date.now() / 1000);
function paySubscription(subscriptionId, { amount, currency, status = 'captured' }) {
  const subscription = rzp.subscriptions.get(subscriptionId);
  Object.assign(subscription, { status: 'active', current_start: now(), current_end: now() + 30 * 86400 });
  const payment = { id: rid('pay'), entity: 'payment', amount, currency, status, order_id: null, invoice_id: rid('inv'), method: 'card',
    email: 'buyer@example.test', contact: '+910000000000', card: { last4: '1111' }, created_at: now() };
  rzp.payments.set(payment.id, payment);
  return payment;
}
function payOrder(orderId, { amount, currency, status = 'captured' } = {}) {
  const order = rzp.orders.get(orderId);
  order.status = status === 'captured' ? 'paid' : 'attempted';
  const payment = { id: rid('pay'), entity: 'payment', amount: amount ?? order.amount, currency: currency ?? order.currency, status, order_id: orderId,
    method: 'upi', email: 'buyer@example.test', created_at: now() };
  rzp.payments.set(payment.id, payment);
  return payment;
}

// ── 3. Stubbed PostgREST with billing semantics from contract §4 ──
const db = { accounts: new Map(), subscriptions: new Map(), payments: new Map(), grants: new Map(), claims: new Map(), calls: [], fail: new Set(), policiesV2: [] };
const policyRows = withIds => ['free', 'pro', 'max'].map(plan => ({
  plan, name: plan[0].toUpperCase() + plan.slice(1), monthly_credit_microusd: { free: 0, pro: 8000000, max: 35000000 }[plan],
  ...(withIds && plan !== 'free' ? { razorpay_plan_id_inr: PLAN_IDS[plan].INR, razorpay_plan_id_usd: PLAN_IDS[plan].USD } : {}),
}));
const ACTIVE = ['authenticated', 'active'];
const ENDED = ['cancelled', 'completed', 'expired'];
const rpc = {
  zerox_sync_account: ({ p_user_id, p_profile }) => {
    const row = db.accounts.get(p_user_id) || { clerk_id: p_user_id, plan: 'free', credit_balance_microusd: 0, daily_requests: 0, daily_tokens_used: 0 };
    Object.assign(row, { email: p_profile.email, name: p_profile.name, image_url: '' });
    db.accounts.set(p_user_id, row);
    return [row];
  },
  zerox_get_account: ({ p_user_id }) => db.accounts.has(p_user_id) ? [db.accounts.get(p_user_id)] : [],
  zerox_plan_policies: () => [{ policies: DEVELOPMENT_PLANS }],
  zerox_plan_policies_v2: () => db.policiesV2,
  zerox_account_overview: ({ p_user_id }) => {
    const account = db.accounts.get(p_user_id);
    const subscription = [...db.subscriptions.values()].filter(row => row.user_id === p_user_id).at(-1) ?? null;
    return account ? [{ account, policy: { plan: account.plan }, credits: { balance_microusd: account.credit_balance_microusd }, subscription, usage_today: {} }] : [];
  },
  zerox_billing_get: ({ p_user_id }) => [{
    subscription: [...db.subscriptions.values()].filter(row => row.user_id === p_user_id).at(-1) ?? null,
    payments: [...db.payments.values()].filter(row => row.user_id === p_user_id),
  }],
  zerox_billing_upsert_subscription: args => {
    const row = { ...(db.subscriptions.get(args.p_provider_subscription_id) || { id: crypto.randomUUID() }), user_id: args.p_user_id, provider: args.p_provider,
      provider_subscription_id: args.p_provider_subscription_id, plan: args.p_plan, status: args.p_status, current_period_start: args.p_current_period_start,
      current_period_end: args.p_current_period_end, cancel_at_period_end: args.p_cancel_at_period_end, raw: args.p_raw };
    db.subscriptions.delete(args.p_provider_subscription_id);
    db.subscriptions.set(args.p_provider_subscription_id, row);
    const account = db.accounts.get(args.p_user_id);
    if (account && ACTIVE.includes(args.p_status)) account.plan = args.p_plan;
    if (account && ENDED.includes(args.p_status)) account.plan = 'free';
    return [row];
  },
  zerox_billing_record_payment: args => {
    const existing = db.payments.get(args.p_provider_payment_id);
    const row = { ...(existing || { id: crypto.randomUUID(), created_at: new Date().toISOString() }), user_id: args.p_user_id, provider: args.p_provider,
      provider_payment_id: args.p_provider_payment_id, kind: args.p_kind, amount_minor: args.p_amount_minor, currency: args.p_currency,
      status: args.p_status, invoice_url: args.p_invoice_url, raw: args.p_raw };
    db.payments.set(args.p_provider_payment_id, row);
    return [row];
  },
  zerox_credit_grant: ({ p_user_id, p_delta_microusd, p_reason, p_ref }) => {
    const account = db.accounts.get(p_user_id);
    if (db.grants.has(p_ref)) return [{ granted: false, balance_microusd: account.credit_balance_microusd }];
    db.grants.set(p_ref, { user_id: p_user_id, delta: p_delta_microusd, reason: p_reason });
    account.credit_balance_microusd += p_delta_microusd;
    return [{ granted: true, balance_microusd: account.credit_balance_microusd }];
  },
  zerox_webhook_claim: ({ p_provider, p_event_id, p_event_type, p_payload_sha256 }) => {
    assert.equal(p_provider, 'razorpay');
    assert.match(p_payload_sha256, /^[0-9a-f]{64}$/);
    if (db.claims.has(p_event_id)) return [{ claimed: false }];
    db.claims.set(p_event_id, p_event_type);
    return [{ claimed: true }];
  },
  zerox_webhook_release: ({ p_event_id }) => { db.claims.delete(p_event_id); return []; },
  zerox_subscription_by_provider_id: ({ p_provider_subscription_id }) => db.subscriptions.has(p_provider_subscription_id)
    ? [db.subscriptions.get(p_provider_subscription_id)] : [],
};

const identities = new Map();
const router = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.startsWith(`${SUPABASE_URL}/rest/v1/rpc/`)) {
    assert.equal(init.headers.apikey, SECRET);
    const name = url.split('/').at(-1);
    const args = JSON.parse(init.body || '{}');
    db.calls.push({ name, args });
    if (db.fail.has(name)) return new Response('down', { status: 503 });
    if (!rpc[name]) return Response.json({ message: `missing ${name}` }, { status: 404 });
    return Response.json(rpc[name](args));
  }
  if (url === `${SUPABASE_URL}/auth/v1/user`) {
    const user = identities.get(init.headers.Authorization.replace(/^Bearer /, ''));
    return user ? Response.json(user) : Response.json({ msg: 'invalid' }, { status: 401 });
  }
  if (url.startsWith(RAZORPAY_API_BASE)) return originalFetch(input, init);
  throw new Error(`Unexpected outbound request: ${url}`);
};
globalThis.fetch = router;

const buyer = { id: '33333333-3333-4333-8333-333333333333', email: 'buyer@example.test', user_metadata: { name: 'Buyer One' } };
const other = { id: '44444444-4444-4444-8444-444444444444', email: 'other@example.test', user_metadata: { name: 'Other' } };
identities.set('billing-token-buyer', buyer);
identities.set('billing-token-other', other);
const baseEnv = { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', SUPABASE_SECRET_KEY: SECRET, SESSIONS_KV: { get: async () => null, put: async () => {}, delete: async () => {} } };
const billingEnv = { ...baseEnv, RAZORPAY_KEY_ID: KEY_ID, RAZORPAY_KEY_SECRET: KEY_SECRET, RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET, RAZORPAY_API_BASE };
const call = async (path, { method = 'POST', token = 'billing-token-buyer', body, bindings = billingEnv } = {}) => {
  const response = await app.request('https://zero-x.live' + path, {
    method, headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }, bindings);
  return { status: response.status, body: await response.json() };
};
const expectError = (result, status, code) => {
  assert.equal(result.status, status, `expected ${status} ${code}: ${JSON.stringify(result.body)}`);
  assert.equal(result.body.error.code, code);
  assert.match(result.body.error.request_id, /^req_/);
  assert.equal(typeof result.body.error.message, 'string');
};
const accountOf = user => db.accounts.get(user.id);
const webhookEvent = (event, payload) => ({ entity: 'event', account_id: 'acc_test', event, contains: Object.keys(payload),
  payload: Object.fromEntries(Object.entries(payload).map(([key, entity]) => [key, { entity }])), created_at: now() });
const deliver = (event, { eventId = rid('evt'), raw = JSON.stringify(event), signature, bindings = billingEnv, headers = {} } = {}) =>
  app.request('https://zero-x.live/webhooks/razorpay', {
    method: 'POST', body: raw,
    headers: { 'Content-Type': 'application/json', 'X-Razorpay-Event-Id': eventId, 'X-Razorpay-Signature': signature ?? hmac(WEBHOOK_SECRET, raw), ...headers },
  }, bindings);
const webhook = async (...args) => { const response = await deliver(...args); return { status: response.status, body: await response.json() }; };

try {
  // ── 4. billing_not_configured ──
  db.policiesV2 = policyRows(false);
  const noPlanIds = { ...billingEnv };
  expectError(await call('/api/billing/checkout', { body: { plan: 'pro', currency: 'INR' }, bindings: noPlanIds }), 503, 'billing_not_configured');
  const noKeys = { ...baseEnv };
  expectError(await call('/api/billing/checkout', { body: { plan: 'pro', currency: 'INR' }, bindings: noKeys }), 503, 'billing_not_configured');
  expectError(await call('/api/billing/topup', { body: { pack: 'credits_5', currency: 'INR' }, bindings: noKeys }), 503, 'billing_not_configured');
  expectError(await call('/api/billing/cancel', { bindings: noKeys }), 503, 'billing_not_configured');
  expectError(await call('/api/billing/verify', { bindings: noKeys, body: { razorpay_payment_id: 'pay_Abcdef123', razorpay_order_id: 'order_Abcdef123',
    razorpay_signature: 'a'.repeat(64) } }), 503, 'billing_not_configured');
  assert.equal((await call('/api/billing', { method: 'GET', bindings: noKeys })).body.provider_configured, false);
  const noWebhookSecret = await webhook(webhookEvent('payment.captured', {}), { bindings: noKeys });
  expectError(noWebhookSecret, 503, 'billing_not_configured');
  assert.equal(rzp.requests.length, 0, 'nothing reaches Razorpay while unconfigured');
  db.policiesV2 = policyRows(true);

  // ── 5. Checkout (subscription) ──
  const state = await call('/api/billing', { method: 'GET' });
  assert.deepEqual(state.body, { provider_configured: true, subscription: null, payments: [] });
  expectError(await call('/api/billing/checkout', { body: { plan: 'free', currency: 'INR' } }), 400, 'invalid_request');
  expectError(await call('/api/billing/checkout', { body: { plan: 'ultrawork', currency: 'INR' } }), 400, 'invalid_request');
  expectError(await call('/api/billing/checkout', { body: { plan: 'pro', currency: 'EUR' } }), 400, 'invalid_request');
  expectError(await call('/api/billing/checkout', { body: 'not-an-object' }), 400, 'invalid_request');
  const checkout = await call('/api/billing/checkout', { body: { plan: 'pro', currency: 'INR' } });
  assert.equal(checkout.status, 200);
  assert.match(checkout.body.subscription_id, /^sub_/);
  assert.deepEqual({ ...checkout.body, subscription_id: undefined }, {
    provider: 'razorpay', key_id: KEY_ID, subscription_id: undefined, name: 'Zero-X', description: 'Neuron Pro plan, billed monthly',
    prefill: { email: 'buyer@example.test', name: 'Buyer One' }, notes: { user_id: buyer.id, plan: 'pro' },
  });
  const created = rzp.requests.find(entry => entry.method === 'POST' && entry.path === '/v1/subscriptions');
  assert.deepEqual(created.body, { plan_id: PLAN_IDS.pro.INR, total_count: 120, quantity: 1, customer_notify: 1, notes: { user_id: buyer.id, plan: 'pro' } });
  const usdCheckout = await call('/api/billing/checkout', { token: 'billing-token-other', body: { plan: 'max', currency: 'USD' } });
  assert.equal(rzp.subscriptions.get(usdCheckout.body.subscription_id).plan_id, PLAN_IDS.max.USD, 'USD checkouts use the USD plan id');

  // ── 6. Verify (subscription): signature, ownership, live status and amount ──
  const subscriptionId = checkout.body.subscription_id;
  let payment = paySubscription(subscriptionId, { amount: 89900, currency: 'INR' });
  const subscriptionVerify = (paymentId, signature = hmac(KEY_SECRET, `${paymentId}|${subscriptionId}`), token = 'billing-token-buyer') =>
    call('/api/billing/verify', { token, body: { razorpay_payment_id: paymentId, razorpay_subscription_id: subscriptionId, razorpay_signature: signature } });
  const writesBefore = db.calls.filter(entry => entry.name.startsWith('zerox_billing_') && entry.name !== 'zerox_billing_get').length;
  expectError(await subscriptionVerify(payment.id, hmac(KEY_SECRET, `${subscriptionId}|${payment.id}`)), 400, 'invalid_signature');
  expectError(await subscriptionVerify(payment.id, hmac('not-the-secret', `${payment.id}|${subscriptionId}`)), 400, 'invalid_signature');
  assert.equal(db.calls.filter(entry => entry.name.startsWith('zerox_billing_') && entry.name !== 'zerox_billing_get').length, writesBefore,
    'nothing is recorded for a bad signature');
  expectError(await call('/api/billing/verify', { body: { razorpay_payment_id: payment.id, razorpay_signature: 'a'.repeat(64) } }), 400, 'invalid_request');
  expectError(await call('/api/billing/verify', { body: { razorpay_payment_id: payment.id, razorpay_subscription_id: subscriptionId,
    razorpay_order_id: 'order_Abcdef123', razorpay_signature: 'a'.repeat(64) } }), 400, 'invalid_request');
  expectError(await call('/api/billing/verify', { body: { razorpay_payment_id: 'pay_<script>', razorpay_subscription_id: subscriptionId, razorpay_signature: 'a'.repeat(64) } }),
    400, 'invalid_request');
  expectError(await subscriptionVerify(payment.id, undefined, 'billing-token-other'), 403, 'payment_mismatch');
  const wrongAmount = paySubscription(subscriptionId, { amount: 100, currency: 'INR' });
  expectError(await subscriptionVerify(wrongAmount.id), 400, 'payment_mismatch');
  const verified = await subscriptionVerify(payment.id);
  assert.equal(verified.status, 200);
  assert.equal(verified.body.status, 'ok');
  assert.equal(verified.body.account.plan.id, 'pro', 'the response carries the upgraded account');
  assert.equal(accountOf(buyer).plan, 'pro');
  const storedSubscription = db.subscriptions.get(subscriptionId);
  assert.equal(storedSubscription.status, 'active');
  assert.equal(storedSubscription.plan, 'pro');
  assert.equal(storedSubscription.current_period_end, new Date(rzp.subscriptions.get(subscriptionId).current_end * 1000).toISOString());
  const storedPayment = db.payments.get(payment.id);
  assert.deepEqual({ kind: storedPayment.kind, amount: storedPayment.amount_minor, currency: storedPayment.currency, status: storedPayment.status },
    { kind: 'subscription', amount: 89900, currency: 'INR', status: 'captured' });
  assert.ok(!JSON.stringify(storedPayment.raw).includes('1111') && !JSON.stringify(storedPayment.raw).includes('buyer@example.test'),
    'card and contact details are not stored');
  assert.equal(db.grants.size, 0, 'monthly credits come from subscription.charged, not verify');
  const pendingSubscription = (await call('/api/billing/checkout', { token: 'billing-token-other', body: { plan: 'pro', currency: 'INR' } })).body.subscription_id;
  const pendingPayment = { id: rid('pay'), amount: 89900, currency: 'INR', status: 'created' };
  rzp.payments.set(pendingPayment.id, pendingPayment);
  const pending = await call('/api/billing/verify', { token: 'billing-token-other', body: { razorpay_payment_id: pendingPayment.id,
    razorpay_subscription_id: pendingSubscription, razorpay_signature: hmac(KEY_SECRET, `${pendingPayment.id}|${pendingSubscription}`) } });
  assert.equal(pending.body.status, 'pending', 'unconfirmed subscriptions are not activated');
  assert.equal(accountOf(other).plan, 'free');

  expectError(await call('/api/billing/checkout', { body: { plan: 'max', currency: 'USD' } }), 409, 'already_subscribed');
  const billing = await call('/api/billing', { method: 'GET' });
  assert.deepEqual(billing.body.subscription, { id: subscriptionId, plan: 'pro', status: 'active', current_period_end: storedSubscription.current_period_end,
    cancel_at_period_end: false, provider: 'razorpay' });
  assert.deepEqual(billing.body.payments.find(entry => entry.id === payment.id), { id: payment.id, kind: 'subscription', amount_minor: 89900, currency: 'INR',
    status: 'captured', created_at: storedPayment.created_at, invoice_url: null });

  // ── 7. Top-ups: paid plans only, order amount from the pack price, credits once per payment ──
  expectError(await call('/api/billing/topup', { token: 'billing-token-other', body: { pack: 'credits_5', currency: 'INR' } }), 403, 'upgrade_required');
  expectError(await call('/api/billing/topup', { body: { pack: 'credits_7', currency: 'INR' } }), 400, 'invalid_request');
  const topup = await call('/api/billing/topup', { body: { pack: 'credits_5', currency: 'INR' } });
  assert.equal(topup.status, 200);
  assert.match(topup.body.order_id, /^order_/);
  assert.deepEqual({ ...topup.body, order_id: undefined }, { provider: 'razorpay', key_id: KEY_ID, order_id: undefined, amount_minor: 44900, currency: 'INR',
    name: 'Zero-X', description: '$5 Neuron credit top-up', prefill: { email: 'buyer@example.test', name: 'Buyer One' } });
  const order = rzp.orders.get(topup.body.order_id);
  assert.deepEqual(order.notes, { user_id: buyer.id, pack: 'credits_5' });
  assert.ok(order.receipt.length <= 40 && order.receipt.startsWith('topup_'));
  const usdTopup = await call('/api/billing/topup', { body: { pack: 'credits_20', currency: 'USD' } });
  assert.equal(usdTopup.body.amount_minor, 2000);
  const orderVerify = (orderId, paymentId, signature = hmac(KEY_SECRET, `${orderId}|${paymentId}`), token = 'billing-token-buyer') =>
    call('/api/billing/verify', { token, body: { razorpay_payment_id: paymentId, razorpay_order_id: orderId, razorpay_signature: signature } });
  const topupPayment = payOrder(order.id);
  expectError(await orderVerify(order.id, topupPayment.id, hmac(KEY_SECRET, `${topupPayment.id}|${order.id}`)), 400, 'invalid_signature');
  expectError(await orderVerify(order.id, topupPayment.id, undefined, 'billing-token-other'), 403, 'payment_mismatch');
  const balanceBefore = accountOf(buyer).credit_balance_microusd;
  const toppedUp = await orderVerify(order.id, topupPayment.id);
  assert.equal(toppedUp.body.status, 'ok');
  assert.equal(accountOf(buyer).credit_balance_microusd - balanceBefore, 5000000);
  assert.equal(toppedUp.body.account.credits.balance_usd, 5);
  assert.deepEqual(db.grants.get(topupPayment.id), { user_id: buyer.id, delta: 5000000, reason: 'topup:credits_5' }, 'ref = payment id');
  await orderVerify(order.id, topupPayment.id);
  assert.equal(accountOf(buyer).credit_balance_microusd - balanceBefore, 5000000, 'verifying twice never grants twice');
  const tamperedOrder = (await call('/api/billing/topup', { body: { pack: 'credits_5', currency: 'INR' } })).body.order_id;
  const underpaid = payOrder(tamperedOrder, { amount: 100 });
  expectError(await orderVerify(tamperedOrder, underpaid.id), 400, 'payment_mismatch');
  const failedOrder = (await call('/api/billing/topup', { body: { pack: 'credits_5', currency: 'INR' } })).body.order_id;
  const failedPayment = payOrder(failedOrder, { status: 'failed' });
  expectError(await orderVerify(failedOrder, failedPayment.id), 402, 'payment_failed');
  rzp.down = true;
  const downOrder = { id: rid('order') };
  expectError(await orderVerify(downOrder.id, 'pay_Down12345'), 502, 'payment_provider_error');
  expectError(await call('/api/billing/topup', { body: { pack: 'credits_5', currency: 'INR' } }), 502, 'payment_provider_error');
  rzp.down = false;

  // ── 8. Webhooks: raw-body signatures, duplicates, credit grants, plan/status mapping ──
  const subscriptionEntity = id => ({ ...rzp.subscriptions.get(id) });
  const charge = paySubscription(subscriptionId, { amount: 89900, currency: 'INR' });
  const charged = webhookEvent('subscription.charged', { subscription: subscriptionEntity(subscriptionId), payment: charge });
  const rawCharged = JSON.stringify(charged, null, 2);
  expectError(await webhook(charged, { raw: JSON.stringify(charged), signature: hmac(WEBHOOK_SECRET, rawCharged) }), 400, 'invalid_signature');
  expectError(await webhook(charged, { signature: '' }), 400, 'invalid_signature');
  expectError(await webhook(charged, { signature: hmac(KEY_SECRET, rawCharged), raw: rawCharged }), 400, 'invalid_signature');
  assert.equal(db.claims.size, 0, 'unverified deliveries are never claimed');
  const creditsBefore = accountOf(buyer).credit_balance_microusd;
  const eventId = rid('evt');
  assert.deepEqual((await webhook(charged, { raw: rawCharged, eventId })).body, { received: true });
  assert.equal(accountOf(buyer).credit_balance_microusd - creditsBefore, 8000000, 'subscription.charged grants the monthly credits');
  assert.equal(db.grants.get(charge.id).reason, 'subscription:pro');
  assert.equal(db.payments.get(charge.id).kind, 'subscription');
  assert.deepEqual((await webhook(charged, { raw: rawCharged, eventId })).body, { received: true, duplicate: true });
  assert.deepEqual((await webhook(charged, { raw: rawCharged })).body, { received: true }, 'a new event id for the same payment is processed');
  assert.equal(accountOf(buyer).credit_balance_microusd - creditsBefore, 8000000, 'credits are granted once per payment id');
  const nextCharge = paySubscription(subscriptionId, { amount: 89900, currency: 'INR' });
  await webhook(webhookEvent('subscription.charged', { subscription: subscriptionEntity(subscriptionId), payment: nextCharge }));
  assert.equal(accountOf(buyer).credit_balance_microusd - creditsBefore, 16000000, 'the next cycle grants again');

  // Max plan in USD, user resolved from notes; plan mapped from the Razorpay plan id.
  const maxSubscription = usdCheckout.body.subscription_id;
  const maxCharge = paySubscription(maxSubscription, { amount: 4000, currency: 'USD' });
  const maxEntity = { ...subscriptionEntity(maxSubscription), notes: { user_id: other.id } };
  await webhook(webhookEvent('subscription.activated', { subscription: maxEntity }));
  assert.equal(db.subscriptions.get(maxSubscription).plan, 'max');
  assert.equal(accountOf(other).plan, 'max');
  await webhook(webhookEvent('subscription.charged', { subscription: maxEntity, payment: maxCharge }));
  assert.equal(db.grants.get(maxCharge.id).delta, 35000000, 'max grants $35');
  // Out-of-order delivery cannot regress state: the live subscription is read back.
  await webhook(webhookEvent('subscription.halted', { subscription: { ...maxEntity, status: 'halted' } }));
  assert.equal(db.subscriptions.get(maxSubscription).status, 'active', 'live state wins over a stale payload');
  // Without API keys the payload status is used and the user comes from the stored subscription.
  const webhookOnly = { ...baseEnv, RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET };
  await webhook(webhookEvent('subscription.pending', { subscription: { ...maxEntity, notes: {}, status: 'pending' } }), { bindings: webhookOnly });
  assert.equal(db.subscriptions.get(maxSubscription).status, 'pending');
  assert.equal(db.subscriptions.get(maxSubscription).user_id, other.id);
  const unknownUser = await webhook(webhookEvent('subscription.activated', { subscription: { id: 'sub_Unknown12345', plan_id: PLAN_IDS.pro.INR, status: 'active', notes: {} } }),
    { bindings: webhookOnly });
  assert.deepEqual(unknownUser.body, { received: true, ignored: true }, 'verified but unresolvable events are acknowledged');
  const unknownPlan = await webhook(webhookEvent('subscription.activated', { subscription: { id: 'sub_OtherPlan123', plan_id: 'plan_SomethingElse', status: 'active',
    notes: { user_id: other.id } } }), { bindings: webhookOnly });
  assert.deepEqual(unknownPlan.body, { received: true, ignored: true });
  assert.deepEqual((await webhook(webhookEvent('refund.created', {}))).body, { received: true, ignored: true });
  assert.deepEqual((await webhook(webhookEvent('subscription.authenticated', { subscription: { id: 'not-a-sub' } }))).body, { received: true, ignored: true });

  // Cancellation: schedule at cycle end, then downgrade when Razorpay ends the subscription.
  const cancelled = await call('/api/billing/cancel');
  assert.deepEqual(cancelled.body, { status: 'cancel_scheduled', current_period_end: new Date(rzp.subscriptions.get(subscriptionId).current_end * 1000).toISOString() });
  assert.deepEqual(rzp.subscriptions.get(subscriptionId).cancel_requested, { cancel_at_cycle_end: 1 });
  assert.equal(db.subscriptions.get(subscriptionId).cancel_at_period_end, true);
  assert.equal(accountOf(buyer).plan, 'pro', 'access continues until the period ends');
  assert.equal((await call('/api/billing/cancel')).body.status, 'cancel_scheduled', 'cancel is idempotent');
  assert.equal(rzp.requests.filter(entry => entry.path.endsWith('/cancel')).length, 1);
  await webhook(webhookEvent('subscription.charged', { subscription: subscriptionEntity(subscriptionId), payment: paySubscription(subscriptionId, { amount: 89900, currency: 'INR' }) }));
  assert.equal(db.subscriptions.get(subscriptionId).cancel_at_period_end, true, 'a scheduled cancellation survives later events');
  rzp.subscriptions.get(subscriptionId).status = 'cancelled';
  await webhook(webhookEvent('subscription.cancelled', { subscription: subscriptionEntity(subscriptionId) }));
  assert.equal(db.subscriptions.get(subscriptionId).status, 'cancelled');
  assert.equal(db.subscriptions.get(subscriptionId).cancel_at_period_end, false);
  assert.equal(accountOf(buyer).plan, 'free', 'cancellation downgrades the account');
  expectError(await call('/api/billing/cancel'), 409, 'no_active_subscription');

  // Top-up webhooks: payment.captured / order.paid grant once per payment; mismatches are ignored.
  accountOf(buyer).plan = 'pro';
  const webhookOrder = (await call('/api/billing/topup', { body: { pack: 'credits_20', currency: 'INR' } })).body.order_id;
  const webhookPayment = payOrder(webhookOrder);
  const balance = accountOf(buyer).credit_balance_microusd;
  await webhook(webhookEvent('payment.captured', { payment: webhookPayment }));
  assert.equal(accountOf(buyer).credit_balance_microusd - balance, 20000000);
  await webhook(webhookEvent('order.paid', { order: rzp.orders.get(webhookOrder), payment: webhookPayment }));
  await orderVerify(webhookOrder, webhookPayment.id);
  assert.equal(accountOf(buyer).credit_balance_microusd - balance, 20000000, 'webhook + verify grant once');
  const forgedOrder = { ...rzp.orders.get(webhookOrder), id: rid('order'), amount: 100 };
  const forgedPayment = { ...webhookPayment, id: rid('pay'), order_id: forgedOrder.id, amount: 100 };
  assert.deepEqual((await webhook(webhookEvent('order.paid', { order: forgedOrder, payment: forgedPayment }))).body, { received: true, ignored: true });
  assert.ok(!db.grants.has(forgedPayment.id), 'an order that does not match its pack price grants nothing');
  const declinedOrder = (await call('/api/billing/topup', { body: { pack: 'credits_5', currency: 'INR' } })).body.order_id;
  const declined = payOrder(declinedOrder, { status: 'failed' });
  await webhook(webhookEvent('payment.failed', { payment: declined }));
  assert.equal(db.payments.get(declined.id).status, 'failed');
  assert.ok(!db.grants.has(declined.id));

  // Failures release the claim so Razorpay's retry is processed.
  const retryEvent = webhookEvent('subscription.activated', { subscription: subscriptionEntity(maxSubscription) });
  const retryId = rid('evt');
  db.fail.add('zerox_billing_upsert_subscription');
  expectError(await webhook(retryEvent, { eventId: retryId }), 503, 'service_unavailable');
  assert.ok(!db.claims.has(retryId), 'the claim is released after a processing failure');
  db.fail.delete('zerox_billing_upsert_subscription');
  assert.deepEqual((await webhook(retryEvent, { eventId: retryId })).body, { received: true });
  db.fail.add('zerox_webhook_claim');
  expectError(await webhook(retryEvent), 503, 'service_unavailable');
  db.fail.delete('zerox_webhook_claim');
  // Body limits and malformed bodies.
  const huge = JSON.stringify({ event: 'payment.captured', pad: 'x'.repeat(300 * 1024) });
  expectError(await webhook(null, { raw: huge }), 413, 'invalid_request');
  expectError(await webhook(null, { raw: 'not json' }), 400, 'invalid_request');
  expectError(await webhook(null, { raw: '[1,2]' }), 400, 'invalid_request');
  const noEventId = await webhook(webhookEvent('refund.processed', {}), { headers: { 'X-Razorpay-Event-Id': '' } });
  assert.deepEqual(noEventId.body, { received: true, ignored: true });
  assert.ok([...db.claims.keys()].some(key => key.startsWith('sha256:')), 'deliveries without an event id are deduplicated by payload hash');

  // ── 9. scripts/razorpay-bootstrap.mjs ──
  const dryWithoutKeys = await bootstrapPlans({ env: {} });
  assert.deepEqual(dryWithoutKeys.map(row => [row.plan, row.currency, row.amount, row.action]), [
    ['pro', 'INR', 89900, 'would_create'], ['pro', 'USD', 1000, 'would_create'], ['max', 'INR', 349900, 'would_create'], ['max', 'USD', 4000, 'would_create'],
  ]);
  assert.match(planSql(dryWithoutKeys), /<razorpay plan id INR>/);
  await assert.rejects(bootstrapPlans({ env: {}, apply: true }), /RAZORPAY_KEY_ID/);
  await assert.rejects(bootstrapPlans({ env: { ...billingEnv, RAZORPAY_KEY_ID: 'rzp_live_RealKey123' } }), /live/);
  const bootstrapEnv = { RAZORPAY_KEY_ID: KEY_ID, RAZORPAY_KEY_SECRET: KEY_SECRET, RAZORPAY_API_BASE };
  const plansBefore = rzp.plans.size;
  const dryRun = await bootstrapPlans({ env: bootstrapEnv });
  assert.ok(dryRun.every(row => row.action === 'would_create'));
  assert.equal(rzp.plans.size, plansBefore, 'dry run creates nothing');
  const applied = await bootstrapPlans({ env: bootstrapEnv, apply: true });
  assert.ok(applied.every(row => row.action === 'created' && /^plan_/.test(row.id)));
  const createdPlans = [...rzp.plans.values()];
  assert.deepEqual(createdPlans.map(plan => [plan.notes.zerox_plan, plan.item.currency, plan.item.amount, plan.period, plan.interval]), [
    ['pro', 'INR', 89900, 'monthly', 1], ['pro', 'USD', 1000, 'monthly', 1], ['max', 'INR', 349900, 'monthly', 1], ['max', 'USD', 4000, 'monthly', 1],
  ]);
  const again = await bootstrapPlans({ env: bootstrapEnv, apply: true });
  assert.ok(again.every(row => row.action === 'existing'));
  assert.equal(rzp.plans.size, 4, 'bootstrap is idempotent');
  const sql = planSql(applied);
  assert.equal(sql.split('\n').length, 2);
  assert.ok(sql.includes(`razorpay_plan_id_inr = '${applied[0].id}', razorpay_plan_id_usd = '${applied[1].id}' WHERE plan = 'pro';`));
  assert.ok(sql.includes(`WHERE plan = 'max';`));
  assert.match(planSql([{ plan: 'pro', currency: 'INR', id: "plan_x'; DROP TABLE x; --" }]), /<razorpay plan id INR>/, 'ids are validated before SQL output');
} finally {
  globalThis.fetch = originalFetch;
  fakeRazorpay.close();
}
console.log('PASS: Razorpay signatures (positive/negative, constant-time), checkout/topup/verify/cancel against a fake Razorpay server, ' +
  'raw-body webhook verification, duplicate events, credits once per payment, plan/status mapping, downgrade on cancellation, ' +
  'billing_not_configured and plan bootstrap');

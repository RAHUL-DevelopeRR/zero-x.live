import { accountRpc, rpcRows, databaseConfigured } from './account-store.js';

// Development-only allocations; production policy is maintained in Postgres.
export const DEVELOPMENT_PLANS = Object.freeze({
  free: { name: 'Free', daily_tokens: 256000, daily_requests: 2000, price_usd: 0 },
  pro: { name: 'Pro', daily_tokens: 2000000, daily_requests: 20000, price_usd: 10 },
  max: { name: 'Max', daily_tokens: 50000000, daily_requests: 10000, price_usd: 40 },
  ultrawork: { name: 'Pro (Legacy Ultrawork)', daily_tokens: 2000000, daily_requests: 20000, price_usd: 10 },
});
const cache = new WeakMap();

export async function loadPlanLimits(env) {
  if (!databaseConfigured(env)) {
    if (env.ALLOW_ANONYMOUS_SESSIONS === 'true') return DEVELOPMENT_PLANS;
    throw new Error('Account policy unavailable');
  }
  const cached = cache.get(env);
  if (cached?.expires > Date.now()) return cached.policies;
  const { policies } = await accountRpc(env, 'zerox_plan_policies', {}) || {};
  if (!policies?.free || Object.values(policies).some(plan =>
    typeof plan?.name !== 'string' || !Number.isSafeInteger(plan.daily_tokens) || plan.daily_tokens < 1 ||
    !Number.isSafeInteger(plan.daily_requests) || plan.daily_requests < 1 ||
    !Number.isFinite(plan.price_usd) || plan.price_usd < 0)) throw new Error('Invalid account policy');
  cache.set(env, { policies, expires: Date.now() + 60000 });
  return policies;
}

// ── Public plan catalogue (docs/PLATFORM_CONTRACT.md §1) ──
// Static fallback used when the database is unavailable. It must stay identical to the seeded
// zerox_plan_policy rows. Prices are in minor units (cents/paise); credits are micro-USD.
export const PAID_PLAN_IDS = Object.freeze(['pro', 'max']);
export const PLAN_CATALOG = Object.freeze([
  Object.freeze({
    id: 'free', name: 'Free', price: { usd_cents: 0, inr_paise: 0 }, interval: 'month',
    limits: { daily_requests: 100, daily_tokens: 500000, rpm: 10, concurrency: 2 },
    monthly_credit_microusd: 0, tiers: ['free'], highlighted: false,
    features: ['Free upstream models (Groq, Gemini, Workers AI)', '100 requests and 500K tokens per day',
      '10 requests per minute, 2 concurrent', 'Bring your own OpenRouter key'],
  }),
  Object.freeze({
    id: 'pro', name: 'Pro', price: { usd_cents: 1000, inr_paise: 89900 }, interval: 'month',
    limits: { daily_requests: 2000, daily_tokens: 10000000, rpm: 30, concurrency: 4 },
    monthly_credit_microusd: 8000000, tiers: ['free', 'paid'], highlighted: true,
    features: ['Everything in Free', '$8 of paid-model credits every month', '2,000 requests and 10M tokens per day',
      '30 requests per minute, 4 concurrent', 'Personal API keys for CI and headless runs'],
  }),
  Object.freeze({
    id: 'max', name: 'Max', price: { usd_cents: 4000, inr_paise: 349900 }, interval: 'month',
    limits: { daily_requests: 10000, daily_tokens: 50000000, rpm: 60, concurrency: 8 },
    monthly_credit_microusd: 35000000, tiers: ['free', 'paid'], highlighted: false,
    features: ['Everything in Pro', '$35 of paid-model credits every month', '10,000 requests and 50M tokens per day',
      '60 requests per minute, 8 concurrent', 'Priority access to paid capacity'],
  }),
]);
export const TOPUP_PACKS = Object.freeze([
  Object.freeze({ id: 'credits_5', credit_usd: 5, credit_microusd: 5000000, price: { usd_cents: 500, inr_paise: 44900 } }),
  Object.freeze({ id: 'credits_20', credit_usd: 20, credit_microusd: 20000000, price: { usd_cents: 2000, inr_paise: 174900 } }),
]);
const LEGACY_PLAN_ALIASES = { ultrawork: 'pro' };

// Maps any stored plan id (including the legacy `ultrawork`) onto a catalogue id.
export function normalizePlanId(plan) {
  const key = String(plan || 'free').toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (LEGACY_PLAN_ALIASES[key]) return LEGACY_PLAN_ALIASES[key];
  return PLAN_CATALOG.some(entry => entry.id === key) ? key : 'free';
}

export function topupPack(id) {
  return TOPUP_PACKS.find(pack => pack.id === id) || null;
}

const integer = (value, fallback) => {
  const number = typeof value === 'string' && value.trim() ? Number(value) : value;
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
};
const minorUnits = (minor, major, fallback) => {
  const exact = integer(minor, null);
  if (exact !== null) return exact;
  const amount = major === null || major === undefined || major === '' ? NaN : Number(major);
  return Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) : fallback;
};
const tierList = (value, fallback) => {
  const list = Array.isArray(value) ? value
    : typeof value === 'string' ? value.replace(/^\{|\}$/g, '').split(',') : null;
  const tiers = list?.map(tier => String(tier).trim().replace(/^"|"$/g, '')).filter(tier => ['free', 'paid'].includes(tier));
  return tiers?.length ? tiers : fallback;
};
const razorpayPlanId = value => typeof value === 'string' && /^plan_[A-Za-z0-9]{6,40}$/.test(value) ? value : null;

// Maps one zerox_plan_policies_v2 row onto its static entry, keeping the static value for
// every column the row omits or provides in an invalid form.
function catalogEntry(base, row) {
  return {
    ...base,
    name: typeof row.name === 'string' && row.name.trim() ? row.name.trim() : base.name,
    price: {
      usd_cents: minorUnits(row.price_usd_cents, row.price_usd, base.price.usd_cents),
      inr_paise: minorUnits(row.price_inr_paise, row.price_inr, base.price.inr_paise),
    },
    limits: {
      daily_requests: integer(row.daily_requests, base.limits.daily_requests),
      daily_tokens: integer(row.daily_tokens, base.limits.daily_tokens),
      rpm: integer(row.rpm ?? row.requests_per_minute, base.limits.rpm),
      concurrency: integer(row.concurrency ?? row.max_concurrency, base.limits.concurrency),
    },
    monthly_credit_microusd: integer(row.monthly_credit_microusd, base.monthly_credit_microusd),
    tiers: tierList(row.tiers, base.tiers),
    features: Array.isArray(row.features) && row.features.length && row.features.every(item => typeof item === 'string')
      ? row.features : base.features,
    highlighted: typeof row.highlighted === 'boolean' ? row.highlighted : base.highlighted,
    razorpay_plan_id_inr: razorpayPlanId(row.razorpay_plan_id_inr),
    razorpay_plan_id_usd: razorpayPlanId(row.razorpay_plan_id_usd),
  };
}

const withoutProviderIds = base => ({ ...base, razorpay_plan_id_inr: null, razorpay_plan_id_usd: null });
const staticCatalog = () => ({ source: 'static', plans: PLAN_CATALOG.map(withoutProviderIds) });
const catalogCache = new WeakMap();

// Returns {source, plans[]} from zerox_plan_policies_v2 (cached for 60 s), falling back to the
// static contract catalogue when the database is not configured or the RPC fails.
export async function loadPlanCatalog(env) {
  if (!databaseConfigured(env)) return staticCatalog();
  const cached = catalogCache.get(env);
  if (cached?.expires > Date.now()) return cached.value;
  let value;
  let ttl = 60000;
  try {
    const rows = (await rpcRows(env, 'zerox_plan_policies_v2', {})).filter(row => row && typeof row === 'object');
    const plans = PLAN_CATALOG.map(base => {
      const row = rows.find(item => String(item.plan ?? item.id ?? '').toLowerCase() === base.id);
      return row ? catalogEntry(base, row) : withoutProviderIds(base);
    });
    value = { source: rows.length ? 'database' : 'static', plans };
  } catch {
    console.warn('Plan catalogue unavailable; serving the static contract catalogue');
    value = staticCatalog();
    ttl = 10000;
  }
  catalogCache.set(env, { value, expires: Date.now() + ttl });
  return value;
}

export async function planById(env, id) {
  const { plans } = await loadPlanCatalog(env);
  return plans.find(plan => plan.id === normalizePlanId(id)) || plans[0];
}

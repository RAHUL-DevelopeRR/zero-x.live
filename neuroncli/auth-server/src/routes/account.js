import { rpc, rpcRows } from '../account-store.js';
import { ApiError, ALL_CREDENTIALS, bearerToken, invalidSession, withCaller } from '../auth-context.js';
import { normalizePlanId, planById } from '../plan-policy.js';
import { sessionExpiry } from '../session-store.js';
import { microusdToUsd } from './plans.js';

const DAY_MS = 86400000;
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
const count = value => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
};
export const nextUtcMidnight = (now = Date.now()) => new Date((Math.floor(now / DAY_MS) + 1) * DAY_MS).toISOString();
// Postgres jsonb renders timestamps as '2026-10-17T00:00:00+00:00'; the API always answers in
// the ISO form the gateway's errors use ('2026-10-17T00:00:00.000Z').
export const isoTime = value => {
  if (typeof value !== 'string' || !value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};

// The apps' account row (A3): the profile name, else the email's local part. Names come from
// the sign-in provider, so they are trimmed, stripped of control characters and capped.
const DISPLAY_NAME_LIMIT = 80;
const cleanName = value => typeof value === 'string'
  ? Array.from(value.replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim()).slice(0, DISPLAY_NAME_LIMIT).join('').trim() : '';
export function displayName(account = {}, caller = {}) {
  const fullName = [account.first_name, account.last_name].map(cleanName).filter(Boolean).join(' ');
  for (const candidate of [account.name, caller.name, fullName, account.username]) {
    const name = cleanName(candidate);
    if (name) return name;
  }
  const email = cleanName(account.email || caller.email);
  return cleanName(email.includes('@') ? email.slice(0, email.indexOf('@')) : email) || 'Zero-X user';
}
// One letter for a one-word name, else the first letters of the first and last words; email
// local parts split on dots, dashes and underscores ("rahul.s" → "RS").
export function initials(name) {
  const words = cleanName(name).split(/[\s._-]+/u)
    .map(word => word.match(/[\p{L}\p{N}]/u)?.[0]).filter(Boolean);
  if (!words.length) return '?';
  return (words.length === 1 ? words[0] : words[0] + words.at(-1)).toLocaleUpperCase('en');
}

// When the credential behind this request stops working, for "sign in again" warnings: a CLI
// session's expiry, a website access token's `exp`; API keys and dev identities never expire.
export function credentialExpiresAt(env, caller, token = '') {
  if (caller.kind === 'session' && caller.session) {
    const expires = sessionExpiry(env, caller.session);
    return Number.isFinite(expires) ? new Date(expires).toISOString() : null;
  }
  if (caller.kind === 'supabase') {
    try {
      const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      return Number.isSafeInteger(payload?.exp) && payload.exp > 0 ? new Date(payload.exp * 1000).toISOString() : null;
    } catch { return null; }
  }
  return null;
}

// Builds the GET /api/account payload from zerox_account_overview (jsonb columns account,
// policy, credits, subscription, usage_today), filling gaps from the plan catalogue.
export async function accountPayload(env, caller, { token = '' } = {}) {
  const row = await rpc(env, 'zerox_account_overview', { p_user_id: caller.user_id });
  if (!row) throw invalidSession();
  const account = object(row.account) || {};
  const policy = object(row.policy) || {};
  const credits = object(row.credits) || {};
  const usage = object(row.usage_today) || object(row.usage) || {};
  const subscription = object(row.subscription);
  const planId = normalizePlanId(policy.plan ?? policy.id ?? account.plan ?? caller.plan);
  const plan = await planById(env, planId);
  // policy is a zerox_plan_policies_v2 row (rpm_limit, concurrency_limit, ...); the catalogue
  // value is used for a column the row lacks.
  const limit = (name, ...columns) => {
    for (const key of columns) {
      if (policy[key] !== null && policy[key] !== undefined && policy[key] !== '' && Number.isSafeInteger(Number(policy[key]))) {
        return Number(policy[key]);
      }
    }
    return plan.limits[name];
  };
  const name = displayName(account, caller);
  return {
    user: {
      id: caller.user_id,
      email: account.email || caller.email || '',
      name: account.name || caller.name || '',
      display_name: name,
      initials: initials(name),
      image_url: account.image_url || caller.image_url || '',
    },
    session_expires_at: credentialExpiresAt(env, caller, token),
    plan: { id: planId, name: typeof policy.name === 'string' && policy.name ? policy.name : plan.name },
    limits: {
      daily_requests: limit('daily_requests', 'daily_requests'),
      daily_tokens: limit('daily_tokens', 'daily_tokens'),
      rpm: limit('rpm', 'rpm_limit', 'rpm'),
      concurrency: limit('concurrency', 'concurrency_limit', 'concurrency'),
    },
    usage_today: {
      requests: count(usage.requests ?? account.daily_requests),
      tokens: count(usage.tokens ?? usage.tokens_used ?? account.daily_tokens_used),
      resets_at: isoTime(usage.resets_at) ?? nextUtcMidnight(),
    },
    credits: {
      balance_usd: microusdToUsd(credits.balance_microusd ?? row.credit_balance_microusd ?? 0),
      monthly_grant_usd: microusdToUsd(credits.monthly_grant_microusd ?? policy.monthly_credit_microusd ?? plan.monthly_credit_microusd),
    },
    subscription: subscription ? {
      status: subscription.status ?? null,
      current_period_end: isoTime(subscription.current_period_end),
      cancel_at_period_end: subscription.cancel_at_period_end === true,
    } : null,
    flags: { suspended: caller.suspended === true || account.suspended === true || account.status === 'suspended' || row.suspended === true },
  };
}

function parseDay(value, param) {
  const invalid = () => new ApiError(400, 'invalid_request', `\`${param}\` must be a calendar date in YYYY-MM-DD format.`, { param });
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw invalid();
  const time = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) throw invalid();
  return time;
}
const dayText = time => new Date(time).toISOString().slice(0, 10);

export const MAX_USAGE_DAYS = 92;
// Validates ?from&to: inclusive range, at most 92 days, default the last 30 days (UTC).
export function usageRange(query, now = Date.now()) {
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  const to = query.to === undefined ? today : parseDay(query.to, 'to');
  const from = query.from === undefined ? to - 29 * DAY_MS : parseDay(query.from, 'from');
  if (from > to) throw new ApiError(400, 'invalid_request', '`from` must not be after `to`.', { param: 'from' });
  if ((to - from) / DAY_MS + 1 > MAX_USAGE_DAYS) {
    throw new ApiError(400, 'invalid_request', `A usage range may span at most ${MAX_USAGE_DAYS} days.`, { param: 'from' });
  }
  return { from: dayText(from), to: dayText(to), fromTime: from, toTime: to };
}

const usageRow = row => ({
  requests: count(row?.requests),
  prompt_tokens: count(row?.prompt_tokens),
  completion_tokens: count(row?.completion_tokens),
  cost_microusd: count(row?.cost_microusd),
});
const withCost = ({ cost_microusd, ...row }) => ({ ...row, cost_usd: microusdToUsd(cost_microusd) });

export async function usagePayload(env, userId, range) {
  const args = { p_user_id: userId, p_from: range.from, p_to: range.to };
  const [seriesRows, modelRows] = await Promise.all([
    rpcRows(env, 'zerox_usage_series', args),
    rpcRows(env, 'zerox_usage_by_model', args),
  ]);
  const byDay = new Map();
  for (const row of seriesRows) {
    if (!row?.day) continue;
    const day = String(row.day).slice(0, 10);
    const current = byDay.get(day) || usageRow(null);
    const next = usageRow(row);
    byDay.set(day, Object.fromEntries(Object.keys(current).map(key => [key, current[key] + next[key]])));
  }
  const series = [];
  const totals = usageRow(null);
  for (let time = range.fromTime; time <= range.toTime; time += DAY_MS) {
    const day = dayText(time);
    const row = byDay.get(day) || usageRow(null);
    for (const key of Object.keys(totals)) totals[key] += row[key];
    series.push({ day, ...withCost(row) });
  }
  const byModel = modelRows.filter(row => typeof row?.model === 'string')
    .map(row => ({ model: row.model, ...withCost(usageRow(row)) }))
    .sort((left, right) => right.requests - left.requests || left.model.localeCompare(right.model));
  return { from: range.from, to: range.to, series, by_model: byModel, totals: withCost(totals) };
}

// zerox_usage_events clamps p_limit to this many rows (WP-B1).
export const EVENTS_PAGE_LIMIT = 200;

function eventsQuery(query) {
  let limit = 50;
  if (query.limit !== undefined) {
    if (!/^\d{1,3}$/.test(query.limit) || Number(query.limit) < 1 || Number(query.limit) > 200) {
      throw new ApiError(400, 'invalid_request', '`limit` must be an integer between 1 and 200.', { param: 'limit' });
    }
    limit = Number(query.limit);
  }
  let before = null;
  if (query.before !== undefined) {
    if (!/^[1-9]\d{0,14}$/.test(query.before)) {
      throw new ApiError(400, 'invalid_request', '`before` must be an event id returned as `next_before`.', { param: 'before' });
    }
    before = Number(query.before);
  }
  return { limit, before };
}

const eventView = row => ({
  id: row.id,
  created_at: isoTime(row.created_at),
  model: row.model ?? null,
  provider: row.provider ?? null,
  tier: row.tier ?? null,
  status: row.status ?? null,
  prompt_tokens: count(row.prompt_tokens),
  completion_tokens: count(row.completion_tokens),
  cost_usd: microusdToUsd(row.cost_microusd ?? 0),
  latency_ms: row.latency_ms === null || row.latency_ms === undefined ? null : count(row.latency_ms),
  request_id: row.request_id ?? null,
});

export function registerAccountRoutes(api) {
  api.get('/api/account', withCaller(ALL_CREDENTIALS, async (c, caller) =>
    c.json(await accountPayload(c.env, caller, { token: bearerToken(c) }))));

  api.get('/api/usage', withCaller(ALL_CREDENTIALS, async (c, caller) => {
    const range = usageRange({ from: c.req.query('from'), to: c.req.query('to') });
    return c.json(await usagePayload(c.env, caller.user_id, range));
  }));

  api.get('/api/usage/events', withCaller(ALL_CREDENTIALS, async (c, caller) => {
    const { limit, before } = eventsQuery({ limit: c.req.query('limit'), before: c.req.query('before') });
    // One extra row tells whether another page exists. zerox_usage_events returns at most
    // EVENTS_PAGE_LIMIT rows, so a full maximum page is followed by a one-row probe.
    const fetchRows = async (pageLimit, cursor) => (await rpcRows(c.env, 'zerox_usage_events',
      { p_user_id: caller.user_id, p_limit: pageLimit, p_before: cursor })).filter(row => row && row.id !== undefined && row.id !== null);
    const rows = await fetchRows(Math.min(limit + 1, EVENTS_PAGE_LIMIT), before);
    const page = rows.slice(0, limit);
    let more = rows.length > limit;
    if (!more && limit === EVENTS_PAGE_LIMIT && page.length === limit) more = (await fetchRows(1, page.at(-1).id)).length > 0;
    return c.json({ events: page.map(eventView), next_before: more ? page.at(-1).id : null });
  }));
}

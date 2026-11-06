// Capacity reservation and settlement (docs/PLATFORM_CONTRACT.md §3.3, §4).
// Account-backed sessions reserve each attempt against the user's quota, credits and the
// shared pool budget atomically in Postgres (zerox_reserve_v2); anonymous/dev sessions
// without a database keep the session-KV daily allocation.
import { databaseConfigured, rpc } from './account-store.js';
import { poolKey } from './catalog.js';
import { billableUsage, costMicrousd, estimateOutputTokens, reserveCostMicrousd } from './pricing.js';
import { billedDailyCapMicrousd } from './catalog-guardrails.js';
import { providerType } from './catalog-types.js';

export function usesLedger(env, session) {
  return Boolean(session?.account_backed && session.user_id) && databaseConfigured(env || {});
}

// Paid pools need credits, which exist only in the account ledger.
export function sessionTiers(env, session, policy) {
  const tiers = [...(policy?.tiers || ['free'])];
  return usesLedger(env, session) ? tiers : tiers.filter(tier => tier === 'free');
}

export const RESERVE_ERRORS = Object.freeze({
  no_account: 'invalid_session',
  suspended: 'account_suspended',
  upgrade_required: 'upgrade_required',
  user_daily_requests: 'insufficient_quota',
  user_daily_tokens: 'insufficient_quota',
  user_window_tokens: 'insufficient_quota',
  user_rpm: 'rate_limited',
  user_concurrency: 'rate_limited',
  insufficient_credits: 'insufficient_credits',
  pool_exhausted: 'capacity_exhausted',
  // This user has used its fair share of a free pool (migration 20261106000000, audit F6): the pool
  // is not exhausted for anyone else, so it is skipped for this request without being remembered.
  user_pool_share: 'capacity_exhausted',
});

// Statuses about the caller rather than the pool: failover cannot help.
export const TERMINAL_RESERVE_STATUSES = new Set(['no_account', 'suspended', 'user_daily_requests',
  'user_daily_tokens', 'user_window_tokens', 'user_rpm', 'user_concurrency']);
// Statuses that rule out every paid pool for the rest of the request.
export const PAID_DENIED_STATUSES = new Set(['upgrade_required', 'insufficient_credits']);

const RESERVE_MESSAGES = {
  user_daily_requests: 'You have used today\'s request allocation. It resets at midnight UTC; upgrade for more.',
  user_daily_tokens: 'This request exceeds your remaining daily token allocation. It resets at midnight UTC; upgrade for more.',
  user_rpm: 'Too many requests per minute for your plan. Retry after the indicated delay.',
  user_concurrency: 'Too many requests are running at once for your plan. Retry when one finishes.',
  insufficient_credits: 'Claude and other paid models need credits for the most a request can cost (its prompt plus max_tokens) ' +
    'before it starts, and credits held by your running requests count as used until they finish. Lower max_tokens, top up, ' +
    'or wait for your renewal.',
};

export function nextUtcMidnight(now = Date.now()) {
  return new Date((Math.floor(now / 86400000) + 1) * 86400000).toISOString();
}

// "5-hour" for 18000 s, "90-minute" for 5400 s: the length of a plan's rolling token window.
export function windowLength(seconds) {
  const value = Number(seconds);
  if (!Number.isSafeInteger(value) || value < 60) return null;
  if (value % 3600 === 0) return `${value / 3600}-hour`;
  return `${Math.round(value / 60)}-minute`;
}

// "17:05 UTC" for a time within a day, else "Nov 3, 17:05 UTC"; rounded up to the minute so
// the time shown is never before the window frees.
export function formatWindowTime(value, now = Date.now()) {
  const time = Date.parse(value || '');
  if (!Number.isFinite(time)) return null;
  const at = new Date(Math.ceil(time / 60000) * 60000);
  const clock = at.toISOString().slice(11, 16) + ' UTC';
  if (at.getTime() - now < 86400000) return clock;
  return at.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) + ', ' + clock;
}

const tokenCount = value => Number(value).toLocaleString('en-US');

// Whether a refused request is larger than the plan's whole window, so it can never fit.
export function exceedsWindow(row, tokens) {
  const limit = Number(row?.window_tokens);
  const needed = Number(tokens);
  return Number.isSafeInteger(limit) && limit > 0 && Number.isSafeInteger(needed) && needed > limit;
}

// The message for user_window_tokens (zerox_reserve_v2 window_* columns, migration
// 20261102000000), from the window's count (window_used_tokens, without the refused request) and
// the request's reserved tokens:
// - used up: "You've used your 1,000,000 tokens for this 5-hour window; it frees up at 17:05 UTC."
// - not enough left: "This request needs 30,000 tokens but only 10,000 of your 1,000,000 tokens
//   for this 5-hour window are left; enough frees up at 17:05 UTC."
// - larger than the window: no time is given, since waiting never makes it fit.
export function windowQuotaMessage(row, now = Date.now(), tokens = null) {
  const limit = Number(row?.window_tokens);
  const length = windowLength(row?.window_seconds);
  if (!Number.isSafeInteger(limit) || limit < 1 || !length) {
    return 'This request does not fit in the tokens left in your current usage window. Retry after the indicated delay, or upgrade for more.';
  }
  const needed = Number(tokens);
  const knownNeed = Number.isSafeInteger(needed) && needed > 0;
  if (exceedsWindow(row, tokens)) {
    return `This request needs ${tokenCount(needed)} tokens, more than the ${tokenCount(limit)} tokens your plan allows in a ` +
      `${length} window, so it cannot run on this plan. Shorten the conversation or lower max_tokens, or upgrade.`;
  }
  const at = formatWindowTime(row?.window_resets_at || row?.resets_at, now);
  const used = Number(row?.window_used_tokens);
  const knownUse = Number.isSafeInteger(used) && used >= 0;
  if (!knownUse || used >= limit) {
    return at ? `You've used your ${tokenCount(limit)} tokens for this ${length} window; it frees up at ${at}.`
      : `You've used your ${tokenCount(limit)} tokens for this ${length} window. Retry after the indicated delay.`;
  }
  const left = tokenCount(limit - used);
  const need = knownNeed ? `This request needs ${tokenCount(needed)} tokens but only` : 'This request needs more than the';
  return `${need} ${left} of your ${tokenCount(limit)} tokens for this ${length} window are left; ` +
    (at ? `enough frees up at ${at}.` : 'retry after the indicated delay.');
}

// Output tokens a reservation holds against the user's daily tokens and the shared pool budget
// until settlement replaces the estimate with the real usage. max_tokens is a ceiling, not an
// estimate: holding all of it let one Groq request (8K TPM, max_tokens fitted to the rest of
// the minute) take the whole per-minute budget of every user. Paid credits still hold the cost
// of the full max_tokens.
export const RESERVED_OUTPUT_TOKENS = 1024;

export function reservedTokens(promptTokens, maxTokens) {
  return promptTokens + Math.min(maxTokens, RESERVED_OUTPUT_TOKENS);
}

// The shared budget is counted per model and tier in Postgres. A provider key vault pool
// (src/catalog.js entryPools) reserves against its own key's bucket and budget (p_pool_key), so a
// key that spent its org or project budget returns pool_exhausted and the chat handler moves on
// to the model's next key. Other pools omit p_pool_key and share the model's default bucket.
//
// Paid pools hold the worst case of the attempt in credits (pricing.js reserveCostMicrousd) and
// carry the pool's daily spend cap as p_pool.cpd (billed micro-USD per UTC day, the effective cap
// of src/catalog-guardrails.js): Postgres refuses the reservation with pool_exhausted until 00:00
// UTC once the day's holds and settled cost would pass it. A paid pool without a price or a cap
// is never offered (catalog.js poolConfigured); reaching here without one is a bug, so it throws.
// A free pool of a provider type with free_concurrency (src/catalog-types.js) carries it as
// p_pool.concurrency: Postgres refuses with pool_exhausted while that many requests of the pool
// key run (contract section 8.6).
export function reservationArgs({ env = {}, session, requestId, entry, pool, promptTokens, maxTokens }) {
  const { limits } = pool;
  const paid = pool.tier === 'paid';
  let budget = limits ? { rpm: limits.rpm ?? null, rpd: limits.rpd ?? null,
    tpm: limits.tpm ?? null, tpd: limits.tpd ?? null } : null;
  if (paid) {
    const cpd = billedDailyCapMicrousd(env, entry, pool);
    if (!pool.price || cpd === null) throw Object.assign(new Error('paid_pool_unpriced'), { name: 'PaidPoolUnpriced' });
    budget = { ...(budget ?? { rpm: null, rpd: null, tpm: null, tpd: null }), cpd };
  }
  const concurrency = pool.tier === 'free' ? providerType(entry.provider)?.free_concurrency ?? null : null;
  if (concurrency !== null) budget = { ...(budget ?? { rpm: null, rpd: null, tpm: null, tpd: null }), concurrency };
  return {
    p_user_id: session.user_id,
    p_request_id: requestId,
    p_model: entry.id,
    p_tier: pool.tier,
    p_tokens: reservedTokens(promptTokens, maxTokens),
    p_cost_microusd: paid ? reserveCostMicrousd(pool.price, promptTokens, maxTokens) : 0,
    p_pool: budget,
    ...(pool.key_id ? { p_pool_key: poolKey(entry, pool) } : {}),
  };
}

export async function reserveCapacity(env, args) {
  const row = await rpc(env, 'zerox_reserve_v2', args);
  if (!row || typeof row.status !== 'string') throw new Error('Reservation returned no status');
  return row;
}

// Error code and details for a non-ok reservation status (unknown statuses fail closed). tokens
// is the refused reservation's p_tokens, for the window message.
export function reserveError(row, now = Date.now(), tokens = null) {
  const status = row?.status;
  const code = RESERVE_ERRORS[status] || 'service_unavailable';
  const retry = Number(row?.retry_after_seconds);
  if (status === 'user_window_tokens') {
    const message = windowQuotaMessage(row, now, tokens);
    // Larger than the whole window: no time makes it fit, so no resets_at or Retry-After.
    if (exceedsWindow(row, tokens)) return { code, message, resetsAt: null, retryAfterSeconds: undefined };
    // A rolling window frees at a known time: resets_at and Retry-After say when.
    const resetsAt = row?.window_resets_at || row?.resets_at || null;
    const until = Math.ceil((Date.parse(resetsAt || '') - now) / 1000);
    return { code, message, resetsAt,
      retryAfterSeconds: retry > 0 ? retry : until > 0 ? until : undefined };
  }
  const options = { code, message: RESERVE_MESSAGES[status] };
  if (code === 'insufficient_quota') options.resetsAt = row?.resets_at || nextUtcMidnight();
  if (code === 'rate_limited') options.retryAfterSeconds = retry > 0 ? retry : status === 'user_rpm' ? 60 : 5;
  if (code === 'capacity_exhausted') options.retryAfterSeconds = retry > 0 ? retry : 60;
  return options;
}

// zerox_settle_v2 arguments. Refunds bill nothing; otherwise real usage (Gemini: from
// total_tokens) or, when the upstream sent none, the byte-based estimate. The pool bucket
// (model, tier and vault key) is the one stored on the reservation. Prompt-cache reads and
// writes (5-minute and 1-hour writes together) are part of p_prompt_tokens; each is billed at its
// own rate (migration 20261029000800, the 11-argument zerox_settle_v2).
export function settlementArgs({ reservationId, entry, pool, usage, promptEstimate = 0, outputBytes = 0,
  status, latencyMs = 0, errorCode = null }) {
  let billed = null;
  if (status !== 'refunded') {
    billed = billableUsage(usage, { prompt_tokens: promptEstimate, completion_tokens: estimateOutputTokens(outputBytes) });
  }
  const prompt = billed?.prompt_tokens ?? 0;
  const completion = billed?.completion_tokens ?? 0;
  return {
    p_reservation_id: reservationId,
    p_prompt_tokens: prompt,
    p_completion_tokens: completion,
    p_cost_microusd: billed && pool.tier === 'paid' ? costMicrousd(pool.price, prompt, completion, billed) : 0,
    p_status: status,
    p_latency_ms: Math.max(0, Math.round(latencyMs)),
    p_provider: entry.provider,
    p_upstream_model: entry.upstream_model,
    p_error_code: errorCode,
    p_cache_read_tokens: billed?.cache_read_tokens ?? 0,
    p_cache_write_tokens: (billed?.cache_write_tokens ?? 0) + (billed?.cache_write_1h_tokens ?? 0),
  };
}

export async function settleCapacity(env, args) {
  return rpc(env, 'zerox_settle_v2', args);
}

// A reservation holds its user's concurrency slot for a lease (90 s from zerox_reserve_v2) that
// the attempt renews while it runs, so a request whose isolate dies frees its slot on its own.
export const RESERVATION_RENEW_MS = 30000;
export const RESERVATION_LEASE_SECONDS = 90;

// Extends the lease of an in-flight reservation; false once it is settled or released.
export async function renewCapacity(env, reservationId, leaseSeconds) {
  return rpc(env, 'zerox_renew_reservation', { p_reservation_id: reservationId, p_lease_seconds: leaseSeconds });
}

// Runs background work through the Worker execution context when there is one.
export function runInBackground(c, promise) {
  try {
    const ctx = c.executionCtx;
    if (typeof ctx?.waitUntil === 'function') {
      ctx.waitUntil(promise);
      return true;
    }
  } catch { /* Hono throws when no ExecutionContext exists (Node server, tests). */ }
  return false;
}

// ── Session-KV allocation (anonymous/dev sessions without an account ledger) ──

// The daily token cap of a session-KV allocation. These sessions keep no per-request history,
// so a plan with a rolling window (zerox_plan_policies window_tokens, migration 20261102000000)
// holds them to one window's tokens per UTC day rather than to daily_tokens (which for such a
// plan is the most five windows allow in a day and refuses nothing in the ledger).
export function sessionDailyTokenCap(limits) {
  const daily = Number(limits?.daily_tokens);
  const window = Number(limits?.window_tokens);
  const seconds = Number(limits?.window_seconds);
  return Number.isSafeInteger(window) && window > 0 && Number.isSafeInteger(seconds) && seconds > 0
    ? Math.min(daily, window) : daily;
}

export async function reserveSessionQuota({ c, token, session, tokens, planLimits, setSession, provider }) {
  const policies = await planLimits(c.env);
  const limits = policies[session.plan] || policies.free;
  const requests = Number(session.requests || 0);
  const used = Number(session.tokens_used || 0);
  const cap = sessionDailyTokenCap(limits);
  if (requests >= limits.daily_requests || used + tokens > cap) {
    return { ok: false, resetsAt: nextUtcMidnight() };
  }
  session.requests = requests + 1;
  session.tokens_used = used + tokens;
  session.provider_used = provider;
  await setSession(c, token, session);
  return {
    ok: true,
    remainingRequests: Math.max(0, limits.daily_requests - session.requests),
    remainingTokens: Math.max(0, cap - session.tokens_used),
  };
}

// Replaces the reservation with actual usage; refunds also return the request.
export async function settleSessionQuota({ c, token, getSession, setSession, reserved, actualTokens, refundRequest, day }) {
  const current = await getSession(c, token);
  if (!current || current.usage_day !== day) return;
  current.tokens_used = Math.max(0, Number(current.tokens_used || 0) + actualTokens - reserved);
  if (refundRequest) current.requests = Math.max(0, Number(current.requests || 0) - 1);
  await setSession(c, token, current);
}

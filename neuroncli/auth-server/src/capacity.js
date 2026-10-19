// Capacity reservation and settlement (docs/PLATFORM_CONTRACT.md §3.3, §4).
// Account-backed sessions reserve each attempt against the user's quota, credits and the
// shared pool budget atomically in Postgres (zerox_reserve_v2); anonymous/dev sessions
// without a database keep the session-KV daily allocation.
import { databaseConfigured, rpc } from './account-store.js';
import { billableUsage, costMicrousd, estimateOutputTokens } from './pricing.js';

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
  user_rpm: 'rate_limited',
  user_concurrency: 'rate_limited',
  insufficient_credits: 'insufficient_credits',
  pool_exhausted: 'capacity_exhausted',
});

// Statuses about the caller rather than the pool: failover cannot help.
export const TERMINAL_RESERVE_STATUSES = new Set(['no_account', 'suspended', 'user_daily_requests',
  'user_daily_tokens', 'user_rpm', 'user_concurrency']);
// Statuses that rule out every paid pool for the rest of the request.
export const PAID_DENIED_STATUSES = new Set(['upgrade_required', 'insufficient_credits']);

const RESERVE_MESSAGES = {
  user_daily_requests: 'You have used today\'s request allocation. It resets at midnight UTC; upgrade for more.',
  user_daily_tokens: 'This request exceeds your remaining daily token allocation. It resets at midnight UTC; upgrade for more.',
  user_rpm: 'Too many requests per minute for your plan. Retry after the indicated delay.',
  user_concurrency: 'Too many requests are running at once for your plan. Retry when one finishes.',
};

export function nextUtcMidnight(now = Date.now()) {
  return new Date((Math.floor(now / 86400000) + 1) * 86400000).toISOString();
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

// The shared budget is counted per model and tier in Postgres, so a model served by several
// vault keys reserves against all of them together (pool.shared_limits, src/catalog.js).
export function reservationArgs({ session, requestId, entry, pool, promptTokens, maxTokens }) {
  const limits = pool.shared_limits || pool.limits;
  return {
    p_user_id: session.user_id,
    p_request_id: requestId,
    p_model: entry.id,
    p_tier: pool.tier,
    p_tokens: reservedTokens(promptTokens, maxTokens),
    p_cost_microusd: pool.tier === 'paid' ? costMicrousd(pool.price, promptTokens, maxTokens) : 0,
    p_pool: limits ? { rpm: limits.rpm ?? null, rpd: limits.rpd ?? null,
      tpm: limits.tpm ?? null, tpd: limits.tpd ?? null } : null,
  };
}

export async function reserveCapacity(env, args) {
  const row = await rpc(env, 'zerox_reserve_v2', args);
  if (!row || typeof row.status !== 'string') throw new Error('Reservation returned no status');
  return row;
}

// Error code and details for a non-ok reservation status (unknown statuses fail closed).
export function reserveError(row) {
  const status = row?.status;
  const code = RESERVE_ERRORS[status] || 'service_unavailable';
  const retry = Number(row?.retry_after_seconds);
  const options = { code, message: RESERVE_MESSAGES[status] };
  if (code === 'insufficient_quota') options.resetsAt = row?.resets_at || nextUtcMidnight();
  if (code === 'rate_limited') options.retryAfterSeconds = retry > 0 ? retry : status === 'user_rpm' ? 60 : 5;
  if (code === 'capacity_exhausted') options.retryAfterSeconds = retry > 0 ? retry : 60;
  return options;
}

// zerox_settle_v2 arguments. Refunds bill nothing; otherwise real usage (Gemini: from
// total_tokens) or, when the upstream sent none, the byte-based estimate.
export function settlementArgs({ reservationId, entry, pool, usage, promptEstimate = 0, outputBytes = 0,
  status, latencyMs = 0, errorCode = null }) {
  let prompt = 0;
  let completion = 0;
  if (status !== 'refunded') {
    const billed = billableUsage(usage, { prompt_tokens: promptEstimate, completion_tokens: estimateOutputTokens(outputBytes) });
    prompt = billed.prompt_tokens;
    completion = billed.completion_tokens;
  }
  return {
    p_reservation_id: reservationId,
    p_prompt_tokens: prompt,
    p_completion_tokens: completion,
    p_cost_microusd: pool.tier === 'paid' ? costMicrousd(pool.price, prompt, completion) : 0,
    p_status: status,
    p_latency_ms: Math.max(0, Math.round(latencyMs)),
    p_provider: entry.provider,
    p_upstream_model: entry.upstream_model,
    p_error_code: errorCode,
  };
}

export async function settleCapacity(env, args) {
  return rpc(env, 'zerox_settle_v2', args);
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

export async function reserveSessionQuota({ c, token, session, tokens, planLimits, setSession, provider }) {
  const policies = await planLimits(c.env);
  const limits = policies[session.plan] || policies.free;
  const requests = Number(session.requests || 0);
  const used = Number(session.tokens_used || 0);
  if (requests >= limits.daily_requests || used + tokens > limits.daily_tokens) {
    return { ok: false, resetsAt: nextUtcMidnight() };
  }
  session.requests = requests + 1;
  session.tokens_used = used + tokens;
  session.provider_used = provider;
  await setSession(c, token, session);
  return {
    ok: true,
    remainingRequests: Math.max(0, limits.daily_requests - session.requests),
    remainingTokens: Math.max(0, limits.daily_tokens - session.tokens_used),
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

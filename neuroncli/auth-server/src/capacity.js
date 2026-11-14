// Capacity reservation and settlement (docs/PLATFORM_CONTRACT.md §3.3, §4).
// Account-backed sessions reserve each attempt against the user's quota, credits and the
// shared pool budget atomically in Postgres (zerox_reserve_v2); anonymous/dev sessions
// without a database keep the session-KV daily allocation.
import { databaseConfigured, rpc } from './account-store.js';
import { missingFunction } from './db/errors.js';
import { poolKey } from './catalog.js';
import { billableUsage, costMicrousd, countedTokens, estimateOutputTokens, reserveCostMicrousd,
  TOKEN_LIMIT_CACHE_READ_WEIGHT } from './pricing.js';
import { billedDailyCapMicrousd, sponsoredTermsFor } from './catalog-guardrails.js';
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
  user_family_month_tokens: 'insufficient_quota',
  user_rpm: 'rate_limited',
  user_concurrency: 'rate_limited',
  insufficient_credits: 'insufficient_credits',
  pool_exhausted: 'capacity_exhausted',
  // This user has used its fair share of a free pool (migration 20261106000000, audit F6): the pool
  // is not exhausted for anyone else, so it is skipped for this request without being remembered.
  user_pool_share: 'capacity_exhausted',
});

// Statuses about the caller rather than the pool: failover cannot help. user_family_month_tokens is
// about the caller too, but only about one model family: the chat handler skips that family's other
// candidates and carries on (contract section 19.3), so it is not in this set.
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

// "Dec 1, 00:00 UTC" for the first of a month; "November" for the month before it.
export function formatMonthReset(value) {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return null;
  return `${at.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}, 00:00 UTC`;
}
export function monthName(resetsAt, now = Date.now()) {
  const at = Date.parse(resetsAt || '');
  const inMonth = Number.isFinite(at) ? new Date(at - 1) : new Date(now);
  return inMonth.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
}

// A reservation holds the request's whole input (the byte estimate, cached part included) plus up
// to RESERVED_OUTPUT_TOKENS until it settles, while the window and month counts hold counted tokens
// (cache reads at the lower weight, pricing.js countedTokens). The refusal messages therefore say
// how much the request holds until it finishes, not what it will count.
const HOLD_NOTE = '(its whole input; cached input counts less after the request finishes)';
const holds = needed => `This request holds up to ${tokenCount(needed)} tokens until it finishes`;

// The message for user_family_month_tokens (zerox_reserve_v2 cap_* columns, migration
// 20261106000600), from the month's count (cap_used_tokens, without the refused request) and the
// request's reserved tokens:
// - used up: "You've used your 10,000,000 Claude Haiku 5.5 tokens for November; the allowance renews on Dec 1, 00:00 UTC.
//   Other models keep working."
// - not enough left: "This request holds up to 48,200 tokens until it finishes (its whole input; cached
//   input counts less after the request finishes), but only 12,000 of your 10,000,000 Claude Haiku 5.5 tokens for November are left; the allowance renews on Dec 1, 00:00 UTC. Choose another model until then."
// - larger than the whole allowance: no time is given, since waiting never makes it fit.
export function monthQuotaMessage(row, name = 'this model', tokens = null, now = Date.now()) {
  const limit = Number(row?.cap_tokens);
  const label = `${name} tokens`;
  if (!Number.isSafeInteger(limit) || limit < 1) return `You have used this month's allowance of ${label}. Other models keep working.`;
  const needed = Number(tokens);
  if (Number.isSafeInteger(needed) && needed > limit) {
    return `${holds(needed)}, more than the ${tokenCount(limit)} ${label} your plan allows a month, so it cannot run on this model.`;
  }
  const month = monthName(row?.cap_resets_at ?? row?.resets_at, now);
  const renews = formatMonthReset(row?.cap_resets_at ?? row?.resets_at);
  const used = Number(row?.cap_used_tokens);
  const left = Number.isSafeInteger(used) && used >= 0 ? limit - used : 0;
  const when = renews ? `the allowance renews on ${renews}` : 'the allowance renews next month';
  if (left <= 0) return `You've used your ${tokenCount(limit)} ${label} for ${month}; ${when}. Other models keep working.`;
  const need = Number.isSafeInteger(needed) && needed > 0 ? `${holds(needed)} ${HOLD_NOTE}, but only` : 'This request needs more than the';
  return `${need} ${tokenCount(left)} of your ${tokenCount(limit)} ${label} for ${month} are left; ${when}. Choose another model until then.`;
}

// Whether a refused request is larger than the plan's whole window, so it can never fit.
export function exceedsWindow(row, tokens) {
  const limit = Number(row?.window_tokens);
  const needed = Number(tokens);
  return Number.isSafeInteger(limit) && limit > 0 && Number.isSafeInteger(needed) && needed > limit;
}

// The message for user_window_tokens (zerox_reserve_v2 window_* columns, migration
// 20261102000000), from the window's count (window_used_tokens, without the refused request) and
// the request's reserved tokens:
// - used up: "You've used your 3,000,000 tokens for this 5-hour window; it frees up at 17:05 UTC."
// - not enough left: "This request holds up to 30,000 tokens until it finishes (its whole input; cached
//   input counts less after the request finishes), but only 10,000 of your 3,000,000 tokens for this 5-hour
//   window are left; enough frees up at 17:05 UTC."
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
    return `${holds(needed)}, more than the ${tokenCount(limit)} tokens your plan allows in a ` +
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
  const need = knownNeed ? `${holds(needed)} ${HOLD_NOTE}, but only` : 'This request needs more than the';
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
//
// `budgetPromptTokens` (src/prompt-calibration.js) is the prompt the reservation holds against the
// user's tokens and the pool budget (p_tokens); `promptTokens`, the byte estimate, still sets the
// credit hold (p_cost_microusd). Without it both use promptTokens.
export function reservationArgs({ env = {}, session, requestId, entry, pool, promptTokens, maxTokens, budgetPromptTokens = null }) {
  const { limits } = pool;
  const paid = pool.tier === 'paid';
  // A sponsored pool (free tier, operator-paid key slot; catalog-types.js SPONSORED_FREE_MODELS) is priced
  // and capped like a paid one and carries its family's monthly allowance (p_cap), but the user is never charged.
  const sponsored = sponsoredTermsFor(entry, pool);
  let budget = limits ? { rpm: limits.rpm ?? null, rpd: limits.rpd ?? null,
    tpm: limits.tpm ?? null, tpd: limits.tpd ?? null } : null;
  if (paid || sponsored) {
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
    p_tokens: reservedTokens(Number.isSafeInteger(budgetPromptTokens) && budgetPromptTokens > 0
      ? Math.min(budgetPromptTokens, promptTokens) : promptTokens, maxTokens),
    p_cost_microusd: paid || sponsored ? reserveCostMicrousd(pool.price, promptTokens, maxTokens) : 0,
    p_pool: budget,
    ...(pool.key_id ? { p_pool_key: poolKey(entry, pool) } : {}),
    // Only sponsored pools send p_cap, so every other reservation keeps the 8-argument call.
    ...(sponsored ? { p_cap: { family: sponsored.family, month_tokens: sponsored.user_month_tokens } } : {}),
  };
}

export async function reserveCapacity(env, args) {
  const row = await rpc(env, 'zerox_reserve_v2', args);
  if (!row || typeof row.status !== 'string') throw new Error('Reservation returned no status');
  return row;
}

// Error code and details for a non-ok reservation status (unknown statuses fail closed). tokens
// is the refused reservation's p_tokens, for the window and month messages; modelName names the
// family in the month message (never a provider).
export function reserveError(row, now = Date.now(), tokens = null, modelName = undefined) {
  const status = row?.status;
  const code = RESERVE_ERRORS[status] || 'service_unavailable';
  const retry = Number(row?.retry_after_seconds);
  if (status === 'user_family_month_tokens') {
    const message = monthQuotaMessage(row, modelName, tokens, now);
    const limit = Number(row?.cap_tokens);
    const headers = {};
    if (row?.cap_family) headers['x-neuron-quota-family'] = String(row.cap_family);
    if (Number.isSafeInteger(limit)) headers['x-neuron-quota-month-limit-tokens'] = String(limit);
    if (Number.isSafeInteger(Number(row?.cap_used_tokens))) headers['x-neuron-quota-month-used-tokens'] = String(Number(row.cap_used_tokens));
    const resetsAt = row?.cap_resets_at ?? row?.resets_at ?? null;
    // Upgrading does not raise the allowance: no upgrade_url. Larger than the whole allowance: no time makes it fit.
    if (Number.isSafeInteger(limit) && Number(tokens) > limit) return { code, message, upgrade: false, headers, resetsAt: null, retryAfterSeconds: undefined };
    if (resetsAt) headers['x-neuron-quota-month-resets-at'] = new Date(resetsAt).toISOString().replace('.000Z', 'Z');
    const until = Math.ceil((Date.parse(resetsAt || '') - now) / 1000);
    return { code, message, upgrade: false, headers, resetsAt,
      retryAfterSeconds: retry > 0 ? retry : until > 0 ? until : undefined };
  }
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

// ── Shared-budget refusals: reasons, messages and records ──
// zerox_reserve_v2 answers pool_exhausted for any spent shared budget and user_pool_share for a
// spent fair share. The client error keeps code capacity_exhausted, HTTP 503 and Retry-After
// (Neuron alpha.5 retries on exactly those, rust/crates/api/src/retry.rs, and ignores fields it
// does not know) and adds a `reason` naming the limit that refused the request:
// - minute_budget: the pool's per-minute request or token budget (rpm, tpm), shared by every user;
//   it frees at the next minute.
// - daily_budget: its daily request or token budget (rpd, tpd), until 00:00 UTC.
// - spend_cap: a paid or sponsored pool's daily spend cap (cpd), until 00:00 UTC.
// - concurrency: a pool that runs one request at a time is serving another one.
// - user_pool_share: this caller's fair share of the free pool today (others are unaffected).
// - pool_budgets: several of these at once (an `auto` request refused everywhere).
// A request larger than a pool's whole per-minute budget never reaches a reservation: the router
// answers context_length_exceeded with reason request_over_minute_budget.
export function refusalReason(status, budget) {
  if (status === 'user_pool_share' || budget === 'share') return 'user_pool_share';
  const names = String(budget || '').split('|').filter(Boolean);
  if (names.length === 1 && names[0] === 'concurrency') return 'concurrency';
  if (names.includes('rpm') || names.includes('tpm')) return 'minute_budget';
  if (names.includes('cpd')) return 'spend_cap';
  if (names.includes('concurrency')) return 'concurrency';
  return 'daily_budget';
}

const wholeSeconds = value => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.max(1, Math.ceil(number)) : null;
};

// The bracket after "has used its free per-minute budget". zerox_reserve_v2 does not say which
// minute budget refused, so exhaustedBudget names every one the pool sets ('rpm|tpm' on Groq's free
// pools): both limits are named, and the request's own size only when the token budget is the
// plausible cause (the only minute limit, or the request is at least half of it). Otherwise a
// pool whose requests a minute ran out would tell a small request it needs 1,500 of 8,000 tokens.
export function minuteBudgetDetail(row) {
  const names = String(row?.budget || '').split('|');
  const limit = name => {
    const value = Number(row?.limits?.[name]);
    return names.includes(name) && Number.isSafeInteger(value) && value > 0 ? value : null;
  };
  const rpm = limit('rpm');
  const tpm = limit('tpm');
  if (!rpm && !tpm) return ' (shared by every user)';
  const limits = [rpm && `${tokenCount(rpm)} requests`, tpm && `${tokenCount(tpm)} tokens`].filter(Boolean).join(' or ');
  const needed = Number(row?.tokens);
  const sized = tpm && Number.isSafeInteger(needed) && needed > 0 && (!rpm || needed * 2 >= tpm);
  return ` (${limits} a minute, shared by every user${sized ? `; this request needs about ${tokenCount(Math.min(needed, tpm))} tokens` : ''})`;
}

// The client error once every candidate was refused by a shared budget (no upstream attempt
// failed). `exhausted` rows are reservation rows plus budget, model (display name), tokens (the
// refused p_tokens) and limits (p_pool); `alternatives` are model ids that can take this request
// now (chat-handler.js), offered when the request named its model.
export function exhaustionError(exhausted, alternatives = []) {
  const reasons = exhausted.map(row => refusalReason(row.status, row.budget));
  const reason = reasons.length && reasons.every(value => value === reasons[0]) ? reasons[0] : 'pool_budgets';
  const relevant = exhausted.filter((row, index) => reason === 'pool_budgets' || reasons[index] === reason);
  const retry = wholeSeconds(Math.min(...relevant.map(row => Number(row.retry_after_seconds) > 0 ? Number(row.retry_after_seconds) : Infinity)));
  const names = [...new Set(exhausted.map(row => row.model).filter(Boolean))];
  const one = names.length === 1 ? names[0] : null;
  const others = alternatives.length ? ` Models that can take it now: ${alternatives.join(', ')}.` : '';
  const switchTo = alternatives.length ? 'Switch to Auto or another model to continue now.' : 'Retry then, or choose another model.';
  let message;
  if (reason === 'user_pool_share') {
    message = 'You have used your share of the free capacity for these models today. It resets at 00:00 UTC; ' +
      'try another model, or upgrade for dedicated capacity.';
  } else if (reason === 'spend_cap') {
    message = `${one || 'This model'} has reached today's spending limit on Zero-X. It resets at 00:00 UTC; choose another model until then.`;
  } else if (reason === 'minute_budget') {
    const wait = retry ? `It frees up in ${retry} s.` : 'It frees up within a minute.';
    if (one) {
      message = `${one} has used its free per-minute budget${minuteBudgetDetail(relevant[0])}. ${wait} ${switchTo}`;
    } else {
      message = `Every free model that can take this request has used its per-minute budget. ${wait} ${switchTo}`;
    }
  } else if (reason === 'daily_budget') {
    message = `${one ? `${one} has` : 'Every free model that can take this request has'} used its free daily budget. ` +
      'It resets at 00:00 UTC; choose another model until then.';
  } else if (reason === 'concurrency') {
    message = `${one || 'This model'} runs one request at a time on the free tier and is serving another one. ` +
      (alternatives.length ? `Retry in a few seconds, or ${switchTo.charAt(0).toLowerCase()}${switchTo.slice(1)}`
        : 'Retry in a few seconds, or choose another model.');
  } else {
    message = 'Every free model that can take this request is at a shared limit right now. ' +
      `${retry ? `Retry in ${retry} s, ` : 'Retry later, '}or choose another model.`;
  }
  // A wait of seconds is where naming the way out matters; the daily messages already say to choose another model.
  const named = reason === 'minute_budget' || reason === 'concurrency' ? others : '';
  return { code: 'capacity_exhausted', retryAfterSeconds: retry ?? 60, message: message + named, reason,
    ...(alternatives.length ? { alternatives } : {}) };
}

// Records each refusal (migration 20261114000000_pool_refusals.sql, zerox_note_pool_refusal) so a
// refused request leaves a queryable row: time, pool, reason, needed tokens and the pool's buckets
// at that moment. Best effort and off the response path: without the migration (PGRST202 or
// 42883), or after any other failure, records stop for REFUSAL_RETRY_MS with one warning. At most
// REFUSALS_PER_MINUTE rows per process and minute, so a burst of refusals cannot load the database.
export const REFUSAL_RETRY_MS = 10 * 60_000;
export const REFUSALS_PER_MINUTE = 60;
const refusalState = new WeakMap(); // env -> { offUntil, minute, count }

export function refusalArgs({ args, status, budget, retryAfterSeconds, requestId }) {
  return {
    p_model: args.p_model,
    p_tier: args.p_tier,
    p_pool_key: args.p_pool_key ?? '',
    p_status: status,
    p_reason: refusalReason(status, budget),
    p_budget: budget === 'share' ? null : budget ?? null,
    p_needed_tokens: Number.isSafeInteger(args.p_tokens) ? args.p_tokens : null,
    p_retry_after_seconds: wholeSeconds(retryAfterSeconds),
    p_limits: args.p_pool ?? null,
    p_request_id: requestId ?? null,
  };
}

// A promise that never rejects (true when recorded), or null when nothing was sent.
export function recordPoolRefusal(env, refusal, now = Date.now()) {
  if (!env || typeof env !== 'object' || !refusal) return null;
  let state = refusalState.get(env);
  if (!state) refusalState.set(env, state = { offUntil: 0, minute: 0, count: 0 });
  if (state.offUntil > now) return null;
  const minute = Math.floor(now / 60_000);
  if (state.minute !== minute) Object.assign(state, { minute, count: 0 });
  if (state.count >= REFUSALS_PER_MINUTE) return null;
  state.count++;
  let call;
  try {
    call = rpc(env, 'zerox_note_pool_refusal', refusal);
  } catch (error) {
    call = Promise.reject(error);
  }
  return call.then(() => true, error => {
    state.offUntil = Date.now() + REFUSAL_RETRY_MS;
    console.warn(missingFunction(error)
      ? 'Pool refusals are not recorded until migration 20261114000000_pool_refusals.sql is applied'
      : 'Pool refusal not recorded', { name: error?.name, code: error?.code ?? null });
    return false;
  });
}

// Test hook.
export function resetPoolRefusals(env) {
  if (env && typeof env === 'object') refusalState.delete(env);
}

// zerox_settle_v2 arguments. Refunds bill nothing; otherwise real usage (Gemini: from
// total_tokens) or, when the upstream sent none, the byte-based estimate. The pool bucket
// (model, tier and vault key) is the one stored on the reservation. Prompt-cache reads and
// writes (5-minute and 1-hour writes together) are part of p_prompt_tokens; each is billed at its
// own rate (migration 20261029000800, the 11-argument zerox_settle_v2).
// p_counted_tokens (migration 20261109000000_cache_weighted_limits.sql) is what the user's token
// limits count (pricing.js countedTokens: cache reads at cacheReadWeight); the pool keeps the raw
// p_prompt_tokens + p_completion_tokens. It is sent only when it differs from the raw sum, so usage
// without cache reads settles with exactly the arguments it always had.
export function settlementArgs({ reservationId, entry, pool, usage, promptEstimate = 0, outputBytes = 0,
  status, latencyMs = 0, errorCode = null, cacheReadWeight: weight = TOKEN_LIMIT_CACHE_READ_WEIGHT }) {
  let billed = null;
  if (status !== 'refunded') {
    billed = billableUsage(usage, { prompt_tokens: promptEstimate, completion_tokens: estimateOutputTokens(outputBytes) });
  }
  const prompt = billed?.prompt_tokens ?? 0;
  const completion = billed?.completion_tokens ?? 0;
  const counted = billed ? countedTokens(billed, weight) : 0;
  return {
    p_reservation_id: reservationId,
    p_prompt_tokens: prompt,
    p_completion_tokens: completion,
    p_cost_microusd: billed && (pool.tier === 'paid' || pool.sponsored === true) && pool.price
      ? costMicrousd(pool.price, prompt, completion, billed) : 0,
    p_status: status,
    p_latency_ms: Math.max(0, Math.round(latencyMs)),
    p_provider: entry.provider,
    p_upstream_model: entry.upstream_model,
    p_error_code: errorCode,
    p_cache_read_tokens: billed?.cache_read_tokens ?? 0,
    p_cache_write_tokens: (billed?.cache_write_tokens ?? 0) + (billed?.cache_write_1h_tokens ?? 0),
    ...(counted !== prompt + completion ? { p_counted_tokens: counted } : {}),
  };
}

// A database without migration 20261109000000 has only the 11-argument zerox_settle_v2, which
// refuses p_counted_tokens (PGRST202 or 42883), and so does one whose migration was rolled back
// while this gateway runs. The call is then repeated without it: the attempt settles with raw
// tokens toward the user's limits, as before the migration, and its credits, usage event and pool
// cost are still recorded. The gateway then skips p_counted_tokens for COUNTED_RETRY_MS before it
// tries again, and logs once per window.
export const COUNTED_RETRY_MS = 10 * 60_000;
const countedUnavailable = new WeakMap(); // env -> time the retry window ends

export async function settleCapacity(env, args, now = Date.now()) {
  if (!args || !('p_counted_tokens' in args)) return rpc(env, 'zerox_settle_v2', args);
  const { p_counted_tokens: _counted, ...raw } = args;
  const keyed = env && typeof env === 'object';
  if (keyed && (countedUnavailable.get(env) ?? 0) > now) return rpc(env, 'zerox_settle_v2', raw);
  try {
    return await rpc(env, 'zerox_settle_v2', args);
  } catch (error) {
    if (!missingFunction(error)) throw error;
    if (keyed) {
      console.error('Counted tokens need migration 20261109000000_cache_weighted_limits.sql; settling with raw tokens until it is applied');
      countedUnavailable.set(env, now + COUNTED_RETRY_MS);
    }
    return rpc(env, 'zerox_settle_v2', raw);
  }
}

// Test hook.
export function resetCountedUnavailable(env) {
  if (env && typeof env === 'object') countedUnavailable.delete(env);
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

/**
 * Shared pool budgets that refused a reservation (zerox_reserve_v2 status pool_exhausted), per
 * isolate. Postgres stays the only judge of the budgets; this remembers its refusals so that
 * /v1/models shows a model whose pool budget is spent as busy (per-minute budget) or blurred
 * (daily budget) with available_again_at, instead of available while every request is refused.
 * A successful reservation on the pool clears the entry; otherwise it ends when the budget resets.
 */

const MAX_POOLS = 1000;
const spent = new Map(); // poolKey -> { budget, until, at }

/**
 * Names the budget behind a pool_exhausted refusal. zerox_reserve_v2 reports only the retry
 * delay: daily budgets (rpd, tpd and a paid pool's daily spend cap cpd) retry at UTC midnight and
 * per-minute ones (rpm, tpm) at the next minute. `limits` is the reservation's p_pool. A pool
 * that sets several budgets of that window gets all their names ('rpm|tpm'); in the last minute
 * of a UTC day both windows end together, so every budget the pool sets is named. A spent spend
 * cap alone is 'cpd', so /v1/models shows the model blurred until midnight.
 */
export function exhaustedBudget(limits, retryAfterSeconds, now = Date.now()) {
  const retry = Number(retryAfterSeconds) > 0 ? Number(retryAfterSeconds) : 60;
  const midnight = (Math.floor(now / 86400000) + 1) * 86400000;
  const daily = retry > 60;
  const both = !daily && Math.abs(now + retry * 1000 - midnight) < 2000;
  const window = daily ? ['rpd', 'tpd', 'cpd'] : both ? ['rpm', 'tpm', 'rpd', 'tpd', 'cpd'] : ['rpm', 'tpm'];
  const set = window.filter(name => limits?.[name] !== null && limits?.[name] !== undefined);
  // Nothing set in that window: name the request and token budgets, as before cpd existed.
  return (set.length ? set : window.filter(name => name !== 'cpd')).join('|');
}

export function notePoolExhausted(key, { budget, retryAfterSeconds, now = Date.now() }) {
  if (!key) return;
  const retry = Number(retryAfterSeconds) > 0 ? Number(retryAfterSeconds) : 60;
  if (!spent.has(key) && spent.size >= MAX_POOLS) spent.delete(spent.keys().next().value);
  spent.set(key, { budget, until: now + retry * 1000, at: now });
}

export function notePoolReserved(key) {
  spent.delete(key);
}

// { budget, until, at } while the pool's budget is known to be spent, otherwise null.
export function poolBudgetState(key, now = Date.now()) {
  const entry = spent.get(key);
  if (!entry) return null;
  if (entry.until <= now) {
    spent.delete(key);
    return null;
  }
  return entry;
}

// Test hook.
export function resetPoolBudgets() {
  spent.clear();
}

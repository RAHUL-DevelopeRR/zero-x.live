#!/usr/bin/env node
// Creates (or reuses) the Neuron monthly Razorpay plans (Athlete, Speed, Pro and Max) in INR and
// USD and prints the SQL that stores their ids in public.zerox_plan_policy. Dry-run unless --apply.
//
//   node --env-file=.dev.vars scripts/razorpay-bootstrap.mjs            # show what would happen
//   node --env-file=.dev.vars scripts/razorpay-bootstrap.mjs --apply    # create missing plans
//   node --env-file=.dev.vars scripts/razorpay-bootstrap.mjs --apply --store-pglite D:/zerox-paytest-db
//   node --env-file=.dev.vars scripts/razorpay-bootstrap.mjs --plan athlete,speed --currency INR
//   node --env-file=.env.razorpay-live scripts/razorpay-bootstrap.mjs --plan athlete,speed --currency INR --apply --allow-live
//
// --plan (comma-separated plan ids, default every paid plan) and --currency (INR, USD or both,
// default both) narrow the run. An account without international payments cannot create USD plans:
// pass --currency INR, and the printed SQL sets only razorpay_plan_id_inr, so the USD ids stay as
// they are (null) and checkout in USD answers billing_plan_missing.
//
// Uses RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET from the environment. Live keys (rzp_live_) are
// refused unless --allow-live is passed. The SQL is printed, never executed: apply it to the
// database yourself (see the manual migration step in .github/workflows/deploy.yml).
//
// --store-pglite <dir> is for a local test-mode rehearsal only: it writes the selected test-mode
// plan ids into the local PGlite database in <dir> (the one `npm run db:dev` prepared and the local
// server.js uses; stop that server first, PGlite allows one process per directory). It refuses
// live keys, even with --allow-live, and never touches any other database.
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createPlan, listPlans, razorpayConfigured } from '../src/billing/razorpay.js';
import { closeAllPglite, getPgliteHandle } from '../src/db/pglite.js';
import { PAID_PLAN_IDS, PLAN_CATALOG } from '../src/plan-policy.js';

export const CURRENCIES = Object.freeze(['INR', 'USD']);

// Validates a plan and currency selection (arrays or comma-separated text); null or empty means
// all of them. The result is in catalogue order.
export function selection({ plans = null, currencies = null } = {}) {
  const pick = (values, known, normalize, label) => {
    const list = (Array.isArray(values) ? values : String(values ?? '').split(','))
      .map(value => normalize(String(value).trim())).filter(Boolean);
    if (!list.length) return [...known];
    const unknown = list.filter(value => !known.includes(value));
    if (unknown.length) throw new Error(`Unknown ${label}: ${unknown.join(', ')} (expected ${known.join(', ')}).`);
    return known.filter(value => list.includes(value));
  };
  return {
    plans: pick(plans, PAID_PLAN_IDS, value => value.toLowerCase(), 'plan'),
    currencies: pick(currencies, CURRENCIES, value => value.toUpperCase(), 'currency'),
  };
}

export function desiredPlans(options = {}) {
  const { plans, currencies } = selection(options);
  return plans.flatMap(id => {
    const plan = PLAN_CATALOG.find(entry => entry.id === id);
    return [['INR', plan.price.inr_paise], ['USD', plan.price.usd_cents]].filter(([currency]) => currencies.includes(currency))
      .map(([currency, amount]) => ({
      plan: id, currency, amount,
      body: {
        period: 'monthly', interval: 1,
        item: { name: `Neuron ${plan.name} (monthly)`, amount, currency, description: `Zero-X Neuron ${plan.name} plan, billed monthly` },
        notes: { zerox_plan: id, zerox_currency: currency },
      },
    }));
  });
}

const matches = (existing, wanted) => existing?.period === 'monthly' && Number(existing.interval) === 1 &&
  existing.notes?.zerox_plan === wanted.plan && existing.item?.currency === wanted.currency &&
  Number(existing.item?.amount) === wanted.amount;

async function existingPlans(env) {
  const plans = [];
  for (let skip = 0; skip < 10000; skip += 100) {
    const page = await listPlans(env, { count: 100, skip });
    const items = Array.isArray(page.items) ? page.items : [];
    plans.push(...items);
    if (items.length < 100) break;
  }
  return plans;
}

export async function bootstrapPlans({ env, apply = false, allowLive = false, plans = null, currencies = null }) {
  const wantedPlans = desiredPlans({ plans, currencies });
  const configured = razorpayConfigured(env);
  if (apply && !configured) {
    throw new Error(`Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET (${allowLive ? 'the keys of the mode you are creating plans in' : 'test mode keys'}) to apply.`);
  }
  if (configured && env.RAZORPAY_KEY_ID.startsWith('rzp_live_') && !allowLive) {
    throw new Error('Refusing to use live Razorpay keys without --allow-live.');
  }
  const existing = configured ? await existingPlans(env) : [];
  const results = [];
  for (const wanted of wantedPlans) {
    const found = existing.find(plan => matches(plan, wanted));
    if (found) results.push({ ...wanted, id: found.id, action: 'existing' });
    else if (!apply) results.push({ ...wanted, id: null, action: 'would_create' });
    else results.push({ ...wanted, id: (await createPlan(env, wanted.body)).id, action: 'created' });
  }
  return results;
}

const sqlText = id => /^plan_[A-Za-z0-9]{6,40}$/.test(id || '') ? `'${id}'` : null;

// One UPDATE per plan in the results, setting only the currencies the results cover: a plan
// bootstrapped in INR alone keeps its stored USD id (null).
export function planSql(results) {
  const plans = PAID_PLAN_IDS.filter(plan => results.some(row => row.plan === plan));
  return plans.map(plan => {
    const sets = CURRENCIES.filter(currency => results.some(row => row.plan === plan && row.currency === currency)).map(currency => {
      const id = sqlText(results.find(row => row.plan === plan && row.currency === currency)?.id) || `'<razorpay plan id ${currency}>'`;
      return `razorpay_plan_id_${currency.toLowerCase()} = ${id}`;
    });
    return `UPDATE public.zerox_plan_policy SET ${sets.join(', ')} WHERE plan = '${plan}';`;
  }).join('\n');
}

/**
 * Writes test-mode plan ids into a local PGlite database (a test-mode rehearsal of checkout on
 * the local server.js). Refuses live keys, a result without an id for every selected plan and
 * currency, and an id that is not a Razorpay plan id. Currencies outside the results keep their
 * stored ids. Returns the stored rows of the plans in the results.
 */
export async function storePlanIdsInPglite({ env, results, dataDir }) {
  if (!dataDir) throw new Error('--store-pglite needs the local PGlite directory.');
  if (!razorpayConfigured(env) || !env.RAZORPAY_KEY_ID.startsWith('rzp_test_')) {
    throw new Error('--store-pglite is for test-mode keys (rzp_test_) only.');
  }
  const plans = PAID_PLAN_IDS.filter(plan => results.some(row => row.plan === plan));
  if (!plans.length) throw new Error('No Razorpay plans to store: run with --apply first.');
  const rows = results.filter(row => plans.includes(row.plan));
  for (const row of rows) {
    if (!sqlText(row.id)) throw new Error(`No Razorpay plan id for ${row.plan} ${row.currency}: run with --apply first.`);
  }
  try {
    const { db } = await getPgliteHandle({ DATABASE_DRIVER: 'pglite', PGLITE_DATA_DIR: dataDir });
    for (const row of rows) {
      const column = row.currency === 'INR' ? 'razorpay_plan_id_inr' : 'razorpay_plan_id_usd';
      await db.query(`UPDATE public.zerox_plan_policy SET ${column} = $2, updated_at = now() WHERE plan = $1`, [row.plan, row.id]);
    }
    return (await db.query(`SELECT plan, razorpay_plan_id_inr, razorpay_plan_id_usd FROM public.zerox_plan_policy
      WHERE plan = ANY($1) ORDER BY plan`, [plans])).rows;
  } finally {
    await closeAllPglite();
  }
}

async function main(argv) {
  const { values } = parseArgs({ args: argv, options: {
    apply: { type: 'boolean' }, 'allow-live': { type: 'boolean' }, 'store-pglite': { type: 'string' },
    plan: { type: 'string' }, currency: { type: 'string' },
  } });
  const apply = values.apply === true;
  const results = await bootstrapPlans({ env: process.env, apply, allowLive: values['allow-live'] === true,
    plans: values.plan ?? null, currencies: values.currency ?? null });
  console.log(apply ? 'Razorpay plans:' : 'Dry run (pass --apply to create missing plans):');
  for (const row of results) {
    console.log(`  ${row.plan.padEnd(7)} ${row.currency} ${String(row.amount).padStart(7)}  ${row.action.padEnd(12)} ${row.id || ''}`);
  }
  if (!razorpayConfigured(process.env)) console.log('  (RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET not set: existing plans were not checked)');
  if (values['store-pglite'] !== undefined) {
    const rows = await storePlanIdsInPglite({ env: process.env, results, dataDir: values['store-pglite'] });
    console.log(`\nStored in the local PGlite database ${values['store-pglite']}:`);
    for (const row of rows) console.log(`  ${row.plan.padEnd(7)} INR ${row.razorpay_plan_id_inr}  USD ${row.razorpay_plan_id_usd}`);
    return;
  }
  console.log('\n-- Store the plan ids (run against the database manually):');
  console.log(planSql(results));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}

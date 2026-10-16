#!/usr/bin/env node
// Creates (or reuses) the Neuron Pro and Max monthly Razorpay plans in INR and USD and prints
// the SQL that stores their ids in public.zerox_plan_policy. Dry-run unless --apply.
//
//   node --env-file=.dev.vars scripts/razorpay-bootstrap.mjs            # show what would happen
//   node --env-file=.dev.vars scripts/razorpay-bootstrap.mjs --apply    # create missing plans
//
// Uses RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET from the environment. Live keys (rzp_live_) are
// refused unless --allow-live is passed. The SQL is printed, never executed: apply it to the
// database yourself (see the manual migration step in .github/workflows/deploy.yml).
import { pathToFileURL } from 'node:url';
import { createPlan, listPlans, razorpayConfigured } from '../src/billing/razorpay.js';
import { PAID_PLAN_IDS, PLAN_CATALOG } from '../src/plan-policy.js';

export function desiredPlans() {
  return PAID_PLAN_IDS.flatMap(id => {
    const plan = PLAN_CATALOG.find(entry => entry.id === id);
    return [['INR', plan.price.inr_paise], ['USD', plan.price.usd_cents]].map(([currency, amount]) => ({
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

export async function bootstrapPlans({ env, apply = false, allowLive = false }) {
  const configured = razorpayConfigured(env);
  if (apply && !configured) throw new Error('Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET (test mode keys) to apply.');
  if (configured && env.RAZORPAY_KEY_ID.startsWith('rzp_live_') && !allowLive) {
    throw new Error('Refusing to use live Razorpay keys without --allow-live.');
  }
  const existing = configured ? await existingPlans(env) : [];
  const results = [];
  for (const wanted of desiredPlans()) {
    const found = existing.find(plan => matches(plan, wanted));
    if (found) results.push({ ...wanted, id: found.id, action: 'existing' });
    else if (!apply) results.push({ ...wanted, id: null, action: 'would_create' });
    else results.push({ ...wanted, id: (await createPlan(env, wanted.body)).id, action: 'created' });
  }
  return results;
}

const sqlText = id => /^plan_[A-Za-z0-9]{6,40}$/.test(id || '') ? `'${id}'` : null;

export function planSql(results) {
  return PAID_PLAN_IDS.map(plan => {
    const inr = sqlText(results.find(row => row.plan === plan && row.currency === 'INR')?.id) || "'<razorpay plan id INR>'";
    const usd = sqlText(results.find(row => row.plan === plan && row.currency === 'USD')?.id) || "'<razorpay plan id USD>'";
    return `UPDATE public.zerox_plan_policy SET razorpay_plan_id_inr = ${inr}, razorpay_plan_id_usd = ${usd} WHERE plan = '${plan}';`;
  }).join('\n');
}

async function main(argv) {
  const apply = argv.includes('--apply');
  const results = await bootstrapPlans({ env: process.env, apply, allowLive: argv.includes('--allow-live') });
  console.log(apply ? 'Razorpay plans:' : 'Dry run (pass --apply to create missing plans):');
  for (const row of results) {
    console.log(`  ${row.plan.padEnd(4)} ${row.currency} ${String(row.amount).padStart(7)}  ${row.action.padEnd(12)} ${row.id || ''}`);
  }
  if (!razorpayConfigured(process.env)) console.log('  (RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET not set: existing plans were not checked)');
  console.log('\n-- Store the plan ids (run against the database manually):');
  console.log(planSql(results));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}

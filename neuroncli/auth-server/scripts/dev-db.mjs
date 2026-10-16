#!/usr/bin/env node
// Creates or updates a local PGlite account database (all migrations plus the dev bootstrap)
// and optionally seeds a development user. Stop any server using the same directory first:
// PGlite does not support two processes on one data directory.
//
//   node scripts/dev-db.mjs --data-dir D:/neuron-build/zerox-db
//   node scripts/dev-db.mjs --data-dir D:/neuron-build/zerox-db --email dev@example.test --plan pro --credits-usd 5
//
// Then run the gateway with DATABASE_DRIVER=pglite PGLITE_DATA_DIR=<same directory>.
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { rpc } from '../src/account-store.js';
import { closeAllPglite, getPgliteHandle } from '../src/db/pglite.js';

const PLANS = new Set(['free', 'pro', 'max', 'ultrawork']);
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}$/;

function usage(message) {
  if (message) console.error(`error: ${message}`);
  console.error('usage: node scripts/dev-db.mjs --data-dir <dir> [--email <email> [--name <name>] [--plan free|pro|max|ultrawork] [--credits-usd <amount>]]');
  process.exit(2);
}

export async function seedDevUser(env, db, { email, name = '', plan, creditsUsd }) {
  const user = (await db.query(`INSERT INTO auth.users (email) VALUES ($1)
    ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id`, [email])).rows[0];
  await rpc(env, 'zerox_sync_account', { p_user_id: user.id, p_profile: { email, name } });
  if (plan) {
    // An operator grant: plan_source 'manual' (manual_plan only holds a grant a subscription overrides).
    await db.query(`UPDATE public.zerox_accounts SET plan = $2,
      plan_source = CASE WHEN $2 = 'free' THEN 'default' ELSE 'manual' END, manual_plan = NULL, updated_at = now()
      WHERE clerk_id = $1`, [user.id, plan]);
  }
  if (creditsUsd) {
    await rpc(env, 'zerox_credit_grant', {
      p_user_id: user.id, p_delta_microusd: Math.round(creditsUsd * 1e6), p_reason: 'dev_seed',
      p_ref: `dev-seed:${randomUUID()}`,
    });
  }
  return rpc(env, 'zerox_get_account', { p_user_id: user.id });
}

async function main() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        'data-dir': { type: 'string' }, email: { type: 'string' }, name: { type: 'string' },
        plan: { type: 'string' }, 'credits-usd': { type: 'string' }, help: { type: 'boolean' },
      },
    }));
  } catch (error) { usage(error.message); }
  if (values.help) usage();
  const dataDir = values['data-dir'] || process.env.PGLITE_DATA_DIR;
  if (!dataDir) usage('pass --data-dir or set PGLITE_DATA_DIR');
  if (values.plan && !PLANS.has(values.plan)) usage(`unknown plan ${values.plan}`);
  const creditsUsd = values['credits-usd'] === undefined ? 0 : Number(values['credits-usd']);
  if (!Number.isFinite(creditsUsd) || creditsUsd < 0 || creditsUsd > 10000) usage('--credits-usd must be between 0 and 10000');
  if ((values.plan || creditsUsd || values.name) && !values.email) usage('--plan, --name and --credits-usd need --email');
  if (values.email && !EMAIL.test(values.email)) usage('invalid --email');

  const env = { DATABASE_DRIVER: 'pglite', PGLITE_DATA_DIR: dataDir };
  try {
    const handle = await getPgliteHandle(env);
    console.log(`database: ${handle.location}`);
    console.log(handle.applied.length ? `applied migrations: ${handle.applied.join(', ')}` : 'migrations: up to date');
    if (values.email) {
      const account = await seedDevUser(env, handle.db, {
        email: values.email, name: values.name, plan: values.plan, creditsUsd,
      });
      console.log(`user: ${account.clerk_id} ${account.email} plan=${account.plan} credits_usd=${account.credit_balance_microusd / 1e6}`);
    }
    console.log(`run the gateway with: DATABASE_DRIVER=pglite PGLITE_DATA_DIR=${handle.location}`);
  } finally {
    await closeAllPglite();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

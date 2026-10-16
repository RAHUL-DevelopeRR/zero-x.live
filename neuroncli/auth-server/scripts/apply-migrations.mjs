#!/usr/bin/env node
// Operator tool: lists or applies migrations/*.sql in version order against DATABASE_URL with
// psql. Dry run by default (prints the plan, never connects).
//
//   node scripts/apply-migrations.mjs                      # dry run: ordered list + checksums
//   DATABASE_URL=postgresql://... node scripts/apply-migrations.mjs --status   # read-only: show applied
//   DATABASE_URL=postgresql://... node scripts/apply-migrations.mjs --apply    # apply pending ones
//
// Applied versions are recorded in supabase_migrations.schema_migrations, the table the
// Supabase CLI uses, so `supabase db push` and this tool agree on what is applied. The
// connection string is passed to psql through PG* environment variables, never argv.
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { listMigrations, readMigration } from '../src/db/migrations.js';

const HISTORY_DDL = `CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text PRIMARY KEY, statements text[], name text);`;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function connectionEnv(databaseUrl) {
  let url;
  try { url = new URL(databaseUrl); } catch { throw new Error('DATABASE_URL is not a valid URL'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('DATABASE_URL must start with postgresql://');
  if (!url.hostname) throw new Error('DATABASE_URL has no host');
  const sslmode = url.searchParams.get('sslmode') || (LOCAL_HOSTS.has(url.hostname) ? 'prefer' : 'require');
  return {
    PGHOST: url.hostname.replace(/^\[|\]$/g, ''),
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username || 'postgres'),
    PGPASSWORD: decodeURIComponent(url.password || ''),
    PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, '') || 'postgres'),
    PGSSLMODE: sslmode,
    PGCONNECT_TIMEOUT: '15',
    PGAPPNAME: 'zerox-apply-migrations',
  };
}

export function maskUrl(databaseUrl) {
  try {
    const url = new URL(databaseUrl);
    if (url.password) url.password = '***';
    url.search = '';
    return url.toString();
  } catch { return '<invalid DATABASE_URL>'; }
}

function psql(env, args, input) {
  const result = spawnSync('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-q', ...args], {
    env: { ...process.env, ...env }, encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw new Error(`psql could not be started: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`psql failed (exit ${result.status}): ${(result.stderr || '').trim()}`);
  return result.stdout;
}

function psqlAvailable() {
  const result = spawnSync('psql', ['--version'], { encoding: 'utf8' });
  return !result.error && result.status === 0 ? result.stdout.trim() : null;
}

function appliedVersions(env) {
  const exists = psql(env, ['-At', '-c', "SELECT to_regclass('supabase_migrations.schema_migrations') IS NOT NULL"]).trim();
  if (exists !== 't') return new Set();
  return new Set(psql(env, ['-At', '-c', 'SELECT version FROM supabase_migrations.schema_migrations'])
    .split(/\r?\n/).map(line => line.trim()).filter(Boolean));
}

export async function plan() {
  return Promise.all((await listMigrations()).map(readMigration));
}

async function main() {
  let values;
  try {
    ({ values } = parseArgs({ options: {
      apply: { type: 'boolean' }, status: { type: 'boolean' }, 'database-url': { type: 'string' }, help: { type: 'boolean' },
    } }));
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exit(2);
  }
  if (values.help) {
    console.log('usage: node scripts/apply-migrations.mjs [--status | --apply] [--database-url <url>]');
    return;
  }
  const migrations = await plan();
  if (!values.apply && !values.status) {
    console.log(`dry run: ${migrations.length} migrations in apply order (nothing is executed)`);
    for (const migration of migrations) console.log(`  ${migration.version}  ${migration.file}  sha256:${migration.sha256.slice(0, 16)}`);
    console.log('each pending file is piped to: psql -X -v ON_ERROR_STOP=1 -q -f -, then its version is recorded in supabase_migrations.schema_migrations');
    console.log('re-run with --status (read-only) or --apply and DATABASE_URL to execute');
    return;
  }

  const databaseUrl = values['database-url'] || process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('error: DATABASE_URL (or --database-url) is required for --status and --apply');
    process.exit(2);
  }
  const version = psqlAvailable();
  if (!version) {
    console.error('error: psql was not found on PATH');
    process.exit(2);
  }
  const env = connectionEnv(databaseUrl);
  console.log(`target: ${maskUrl(databaseUrl)} (${version})`);
  const applied = appliedVersions(env);
  const pending = migrations.filter(migration => !applied.has(migration.version));
  for (const migration of migrations) {
    console.log(`  ${applied.has(migration.version) ? 'applied' : 'pending'}  ${migration.file}`);
  }
  if (values.status) return;
  if (!pending.length) {
    console.log('nothing to apply');
    return;
  }
  for (const migration of pending) {
    console.log(`applying ${migration.file}`);
    psql(env, ['-f', '-'], migration.sql);
    psql(env, ['-c', `${HISTORY_DDL}
      INSERT INTO supabase_migrations.schema_migrations (version, name)
      VALUES ('${migration.version}', '${migration.name}') ON CONFLICT (version) DO NOTHING;`]);
  }
  console.log(`applied ${pending.length} migration(s)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`error: ${error.message}`);
    process.exit(1);
  });
}

#!/usr/bin/env node
// Operator tool: lists or applies migrations/*.sql in version order against DATABASE_URL with
// psql. Dry run by default (prints the plan, never connects).
//
//   node scripts/apply-migrations.mjs                      # dry run: ordered list + checksums
//   DATABASE_URL=postgresql://... node scripts/apply-migrations.mjs --status   # read-only: show applied
//   DATABASE_URL=postgresql://... node scripts/apply-migrations.mjs --apply    # apply pending ones
//
// Applied versions are recorded in supabase_migrations.schema_migrations, the table the
// Supabase CLI uses, so `supabase db push` and this tool agree on what is applied. Each file and
// its history row go to psql as one script, with the row inserted inside the file's own
// transaction (just before its final COMMIT), so a migration is never applied without being
// recorded. The connection string is read only from the DATABASE_URL environment variable and
// reaches psql through PG* environment variables; it never appears in any process's argv.
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { listMigrations, readMigration } from '../src/db/migrations.js';

const HISTORY_DDL = `CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text PRIMARY KEY, statements text[], name text);`;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const VERSION = /^\d{8,14}$/;
const NAME = /^[a-z0-9_]+$/;
const FINAL_COMMIT = /\bCOMMIT\s*;\s*$/i;

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

// The psql script for one migration: make sure the history table exists, then run the file with
// its history row inserted just before the file's final COMMIT. A file without a final COMMIT
// gets the row appended; psql's ON_ERROR_STOP still keeps a failed file from being recorded.
export function migrationScript(migration) {
  if (!VERSION.test(migration.version) || !NAME.test(migration.name)) {
    throw new Error(`Unexpected migration identity: ${migration.file}`);
  }
  const record = `INSERT INTO supabase_migrations.schema_migrations (version, name)
  VALUES ('${migration.version}', '${migration.name}') ON CONFLICT (version) DO NOTHING;
`;
  const body = migration.sql.replace(/\s+$/, '');
  const commit = FINAL_COMMIT.exec(body);
  const script = commit
    ? `${body.slice(0, commit.index)}${record}${body.slice(commit.index)}\n`
    : `${body}\n${record}`;
  return `${HISTORY_DDL}\n${script}`;
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
    console.log('usage: DATABASE_URL=postgresql://... node scripts/apply-migrations.mjs [--status | --apply]');
    return;
  }
  if (values['database-url'] !== undefined) {
    // Recognised only to refuse it: argv (and the password in it) is visible in the process list.
    console.error('error: --database-url is not supported because it exposes the password in the process list; set DATABASE_URL instead');
    process.exit(2);
  }
  const migrations = await plan();
  if (!values.apply && !values.status) {
    console.log(`dry run: ${migrations.length} migrations in apply order (nothing is executed)`);
    for (const migration of migrations) console.log(`  ${migration.version}  ${migration.file}  sha256:${migration.sha256.slice(0, 16)}`);
    console.log('each pending file is piped to psql -X -v ON_ERROR_STOP=1 -q -f - with its supabase_migrations.schema_migrations row inserted before the final COMMIT');
    console.log('re-run with --status (read-only) or --apply and DATABASE_URL to execute');
    return;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('error: DATABASE_URL is required for --status and --apply');
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
    psql(env, ['-f', '-'], migrationScript(migration));
  }
  console.log(`applied ${pending.length} migration(s)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`error: ${error.message}`);
    process.exit(1);
  });
}

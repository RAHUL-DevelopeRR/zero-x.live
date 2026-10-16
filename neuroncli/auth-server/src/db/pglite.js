// Local Postgres driver for DATABASE_DRIVER=pglite (Node only; loaded lazily by
// src/account-store.js so the Worker bundle never includes it). It emulates the PostgREST RPC
// contract: named JSON arguments are converted with jsonb_to_record (the same conversion
// PostgREST performs), calls run as service_role, and every row is returned as to_jsonb() so
// values have the same JSON shape as in production.
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { DEV_BOOTSTRAP_SQL } from './bootstrap.js';
import { AccountDatabaseError } from './errors.js';
import { listMigrations } from './migrations.js';

const MEMORY = 'memory://';
const FUNCTION_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const INPUT_MODES = new Set(['i', 'b', 'v']);
const instances = new Map();

export function pgliteLocation(env = {}) {
  const dir = String(env.PGLITE_DATA_DIR || '').trim();
  return dir ? resolve(dir) : MEMORY;
}

function quoteIdent(name) {
  return `"${String(name).replaceAll('"', '""')}"`;
}

// Keeps the Postgres message, SQLSTATE, detail and hint but drops the driver error itself, which
// carries the query parameters (hashes, profiles) and must not end up in logs.
function databaseError(error, context = '') {
  if (error instanceof AccountDatabaseError) return error;
  return new AccountDatabaseError(`${context}${error.message}`, {
    code: error.code ?? null, detail: error.detail ?? null, hint: error.hint ?? null,
  });
}

// Applies the dev bootstrap and every migration not yet recorded in
// supabase_migrations.schema_migrations, in version order. Returns the applied versions.
export async function migrate(db, { directory } = {}) {
  await db.exec(DEV_BOOTSTRAP_SQL);
  const applied = new Set((await db.query('SELECT version FROM supabase_migrations.schema_migrations')).rows
    .map(row => row.version));
  const done = [];
  for (const migration of await listMigrations(directory)) {
    if (applied.has(migration.version)) continue;
    try {
      await db.exec(await readFile(migration.path, 'utf8'));
    } catch (error) {
      await db.exec('ROLLBACK').catch(() => {});
      const at = error.position ? ` (at character ${error.position})` : '';
      throw databaseError(error, `Migration ${migration.file} failed${at}: `);
    }
    await db.query('INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ($1, $2)',
      [migration.version, migration.name]);
    done.push(migration.version);
  }
  return done;
}

async function open(location) {
  if (location !== MEMORY) await mkdir(location, { recursive: true });
  const db = location === MEMORY ? await PGlite.create() : await PGlite.create(location);
  try {
    const applied = await migrate(db);
    return { db, location, applied, functions: new Map() };
  } catch (error) {
    await db.close().catch(() => {});
    throw error;
  }
}

// Returns the shared handle for env (one per data directory, one in-memory per process).
export function getPgliteHandle(env = {}) {
  const location = pgliteLocation(env);
  if (!instances.has(location)) {
    const pending = open(location);
    instances.set(location, pending);
    pending.catch(() => { if (instances.get(location) === pending) instances.delete(location); });
  }
  return instances.get(location);
}

export async function getPglite(env = {}) {
  return (await getPgliteHandle(env)).db;
}

export async function closePglite(env = {}) {
  const location = pgliteLocation(env);
  const pending = instances.get(location);
  if (!pending) return;
  instances.delete(location);
  const handle = await pending.catch(() => null);
  if (handle) await handle.db.close();
}

export async function closeAllPglite() {
  const pending = [...instances.values()];
  instances.clear();
  for (const handle of await Promise.all(pending.map(entry => entry.catch(() => null)))) {
    if (handle) await handle.db.close();
  }
}

async function describeFunction(handle, name) {
  if (handle.functions.has(name)) return handle.functions.get(name);
  const { rows } = await handle.db.query(`
    SELECT p.pronargs, p.pronargdefaults, p.proargnames, p.proargmodes::text[] AS proargmodes,
      ARRAY(SELECT pg_catalog.format_type(t.oid, NULL)
        FROM unnest(p.proargtypes::oid[]) WITH ORDINALITY AS t(oid, n) ORDER BY t.n) AS input_types,
      p.prorettype = 'pg_catalog.void'::pg_catalog.regtype AS returns_void, p.proretset,
      coalesce(p.proargmodes::text[] && ARRAY['o', 'b', 't'], false) OR rt.typtype = 'c'
        OR rt.oid = 'pg_catalog.record'::pg_catalog.regtype AS returns_rows
    FROM pg_catalog.pg_proc AS p
    JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
    JOIN pg_catalog.pg_type AS rt ON rt.oid = p.prorettype
    WHERE n.nspname = 'public' AND p.proname = $1 AND p.prokind = 'f'`, [name]);
  const overloads = rows.map(row => {
    const names = row.proargmodes
      ? (row.proargnames || []).filter((_, index) => INPUT_MODES.has(row.proargmodes[index]))
      : (row.proargnames || []).slice(0, row.pronargs);
    const args = row.input_types.map((type, index) => ({ name: names[index] || '', type }));
    return {
      args, required: args.slice(0, row.pronargs - row.pronargdefaults),
      returnsVoid: row.returns_void, returnsRows: row.returns_rows, returnsSet: row.proretset,
    };
  });
  handle.functions.set(name, overloads);
  return overloads;
}

function selectOverload(overloads, name, keys) {
  const matches = overloads.filter(overload => {
    const names = new Set(overload.args.map(arg => arg.name));
    return keys.every(key => names.has(key)) && overload.required.every(arg => keys.includes(arg.name));
  });
  if (matches.length === 1) return matches[0];
  const signature = `public.${name}(${keys.join(', ')})`;
  if (!matches.length) {
    throw new AccountDatabaseError(`Could not find the function ${signature} in the schema cache`,
      { code: 'PGRST202', status: 404 });
  }
  throw new AccountDatabaseError(`Could not choose the best candidate function between overloads of ${signature}`,
    { code: 'PGRST203', status: 300 });
}

// Like PostgREST, functions with OUT/TABLE columns or a composite result yield one JSON object
// per row (even with a single column); scalar functions yield bare JSON values.
function buildCall(name, overload, args) {
  const provided = overload.args.filter(arg => args[arg.name] !== undefined);
  const call = `public.${quoteIdent(name)}(${provided
    .map(arg => `${quoteIdent(arg.name)} => a.${quoteIdent(arg.name)}`).join(', ')})`;
  const source = overload.returnsRows ? `(SELECT * FROM ${call})` : call;
  if (!provided.length) return { sql: `SELECT to_jsonb(r) AS row FROM ${source} AS r`, params: [] };
  const columns = provided.map(arg => `${quoteIdent(arg.name)} ${arg.type}`).join(', ');
  const payload = Object.fromEntries(provided.map(arg => [arg.name, args[arg.name]]));
  return {
    sql: `SELECT to_jsonb(r) AS row FROM jsonb_to_record($1::jsonb) AS a(${columns}) CROSS JOIN LATERAL ${source} AS r`,
    params: [JSON.stringify(payload)],
  };
}

// Calls public.<name>(arg => value, ...) as service_role and returns every row (PostgREST shape).
export async function pgliteRpcRows(env, name, args = {}) {
  if (typeof name !== 'string' || !FUNCTION_NAME.test(name)) {
    throw new AccountDatabaseError(`Could not find the function public.${name} in the schema cache`,
      { code: 'PGRST202', status: 404 });
  }
  if (args === null || args === undefined) args = {};
  if (typeof args !== 'object' || Array.isArray(args)) {
    throw new AccountDatabaseError('RPC arguments must be a JSON object', { code: 'PGRST102', status: 400 });
  }
  const handle = await getPgliteHandle(env);
  const keys = Object.keys(args).filter(key => args[key] !== undefined);
  const overload = selectOverload(await describeFunction(handle, name), name, keys);
  const { sql, params } = buildCall(name, overload, args);
  let result;
  try {
    result = await handle.db.transaction(async tx => {
      await tx.exec("SET LOCAL ROLE service_role; SET LOCAL TimeZone = 'UTC'");
      return tx.query(sql, params);
    });
  } catch (error) {
    throw databaseError(error);
  }
  if (overload.returnsVoid) return [];
  const rows = result.rows.map(row => row.row);
  // A non-set scalar function returning NULL answers JSON null in PostgREST, i.e. no rows.
  if (!overload.returnsRows && !overload.returnsSet && rows.length === 1 && rows[0] === null) return [];
  return rows;
}

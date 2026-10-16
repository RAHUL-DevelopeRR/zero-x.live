import { AccountDatabaseError } from './db/errors.js';

export { AccountDatabaseError };

const FUNCTION_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

// DATABASE_DRIVER selects the account database: 'postgrest' (default, Supabase in production)
// or 'pglite' (local Node development and tests only; see src/db/pglite.js).
export function databaseDriver(env) {
  return String(env?.DATABASE_DRIVER || 'postgrest').trim().toLowerCase();
}

export function databaseConfigured(env) {
  if (!env) return false;
  const driver = databaseDriver(env);
  if (driver === 'pglite') return true;
  if (driver !== 'postgrest') return false;
  return !!env.SUPABASE_URL && String(env.SUPABASE_SECRET_KEY || '').startsWith('sb_secret_');
}

// The specifier is computed at runtime so bundlers (wrangler/esbuild) never follow it into
// PGlite and its WASM assets; the module is only ever loaded on Node.
const PGLITE_DRIVER = ['.', 'db', 'pglite.js'].join('/');
let pgliteDriver;
function loadPgliteDriver() {
  pgliteDriver ||= import(PGLITE_DRIVER).catch(error => {
    pgliteDriver = undefined;
    throw new AccountDatabaseError(
      `DATABASE_DRIVER=pglite needs Node with @electric-sql/pglite installed (${error.message})`);
  });
  return pgliteDriver;
}

async function postgrestRows(env, name, args) {
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: env.SUPABASE_SECRET_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(args ?? {}),
    signal: AbortSignal.timeout(10000),
  });
  const text = await response.text();
  if (!response.ok) {
    let body = {};
    try { body = JSON.parse(text) || {}; } catch { /* non-JSON error body */ }
    const message = typeof body.message === 'string' ? `: ${body.message}` : '';
    throw new AccountDatabaseError(`Account database request failed (${response.status})${message}`, {
      status: response.status, code: body.code ?? null, detail: body.details ?? null, hint: body.hint ?? null,
    });
  }
  // Functions returning void answer 204 (or a JSON null) and yield no rows.
  if (!text.trim()) return [];
  const rows = JSON.parse(text);
  if (rows === null) return [];
  return Array.isArray(rows) ? rows : [rows];
}

// Calls a Postgres function and returns every row (PostgREST in production, PGlite when
// DATABASE_DRIVER=pglite). Errors are AccountDatabaseError whose message includes the Postgres
// message (e.g. /too_many_keys/) and whose `code` is the SQLSTATE or PostgREST code.
// See docs/PLATFORM_CONTRACT.md section 4 for the RPC catalogue.
export async function rpcRows(env, name, args) {
  if (!databaseConfigured(env)) throw new AccountDatabaseError('Account database is not configured');
  if (typeof name !== 'string' || !FUNCTION_NAME.test(name)) {
    throw new AccountDatabaseError(`Invalid database function name: ${String(name).slice(0, 80)}`);
  }
  if (databaseDriver(env) === 'pglite') {
    const { pgliteRpcRows } = await loadPgliteDriver();
    return pgliteRpcRows(env, name, args);
  }
  return postgrestRows(env, name, args);
}

// Calls a Postgres function and returns its first row (or null).
export async function rpc(env, name, args) {
  const rows = await rpcRows(env, name, args);
  return rows[0] ?? null;
}

export const accountRpc = rpc;

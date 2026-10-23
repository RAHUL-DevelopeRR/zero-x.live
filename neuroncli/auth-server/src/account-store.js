import { AccountDatabaseError, missingFunction } from './db/errors.js';

export { AccountDatabaseError, missingFunction };

const FUNCTION_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

// DATABASE_DRIVER selects the account database: 'postgrest' (default, Supabase in production)
// or 'pglite' (local Node development and tests only; see src/db/pglite.js).
export function databaseDriver(env) {
  return String(env?.DATABASE_DRIVER || 'postgrest').trim().toLowerCase();
}

const LOOPBACK_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|::1|\[::1\])$/i;

// PGlite keeps accounts, quotas and keys in a local directory (or in memory), so it is refused
// wherever it could silently serve real users: NODE_ENV=production, Cloudflare Workers, and a
// Node server bound beyond loopback (AUTH_HOST) unless ALLOW_LOCAL_DATABASE=true. Returns why
// it is refused, or null when it may be used.
export function localDatabaseRefusal(env) {
  if (String(env?.NODE_ENV || '').trim().toLowerCase() === 'production') {
    return 'DATABASE_DRIVER=pglite is a local development database and is refused when NODE_ENV=production';
  }
  if (globalThis.navigator?.userAgent === 'Cloudflare-Workers') {
    return 'DATABASE_DRIVER=pglite needs Node and is not available in Cloudflare Workers';
  }
  const host = String(env?.AUTH_HOST || '').trim();
  if (host && !LOOPBACK_HOST.test(host) && env?.ALLOW_LOCAL_DATABASE !== 'true') {
    return `DATABASE_DRIVER=pglite only serves a gateway bound to loopback (AUTH_HOST=${host.slice(0, 64)}); ` +
      'set ALLOW_LOCAL_DATABASE=true to override';
  }
  return null;
}

export function databaseConfigured(env) {
  if (!env) return false;
  const driver = databaseDriver(env);
  if (driver === 'pglite') return localDatabaseRefusal(env) === null;
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
  const refusal = databaseDriver(env) === 'pglite' ? localDatabaseRefusal(env) : null;
  if (refusal) throw new AccountDatabaseError(refusal);
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

// Local development only. Supabase Auth owns auth.users, which zerox_accounts and
// zerox_session_index reference; the PGlite database has no Auth service, so the auth.users row
// of a local dev identity (dev_ token, DEV_AUTH_ENABLED on a loopback Node server) is created
// here. On every other driver this does nothing: production accounts always come from Supabase
// Auth, and dev identities cannot sign in there. Returns true when the row was provisioned.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function provisionDevIdentity(env, userId, email) {
  if (databaseDriver(env) !== 'pglite') return false;
  const refusal = localDatabaseRefusal(env);
  if (refusal) throw new AccountDatabaseError(refusal);
  if (!UUID.test(String(userId)) || typeof email !== 'string' || !email.includes('@') || email.length > 255) {
    throw new AccountDatabaseError('Invalid local dev identity');
  }
  const { pgliteProvisionAuthUser } = await loadPgliteDriver();
  await pgliteProvisionAuthUser(env, userId, email);
  return true;
}

// Calls a Postgres function and returns its first row (or null).
export async function rpc(env, name, args) {
  const rows = await rpcRows(env, name, args);
  return rows[0] ?? null;
}

export const accountRpc = rpc;

export function databaseConfigured(env) {
  return !!env.SUPABASE_URL && String(env.SUPABASE_SECRET_KEY || '').startsWith('sb_secret_');
}

// Calls a Postgres function through PostgREST and returns every row.
// See docs/PLATFORM_CONTRACT.md section 4 for the RPC catalogue.
export async function rpcRows(env, name, args) {
  if (!databaseConfigured(env)) throw new Error('Account database is not configured');
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: env.SUPABASE_SECRET_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Account database request failed (${response.status})`);
  const rows = await response.json();
  return Array.isArray(rows) ? rows : [rows];
}

// Calls a Postgres function and returns its first row (or null).
export async function rpc(env, name, args) {
  const rows = await rpcRows(env, name, args);
  return rows[0] || null;
}

export const accountRpc = rpc;

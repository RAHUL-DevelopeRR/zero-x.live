export function databaseConfigured(env) {
  return !!env.SUPABASE_URL && String(env.SUPABASE_SECRET_KEY || '').startsWith('sb_secret_');
}

export async function accountRpc(env, name, args) {
  if (!databaseConfigured(env)) throw new Error('Account database is not configured');
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: env.SUPABASE_SECRET_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Account database request failed (${response.status})`);
  const rows = await response.json();
  return rows[0] || null;
}

// Provider key vault admin API (docs/PLATFORM_CONTRACT.md section 11.1). Operator only: Bearer
// GATEWAY_ADMIN_TOKEN, plus a valid Cloudflare Access JWT when CF_ACCESS_* is configured
// (src/access-auth.js). Responses carry key metadata and the last four characters, never a key,
// its ciphertext or its IV. Used by https://dashboard.zero-x.live/admin/keys.
import { rpc, rpcRows } from '../account-store.js';
import { errorResponse, sendApiError } from '../auth-context.js';
import { isOperator } from '../operator-auth.js';
import { accessConfigured, passedAccess } from '../access-auth.js';
import { CATALOG, VAULT_KEY_VARS, entryPools, offeredEntries, poolKey } from '../catalog.js';
import { classifyUpstreamFailure } from '../providers.js';
import { FailureKind, globalHealthTracker } from '../provider-health.js';
import { hubHealthRows } from '../health-hub-client.js';
import { publicStatus } from '../health-share.js';
import {
  MAX_ACTIVE_KEYS, VAULT_PROVIDERS, kekConfigured, lastFour, loadVaultKeys, sealProviderKey, vaultConfigured, vaultKeys,
  vaultKeySecret,
} from '../provider-keys.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_TEXT = /^[\x21-\x7e]{16,512}$/; // printable ASCII, no spaces
const MAX_BODY_BYTES = 4096;

// One free request that tells a live key from a dead one. Groq and Gemini list models with the
// key; OpenRouter's list is public, so its key endpoint is read; NVIDIA's list is public and it
// has no free key endpoint, so one 1-token completion is sent (one of the trial's 10,000 a day).
function validationRequest(provider, secret) {
  if (provider === 'groq') return ['https://api.groq.com/openai/v1/models', { headers: { Authorization: `Bearer ${secret}` } }];
  if (provider === 'gemini') {
    return ['https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', { headers: { 'x-goog-api-key': secret } }];
  }
  if (provider === 'openrouter') return ['https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${secret}` } }];
  const model = CATALOG.find(entry => entry.provider === 'nvidia' && entry.auto_rank != null)?.upstream_model;
  return ['https://integrate.api.nvidia.com/v1/chat/completions', {
    method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 1, stream: false, messages: [{ role: 'user', content: 'OK' }] }),
  }];
}

// { ok:true } when the provider accepted the key (a rate limit counts: it authenticated);
// { ok:false, reason:'rejected'|'unavailable', status } otherwise. Never includes the key.
export async function validateProviderKey(provider, secret, { fetchImpl = (...args) => fetch(...args) } = {}) {
  const [url, init] = validationRequest(provider, secret);
  let response;
  try {
    // Never follow a redirect with the key attached: Workers rejects the 'error' mode, and with
    // 'manual' a 3xx is a non-ok response, reported as unavailable below.
    response = await fetchImpl(url, { ...init, redirect: 'manual',
      signal: AbortSignal.timeout(provider === 'nvidia' ? 30_000 : 10_000) });
  } catch (error) {
    return { ok: false, reason: 'unavailable', status: null, timeout: error?.name === 'TimeoutError' };
  }
  if (response.ok) {
    await response.body?.cancel?.().catch?.(() => {});
    return { ok: true, status: response.status };
  }
  const text = (await response.text().catch(() => '')).slice(0, 16384);
  const { kind } = classifyUpstreamFailure(response.status, text, response.headers);
  if (response.status === 401 || response.status === 403 || kind === FailureKind.AUTH) {
    return { ok: false, reason: 'rejected', status: response.status };
  }
  if (kind === FailureKind.RATE_LIMITED) return { ok: true, status: response.status };
  return { ok: false, reason: 'unavailable', status: response.status };
}

const publicKey = row => ({
  id: row.id, provider: row.provider, label: row.label, last4: row.last4, status: row.status,
  created_at: row.created_at ?? null, disabled_at: row.disabled_at ?? null, last_used_at: row.last_used_at ?? null,
});

// Per active key: how its pools look in the HealthHub snapshot (this isolate's tracker on the
// Node server). A key whose every pool is blurred is most likely dead.
async function keyHealth(env, keys) {
  const poolsByKey = new Map(keys.map(key => [key.id, []]));
  for (const entry of offeredEntries(env)) {
    for (const pool of entryPools(env, entry)) {
      if (pool.key_id && poolsByKey.has(pool.key_id)) poolsByKey.get(pool.key_id).push(poolKey(entry, pool));
    }
  }
  const all = [...poolsByKey.values()].flat();
  const rows = await hubHealthRows(env, all);
  const now = Date.now();
  const statusOf = key => {
    const row = rows?.get(key);
    if (row) return row.status === 'degraded' || (row.until || 0) > now ? row.status : 'available';
    return publicStatus(globalHealthTracker.records.get(key), now).status;
  };
  return new Map([...poolsByKey].map(([id, pools]) => {
    const summary = { pools: pools.length, available: 0, degraded: 0, busy: 0, blurred: 0 };
    for (const key of pools) summary[statusOf(key)]++;
    return [id, summary];
  }));
}

async function operatorGate(c) {
  if (!await isOperator(c)) return errorResponse(c, 401, 'invalid_session', 'Operator authentication required.');
  if (!await passedAccess(c)) return errorResponse(c, 403, 'access_required', 'Cloudflare Access authentication required.');
  if (!vaultConfigured(c.env)) {
    return errorResponse(c, 503, 'vault_not_configured', kekConfigured(c.env)
      ? 'The account database is not configured.'
      : 'Set the Worker secret PROVIDER_KEYS_KEK (32 random bytes, base64) to use the provider key vault.');
  }
  c.header('Cache-Control', 'no-store');
  return null;
}

async function listing(env) {
  const rows = await rpcRows(env, 'zerox_provider_keys_list', {});
  const active = await loadVaultKeys(env, { force: true, wait: Infinity });
  const health = await keyHealth(env, active);
  const providers = VAULT_PROVIDERS.map(provider => {
    const envKey = typeof env[VAULT_KEY_VARS[provider]] === 'string' ? env[VAULT_KEY_VARS[provider]].trim() : '';
    const duplicate = envKey ? active.find(key => key.provider === provider && vaultKeySecret(key) === envKey) : null;
    return {
      provider,
      active_keys: rows.filter(row => row.provider === provider && row.status === 'active').length,
      max_keys: MAX_ACTIVE_KEYS,
      // The Worker secret (GitHub-deployed) key: the fallback pool, unless the vault holds it too.
      env_key: envKey ? { variable: VAULT_KEY_VARS[provider], last4: lastFour(envKey),
        fallback: !duplicate, duplicate_of: duplicate?.id ?? null } : null,
    };
  });
  return {
    vault_configured: true,
    access_configured: accessConfigured(env),
    providers,
    keys: rows.map(row => ({ ...publicKey(row), health: health.get(row.id) ?? null })),
  };
}

export function registerProviderKeyRoutes(api) {
  api.get('/admin/providers/keys', async c => {
    const denied = await operatorGate(c);
    if (denied) return denied;
    try {
      return c.json(await listing(c.env));
    } catch (error) {
      return sendApiError(c, error);
    }
  });

  // { provider, label, key } → 201 { key } after one validation request to the provider.
  api.post('/admin/providers/keys', async c => {
    const denied = await operatorGate(c);
    if (denied) return denied;
    if (!String(c.req.header('Content-Type') || '').toLowerCase().startsWith('application/json')) {
      return errorResponse(c, 415, 'invalid_request', 'Send the key as application/json.');
    }
    const raw = await c.req.text().catch(() => '');
    if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return errorResponse(c, 413, 'invalid_request', 'Request body too large.');
    let body = null;
    try { body = JSON.parse(raw); } catch { /* reported below */ }
    const provider = typeof body?.provider === 'string' ? body.provider.trim().toLowerCase() : '';
    const label = typeof body?.label === 'string' ? body.label.trim() : '';
    const secret = typeof body?.key === 'string' ? body.key.trim() : '';
    if (!VAULT_PROVIDERS.includes(provider)) {
      return errorResponse(c, 400, 'invalid_request', `provider must be one of ${VAULT_PROVIDERS.join(', ')}.`, { param: 'provider' });
    }
    if (!label || label.length > 64 || /[\u0000-\u001f\u007f]/.test(label)) {
      return errorResponse(c, 400, 'invalid_request', 'label must be 1-64 printable characters.', { param: 'label' });
    }
    if (!KEY_TEXT.test(secret)) {
      return errorResponse(c, 400, 'invalid_request', 'key must be 16-512 printable characters without spaces.', { param: 'key' });
    }
    try {
      const active = await loadVaultKeys(c.env, { force: true, wait: Infinity });
      if (active.some(key => key.provider === provider && vaultKeySecret(key) === secret)) {
        return errorResponse(c, 409, 'duplicate_key', 'This key is already in the vault.', { param: 'key' });
      }
      const check = await validateProviderKey(provider, secret);
      if (!check.ok && check.reason === 'rejected') {
        return errorResponse(c, 422, 'invalid_provider_key',
          `${provider} rejected this key (HTTP ${check.status}). Nothing was saved.`, { param: 'key' });
      }
      if (!check.ok) {
        return errorResponse(c, 502, 'upstream_error', `Could not verify the key with ${provider} ` +
          `(${check.status ? `HTTP ${check.status}` : check.timeout ? 'timed out' : 'network error'}). Nothing was saved; try again.`);
      }
      const id = crypto.randomUUID();
      const sealed = await sealProviderKey(c.env, { id, provider, secret });
      let row;
      try {
        row = await rpc(c.env, 'zerox_provider_key_add', { p_id: id, p_provider: provider, p_label: label,
          p_ciphertext: sealed.ciphertext, p_iv: sealed.iv, p_last4: lastFour(secret) });
      } catch (error) {
        if (/too_many_keys/.test(error?.message || '')) {
          return errorResponse(c, 409, 'too_many_keys', `At most ${MAX_ACTIVE_KEYS} active ${provider} keys; disable one first.`);
        }
        throw error;
      }
      if (!row) throw new Error('Provider key insert returned no row');
      await loadVaultKeys(c.env, { force: true, wait: Infinity });
      return c.json({ key: publicKey(row) }, 201);
    } catch (error) {
      return sendApiError(c, error);
    }
  });

  // Disables a key: its pools leave every isolate within a minute (this one at once).
  api.delete('/admin/providers/keys/:id', async c => {
    const denied = await operatorGate(c);
    if (denied) return denied;
    const id = c.req.param('id');
    if (!UUID.test(id)) return errorResponse(c, 400, 'invalid_request', 'Unknown key id.', { param: 'id' });
    try {
      const row = await rpc(c.env, 'zerox_provider_key_disable', { p_id: id });
      if (!row) return errorResponse(c, 404, 'not_found', 'No such provider key.');
      await loadVaultKeys(c.env, { force: true, wait: Infinity });
      return c.json({ key: publicKey(row) });
    } catch (error) {
      return sendApiError(c, error);
    }
  });
}

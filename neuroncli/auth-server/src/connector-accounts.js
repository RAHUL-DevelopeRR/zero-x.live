// Linked hosted connector accounts (migration 20261104000100_connector_accounts.sql): plan access,
// the vendor token exchange and refresh, and the stored links. Shared by the account routes
// (src/routes/connectors.js) and the MCP proxy (src/mcp-proxy.js). Tokens never leave this module
// except as the bearer the proxy sends to the vendor; nothing here logs them.
import { databaseConfigured, rpc, rpcRows } from './account-store.js';
import { connectorConfig, hostedConnector } from './connector-catalog.js';
import { connectorPolicyBlock, hostedConnectorsEnabled } from './connector-policy.js';
import { connectorKekConfigured, openConnectorTokens, sealConnectorTokens } from './connector-vault.js';
import { normalizePlanId } from './plan-policy.js';

export const CONNECT_URL = 'https://zero-x.live/dashboard#connectors';
const POLICY_TTL_MS = 60_000;
const REFRESH_MARGIN_MS = 60_000;

// Hosted connectors serve only when switched on, with the account database and the token key.
export function connectorsServing(env) {
  return hostedConnectorsEnabled(env) && databaseConfigured(env) && connectorKekConfigured(env);
}

// The public origin of /mcp/<id> (HOSTED_CONNECTORS_BASE_URL, https; default https://zero-x.live).
export function connectorEndpoint(env, id) {
  const base = typeof env?.HOSTED_CONNECTORS_BASE_URL === 'string' && /^https:\/\/[^/\s]+$/.test(env.HOSTED_CONNECTORS_BASE_URL.trim())
    ? env.HOSTED_CONNECTORS_BASE_URL.trim() : 'https://zero-x.live';
  return `${base}/mcp/${id}`;
}

const policyCache = new WeakMap(); // env -> { expires, byPlan: Map(plan -> block|null) }

// The plan's policy.connectors block (contract section 14.1) or null; plans without a policy (or a
// database without the column) grant no hosted connector.
export async function planConnectorPolicy(env, plan) {
  let cached = policyCache.get(env);
  if (!cached || cached.expires <= Date.now()) {
    const rows = await rpcRows(env, 'zerox_plan_policies_v2', {});
    const byPlan = new Map();
    for (const row of rows) {
      const id = String(row?.plan ?? '').toLowerCase();
      if (id && !byPlan.has(id)) byPlan.set(id, connectorPolicyBlock(row.connector_policy, env));
    }
    cached = { expires: Date.now() + POLICY_TTL_MS, byPlan };
    policyCache.set(env, cached);
  }
  const key = String(plan || 'free').toLowerCase();
  return cached.byPlan.get(key) ?? cached.byPlan.get(normalizePlanId(key)) ?? null;
}

export function resetConnectorPolicyCache(env) {
  policyCache.delete(env);
}

// Whether a policy block lets the plan use connector `id` hosted: listed in `hosted`, allowed
// (by id or "catalog:*") and not denied.
export function policyAllowsHosted(policy, id) {
  if (!policy) return false;
  if (policy.denied.includes(id)) return false;
  if (!policy.allowed.includes('catalog:*') && !policy.allowed.includes(id)) return false;
  return policy.hosted.includes(id);
}

// ── Vendor token endpoint ──

export class ConnectorTokenError extends Error {
  constructor(status, code) {
    super(`Connector token request failed (${status})`);
    this.name = 'ConnectorTokenError';
    this.status = status;
    // The vendor's OAuth error code, kept only when it looks like one (it reaches the audit log).
    this.code = typeof code === 'string' && /^[a-z_]{1,40}$/.test(code) ? code : 'token_error';
  }
}

const scopeList = value => (typeof value === 'string' ? value.split(/[\s,]+/) : Array.isArray(value) ? value : [])
  .filter(scope => typeof scope === 'string' && /^[\w.:/*-]{1,128}$/.test(scope)).slice(0, 64);

// POSTs a form to the connector's token URL (client id, and client secret when set) and returns
// {bundle, scopes}. Handles Slack's {ok:false} and its user-token shape (authed_user).
export async function requestTokens(config, params, now = Date.now()) {
  const body = new URLSearchParams({ ...params, client_id: config.clientId });
  if (config.clientSecret) body.set('client_secret', config.clientSecret);
  let response;
  try {
    response = await fetch(config.tokenUrl, {
      method: 'POST', redirect: 'manual', body, signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    });
  } catch {
    throw new ConnectorTokenError(502, 'token_endpoint_unreachable');
  }
  const data = await response.json().catch(() => null);
  if (!response.ok || !data || typeof data !== 'object' || data.ok === false || data.error) {
    throw new ConnectorTokenError(response.status, data?.error);
  }
  const source = typeof data.access_token === 'string' ? data
    : typeof data.authed_user?.access_token === 'string' ? data.authed_user : data;
  const expiresIn = Number(source.expires_in);
  const bundle = {
    access_token: typeof source.access_token === 'string' ? source.access_token : undefined,
    refresh_token: typeof source.refresh_token === 'string' ? source.refresh_token : undefined,
    token_type: typeof source.token_type === 'string' ? source.token_type : undefined,
    expires_at: Number.isFinite(expiresIn) && expiresIn > 0 ? Math.round(now + expiresIn * 1000) : undefined,
  };
  if (!bundle.access_token && !bundle.refresh_token) throw new ConnectorTokenError(502, 'no_token');
  return { bundle, scopes: scopeList(source.scope ?? data.scope) };
}

// ── Stored links ──

export async function linkConnectorAccount(env, { userId, connector, bundle, scopes }) {
  const id = crypto.randomUUID();
  const enc = await sealConnectorTokens(env, { id, userId, connector }, bundle);
  return rpc(env, 'zerox_connector_account_link', {
    p_id: id, p_user_id: userId, p_connector: connector, p_enc: enc, p_scopes: scopes,
  });
}

export async function listConnectorAccounts(env, userId) {
  return rpcRows(env, 'zerox_connector_accounts_list', { p_user_id: userId });
}

export async function revokeConnectorAccount(env, userId, connector) {
  const row = await rpc(env, 'zerox_connector_account_revoke', { p_user_id: userId, p_connector: connector });
  return row?.revoked === true;
}

const refreshing = new Map(); // row id -> Promise<bundle> (one refresh per link per isolate)

async function refreshBundle(env, config, link, bundle) {
  const { bundle: fresh } = await requestTokens(config, { grant_type: 'refresh_token', refresh_token: bundle.refresh_token });
  // A vendor that does not rotate refresh tokens keeps the old one.
  const next = { ...fresh, refresh_token: fresh.refresh_token || bundle.refresh_token };
  const enc = await sealConnectorTokens(env, link, next);
  await rpc(env, 'zerox_connector_account_rotate', { p_id: link.id, p_user_id: link.userId, p_enc: enc });
  return next;
}

/**
 * The user's usable vendor access token for a connector, refreshing it when it has expired (or
 * `force`, after the vendor answered 401). Returns {token, link} or null when the user has no
 * active link, or its tokens cannot be opened or refreshed (the proxy then answers needs_connect;
 * a link the vendor refuses to refresh is revoked so the dashboard shows it disconnected).
 */
export async function connectorAccessToken(env, userId, connectorId, { force = false, now = Date.now() } = {}) {
  const connector = hostedConnector(connectorId);
  if (!connector) return null;
  const row = await rpc(env, 'zerox_connector_account_get', { p_user_id: userId, p_connector: connectorId });
  if (!row?.id) return null;
  const link = { id: String(row.id), userId, connector: connectorId };
  let bundle;
  try {
    bundle = await openConnectorTokens(env, link, row.enc_refresh_token);
  } catch {
    console.error('Connector tokens could not be opened', { connector: connectorId });
    return null;
  }
  const expired = Number.isSafeInteger(bundle.expires_at) && bundle.expires_at - REFRESH_MARGIN_MS <= now;
  if ((force || expired || !bundle.access_token) && bundle.refresh_token) {
    const config = connectorConfig(env, connector);
    if (!config.configured) return null;
    let pending = refreshing.get(link.id);
    if (!pending) {
      pending = refreshBundle(env, config, link, bundle).finally(() => refreshing.delete(link.id));
      refreshing.set(link.id, pending);
    }
    try {
      bundle = await pending;
    } catch (error) {
      if (error instanceof ConnectorTokenError && error.status >= 400 && error.status < 500) {
        await revokeConnectorAccount(env, userId, connectorId).catch(() => {});
      }
      console.warn('Connector token refresh failed', { connector: connectorId, code: error?.code ?? 'error' });
      return null;
    }
  } else if (force || expired) {
    // An expired (or refused) token that cannot be refreshed: the user links the account again.
    return null;
  }
  return bundle.access_token ? { token: bundle.access_token, link } : null;
}

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

// The hosted ids (of a plan's policy) this gateway can serve right now: hosted connectors serving
// (switched on, database, token key), a catalog entry, and the vendor's OAuth app configured.
// GET /api/account reports only these, so a client never sets up a connector that would answer
// 503 connector_not_configured or connectors_unavailable.
export function servableHostedIds(env, ids) {
  if (!Array.isArray(ids) || !ids.length || !connectorsServing(env)) return [];
  return ids.filter(id => {
    const connector = hostedConnector(id);
    return Boolean(connector) && connectorConfig(env, connector).configured;
  });
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

// A token request the vendor answered, refusing the grant itself (the refresh token is revoked,
// expired or unknown). Only these end a link; an unreachable token endpoint, a vendor 5xx or an
// operator mistake (invalid_client, invalid_request) keeps it.
const REFUSED_GRANT = new Set(['invalid_grant', 'invalid_refresh_token', 'token_revoked', 'token_expired',
  'refresh_token_expired', 'expired_token']);
export function grantRefused(error) {
  return error instanceof ConnectorTokenError && error.status < 500 && REFUSED_GRANT.has(error.code);
}

// The link cannot be used right now for a reason that may pass (the vendor's token endpoint is
// down, the tokens cannot be opened, the vendor is not configured). The link is kept.
export class ConnectorUnavailableError extends Error {
  constructor(code) {
    super('Connector tokens are temporarily unavailable');
    this.name = 'ConnectorUnavailableError';
    this.code = typeof code === 'string' && /^[a-z_]{1,40}$/.test(code) ? code : 'unavailable';
  }
}

const scopeList = value => (typeof value === 'string' ? value.split(/[\s,]+/) : Array.isArray(value) ? value : [])
  .filter(scope => typeof scope === 'string' && /^[\w.:/*-]{1,128}$/.test(scope)).slice(0, 64);

// POSTs a form to the connector's token URL (client id, and client secret when set) and returns
// {bundle, scopes}. Handles Slack's {ok:false} and its user-token shape (authed_user). For a
// connector with `resource` (an MCP 2025-06-18 authorization server, RFC 8707) every grant names
// the MCP server as the resource, as the authorize URL did, so the token's audience is that server.
export async function requestTokens(config, params, now = Date.now()) {
  const body = new URLSearchParams({ ...params, client_id: config.clientId });
  if (config.clientSecret) body.set('client_secret', config.clientSecret);
  if (config.resource && config.mcpUrl) body.set('resource', config.mcpUrl);
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

// Ends the user's link: the row and its sealed tokens are deleted (not kept as a record).
export async function revokeConnectorAccount(env, userId, connector) {
  const row = await rpc(env, 'zerox_connector_account_revoke', { p_user_id: userId, p_connector: connector });
  return row?.revoked === true;
}

// The stored tokens of the user's active link, as stored (no refresh), or null without a link.
// For revoking them at the vendor on disconnect; throws when they cannot be opened.
export async function storedConnectorTokens(env, userId, connectorId) {
  const row = await rpc(env, 'zerox_connector_account_get', { p_user_id: userId, p_connector: connectorId });
  if (!row?.id) return null;
  return openConnectorTokens(env, { id: String(row.id), userId, connector: connectorId }, row.enc_refresh_token);
}

// RFC 7009 revocation at the vendor (CONNECTOR_<ID>_REVOKE_URL), best effort: the refresh token
// first (which ends the grant at vendors that tie access tokens to it), then the access token.
export async function revokeTokensAtVendor(config, bundle) {
  if (!config.revokeUrl || !bundle) return;
  const tokens = [['refresh_token', bundle.refresh_token], ['access_token', bundle.access_token]]
    .filter(([, token]) => typeof token === 'string' && token);
  for (const [hint, token] of tokens) {
    const body = new URLSearchParams({ token, token_type_hint: hint, client_id: config.clientId });
    if (config.clientSecret) body.set('client_secret', config.clientSecret);
    try {
      const response = await fetch(config.revokeUrl, { method: 'POST', body, redirect: 'manual', signal: AbortSignal.timeout(10000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' } });
      response.body?.cancel().catch(() => {});
    } catch {
      console.warn('Connector revocation at the vendor failed', { connector: config.id, hint });
    }
  }
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
 * `force`, after the vendor answered 401). Returns {token, link}, or null when the link is gone
 * for good: no active link, the vendor refused the refresh grant (grantRefused), or the token is
 * expired or refused without a refresh token. In the last two cases the link is revoked, so the
 * dashboard shows it disconnected and the proxy answers needs_connect.
 * Throws ConnectorUnavailableError when the failure may pass (the token endpoint unreachable or
 * answering 5xx, an operator error such as invalid_client, tokens that cannot be opened, the
 * vendor not configured): the link is kept and the proxy answers 502.
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
    throw new ConnectorUnavailableError('token_open_failed');
  }
  const expired = Number.isSafeInteger(bundle.expires_at) && bundle.expires_at - REFRESH_MARGIN_MS <= now;
  if ((force || expired || !bundle.access_token) && bundle.refresh_token) {
    const config = connectorConfig(env, connector);
    if (!config.configured) throw new ConnectorUnavailableError('connector_not_configured');
    let pending = refreshing.get(link.id);
    if (!pending) {
      pending = refreshBundle(env, config, link, bundle).finally(() => refreshing.delete(link.id));
      refreshing.set(link.id, pending);
    }
    try {
      bundle = await pending;
    } catch (error) {
      console.warn('Connector token refresh failed', { connector: connectorId, code: error?.code ?? 'error' });
      if (grantRefused(error)) {
        await revokeConnectorAccount(env, userId, connectorId).catch(() => {});
        return null;
      }
      throw new ConnectorUnavailableError(error instanceof ConnectorTokenError ? error.code : 'refresh_failed');
    }
  } else if (force || expired) {
    // An expired (or refused) token without a refresh token: the link cannot recover, so it ends
    // and the user links the account again.
    await revokeConnectorAccount(env, userId, connectorId).catch(() => {});
    return null;
  }
  return bundle.access_token ? { token: bundle.access_token, link } : null;
}

// Hosted connector accounts (docs/PLATFORM_CONTRACT.md section 18.4). Every route answers 404 unless
// HOSTED_CONNECTORS=true.
//   GET    /api/connectors              → {connectors:[{id, name, publisher, status, ...}], connect_url, catalog_version}
//   POST   /api/connectors/:id/connect  → {authorize_url} (and a short-lived HttpOnly state cookie)
//   GET    /api/connectors/callback     → 303 to the dashboard (?connector=<id>&connect=ok|error[&reason=]#connectors)
//   DELETE /api/connectors/:id          → {status:'disconnected'}
// status is one of connected, not_connected, not_in_plan (the plan's policy.connectors.hosted
// lacks the id) and unavailable (the operator has not configured the vendor's OAuth app).
// The vendor's tokens are never returned; the list shows scopes and dates only.
import { rpc } from '../account-store.js';
import { ApiError, INTERACTIVE_CREDENTIALS, errorResponse, withCaller } from '../auth-context.js';
import { HOSTED_CATALOG_VERSION, HOSTED_CONNECTORS, connectorConfig, hostedConnector } from '../connector-catalog.js';
import { hostedConnectorsEnabled } from '../connector-policy.js';
import {
  CONNECT_URL, ConnectorTokenError, connectorEndpoint, connectorsServing, linkConnectorAccount,
  listConnectorAccounts, planConnectorPolicy, policyAllowsHosted, requestTokens, revokeConnectorAccount,
  revokeTokensAtVendor, storedConnectorTokens,
} from '../connector-accounts.js';
import { bytesToBase64 } from '../provider-keys.js';
import { deleteRecord, readRecord, sha256Hex, writeRecord } from '../session-store.js';

const STATE_TTL_SECONDS = 600;
const STATE_COOKIE = 'zx_connect';
const STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DEFAULT_CALLBACK_URL = 'https://dashboard.zero-x.live/api/connectors/callback';
const DEFAULT_RETURN_URL = 'https://dashboard.zero-x.live/';

const randomToken = () => bytesToBase64(crypto.getRandomValues(new Uint8Array(32)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function s256(verifier) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return bytesToBase64(digest).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// The redirect URI registered with every vendor's OAuth app (CONNECTORS_CALLBACK_URL, https; on
// the local Node server an http loopback URL is accepted).
export function callbackUrl(env) {
  const value = typeof env?.CONNECTORS_CALLBACK_URL === 'string' ? env.CONNECTORS_CALLBACK_URL.trim() : '';
  if (/^https:\/\/[^\s]+$/.test(value) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?\/[^\s]*$/.test(value)) return value;
  return DEFAULT_CALLBACK_URL;
}

// Where the callback sends the browser back (CONNECTORS_RETURN_URL: https, or a same-origin path).
function returnUrl(env, params) {
  const value = typeof env?.CONNECTORS_RETURN_URL === 'string' ? env.CONNECTORS_RETURN_URL.trim() : '';
  const base = /^https:\/\/[^\s]+$/.test(value) || /^\/(?!\/)[^\s]*$/.test(value) ? value : DEFAULT_RETURN_URL;
  const url = new URL(base, 'https://dashboard.zero-x.live');
  for (const [key, val] of Object.entries(params)) if (val) url.searchParams.set(key, val);
  url.hash = 'connectors';
  return base.startsWith('/') ? url.pathname + url.search + url.hash : url.toString();
}

const notFound = c => errorResponse(c, 404, 'not_found', 'Unknown API route.');
const unavailable = () => new ApiError(503, 'connectors_unavailable', 'Hosted connectors are not available on this gateway yet.');

function readCookie(c, name) {
  for (const part of String(c.req.header('Cookie') || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return '';
}
function stateCookie(env, value, maxAge) {
  const secure = callbackUrl(env).startsWith('https:') ? '; Secure' : '';
  return `${STATE_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

// Gate for the account routes: off → 404 (the route does not exist), on but missing the
// database or CONNECTOR_TOKENS_KEK → 503.
function gated(handler) {
  return async c => {
    if (!hostedConnectorsEnabled(c.env)) return notFound(c);
    return handler(c);
  };
}

function connectorParam(c) {
  const connector = hostedConnector(c.req.param('id'));
  if (!connector) throw new ApiError(404, 'not_found', 'No such hosted connector.', { param: 'id' });
  return connector;
}

export function registerConnectorRoutes(api) {
  api.get('/api/connectors', gated(withCaller(INTERACTIVE_CREDENTIALS, async (c, caller) => {
    if (!connectorsServing(c.env)) throw unavailable();
    const [policy, links] = await Promise.all([planConnectorPolicy(c.env, caller.plan), listConnectorAccounts(c.env, caller.user_id)]);
    const linked = new Map(links.map(row => [row.connector, row]));
    const iso = value => (Number.isFinite(Date.parse(value)) ? new Date(Date.parse(value)).toISOString() : null);
    return c.json({
      catalog_version: HOSTED_CATALOG_VERSION,
      connect_url: CONNECT_URL,
      connectors: HOSTED_CONNECTORS.map(connector => {
        const link = linked.get(connector.id);
        const inPlan = policyAllowsHosted(policy, connector.id);
        const configured = connectorConfig(c.env, connector).configured;
        const status = !inPlan ? 'not_in_plan' : link ? 'connected' : configured ? 'not_connected' : 'unavailable';
        return {
          id: connector.id, name: connector.name, publisher: connector.publisher, source: connector.source,
          endpoint: connectorEndpoint(c.env, connector.id), status, in_plan: inPlan, configured,
          scopes: link ? (link.scopes || []).map(String) : [],
          connected_at: link ? iso(link.created_at) : null,
        };
      }),
    });
  })));

  api.post('/api/connectors/:id/connect', gated(withCaller(INTERACTIVE_CREDENTIALS, async (c, caller) => {
    if (!connectorsServing(c.env)) throw unavailable();
    const connector = connectorParam(c);
    if (caller.suspended) throw new ApiError(403, 'account_suspended', 'This account is suspended. Contact support@zero-x.live.');
    if (!policyAllowsHosted(await planConnectorPolicy(c.env, caller.plan), connector.id)) {
      throw new ApiError(403, 'not_in_plan', `${connector.name} is not included in your plan. Upgrade at https://zero-x.live/pricing.`);
    }
    const config = connectorConfig(c.env, connector);
    if (!config.configured) {
      throw new ApiError(503, 'connector_not_configured', `${connector.name} is not available yet. Try again later.`);
    }
    const state = randomToken();
    const verifier = randomToken();
    const nonce = randomToken();
    await writeRecord(c.env, `connector-oauth:${state}`, {
      user_id: caller.user_id, connector: connector.id, verifier, nonce_hash: await sha256Hex(nonce), created: Date.now(),
    }, STATE_TTL_SECONDS);
    const url = new URL(config.authorizeUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', config.clientId);
    url.searchParams.set('redirect_uri', callbackUrl(c.env));
    if (config.scopes.length) url.searchParams.set(config.scopeParam, config.scopes.join(config.scopeSeparator));
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', await s256(verifier));
    url.searchParams.set('code_challenge_method', 'S256');
    if (config.resource) url.searchParams.set('resource', config.mcpUrl);
    c.header('Set-Cookie', stateCookie(c.env, nonce, STATE_TTL_SECONDS));
    return c.json({ authorize_url: url.toString(), expires_in: STATE_TTL_SECONDS });
  })));

  // The vendor sends the browser here. No Authorization header: the state record (one use, ten
  // minutes) names the user, and the HttpOnly cookie set by /connect proves this browser started
  // the flow, so a link started by someone else cannot be completed in a victim's browser.
  api.get('/api/connectors/callback', gated(async c => {
    const back = (connector, connect, reason) => {
      c.header('Set-Cookie', stateCookie(c.env, '', 0));
      return c.redirect(returnUrl(c.env, { connector, connect, reason }), 303);
    };
    const state = c.req.query('state') || '';
    if (!STATE_PATTERN.test(state)) return back(null, 'error', 'invalid_state');
    let record = null;
    try {
      record = await readRecord(c.env, `connector-oauth:${state}`);
      if (record) await deleteRecord(c.env, `connector-oauth:${state}`);
    } catch {
      return back(null, 'error', 'unavailable');
    }
    const connector = hostedConnector(record?.connector);
    if (!record || !connector || Date.now() - Number(record.created) > STATE_TTL_SECONDS * 1000) {
      return back(null, 'error', 'expired');
    }
    const nonce = readCookie(c, STATE_COOKIE);
    if (!nonce || await sha256Hex(nonce) !== record.nonce_hash) return back(connector.id, 'error', 'browser_mismatch');
    const vendorError = c.req.query('error');
    if (vendorError) return back(connector.id, 'error', vendorError === 'access_denied' ? 'denied' : 'vendor_error');
    const code = c.req.query('code') || '';
    if (!code || code.length > 2048) return back(connector.id, 'error', 'invalid_code');
    if (!connectorsServing(c.env)) return back(connector.id, 'error', 'unavailable');
    const config = connectorConfig(c.env, connector);
    if (!config.configured) return back(connector.id, 'error', 'unavailable');
    try {
      // The plan may have changed during the ten minutes.
      const account = await planForUser(c.env, record.user_id);
      if (!policyAllowsHosted(await planConnectorPolicy(c.env, account.plan), connector.id) || account.suspended) {
        return back(connector.id, 'error', 'not_in_plan');
      }
      const { bundle, scopes } = await requestTokens(config, {
        grant_type: 'authorization_code', code, redirect_uri: callbackUrl(c.env), code_verifier: record.verifier,
      });
      await linkConnectorAccount(c.env, { userId: record.user_id, connector: connector.id, bundle,
        scopes: scopes.length ? scopes : config.scopes });
      return back(connector.id, 'ok');
    } catch (error) {
      console.warn('Connector link failed', { connector: connector.id,
        code: error instanceof ConnectorTokenError ? error.code : error?.name ?? 'error' });
      return back(connector.id, 'error', error instanceof ConnectorTokenError ? 'token_exchange' : 'unavailable');
    }
  }));

  api.delete('/api/connectors/:id', gated(withCaller(INTERACTIVE_CREDENTIALS, async (c, caller) => {
    if (!connectorsServing(c.env)) throw unavailable();
    const connector = connectorParam(c);
    // Best effort: revoke the stored refresh and access tokens at the vendor (RFC 7009) when the
    // operator configured a revocation URL. The stored tokens are used as they are (no refresh).
    const config = connectorConfig(c.env, connector);
    if (config.revokeUrl) {
      const stored = await storedConnectorTokens(c.env, caller.user_id, connector.id).catch(() => null);
      await revokeTokensAtVendor(config, stored);
    }
    // Deletes the link and its sealed tokens.
    if (!await revokeConnectorAccount(c.env, caller.user_id, connector.id)) {
      throw new ApiError(404, 'not_found', `${connector.name} is not connected.`);
    }
    return c.json({ status: 'disconnected', connector: connector.id });
  })));
}

async function planForUser(env, userId) {
  const account = await rpc(env, 'zerox_get_account', { p_user_id: userId });
  if (!account) throw new Error('Account not found');
  return { plan: account.plan, suspended: account.suspended === true || account.status === 'suspended' };
}

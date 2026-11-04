// Hosted connector catalog (docs/PLATFORM_CONTRACT.md section 14.4). Each entry is a SaaS vendor
// whose official remote MCP server https://zero-x.live/mcp/<id> proxies to (src/mcp-proxy.js),
// with the OAuth endpoints the gateway links accounts through (src/routes/connectors.js) and the
// tool tiers the proxy enforces. The ids are the ones plans grant in
// zerox_plan_policy.connector_policy.hosted (migration 20261104000000) and must equal the CLI
// catalog's ids.
//
// Provider config comes from env vars named per connector, CONNECTOR_<ID>_<FIELD> (ID upper-case,
// other characters as "_"): CLIENT_ID, CLIENT_SECRET (secret), SCOPES (space or comma separated),
// and overrides MCP_URL, AUTHORIZE_URL, TOKEN_URL, REVOKE_URL (https only). A connector serves
// only when its client id and every URL are known; none are set as of 2026-11-04, so every
// connector reports `configured: false` until the owner registers an OAuth app per vendor.
//
// What was checked (web, 2026-11-04), and what still needs the owner:
// - github: remote server https://api.githubcopilot.com/mcp/ (Streamable HTTP), source
//   github/github-mcp-server (MIT, maintained by GitHub; releases v1.4/v1.5 on pkg.go.dev). It
//   accepts a bearer token; hosts that use OAuth register their own GitHub OAuth or GitHub App.
//   OAuth endpoints are GitHub's standard ones. Not verified: that an OAuth app's user token (as
//   opposed to a PAT) is accepted with every toolset; check on staging.
// - linear: https://mcp.linear.app/mcp (Streamable HTTP; /sse deprecated), vendor-operated. Linear
//   documents passing OAuth tokens and API keys as `Authorization: Bearer` (linear.app/docs/mcp).
//   OAuth endpoints are Linear's API OAuth app endpoints.
// - slack: https://mcp.slack.com/mcp (Streamable HTTP, no SSE, no dynamic client registration),
//   vendor-operated. User tokens from https://slack.com/oauth/v2_user/authorize and
//   https://slack.com/api/oauth.v2.user.access with the app's client id and secret
//   (docs.slack.dev/ai/mcp-server). Only Marketplace-published or internal Slack apps may use it,
//   and scopes vary per tool, so CONNECTOR_SLACK_SCOPES has no default and must be set.
// - notion: https://mcp.notion.com/mcp (GA, vendor-operated; the open-source makenotion server is
//   soft-deprecated in its favour). OAuth 2.0 with PKCE through the authorization server its
//   protected-resource metadata names, so the AUTHORIZE_URL and TOKEN_URL (and the client id,
//   registered for zero-x.live) come from that discovery and are set by the owner.
// - atlassian: Rovo MCP server, vendor-operated (atlassian/atlassian-mcp-server holds its docs).
//   OAuth 2.1 is the primary method. Sources disagree on the endpoint (/v1/mcp, /v2/mcp,
//   /v1/mcp/authv2), so MCP_URL, AUTHORIZE_URL and TOKEN_URL have no default and are set by the
//   owner after checking Atlassian's current docs.
//
// Tool tiers (read, write, external, destructive, blocked): an entry's explicit `tools` map wins,
// then its `patterns`, then the shared name patterns below; a tool matching none is `write`.
// `destructive` calls need `x-neuron-confirmed: 1`; `blocked` tools are removed from tools/list
// and refused.

export const HOSTED_CATALOG_VERSION = '2026-11-03';
export const TIERS = Object.freeze(['read', 'write', 'external', 'destructive', 'blocked']);

const READ_TOOL = /^(get|list|search|read|fetch|find|query|lookup|view|describe|retrieve|whoami|me)(?:[_-]|$)/i;
const DESTRUCTIVE_TOOL = /(?:^|[_-])(delete|remove|archive|close|merge|revoke|drop|destroy|cancel|transfer|reset|purge|dismiss)(?:[_-]|$)/i;

const entry = value => Object.freeze({ ...value, scopes: value.scopes ? Object.freeze(value.scopes) : null,
  tools: Object.freeze(value.tools || {}), patterns: Object.freeze(value.patterns || []) });

export const HOSTED_CONNECTORS = Object.freeze([
  entry({
    id: 'atlassian', name: 'Atlassian (Jira and Confluence)', publisher: 'Atlassian',
    source: 'Atlassian Rovo MCP server (vendor-operated)',
    mcp_url: null, authorize_url: null, token_url: null,
    scopes: null, scope_param: 'scope', scope_separator: ' ', resource: true,
  }),
  entry({
    id: 'github', name: 'GitHub', publisher: 'GitHub', source: 'github/github-mcp-server (MIT)',
    mcp_url: 'https://api.githubcopilot.com/mcp/',
    authorize_url: 'https://github.com/login/oauth/authorize',
    token_url: 'https://github.com/login/oauth/access_token',
    scopes: ['repo', 'read:org'], scope_param: 'scope', scope_separator: ' ', resource: false,
    tools: { delete_file: 'destructive', merge_pull_request: 'destructive', push_files: 'write' },
  }),
  entry({
    id: 'linear', name: 'Linear', publisher: 'Linear', source: 'Linear remote MCP server (vendor-operated)',
    mcp_url: 'https://mcp.linear.app/mcp',
    authorize_url: 'https://linear.app/oauth/authorize',
    token_url: 'https://api.linear.app/oauth/token',
    scopes: ['read', 'write'], scope_param: 'scope', scope_separator: ',', resource: false,
  }),
  entry({
    id: 'notion', name: 'Notion', publisher: 'Notion', source: 'Notion hosted MCP server (vendor-operated)',
    mcp_url: 'https://mcp.notion.com/mcp', authorize_url: null, token_url: null,
    scopes: [], scope_param: 'scope', scope_separator: ' ', resource: true,
  }),
  entry({
    id: 'slack', name: 'Slack', publisher: 'Slack', source: 'Slack MCP server (vendor-operated)',
    mcp_url: 'https://mcp.slack.com/mcp',
    authorize_url: 'https://slack.com/oauth/v2_user/authorize',
    token_url: 'https://slack.com/api/oauth.v2.user.access',
    scopes: null, scope_param: 'scope', scope_separator: ',', resource: false,
    // Messages leave the workspace's private context: shown as external, not destructive.
    patterns: [[/(?:^|[_-])(send|post|schedule|reply)(?:[_-]|$)/i, 'external']],
  }),
]);

export function hostedConnector(id) {
  return HOSTED_CONNECTORS.find(connector => connector.id === id) || null;
}

export function toolTier(connector, name) {
  const tool = String(name || '');
  if (connector && Object.hasOwn(connector.tools, tool)) return connector.tools[tool];
  for (const [pattern, tier] of connector?.patterns || []) if (pattern.test(tool)) return tier;
  if (DESTRUCTIVE_TOOL.test(tool)) return 'destructive';
  if (READ_TOOL.test(tool)) return 'read';
  return 'write';
}

const envName = (id, field) => `CONNECTOR_${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_${field}`;
const envText = (env, id, field) => {
  const value = env?.[envName(id, field)];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
};
// https URLs only, without credentials; anything else is no URL.
export function httpsUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
  } catch { return null; }
}

// The connector's provider config from the catalog and its env vars. `configured` is false (with
// the missing names) until a client id and every URL are known. The client secret is returned
// for the token exchange only; callers never log or return it.
export function connectorConfig(env, connector) {
  const id = connector.id;
  const scopesText = envText(env, id, 'SCOPES');
  const scopes = scopesText !== null ? scopesText.split(/[\s,]+/).filter(Boolean).slice(0, 64) : connector.scopes;
  const config = {
    id,
    mcpUrl: httpsUrl(envText(env, id, 'MCP_URL') ?? connector.mcp_url),
    authorizeUrl: httpsUrl(envText(env, id, 'AUTHORIZE_URL') ?? connector.authorize_url),
    tokenUrl: httpsUrl(envText(env, id, 'TOKEN_URL') ?? connector.token_url),
    revokeUrl: httpsUrl(envText(env, id, 'REVOKE_URL')),
    clientId: envText(env, id, 'CLIENT_ID'),
    clientSecret: envText(env, id, 'CLIENT_SECRET'),
    scopes,
    scopeParam: connector.scope_param,
    scopeSeparator: connector.scope_separator,
    resource: connector.resource,
  };
  const missing = [];
  if (!config.clientId) missing.push(envName(id, 'CLIENT_ID'));
  if (!config.mcpUrl) missing.push(envName(id, 'MCP_URL'));
  if (!config.authorizeUrl) missing.push(envName(id, 'AUTHORIZE_URL'));
  if (!config.tokenUrl) missing.push(envName(id, 'TOKEN_URL'));
  if (!Array.isArray(config.scopes)) missing.push(envName(id, 'SCOPES'));
  return { ...config, configured: missing.length === 0, missing };
}

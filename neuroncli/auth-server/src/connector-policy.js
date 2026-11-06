// Connector (MCP server) policy per plan (docs/PLATFORM_CONTRACT.md section 16.1). The policy is
// stored in zerox_plan_policy.connector_policy (migration 20261105000000_connector_policy.sql) and
// served as GET /api/account `policy.connectors`; the Neuron CLI applies it after its managed
// settings (managed-settings.json) and before user and project settings. There are no
// organisations yet, so the plan is the only gateway scope.
//
// Operators edit the column by hand, so every value is validated again here: ids that are not
// connector catalog ids are dropped, lists are de-duplicated and capped, and a policy that is not
// a JSON object is no policy at all (the block is left out, which the contract defines as "no
// gateway policy"). Deny wins: a denied id is never reported as required or hosted.

export const CATALOG_WILDCARD = 'catalog:*';
// The connector catalog version the seeded policies were written against; reported when a stored
// policy names none (or an invalid one).
export const DEFAULT_CATALOG_VERSION = '2026-11-03';
// Connector catalog ids: lower-case, as in the CLI's compiled-in catalog (assets/mcp-catalog.json).
const CONNECTOR_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CATALOG_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,63}$/;
const MAX_IDS = 100;

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// Hosted connectors (https://zero-x.live/mcp/<id>) are off until the operator switches them on:
// with HOSTED_CONNECTORS unset the plans' hosted ids stay in the database but /api/account reports
// none, so no client offers a connector this gateway does not serve.
export function hostedConnectorsEnabled(env) {
  return env?.HOSTED_CONNECTORS === 'true';
}

function idList(value, { wildcard = false } = {}) {
  if (!Array.isArray(value)) return null;
  const ids = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    const valid = CONNECTOR_ID.test(id) || (wildcard && id === CATALOG_WILDCARD);
    if (valid && !ids.includes(id)) ids.push(id);
    if (ids.length === MAX_IDS) break;
  }
  return ids;
}

// One stored connector_policy (a jsonb object, or its JSON text) as the contract's
// policy.connectors block, or null when the plan has no gateway policy. A missing `allowed`
// allows the whole catalog and a missing `allow_unvetted` allows unvetted servers: a policy only
// restricts what it says.
export function connectorPolicyBlock(stored, env = {}) {
  let raw = stored;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { return null; }
  }
  if (!isObject(raw)) return null;
  const denied = idList(raw.denied) ?? [];
  const notDenied = id => !denied.includes(id);
  return {
    allowed: idList(raw.allowed, { wildcard: true }) ?? [CATALOG_WILDCARD],
    denied,
    required: (idList(raw.required) ?? []).filter(notDenied),
    hosted: hostedConnectorsEnabled(env) ? (idList(raw.hosted) ?? []).filter(notDenied) : [],
    allow_unvetted: raw.allow_unvetted !== false,
    catalog_version: typeof raw.catalog_version === 'string' && CATALOG_VERSION.test(raw.catalog_version)
      ? raw.catalog_version : DEFAULT_CATALOG_VERSION,
  };
}

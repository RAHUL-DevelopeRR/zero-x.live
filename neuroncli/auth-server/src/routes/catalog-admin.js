// Catalog admin API (docs/PLATFORM_CONTRACT.md §2; used by https://dashboard.zero-x.live/admin/models).
// Operator only, like the provider key vault and the offers API: Bearer GATEWAY_ADMIN_TOKEN plus a
// valid Cloudflare Access JWT when CF_ACCESS_* is configured. The actor recorded in the audit log is
// the Access e-mail address, else "operator".
//
// A model change is proposed as a draft revision (nothing serves), reviewed as a diff against what
// serves now, and approved draft -> active here; the database requires the approver fields and logs
// every change (migration 20261025000000_catalog_models.sql). Every spec is checked against the code
// guardrails (src/catalog-guardrails.js) before it is written and again before it is approved.
// Model ids contain '/', so they travel in query strings and bodies, never in path parameters.
//
// src/index.js registers these routes and serves neuroncli/admin/models/ under /admin/models
// (ADMIN_PAGE_FILES, strict admin CSP); src/routes/discovery.js promote calls proposeCandidateDraft.
import { databaseConfigured, rpcRows } from '../account-store.js';
import { ApiError, errorResponse, sendApiError } from '../auth-context.js';
import { isOperator } from '../operator-auth.js';
import { accessConfigured, passedAccess, verifyAccessJwt } from '../access-auth.js';
import { MARKUP } from '../pricing.js';
import { LIST_PRICES, listPriceFor, MAX_DAILY_SPEND_CAP_USD } from '../list-prices.js';
import {
  BILLED_FREE_LIMITS, KEY_SLOTS, PROVIDER_TYPES, providerType, publicIdFor, slotConfigured, typeMaxCapMicrousd,
} from '../catalog-types.js';
import {
  apiFromSpec, normalizeSpec, publicSpecPricing, REASONING_EFFORTS, riskyChanges, sameSpec, specDiff, specFromApi,
  specValid, validateSpec,
} from '../catalog-guardrails.js';
import { catalogSnapshot, catalogStatus, codeCatalog, loadCatalog, reservedAliases } from '../catalog-db.js';

const MAX_BODY_BYTES = 65536;
const MODEL_ID = /^[a-z0-9@][a-z0-9@./:_-]{0,199}$/;
const DISPLAY_FORBIDDEN = /[\u0000-\u001f\u007f<>]/g;
export const SERVED_WITHIN_SECONDS = 60;

// Postgres exceptions raised by the catalog functions.
function databaseFailure(error) {
  if (error instanceof ApiError) return error;
  const message = String(error?.message || '');
  if (message.includes('catalog_model_not_found')) return new ApiError(404, 'not_found', 'No catalog model with this id.');
  if (message.includes('stale_revision')) {
    return new ApiError(409, 'stale_revision', 'The pending or active revision changed since it was reviewed; reload and review again.');
  }
  const transition = message.match(/invalid_transition: [^\n]{1,120}/);
  if (transition) return new ApiError(409, 'invalid_transition', transition[0]);
  for (const code of ['candidate_not_verified', 'catalog_immutable', 'catalog_unapproved']) {
    const at = message.indexOf(`${code}:`);
    if (at >= 0) return new ApiError(409, code, message.slice(at).slice(0, 300));
  }
  const invalid = message.indexOf('invalid_catalog:');
  if (invalid >= 0) return new ApiError(400, 'invalid_request', message.slice(invalid).slice(0, 300));
  if (/violates (check|not-null|foreign key) constraint|invalid input syntax/.test(message)) {
    return new ApiError(400, 'invalid_request', 'The database refused the model spec.');
  }
  return error;
}

async function actorOf(c) {
  if (!accessConfigured(c.env)) return 'operator';
  const identity = await verifyAccessJwt(c.env, c.req.header('Cf-Access-Jwt-Assertion'));
  return (identity?.email || identity?.sub || 'operator').slice(0, 64);
}

async function readJson(c) {
  const raw = await c.req.text();
  if (raw.length > MAX_BODY_BYTES) throw new ApiError(413, 'request_too_large', 'The request body is too large.');
  let body;
  try { body = raw ? JSON.parse(raw) : {}; } catch { throw new ApiError(400, 'invalid_request', 'The body must be JSON.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'invalid_request', 'The body must be a JSON object.');
  return body;
}

function modelIdOf(value, param = 'model_id') {
  const id = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!MODEL_ID.test(id)) throw new ApiError(400, 'invalid_request', 'A catalog model id is required.', { param });
  return id;
}

function revisionIdOf(value, param) {
  if (value === null) return null;
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new ApiError(400, 'invalid_request', `${param} must be a revision id.`, { param });
  return id;
}

const noteOf = value => (typeof value === 'string' && value.trim() ? value.trim().slice(0, 2000) : null);

function requireDatabase(env) {
  if (!databaseConfigured(env)) {
    throw new ApiError(503, 'catalog_not_configured', 'The account database is not configured; the code catalog is read-only.');
  }
}

// What a spec would add to GET /v1/models (deployment-independent part; availability depends on
// keys, offers, plan and country and is shown once it serves).
export function previewModel(id, spec) {
  const s = normalizeSpec(spec);
  const pools = Array.isArray(s.pools) ? s.pools.filter(pool => pool && typeof pool === 'object') : [];
  return {
    id, object: 'model', owned_by: s.provider_type, display_name: s.display_name,
    context_window: s.context_window, context_length: s.context_window, max_output_tokens: s.max_output_tokens,
    capabilities: { tools: s.supports_tools, streaming: true, vision: s.supports_vision,
      reasoning: Array.isArray(s.reasoning_efforts) && s.reasoning_efforts.length > 0 },
    reasoning_efforts: s.reasoning_efforts, tiers: pools.map(pool => pool.tier), pricing: publicSpecPricing(s),
    default_max_tokens: s.default_max_tokens, default_reasoning_effort: s.default_reasoning_effort,
    chosen_by_auto: s.auto_rank !== null,
  };
}

function revisionView(id, revision, now) {
  if (!revision) return null;
  const spec = normalizeSpec(revision.spec);
  return {
    revision_id: revision.revision_id, revision: revision.revision, author: revision.author, note: revision.note ?? null,
    created_at: revision.created_at, approved_by: revision.approved_by ?? null, approved_at: revision.approved_at ?? null,
    rejected_by: revision.rejected_by ?? null, rejected_at: revision.rejected_at ?? null,
    spec: apiFromSpec(spec), validation: validateSpec(id, spec, { now }), preview: previewModel(id, spec),
  };
}

// The spec a change is compared with: the active revision, else the code entry, else nothing (new).
function baseSpec(id, activeSpec) {
  return activeSpec ?? codeCatalog().byId.get(id.toLowerCase())?.spec ?? null;
}

function modelView(row, snapshot, now = Date.now()) {
  const code = codeCatalog().byId.get(row.id.toLowerCase());
  const activeSpec = row.active ? normalizeSpec(row.active.spec) : null;
  const verdict = snapshot.verdicts.get(row.id) ?? null;
  const pending = revisionView(row.id, row.pending, now);
  if (pending) {
    pending.diff = specDiff(baseSpec(row.id, activeSpec), row.pending.spec);
    pending.risky = riskyChanges(pending.diff).map(item => item.path);
  }
  const served = snapshot.byId.get(row.id.toLowerCase());
  return {
    id: row.id, provider_type: row.provider_type, status: row.status, source: row.source, candidate_id: row.candidate_id ?? null,
    status_changed_at: row.status_changed_at, created_at: row.created_at, updated_at: row.updated_at,
    code_defined: Boolean(code), matches_code: Boolean(code && activeSpec && sameSpec(activeSpec, code.spec)),
    served_from: verdict?.served_from ?? 'none', loader_reasons: verdict?.reasons ?? [], dropped_pools: verdict?.dropped_pools ?? [],
    served_tiers: served ? served.pools.map(pool => pool.tier) : [],
    active: revisionView(row.id, row.active, now), pending,
  };
}

function codeOnlyView(item, snapshot) {
  const verdict = snapshot.verdicts.get(item.id) ?? null;
  return { id: item.id, provider_type: item.spec.provider_type, status: 'code', code_defined: true,
    served_from: verdict?.served_from ?? 'none', loader_reasons: verdict?.reasons ?? [], dropped_pools: verdict?.dropped_pools ?? [],
    spec: apiFromSpec(item.spec), preview: previewModel(item.id, item.spec) };
}

async function modelDetail(env, id) {
  const [detail] = await rpcRows(env, 'zerox_catalog_model', { p_id: id });
  if (!detail?.model) throw new ApiError(404, 'not_found', 'No catalog model with this id.');
  return detail;
}

// The current row as zerox_catalog_list shapes it (active and pending revision json).
function listRow(detail) {
  const byId = new Map((detail.revisions || []).map(revision => [revision.revision_id, revision]));
  return { ...detail.model, active: byId.get(detail.model.active_revision_id) ?? null,
    pending: byId.get(detail.model.pending_revision_id) ?? null };
}

function apiPrice(price) {
  if (!price) return null;
  const billed = value => (value === undefined || value === null ? null : Number((value * MARKUP).toFixed(6)));
  const fields = ['input', 'output', 'cache_read', 'cache_write', 'cache_write_1h'].filter(key => price[key] !== undefined);
  return {
    ...Object.fromEntries(fields.map(key => [`${key}_usd_per_mtok`, price[key]])),
    long_context: price.long_context ? { threshold_tokens: price.long_context.threshold, input_usd_per_mtok: price.long_context.input,
      output_usd_per_mtok: price.long_context.output } : null,
    billed: Object.fromEntries(fields.map(key => [`${key}_usd_per_mtok`, billed(price[key])])),
  };
}

function typesView(env) {
  return Object.entries(PROVIDER_TYPES).map(([id, registry]) => {
    const slot = slotId => ({ id: slotId, env: KEY_SLOTS[slotId].env ?? null, binding: KEY_SLOTS[slotId].binding ?? null,
      configured: slotConfigured(env, slotId) });
    const prices = Object.fromEntries(Object.keys(LIST_PRICES).filter(key => key.startsWith(`${id}:`))
      .map(key => [key.slice(id.length + 1), apiPrice(listPriceFor(id, key.slice(id.length + 1)))]));
    return {
      id, adapter: registry.adapter, base_url: registry.base_url,
      // The private base URL itself is never shown, only whether its secret is set.
      base_url_env: registry.base_url_env, base_url_configured: registry.base_url_env ? Boolean(env?.[registry.base_url_env]) : null,
      id_prefix: registry.id_prefix, upstream_pattern: registry.upstream.source,
      slots: { free: registry.slots.free.map(slot), paid: registry.slots.paid.map(slot) },
      hosted_flag: registry.hosted_flag, requires_flag: { ...registry.requires_flag }, free_geo_block: [...registry.free_geo_block],
      paid_pricing: registry.paid_pricing, requires_cache_prices: registry.requires_cache_prices,
      max_daily_spend_usd: typeMaxCapMicrousd(id) / 1_000_000, paid_daily_cap_usd: registry.paid_daily_cap_usd,
      free_limits: registry.discovery_defaults?.limits ?? null, list_prices: prices,
      // Free pools on a billed slot (Workers AI): the only models allowed and their limit ceilings.
      billed_free_limits: BILLED_FREE_LIMITS[id] ?? null,
    };
  });
}

// Validates an operator API spec. Returns { id, spec, errors, validation }. A code model's id or
// alias named as another model's alias is an error here too (the loader would drop it anyway).
function checkApiSpec(body, now) {
  const { spec, errors } = specFromApi(body);
  if (!spec) return { id: null, spec: null, errors, validation: null };
  const id = publicIdFor(spec.provider_type, spec.upstream_model);
  const reserved = reservedAliases();
  for (const alias of Array.isArray(spec.aliases) ? spec.aliases : []) {
    const owner = reserved.get(String(alias).toLowerCase());
    if (owner && owner !== id) errors.push(`alias_reserved:${String(alias).slice(0, 100)}`);
  }
  return { id, spec, errors, validation: validateSpec(id, spec, { now }) };
}

async function currentActiveSpec(env, id) {
  if (!databaseConfigured(env)) return null;
  const [detail] = await rpcRows(env, 'zerox_catalog_model', { p_id: id });
  if (!detail?.model?.active_revision_id) return null;
  const active = (detail.revisions || []).find(revision => revision.revision_id === detail.model.active_revision_id);
  return active ? normalizeSpec(active.spec) : null;
}

const cleanName = value => (typeof value === 'string' ? value.replace(DISPLAY_FORBIDDEN, '').trim().slice(0, 120) : '');

/**
 * Discovery promote (src/routes/discovery.js): a verified candidate becomes a draft catalog row
 * (source 'discovery') with the provider type's free pool and default limits. Nothing serves until
 * an operator approves it on /admin/models.
 */
export async function proposeCandidateDraft(env, candidate, overrides = {}, actor = 'operator') {
  requireDatabase(env);
  const registry = providerType(candidate?.provider);
  if (!registry?.discovery_defaults || !registry.slots.free.length) {
    throw new ApiError(409, 'no_catalog_type', `${String(candidate?.provider ?? '').slice(0, 64)} has no free catalog type for discovered models.`);
  }
  const id = publicIdFor(candidate.provider, candidate.model_id);
  if (!id) throw new ApiError(409, 'invalid_model_id', 'The candidate model id is not a valid upstream id for its provider.');
  const context = Number(overrides.context_window ?? candidate.context_window);
  const maxOutput = Number(overrides.max_output_tokens ?? candidate.max_output_tokens ?? Math.min(16384, context));
  const spec = normalizeSpec({
    provider_type: candidate.provider, upstream_model: candidate.model_id,
    display_name: cleanName(overrides.display_name ?? candidate.display_name) || id.slice(0, 120),
    context_window: context, max_output_tokens: maxOutput, supports_tools: true, supports_vision: candidate.supports_vision === true,
    pools: [{ tier: 'free', key_slot: registry.slots.free[0], price: null, limits: { ...registry.discovery_defaults.limits },
      daily_spend_cap_microusd: null }],
  });
  const validation = validateSpec(id, spec);
  if (!specValid(validation)) {
    throw new ApiError(400, 'invalid_request', 'The candidate does not make a valid catalog model.', { reasons: validation });
  }
  const [row] = await rpcRows(env, 'zerox_catalog_propose', {
    p_spec: spec, p_actor: String(actor || 'operator').slice(0, 64), p_note: `Promoted discovery candidate ${candidate.id}`,
    p_detail: { diff: specDiff(baseSpec(id, await currentActiveSpec(env, id)), spec) }, p_source: 'discovery',
    p_candidate_id: candidate.id,
  }).catch(error => { throw databaseFailure(error); });
  return { model_id: row.model_id, revision_id: row.revision_id, status: row.status,
    admin_url: `/admin/models?id=${encodeURIComponent(row.model_id)}` };
}

export function registerCatalogAdminRoutes(api) {
  const operatorOnly = handler => async c => {
    if (!await isOperator(c)) return errorResponse(c, 401, 'invalid_session', 'Operator authentication required.');
    if (!await passedAccess(c)) return errorResponse(c, 403, 'access_required', 'Cloudflare Access authentication required.');
    c.header('Cache-Control', 'no-store');
    try {
      return await handler(c);
    } catch (error) {
      return sendApiError(c, databaseFailure(error));
    }
  };

  // Provider types, key slots (configured or not, never their values) and list prices.
  api.get('/admin/catalog/types', operatorOnly(async c => c.json({
    markup: MARKUP, hard_max_daily_spend_usd: MAX_DAILY_SPEND_CAP_USD, reasoning_efforts: REASONING_EFFORTS,
    access_configured: accessConfigured(c.env), database_configured: databaseConfigured(c.env), catalog: catalogStatus(c.env),
    types: typesView(c.env),
  })));

  api.get('/admin/catalog/models', operatorOnly(async c => {
    const snapshot = await loadCatalog(c.env, { wait: Infinity });
    // Rows are listed even under CATALOG_SOURCE=code, so the operator can still review them.
    const rows = databaseConfigured(c.env) ? await rpcRows(c.env, 'zerox_catalog_list', {}) : [];
    const ids = new Set(rows.map(row => row.id.toLowerCase()));
    return c.json({
      catalog: catalogStatus(c.env), access_configured: accessConfigured(c.env), markup: MARKUP,
      models: rows.map(row => modelView(row, snapshot)),
      code_only: codeCatalog().items.filter(item => !ids.has(item.id.toLowerCase())).map(item => codeOnlyView(item, snapshot)),
      warnings: snapshot.warnings,
    });
  }));

  api.get('/admin/catalog/model', operatorOnly(async c => {
    const id = modelIdOf(c.req.query('id'), 'id');
    requireDatabase(c.env);
    const snapshot = await loadCatalog(c.env, { wait: Infinity });
    const detail = await modelDetail(c.env, id);
    return c.json({
      model: modelView(listRow(detail), snapshot),
      revisions: (detail.revisions || []).map(revision => revisionView(id, revision, Date.now())),
      events: detail.events || [],
    });
  }));

  // Dry run: what the spec would be, its validation, the diff against what serves, the preview.
  api.post('/admin/catalog/validate', operatorOnly(async c => {
    const body = await readJson(c);
    const { id, spec, errors, validation } = checkApiSpec(body.spec, Date.now());
    if (!spec) throw new ApiError(400, 'invalid_request', 'spec must be a JSON object.', { param: 'spec', reasons: errors });
    const diff = id ? specDiff(baseSpec(id, await currentActiveSpec(c.env, id)), spec) : [];
    return c.json({
      ok: !errors.length && specValid(validation), id, errors, validation, diff, risky: riskyChanges(diff).map(item => item.path),
      preview: id ? previewModel(id, spec) : null,
    });
  }));

  // Stores the spec as the model's pending revision (a new model starts as a draft).
  api.post('/admin/catalog/propose', operatorOnly(async c => {
    requireDatabase(c.env);
    const body = await readJson(c);
    const { id, spec, errors, validation } = checkApiSpec(body.spec, Date.now());
    if (!spec || errors.length || !specValid(validation)) {
      throw new ApiError(400, 'invalid_request', 'The model spec does not pass the catalog guardrails; nothing was saved.',
        { param: 'spec', reasons: errors, validation });
    }
    const active = await currentActiveSpec(c.env, id);
    if (active && sameSpec(active, spec)) throw new ApiError(409, 'no_change', 'The spec equals the active revision.');
    const diff = specDiff(baseSpec(id, active), spec);
    const [row] = await rpcRows(c.env, 'zerox_catalog_propose', {
      p_spec: spec, p_actor: await actorOf(c), p_note: noteOf(body.note), p_detail: { diff }, p_source: 'operator',
    });
    return c.json({ model_id: row.model_id, revision_id: row.revision_id, revision: row.revision, status: row.status,
      diff, risky: riskyChanges(diff).map(item => item.path), validation }, 201);
  }));

  // Approves exactly the revision that was reviewed: revision_id must still be pending and
  // expected_active_revision_id must still be active. Risky changes need confirm = the model id.
  api.post('/admin/catalog/approve', operatorOnly(async c => {
    requireDatabase(c.env);
    const body = await readJson(c);
    const id = modelIdOf(body.model_id);
    const revisionId = revisionIdOf(body.revision_id ?? 0, 'revision_id');
    if (!Object.hasOwn(body, 'expected_active_revision_id')) {
      throw new ApiError(400, 'invalid_request', 'expected_active_revision_id is required (null when nothing is active).',
        { param: 'expected_active_revision_id' });
    }
    const expected = revisionIdOf(body.expected_active_revision_id, 'expected_active_revision_id');
    const detail = await modelDetail(c.env, id);
    if (detail.model.pending_revision_id !== revisionId || (detail.model.active_revision_id ?? null) !== expected) {
      throw new ApiError(409, 'stale_revision', 'The pending or active revision changed since it was reviewed; reload and review again.');
    }
    const row = listRow(detail);
    const spec = normalizeSpec(row.pending.spec);
    const validation = validateSpec(id, spec);
    if (!specValid(validation)) {
      throw new ApiError(422, 'validation_failed', 'The pending revision no longer passes the catalog guardrails.', { reasons: validation });
    }
    const diff = specDiff(baseSpec(id, row.active ? row.active.spec : null), spec);
    const risky = riskyChanges(diff);
    if (risky.length && body.confirm !== id) {
      throw new ApiError(422, 'confirmation_required', 'This change moves prices, caps, key slots, paid pools or auto ranks; send confirm with the model id.',
        { param: 'confirm', risky: risky.map(item => item.path) });
    }
    await rpcRows(c.env, 'zerox_catalog_approve', {
      p_model_id: id, p_revision_id: revisionId, p_expected_active: expected, p_actor: await actorOf(c),
      p_note: noteOf(body.note), p_detail: { diff },
    });
    const snapshot = await loadCatalog(c.env, { force: true, wait: Infinity });
    return c.json({ model: modelView(listRow(await modelDetail(c.env, id)), snapshot), catalog_version: snapshot.version,
      served_within_seconds: SERVED_WITHIN_SECONDS });
  }));

  api.post('/admin/catalog/reject', operatorOnly(async c => {
    requireDatabase(c.env);
    const body = await readJson(c);
    const id = modelIdOf(body.model_id);
    const revisionId = revisionIdOf(body.revision_id ?? 0, 'revision_id');
    await rpcRows(c.env, 'zerox_catalog_reject', { p_model_id: id, p_revision_id: revisionId, p_actor: await actorOf(c),
      p_note: noteOf(body.note) });
    const snapshot = catalogSnapshot(c.env);
    return c.json({ model: modelView(listRow(await modelDetail(c.env, id)), snapshot) });
  }));

  const setStatus = to => operatorOnly(async c => {
    requireDatabase(c.env);
    const body = await readJson(c);
    const id = modelIdOf(body.model_id);
    if (to === 'active') {
      // Enabling serves the active revision again: it must still pass the guardrails.
      const row = listRow(await modelDetail(c.env, id));
      const validation = row.active ? validateSpec(id, row.active.spec) : null;
      if (validation && validation.model.length) {
        throw new ApiError(422, 'validation_failed', 'The active revision no longer passes the catalog guardrails.', { reasons: validation });
      }
    }
    await rpcRows(c.env, 'zerox_catalog_set_status', { p_model_id: id, p_to: to, p_actor: await actorOf(c), p_note: noteOf(body.note) });
    const snapshot = await loadCatalog(c.env, { force: true, wait: Infinity });
    return c.json({ model: modelView(listRow(await modelDetail(c.env, id)), snapshot), catalog_version: snapshot.version,
      served_within_seconds: SERVED_WITHIN_SECONDS });
  });
  api.post('/admin/catalog/disable', setStatus('disabled'));
  api.post('/admin/catalog/enable', setStatus('active'));

  // The audit trail: one model's events, or the operator feed (offers and models together).
  api.get('/admin/catalog/audit', operatorOnly(async c => {
    requireDatabase(c.env);
    const limit = Math.min(Math.max(Number.parseInt(c.req.query('limit') || '100', 10) || 100, 1), 500);
    const beforeRaw = c.req.query('before');
    const before = beforeRaw && !Number.isNaN(Date.parse(beforeRaw)) ? new Date(beforeRaw).toISOString() : null;
    const id = c.req.query('id');
    const events = id
      ? await rpcRows(c.env, 'zerox_catalog_events_list', { p_id: modelIdOf(id, 'id'), p_limit: limit, p_before: before })
      : await rpcRows(c.env, 'zerox_operator_audit_list', { p_limit: limit, p_before: before });
    return c.json({ events });
  }));
}

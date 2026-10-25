// Discovery review (contract §8.4): every route needs Bearer GATEWAY_ADMIN_TOKEN, plus a valid
// Cloudflare Access JWT when Access is configured (as the catalog, key vault, offers and credits
// routes: research and credit runs spend money, verify spends provider keys), except the page
// shell, which holds no data and asks for the token. Approving a model runs one live streamed
// tool call when this deployment holds a key for its provider; promotion is a separate step that
// only proposes: it creates a draft catalog row, served once an operator approves it on
// /admin/models (src/routes/catalog-admin.js).
import { rpcRows } from '../account-store.js';
import { ApiError, errorResponse, sendApiError } from '../auth-context.js';
import { isOperator } from '../operator-auth.js';
import { MODELS_VARS, loadCatalog, resolveModelId } from '../catalog.js';
import { catalogSource } from '../catalog-db.js';
import { providerType, publicIdFor } from '../catalog-types.js';
import { proposeCandidateDraft } from './catalog-admin.js';
import { accessConfigured, passedAccess, verifyAccessJwt } from '../access-auth.js';
import { discoveryJobs, JOB_INTERVALS, researchEnabled, runDiscoveryTick } from '../discovery/jobs.js';
import { researchCap } from '../discovery/research.js';
import { verificationTarget, verifyCandidate } from '../discovery/verify.js';
import { REVIEW_PAGE } from '../discovery/review-page.js';

const STATUSES = new Set(['new', 'approved', 'verified', 'rejected', 'filtered', 'excluded']);
const CONFLICTS = ['candidate_excluded', 'candidate_not_approved', 'candidate_not_verified', 'public_model_id_taken'];
const INVALID = ['invalid_review', 'invalid_promotion', 'invalid_candidates', 'invalid_jobs'];

// Postgres exceptions raised by the discovery RPCs become 409/400 answers with their code.
function databaseFailure(error) {
  const message = String(error?.message || '');
  const conflict = CONFLICTS.find(code => message.includes(`${code}:`));
  if (conflict) return new ApiError(409, conflict, message.slice(message.indexOf(`${conflict}:`)).slice(0, 300));
  const invalid = INVALID.find(code => message.includes(`${code}:`));
  if (invalid) return new ApiError(400, 'invalid_request', message.slice(message.indexOf(`${invalid}:`)).slice(0, 300));
  return error;
}

const candidateId = value => (/^[1-9]\d{0,17}$/.test(String(value)) ? Number(value) : null);

// Whether discovered models of a provider can become catalog rows: its provider type has a free
// key slot and default limits for new models (src/catalog-types.js discovery_defaults).
const catalogType = provider => {
  const registry = providerType(provider);
  return Boolean(registry?.discovery_defaults && registry.slots.free.length);
};

// `catalog`: the catalog row promoted from this candidate (id and status), when there is one.
function publicCandidate(env, row, catalog = null) {
  const { total_count: _total, ...candidate } = row;
  return {
    ...candidate,
    filtered: row.status === 'rejected' && !row.reviewed_at,
    verifiable: Boolean(row.model_id && verificationTarget(env, row.provider)),
    catalog_template: Boolean(row.model_id && catalogType(row.provider)),
    catalog_model_id: catalog?.id ?? null,
    catalog_status: catalog?.status ?? null,
  };
}

// Catalog rows by the discovery candidate they were promoted from (none without the catalog).
async function catalogByCandidate(env) {
  try {
    const rows = await rpcRows(env, 'zerox_catalog_list', {});
    return new Map(rows.filter(row => row.candidate_id).map(row => [Number(row.candidate_id), { id: row.id, status: row.status }]));
  } catch {
    return new Map();
  }
}

async function actorOf(c) {
  if (!accessConfigured(c.env)) return 'operator';
  const identity = await verifyAccessJwt(c.env, c.req.header('Cf-Access-Jwt-Assertion')).catch(() => null);
  return String(identity?.email || identity?.sub || 'operator').slice(0, 64);
}

async function loadCandidate(env, id) {
  const [row] = await rpcRows(env, 'zerox_candidates_list', { p_id: id, p_limit: 1 });
  if (!row) throw new ApiError(404, 'not_found', 'No candidate with this id.');
  return row;
}

async function verifyAndRecord(env, row) {
  const verification = await verifyCandidate(env, row);
  const [updated] = await rpcRows(env, 'zerox_candidate_record_verification',
    { p_id: row.id, p_passed: verification.passed, p_result: verification });
  return { verification, status: updated?.status ?? row.status };
}

async function readJson(c) {
  const body = await c.req.json().catch(() => ({}));
  return body && typeof body === 'object' && !Array.isArray(body) ? body : {};
}

const note = value => (typeof value === 'string' && value.trim() ? value.trim().slice(0, 2000) : null);

export function registerDiscoveryRoutes(api) {
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

  // The review page: a static shell that calls the routes below with the token typed into it.
  api.get('/admin/discovery', c => {
    c.header('Cache-Control', 'no-store');
    return c.html(REVIEW_PAGE);
  });

  api.get('/admin/discovery/candidates', operatorOnly(async c => {
    const status = c.req.query('status') || 'new';
    if (status !== 'all' && !STATUSES.has(status)) {
      throw new ApiError(400, 'invalid_request', 'Unknown status filter.', { param: 'status' });
    }
    const limit = Math.min(Math.max(Number.parseInt(c.req.query('limit') || '100', 10) || 100, 1), 500);
    const offset = Math.max(Number.parseInt(c.req.query('offset') || '0', 10) || 0, 0);
    const [rows, overview, catalog] = await Promise.all([
      rpcRows(c.env, 'zerox_candidates_list', {
        p_status: status === 'all' ? null : status, p_provider: c.req.query('provider')?.trim().toLowerCase() || null,
        p_search: c.req.query('q')?.trim() || null, p_limit: limit, p_offset: offset,
      }),
      rpcRows(c.env, 'zerox_discovery_overview', {}),
      catalogByCandidate(c.env),
    ]);
    return c.json({
      object: 'list', data: rows.map(row => publicCandidate(c.env, row, catalog.get(Number(row.id)))),
      total: Number(rows[0]?.total_count ?? 0),
      limit, offset, overview: overview[0]?.overview ?? { counts: {}, jobs: [] },
      settings: {
        discovery_enabled: c.env.DISCOVERY_ENABLED !== 'false', catalog_source: catalogSource(c.env),
        research_enabled: researchEnabled(c.env), research_cap_usd: researchCap(c.env),
        jobs: discoveryJobs(c.env).map(job => ({ job, interval_seconds: JOB_INTERVALS[job] })),
      },
    });
  }));

  api.get('/admin/discovery/candidates/:id', operatorOnly(async c => {
    const id = candidateId(c.req.param('id'));
    if (!id) throw new ApiError(404, 'not_found', 'No candidate with this id.');
    return c.json(publicCandidate(c.env, await loadCandidate(c.env, id)));
  }));

  // Approve, then verify right away when a key for the provider is configured.
  api.post('/admin/discovery/candidates/:id/approve', operatorOnly(async c => {
    const id = candidateId(c.req.param('id'));
    if (!id) throw new ApiError(404, 'not_found', 'No candidate with this id.');
    const body = await readJson(c);
    const changed = await rpcRows(c.env, 'zerox_candidates_review', { p_ids: [id], p_action: 'approve', p_note: note(body.note) });
    const row = await loadCandidate(c.env, id);
    if (!changed.length) {
      throw new ApiError(409, 'invalid_transition', `A ${row.status} candidate cannot be approved${row.status === 'verified' ? '; verify it again instead' : ''}.`);
    }
    if (!row.model_id || !verificationTarget(c.env, row.provider)) {
      return c.json({ candidate: publicCandidate(c.env, row), verification: null,
        message: row.model_id ? 'Approved. No key is configured for this provider, so it was not verified; signing up stays manual.'
          : 'Provider approved. Signing up stays manual; its models are reviewed one by one.' });
    }
    const { verification } = await verifyAndRecord(c.env, row);
    return c.json({ candidate: publicCandidate(c.env, await loadCandidate(c.env, id)), verification });
  }));

  api.post('/admin/discovery/candidates/:id/verify', operatorOnly(async c => {
    const id = candidateId(c.req.param('id'));
    if (!id) throw new ApiError(404, 'not_found', 'No candidate with this id.');
    const row = await loadCandidate(c.env, id);
    if (!['approved', 'verified'].includes(row.status) || !row.model_id) {
      throw new ApiError(409, 'candidate_not_approved', 'Only approved or verified models can be verified.');
    }
    if (!verificationTarget(c.env, row.provider)) {
      throw new ApiError(409, 'no_key', `No key is configured for ${row.provider}; signing up stays manual.`);
    }
    const { verification } = await verifyAndRecord(c.env, row);
    return c.json({ candidate: publicCandidate(c.env, await loadCandidate(c.env, id)), verification });
  }));

  api.post('/admin/discovery/candidates/reject', operatorOnly(async c => {
    const body = await readJson(c);
    const ids = Array.isArray(body.ids) ? [...new Set(body.ids.map(candidateId).filter(Boolean))] : [];
    if (!ids.length || ids.length > 200) throw new ApiError(400, 'invalid_request', 'Provide 1 to 200 candidate ids.', { param: 'ids' });
    const changed = await rpcRows(c.env, 'zerox_candidates_review', { p_ids: ids, p_action: 'reject', p_note: note(body.note) });
    return c.json({ rejected: changed.map(row => row.id) });
  }));

  api.post('/admin/discovery/candidates/:id/reject', operatorOnly(async c => {
    const id = candidateId(c.req.param('id'));
    if (!id) throw new ApiError(404, 'not_found', 'No candidate with this id.');
    const body = await readJson(c);
    const changed = await rpcRows(c.env, 'zerox_candidates_review', { p_ids: [id], p_action: 'reject', p_note: note(body.note) });
    const row = await loadCandidate(c.env, id);
    if (!changed.length) throw new ApiError(409, 'invalid_transition', `A ${row.status} candidate cannot be rejected.`);
    return c.json({ candidate: publicCandidate(c.env, row) });
  }));

  // Verified model -> a draft catalog row (source discovery) with its provider type's free pool and
  // default limits. Nothing serves until an operator reviews and approves it on /admin/models.
  api.post('/admin/discovery/candidates/:id/promote', operatorOnly(async c => {
    const id = candidateId(c.req.param('id'));
    if (!id) throw new ApiError(404, 'not_found', 'No candidate with this id.');
    const body = await readJson(c);
    const row = await loadCandidate(c.env, id);
    if (!row.model_id) throw new ApiError(409, 'invalid_transition', 'Provider records cannot join the catalog.');
    if (!catalogType(row.provider)) {
      throw new ApiError(409, 'no_catalog_template', `${row.provider} has no catalog provider type for discovered models (src/catalog-types.js); add the model to the code catalog instead.`);
    }
    if (row.status !== 'verified') throw new ApiError(409, 'candidate_not_verified', 'Only verified models can be promoted.');
    const publicId = publicIdFor(row.provider, row.model_id);
    if (!publicId) throw new ApiError(409, 'invalid_model_id', 'The model id is not a valid upstream id for its provider.');
    // Ids and aliases the catalog already serves are never shadowed by a discovered model.
    await loadCatalog(c.env);
    if (resolveModelId(publicId, c.env)) {
      throw new ApiError(409, 'already_in_catalog', `${publicId} is already in the catalog.`);
    }
    for (const [name, value] of [['context_window', body.context_window], ['max_output_tokens', body.max_output_tokens]]) {
      if (value !== undefined && (!Number.isSafeInteger(Number(value)) || Number(value) < 1)) {
        throw new ApiError(400, 'invalid_request', `${name} must be a positive integer.`, { param: name });
      }
    }
    const contextWindow = Number(body.context_window ?? row.context_window);
    if (!Number.isSafeInteger(contextWindow) || contextWindow < 1) {
      throw new ApiError(400, 'invalid_request', 'The context window is unknown; send context_window.', { param: 'context_window' });
    }
    const draft = await proposeCandidateDraft(c.env, row, {
      context_window: body.context_window, max_output_tokens: body.max_output_tokens,
      display_name: typeof body.display_name === 'string' ? body.display_name : undefined,
    }, await actorOf(c));
    const registry = providerType(row.provider);
    const narrowing = c.env[MODELS_VARS[row.provider]];
    const listed = narrowing === undefined || String(narrowing).split(',').map(item => item.trim().toLowerCase())
      .some(item => item === publicId.toLowerCase() || item === row.model_id.toLowerCase());
    const notes = [`Saved as a draft catalog row: review and approve ${draft.model_id} on /admin/models to serve it.`];
    if (catalogSource(c.env) === 'code') notes.push('CATALOG_SOURCE is "code": approved catalog rows are not served until it is removed.');
    if (!listed) notes.push(`${MODELS_VARS[row.provider]} narrows this provider and does not list ${row.model_id}.`);
    if (registry.hosted_flag && c.env[registry.hosted_flag] !== 'true') notes.push(`${registry.hosted_flag} is not "true".`);
    return c.json({ promoted: { public_model_id: draft.model_id, status: draft.status, revision_id: draft.revision_id },
      admin_url: draft.admin_url, served_within_seconds: null, notes });
  }));

  // Disables the candidate's legacy gateway_provider_models row (promotions from before the
  // data-driven catalog). That row is never served (CATALOG_DB_MODELS is no longer read), so this
  // removes nothing from the catalog. A candidate that has a catalog row (promoted as a draft, or
  // imported by migration 20261025000100) is managed on /admin/models, behind the operator token
  // and Cloudflare Access: demoting here would leave that row serving, so it is refused.
  api.post('/admin/discovery/candidates/:id/demote', operatorOnly(async c => {
    const id = candidateId(c.req.param('id'));
    if (!id) throw new ApiError(404, 'not_found', 'No candidate with this id.');
    // Not catalogByCandidate: when the catalog cannot be read, this fails instead of guessing.
    const catalog = (await rpcRows(c.env, 'zerox_catalog_list', {})).find(row => Number(row.candidate_id) === id);
    if (catalog) {
      const adminUrl = `/admin/models?id=${encodeURIComponent(catalog.id)}`;
      throw new ApiError(409, 'catalog_managed',
        `${catalog.id} is a catalog row (${catalog.status}); disable it on /admin/models instead.`, { admin_url: adminUrl });
    }
    const rows = await rpcRows(c.env, 'zerox_candidate_demote', { p_id: id });
    return c.json({ demoted: rows.map(row => row.public_model_id), served: false,
      note: 'The legacy discovery row was disabled. It was not served: promoted models are catalog rows now.' });
  }));

  // Runs jobs now (default: every list). Research spends money, so it only runs when named.
  api.post('/admin/discovery/run', operatorOnly(async c => {
    const body = await readJson(c);
    const jobs = Array.isArray(body.jobs) ? body.jobs.filter(job => typeof job === 'string') : null;
    const known = discoveryJobs(c.env);
    const wanted = jobs?.length ? jobs : known.filter(job => job.startsWith('list:'));
    const unknown = wanted.filter(job => !known.includes(job));
    if (unknown.length) throw new ApiError(400, 'invalid_request', `Unknown or disabled jobs: ${unknown.join(', ').slice(0, 200)}`, { param: 'jobs' });
    return c.json(await runDiscoveryTick(c.env, { force: true, jobs: wanted }));
  }));
}

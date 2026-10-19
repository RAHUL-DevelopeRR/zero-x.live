// Discovery review (contract §8.4): every route needs Bearer GATEWAY_ADMIN_TOKEN except the page
// shell, which holds no data and asks for the token. Approving a model runs one live streamed
// tool call when this deployment holds a key for its provider; promotion is a separate step.
import { rpcRows } from '../account-store.js';
import { ApiError, errorResponse, sendApiError } from '../auth-context.js';
import { isOperator } from '../operator-auth.js';
import { DB_MODEL_TEMPLATES, MODELS_VARS, dbModelsEnabled, resolveModelId } from '../catalog.js';
import { discoveryJobs, JOB_INTERVALS, runDiscoveryTick } from '../discovery/jobs.js';
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

function publicCandidate(env, row) {
  const { total_count: _total, ...candidate } = row;
  return {
    ...candidate,
    filtered: row.status === 'rejected' && !row.reviewed_at,
    verifiable: Boolean(row.model_id && verificationTarget(env, row.provider)),
    catalog_template: Boolean(row.model_id && DB_MODEL_TEMPLATES[row.provider]),
  };
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
    const [rows, overview] = await Promise.all([
      rpcRows(c.env, 'zerox_candidates_list', {
        p_status: status === 'all' ? null : status, p_provider: c.req.query('provider')?.trim().toLowerCase() || null,
        p_search: c.req.query('q')?.trim() || null, p_limit: limit, p_offset: offset,
      }),
      rpcRows(c.env, 'zerox_discovery_overview', {}),
    ]);
    return c.json({
      object: 'list', data: rows.map(row => publicCandidate(c.env, row)), total: Number(rows[0]?.total_count ?? 0),
      limit, offset, overview: overview[0]?.overview ?? { counts: {}, jobs: [] },
      settings: {
        discovery_enabled: c.env.DISCOVERY_ENABLED !== 'false', catalog_db_models: dbModelsEnabled(c.env),
        research_enabled: Boolean(c.env.ANTHROPIC_API_KEY), research_cap_usd: researchCap(c.env),
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

  // Verified model → gateway_provider_models through its provider's catalog template.
  api.post('/admin/discovery/candidates/:id/promote', operatorOnly(async c => {
    const id = candidateId(c.req.param('id'));
    if (!id) throw new ApiError(404, 'not_found', 'No candidate with this id.');
    const body = await readJson(c);
    const row = await loadCandidate(c.env, id);
    const template = DB_MODEL_TEMPLATES[row.provider];
    if (!row.model_id) throw new ApiError(409, 'invalid_transition', 'Provider records cannot join the catalog.');
    if (!template) {
      throw new ApiError(409, 'no_catalog_template', `${row.provider} has no catalog template (src/catalog.js DB_MODEL_TEMPLATES); add the model to the code catalog instead.`);
    }
    const publicId = template.publicId(row.model_id);
    // Without env, resolution only sees code-defined ids and aliases.
    if (resolveModelId(publicId)) {
      throw new ApiError(409, 'already_in_catalog', `${publicId} is already in the code-defined catalog.`);
    }
    const contextWindow = Number(body.context_window ?? row.context_window);
    if (!Number.isSafeInteger(contextWindow) || contextWindow < 1) {
      throw new ApiError(400, 'invalid_request', 'The context window is unknown; send context_window.', { param: 'context_window' });
    }
    const maxOutput = Number(body.max_output_tokens ?? row.max_output_tokens ?? Math.min(16384, contextWindow));
    if (!Number.isSafeInteger(maxOutput) || maxOutput < 1 || maxOutput > contextWindow) {
      throw new ApiError(400, 'invalid_request', 'max_output_tokens must be between 1 and the context window.', { param: 'max_output_tokens' });
    }
    const [promoted] = await rpcRows(c.env, 'zerox_candidate_promote', {
      p_id: id, p_public_model_id: publicId, p_provider_id: row.provider, p_provider_model_id: row.model_id,
      p_display_name: typeof body.display_name === 'string' ? body.display_name.slice(0, 200) : row.display_name,
      p_context_window: contextWindow, p_max_output_tokens: maxOutput, p_supports_vision: row.supports_vision === true,
    });
    const narrowing = c.env[MODELS_VARS[row.provider]];
    const listed = narrowing === undefined || String(narrowing).split(',').map(item => item.trim().toLowerCase())
      .some(item => item === publicId.toLowerCase() || item === row.model_id.toLowerCase());
    const notes = [];
    if (!dbModelsEnabled(c.env)) notes.push('CATALOG_DB_MODELS is not "true": promoted models are not served yet.');
    if (!listed) notes.push(`${MODELS_VARS[row.provider]} narrows this provider and does not list ${row.model_id}.`);
    if (template.hosted_flag && c.env[template.hosted_flag] !== 'true') notes.push(`${template.hosted_flag} is not "true".`);
    return c.json({ promoted, served_within_seconds: notes.length ? null : 60, notes });
  }));

  api.post('/admin/discovery/candidates/:id/demote', operatorOnly(async c => {
    const id = candidateId(c.req.param('id'));
    if (!id) throw new ApiError(404, 'not_found', 'No candidate with this id.');
    const rows = await rpcRows(c.env, 'zerox_candidate_demote', { p_id: id });
    return c.json({ demoted: rows.map(row => row.public_model_id) });
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

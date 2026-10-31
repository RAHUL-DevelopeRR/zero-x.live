// Free cloud and AI credit programs (docs/PLATFORM_CONTRACT.md §12.6). Operator only: Bearer
// GATEWAY_ADMIN_TOKEN, plus a valid Cloudflare Access JWT when CF_ACCESS_* is configured. The
// weekly `credits` discovery job fills the list; the operator reviews each program, applies
// outside the gateway and records the outcome here. Every move is audited
// (zerox_credit_program_events).
import { rpcRows } from '../account-store.js';
import { ApiError, errorResponse, sendApiError } from '../auth-context.js';
import { isOperator } from '../operator-auth.js';
import { accessConfigured, passedAccess, verifyAccessJwt } from '../access-auth.js';
import { CREDIT_KINDS, CREDIT_TRANSITIONS, CREDIT_USES, creditNextStep, GPU_ACCESS } from '../discovery/credits.js';
import { httpsUrl } from '../discovery/policy.js';

const PROGRAM_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const STATUSES = new Set(Object.keys(CREDIT_TRANSITIONS));
const MAX_BODY_BYTES = 32768;

function databaseFailure(error) {
  const message = String(error?.message || '');
  if (message.includes('program_not_found')) return new ApiError(404, 'not_found', 'No credit program with this id.');
  const transition = message.match(/invalid_transition: [a-z_]+ -> [a-z_]+/);
  if (transition) return new ApiError(409, 'invalid_transition', transition[0]);
  const invalid = message.indexOf('invalid_credits:');
  if (invalid >= 0) return new ApiError(400, 'invalid_request', message.slice(invalid).slice(0, 300));
  if (/violates (check|not-null) constraint|invalid input syntax/.test(message)) {
    return new ApiError(400, 'invalid_request', 'The credit program facts are not valid.');
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

function programId(c) {
  const id = c.req.param('id');
  if (!PROGRAM_ID.test(id || '')) throw new ApiError(404, 'not_found', 'No credit program with this id.');
  return id;
}

const publicProgram = program => ({ ...program, next_states: CREDIT_TRANSITIONS[program.status] || [], next_step: creditNextStep(program) });

// The facts an operator may set when adding or correcting a program by hand.
function programFacts(id, body) {
  const text = (value, max) => (value === undefined ? undefined : typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);
  const flag = value => (value === undefined ? undefined : typeof value === 'boolean' ? value : null);
  const facts = {
    id, vendor: text(body.vendor, 120), name: text(body.name, 200),
    kind: body.kind === undefined ? undefined : CREDIT_KINDS.includes(body.kind) ? body.kind : 'invalid',
    url: body.url === undefined ? undefined : httpsUrl(body.url) || 'invalid',
    amount_usd: body.amount_usd === undefined ? undefined : body.amount_usd,
    amount_text: text(body.amount_text, 300), validity_days: body.validity_days,
    self_serve: flag(body.self_serve), requires_funding: flag(body.requires_funding), requires_card: flag(body.requires_card),
    india_eligible: flag(body.india_eligible),
    usable_for: body.usable_for === undefined ? undefined : Array.isArray(body.usable_for) ? body.usable_for : 'invalid',
    gpu_access: body.gpu_access === undefined ? undefined : GPU_ACCESS.includes(body.gpu_access) ? body.gpu_access : 'invalid',
    eligibility: text(body.eligibility, 1000), notes: text(body.notes, 2000),
  };
  if ([facts.kind, facts.url, facts.usable_for, facts.gpu_access].includes('invalid') ||
      (Array.isArray(facts.usable_for) && facts.usable_for.some(use => !CREDIT_USES.includes(use))) ||
      (facts.amount_usd !== undefined && facts.amount_usd !== null && !(Number.isFinite(facts.amount_usd) && facts.amount_usd >= 0)) ||
      (facts.validity_days !== undefined && facts.validity_days !== null && !Number.isSafeInteger(facts.validity_days))) {
    throw new ApiError(400, 'invalid_request', 'kind, url (https), usable_for, gpu_access, amount_usd or validity_days is not valid.');
  }
  return Object.fromEntries(Object.entries(facts).filter(([, value]) => value !== undefined));
}

export function registerCreditRoutes(api) {
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

  api.get('/admin/credits', operatorOnly(async c => {
    const status = c.req.query('status') || null;
    if (status && !STATUSES.has(status)) throw new ApiError(400, 'invalid_request', 'Unknown status.', { param: 'status' });
    const programs = (await rpcRows(c.env, 'zerox_credit_programs_list', status ? { p_status: status } : {})).map(publicProgram);
    const granted = programs.filter(program => program.status === 'granted');
    return c.json({
      programs,
      totals: {
        granted_usd: granted.reduce((sum, program) => sum + Number(program.granted_usd || 0), 0),
        to_review: programs.filter(program => program.status === 'new').length,
        self_serve_unclaimed_usd: programs.filter(program => ['new', 'approved'].includes(program.status) && program.self_serve === true)
          .reduce((sum, program) => sum + Number(program.amount_usd || 0), 0),
      },
    });
  }));

  api.get('/admin/credits/:id', operatorOnly(async c => {
    const id = programId(c);
    const [program] = (await rpcRows(c.env, 'zerox_credit_programs_list', {})).filter(row => row.id === id);
    if (!program) throw new ApiError(404, 'not_found', 'No credit program with this id.');
    const events = await rpcRows(c.env, 'zerox_credit_program_events_list', { p_id: id, p_limit: 50 });
    return c.json({ program: publicProgram(program), events });
  }));

  // Adds a program the operator found, or corrects one (facts only; the status moves below).
  api.put('/admin/credits/:id', operatorOnly(async c => {
    const id = programId(c);
    const facts = programFacts(id, await readJson(c));
    const [row] = await rpcRows(c.env, 'zerox_credit_programs_upsert', { p_rows: [facts], p_source: 'operator', p_actor: await actorOf(c) });
    const [program] = (await rpcRows(c.env, 'zerox_credit_programs_list', {})).filter(item => item.id === row.id);
    return c.json({ program: publicProgram(program) });
  }));

  // { to, note, granted_usd, expires_at } - granted_usd and expires_at only when `to` is granted.
  api.post('/admin/credits/:id/transition', operatorOnly(async c => {
    const id = programId(c);
    const body = await readJson(c);
    if (!STATUSES.has(body.to)) throw new ApiError(400, 'invalid_request', 'to must be a credit program status.', { param: 'to' });
    const granted = body.to === 'granted';
    const amount = granted && body.granted_usd !== undefined && body.granted_usd !== null ? Number(body.granted_usd) : null;
    if (amount !== null && !(Number.isFinite(amount) && amount >= 0)) throw new ApiError(400, 'invalid_request', 'granted_usd must be a number.');
    const expires = granted && body.expires_at ? new Date(body.expires_at) : null;
    if (expires && Number.isNaN(expires.getTime())) throw new ApiError(400, 'invalid_request', 'expires_at must be a date.');
    const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 2000) : null;
    const [program] = await rpcRows(c.env, 'zerox_credit_program_transition', { p_id: id, p_to: body.to, p_actor: await actorOf(c),
      p_note: note, p_granted_usd: amount, p_expires_at: expires ? expires.toISOString() : null });
    return c.json({ program: publicProgram(program) });
  }));
}

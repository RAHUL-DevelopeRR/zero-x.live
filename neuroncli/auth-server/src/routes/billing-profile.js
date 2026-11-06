import { rpc, rpcRows } from '../account-store.js';
import { ApiError, INTERACTIVE_CREDENTIALS, withCaller } from '../auth-context.js';
import { documentPublic, documentVersions, requiredDocuments } from '../billing/legal-versions.js';
import {
  checkStoredProfile, normalizeProfile, PROFILE_FIELDS, profileOptions, publicProfile, razorpayPrefill,
} from '../billing/profile.js';
import { isoTime } from './account.js';

// GET/PUT /api/billing/profile (the details a buyer gives before Razorpay opens) and the gate
// checkout and top-up pass through: a complete saved profile and the current versions of the
// documents the purchase needs agreement to (src/billing/legal-versions.js). Same credentials as
// the other billing routes: an interactive web or CLI session, never an API key.

const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
const DOCUMENT_NAMES = { terms: 'Terms of Service', privacy: 'Privacy Policy', refund: 'Cancellation and Refund Policy', auto_renewal: 'renewal notice' };

// "No GST charged" is shown at checkout only when the owner has confirmed it (the CA has said
// Zero-X is not registered): BILLING_NO_GST_NOTICE=true. Off, the pages say nothing about GST.
const noGstNotice = env => String(env?.BILLING_NO_GST_NOTICE ?? '').trim().toLowerCase() === 'true';

const storedConsents = async (env, userId) => (await rpcRows(env, 'zerox_billing_consents_latest', { p_user_id: userId }))
  .filter(entry => typeof entry?.document === 'string' && typeof entry?.version === 'string');

function acceptedView(rows) {
  const current = documentVersions();
  return Object.fromEntries(rows.map(entry => [entry.document, {
    version: entry.version, accepted_at: isoTime(entry.accepted_at), current: current[entry.document] === entry.version,
  }]));
}

async function getProfile(c, caller) {
  const [row, consents] = await Promise.all([
    rpc(c.env, 'zerox_billing_profile_get', { p_user_id: caller.user_id }), storedConsents(c.env, caller.user_id),
  ]);
  const checked = checkStoredProfile(row);
  return c.json({
    profile: publicProfile(row),
    complete: checked.ok,
    missing: checked.ok ? [] : checked.missing,
    documents: documentPublic(),
    accepted: acceptedView(consents),
    tax: { no_gst_notice: noGstNotice(c.env) },
    options: profileOptions(),
  });
}

// Eleven fields of at most 120 characters: far below this, so anything larger is not a billing profile.
const MAX_PROFILE_BYTES = 16 * 1024;

async function putProfile(c, caller) {
  if (Number(c.req.header('content-length') || 0) > MAX_PROFILE_BYTES) throw new ApiError(413, 'invalid_request', 'The billing details are too large.');
  const raw = await c.req.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_PROFILE_BYTES) throw new ApiError(413, 'invalid_request', 'The billing details are too large.');
  let body = null;
  try { body = JSON.parse(raw); } catch { body = null; }
  if (!object(body)) throw new ApiError(400, 'invalid_request', 'Send a JSON object body.');
  const result = normalizeProfile(body);
  if (!result.ok) {
    const first = PROFILE_FIELDS.find(field => result.errors[field]) || Object.keys(result.errors)[0];
    throw new ApiError(400, 'invalid_request', result.errors[first], { param: first === '_' ? null : first, fields: result.errors });
  }
  // No tax id: the key is left out (the upsert clears an absent one all the same), so a profile
  // without one still saves on a database that does not have 20261105000200_billing_tax_id.sql yet.
  const { tax_id: taxId, ...withoutTaxId } = result.value;
  const row = await rpc(c.env, 'zerox_billing_profile_upsert', { p_user_id: caller.user_id, p_profile: taxId ? result.value : withoutTaxId });
  return c.json({ profile: publicProfile(row), complete: true, missing: [] });
}

/**
 * The gate for POST /api/billing/checkout (kind 'subscription') and /topup (kind 'topup'): a
 * complete saved profile (409 billing_profile_required, with the fields missing) and, for each
 * document the purchase needs, either the current version submitted in body.consent or an earlier
 * agreement to the current version (409 consent_required, with the current versions). The
 * renewal notice is never satisfied by an earlier agreement: it is about this purchase.
 *
 * Returns what the caller needs once Razorpay may open: the Razorpay prefill (name, e-mail and
 * phone only) and recordConsents(), which appends the agreements made in this request. Nothing
 * else of the profile leaves Zero-X.
 */
export async function requireBillingDetails(env, caller, kind, body) {
  const [row, consents] = await Promise.all([
    rpc(env, 'zerox_billing_profile_get', { p_user_id: caller.user_id }), storedConsents(env, caller.user_id),
  ]);
  const checked = checkStoredProfile(row);
  if (!checked.ok) {
    throw new ApiError(409, 'billing_profile_required', 'Add your billing details before you pay.', { missing: checked.missing });
  }
  const submitted = object(body?.consent) || {};
  const current = documentVersions();
  const earlier = new Map(consents.map(entry => [entry.document, entry.version]));
  const fresh = {};
  const missing = [];
  for (const document of requiredDocuments(kind)) {
    if (submitted[document] === current[document]) fresh[document] = current[document];
    else if (document !== 'auto_renewal' && earlier.get(document) === current[document]) continue;
    else missing.push(document);
  }
  if (missing.length) {
    throw new ApiError(409, 'consent_required',
      `Accept the current ${missing.map(document => DOCUMENT_NAMES[document]).join(', ')} to continue.`, { missing, documents: current });
  }
  return {
    profile: checked.value,
    prefill: razorpayPrefill(checked.profile, caller.email),
    recordConsents: () => Object.keys(fresh).length
      ? rpc(env, 'zerox_billing_record_consents', { p_user_id: caller.user_id, p_context: kind, p_consents: fresh })
      : null,
  };
}

export function registerBillingProfileRoutes(api) {
  api.get('/api/billing/profile', withCaller(INTERACTIVE_CREDENTIALS, getProfile));
  api.put('/api/billing/profile', withCaller(INTERACTIVE_CREDENTIALS, putProfile));
}

// Billing details step: the dialog a buyer sees between "Upgrade" or "Add credit" and Razorpay's
// payment window (pricing.js and dashboard.js both use it). First purchase: name, country, state,
// city, postal code (address lines, phone and business name optional) and the boxes to tick.
// Later purchases: a one-click review of the saved details, with ticks only for what is new.
// Contract: neuroncli/auth-server/docs/PLATFORM_CONTRACT.md section 3.5, GET/PUT /api/billing/profile.
//
// Only contact and address details, and an optional tax id (a GSTIN in India, a VAT or tax ID
// elsewhere; since 2026-11-04), are asked for here. Zero-X is not registered for GST: the tax id is
// kept with the billing details for Zero-X's billing records and never sent to Razorpay. Card, UPI and bank details are typed
// into Razorpay's own window and never reach Zero-X. Every value that comes back from the API is
// treated as untrusted data (textContent only), and details are held in memory only: nothing is
// written to browser storage.
import { ApiError, apiFetch, describeError, normalizeCurrency, siteUrl } from './billing-checkout.js';

export const PROFILE_PATH = '/api/billing/profile';
// The server refuses a checkout or top-up without a complete profile or the current documents'
// agreement; the step then reopens once with fresh data (a document changed while the dialog was open).
export const DETAILS_RETRY_CODES = Object.freeze(['billing_profile_required', 'consent_required']);

/** The documents a purchase needs agreement to, in the order the boxes are shown. */
export const requiredDocuments = kind => kind === 'subscription'
  ? ['terms', 'privacy', 'auto_renewal', 'refund']
  : ['terms', 'privacy', 'refund'];

export const DOCUMENT_NAMES = Object.freeze({
  terms: 'Terms of Service', privacy: 'Privacy Policy', refund: 'Cancellation and Refund Policy', auto_renewal: 'renewal notice',
});

const DEFAULT_PATHS = Object.freeze({ terms: '/terms', privacy: '/privacy', refund: '/refund', auto_renewal: '/terms#billing' });

/** What each box says, as [text before the link, link label, text after]; subscriptions only for auto_renewal. */
export function consentText(document, { planName = 'plan', price = '' } = {}) {
  if (document === 'terms') return ['I have read and agree to the ', 'Terms of Service', '.'];
  if (document === 'privacy') return ['I have read the ', 'Privacy Policy', ', including how Zero-X uses my billing details.'];
  if (document === 'refund') return ['I have read the ', 'Cancellation and Refund Policy', '.'];
  return [`I understand that the ${planName} plan renews every month at ${price} until I cancel, and I authorise Razorpay to charge my payment method each month. I can cancel any time from Billing in my dashboard; my plan stays active until the end of the period I have paid for. `,
    'Billing and renewal terms', '.'];
}

export const RENEWAL_NOTICE = 'Your subscription renews monthly until you cancel. Cancel any time in Billing in your dashboard. Your bank or Razorpay may notify you before each charge.';
export const ONE_TIME_NOTICE = 'This is a one-time payment. It does not renew.';
export const PROCESSOR_NOTICE = 'Payments are processed by Razorpay. Zero-X never sees your card details.';
export const DATA_NOTICE = 'Zero-X keeps these details with your account for billing records and support. Razorpay receives only your name, e-mail address and phone number, to fill in its payment window.';
// Next to the optional tax id field. Zero-X is not registered for GST; nothing more is claimed about tax.
export const TAX_ID_HINT = "Optional. Zero-X keeps it with your billing details for its billing records; it is not sent to Razorpay and does not appear on Razorpay's receipt. Zero-X is not registered for GST, so no GST is charged and no GST invoice is issued.";

/* ───────────── Pure helpers (unit-tested in check-pages.mjs) ───────────── */

const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
const string = (value, max = 200) => typeof value === 'string' ? value.slice(0, max) : '';
const FIELD_KEYS = ['customer_type', 'full_name', 'business_name', 'country', 'state', 'city', 'postal_code', 'address_line1', 'address_line2', 'tax_id', 'phone'];
const FIELD_LABELS = Object.freeze({
  full_name: 'Full name', business_name: 'Business name', country: 'Country', state: 'State', city: 'City', postal_code: 'Postal code',
  address_line1: 'Address line 1', address_line2: 'Address line 2', tax_id: 'GSTIN or tax ID', phone: 'Phone number',
});

/** The tax id field's label: a GSTIN in India, a VAT or tax ID elsewhere. */
export const taxIdLabel = country => country === 'IN' ? 'GSTIN' : 'VAT or tax ID';

// The server's tax id rule and messages (src/billing/profile.js taxIdError); check-billing-profile.mjs
// keeps the two equal for every country and Indian state.
export const GST_STATE_CODES = Object.freeze({
  JK: ['01'], HP: ['02'], PB: ['03'], CH: ['04'], UT: ['05'], HR: ['06'], DL: ['07'], RJ: ['08'], UP: ['09'], BR: ['10'], SK: ['11'],
  AR: ['12'], NL: ['13'], MN: ['14'], MZ: ['15'], TR: ['16'], ML: ['17'], AS: ['18'], WB: ['19'], JH: ['20'], OD: ['21'], CT: ['22'],
  MP: ['23'], GJ: ['24'], DH: ['26', '25'], MH: ['27'], KA: ['29'], GA: ['30'], LD: ['31'], KL: ['32'], TN: ['33'], PY: ['34'],
  AN: ['35'], TG: ['36'], AP: ['37'], LA: ['38'],
});
const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const OTHER_TAX_ID = /^[A-Z0-9][A-Z0-9-]{0,18}[A-Z0-9]$/;
const GSTIN_CHARACTERS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
// The server's cleaning of typed text: control characters become spaces; invisible and bidirectional override characters go.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
const cleanText = value => string(value, 200).normalize('NFC').replace(CONTROL, ' ').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();

/** A tax id as the server stores it: spaces removed, upper case ('' when nothing was given). */
export function normalizeTaxId(raw) {
  return cleanText(raw).replace(/\s+/g, '').toUpperCase();
}

/** The GSTIN check character (the 15th) for its first 14 characters: the GSTN's mod-36 rule. */
export function gstinCheckCharacter(first14) {
  let sum = 0;
  for (let index = 0; index < 14; index++) {
    const product = GSTIN_CHARACTERS.indexOf(first14[index]) * (index % 2 ? 2 : 1);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GSTIN_CHARACTERS[(36 - (sum % 36)) % 36];
}

/** Why a normalised tax id is refused for this country and state code, or '' (also for an empty one). */
export function taxIdError(value, country, state = '', stateName = '') {
  if (!value) return '';
  if (country !== 'IN') return OTHER_TAX_ID.test(value) ? '' : 'Enter a VAT or tax ID of 2 to 20 letters, digits or hyphens.';
  if (value.length !== 15) return 'A GSTIN has 15 letters and digits.';
  if (!GSTIN.test(value)) return 'Enter a valid GSTIN: a 2 digit state code, the 10 character PAN, then 3 more characters.';
  if (gstinCheckCharacter(value) !== value[14]) return 'This GSTIN\'s last character does not match the rest. Check it for a typo.';
  const codes = Object.prototype.hasOwnProperty.call(GST_STATE_CODES, state) ? GST_STATE_CODES[state] : null;
  if (codes && !codes.includes(value.slice(0, 2))) {
    return `This GSTIN starts with ${value.slice(0, 2)}, but the GST state code of ${stateName || state} is ${codes[0]}. Check the GSTIN or the state.`;
  }
  return '';
}

/** The fields that must be filled in (the server's rule: src/billing/profile.js requiredFields). */
export function requiredFields(country, customerType, noPostal = []) {
  const fields = ['full_name', 'country'];
  if (customerType === 'business') fields.push('business_name');
  if (country === 'IN') fields.push('state');
  fields.push('city');
  if (!noPostal.includes(country)) fields.push('postal_code');
  if (customerType === 'business') fields.push('address_line1');
  return fields;
}

const REQUIRED_MESSAGES = Object.freeze({
  full_name: 'Enter your full name.', country: 'Choose your country.', business_name: 'Enter the business name.',
  state: 'Choose your state or union territory.', city: 'Enter your city.', postal_code: 'Enter your postal code.',
  address_line1: 'Enter the business address.',
});

/** Form values as strings, from a saved profile (or empty). Never keeps unknown keys. */
export function valuesFromProfile(profile) {
  const source = object(profile) || {};
  const values = Object.fromEntries(FIELD_KEYS.map(key => [key, string(source[key], 200)]));
  values.customer_type = source.customer_type === 'business' ? 'business' : 'individual';
  return values;
}

/**
 * Quick checks before anything is sent: the required fields and the optional tax id, with the
 * server's rules and messages. The server checks the rest and says what is wrong. `states` (the
 * server's lists) names the state in a GSTIN state-code message and enables that check.
 */
export function validateDetails(values, { noPostal = [], states = {} } = {}) {
  const errors = {};
  const type = values && values.customer_type === 'business' ? 'business' : 'individual';
  const country = string(values && values.country, 2).toUpperCase();
  for (const field of requiredFields(country, type, noPostal)) {
    if (!string(values && values[field], 200).trim()) errors[field] = REQUIRED_MESSAGES[field];
  }
  if (string(values && values.address_line2, 200).trim() && !string(values && values.address_line1, 200).trim()) {
    errors.address_line1 ||= 'Enter address line 1 before address line 2.';
  }
  const typed = cleanText(values && values.tax_id);
  if (Array.from(typed).length > 40) errors.tax_id = 'GSTIN or tax ID must be at most 40 characters.';
  else if (typed) {
    const state = string(values && values.state, 80);
    const named = (Array.isArray(states[country]) ? states[country] : []).find(entry => entry && entry.code === state);
    const message = taxIdError(normalizeTaxId(typed), country, named ? state : '', named ? named.name : '');
    if (message) errors.tax_id = message;
  }
  return errors;
}

/** The PUT body: every non-empty value, trimmed (a PUT replaces the profile, so blanks are simply left out). */
export function profilePayload(values) {
  const body = { customer_type: values && values.customer_type === 'business' ? 'business' : 'individual' };
  for (const key of FIELD_KEYS) {
    if (key === 'customer_type') continue;
    const value = string(values && values[key], 200).trim();
    if (value) body[key] = value;
  }
  return body;
}

/** Validates GET /api/billing/profile. Anything unusable becomes an empty/safe value. */
export function parseDetailsResponse(data) {
  const source = object(data) || {};
  const options = object(source.options) || {};
  const pair = list => (Array.isArray(list) ? list : []).map(entry => ({ code: string(entry && entry.code, 8), name: string(entry && entry.name, 80) }))
    .filter(entry => entry.code && entry.name);
  const documents = {};
  for (const name of Object.keys(DOCUMENT_NAMES)) {
    const entry = object(source.documents && source.documents[name]);
    if (entry && /^\d{4}-\d{2}-\d{2}$/.test(entry.version || '')) documents[name] = { version: entry.version, path: /^\/[a-z#/-]{1,40}$/.test(entry.path || '') ? entry.path : '/' + name };
  }
  const accepted = {};
  for (const name of Object.keys(DOCUMENT_NAMES)) {
    const entry = object(source.accepted && source.accepted[name]);
    if (entry && typeof entry.version === 'string') accepted[name] = { version: entry.version, at: string(entry.accepted_at, 40), current: entry.current === true };
  }
  const states = {};
  for (const [country, list] of Object.entries(object(options.states) || {})) if (/^[A-Z]{2}$/.test(country)) states[country] = pair(list);
  const profile = object(source.profile) ? valuesFromProfile(source.profile) : null;
  return {
    profile,
    complete: source.complete === true && profile !== null,
    documents,
    accepted,
    noGst: Boolean(object(source.tax) && source.tax.no_gst_notice === true),
    countries: pair(options.countries),
    states,
    noPostal: (Array.isArray(options.no_postal) ? options.no_postal : []).filter(code => /^[A-Z]{2}$/.test(code)),
  };
}

/** The documents the buyer must tick for this purchase: not the ones already agreed to at their current version. The renewal notice is always ticked. */
export function documentsToTick(kind, data) {
  return requiredDocuments(kind).filter(name => {
    if (!data.documents[name]) return true;
    if (name === 'auto_renewal') return true;
    const earlier = data.accepted[name];
    return !(earlier && earlier.current === true && earlier.version === data.documents[name].version);
  });
}

/** body.consent: the version of each ticked document, as the server expects. */
export function consentBody(documents, ticked) {
  const body = {};
  for (const name of ticked) if (documents[name]) body[name] = documents[name].version;
  return body;
}

const formatters = new Map();
/** 89900 INR paise → "₹899"; 1000 USD cents → "$10"; 1050 → "$10.50". The same rule as pricing.js formatMoney. */
export function formatPrice(minor, currency) {
  const code = normalizeCurrency(currency);
  if (!Number.isFinite(minor)) return '';
  const digits = Math.round(minor) % 100 === 0 ? 0 : 2;
  const key = code + digits;
  if (!formatters.has(key)) {
    formatters.set(key, new Intl.NumberFormat(code === 'INR' ? 'en-IN' : 'en-US', { style: 'currency', currency: code, minimumFractionDigits: digits, maximumFractionDigits: digits }));
  }
  return formatters.get(key).format(Math.round(minor) / 100);
}

const price = (item, currency) => normalizeCurrency(currency) === 'INR' ? item && item.price && item.price.inr_paise : item && item.price && item.price.usd_cents;

/** One month after `now`, clamped to the end of a shorter month (31 January → 28 February), as UTC "3 December 2026". */
export function nextChargeDate(now = Date.now()) {
  const start = new Date(now);
  const target = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(start.getUTCDate(), lastDay));
  return target.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/**
 * The order summary rows [{label, value}]. "No GST charged" appears only when the server says the
 * owner has confirmed it (tax.no_gst_notice): until then the page states nothing about GST.
 */
export function summaryRows({ kind, plan, pack, currency, noGst = false, now = Date.now() }) {
  const code = normalizeCurrency(currency);
  const rows = [];
  if (kind === 'subscription') {
    const amount = formatPrice(price(plan, code), code);
    rows.push({ label: 'Plan', value: 'Neuron ' + string(plan && plan.name, 40) });
    rows.push({ label: 'Billing', value: 'Monthly, renews until you cancel' });
    rows.push({ label: 'Price', value: amount + ' per month' });
    if (plan && Number.isFinite(plan.monthly_credit_usd) && plan.monthly_credit_usd > 0) {
      rows.push({ label: 'Credits included', value: formatPrice(Math.round(plan.monthly_credit_usd * 100), 'USD') + ' every month' });
    }
    if (noGst) rows.push({ label: 'Tax', value: 'No GST charged' });
    rows.push({ label: 'Due today', value: amount });
    rows.push({ label: 'First renewal', value: 'About ' + nextChargeDate(now) + ', then monthly' });
  } else {
    const amount = formatPrice(price(pack, code), code);
    rows.push({ label: 'Item', value: formatPrice(Math.round((pack && pack.credit_usd || 0) * 100), 'USD') + ' of Neuron credits' });
    rows.push({ label: 'Payment', value: 'One time, no renewal' });
    rows.push({ label: 'Price', value: amount });
    if (noGst) rows.push({ label: 'Tax', value: 'No GST charged' });
    rows.push({ label: 'Due today', value: amount });
  }
  return rows;
}

/** The saved address as short lines for the review screen. */
export function addressLines(values, data) {
  const country = data.countries.find(entry => entry.code === values.country);
  const state = (data.states[values.country] || []).find(entry => entry.code === values.state);
  const place = [values.city, state ? state.name : values.state].filter(Boolean).join(', ');
  return [values.business_name, values.address_line1, values.address_line2, [place, values.postal_code].filter(Boolean).join(' '),
    country ? country.name : values.country].filter(Boolean);
}

/** Runs the step, then `begin(consent)`; once, if the server says the details or agreement changed meanwhile, runs both again. */
export async function purchaseWithDetails(collectOptions, begin, { collect = collectBillingDetails } = {}) {
  for (let attempt = 0; ; attempt++) {
    const { consent } = await collect(collectOptions);
    try { return await begin(consent); }
    catch (error) {
      if (attempt === 0 && error && DETAILS_RETRY_CODES.includes(error.code)) continue;
      throw error;
    }
  }
}

/* ───────────── The dialog ───────────── */

function h(doc, tag, attributes = {}, ...children) {
  const element = doc.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue;
    element.setAttribute(name, value === true ? '' : String(value));
  }
  element.append(...children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false));
  return element;
}

const dismissed = () => new ApiError(describeError({ code: 'checkout_dismissed' }), { code: 'checkout_dismissed' });

/**
 * Opens the dialog and resolves with {consent} once the buyer has saved (or confirmed) their details and
 * ticked what is needed; rejects with checkout_dismissed when it is closed. `kind` is 'subscription'
 * (with `plan`) or 'topup' (with `pack`); `currency` is INR or USD.
 */
export async function collectBillingDetails({ kind, plan = null, pack = null, currency, auth, fetchImpl, doc = globalThis.document, win = globalThis.window, now = () => Date.now(), onStatus } = {}) {
  if (!['subscription', 'topup'].includes(kind)) throw new ApiError('Choose a plan or a credit pack.', { code: 'invalid_request' });
  if (onStatus) onStatus('Loading your billing details…');
  const data = parseDetailsResponse(await apiFetch(PROFILE_PATH, { auth, fetchImpl, timeoutMs: 10000 }));
  if (onStatus) onStatus('');
  const host = win && win.location ? win.location.hostname : '';
  const code = normalizeCurrency(currency);
  const needed = documentsToTick(kind, data);
  const missingDocuments = requiredDocuments(kind).filter(name => !data.documents[name]);
  if (missingDocuments.length) throw new ApiError('Billing is not available right now. Try again shortly.', { code: 'service_unavailable' });
  const planName = string(plan && plan.name, 40) || 'subscription';
  const amount = formatPrice(price(kind === 'subscription' ? plan : pack, code), code);
  const opener = doc.activeElement || null;

  return new Promise((resolve, reject) => {
    let mode = data.complete ? 'review' : 'form';
    let values = valuesFromProfile(data.profile);
    // A guess only, for a first purchase: a buyer paying in rupees is most likely in India (the pricing page
    // chose the currency from their time zone or their own toggle).
    if (!data.profile && code === 'INR') values.country = 'IN';
    let settled = false;
    let saving = false;
    const refs = { fields: {}, boxes: {} };

    const dialog = h(doc, 'dialog', { class: 'zx-dialog zx-dialog--billing', 'aria-labelledby': 'bd-title', 'aria-describedby': 'bd-intro' });
    const title = h(doc, 'h2', { id: 'bd-title', tabindex: '-1' }, kind === 'subscription' ? 'Billing details' : 'Billing details for your top-up');
    const intro = h(doc, 'p', { id: 'bd-intro', class: 'zx-muted' });
    const summary = h(doc, 'div', { id: 'bd-errors', class: 'zx-alert zx-alert--error', role: 'alert', tabindex: '-1' });
    const status = h(doc, 'p', { id: 'bd-status', class: 'zx-help', role: 'status', 'aria-live': 'polite' });
    const body = h(doc, 'div', { id: 'bd-body' });
    const form = h(doc, 'form', { id: 'bd-form', novalidate: true, 'aria-labelledby': 'bd-title' });
    const submit = h(doc, 'button', { type: 'submit', class: 'zx-btn zx-btn--primary', id: 'bd-submit' });
    const cancel = h(doc, 'button', { type: 'button', class: 'zx-btn', id: 'bd-cancel' }, 'Cancel');

    const finish = (action, value) => {
      if (settled) return;
      settled = true;
      try { if (dialog.open) dialog.close(); } catch { /* The dialog may already be closed. */ }
      dialog.remove();
      if (opener && typeof opener.focus === 'function') { try { opener.focus(); } catch { /* The opener may be gone. */ } }
      action(value);
    };

    const link = (name, label) => h(doc, 'a', {
      href: siteUrl((data.documents[name] && data.documents[name].path) || DEFAULT_PATHS[name] || '/terms', host),
      target: '_blank', rel: 'noopener noreferrer',
    }, label);

    // ── Fields ──
    function field(key, { type = 'text', autocomplete, inputmode, hint, control, maxlength = 120, autocapitalize, autocorrect, spellcheck } = {}) {
      const id = 'bd-' + key.replace(/_/g, '-');
      const input = control || h(doc, 'input', { class: 'zx-input', id, type, name: key, autocomplete, inputmode, maxlength, autocapitalize, autocorrect, spellcheck });
      if (control) { control.setAttribute('id', id); control.setAttribute('name', key); control.setAttribute('autocomplete', autocomplete); }
      input.value = values[key] || '';
      refs.fields[key] = { input, id };
      const marker = h(doc, 'span', { class: 'zx-help', id: id + '-marker' });
      const hintEl = hint ? h(doc, 'p', { class: 'zx-help', id: id + '-hint' }, hint) : null;
      const error = h(doc, 'p', { class: 'zx-field-error', id: id + '-error', hidden: true });
      input.setAttribute('aria-describedby', [hintEl ? id + '-hint' : '', id + '-error'].filter(Boolean).join(' '));
      const labelText = h(doc, 'span', { id: id + '-label' }, FIELD_LABELS[key]);
      const wrapper = h(doc, 'div', { class: 'zx-field', id: id + '-field' }, h(doc, 'label', { for: id }, labelText, ' ', marker), input, hintEl, error);
      refs.fields[key].wrapper = wrapper;
      refs.fields[key].label = labelText;
      refs.fields[key].marker = marker;
      refs.fields[key].error = error;
      return wrapper;
    }

    const read = () => {
      const next = { ...values };
      for (const [key, ref] of Object.entries(refs.fields)) if (ref.input) next[key] = ref.input.value;
      if (refs.type) next.customer_type = refs.type.business.checked ? 'business' : 'individual';
      return next;
    };

    function stateControl() {
      const options = data.states[values.country] || [];
      const select = h(doc, 'select', { class: 'zx-select', id: 'bd-state', name: 'state', autocomplete: 'address-level1' },
        h(doc, 'option', { value: '' }, 'Choose…'), options.map(entry => h(doc, 'option', { value: entry.code }, entry.name)));
      return select;
    }

    function buildForm() {
      refs.fields = {};
      const businessRadio = h(doc, 'input', { type: 'radio', name: 'bd-type', id: 'bd-type-business', value: 'business' });
      const individualRadio = h(doc, 'input', { type: 'radio', name: 'bd-type', id: 'bd-type-individual', value: 'individual' });
      businessRadio.checked = values.customer_type === 'business';
      individualRadio.checked = values.customer_type !== 'business';
      refs.type = { business: businessRadio, individual: individualRadio };
      const typeSet = h(doc, 'fieldset', { class: 'zx-fieldset', id: 'bd-type-set' }, h(doc, 'legend', {}, 'I am buying as'),
        h(doc, 'div', { class: 'zx-row' },
          h(doc, 'label', { class: 'zx-check', for: 'bd-type-individual' }, individualRadio, ' Individual'),
          h(doc, 'label', { class: 'zx-check', for: 'bd-type-business' }, businessRadio, ' Business')));

      const countrySelect = h(doc, 'select', { class: 'zx-select', 'aria-required': 'true' }, h(doc, 'option', { value: '' }, 'Choose…'),
        data.countries.map(entry => h(doc, 'option', { value: entry.code }, entry.name)));
      const stateWrapper = h(doc, 'div', { id: 'bd-state-slot' });
      const container = h(doc, 'div', { class: 'zx-form-grid', id: 'bd-fields' }, typeSet,
        field('full_name', { autocomplete: 'name' }),
        field('business_name', { autocomplete: 'organization' }),
        field('country', { control: countrySelect, autocomplete: 'country' }),
        stateWrapper,
        field('city', { autocomplete: 'address-level2' }),
        field('postal_code', { autocomplete: 'postal-code' }),
        field('address_line1', { autocomplete: 'address-line1', hint: 'Optional for individuals; needed for a business.' }),
        field('address_line2', { autocomplete: 'address-line2' }),
        // With the business address, for individuals and businesses alike; its label follows the country.
        // A code, not words: capitals on a phone keyboard, no autocorrect or spelling marks.
        field('tax_id', { autocomplete: 'off', maxlength: 40, hint: TAX_ID_HINT, autocapitalize: 'characters', autocorrect: 'off', spellcheck: 'false' }),
        field('phone', { type: 'tel', autocomplete: 'tel', inputmode: 'tel', hint: 'Optional. With the country code, for example +91 98765 43210. Fills in the payment window for you.' }));
      refs.stateSlot = stateWrapper;
      countrySelect.value = values.country;
      renderState();
      sync();
      countrySelect.addEventListener('change', () => { values = read(); renderState(); sync(); });
      businessRadio.addEventListener('change', () => { values = read(); sync(); });
      individualRadio.addEventListener('change', () => { values = read(); sync(); });
      return container;
    }

    // The state is a list for India and free text elsewhere.
    function renderState() {
      const india = Boolean(data.states[values.country]);
      const control = india ? stateControl() : h(doc, 'input', { class: 'zx-input', type: 'text', maxlength: 80 });
      const wrapper = field('state', { control, autocomplete: 'address-level1' });
      if (india) control.value = values.state;
      refs.stateSlot.replaceChildren(wrapper);
    }

    // Required and optional markers follow the country and customer type.
    function sync() {
      const current = read();
      const required = requiredFields(current.country, current.customer_type, data.noPostal);
      for (const [key, ref] of Object.entries(refs.fields)) {
        ref.marker.textContent = required.includes(key) ? '(required)' : '(optional)';
        if (required.includes(key)) ref.input.setAttribute('aria-required', 'true'); else ref.input.removeAttribute('aria-required');
      }
      if (refs.fields.business_name) refs.fields.business_name.wrapper.hidden = current.customer_type !== 'business';
      if (refs.fields.state) refs.fields.state.wrapper.hidden = !current.country;
      if (refs.fields.postal_code) refs.fields.postal_code.wrapper.hidden = !current.country || data.noPostal.includes(current.country);
      if (refs.fields.tax_id) refs.fields.tax_id.label.textContent = taxIdLabel(current.country);
    }

    function showErrors(errors) {
      for (const [key, ref] of Object.entries(refs.fields)) {
        const message = errors[key] || '';
        ref.error.textContent = message;
        ref.error.hidden = !message;
        if (message) ref.input.setAttribute('aria-invalid', 'true'); else ref.input.removeAttribute('aria-invalid');
      }
      for (const [name, ref] of Object.entries(refs.boxes)) {
        const message = errors['consent_' + name] || '';
        ref.error.textContent = message;
        ref.error.hidden = !message;
        if (message) ref.input.setAttribute('aria-invalid', 'true'); else ref.input.removeAttribute('aria-invalid');
      }
      const entries = Object.entries(errors).filter(([, message]) => message);
      summary.replaceChildren();
      if (!entries.length) return;
      summary.append(h(doc, 'p', {}, entries.length === 1 ? 'One thing needs your attention.' : entries.length + ' things need your attention.'),
        h(doc, 'ul', {}, entries.map(([key, message]) => {
          const target = refs.fields[key] ? refs.fields[key].id : refs.boxes[key.replace(/^consent_/, '')] ? refs.boxes[key.replace(/^consent_/, '')].id : '';
          // The tax id's label follows the country ("GSTIN" or "VAT or tax ID"); the summary uses the same words.
          const label = key === 'tax_id' && refs.fields.tax_id ? refs.fields.tax_id.label.textContent : FIELD_LABELS[key];
          const anchor = h(doc, 'a', { href: '#' + target }, (label ? label + ': ' : '') + message);
          anchor.addEventListener('click', event => {
            event.preventDefault();
            const input = (refs.fields[key] || refs.boxes[key.replace(/^consent_/, '')] || {}).input;
            if (input && input.focus) input.focus();
          });
          return h(doc, 'li', {}, anchor);
        })));
      if (summary.focus) summary.focus();
    }

    // ── Review (a buyer with saved details) ──
    function buildReview() {
      const rows = [['Name', values.full_name], ['Address', addressLines(values, data)], ['Phone', values.phone || 'Not given']];
      if (values.tax_id) rows.push([taxIdLabel(values.country), values.tax_id]);
      return h(doc, 'section', { 'aria-labelledby': 'bd-saved-title', id: 'bd-review' },
        h(doc, 'h3', { id: 'bd-saved-title' }, 'Your saved details'),
        h(doc, 'dl', { class: 'zx-kv' }, rows.flatMap(([label, value]) => [h(doc, 'dt', {}, label),
          h(doc, 'dd', {}, Array.isArray(value) ? value.map((line, index) => [index ? h(doc, 'br') : null, line]) : value)])),
        h(doc, 'button', { type: 'button', class: 'zx-btn zx-btn--sm', id: 'bd-edit' }, 'Edit details'));
    }

    function buildSummary() {
      const rows = summaryRows({ kind, plan, pack, currency: code, noGst: data.noGst, now: now() });
      return h(doc, 'section', { 'aria-labelledby': 'bd-summary-title', id: 'bd-summary' },
        h(doc, 'h3', { id: 'bd-summary-title' }, 'Order summary'),
        h(doc, 'dl', { class: 'zx-kv' }, rows.flatMap(row => [h(doc, 'dt', {}, row.label), h(doc, 'dd', {}, row.value)])));
    }

    function buildConsents() {
      refs.boxes = {};
      const earlier = requiredDocuments(kind).filter(name => !needed.includes(name));
      const sentence = earlier.length
        ? h(doc, 'p', { class: 'zx-help', id: 'bd-earlier' }, 'You have already accepted the ', earlier.map((name, index) => [index ? (index === earlier.length - 1 ? ' and ' : ', ') : '', link(name, DOCUMENT_NAMES[name])]),
          ' in their current versions.')
        : null;
      const boxes = needed.map(name => {
        const id = 'bd-consent-' + name.replace(/_/g, '-');
        const input = h(doc, 'input', { type: 'checkbox', id, name: 'consent_' + name, 'aria-describedby': id + '-error' });
        const [before, label, after] = consentText(name, { planName, price: amount });
        const error = h(doc, 'p', { class: 'zx-field-error', id: id + '-error', hidden: true });
        refs.boxes[name] = { input, id, error };
        return h(doc, 'div', { class: 'zx-check-row' }, h(doc, 'label', { class: 'zx-check', for: id }, input, ' ', h(doc, 'span', {}, before, link(name, label), after)), error);
      });
      return h(doc, 'fieldset', { class: 'zx-fieldset', id: 'bd-consents' }, h(doc, 'legend', {}, needed.length ? 'Before you pay' : 'Your agreement'), boxes, sentence);
    }

    function render() {
      intro.textContent = mode === 'review'
        ? 'Check your saved details, then continue to the payment window.'
        : 'We ask for these once and keep them for your next purchase. Required fields are marked.';
      submit.textContent = mode === 'review' ? 'Continue to payment' : 'Save and continue to payment';
      showErrors({});
      const parts = [mode === 'review' ? buildReview() : buildForm(), buildSummary(), buildConsents(),
        h(doc, 'p', { class: 'zx-help', id: 'bd-notice' }, kind === 'subscription' ? RENEWAL_NOTICE : ONE_TIME_NOTICE, ' ', PROCESSOR_NOTICE),
        mode === 'form' ? h(doc, 'p', { class: 'zx-help', id: 'bd-data-notice' }, DATA_NOTICE) : null];
      body.replaceChildren(...parts.filter(Boolean));
      const edit = body.querySelector('#bd-edit');
      if (edit) edit.addEventListener('click', () => { mode = 'form'; render(); const first = refs.fields.full_name; if (first && first.input.focus) first.input.focus(); });
    }

    async function onSubmit(event) {
      if (event && event.preventDefault) event.preventDefault();
      if (saving || settled) return;
      const errors = {};
      if (mode === 'form') {
        values = read();
        Object.assign(errors, validateDetails(values, { noPostal: data.noPostal, states: data.states }));
      }
      for (const name of needed) if (!refs.boxes[name].input.checked) errors['consent_' + name] = 'Tick the box for the ' + DOCUMENT_NAMES[name] + ' to continue.';
      if (Object.keys(errors).length) { showErrors(errors); return; }
      showErrors({});
      saving = true;
      submit.disabled = true;
      submit.setAttribute('aria-busy', 'true');
      try {
        if (mode === 'form') {
          status.textContent = 'Saving your details…';
          await apiFetch(PROFILE_PATH, { method: 'PUT', body: profilePayload(values), auth, fetchImpl, timeoutMs: 10000 });
        }
        const consent = consentBody(data.documents, needed);
        // Accepted documents are not resent; the server knows them. The renewal notice always is.
        finish(resolve, { consent });
      } catch (error) {
        saving = false;
        submit.disabled = false;
        submit.removeAttribute('aria-busy');
        status.textContent = '';
        if (error && error.fields && Object.keys(error.fields).length) {
          // The server's messages, by field (it checks postal codes, phone numbers, state lists and the tax id).
          const fields = {};
          for (const [key, message] of Object.entries(error.fields)) if (FIELD_LABELS[key] || key === 'customer_type') fields[key] = string(message, 200);
          showErrors(Object.keys(fields).length ? fields : { full_name: describeError(error) });
        } else if (error && error.code === 'invalid_session') {
          finish(reject, error);
        } else {
          summary.replaceChildren(h(doc, 'p', {}, describeError(error)));
        }
      }
    }

    form.addEventListener('submit', onSubmit);
    cancel.addEventListener('click', () => finish(reject, dismissed()));
    // Esc and the backdrop close the dialog natively.
    dialog.addEventListener('cancel', () => finish(reject, dismissed()));
    dialog.addEventListener('close', () => finish(reject, dismissed()));

    form.append(summary, body, status, h(doc, 'div', { class: 'zx-row zx-dialog__actions' }, submit, cancel));
    dialog.append(title, intro, form);
    render();
    doc.body.appendChild(dialog);
    if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
    const first = mode === 'form' && refs.fields.full_name ? refs.fields.full_name.input : title;
    if (first && first.focus) first.focus();
  });
}

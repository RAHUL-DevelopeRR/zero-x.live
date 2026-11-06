// Billing profile: what Zero-X asks a buyer for before Razorpay opens (docs/PLATFORM_CONTRACT.md
// section 3.5, GET/PUT /api/billing/profile). Pure functions, no I/O, shared by the routes and
// the tests. Never card, UPI or bank details: those are typed into Razorpay's own window and
// never reach Zero-X. An optional tax id (a GSTIN in India, a VAT or tax id elsewhere) has been
// accepted since 20261105000200_billing_tax_id.sql (owner decision of 2026-11-04); Zero-X is still
// not registered for GST, so it is kept with the billing details for Zero-X's billing records only
// and never sent to Razorpay.
//
// The server is the authority. The browser (billing-details.js) checks the same required fields
// and the same tax id rule so a form fails fast, and shows the server's messages for everything
// else; a test keeps the two rules equal.

const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null;

// ISO 3166-1 alpha-2 (249 codes), India first. Names are plain English for a select box.
const COUNTRY_DATA = [
  'AF:Afghanistan|AX:Aland Islands|AL:Albania|DZ:Algeria|AS:American Samoa|AD:Andorra|AO:Angola|AI:Anguilla',
  'AQ:Antarctica|AG:Antigua and Barbuda|AR:Argentina|AM:Armenia|AW:Aruba|AU:Australia|AT:Austria|AZ:Azerbaijan',
  'BS:Bahamas|BH:Bahrain|BD:Bangladesh|BB:Barbados|BY:Belarus|BE:Belgium|BZ:Belize|BJ:Benin|BM:Bermuda|BT:Bhutan',
  'BO:Bolivia|BA:Bosnia and Herzegovina|BW:Botswana|BV:Bouvet Island|BR:Brazil|IO:British Indian Ocean Territory',
  'VG:British Virgin Islands|BN:Brunei|BG:Bulgaria|BF:Burkina Faso|BI:Burundi|CV:Cabo Verde|KH:Cambodia',
  'CM:Cameroon|CA:Canada|BQ:Caribbean Netherlands|KY:Cayman Islands|CF:Central African Republic|TD:Chad|CL:Chile',
  'CN:China|CX:Christmas Island|CC:Cocos (Keeling) Islands|CO:Colombia|KM:Comoros|CD:Congo (Democratic Republic)',
  'CG:Congo (Republic)|CK:Cook Islands|CR:Costa Rica|HR:Croatia|CU:Cuba|CW:Curacao|CY:Cyprus|CZ:Czechia',
  'DK:Denmark|DJ:Djibouti|DM:Dominica|DO:Dominican Republic|EC:Ecuador|EG:Egypt|SV:El Salvador',
  'GQ:Equatorial Guinea|ER:Eritrea|EE:Estonia|SZ:Eswatini|ET:Ethiopia|FK:Falkland Islands|FO:Faroe Islands',
  'FJ:Fiji|FI:Finland|FR:France|GF:French Guiana|PF:French Polynesia|TF:French Southern Territories|GA:Gabon',
  'GM:Gambia|GE:Georgia|DE:Germany|GH:Ghana|GI:Gibraltar|GR:Greece|GL:Greenland|GD:Grenada|GP:Guadeloupe|GU:Guam',
  'GT:Guatemala|GG:Guernsey|GN:Guinea|GW:Guinea-Bissau|GY:Guyana|HT:Haiti|HM:Heard and McDonald Islands',
  'HN:Honduras|HK:Hong Kong|HU:Hungary|IS:Iceland|ID:Indonesia|IR:Iran|IQ:Iraq|IE:Ireland|IM:Isle of Man',
  'IL:Israel|IT:Italy|CI:Ivory Coast|JM:Jamaica|JP:Japan|JE:Jersey|JO:Jordan|KZ:Kazakhstan|KE:Kenya|KI:Kiribati',
  'KW:Kuwait|KG:Kyrgyzstan|LA:Laos|LV:Latvia|LB:Lebanon|LS:Lesotho|LR:Liberia|LY:Libya|LI:Liechtenstein',
  'LT:Lithuania|LU:Luxembourg|MO:Macao|MG:Madagascar|MW:Malawi|MY:Malaysia|MV:Maldives|ML:Mali|MT:Malta',
  'MH:Marshall Islands|MQ:Martinique|MR:Mauritania|MU:Mauritius|YT:Mayotte|MX:Mexico|FM:Micronesia|MD:Moldova',
  'MC:Monaco|MN:Mongolia|ME:Montenegro|MS:Montserrat|MA:Morocco|MZ:Mozambique|MM:Myanmar|NA:Namibia|NR:Nauru',
  'NP:Nepal|NL:Netherlands|NC:New Caledonia|NZ:New Zealand|NI:Nicaragua|NE:Niger|NG:Nigeria|NU:Niue',
  'NF:Norfolk Island|KP:North Korea|MK:North Macedonia|MP:Northern Mariana Islands|NO:Norway|OM:Oman|PK:Pakistan',
  'PW:Palau|PS:Palestine|PA:Panama|PG:Papua New Guinea|PY:Paraguay|PE:Peru|PH:Philippines|PN:Pitcairn Islands',
  'PL:Poland|PT:Portugal|PR:Puerto Rico|QA:Qatar|RE:Reunion|RO:Romania|RU:Russia|RW:Rwanda|BL:Saint Barthelemy',
  'WS:Samoa|SM:San Marino|ST:Sao Tome and Principe|SA:Saudi Arabia|SN:Senegal|RS:Serbia|SC:Seychelles',
  'SL:Sierra Leone|SG:Singapore|SX:Sint Maarten|SK:Slovakia|SI:Slovenia|SB:Solomon Islands|SO:Somalia',
  'ZA:South Africa|GS:South Georgia and South Sandwich Islands|KR:South Korea|SS:South Sudan|ES:Spain',
  'LK:Sri Lanka|SH:St. Helena|KN:St. Kitts and Nevis|LC:St. Lucia|MF:St. Martin|PM:St. Pierre and Miquelon',
  'VC:St. Vincent and Grenadines|SD:Sudan|SR:Suriname|SJ:Svalbard and Jan Mayen|SE:Sweden|CH:Switzerland|SY:Syria',
  'TW:Taiwan|TJ:Tajikistan|TZ:Tanzania|TH:Thailand|TL:Timor-Leste|TG:Togo|TK:Tokelau|TO:Tonga',
  'TT:Trinidad and Tobago|TN:Tunisia|TR:Turkey|TM:Turkmenistan|TC:Turks and Caicos Islands|TV:Tuvalu',
  'UM:U.S. Outlying Islands|VI:U.S. Virgin Islands|UG:Uganda|UA:Ukraine|AE:United Arab Emirates|GB:United Kingdom',
  'US:United States|UY:Uruguay|UZ:Uzbekistan|VU:Vanuatu|VA:Vatican City|VE:Venezuela|VN:Vietnam',
  'WF:Wallis and Futuna|EH:Western Sahara|YE:Yemen|ZM:Zambia|ZW:Zimbabwe',
].join('|');

export const COUNTRIES = Object.freeze([['IN', 'India'],
  ...COUNTRY_DATA.split('|').map(entry => entry.split(':'))].map(entry => Object.freeze(entry)));
const COUNTRY_CODES = new Set(COUNTRIES.map(([code]) => code));

// States and union territories, with ISO 3166-1:IN subdivision codes where the code is certain;
// the codes are internal identifiers here (nothing is filed with them).
export const INDIA_STATES = Object.freeze([
  ['AN', 'Andaman and Nicobar Islands'], ['AP', 'Andhra Pradesh'], ['AR', 'Arunachal Pradesh'], ['AS', 'Assam'], ['BR', 'Bihar'],
  ['CH', 'Chandigarh'], ['CT', 'Chhattisgarh'], ['DH', 'Dadra and Nagar Haveli and Daman and Diu'], ['DL', 'Delhi'], ['GA', 'Goa'],
  ['GJ', 'Gujarat'], ['HR', 'Haryana'], ['HP', 'Himachal Pradesh'], ['JK', 'Jammu and Kashmir'], ['JH', 'Jharkhand'],
  ['KA', 'Karnataka'], ['KL', 'Kerala'], ['LA', 'Ladakh'], ['LD', 'Lakshadweep'], ['MP', 'Madhya Pradesh'], ['MH', 'Maharashtra'],
  ['MN', 'Manipur'], ['ML', 'Meghalaya'], ['MZ', 'Mizoram'], ['NL', 'Nagaland'], ['OD', 'Odisha'], ['PY', 'Puducherry'],
  ['PB', 'Punjab'], ['RJ', 'Rajasthan'], ['SK', 'Sikkim'], ['TN', 'Tamil Nadu'], ['TG', 'Telangana'], ['TR', 'Tripura'],
  ['UP', 'Uttar Pradesh'], ['UT', 'Uttarakhand'], ['WB', 'West Bengal'],
].map(entry => Object.freeze(entry)));
const STATE_BY_CODE = new Map(INDIA_STATES);
const STATE_BY_NAME = new Map(INDIA_STATES.map(([code, name]) => [name.toLowerCase(), code]));

// Countries whose addresses have no postal code (so none is asked for).
export const NO_POSTAL_COUNTRIES = Object.freeze(['AE', 'AG', 'AO', 'AW', 'BF', 'BI', 'BJ', 'BS', 'BW', 'BZ', 'CD', 'CF', 'CG', 'CI', 'CK',
  'CM', 'DJ', 'DM', 'ER', 'FJ', 'GD', 'GH', 'GM', 'GQ', 'GY', 'HK', 'KI', 'KM', 'KN', 'LC', 'ML', 'MO', 'MR', 'MW', 'NR', 'NU', 'QA', 'RW',
  'SB', 'SC', 'SL', 'SR', 'ST', 'SY', 'TK', 'TL', 'TO', 'TV', 'UG', 'VU', 'YE', 'ZW']);

// Cheap per-country postal code shapes (after upper-casing and collapsing spaces). Other
// countries accept 3 to 12 letters, digits, spaces or hyphens.
const DIGITS = count => new RegExp(`^\\d{${count}}$`);
const POSTAL = {
  IN: /^[1-9]\d{5}$/, US: /^\d{5}(-\d{4})?$/, GB: /^[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}$/,
  CA: /^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z] ?\d[ABCEGHJ-NPRSTV-Z]\d$/, NL: /^\d{4} ?[A-Z]{2}$/, SE: /^\d{3} ?\d{2}$/,
  JP: /^\d{3}-?\d{4}$/, BR: /^\d{5}-?\d{3}$/, PL: /^\d{2}-\d{3}$/, PT: /^\d{4}-\d{3}$/,
  AU: DIGITS(4), NZ: DIGITS(4), AT: DIGITS(4), BE: DIGITS(4), CH: DIGITS(4), DK: DIGITS(4), NO: DIGITS(4), HU: DIGITS(4), ZA: DIGITS(4),
  PH: DIGITS(4), BD: DIGITS(4), DE: DIGITS(5), FR: DIGITS(5), ES: DIGITS(5), IT: DIGITS(5), FI: DIGITS(5), MX: DIGITS(5), TR: DIGITS(5),
  KR: DIGITS(5), TH: DIGITS(5), ID: DIGITS(5), PK: DIGITS(5), LK: DIGITS(5), NP: DIGITS(5), MY: DIGITS(5),
  SG: DIGITS(6), CN: DIGITS(6), RU: DIGITS(6), VN: DIGITS(6), BY: DIGITS(6), KZ: DIGITS(6),
};
const GENERIC_POSTAL = /^[A-Z0-9][A-Z0-9 -]{1,10}[A-Z0-9]$/;

export const CUSTOMER_TYPES = Object.freeze(['individual', 'business']);
// The only keys a profile body may carry, in form order. Card, UPI and bank details are never among them.
export const PROFILE_FIELDS = Object.freeze(['customer_type', 'full_name', 'business_name', 'country', 'state', 'city', 'postal_code',
  'address_line1', 'address_line2', 'tax_id', 'phone']);
// tax_id's limit is on what was typed (spaces included); the stored value is at most 20 characters.
const LIMITS = { full_name: 120, business_name: 120, state: 80, city: 80, postal_code: 12, address_line1: 120, address_line2: 120, tax_id: 40, phone: 40 };
export const FIELD_LABELS = Object.freeze({
  customer_type: 'Customer type', full_name: 'Full name', business_name: 'Business name', country: 'Country', state: 'State',
  city: 'City', postal_code: 'Postal code', address_line1: 'Address line 1', address_line2: 'Address line 2', tax_id: 'GSTIN or tax ID',
  phone: 'Phone number',
});

// GST state codes (the first two digits of a GSTIN) of each state and union territory in
// INDIA_STATES. Dadra and Nagar Haveli and Daman and Diu is 26 since the 2020 merger; 25 (Daman and
// Diu before it) is accepted too. Codes 97 (Other Territory) and 99 (Centre Jurisdiction) belong to
// no state, so a GSTIN with them is refused by the state match.
export const GST_STATE_CODES = Object.freeze({
  JK: ['01'], HP: ['02'], PB: ['03'], CH: ['04'], UT: ['05'], HR: ['06'], DL: ['07'], RJ: ['08'], UP: ['09'], BR: ['10'], SK: ['11'],
  AR: ['12'], NL: ['13'], MN: ['14'], MZ: ['15'], TR: ['16'], ML: ['17'], AS: ['18'], WB: ['19'], JH: ['20'], OD: ['21'], CT: ['22'],
  MP: ['23'], GJ: ['24'], DH: ['26', '25'], MH: ['27'], KA: ['29'], GA: ['30'], LD: ['31'], KL: ['32'], TN: ['33'], PY: ['34'],
  AN: ['35'], TG: ['36'], AP: ['37'], LA: ['38'],
});
const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const OTHER_TAX_ID = /^[A-Z0-9][A-Z0-9-]{0,18}[A-Z0-9]$/;
const GSTIN_CHARACTERS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** A tax id as stored: spaces removed, upper case ('' when nothing was given). */
export function normalizeTaxId(raw) {
  return String(raw ?? '').replace(/\s+/g, '').toUpperCase();
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

/**
 * Why a normalised tax id is refused for this country and state, or '' when it is accepted (an
 * empty one is). India: a GSTIN with the right check character whose state code is the state's
 * (when the state is a code from INDIA_STATES; otherwise the state's own error is shown instead).
 * Elsewhere: 2 to 20 letters, digits or hyphens, starting and ending with a letter or digit.
 * billing-details.js has the same rule and messages (a test compares them).
 */
export function taxIdError(value, country, state = '') {
  if (!value) return '';
  if (country !== 'IN') return OTHER_TAX_ID.test(value) ? '' : 'Enter a VAT or tax ID of 2 to 20 letters, digits or hyphens.';
  if (value.length !== 15) return 'A GSTIN has 15 letters and digits.';
  if (!GSTIN.test(value)) return 'Enter a valid GSTIN: a 2 digit state code, the 10 character PAN, then 3 more characters.';
  if (gstinCheckCharacter(value) !== value[14]) return 'This GSTIN\'s last character does not match the rest. Check it for a typo.';
  const codes = Object.hasOwn(GST_STATE_CODES, state) ? GST_STATE_CODES[state] : null;
  if (codes && !codes.includes(value.slice(0, 2))) {
    return `This GSTIN starts with ${value.slice(0, 2)}, but the GST state code of ${STATE_BY_CODE.get(state)} is ${codes[0]}. Check the GSTIN or the state.`;
  }
  return '';
}

// Control characters become spaces; zero-width and bidirectional override characters (which can
// disguise text) are dropped.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
const length = value => Array.from(value).length;

/** The fields that must be filled in for this country and customer type, in form order. */
export function requiredFields(country, customerType) {
  const fields = ['full_name', 'country'];
  if (customerType === 'business') fields.push('business_name');
  if (country === 'IN') fields.push('state');
  fields.push('city');
  if (!NO_POSTAL_COUNTRIES.includes(country)) fields.push('postal_code');
  if (customerType === 'business') fields.push('address_line1');
  return fields;
}

/** An E.164 number (+919876543210) from what a person typed, or null when it cannot be one. */
export function normalizePhone(raw, country = '') {
  if (typeof raw !== 'string') return null;
  let digits = raw.replace(/[\s().-]/g, '');
  if (!/^\+?\d+$/.test(digits)) return null;
  if (digits.startsWith('00')) digits = '+' + digits.slice(2);
  if (!digits.startsWith('+')) {
    // Without a country code only an Indian mobile number is understood.
    if (country !== 'IN') return null;
    digits = digits.replace(/^0/, '');
    if (/^91\d{10}$/.test(digits)) digits = '+' + digits;
    else if (/^[6-9]\d{9}$/.test(digits)) digits = '+91' + digits;
    else return null;
  }
  if (!/^\+[1-9]\d{7,14}$/.test(digits)) return null;
  if (digits.startsWith('+91') && !/^\+91[6-9]\d{9}$/.test(digits)) return null;
  return digits;
}

export function normalizePostalCode(raw, country) {
  const value = String(raw ?? '').toUpperCase().replace(/\s+/g, ' ').trim();
  if (!value) return '';
  return country === 'IN' ? value.replace(/ /g, '') : value;
}

export function postalCodeValid(value, country) {
  return (POSTAL[country] || GENERIC_POSTAL).test(value);
}

/**
 * Validates and normalises a profile body. Returns {ok: true, value} where value has the database
 * column names (phone is phone_e164), or {ok: false, errors} with one message per field; errors._
 * is for a body that is not an object. Unknown keys are refused, never ignored.
 */
export function normalizeProfile(input) {
  const source = object(input);
  if (!source) return { ok: false, errors: { _: 'Send the billing details as a JSON object.' } };
  const errors = {};
  for (const key of Object.keys(source)) {
    // defineProperty, so that even a key named __proto__ (JSON.parse makes it an own property) is recorded.
    if (!PROFILE_FIELDS.includes(key)) Object.defineProperty(errors, key, { value: 'This field is not accepted.', enumerable: true, writable: true, configurable: true });
  }
  const read = key => {
    const raw = source[key];
    if (raw === undefined || raw === null) return '';
    if (typeof raw !== 'string') { errors[key] = `${FIELD_LABELS[key]} must be text.`; return ''; }
    const value = raw.normalize('NFC').replace(CONTROL, ' ').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
    if (length(value) > LIMITS[key]) errors[key] = `${FIELD_LABELS[key]} must be at most ${LIMITS[key]} characters.`;
    return value;
  };

  const type = source.customer_type === undefined || source.customer_type === null || source.customer_type === ''
    ? 'individual' : source.customer_type;
  if (!CUSTOMER_TYPES.includes(type)) errors.customer_type = 'Choose Individual or Business.';
  const fullName = read('full_name');
  const businessName = read('business_name');
  const country = read('country').toUpperCase();
  const state = read('state');
  const city = read('city');
  const postalRaw = read('postal_code');
  const line1 = read('address_line1');
  const line2 = read('address_line2');
  const taxId = normalizeTaxId(read('tax_id'));
  const phoneRaw = read('phone');

  if (!country) errors.country ||= 'Choose your country.';
  else if (!COUNTRY_CODES.has(country)) errors.country ||= 'Choose a country from the list.';
  const known = COUNTRY_CODES.has(country) ? country : '';
  const customerType = CUSTOMER_TYPES.includes(type) ? type : 'individual';

  let stateValue = state;
  if (known === 'IN') {
    // India: a state or union territory from the list, given by code or by name.
    const code = STATE_BY_CODE.has(state.toUpperCase()) ? state.toUpperCase() : STATE_BY_NAME.get(state.toLowerCase());
    if (!state) errors.state ||= 'Choose your state or union territory.';
    else if (!code) errors.state ||= 'Choose a state or union territory from the list.';
    else stateValue = code;
  }
  const postal = normalizePostalCode(postalRaw, known);
  if (known && !NO_POSTAL_COUNTRIES.includes(known) && !postal) errors.postal_code ||= 'Enter your postal code.';
  else if (known && postal && !postalCodeValid(postal, known)) {
    errors.postal_code ||= known === 'IN' ? 'Enter a 6 digit PIN code.' : 'Enter a valid postal code for this country.';
  }
  if (!fullName) errors.full_name ||= 'Enter your full name.';
  if (!city) errors.city ||= 'Enter your city.';
  if (customerType === 'business') {
    if (!businessName) errors.business_name ||= 'Enter the business name.';
    if (!line1) errors.address_line1 ||= 'Enter the business address.';
  }
  if (line2 && !line1) errors.address_line1 ||= 'Enter address line 1 before address line 2.';
  // Optional for every buyer; checked against the country (and, in India, the state code) once known.
  if (taxId && !errors.tax_id) {
    const message = taxIdError(taxId, known, STATE_BY_CODE.has(stateValue) ? stateValue : '');
    if (message) errors.tax_id = message;
  }
  const phone = phoneRaw ? normalizePhone(phoneRaw, known) : null;
  if (phoneRaw && !phone) errors.phone ||= 'Enter the number with its country code, for example +91 98765 43210.';

  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      customer_type: customerType, full_name: fullName, business_name: businessName || null, country: known,
      state: stateValue || null, city, postal_code: postal || null, address_line1: line1 || null, address_line2: line2 || null,
      phone_e164: phone, tax_id: taxId || null,
    },
  };
}

/** A stored row as the API shows it (phone_e164 is called phone, like the body that saved it). */
export function publicProfile(row) {
  const stored = object(row);
  if (!stored) return null;
  return {
    customer_type: stored.customer_type, full_name: stored.full_name, business_name: stored.business_name ?? null, country: stored.country,
    state: stored.state ?? null, city: stored.city, postal_code: stored.postal_code ?? null, address_line1: stored.address_line1 ?? null,
    address_line2: stored.address_line2 ?? null, phone: stored.phone_e164 ?? null, tax_id: stored.tax_id ?? null,
  };
}

/**
 * Checks a stored profile against today's rules: the validated profile (database column names),
 * or the fields still missing or invalid. A profile saved before a rule tightened is asked for
 * again rather than trusted.
 */
export function checkStoredProfile(row) {
  const profile = publicProfile(row);
  if (!profile) return { ok: false, missing: ['full_name', 'country', 'city', 'postal_code'] };
  const result = normalizeProfile(profile);
  if (result.ok) return { ok: true, value: result.value, profile };
  return { ok: false, missing: PROFILE_FIELDS.filter(key => result.errors[key]) };
}

/**
 * What Razorpay Checkout is prefilled with: the buyer's name (at most 50 characters, Razorpay's
 * limit), the account e-mail and, when given, the phone. Address, state, business name and tax id
 * stay in Zero-X's own database; nothing here goes into Razorpay notes.
 */
export function razorpayPrefill(profile, email) {
  const prefill = { email: typeof email === 'string' ? email : '', name: Array.from(profile?.full_name || '').slice(0, 50).join('').trim() };
  const contact = profile?.phone ?? profile?.phone_e164;
  if (contact) prefill.contact = contact;
  return prefill;
}

/** Choices for the form: every country (India first), India's states and the countries without postal codes. */
export function profileOptions() {
  return {
    countries: COUNTRIES.map(([code, name]) => ({ code, name })),
    states: { IN: INDIA_STATES.map(([code, name]) => ({ code, name })) },
    no_postal: [...NO_POSTAL_COUNTRIES],
  };
}

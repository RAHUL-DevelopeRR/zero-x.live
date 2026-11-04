// Billing details without a database or a browser: the validation and normalisation rules
// (src/billing/profile.js), the legal document versions against the pages they name, and the pure
// helpers of the browser step (billing-details.js, repository root), including that the browser's
// required-field and tax id rules cannot drift from the server's. GSTIN check characters are
// computed here with an implementation of the GSTN's mod-36 rule written independently of both. Routes, the checkout gate and the consent
// records are in check-billing.mjs; the tables in check-billing-details-db.mjs; the dialog itself in
// check-dashboard.mjs. Run: node check-billing-profile.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// Site scripts load as ES modules whatever package.json lies above the checkout.
import './site-modules.mjs';
import {
  COUNTRIES, CUSTOMER_TYPES, GST_STATE_CODES, INDIA_STATES, NO_POSTAL_COUNTRIES, PROFILE_FIELDS, checkStoredProfile, gstinCheckCharacter, normalizePhone,
  normalizePostalCode, normalizeProfile, normalizeTaxId, postalCodeValid, profileOptions, publicProfile, razorpayPrefill, requiredFields, taxIdError,
} from './src/billing/profile.js';
import { CONSENT_DOCUMENTS, LEGAL_DOCUMENTS, VERSION_PATTERN, documentPublic, documentVersions, requiredDocuments } from './src/billing/legal-versions.js';

const root = new URL('../../', import.meta.url);
const read = file => readFileSync(new URL(file, root), 'utf8');
const passed = [];
const ok = name => { passed.push(name); console.log(`ok - ${name}`); };

const GOOD = { full_name: 'Asha Kumar', country: 'IN', state: 'TN', city: 'Karur', postal_code: '639113' };
const valid = body => { const result = normalizeProfile(body); assert.equal(result.ok, true, JSON.stringify(result)); return result.value; };
const errorsOf = body => { const result = normalizeProfile(body); assert.equal(result.ok, false, JSON.stringify(body)); return result.errors; };

// ── Countries and states ──
assert.equal(COUNTRIES.length, 249, 'ISO 3166-1 has 249 codes');
assert.deepEqual(COUNTRIES[0], ['IN', 'India'], 'India first');
assert.equal(new Set(COUNTRIES.map(([code]) => code)).size, 249);
assert.ok(COUNTRIES.every(([code, name]) => /^[A-Z]{2}$/.test(code) && name.length > 1 && !/[<>&]/.test(name)));
assert.deepEqual(COUNTRIES.slice(1).map(([, name]) => name), COUNTRIES.slice(1).map(([, name]) => name).slice().sort((a, b) => a.localeCompare(b, 'en')), 'the rest alphabetical');
for (const code of ['US', 'GB', 'AE', 'SG', 'DE', 'AU', 'CA', 'JP']) assert.ok(COUNTRIES.some(entry => entry[0] === code), code);
assert.equal(INDIA_STATES.length, 36, '28 states and 8 union territories');
assert.equal(new Set(INDIA_STATES.map(([code]) => code)).size, 36);
assert.ok(NO_POSTAL_COUNTRIES.every(code => COUNTRIES.some(entry => entry[0] === code)));
const options = profileOptions();
assert.deepEqual([options.countries[0], options.countries.length, options.states.IN.length, options.no_postal.includes('AE')], [{ code: 'IN', name: 'India' }, 249, 36, true]);
assert.deepEqual(Object.keys(options.states), ['IN'], 'only India has a state list');
ok('249 countries with India first, 36 Indian states and union territories, countries without postal codes');

// ── Normalisation ──
assert.deepEqual(valid({ ...GOOD, full_name: '  Asha \t  Kumar \n', country: 'in', state: 'tamil nadu', postal_code: '639 113', phone: '098765 43210' }), {
  customer_type: 'individual', full_name: 'Asha Kumar', business_name: null, country: 'IN', state: 'TN', city: 'Karur', postal_code: '639113',
  address_line1: null, address_line2: null, phone_e164: '+919876543210', tax_id: null }, 'trimmed, collapsed, India by name to its code, PIN without spaces, E.164 phone');
assert.equal(valid({ ...GOOD, state: 'TN' }).state, 'TN');
assert.equal(valid({ ...GOOD, full_name: 'Zoë​ O’Brien‮' }).full_name, 'Zoë O’Brien', 'invisible and bidirectional override characters are dropped');
assert.equal(valid({ ...GOOD, full_name: 'école' }).full_name, 'école', 'NFC');
assert.equal(valid({ ...GOOD, full_name: 'A\u0000B' }).full_name, 'A B', 'control characters become spaces');
assert.equal(valid({ ...GOOD, customer_type: undefined }).customer_type, 'individual');
assert.equal(valid({ ...GOOD, address_line1: '', address_line2: null, business_name: '', phone: '' }).address_line1, null, 'blank optional fields are null');
assert.equal(valid({ ...GOOD, full_name: 'x'.repeat(120) }).full_name.length, 120);
assert.equal(valid({ ...GOOD, full_name: '\u{1F600}'.repeat(120) }).full_name.length, 240, 'limits count characters, not UTF-16 units');
assert.deepEqual(valid({ customer_type: 'business', full_name: 'Asha', business_name: 'Zero X Labs', address_line1: 'Office 4', address_line2: 'Floor 2', country: 'US', state: 'Texas',
  city: 'Austin', postal_code: '73301-1234' }), { customer_type: 'business', full_name: 'Asha', business_name: 'Zero X Labs', country: 'US', state: 'Texas', city: 'Austin',
  postal_code: '73301-1234', address_line1: 'Office 4', address_line2: 'Floor 2', phone_e164: null, tax_id: null });
assert.deepEqual(valid({ full_name: 'Asha', country: 'AE', city: 'Dubai' }).postal_code, null, 'no postal code where there are none');

// ── Refusals, with one message per field ──
assert.deepEqual(errorsOf('x'), { _: 'Send the billing details as a JSON object.' });
assert.deepEqual(errorsOf([GOOD]), { _: 'Send the billing details as a JSON object.' });
assert.deepEqual(Object.keys(errorsOf({})), ['country', 'full_name', 'city']);
assert.deepEqual(Object.keys(errorsOf({ ...GOOD, gstin: '33AAAAA0000A1Z5', tax_id: '27AAPFU0939F1ZV', taxId: 'x', vat: 'x', constructor: 1 })).sort(),
  ['constructor', 'gstin', 'taxId', 'tax_id', 'vat'], 'unknown keys are refused (tax_id is the only tax key; this one is refused for the state)');
assert.equal(errorsOf({ ...GOOD, gstin: '33AAAAA0000A1Z5' }).gstin, 'This field is not accepted.');
assert.deepEqual(Object.keys(errorsOf(JSON.parse('{"__proto__": {"x": 1}, "full_name": "A", "country": "IN", "state": "TN", "city": "K", "postal_code": "639113"}'))), ['__proto__'],
  'a key named __proto__ is refused like any other');
assert.deepEqual(PROFILE_FIELDS.filter(name => /gst|tax|vat/i.test(name)), ['tax_id'], 'one tax id field');
assert.ok(!PROFILE_FIELDS.some(name => /card|cvv|upi|vpa|bank|ifsc|account|iban|pan$/i.test(name)), 'no card, UPI or bank field');
assert.equal(errorsOf({ ...GOOD, country: 'ZZ' }).country, 'Choose a country from the list.');
assert.equal(errorsOf({ ...GOOD, country: 'India' }).country, 'Choose a country from the list.', 'the code, not the name');
assert.equal(errorsOf({ ...GOOD, state: '' }).state, 'Choose your state or union territory.');
assert.equal(errorsOf({ ...GOOD, state: 'Atlantis' }).state, 'Choose a state or union territory from the list.');
assert.equal(errorsOf({ ...GOOD, city: '   ' }).city, 'Enter your city.');
assert.equal(errorsOf({ ...GOOD, full_name: 'x'.repeat(121) }).full_name, 'Full name must be at most 120 characters.');
assert.equal(errorsOf({ ...GOOD, full_name: 42 }).full_name, 'Full name must be text.');
assert.equal(errorsOf({ ...GOOD, city: { a: 1 } }).city, 'City must be text.');
assert.equal(errorsOf({ ...GOOD, customer_type: 'company' }).customer_type, 'Choose Individual or Business.');
assert.equal(errorsOf({ ...GOOD, customer_type: 'business' }).business_name, 'Enter the business name.');
assert.equal(errorsOf({ ...GOOD, customer_type: 'business', business_name: 'X' }).address_line1, 'Enter the business address.');
assert.equal(errorsOf({ ...GOOD, address_line2: 'Floor 2' }).address_line1, 'Enter address line 1 before address line 2.');
assert.equal(errorsOf({ ...GOOD, postal_code: '' }).postal_code, 'Enter your postal code.');
assert.equal(errorsOf({ ...GOOD, postal_code: '012345' }).postal_code, 'Enter a 6 digit PIN code.');
assert.equal(errorsOf({ ...GOOD, country: 'US', state: '', postal_code: 'ABCDE' }).postal_code, 'Enter a valid postal code for this country.');
assert.equal(errorsOf({ ...GOOD, phone: '12345' }).phone, 'Enter the number with its country code, for example +91 98765 43210.');
assert.deepEqual(errorsOf({ full_name: '', country: '', city: '', postal_code: '1', state: 'x' }).country, 'Choose your country.');
ok('normalisation (names, India states, PIN, E.164, control and bidirectional characters, NFC, code-point limits) and one message per refused field');

// ── Postal codes ──
const POSTAL_OK = { IN: ['110001', '639113'], US: ['73301', '73301-1234'], GB: ['SW1A 1AA', 'M1 1AE', 'sw1a1aa'], CA: ['K1A 0B1', 'k1a0b1'], AU: ['2000'], DE: ['10115'], FR: ['75001'],
  NL: ['1012 AB', '1012ab'], SG: ['018956'], JP: ['100-0001', '1000001'], BR: ['01310-100'], PL: ['00-950'], PT: ['1000-001'], SE: ['111 22'], CH: ['8001'], ZA: ['0001'], FI: ['00100'],
  IE: ['D02 X285'], BG: ['1000'] };
const POSTAL_BAD = { IN: ['011000', '12345', '1100011', 'ABCDEF'], US: ['1234', '123456', '73301-12'], GB: ['12345', 'SW1A'], CA: ['D1A 0B1', '123 456'], AU: ['200', '20000'],
  DE: ['1011', '101155'], NL: ['1012', '1012 A'], SG: ['01895'], JP: ['100-000', '10000011'], BR: ['0131-100'], PL: ['00950'] };
for (const [country, codes] of Object.entries(POSTAL_OK)) for (const code of codes) assert.equal(postalCodeValid(normalizePostalCode(code, country), country), true, `${country} ${code}`);
for (const [country, codes] of Object.entries(POSTAL_BAD)) for (const code of codes) assert.equal(postalCodeValid(normalizePostalCode(code, country), country), false, `${country} ${code}`);
assert.equal(postalCodeValid('AB', 'IE'), false, 'the generic shape needs 3 to 12 characters');
assert.equal(postalCodeValid('A'.repeat(13), 'IE'), false);
assert.equal(normalizePostalCode(' 639 113 ', 'IN'), '639113');
assert.equal(normalizePostalCode('sw1a   1aa', 'GB'), 'SW1A 1AA');
ok('postal codes: per-country shapes for the common countries, a generic shape for the rest');

// ── Phone numbers ──
for (const [input, country, expected] of [['+91 98765 43210', 'IN', '+919876543210'], ['98765 43210', 'IN', '+919876543210'], ['098765-43210', 'IN', '+919876543210'], ['919876543210', 'IN', '+919876543210'],
  ['0091 98765 43210', 'US', '+919876543210'], ['+1 (512) 555-0100', 'US', '+15125550100'], ['+44 20 7946 0958', 'GB', '+442079460958'], ['+971 4 123 4567', 'AE', '+97141234567']]) {
  assert.equal(normalizePhone(input, country), expected, `${input} (${country})`);
}
for (const [input, country] of [['98765 43210', 'US'], ['12345', 'IN'], ['+0 123 456 789', 'US'], ['+91 12345 67890', 'IN'], ['+911234', 'IN'], ['+1234567890123456', 'US'], ['phone', 'IN'], ['+91 98765 4321a', 'IN'], ['', 'IN'], [null, 'IN']]) {
  assert.equal(normalizePhone(input, country), null, `${input} (${country})`);
}
ok('phone numbers: E.164 from Indian mobiles with or without +91, 00 prefixes, other countries only with a country code');

// ── Stored rows, the Razorpay prefill and the form's rules ──
const row = { customer_type: 'individual', full_name: 'Asha Kumar', business_name: null, country: 'IN', state: 'TN', city: 'Karur', postal_code: '639113', address_line1: '6/2 N. Pugalur',
  address_line2: null, phone_e164: '+919876543210', created_at: 'x', updated_at: 'y' };
assert.deepEqual(publicProfile(row), { customer_type: 'individual', full_name: 'Asha Kumar', business_name: null, country: 'IN', state: 'TN', city: 'Karur', postal_code: '639113',
  address_line1: '6/2 N. Pugalur', address_line2: null, phone: '+919876543210', tax_id: null }, 'phone_e164 is called phone, timestamps are not shown');
assert.equal(publicProfile({ ...row, tax_id: '33ABCDE1234F1Z7' }).tax_id, '33ABCDE1234F1Z7');
assert.equal(publicProfile(null), null);
assert.equal(checkStoredProfile(row).ok, true);
assert.deepEqual(checkStoredProfile(null), { ok: false, missing: ['full_name', 'country', 'city', 'postal_code'] });
assert.deepEqual(checkStoredProfile({ ...row, city: null, postal_code: 'abc' }), { ok: false, missing: ['city', 'postal_code'] }, 'a stored profile is held to today\'s rules');
assert.deepEqual(checkStoredProfile({ ...row, tax_id: '29ABCDE1234F1ZW' }), { ok: false, missing: ['tax_id'] }, 'a stored GSTIN of another state is asked for again');
assert.equal(checkStoredProfile({ ...row, tax_id: '33ABCDE1234F1Z7' }).value.tax_id, '33ABCDE1234F1Z7');
assert.deepEqual(razorpayPrefill(publicProfile(row), 'a@example.test'), { email: 'a@example.test', name: 'Asha Kumar', contact: '+919876543210' });
assert.deepEqual(razorpayPrefill({ ...publicProfile(row), phone: null }, 'a@example.test'), { email: 'a@example.test', name: 'Asha Kumar' });
assert.equal(razorpayPrefill({ full_name: 'x'.repeat(80) }, '').name.length, 50, 'Razorpay allows 50 characters');
assert.equal(razorpayPrefill({ full_name: '\u{1F600}'.repeat(60) }, '').name, '\u{1F600}'.repeat(50), 'never cut inside a character');
assert.deepEqual(Object.keys(razorpayPrefill(publicProfile(row), 'a@example.test')), ['email', 'name', 'contact'], 'no address field can reach the prefill');
assert.deepEqual(Object.keys(razorpayPrefill({ ...publicProfile(row), tax_id: '33ABCDE1234F1Z7', business_name: 'X' }, 'a@example.test')), ['email', 'name', 'contact'],
  'nor the tax id or business name');
assert.deepEqual(requiredFields('IN', 'individual'), ['full_name', 'country', 'state', 'city', 'postal_code']);
assert.deepEqual(requiredFields('AE', 'individual'), ['full_name', 'country', 'city']);
assert.deepEqual(requiredFields('US', 'business'), ['full_name', 'country', 'business_name', 'city', 'postal_code', 'address_line1']);
ok('stored profile checks, Razorpay prefill (name, e-mail and phone only, 50 characters), required fields');

// ── Tax id: GSTIN in India, a VAT or tax id elsewhere; optional for every buyer ──
// The GSTN's check character, written here independently of src/billing/profile.js and billing-details.js.
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const checkCharacter = first14 => {
  let total = 0;
  [...first14].forEach((char, position) => {
    const weighted = ALPHABET.indexOf(char) * (position % 2 === 0 ? 1 : 2);
    total += Math.trunc(weighted / 36) + weighted % 36;
  });
  return ALPHABET[(36 - total % 36) % 36];
};
const gstin = first14 => first14 + checkCharacter(first14);
// A public example of the format (used in GST documentation): its check character is V.
assert.equal(checkCharacter('27AAPFU0939F1Z'), 'V');
assert.equal(gstinCheckCharacter('27AAPFU0939F1ZV'), 'V', 'the server computes the same check character');
const TN = gstin('33ABCDE1234F1Z');
const KA = gstin('29ABCDE1234F1Z');
assert.deepEqual([TN, KA], ['33ABCDE1234F1Z7', '29ABCDE1234F1ZW'], 'the fixtures check-dashboard.mjs uses');
// Valid GSTINs: the public example in Maharashtra, one per state and union territory, a few PAN and entity shapes.
assert.equal(valid({ ...GOOD, state: 'MH', postal_code: '400001', tax_id: '27AAPFU0939F1ZV' }).tax_id, '27AAPFU0939F1ZV');
for (const [code] of INDIA_STATES) {
  for (const prefix of GST_STATE_CODES[code]) {
    const id = gstin(`${prefix}AAACZ${String(1000 + Number(prefix)).slice(-4)}K${prefix === '25' ? '2' : '1'}Z`);
    assert.equal(valid({ ...GOOD, state: code, tax_id: id }).tax_id, id, `${code} ${id}`);
  }
}
for (const first14 of ['33AAACZ9999Z9Z', '33ZZZZZ0000A1Z', '33AAACZ1234AZZ', '33AAACZ1234A9Z']) {
  assert.equal(valid({ ...GOOD, tax_id: gstin(first14) }).tax_id, gstin(first14), first14);
}
// Every Indian state and union territory has a GST state code, and no two share one.
assert.deepEqual(Object.keys(GST_STATE_CODES).sort(), INDIA_STATES.map(([code]) => code).sort());
assert.equal(new Set(Object.values(GST_STATE_CODES).flat()).size, Object.values(GST_STATE_CODES).flat().length);
assert.ok(Object.values(GST_STATE_CODES).flat().every(code => /^(0[1-9]|[1-3][0-9])$/.test(code)));
assert.deepEqual([GST_STATE_CODES.TN, GST_STATE_CODES.KA, GST_STATE_CODES.MH, GST_STATE_CODES.DL, GST_STATE_CODES.TG, GST_STATE_CODES.AP, GST_STATE_CODES.LA, GST_STATE_CODES.DH],
  [['33'], ['29'], ['27'], ['07'], ['36'], ['37'], ['38'], ['26', '25']]);
// Normalisation: spaces removed, upper case; the state by name works too.
assert.equal(valid({ ...GOOD, tax_id: ' 33abcde 1234 f1z7 ' }).tax_id, TN, 'lower case and spaces');
assert.equal(valid({ ...GOOD, state: 'tamil nadu', tax_id: TN.toLowerCase() }).tax_id, TN, 'the state given by name is matched by its code');
assert.equal(valid({ ...GOOD, tax_id: '​33ABCDE1234F1Z7‮' }).tax_id, TN, 'invisible characters are dropped');
assert.equal(normalizeTaxId(' de 123\t456 789 '), 'DE123456789');
assert.equal(normalizeTaxId(undefined), '');
// Empty is "not given", and a PUT without it clears it.
for (const empty of ['', '   ', null, undefined]) assert.equal(valid({ ...GOOD, tax_id: empty }).tax_id, null, JSON.stringify(empty));
// Refusals, one message each.
const taxError = (body, message, label) => assert.equal(errorsOf(body).tax_id, message, label);
taxError({ ...GOOD, tax_id: TN.slice(0, 14) + (TN[14] === 'A' ? 'B' : 'A') }, 'This GSTIN\'s last character does not match the rest. Check it for a typo.', 'wrong check character');
taxError({ ...GOOD, tax_id: '27AAPFU0939F1ZW' }, 'This GSTIN\'s last character does not match the rest. Check it for a typo.');
taxError({ ...GOOD, tax_id: TN.slice(0, 14) }, 'A GSTIN has 15 letters and digits.', '14 characters');
taxError({ ...GOOD, tax_id: TN + '1' }, 'A GSTIN has 15 letters and digits.', '16 characters');
taxError({ ...GOOD, tax_id: 'X' }, 'A GSTIN has 15 letters and digits.');
taxError({ ...GOOD, tax_id: '33-ABCDE-1234F' }, 'A GSTIN has 15 letters and digits.');
for (const bad of [gstin('3AABCDE1234F1Z'), gstin('33ABCD11234F1Z'), gstin('33ABCDE123AF1Z'), gstin('33ABCDE12345FZ'), gstin('33ABCDE1234F0Z'), gstin('33ABCDE1234F1Y'), '33ABCDE1234F1Z-']) {
  taxError({ ...GOOD, tax_id: bad }, 'Enter a valid GSTIN: a 2 digit state code, the 10 character PAN, then 3 more characters.', bad);
}
taxError({ ...GOOD, tax_id: KA }, 'This GSTIN starts with 29, but the GST state code of Tamil Nadu is 33. Check the GSTIN or the state.', 'state code mismatch');
taxError({ ...GOOD, state: 'KA', postal_code: '560001', tax_id: TN }, 'This GSTIN starts with 33, but the GST state code of Karnataka is 29. Check the GSTIN or the state.');
taxError({ ...GOOD, state: 'DH', postal_code: '396210', tax_id: gstin('24AAACZ1234K1Z') }, 'This GSTIN starts with 24, but the GST state code of Dadra and Nagar Haveli and Daman and Diu is 26. Check the GSTIN or the state.');
taxError({ ...GOOD, tax_id: gstin('97AAACZ1234K1Z') }, 'This GSTIN starts with 97, but the GST state code of Tamil Nadu is 33. Check the GSTIN or the state.', '97 belongs to no state');
// No state to match (an unknown one has its own error): the GSTIN is checked without the state code.
{
  const errors = errorsOf({ ...GOOD, state: 'Atlantis', tax_id: KA });
  assert.deepEqual([errors.state, errors.tax_id], ['Choose a state or union territory from the list.', undefined]);
}
taxError({ ...GOOD, tax_id: 'A'.repeat(41) }, 'GSTIN or tax ID must be at most 40 characters.', 'over the limit');
taxError({ ...GOOD, country: 'US', state: 'Texas', postal_code: '73301', tax_id: 'A'.repeat(21) }, 'Enter a VAT or tax ID of 2 to 20 letters, digits or hyphens.', '21 characters');
taxError({ ...GOOD, tax_id: 42 }, 'GSTIN or tax ID must be text.');
// Other countries: a VAT or tax id of 2 to 20 letters, digits or hyphens.
const US = { ...GOOD, country: 'US', state: 'Texas', postal_code: '73301' };
for (const [typed, stored] of [['DE 123 456 789', 'DE123456789'], ['gb123456789', 'GB123456789'], ['12-3456789', '12-3456789'], ['AB', 'AB'], ['A'.repeat(20), 'A'.repeat(20)],
  [TN, TN], ['100 2345 6789 0003', '100234567890003']]) {
  assert.equal(valid({ ...US, tax_id: typed }).tax_id, stored, typed);
}
for (const bad of ['A', '-AB', 'AB-', 'DE_123', 'DE.123', 'DE/123', 'ÄB12', '<b>12</b>']) {
  taxError({ ...US, tax_id: bad }, 'Enter a VAT or tax ID of 2 to 20 letters, digits or hyphens.', bad);
}
// Individuals and businesses alike.
assert.equal(valid({ ...GOOD, customer_type: 'business', business_name: 'Zero X Labs', address_line1: '6/2 N. Pugalur', tax_id: TN }).tax_id, TN);
assert.equal(taxIdError('', 'IN', 'TN'), '');
assert.equal(taxIdError(KA, 'IN', ''), '', 'without a state the state code is not compared');
assert.equal(taxIdError(KA, 'IN', '__proto__'), '', 'only real state codes are compared');
ok('tax id: GSTINs with their check character (a public example, every state code, wrong check characters, lengths and shapes), the state code match, normalisation, empty clears, the length limit, other countries\' VAT ids');

// ── Legal versions: the constants and the pages they name cannot drift ──
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const effective = file => {
  const match = read(file).match(/Effective date: (\d{1,2}) (\w+) (\d{4})\./);
  assert.ok(match, `${file} states an effective date`);
  return `${match[3]}-${String(MONTHS.indexOf(match[2]) + 1).padStart(2, '0')}-${match[1].padStart(2, '0')}`;
};
assert.deepEqual(CONSENT_DOCUMENTS, ['terms', 'privacy', 'refund', 'auto_renewal']);
for (const name of CONSENT_DOCUMENTS) assert.match(LEGAL_DOCUMENTS[name].version, VERSION_PATTERN, `${name} version is a date`);
for (const [name, file] of [['terms', 'terms.html'], ['privacy', 'privacy.html'], ['refund', 'refund.html']]) {
  assert.equal(LEGAL_DOCUMENTS[name].version, effective(file), `${file} effective date = legal-versions ${name} (change both together)`);
  assert.equal(LEGAL_DOCUMENTS[name].path, '/' + name);
}
const termsHtml = read('terms.html');
assert.ok(termsHtml.includes('id="billing"') && LEGAL_DOCUMENTS.auto_renewal.path === '/terms#billing', 'the renewal notice links to the Billing and renewal section');
assert.ok(Object.isFrozen(LEGAL_DOCUMENTS) && Object.isFrozen(LEGAL_DOCUMENTS.terms));
assert.deepEqual(documentVersions(), { terms: LEGAL_DOCUMENTS.terms.version, privacy: LEGAL_DOCUMENTS.privacy.version, refund: LEGAL_DOCUMENTS.refund.version, auto_renewal: LEGAL_DOCUMENTS.auto_renewal.version });
assert.deepEqual(documentPublic().terms, { version: LEGAL_DOCUMENTS.terms.version, path: '/terms' });
assert.deepEqual(requiredDocuments('subscription'), ['terms', 'privacy', 'auto_renewal', 'refund']);
assert.deepEqual(requiredDocuments('topup'), ['terms', 'privacy', 'refund'], 'a one-time top-up has no renewal notice');
ok('document versions equal the effective dates of terms.html, privacy.html and refund.html; subscriptions need the renewal notice, top-ups do not');

// ── The browser step: pure helpers ──
const details = await import(new URL('billing-details.js', root));
const pricing = await import(new URL('pricing.js', root));
const checkout = await import(new URL('billing-checkout.js', root));
// The same required-field rule as the server, over every country and both customer types.
const noPostal = profileOptions().no_postal;
for (const [country] of COUNTRIES) {
  for (const type of CUSTOMER_TYPES) {
    assert.deepEqual(details.requiredFields(country, type, noPostal), requiredFields(country, type), `required fields for ${country} ${type}`);
  }
}
// The same tax id rule and messages, over every country, both customer types and every Indian state.
{
  const states = profileOptions().states;
  const sameError = (values, label) => {
    const server = normalizeProfile(values).errors?.tax_id;
    const browser = details.validateDetails(values, { noPostal, states }).tax_id;
    assert.equal(browser, server, label);
  };
  const samples = ['', '   ', TN, TN.toLowerCase(), ' 33abcde 1234 f1z7 ', KA, TN.slice(0, 14) + 'A', TN.slice(0, 14), TN + 'X', gstin('33ABCDE1234F0Z'), 'DE 123 456 789', 'AB', 'A', '-AB',
    'DE_123', 'A'.repeat(20), 'A'.repeat(21), 'A'.repeat(41), 'A '.repeat(20) + 'A', '\u200b' + TN];
  for (const [country] of COUNTRIES) {
    for (const type of CUSTOMER_TYPES) for (const tax_id of samples) sameError({ customer_type: type, country, state: country === 'IN' ? 'TN' : '', tax_id }, `${country} ${type} ${tax_id}`);
  }
  for (const [code] of INDIA_STATES) {
    for (const tax_id of [TN, KA, ...GST_STATE_CODES[code].map(prefix => gstin(`${prefix}AAACZ1234K1Z`)), gstin('97AAACZ1234K1Z')]) sameError({ country: 'IN', state: code, tax_id }, `IN ${code} ${tax_id}`);
  }
  sameError({ country: 'IN', state: '', tax_id: KA }, 'no state chosen yet');
  assert.deepEqual(details.GST_STATE_CODES, GST_STATE_CODES, 'the same state codes');
  for (const value of [TN, '27AAPFU0939F1ZV', KA]) assert.equal(details.gstinCheckCharacter(value), gstinCheckCharacter(value));
  for (const typed of [' 33abcde 1234 f1z7 ', 'de\t123', '', '\u200bAB\u202e']) assert.equal(details.normalizeTaxId(typed), normalizeTaxId(typed.normalize('NFC').replace(/[\u200b\u202e]/g, '')), typed);
  assert.equal(details.validateDetails({ full_name: 'A', country: 'IN', state: 'TN', city: 'K', postal_code: '639113', tax_id: KA }).tax_id, undefined,
    'without the state lists the browser leaves the state code to the server');
  assert.equal(details.taxIdLabel('IN'), 'GSTIN');
  assert.equal(details.taxIdLabel('US'), 'VAT or tax ID');
  assert.equal(details.taxIdLabel(''), 'VAT or tax ID');
}
assert.deepEqual(details.requiredDocuments('subscription'), requiredDocuments('subscription'));
assert.deepEqual(details.requiredDocuments('topup'), requiredDocuments('topup'));
// The messages for a missing field are the server's, so the form and the server say the same thing.
{
  const empty = normalizeProfile({ customer_type: 'business', country: 'IN' }).errors;
  const browser = details.validateDetails({ customer_type: 'business', country: 'IN' });
  for (const field of ['full_name', 'business_name', 'state', 'city', 'postal_code', 'address_line1']) assert.equal(browser[field], empty[field], `message for ${field}`);
}
// Price formatting follows pricing.js formatMoney.
for (const [minor, currency] of [[0, 'USD'], [1000, 'USD'], [1050, 'USD'], [89900, 'INR'], [349900, 'INR'], [44900, 'INR'], [174900, 'inr'], [4000, 'USD']]) {
  assert.equal(details.formatPrice(minor, currency), pricing.formatMoney(minor, currency), `${minor} ${currency}`);
}
assert.equal(details.formatPrice(NaN, 'USD'), '');
// validateDetails: required only; the server judges the rest.
assert.deepEqual(details.validateDetails(details.valuesFromProfile(null)), { full_name: 'Enter your full name.', country: 'Choose your country.', city: 'Enter your city.', postal_code: 'Enter your postal code.' });
assert.deepEqual(details.validateDetails({ customer_type: 'individual', full_name: 'A', country: 'IN', state: 'TN', city: 'K', postal_code: '1' }), {}, 'a bad PIN is the server\'s to refuse');
assert.deepEqual(details.validateDetails({ full_name: 'A', country: 'AE', city: 'Dubai' }, { noPostal }), {});
assert.equal(details.validateDetails({ full_name: 'A', country: 'AE', city: 'D', address_line2: 'x' }, { noPostal }).address_line1, 'Enter address line 1 before address line 2.');
assert.deepEqual(Object.keys(details.validateDetails({ customer_type: 'business', country: 'AE' }, { noPostal })), ['full_name', 'business_name', 'city', 'address_line1']);
// profilePayload: only non-empty values, trimmed; never an unknown key.
assert.deepEqual(details.profilePayload({ customer_type: 'business', full_name: ' A ', business_name: 'X', country: 'IN', state: 'TN', city: 'K', postal_code: '639113', address_line1: '', address_line2: '  ',
  phone: '', gstin: '33AAAAA0000A1Z5', extra: 1 }), { customer_type: 'business', full_name: 'A', business_name: 'X', country: 'IN', state: 'TN', city: 'K', postal_code: '639113' });
assert.deepEqual(details.profilePayload({}), { customer_type: 'individual' });
assert.deepEqual(details.profilePayload({ country: 'IN', tax_id: ' 33abcde 1234f1z7 ' }), { customer_type: 'individual', country: 'IN', tax_id: '33abcde 1234f1z7' }, 'the tax id as typed, trimmed (the server normalises it)');
assert.deepEqual(details.profilePayload({ country: 'IN', tax_id: '   ' }), { customer_type: 'individual', country: 'IN' }, 'an empty tax id is left out, so the PUT clears it');
assert.deepEqual(details.valuesFromProfile({ ...publicProfile(row), gstin: 'x', evil: '<script>' }), { customer_type: 'individual', full_name: 'Asha Kumar', business_name: '', country: 'IN', state: 'TN', city: 'Karur',
  postal_code: '639113', address_line1: '6/2 N. Pugalur', address_line2: '', tax_id: '', phone: '+919876543210' }, 'unknown keys are dropped');
assert.equal(details.valuesFromProfile({ ...publicProfile(row), tax_id: TN }).tax_id, TN, 'a saved tax id prefills the form');
// parseDetailsResponse treats everything as untrusted.
{
  const parsed = details.parseDetailsResponse({ profile: publicProfile(row), complete: true, documents: { ...documentPublic(), terms: { version: '<b>', path: '/x' }, extra: { version: '2026-01-01', path: '/' } },
    accepted: { terms: { version: '2026-10-25', accepted_at: '2026-10-20T10:00:00.000Z', current: true }, privacy: 'x' }, tax: { no_gst_notice: 'true' },
    options: { countries: [{ code: 'IN', name: 'India' }, { code: 5 }, null], states: { IN: [{ code: 'TN', name: 'Tamil Nadu' }], lower: [{ code: 'x', name: 'y' }] }, no_postal: ['AE', 'ae', 5] } });
  assert.equal(parsed.complete, true);
  assert.equal(parsed.noGst, false, 'only a real true turns the GST statement on');
  assert.equal(parsed.documents.terms, undefined, 'a document without a date version is dropped');
  assert.deepEqual(Object.keys(parsed.documents).sort(), ['auto_renewal', 'privacy', 'refund']);
  assert.deepEqual(parsed.countries, [{ code: 'IN', name: 'India' }]);
  assert.deepEqual(Object.keys(parsed.states), ['IN']);
  assert.deepEqual(parsed.noPostal, ['AE']);
  assert.deepEqual(Object.keys(parsed.accepted), ['terms']);
  assert.equal(details.parseDetailsResponse(null).complete, false);
  assert.equal(details.parseDetailsResponse({ profile: null, complete: true }).complete, false, 'complete needs a profile');
  assert.equal(details.parseDetailsResponse({ options: { countries: 'x' } }).countries.length, 0);
}
// Which boxes to tick, and what is sent.
{
  const data = details.parseDetailsResponse({ profile: publicProfile(row), complete: true, documents: documentPublic(), tax: { no_gst_notice: false },
    accepted: { terms: { version: LEGAL_DOCUMENTS.terms.version, accepted_at: '2026-10-20T10:00:00.000Z', current: true },
      privacy: { version: '2026-01-01', accepted_at: '2026-01-02T10:00:00.000Z', current: false },
      refund: { version: LEGAL_DOCUMENTS.refund.version, accepted_at: '2026-10-20T10:00:00.000Z', current: true },
      auto_renewal: { version: LEGAL_DOCUMENTS.auto_renewal.version, accepted_at: '2026-10-20T10:00:00.000Z', current: true } }, options: {} });
  assert.deepEqual(details.documentsToTick('subscription', data), ['privacy', 'auto_renewal'], 'an old version is ticked again; the renewal notice always is');
  assert.deepEqual(details.documentsToTick('topup', data), ['privacy']);
  assert.deepEqual(details.documentsToTick('topup', { documents: {}, accepted: {} }), ['terms', 'privacy', 'refund'], 'unknown documents are never skipped');
  assert.deepEqual(details.consentBody(data.documents, ['privacy', 'auto_renewal']), { privacy: LEGAL_DOCUMENTS.privacy.version, auto_renewal: LEGAL_DOCUMENTS.auto_renewal.version });
  assert.deepEqual(details.consentBody(data.documents, ['cookies']), {});
}
// The order summary and the GST notice.
{
  const plan = pricing.PLAN_CATALOG.plans.find(entry => entry.id === 'pro');
  const pack = pricing.PLAN_CATALOG.topups[0];
  const NOW = Date.parse('2026-11-03T10:00:00Z');
  assert.deepEqual(details.summaryRows({ kind: 'subscription', plan, currency: 'INR', now: NOW }), [
    { label: 'Plan', value: 'Neuron Pro' }, { label: 'Billing', value: 'Monthly, renews until you cancel' }, { label: 'Price', value: '₹899 per month' },
    { label: 'Credits included', value: '$8 every month' }, { label: 'Due today', value: '₹899' }, { label: 'First renewal', value: 'About 3 December 2026, then monthly' }]);
  assert.deepEqual(details.summaryRows({ kind: 'subscription', plan: pricing.PLAN_CATALOG.plans[2], currency: 'USD', noGst: true, now: NOW }).map(row => [row.label, row.value]), [
    ['Plan', 'Neuron Max'], ['Billing', 'Monthly, renews until you cancel'], ['Price', '$40 per month'], ['Credits included', '$35 every month'], ['Tax', 'No GST charged'],
    ['Due today', '$40'], ['First renewal', 'About 3 December 2026, then monthly']]);
  assert.deepEqual(details.summaryRows({ kind: 'topup', pack, currency: 'INR', now: NOW }), [{ label: 'Item', value: '$5 of Neuron credits' }, { label: 'Payment', value: 'One time, no renewal' },
    { label: 'Price', value: '₹449' }, { label: 'Due today', value: '₹449' }]);
  assert.ok(details.summaryRows({ kind: 'topup', pack, currency: 'USD', noGst: true }).some(row => row.label === 'Tax' && row.value === 'No GST charged'));
  for (const kind of ['subscription', 'topup']) {
    assert.ok(!JSON.stringify(details.summaryRows({ kind, plan, pack, currency: 'INR' })).includes('GST'), 'no GST wording unless the flag is on');
  }
  for (const [from, expected] of [['2026-01-31T00:00:00Z', '28 February 2026'], ['2024-01-31T00:00:00Z', '29 February 2024'], ['2026-12-15T00:00:00Z', '15 January 2027'],
    ['2026-03-31T23:59:59Z', '30 April 2026'], ['2026-11-03T00:00:00Z', '3 December 2026']]) {
    assert.equal(details.nextChargeDate(Date.parse(from)), expected, from);
  }
  const data = details.parseDetailsResponse({ options: { countries: [{ code: 'IN', name: 'India' }], states: { IN: [{ code: 'TN', name: 'Tamil Nadu' }] } } });
  assert.deepEqual(details.addressLines({ ...details.valuesFromProfile(publicProfile(row)), business_name: 'Zero X Labs' }, data),
    ['Zero X Labs', '6/2 N. Pugalur', 'Karur, Tamil Nadu 639113', 'India']);
  assert.deepEqual(details.addressLines({ country: 'XX', city: 'Somewhere' }, data), ['Somewhere', 'XX']);
}
// The consent wording names the document it stands for and the renewal terms of this purchase.
{
  assert.deepEqual(details.consentText('terms'), ['I have read and agree to the ', 'Terms of Service', '.']);
  assert.match(details.consentText('privacy')[2], /how Zero-X uses my billing details/);
  assert.match(details.consentText('auto_renewal', { planName: 'Pro', price: '₹899' })[0], /Pro plan renews every month at ₹899 until I cancel.*authorise Razorpay.*cancel any time from Billing/);
  assert.match(details.RENEWAL_NOTICE, /renews monthly until you cancel.*bank or Razorpay may notify you before each charge/);
  assert.match(details.PROCESSOR_NOTICE, /Zero-X never sees your card details/);
  assert.ok(!/gst|tax/i.test(details.DATA_NOTICE + details.RENEWAL_NOTICE + details.ONE_TIME_NOTICE + details.PROCESSOR_NOTICE), 'no tax claims in the fixed texts');
  // The tax id note says what is true and nothing more: own records, not sent to Razorpay, not registered, no GST, no GST invoice.
  assert.equal(details.TAX_ID_HINT, 'Optional. It is saved with your billing details for your own records and is not sent to Razorpay. Zero-X is not registered for GST, so no GST is charged and no GST invoice is issued.');
  assert.doesNotMatch(details.TAX_ID_HINT, /input tax credit|claim|tax invoice will|we will issue|deductible|exempt/i);
}
// purchaseWithDetails: one retry for a stale step, never a loop.
{
  const collected = [];
  const collect = async options => { collected.push(options.kind); return { consent: { terms: '2026-10-25' } }; };
  const begun = [];
  assert.equal(await details.purchaseWithDetails({ kind: 'topup' }, async consent => { begun.push(consent); return 'paid'; }, { collect }), 'paid');
  assert.deepEqual([collected.length, begun.length], [1, 1]);
  let calls = 0;
  assert.equal(await details.purchaseWithDetails({ kind: 'topup' }, async () => { calls += 1; if (calls === 1) throw new checkout.ApiError('x', { code: 'consent_required' }); return 'ok'; }, { collect }), 'ok');
  assert.equal(collected.length, 3, 'the step ran again after consent_required');
  calls = 0;
  await assert.rejects(details.purchaseWithDetails({ kind: 'topup' }, async () => { calls += 1; throw new checkout.ApiError('x', { code: 'billing_profile_required' }); }, { collect }), { code: 'billing_profile_required' });
  assert.equal(calls, 2, 'one retry, then the refusal');
  await assert.rejects(details.purchaseWithDetails({ kind: 'topup' }, async () => { throw new checkout.ApiError('x', { code: 'already_subscribed' }); }, { collect }), { code: 'already_subscribed' });
  await assert.rejects(details.purchaseWithDetails({ kind: 'topup' }, async () => 'never', { collect: async () => { throw new checkout.ApiError('closed', { code: 'checkout_dismissed' }); } }), { code: 'checkout_dismissed' });
  await assert.rejects(details.collectBillingDetails({ kind: 'gift' }), { code: 'invalid_request' });
}
// billing-checkout.js: the new codes, error fields, consent in the request, the phone in the prefill.
{
  assert.match(checkout.describeError({ code: 'billing_plan_missing' }), /Checkout for this plan is not set up yet\. Email support@zero-x\.live/);
  assert.match(checkout.describeError({ code: 'billing_profile_required' }), /billing details/);
  assert.match(checkout.describeError({ code: 'consent_required' }), /accept the current terms/);
  const error = checkout.parseApiError(400, { error: { message: 'Enter a 6 digit PIN code.', code: 'invalid_request', param: 'postal_code', fields: { postal_code: 'Enter a 6 digit PIN code.', 'Bad Key': 'x', phone: 7 }, missing: ['city', 5] } });
  assert.deepEqual([error.param, error.fields, error.missing], ['postal_code', { postal_code: 'Enter a 6 digit PIN code.' }, ['city']], 'only well-formed fields are kept');
  assert.deepEqual(checkout.parseApiError(500, null).fields, {});
  const calls = [];
  const fetchImpl = async (path, options) => { calls.push({ path, body: JSON.parse(options.body) }); return new Response(JSON.stringify({ provider: 'razorpay', key_id: 'rzp_test_AbCdEf123456', subscription_id: 'sub_TEST12345' }), { status: 200, headers: { 'Content-Type': 'application/json' } }); };
  const auth = { getAccessToken: async () => 'token' };
  const win = { Razorpay: class { constructor(options) { this.options = options; } on() {} open() { throw new Error('opened'); } } };
  await assert.rejects(checkout.startSubscription({ plan: 'pro', currency: 'INR', consent: { terms: '2026-10-25', privacy: 'yes', 'bad key': '2026-10-25', refund: '2026-10-24' }, auth, fetchImpl, win }), /opened/);
  assert.deepEqual(calls[0].body, { plan: 'pro', currency: 'INR', consent: { terms: '2026-10-25', refund: '2026-10-24' } }, 'only well-formed document versions are sent');
  await assert.rejects(checkout.startTopup({ pack: 'credits_5', currency: 'USD', auth, fetchImpl, win }), /opened/);
  assert.deepEqual(calls[1].body, { pack: 'credits_5', currency: 'USD' }, 'a caller without consent sends none');
  const prefilled = checkout.checkoutOptions({ provider: 'razorpay', key_id: 'rzp_test_AbCdEf123456', subscription_id: 'sub_TEST12345', prefill: { email: 'a@example.test', name: 'Asha', contact: '+919876543210', address: '6/2 N. Pugalur' } });
  assert.deepEqual(prefilled.prefill, { email: 'a@example.test', name: 'Asha', contact: '+919876543210' }, 'name, e-mail and phone; nothing else is passed on');
  assert.deepEqual(checkout.checkoutOptions({ provider: 'razorpay', key_id: 'rzp_test_AbCdEf123456', subscription_id: 'sub_TEST12345', prefill: { email: 'a@example.test', name: 'Asha', contact: '98765' } }).prefill,
    { email: 'a@example.test', name: 'Asha' }, 'a phone that is not E.164 is not passed on');
}
// Source rules for the step: nothing sensitive is stored, no unsafe HTML sinks, no card, UPI or bank field, the tax id kept from Razorpay.
{
  const source = read('billing-details.js');
  assert.doesNotMatch(source, /localStorage|sessionStorage|document\.cookie|indexedDB/, 'details are held in memory only');
  assert.doesNotMatch(source, /\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML|document\.write|\beval\(|new Function\(/, 'no unsafe HTML or code sink');
  assert.doesNotMatch(source, /fetch\(/, 'network calls go through apiFetch');
  const code = source.replace(/\/\/[^\n]*/g, '');
  assert.match(code, /field\('tax_id'/, 'the optional tax id field');
  assert.doesNotMatch(code, /card.?number|\bcvv\b|\bcvc\b|upi.?id|\bvpa\b|\bifsc\b|account.?number|\biban\b|expiry/i, 'no card, UPI or bank field');
  assert.doesNotMatch(source, /Claude|Anthropic/, 'no provider names in the step');
  const serverCode = read('neuroncli/auth-server/src/billing/profile.js').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(serverCode, /card.?number|\bcvv\b|\bcvc\b|upi.?id|\bvpa\b|\bifsc\b|account.?number|\biban\b|expiry/i);
  // The tax id never goes to Razorpay: the prefill names only the name, e-mail and phone, and no route puts profile fields in notes.
  assert.doesNotMatch(read('neuroncli/auth-server/src/routes/billing.js'), /tax_id|business_name|address_line/);
}
ok('browser step: required-field and tax id rules equal the server\'s for every country, customer type and Indian state; prices, summary rows (no GST unless the server says so), renewal date, consent wording, retry rule, error fields, consent and phone in requests');

console.log(`PASS: billing details validation (${passed.length} groups)`);

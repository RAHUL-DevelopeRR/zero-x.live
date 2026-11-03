// Versions of the documents a buyer agrees to at checkout (consent records name them), and the
// documents each kind of purchase needs agreement to.
//
// terms, privacy and refund carry the "Effective date" of the page of the same name (terms.html,
// privacy.html, refund.html at the site root), written YYYY-MM-DD. check-billing-profile.mjs fails
// when a page's effective date and its version here differ, so publishing a new version of a page
// means changing it here in the same commit: buyers are then asked to agree again at their next
// checkout (billing_consents keeps what each one agreed to and when).
//
// auto_renewal is the notice shown beside the Subscribe button (billing-details.js: the monthly
// charge, how to cancel, and that the bank or Razorpay notifies before each charge). It is not a
// page; change its version whenever the wording of that notice changes.

export const LEGAL_DOCUMENTS = Object.freeze({
  terms: Object.freeze({ version: '2026-10-25', path: '/terms' }),
  privacy: Object.freeze({ version: '2026-10-25', path: '/privacy' }),
  refund: Object.freeze({ version: '2026-10-24', path: '/refund' }),
  auto_renewal: Object.freeze({ version: '2026-11-03', path: '/terms#billing' }),
});

export const CONSENT_DOCUMENTS = Object.freeze(Object.keys(LEGAL_DOCUMENTS));
export const VERSION_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// A subscription renews every month, so the renewal notice is agreed to too; a top-up is a
// one-time payment.
export const requiredDocuments = kind => kind === 'subscription'
  ? ['terms', 'privacy', 'auto_renewal', 'refund']
  : ['terms', 'privacy', 'refund'];

export const documentVersions = () => Object.fromEntries(CONSENT_DOCUMENTS.map(name => [name, LEGAL_DOCUMENTS[name].version]));
export const documentPublic = () => Object.fromEntries(CONSENT_DOCUMENTS.map(name => [name, { ...LEGAL_DOCUMENTS[name] }]));

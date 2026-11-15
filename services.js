// Zero-X Studio services page (services.html at services.zero-x.live): the WhatsApp buttons.
// The business number lives on <body data-whatsapp="">. Until it holds a valid international number
// (digits only, country code first, 10 to 15 digits, e.g. 919XXXXXXXXX) every WhatsApp link stays
// hidden and the mailto buttons, which work without JavaScript, carry the enquiry. No HTML is built
// here: links get their href, rel and target through setAttribute and are shown through `hidden`.

const WHATSAPP_NUMBER = /^[1-9]\d{9,14}$/;
const WHATSAPP_BASE = 'https://wa.me/';

/**
 * The wa.me link that opens a chat with `number` and `text` prefilled, or null when `number` is not
 * a digits-only international number of 10 to 15 digits (no "+", spaces or leading zero).
 */
export function whatsappHref(number, text) {
  if (typeof number !== 'string' || !WHATSAPP_NUMBER.test(number)) return null;
  const message = typeof text === 'string' ? text.trim() : '';
  return WHATSAPP_BASE + number + (message ? '?text=' + encodeURIComponent(message) : '');
}

/** Points every `a[data-wa-text]` in `doc` at WhatsApp and shows it, or keeps it hidden; returns how many were shown. */
export function installWhatsapp(doc) {
  const number = ((doc.body && doc.body.dataset.whatsapp) || '').trim();
  let shown = 0;
  for (const link of doc.querySelectorAll('a[data-wa-text]')) {
    const href = whatsappHref(number, link.dataset.waText);
    if (!href) {
      link.hidden = true;
      continue;
    }
    link.setAttribute('href', href);
    link.setAttribute('rel', 'noopener');
    link.setAttribute('target', '_blank');
    link.hidden = false;
    shown += 1;
  }
  return shown;
}

if (typeof document !== 'undefined') installWhatsapp(document);

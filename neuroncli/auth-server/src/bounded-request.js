import { carryCallerCountry } from './catalog.js';

/**
 * The request a route sees after the gateway counted its body (src/index.js body limit middleware).
 * The bytes are exactly the bytes read; Content-Length is set from them (a stale or lying original
 * is replaced, Transfer-Encoding dropped) and every other header, raw.cf and the caller country are
 * kept, so a signature over the raw body (Razorpay webhook) and a country policy still hold.
 */
export function boundedRequest(raw, bytes) {
  const headers = new Headers(raw.headers);
  headers.delete('transfer-encoding');
  headers.set('content-length', String(bytes.byteLength));
  const bounded = new Request(raw, { headers, body: bytes, duplex: 'half' });
  if (raw.cf) bounded.cf = raw.cf;
  return carryCallerCountry(raw, bounded);
}

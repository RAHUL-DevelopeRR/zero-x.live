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
  // Built from the URL, not from `raw`: its body is already read, and the Workers runtime refuses to
  // construct a Request from a used one. `cf` goes in through the init, where workerd accepts it;
  // assigning it afterwards throws there because the property is read-only.
  const init = { method: raw.method, headers, body: bytes, redirect: raw.redirect };
  if (raw.cf) init.cf = raw.cf;
  return carryCallerCountry(raw, new Request(raw.url, init));
}

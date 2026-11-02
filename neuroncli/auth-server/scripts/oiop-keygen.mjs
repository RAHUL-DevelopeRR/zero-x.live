#!/usr/bin/env node
// Makes the OIOP registry signing key (docs/OIOP.md): an Ed25519 private JWK for the Worker
// secret OIOP_SIGNING_JWK, and its public half, which /oiop/keys.json serves.
//
//   node scripts/oiop-keygen.mjs > oiop-signing.jwk       # keep this file out of the repo
//   wrangler secret put OIOP_SIGNING_JWK < oiop-signing.jwk
//
// The private key goes to stdout only; the key id and public key go to stderr.
import { keyId, publicJwkOf } from '../src/oiop/manifest.js';

const { privateKey } = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const jwk = await crypto.subtle.exportKey('jwk', privateKey);
const secret = { kty: 'OKP', crv: 'Ed25519', d: jwk.d, x: jwk.x };
process.stdout.write(`${JSON.stringify(secret)}\n`);
console.error(`key id: ${await keyId(secret)}`);
console.error(`public: ${JSON.stringify(publicJwkOf(secret))}`);

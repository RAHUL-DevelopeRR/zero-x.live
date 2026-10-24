// Caller data policy (docs/PLATFORM_CONTRACT.md §12.2): which offers may see a caller's prompts.
// A coding agent sends source code, so callers choose the trust tiers they accept and whether
// offers that may train on inputs are allowed. The choice travels with each request (the Neuron
// client keeps it in its settings); the gateway enforces it on routing and /v1/models, and it can
// only narrow what the caller's plan already allows.
//   X-Neuron-Trust-Tiers: T0,T1        default T0,T1,T2 (T3, unknown or reseller, never by default)
//   X-Neuron-Allow-Training: false     default true; false keeps only offers with trains_on_inputs=no
import { TRUST_TIERS } from './offers.js';

export const TRUST_HEADER = 'x-neuron-trust-tiers';
export const TRAINING_HEADER = 'x-neuron-allow-training';
export const DEFAULT_TRUST_TIERS = Object.freeze(['T0', 'T1', 'T2']);
export const DEFAULT_POLICY = Object.freeze({ trustTiers: DEFAULT_TRUST_TIERS, allowTraining: true });

const header = (headers, name) => {
  const value = typeof headers?.get === 'function' ? headers.get(name) : headers?.[name];
  return typeof value === 'string' ? value.trim() : '';
};

// The caller's policy from request headers. Unknown tiers are ignored; a header that names no
// known tier keeps the default rather than blocking every offer by accident.
export function callerPolicy(headers) {
  const tiers = header(headers, TRUST_HEADER).toUpperCase().split(',').map(value => value.trim())
    .filter(value => TRUST_TIERS.includes(value));
  const training = header(headers, TRAINING_HEADER).toLowerCase();
  return Object.freeze({
    trustTiers: Object.freeze(tiers.length ? [...new Set(tiers)].sort() : DEFAULT_TRUST_TIERS),
    allowTraining: !['false', '0', 'no', 'off'].includes(training),
  });
}

// Why `policy` keeps the caller away from `offer` ('trust_tier' | 'training'), or null.
export function policyBlock(offer, policy = DEFAULT_POLICY) {
  if (!offer) return 'trust_tier';
  if (!policy.trustTiers.includes(offer.trust_tier)) return 'trust_tier';
  if (!policy.allowTraining && offer.trains_on_inputs !== 'no') return 'training';
  return null;
}

export function describePolicy(policy) {
  return `trust tiers ${policy.trustTiers.join(', ')}${policy.allowTraining ? '' : '; no training on inputs'}`;
}

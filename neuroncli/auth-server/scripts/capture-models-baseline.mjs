#!/usr/bin/env node
// Captures fixtures/v1-models-baseline.json: GET /v1/models (listModelsForCaller) of the code
// catalog for a fixed matrix of deployments, plans, countries and caller data policies. The
// fixture was taken once from the code catalog before the data-driven catalog was wired in
// (src/catalog-db.js); check-catalog-db.mjs proves that the seeded database rows produce the
// same list (minus the two anthropic/* models they add). Re-capturing it is a deliberate act:
// only do it when a reviewed change to the code catalog is meant to change /v1/models.
//
//   node scripts/capture-models-baseline.mjs [--catalog <path to catalog.js>] [--out <file>]
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const KEYS = Object.freeze({
  GEMINI_API_KEY: 'gemini-free-key', GEMINI_PAID_API_KEY: 'gemini-paid-key', GROQ_API_KEY: 'groq-free-key',
  GROQ_PAID_API_KEY: 'groq-paid-key', NVIDIA_API_KEY: 'nvidia-key', OPENROUTER_API_KEY: 'openrouter-key',
  ANTHROPIC_API_KEY: 'anthropic-key', AI: {},
});
const HOSTED = Object.freeze({ NVIDIA_HOSTED: 'true', OPENROUTER_HOSTED: 'true', CLOUDFLARE_PAID: 'true' });

export const BASELINE_ENVS = Object.freeze({
  bare: {},
  keys: { ...KEYS, ...HOSTED },
  keys_unhosted: { ...KEYS },
  narrowed: { ...KEYS, ...HOSTED, CLOUDFLARE_MODELS: '@cf/openai/gpt-oss-120b', GEMINI_MODELS: 'gemini-2.5-flash,gemini-2.5-pro',
    NVIDIA_MODELS: 'openai/gpt-oss-20b' },
  free_only: { GEMINI_API_KEY: 'gemini-free-key', GROQ_API_KEY: 'groq-free-key', AI: {}, ALLOW_UNKNOWN_COUNTRY: 'true' },
});
export const BASELINE_PLANS = Object.freeze({
  anonymous: { plan: 'free' },
  free: { plan: 'free', tiers: ['free'] },
  pro: { plan: 'pro', tiers: ['free', 'paid'] },
  max: { plan: 'max' },
});
export const BASELINE_COUNTRIES = Object.freeze(['US', 'DE', 'IN', 'T1', null]);
export const BASELINE_POLICIES = Object.freeze({
  default: { trustTiers: ['T0', 'T1', 'T2'], allowTraining: true },
  t0_only: { trustTiers: ['T0'], allowTraining: true },
  no_training: { trustTiers: ['T0', 'T1', 'T2'], allowTraining: false },
});

export function baselineCases() {
  const cases = [];
  for (const [envName, env] of Object.entries(BASELINE_ENVS)) {
    for (const [planName, plan] of Object.entries(BASELINE_PLANS)) {
      for (const country of BASELINE_COUNTRIES) {
        for (const [policyName, policy] of Object.entries(BASELINE_POLICIES)) {
          cases.push({ name: `${envName}/${planName}/${country ?? 'unknown'}/${policyName}`, env,
            options: { ...plan, country, policy } });
        }
      }
    }
  }
  return cases;
}

async function main() {
  const { values } = parseArgs({ options: { catalog: { type: 'string' }, out: { type: 'string' } } });
  const catalogPath = resolve(values.catalog || fileURLToPath(new URL('../src/catalog.js', import.meta.url)));
  const out = resolve(values.out || fileURLToPath(new URL('../fixtures/v1-models-baseline.json', import.meta.url)));
  const { listModelsForCaller } = await import(pathToFileURL(catalogPath).href);
  const items = [];
  const index = new Map();
  const cases = baselineCases().map(({ name, env, options }) => {
    const data = JSON.parse(JSON.stringify(listModelsForCaller({ ...env }, options).data));
    return {
      name, env, options,
      data: data.map(model => {
        const key = JSON.stringify(model);
        if (!index.has(key)) { index.set(key, items.length); items.push(model); }
        return index.get(key);
      }),
    };
  });
  const fixture = {
    description: 'GET /v1/models (listModelsForCaller) of the code catalog before the data-driven catalog, for a fixed ' +
      'matrix of deployments, plans, countries and data policies. data[] indexes items[]. Captured by ' +
      'scripts/capture-models-baseline.mjs; check-catalog-db.mjs compares the seeded database rows against it.',
    captured_from: 'feat/claude-data-catalog at 304fad2 (src/catalog.js before src/catalog-db.js was wired in)',
    models: [...new Set(items.map(item => item.id))],
    items,
    cases,
  };
  writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
  console.log(`wrote ${out}: ${cases.length} cases, ${items.length} distinct model items, ${fixture.models.length} model ids`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();

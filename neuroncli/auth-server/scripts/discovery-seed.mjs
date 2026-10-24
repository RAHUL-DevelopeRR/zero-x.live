#!/usr/bin/env node
// Operator tool: (re)writes the seed section of migrations/20261019120000_provider_discovery.sql
// from the provider database research (provider-db.json, record schema SCHEMA.json).
//
//   node scripts/discovery-seed.mjs path/to/provider-db.json          # dry run: prints counts
//   node scripts/discovery-seed.mjs path/to/provider-db.json --write  # rewrites the seed section
//
// Only for a migration that has not been applied anywhere yet; later changes need a new migration.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { CATALOG } from '../src/catalog.js';
import { candidateRow, evaluateOffer, exclusionReason, httpsUrl, providerId } from '../src/discovery/policy.js';

export const SEED_SOURCE = 'seed:2026-10-19';
const SEEN_AT = '2026-10-19T00:00:00Z';
const MIGRATION = fileURLToPath(new URL('../migrations/20261019120000_provider_discovery.sql', import.meta.url));
const BEGIN = '-- BEGIN SEED';
const END = '-- END SEED';
// Catalog provider ids (src/catalog.js) as named in the provider database.
export const CATALOG_PROVIDER_IDS = Object.freeze({
  gemini: 'google-gemini', cloudflare: 'cloudflare-workers-ai', groq: 'groq', nvidia: 'nvidia', openrouter: 'openrouter',
});
const NOT_FREE = new Set(['paid_only_now', 'retired', 'unclear']);

const clip = (value, max) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined);
const prune = value => JSON.parse(JSON.stringify(value, (key, item) => (item === null || item === '' ? undefined : item)));

// The SCHEMA.json fields a reviewer needs, kept small enough for the record column (32 KB).
function providerRecord(p) {
  const signup = p.signup && typeof p.signup === 'object'
    ? { card_required: p.signup.card_required, phone_required: p.signup.phone_required, kyc: clip(p.signup.kyc, 160),
      india_available: p.signup.india_available, region_notes: clip(p.signup.region_notes, 300) }
    : clip(p.signup, 300);
  return prune({
    id: p.id, name: clip(p.name, 120), kind: p.kind, free_status: p.free_status,
    free_status_note: clip(p.free_status_note, 400), base_url: httpsUrl(p.base_url) || undefined,
    api_shape: p.api_shape, auth: clip(p.auth, 200), signup,
    limits: p.limits && {
      rpm: p.limits.rpm, rpd: p.limits.rpd, tpm: p.limits.tpm, tpd: p.limits.tpd, concurrency: p.limits.concurrency,
      scope: p.limits.scope, other: clip(p.limits.other, 300),
    },
    reset: p.reset, status_page: httpsUrl(p.status_page) || undefined, terms: clip(p.terms, 300),
    data_training_free_tier: clip(p.data_training_free_tier, 160), excluded_reason: clip(p.excluded_reason, 300),
    health_probe: p.health_probe && { request: clip(p.health_probe.request ?? p.health_probe.url, 300),
      auth_required: p.health_probe.auth_required },
    sources: (p.sources || []).map(url => httpsUrl(url)).filter(Boolean).slice(0, 6),
    verified_date: p.verified_date, layers: p.layers, notes: clip(p.notes, 600),
  });
}

export function seedRows(db) {
  const rows = new Map();
  const put = row => { if (row) rows.set(`${row.provider}\u0000${row.model_id}`, row); };
  for (const p of db.providers || []) {
    const provider = providerId(p.id);
    if (!provider) continue;
    const exclusion = exclusionReason(p);
    const evidence = (p.sources || []).map(url => httpsUrl(url)).find(Boolean) || null;
    put(candidateRow({ source: SEED_SOURCE, provider, displayName: p.name, evidenceUrl: evidence,
      notes: exclusion ? null : `Reference record from the 19 Oct research (free_status=${p.free_status}).`,
      record: providerRecord(p) },
    exclusion ? { status: 'excluded', reason: exclusion } : { status: 'rejected', reason: null }));
    for (const m of p.free_models || []) {
      const context = Number.isSafeInteger(m.context_window) ? m.context_window : null;
      const tools = m.tool_calling === true || m.tool_calling === false ? m.tool_calling : null;
      const policy = exclusion ? { status: 'excluded', reason: exclusion }
        : NOT_FREE.has(p.free_status) ? { status: 'rejected', reason: `provider free_status=${p.free_status}` }
          : evaluateOffer({ tools, context }, { strict: true });
      const trial = p.free_status === 'trial_only' ? 'trial credit only'
        : p.free_status === 'unverified_catalog' ? 'OmniRoute claim, not re-verified' : null;
      put(candidateRow({ source: SEED_SOURCE, provider, model: m.id, context, maxOutput: m.max_output, tools,
        evidenceUrl: evidence, notes: trial, record: prune({ notes: clip(m.notes, 200) }) }, policy));
    }
  }
  // Live in src/catalog.js: verified by the operator's own probes.
  for (const entry of CATALOG) {
    const provider = CATALOG_PROVIDER_IDS[entry.provider];
    const row = candidateRow({ source: SEED_SOURCE, provider, model: entry.upstream_model, displayName: entry.display_name,
      context: entry.context_window, maxOutput: entry.max_output_tokens, tools: entry.supports_tools,
      vision: entry.supports_vision, notes: `In src/catalog.js as ${entry.id}.` }, { status: 'new', reason: null });
    if (row) put({ ...row, status: 'verified', reviewed: true });
  }
  return [...rows.values()];
}

export function seedSql(rows) {
  // Compact: the source is a constant, null fields are left out, and model rows point to their
  // provider's record (and evidence) instead of repeating it.
  const json = JSON.stringify(rows.map(({ source, reviewed, record, evidence_url, ...row }) => prune({
    ...row, reviewed: reviewed ? true : undefined, evidence_url: row.model_id ? undefined : evidence_url,
    record: Object.keys(record || {}).length ? record : undefined,
  })));
  if (json.includes('$seed$')) throw new Error('Seed data contains the dollar-quote tag');
  return `INSERT INTO public.zerox_provider_candidates AS c (source, provider, model_id, display_name, context_window,
  max_output_tokens, supports_tools, supports_vision, evidence_url, status, excluded_reason, notes, record,
  first_seen, last_seen, reviewed_at, verified_at, review_notes)
SELECT '${SEED_SOURCE}', s.provider, coalesce(s.model_id, ''), s.display_name, s.context_window, s.max_output_tokens, s.supports_tools,
  s.supports_vision, s.evidence_url, s.status, s.excluded_reason, s.notes, coalesce(s.record, '{}'::jsonb),
  '${SEEN_AT}', '${SEEN_AT}',
  CASE WHEN s.reviewed THEN timestamptz '${SEEN_AT}' END, CASE WHEN s.status = 'verified' THEN timestamptz '${SEEN_AT}' END,
  CASE WHEN s.reviewed THEN 'Live in src/catalog.js when discovery shipped.' END
FROM jsonb_to_recordset($seed$${json}$seed$::jsonb) AS s(provider text, model_id text, display_name text,
  context_window integer, max_output_tokens integer, supports_tools boolean, supports_vision boolean, evidence_url text,
  status text, excluded_reason text, notes text, record jsonb, reviewed boolean)
ON CONFLICT ON CONSTRAINT zerox_provider_candidates_key DO NOTHING;`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [path, flag] = process.argv.slice(2);
  if (!path) {
    console.error('Usage: node scripts/discovery-seed.mjs path/to/provider-db.json [--write]');
    process.exit(2);
  }
  const db = JSON.parse(await readFile(path, 'utf8'));
  const rows = seedRows(db);
  const counts = {};
  for (const row of rows) {
    const key = `${row.model_id ? 'model' : 'provider'}:${row.status}`;
    counts[key] = (counts[key] || 0) + 1;
  }
  console.log(JSON.stringify({ providers: db.providers?.length, rows: rows.length, counts }));
  if (flag === '--write') {
    const migration = await readFile(MIGRATION, 'utf8');
    const start = migration.indexOf(BEGIN);
    const end = migration.indexOf(END);
    if (start < 0 || end < start) throw new Error('Seed markers not found in the migration');
    const next = `${migration.slice(0, start + BEGIN.length)}\n${seedSql(rows)}\n${migration.slice(end)}`;
    await writeFile(MIGRATION, next);
    console.log(`Wrote ${rows.length} seed rows (${Buffer.byteLength(next)} bytes) to ${MIGRATION}`);
  }
}

// Node-only helpers shared by the PGlite driver and the operator scripts.
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));
const MIGRATION_FILE = /^(\d{8,14})_([a-z0-9_]+)\.sql$/;

// Supabase versions are timestamps of 8-14 digits; compare them right-padded to 14 digits so
// `20261003_x.sql` sorts before `20261003000001_y.sql` regardless of the separator character.
function sortKey(version) {
  return version.padEnd(14, '0');
}

export async function listMigrations(directory = MIGRATIONS_DIR) {
  const names = (await readdir(directory)).filter(name => name.endsWith('.sql'));
  const migrations = names.map(file => {
    const match = MIGRATION_FILE.exec(file);
    if (!match) throw new Error(`Unexpected migration file name: ${file}`);
    return { version: match[1], name: match[2], file, path: join(directory, file) };
  });
  migrations.sort((a, b) => sortKey(a.version).localeCompare(sortKey(b.version)) || a.file.localeCompare(b.file));
  const seen = new Set();
  // Name -> version: a renumbered migration (PR #27's ten moved from 20261023-20261025 to
  // 20261029, GATEWAY_SETUP.md) whose old copy came back with a merge or rebase would run twice.
  const named = new Map();
  for (const migration of migrations) {
    if (seen.has(migration.version)) throw new Error(`Duplicate migration version: ${migration.version}`);
    seen.add(migration.version);
    if (named.has(migration.name)) {
      throw new Error(`Duplicate migration name: ${migration.name} (${named.get(migration.name)} and ${migration.version})`);
    }
    named.set(migration.name, migration.version);
  }
  return migrations;
}

export async function readMigration(migration) {
  const sql = await readFile(migration.path, 'utf8');
  return { ...migration, sql, sha256: createHash('sha256').update(sql).digest('hex') };
}

#!/usr/bin/env node
/**
 * check-migrations.mjs: do the migrations build exactly the database schema.prisma describes?
 *
 *   DATABASE_URL=postgresql://.../<empty database> node scripts/check-migrations.mjs
 *
 * 1. `prisma migrate deploy` applies every migration to the (empty) database.
 * 2. `prisma migrate diff` compares that database with schema.prisma.
 * 3. Any difference not listed in apps/api/prisma/known-drift.sql (objects that only raw SQL can
 *    create) fails: a model changed without a migration, or a migration that drifted.
 * CI runs it against a Postgres service container (job `migrations`).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const api = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'api');
if (!process.env.DATABASE_URL) {
  console.error('check-migrations: set DATABASE_URL to an EMPTY database');
  process.exit(2);
}
const prisma = (...args) =>
  execFileSync(process.execPath, [join('node_modules', 'prisma', 'build', 'index.js'), ...args], {
    cwd: api,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const statements = (sql) =>
  sql
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('--'))
    .sort();

prisma('migrate', 'deploy');
const actual = statements(
  prisma(
    'migrate',
    'diff',
    '--from-config-datasource',
    '--to-schema',
    'prisma/schema.prisma',
    '--script',
  ),
);
const expected = statements(readFileSync(join(api, 'prisma', 'known-drift.sql'), 'utf8'));

const unexpected = actual.filter((s) => !expected.includes(s));
const missing = expected.filter((s) => !actual.includes(s));
for (const s of unexpected) console.error(`unexpected drift: ${s}`);
for (const s of missing)
  console.error(`known drift no longer present (update known-drift.sql): ${s}`);
if (unexpected.length || missing.length) process.exit(1);
console.log(
  `check-migrations: migrations match schema.prisma (${String(expected.length)} known raw-SQL difference(s))`,
);

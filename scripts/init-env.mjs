#!/usr/bin/env node
// Creates `.env` from `.env.example`.
//
//   node scripts/init-env.mjs          create .env, or add keys that are missing from an existing one
//   node scripts/init-env.mjs --force  regenerate every secret (you must also run `pnpm dev:clean`,
//                                      because Postgres keeps the passwords it was initialised with)
//
// Rules:
//   - `__GENERATE__` becomes a random secret (hex, so it is safe inside URLs and shell commands)
//   - `${VAR}` references are resolved once, from values earlier in the same file
//   - existing values in `.env` are never changed without --force
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const examplePath = join(root, '.env.example');
const envPath = join(root, '.env');
const force = process.argv.includes('--force');

/** Parse KEY=VALUE lines, ignoring comments and blank lines. */
export function parseEnv(text) {
  const out = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    out.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return out;
}

function secret(key) {
  // Access keys are shorter, like real S3 access key ids; everything else gets 256 bits.
  const bytes = key.endsWith('ACCESS_KEY') ? 10 : 32;
  return randomBytes(bytes).toString('hex');
}

function resolve(value, known) {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => {
    const v = known.get(name);
    if (v === undefined)
      throw new Error(`.env.example references \${${name}} before it is defined`);
    return v;
  });
}

const template = readFileSync(examplePath, 'utf8');
const existing =
  existsSync(envPath) && !force ? parseEnv(readFileSync(envPath, 'utf8')) : new Map();

const resolved = new Map();
const added = [];
const lines = template.split(/\r?\n/).map((raw) => {
  const line = raw.trim();
  if (!line || line.startsWith('#') || !line.includes('=')) return raw;
  const eq = line.indexOf('=');
  const key = line.slice(0, eq).trim();
  const templateValue = line.slice(eq + 1).trim();

  let value = existing.get(key);
  if (value === undefined) {
    value = templateValue === '__GENERATE__' ? secret(key) : resolve(templateValue, resolved);
    added.push(key);
  }
  resolved.set(key, value);
  return `${key}=${value}`;
});

// Keep any extra keys the developer added by hand.
for (const [key, value] of existing) {
  if (!resolved.has(key)) lines.push(`${key}=${value}`);
}

writeFileSync(envPath, lines.join('\n').replace(/\n*$/, '\n'), { mode: 0o600 });

if (added.length === 0) {
  console.log('init-env: .env is up to date (no keys added)');
} else {
  console.log(`init-env: wrote .env (${added.length} key(s) set: ${added.join(', ')})`);
}

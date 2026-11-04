#!/usr/bin/env node
// Cross-platform wrapper around `docker compose` with the project's fixed arguments,
// so the same command works in PowerShell, Git Bash, Linux and CI.
//
//   node scripts/compose.mjs up      build + start + wait until every healthcheck passes
//   node scripts/compose.mjs down    stop containers (data volumes are kept)
//   node scripts/compose.mjs <any docker compose args...>
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = join(root, '.env');

if (!existsSync(envFile)) {
  console.error('compose: .env not found. Run `pnpm env:init` first.');
  process.exit(1);
}

const base = [
  'compose',
  '--project-name',
  'modelops',
  '--env-file',
  envFile,
  '-f',
  join(root, 'infra', 'compose', 'docker-compose.yml'),
];

const [command = 'ps', ...rest] = process.argv.slice(2);
const presets = {
  up: ['up', '-d', '--build', '--wait', '--wait-timeout', '300'],
  down: ['down'],
  logs: ['logs', '--tail', '100'],
};
const args = [...base, ...(presets[command] ?? [command]), ...rest];

const result = spawnSync('docker', args, { stdio: 'inherit', cwd: root });
process.exit(result.status ?? 1);

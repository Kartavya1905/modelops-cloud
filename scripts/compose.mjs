#!/usr/bin/env node
// Cross-platform wrapper around `docker compose` with the project's fixed arguments,
// so the same command works in PowerShell, Git Bash, Linux and CI.
//
//   node scripts/compose.mjs up      build (incl. the model-server image) + start + wait until healthy
//   node scripts/compose.mjs down    stop containers (data volumes are kept)
//   node scripts/compose.mjs obs     M10: also start the observability profile (Collector, Tempo,
//                                    Grafana) and (re)apply Grafana's read-only database role
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
  obs: ['--profile', 'obs', 'up', '-d', '--wait', '--wait-timeout', '300'],
  down: ['--profile', 'obs', 'down'],
  logs: ['logs', '--tail', '100'],
};
const args = [...base, ...(presets[command] ?? [command]), ...rest];

// The model-server image is never run by Compose (the worker starts one per revision), so it
// sits in the `images` profile; build it explicitly on `up`.
if (command === 'up') {
  const build = spawnSync('docker', [...base, '--profile', 'images', 'build', 'model-server'], {
    stdio: 'inherit',
    cwd: root,
  });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

const result = spawnSync('docker', args, { stdio: 'inherit', cwd: root });
if (result.status !== 0) process.exit(result.status ?? 1);

// The role script is idempotent: it creates the role on an existing volume (where the init scripts
// no longer run) and grants SELECT on tables that only exist after `pnpm db:deploy`.
if (command === 'obs') {
  const role = spawnSync(
    'docker',
    [...base, 'exec', '-T', 'postgres', 'sh', '/docker-entrypoint-initdb.d/02-grafana.sh'],
    { stdio: 'inherit', cwd: root },
  );
  process.exit(role.status ?? 1);
}
process.exit(0);

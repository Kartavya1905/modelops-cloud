#!/usr/bin/env node
// Removes everything this project created in Docker:
//   - Compose containers, network and DATA VOLUMES (Postgres, Redis, object storage)
//   - any model-server containers left behind by the orchestrator (label modelops.managed=true)
// It never touches containers or volumes from other projects.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, encoding: 'utf8' });
  return { code: r.status ?? 1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

console.log('cleanup: stopping Compose stack and deleting its volumes...');
const down = spawnSync(
  'node',
  [join(root, 'scripts', 'compose.mjs'), 'down', '--volumes', '--remove-orphans'],
  {
    stdio: 'inherit',
    cwd: root,
  },
);
if (down.status !== 0) process.exit(down.status ?? 1);

const managed = run('docker', ['ps', '-aq', '--filter', 'label=modelops.managed=true']);
const ids = managed.out.split(/\s+/).filter(Boolean);
if (ids.length > 0) {
  console.log(`cleanup: removing ${ids.length} orchestrator-managed container(s)...`);
  run('docker', ['rm', '-f', ...ids]);
}

console.log('cleanup: done. Run `pnpm dev:up` to start fresh.');

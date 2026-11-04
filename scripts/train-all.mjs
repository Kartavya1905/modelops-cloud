#!/usr/bin/env node
// Trains both demo models into one MLflow experiment.
//
//   pnpm ml:train --experiment modelops/<org-slug>/<project-slug> [--rows 20000]
//
// The project page in the web app shows the exact experiment name to use.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2).filter((a) => a !== '--');
if (!args.includes('--experiment')) {
  console.error('usage: pnpm ml:train --experiment modelops/<org-slug>/<project-slug> [--rows N]');
  process.exit(2);
}

for (const script of ['train_sklearn', 'train_pytorch']) {
  console.log(`\n=== ${script} ===`);
  const r = spawnSync(
    'uv',
    ['run', '--directory', join(root, 'ml'), 'python', '-m', `modelops_ml.${script}`, ...args],
    { stdio: 'inherit', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } },
  );
  if (r.status !== 0) process.exit(r.status ?? 1);
}

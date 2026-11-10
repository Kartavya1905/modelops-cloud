#!/usr/bin/env node
// Journey J3 (docs/01): sends churn traffic of a chosen kind to an endpoint, then the true labels
// as feedback, so the endpoint page shows data drift and concept drift as SEPARATE signals.
//
//   pnpm demo:drift --endpoint churn-staging --key mo_XXXX_... --phase normal  [--rows 400]
//   pnpm demo:drift ... --phase data      inputs move (charges +40, usage x1.6): data drift
//                                         (support tickets follow charges, so they move too)
//   pnpm demo:drift ... --phase concept   same inputs, the label relationship flips: concept drift
//
// Rows come from the platform's seeded generator (ml/modelops_ml/datasets.py), so every run is
// reproducible. Turn on "Capture inputs" on the endpoint first, then press "Run drift check".
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { values: args } = parseArgs({
  options: {
    endpoint: { type: 'string' },
    key: { type: 'string', default: process.env.MODELOPS_API_KEY },
    phase: { type: 'string', default: 'normal' },
    rows: { type: 'string', default: '400' },
    seed: { type: 'string', default: '13' },
    gateway: { type: 'string', default: process.env.MO_GATEWAY_URL ?? 'http://127.0.0.1:18088' },
    feedback: { type: 'boolean', default: true },
  },
});

const PHASES = {
  normal: [],
  data: ['--charge-shift', '40', '--usage-scale', '1.6'],
  concept: ['--concept-shift', '1'],
};
if (!args.endpoint || !args.key || !(args.phase in PHASES)) {
  console.error(
    'usage: pnpm demo:drift --endpoint <slug> --key <mo_…> --phase normal|data|concept',
  );
  process.exit(2);
}
if (!/^\d+$/.test(args.rows) || !/^\d+$/.test(args.seed)) {
  console.error('demo-drift: --rows and --seed must be integers');
  process.exit(2);
}

const out = join(mkdtempSync(join(tmpdir(), 'mo-drift-')), 'rows.jsonl');
execFileSync(
  'uv',
  [
    'run',
    '--directory',
    join(root, 'ml'),
    'python',
    '-m',
    'modelops_ml.datasets',
    '--rows',
    args.rows,
    '--seed',
    args.seed,
    ...PHASES[args.phase],
    '--format',
    'jsonl',
    '--out',
    out,
  ],
  { stdio: 'pipe' },
);
const rows = readFileSync(out, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const headers = { authorization: `Bearer ${args.key}`, 'content-type': 'application/json' };
const base = `${args.gateway}/v1/endpoints/${args.endpoint}`;
const ids = [];
for (let i = 0; i < rows.length; i += 64) {
  const chunk = rows.slice(i, i + 64);
  const res = await fetch(`${base}/predict`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ inputs: chunk.map((r) => r.features) }),
  });
  if (!res.ok) {
    console.error(`demo-drift: predict answered ${res.status}: ${await res.text()}`);
    process.exit(1);
  }
  ids.push(...(await res.json()).predictionIds);
}
let labelled = 0;
if (args.feedback) {
  const items = ids.map((predictionId, i) => ({ predictionId, label: rows[i].label }));
  for (let i = 0; i < items.length; i += 1000) {
    const res = await fetch(`${base}/feedback`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ items: items.slice(i, i + 1000) }),
    });
    if (res.status !== 202) {
      console.error(`demo-drift: feedback answered ${res.status}: ${await res.text()}`);
      process.exit(1);
    }
    labelled += (await res.json()).accepted;
  }
}
console.log(
  `demo-drift (${args.phase}): ${ids.length} predictions, ${labelled} labels sent to ${args.endpoint}`,
);

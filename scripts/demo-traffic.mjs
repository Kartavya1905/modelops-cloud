#!/usr/bin/env node
// Sends steady prediction traffic to one endpoint with k6 (in Docker, nothing to install), so the
// dashboards have something to show, and prints k6's own counts for comparison.
//
//   pnpm demo:traffic --endpoint churn-staging --key mo_XXXX_... [--rps 10] [--duration 30s]
//                     [--gateway http://gateway:8080] [--network modelops-backend] [--json]
//
// Request bodies default to the churn fixture's golden inputs (tests/fixtures/bundles/sklearn),
// which match the demo models' signature. Pass --body file.json for another model.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const K6_IMAGE = 'grafana/k6:2.3.0';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const { values: args } = parseArgs({
  options: {
    endpoint: { type: 'string' },
    key: { type: 'string', default: process.env.MODELOPS_API_KEY },
    rps: { type: 'string', default: '10' },
    duration: { type: 'string', default: '30s' },
    gateway: { type: 'string', default: 'http://gateway:8080' },
    network: { type: 'string', default: 'modelops-backend' },
    body: { type: 'string' },
    json: { type: 'boolean', default: false },
  },
});

if (!args.endpoint || !args.key) {
  console.error(
    'usage: pnpm demo:traffic --endpoint <slug> --key <mo_…> [--rps 10] [--duration 30s]',
  );
  process.exit(2);
}
if (!/^\d+$/.test(args.rps) || !/^\d+[smh]$/.test(args.duration)) {
  console.error('demo-traffic: --rps must be an integer and --duration like 30s, 2m');
  process.exit(2);
}

function defaultBodies() {
  const dir = join(root, 'tests', 'fixtures', 'bundles', 'sklearn');
  const sig = JSON.parse(readFileSync(join(dir, 'signature.json'), 'utf8'));
  const golden = JSON.parse(readFileSync(join(dir, 'golden_examples.json'), 'utf8'));
  const features = sig.inputs[0].features;
  return golden.inputs.map((row) => ({
    inputs: [Object.fromEntries(features.map((f, i) => [f, row[i]]))],
  }));
}
const bodies = args.body ? [JSON.parse(readFileSync(args.body, 'utf8'))] : defaultBodies();

if (!args.json) {
  console.log(
    `demo-traffic: ${args.rps} req/s for ${args.duration} -> ${args.gateway}/v1/endpoints/${args.endpoint}/predict`,
  );
}
const run = spawnSync(
  'docker',
  [
    'run',
    '--rm',
    '-i',
    '--network',
    args.network,
    '-e',
    `GATEWAY=${args.gateway}`,
    '-e',
    `ENDPOINT=${args.endpoint}`,
    '-e',
    `API_KEY=${args.key}`,
    '-e',
    `RPS=${args.rps}`,
    '-e',
    `DURATION=${args.duration}`,
    '-e',
    `BODIES=${JSON.stringify(bodies)}`,
    K6_IMAGE,
    'run',
    '--quiet',
    '-',
  ],
  { input: readFileSync(join(root, 'tests', 'load', 'predict.js')), encoding: 'utf8' },
);
const line = (run.stdout ?? '').split('\n').find((l) => l.startsWith('K6_SUMMARY '));
if (run.status !== 0 || !line) {
  console.error(run.stderr || run.stdout || 'k6 failed');
  process.exit(run.status || 1);
}
const summary = JSON.parse(line.slice('K6_SUMMARY '.length));
if (args.json) {
  console.log(JSON.stringify(summary));
} else {
  console.log(
    `k6: ${summary.requests} requests (${summary.failed} failed), ${summary.rps.toFixed(1)} req/s, p95 ${summary.p95Ms.toFixed(1)} ms`,
  );
  console.log('Compare with the endpoint dashboard (it counts the same requests at the gateway).');
}

#!/usr/bin/env node
/**
 * cloud-smoke.mjs: end-to-end check of a ModelOps server reached over the network (the AWS
 * free-plan server, docs/14), through its public ports only, like a real user and client:
 *
 *   node scripts/cloud-smoke.mjs --host <ip-or-name>     (pnpm aws:smoke fills in the server's IP)
 *
 *   1. Registers a throwaway user through the web console's /api, creates a project and a model,
 *      uploads the sklearn fixture bundle; the ml-worker validates it.
 *   2. Deploys it; the worker starts a model-server container. Waits for READY.
 *   3. Creates an API key and sends predictions through the public gateway port.
 *   4. Grafana answers on its port.
 * Leaves the endpoint running (one 0.5-CPU / 512 MiB model server) so it can be looked at.
 * Exit code 0 only if every check passed.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { values: args } = parseArgs({
  options: {
    host: { type: 'string' },
    'web-port': { type: 'string', default: '3300' },
    'gateway-port': { type: 'string', default: '18088' },
    'grafana-port': { type: 'string', default: '13001' },
    requests: { type: 'string', default: '20' },
  },
});
if (!args.host || !/^[A-Za-z0-9.-]+$/.test(args.host)) {
  console.error('usage: node scripts/cloud-smoke.mjs --host <ip-or-name>');
  process.exit(2);
}
const WEB = `http://${args.host}:${args['web-port']}`;
const API = `${WEB}/api/v1`;
const GATEWAY = `http://${args.host}:${args['gateway-port']}`;
const GRAFANA = `http://${args.host}:${args['grafana-port']}`;
const FIXTURE = join(root, 'tests', 'fixtures', 'bundles', 'sklearn');

let failures = 0;
function check(ok, what, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${what}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures++;
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ok, ms, every = 2000) {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (ok(last)) return last;
    await sleep(every);
  }
  return last;
}

// The web console's own way of calling the API: session cookie + CSRF header, same origin.
let cookie = '';
let csrf = '';
async function api(method, path, body, headers = {}) {
  const isForm = body instanceof FormData;
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      origin: WEB,
      ...(cookie ? { cookie } : {}),
      ...(csrf && method !== 'GET' ? { 'x-csrf-token': csrf } : {}),
      ...(body && !isForm ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: isForm ? body : body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok)
    throw new Error(`${method} ${path}: HTTP ${String(res.status)} ${text.slice(0, 300)}`);
  const set = res.headers.getSetCookie();
  if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  return text ? JSON.parse(text) : null;
}

console.log(`cloud-smoke: ${WEB}\n`);
const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);

try {
  // 1. User, project, model, upload + validation -------------------------------------------------
  const session = await api('POST', '/auth/register', {
    email: `smoke-${stamp}@example.com`,
    name: 'Cloud Smoke',
    password: randomBytes(18).toString('base64url'),
  });
  csrf = session.csrfToken;
  check(true, 'registered through the web console');
  const org = session.memberships[0].orgId;
  const project = await api('POST', `/orgs/${org}/projects`, { name: `Smoke ${stamp}` });
  const model = await api('POST', `/orgs/${org}/projects/${project.id}/models`, {
    name: 'Churn',
  });
  const form = new FormData();
  form.set('framework', 'SKLEARN_ONNX');
  for (const [part, file] of [
    ['model', 'model.onnx'],
    ['signature', 'signature.json'],
    ['golden', 'golden_examples.json'],
  ]) {
    form.set(part, new Blob([readFileSync(join(FIXTURE, file))]), file);
  }
  const version = await api('POST', `/orgs/${org}/models/${model.id}/versions/upload`, form);
  const validated = await until(
    () => api('GET', `/orgs/${org}/model-versions/${version.id}`),
    (v) => v.status !== 'PENDING_VALIDATION' && v.status !== 'VALIDATING',
    300_000,
  );
  check(validated.status === 'VALIDATED', 'the ml-worker validated the upload', validated.status);

  // 2. Deploy --------------------------------------------------------------------------------------
  const endpoint = await api('POST', `/orgs/${org}/projects/${project.id}/endpoints`, {
    name: `Smoke ${stamp}`,
  });
  const revision = await api(
    'POST',
    `/orgs/${org}/endpoints/${endpoint.id}/revisions`,
    { modelVersionId: version.id },
    { 'idempotency-key': crypto.randomUUID() },
  );
  const ready = await until(
    () => api('GET', `/orgs/${org}/revisions/${revision.id}`),
    (r) => ['READY', 'FAILED', 'CANCELLED'].includes(r.state),
    300_000,
  );
  check(
    ready.state === 'READY',
    'model server deployed (revision READY)',
    ready.state === 'READY' ? '' : `${ready.state} ${ready.failureCode ?? ''}`,
  );

  // 3. Predictions through the public gateway port ---------------------------------------------
  const { key } = await api('POST', `/orgs/${org}/projects/${project.id}/api-keys`, {
    name: 'cloud-smoke',
  });
  const sig = JSON.parse(readFileSync(join(FIXTURE, 'signature.json'), 'utf8'));
  const golden = JSON.parse(readFileSync(join(FIXTURE, 'golden_examples.json'), 'utf8'));
  const features = sig.inputs[0].features;
  const rows = golden.inputs.map((r) => Object.fromEntries(features.map((f, i) => [f, r[i]])));
  const predict = (row) =>
    fetch(`${GATEWAY}/v1/endpoints/${endpoint.slug}/predict`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ inputs: [row] }),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => ({ status: 0, headers: new Headers() }));
  // the gateway learns about a new revision within a few seconds (routing snapshot)
  const first = await until(
    () => predict(rows[0]),
    (r) => r.status === 200,
    60_000,
  );
  check(
    first.status === 200,
    'prediction through the public gateway',
    `HTTP ${String(first.status)}, model version ${first.headers.get('x-model-version') ?? '?'}`,
  );
  const n = Number(args.requests);
  let ok = 0;
  for (let i = 0; i < n; i++) ok += (await predict(rows[i % rows.length])).status === 200 ? 1 : 0;
  check(ok === n, `${String(n)} more predictions`, `${String(ok)} answered 200`);
  console.log(`\n  endpoint: ${WEB}/orgs/${org}/endpoints/${endpoint.id} (user smoke-${stamp})`);
} catch (err) {
  check(false, 'request failed', err instanceof Error ? err.message : String(err));
}

// 4. Grafana -------------------------------------------------------------------------------------
const grafana = await fetch(`${GRAFANA}/api/health`, { signal: AbortSignal.timeout(10_000) }).catch(
  () => ({ ok: false, status: 0 }),
);
check(grafana.ok, 'Grafana answers', `HTTP ${String(grafana.status)}`);

console.log(
  failures
    ? `\ncloud-smoke: ${String(failures)} check(s) FAILED`
    : '\ncloud-smoke: all checks passed',
);
process.exit(failures ? 1 : 0);

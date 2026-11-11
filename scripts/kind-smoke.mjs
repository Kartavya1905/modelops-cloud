#!/usr/bin/env node
/**
 * kind-smoke.mjs: the M10 acceptance check against the platform running on kind (`pnpm kind:up`).
 *
 *   pnpm kind:smoke [--requests 60]
 *
 * Through the real, deployed services only (no test shortcuts):
 *   1. Registers a user on the API (127.0.0.1:14400), creates a project and a model, uploads the
 *      sklearn fixture bundle; the worker pod validates it with the ml-worker.
 *   2. Deploys it; the worker's KubernetesDriver creates the model-server pod. Waits for READY.
 *   3. Reads the pod: resources (requests = limits), restartPolicy Never, hardened securityContext.
 *   4. Creates an API key and sends predictions through the gateway (127.0.0.1:18188).
 *   5. Live data: Prometheus has the kind gateway's request counter, Tempo has the trace of a
 *      prediction (gateway -> model server), and Grafana answers a query on the kind database.
 * Exit code 0 only if every check passed.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
process.loadEnvFile(join(root, '.env'));
const env = process.env;
const { values: args } = parseArgs({ options: { requests: { type: 'string', default: '60' } } });

const API = 'http://127.0.0.1:14400/api/v1';
const GATEWAY = 'http://127.0.0.1:18188';
const PROMETHEUS = `http://127.0.0.1:${env.MO_PORT_PROMETHEUS ?? '19090'}`;
const TEMPO = `http://127.0.0.1:${env.MO_PORT_TEMPO ?? '13200'}`;
const GRAFANA = `http://127.0.0.1:${env.MO_PORT_GRAFANA ?? '13001'}`;
const KUBECTL = env.KUBECTL ?? 'kubectl';
const FIXTURE = join(root, 'tests', 'fixtures', 'bundles', 'sklearn');

let failures = 0;
function check(ok, what, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${what}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures++;
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ok, ms, every = 1000) {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (ok(last)) return last;
    await sleep(every);
  }
  return last;
}

// ---------------------------------------------------------------------------------------------
// A tiny API client: session cookie + CSRF header, like the web console.
// ---------------------------------------------------------------------------------------------
let cookie = '';
let csrf = '';
async function api(method, path, body, headers = {}) {
  const isForm = body instanceof FormData;
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(csrf && method !== 'GET' ? { 'x-csrf-token': csrf } : {}),
      ...(body && !isForm ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: isForm ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok)
    throw new Error(`${method} ${path}: HTTP ${String(res.status)} ${text.slice(0, 300)}`);
  const set = res.headers.getSetCookie();
  if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  return json;
}

const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
console.log('kind-smoke: the platform on kind, end to end\n');

// 1. User, project, model, upload + validation ---------------------------------------------------
const session = await api('POST', '/auth/register', {
  email: `kind-smoke-${stamp}@example.com`,
  name: 'Kind Smoke',
  password: 'correct horse battery staple',
});
csrf = session.csrfToken;
const org = session.memberships[0].orgId;
const project = await api('POST', `/orgs/${org}/projects`, { name: `Kind ${stamp}` });
const model = await api('POST', `/orgs/${org}/projects/${project.id}/models`, { name: 'Churn' });
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
  180_000,
  2000,
);
check(validated.status === 'VALIDATED', 'the worker pod validated the upload', validated.status);

// 2. Deploy ----------------------------------------------------------------------------------------
const endpoint = await api('POST', `/orgs/${org}/projects/${project.id}/endpoints`, {
  name: `Kind churn ${stamp}`,
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
  240_000,
  2000,
);
check(
  ready.state === 'READY',
  'revision READY',
  ready.state === 'READY'
    ? ''
    : `${ready.state} ${ready.failureCode ?? ''} ${ready.failureDetail ?? ''}`,
);

// 3. The pod -----------------------------------------------------------------------------------------
const pod = JSON.parse(
  execFileSync(
    KUBECTL,
    [
      '--context',
      'kind-modelops',
      '-n',
      'modelops-models',
      'get',
      'pod',
      `mo-rev-${revision.id}`,
      '-o',
      'json',
    ],
    { encoding: 'utf8' },
  ),
);
const c = pod.spec.containers[0];
check(
  pod.status.phase === 'Running',
  `pod mo-rev-${revision.id.slice(0, 8)}… is Running`,
  pod.spec.nodeName,
);
check(
  JSON.stringify(c.resources.limits) === JSON.stringify(c.resources.requests) &&
    !!c.resources.limits.cpu,
  'requests = limits',
  JSON.stringify(c.resources.limits),
);
check(pod.spec.restartPolicy === 'Never', 'restartPolicy Never (restarts are the reconciler’s)');
check(
  c.securityContext.readOnlyRootFilesystem === true &&
    c.securityContext.allowPrivilegeEscalation === false &&
    c.securityContext.capabilities?.drop?.includes('ALL') &&
    pod.spec.securityContext.runAsUser === 10001,
  'hardened: uid 10001, read-only root, no capabilities, no escalation',
);

// 4. Predictions through the gateway -----------------------------------------------------------------
const key = (
  await api('POST', `/orgs/${org}/projects/${project.id}/api-keys`, { name: 'kind-smoke' })
).key;
const sig = JSON.parse(readFileSync(join(FIXTURE, 'signature.json'), 'utf8'));
const golden = JSON.parse(readFileSync(join(FIXTURE, 'golden_examples.json'), 'utf8'));
const features = sig.inputs[0].features;
const rows = golden.inputs.map((r) => Object.fromEntries(features.map((f, i) => [f, r[i]])));
const predict = (row) =>
  fetch(`${GATEWAY}/v1/endpoints/${endpoint.slug}/predict`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ inputs: [row] }),
  });
const first = await until(
  () => predict(rows[0]),
  (r) => r.status === 200,
  30_000,
  500,
);
const traceId = first.headers.get('x-trace-id') ?? '';
check(first.status === 200, 'prediction through the kind gateway', `HTTP ${String(first.status)}`);
const answer = await first.json();
check(answer.outputs?.[0]?.label === golden.outputs.label[0], 'same label as the golden example');
// Paced at ~20 req/s: endpoints are rate limited (50 req/s by default), and 429s are not the point.
let okCount = 0;
const n = Number(args.requests);
for (let i = 0; i < n; i++) {
  okCount += (await predict(rows[i % rows.length])).status === 200 ? 1 : 0;
  await sleep(50);
}
check(okCount === n, `${String(n)} more predictions`, `${String(okCount)} x 200`);

// 5. Live data ---------------------------------------------------------------------------------------
const promQuery = `sum(gateway_requests_total{stack="kind",endpoint_id="${endpoint.id}"})`;
const prom = await until(
  async () => {
    const r = await fetch(`${PROMETHEUS}/api/v1/query?query=${encodeURIComponent(promQuery)}`);
    return Number((await r.json()).data?.result?.[0]?.value?.[1] ?? 0);
  },
  (v) => v >= n,
  60_000,
  2000,
);
check(
  prom >= n,
  'Prometheus scraped the kind gateway',
  `${String(prom)} requests for this endpoint`,
);

const services = await until(
  async () => {
    const r = await fetch(`${TEMPO}/api/traces/${traceId}`, {
      headers: { accept: 'application/json' },
    });
    if (!r.ok) return new Set();
    const t = await r.json();
    return new Set(
      (t.batches ?? []).map(
        (b) => b.resource.attributes.find((a) => a.key === 'service.name')?.value.stringValue,
      ),
    );
  },
  (s) => s.has('modelops-gateway') && s.has('modelops-model-server'),
  60_000,
  2000,
);
check(
  services.has('modelops-gateway') && services.has('modelops-model-server'),
  `Tempo has trace ${traceId}`,
  [...services].join(' -> '),
);

const grafana = await fetch(`${GRAFANA}/api/ds/query`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: `Basic ${Buffer.from(`admin:${env.MO_GRAFANA_ADMIN_PASSWORD ?? ''}`).toString('base64')}`,
  },
  body: JSON.stringify({
    queries: [
      {
        refId: 'A',
        datasource: { uid: 'modelops-db-kind' },
        rawSql: `SELECT count(*) AS ready FROM deployment_revisions WHERE state = 'READY'`,
        format: 'table',
      },
    ],
  }),
});
const frame = grafana.ok ? (await grafana.json()).results?.A?.frames?.[0] : undefined;
const readyCount = frame?.data?.values?.[0]?.[0];
check(
  Number(readyCount) >= 1,
  'Grafana reads the kind database',
  `${String(readyCount)} READY revision(s)`,
);

console.log(
  `\n${failures === 0 ? 'kind-smoke: all checks passed' : `kind-smoke: ${String(failures)} check(s) FAILED`}` +
    `\n  endpoint ${endpoint.slug}, revision ${revision.id}\n  Grafana  ${GRAFANA}/d/modelops-platform (Database: ModelOps DB (kind))`,
);
process.exit(failures === 0 ? 0 : 1);

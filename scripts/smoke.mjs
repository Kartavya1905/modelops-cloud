#!/usr/bin/env node
// Milestone 1 smoke test: proves the local environment works end to end.
//
//   node scripts/smoke.mjs               infrastructure + API + web (run `pnpm dev` first)
//   node scripts/smoke.mjs --infra-only  infrastructure only (used before the apps are started)
//
// Every check prints PASS/FAIL with timing. Exit code is 1 if any check fails.
// The script creates only uniquely named, temporary objects and removes them afterwards.
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = join(root, '.env');
if (!existsSync(envFile)) {
  console.error('smoke: .env not found. Run `pnpm env:init` first.');
  process.exit(1);
}
process.loadEnvFile(envFile);
const env = process.env;
const infraOnly = process.argv.includes('--infra-only');

const EXPECTED_SERVICES = [
  'postgres',
  'redis',
  'seaweedfs',
  'mlflow',
  'ml-worker',
  'docker-proxy',
  'gateway',
  'prometheus',
];
const EXPECTED_BUCKETS = [
  'mlflow-artifacts',
  'model-artifacts',
  'datasets',
  'drift-captures',
  'reports',
  'uploads-staging',
];
const mlflowUrl = env.MO_MLFLOW_URL;
const mlWorkerUrl = env.MO_ML_WORKER_URL;
const dockerProxyUrl = env.MO_DOCKER_PROXY_URL;
const gatewayUrl = env.MO_GATEWAY_URL;
const gatewayAdminUrl = env.MO_GATEWAY_ADMIN_URL;
const prometheusUrl = env.MO_PROMETHEUS_URL;
const apiUrl = env.MO_API_URL;
const webUrl = `http://127.0.0.1:${env.MO_PORT_WEB ?? '3300'}`;

const results = [];
async function check(name, fn) {
  const started = performance.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: performance.now() - started, detail: detail ?? '' });
  } catch (err) {
    results.push({ name, ok: false, ms: performance.now() - started, detail: err.message });
  }
  const r = results.at(-1);
  console.log(
    `${r.ok ? 'PASS' : 'FAIL'}  ${name.padEnd(52)} ${String(Math.round(r.ms)).padStart(5)} ms  ${r.detail}`,
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function compose(...args) {
  const r = spawnSync(
    'docker',
    [
      'compose',
      '--project-name',
      'modelops',
      '--env-file',
      envFile,
      '-f',
      join(root, 'infra', 'compose', 'docker-compose.yml'),
      ...args,
    ],
    { encoding: 'utf8' },
  );
  return { code: r.status ?? 1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

async function http(url, init = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, text, json };
}

function s3Client(accessKeyId, secretAccessKey) {
  return new S3Client({
    endpoint: env.MO_S3_ENDPOINT,
    region: env.MO_S3_REGION,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
}
const s3 = s3Client(env.MO_S3_ACCESS_KEY, env.MO_S3_SECRET_KEY);
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

console.log(`ModelOps Cloud smoke test (${infraOnly ? 'infrastructure only' : 'full'})\n`);

// ------------------------------------------------------------------ containers
await check('compose: core services running and healthy', () => {
  const r = compose('ps', '--format', 'json');
  assert(r.code === 0, `docker compose ps failed: ${r.err}`);
  // Compose prints one JSON object per line.
  const rows = r.out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const bad = EXPECTED_SERVICES.filter((svc) => {
    const row = rows.find((x) => x.Service === svc);
    return !row || row.State !== 'running' || row.Health !== 'healthy';
  });
  assert(bad.length === 0, `not healthy: ${bad.join(', ')}`);
  return EXPECTED_SERVICES.join(', ');
});

await check('compose: storage-init completed successfully', () => {
  const r = compose('ps', '-a', '--format', 'json', 'storage-init');
  const row = r.out ? JSON.parse(r.out.split(/\r?\n/)[0]) : undefined;
  assert(
    row && row.State === 'exited' && row.ExitCode === 0,
    `state=${row?.State} exit=${row?.ExitCode}`,
  );
  return 'exit 0';
});

// ------------------------------------------------------------------ PostgreSQL
await check('postgres: app role can use the modelops database', () => {
  const r = compose(
    'exec',
    '-T',
    '-e',
    `PGPASSWORD=${env.MO_DB_APP_PASSWORD}`,
    'postgres',
    'psql',
    '-h',
    '127.0.0.1',
    '-U',
    env.MO_DB_APP_USER,
    '-d',
    'modelops',
    '-tAc',
    'SELECT current_user',
  );
  assert(r.code === 0 && r.out === env.MO_DB_APP_USER, r.err || r.out);
  return `connected as ${r.out}`;
});

await check('postgres: app role is denied the mlflow database', () => {
  const r = compose(
    'exec',
    '-T',
    '-e',
    `PGPASSWORD=${env.MO_DB_APP_PASSWORD}`,
    'postgres',
    'psql',
    '-h',
    '127.0.0.1',
    '-U',
    env.MO_DB_APP_USER,
    '-d',
    'mlflow',
    '-tAc',
    'SELECT 1',
  );
  assert(
    r.code !== 0 && /permission denied/i.test(r.err),
    `expected permission denied, got: ${r.err || r.out}`,
  );
  return 'permission denied (least privilege)';
});

// ----------------------------------------------------------------------- Redis
await check('redis: authenticated PING and noeviction policy', () => {
  const ping = compose('exec', '-T', 'redis', 'redis-cli', 'PING');
  assert(ping.out === 'PONG', `PING -> ${ping.out || ping.err}`);
  const policy = compose('exec', '-T', 'redis', 'redis-cli', 'CONFIG', 'GET', 'maxmemory-policy');
  assert(policy.out.includes('noeviction'), `policy: ${policy.out}`);
  return 'PONG, maxmemory-policy=noeviction';
});

await check('redis: unauthenticated access is rejected', () => {
  const r = compose(
    'exec',
    '-T',
    '-e',
    'REDISCLI_AUTH=',
    'redis',
    'redis-cli',
    '--no-auth-warning',
    'PING',
  );
  assert(/NOAUTH/i.test(r.out + r.err), `expected NOAUTH, got: ${r.out || r.err}`);
  return 'NOAUTH';
});

// ---------------------------------------------------------- Object storage (S3)
await check('s3: all platform buckets exist', async () => {
  const out = await s3.send(new ListBucketsCommand({}));
  const names = new Set((out.Buckets ?? []).map((b) => b.Name));
  const missing = EXPECTED_BUCKETS.filter((b) => !names.has(b));
  assert(missing.length === 0, `missing: ${missing.join(', ')}`);
  return `${EXPECTED_BUCKETS.length} buckets`;
});

const key = `smoke/${randomUUID()}.bin`;
const payload = Buffer.from(`modelops smoke ${new Date().toISOString()} ${randomUUID()}`);
await check('s3: put -> get round trip preserves SHA-256', async () => {
  await s3.send(new PutObjectCommand({ Bucket: 'model-artifacts', Key: key, Body: payload }));
  const got = await s3.send(new GetObjectCommand({ Bucket: 'model-artifacts', Key: key }));
  const body = Buffer.from(await got.Body.transformToByteArray());
  assert(sha256(body) === sha256(payload), 'checksum mismatch');
  return `sha256 ${sha256(payload).slice(0, 12)}…`;
});

await check('s3: presigned GET URL works without credentials', async () => {
  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: 'model-artifacts', Key: key }),
    {
      expiresIn: 60,
    },
  );
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  const body = Buffer.from(await res.arrayBuffer());
  assert(res.status === 200, `HTTP ${res.status}`);
  assert(sha256(body) === sha256(payload), 'checksum mismatch via presigned URL');
  return 'HTTP 200, checksum ok';
});

await check('s3: tampered presigned URL is rejected', async () => {
  const url = new URL(
    await getSignedUrl(s3, new GetObjectCommand({ Bucket: 'model-artifacts', Key: key }), {
      expiresIn: 60,
    }),
  );
  url.searchParams.set('X-Amz-Signature', '0'.repeat(64));
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  assert(res.status === 403, `expected 403, got ${res.status}`);
  return 'HTTP 403';
});

await check('s3: wrong credentials are rejected', async () => {
  const bad = s3Client('not-a-real-key', 'not-a-real-secret');
  try {
    await bad.send(new ListBucketsCommand({}));
  } catch (err) {
    const status = err.$metadata?.httpStatusCode;
    assert(status === 403, `expected 403, got ${status} (${err.name})`);
    return 'HTTP 403';
  }
  throw new Error('request with wrong credentials succeeded');
});

await check('s3: validator identity can read model-artifacts but never write', async () => {
  const ro = s3Client(env.MO_S3_VALIDATOR_ACCESS_KEY, env.MO_S3_VALIDATOR_SECRET_KEY);
  const got = await ro.send(new GetObjectCommand({ Bucket: 'model-artifacts', Key: key }));
  assert(sha256(Buffer.from(await got.Body.transformToByteArray())) === sha256(payload), 'read');
  for (const attempt of [
    () => ro.send(new PutObjectCommand({ Bucket: 'model-artifacts', Key: key, Body: 'x' })),
    () => ro.send(new DeleteObjectCommand({ Bucket: 'model-artifacts', Key: key })),
    () => ro.send(new GetObjectCommand({ Bucket: 'datasets', Key: 'anything' })),
  ]) {
    try {
      await attempt();
    } catch (err) {
      const status = err.$metadata?.httpStatusCode;
      assert(status === 403, `expected 403, got ${status} (${err.name})`);
      continue;
    }
    throw new Error('validator identity was allowed a write or another bucket');
  }
  return 'read ok; put, delete, other bucket: HTTP 403';
});

await s3
  .send(new DeleteObjectCommand({ Bucket: 'model-artifacts', Key: key }))
  .catch(() => undefined);

// ------------------------------------------------------------------ ML worker
await check('ml-worker: /healthz returns OK', async () => {
  const r = await http(`${mlWorkerUrl}/healthz`);
  assert(r.status === 200, `HTTP ${r.status}: ${r.text.slice(0, 120)}`);
  return 'HTTP 200';
});

await check('ml-worker: /v1/validate refuses requests without the shared token', async () => {
  const r = await http(`${mlWorkerUrl}/v1/validate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert(r.status === 401, `expected 401, got ${r.status}`);
  return 'HTTP 401';
});

// ------------------------------------------------- Docker socket proxy (M5)
await check('docker-proxy: containers API allowed, everything dangerous denied', async () => {
  const list = await http(`${dockerProxyUrl}/containers/json`);
  assert(list.status === 200, `list containers: HTTP ${list.status}`);
  const denied = [
    ['POST', '/exec/x/start'], // running a command inside any container
    ['GET', '/volumes'],
    ['GET', '/networks'],
    ['POST', '/build'],
    ['GET', '/swarm'],
    ['GET', '/secrets'],
  ];
  for (const [method, path] of denied) {
    const r = await http(`${dockerProxyUrl}${path}`, { method });
    assert(r.status === 403, `${method} ${path}: expected 403, got ${r.status}`);
  }
  return `list 200; ${denied.length} sensitive endpoints 403`;
});

// ------------------------------------------------------- Inference gateway (M5)
await check('gateway: up, and predict without an API key is 401 problem+json', async () => {
  const health = await http(`${gatewayUrl}/healthz`);
  assert(health.status === 200, `healthz: HTTP ${health.status}`);
  const r = await http(`${gatewayUrl}/v1/endpoints/smoke/predict`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"inputs":[]}',
  });
  assert(r.status === 401 && r.text.includes('INVALID_API_KEY'), `predict: HTTP ${r.status}`);
  return 'HTTP 200 / 401';
});

await check('gateway: internal admin API refuses requests without the token', async () => {
  const r = await http(
    `${gatewayAdminUrl}/internal/revisions/00000000-0000-0000-0000-000000000000/readyz`,
  );
  assert(r.status === 401, `expected 401, got ${r.status}`);
  const metrics = await http(`${gatewayAdminUrl}/metrics`);
  assert(metrics.text.includes('gateway_'), 'no gateway metrics exposed');
  return 'HTTP 401; /metrics served';
});

// ------------------------------------------------------------- Prometheus (M6)
await check('prometheus: ready and scraping the gateway', async () => {
  const ready = await http(`${prometheusUrl}/-/ready`);
  assert(ready.status === 200, `ready: HTTP ${ready.status}`);
  // The first scrape can take one interval (5 s) after a fresh start.
  for (let i = 0; i < 12; i++) {
    const r = await http(
      `${prometheusUrl}/api/v1/query?query=${encodeURIComponent('up{job="gateway",stack="dev"}')}`,
    );
    const value = JSON.parse(r.text).data?.result?.[0]?.value?.[1];
    if (value === '1') return 'gateway target up';
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error('the dev gateway target is not up in Prometheus');
});

// --------------------------------------------------------------------- MLflow
await check('mlflow: /health returns OK', async () => {
  const r = await http(`${mlflowUrl}/health`);
  assert(r.status === 200, `HTTP ${r.status}: ${r.text.slice(0, 120)}`);
  return 'HTTP 200';
});

await check('mlflow: run + artifact stored in Postgres and S3', async () => {
  const expName = `smoke-${randomUUID()}`;
  const post = (path, body) =>
    http(`${mlflowUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const exp = await post('/api/2.0/mlflow/experiments/create', { name: expName });
  assert(exp.status === 200, `create experiment: HTTP ${exp.status} ${exp.text.slice(0, 160)}`);
  const experimentId = exp.json.experiment_id;
  try {
    const run = await post('/api/2.0/mlflow/runs/create', {
      experiment_id: experimentId,
      start_time: Date.now(),
    });
    assert(run.status === 200, `create run: HTTP ${run.status}`);
    const runId = run.json.run.info.run_id;

    const metric = await post('/api/2.0/mlflow/runs/log-metric', {
      run_id: runId,
      key: 'smoke_metric',
      value: 0.42,
      timestamp: Date.now(),
      step: 0,
    });
    assert(metric.status === 200, `log metric: HTTP ${metric.status}`);

    // Upload through MLflow's artifact proxy; MLflow writes it to the S3 bucket.
    const artifactPath = `${experimentId}/${runId}/artifacts/smoke.txt`;
    const put = await http(`${mlflowUrl}/api/2.0/mlflow-artifacts/artifacts/${artifactPath}`, {
      method: 'PUT',
      body: 'hello from the smoke test',
    });
    assert(put.status === 200, `artifact upload: HTTP ${put.status} ${put.text.slice(0, 160)}`);

    const listed = await s3.send(
      new ListObjectsV2Command({ Bucket: 'mlflow-artifacts', Prefix: `${experimentId}/${runId}/` }),
    );
    const found = (listed.Contents ?? []).some((o) => o.Key.endsWith('smoke.txt'));
    assert(found, 'artifact not found in s3://mlflow-artifacts');

    const got = await http(`${mlflowUrl}/api/2.0/mlflow/runs/get?run_id=${runId}`);
    const m = got.json?.run?.data?.metrics?.find((x) => x.key === 'smoke_metric');
    assert(m?.value === 0.42, 'metric not persisted');

    // Clean up the S3 object (MLflow deletes are soft deletes in the DB).
    for (const o of listed.Contents ?? []) {
      await s3.send(new DeleteObjectCommand({ Bucket: 'mlflow-artifacts', Key: o.Key }));
    }
    await post('/api/2.0/mlflow/runs/delete', { run_id: runId });
    return `experiment ${experimentId}, run ${runId.slice(0, 8)}…`;
  } finally {
    await post('/api/2.0/mlflow/experiments/delete', { experiment_id: experimentId });
  }
});

// ----------------------------------------------------------------- API + web
if (!infraOnly) {
  await check('api: GET /api/v1/health/live', async () => {
    const r = await http(`${apiUrl}/api/v1/health/live`);
    assert(
      r.status === 200 && r.json?.status === 'ok',
      `HTTP ${r.status} (is \`pnpm dev\` running?)`,
    );
    return 'HTTP 200';
  });

  await check('api: GET /api/v1/health/ready (postgres + redis up)', async () => {
    const r = await http(`${apiUrl}/api/v1/health/ready`);
    assert(r.status === 200, `HTTP ${r.status}: ${r.text.slice(0, 160)}`);
    const c = r.json.checks;
    return `postgres ${c.postgres.latencyMs} ms, redis ${c.redis.latencyMs} ms`;
  });

  await check('web: home page renders', async () => {
    const r = await http(`${webUrl}/`);
    assert(r.status === 200 && r.text.includes('ModelOps Cloud'), `HTTP ${r.status}`);
    return 'HTTP 200';
  });

  await check('web: /api rewrite reaches the API', async () => {
    const r = await http(`${webUrl}/api/v1/health/ready`);
    assert(r.status === 200 && r.json?.status === 'ok', `HTTP ${r.status}`);
    return 'HTTP 200 via Next.js rewrite';
  });
}

// --------------------------------------------------------------------- summary
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
process.exit(failed.length === 0 ? 0 : 1);

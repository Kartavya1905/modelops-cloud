#!/usr/bin/env node
/**
 * bench.mjs: the M12 benchmarks, against the running Docker platform (`pnpm dev:up` + `pnpm dev`).
 *
 *   pnpm bench                 all scenarios (~15 min)
 *   pnpm bench --only steady   some scenarios: steady,direct,ramp,canary,footprint,rollback
 *   pnpm bench --into <stamp> --only direct,footprint   add scenarios to an earlier run
 *
 * 1. Setup through the public API only: a fresh user, project, model, two validated versions
 *    (the scikit-learn and PyTorch churn fixtures), a STAGING endpoint with a 1000 req/s limit,
 *    version 1 deployed, an API key.
 * 2. Scenarios (k6 in Docker on the compose network, straight to the gateway container):
 *      steady    50 req/s for 3 minutes
 *      direct    the same, straight to the model server (no gateway): the gateway's overhead
 *      ramp      50 -> 100 -> 200 -> 300 -> 400 req/s, 45 s each: where does it saturate?
 *      canary    version 2 as a 10 % canary; 50 req/s for 2 minutes; the share each revision got
 *      footprint memory of the core stack with this run's two model servers (docker stats)
 *      rollback  10 rollbacks between the two warm revisions: request -> gateway serves the target
 * 3. Everything raw goes to benchmarks/results/<timestamp>/: the full k6 summaries, the Prometheus
 *    queries with their answers, each rollback trial, and the machine it ran on (meta.json).
 *    `pnpm bench:report` turns a results directory into docs/benchmarks/report.md.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { cpus, freemem, release, totalmem, type } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
process.loadEnvFile(join(root, '.env'));
const env = process.env;
const { values: args } = parseArgs({
  options: { only: { type: 'string' }, into: { type: 'string' } },
});
const run = (name) => !args.only || args.only.split(',').includes(name);

const API = `http://127.0.0.1:${env.MO_PORT_API ?? '4000'}/api/v1`;
const GATEWAY_HOST = `http://127.0.0.1:${env.MO_PORT_GATEWAY ?? '18088'}`; // for the rollback probe
const PROMETHEUS = `http://127.0.0.1:${env.MO_PORT_PROMETHEUS ?? '19090'}`;
const K6_IMAGE =
  'grafana/k6:2.3.0@sha256:2dd4756ec6e14e62778916e1eb850108e4b499304c02df56760fa0bdb0fba0b8';
const FIXTURES = join(root, 'tests', 'fixtures', 'bundles');
// --into <stamp>: add scenarios to an earlier run (its setup.json says which endpoint/revision).
const stamp = args.into ?? new Date().toISOString().replace(/[:]/g, '').slice(0, 15); // 20261111T1015
const OUT = join(root, 'benchmarks', 'results', stamp);
mkdirSync(OUT, { recursive: true });
const save = (name, data) => writeFileSync(join(OUT, name), `${JSON.stringify(data, null, 1)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[bench ${new Date().toISOString().slice(11, 19)}] ${m}`);

// ---------------------------------------------------------------------------------------------
// API client (session cookie + CSRF header, like the web console)
// ---------------------------------------------------------------------------------------------
let cookie = '';
let csrf = '';
/** A dropped connection (the dev server restarting) is retried; an HTTP error never is. */
async function retryFetch(url, init) {
  for (let i = 0; ; i++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      if (i >= 4) throw err;
      await sleep(2000);
    }
  }
}

async function api(method, path, body, headers = {}) {
  const form = body instanceof FormData;
  const res = await retryFetch(`${API}${path}`, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(csrf && method !== 'GET' ? { 'x-csrf-token': csrf } : {}),
      ...(body && !form ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: form ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok)
    throw new Error(`${method} ${path}: HTTP ${String(res.status)} ${text.slice(0, 300)}`);
  const set = res.headers.getSetCookie();
  if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  return { body: text ? JSON.parse(text) : null, etag: res.headers.get('etag') };
}
async function until(fn, ok, ms, every = 1000) {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (ok(last)) return last;
    await sleep(every);
  }
  throw new Error(`timed out; last value: ${JSON.stringify(last).slice(0, 300)}`);
}

// ---------------------------------------------------------------------------------------------
// 1. Setup
// ---------------------------------------------------------------------------------------------
async function setup() {
  const session = (
    await api('POST', '/auth/register', {
      email: `bench-${stamp.toLowerCase()}-${crypto.randomUUID().slice(0, 6)}@example.com`,
      name: 'Benchmark',
      password: `bench ${crypto.randomUUID()}`,
    })
  ).body;
  csrf = session.csrfToken;
  const org = session.memberships[0].orgId;
  const project = (await api('POST', `/orgs/${org}/projects`, { name: `Bench ${stamp}` })).body;
  const model = (await api('POST', `/orgs/${org}/projects/${project.id}/models`, { name: 'Churn' }))
    .body;

  const versions = [];
  for (const kind of ['sklearn', 'pytorch']) {
    const manifest = JSON.parse(readFileSync(join(FIXTURES, 'manifest.json'), 'utf8'))[kind];
    const form = new FormData();
    form.set('framework', manifest.framework);
    for (const [part, file] of [
      ['model', 'model.onnx'],
      ['signature', 'signature.json'],
      ['golden', 'golden_examples.json'],
    ]) {
      form.set(part, new Blob([readFileSync(join(FIXTURES, kind, file))]), file);
    }
    const v = (await api('POST', `/orgs/${org}/models/${model.id}/versions/upload`, form)).body;
    const done = await until(
      async () => (await api('GET', `/orgs/${org}/model-versions/${v.id}`)).body,
      (x) => x.status === 'VALIDATED' || x.status === 'REJECTED',
      180_000,
      2000,
    );
    if (done.status !== 'VALIDATED') throw new Error(`${kind} version ${done.status}`);
    versions.push({ id: v.id, kind, framework: manifest.framework });
    log(`version ${kind} validated`);
  }

  const endpoint = (
    await api('POST', `/orgs/${org}/projects/${project.id}/endpoints`, {
      name: `Bench ${stamp}`,
      rateLimitRps: 1000, // the limiter must not be what the ramp measures
    })
  ).body;
  const first = await deployAndWait(org, endpoint.id, versions[0].id);
  const key = (await api('POST', `/orgs/${org}/projects/${project.id}/api-keys`, { name: 'bench' }))
    .body.key;

  const sig = JSON.parse(readFileSync(join(FIXTURES, 'sklearn', 'signature.json'), 'utf8'));
  const golden = JSON.parse(
    readFileSync(join(FIXTURES, 'sklearn', 'golden_examples.json'), 'utf8'),
  );
  const features = sig.inputs[0].features;
  const bodies = golden.inputs.map((row) => ({
    inputs: [Object.fromEntries(features.map((f, i) => [f, row[i]]))],
  }));
  // The routing snapshot reaches the gateway within a second; wait for the first 200.
  await until(
    () => predictOnce(endpoint.slug, key, bodies[0]),
    (r) => r.status === 200,
    30_000,
    250,
  );
  return { org, endpoint, versions, first, key, bodies };
}

async function deployAndWait(org, endpointId, versionId, extra = {}) {
  const rev = (
    await api(
      'POST',
      `/orgs/${org}/endpoints/${endpointId}/revisions`,
      { modelVersionId: versionId, ...extra },
      { 'idempotency-key': crypto.randomUUID() },
    )
  ).body;
  const ready = await until(
    async () => (await api('GET', `/orgs/${org}/revisions/${rev.id}`)).body,
    (r) => ['READY', 'FAILED', 'CANCELLED'].includes(r.state),
    240_000,
    1000,
  );
  if (ready.state !== 'READY')
    throw new Error(`revision ${rev.id} ${ready.state} ${ready.failureCode}`);
  return ready;
}

function predictOnce(slug, key, body) {
  return fetch(`${GATEWAY_HOST}/v1/endpoints/${slug}/predict`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------------------------
// 2. k6 scenarios
// ---------------------------------------------------------------------------------------------
function k6(scenario, ctx, extraEnv = {}, network = 'modelops-backend') {
  const vars = {
    SCENARIO: scenario,
    GATEWAY: 'http://gateway:8080', // the gateway container, from inside the compose network
    ENDPOINT: ctx.endpoint.slug,
    API_KEY: ctx.key ?? '',
    BODIES: JSON.stringify(ctx.bodies),
    ...extraEnv,
  };
  const r = spawnSync(
    'docker',
    [
      ...['run', '--rm', '-i', '--network', network, '-v', `${OUT}:/out`],
      ...Object.keys(vars).flatMap((k) => ['-e', k]),
      ...[K6_IMAGE, 'run', '--quiet', '--no-color', '-'],
    ],
    {
      input: readFileSync(join(root, 'tests', 'load', 'bench.js')),
      env: { ...process.env, ...vars, MSYS_NO_PATHCONV: '1' },
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  // Thresholds that only exist to expose sub-metrics never fail; a non-zero exit is a real error.
  if (r.status !== 0) throw new Error(`k6 ${scenario} failed (${String(r.status)}): ${r.stderr}`);
  return JSON.parse(readFileSync(join(OUT, `${scenario}.json`), 'utf8'));
}

/** Gateway-side percentiles over the last `window` (Prometheus, the same data as the dashboards). */
async function gatewaySide(name, slug, window, revisions) {
  const rev = revisions.join('|');
  const queries = {};
  for (const q of [0.5, 0.95, 0.99]) {
    queries[`request_p${String(q * 100)}`] =
      `histogram_quantile(${String(q)}, sum by (le) (increase(gateway_request_duration_seconds_bucket{stack="dev", source="api", endpoint="${slug}"}[${window}])))`;
    queries[`upstream_p${String(q * 100)}`] =
      `histogram_quantile(${String(q)}, sum by (le) (increase(gateway_upstream_duration_seconds_bucket{stack="dev", revision=~"${rev}"}[${window}])))`;
  }
  queries.requests_by_code = `sum by (code) (increase(gateway_requests_total{stack="dev", source="api", endpoint="${slug}"}[${window}]))`;
  await sleep(12_000); // two scrape intervals, so the last seconds are in
  const out = { at: new Date().toISOString(), window, queries: {} };
  for (const [k, q] of Object.entries(queries)) {
    const res = await fetch(`${PROMETHEUS}/api/v1/query?query=${encodeURIComponent(q)}`);
    out.queries[k] = { promql: q, result: (await res.json()).data?.result ?? [] };
  }
  save(`${name}-gateway.json`, out);
}

// ---------------------------------------------------------------------------------------------
// 3. Rollback timing
// ---------------------------------------------------------------------------------------------
async function rollbackTrials(ctx, a, b, n) {
  const trials = [];
  let target = a;
  for (let i = 0; i < n; i++) {
    const { etag } = await api('GET', `/orgs/${ctx.org}/endpoints/${ctx.endpoint.id}`);
    const t0 = performance.now();
    await api(
      'POST',
      `/orgs/${ctx.org}/endpoints/${ctx.endpoint.id}/rollback`,
      { targetRevisionId: target },
      { 'if-match': etag },
    );
    const tApi = performance.now();
    let polls = 0;
    for (;;) {
      polls++;
      const r = await predictOnce(ctx.endpoint.slug, ctx.key, ctx.bodies[0]);
      if (r.status === 200 && r.headers.get('x-revision-id') === target) break;
      if (performance.now() - t0 > 30_000) throw new Error('rollback not visible after 30 s');
    }
    const tServed = performance.now();
    trials.push({
      trial: i + 1,
      target,
      apiMs: +(tApi - t0).toFixed(1),
      servedMs: +(tServed - t0).toFixed(1),
      probes: polls,
    });
    log(
      `rollback ${String(i + 1)}/${String(n)}: served by the target after ${(tServed - t0).toFixed(0)} ms`,
    );
    target = target === a ? b : a;
    await sleep(2000);
  }
  return trials;
}

// ---------------------------------------------------------------------------------------------
function meta() {
  const sh = (cmd, a) => {
    try {
      return execFileSync(cmd, a, { encoding: 'utf8', cwd: root }).trim();
    } catch {
      return null;
    }
  };
  const names = (sh('docker', ['ps', '--format', '{{.Names}}']) ?? '').split('\n').filter(Boolean);
  return {
    startedAt: new Date().toISOString(),
    machine: {
      os: `${type()} ${release()}`,
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      memoryGiB: +(totalmem() / 2 ** 30).toFixed(1),
      freeMemoryGiBAtStart: +(freemem() / 2 ** 30).toFixed(1),
      docker: sh('docker', ['version', '--format', '{{.Server.Version}}']),
      dockerCpus: sh('docker', ['info', '--format', '{{.NCPU}}']),
      dockerMemoryGiB: (() => {
        const b = Number(sh('docker', ['info', '--format', '{{.MemTotal}}']));
        return b ? +(b / 2 ** 30).toFixed(1) : null;
      })(),
    },
    git: {
      commit: sh('git', ['rev-parse', 'HEAD']),
      uncommittedChanges: (sh('git', ['status', '--porcelain']) ?? '').length > 0,
    },
    limits: {
      gateway: { cpus: 1.0, memory: '256M' }, // infra/compose/docker-compose.yml
      modelServer: { cpus: 0.5, memoryMb: 512 }, // default revision resources
    },
    // M12: failed health checks in a row before the reconciler restarts a running model server
    // (MO_UNHEALTHY_STREAK as the API and worker read it from .env; 3 unless set)
    reconciler: { unhealthyStreak: Number(env.MO_UNHEALTHY_STREAK ?? 3) },
    k6: K6_IMAGE,
    load: 'k6 runs in a container on the compose network and calls the gateway container directly',
    runningContainers: {
      total: names.length,
      modelops: names.filter((n) => n.startsWith('modelops') || n.startsWith('mo-rev')).length,
      other: names.filter((n) => !n.startsWith('modelops') && !n.startsWith('mo-rev')).length,
    },
  };
}

/** The same load with no gateway: k6 joins the internal network and calls the model server. */
function direct(ctx, revisionId) {
  const rows = ctx.bodies.map((b) => ({ inputs: [Object.values(b.inputs[0])] }));
  log(`direct: 50 req/s for 3 minutes straight to mo-rev-${revisionId.slice(0, 8)}… (no gateway)`);
  k6(
    'direct',
    ctx,
    {
      RPS: '50',
      DURATION: '3m',
      DIRECT_URL: `http://mo-rev-${revisionId}:8000`,
      BODIES: JSON.stringify(rows),
    },
    'modelops-inference',
  );
  save('direct-setup.json', {
    revision: revisionId,
    url: `http://mo-rev-${revisionId}:8000/v1/predict`,
  });
}

/**
 * The gateway's status codes over a past window (Prometheus keeps the data): what the overloaded
 * steps of the ramp actually answered. `end` is when the scenario finished.
 */
async function gatewayCodes(name, slug, end, seconds) {
  const q = `sum by (code) (increase(gateway_requests_total{stack="dev", source="api", endpoint="${slug}"}[${String(Math.round(seconds))}s]))`;
  const at = Math.round(end.getTime() / 1000);
  const res = await fetch(
    `${PROMETHEUS}/api/v1/query?query=${encodeURIComponent(q)}&time=${String(at)}`,
  );
  save(`${name}-codes.json`, {
    window: { end: end.toISOString(), seconds: Math.round(seconds) },
    promql: q,
    result: (await res.json()).data?.result ?? [],
  });
}

/**
 * What the platform itself did during the run: every state change of this run's revisions, with
 * its message, and their restart counters (read-only, from the platform's own database).
 */
function revisionEvents(revisionIds) {
  const ids = revisionIds.map((id) => `'${id.replace(/[^0-9a-f-]/g, '')}'`).join(',');
  const sql = `SELECT json_build_object(
      'revisions', (SELECT json_agg(json_build_object('id', id, 'restartCount', restart_count)) FROM deployment_revisions WHERE id IN (${ids})),
      'events', (SELECT json_agg(json_build_object('revision', revision_id, 'from', from_state, 'to', to_state, 'message', message, 'at', created_at) ORDER BY created_at) FROM deployment_events WHERE revision_id IN (${ids})))`;
  const out = execFileSync(
    'docker',
    [
      'exec',
      'modelops-postgres-1',
      'sh',
      '-c',
      `psql -tA -U "$POSTGRES_USER" -d modelops -c "${sql.replaceAll('"', '\\"')}"`,
    ],
    { encoding: 'utf8' },
  );
  save('events.json', JSON.parse(out));
}

/** NFR-2: memory of the core stack plus this run's two model servers (docker stats). */
function footprint(revisions) {
  const lines = execFileSync(
    'docker',
    ['stats', '--no-stream', '--format', '{{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}'],
    { encoding: 'utf8' },
  )
    .trim()
    .split('\n')
    .map((l) => l.split('\t'));
  const mib = (s) => {
    const m = /([\d.]+)\s*([KMG]i?B)/.exec(s);
    if (!m) return 0;
    const f = { KiB: 1 / 1024, KB: 1 / 1024, MiB: 1, MB: 1, GiB: 1024, GB: 1024 }[m[2]] ?? 1;
    return +(Number(m[1]) * f).toFixed(1);
  };
  const wanted = (name) =>
    (name.startsWith('modelops-') && name !== 'modelops-control-plane') ||
    revisions.some((r) => name === `mo-rev-${r}`);
  const containers = lines
    .filter(([name]) => wanted(name))
    .map(([name, mem, cpu]) => ({ name, memMiB: mib(mem.split('/')[0]), cpu }));
  const total = containers.reduce((s, c) => s + c.memMiB, 0);
  save('footprint.json', {
    at: new Date().toISOString(),
    note: 'docker stats of every modelops-* compose container plus the two model servers of this run; the API, worker and web ran on the host (pnpm dev) and are not included',
    containers,
    totalMiB: +total.toFixed(1),
  });
  log(`footprint: ${(total / 1024).toFixed(2)} GiB in ${String(containers.length)} containers`);
}

async function main() {
  if (args.into) {
    // Add scenarios to an earlier run, against the same endpoint and revisions.
    const s = JSON.parse(readFileSync(join(OUT, 'setup.json'), 'utf8'));
    const sig = JSON.parse(readFileSync(join(FIXTURES, 'sklearn', 'signature.json'), 'utf8'));
    const golden = JSON.parse(
      readFileSync(join(FIXTURES, 'sklearn', 'golden_examples.json'), 'utf8'),
    );
    const features = sig.inputs[0].features;
    const ctx = {
      endpoint: s.endpoint,
      bodies: golden.inputs.map((row) => ({
        inputs: [Object.fromEntries(features.map((f, i) => [f, row[i]]))],
      })),
    };
    if (run('direct')) direct(ctx, s.firstRevision);
    if (run('rampcodes')) {
      // from the finished ramp: its file was written when it ended, its summary says how long it ran
      const ramp = JSON.parse(readFileSync(join(OUT, 'ramp.json'), 'utf8'));
      const end = statSync(join(OUT, 'ramp.json')).mtime;
      await gatewayCodes('ramp', s.endpoint.slug, end, ramp.state.testRunDurationMs / 1000);
    }
    if (run('events')) {
      const ids = [s.firstRevision];
      for (const f of ['canary-setup.json', 'rollback.json']) {
        try {
          const j = JSON.parse(readFileSync(join(OUT, f), 'utf8'));
          ids.push(...(j.revisions ?? [j.stable, j.canary]));
        } catch {
          // scenario not run
        }
      }
      revisionEvents([...new Set(ids.filter(Boolean))]);
    }
    if (run('footprint')) {
      // the two revisions still running at the end of a full run (both warm after the rollbacks)
      footprint(JSON.parse(readFileSync(join(OUT, 'rollback.json'), 'utf8')).revisions);
    }
    log(`added to ${OUT}`);
    return;
  }
  const m = meta();
  save('meta.json', m);
  log(`results -> ${OUT}`);
  const ctx = await setup();
  save('setup.json', {
    endpoint: { id: ctx.endpoint.id, slug: ctx.endpoint.slug, rateLimitRps: 1000 },
    versions: ctx.versions,
    firstRevision: ctx.first.id,
    requestBodies: ctx.bodies.length,
  });
  log(`endpoint ${ctx.endpoint.slug} serving ${ctx.versions[0].kind} (revision ${ctx.first.id})`);

  k6('warmup', ctx, { RPS: '20', DURATION: '20s' }); // JIT, connection pools; not reported

  if (run('steady')) {
    log('steady: 50 req/s for 3 minutes');
    k6('steady', ctx, { RPS: '50', DURATION: '3m' });
    await gatewaySide('steady', ctx.endpoint.slug, '3m', [ctx.first.id]);
  }
  if (run('direct')) direct(ctx, ctx.first.id);
  if (run('ramp')) {
    log('ramp: 50, 100, 200, 300, 400 req/s, 45 s each');
    const ramp = k6('ramp', ctx, { STEPS: '50,100,200,300,400', STEP: '45s' });
    await sleep(12_000); // two scrape intervals
    await gatewayCodes(
      'ramp',
      ctx.endpoint.slug,
      new Date(Date.now() - 12_000),
      ramp.state.testRunDurationMs / 1000,
    );
  }
  let second;
  if (run('canary') || run('rollback')) {
    log('canary: deploying version 2 with 10 % of the traffic');
    second = await deployAndWait(ctx.org, ctx.endpoint.id, ctx.versions[1].id, {
      strategy: 'CANARY',
      canaryWeight: 10,
    });
    await sleep(2000);
  }
  if (run('canary')) {
    k6('canary', ctx, {
      RPS: '50',
      DURATION: '2m',
      REVISIONS: `${ctx.first.id},${second.id}`,
    });
    save('canary-setup.json', { stable: ctx.first.id, canary: second.id, weightPercent: 10 });
    await gatewaySide('canary', ctx.endpoint.slug, '2m', [ctx.first.id, second.id]);
  }
  if (run('footprint') && second) footprint([ctx.first.id, second.id]); // both revisions up
  if (run('rollback')) {
    // Make version 2 the stable revision (blue/green), version 1 stays warm (draining), then
    // roll back and forth between the two.
    const { etag } = await api('GET', `/orgs/${ctx.org}/endpoints/${ctx.endpoint.id}`);
    await api('POST', `/orgs/${ctx.org}/endpoints/${ctx.endpoint.id}/canary/abort`, undefined, {
      'if-match': etag,
    }).catch(() => undefined); // the analysis may have ended it already
    const v2 = await deployAndWait(ctx.org, ctx.endpoint.id, ctx.versions[1].id);
    await until(
      () => predictOnce(ctx.endpoint.slug, ctx.key, ctx.bodies[0]),
      (r) => r.headers.get('x-revision-id') === v2.id,
      30_000,
      250,
    );
    log('rollback: 10 trials between the two warm revisions');
    const trials = await rollbackTrials(ctx, ctx.first.id, v2.id, 10);
    save('rollback.json', { revisions: [ctx.first.id, v2.id], trials });
  }
  revisionEvents([ctx.first.id, second?.id].filter(Boolean)); // what the platform did meanwhile
  save('meta.json', { ...m, finishedAt: new Date().toISOString() });
  log(`done: ${OUT}`);
  log('next: pnpm bench:report');
}

await main();

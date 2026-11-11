import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { TestingModule } from '@nestjs/testing';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { OutboxRelay } from '../../src/modules/deployments/outbox.relay';
import { ValidationService } from '../../src/modules/validation/validation.service';
import { loadBundle, uniqueGolden, uniqueModel } from '../integration/bundles';
import { API, Client, createTestApp, createTestWorker, prismaOf } from '../integration/helpers';

/**
 * M9 chaos: real faults against the real stack, not simulated ones. The deployment worker runs as
 * a separate OS process (`node dist/worker.js`) so it can be killed with SIGKILL; Redis is
 * flushed and restarted, Postgres is paused, a model server container is killed. Every scenario
 * must end in a correct terminal state within its deadline (docs/05 §7), and records what it saw
 * in test-results/chaos-report.json for the reliability report (docs/milestones/m9-…).
 */
interface Result {
  scenario: string;
  fault: string;
  expected: string;
  observed: Record<string, unknown>;
  recoveryMs: number;
  deadlineMs: number;
  ok: boolean;
}
const results: Result[] = [];
const REPORT = join(process.cwd(), 'test-results', 'chaos-report.json');

let app: NestExpressApplication;
let ada: Client;
let projectId: string;
let modelId: string;
let versionId: string;
let apiKey: string;
let worker: ChildProcess | null = null;
let workerLog = '';
const sklearn = loadBundle('sklearn');
const golden = (JSON.parse(sklearn.golden.toString('utf8')) as { inputs: number[][] }).inputs;
const features =
  (JSON.parse(sklearn.signature.toString('utf8')) as { inputs: { features: string[] }[] }).inputs[0]
    ?.features ?? [];
const row = (i: number) =>
  Object.fromEntries(features.map((f, k) => [f, golden[i % golden.length]?.[k] ?? 0]));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const docker = (...args: string[]) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** The real worker process, on the test database / Redis DB / gateway, with fast loops. */
async function startWorker(): Promise<void> {
  const child = spawn(process.execPath, ['--enable-source-maps', 'dist/worker.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: inject('databaseUrl'),
      REDIS_URL: inject('redisUrl'),
      MO_GATEWAY_URL: inject('gatewayUrl'),
      MO_GATEWAY_ADMIN_URL: inject('gatewayAdminUrl'),
      MO_INSTANCE_ID: inject('instanceId'),
      MO_RECONCILE_MS: '2000',
      MO_DEPLOY_RELAY_MS: '300',
      MO_CANARY_ANALYSIS_MS: '600000',
      MO_DRIFT_INTERVAL_MS: '3600000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d: Buffer) => (workerLog += d.toString()));
  child.stderr.on('data', (d: Buffer) => (workerLog += d.toString()));
  worker = child;
  const deadline = Date.now() + 60_000;
  while (!workerLog.includes('deployment worker started')) {
    if (Date.now() > deadline || child.exitCode !== null) {
      throw new Error(`worker did not start:\n${workerLog.slice(-2000)}`);
    }
    await sleep(100);
  }
}

function killWorker(): void {
  worker?.kill('SIGKILL');
  worker = null;
}

async function stopWorker(): Promise<void> {
  if (!worker) return;
  const w = worker;
  worker = null;
  w.kill('SIGTERM');
  for (let i = 0; i < 100 && w.exitCode === null; i++) await sleep(100);
  if (w.exitCode === null) w.kill('SIGKILL');
}

const state = async (id: string) =>
  (await prismaOf(app).deploymentRevision.findUniqueOrThrow({ where: { id } })).state;

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms: number, step = 100) {
  const deadline = Date.now() + ms;
  let last = await fn();
  while (!ok(last) && Date.now() < deadline) {
    await sleep(step);
    last = await fn();
  }
  return last;
}

/** Revision ids whose containers are running for this test instance. */
const runningContainers = (revisionId: string) =>
  docker(
    'ps',
    '--filter',
    `label=modelops.revision=${revisionId}`,
    '--filter',
    'status=running',
    '--format',
    '{{.Names}}',
  )
    .split('\n')
    .filter(Boolean);

async function deploy(endpointId: string) {
  const res = await ada.agent
    .post(`${API}/orgs/${ada.orgId}/endpoints/${endpointId}/revisions`)
    .set('x-csrf-token', ada.session.csrfToken)
    .set('idempotency-key', crypto.randomUUID())
    .send({ modelVersionId: versionId });
  if (res.status !== 202) throw new Error(`deploy ${String(res.status)} ${res.text}`);
  return (res.body as { id: string }).id;
}

async function newEndpoint(name: string) {
  const res = await ada.post(`/orgs/${ada.orgId}/projects/${projectId}/endpoints`, {
    name,
    rateLimitRps: 1000,
  });
  return res.body as { id: string; slug: string };
}

/** Steady client traffic while a fault happens: counts answers by status, with timestamps. */
function traffic(slug: string, everyMs = 20) {
  const statuses: { at: number; status: number }[] = [];
  let running = true;
  let i = 0;
  const loop = async () => {
    while (running) {
      const at = Date.now();
      const status = await fetch(`${inject('gatewayUrl')}/v1/endpoints/${slug}/predict`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ inputs: [row(i++)] }),
        signal: AbortSignal.timeout(5000),
      })
        .then(async (r) => {
          await r.arrayBuffer();
          return r.status;
        })
        .catch(() => 0); // no answer at all (connection refused / timeout)
      statuses.push({ at, status });
      await sleep(everyMs);
    }
  };
  const done = Promise.all([loop(), loop()]);
  return {
    statuses,
    async stop() {
      running = false;
      await done;
      const by: Record<string, number> = {};
      for (const s of statuses) by[String(s.status)] = (by[String(s.status)] ?? 0) + 1;
      return by;
    },
  };
}

function record(r: Result) {
  results.push(r);
  console.info(`[chaos] ${r.scenario}: ${r.ok ? 'OK' : 'NOT OK'} ${JSON.stringify(r.observed)}`);
}

beforeAll(async () => {
  app = await createTestApp();
  ada = await Client.register(app, { name: 'Ada' });
  projectId = (
    (await ada.post(`/orgs/${ada.orgId}/projects`, { name: 'Chaos' })).body as { id: string }
  ).id;
  modelId = (
    (await ada.post(`/orgs/${ada.orgId}/projects/${projectId}/models`, { name: 'Churn' })).body as {
      id: string;
    }
  ).id;
  const up = await ada.upload(
    `/orgs/${ada.orgId}/models/${modelId}/versions/upload`,
    { framework: sklearn.framework },
    {
      model: uniqueModel(sklearn.model),
      signature: sklearn.signature,
      golden: uniqueGolden(sklearn.golden),
    },
  );
  versionId = (up.body as { id: string }).id;
  const validator: TestingModule = await createTestWorker();
  await validator.get(ValidationService).process(versionId, false);
  await validator.close();
  apiKey = (
    (await ada.post(`/orgs/${ada.orgId}/projects/${projectId}/api-keys`, { name: 'chaos' }))
      .body as { key: string }
  ).key;
}, 240_000);

afterAll(async () => {
  await stopWorker();
  // Never leave the shared stack broken, whatever failed above.
  try {
    docker('unpause', 'modelops-postgres-1');
  } catch {
    // not paused
  }
  mkdirSync(join(process.cwd(), 'test-results'), { recursive: true });
  writeFileSync(
    REPORT,
    `${JSON.stringify({ at: new Date().toISOString(), platform: process.platform, results }, null, 2)}\n`,
  );
  console.info(`[chaos] report: ${REPORT}`);
  await app.close();
});

describe('chaos (docs/05 §7 guarantees under real faults)', () => {
  let ep: { id: string; slug: string };

  it('the deployment worker is killed (SIGKILL) mid-deploy: a new worker finishes it, one container', async () => {
    ep = await newEndpoint('Chaos churn');
    await startWorker();
    const revId = await deploy(ep.id);
    const at = await waitFor(
      () => state(revId),
      (s) => s === 'PROVISIONING' || s === 'LOADING' || s === 'READY',
      30_000,
      20,
    );
    killWorker();
    const killedAt = Date.now();
    await sleep(3000);
    const whileDead = await state(revId);
    await startWorker();
    const final = await waitFor(
      () => state(revId),
      (s) => s === 'READY' || s === 'FAILED',
      150_000,
      250,
    );
    const recoveryMs = Date.now() - killedAt;
    const containers = runningContainers(revId);
    record({
      scenario: 'worker killed mid-deploy',
      fault: `SIGKILL of the worker process while the revision was ${at}`,
      expected: 'READY within the state deadline (LOADING 120 s), exactly one container',
      observed: {
        killedIn: at,
        stateWhileNoWorker: whileDead,
        final,
        containers: containers.length,
      },
      recoveryMs,
      deadlineMs: 120_000,
      ok: final === 'READY' && containers.length === 1,
    });
    expect(at).not.toBe('READY'); // the kill happened mid-deploy
    expect(final).toBe('READY');
    expect(containers).toHaveLength(1);
  });

  it('Redis loses everything (FLUSHDB) with a deploy queued: the reconciler re-enqueues it and re-publishes the data plane', async () => {
    await stopWorker();
    const other = await newEndpoint('Chaos queued');
    const revId = await deploy(other.id);
    const inProcess = await createTestWorker(); // relay only: REQUESTED -> QUEUED + job in Redis
    await inProcess.get(OutboxRelay).runOnce();
    await inProcess.close();
    expect(await state(revId)).toBe('QUEUED');

    const load = traffic(ep.slug);
    await sleep(1000);
    const redis = new Redis(inject('redisUrl'));
    await redis.flushdb(); // the job, the routing snapshot, the API-key directory: all gone
    const flushedAt = Date.now();
    const jobsLeft = await redis.keys('bull:*');
    redis.disconnect();
    await startWorker();
    const final = await waitFor(
      () => state(revId),
      (s) => s === 'READY' || s === 'FAILED' || s === 'CANCELLED',
      120_000,
      250,
    );
    const recoveryMs = Date.now() - flushedAt;
    await sleep(2000);
    const by = await load.stop();
    const errors = Object.entries(by).filter(([s]) => s !== '200');
    record({
      scenario: 'Redis flushed (all queue, routing and key data lost)',
      fault: 'FLUSHDB on the platform Redis database with a revision QUEUED and traffic running',
      expected: 'the queued revision reaches READY; clients keep being served',
      observed: { bullKeysAfterFlush: jobsLeft.length, final, traffic: by },
      recoveryMs,
      deadlineMs: 10 * 60_000, // QUEUED deadline
      ok: final === 'READY' && errors.length === 0,
    });
    expect(final).toBe('READY');
    expect(errors).toEqual([]); // the gateway serves from its last snapshot and key cache
  });

  it('Redis restarts: predictions never stop, the worker reconnects and deploys again', async () => {
    const load = traffic(ep.slug);
    await sleep(1000);
    const restartedAt = Date.now();
    docker('restart', '-t', '2', 'modelops-redis-1');
    const backAt = Date.now();
    await sleep(3000);
    const revId = await deploy(ep.id); // a redeploy after the restart
    const final = await waitFor(
      () => state(revId),
      (s) => s === 'READY' || s === 'FAILED',
      120_000,
      250,
    );
    const recoveryMs = Date.now() - restartedAt;
    const by = await load.stop();
    const errors = Object.entries(by).filter(([s]) => s !== '200');
    record({
      scenario: 'Redis restarted',
      fault: 'docker restart of the Redis container with traffic running',
      expected:
        'no client errors (rate limiter fails open, keys cached, routing in memory); next deploy READY',
      observed: { redisDownMs: backAt - restartedAt, redeploy: final, traffic: by },
      recoveryMs,
      deadlineMs: 120_000,
      ok: final === 'READY' && errors.length === 0,
    });
    expect(final).toBe('READY');
    expect(errors).toEqual([]);
  });

  it('Postgres is paused for 15 s: inference keeps working, readiness says so, a deploy finishes afterwards', async () => {
    const other = await newEndpoint('Chaos paused');
    const revId = await deploy(other.id);
    const load = traffic(ep.slug);
    await sleep(500);
    docker('pause', 'modelops-postgres-1');
    const pausedAt = Date.now();
    let readyDuring: number;
    try {
      readyDuring = (await request(app.getHttpServer()).get(`${API}/health/ready`)).status;
      await sleep(Math.max(0, 15_000 - (Date.now() - pausedAt)));
    } finally {
      docker('unpause', 'modelops-postgres-1');
    }
    const resumedAt = Date.now();
    const readyAfter = (
      await waitFor(
        () => request(app.getHttpServer()).get(`${API}/health/ready`),
        (r) => r.status === 200,
        30_000,
        250,
      )
    ).status;
    const final = await waitFor(
      () => state(revId),
      (s) => s === 'READY' || s === 'FAILED',
      120_000,
      250,
    );
    const recoveryMs = Date.now() - resumedAt;
    const by = await load.stop();
    const errors = Object.entries(by).filter(([s]) => s !== '200');
    const rev = await prismaOf(app).deploymentRevision.findUniqueOrThrow({ where: { id: revId } });
    if (final !== 'READY') {
      console.info(`[chaos] ${String(rev.failureCode)}: ${String(rev.failureDetail)}`);
      console.info(workerLog.slice(-4000));
    }
    record({
      scenario: 'Postgres paused',
      fault:
        'docker pause of the Postgres container for 15 s, with a deploy in flight and traffic running',
      expected:
        'no client errors (the data plane never reads Postgres); readiness 503 then 200; the deploy ends READY',
      observed: {
        pausedMs: resumedAt - pausedAt,
        readyDuring,
        readyAfter,
        deploy: final,
        traffic: by,
      },
      recoveryMs,
      deadlineMs: 120_000,
      ok: final === 'READY' && errors.length === 0 && readyDuring === 503 && readyAfter === 200,
    });
    expect(readyDuring).toBe(503);
    expect(readyAfter).toBe(200);
    expect(final).toBe('READY');
    expect(errors).toEqual([]);
  });

  it('the serving model server is killed: the reconciler restarts it and traffic comes back', async () => {
    const e = (await ada.get(`/orgs/${ada.orgId}/endpoints/${ep.id}`)).body as {
      stableRevision: { id: string };
    };
    const revId = e.stableRevision.id;
    const load = traffic(ep.slug);
    await sleep(1000);
    const [name] = runningContainers(revId);
    docker('kill', name ?? '');
    const killedAt = Date.now();
    const degraded = await waitFor(
      () => state(revId),
      (s) => s === 'DEGRADED',
      30_000,
      100,
    );
    const degradedAt = Date.now();
    const final = await waitFor(
      () => state(revId),
      (s) => s === 'READY' || s === 'FAILED',
      60_000,
      100,
    );
    // Recovered = the gateway answers 200 again after the kill.
    await waitFor(
      () => Promise.resolve(load.statuses.filter((s) => s.at > killedAt + 500).slice(-5)),
      (last) => last.length === 5 && last.every((s) => s.status === 200),
      60_000,
      200,
    );
    const recoveryMs = Date.now() - killedAt;
    await sleep(1000);
    const by = await load.stop();
    const after = load.statuses.filter((s) => s.at > killedAt);
    const failed = after.filter((s) => s.status !== 200);
    const lastFailure = failed.length ? Math.max(...failed.map((s) => s.at)) - killedAt : 0;
    const restarts = (
      await prismaOf(app).deploymentRevision.findUniqueOrThrow({ where: { id: revId } })
    ).restartCount;
    record({
      scenario: 'model server killed',
      fault: 'docker kill of the only serving model server, with traffic running',
      expected:
        'DEGRADED, restarted within the budget (3 / 10 min), READY again; errors only until then',
      observed: {
        degraded,
        msToDegraded: degradedAt - killedAt,
        final,
        restarts,
        errorWindowMs: lastFailure,
        traffic: by,
      },
      recoveryMs,
      deadlineMs: 60_000,
      ok: final === 'READY' && restarts >= 1,
    });
    expect(degraded).toBe('DEGRADED');
    expect(final).toBe('READY');
    expect(restarts).toBeGreaterThanOrEqual(1);
  });
});

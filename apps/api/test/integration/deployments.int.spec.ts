import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { ArtifactStore } from '../../src/common/storage/artifact-store';
import { APP_CONFIG, type AppConfig } from '../../src/config/config';
import { DataPlanePublisher } from '../../src/modules/deployments/dataplane';
import { DeployProcessor } from '../../src/modules/deployments/deploy.processor';
import { DeployQueue } from '../../src/modules/deployments/deploy.queue';
import { OutboxRelay } from '../../src/modules/deployments/outbox.relay';
import { Reconciler } from '../../src/modules/deployments/reconciler';
import { ModelServerProbe } from '../../src/modules/deployments/probe';
import {
  RUNTIME_DRIVER,
  type RuntimeDriver,
} from '../../src/modules/deployments/runtime/runtime-driver';
import { ValidationService } from '../../src/modules/validation/validation.service';
import { type Bundle, loadBundle, uniqueGolden, uniqueModel } from './bundles';
import { Client, createTestApp, createTestWorker, prismaOf, type Problem } from './helpers';
import { readPod, tcpFromNewPod, tcpFromPod } from './kind-runtime';

/**
 * M5 end to end against real infrastructure: Postgres, Redis, SeaweedFS, the ml-worker (to
 * validate versions), Docker through the socket proxy (one model-server container per revision)
 * and a gateway container on the internal inference network.
 * M10: with `MO_TEST_RUNTIME=kubernetes` (`pnpm test:k8s`) the same tests run against the
 * KubernetesDriver: one pod + Service + NetworkPolicy per revision in kind, and a gateway pod.
 * The worker's loops are off: tests drive relay -> processor -> reconciler step by step.
 */
interface Revision {
  id: string;
  revisionNumber: number;
  state: string;
  failureCode: string | null;
  failureDetail: string | null;
  runtimeRef: string | null;
  events: { fromState: string | null; toState: string }[];
}
interface Endpoint {
  id: string;
  slug: string;
  invokeUrl: string;
  stableRevision: { id: string } | null;
  inProgressRevision: { id: string } | null;
  revisions: { id: string; state: string }[];
}
interface Golden {
  inputs: number[][];
  outputs: { label: number[]; probabilities: number[][] };
}

let app: NestExpressApplication;
let worker: TestingModule;
let ada: Client;
let viewer: Client;
let projectId: string;
let modelId: string;
let apiKey: string;
let features: string[];
const sklearn = loadBundle('sklearn');
const pytorch = loadBundle('pytorch');
const PROXY = 'http://127.0.0.1:12375';
/** M10: the same suite runs against Docker or kind (`MO_TEST_RUNTIME`, see global-setup). */
const RUNTIME = inject('runtime');
const NAMESPACE = inject('runtimeEnv').MO_K8S_NAMESPACE ?? '';
const GATEWAY = () => inject('gatewayUrl');
let n = 0;

const code = (res: { body: unknown }) => (res.body as Problem).code;
const relay = () => worker.get(OutboxRelay).runOnce();
const processor = () => worker.get(DeployProcessor);
const reconciler = () => worker.get(Reconciler);
const driver = () => worker.get<RuntimeDriver>(RUNTIME_DRIVER);
const getRevision = async (id: string) =>
  (await ada.get(`/orgs/${ada.orgId}/revisions/${id}`)).body as Revision;
const getEndpoint = async (id: string) =>
  (await ada.get(`/orgs/${ada.orgId}/endpoints/${id}`)).body as Endpoint;

/** Upload + validate with the real ml-worker; returns a VALIDATED version id. */
async function validatedVersion(b: Bundle, golden = uniqueGolden(b.golden)): Promise<string> {
  const res = await ada.upload(
    `/orgs/${ada.orgId}/models/${modelId}/versions/upload`,
    { framework: b.framework },
    { model: b.model, signature: b.signature, golden },
  );
  if (res.status !== 201) throw new Error(`upload ${String(res.status)} ${res.text}`);
  const id = (res.body as { id: string }).id;
  await worker.get(ValidationService).process(id, false);
  const v = await prismaOf(app).modelVersion.findUniqueOrThrow({ where: { id } });
  if (v.status !== 'VALIDATED') throw new Error(`version ${id} is ${v.status}`);
  return id;
}

async function newEndpoint(): Promise<Endpoint> {
  const res = await ada.post(`/orgs/${ada.orgId}/projects/${projectId}/endpoints`, {
    name: `Churn ${String(++n)}`,
  });
  if (res.status !== 201) throw new Error(`endpoint ${String(res.status)} ${res.text}`);
  return res.body as Endpoint;
}

function deploy(endpointId: string, modelVersionId: string, key = crypto.randomUUID()) {
  return ada.agent
    .post(`/api/v1/orgs/${ada.orgId}/endpoints/${endpointId}/revisions`)
    .set('x-csrf-token', ada.session.csrfToken)
    .set('idempotency-key', key)
    .send({ modelVersionId });
}

/** REQUESTED -> ... -> READY (or FAILED), exactly as the worker would do it. */
async function runToEnd(revisionId: string): Promise<Revision> {
  await relay();
  await processor().process(revisionId, { isFinalAttempt: true });
  return getRevision(revisionId);
}

async function deployed(endpointId: string, versionId: string): Promise<Revision> {
  const res = await deploy(endpointId, versionId);
  if (res.status !== 202) throw new Error(`deploy ${String(res.status)} ${res.text}`);
  return runToEnd((res.body as Revision).id);
}

async function dockerInspect(revisionId: string) {
  const res = await fetch(`${PROXY}/containers/mo-rev-${revisionId}/json`);
  return res.status === 404
    ? null
    : ((await res.json()) as {
        State: { Status: string };
        Config: { User: string; Labels: Record<string, string> };
        HostConfig: {
          ReadonlyRootfs: boolean;
          CapDrop: string[];
          SecurityOpt: string[];
          NetworkMode: string;
          Memory: number;
          NanoCpus: number;
          PidsLimit: number;
          RestartPolicy: { Name: string };
        };
      });
}

/** Waits until the gateway's routing table (500 ms poll + pub/sub) serves `revisionId`. */
function predict(slug: string, rows: Record<string, number>[]) {
  return predictWith(apiKey, slug, rows);
}
/** Explicit key: never falls back to the default one (a failed setup must not be masked). */
async function predictWith(key: string, slug: string, rows: Record<string, number>[]) {
  if (!key) throw new Error('predictWith needs a key');
  return fetch(`${GATEWAY()}/v1/endpoints/${slug}/predict`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ inputs: rows }),
  });
}
async function eventually<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 10_000) {
  const deadline = Date.now() + ms;
  let last = await fn();
  while (!ok(last) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    last = await fn();
  }
  return last;
}

const goldenOf = (b: Bundle) => JSON.parse(b.golden.toString('utf8')) as Golden;
const asRows = (inputs: number[][]) =>
  inputs.map((r) => Object.fromEntries(features.map((f, i) => [f, r[i] ?? 0])));

beforeAll(async () => {
  app = await createTestApp({ MO_DRAIN_GRACE_MS: '0' });
  worker = await createTestWorker({ MO_DRAIN_GRACE_MS: '0' });
  ada = await Client.register(app, { name: 'Ada' });
  viewer = await Client.register(app, { name: 'Vic' });
  await prismaOf(app).membership.create({
    data: { orgId: ada.orgId, userId: viewer.userId, role: 'VIEWER' },
  });
  projectId = (
    (await ada.post(`/orgs/${ada.orgId}/projects`, { name: 'Serving' })).body as {
      id: string;
    }
  ).id;
  modelId = (
    (await ada.post(`/orgs/${ada.orgId}/projects/${projectId}/models`, { name: 'Churn' })).body as {
      id: string;
    }
  ).id;
  const key = await ada.post(`/orgs/${ada.orgId}/projects/${projectId}/api-keys`, {
    name: 'tests',
  });
  apiKey = (key.body as { key: string }).key;
  features =
    (
      JSON.parse(sklearn.signature.toString('utf8')) as {
        inputs: { features: string[] }[];
      }
    ).inputs[0]?.features ?? [];
}, 120_000);
afterAll(async () => {
  await worker.close();
  await app.close();
});

describe('deploy -> READY -> predict', () => {
  it('runs a validated model in a hardened container and serves exact predictions', async () => {
    const versionId = await validatedVersion(sklearn);
    const ep = await newEndpoint();
    expect(ep.invokeUrl).toBe(`${GATEWAY()}/v1/endpoints/${ep.slug}/predict`);

    // Before any revision: the endpoint exists for the gateway, but nothing serves it.
    const idle = await eventually(
      () => predict(ep.slug, asRows(goldenOf(sklearn).inputs.slice(0, 1))),
      (r) => r.status === 503,
    );
    expect(idle.status).toBe(503);

    const res = await deploy(ep.id, versionId);
    expect(res.status).toBe(202);
    const requested = res.body as Revision;
    expect(requested.state).toBe('REQUESTED');

    const rev = await runToEnd(requested.id);
    expect(rev.failureDetail).toBeNull();
    expect(rev.state).toBe('READY');
    expect(rev.events.map((e) => e.toState)).toEqual([
      'REQUESTED',
      'QUEUED',
      'PROVISIONING',
      'LOADING',
      'VERIFYING',
      'READY',
    ]);
    expect((await getEndpoint(ep.id)).stableRevision?.id).toBe(rev.id);

    // docs/02 §8: the model server runs exactly as designed, on either runtime.
    expect((await driver().inspect(rev.id))?.state).toBe('running');
    if (RUNTIME === 'kubernetes') {
      const pod = readPod(NAMESPACE, `mo-rev-${rev.id}`);
      expect(pod?.status.phase).toBe('Running');
      expect(pod?.spec).toMatchObject({
        restartPolicy: 'Never', // restarts are the reconciler's, with its budget
        automountServiceAccountToken: false,
        securityContext: { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001 },
      });
      expect(pod?.spec.containers[0]?.securityContext).toEqual({
        readOnlyRootFilesystem: true,
        allowPrivilegeEscalation: false,
        capabilities: { drop: ['ALL'] },
      });
      expect(pod?.spec.containers[0]?.resources).toEqual({
        requests: { cpu: '100m', memory: '512Mi' }, // MO_K8S_CPU_REQUEST in the test run
        limits: { cpu: '500m', memory: '512Mi' },
      });
      expect(pod?.metadata.labels['modelops.instance']).toBe(inject('instanceId'));
    } else {
      const c = await dockerInspect(rev.id);
      expect(c?.Config.User).toBe('10001:10001');
      expect(c?.HostConfig).toMatchObject({
        ReadonlyRootfs: true,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        NetworkMode: 'modelops-inference',
        Memory: 512 * 1024 * 1024,
        NanoCpus: 500_000_000,
        PidsLimit: 128,
        RestartPolicy: { Name: 'no' },
      });
      expect(c?.Config.Labels['modelops.instance']).toBe(inject('instanceId'));
    }

    // Inference correctness: gateway output == the ONNX Runtime outputs recorded at training.
    const golden = goldenOf(sklearn);
    const out = await eventually(
      () => predict(ep.slug, asRows(golden.inputs)),
      (r) => r.status === 200,
    );
    expect(out.status).toBe(200);
    expect(out.headers.get('x-revision-id')).toBe(rev.id);
    const body = (await out.json()) as {
      revisionId: string;
      model: { version: number; framework: string };
      outputs: { label: number; probabilities: Record<string, number> }[];
      predictionIds: string[];
    };
    expect(body.model.framework).toBe('SKLEARN_ONNX');
    expect(out.headers.get('x-model-version')).toBe(String(body.model.version));
    expect(body.outputs.map((o) => o.label)).toEqual(golden.outputs.label);
    body.outputs.forEach((o, i) => {
      expect(o.probabilities['0']).toBeCloseTo(golden.outputs.probabilities[i]?.[0] ?? NaN, 6);
      expect(o.probabilities['1']).toBeCloseTo(golden.outputs.probabilities[i]?.[1] ?? NaN, 6);
    });
    expect(new Set(body.predictionIds).size).toBe(golden.inputs.length);
  }, 180_000);

  it('a redeploy switches traffic only after verification; the old revision drains, then retires', async () => {
    const ep = await newEndpoint();
    const first = await deployed(ep.id, await validatedVersion(sklearn));
    expect(first.state).toBe('READY');
    const second = await deployed(ep.id, await validatedVersion(pytorch));
    expect(second.state).toBe('READY');
    expect((await getRevision(first.id)).state).toBe('DRAINING');
    expect((await getEndpoint(ep.id)).stableRevision?.id).toBe(second.id);

    const row = asRows(goldenOf(pytorch).inputs.slice(0, 1));
    const res = await eventually(
      () => predict(ep.slug, row),
      (r) => r.headers.get('x-revision-id') === second.id,
    );
    expect(res.headers.get('x-revision-id')).toBe(second.id);

    // Grace period is 0 in tests: the next reconcile retires the drained revision.
    await reconciler().reconcile();
    expect((await getRevision(first.id)).state).toBe('RETIRED');
    expect(await driver().inspect(first.id)).toBeNull();
    expect((await driver().inspect(second.id))?.state).toBe('running');
  }, 240_000);
});

describe('idempotency (docs/05 §4)', () => {
  it('ten concurrent submits with the same key create one revision and replay one answer', async () => {
    const versionId = await validatedVersion(sklearn);
    const ep = await newEndpoint();
    const key = crypto.randomUUID();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => deploy(ep.id, versionId, key)),
    );
    expect(results.map((r) => r.status)).toEqual(Array(10).fill(202));
    expect(new Set(results.map((r) => (r.body as Revision).id)).size).toBe(1);
    expect(results.filter((r) => r.headers['idempotent-replayed'] === 'true')).toHaveLength(9);
    const rows = await prismaOf(app).deploymentRevision.count({ where: { endpointId: ep.id } });
    expect(rows).toBe(1);
    const outbox = await prismaOf(app).outboxMessage.count({
      where: { aggregateId: (results[0]?.body as Revision).id },
    });
    expect(outbox).toBe(1);

    // Same key, different body: refused.
    const other = await validatedVersion(sklearn);
    const reused = await deploy(ep.id, other, key);
    expect(reused.status).toBe(409);
    expect(code(reused)).toBe('IDEMPOTENCY_KEY_REUSED');

    // Different keys while one is in progress: one deployment at a time per endpoint.
    const busy = await deploy(ep.id, other);
    expect(busy.status).toBe(409);
    expect(code(busy)).toBe('DEPLOYMENT_IN_PROGRESS');

    // Only one container ever exists for the endpoint, even if the job is processed twice.
    const id = (results[0]?.body as Revision).id;
    await relay();
    await Promise.all([processor().process(id), processor().process(id)]);
    expect((await getRevision(id)).state).toBe('READY');
    const containers = (await driver().list()).filter((c) => c.revisionId === id);
    expect(containers).toHaveLength(1);
  }, 240_000);

  it('requires an Idempotency-Key, a validated version and a writer role', async () => {
    const ep = await newEndpoint();
    const versionId = await validatedVersion(sklearn);
    const noKey = await ada.post(`/orgs/${ada.orgId}/endpoints/${ep.id}/revisions`, {
      modelVersionId: versionId,
    });
    expect(noKey.status).toBe(400);

    const pending = await ada.upload(
      `/orgs/${ada.orgId}/models/${modelId}/versions/upload`,
      { framework: sklearn.framework },
      { model: sklearn.model, signature: sklearn.signature, golden: uniqueGolden(sklearn.golden) },
    );
    const notValidated = await deploy(ep.id, (pending.body as { id: string }).id);
    expect(notValidated.status).toBe(422);
    expect(code(notValidated)).toBe('MODEL_NOT_VALIDATED');

    const asViewer = await viewer.agent
      .post(`/api/v1/orgs/${ada.orgId}/endpoints/${ep.id}/revisions`)
      .set('x-csrf-token', viewer.session.csrfToken)
      .set('idempotency-key', crypto.randomUUID())
      .send({ modelVersionId: versionId });
    expect(asViewer.status).toBe(403);
  }, 120_000);

  it('SEC-6: the database refuses a revision for an unvalidated version even if the API is bypassed', async () => {
    const ep = await newEndpoint();
    const pending = await ada.upload(
      `/orgs/${ada.orgId}/models/${modelId}/versions/upload`,
      { framework: sklearn.framework },
      { model: sklearn.model, signature: sklearn.signature, golden: uniqueGolden(sklearn.golden) },
    );
    await expect(
      prismaOf(app).deploymentRevision.create({
        data: {
          orgId: ada.orgId,
          endpointId: ep.id,
          modelVersionId: (pending.body as { id: string }).id,
          revisionNumber: 99,
          requestedById: ada.userId,
        },
      }),
    ).rejects.toThrow(/not VALIDATED/);
  });
});

describe('failures and recovery', () => {
  it('a worker crash mid-deploy resumes on redelivery without a second container', async () => {
    const ep = await newEndpoint();
    const versionId = await validatedVersion(sklearn);
    const id = ((await deploy(ep.id, versionId)).body as Revision).id;
    await relay();
    // Crash right after the container was created (state LOADING, never verified).
    await processor().process(id, { stopAfter: 'LOADING' });
    expect((await getRevision(id)).state).toBe('LOADING');
    expect(await driver().inspect(id)).not.toBeNull();

    // The job is redelivered (stalled lock / reconciler) and continues from LOADING.
    await processor().process(id);
    expect((await getRevision(id)).state).toBe('READY');
    expect((await driver().list()).filter((c) => c.revisionId === id)).toHaveLength(1);
  }, 180_000);

  it('SEC-5: an artifact swapped in storage after validation never serves (checksum mismatch)', async () => {
    const ep = await newEndpoint();
    // A model only this test uses, so replacing its blob can't affect anything else.
    const model = uniqueModel(sklearn.model);
    const versionId = await validatedVersion({ ...sklearn, model });
    const mv = await prismaOf(app).modelVersion.findUniqueOrThrow({ where: { id: versionId } });

    // An attacker with write access to the bucket replaces the bytes behind the validated hash.
    const cfg = app.get<AppConfig>(APP_CONFIG);
    const s3 = new S3Client({
      endpoint: cfg.s3.endpoint,
      region: cfg.s3.region,
      forcePathStyle: true,
      credentials: { accessKeyId: cfg.s3.accessKey, secretAccessKey: cfg.s3.secretKey },
    });
    await s3.send(
      new PutObjectCommand({
        Bucket: cfg.s3.artifactBucket,
        Key: ArtifactStore.key(mv.artifactSha256 ?? ''),
        Body: uniqueModel(sklearn.model), // a perfectly loadable model, just not the validated one
      }),
    );
    s3.destroy();

    const rev = await deployed(ep.id, versionId);
    expect(rev.state).toBe('FAILED');
    expect(rev.failureCode).toBe('ARTIFACT_CHECKSUM_MISMATCH');
    expect(rev.failureDetail).toMatch(/expected sha256/);
    expect(await driver().inspect(rev.id)).toBeNull(); // cleaned up
    expect((await getEndpoint(ep.id)).stableRevision).toBeNull();
  }, 180_000);

  it('the reconciler fails a revision stuck past its deadline and removes its container', async () => {
    const ep = await newEndpoint();
    const versionId = await validatedVersion(sklearn);
    const id = ((await deploy(ep.id, versionId)).body as Revision).id;
    await relay();
    await processor().process(id, { stopAfter: 'LOADING' });
    await prismaOf(app).deploymentRevision.update({
      where: { id },
      data: { stateDeadlineAt: new Date(Date.now() - 1000) },
    });
    const report = await reconciler().reconcile();
    expect(report.timedOut).toBeGreaterThanOrEqual(1);
    const rev = await getRevision(id);
    expect(rev.state).toBe('FAILED');
    expect(rev.failureCode).toBe('TIMEOUT');
    expect(await driver().inspect(id)).toBeNull();
  }, 180_000);

  it('a crashed model server is restarted (self-healing) within a budget, then FAILED', async () => {
    const ep = await newEndpoint();
    const rev = await deployed(ep.id, await validatedVersion(sklearn));
    expect(rev.state).toBe('READY');

    await driver().remove(rev.id); // the container dies
    const r1 = await reconciler().reconcile();
    expect(r1.degraded).toBe(1);
    expect(r1.restarted).toBe(1);
    expect((await getRevision(rev.id)).state).toBe('DEGRADED');
    const unavailable = await eventually(
      () => predict(ep.slug, asRows(goldenOf(sklearn).inputs.slice(0, 1))),
      (r) => r.status === 503,
    );
    expect(unavailable.status).toBe(503); // not routed while degraded

    const healed = await eventually(
      async () => {
        await reconciler().reconcile();
        return getRevision(rev.id);
      },
      (r) => r.state === 'READY',
      60_000,
    );
    expect(healed.state).toBe('READY');

    // Budget spent: the next crash is final, and the endpoint stops routing to it.
    await prismaOf(app).deploymentRevision.update({
      where: { id: rev.id },
      data: { restartCount: 3, restartWindowStart: new Date() },
    });
    await driver().remove(rev.id);
    await reconciler().reconcile();
    const dead = await getRevision(rev.id);
    expect(dead.state).toBe('FAILED');
    expect(dead.failureCode).toBe('RESTART_BUDGET_EXHAUSTED');
    expect((await getEndpoint(ep.id)).stableRevision).toBeNull();
  }, 240_000);

  // M12: the ramp benchmark found that one slow health check restarted a busy, healthy server.
  it('a running model server that misses health checks keeps serving; only 3 misses in a row restart it', async () => {
    const ep = await newEndpoint();
    const rev = await deployed(ep.id, await validatedVersion(sklearn));
    expect(rev.state).toBe('READY');
    const db = prismaOf(app).deploymentRevision;
    const row = asRows(goldenOf(sklearn).inputs.slice(0, 1));

    // Its container keeps running and answering predictions; only its health checks fail, as
    // they do when it is saturated.
    const UNHEALTHY_STREAK = worker.get<AppConfig>(APP_CONFIG).deploy.unhealthyStreak; // 3
    const probe = worker.get(ModelServerProbe);
    const realReady = probe.ready.bind(probe);
    const missChecks = () =>
      vi
        .spyOn(probe, 'ready')
        .mockImplementation((id) => (id === rev.id ? Promise.resolve(false) : realReady(id)));

    let spy = missChecks();
    for (let miss = 1; miss < UNHEALTHY_STREAK; miss++) {
      const report = await reconciler().reconcile();
      expect(report.slow).toBeGreaterThanOrEqual(1);
      const now = await db.findUniqueOrThrow({ where: { id: rev.id } });
      expect(now).toMatchObject({ state: 'READY', healthFailures: miss, restartCount: 0 });
    }
    const served = await predict(ep.slug, row);
    expect(served.status).toBe(200); // still in routing while it misses checks
    expect(served.headers.get('x-revision-id')).toBe(rev.id);

    // One answered check ends the streak.
    spy.mockRestore();
    await reconciler().reconcile();
    expect(await db.findUniqueOrThrow({ where: { id: rev.id } })).toMatchObject({
      state: 'READY',
      healthFailures: 0,
    });

    // Three misses in a row: hung, not busy. Out of routing and restarted (within the budget).
    spy = missChecks();
    let last;
    for (let miss = 1; miss <= UNHEALTHY_STREAK; miss++) last = await reconciler().reconcile();
    expect(last?.degraded).toBeGreaterThanOrEqual(1);
    expect(last?.restarted).toBeGreaterThanOrEqual(1);
    const degraded = await getRevision(rev.id);
    expect(degraded.state).toBe('DEGRADED');
    expect(degraded.events.at(-1)?.toState).toBe('DEGRADED');
    expect((await db.findUniqueOrThrow({ where: { id: rev.id } })).restartCount).toBe(1);

    // Answering again: back in service.
    spy.mockRestore();
    const healed = await eventually(
      async () => {
        await reconciler().reconcile();
        return getRevision(rev.id);
      },
      (r) => r.state === 'READY',
      60_000,
    );
    expect(healed.state).toBe('READY');
  }, 240_000);

  it('cancel before READY: no container survives; lost jobs are re-enqueued', async () => {
    const ep = await newEndpoint();
    const versionId = await validatedVersion(sklearn);
    const id = ((await deploy(ep.id, versionId)).body as Revision).id;
    const cancelled = await ada.post(`/orgs/${ada.orgId}/revisions/${id}/cancel`);
    expect(cancelled.status).toBe(200);
    expect((cancelled.body as Revision).state).toBe('CANCELLED');
    await relay();
    await processor().process(id);
    expect(await driver().inspect(id)).toBeNull();
    const again = await ada.post(`/orgs/${ada.orgId}/revisions/${id}/cancel`);
    expect(again.status).toBe(409);

    // A QUEUED revision whose job vanished (Redis restart) is put back on the queue.
    const id2 = ((await deploy(ep.id, versionId)).body as Revision).id;
    await relay();
    const queue = worker.get(DeployQueue);
    await queue.queue.remove(DeployQueue.jobId(id2));
    await prismaOf(app).deploymentRevision.update({
      where: { id: id2 },
      data: { updatedAt: new Date(Date.now() - 60_000) },
    });
    await reconciler().reconcile();
    expect(await queue.queue.getJob(DeployQueue.jobId(id2))).toBeTruthy();
    await processor().process(id2);
    expect((await getRevision(id2)).state).toBe('READY');
  }, 240_000);
});

// M10: on Docker, isolation is the internal `inference` network (SEC tests in security.int.spec);
// on Kubernetes it is the NetworkPolicy each revision gets. Probed from real pods, both ways.
describe.runIf(RUNTIME === 'kubernetes')('network isolation on Kubernetes (M10)', () => {
  it('only gateway pods reach a model server; it reaches S3 but not Postgres or Redis', async () => {
    const ep = await newEndpoint();
    const rev = await deployed(ep.id, await validatedVersion(sklearn));
    expect(rev.state).toBe('READY');
    const pod = `mo-rev-${rev.id}`;
    const host = `${pod}.${NAMESPACE}.svc.cluster.local`;

    // Ingress: from another namespace, a pod labelled as a gateway gets in; any other pod doesn't.
    expect(tcpFromNewPod('default', { 'app.kubernetes.io/name': 'gateway' }, host, 8000)).toBe(
      'OPEN',
    );
    expect(tcpFromNewPod('default', { 'modelops.test-probe': 'true' }, host, 8000)).toBe('BLOCKED');

    // Egress: object storage yes (it downloaded its artifact); the databases no.
    expect(tcpFromPod(NAMESPACE, pod, 'seaweedfs', 8333)).toBe('OPEN');
    expect(tcpFromPod(NAMESPACE, pod, 'postgres', 5432)).toBe('BLOCKED');
    expect(tcpFromPod(NAMESPACE, pod, 'redis', 6379)).toBe('BLOCKED');
  }, 300_000);
});

describe('API keys at the gateway (ADR-0006)', () => {
  it('stores only an HMAC, shows the secret once, and revocation reaches the gateway in seconds', async () => {
    const ep = await newEndpoint();
    await deployed(ep.id, await validatedVersion(sklearn));
    const created = await ada.post(`/orgs/${ada.orgId}/projects/${projectId}/api-keys`, {
      name: 'revocable',
    });
    const { key, id, prefix } = created.body as { key: string; id: string; prefix: string };
    expect(key).toMatch(/^mo_[A-Z2-9]{10}_[A-Za-z0-9_-]{43}$/);
    const row = await prismaOf(app).apiKey.findUniqueOrThrow({ where: { id } });
    expect(Buffer.from(row.secretHash).toString('utf8')).not.toContain(key.slice(14));
    const list = await ada.get(`/orgs/${ada.orgId}/projects/${projectId}/api-keys`);
    expect(JSON.stringify(list.body)).not.toContain(key.slice(14));
    expect(JSON.stringify(list.body)).toContain(prefix);

    const row1 = asRows(goldenOf(sklearn).inputs.slice(0, 1));
    const ok = await eventually(
      () => predictWith(key, ep.slug, row1),
      (r) => r.status === 200,
    );
    expect(ok.status).toBe(200);

    const started = Date.now();
    expect((await ada.delete(`/orgs/${ada.orgId}/api-keys/${id}`)).status).toBe(204);
    const refused = await eventually(
      () => predictWith(key, ep.slug, row1),
      (r) => r.status === 401,
    );
    expect(refused.status).toBe(401);
    expect(Date.now() - started).toBeLessThan(5_000); // SEC-10: pub/sub eviction, not the 30 s TTL
  }, 180_000);

  it("SEC-11: another project's key cannot reach this project's endpoint", async () => {
    const project = await ada.post(`/orgs/${ada.orgId}/projects`, { name: 'Elsewhere' });
    expect(project.status, project.text).toBe(201);
    const other = (project.body as { id: string }).id;
    const created = await ada.post(`/orgs/${ada.orgId}/projects/${other}/api-keys`, {
      name: 'other team',
    });
    expect(created.status, created.text).toBe(201);
    const otherKey = (created.body as { key: string }).key;
    const ep = (await newEndpoint()).slug;
    const res = await eventually(
      () => predictWith(otherKey, ep, [{}]),
      (r) => r.status === 404,
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('ENDPOINT_NOT_FOUND');
  });

  it('viewers cannot see or create keys; the routing snapshot is rebuilt from Postgres', async () => {
    expect((await viewer.get(`/orgs/${ada.orgId}/projects/${projectId}/api-keys`)).status).toBe(
      403,
    );
    const published = await worker.get(DataPlanePublisher).buildRouting();
    // Docker: `mo-rev-<id>` on the inference network; kind: the Service `mo-rev-<id>.<ns>.svc…`.
    const suffix = RUNTIME === 'kubernetes' ? `\\.${NAMESPACE}\\.svc\\.cluster\\.local` : '';
    const url = new RegExp(`^http://mo-rev-[0-9a-f-]{36}${suffix}:8000$`);
    for (const e of Object.values(published.endpoints)) {
      if (e.revision) expect(e.revision.url).toMatch(url);
    }
  });
});

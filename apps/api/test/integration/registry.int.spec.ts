import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, Client, createTestApp, prismaOf, type Problem } from './helpers';
import {
  createRun,
  DATASET_SHA,
  deleteRun,
  getExperiment,
  getRegisteredModel,
  VALID_SIGNATURE,
} from './mlflow-fixtures';

/** Experiments + model registry against the real MLflow server (M3). */
interface Experiment {
  experimentId: string;
  name: string;
  trainCommands: string[];
}
interface Run {
  runId: string;
  name: string;
  framework: string | null;
  metrics: Record<string, number>;
  registeredAs: { version: number }[];
}
interface Version {
  id: string;
  version: number;
  status: string;
  framework: string;
  mlflowVersion: string | null;
  mlflowSyncError: string | null;
  signature: typeof VALID_SIGNATURE;
  trainingDataset: { sha256: string; version: string } | null;
  model: { id: string; mlflowName: string };
}

let app: NestExpressApplication;
let ada: Client;
let projectA: string;
let projectA2: string; // a second project in the same org
let expA: Experiment;
let expA2: Experiment;

const code = (res: { body: unknown }) => (res.body as Problem).code;

async function newProject(c: Client, name: string): Promise<string> {
  return ((await c.post(`/orgs/${c.orgId}/projects`, { name })).body as { id: string }).id;
}
async function experimentOf(c: Client, projectId: string): Promise<Experiment> {
  return (await c.get(`/orgs/${c.orgId}/projects/${projectId}/experiment`)).body as Experiment;
}
async function newModel(
  c: Client,
  projectId: string,
  name: string,
): Promise<{ id: string; mlflowName: string }> {
  const res = await c.post(`/orgs/${c.orgId}/projects/${projectId}/models`, { name });
  if (res.status !== 201) throw new Error(`model create failed ${String(res.status)} ${res.text}`);
  return res.body as { id: string; mlflowName: string };
}

beforeAll(async () => {
  app = await createTestApp();
  ada = await Client.register(app, { name: 'Ada' });
  projectA = await newProject(ada, 'Churn');
  projectA2 = await newProject(ada, 'Fraud');
  expA = await experimentOf(ada, projectA);
  expA2 = await experimentOf(ada, projectA2);
});
afterAll(async () => {
  await app.close();
});

describe('experiments', () => {
  it('creates one MLflow experiment per project, named and tagged for the tenant', async () => {
    const org = await prismaOf(app).organization.findUniqueOrThrow({ where: { id: ada.orgId } });
    expect(expA.name).toBe(`modelops/${org.slug}/churn`);
    expect(expA.trainCommands[0]).toContain(`--experiment ${expA.name}`);

    const again = await experimentOf(ada, projectA);
    expect(again.experimentId).toBe(expA.experimentId); // idempotent
    const stored = await prismaOf(app).project.findUniqueOrThrow({ where: { id: projectA } });
    expect(stored.mlflowExperimentId).toBe(expA.experimentId);

    const { experiment } = await getExperiment(expA.experimentId);
    expect(experiment.tags).toContainEqual({ key: 'modelops.project_id', value: projectA });
  });

  it('lists only this project’s runs, newest first, with framework, dataset and metrics', async () => {
    const older = await createRun(expA.experimentId, {
      name: 'older',
      metrics: { test_roc_auc: 0.81 },
    });
    const newer = await createRun(expA.experimentId, { name: 'newer', framework: 'PYTORCH_ONNX' });
    const foreign = await createRun(expA2.experimentId, { name: 'other project' });

    const res = await ada.get(`/orgs/${ada.orgId}/projects/${projectA}/runs?limit=50`);
    const ids = (res.body as { data: Run[] }).data.map((r) => r.runId);
    expect(ids.indexOf(newer)).toBeLessThan(ids.indexOf(older));
    expect(ids).not.toContain(foreign);
    const run = (res.body as { data: Run[] }).data.find((r) => r.runId === newer);
    expect(run).toMatchObject({
      name: 'newer',
      framework: 'PYTORCH_ONNX',
      metrics: { test_roc_auc: 0.85 },
    });
  });

  it('a run id from another project (same org) is "not found"; so are malformed and deleted ids', async () => {
    const foreign = await createRun(expA2.experimentId);
    expect((await ada.get(`/orgs/${ada.orgId}/projects/${projectA}/runs/${foreign}`)).status).toBe(
      404,
    );
    expect(
      (await ada.get(`/orgs/${ada.orgId}/projects/${projectA}/runs/not-a-run-id`)).status,
    ).toBe(404);
    const deleted = await createRun(expA.experimentId);
    await deleteRun(deleted);
    expect((await ada.get(`/orgs/${ada.orgId}/projects/${projectA}/runs/${deleted}`)).status).toBe(
      404,
    );
  });

  it('run detail includes per-epoch curves and only modelops.* tags', async () => {
    const id = await createRun(expA.experimentId, { series: { train_loss: [0.7, 0.5, 0.4] } });
    const res = await ada.get(`/orgs/${ada.orgId}/projects/${projectA}/runs/${id}`);
    const body = res.body as {
      series: Record<string, { step: number; value: number }[]>;
      tags: Record<string, string>;
    };
    expect(body.series.train_loss).toEqual([
      { step: 0, value: 0.7 },
      { step: 1, value: 0.5 },
      { step: 2, value: 0.4 },
    ]);
    expect(Object.keys(body.tags).every((k) => k.startsWith('modelops.'))).toBe(true);
  });

  it('compares 2–5 runs: union of metrics and the params that differ', async () => {
    const a = await createRun(expA.experimentId, {
      params: { model: 'GBM', lr: '0.1' },
      metrics: { test_roc_auc: 0.8 },
    });
    const b = await createRun(expA.experimentId, {
      params: { model: 'GBM', lr: '0.05' },
      metrics: { test_f1: 0.5 },
    });
    const res = await ada.get(`/orgs/${ada.orgId}/projects/${projectA}/runs/compare?ids=${a},${b}`);
    expect(res.status).toBe(200);
    const body = res.body as { metricKeys: string[]; differingParams: string[]; runs: Run[] };
    expect(body.metricKeys).toEqual(['test_f1', 'test_roc_auc']);
    expect(body.differingParams).toEqual(['lr']);
    expect(body.runs.map((r) => r.runId)).toEqual([a, b]);
  });

  it('compare rejects 1 or 6 ids (400) and a foreign run (404)', async () => {
    const a = await createRun(expA.experimentId);
    const foreign = await createRun(expA2.experimentId);
    const base = `/orgs/${ada.orgId}/projects/${projectA}/runs/compare?ids=`;
    expect((await ada.get(`${base}${a}`)).status).toBe(400);
    expect((await ada.get(`${base}${Array(6).fill(a).join(',')}`)).status).toBe(400);
    expect((await ada.get(`${base}${a},${foreign}`)).status).toBe(404);
  });
});

describe('model registry', () => {
  it('creates a model in Postgres and the MLflow registry with a tenant-scoped name', async () => {
    const model = await newModel(ada, projectA, 'Churn classifier');
    const org = await prismaOf(app).organization.findUniqueOrThrow({ where: { id: ada.orgId } });
    expect(model.mlflowName).toBe(`${org.slug}.churn.churn-classifier`);
    const mirror = await getRegisteredModel(model.mlflowName);
    expect(mirror.registered_model.tags).toContainEqual({
      key: 'modelops.project_id',
      value: projectA,
    });

    const dup = await ada.post(`/orgs/${ada.orgId}/projects/${projectA}/models`, {
      name: 'Churn  Classifier',
    });
    expect(dup.status).toBe(409);
    expect(code(dup)).toBe('MODEL_NAME_TAKEN');
  });

  it('registers runs as versions 1, 2, … with signature, metrics and dataset lineage', async () => {
    const model = await newModel(ada, projectA, 'Lineage model');
    const r1 = await createRun(expA.experimentId, { metrics: { test_roc_auc: 0.83 } });
    const r2 = await createRun(expA.experimentId, { framework: 'PYTORCH_ONNX' });

    const v1 = (
      await ada.post(`/orgs/${ada.orgId}/models/${model.id}/versions/import`, { runId: r1 })
    ).body as Version;
    const v2 = (
      await ada.post(`/orgs/${ada.orgId}/models/${model.id}/versions/import`, { runId: r2 })
    ).body as Version;
    expect([v1.version, v2.version]).toEqual([1, 2]);
    expect(v1).toMatchObject({
      status: 'PENDING_VALIDATION',
      framework: 'SKLEARN_ONNX',
      mlflowVersion: '1',
      mlflowSyncError: null,
      signature: VALID_SIGNATURE,
      trainingDataset: { sha256: DATASET_SHA, version: 'seed7-n1000' },
    });
    expect(v2.framework).toBe('PYTORCH_ONNX');

    // Both versions share one dataset row (same SHA-256 in the same project).
    expect(
      await prismaOf(app).datasetVersion.count({
        where: { projectId: projectA, sha256: DATASET_SHA },
      }),
    ).toBe(1);

    const mirror = await getRegisteredModel(model.mlflowName);
    expect(mirror.registered_model.latest_versions?.map((v) => v.run_id)).toContain(r2);

    const audit = await prismaOf(app).auditEvent.count({
      where: { orgId: ada.orgId, action: 'model_version.registered' },
    });
    expect(audit).toBeGreaterThanOrEqual(2);

    // The run list now shows what each run was registered as.
    const run = (await ada.get(`/orgs/${ada.orgId}/projects/${projectA}/runs/${r1}`)).body as Run;
    expect(run.registeredAs.map((x) => x.version)).toEqual([1]);
  });

  it('concurrent imports of different runs get distinct version numbers', async () => {
    const model = await newModel(ada, projectA, 'Concurrent model');
    const runs = await Promise.all([0, 1, 2].map(() => createRun(expA.experimentId)));
    const results = await Promise.all(
      runs.map((runId) =>
        ada.post(`/orgs/${ada.orgId}/models/${model.id}/versions/import`, { runId }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
    expect(results.map((r) => (r.body as Version).version).sort()).toEqual([1, 2, 3]);
  });

  it('rejects: same run twice (409), unfinished run (409), foreign run (404)', async () => {
    const model = await newModel(ada, projectA, 'Rejections');
    const run = await createRun(expA.experimentId);
    const path = `/orgs/${ada.orgId}/models/${model.id}/versions/import`;
    expect((await ada.post(path, { runId: run })).status).toBe(201);

    const again = await ada.post(path, { runId: run });
    expect([again.status, code(again)]).toEqual([409, 'RUN_ALREADY_REGISTERED']);

    const running = await ada.post(path, {
      runId: await createRun(expA.experimentId, { status: 'RUNNING' }),
    });
    expect([running.status, code(running)]).toEqual([409, 'RUN_NOT_FINISHED']);

    const foreign = await ada.post(path, { runId: await createRun(expA2.experimentId) });
    expect(foreign.status).toBe(404);
  });

  it('rejects incomplete bundles, invalid signatures and unsupported frameworks (422)', async () => {
    const model = await newModel(ada, projectA, 'Bad bundles');
    const path = `/orgs/${ada.orgId}/models/${model.id}/versions/import`;

    const missing = await ada.post(path, {
      runId: await createRun(expA.experimentId, { files: { 'golden_examples.json': null } }),
    });
    expect([missing.status, code(missing)]).toEqual([422, 'BUNDLE_INCOMPLETE']);
    expect((missing.body as Problem).errors).toEqual([
      { field: 'model/golden_examples.json', message: 'is missing' },
    ]);

    const badShape = structuredClone(VALID_SIGNATURE);
    const input = badShape.inputs[0];
    if (!input) throw new Error('fixture has no input');
    input.shape = [-1, 5]; // 6 feature names, width 5
    const sig = await ada.post(path, {
      runId: await createRun(expA.experimentId, {
        files: { 'signature.json': JSON.stringify(badShape) },
      }),
    });
    expect([sig.status, code(sig)]).toEqual([422, 'SIGNATURE_INVALID']);
    expect((sig.body as Problem).errors?.[0]?.field).toBe('signature.inputs.0.features');

    const notJson = await ada.post(path, {
      runId: await createRun(expA.experimentId, { files: { 'signature.json': '{oops' } }),
    });
    expect(code(notJson)).toBe('SIGNATURE_INVALID');

    const pickle = await ada.post(path, {
      runId: await createRun(expA.experimentId, { framework: 'SKLEARN_PICKLE' }),
    });
    expect([pickle.status, code(pickle)]).toEqual([422, 'UNSUPPORTED_FRAMEWORK']);
    const untagged = await ada.post(path, {
      runId: await createRun(expA.experimentId, { framework: null }),
    });
    expect(code(untagged)).toBe('UNSUPPORTED_FRAMEWORK');

    expect(await prismaOf(app).modelVersion.count({ where: { modelId: model.id } })).toBe(0);
  });

  it('archived projects accept no new models or versions', async () => {
    const pid = await newProject(ada, 'Soon archived');
    const exp = await experimentOf(ada, pid);
    const model = await newModel(ada, pid, 'Before archive');
    await ada.delete(`/orgs/${ada.orgId}/projects/${pid}`);
    const create = await ada.post(`/orgs/${ada.orgId}/projects/${pid}/models`, {
      name: 'After archive',
    });
    expect([create.status, code(create)]).toEqual([409, 'PROJECT_ARCHIVED']);
    const imp = await ada.post(`/orgs/${ada.orgId}/models/${model.id}/versions/import`, {
      runId: await createRun(exp.experimentId),
    });
    expect(code(imp)).toBe('PROJECT_ARCHIVED');
  });

  it('model and version detail, datasets list; another org sees none of it (404)', async () => {
    const model = await newModel(ada, projectA, 'Detail model');
    const v = (
      await ada.post(`/orgs/${ada.orgId}/models/${model.id}/versions/import`, {
        runId: await createRun(expA.experimentId),
      })
    ).body as Version;

    const detail = await ada.get(`/orgs/${ada.orgId}/models/${model.id}`);
    expect(detail.body).toMatchObject({
      versionCount: 1,
      project: { id: projectA },
      latestVersion: { version: 1 },
    });
    const version = await ada.get(`/orgs/${ada.orgId}/model-versions/${v.id}`);
    expect(version.body).toMatchObject({
      model: { id: model.id },
      sourceUri: expect.stringMatching(/\/model$/) as string,
    });
    const datasets = await ada.get(`/orgs/${ada.orgId}/projects/${projectA}/datasets`);
    expect((datasets.body as { sha256: string }[]).map((d) => d.sha256)).toContain(DATASET_SHA);

    const eve = await Client.register(app, { name: 'Eve' });
    for (const path of [
      `/orgs/${ada.orgId}/models/${model.id}`,
      `/orgs/${eve.orgId}/models/${model.id}`,
      `/orgs/${eve.orgId}/model-versions/${v.id}`,
      `/orgs/${eve.orgId}/projects/${projectA}/runs`,
      `/orgs/${eve.orgId}/projects/${projectA}/experiment`,
    ]) {
      expect((await eve.get(path)).status, path).toBe(404);
    }
  });

  it('a Viewer can browse runs and models but not create or register', async () => {
    const viewer = await Client.register(app, { name: 'Viewer' });
    await addMember(app, ada.orgId, viewer, 'VIEWER');
    const model = await newModel(ada, projectA, 'Viewer test');
    expect((await viewer.get(`/orgs/${ada.orgId}/projects/${projectA}/runs`)).status).toBe(200);
    expect((await viewer.get(`/orgs/${ada.orgId}/models/${model.id}`)).status).toBe(200);
    const imp = await viewer.post(`/orgs/${ada.orgId}/models/${model.id}/versions/import`, {
      runId: await createRun(expA.experimentId),
    });
    expect([imp.status, code(imp)]).toEqual([403, 'FORBIDDEN_ROLE']);
  });
});

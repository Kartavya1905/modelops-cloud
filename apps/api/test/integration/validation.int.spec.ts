import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ArtifactStore } from '../../src/common/storage/artifact-store';
import { APP_CONFIG, type AppConfig } from '../../src/config/config';
import { RetryableError, ValidationService } from '../../src/modules/validation/validation.service';
import {
  type Bundle,
  flippedGolden,
  loadBundle,
  PICKLE_PAYLOAD,
  renamedInputSignature,
  uniqueGolden,
} from './bundles';
import { Client, createTestApp, prismaOf, type Problem } from './helpers';
import { createRun, getModelVersion } from './mlflow-fixtures';

/**
 * M4 validation pipeline end to end, against the real services from `pnpm dev:up`:
 * Postgres, MLflow (source of training bundles), SeaweedFS (content-addressed storage) and the
 * sandboxed ml-worker (checks V1-V11). The queue consumer is not started here: tests call
 * ValidationService.process directly, exactly as the worker does, so every step is deterministic.
 * (worker.int.spec.ts covers the real BullMQ worker and sweeper.)
 */
interface Check {
  id: string;
  name: string;
  passed: boolean | null;
  detail: string;
}
interface Report {
  attempt: number;
  result: 'PASSED' | 'FAILED' | 'ERROR';
  checks: Check[];
  facts: Record<string, unknown>;
  validatorVersion: string;
}
interface Version {
  id: string;
  version: number;
  status: string;
  source: 'MLFLOW_RUN' | 'UPLOAD';
  mlflowRunId: string | null;
  mlflowVersion: string | null;
  sourceUri: string;
  artifactSha256: string | null;
  sizeBytes: number | null;
  validationAttempts: number;
  validatedAt: string | null;
  latestValidation: Report | null;
  model: { mlflowName: string };
}
interface History {
  status: string;
  attempts: number;
  latest: Report | null;
  history: Report[];
  retryable: boolean;
}

let app: NestExpressApplication;
let validation: ValidationService;
let ada: Client;
let eve: Client; // another tenant
let experimentId: string;
let modelId: string;
const sklearn = loadBundle('sklearn');
const pytorch = loadBundle('pytorch');

const code = (res: { body: unknown }) => (res.body as Problem).code;
const failedIds = (r: Report | null) =>
  (r?.checks ?? []).filter((c) => c.passed === false).map((c) => c.id);

async function importRun(
  files: { model: Buffer; signature: Buffer; golden: Buffer },
  opts: { framework?: string; tags?: Record<string, string> } = {},
): Promise<Version> {
  const runId = await createRun(experimentId, {
    framework: opts.framework ?? 'SKLEARN_ONNX',
    tags: opts.tags ?? {},
    files: {
      'model.onnx': files.model,
      'signature.json': files.signature.toString('utf8'),
      'golden_examples.json': files.golden.toString('utf8'),
    },
  });
  const res = await ada.post(`/orgs/${ada.orgId}/models/${modelId}/versions/import`, { runId });
  if (res.status !== 201) throw new Error(`import failed ${String(res.status)} ${res.text}`);
  return res.body as Version;
}

async function upload(b: Pick<Bundle, 'framework' | 'model' | 'signature' | 'golden'>) {
  return ada.upload(
    `/orgs/${ada.orgId}/models/${modelId}/versions/upload`,
    { framework: b.framework },
    { model: b.model, signature: b.signature, golden: b.golden },
  );
}
async function uploaded(b: Pick<Bundle, 'framework' | 'model' | 'signature' | 'golden'>) {
  const res = await upload(b);
  if (res.status !== 201) throw new Error(`upload failed ${String(res.status)} ${res.text}`);
  return res.body as Version;
}

const getVersion = async (id: string) =>
  (await ada.get(`/orgs/${ada.orgId}/model-versions/${id}`)).body as Version;
const getHistory = async (id: string) =>
  (await ada.get(`/orgs/${ada.orgId}/model-versions/${id}/validation`)).body as History;

beforeAll(async () => {
  app = await createTestApp();
  validation = app.get(ValidationService);
  ada = await Client.register(app, { name: 'Ada' });
  eve = await Client.register(app, { name: 'Eve' });
  const project = await ada.post(`/orgs/${ada.orgId}/projects`, { name: 'Validation' });
  const projectId = (project.body as { id: string }).id;
  experimentId = (
    (await ada.get(`/orgs/${ada.orgId}/projects/${projectId}/experiment`)).body as {
      experimentId: string;
    }
  ).experimentId;
  const model = await ada.post(`/orgs/${ada.orgId}/projects/${projectId}/models`, {
    name: 'Validated churn',
  });
  modelId = (model.body as { id: string }).id;
}, 120_000);
afterAll(async () => {
  await app.close();
});

describe('valid bundles', () => {
  it('a real sklearn bundle from MLflow is ingested, passes V1-V11 and becomes VALIDATED', async () => {
    const v = await importRun(sklearn, { tags: { 'modelops.bundle.sha256': sklearn.sha256 } });
    expect(v.status).toBe('PENDING_VALIDATION');
    expect(v.artifactSha256).toBeNull(); // not ingested until the worker runs

    expect(await validation.process(v.id, false)).toBe(true);

    const after = await getVersion(v.id);
    expect(after.status).toBe('VALIDATED');
    expect(after.artifactSha256).toBe(sklearn.sha256); // hashed by the platform, not trusted
    expect(after.sizeBytes).toBe(sklearn.bytes);
    expect(after.validationAttempts).toBe(1);
    expect(after.validatedAt).not.toBeNull();
    expect(after.latestValidation?.result).toBe('PASSED');
    const ids = after.latestValidation?.checks.map((c) => c.id) ?? [];
    expect([...ids].sort()).toEqual(
      ['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8', 'V9', 'V10', 'V11'].sort(),
    );
    expect(failedIds(after.latestValidation)).toEqual([]);
    expect(after.latestValidation?.validatorVersion).toBe('1');

    // Stored content-addressed, with an audit trail and the status mirrored to MLflow.
    expect(await app.get(ArtifactStore).exists(sklearn.sha256)).toBe(true);
    const audit = await prismaOf(app).auditEvent.findMany({
      where: { targetId: v.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(audit.map((a) => a.action)).toEqual([
      'model_version.registered',
      'model_version.validated',
    ]);
    const mv = await getModelVersion(after.model.mlflowName, after.mlflowVersion ?? '');
    expect(mv.model_version.tags).toContainEqual({ key: 'modelops.status', value: 'VALIDATED' });
  });

  it('a real PyTorch bundle uploaded directly is stored on upload and VALIDATED', async () => {
    const v = await uploaded(pytorch);
    expect(v).toMatchObject({
      status: 'PENDING_VALIDATION',
      source: 'UPLOAD',
      mlflowRunId: null,
      artifactSha256: pytorch.sha256,
      sizeBytes: pytorch.bytes,
      sourceUri: `s3://model-artifacts/blobs/sha256/${pytorch.sha256}`,
    });
    expect(await validation.process(v.id, false)).toBe(true);
    const after = await getVersion(v.id);
    expect(after.status).toBe('VALIDATED');
    expect(failedIds(after.latestValidation)).toEqual([]);
  });

  it('identical bytes are stored once (content addressing deduplicates)', async () => {
    const a = await uploaded(sklearn);
    const b = await uploaded(sklearn);
    expect(a.version).toBeLessThan(b.version);
    expect(a.artifactSha256).toBe(b.artifactSha256);
    expect(b.artifactSha256).toBe(sklearn.sha256);
  });
});

describe('hostile or broken bundles are rejected with the failing check', () => {
  it('a pickle disguised as model.onnx fails V1 without ever being loaded', async () => {
    const v = await importRun({ ...sklearn, model: PICKLE_PAYLOAD });
    await validation.process(v.id, false);
    const h = await getHistory(v.id);
    expect(h.status).toBe('REJECTED');
    expect(h.latest?.result).toBe('FAILED');
    expect(failedIds(h.latest)).toEqual(['V1']);
    expect(h.latest?.checks.find((c) => c.id === 'V1')?.detail).toMatch(/pickle/);
    // Nothing after the format check ran: no runtime session was ever created.
    expect(
      h.latest?.checks.filter((c) => ['V8', 'V9', 'V10'].includes(c.id) && c.passed !== null),
    ).toEqual([]);
    expect(h.retryable).toBe(false);
  });

  it('golden examples the model cannot reproduce fail V9', async () => {
    const v = await uploaded({ ...sklearn, golden: flippedGolden(sklearn.golden) });
    await validation.process(v.id, false);
    const after = await getVersion(v.id);
    expect(after.status).toBe('REJECTED');
    expect(failedIds(after.latestValidation)).toEqual(['V9']);
  });

  it('a signature that does not match the graph fails V7', async () => {
    const v = await importRun(
      { ...pytorch, signature: renamedInputSignature(pytorch.signature) },
      {
        framework: 'PYTORCH_ONNX',
      },
    );
    await validation.process(v.id, false);
    const after = await getVersion(v.id);
    expect(after.status).toBe('REJECTED');
    expect(failedIds(after.latestValidation)).toContain('V7');
  });

  it('bytes that differ from the hash the training run reported fail V11 at ingest', async () => {
    const v = await importRun(sklearn, { tags: { 'modelops.bundle.sha256': 'f'.repeat(64) } });
    await validation.process(v.id, false);
    const after = await getVersion(v.id);
    expect(after.status).toBe('REJECTED');
    expect(after.artifactSha256).toBeNull(); // never recorded as this version's artifact
    expect(after.latestValidation?.checks).toEqual([
      expect.objectContaining({ id: 'V11', passed: false }),
    ]);
  });

  it('a blob changed in storage after ingest fails V11 before anything is parsed', async () => {
    const golden = uniqueGolden(sklearn.golden); // a blob no other test shares
    const v = await uploaded({ ...sklearn, golden });
    const row = await prismaOf(app).modelVersion.findUniqueOrThrow({ where: { id: v.id } });

    // An attacker with write access to the bucket swaps the bytes behind the hash.
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
        Key: ArtifactStore.key(row.goldenSha256 ?? ''),
        Body: flippedGolden(sklearn.golden),
      }),
    );
    s3.destroy();

    await validation.process(v.id, false);
    const after = await getVersion(v.id);
    expect(after.status).toBe('REJECTED');
    expect(failedIds(after.latestValidation)).toEqual(['V11']);
    expect(after.latestValidation?.checks.find((c) => c.id === 'V11')?.detail).toMatch(/golden/);
  });
});

describe('at-least-once delivery and crash recovery', () => {
  it('a duplicate delivery is a no-op: one claim, one report', async () => {
    const v = await uploaded({ ...sklearn, golden: uniqueGolden(sklearn.golden) });
    const results = await Promise.all([
      validation.process(v.id, false),
      validation.process(v.id, false),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await validation.process(v.id, false)).toBe(false); // already done
    const reports = await prismaOf(app).validationReport.count({ where: { versionId: v.id } });
    expect(reports).toBe(1);
    expect((await getVersion(v.id)).validationAttempts).toBe(1);
  });

  it('the sweeper reclaims an expired lease (crashed worker) and re-enqueues it', async () => {
    const crashed = await uploaded({ ...sklearn, golden: uniqueGolden(sklearn.golden) });
    const busy = await uploaded({ ...sklearn, golden: uniqueGolden(sklearn.golden) });
    const prisma = prismaOf(app);
    // Simulate two workers that claimed a version: one died (lease expired), one is still working.
    await prisma.modelVersion.update({
      where: { id: crashed.id },
      data: { status: 'VALIDATING', validationLeaseUntil: new Date(Date.now() - 1000) },
    });
    await prisma.modelVersion.update({
      where: { id: busy.id },
      data: { status: 'VALIDATING', validationLeaseUntil: new Date(Date.now() + 600_000) },
    });

    const enqueued: string[] = [];
    const r = await validation.sweep((id) => {
      enqueued.push(id);
      return Promise.resolve(true);
    });
    expect(r.reclaimed).toBeGreaterThanOrEqual(1);
    expect(enqueued).toContain(crashed.id);
    expect(enqueued).not.toContain(busy.id);
    expect((await getVersion(busy.id)).status).toBe('VALIDATING');

    expect(await validation.process(crashed.id, false)).toBe(true);
    expect((await getVersion(crashed.id)).status).toBe('VALIDATED');
  });

  it('an infrastructure failure is retried, then recorded as ERROR, and can be re-run', async () => {
    const v = await uploaded({ ...sklearn, golden: uniqueGolden(sklearn.golden) });
    // A second API instance whose ML worker is unreachable (port 9 = discard, nothing listens).
    const broken = await createTestApp({ MO_ML_WORKER_URL: 'http://127.0.0.1:9' });
    try {
      const brokenValidation = broken.get(ValidationService);
      await expect(brokenValidation.process(v.id, false)).rejects.toBeInstanceOf(RetryableError);
      expect((await getVersion(v.id)).status).toBe('PENDING_VALIDATION'); // released for a retry

      expect(await brokenValidation.process(v.id, true)).toBe(true); // last attempt
    } finally {
      await broken.close();
    }
    const failed = await getHistory(v.id);
    expect(failed.status).toBe('REJECTED');
    expect(failed.latest?.result).toBe('ERROR');
    expect(failed.latest?.facts.error).toMatch(/unreachable/);
    expect(failed.retryable).toBe(true);

    const rerun = await ada.post(`/orgs/${ada.orgId}/model-versions/${v.id}/validation/rerun`);
    expect(rerun.status).toBe(202);
    expect((rerun.body as History).status).toBe('PENDING_VALIDATION');

    expect(await validation.process(v.id, false)).toBe(true);
    const h = await getHistory(v.id);
    expect(h.status).toBe('VALIDATED');
    expect(h.attempts).toBe(3);
    expect(h.history.map((r) => r.result)).toEqual(['PASSED', 'ERROR']);
    expect(h.retryable).toBe(false);
  });

  it('only an ERROR result can be re-run; a model that FAILED a check cannot', async () => {
    const v = await uploaded({ ...sklearn, golden: flippedGolden(sklearn.golden) });
    const pending = await ada.post(`/orgs/${ada.orgId}/model-versions/${v.id}/validation/rerun`);
    expect(pending.status).toBe(409);
    await validation.process(v.id, false);
    const failed = await ada.post(`/orgs/${ada.orgId}/model-versions/${v.id}/validation/rerun`);
    expect(failed.status).toBe(409);
    expect(code(failed)).toBe('VALIDATION_NOT_RETRYABLE');
  });
});

describe('database invariants (trigger model_versions_guard)', () => {
  it('a VALIDATED version is final and its artifact hashes are immutable', async () => {
    const v = await uploaded({ ...sklearn, golden: uniqueGolden(sklearn.golden) });
    await validation.process(v.id, false);
    const prisma = prismaOf(app);
    await expect(
      prisma.modelVersion.update({ where: { id: v.id }, data: { status: 'PENDING_VALIDATION' } }),
    ).rejects.toThrow();
    await expect(
      prisma.modelVersion.update({ where: { id: v.id }, data: { artifactSha256: 'e'.repeat(64) } }),
    ).rejects.toThrow();
    expect((await getVersion(v.id)).artifactSha256).toBe(sklearn.sha256);
  });
});

describe('upload endpoint input handling', () => {
  it('requires every part', async () => {
    const res = await ada.upload(
      `/orgs/${ada.orgId}/models/${modelId}/versions/upload`,
      { framework: 'SKLEARN_ONNX' },
      { model: sklearn.model },
    );
    expect(res.status).toBe(400);
    expect((res.body as Problem).errors?.map((e) => e.field)).toEqual(['signature', 'golden']);
  });

  it('rejects an unknown framework and a malformed signature with 422', async () => {
    const fw = await upload({ ...sklearn, framework: 'TENSORFLOW' as Bundle['framework'] });
    expect(fw.status).toBe(422);
    expect(code(fw)).toBe('UNSUPPORTED_FRAMEWORK');
    const sig = await upload({ ...sklearn, signature: Buffer.from('{"task":"regression"}') });
    expect(sig.status).toBe(422);
    expect(code(sig)).toBe('SIGNATURE_INVALID');
  });

  it('rejects a JSON part over 1 MB and a model over 100 MB with 413', async () => {
    const bigJson = await upload({ ...sklearn, golden: Buffer.alloc(1024 * 1024 + 1, 0x20) });
    expect(bigJson.status).toBe(413);
    const bigModel = await upload({ ...sklearn, model: Buffer.alloc(100 * 1024 * 1024 + 1) });
    expect(bigModel.status).toBe(413);
    // Neither created a version.
    const versions = await prismaOf(app).modelVersion.count({
      where: { modelId, sizeBytes: { gt: 1024 * 1024 } },
    });
    expect(versions).toBe(0);
  }, 60_000);

  it('another tenant sees neither the version nor its validation (404)', async () => {
    const v = await uploaded(sklearn);
    const res = await eve.get(`/orgs/${ada.orgId}/model-versions/${v.id}/validation`);
    expect(res.status).toBe(404); // not a member: the org itself does not exist for Eve
    const own = await eve.get(`/orgs/${eve.orgId}/model-versions/${v.id}/validation`);
    expect(own.status).toBe(404);
  });
});

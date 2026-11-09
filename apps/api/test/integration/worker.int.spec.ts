import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test, type TestingModule } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_CONFIG } from '../../src/config/config';
import {
  bullConnection,
  VALIDATION_QUEUE,
  ValidationQueue,
} from '../../src/modules/validation/validation.queue';
import { WorkerModule } from '../../src/worker.module';
import { loadBundle, uniqueGolden } from './bundles';
import { Client, createTestApp, prismaOf, testConfig } from './helpers';

/**
 * The real background path: the API enqueues on Redis (BullMQ), a separate WorkerModule (what
 * `node dist/worker.js` runs) consumes the job, and its sweeper recovers jobs that were lost.
 */
let api: NestExpressApplication;
let worker: TestingModule | undefined;
let ada: Client;
let modelId: string;
const sklearn = loadBundle('sklearn');

async function waitForStatus(id: string, want: string, timeoutMs = 60_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let status = '';
  while (Date.now() < deadline) {
    const v = await prismaOf(api).modelVersion.findUniqueOrThrow({ where: { id } });
    status = v.status;
    if (status === want) return status;
    await new Promise((r) => setTimeout(r, 250));
  }
  return status;
}

async function upload(): Promise<string> {
  const res = await ada.upload(
    `/orgs/${ada.orgId}/models/${modelId}/versions/upload`,
    { framework: sklearn.framework },
    { model: sklearn.model, signature: sklearn.signature, golden: uniqueGolden(sklearn.golden) },
  );
  if (res.status !== 201) throw new Error(`upload failed ${String(res.status)} ${res.text}`);
  return (res.body as { id: string }).id;
}

beforeAll(async () => {
  api = await createTestApp();
  ada = await Client.register(api, { name: 'Ada' });
  const project = await ada.post(`/orgs/${ada.orgId}/projects`, { name: 'Worker' });
  const projectId = (project.body as { id: string }).id;
  const model = await ada.post(`/orgs/${ada.orgId}/projects/${projectId}/models`, {
    name: 'Queued',
  });
  modelId = (model.body as { id: string }).id;
}, 120_000);
afterAll(async () => {
  await worker?.close();
  await api.close();
});

describe('validation worker process', () => {
  it('validates queued versions, and its sweeper recovers a version whose job was lost', async () => {
    // Test instance id: the real loops here must never manage the dev stack's containers.
    const config = testConfig({ MO_VALIDATION_SWEEP_MS: '1000' });

    // 1. A version whose job vanished from Redis (e.g. Redis restarted without persistence).
    const lost = await upload();
    const connection = bullConnection(config);
    const queue = new Queue(VALIDATION_QUEUE, { connection });
    expect(await queue.remove(ValidationQueue.jobId(lost))).toBe(1);
    await queue.close();
    connection.disconnect();

    // 2. Start the worker (exactly the module `node dist/worker.js` boots).
    worker = await Test.createTestingModule({ imports: [WorkerModule] })
      .overrideProvider(APP_CONFIG)
      .useValue(config)
      .compile();
    await worker.init();

    // 3. A version enqueued normally while the worker runs.
    const queued = await upload();

    expect(await waitForStatus(queued, 'VALIDATED')).toBe('VALIDATED');
    expect(await waitForStatus(lost, 'VALIDATED')).toBe('VALIDATED');
    const reports = await prismaOf(api).validationReport.findMany({
      where: { versionId: { in: [queued, lost] } },
    });
    expect(reports.map((r) => r.result)).toEqual(['PASSED', 'PASSED']);
  }, 120_000);
});

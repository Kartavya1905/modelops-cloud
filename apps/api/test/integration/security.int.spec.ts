import { execFileSync } from 'node:child_process';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { TestingModule } from '@nestjs/testing';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { DeployProcessor } from '../../src/modules/deployments/deploy.processor';
import { OutboxRelay } from '../../src/modules/deployments/outbox.relay';
import { ValidationService } from '../../src/modules/validation/validation.service';
import { loadBundle, uniqueGolden, uniqueModel } from './bundles';
import { API, Client, createTestApp, createTestWorker, prismaOf } from './helpers';

/**
 * SEC-14 (docs/06 §7): request inputs never reach a log. A sentinel value is sent through every
 * inference path (public predict, the UI playground, a rejected request), then every place that
 * could hold it is searched: the gateway's and the model server's container logs, this process's
 * own stdout/stderr (API + worker code), the Redis event stream (capture is off) and the audit log.
 */
const SENTINEL = 31337.424242; // a number, so it is a valid feature value
const TEXT_SENTINEL = 'sentinel-7f3a9c'; // and a string, for the rejected-input path

let app: NestExpressApplication;
let worker: TestingModule;
let ada: Client;
let endpoint: { id: string; slug: string };
let revisionId: string;
let apiKey: string;
const captured: string[] = [];
const write = {
  out: process.stdout.write.bind(process.stdout),
  err: process.stderr.write.bind(process.stderr),
};
const sklearn = loadBundle('sklearn');
const features =
  (JSON.parse(sklearn.signature.toString('utf8')) as { inputs: { features: string[] }[] }).inputs[0]
    ?.features ?? [];

beforeAll(async () => {
  app = await createTestApp();
  worker = await createTestWorker();
  ada = await Client.register(app, { name: 'Ada' });
  const projectId = (
    (await ada.post(`/orgs/${ada.orgId}/projects`, { name: 'Private' })).body as { id: string }
  ).id;
  const modelId = (
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
  const versionId = (up.body as { id: string }).id;
  await worker.get(ValidationService).process(versionId, false);
  endpoint = (
    await ada.post(`/orgs/${ada.orgId}/projects/${projectId}/endpoints`, { name: 'Private churn' })
  ).body as { id: string; slug: string };
  const dep = await ada.agent
    .post(`${API}/orgs/${ada.orgId}/endpoints/${endpoint.id}/revisions`)
    .set('x-csrf-token', ada.session.csrfToken)
    .set('idempotency-key', crypto.randomUUID())
    .send({ modelVersionId: versionId });
  revisionId = (dep.body as { id: string }).id;
  await worker.get(OutboxRelay).runOnce();
  await worker.get(DeployProcessor).process(revisionId, { isFinalAttempt: true });
  apiKey = (
    (await ada.post(`/orgs/${ada.orgId}/projects/${projectId}/api-keys`, { name: 'sec-14' }))
      .body as {
      key: string;
    }
  ).key;
}, 240_000);
afterAll(async () => {
  process.stdout.write = write.out;
  process.stderr.write = write.err;
  await worker.close();
  await app.close();
});

describe('SEC-14: inputs never reach a log', () => {
  it('a sentinel sent through every inference path appears nowhere', async () => {
    // Capture everything this process (API and worker code) prints from here on.
    process.stdout.write = (chunk: string | Uint8Array, ...rest: never[]) => {
      captured.push(String(chunk));
      return write.out(chunk, ...rest);
    };
    process.stderr.write = (chunk: string | Uint8Array, ...rest: never[]) => {
      captured.push(String(chunk));
      return write.err(chunk, ...rest);
    };

    const row = Object.fromEntries(features.map((f) => [f, SENTINEL]));
    const predict = (body: unknown) =>
      fetch(`${inject('gatewayUrl')}/v1/endpoints/${endpoint.slug}/predict`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    let ok: Response | undefined;
    for (let i = 0; i < 40; i++) {
      ok = await predict({ inputs: [row] });
      if (ok.status === 200) break;
      await new Promise((r) => setTimeout(r, 250)); // routing snapshot propagating
    }
    expect(ok?.status, await ok?.clone().text()).toBe(200);
    const bad = await predict({ inputs: [{ ...row, [features[0] ?? 'x']: TEXT_SENTINEL }] });
    expect(bad.status).toBe(400);
    expect(await bad.text()).not.toContain(TEXT_SENTINEL); // the error names the field, not the value
    const pg = await ada.post(`/orgs/${ada.orgId}/endpoints/${endpoint.id}/playground/predict`, {
      inputs: [row],
    });
    expect(pg.status).toBe(200);
    await new Promise((r) => setTimeout(r, 1500)); // let log lines flush

    const logs = (name: string) => {
      const out = execFileSync('docker', ['logs', name], {
        encoding: 'buffer',
        stdio: 'pipe',
        maxBuffer: 512 * 1024 * 1024, // the shared test gateway logs every request of the run
      });
      return out.toString('utf8');
    };
    const gatewayLog = logs('modelops-gateway-test');
    const modelServerLog = logs(`mo-rev-${revisionId}`);
    expect(gatewayLog).toContain('predict'); // the gateway did log these requests (info level)
    const redis = new Redis(inject('redisUrl'));
    const stream = JSON.stringify(await redis.xrange('mo:events', '-', '+'));
    redis.disconnect();
    const audit = JSON.stringify(
      await prismaOf(app).auditEvent.findMany({ where: { orgId: ada.orgId } }),
      (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v),
    );
    const places = {
      gatewayLog,
      modelServerLog,
      apiAndWorkerOutput: captured.join(''),
      eventStream: stream,
      auditLog: audit,
    };
    for (const [place, text] of Object.entries(places)) {
      expect(text.includes(String(SENTINEL)), `${place} contains the numeric sentinel`).toBe(false);
      expect(text.includes(TEXT_SENTINEL), `${place} contains the text sentinel`).toBe(false);
    }
    expect(stream).toContain(endpoint.id); // the stream did carry these predictions (no inputs)
  }, 60_000);
});

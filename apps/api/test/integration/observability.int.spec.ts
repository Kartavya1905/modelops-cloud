import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DeployProcessor } from '../../src/modules/deployments/deploy.processor';
import { OutboxRelay } from '../../src/modules/deployments/outbox.relay';
import { ValidationService } from '../../src/modules/validation/validation.service';
import { loadBundle, uniqueGolden } from './bundles';
import { Client, createTestApp, createTestWorker, prismaOf, type Problem } from './helpers';

/**
 * M6 against real infrastructure: the playground goes through the test gateway container; the
 * dashboard reads Prometheus (which scrapes that gateway); k6 (in Docker) generates the load.
 * Acceptance (roadmap M6): dashboard numbers match k6's own counts.
 */
interface Metrics {
  range: string;
  summary: { requests: number; serverErrors: number; clientErrors: number; playground: number };
  rps: { name: string; points: { t: number; v: number | null }[] }[];
  latency: { name: string }[];
}
interface Golden {
  inputs: number[][];
  outputs: { label: number[] };
}

let app: NestExpressApplication;
let worker: TestingModule;
let ada: Client;
let viewer: Client;
let eve: Client;
let endpointId: string;
let slug: string;
let apiKey: string;
const sklearn = loadBundle('sklearn');
const golden = JSON.parse(sklearn.golden.toString('utf8')) as Golden;
const features =
  (JSON.parse(sklearn.signature.toString('utf8')) as { inputs: { features: string[] }[] }).inputs[0]
    ?.features ?? [];
const asRow = (r: number[]) => Object.fromEntries(features.map((f, i) => [f, r[i] ?? 0]));
const ROOT = join(process.cwd(), '..', '..');

const metrics = async (c: Client, range = '15m') =>
  c.get(`/orgs/${ada.orgId}/endpoints/${endpointId}/metrics?range=${range}`);
async function eventually<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 30_000) {
  const deadline = Date.now() + ms;
  let last = await fn();
  while (!ok(last) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    last = await fn();
  }
  return last;
}
const playground = (c: Client, inputs: object[]) =>
  c.post(`/orgs/${ada.orgId}/endpoints/${endpointId}/playground/predict`, { inputs });

beforeAll(async () => {
  app = await createTestApp();
  worker = await createTestWorker();
  ada = await Client.register(app, { name: 'Ada' });
  viewer = await Client.register(app, { name: 'Vic' });
  eve = await Client.register(app, { name: 'Eve' });
  await prismaOf(app).membership.create({
    data: { orgId: ada.orgId, userId: viewer.userId, role: 'VIEWER' },
  });
  const project = (
    (await ada.post(`/orgs/${ada.orgId}/projects`, { name: 'Observed' })).body as { id: string }
  ).id;
  const model = (
    (await ada.post(`/orgs/${ada.orgId}/projects/${project}/models`, { name: 'Churn' })).body as {
      id: string;
    }
  ).id;
  const up = await ada.upload(
    `/orgs/${ada.orgId}/models/${model}/versions/upload`,
    { framework: sklearn.framework },
    { model: sklearn.model, signature: sklearn.signature, golden: uniqueGolden(sklearn.golden) },
  );
  const versionId = (up.body as { id: string }).id;
  await worker.get(ValidationService).process(versionId, false);

  const ep = (
    await ada.post(`/orgs/${ada.orgId}/projects/${project}/endpoints`, { name: 'Observed churn' })
  ).body as { id: string; slug: string };
  endpointId = ep.id;
  slug = ep.slug;
  const dep = await ada.agent
    .post(`/api/v1/orgs/${ada.orgId}/endpoints/${endpointId}/revisions`)
    .set('x-csrf-token', ada.session.csrfToken)
    .set('idempotency-key', crypto.randomUUID())
    .send({ modelVersionId: versionId });
  const revisionId = (dep.body as { id: string }).id;
  await worker.get(OutboxRelay).runOnce();
  await worker.get(DeployProcessor).process(revisionId, { isFinalAttempt: true });
  apiKey = (
    (await ada.post(`/orgs/${ada.orgId}/projects/${project}/api-keys`, { name: 'load test' }))
      .body as { key: string }
  ).key;
}, 240_000);
afterAll(async () => {
  await worker.close();
  await app.close();
});

describe('playground', () => {
  it('describes the serving model from its signature, with golden examples to start from', async () => {
    const res = await ada.get(`/orgs/${ada.orgId}/endpoints/${endpointId}/playground`);
    expect(res.status).toBe(200);
    const info = res.body as { ready: boolean; features: string[]; examples: object[] };
    expect(info.ready).toBe(true);
    expect(info.features).toEqual(features);
    expect(info.examples).toEqual(golden.inputs.slice(0, 5).map(asRow));
  });

  it('predicts through the gateway (same validation), for every role, never across tenants', async () => {
    const rows = golden.inputs.slice(0, 3).map(asRow);
    const res = await eventually(
      () => playground(ada, rows),
      (r) => r.status === 200,
    );
    expect(res.status).toBe(200);
    expect((res.body as { outputs: { label: number }[] }).outputs.map((o) => o.label)).toEqual(
      golden.outputs.label.slice(0, 3),
    );
    expect((await playground(viewer, rows.slice(0, 1))).status).toBe(200);

    const bad = await playground(ada, [{ ...rows[0], extra: 1 }]);
    expect(bad.status).toBe(400);
    expect((bad.body as Problem).errors?.[0]?.field).toBe('inputs[0].extra');

    expect((await playground(eve, rows)).status).toBe(404); // not her org
  }, 60_000);
});

describe('metrics API', () => {
  it('SEC-15: rejects anything but allow-listed series and ranges', async () => {
    for (const q of ['series=sum(up)', 'query=up', 'range=1y', 'range=1h&step=1s']) {
      const res = await ada.get(`/orgs/${ada.orgId}/endpoints/${endpointId}/metrics?${q}`);
      expect(res.status, q).toBe(400);
      expect((res.body as Problem).code).toBe('VALIDATION_FAILED');
    }
    const other = await eve.get(`/orgs/${ada.orgId}/endpoints/${endpointId}/metrics`);
    expect(other.status).toBe(404);
  });

  it('acceptance: dashboard counts match the load generator’s (k6) counts', async () => {
    const before = await eventually(
      () => metrics(ada),
      (r) => r.status === 200,
    );
    const start = (before.body as Metrics).summary;

    // 10 req/s for 6 s through the test gateway, exactly like `pnpm demo:traffic`.
    const out = execFileSync(
      process.execPath,
      [
        join(ROOT, 'scripts', 'demo-traffic.mjs'),
        '--endpoint',
        slug,
        '--key',
        apiKey,
        '--rps',
        '10',
        '--duration',
        '6s',
        '--gateway',
        'http://modelops-gateway-test:8080',
        '--json',
      ],
      { encoding: 'utf8', timeout: 120_000 },
    );
    const k6 = JSON.parse(out.trim()) as { requests: number; failed: number };
    expect(k6.requests).toBeGreaterThanOrEqual(55); // constant arrival rate: ~60
    expect(k6.failed).toBe(0);

    // Prometheus scrapes every 5 s; the API's counts are exact counter differences.
    const after = await eventually(
      () => metrics(ada),
      (r) =>
        r.status === 200 &&
        (r.body as Metrics).summary.requests - (r.body as Metrics).summary.playground >=
          start.requests - start.playground + k6.requests,
      40_000,
    );
    const m = after.body as Metrics;
    const apiTraffic = m.summary.requests - m.summary.playground;
    expect(apiTraffic - (start.requests - start.playground)).toBe(k6.requests);
    expect(m.summary.serverErrors).toBe(0);
    expect(m.rps.map((l) => l.name)).toEqual(['v1']);
    // Rates are approximations by design: for a series Prometheus sees for the first time, the
    // requests before its first scrape are in the counter (so the exact count above includes
    // them) but in no rate. So the chart is only checked for having the series, not its height.
    expect(m.latency.map((l) => l.name)).toEqual(['p50', 'p95', 'p99']);

    // The org overview sees the same traffic.
    const overview = await ada.get(`/orgs/${ada.orgId}/overview`);
    expect(overview.status).toBe(200);
    const o = overview.body as { requests24h: number; servingEndpoints: number; endpoints: number };
    expect(o.requests24h).toBe(m.summary.requests);
    expect(o).toMatchObject({ servingEndpoints: 1, endpoints: 1 });
  }, 180_000);

  it('degrades clearly when Prometheus is down: 503 for metrics, overview still renders', async () => {
    const broken = await createTestApp({ MO_PROMETHEUS_URL: 'http://127.0.0.1:9' });
    try {
      const bob = await Client.register(broken, { name: 'Bob' });
      const project = (
        (await bob.post(`/orgs/${bob.orgId}/projects`, { name: 'Dark' })).body as { id: string }
      ).id;
      const ep = (
        (await bob.post(`/orgs/${bob.orgId}/projects/${project}/endpoints`, { name: 'Dark ep' }))
          .body as { id: string }
      ).id;
      const res = await bob.get(`/orgs/${bob.orgId}/endpoints/${ep}/metrics`);
      expect(res.status).toBe(503);
      expect((res.body as Problem).code).toBe('METRICS_UNAVAILABLE');
      const overview = await bob.get(`/orgs/${bob.orgId}/overview`);
      expect(overview.status).toBe(200);
      expect((overview.body as { requests24h: number | null }).requests24h).toBeNull();
    } finally {
      await broken.close();
    }
  });
});

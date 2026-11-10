import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { DeployProcessor } from '../../src/modules/deployments/deploy.processor';
import { OutboxRelay } from '../../src/modules/deployments/outbox.relay';
import { EventsConsumer } from '../../src/modules/monitoring/events.consumer';
import { ValidationService } from '../../src/modules/validation/validation.service';
import { type Bundle, loadBundle, uniqueGolden } from './bundles';
import { API, Client, createTestApp, createTestWorker, prismaOf, type Problem } from './helpers';

/**
 * M7 end to end: Evidently drift in the ml-worker, prediction events through the real gateway and
 * Redis stream, ground-truth feedback, measured performance, and the evaluation gate in front of
 * the `champion` alias. Datasets come from the seeded generator (`python -m modelops_ml.datasets`).
 */
interface Row {
  features: Record<string, number>;
  label: number;
}
interface Drift {
  datasetDrift: boolean;
  driftShare: number;
  sampleCount: number;
  features: { feature: string; drifted: boolean; method: string; score: number }[];
}
interface Perf {
  predictions: number;
  summary: { labelled: number; accuracy: number; f1: number; rocAuc: number };
}
interface Evaluation {
  id: string;
  status: string;
  passed: boolean;
  canPromote: boolean;
  baseline: { id: string } | null;
  checks: { rule: string; passed: boolean }[];
  metrics: { candidate: { rocAuc: number }; baseline: { rocAuc: number } | null };
}

const ROOT = join(process.cwd(), '..', '..');
const TMP = mkdtempSync(join(tmpdir(), 'mo-m7-'));
const sklearn = loadBundle('sklearn');
const pytorch = loadBundle('pytorch');

/** The platform's own generator, so drift and concept drift are known by construction. */
function dataset(name: string, args: string[], format: 'csv' | 'jsonl'): string {
  const out = join(TMP, `${name}.${format}`);
  execFileSync(
    'uv',
    [
      'run',
      '--directory',
      join(ROOT, 'ml'),
      'python',
      '-m',
      'modelops_ml.datasets',
      ...args,
      '--format',
      format,
      '--out',
      out,
    ],
    { stdio: 'pipe', timeout: 180_000 },
  );
  return out;
}
const rowsOf = (file: string) =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Row);

let app: NestExpressApplication;
let worker: TestingModule;
let ada: Client;
let viewer: Client;
let projectId: string;
let modelId: string;
let trainingDatasetId: string;
let holdoutDatasetId: string;
let sklearnVersionId: string;
let apiKey: string;

const GATEWAY = () => inject('gatewayUrl');
const consumer = () => worker.get(EventsConsumer);

async function drainEvents() {
  const total = { predictions: 0, captured: 0, feedbackApplied: 0, feedbackIgnored: 0 };
  for (let i = 0; i < 50; i++) {
    const r = await consumer().runOnce();
    if (r.predictions + r.feedbackApplied + r.feedbackIgnored === 0) break;
    for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += r[k];
  }
  return total;
}

async function uploadDataset(file: string, name: string, version: string): Promise<string> {
  const res = await ada.agent
    .post(`${API}/orgs/${ada.orgId}/projects/${projectId}/datasets`)
    .set('x-csrf-token', ada.session.csrfToken)
    .field('name', name)
    .field('version', version)
    .attach('file', readFileSync(file), 'data.csv');
  if (res.status !== 201) throw new Error(`dataset ${String(res.status)} ${res.text}`);
  return (res.body as { id: string }).id;
}

async function validatedVersion(b: Bundle): Promise<string> {
  const res = await ada.upload(
    `/orgs/${ada.orgId}/models/${modelId}/versions/upload`,
    { framework: b.framework, trainingDatasetVersionId: trainingDatasetId },
    { model: b.model, signature: b.signature, golden: uniqueGolden(b.golden) },
  );
  if (res.status !== 201) throw new Error(`upload ${String(res.status)} ${res.text}`);
  const id = (res.body as { id: string }).id;
  await worker.get(ValidationService).process(id, false);
  return id;
}

/** Endpoint + deploy + READY; returns { id, slug }. */
async function servingEndpoint(name: string, versionId: string, capture: boolean) {
  const ep = (await ada.post(`/orgs/${ada.orgId}/projects/${projectId}/endpoints`, { name }))
    .body as {
    id: string;
    slug: string;
  };
  const dep = await ada.agent
    .post(`${API}/orgs/${ada.orgId}/endpoints/${ep.id}/revisions`)
    .set('x-csrf-token', ada.session.csrfToken)
    .set('idempotency-key', crypto.randomUUID())
    .send({ modelVersionId: versionId });
  await worker.get(OutboxRelay).runOnce();
  await worker
    .get(DeployProcessor)
    .process((dep.body as { id: string }).id, { isFinalAttempt: true });
  if (capture) {
    const etag = (await ada.get(`/orgs/${ada.orgId}/endpoints/${ep.id}`)).headers.etag as string;
    const res = await ada.agent
      .patch(`${API}/orgs/${ada.orgId}/endpoints/${ep.id}`)
      .set('x-csrf-token', ada.session.csrfToken)
      .set('if-match', etag)
      .send({ captureInputs: true });
    if (res.status !== 200) throw new Error(`capture ${String(res.status)} ${res.text}`);
  }
  return ep;
}

/** Sends every row through the gateway (64 per request), then its true label as feedback. */
async function traffic(slug: string, rows: Row[], feedback = true) {
  const ids: string[] = [];
  for (let i = 0; i < rows.length; i += 64) {
    const chunk = rows.slice(i, i + 64);
    let res: Response | undefined;
    for (let attempt = 0; attempt < 30; attempt++) {
      res = await fetch(`${GATEWAY()}/v1/endpoints/${slug}/predict`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ inputs: chunk.map((r) => r.features) }),
      });
      if (res.status === 200) break;
      await new Promise((r) => setTimeout(r, 300)); // routing snapshot / capture flag propagating
    }
    if (res?.status !== 200) throw new Error(`predict ${String(res?.status)}`);
    ids.push(...((await res.json()) as { predictionIds: string[] }).predictionIds);
  }
  if (feedback) {
    const items = ids.map((predictionId, i) => ({ predictionId, label: rows[i]?.label }));
    for (let i = 0; i < items.length; i += 1000) {
      const res = await fetch(`${GATEWAY()}/v1/endpoints/${slug}/feedback`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ items: items.slice(i, i + 1000) }),
      });
      if (res.status !== 202) throw new Error(`feedback ${String(res.status)}`);
    }
  }
  return ids;
}

const drift = (endpointId: string) =>
  ada.post(`/orgs/${ada.orgId}/endpoints/${endpointId}/drift-reports`, {});
const performance = async (endpointId: string) =>
  (await ada.get(`/orgs/${ada.orgId}/endpoints/${endpointId}/performance?range=24h`)).body as Perf;
const evaluate = (candidateVersionId: string) =>
  ada.post(`/orgs/${ada.orgId}/models/${modelId}/evaluations`, {
    candidateVersionId,
    datasetVersionId: holdoutDatasetId,
  });

beforeAll(async () => {
  app = await createTestApp({ MO_DRIFT_MIN_SAMPLES: '100' });
  worker = await createTestWorker({ MO_DRIFT_MIN_SAMPLES: '100' });
  ada = await Client.register(app, { name: 'Ada' });
  viewer = await Client.register(app, { name: 'Vic' });
  await prismaOf(app).membership.create({
    data: { orgId: ada.orgId, userId: viewer.userId, role: 'VIEWER' },
  });
  projectId = (
    (await ada.post(`/orgs/${ada.orgId}/projects`, { name: 'Monitored' })).body as { id: string }
  ).id;
  modelId = (
    (await ada.post(`/orgs/${ada.orgId}/projects/${projectId}/models`, { name: 'Churn' })).body as {
      id: string;
    }
  ).id;
  // The fixture bundles were trained on seed 3 / 1500 rows: that is their reference dataset.
  trainingDatasetId = await uploadDataset(
    dataset('train', ['--rows', '1500', '--seed', '3'], 'csv'),
    'churn',
    'seed3-n1500',
  );
  holdoutDatasetId = await uploadDataset(
    dataset('holdout', ['--rows', '2000', '--seed', '11'], 'csv'),
    'churn-holdout',
    'seed11-n2000',
  );
  sklearnVersionId = await validatedVersion(sklearn);
  apiKey = (
    (await ada.post(`/orgs/${ada.orgId}/projects/${projectId}/api-keys`, { name: 'monitor' }))
      .body as { key: string }
  ).key;
  // Earlier test files send predictions through the same test gateway, so the shared event
  // stream may hold their events; consume them first so the counts below are this file's only.
  await drainEvents();
}, 300_000);
afterAll(async () => {
  await worker.close();
  await app.close();
});

describe('datasets', () => {
  it('are stored content-addressed, with columns, and the same bytes are the same version', async () => {
    const list = (await ada.get(`/orgs/${ada.orgId}/projects/${projectId}/datasets`)).body as {
      id: string;
      stored: boolean;
      sha256: string;
      columns: string[];
      rowCount: number;
    }[];
    const train = list.find((d) => d.id === trainingDatasetId);
    expect(train).toMatchObject({ stored: true, rowCount: 1500 });
    expect(train?.sha256).toBe('6bf52cb8b764f6ac72ea3f568dd7bd19981dd198c661baeb377f2652ef4eb91e');
    expect(train?.columns).toContain('churned');
    const again = await uploadDataset(join(TMP, 'train.csv'), 'churn', 'seed3-n1500');
    expect(again).toBe(trainingDatasetId);

    const bad = await ada.agent
      .post(`${API}/orgs/${ada.orgId}/projects/${projectId}/datasets`)
      .set('x-csrf-token', ada.session.csrfToken)
      .field('name', 'broken')
      .field('version', 'x')
      .attach('file', Buffer.from('a,b\n1\n'), 'bad.csv');
    expect(bad.status).toBe(422);
    expect((bad.body as Problem).code).toBe('INVALID_DATASET');
  }, 60_000);
});

describe('data drift vs concept drift (separate signals)', () => {
  it('normal traffic: no data drift, good measured performance', async () => {
    const ep = await servingEndpoint('Normal traffic', sklearnVersionId, true);
    await traffic(ep.slug, rowsOf(dataset('normal', ['--rows', '400', '--seed', '13'], 'jsonl')));
    const consumed = await drainEvents();
    expect(consumed).toMatchObject({ predictions: 400, captured: 400, feedbackApplied: 400 });

    const res = await drift(ep.id);
    expect(res.status, res.text).toBe(201);
    const d = res.body as Drift;
    expect(d.sampleCount).toBe(400);
    expect(d.datasetDrift).toBe(false);
    expect(d.features.find((f) => f.feature === 'monthly_charges')?.drifted).toBe(false);

    const p = await performance(ep.id);
    expect(p.predictions).toBe(400);
    expect(p.summary.labelled).toBe(400);
    expect(p.summary.rocAuc).toBeGreaterThan(0.7);
  }, 240_000);

  it('shifted inputs (data drift): the moved features are flagged', async () => {
    const ep = await servingEndpoint('Shifted traffic', sklearnVersionId, true);
    const rows = rowsOf(
      dataset(
        'shifted',
        ['--rows', '400', '--seed', '14', '--charge-shift', '40', '--usage-scale', '1.6'],
        'jsonl',
      ),
    );
    await traffic(ep.slug, rows, false);
    await drainEvents();
    const d = (await drift(ep.id)).body as Drift;
    const drifted = d.features.filter((f) => f.drifted).map((f) => f.feature);
    expect(drifted).toEqual(expect.arrayContaining(['monthly_charges', 'usage_hours']));
    expect(drifted).not.toContain('tenure_months');
    expect(d.driftShare).toBeGreaterThan(0);
  }, 240_000);

  it('concept drift: inputs look normal, but measured performance falls', async () => {
    const ep = await servingEndpoint('Concept drift', sklearnVersionId, true);
    // Same seed as the normal endpoint: IDENTICAL inputs, only the labels' meaning changed.
    await traffic(
      ep.slug,
      rowsOf(
        dataset('concept', ['--rows', '400', '--seed', '13', '--concept-shift', '1'], 'jsonl'),
      ),
    );
    await drainEvents();
    const d = (await drift(ep.id)).body as Drift;
    expect(d.datasetDrift).toBe(false);
    expect(d.features.filter((f) => f.drifted)).toEqual([]);

    const normalEp = (
      await prismaOf(app).endpoint.findFirstOrThrow({ where: { name: 'Normal traffic' } })
    ).id;
    const normal = await performance(normalEp);
    const concept = await performance(ep.id);
    expect(concept.summary.accuracy).toBeLessThan(normal.summary.accuracy - 0.08);
    expect(concept.summary.rocAuc).toBeLessThan(normal.summary.rocAuc - 0.2);
  }, 240_000);
});

describe('drift prerequisites and safety', () => {
  it('explains missing samples and missing references instead of guessing', async () => {
    const quiet = await servingEndpoint('Quiet', sklearnVersionId, false);
    const res = await drift(quiet.id);
    expect(res.status).toBe(422);
    expect((res.body as Problem).code).toBe('NOT_ENOUGH_SAMPLES');
    expect((res.body as Problem).detail).toMatch(/capture is off/);

    // A version without a training dataset (no lineage) can't be drift-checked.
    const up = await ada.upload(
      `/orgs/${ada.orgId}/models/${modelId}/versions/upload`,
      { framework: sklearn.framework },
      { model: sklearn.model, signature: sklearn.signature, golden: uniqueGolden(sklearn.golden) },
    );
    const noRef = (up.body as { id: string }).id;
    await worker.get(ValidationService).process(noRef, false);
    const ep = await servingEndpoint('No reference', noRef, true);
    expect((await drift(ep.id)).status).toBe(409);
    expect(((await drift(ep.id)).body as Problem).code).toBe('DRIFT_REFERENCE_UNAVAILABLE');
  }, 240_000);

  it('feedback for another endpoint’s prediction is ignored; viewers can read but not run', async () => {
    const a = await prismaOf(app).endpoint.findFirstOrThrow({ where: { name: 'Shifted traffic' } });
    const b = await prismaOf(app).endpoint.findFirstOrThrow({ where: { name: 'Quiet' } });
    const rec = await prismaOf(app).predictionRecord.findFirstOrThrow({
      where: { endpointId: a.id },
    });
    const res = await fetch(`${GATEWAY()}/v1/endpoints/${b.slug}/feedback`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ items: [{ predictionId: rec.id, label: 1 }] }),
    });
    expect(res.status).toBe(202);
    const consumed = await drainEvents();
    expect(consumed.feedbackIgnored).toBe(1);
    expect(
      await prismaOf(app).predictionFeedback.findUnique({ where: { predictionId: rec.id } }),
    ).toBeNull();

    expect((await viewer.get(`/orgs/${ada.orgId}/endpoints/${a.id}/drift-reports`)).status).toBe(
      200,
    );
    expect(
      (await viewer.post(`/orgs/${ada.orgId}/endpoints/${a.id}/drift-reports`, {})).status,
    ).toBe(403);
  }, 60_000);

  it('endpoint settings need If-Match (lost-update protection)', async () => {
    const ep = await prismaOf(app).endpoint.findFirstOrThrow({ where: { name: 'Quiet' } });
    const url = `${API}/orgs/${ada.orgId}/endpoints/${ep.id}`;
    const send = (ifMatch?: string) => {
      const req = ada.agent.patch(url).set('x-csrf-token', ada.session.csrfToken);
      return (ifMatch ? req.set('if-match', ifMatch) : req).send({ captureInputs: true });
    };
    expect((await send()).status).toBe(428);
    expect((await send('W/"999"')).status).toBe(412);
    const etag = (await ada.get(`/orgs/${ada.orgId}/endpoints/${ep.id}`)).headers.etag as string;
    const ok = await send(etag);
    expect(ok.status).toBe(200);
    expect(ok.headers.etag).not.toBe(etag);
    expect((await send(etag)).status).toBe(412); // the old ETag is stale now

    // The ETag covers the settings only, not the revisions in the same body: a conditional GET
    // must never come back 304 (the browser would keep showing the endpoint as before a deploy).
    const fresh = await ada.agent.get(url).set('if-none-match', ok.headers.etag as string);
    expect(fresh.status).toBe(200);
    expect(fresh.headers['cache-control']).toBe('no-store');
    expect((fresh.body as { captureInputs: boolean }).captureInputs).toBe(true);
  });

  it('retention deletes records and captured inputs older than 7 days', async () => {
    const before = await prismaOf(app).predictionRecord.count({ where: { orgId: ada.orgId } });
    expect(before).toBeGreaterThan(0);
    const r = await consumer().purge(Date.now() + 8 * 86_400_000, ada.orgId);
    expect(r.records).toBe(before);
    expect(r.captureObjects).toBeGreaterThan(0);
    expect(await prismaOf(app).predictionRecord.count({ where: { orgId: ada.orgId } })).toBe(0);
  }, 60_000);
});

describe('evaluation gate and the champion alias (FR-32)', () => {
  it('first champion: gate on the absolute floor, then promote', async () => {
    const res = await evaluate(sklearnVersionId);
    expect(res.status, res.text).toBe(201);
    const ev = res.body as Evaluation;
    expect(ev).toMatchObject({
      status: 'COMPLETED',
      passed: true,
      baseline: null,
      canPromote: true,
    });
    expect(ev.metrics.candidate.rocAuc).toBeGreaterThan(0.7);

    const crowned = await ada.post(`/orgs/${ada.orgId}/models/${modelId}/champion`, {
      evaluationId: ev.id,
    });
    expect(crowned.status, crowned.text).toBe(200);
    const model = (await ada.get(`/orgs/${ada.orgId}/models/${modelId}`)).body as {
      championVersionId: string;
    };
    expect(model.championVersionId).toBe(sklearnVersionId);
  }, 120_000);

  it('a failed gate cannot crown a version, through the API or by writing to the database', async () => {
    // The PyTorch fixture (5 epochs on 1,500 rows) is genuinely weaker than the sklearn champion.
    const weak = await validatedVersion(pytorch);
    const ev = (await evaluate(weak)).body as Evaluation;
    expect(ev.status).toBe('COMPLETED');
    expect(ev.passed).toBe(false);
    expect(ev.baseline?.id).toBe(sklearnVersionId); // compared against the current champion
    expect(ev.metrics.candidate.rocAuc).toBeLessThan(ev.metrics.baseline?.rocAuc ?? 0);
    expect(ev.checks.find((c) => c.rule === 'maxRocAucDrop')?.passed).toBe(false);

    const refused = await ada.post(`/orgs/${ada.orgId}/models/${modelId}/champion`, {
      evaluationId: ev.id,
    });
    expect(refused.status).toBe(422);
    expect((refused.body as Problem).code).toBe('EVALUATION_NOT_PASSED');
    await expect(
      prismaOf(app).registeredModel.update({
        where: { id: modelId },
        data: { championVersionId: weak, championEvaluationId: ev.id },
      }),
    ).rejects.toThrow(/did not pass/);
    // Reports are evidence: append-only.
    await expect(
      prismaOf(app).evaluationReport.update({ where: { id: ev.id }, data: { passed: true } }),
    ).rejects.toThrow(/append-only/);
  }, 240_000);

  it('only Owners/Admins crown; an evaluation against an older champion is stale', async () => {
    // Two candidates that are as good as the champion (same weights, new versions).
    const c1 = await validatedVersion(sklearn);
    const c2 = await validatedVersion(sklearn);
    const e1 = (await evaluate(c1)).body as Evaluation;
    const e2 = (await evaluate(c2)).body as Evaluation;
    expect([e1.passed, e2.passed]).toEqual([true, true]);
    expect(e1.canPromote && e2.canPromote).toBe(true);

    expect(
      (await viewer.post(`/orgs/${ada.orgId}/models/${modelId}/champion`, { evaluationId: e1.id }))
        .status,
    ).toBe(403);
    expect(
      (await ada.post(`/orgs/${ada.orgId}/models/${modelId}/champion`, { evaluationId: e1.id }))
        .status,
    ).toBe(200);

    // e2 compared c2 against the PREVIOUS champion: it no longer says anything about c2 vs c1.
    const stale = await ada.post(`/orgs/${ada.orgId}/models/${modelId}/champion`, {
      evaluationId: e2.id,
    });
    expect(stale.status).toBe(409);
    expect((stale.body as Problem).code).toBe('EVALUATION_STALE');
    await expect(
      prismaOf(app).registeredModel.update({
        where: { id: modelId },
        data: { championVersionId: c2, championEvaluationId: e2.id },
      }),
    ).rejects.toThrow(/current champion/);
    const reports = (await ada.get(`/orgs/${ada.orgId}/models/${modelId}/evaluations`))
      .body as Evaluation[];
    expect(reports.find((r) => r.id === e2.id)?.canPromote).toBe(false);
    const model = (await ada.get(`/orgs/${ada.orgId}/models/${modelId}`)).body as {
      championVersionId: string;
    };
    expect(model.championVersionId).toBe(c1);
  }, 240_000);
});

import type { NestExpressApplication } from '@nestjs/platform-express';
import type { TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { DeployProcessor } from '../../src/modules/deployments/deploy.processor';
import { OutboxRelay } from '../../src/modules/deployments/outbox.relay';
import { ValidationService } from '../../src/modules/validation/validation.service';
import { loadBundle, uniqueGolden, uniqueModel } from './bundles';
import { API, Client, createTestApp, createTestWorker } from './helpers';

/**
 * M10 acceptance: one prediction is one trace, gateway -> model server. The test gateway and the
 * model servers export OTLP to the collector of the `obs` profile, which stores traces in Tempo;
 * this test reads the trace back from Tempo's API by the X-Trace-Id the gateway returned.
 */
const TEMPO = `http://127.0.0.1:${process.env.MO_PORT_TEMPO ?? '13200'}`;

interface OtlpSpan {
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number | string;
}
interface OtlpBatch {
  resource: { attributes: { key: string; value: { stringValue?: string } }[] };
  scopeSpans: { spans: OtlpSpan[] }[];
}

/** Tempo returns OTLP JSON; ids may be base64 (protobuf JSON) or hex. Normalise to hex. */
const hex = (id: string | undefined) =>
  !id ? '' : /^[0-9a-f]+$/i.test(id) ? id.toLowerCase() : Buffer.from(id, 'base64').toString('hex');

let app: NestExpressApplication;
let worker: TestingModule;
let ada: Client;
let slug: string;
let apiKey: string;
const sklearn = loadBundle('sklearn');

beforeAll(async () => {
  const ready = await fetch(`${TEMPO}/ready`).then(
    (r) => r.ok,
    () => false,
  );
  if (!ready) throw new Error(`Tempo is not reachable at ${TEMPO}: run \`pnpm dev:obs\` first`);
  app = await createTestApp();
  worker = await createTestWorker();
  ada = await Client.register(app, { name: 'Ada' });
  const projectId = (
    (await ada.post(`/orgs/${ada.orgId}/projects`, { name: 'Traced' })).body as { id: string }
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
  const ep = (
    await ada.post(`/orgs/${ada.orgId}/projects/${projectId}/endpoints`, { name: 'Traced churn' })
  ).body as { id: string; slug: string };
  slug = ep.slug;
  const dep = await ada.agent
    .post(`${API}/orgs/${ada.orgId}/endpoints/${ep.id}/revisions`)
    .set('x-csrf-token', ada.session.csrfToken)
    .set('idempotency-key', crypto.randomUUID())
    .send({ modelVersionId: versionId });
  await worker.get(OutboxRelay).runOnce();
  await worker
    .get(DeployProcessor)
    .process((dep.body as { id: string }).id, { isFinalAttempt: true });
  apiKey = (
    (await ada.post(`/orgs/${ada.orgId}/projects/${projectId}/api-keys`, { name: 'tracing' }))
      .body as {
      key: string;
    }
  ).key;
}, 240_000);
afterAll(async () => {
  await worker.close();
  await app.close();
});

describe('distributed tracing (M10)', () => {
  it('a prediction is one trace: gateway span -> model-server span, linked by traceparent', async () => {
    const golden = (JSON.parse(sklearn.golden.toString('utf8')) as { inputs: number[][] }).inputs;
    const features =
      (JSON.parse(sklearn.signature.toString('utf8')) as { inputs: { features: string[] }[] })
        .inputs[0]?.features ?? [];
    const row = Object.fromEntries(features.map((f, i) => [f, golden[0]?.[i] ?? 0]));
    let res: Response | undefined;
    for (let i = 0; i < 40; i++) {
      res = await fetch(`${inject('gatewayUrl')}/v1/endpoints/${slug}/predict`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ inputs: [row] }),
      });
      if (res.status === 200) break;
      await new Promise((r) => setTimeout(r, 250)); // routing snapshot propagating
    }
    expect(res?.status).toBe(200);
    const traceId = res?.headers.get('x-trace-id') ?? '';
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);

    // Spans are batched (gateway 5 s, model server 5 s) and then flushed by the collector.
    let batches: OtlpBatch[] = [];
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const r = await fetch(`${TEMPO}/api/traces/${traceId}`, {
        headers: { accept: 'application/json' },
      });
      if (r.ok) {
        batches = ((await r.json()) as { batches?: OtlpBatch[] }).batches ?? [];
        const services = new Set(batches.map((b) => serviceOf(b)));
        if (services.has('modelops-gateway') && services.has('modelops-model-server')) break;
      }
      await new Promise((r2) => setTimeout(r2, 1000));
    }
    const spans = batches.flatMap((b) =>
      b.scopeSpans.flatMap((s) => s.spans.map((sp) => ({ ...sp, service: serviceOf(b) }))),
    );
    const server = spans.find((s) => s.name === 'POST /v1/endpoints/:slug/predict');
    const client = spans.find((s) => s.name === 'model-server POST /v1/predict');
    // The model server's SERVER span (FastAPI); its ASGI internals are children of it.
    const model = spans.find(
      (s) =>
        s.service === 'modelops-model-server' && (s.kind === 2 || s.kind === 'SPAN_KIND_SERVER'),
    );
    console.info(`[trace] ${traceId}: ${spans.map((s) => `${s.service}:${s.name}`).join(' | ')}`);
    expect(server?.service).toBe('modelops-gateway');
    expect(hex(client?.parentSpanId)).toBe(hex(server?.spanId));
    expect(model, 'the model server joined the trace').toBeDefined();
    expect(hex(model?.parentSpanId)).toBe(hex(client?.spanId));
  }, 120_000);
});

function serviceOf(b: OtlpBatch): string {
  return b.resource.attributes.find((a) => a.key === 'service.name')?.value.stringValue ?? '?';
}

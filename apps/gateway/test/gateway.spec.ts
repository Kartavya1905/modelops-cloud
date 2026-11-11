import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildAdminApp, buildPublicApp, createMetrics } from '../src/app.js';
import { loadConfig, modelServerUrl } from '../src/config.js';
import type { ApiKeyEntry, RoutingSnapshot } from '../src/contract.js';
import { CircuitBreaker, RateLimiter, toMatrix } from '../src/guards.js';
import { KeyVerifier } from '../src/keys.js';
import { RoutingTable } from '../src/routing.js';
import { bucketOf, fnv1a32, pickRevision } from '../src/split.js';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace';

const PEPPER = 'p'.repeat(40);
const TOKEN = 't'.repeat(40);
const config = loadConfig({
  REDIS_URL: 'redis://localhost:6379',
  MO_API_KEY_PEPPER: PEPPER,
  MO_GATEWAY_INTERNAL_TOKEN: TOKEN,
});
const FEATURES = ['a', 'b', 'c'];
const REV = '11111111-2222-3333-4444-555555555555';
const CANARY = '99999999-8888-7777-6666-555555555555';
const revisionOf = (id: string, modelVersion: number) => ({
  id,
  url: `http://mo-rev-${id}:8000`,
  modelVersionId: `mv-${String(modelVersion)}`,
  modelName: 'Churn',
  modelVersion,
  framework: 'PYTORCH_ONNX',
  features: FEATURES,
  classes: [0, 1],
});
const PROJECT = 'project-1';

function makeKey(projectId = PROJECT, overrides: Partial<ApiKeyEntry> = {}) {
  const prefix = 'ABCDEFGH23'
    .split('')
    .sort(() => Math.random() - 0.5)
    .join('');
  const secret = randomBytes(32).toString('base64url');
  const entry: ApiKeyEntry = {
    id: `key-${prefix}`,
    orgId: 'org-1',
    projectId,
    hash: createHmac('sha256', PEPPER).update(secret).digest('hex'),
    scopes: ['predict', 'feedback'],
    expiresAt: null,
    revoked: false,
    ...overrides,
  };
  return { prefix, token: `mo_${prefix}_${secret}`, entry };
}

const snapshot = (
  revision: boolean,
  rateLimitRps = 3,
  captureInputs = false,
  canaryWeight = 0,
): RoutingSnapshot => ({
  hash: revision ? 'h1' : 'h0',
  generatedAt: new Date().toISOString(),
  endpoints: {
    [`${PROJECT}/churn`]: {
      endpointId: 'ep-1',
      orgId: 'org-1',
      projectId: PROJECT,
      slug: 'churn',
      rateLimitRps,
      captureInputs,
      revision: revision
        ? {
            id: REV,
            url: `http://mo-rev-${REV}:8000`,
            modelVersionId: 'mv-1',
            modelName: 'Churn',
            modelVersion: 4,
            framework: 'PYTORCH_ONNX',
            features: FEATURES,
            classes: [0, 1],
          }
        : null,
      canary: canaryWeight > 0 ? { revision: revisionOf(CANARY, 5), weight: canaryWeight } : null,
    },
  },
});

async function setup(
  opts: {
    revision?: boolean;
    upstream?: typeof fetch;
    rateLimitRps?: number;
    capture?: boolean;
    sinkFails?: boolean;
    canaryWeight?: number;
  } = {},
) {
  const store = new Map<string, ApiKeyEntry>();
  const keys = new KeyVerifier(
    { getEntry: (p) => Promise.resolve(store.get(p) ?? null) },
    PEPPER,
    30_000,
  );
  const routing = new RoutingTable({
    load: () =>
      Promise.resolve(
        snapshot(opts.revision ?? true, opts.rateLimitRps, opts.capture, opts.canaryWeight),
      ),
  });
  await routing.refresh();
  const counts = new Map<string, number>();
  // A frozen clock: every request in a test falls into the same one-second window.
  const limiter = new RateLimiter(
    {
      incr: (k) => {
        counts.set(k, (counts.get(k) ?? 0) + 1);
        return Promise.resolve(counts.get(k) ?? 0);
      },
    },
    () => undefined,
    () => 1_700_000_000_000,
  );
  const calls: { url: string; body: unknown; headers?: Record<string, string> }[] = [];
  const upstream =
    opts.upstream ??
    ((url: string, init?: RequestInit) => {
      if (typeof init?.body !== 'string') {
        return Promise.resolve(new Response(JSON.stringify({ status: 'ready' })));
      }
      const body = JSON.parse(init.body) as { inputs: number[][] };
      calls.push({ url, body, headers: init.headers as Record<string, string> });
      const res = new Response(
        JSON.stringify({
          outputs: {
            label: body.inputs.map(() => 1),
            probabilities: body.inputs.map(() => [0.25, 0.75]),
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
      return Promise.resolve(res);
    });
  const events: Record<string, string>[] = [];
  const sink = {
    publish: (batch: Record<string, string>[]) => {
      if (opts.sinkFails) return Promise.reject(new Error('redis down'));
      events.push(...batch);
      return Promise.resolve();
    },
  };
  const deps = {
    config,
    routing,
    keys,
    limiter,
    fetchFn: upstream as unknown as typeof fetch,
    events: sink,
  };
  const metrics = createMetrics();
  return {
    events,
    app: buildPublicApp(deps, metrics),
    admin: buildAdminApp(deps, metrics),
    store,
    keys,
    calls,
    metrics,
  };
}

const row = { a: 1, b: 2.5, c: -3 };

describe('predict', () => {
  it('authenticates, validates, forwards ordered rows and shapes the response', async () => {
    const { app, store, calls } = await setup();
    const k = makeKey();
    store.set(k.prefix, k.entry);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/endpoints/churn/predict',
      headers: { authorization: `Bearer ${k.token}`, 'x-request-id': 'req-12345678' },
      payload: { inputs: [{ c: -3, a: 1, b: 2.5 }] },
    });
    expect(res.statusCode).toBe(200);
    expect(calls[0]).toMatchObject({
      url: `http://mo-rev-${REV}:8000/v1/predict`,
      body: { inputs: [[1, 2.5, -3]] },
    });
    const body = res.json<{
      outputs: unknown[];
      model: unknown;
      revisionId: string;
      predictionIds: string[];
    }>();
    expect(body.outputs).toEqual([{ label: 1, probabilities: { '0': 0.25, '1': 0.75 } }]);
    expect(body.model).toEqual({ name: 'Churn', version: 4, framework: 'PYTORCH_ONNX' });
    expect(body.predictionIds).toHaveLength(1);
    expect(res.headers['x-model-version']).toBe('4');
    expect(res.headers['x-revision-id']).toBe(REV);
    expect(res.headers['x-request-id']).toBe('req-12345678');
  });

  it.each([
    ['no header', undefined],
    ['not a key', 'Bearer hello'],
    ['wrong secret', 'Bearer mo_ABCDEFGH23_' + 'x'.repeat(43)],
  ])('401 for %s', async (_n, auth) => {
    const { app, store } = await setup();
    const k = makeKey();
    store.set('ABCDEFGH23', k.entry);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/endpoints/churn/predict',
      headers: auth ? { authorization: auth } : {},
      payload: { inputs: [row] },
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json<{ code: string }>().code).toBe('INVALID_API_KEY');
  });

  it('a revoked or expired key is refused', async () => {
    const { app, store, keys } = await setup();
    const k = makeKey();
    store.set(k.prefix, k.entry);
    const send = () =>
      app.inject({
        method: 'POST',
        url: '/v1/endpoints/churn/predict',
        headers: { authorization: `Bearer ${k.token}` },
        payload: { inputs: [row] },
      });
    expect((await send()).statusCode).toBe(200);
    store.set(k.prefix, { ...k.entry, revoked: true });
    expect((await send()).statusCode).toBe(200); // still cached...
    keys.evict(k.prefix); // ...until the revocation message arrives
    expect((await send()).statusCode).toBe(401);

    const e = makeKey(PROJECT, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    store.set(e.prefix, e.entry);
    const expired = await app.inject({
      method: 'POST',
      url: '/v1/endpoints/churn/predict',
      headers: { authorization: `Bearer ${e.token}` },
      payload: { inputs: [row] },
    });
    expect(expired.statusCode).toBe(401);
  });

  it("another project's key sees 404 (SEC-11); no ready revision is 503", async () => {
    const { app, store } = await setup();
    const other = makeKey('project-2');
    store.set(other.prefix, other.entry);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/endpoints/churn/predict',
      headers: { authorization: `Bearer ${other.token}` },
      payload: { inputs: [row] },
    });
    expect(res.statusCode).toBe(404);

    const idle = await setup({ revision: false });
    const k = makeKey();
    idle.store.set(k.prefix, k.entry);
    const r = await idle.app.inject({
      method: 'POST',
      url: '/v1/endpoints/churn/predict',
      headers: { authorization: `Bearer ${k.token}` },
      payload: { inputs: [row] },
    });
    expect(r.statusCode).toBe(503);
    expect(r.json<{ code: string }>().code).toBe('NO_READY_REVISION');
  });

  it('rejects bad inputs before the model sees them (SEC-13)', async () => {
    const { app, store, calls } = await setup({ rateLimitRps: 100 });
    const k = makeKey();
    store.set(k.prefix, k.entry);
    const send = (payload: string) =>
      app.inject({
        method: 'POST',
        url: '/v1/endpoints/churn/predict',
        headers: { authorization: `Bearer ${k.token}`, 'content-type': 'application/json' },
        payload,
      });
    for (const bad of [
      JSON.stringify({ inputs: [{ a: 1, b: 2 }] }), // missing c
      JSON.stringify({ inputs: [{ ...row, z: 1 }] }), // unknown
      JSON.stringify({ inputs: [{ ...row, a: '1' }] }), // type
      JSON.stringify({ inputs: Array.from({ length: 65 }, () => row) }), // batch
      '{"inputs": [{"a": 1, "b": 2, "c": ',
    ]) {
      expect((await send(bad)).statusCode).toBe(400);
    }
    const huge = await send(JSON.stringify({ inputs: [row], pad: 'x'.repeat(300_000) }));
    expect(huge.statusCode).toBe(413);
    expect(calls).toHaveLength(0);
  });

  it('rate limits per key per second with Retry-After', async () => {
    const { app, store } = await setup();
    const k = makeKey();
    store.set(k.prefix, k.entry);
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/endpoints/churn/predict',
        headers: { authorization: `Bearer ${k.token}` },
        payload: { inputs: [row] },
      });
      codes.push(res.statusCode);
      if (res.statusCode === 429) expect(res.headers['retry-after']).toBe('1');
    }
    expect(codes).toEqual([200, 200, 200, 429, 429]); // limit 3 rps, same second
  });

  it('times out slow model servers (504) and opens the circuit after repeated failures', async () => {
    const slow = (async (_u: unknown, init?: RequestInit) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener('abort', () =>
          rej(Object.assign(new Error('t'), { name: 'TimeoutError' })),
        );
      })) as typeof fetch;
    const s = await setup({ upstream: slow });
    const k = makeKey();
    s.store.set(k.prefix, k.entry);
    const routing = new RoutingTable({ load: () => Promise.resolve(snapshot(true)) });
    await routing.refresh();
    const app2 = buildPublicApp({
      config: { ...config, upstreamTimeoutMs: 50 },
      routing,
      keys: s.keys,
      limiter: new RateLimiter({ incr: () => Promise.resolve(1) }),
      fetchFn: slow,
      breaker: new CircuitBreaker(2, 60_000),
    });
    const send = () =>
      app2.inject({
        method: 'POST',
        url: '/v1/endpoints/churn/predict',
        headers: { authorization: `Bearer ${k.token}` },
        payload: { inputs: [row] },
      });
    expect((await send()).statusCode).toBe(504);
    expect((await send()).statusCode).toBe(504);
    const open = await send();
    expect(open.statusCode).toBe(503); // fails fast, no upstream call
  });
});

describe('admin API', () => {
  it('requires the internal token and only reaches mo-rev-<uuid> hosts', async () => {
    const { admin } = await setup();
    expect((await admin.inject({ url: `/internal/revisions/${REV}/readyz` })).statusCode).toBe(401);
    const ok = await admin.inject({
      url: `/internal/revisions/${REV}/readyz`,
      headers: { 'x-modelops-token': TOKEN },
    });
    expect(ok.statusCode).toBe(200);
    const bad = await admin.inject({
      url: '/internal/revisions/evil.example.com/readyz',
      headers: { 'x-modelops-token': TOKEN },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('exposes Prometheus metrics labelled by model version', async () => {
    const { app, admin, store } = await setup();
    const k = makeKey();
    store.set(k.prefix, k.entry);
    await app.inject({
      method: 'POST',
      url: '/v1/endpoints/churn/predict',
      headers: { authorization: `Bearer ${k.token}` },
      payload: { inputs: [row] },
    });
    const text = (await admin.inject({ url: '/metrics' })).body;
    const line = text.split('\n').find((l) => l.startsWith('gateway_requests_total{'));
    for (const label of [
      'endpoint_id="ep-1"',
      'endpoint="churn"',
      `revision="${REV}"`,
      'model_version="4"',
      'code="200"',
      'source="api"',
    ]) {
      expect(line).toContain(label);
    }
    expect(line?.endsWith(' 1')).toBe(true);
  });

  it('playground route: token + user id required, same pipeline, own source label and limit', async () => {
    const { admin, calls } = await setup({ rateLimitRps: 100 });
    const user = '99999999-8888-7777-6666-555555555555';
    const send = (headers: Record<string, string>, payload: object = { inputs: [row] }) =>
      admin.inject({ method: 'POST', url: '/internal/endpoints/ep-1/predict', headers, payload });

    expect((await send({ 'x-playground-actor': user })).statusCode).toBe(401); // no token
    expect((await send({ 'x-modelops-token': TOKEN })).statusCode).toBe(400); // no actor
    const unknown = await admin.inject({
      method: 'POST',
      url: '/internal/endpoints/nope/predict',
      headers: { 'x-modelops-token': TOKEN, 'x-playground-actor': user },
      payload: { inputs: [row] },
    });
    expect(unknown.statusCode).toBe(404);

    const auth = { 'x-modelops-token': TOKEN, 'x-playground-actor': user };
    const ok = await send(auth);
    expect(ok.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    expect((await send(auth, { inputs: [{ a: 1 }] })).statusCode).toBe(400); // signature checked

    // At most 5 per second per user, whatever the endpoint allows (100 here). Two calls above
    // count too (the 200 and the 400), so 3 more pass, then 429.
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await send(auth)).statusCode);
    expect(codes).toEqual([200, 200, 200, 429, 429]);

    const text = (await admin.inject({ url: '/metrics' })).body;
    const playground = text
      .split('\n')
      .filter((l) => l.startsWith('gateway_requests_total{') && l.includes('source="playground"'));
    expect(playground.find((l) => l.includes('code="200"'))).toMatch(/ 4$/);
    expect(playground.find((l) => l.includes('code="429"'))).toMatch(/ 2$/);
  });
});

describe('toMatrix', () => {
  it('orders by signature and reports every problem', () => {
    expect(toMatrix({ inputs: [{ b: 2, a: 1, c: 3 }] }, FEATURES, 64)).toEqual({
      rows: [[1, 2, 3]],
    });
    const r = toMatrix({ inputs: [{ a: 1, c: Number.NaN, x: 1 }] }, FEATURES, 64);
    expect('errors' in r && r.errors.map((e) => e.field)).toEqual([
      'inputs[0].x',
      'inputs[0].b',
      'inputs[0].c',
    ]);
  });
});

describe('M7 events and feedback', () => {
  const send = (
    app: Awaited<ReturnType<typeof setup>>['app'],
    token: string,
    url: string,
    payload: object,
  ) => app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${token}` }, payload });

  it('records one prediction event per row; inputs only when capture is on', async () => {
    const off = await setup({ rateLimitRps: 100 });
    const k = makeKey();
    off.store.set(k.prefix, k.entry);
    const res = await send(off.app, k.token, '/v1/endpoints/churn/predict', { inputs: [row, row] });
    const ids = res.json<{ predictionIds: string[] }>().predictionIds;
    await new Promise((r) => setImmediate(r));
    expect(off.events.map((e) => e.id)).toEqual(ids);
    expect(off.events[0]).toMatchObject({
      type: 'prediction',
      endpoint: 'ep-1',
      org: 'org-1',
      revision: REV,
      modelVersion: 'mv-1',
      label: '1',
      score: '0.75',
    });
    expect(off.events[0]).not.toHaveProperty('inputs');

    const on = await setup({ rateLimitRps: 100, capture: true });
    on.store.set(k.prefix, k.entry);
    await send(on.app, k.token, '/v1/endpoints/churn/predict', { inputs: [{ c: 3, b: 2, a: 1 }] });
    await new Promise((r) => setImmediate(r));
    expect(JSON.parse(on.events[0]?.inputs ?? '')).toEqual([1, 2, 3]); // signature order
  });

  it('a failing stream never fails the prediction (counted instead)', async () => {
    const s = await setup({ rateLimitRps: 100, sinkFails: true });
    const k = makeKey();
    s.store.set(k.prefix, k.entry);
    const res = await send(s.app, k.token, '/v1/endpoints/churn/predict', { inputs: [row] });
    expect(res.statusCode).toBe(200);
    await new Promise((r) => setImmediate(r));
    expect((await s.admin.inject({ url: '/metrics' })).body).toContain(
      'gateway_events_dropped_total 1',
    );
  });

  it('playground calls are not production predictions', async () => {
    const s = await setup({ rateLimitRps: 100 });
    await s.admin.inject({
      method: 'POST',
      url: '/internal/endpoints/ep-1/predict',
      headers: {
        'x-modelops-token': TOKEN,
        'x-playground-actor': '99999999-8888-7777-6666-555555555555',
      },
      payload: { inputs: [row] },
    });
    await new Promise((r) => setImmediate(r));
    expect(s.events).toEqual([]);
  });

  it('feedback: 202 with events; labels must be classes; scope and project are enforced', async () => {
    const s = await setup({ rateLimitRps: 100 });
    const k = makeKey();
    s.store.set(k.prefix, k.entry);
    const id = '0b9f6c1e-5d2a-4f7b-9c3d-2e1f0a9b8c7d';
    const ok = await send(s.app, k.token, '/v1/endpoints/churn/feedback', {
      items: [{ predictionId: id, label: 1 }],
    });
    expect(ok.statusCode).toBe(202);
    expect(ok.json()).toEqual({ accepted: 1 });
    expect(s.events).toEqual([
      expect.objectContaining({ type: 'feedback', id, endpoint: 'ep-1', label: '1' }),
    ]);

    for (const bad of [
      { items: [] },
      { items: [{ predictionId: 'nope', label: 1 }] },
      { items: [{ predictionId: id, label: 7 }] },
    ]) {
      expect((await send(s.app, k.token, '/v1/endpoints/churn/feedback', bad)).statusCode).toBe(
        400,
      );
    }
    const predictOnly = makeKey(PROJECT, { scopes: ['predict'] });
    s.store.set(predictOnly.prefix, predictOnly.entry);
    expect(
      (
        await send(s.app, predictOnly.token, '/v1/endpoints/churn/feedback', {
          items: [{ predictionId: id, label: 1 }],
        })
      ).statusCode,
    ).toBe(401);
    const other = makeKey('project-2');
    s.store.set(other.prefix, other.entry);
    expect(
      (
        await send(s.app, other.token, '/v1/endpoints/churn/feedback', {
          items: [{ predictionId: id, label: 1 }],
        })
      ).statusCode,
    ).toBe(404);

    const down = await setup({ sinkFails: true });
    down.store.set(k.prefix, k.entry);
    expect(
      (
        await send(down.app, k.token, '/v1/endpoints/churn/feedback', {
          items: [{ predictionId: id, label: 0 }],
        })
      ).statusCode,
    ).toBe(503);
  });
});

describe('M8 canary routing', () => {
  const endpoint = (weight: number) => {
    const e = snapshot(true, 3, false, weight).endpoints[`${PROJECT}/churn`];
    if (!e) throw new Error('fixture endpoint missing');
    return e;
  };

  it('FNV-1a matches the reference vectors', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
    expect(fnv1a32('foobar')).toBe(0xbf9cf968);
  });

  it('10 000 requests at 10% send 10% ± 1.5% to the canary', () => {
    let canary = 0;
    for (let i = 0; i < 10_000; i++) {
      if (pickRevision(endpoint(10), randomBytes(16).toString('hex'))?.role === 'canary') canary++;
    }
    expect(canary / 10_000).toBeGreaterThanOrEqual(0.085);
    expect(canary / 10_000).toBeLessThanOrEqual(0.115);
  });

  it('a routing key is sticky; without a canary everything is stable', () => {
    for (const key of ['customer-1', 'customer-2', 'customer-3', 'customer-42']) {
      const first = pickRevision(endpoint(30), key)?.role;
      for (let i = 0; i < 50; i++) expect(pickRevision(endpoint(30), key)?.role).toBe(first);
      expect(pickRevision(endpoint(30), key)?.role).toBe(bucketOf(key) < 30 ? 'canary' : 'stable');
    }
    expect(pickRevision(endpoint(0), 'anything')?.role).toBe('stable');
  });

  // Keys whose bucket is below 20 (canary) and above (stable), found deterministically.
  const keysIn = (canary: boolean, n: number) => {
    const out: string[] = [];
    for (let i = 0; out.length < n; i++) {
      if (bucketOf(`k-${String(i)}`) < 20 === canary) out.push(`k-${String(i)}`);
    }
    return out;
  };

  it('routes by X-Routing-Key and says which track answered', async () => {
    const { app, store, calls } = await setup({ canaryWeight: 20, rateLimitRps: 100 });
    const k = makeKey();
    store.set(k.prefix, k.entry);
    const send = (key: string) =>
      app.inject({
        method: 'POST',
        url: '/v1/endpoints/churn/predict',
        headers: { authorization: `Bearer ${k.token}`, 'x-routing-key': key },
        payload: { inputs: [row] },
      });
    const [c = ''] = keysIn(true, 1);
    const [s = ''] = keysIn(false, 1);
    const toCanary = await send(c);
    expect(toCanary.headers['x-traffic-role']).toBe('canary');
    expect(toCanary.headers['x-revision-id']).toBe(CANARY);
    expect(toCanary.json<{ model: { version: number } }>().model.version).toBe(5);
    const toStable = await send(s);
    expect(toStable.headers['x-traffic-role']).toBe('stable');
    expect(calls.map((x) => x.url)).toEqual([
      `http://mo-rev-${CANARY}:8000/v1/predict`,
      `http://mo-rev-${REV}:8000/v1/predict`,
    ]);
  });

  it('a broken canary fails only its own requests, then stable takes them (fallback)', async () => {
    const okBody = JSON.stringify({ outputs: { label: [1], probabilities: [[0.25, 0.75]] } });
    const upstream = (url: string) =>
      Promise.resolve(
        url.includes(CANARY)
          ? new Response('boom', { status: 500 })
          : new Response(okBody, { headers: { 'content-type': 'application/json' } }),
      );
    const { app, store, metrics } = await setup({
      canaryWeight: 20,
      rateLimitRps: 100,
      upstream: upstream as unknown as typeof fetch,
    });
    const k = makeKey();
    store.set(k.prefix, k.entry);
    const send = (key: string) =>
      app.inject({
        method: 'POST',
        url: '/v1/endpoints/churn/predict',
        headers: { authorization: `Bearer ${k.token}`, 'x-routing-key': key },
        payload: { inputs: [row] },
      });
    // The first 5 canary requests reach the broken model (no automatic retry: errors stay honest).
    const canaryKeys = keysIn(true, 8);
    const codes: number[] = [];
    for (const key of canaryKeys) codes.push((await send(key)).statusCode);
    expect(codes).toEqual([502, 502, 502, 502, 502, 200, 200, 200]);
    // Stable requests never saw an error.
    for (const key of keysIn(false, 10)) expect((await send(key)).statusCode).toBe(200);
    const text = await metrics.registry.metrics();
    expect(text).toMatch(
      new RegExp(`gateway_canary_fallback_total\\{[^}]*revision="${CANARY}"[^}]*\\} 3`),
    );
  });
});

describe('M10 tracing', () => {
  it('continues the caller trace into the model server and returns the trace id', async () => {
    const exporter = new InMemorySpanExporter();
    const processor = new SimpleSpanProcessor({ exporter });
    const sdk = new NodeSDK({ spanProcessors: [processor] });
    sdk.start();
    try {
      const { app, store, calls } = await setup();
      const k = makeKey();
      store.set(k.prefix, k.entry);
      const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
      const res = await app.inject({
        method: 'POST',
        url: '/v1/endpoints/churn/predict',
        headers: {
          authorization: `Bearer ${k.token}`,
          traceparent: `00-${traceId}-00f067aa0ba902b7-01`,
        },
        payload: { inputs: [row] },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-trace-id']).toBe(traceId);
      // The model server gets a traceparent of the same trace, from the gateway's client span.
      const sent = calls[0]?.headers?.traceparent ?? '';
      expect(sent).toMatch(new RegExp(`^00-${traceId}-[0-9a-f]{16}-01$`));
      await processor.forceFlush(); // export is asynchronous
      const spans = exporter.getFinishedSpans();
      const server = spans.find((s) => s.name === 'POST /v1/endpoints/:slug/predict');
      const client = spans.find((s) => s.name === 'model-server POST /v1/predict');
      expect(server?.attributes).toMatchObject({ 'modelops.revision_id': REV });
      expect(client?.parentSpanContext?.spanId).toBe(server?.spanContext().spanId);
      expect(sent.split('-')[2]).toBe(client?.spanContext().spanId);
    } finally {
      await sdk.shutdown();
    }
  });
});

describe('M10 model-server addressing', () => {
  const base = {
    REDIS_URL: 'redis://x',
    MO_API_KEY_PEPPER: PEPPER,
    MO_GATEWAY_INTERNAL_TOKEN: TOKEN,
  };
  it('Docker: bare mo-rev-<id> names only', () => {
    const c = loadConfig(base);
    expect(modelServerUrl(c, REV)).toBe(`http://mo-rev-${REV}:8000`);
    expect(c.upstreamPattern.test(`mo-rev-${REV}`)).toBe(true);
    expect(c.upstreamPattern.test(`mo-rev-${REV}.evil.example`)).toBe(false);
  });
  it('Kubernetes: the namespace domain, and nothing else', () => {
    const c = loadConfig({ ...base, MO_MODEL_SERVER_DOMAIN: 'modelops-models.svc.cluster.local' });
    const host = `mo-rev-${REV}.modelops-models.svc.cluster.local`;
    expect(modelServerUrl(c, REV)).toBe(`http://${host}:8000`);
    expect(c.upstreamPattern.test(host)).toBe(true);
    expect(c.upstreamPattern.test(`mo-rev-${REV}`)).toBe(false);
    // dots are literal: no lookalike domains
    expect(c.upstreamPattern.test(`mo-rev-${REV}.modelops-modelsXsvc.cluster.local`)).toBe(false);
    expect(() => loadConfig({ ...base, MO_MODEL_SERVER_DOMAIN: 'evil/../x' })).toThrow();
  });
});

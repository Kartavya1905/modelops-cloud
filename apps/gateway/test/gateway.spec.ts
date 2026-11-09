import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildAdminApp, buildPublicApp, createMetrics } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { ApiKeyEntry, RoutingSnapshot } from '../src/contract.js';
import { CircuitBreaker, RateLimiter, toMatrix } from '../src/guards.js';
import { KeyVerifier } from '../src/keys.js';
import { RoutingTable } from '../src/routing.js';

const PEPPER = 'p'.repeat(40);
const TOKEN = 't'.repeat(40);
const config = loadConfig({
  REDIS_URL: 'redis://localhost:6379',
  MO_API_KEY_PEPPER: PEPPER,
  MO_GATEWAY_INTERNAL_TOKEN: TOKEN,
});
const FEATURES = ['a', 'b', 'c'];
const REV = '11111111-2222-3333-4444-555555555555';
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
    scopes: ['predict'],
    expiresAt: null,
    revoked: false,
    ...overrides,
  };
  return { prefix, token: `mo_${prefix}_${secret}`, entry };
}

const snapshot = (revision: boolean, rateLimitRps = 3): RoutingSnapshot => ({
  hash: revision ? 'h1' : 'h0',
  generatedAt: new Date().toISOString(),
  endpoints: {
    [`${PROJECT}/churn`]: {
      endpointId: 'ep-1',
      orgId: 'org-1',
      projectId: PROJECT,
      slug: 'churn',
      rateLimitRps,
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
    },
  },
});

async function setup(
  opts: { revision?: boolean; upstream?: typeof fetch; rateLimitRps?: number } = {},
) {
  const store = new Map<string, ApiKeyEntry>();
  const keys = new KeyVerifier(
    { getEntry: (p) => Promise.resolve(store.get(p) ?? null) },
    PEPPER,
    30_000,
  );
  const routing = new RoutingTable({
    load: () => Promise.resolve(snapshot(opts.revision ?? true, opts.rateLimitRps)),
  });
  await routing.refresh();
  const counts = new Map<string, number>();
  const limiter = new RateLimiter({
    incr: (k) => {
      counts.set(k, (counts.get(k) ?? 0) + 1);
      return Promise.resolve(counts.get(k) ?? 0);
    },
  });
  const calls: { url: string; body: unknown }[] = [];
  const upstream =
    opts.upstream ??
    ((url: string, init?: RequestInit) => {
      if (typeof init?.body !== 'string') {
        return Promise.resolve(new Response(JSON.stringify({ status: 'ready' })));
      }
      const body = JSON.parse(init.body) as { inputs: number[][] };
      calls.push({ url, body });
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
  const deps = { config, routing, keys, limiter, fetchFn: upstream as unknown as typeof fetch };
  const metrics = createMetrics();
  return {
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
    expect(calls[0]).toEqual({
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
    // limit is 3 rps; a second boundary in the middle can only allow more, never fewer
    expect(codes.filter((c) => c === 200).length).toBeGreaterThanOrEqual(3);
    expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(1);
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
    expect(text).toContain(
      `gateway_requests_total{endpoint="churn",revision="${REV}",model_version="4",code="200"} 1`,
    );
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

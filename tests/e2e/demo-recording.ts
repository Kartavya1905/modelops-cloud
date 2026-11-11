// M12: records the README demo (docs/images/demo.gif) from the running dev platform.
//   pnpm --filter @modelops/e2e demo:record && node scripts/make-gif.mjs   (-> docs/images/demo.gif)
//
// 1. Setup, not recorded: a fresh account, two validated versions, an endpoint serving version 1
//    with version 2 as a 20 % canary, an API key, and live traffic through the gateway.
// 2. Recording: overview -> validation checklist -> endpoint (revisions, canary split, analysis)
//    -> playground prediction -> live dashboard -> audit log integrity check.
// A throwaway account; nothing here is a real credential.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type APIRequestContext, chromium, type Page } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3300';
const GATEWAY = process.env.GATEWAY_URL ?? 'http://127.0.0.1:18088';
const API = `${BASE}/api/v1`;
const BUNDLES = join(import.meta.dirname, '..', 'fixtures', 'bundles');
const VIDEO_DIR = join(import.meta.dirname, 'test-results', 'demo-video');
const OUT = join(VIDEO_DIR, 'demo.webm'); // not committed; scripts/make-gif.mjs makes the GIF
const VIEWPORT = { width: 1280, height: 800 };

let csrf = '';
async function call<T>(req: APIRequestContext, method: string, path: string, data?: unknown) {
  const res = await req.fetch(`${API}${path}`, {
    method,
    headers: { 'x-csrf-token': csrf, 'idempotency-key': randomUUID() },
    ...(data instanceof Object && 'multipart' in data ? (data as object) : data ? { data } : {}),
  });
  if (!res.ok()) throw new Error(`${method} ${path}: ${String(res.status())} ${await res.text()}`);
  return (await res.json()) as T;
}
async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms: number): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v) || Date.now() > deadline) return v;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function setup(req: APIRequestContext) {
  const session = await call<{ csrfToken: string; memberships: { orgId: string }[] }>(
    req,
    'POST',
    '/auth/register',
    {
      email: `demo-${randomUUID().slice(0, 8)}@example.com`,
      name: 'Ada Demo',
      password: `demo ${randomUUID()}`,
    },
  );
  csrf = session.csrfToken;
  const org = session.memberships[0]?.orgId ?? '';
  const project = await call<{ id: string }>(req, 'POST', `/orgs/${org}/projects`, {
    name: 'Customer churn',
  });
  const model = await call<{ id: string }>(
    req,
    'POST',
    `/orgs/${org}/projects/${project.id}/models`,
    {
      name: 'Churn classifier',
    },
  );
  const versions: string[] = [];
  for (const [kind, framework] of [
    ['sklearn', 'SKLEARN_ONNX'],
    ['pytorch', 'PYTORCH_ONNX'],
  ] as const) {
    const file = (f: string) => ({
      name: f,
      mimeType: 'application/octet-stream',
      buffer: readFileSync(join(BUNDLES, kind, f)),
    });
    const v = await call<{ id: string }>(
      req,
      'POST',
      `/orgs/${org}/models/${model.id}/versions/upload`,
      {
        multipart: {
          framework,
          model: file('model.onnx'),
          signature: file('signature.json'),
          golden: file('golden_examples.json'),
        },
      },
    );
    await until(
      () => call<{ status: string }>(req, 'GET', `/orgs/${org}/model-versions/${v.id}`),
      (x) => x.status === 'VALIDATED',
      180_000,
    );
    versions.push(v.id);
  }
  const ep = await call<{ id: string; slug: string }>(
    req,
    'POST',
    `/orgs/${org}/projects/${project.id}/endpoints`,
    { name: 'Churn API' },
  );
  const deploy = async (versionId: string, extra: object) => {
    const rev = await call<{ id: string }>(
      req,
      'POST',
      `/orgs/${org}/endpoints/${ep.id}/revisions`,
      {
        modelVersionId: versionId,
        ...extra,
      },
    );
    await until(
      () => call<{ state: string }>(req, 'GET', `/orgs/${org}/revisions/${rev.id}`),
      (r) => r.state === 'READY',
      240_000,
    );
  };
  await deploy(versions[0] ?? '', {});
  const { key } = await call<{ key: string }>(
    req,
    'POST',
    `/orgs/${org}/projects/${project.id}/api-keys`,
    {
      name: 'demo traffic',
    },
  );
  await deploy(versions[1] ?? '', { strategy: 'CANARY', canaryWeight: 20 });
  return { org, projectId: project.id, versionId: versions[0] ?? '', ep, key };
}

/** Background traffic so the dashboard and the canary panel have something to show. */
function traffic(slug: string, key: string, stop: { done: boolean }) {
  const sig = JSON.parse(readFileSync(join(BUNDLES, 'sklearn', 'signature.json'), 'utf8')) as {
    inputs: { features: string[] }[];
  };
  const golden = JSON.parse(
    readFileSync(join(BUNDLES, 'sklearn', 'golden_examples.json'), 'utf8'),
  ) as {
    inputs: number[][];
  };
  const features = sig.inputs[0]?.features ?? [];
  let i = 0;
  const loop = async () => {
    while (!stop.done) {
      const row = golden.inputs[i++ % golden.inputs.length] ?? [];
      await fetch(`${GATEWAY}/v1/endpoints/${slug}/predict`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ inputs: [Object.fromEntries(features.map((f, j) => [f, row[j]]))] }),
      }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 50)); // ~20 req/s
    }
  };
  return loop();
}

const pause = (page: Page, ms: number) => page.waitForTimeout(ms);

async function main(): Promise<void> {
  const browser = await chromium.launch();
  const setupContext = await browser.newContext({ baseURL: BASE });
  const ctx = await setup(setupContext.request);
  const stop = { done: false };
  const load = traffic(ctx.ep.slug, ctx.key, stop);
  await new Promise((r) => setTimeout(r, 45_000)); // a minute of history for the charts
  const state = await setupContext.storageState();
  await setupContext.close();

  rmSync(VIDEO_DIR, { recursive: true, force: true });
  mkdirSync(VIDEO_DIR, { recursive: true });
  const context = await browser.newContext({
    baseURL: BASE,
    storageState: state,
    viewport: VIEWPORT,
    colorScheme: 'light',
    recordVideo: { dir: VIDEO_DIR, size: VIEWPORT },
  });
  const recordingStarted = Date.now();
  const page = await context.newPage();

  await page.goto(`/orgs/${ctx.org}`);
  await page.getByRole('heading', { name: 'Overview' }).waitFor();
  // The video starts with a blank page while the first one loads: make-gif cuts it off here.
  const firstFrame = (Date.now() - recordingStarted) / 1000;
  await pause(page, 2500);

  await page.goto(`/orgs/${ctx.org}/model-versions/${ctx.versionId}`);
  await page.getByText('Passed all checks').waitFor();
  await pause(page, 3000);

  await page.goto(`/orgs/${ctx.org}/endpoints/${ctx.ep.id}`);
  await page.getByRole('heading', { name: 'Churn API' }).waitFor();
  await pause(page, 2500);
  const canary = page.getByRole('region', { name: 'Canary' });
  await canary.scrollIntoViewIfNeeded();
  await pause(page, 1500);
  await canary.getByRole('button', { name: 'Run check' }).click();
  await pause(page, 3000);

  const playground = page.getByRole('form', { name: 'Playground' });
  await playground.scrollIntoViewIfNeeded();
  await pause(page, 1200);
  await playground.getByRole('button', { name: 'Predict' }).click();
  await page.getByTestId('playground-label').waitFor();
  await pause(page, 2500);

  await page
    .getByRole('img', { name: /requests per second by model version/ })
    .scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: '15m', exact: true }).click(); // a minute of traffic in a 15-minute window
  await pause(page, 4000);

  await page.goto(`/orgs/${ctx.org}/audit`);
  await pause(page, 1500);
  await page.getByRole('button', { name: 'Verify integrity' }).click();
  await page.getByTestId('audit-integrity').waitFor();
  await pause(page, 3000);

  await context.close(); // writes the video
  stop.done = true;
  await load;
  await browser.close();

  const video = readdirSync(VIDEO_DIR).find((f) => f.endsWith('.webm'));
  if (!video) throw new Error('no video recorded');
  renameSync(join(VIDEO_DIR, video), OUT);
  writeFileSync(join(VIDEO_DIR, 'start.txt'), firstFrame.toFixed(2));
  console.log(
    `demo video: tests/e2e/test-results/demo-video/demo.webm, first page at ${firstFrame.toFixed(1)} s (next: node scripts/make-gif.mjs)`,
  );
}

await main();

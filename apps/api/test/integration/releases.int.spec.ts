import type { NestExpressApplication } from '@nestjs/platform-express';
import type { TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { CanaryAnalyzer } from '../../src/modules/deployments/canary-analysis';
import { DeployProcessor } from '../../src/modules/deployments/deploy.processor';
import { OutboxRelay } from '../../src/modules/deployments/outbox.relay';
import { Reconciler } from '../../src/modules/deployments/reconciler';
import { ValidationService } from '../../src/modules/validation/validation.service';
import { type Bundle, loadBundle, uniqueGolden, uniqueModel } from './bundles';
import {
  addMember,
  API,
  Client,
  createTestApp,
  createTestWorker,
  prismaOf,
  type Problem,
} from './helpers';

/**
 * M8 against real infrastructure: canary traffic through the test gateway container, analysis
 * from Prometheus (which scrapes it), promote, fast and slow rollback, and four-eyes approvals.
 * The "deliberately broken canary" is tests/fixtures/bundles/latent-nan: it passes validation,
 * then answers 500 for every input with late_payments = 0.
 */
interface Endpoint {
  id: string;
  slug: string;
  rowVersion: number;
  stableRevision: { id: string; state: string } | null;
  canary: {
    revision: { id: string };
    weight: number;
    eligible: boolean;
    latestCheck: { verdict: string } | null;
  } | null;
  revisions: { id: string; state: string; rollbackOfId: string | null }[];
}
interface Check {
  verdict: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
  aborted: boolean;
  canary: { requests: number; errors: number };
  fallbacks: number;
}
interface Answer {
  status: number;
  revision: string | null;
  role: string | null;
}

let app: NestExpressApplication;
let worker: TestingModule;
let ada: Client; // Owner
let bob: Client; // Admin
let eli: Client; // ML engineer
let vic: Client; // Viewer
let projectId: string;
let modelId: string;
let apiKey: string;
const v: Record<'sklearn' | 'pytorch' | 'broken' | 'other', string> = {
  sklearn: '',
  pytorch: '',
  broken: '',
  other: '',
};
const GATEWAY = () => inject('gatewayUrl');
const sklearn = loadBundle('sklearn');
const golden = (JSON.parse(sklearn.golden.toString('utf8')) as { inputs: number[][] }).inputs;
const features =
  (JSON.parse(sklearn.signature.toString('utf8')) as { inputs: { features: string[] }[] }).inputs[0]
    ?.features ?? [];
const asRow = (r: number[]) => Object.fromEntries(features.map((f, i) => [f, r[i] ?? 0]));
const LATE = features.indexOf('late_payments');

/** The gateway's bucket function (apps/gateway/src/split.ts), to know where a key must go. */
function bucketOf(key: string): number {
  let h = 0x811c9dc5;
  for (const byte of Buffer.from(key, 'utf8')) {
    h ^= byte;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0) % 100;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function eventually<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 30_000) {
  const deadline = Date.now() + ms;
  let last = await fn();
  while (!ok(last) && Date.now() < deadline) {
    await sleep(500);
    last = await fn();
  }
  return last;
}

async function call(slug: string, row: number[], key?: string): Promise<Answer> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${GATEWAY()}/v1/endpoints/${slug}/predict`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        ...(key ? { 'x-routing-key': key } : {}),
      },
      body: JSON.stringify({ inputs: [asRow(row)] }),
    });
    await res.arrayBuffer();
    // 429 is the per-key limit (1000/s here), not part of what these tests measure: retry it.
    if (res.status === 429 && attempt < 50) {
      await sleep(100);
      continue;
    }
    return {
      status: res.status,
      revision: res.headers.get('x-revision-id'),
      role: res.headers.get('x-traffic-role'),
    };
  }
}

/** n requests, `concurrency` at a time; row and routing key chosen per index. */
async function many(
  n: number,
  slug: string,
  opts: { row?: (i: number) => number[]; key?: (i: number) => string; concurrency?: number } = {},
): Promise<Answer[]> {
  const out: Answer[] = new Array<Answer>(n);
  let next = 0;
  const lane = async () => {
    for (let i = next++; i < n; i = next++) {
      out[i] = await call(slug, opts.row?.(i) ?? golden[i % golden.length] ?? [], opts.key?.(i));
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency ?? 16 }, lane));
  return out;
}

async function version(b: Bundle, signature = b.signature): Promise<string> {
  const res = await ada.upload(
    `/orgs/${ada.orgId}/models/${modelId}/versions/upload`,
    { framework: b.framework },
    { model: uniqueModel(b.model), signature, golden: uniqueGolden(b.golden) },
  );
  if (res.status !== 201) throw new Error(`upload ${String(res.status)} ${res.text}`);
  const id = (res.body as { id: string }).id;
  await worker.get(ValidationService).process(id, false);
  return id;
}

const endpoint = async (id: string) =>
  (await ada.get(`/orgs/${ada.orgId}/endpoints/${id}`)).body as Endpoint;
const etagOf = async (id: string) => `W/"${String((await endpoint(id)).rowVersion)}"`;

async function createEndpoint(name: string, environment = 'STAGING', who = ada) {
  return who.post(`/orgs/${ada.orgId}/projects/${projectId}/endpoints`, {
    name,
    environment,
    rateLimitRps: 1000,
  });
}

function deployRequest(endpointId: string, body: object, who = ada) {
  return who.agent
    .post(`${API}/orgs/${ada.orgId}/endpoints/${endpointId}/revisions`)
    .set('x-csrf-token', who.session.csrfToken)
    .set('idempotency-key', crypto.randomUUID())
    .send(body);
}

/** Deploy and drive the worker to READY (or wherever it stops). */
async function deploy(endpointId: string, body: object, who = ada) {
  const res = await deployRequest(endpointId, body, who);
  if (res.status !== 202) throw new Error(`deploy ${String(res.status)} ${res.text}`);
  const id = (res.body as { id: string }).id;
  await worker.get(OutboxRelay).runOnce();
  await worker.get(DeployProcessor).process(id, { isFinalAttempt: true });
  return id;
}

const release = (
  who: Client,
  endpointId: string,
  path: string,
  ifMatch: string | null,
  body = {},
) => {
  let req = who.agent
    .post(`${API}/orgs/${ada.orgId}/endpoints/${endpointId}/${path}`)
    .set('x-csrf-token', who.session.csrfToken);
  if (ifMatch) req = req.set('if-match', ifMatch);
  return req.send(body);
};
const setWeight = (who: Client, endpointId: string, weight: number, ifMatch: string | null) => {
  let req = who.agent
    .put(`${API}/orgs/${ada.orgId}/endpoints/${endpointId}/canary`)
    .set('x-csrf-token', who.session.csrfToken);
  if (ifMatch) req = req.set('if-match', ifMatch);
  return req.send({ weight });
};
const setPolicy = (policy: object) =>
  prismaOf(app).project.update({ where: { id: projectId }, data: { canaryPolicy: policy } });

beforeAll(async () => {
  app = await createTestApp();
  worker = await createTestWorker();
  ada = await Client.register(app, { name: 'Ada' });
  bob = await Client.register(app, { name: 'Bob' });
  eli = await Client.register(app, { name: 'Eli' });
  vic = await Client.register(app, { name: 'Vic' });
  await addMember(app, ada.orgId, bob, 'ADMIN');
  await addMember(app, ada.orgId, eli, 'ML_ENGINEER');
  await addMember(app, ada.orgId, vic, 'VIEWER');
  projectId = (
    (await ada.post(`/orgs/${ada.orgId}/projects`, { name: 'Released' })).body as { id: string }
  ).id;
  modelId = (
    (await ada.post(`/orgs/${ada.orgId}/projects/${projectId}/models`, { name: 'Churn' })).body as {
      id: string;
    }
  ).id;
  v.sklearn = await version(sklearn);
  v.pytorch = await version(loadBundle('pytorch'));
  v.broken = await version(loadBundle('latent-nan'));
  v.other = await version(sklearn);
  apiKey = (
    (await ada.post(`/orgs/${ada.orgId}/projects/${projectId}/api-keys`, { name: 'releases' }))
      .body as { key: string }
  ).key;
}, 300_000);
afterAll(async () => {
  await worker.close();
  await app.close();
});

describe('the deliberately broken canary is a realistic one', () => {
  it('passes every validation check, like a latent bug the tests never covered', async () => {
    const mv = await prismaOf(app).modelVersion.findUniqueOrThrow({ where: { id: v.broken } });
    expect(mv.status).toBe('VALIDATED');
    expect(golden.filter((r) => r[LATE] === 0).length).toBeGreaterThan(golden.length / 2);
  });
});

describe('canary traffic split (docs/05 §6)', () => {
  let ep: { id: string; slug: string };
  let stableId: string;
  let canaryId: string;

  beforeAll(async () => {
    ep = (await createEndpoint('Split churn')).body as { id: string; slug: string };
    stableId = await deploy(ep.id, { modelVersionId: v.sklearn });
    canaryId = await deploy(ep.id, {
      modelVersionId: v.pytorch,
      strategy: 'CANARY',
      canaryWeight: 10,
    });
  }, 180_000);

  it('a canary becomes READY next to the stable revision, with its share', async () => {
    const e = await endpoint(ep.id);
    expect(e.stableRevision?.id).toBe(stableId);
    expect(e.canary?.revision.id).toBe(canaryId);
    expect(e.canary?.weight).toBe(10);
    expect(e.canary?.eligible).toBe(false);
  });

  it('10 000 requests at 10% send 10% ± 1.5% to the canary, all answered', async () => {
    await eventually(
      () => many(200, ep.slug),
      (a) => a.some((x) => x.role === 'canary'),
    ); // the gateway has the canary in its routing table
    const started = Date.now();
    const answers = await many(10_000, ep.slug, { concurrency: 24 });
    const seconds = (Date.now() - started) / 1000;
    const share = answers.filter((a) => a.role === 'canary').length / answers.length;
    console.info(
      `split: canary share ${(share * 100).toFixed(2)}% of 10 000 in ${seconds.toFixed(1)} s`,
    );
    expect(answers.every((a) => a.status === 200)).toBe(true);
    expect(share).toBeGreaterThanOrEqual(0.085);
    expect(share).toBeLessThanOrEqual(0.115);
    for (const a of answers) expect(a.revision).toBe(a.role === 'canary' ? canaryId : stableId);
  }, 180_000);

  it('a routing key always reaches the same revision', async () => {
    const keys = Array.from({ length: 40 }, (_, i) => `customer-${String(i)}`);
    const answers = await many(400, ep.slug, { key: (i) => keys[i % keys.length] ?? '' });
    for (const [i, a] of answers.entries()) {
      const key = keys[i % keys.length] ?? '';
      expect(a.role, key).toBe(bucketOf(key) < 10 ? 'canary' : 'stable');
    }
    expect(new Set(answers.map((a) => a.role))).toEqual(new Set(['canary', 'stable']));
  }, 60_000);

  it('weight changes need the current ETag and stay within 0-50 %', async () => {
    expect((await setWeight(ada, ep.id, 20, null)).status).toBe(428);
    expect((await setWeight(ada, ep.id, 20, 'W/"0"')).status).toBe(412);
    expect((await setWeight(ada, ep.id, 80, await etagOf(ep.id))).status).toBe(400);
    expect((await setWeight(vic, ep.id, 20, await etagOf(ep.id))).status).toBe(403);
    const ok = await setWeight(eli, ep.id, 10, await etagOf(ep.id)); // staging: engineers may
    expect(ok.status, ok.text).toBe(200);
  });

  it('one canary at a time; a canary needs a stable revision with the same inputs', async () => {
    const busy = await deployRequest(ep.id, { modelVersionId: v.other });
    expect((busy.body as Problem).code).toBe('CANARY_IN_PROGRESS');
    const fresh = (await createEndpoint('Fresh churn')).body as { id: string };
    const none = await deployRequest(fresh.id, { modelVersionId: v.pytorch, strategy: 'CANARY' });
    expect((none.body as Problem).code).toBe('NO_STABLE_REVISION');
  });

  it('promote needs a passing analysis, then the canary takes all traffic', async () => {
    const early = await release(ada, ep.id, 'promote', await etagOf(ep.id));
    expect((early.body as Problem).code).toBe('CANARY_NOT_ELIGIBLE');
    await setPolicy({
      minDurationSeconds: 5,
      minRequests: 200,
      maxErrorRateIncrease: 0.01,
      maxLatencyRatio: 3,
    });
    // Prometheus scrapes every 5 s: check until the analysis has the traffic sent above.
    const check = await eventually(
      async () =>
        (await ada.post(`/orgs/${ada.orgId}/endpoints/${ep.id}/canary/checks`)).body as Check,
      (c) => c.verdict !== 'INCONCLUSIVE',
      40_000,
    );
    expect(check.verdict, JSON.stringify(check)).toBe('PASS');
    expect(check.canary.requests).toBeGreaterThanOrEqual(200);
    expect(check.canary.errors).toBe(0);
    expect((await release(ada, ep.id, 'promote', 'W/"0"')).status).toBe(412);
    const res = await release(ada, ep.id, 'promote', await etagOf(ep.id));
    expect(res.status, res.text).toBe(200);
    const e = res.body as Endpoint;
    expect(e.stableRevision?.id).toBe(canaryId);
    expect(e.canary).toBeNull();
    expect(e.revisions.find((r) => r.id === stableId)?.state).toBe('DRAINING'); // warm
    const after = await eventually(
      () => many(50, ep.slug),
      (a) => a.every((x) => x.revision === canaryId),
    );
    expect(after.every((x) => x.status === 200 && x.revision === canaryId)).toBe(true);
  }, 90_000);

  it('fast rollback: the warm previous revision serves again within seconds', async () => {
    const started = Date.now();
    const res = await release(ada, ep.id, 'rollback', await etagOf(ep.id));
    expect(res.status, res.text).toBe(200);
    expect((res.body as { path: string }).path).toBe('fast');
    const first = await eventually(
      () => call(ep.slug, golden[0] ?? []),
      (a) => a.revision === stableId,
      10_000,
    );
    const ms = Date.now() - started;
    console.info(`fast rollback: request to traffic on the old revision in ${String(ms)} ms`);
    expect(first.revision).toBe(stableId);
    expect(ms).toBeLessThan(10_000);
    const e = await endpoint(ep.id);
    expect(e.stableRevision?.id).toBe(stableId);
    expect(e.revisions.find((r) => r.id === canaryId)?.state).toBe('DRAINING');
  }, 30_000);

  it('slow rollback: a retired revision is redeployed from its version, no approval needed', async () => {
    await prismaOf(app).deploymentRevision.update({
      where: { id: canaryId },
      data: { drainUntil: new Date(Date.now() - 1000) },
    });
    await worker.get(Reconciler).reconcile();
    expect((await endpoint(ep.id)).revisions.find((r) => r.id === canaryId)?.state).toBe('RETIRED');
    const res = await release(ada, ep.id, 'rollback', await etagOf(ep.id), {
      targetRevisionId: canaryId,
    });
    expect(res.status, res.text).toBe(202);
    const out = res.body as { path: string; revision: { id: string; rollbackOfId: string } };
    expect(out.path).toBe('slow');
    expect(out.revision.rollbackOfId).toBe(canaryId);
    await worker.get(OutboxRelay).runOnce();
    await worker.get(DeployProcessor).process(out.revision.id, { isFinalAttempt: true });
    expect((await endpoint(ep.id)).stableRevision?.id).toBe(out.revision.id);
    const a = await eventually(
      () => call(ep.slug, golden[0] ?? []),
      (x) => x.revision === out.revision.id,
    );
    expect(a.status).toBe(200);
  }, 120_000);
});

describe('a broken canary is rolled back automatically (acceptance)', () => {
  it('clients see errors only in the canary share; the analysis aborts it', async () => {
    await setPolicy({
      minDurationSeconds: 300,
      minRequests: 50,
      maxErrorRateIncrease: 0.01,
      maxLatencyRatio: 3,
    });
    const ep = (await createEndpoint('Guarded churn')).body as { id: string; slug: string };
    const stableId = await deploy(ep.id, { modelVersionId: v.sklearn });
    const canaryId = await deploy(ep.id, {
      modelVersionId: v.broken,
      strategy: 'CANARY',
      canaryWeight: 20,
    });
    expect((await endpoint(ep.id)).canary?.revision.id).toBe(canaryId);
    const key = (i: number) => `user-${String(i)}`;
    const sent: { key: string; answer: Answer }[] = [];
    const send = async (n: number) => {
      const offset = sent.length;
      const answers = await many(n, ep.slug, { key: (i) => key(offset + i) });
      answers.forEach((answer, i) => sent.push({ key: key(offset + i), answer }));
      return answers;
    };
    // Until the gateway has the canary in its routing table (every answer counts below).
    await eventually(
      () => send(100),
      (a) => a.some((x) => x.role === 'canary' || x.status >= 500),
    );
    await send(1000);

    const canaryBound = sent.filter((x) => bucketOf(x.key) < 20);
    const stableBound = sent.filter((x) => bucketOf(x.key) >= 20);
    const errors = sent.filter((x) => x.answer.status >= 500).length;
    const fallbacks = canaryBound.filter(
      (x) => x.answer.status === 200 && x.answer.revision === stableId,
    ).length;
    console.info(
      `broken canary: ${String(errors)} errors in ${String(sent.length)} requests; ` +
        `canary-bound ${String(canaryBound.length)}, of which served by stable (fallback) ` +
        String(fallbacks),
    );
    // Stable customers never see the broken model; canary customers see at most their share.
    expect(
      stableBound.every((x) => x.answer.status === 200 && x.answer.revision === stableId),
    ).toBe(true);
    expect(errors).toBeGreaterThan(0); // the first failures, before its circuit opened
    expect(errors).toBeLessThanOrEqual(canaryBound.length);
    expect(fallbacks).toBeGreaterThan(0);

    const check = await eventually(
      () => worker.get(CanaryAnalyzer).analyze(ep.id),
      (c) => c?.verdict === 'FAIL',
      40_000,
    );
    expect(check?.verdict).toBe('FAIL');
    expect(check?.aborted).toBe(true);
    const e = await endpoint(ep.id);
    expect(e.canary).toBeNull();
    expect(e.stableRevision?.id).toBe(stableId);
    expect(e.revisions.find((r) => r.id === canaryId)?.state).toBe('DRAINING');
    const audit = await prismaOf(app).auditEvent.findFirst({
      where: { action: 'deployment.canary_aborted', targetId: canaryId },
    });
    expect(audit?.actorType).toBe('SYSTEM');

    // The aborted canary never served as stable: it is not something to roll back to.
    const rb = await release(ada, ep.id, 'rollback', await etagOf(ep.id));
    expect((rb.body as Problem).code).toBe('NO_ROLLBACK_TARGET');

    // After the abort: nobody sees an error any more, canary-bound customers included.
    await eventually(
      () => many(50, ep.slug, { key }),
      (a) => a.every((x) => x.status === 200),
    );
    const later = await many(500, ep.slug, { key });
    expect(later.every((a) => a.status === 200 && a.revision === stableId)).toBe(true);
  }, 240_000);
});

describe('production: four eyes (FR-41)', () => {
  let prod: { id: string; slug: string };

  it('only Owners/Admins create production endpoints and deploy to them', async () => {
    expect((await createEndpoint('Prod by eli', 'PRODUCTION', eli)).status).toBe(403);
    const res = await createEndpoint('Churn production', 'PRODUCTION');
    expect(res.status).toBe(201);
    prod = res.body as { id: string; slug: string };
    expect((await deployRequest(prod.id, { modelVersionId: v.sklearn }, eli)).status).toBe(403);
  });

  it('SEC-8, SEC-9: a production deploy waits for a second Owner/Admin; nobody approves their own', async () => {
    const res = await deployRequest(prod.id, { modelVersionId: v.sklearn });
    expect(res.status).toBe(202);
    const revId = (res.body as { id: string; state: string }).id;
    expect((res.body as { state: string }).state).toBe('AWAITING_APPROVAL');
    await worker.get(OutboxRelay).runOnce();
    const waiting = await prismaOf(app).deploymentRevision.findUniqueOrThrow({
      where: { id: revId },
    });
    expect(waiting.state).toBe('AWAITING_APPROVAL'); // nothing was queued

    const list = (await ada.get(`/orgs/${ada.orgId}/approvals?status=PENDING`)).body as {
      id: string;
      revision: { id: string };
      canDecide: boolean;
    }[];
    const mine = list.find((x) => x.revision.id === revId);
    expect(mine?.canDecide).toBe(false);
    const forBob = (
      (await bob.get(`/orgs/${ada.orgId}/approvals?status=PENDING`)).body as typeof list
    ).find((x) => x.revision.id === revId);
    expect(forBob?.canDecide).toBe(true);
    const approvalId = mine?.id ?? '';

    const self = await ada.post(`/orgs/${ada.orgId}/approvals/${approvalId}/approve`, {});
    expect(self.status).toBe(403);
    expect((self.body as Problem).code).toBe('SELF_APPROVAL');
    expect((await eli.post(`/orgs/${ada.orgId}/approvals/${approvalId}/approve`, {})).status).toBe(
      403,
    );

    // The database refuses the same shortcuts, even without the API.
    const db = prismaOf(app);
    await expect(
      db.approval.update({
        where: { id: approvalId },
        data: { status: 'APPROVED', decidedById: ada.userId, decidedAt: new Date() },
      }),
    ).rejects.toThrow(/approvals_four_eyes/);
    await expect(
      db.deploymentRevision.update({
        where: { id: revId },
        data: { state: 'QUEUED', stateVersion: { increment: 1 } },
      }),
    ).rejects.toThrow(/needs an approved approval/);

    const ok = await bob.post(`/orgs/${ada.orgId}/approvals/${approvalId}/approve`, {
      reason: 'golden checks reviewed',
    });
    expect(ok.status, ok.text).toBe(200);
    expect((ok.body as { status: string; decidedBy: { id: string } }).decidedBy.id).toBe(
      bob.userId,
    );
    expect((await bob.post(`/orgs/${ada.orgId}/approvals/${approvalId}/approve`, {})).status).toBe(
      409,
    );
    await worker.get(OutboxRelay).runOnce();
    await worker.get(DeployProcessor).process(revId, { isFinalAttempt: true });
    expect((await endpoint(prod.id)).stableRevision?.id).toBe(revId);
  }, 120_000);

  it('a rejection needs a reason and cancels the deployment; silence expires it', async () => {
    const res = await deployRequest(prod.id, { modelVersionId: v.other }, bob);
    const revId = (res.body as { id: string }).id;
    const approval = await prismaOf(app).approval.findUniqueOrThrow({
      where: { revisionId: revId },
    });
    expect((await ada.post(`/orgs/${ada.orgId}/approvals/${approval.id}/reject`, {})).status).toBe(
      400,
    );
    const rejected = await ada.post(`/orgs/${ada.orgId}/approvals/${approval.id}/reject`, {
      reason: 'not this week',
    });
    expect(rejected.status, rejected.text).toBe(200);
    const rev = await prismaOf(app).deploymentRevision.findUniqueOrThrow({ where: { id: revId } });
    expect(rev.state).toBe('CANCELLED');
    expect(rev.failureCode).toBe('APPROVAL_REJECTED');

    const again = await deployRequest(prod.id, { modelVersionId: v.other }, bob);
    const lateId = (again.body as { id: string }).id;
    await prismaOf(app).deploymentRevision.update({
      where: { id: lateId },
      data: { stateDeadlineAt: new Date(Date.now() - 1000) },
    });
    await worker.get(Reconciler).reconcile();
    const expired = await prismaOf(app).deploymentRevision.findUniqueOrThrow({
      where: { id: lateId },
    });
    expect(expired.state).toBe('CANCELLED');
    expect(expired.failureCode).toBe('APPROVAL_EXPIRED');
    expect(
      (await prismaOf(app).approval.findUniqueOrThrow({ where: { revisionId: lateId } })).status,
    ).toBe('EXPIRED');
  }, 60_000);

  it('release actions on production are for Owners/Admins only', async () => {
    const res = await setWeight(eli, prod.id, 10, await etagOf(prod.id));
    expect((res.body as Problem).code).toBe('PRODUCTION_REQUIRES_ADMIN');
    const rb = await release(eli, prod.id, 'rollback', await etagOf(prod.id));
    expect((rb.body as Problem).code).toBe('PRODUCTION_REQUIRES_ADMIN');
  });
});

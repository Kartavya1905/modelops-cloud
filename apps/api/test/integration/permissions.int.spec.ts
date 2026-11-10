import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, can, type Permission } from '../../src/common/authz/permissions';
import type { Role } from '../../src/generated/prisma/client';
import {
  addMember,
  API,
  Client,
  createTestApp,
  prismaOf,
  type Problem,
  uniqueEmail,
} from './helpers';
import { loadBundle } from './bundles';
import { createRun } from './mlflow-fixtures';

/**
 * Role x route matrix, generated from src/common/authz/permissions.ts.
 * For every role and every org-scoped route: allowed -> any non-403 success, denied -> 403 FORBIDDEN_ROLE.
 */
const ROLES: Role[] = ['OWNER', 'ADMIN', 'ML_ENGINEER', 'VIEWER'];

interface Ctx {
  orgId: string;
  projectId: string;
  targetUserId: string;
  experimentId: string;
  runIds: [string, string];
  modelId: string;
  versionId: string;
  endpointId: string;
  revisionId: string;
  apiKeyId: string;
  as: Client;
}
interface RouteCase {
  name: string;
  permission: Permission;
  call: (c: Ctx) => Promise<Response>;
  /** statuses that prove the call got past authorization (default: any status below 400) */
  allowed?: number[];
  /** or a finer check, for routes with extra rules on top of the role (e.g. "own only") */
  allowedIf?: (res: Response) => boolean;
}

let counter = 0;
const ROUTES: RouteCase[] = [
  { name: 'GET org', permission: 'org:read', call: (c) => c.as.get(`/orgs/${c.orgId}`) },
  {
    name: 'GET members',
    permission: 'member:read',
    call: (c) => c.as.get(`/orgs/${c.orgId}/members`),
  },
  {
    name: 'GET invitations',
    permission: 'member:manage',
    call: (c) => c.as.get(`/orgs/${c.orgId}/invitations`),
  },
  {
    name: 'PATCH member role',
    permission: 'member:manage',
    call: (c) => c.as.patch(`/orgs/${c.orgId}/members/${c.targetUserId}`, { role: 'VIEWER' }),
  },
  {
    name: 'POST invitation',
    permission: 'invitation:create',
    call: (c) =>
      c.as.post(`/orgs/${c.orgId}/invitations`, { email: uniqueEmail(), role: 'VIEWER' }),
  },
  {
    name: 'GET projects',
    permission: 'project:read',
    call: (c) => c.as.get(`/orgs/${c.orgId}/projects`),
  },
  {
    name: 'GET project',
    permission: 'project:read',
    call: (c) => c.as.get(`/orgs/${c.orgId}/projects/${c.projectId}`),
  },
  {
    name: 'POST project',
    permission: 'project:create',
    call: (c) =>
      c.as.post(`/orgs/${c.orgId}/projects`, { name: `Matrix project ${String(++counter)}` }),
  },
  {
    name: 'PATCH project',
    permission: 'project:update',
    call: (c) => c.as.patch(`/orgs/${c.orgId}/projects/${c.projectId}`, { description: 'edited' }),
  },
  {
    name: 'DELETE (archive) project',
    permission: 'project:archive',
    call: async (c) => {
      // Fresh project each time, so archive is never a no-op on an already archived one.
      const p = await prismaOf(app).project.create({
        data: {
          orgId: c.orgId,
          slug: `arch-${String(++counter)}`,
          name: 'To archive',
          createdById: c.targetUserId,
        },
      });
      return c.as.delete(`/orgs/${c.orgId}/projects/${p.id}`);
    },
  },
  {
    name: 'GET audit events',
    permission: 'audit:read',
    call: (c) => c.as.get(`/orgs/${c.orgId}/audit-events`),
  },
  // ---- M3: experiments + registry
  {
    name: 'GET experiment',
    permission: 'experiment:read',
    call: (c) => c.as.get(`/orgs/${c.orgId}/projects/${c.projectId}/experiment`),
  },
  {
    name: 'GET runs',
    permission: 'experiment:read',
    call: (c) => c.as.get(`/orgs/${c.orgId}/projects/${c.projectId}/runs`),
  },
  {
    name: 'GET run',
    permission: 'experiment:read',
    call: (c) => c.as.get(`/orgs/${c.orgId}/projects/${c.projectId}/runs/${c.runIds[0]}`),
  },
  {
    name: 'GET runs/compare',
    permission: 'experiment:read',
    call: (c) =>
      c.as.get(`/orgs/${c.orgId}/projects/${c.projectId}/runs/compare?ids=${c.runIds.join(',')}`),
  },
  {
    name: 'GET models',
    permission: 'model:read',
    call: (c) => c.as.get(`/orgs/${c.orgId}/projects/${c.projectId}/models`),
  },
  {
    name: 'GET model',
    permission: 'model:read',
    call: (c) => c.as.get(`/orgs/${c.orgId}/models/${c.modelId}`),
  },
  {
    name: 'GET model version',
    permission: 'model:read',
    call: (c) => c.as.get(`/orgs/${c.orgId}/model-versions/${c.versionId}`),
  },
  {
    name: 'GET datasets',
    permission: 'model:read',
    call: (c) => c.as.get(`/orgs/${c.orgId}/projects/${c.projectId}/datasets`),
  },
  {
    name: 'POST model',
    permission: 'model:create',
    call: (c) =>
      c.as.post(`/orgs/${c.orgId}/projects/${c.projectId}/models`, {
        name: `Matrix model ${String(++counter)}`,
      }),
  },
  {
    name: 'POST version import',
    permission: 'model:register',
    // a fresh run each time, so an allowed role never hits RUN_ALREADY_REGISTERED
    call: async (c) =>
      c.as.post(`/orgs/${c.orgId}/models/${c.modelId}/versions/import`, {
        runId: await createRun(c.experimentId),
      }),
  },
  {
    name: 'POST version upload',
    permission: 'model:register',
    call: (c) => {
      const b = loadBundle('sklearn');
      return c.as.upload(
        `/orgs/${c.orgId}/models/${c.modelId}/versions/upload`,
        { framework: b.framework },
        { model: b.model, signature: b.signature, golden: b.golden },
      );
    },
  },
  {
    name: 'GET validation',
    permission: 'model:read',
    call: (c) => c.as.get(`/orgs/${c.orgId}/model-versions/${c.versionId}/validation`),
  },
  {
    name: 'POST validation rerun',
    permission: 'model:register',
    // the version is still pending, so an authorized caller gets 409 (not retryable), never 403
    allowed: [409],
    call: (c) => c.as.post(`/orgs/${c.orgId}/model-versions/${c.versionId}/validation/rerun`),
  },
  // ---- M5: endpoints, deployments, API keys
  {
    name: 'GET endpoints',
    permission: 'endpoint:read',
    call: (c) => c.as.get(`/orgs/${c.orgId}/projects/${c.projectId}/endpoints`),
  },
  {
    name: 'POST endpoint',
    permission: 'endpoint:create',
    call: (c) =>
      c.as.post(`/orgs/${c.orgId}/projects/${c.projectId}/endpoints`, {
        name: `Matrix endpoint ${String(++counter)}`,
      }),
  },
  {
    name: 'GET endpoint',
    permission: 'endpoint:read',
    call: (c) => c.as.get(`/orgs/${c.orgId}/endpoints/${c.endpointId}`),
  },
  {
    name: 'GET revision',
    permission: 'endpoint:read',
    call: (c) => c.as.get(`/orgs/${c.orgId}/revisions/${c.revisionId}`),
  },
  {
    name: 'POST deploy',
    permission: 'deployment:create',
    // one deployment at a time per endpoint: an authorized caller gets 202 or 409, never 403
    allowed: [202, 409],
    call: (c) =>
      c.as.agent
        .post(`${API}/orgs/${c.orgId}/endpoints/${c.endpointId}/revisions`)
        .set('x-csrf-token', c.as.session.csrfToken)
        .set('idempotency-key', crypto.randomUUID())
        .send({ modelVersionId: c.versionId }),
  },
  {
    name: 'POST cancel',
    permission: 'deployment:cancel',
    // Owners/Admins: 200, or 409 once it is cancelled. ML engineers may only cancel their own.
    allowedIf: (res) =>
      res.status === 200 ||
      res.status === 409 ||
      (res.status === 403 && (res.body as Problem).code === 'NOT_YOUR_DEPLOYMENT'),
    call: (c) => c.as.post(`/orgs/${c.orgId}/revisions/${c.revisionId}/cancel`),
  },
  {
    name: 'GET api keys',
    permission: 'apikey:read',
    call: (c) => c.as.get(`/orgs/${c.orgId}/projects/${c.projectId}/api-keys`),
  },
  {
    name: 'POST api key',
    permission: 'apikey:manage',
    call: (c) =>
      c.as.post(`/orgs/${c.orgId}/projects/${c.projectId}/api-keys`, { name: 'matrix key' }),
  },
  // ---- M6: dashboards, playground, overview
  {
    name: 'GET endpoint metrics',
    permission: 'endpoint:read',
    call: (c) => c.as.get(`/orgs/${c.orgId}/endpoints/${c.endpointId}/metrics?range=15m`),
  },
  {
    name: 'GET org overview',
    permission: 'org:read',
    call: (c) => c.as.get(`/orgs/${c.orgId}/overview`),
  },
  {
    name: 'GET playground',
    permission: 'endpoint:read',
    call: (c) => c.as.get(`/orgs/${c.orgId}/endpoints/${c.endpointId}/playground`),
  },
  {
    name: 'POST playground predict',
    permission: 'endpoint:read',
    // nothing is deployed on the matrix endpoint: any answer but 403 proves authorization passed
    allowedIf: (res) => res.status !== 403,
    call: (c) =>
      c.as.post(`/orgs/${c.orgId}/endpoints/${c.endpointId}/playground/predict`, {
        inputs: [{ a: 1 }],
      }),
  },
  {
    name: 'DELETE api key',
    permission: 'apikey:manage',
    call: (c) => c.as.delete(`/orgs/${c.orgId}/api-keys/${c.apiKeyId}`),
  },
];

let app: NestExpressApplication;
let orgId: string;
let projectId: string;
let target: Client;
let m3: Pick<
  Ctx,
  'experimentId' | 'runIds' | 'modelId' | 'versionId' | 'endpointId' | 'revisionId' | 'apiKeyId'
>;
const members = new Map<Role, Client>();

beforeAll(async () => {
  app = await createTestApp();
  const owner = await Client.register(app, { name: 'Owner' });
  orgId = owner.orgId;
  members.set('OWNER', owner);
  for (const role of ['ADMIN', 'ML_ENGINEER', 'VIEWER'] as const) {
    const c = await Client.register(app, { name: role });
    await addMember(app, orgId, c, role);
    members.set(role, c);
  }
  target = await Client.register(app, { name: 'Target viewer' });
  await addMember(app, orgId, target, 'VIEWER');
  projectId = (
    (await owner.post(`/orgs/${orgId}/projects`, { name: 'Matrix base' })).body as { id: string }
  ).id;

  // M3 fixtures: the project's experiment, two real MLflow runs, a model and one version.
  const exp = await owner.get(`/orgs/${orgId}/projects/${projectId}/experiment`);
  const experimentId = (exp.body as { experimentId: string }).experimentId;
  const runIds: [string, string] = [await createRun(experimentId), await createRun(experimentId)];
  const model = await owner.post(`/orgs/${orgId}/projects/${projectId}/models`, {
    name: 'Matrix registry',
  });
  const modelId = (model.body as { id: string }).id;
  const version = await owner.post(`/orgs/${orgId}/models/${modelId}/versions/import`, {
    runId: runIds[0],
  });
  const versionId = (version.body as { id: string }).id;

  // M5 fixtures: the version marked VALIDATED (validation itself is tested elsewhere), an
  // endpoint with one in-progress revision requested by the owner, and an API key.
  await prismaOf(app).modelVersion.update({
    where: { id: versionId },
    data: { status: 'VALIDATED' },
  });
  const endpoint = await owner.post(`/orgs/${orgId}/projects/${projectId}/endpoints`, {
    name: 'Matrix serving',
  });
  const endpointId = (endpoint.body as { id: string }).id;
  const revision = await owner.agent
    .post(`${API}/orgs/${orgId}/endpoints/${endpointId}/revisions`)
    .set('x-csrf-token', owner.session.csrfToken)
    .set('idempotency-key', 'matrix-setup-revision')
    .send({ modelVersionId: versionId });
  const key = await owner.post(`/orgs/${orgId}/projects/${projectId}/api-keys`, { name: 'k1' });
  m3 = {
    experimentId,
    runIds,
    modelId,
    versionId,
    endpointId,
    revisionId: (revision.body as { id: string }).id,
    apiKeyId: (key.body as { id: string }).id,
  };
});
afterAll(async () => {
  await app.close();
});

describe('route table covers every permission', () => {
  it('each permission in permissions.ts is exercised by at least one route', () => {
    const covered = new Set(ROUTES.map((r) => r.permission));
    expect(ALL_PERMISSIONS.filter((p) => !covered.has(p))).toEqual([]);
  });
});

describe.each(ROLES)('as %s', (role) => {
  it.each(ROUTES.map((r) => [r.name, r] as const))('%s', async (_name, route) => {
    const as = members.get(role);
    if (!as) throw new Error(`no ${role} client`);
    const res = await route.call({ orgId, projectId, targetUserId: target.userId, as, ...m3 });
    if (can(role, route.permission)) {
      const ok = route.allowedIf
        ? route.allowedIf(res)
        : route.allowed
          ? route.allowed.includes(res.status)
          : res.status < 400;
      expect(ok, `${role} should be allowed ${route.permission}: ${res.text}`).toBe(true);
    } else {
      expect(res.status, `${role} should be denied ${route.permission}`).toBe(403);
      expect((res.body as Problem).code).toBe('FORBIDDEN_ROLE');
    }
  });
});

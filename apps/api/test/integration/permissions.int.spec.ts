import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, can, type Permission } from '../../src/common/authz/permissions';
import type { Role } from '../../src/generated/prisma/client';
import { addMember, Client, createTestApp, prismaOf, type Problem, uniqueEmail } from './helpers';

/**
 * Role x route matrix, generated from src/common/authz/permissions.ts.
 * For every role and every org-scoped route: allowed -> any non-403 success, denied -> 403 FORBIDDEN_ROLE.
 */
const ROLES: Role[] = ['OWNER', 'ADMIN', 'ML_ENGINEER', 'VIEWER'];

interface Ctx {
  orgId: string;
  projectId: string;
  targetUserId: string;
  as: Client;
}
interface RouteCase {
  name: string;
  permission: Permission;
  call: (c: Ctx) => Promise<Response>;
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
];

let app: NestExpressApplication;
let orgId: string;
let projectId: string;
let target: Client;
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
    const res = await route.call({ orgId, projectId, targetUserId: target.userId, as });
    if (can(role, route.permission)) {
      expect(res.status, `${role} should be allowed ${route.permission}: ${res.text}`).toBeLessThan(
        400,
      );
    } else {
      expect(res.status, `${role} should be denied ${route.permission}`).toBe(403);
      expect((res.body as Problem).code).toBe('FORBIDDEN_ROLE');
    }
  });
});

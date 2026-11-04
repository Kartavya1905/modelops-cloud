import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, createTestApp, type Problem } from './helpers';

/**
 * docs/06 SEC-7: a member of org B must not be able to read or change anything in org A,
 * and must not be able to tell whether an org A id exists (always 404, never 403).
 */
let app: NestExpressApplication;
let alice: Client; // owns org A
let bob: Client; // owns org B
let projectA: string;

beforeAll(async () => {
  app = await createTestApp();
  alice = await Client.register(app, { name: 'Alice' });
  bob = await Client.register(app, { name: 'Bob' });
  const res = await alice.post(`/orgs/${alice.orgId}/projects`, { name: 'Secret project' });
  projectA = (res.body as { id: string }).id;
});
afterAll(async () => {
  await app.close();
});

describe('cross-tenant access is indistinguishable from "does not exist"', () => {
  const readPaths = () => [
    `/orgs/${alice.orgId}`,
    `/orgs/${alice.orgId}/projects`,
    `/orgs/${alice.orgId}/projects/${projectA}`,
    `/orgs/${alice.orgId}/members`,
    `/orgs/${alice.orgId}/invitations`,
    `/orgs/${alice.orgId}/audit-events`,
  ];

  it.each([0, 1, 2, 3, 4, 5])('GET path #%i of org A as Bob -> 404', async (i) => {
    const path = readPaths()[i] ?? '';
    const res = await bob.get(path);
    expect(res.status).toBe(404);
    expect((res.body as Problem).code).toBe('NOT_FOUND');
  });

  it('writes into org A as Bob -> 404', async () => {
    const results = await Promise.all([
      bob.post(`/orgs/${alice.orgId}/projects`, { name: 'Injected' }),
      bob.patch(`/orgs/${alice.orgId}/projects/${projectA}`, { name: 'Pwned' }),
      bob.delete(`/orgs/${alice.orgId}/projects/${projectA}`),
      bob.post(`/orgs/${alice.orgId}/invitations`, { email: bob.email, role: 'OWNER' }),
      bob.patch(`/orgs/${alice.orgId}/members/${bob.userId}`, { role: 'OWNER' }),
    ]);
    expect(results.map((r) => r.status)).toEqual([404, 404, 404, 404, 404]);
  });

  it("org A's project id under Bob's own org path -> 404 (id swap)", async () => {
    expect((await bob.get(`/orgs/${bob.orgId}/projects/${projectA}`)).status).toBe(404);
    expect(
      (await bob.patch(`/orgs/${bob.orgId}/projects/${projectA}`, { name: 'x2' })).status,
    ).toBe(404);
  });

  it('malformed and random org ids -> 404', async () => {
    expect((await bob.get('/orgs/not-a-uuid/projects')).status).toBe(404);
    expect((await bob.get('/orgs/00000000-0000-4000-8000-000000000000/projects')).status).toBe(404);
  });

  it("org A's data is unchanged and absent from Bob's listings", async () => {
    const project = await alice.get(`/orgs/${alice.orgId}/projects/${projectA}`);
    expect((project.body as { name: string }).name).toBe('Secret project');
    const bobsOrgs = (await bob.get('/orgs')).body as { id: string }[];
    expect(bobsOrgs.map((o) => o.id)).not.toContain(alice.orgId);
  });
});

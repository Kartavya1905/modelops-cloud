import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, createTestApp, PASSWORD, prismaOf, type Problem } from './helpers';

interface ProjectBody {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  archivedAt: string | null;
}
interface PageBody<T> {
  data: T[];
  nextCursor: string | null;
}

let app: NestExpressApplication;
let owner: Client;
beforeAll(async () => {
  app = await createTestApp();
  owner = await Client.register(app, { name: 'Project Owner' });
});
afterAll(async () => {
  await app.close();
});

describe('projects', () => {
  it('creates a project with a slug, and audits it with the caller’s request id', async () => {
    const res = await owner
      .post(`/orgs/${owner.orgId}/projects`, { name: 'Churn Prediction v2!', description: 'Demo' })
      .set('x-request-id', 'test-req-create-1');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ slug: 'churn-prediction-v2', name: 'Churn Prediction v2!' });

    const audit = await prismaOf(app).auditEvent.findFirstOrThrow({
      where: {
        orgId: owner.orgId,
        action: 'project.created',
        targetId: (res.body as ProjectBody).id,
      },
    });
    expect(audit.requestId).toBe('test-req-create-1');
    expect(audit.actorId).toBe(owner.userId);
  });

  it('409 PROJECT_SLUG_TAKEN when two names produce the same slug', async () => {
    await owner.post(`/orgs/${owner.orgId}/projects`, { name: 'Fraud detection' });
    const res = await owner.post(`/orgs/${owner.orgId}/projects`, { name: 'Fraud   Detection' });
    expect(res.status).toBe(409);
    expect((res.body as Problem).code).toBe('PROJECT_SLUG_TAKEN');
  });

  it('paginates with a stable cursor (no duplicates, no gaps)', async () => {
    const org = await Client.register(app);
    for (let i = 1; i <= 5; i++)
      await org.post(`/orgs/${org.orgId}/projects`, { name: `Paged ${String(i)}` });

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const q: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
      const res = await org.get(`/orgs/${org.orgId}/projects?limit=2${q}`);
      const body = res.body as PageBody<ProjectBody>;
      seen.push(...body.data.map((p) => p.name));
      cursor = body.nextCursor;
      pages++;
    } while (cursor && pages < 10);

    expect(pages).toBe(3);
    expect(seen).toEqual(['Paged 5', 'Paged 4', 'Paged 3', 'Paged 2', 'Paged 1']);
  });

  it('rejects a tampered cursor with 400', async () => {
    const res = await owner.get(`/orgs/${owner.orgId}/projects?cursor=not-a-real-cursor`);
    expect(res.status).toBe(400);
  });

  it('updates name and description but never the slug', async () => {
    const created = (await owner.post(`/orgs/${owner.orgId}/projects`, { name: 'Original name' }))
      .body as ProjectBody;
    const res = await owner.patch(`/orgs/${owner.orgId}/projects/${created.id}`, {
      name: 'Renamed',
      description: 'Now with a description',
    });
    expect(res.body).toMatchObject({
      name: 'Renamed',
      slug: 'original-name',
      description: 'Now with a description',
    });
    const slugChange = await owner.patch(`/orgs/${owner.orgId}/projects/${created.id}`, {
      slug: 'hacked',
    });
    expect(slugChange.status).toBe(400);
  });

  it('archive hides a project from the default list, idempotently', async () => {
    const created = (await owner.post(`/orgs/${owner.orgId}/projects`, { name: 'To be archived' }))
      .body as ProjectBody;
    const first = await owner.delete(`/orgs/${owner.orgId}/projects/${created.id}`);
    const second = await owner.delete(`/orgs/${owner.orgId}/projects/${created.id}`);
    expect(first.status).toBe(200);
    expect((second.body as ProjectBody).archivedAt).toBe((first.body as ProjectBody).archivedAt);

    const active = (await owner.get(`/orgs/${owner.orgId}/projects?limit=100`))
      .body as PageBody<ProjectBody>;
    expect(active.data.map((p) => p.id)).not.toContain(created.id);
    const all = (await owner.get(`/orgs/${owner.orgId}/projects?limit=100&includeArchived=true`))
      .body as PageBody<ProjectBody>;
    expect(all.data.map((p) => p.id)).toContain(created.id);

    const archived = await prismaOf(app).auditEvent.count({
      where: { targetId: created.id, action: 'project.archived' },
    });
    expect(archived).toBe(1);
  });
});

describe('audit log', () => {
  it('is append-only at the database level (UPDATE, DELETE, TRUNCATE all rejected)', async () => {
    const prisma = prismaOf(app);
    await expect(
      prisma.$executeRawUnsafe(`UPDATE audit_events SET action = 'tampered'`),
    ).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe(`DELETE FROM audit_events`)).rejects.toThrow(
      /append-only/,
    );
    await expect(prisma.$executeRawUnsafe(`TRUNCATE audit_events`)).rejects.toThrow(/append-only/);
    expect(await prisma.auditEvent.count({ where: { action: 'tampered' } })).toBe(0);
  });

  it('lists the org’s events newest first, filters by action, and names the actor', async () => {
    const res = await owner.get(`/orgs/${owner.orgId}/audit-events?limit=50`);
    const body = res.body as PageBody<{
      id: string;
      action: string;
      actor: { name: string } | null;
    }>;
    const ids = body.data.map((e) => BigInt(e.id));
    expect([...ids].sort((a, b) => (a > b ? -1 : 1))).toEqual(ids);
    expect(body.data.at(-1)?.action).toBe('organization.created');
    expect(body.data[0]?.actor?.name).toBe('Project Owner');

    const filtered = (await owner.get(`/orgs/${owner.orgId}/audit-events?action=project.archived`))
      .body as PageBody<{ action: string }>;
    expect(filtered.data.length).toBeGreaterThan(0);
    expect(new Set(filtered.data.map((e) => e.action))).toEqual(new Set(['project.archived']));
  });

  it('never stores passwords, session tokens or raw IPs', async () => {
    const rows = await prismaOf(app).auditEvent.findMany();
    const dump = JSON.stringify(rows, (_k, v: unknown) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
    expect(dump).not.toContain(PASSWORD);
    expect(dump).not.toContain(owner.session.csrfToken);
    expect(dump).not.toMatch(/"(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)"/);
  });
});

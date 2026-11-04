import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, Client, createTestApp, prismaOf, type Problem, uniqueEmail } from './helpers';

let app: NestExpressApplication;
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
});

const code = (res: { body: unknown }) => (res.body as Problem).code;

describe('owner rules', () => {
  it('an Admin cannot grant Owner or change an Owner', async () => {
    const owner = await Client.register(app);
    const admin = await Client.register(app);
    const other = await Client.register(app);
    await addMember(app, owner.orgId, admin, 'ADMIN');
    await addMember(app, owner.orgId, other, 'VIEWER');

    const grant = await admin.patch(`/orgs/${owner.orgId}/members/${other.userId}`, {
      role: 'OWNER',
    });
    expect(grant.status).toBe(403);
    expect(code(grant)).toBe('OWNER_REQUIRED');

    const demote = await admin.patch(`/orgs/${owner.orgId}/members/${owner.userId}`, {
      role: 'VIEWER',
    });
    expect(demote.status).toBe(403);
    const remove = await admin.delete(`/orgs/${owner.orgId}/members/${owner.userId}`);
    expect(remove.status).toBe(403);
  });

  it('the last Owner can be neither demoted nor removed', async () => {
    const owner = await Client.register(app);
    const demote = await owner.patch(`/orgs/${owner.orgId}/members/${owner.userId}`, {
      role: 'ADMIN',
    });
    expect(demote.status).toBe(409);
    expect(code(demote)).toBe('LAST_OWNER');
    const remove = await owner.delete(`/orgs/${owner.orgId}/members/${owner.userId}`);
    expect(remove.status).toBe(409);
  });

  it('two Owners demoting each other at the same time: exactly one wins, one Owner remains', async () => {
    const a = await Client.register(app);
    const b = await Client.register(app);
    await addMember(app, a.orgId, b, 'OWNER');

    // Both requests pass OrgAccessGuard as Owners. The org-row lock serializes them, and the
    // second re-reads its caller's role inside the transaction, finds it was just demoted to
    // Admin, and is refused, instead of acting on the stale role from the guard.
    const results = await Promise.all([
      a.patch(`/orgs/${a.orgId}/members/${b.userId}`, { role: 'ADMIN' }),
      b.patch(`/orgs/${a.orgId}/members/${a.userId}`, { role: 'ADMIN' }),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 403]);
    expect(results.map(code).filter(Boolean)).toEqual(['OWNER_REQUIRED']);
    const owners = await prismaOf(app).membership.count({
      where: { orgId: a.orgId, role: 'OWNER' },
    });
    expect(owners).toBe(1);
  });

  it('a member demoted mid-flight cannot act with the role they had when the request started', async () => {
    const owner = await Client.register(app);
    const admin = await Client.register(app);
    const viewer = await Client.register(app);
    await addMember(app, owner.orgId, admin, 'ADMIN');
    await addMember(app, owner.orgId, viewer, 'VIEWER');

    // Owner demotes the Admin while the Admin tries to change someone's role, at the same time.
    // Whatever the interleaving, the Admin's request may only succeed if it ran *before* the demotion.
    const [demote, attempt] = await Promise.all([
      owner.patch(`/orgs/${owner.orgId}/members/${admin.userId}`, { role: 'VIEWER' }),
      admin.patch(`/orgs/${owner.orgId}/members/${viewer.userId}`, { role: 'ML_ENGINEER' }),
    ]);
    expect(demote.status).toBe(200);
    expect([200, 403]).toContain(attempt.status);
    const events = await prismaOf(app).auditEvent.findMany({
      where: { orgId: owner.orgId, action: 'member.role_changed' },
      orderBy: { id: 'asc' },
    });
    if (attempt.status === 200) {
      // the Admin's change committed first, while they were still an Admin
      expect(events.map((e) => e.targetId)).toEqual([viewer.userId, admin.userId]);
    } else {
      expect(events.map((e) => e.targetId)).toEqual([admin.userId]);
    }
  });

  it('an Owner can hand over ownership, and the change is audited', async () => {
    const owner = await Client.register(app);
    const admin = await Client.register(app);
    await addMember(app, owner.orgId, admin, 'ADMIN');
    expect(
      (await owner.patch(`/orgs/${owner.orgId}/members/${admin.userId}`, { role: 'OWNER' })).status,
    ).toBe(200);
    expect(
      (await owner.patch(`/orgs/${owner.orgId}/members/${owner.userId}`, { role: 'ADMIN' })).status,
    ).toBe(200);

    const audit = await prismaOf(app).auditEvent.findMany({
      where: { orgId: owner.orgId, action: 'member.role_changed' },
      orderBy: { id: 'asc' },
    });
    expect(audit.map((e) => e.metadata)).toEqual([
      { from: 'ADMIN', to: 'OWNER' },
      { from: 'OWNER', to: 'ADMIN' },
    ]);
  });
});

describe('invitations', () => {
  it('invite -> preview -> accept by the invited email -> member with the invited role', async () => {
    const owner = await Client.register(app);
    const inviteeEmail = uniqueEmail();
    const created = await owner.post(`/orgs/${owner.orgId}/invitations`, {
      email: inviteeEmail,
      role: 'ML_ENGINEER',
    });
    expect(created.status).toBe(201);
    const { token, acceptPath } = created.body as { token: string; acceptPath: string };
    expect(acceptPath).toBe(`/invite/${token}`);

    // only the hash is stored
    const stored = await prismaOf(app).invitation.findFirstOrThrow({
      where: { orgId: owner.orgId },
    });
    expect(Buffer.from(stored.tokenHash).toString('utf8')).not.toContain(token);

    const invitee = await Client.register(app, { email: inviteeEmail });
    const preview = await invitee.get(`/invitations/${token}`);
    expect(preview.body).toMatchObject({ role: 'ML_ENGINEER', email: inviteeEmail });

    const accepted = await invitee.post(`/invitations/${token}/accept`);
    expect(accepted.status).toBe(200);
    const members = (await owner.get(`/orgs/${owner.orgId}/members`)).body as {
      userId: string;
      role: string;
    }[];
    expect(members.find((m) => m.userId === invitee.userId)?.role).toBe('ML_ENGINEER');

    // single use
    expect((await invitee.post(`/invitations/${token}/accept`)).status).toBe(404);
  });

  it('a different signed-in email cannot use the link', async () => {
    const owner = await Client.register(app);
    const created = await owner.post(`/orgs/${owner.orgId}/invitations`, {
      email: uniqueEmail(),
      role: 'VIEWER',
    });
    const { token } = created.body as { token: string };
    const stranger = await Client.register(app);
    const res = await stranger.post(`/invitations/${token}/accept`);
    expect(res.status).toBe(403);
    expect(code(res)).toBe('INVITATION_EMAIL_MISMATCH');
  });

  it('two concurrent accepts of the same link create exactly one membership', async () => {
    const owner = await Client.register(app);
    const email = uniqueEmail();
    const { token } = (
      await owner.post(`/orgs/${owner.orgId}/invitations`, { email, role: 'VIEWER' })
    ).body as {
      token: string;
    };
    const invitee = await Client.register(app, { email });
    const results = await Promise.all([
      invitee.post(`/invitations/${token}/accept`),
      invitee.post(`/invitations/${token}/accept`),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 404]);
    const count = await prismaOf(app).membership.count({
      where: { orgId: owner.orgId, userId: invitee.userId },
    });
    expect(count).toBe(1);
  });

  it('expired, unknown and malformed tokens are 404', async () => {
    const owner = await Client.register(app);
    const email = uniqueEmail();
    const { token } = (
      await owner.post(`/orgs/${owner.orgId}/invitations`, { email, role: 'VIEWER' })
    ).body as {
      token: string;
    };
    await prismaOf(app).invitation.updateMany({
      where: { orgId: owner.orgId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const invitee = await Client.register(app, { email });
    expect((await invitee.post(`/invitations/${token}/accept`)).status).toBe(404);
    expect((await invitee.get(`/invitations/${'x'.repeat(43)}`)).status).toBe(404);
    expect((await invitee.get('/invitations/short')).status).toBe(404);
  });

  it('only an Owner may invite an Owner; existing members cannot be invited', async () => {
    const owner = await Client.register(app);
    const admin = await Client.register(app);
    await addMember(app, owner.orgId, admin, 'ADMIN');
    const res = await admin.post(`/orgs/${owner.orgId}/invitations`, {
      email: uniqueEmail(),
      role: 'OWNER',
    });
    expect(res.status).toBe(403);
    const dup = await owner.post(`/orgs/${owner.orgId}/invitations`, {
      email: admin.email,
      role: 'VIEWER',
    });
    expect(dup.status).toBe(409);
    expect(code(dup)).toBe('ALREADY_MEMBER');
  });
});

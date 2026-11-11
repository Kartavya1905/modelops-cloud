import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, createTestApp, prismaOf } from './helpers';

/**
 * M9: the audit log is tamper-evident. Every event's hash covers the previous event's hash, so
 * editing or deleting history (even as the database owner, bypassing the append-only trigger) is
 * detected by GET /orgs/{orgId}/audit-events/verify.
 */
interface Verification {
  intact: boolean;
  checked: number;
  brokenAt: number | null;
  reason: string | null;
  head: string | null;
}

let app: NestExpressApplication;
const verify = async (c: Client) =>
  (await c.get(`/orgs/${c.orgId}/audit-events/verify`)).body as Verification;
const chain = (orgId: string) =>
  prismaOf(app).auditEvent.findMany({ where: { orgId }, orderBy: { chainSeq: 'asc' } });
/** Changes history the way only the database owner could: with the append-only trigger off. */
async function asOwner(sql: string) {
  const db = prismaOf(app);
  await db.$executeRawUnsafe(
    'ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update_delete',
  );
  try {
    await db.$executeRawUnsafe(sql);
  } finally {
    await db.$executeRawUnsafe(
      'ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update_delete',
    );
  }
}

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
});

describe('audit hash chain (M9)', () => {
  it('links every event of an org to the one before it, and verifies', async () => {
    const ada = await Client.register(app, { name: 'Ada' });
    for (const name of ['One', 'Two', 'Three']) {
      await ada.post(`/orgs/${ada.orgId}/projects`, { name });
    }
    const events = await chain(ada.orgId);
    expect(events.map((e) => Number(e.chainSeq))).toEqual(events.map((_, i) => i + 1));
    expect(events[0]?.prevHash).toBeNull();
    for (let i = 1; i < events.length; i++) {
      expect(
        Buffer.from(events[i]?.prevHash ?? []).equals(Buffer.from(events[i - 1]?.hash ?? [])),
      ).toBe(true);
    }
    const v = await verify(ada);
    expect(v).toMatchObject({ intact: true, checked: events.length, brokenAt: null });
    expect(v.head).toBe(Buffer.from(events.at(-1)?.hash ?? []).toString('hex'));
  });

  it('stays one chain under concurrent writes (no forks)', async () => {
    const bob = await Client.register(app, { name: 'Bob' });
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        bob.post(`/orgs/${bob.orgId}/projects`, { name: `P ${String(i)}` }),
      ),
    );
    const events = await chain(bob.orgId);
    expect(new Set(events.map((e) => Number(e.chainSeq))).size).toBe(events.length);
    expect((await verify(bob)).intact).toBe(true);
  });

  it('detects an edited event, even when the database owner edits it', async () => {
    const eve = await Client.register(app, { name: 'Eve' });
    await eve.post(`/orgs/${eve.orgId}/projects`, { name: 'Honest' });
    await eve.post(`/orgs/${eve.orgId}/projects`, { name: 'Later' });
    const target = (await chain(eve.orgId))[1];
    // The app itself cannot: the append-only trigger refuses.
    await expect(
      prismaOf(app).auditEvent.update({ where: { id: target?.id }, data: { action: 'x.y' } }),
    ).rejects.toThrow(/append-only/);
    await asOwner(
      `UPDATE audit_events SET metadata = '{"name":"Rewritten"}' WHERE id = ${String(target?.id)}`,
    );
    expect(await verify(eve)).toMatchObject({
      intact: false,
      brokenAt: Number(target?.chainSeq),
      reason: 'event content changed',
    });
  });

  it('detects a deleted event (a gap in the chain)', async () => {
    const mal = await Client.register(app, { name: 'Mal' });
    for (const name of ['A1', 'A2', 'A3']) await mal.post(`/orgs/${mal.orgId}/projects`, { name });
    const middle = (await chain(mal.orgId))[2];
    await asOwner(`DELETE FROM audit_events WHERE id = ${String(middle?.id)}`);
    expect(await verify(mal)).toMatchObject({
      intact: false,
      brokenAt: Number(middle?.chainSeq),
      reason: 'missing event (gap in the chain)',
    });
  });
});

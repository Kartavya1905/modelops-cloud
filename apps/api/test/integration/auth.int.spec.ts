import { createHash } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  API,
  Client,
  createTestApp,
  PASSWORD,
  prismaOf,
  type Problem,
  uniqueEmail,
} from './helpers';

let app: NestExpressApplication;
let http: () => ReturnType<typeof request>;

beforeAll(async () => {
  app = await createTestApp();
  http = () => request(app.getHttpServer());
});
afterAll(async () => {
  await app.close();
});

function sessionCookie(res: request.Response): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  const cookie = raw?.find((c) => c.startsWith('mo_session='));
  if (!cookie) throw new Error('no mo_session cookie');
  return cookie;
}

describe('POST /auth/register', () => {
  it('creates the user, a personal org they own, and a hardened session cookie', async () => {
    const email = uniqueEmail();
    const res = await http()
      .post(`${API}/auth/register`)
      .send({ email: `  ${email.toUpperCase()} `, name: 'Ada Lovelace', password: PASSWORD });

    expect(res.status).toBe(201);
    const body = res.body as {
      user: { email: string };
      memberships: { role: string }[];
      csrfToken: string;
    };
    expect(body.user.email).toBe(email); // trimmed + lower-cased
    expect(body.memberships).toHaveLength(1);
    expect(body.memberships[0]?.role).toBe('OWNER');
    expect(body.csrfToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);

    const cookie = sessionCookie(res);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//);
  });

  it('stores an Argon2id hash, never the password, and only a hash of the session token', async () => {
    const email = uniqueEmail();
    const res = await http()
      .post(`${API}/auth/register`)
      .send({ email, name: 'Hash Check', password: PASSWORD });
    const token = decodeURIComponent(sessionCookie(res).split(';')[0]?.split('=')[1] ?? '');

    const user = await prismaOf(app).user.findUniqueOrThrow({
      where: { email },
      include: { sessions: true },
    });
    // PHC string: algorithm, version and the OWASP parameters (order of params is library-defined).
    expect(user.passwordHash).toMatch(/^\$argon2id\$v=19\$/);
    expect(user.passwordHash).toMatch(/m=19456/);
    expect(user.passwordHash).toMatch(/t=2/);
    expect(user.passwordHash).toMatch(/p=1/);
    expect(user.passwordHash).not.toContain(PASSWORD);

    const expected = createHash('sha256').update(token).digest('hex');
    expect(Buffer.from(user.sessions[0]?.tokenHash ?? []).toString('hex')).toBe(expected);
  });

  it('rejects a duplicate email regardless of case with 409 EMAIL_TAKEN', async () => {
    const email = uniqueEmail();
    await Client.register(app, { email });
    const res = await http()
      .post(`${API}/auth/register`)
      .send({ email: email.toUpperCase(), name: 'Dup', password: PASSWORD });
    expect(res.status).toBe(409);
    expect((res.body as Problem).code).toBe('EMAIL_TAKEN');
  });

  it('returns 400 problem+json listing every invalid field', async () => {
    const res = await http()
      .post(`${API}/auth/register`)
      .send({ email: 'not-an-email', name: '', password: 'short' });
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    const fields = new Set((res.body as Problem).errors?.map((e) => e.field));
    expect(fields).toEqual(new Set(['email', 'name', 'password']));
  });

  it('rejects unknown properties (mass assignment)', async () => {
    const res = await http()
      .post(`${API}/auth/register`)
      .send({ email: uniqueEmail(), name: 'X', password: PASSWORD, role: 'OWNER' });
    expect(res.status).toBe(400);
    expect((res.body as Problem).errors?.[0]?.field).toBe('role');
  });
});

describe('POST /auth/login', () => {
  it('logs in with the right password and returns a fresh session', async () => {
    const user = await Client.register(app);
    const res = await http()
      .post(`${API}/auth/login`)
      .send({ email: user.email, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(sessionCookie(res)).toBeTruthy();
  });

  it('gives the same answer for a wrong password and an unknown email', async () => {
    const user = await Client.register(app);
    const wrong = await http()
      .post(`${API}/auth/login`)
      .send({ email: user.email, password: 'nope-nope-nope' });
    const unknown = await http()
      .post(`${API}/auth/login`)
      .send({ email: uniqueEmail(), password: 'nope-nope-nope' });
    for (const res of [wrong, unknown]) {
      expect(res.status).toBe(401);
      const { code, title, detail } = res.body as Problem;
      expect({ code, title, detail }).toEqual({
        code: 'INVALID_CREDENTIALS',
        title: 'Invalid credentials',
        detail: 'The email or password is incorrect.',
      });
    }
  });

  it('SEC-16: blocks the 6th failed attempt within a minute with 429 + Retry-After, even with the right password', async () => {
    const user = await Client.register(app);
    for (let i = 0; i < 5; i++) {
      const r = await http()
        .post(`${API}/auth/login`)
        .send({ email: user.email, password: 'wrong-password-1' });
      expect(r.status).toBe(401);
    }
    const blocked = await http()
      .post(`${API}/auth/login`)
      .send({ email: user.email, password: PASSWORD });
    expect(blocked.status).toBe(429);
    expect((blocked.body as Problem).code).toBe('RATE_LIMITED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('records failures and successes in the audit log without the password', async () => {
    const user = await Client.register(app);
    await http()
      .post(`${API}/auth/login`)
      .send({ email: user.email, password: 'wrong-password-2' });
    await http().post(`${API}/auth/login`).send({ email: user.email, password: PASSWORD });
    const events = await prismaOf(app).auditEvent.findMany({
      where: { actorId: user.userId, action: { startsWith: 'auth.login' } },
      orderBy: { id: 'asc' },
    });
    expect(events.map((e) => e.action)).toEqual(['auth.login_failed', 'auth.login_succeeded']);
    const dump = JSON.stringify(events, (_k, v: unknown) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
    expect(dump).not.toContain('wrong-password-2');
    expect(dump).not.toContain(PASSWORD);
  });
});

describe('session lifecycle', () => {
  it('GET /auth/me without a session is 401 problem+json', async () => {
    const res = await http().get(`${API}/auth/me`);
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  });

  it('SEC-12: logout requires the CSRF token and then revokes the session', async () => {
    const user = await Client.register(app);
    const noCsrf = await user.agent.post(`${API}/auth/logout`);
    expect(noCsrf.status).toBe(403);
    expect((noCsrf.body as Problem).code).toBe('CSRF_TOKEN_INVALID');

    expect((await user.post('/auth/logout')).status).toBe(204);
    expect((await user.get('/auth/me')).status).toBe(401);
  });

  it('SEC-12: rejects a wrong CSRF token', async () => {
    const user = await Client.register(app);
    const res = await user.agent
      .post(`${API}/orgs`)
      .set('x-csrf-token', `${user.session.csrfToken.slice(0, -2)}xx`)
      .send({ name: 'Should fail' });
    expect(res.status).toBe(403);
  });

  it('rejects an expired session', async () => {
    const user = await Client.register(app);
    await prismaOf(app).session.updateMany({
      where: { userId: user.userId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await user.get('/auth/me')).status).toBe(401);
  });

  it('echoes a valid X-Request-Id and generates one otherwise', async () => {
    const echoed = await http().get(`${API}/health/live`).set('x-request-id', 'trace-abc-12345');
    expect(echoed.headers['x-request-id']).toBe('trace-abc-12345');
    const generated = await http().get(`${API}/health/live`).set('x-request-id', 'bad id!');
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

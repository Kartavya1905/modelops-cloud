import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { inject } from 'vitest';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { APP_CONFIG, type AppConfig, loadConfig } from '../../src/config/config';
import type { Role } from '../../src/generated/prisma/client';
import { DeployWorker } from '../../src/modules/deployments/deploy.worker';
import { EventsWorker } from '../../src/modules/monitoring/events.consumer';
import { CanaryScheduler } from '../../src/modules/deployments/canary-analysis';
import { DriftScheduler } from '../../src/modules/monitoring/monitoring.module';
import { ValidationWorker } from '../../src/modules/validation/validation.worker';
import { setupApp } from '../../src/setup-app';
import { WorkerModule } from '../../src/worker.module';

export const API = '/api/v1';
export const PASSWORD = 'correct horse battery staple';

/**
 * Boots the full AppModule (all guards, filters, pipes) against the throwaway test database.
 * `env` overrides individual settings (e.g. an unreachable ML worker for failure tests).
 */
/** Settings every test process shares: throwaway DB, test Redis, test gateway, test instance. */
export function testConfig(env: Record<string, string> = {}): AppConfig {
  const envFile = join(process.cwd(), '..', '..', '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  return loadConfig({
    ...process.env,
    DATABASE_URL: inject('databaseUrl'),
    REDIS_URL: inject('redisUrl'),
    MO_API_DOCS: 'false',
    MO_GATEWAY_URL: inject('gatewayUrl'),
    MO_GATEWAY_ADMIN_URL: inject('gatewayAdminUrl'),
    MO_INSTANCE_ID: inject('instanceId'),
    ...inject('runtimeEnv'), // M10: kubernetes runs (namespace, context, egress)
    ...env,
  });
}

export async function createTestApp(
  env: Record<string, string> = {},
): Promise<NestExpressApplication> {
  const config = testConfig(env);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(config)
    .compile();
  const app = setupApp(
    moduleRef.createNestApplication<NestExpressApplication>({ logger: ['error'] }),
  );
  await app.init();
  return app;
}

export const prismaOf = (app: NestExpressApplication) => app.get(PrismaService);
export const uniqueEmail = () => `u-${randomUUID().slice(0, 8)}@example.com`;

interface SessionBody {
  user: { id: string; email: string; name: string };
  memberships: { orgId: string; role: Role; permissions: string[] }[];
  csrfToken: string;
}

/** A signed-in browser: keeps the session cookie and sends the CSRF header on writes. */
export class Client {
  private constructor(
    readonly agent: ReturnType<typeof request.agent>,
    readonly session: SessionBody,
  ) {}

  get userId(): string {
    return this.session.user.id;
  }
  get email(): string {
    return this.session.user.email;
  }
  /** The personal organization created at registration. */
  get orgId(): string {
    const first = this.session.memberships[0];
    if (!first) throw new Error('user has no organization');
    return first.orgId;
  }

  static async register(
    app: NestExpressApplication,
    opts: { email?: string; name?: string } = {},
  ): Promise<Client> {
    const agent = request.agent(app.getHttpServer());
    const res = await agent.post(`${API}/auth/register`).send({
      email: opts.email ?? uniqueEmail(),
      name: opts.name ?? 'Test User',
      password: PASSWORD,
    });
    if (res.status !== 201) throw new Error(`register failed: ${res.status} ${res.text}`);
    return new Client(agent, res.body as SessionBody);
  }

  get(path: string) {
    return this.agent.get(`${API}${path}`);
  }
  post(path: string, body?: object) {
    return this.agent.post(`${API}${path}`).set('x-csrf-token', this.session.csrfToken).send(body);
  }
  patch(path: string, body?: object) {
    return this.agent.patch(`${API}${path}`).set('x-csrf-token', this.session.csrfToken).send(body);
  }
  /** multipart/form-data: text fields plus named file parts. */
  upload(path: string, fields: Record<string, string>, files: Record<string, Buffer>) {
    let req = this.agent.post(`${API}${path}`).set('x-csrf-token', this.session.csrfToken);
    for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
    for (const [k, v] of Object.entries(files)) req = req.attach(k, v, `${k}.bin`);
    return req;
  }
  delete(path: string) {
    return this.agent.delete(`${API}${path}`).set('x-csrf-token', this.session.csrfToken);
  }
}

/** Adds `user` to `orgId` with `role` directly in the database (test setup shortcut). */
export async function addMember(
  app: NestExpressApplication,
  orgId: string,
  user: Client,
  role: Role,
): Promise<void> {
  await prismaOf(app).membership.create({ data: { orgId, userId: user.userId, role } });
}

export interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  errors?: { field: string; message: string }[];
  requestId?: string;
}

/**
 * The worker process's module (validation + deployments) with its background loops disabled:
 * tests call the relay, processor and reconciler directly, so every step is deterministic.
 */
export async function createTestWorker(env: Record<string, string> = {}): Promise<TestingModule> {
  const worker = await Test.createTestingModule({ imports: [WorkerModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(testConfig(env))
    .overrideProvider(DeployWorker)
    .useValue({})
    .overrideProvider(ValidationWorker)
    .useValue({})
    .overrideProvider(EventsWorker)
    .useValue({})
    .overrideProvider(DriftScheduler)
    .useValue({})
    .overrideProvider(CanaryScheduler)
    .useValue({})
    .compile();
  await worker.init();
  return worker;
}

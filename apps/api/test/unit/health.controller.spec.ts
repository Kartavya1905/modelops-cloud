import type { Server } from 'node:http';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { APP_CONFIG, type AppConfig } from '../../src/config/config';
import { HealthController } from '../../src/health/health.controller';
import { HealthService } from '../../src/health/health.service';
import {
  DEPENDENCY_CHECKS,
  type DependencyCheck,
  type ReadinessReport,
} from '../../src/health/health.types';
import { setupApp } from '../../src/setup-app';

/**
 * Boots the real controller + service + HTTP conventions (`/api/v1` prefix, status codes)
 * with fake dependency checks, so routing and status mapping are tested without Docker.
 */
async function bootWith(checks: DependencyCheck[]): Promise<INestApplication> {
  const config: AppConfig = {
    host: '127.0.0.1',
    port: 0,
    databaseUrl: 'postgresql://unused',
    redisUrl: 'redis://unused',
    healthCheckTimeoutMs: 50,
    sessionPepper: 'x'.repeat(64),
    cookieSecure: false,
    webUrl: 'http://127.0.0.1:3300',
    apiDocsEnabled: false,
    mlflowUrl: 'http://127.0.0.1:15000',
    mlflowTimeoutMs: 1000,
  };
  const moduleRef = await Test.createTestingModule({
    controllers: [HealthController],
    providers: [
      HealthService,
      { provide: APP_CONFIG, useValue: config },
      { provide: DEPENDENCY_CHECKS, useValue: checks },
    ],
  }).compile();
  const app = setupApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }));
  await app.init();
  return app;
}

/** Typed supertest client (Nest's getHttpServer() is typed as `any`). */
function http(app: INestApplication) {
  return request(app.getHttpServer() as Server);
}

describe('HealthController (HTTP)', () => {
  let app: INestApplication | undefined;
  afterEach(async () => {
    await app?.close();
  });

  it('GET /api/v1/health/live returns 200', async () => {
    app = await bootWith([]);
    const res = await http(app).get('/api/v1/health/live');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok' });
  });

  it('GET /api/v1/health/ready returns 200 when every dependency is up', async () => {
    app = await bootWith([
      { name: 'postgres', check: () => Promise.resolve() },
      { name: 'redis', check: () => Promise.resolve() },
    ]);
    const res = await http(app).get('/api/v1/health/ready');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'ok',
      checks: { postgres: { status: 'up' }, redis: { status: 'up' } },
    });
  });

  it('GET /api/v1/health/ready returns 503 and names the failing dependency', async () => {
    app = await bootWith([
      { name: 'postgres', check: () => Promise.resolve() },
      { name: 'redis', check: () => Promise.reject(new Error('ECONNREFUSED')) },
    ]);
    const res = await http(app).get('/api/v1/health/ready');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      status: 'error',
      checks: { postgres: { status: 'up' }, redis: { status: 'down', error: 'ECONNREFUSED' } },
    });
  });

  it('GET /api/v1/health/ready returns 503 when a dependency hangs (timeout)', async () => {
    app = await bootWith([{ name: 'postgres', check: () => new Promise(() => undefined) }]);
    const res = await http(app).get('/api/v1/health/ready');
    expect(res.status).toBe(503);
    const body = res.body as ReadinessReport;
    expect(body.checks.postgres?.error).toMatch(/timed out/);
  });

  it('unversioned paths are not served', async () => {
    app = await bootWith([]);
    const res = await http(app).get('/health/live');
    expect(res.status).toBe(404);
  });
});

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Redis } from 'ioredis';
import { Client } from 'pg';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    redisUrl: string;
    gatewayUrl: string;
    gatewayAdminUrl: string;
    instanceId: string;
  }
}

const GATEWAY = 'modelops-gateway-test';
const docker = (...args: string[]) =>
  execFileSync('docker', args, { stdio: 'pipe', encoding: 'utf8' }).trim();

function removeTestContainers(instanceId: string): void {
  const ids = docker('ps', '-aq', '--filter', `label=modelops.instance=${instanceId}`)
    .split(/\s+/)
    .filter(Boolean);
  if (ids.length) docker('rm', '-f', ...ids);
  try {
    docker('rm', '-f', GATEWAY);
  } catch {
    // not running
  }
}

/**
 * A gateway of our own for the test run (M5): same image as the dev stack's, but reading the
 * test Redis database, on its own ports, joined to the internal `inference` network so it can
 * reach the model servers the tests deploy.
 */
function startTestGateway(redisUrl: URL): void {
  const password = decodeURIComponent(redisUrl.password);
  docker(
    'run',
    '-d',
    '--name',
    GATEWAY,
    '--network',
    'modelops-backend',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '-p',
    '127.0.0.1:18098:8080',
    '-p',
    '127.0.0.1:18099:8081',
    '-e',
    `REDIS_URL=redis://:${password}@redis:6379/15`,
    '-e',
    `MO_API_KEY_PEPPER=${process.env.MO_API_KEY_PEPPER ?? ''}`,
    '-e',
    `MO_GATEWAY_INTERNAL_TOKEN=${process.env.MO_GATEWAY_INTERNAL_TOKEN ?? ''}`,
    '-e',
    'MO_GATEWAY_ROUTING_POLL_MS=500',
    '-e',
    'LOG_LEVEL=warn',
    'modelops/gateway:dev',
  );
  docker('network', 'connect', 'modelops-inference', GATEWAY);
}

async function waitFor(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // still starting
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${url} did not become healthy`);
}

/**
 * 1. Creates an empty database `modelops_test_<timestamp>` (the app role has CREATEDB in dev/CI).
 * 2. Applies the real migrations with `prisma migrate deploy` (so migrations are tested too).
 * 3. Points Redis at logical DB 15 and flushes it.
 * 4. Starts a test gateway container on the test Redis database (M5).
 * 5. Drops the database and removes test containers afterwards, even if tests failed.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const envFile = join(process.cwd(), '..', '..', '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const baseUrl = process.env.DATABASE_URL;
  const baseRedis = process.env.REDIS_URL;
  if (!baseUrl || !baseRedis) {
    throw new Error('DATABASE_URL / REDIS_URL missing: run `pnpm env:init && pnpm dev:up` first');
  }

  const dbName = `modelops_test_${String(Date.now())}_${String(process.pid)}`;
  const admin = new Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${dbName}"`);
  await admin.end();

  const testUrl = new URL(baseUrl);
  testUrl.pathname = `/${dbName}`;
  execFileSync(
    process.execPath,
    [join('node_modules', 'prisma', 'build', 'index.js'), 'migrate', 'deploy'],
    { env: { ...process.env, DATABASE_URL: testUrl.toString() }, stdio: 'pipe' },
  );

  const redisUrl = new URL(baseRedis);
  redisUrl.pathname = '/15';
  const redis = new Redis(redisUrl.toString());
  await redis.flushdb();
  redis.disconnect();

  project.provide('databaseUrl', testUrl.toString());
  project.provide('redisUrl', redisUrl.toString());

  // M5: a test-scoped data plane. Containers carry this instance id, so neither the dev stack's
  // reconciler nor ours ever touches the other's model servers.
  const instanceId = `test-${String(process.pid)}`;
  removeTestContainers(instanceId);
  startTestGateway(redisUrl);
  await waitFor('http://127.0.0.1:18099/healthz', 30_000);
  project.provide('gatewayUrl', 'http://127.0.0.1:18098');
  project.provide('gatewayAdminUrl', 'http://127.0.0.1:18099');
  project.provide('instanceId', instanceId);

  return async () => {
    removeTestContainers(instanceId);
    const c = new Client({ connectionString: baseUrl });
    await c.connect();
    await c.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await c.end();
  };
}

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
  }
}

/**
 * 1. Creates an empty database `modelops_test_<timestamp>` (the app role has CREATEDB in dev/CI).
 * 2. Applies the real migrations with `prisma migrate deploy` (so migrations are tested too).
 * 3. Points Redis at logical DB 15 and flushes it.
 * 4. Drops the database afterwards, even if tests failed.
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

  return async () => {
    const c = new Client({ connectionString: baseUrl });
    await c.connect();
    await c.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await c.end();
  };
}

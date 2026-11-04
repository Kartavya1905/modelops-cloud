import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import { APP_CONFIG, type AppConfig } from '../../config/config';
import type { DependencyCheck } from '../health.types';

/**
 * Milestone 1 uses a tiny dedicated pool for the readiness probe.
 * From Milestone 2 the check moves onto Prisma's connection.
 */
@Injectable()
export class PostgresCheck implements DependencyCheck, OnModuleDestroy {
  readonly name = 'postgres';
  private readonly pool: Pool;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.pool = new Pool({
      connectionString: config.databaseUrl,
      max: 2,
      connectionTimeoutMillis: config.healthCheckTimeoutMs,
      idleTimeoutMillis: 30_000,
    });
    // An idle client losing its connection must not crash the process.
    this.pool.on('error', () => undefined);
  }

  async check(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}

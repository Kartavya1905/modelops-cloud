import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { APP_CONFIG, type AppConfig } from '../../config/config';
import { PrismaClient } from '../../generated/prisma/client';

/**
 * The single database client for the API process.
 * Prisma 7 talks to Postgres through the `pg` driver adapter (no Rust query engine).
 * Connections are opened lazily on first query.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    super({ adapter: new PrismaPg({ connectionString: config.databaseUrl, max: 10 }) });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

/** The transaction client handed to `$transaction(async (tx) => ...)` callbacks. */
export type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

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

/** Prisma error codes that mean "the database could not be used right now", not "bad data". */
const UNAVAILABLE_CODES = new Set([
  'P1001', // can't reach the database server
  'P1002', // the server was reached but timed out
  'P1008', // operation timed out
  'P1017', // the server closed the connection
  'P2024', // timed out fetching a connection from the pool
  'P2028', // transaction API error (e.g. the transaction expired while the server was frozen)
]);
const UNAVAILABLE_MESSAGE =
  /Connection terminated|ECONNRESET|ECONNREFUSED|EPIPE|timeout exceeded when trying to connect|Can't reach database|Transaction API error|Unable to start a transaction|server closed the connection/i;

/**
 * True when an error says the database is unavailable (M9 chaos: a paused Postgres expired an
 * interactive transaction). Such errors are infrastructure trouble to retry, never a verdict on
 * the thing being processed: a deploy must not FAIL because Postgres hiccuped.
 */
export function isDatabaseUnavailable(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; name?: unknown; message?: unknown };
  if (typeof e.code === 'string' && UNAVAILABLE_CODES.has(e.code)) return true;
  if (e.name === 'PrismaClientInitializationError') return true;
  return typeof e.message === 'string' && UNAVAILABLE_MESSAGE.test(e.message);
}

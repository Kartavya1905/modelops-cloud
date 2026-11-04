import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { APP_CONFIG, type AppConfig } from '../../config/config';
import type { DependencyCheck } from '../health.types';

@Injectable()
export class RedisCheck implements DependencyCheck, OnModuleDestroy {
  readonly name = 'redis';
  private readonly client: Redis;
  private readonly logger = new Logger(RedisCheck.name);
  private lastErrorLoggedAt = 0;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.client = new Redis(config.redisUrl, {
      connectTimeout: config.healthCheckTimeoutMs,
      maxRetriesPerRequest: 1,
      // Fail fast while disconnected instead of queueing commands until Redis returns.
      enableOfflineQueue: false,
      lazyConnect: false,
    });
    this.client.on('error', (err: Error) => {
      // ioredis retries forever; log at most once per 30 s instead of flooding the console.
      const now = Date.now();
      if (now - this.lastErrorLoggedAt > 30_000) {
        this.lastErrorLoggedAt = now;
        this.logger.warn(`Redis connection problem: ${err.message}`);
      }
    });
  }

  async check(): Promise<void> {
    // ioredis rejects on error or when disconnected (offline queue disabled).
    await this.client.ping();
  }

  onModuleDestroy(): void {
    this.client.disconnect();
  }
}

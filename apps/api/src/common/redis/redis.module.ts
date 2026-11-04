import { Global, Inject, Logger, Module, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { APP_CONFIG, type AppConfig } from '../../config/config';

export const REDIS = Symbol('REDIS');

function createRedis(config: AppConfig): Redis {
  const logger = new Logger('Redis');
  let lastErrorLoggedAt = 0;
  const client = new Redis(config.redisUrl, {
    connectTimeout: config.healthCheckTimeoutMs,
    maxRetriesPerRequest: 1,
    // Fail fast while disconnected instead of queueing commands until Redis returns.
    enableOfflineQueue: false,
  });
  client.on('error', (err: Error) => {
    // ioredis reconnects forever; log at most once per 30 s instead of flooding the console.
    const now = Date.now();
    if (now - lastErrorLoggedAt > 30_000) {
      lastErrorLoggedAt = now;
      logger.warn(`Redis connection problem: ${err.message}`);
    }
  });
  return client;
}

/** One shared Redis connection for the API process (health checks, rate limits). */
@Global()
@Module({
  providers: [{ provide: REDIS, useFactory: createRedis, inject: [APP_CONFIG] }],
  exports: [REDIS],
})
export class RedisModule implements OnModuleDestroy {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  onModuleDestroy(): void {
    this.redis.disconnect();
  }
}

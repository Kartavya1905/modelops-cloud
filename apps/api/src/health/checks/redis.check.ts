import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS } from '../../common/redis/redis.module';
import type { DependencyCheck } from '../health.types';

/** PINGs the shared Redis connection (rejects immediately while disconnected). */
@Injectable()
export class RedisCheck implements DependencyCheck {
  readonly name = 'redis';

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async check(): Promise<void> {
    await this.redis.ping();
  }
}

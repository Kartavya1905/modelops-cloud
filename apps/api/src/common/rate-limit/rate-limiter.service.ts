import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS } from '../redis/redis.module';

export interface LimitState {
  blocked: boolean;
  retryAfterSeconds: number;
}

/**
 * Fixed-window failure counter in Redis (used for login brute-force protection).
 *
 * If Redis is unavailable the limiter **fails open** (logs a warning, allows the request):
 * an outage of the cache must not lock every user out. Argon2's cost still slows guessing.
 */
@Injectable()
export class RateLimiterService {
  private readonly logger = new Logger(RateLimiterService.name);

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async check(key: string, limit: number): Promise<LimitState> {
    try {
      const [count, ttl] = await Promise.all([this.redis.get(key), this.redis.ttl(key)]);
      const n = count ? Number(count) : 0;
      return n >= limit
        ? { blocked: true, retryAfterSeconds: Math.max(ttl, 1) }
        : { blocked: false, retryAfterSeconds: 0 };
    } catch (err) {
      this.logger.warn(`rate limiter unavailable, failing open: ${(err as Error).message}`);
      return { blocked: false, retryAfterSeconds: 0 };
    }
  }

  async recordFailure(key: string, windowSeconds: number): Promise<void> {
    try {
      const n = await this.redis.incr(key);
      if (n === 1) await this.redis.expire(key, windowSeconds);
    } catch (err) {
      this.logger.warn(`rate limiter unavailable: ${(err as Error).message}`);
    }
  }

  async reset(key: string): Promise<void> {
    try {
      await this.redis.del(key);
    } catch {
      // best effort
    }
  }
}

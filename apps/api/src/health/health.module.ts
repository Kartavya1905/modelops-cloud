import { Module } from '@nestjs/common';
import { PostgresCheck } from './checks/postgres.check';
import { RedisCheck } from './checks/redis.check';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { DEPENDENCY_CHECKS, type DependencyCheck } from './health.types';

@Module({
  controllers: [HealthController],
  providers: [
    PostgresCheck,
    RedisCheck,
    {
      provide: DEPENDENCY_CHECKS,
      useFactory: (pg: PostgresCheck, redis: RedisCheck): DependencyCheck[] => [pg, redis],
      inject: [PostgresCheck, RedisCheck],
    },
    HealthService,
  ],
})
export class HealthModule {}

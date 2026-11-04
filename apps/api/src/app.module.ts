import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ProblemFilter } from './common/errors/problem.filter';
import { PrismaModule } from './common/prisma/prisma.module';
import { RedisModule } from './common/redis/redis.module';
import { ConfigModule } from './config/config.module';
import { HealthModule } from './health/health.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { ProjectsModule } from './modules/projects/projects.module';

/**
 * Modular monolith (ADR-0001). Infrastructure modules are global; feature modules talk to
 * each other only through exported services.
 */
@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    RedisModule,
    AuditModule,
    AuthModule,
    HealthModule,
    OrganizationsModule,
    ProjectsModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: ProblemFilter }],
})
export class AppModule {}

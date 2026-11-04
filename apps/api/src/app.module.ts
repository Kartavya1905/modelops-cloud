import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ProblemFilter } from './common/errors/problem.filter';
import { PrismaModule } from './common/prisma/prisma.module';
import { RedisModule } from './common/redis/redis.module';
import { ArtifactStoreModule } from './common/storage/artifact-store';
import { ConfigModule } from './config/config.module';
import { HealthModule } from './health/health.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { ExperimentsModule } from './modules/experiments/experiments.module';
import { MlflowModule } from './modules/mlflow/mlflow.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { RegistryModule } from './modules/registry/registry.module';
import { ValidationModule } from './modules/validation/validation.module';

/**
 * Modular monolith (ADR-0001). Infrastructure modules are global; feature modules talk to
 * each other only through exported services.
 */
@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    RedisModule,
    ArtifactStoreModule,
    AuditModule,
    AuthModule,
    HealthModule,
    OrganizationsModule,
    ProjectsModule,
    MlflowModule,
    ExperimentsModule,
    ValidationModule,
    RegistryModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: ProblemFilter }],
})
export class AppModule {}

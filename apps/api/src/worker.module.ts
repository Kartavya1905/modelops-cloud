import { Module } from '@nestjs/common';
import { PrismaModule } from './common/prisma/prisma.module';
import { RedisModule } from './common/redis/redis.module';
import { ArtifactStoreModule } from './common/storage/artifact-store';
import { ConfigModule } from './config/config.module';
import { AuditModule } from './modules/audit/audit.module';
import { DeploymentsWorkerModule } from './modules/deployments/deployments.module';
import { MlflowModule } from './modules/mlflow/mlflow.module';
import { MonitoringWorkerModule } from './modules/monitoring/monitoring.module';
import { ValidationModule, ValidationWorkerModule } from './modules/validation/validation.module';

/** Everything the background worker process needs (validation + deployments), nothing HTTP. */
@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    RedisModule,
    ArtifactStoreModule,
    AuditModule,
    MlflowModule,
    ValidationModule,
    ValidationWorkerModule,
    DeploymentsWorkerModule,
    MonitoringWorkerModule,
  ],
})
export class WorkerModule {}

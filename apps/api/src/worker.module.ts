import { Module } from '@nestjs/common';
import { PrismaModule } from './common/prisma/prisma.module';
import { ArtifactStoreModule } from './common/storage/artifact-store';
import { ConfigModule } from './config/config.module';
import { AuditModule } from './modules/audit/audit.module';
import { MlflowModule } from './modules/mlflow/mlflow.module';
import { ValidationModule, ValidationWorkerModule } from './modules/validation/validation.module';

/** Everything the background worker process needs, and nothing HTTP-related. */
@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    ArtifactStoreModule,
    AuditModule,
    MlflowModule,
    ValidationModule,
    ValidationWorkerModule,
  ],
})
export class WorkerModule {}

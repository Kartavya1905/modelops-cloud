import { Global, Module } from '@nestjs/common';
import { MlflowClient } from './mlflow.client';

@Global()
@Module({
  providers: [MlflowClient],
  exports: [MlflowClient],
})
export class MlflowModule {}

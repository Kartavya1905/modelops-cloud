import { Global, Module } from '@nestjs/common';
import { ValidationController } from './validation.controller';
import { ValidationQueue } from './validation.queue';
import { ValidationService } from './validation.service';
import { ValidationWorker } from './validation.worker';

/** API side: report endpoints + queue producer (the registry enqueues new versions). */
@Global()
@Module({
  controllers: [ValidationController],
  providers: [ValidationQueue, ValidationService],
  exports: [ValidationQueue, ValidationService],
})
export class ValidationModule {}

/** Worker side: the queue consumer and sweeper. Imported only by the worker process. */
@Module({
  providers: [ValidationWorker],
  exports: [ValidationWorker],
})
export class ValidationWorkerModule {}

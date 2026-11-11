// Worker process entrypoint (ADR-0001: same codebase as the API, separate process).
// Runs background jobs (M4: model validation) so slow work never blocks HTTP requests.
//   node dist/worker.js
import './tracing'; // M10: must load before anything it instruments
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigError, loadConfig } from './config/config';
import { WorkerModule } from './worker.module';

async function bootstrap(): Promise<void> {
  loadConfig(); // fail fast with a readable message on a bad .env
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  Logger.log('worker started', 'Worker');
}

bootstrap().catch((err: unknown) => {
  console.error(err instanceof ConfigError ? err.message : err);
  process.exit(1);
});

import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ConfigError, loadConfig } from './config/config';
import { setupApp } from './setup-app';

async function bootstrap(): Promise<void> {
  // Validate configuration before Nest starts, so a bad .env gives one clear error.
  const config = loadConfig();
  const app = setupApp(await NestFactory.create(AppModule));
  await app.listen(config.port, config.host);
  Logger.log(`API listening on http://${config.host}:${config.port}/api/v1`, 'Bootstrap');
}

bootstrap().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    console.error(err.message);
  } else {
    console.error(err);
  }
  process.exit(1);
});

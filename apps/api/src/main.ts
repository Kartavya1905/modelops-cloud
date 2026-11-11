import './tracing'; // M10: must load before anything it instruments
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { ConfigError, loadConfig } from './config/config';
import { buildOpenApiDocument } from './openapi/document';
import { setupApp } from './setup-app';

async function bootstrap(): Promise<void> {
  // Validate configuration before Nest starts, so a bad .env gives one clear error.
  const config = loadConfig();
  const app = setupApp(await NestFactory.create<NestExpressApplication>(AppModule));
  if (config.apiDocsEnabled) {
    SwaggerModule.setup('api/docs', app, buildOpenApiDocument(app));
  }
  await app.listen(config.port, config.host);
  Logger.log(`API listening on http://${config.host}:${config.port}/api/v1`, 'Bootstrap');
  if (config.apiDocsEnabled) {
    Logger.log(`API docs at http://${config.host}:${config.port}/api/docs`, 'Bootstrap');
  }
}

bootstrap().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    console.error(err.message);
  } else {
    console.error(err);
  }
  process.exit(1);
});

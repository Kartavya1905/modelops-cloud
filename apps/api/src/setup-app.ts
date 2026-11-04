import { VersioningType, type INestApplication } from '@nestjs/common';

/**
 * HTTP conventions shared by the real server and the integration tests,
 * so tests exercise exactly the same routes (`/api/v1/...`).
 */
export function setupApp(app: INestApplication): INestApplication {
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.enableShutdownHooks();
  return app;
}

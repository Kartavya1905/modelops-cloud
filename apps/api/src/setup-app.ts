import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { requestIdMiddleware } from './common/request-context/request-context';
import { createValidationPipe } from './common/validation';

/**
 * HTTP conventions shared by the real server, the OpenAPI emitter and the tests,
 * so all three see exactly the same routes and behaviour.
 */
export function setupApp<T extends NestExpressApplication>(app: T): T {
  // The web app's Next.js server proxies /api on the same machine; trust its X-Forwarded-For
  // so req.ip is the browser's address (used for rate limiting and hashed audit metadata).
  app.set('trust proxy', 'loopback');
  app.disable('x-powered-by');
  app.use(requestIdMiddleware);
  app.use(cookieParser());
  app.useBodyParser('json', { limit: '256kb' });
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(createValidationPipe());
  app.enableShutdownHooks();
  return app;
}

import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';

/** The management API contract (docs/04). Committed as packages/api-contract/openapi.json. */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('ModelOps Cloud — Management API')
    .setDescription(
      'Control-plane API. Errors use RFC 9457 problem+json. Mutating requests made with a ' +
        'session cookie must send the `X-CSRF-Token` header returned by `/api/v1/auth/me`.',
    )
    .setVersion('1')
    .addCookieAuth('mo_session', { type: 'apiKey', in: 'cookie', name: 'mo_session' }, 'session')
    .build();
  return SwaggerModule.createDocument(app, config, {
    operationIdFactory: (controllerKey, methodKey) =>
      `${controllerKey.replace(/Controller$/, '')}_${methodKey}`,
  });
}

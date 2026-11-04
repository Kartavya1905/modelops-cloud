// Writes the OpenAPI document to the path given as the first argument.
//   node dist/openapi/emit.js ../../packages/api-contract/openapi.json
// Runs Nest in "preview" mode: modules and routes are scanned but no provider is instantiated,
// so no database, Redis or .env is needed (CI uses this to detect contract drift).
import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '../app.module';
import { setupApp } from '../setup-app';
import { buildOpenApiDocument } from './document';

async function main(): Promise<void> {
  const out = process.argv[2];
  if (!out) throw new Error('usage: emit.js <output.json>');
  const app = setupApp(
    await NestFactory.create<NestExpressApplication>(AppModule, { preview: true, logger: false }),
  );
  const doc = buildOpenApiDocument(app);
  writeFileSync(resolve(out), `${JSON.stringify(doc, null, 2)}\n`);
  await app.close();
  console.log(`openapi: wrote ${Object.keys(doc.paths).length} paths to ${out}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

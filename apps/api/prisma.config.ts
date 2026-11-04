// Prisma 7 CLI configuration (migrations, generate, studio).
// Prisma does not load .env files itself, so the repo-wide `.env` is loaded here.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'prisma/config';

const rootEnv = join(__dirname, '..', '..', '.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.DATABASE_URL ?? '' },
});

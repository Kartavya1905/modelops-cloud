import { z } from 'zod';

/**
 * Typed, validated runtime configuration.
 * The process refuses to start with a clear message if a variable is missing or malformed,
 * instead of failing later with a confusing connection error.
 */
const ConfigSchema = z.object({
  MO_API_HOST: z.string().min(1).default('127.0.0.1'),
  MO_PORT_API: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  MO_HEALTH_CHECK_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(2000),
});

export interface AppConfig {
  host: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  healthCheckTimeoutMs: number;
}

export const APP_CONFIG = Symbol('APP_CONFIG');

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    // Report variable names and problems only; never echo values (they may be secrets).
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new ConfigError(`Invalid configuration. Did you run \`pnpm env:init\`?\n${problems}`);
  }
  const c = parsed.data;
  return {
    host: c.MO_API_HOST,
    port: c.MO_PORT_API,
    databaseUrl: c.DATABASE_URL,
    redisUrl: c.REDIS_URL,
    healthCheckTimeoutMs: c.MO_HEALTH_CHECK_TIMEOUT_MS,
  };
}

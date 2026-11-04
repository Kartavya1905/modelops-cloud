import { z } from 'zod';

/**
 * Typed, validated runtime configuration.
 * The process refuses to start with a clear message if a variable is missing or malformed,
 * instead of failing later with a confusing connection error.
 */
const booleanString = (defaultValue: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(defaultValue)
    .transform((v) => v === 'true');

const ConfigSchema = z.object({
  MO_API_HOST: z.string().min(1).default('127.0.0.1'),
  MO_PORT_API: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  MO_HEALTH_CHECK_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(2000),
  MO_API_SESSION_PEPPER: z.string().min(32, 'must be at least 32 characters'),
  MO_COOKIE_SECURE: booleanString('false'),
  MO_WEB_URL: z.url().default('http://127.0.0.1:3300'),
  MO_API_DOCS: booleanString('true'),
});

export interface AppConfig {
  host: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  healthCheckTimeoutMs: number;
  /** Server-side secret for CSRF token derivation and IP hashing. */
  sessionPepper: string;
  cookieSecure: boolean;
  webUrl: string;
  apiDocsEnabled: boolean;
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
    sessionPepper: c.MO_API_SESSION_PEPPER,
    cookieSecure: c.MO_COOKIE_SECURE,
    webUrl: c.MO_WEB_URL,
    apiDocsEnabled: c.MO_API_DOCS,
  };
}

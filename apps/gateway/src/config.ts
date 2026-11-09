export interface GatewayConfig {
  redisUrl: string;
  apiKeyPepper: string;
  internalToken: string;
  port: number;
  adminPort: number;
  /** How long a verified key is trusted without re-reading Redis (bounds revocation delay). */
  keyCacheMs: number;
  upstreamTimeoutMs: number;
  maxBatch: number;
  bodyLimitBytes: number;
  routingPollMs: number;
  /** Only model servers named like this are reachable (no open proxy). */
  upstreamPattern: RegExp;
}

function int(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number) {
  const raw = env[name];
  const v = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(v) || v < min || v > max)
    throw new Error(`${name} must be ${String(min)}-${String(max)}`);
  return v;
}

function secret(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v || v.length < 32) throw new Error(`${name} must be set (at least 32 characters)`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const redisUrl = env.REDIS_URL;
  if (!redisUrl?.startsWith('redis')) throw new Error('REDIS_URL must be a redis:// URL');
  return {
    redisUrl,
    apiKeyPepper: secret(env, 'MO_API_KEY_PEPPER'),
    internalToken: secret(env, 'MO_GATEWAY_INTERNAL_TOKEN'),
    port: int(env, 'PORT', 8080, 1, 65535),
    adminPort: int(env, 'ADMIN_PORT', 8081, 1, 65535),
    keyCacheMs: int(env, 'MO_GATEWAY_KEY_CACHE_MS', 30_000, 0, 300_000),
    upstreamTimeoutMs: int(env, 'MO_GATEWAY_UPSTREAM_TIMEOUT_MS', 2_000, 50, 60_000),
    maxBatch: int(env, 'MO_GATEWAY_MAX_BATCH', 64, 1, 1024),
    bodyLimitBytes: int(env, 'MO_GATEWAY_BODY_LIMIT_BYTES', 256 * 1024, 1024, 10 * 1024 * 1024),
    routingPollMs: int(env, 'MO_GATEWAY_ROUTING_POLL_MS', 15_000, 100, 600_000),
    upstreamPattern: /^mo-rev-[0-9a-f-]{36}$/,
  };
}

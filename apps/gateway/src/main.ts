// Inference gateway entrypoint: `node dist/main.js` (in the gateway container).
import { Redis } from 'ioredis';
import { buildAdminApp, buildPublicApp, createMetrics } from './app.js';
import { loadConfig } from './config.js';
import { type ApiKeyEntry, DP, type RoutingSnapshot } from './contract.js';
import { RateLimiter } from './guards.js';
import { KeyVerifier } from './keys.js';
import { RoutingTable } from './routing.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
  const sub = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  redis.on('error', () => undefined);
  sub.on('error', () => undefined);

  const routing = new RoutingTable({
    load: async () => {
      const raw = await redis.get(DP.routingKey);
      return raw ? (JSON.parse(raw) as RoutingSnapshot) : null;
    },
  });
  const keys = new KeyVerifier(
    {
      getEntry: async (prefix) => {
        const raw = await redis.get(`${DP.apiKeyPrefix}${prefix}`);
        return raw ? (JSON.parse(raw) as ApiKeyEntry) : null;
      },
    },
    config.apiKeyPepper,
    config.keyCacheMs,
  );
  const metrics = createMetrics();
  const limiter = new RateLimiter(
    {
      incr: async (key, ttlMs) => {
        const [[, n]] = (await redis.multi().incr(key).pexpire(key, ttlMs).exec()) as [
          [null, number],
        ];
        return n;
      },
    },
    () => metrics.rateLimitFailOpen.inc(),
  );

  const refresh = () =>
    routing.refresh().catch((err: unknown) => {
      // Keep serving the last good table while Redis is away.
      console.warn(JSON.stringify({ event: 'routing.refresh_failed', error: String(err) }));
      return false;
    });
  await sub.subscribe(DP.routingChannel, DP.apiKeyChannel).catch(() => undefined);
  sub.on('message', (channel: string, message: string) => {
    if (channel === DP.routingChannel) void refresh();
    if (channel === DP.apiKeyChannel) keys.evict(message);
  });
  // Re-subscribing after a reconnect is automatic in ioredis; the poll covers missed messages.
  await refresh();
  setInterval(() => void refresh(), config.routingPollMs).unref();

  const deps = {
    config,
    routing,
    keys,
    limiter,
    redisReady: () => redis.status === 'ready',
  };
  const pub = buildPublicApp(deps, metrics);
  const admin = buildAdminApp(deps, metrics);
  await pub.listen({ host: '0.0.0.0', port: config.port });
  await admin.listen({ host: '0.0.0.0', port: config.adminPort });

  const shutdown = async () => {
    await Promise.allSettled([pub.close(), admin.close()]);
    redis.disconnect();
    sub.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

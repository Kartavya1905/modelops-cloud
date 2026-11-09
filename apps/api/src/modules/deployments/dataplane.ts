import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { PrismaService } from '../../common/prisma/prisma.service';
import { REDIS } from '../../common/redis/redis.module';
import { containerName } from './runtime/runtime-driver';

/**
 * The control plane -> data plane contract (docs/02 §3, docs/05 §4).
 * The gateway (apps/gateway/src/contract.ts mirrors these names) never calls the API or Postgres:
 * it reads a FULL routing snapshot and an API-key directory from Redis, and is told to reload by
 * pub/sub. Snapshots, not deltas, so out-of-order or lost messages can't corrupt routing; the
 * reconciler re-publishes everything every 15 s.
 */
export const DP = {
  routingKey: 'mo:routing:snapshot',
  routingChannel: 'mo:routing:changed',
  apiKeyPrefix: 'mo:apikey:',
  apiKeyChannel: 'mo:apikeys:changed',
} as const;

export interface RoutedRevision {
  id: string;
  /** Model server on the internal network (`http://mo-rev-<id>:8000`). */
  url: string;
  modelVersionId: string;
  modelName: string;
  modelVersion: number;
  framework: string;
  /** Request validation: exactly these feature names, in this order. */
  features: string[];
  classes: (number | string)[];
}

export interface RoutedEndpoint {
  endpointId: string;
  orgId: string;
  projectId: string;
  slug: string;
  rateLimitRps: number;
  /** null: the endpoint exists but nothing is READY (the gateway answers 503, not 404). */
  revision: RoutedRevision | null;
}

export interface RoutingSnapshot {
  /** sha256 of `endpoints`, so publishers can skip no-op updates. */
  hash: string;
  generatedAt: string;
  /** keyed by `<projectId>/<slug>`: an API key is project-scoped, so this is its lookup path. */
  endpoints: Record<string, RoutedEndpoint>;
}

export interface ApiKeyEntry {
  id: string;
  orgId: string;
  projectId: string;
  /** hex HMAC-SHA256(pepper, secret) */
  hash: string;
  scopes: string[];
  expiresAt: string | null;
  revoked: boolean;
}

interface SignatureJson {
  inputs: { features?: string[] }[];
  outputs: { name: string; classes?: (number | string)[] }[];
}

/** Builds snapshots from Postgres (the truth) and publishes them to Redis. */
@Injectable()
export class DataPlanePublisher {
  private readonly logger = new Logger(DataPlanePublisher.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async buildRouting(): Promise<RoutingSnapshot> {
    const endpoints = await this.prisma.endpoint.findMany({
      orderBy: { id: 'asc' },
      include: {
        stableRevision: {
          include: { modelVersion: { include: { model: { select: { name: true } } } } },
        },
      },
    });
    const out: Record<string, RoutedEndpoint> = {};
    for (const e of endpoints) {
      // Only a READY revision receives traffic (docs/05 §7 "Safety"); DEGRADED is healing.
      const rev = e.stableRevision?.state === 'READY' ? e.stableRevision : null;
      const sig = rev?.modelVersion.signature as unknown as SignatureJson | undefined;
      out[`${e.projectId}/${e.slug}`] = {
        endpointId: e.id,
        orgId: e.orgId,
        projectId: e.projectId,
        slug: e.slug,
        rateLimitRps: e.rateLimitRps,
        revision:
          rev && sig
            ? {
                id: rev.id,
                url: `http://${containerName(rev.id)}:8000`,
                modelVersionId: rev.modelVersionId,
                modelName: rev.modelVersion.model.name,
                modelVersion: rev.modelVersion.version,
                framework: rev.modelVersion.framework,
                features: sig.inputs[0]?.features ?? [],
                classes: sig.outputs.find((o) => o.classes)?.classes ?? [0, 1],
              }
            : null,
      };
    }
    const hash = createHash('sha256').update(JSON.stringify(out)).digest('hex');
    return { hash, generatedAt: new Date().toISOString(), endpoints: out };
  }

  /** Publishes the routing snapshot if it changed (or always, when `force`). Best effort. */
  async publishRouting(force = false): Promise<boolean> {
    try {
      const snap = await this.buildRouting();
      if (!force) {
        const current = await this.redis.get(DP.routingKey);
        if (current && (JSON.parse(current) as RoutingSnapshot).hash === snap.hash) return false;
      }
      await this.redis.set(DP.routingKey, JSON.stringify(snap));
      await this.redis.publish(DP.routingChannel, snap.hash);
      return true;
    } catch (err) {
      // The reconciler retries every 15 s; the gateway keeps its last table meanwhile.
      this.logger.warn(`routing snapshot not published: ${(err as Error).message}`);
      return false;
    }
  }

  async publishApiKey(prefix: string, entry: ApiKeyEntry): Promise<void> {
    await this.redis.set(`${DP.apiKeyPrefix}${prefix}`, JSON.stringify(entry));
    await this.redis.publish(DP.apiKeyChannel, prefix);
  }

  /** Full sync of the key directory from Postgres (reconciler): repairs lost writes. */
  async syncApiKeys(): Promise<number> {
    const keys = await this.prisma.apiKey.findMany({
      select: {
        id: true,
        orgId: true,
        projectId: true,
        prefix: true,
        secretHash: true,
        scopes: true,
        expiresAt: true,
        revokedAt: true,
      },
    });
    if (keys.length === 0) return 0;
    const pipeline = this.redis.pipeline();
    for (const k of keys) pipeline.set(`${DP.apiKeyPrefix}${k.prefix}`, JSON.stringify(entryOf(k)));
    await pipeline.exec();
    return keys.length;
  }
}

export function entryOf(k: {
  id: string;
  orgId: string;
  projectId: string;
  secretHash: Uint8Array;
  scopes: string[];
  expiresAt: Date | null;
  revokedAt: Date | null;
}): ApiKeyEntry {
  return {
    id: k.id,
    orgId: k.orgId,
    projectId: k.projectId,
    hash: Buffer.from(k.secretHash).toString('hex'),
    scopes: k.scopes,
    expiresAt: k.expiresAt?.toISOString() ?? null,
    revoked: k.revokedAt !== null,
  };
}

import { Inject, Injectable } from '@nestjs/common';
import { hmacBase64Url } from '../../common/crypto';
import { decodeCursor, encodeCursor, type Page } from '../../common/pagination';
import type { Tx } from '../../common/prisma/prisma.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { ActorContext } from '../../common/request-context/request-context';
import { APP_CONFIG, type AppConfig } from '../../config/config';
import type { Prisma } from '../../generated/prisma/client';

export interface AuditRecord {
  orgId: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  /** Small, non-sensitive facts only: never request bodies, passwords, tokens, raw IPs. */
  metadata?: Prisma.InputJsonObject;
}

export interface AuditEventView {
  id: string;
  actorType: 'USER' | 'API_KEY' | 'SYSTEM';
  actor: { id: string; name: string; email: string } | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Prisma.JsonValue;
  requestId: string | null;
  createdAt: string;
}

/**
 * Writes and reads the append-only audit log.
 * `record` takes the caller's transaction client, so an audit row is committed if and only if
 * the change it describes is committed.
 */
@Injectable()
export class AuditService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Raw IPs are personal data; a keyed hash still lets us correlate events from the same address. */
  hashIp(ip: string | undefined): string | null {
    return ip ? hmacBase64Url(this.config.sessionPepper, `ip:${ip}`).slice(0, 22) : null;
  }

  async record(
    tx: Tx,
    actor: ActorContext | { userId: null; requestId: string | undefined; ip: string | undefined },
    event: AuditRecord,
  ): Promise<void> {
    await tx.auditEvent.create({
      data: {
        orgId: event.orgId,
        actorType: actor.userId ? 'USER' : 'SYSTEM',
        actorId: actor.userId,
        action: event.action,
        targetType: event.targetType ?? null,
        targetId: event.targetId ?? null,
        metadata: event.metadata ?? {},
        requestId: actor.requestId ?? null,
        ipHash: this.hashIp(actor.ip),
      },
    });
  }

  async list(
    orgId: string,
    query: { limit: number; cursor?: string | undefined; action?: string | undefined },
  ): Promise<Page<AuditEventView>> {
    const before = query.cursor ? BigInt(decodeCursor(query.cursor, ['id']).id) : undefined;
    const rows = await this.prisma.auditEvent.findMany({
      where: {
        orgId,
        ...(query.action && { action: query.action }),
        ...(before !== undefined && { id: { lt: before } }),
      },
      orderBy: { id: 'desc' },
      take: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);

    const actorIds = [...new Set(page.map((r) => r.actorId).filter((id): id is string => !!id))];
    const users = await this.prisma.user.findMany({
      where: { id: { in: actorIds } },
      select: { id: true, name: true, email: true },
    });
    const byId = new Map(users.map((u) => [u.id, u]));

    const last = page.at(-1);
    return {
      data: page.map((r) => ({
        id: r.id.toString(),
        actorType: r.actorType,
        actor: r.actorId ? (byId.get(r.actorId) ?? null) : null,
        action: r.action,
        targetType: r.targetType,
        targetId: r.targetId,
        metadata: r.metadata,
        requestId: r.requestId,
        createdAt: r.createdAt.toISOString(),
      })),
      nextCursor:
        rows.length > query.limit && last ? encodeCursor({ id: last.id.toString() }) : null,
    };
  }
}

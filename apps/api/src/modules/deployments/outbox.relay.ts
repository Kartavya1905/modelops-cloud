import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { DeployQueue } from './deploy.queue';
import { transition } from './transition';

export const OUTBOX_DEPLOY = 'deployment.requested';

/**
 * Transactional outbox relay (ADR-0004, docs/02 §3). The API never talks to Redis when a deploy
 * is requested: it commits the revision and an outbox row together. This relay then:
 *   1. claims undispatched rows (FOR UPDATE SKIP LOCKED, so several relays never collide),
 *   2. moves each revision REQUESTED -> QUEUED and marks the row dispatched (same transaction),
 *   3. after the commit, enqueues `deploy-<revisionId>` (deduplicated by job id).
 * A crash between 2 and 3 leaves a QUEUED revision without a job: the reconciler re-enqueues it.
 */
@Injectable()
export class OutboxRelay {
  private readonly logger = new Logger(OutboxRelay.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: DeployQueue,
  ) {}

  async runOnce(batch = 20): Promise<number> {
    const toEnqueue = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string; type: string; aggregate_id: string }[]>`
        SELECT id, type, aggregate_id FROM outbox_messages
        WHERE dispatched_at IS NULL
        ORDER BY created_at
        LIMIT ${batch}
        FOR UPDATE SKIP LOCKED`;
      const ids: string[] = [];
      for (const row of rows) {
        if (row.type === OUTBOX_DEPLOY) {
          const rev = await tx.deploymentRevision.findUnique({ where: { id: row.aggregate_id } });
          if (rev?.state === 'REQUESTED') {
            await transition(tx, rev, 'QUEUED', { message: 'Queued for the deployment worker' });
          }
          // Already QUEUED or beyond (a previous relay crashed after committing): still enqueue,
          // the job id makes it a no-op. Cancelled/failed: the processor ignores it.
          ids.push(row.aggregate_id);
        }
        await tx.outboxMessage.update({
          where: { id: row.id },
          data: { dispatchedAt: new Date(), attempts: { increment: 1 } },
        });
      }
      return ids;
    });
    for (const id of toEnqueue) await this.queue.enqueue(id);
    if (toEnqueue.length) this.logger.debug(`dispatched ${String(toEnqueue.length)} deployment(s)`);
    return toEnqueue.length;
  }
}

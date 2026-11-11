import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { PrismaService } from '../../common/prisma/prisma.service';
import { REDIS } from '../../common/redis/redis.module';
import { APP_CONFIG, type AppConfig } from '../../config/config';
import type { DeploymentRevision } from '../../generated/prisma/client';
import { DataPlanePublisher } from './dataplane';
import { DeployProcessor } from './deploy.processor';
import { DeployQueue } from './deploy.queue';
import { ModelServerProbe } from './probe';
import { RUNTIME_DRIVER, type RuntimeDriver } from './runtime/runtime-driver';
import { IN_PROGRESS, RUNNING } from './state-machine';
import { transition } from './transition';

const RESTART_BUDGET = 3;
const RESTART_WINDOW_MS = 10 * 60_000;
// A RUNNING container must fail MO_UNHEALTHY_STREAK health checks in a row (one per reconcile,
// every MO_RECONCILE_MS; default 3, as docs/05 specifies) before it counts as hung.

export interface ReconcileReport {
  timedOut: number;
  requeued: number;
  degraded: number;
  /** running model servers that failed a check but stay in service (streak below the limit) */
  slow: number;
  recovered: number;
  restarted: number;
  retired: number;
  approvalsExpired: number;
  orphansRemoved: number;
  routingPublished: boolean;
}

/**
 * Desired state (Postgres) vs actual state (runtime), every MO_RECONCILE_MS (docs/05 §5).
 * Every action is idempotent and guarded by CAS, so two reconcilers running at once are safe;
 * the Redis lock only avoids wasted work.
 */
@Injectable()
export class Reconciler {
  private readonly logger = new Logger(Reconciler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly processor: DeployProcessor,
    private readonly queue: DeployQueue,
    private readonly probe: ModelServerProbe,
    private readonly dataplane: DataPlanePublisher,
    @Inject(RUNTIME_DRIVER) private readonly driver: RuntimeDriver,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Returns null if another instance holds the lock. */
  async runOnce(opts: { lockMs?: number } = {}): Promise<ReconcileReport | null> {
    const lockMs = opts.lockMs ?? 14_000;
    const got = await this.redis.set('mo:reconciler:lock', String(process.pid), 'PX', lockMs, 'NX');
    if (got !== 'OK') return null;
    try {
      return await this.reconcile();
    } finally {
      await this.redis.del('mo:reconciler:lock').catch(() => undefined);
    }
  }

  async reconcile(): Promise<ReconcileReport> {
    const report: ReconcileReport = {
      timedOut: 0,
      requeued: 0,
      degraded: 0,
      recovered: 0,
      restarted: 0,
      slow: 0,
      retired: 0,
      approvalsExpired: 0,
      orphansRemoved: 0,
      routingPublished: false,
    };
    const now = new Date();

    // 1. Liveness: anything past its state deadline fails (and is cleaned up).
    const late = await this.prisma.deploymentRevision.findMany({
      where: {
        state: { in: IN_PROGRESS.filter((st) => st !== 'AWAITING_APPROVAL') },
        stateDeadlineAt: { lt: now },
      },
    });
    for (const rev of late) {
      await this.processor.fail(rev, 'TIMEOUT', `stuck in ${rev.state} past its deadline`);
      report.timedOut++;
    }

    // 1b. Approvals nobody decided within 24 h expire: the deployment is cancelled, not failed.
    const unanswered = await this.prisma.deploymentRevision.findMany({
      where: { state: 'AWAITING_APPROVAL', stateDeadlineAt: { lt: now } },
    });
    for (const rev of unanswered) {
      const moved = await this.prisma.$transaction(async (tx) => {
        const r = await transition(tx, rev, 'CANCELLED', {
          message: 'Approval expired: nobody decided within 24 hours',
          data: { failureCode: 'APPROVAL_EXPIRED' },
        });
        if (r) {
          await tx.approval.updateMany({
            where: { revisionId: rev.id, status: 'PENDING' },
            data: { status: 'EXPIRED' },
          });
        }
        return r;
      });
      if (moved) report.approvalsExpired++;
    }

    // 2. Lost jobs (Redis restart, crash after the relay committed): re-enqueue, deduplicated.
    const active = await this.prisma.deploymentRevision.findMany({
      where: { state: { in: ['QUEUED', 'PROVISIONING', 'LOADING', 'VERIFYING'] } },
      select: { id: true, updatedAt: true },
    });
    for (const rev of active) {
      if (now.getTime() - rev.updatedAt.getTime() < 10_000) continue; // let the live job work
      if (await this.queue.enqueue(rev.id)) report.requeued++;
    }

    // 3. Serving revisions: health, self-healing with a restart budget, draining -> retired.
    const actual = new Map((await this.driver.list()).map((c) => [c.revisionId, c]));
    const serving = await this.prisma.deploymentRevision.findMany({
      where: { state: { in: ['READY', 'DEGRADED', 'DRAINING'] } },
    });
    for (const rev of serving) {
      const container = actual.get(rev.id);
      const running = container?.state === 'running';
      if (rev.state === 'DRAINING') {
        if (rev.drainUntil && rev.drainUntil < now) {
          await this.driver.remove(rev.id);
          await this.prisma.$transaction((tx) =>
            transition(tx, rev, 'RETIRED', { message: 'Grace period over; container removed' }),
          );
          report.retired++;
        }
        continue;
      }
      const healthy = running && (await this.probe.ready(rev.id).catch(() => false));
      if (rev.state === 'READY' && healthy) {
        if (rev.healthFailures > 0) await this.setHealthFailures(rev.id, 0);
      } else if (rev.state === 'READY' && !running) {
        // Crashed or gone: nothing to wait for.
        await this.degrade(rev, container ? `container ${container.state}` : 'container missing');
        report.degraded++;
        report.restarted += (await this.restart(rev.id)) ? 1 : 0;
      } else if (rev.state === 'READY') {
        // Running but not answering. Under overload a model server is slow, not dead (found by
        // the M12 ramp benchmark): keep it serving while the gateway sheds load, and treat it as
        // hung only after MO_UNHEALTHY_STREAK failed checks in a row.
        const streak = rev.healthFailures + 1;
        const limit = this.config.deploy.unhealthyStreak;
        if (streak < limit) {
          await this.setHealthFailures(rev.id, streak);
          report.slow++;
          this.logger.warn(
            `health check failed for running ${rev.id} (${String(streak)}/${String(limit)}); still serving`,
          );
        } else {
          await this.degrade(
            rev,
            `container running, ${String(streak)} checks in a row without an answer`,
          );
          report.degraded++;
          report.restarted += (await this.restart(rev.id)) ? 1 : 0;
        }
      } else if (rev.state === 'DEGRADED') {
        if (healthy) {
          await this.prisma.$transaction((tx) =>
            transition(tx, rev, 'READY', { message: 'Recovered: health checks passing again' }),
          );
          report.recovered++;
        } else if (!running) {
          report.restarted += (await this.restart(rev.id)) ? 1 : 0;
        }
      }
    }

    // 4. Orphans: managed containers whose revision is not supposed to be running.
    const wanted = new Set(
      (
        await this.prisma.deploymentRevision.findMany({
          where: { id: { in: [...actual.keys()] }, state: { in: [...RUNNING] } },
          select: { id: true },
        })
      ).map((r) => r.id),
    );
    for (const id of actual.keys()) {
      if (!wanted.has(id)) {
        await this.driver.remove(id);
        report.orphansRemoved++;
      }
    }

    // 5. Data plane: rebuild from Postgres, publish if it differs; re-sync the key directory.
    report.routingPublished = await this.dataplane.publishRouting();
    await this.dataplane.syncApiKeys().catch(() => 0);
    await this.prisma.idempotencyKey.deleteMany({ where: { expiresAt: { lt: now } } });
    return report;
  }

  private async setHealthFailures(revisionId: string, healthFailures: number): Promise<void> {
    await this.prisma.deploymentRevision.update({
      where: { id: revisionId },
      data: { healthFailures },
    });
  }

  private async degrade(rev: DeploymentRevision, why: string): Promise<void> {
    const moved = await this.prisma.$transaction((tx) =>
      transition(tx, rev, 'DEGRADED', {
        message: `Health check failed: ${why}`,
        data: { healthFailures: 0 }, // the streak led here; a recovery starts a new one
      }),
    );
    if (moved) await this.dataplane.publishRouting(true); // stop routing to it right away
  }

  /** Recreates the container (fresh presigned URL) within the budget, else FAILED. */
  private async restart(revisionId: string): Promise<boolean> {
    const rev = await this.prisma.deploymentRevision.findUniqueOrThrow({
      where: { id: revisionId },
      include: { modelVersion: { select: { artifactSha256: true, signature: true } } },
    });
    const now = Date.now();
    const windowOpen =
      rev.restartWindowStart && now - rev.restartWindowStart.getTime() < RESTART_WINDOW_MS;
    const count = windowOpen ? rev.restartCount : 0;
    if (count >= RESTART_BUDGET) {
      await this.processor.fail(
        rev,
        'RESTART_BUDGET_EXHAUSTED',
        `${String(RESTART_BUDGET)} restarts within 10 minutes`,
      );
      return false;
    }
    await this.prisma.deploymentRevision.update({
      where: { id: rev.id },
      data: {
        restartCount: count + 1,
        restartWindowStart: windowOpen ? rev.restartWindowStart : new Date(now),
      },
    });
    await this.driver.remove(rev.id);
    await this.processor.ensureContainer(
      rev,
      rev.modelVersion.artifactSha256 ?? '',
      rev.modelVersion.signature,
    );
    this.logger.warn(
      `restarted container for ${rev.id} (${String(count + 1)}/${String(RESTART_BUDGET)})`,
    );
    return true;
  }
}

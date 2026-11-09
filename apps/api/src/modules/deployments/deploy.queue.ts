import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { APP_CONFIG, type AppConfig } from '../../config/config';
import { bullConnection } from '../validation/validation.queue';

export const DEPLOY_QUEUE = 'deploy';
export interface DeployJob {
  revisionId: string;
}

/**
 * Deterministic job id `deploy-<revisionId>` (docs/05 §4 "Queue"): re-dispatch by the relay or the
 * reconciler is a no-op while a job for that revision exists. Only the worker process enqueues:
 * the API writes an outbox row in its transaction instead (ADR-0004).
 */
@Injectable()
export class DeployQueue implements OnModuleDestroy {
  private readonly logger = new Logger(DeployQueue.name);
  private readonly connection: Redis;
  readonly queue: Queue<DeployJob>;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.connection = bullConnection(config);
    this.connection.on('error', () => undefined);
    this.queue = new Queue<DeployJob>(DEPLOY_QUEUE, { connection: this.connection });
  }

  static jobId(revisionId: string): string {
    return `deploy-${revisionId}`;
  }

  async enqueue(revisionId: string): Promise<boolean> {
    try {
      await this.queue.add(
        'deploy',
        { revisionId },
        {
          jobId: DeployQueue.jobId(revisionId),
          attempts: 5,
          // 2 s x 2^n, bounded by the state deadline (docs/05 §3)
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
      return true;
    } catch (err) {
      this.logger.warn(`could not enqueue deploy ${revisionId}: ${(err as Error).message}`);
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
    this.connection.disconnect();
  }
}

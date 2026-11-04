import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { APP_CONFIG, type AppConfig } from '../../config/config';

export const VALIDATION_QUEUE = 'validate';

export interface ValidationJob {
  versionId: string;
}

/** BullMQ needs `maxRetriesPerRequest: null` on its connections (blocking commands). */
export function bullConnection(config: AppConfig): Redis {
  return new Redis(config.redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: false });
}

/**
 * Producer side of the validation queue (used by the API and the sweeper).
 *
 * Delivery is at-least-once and *duplicates are harmless*: the job id is derived from the version
 * id, so re-enqueueing a version that is already queued is a no-op, and the processor claims a
 * version with a compare-and-set, so a duplicate that slips through does nothing.
 * The database status is the source of truth: if Redis loses a job, the sweeper re-enqueues it.
 */
@Injectable()
export class ValidationQueue implements OnModuleDestroy {
  private readonly logger = new Logger(ValidationQueue.name);
  private readonly connection: Redis;
  readonly queue: Queue<ValidationJob>;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.connection = bullConnection(config);
    this.connection.on('error', () => undefined);
    this.queue = new Queue<ValidationJob>(VALIDATION_QUEUE, { connection: this.connection });
  }

  static jobId(versionId: string): string {
    return `validate-${versionId}`;
  }

  /** Best effort: failures are logged, the sweeper guarantees the version is eventually picked up. */
  async enqueue(versionId: string): Promise<boolean> {
    try {
      await this.queue.add(
        'validate',
        { versionId },
        {
          jobId: ValidationQueue.jobId(versionId),
          attempts: this.config.validation.maxAttempts,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
      return true;
    } catch (err) {
      this.logger.warn(`could not enqueue validation for ${versionId}: ${(err as Error).message}`);
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
    this.connection.disconnect();
  }
}

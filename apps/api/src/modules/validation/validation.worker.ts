import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { type Job, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { APP_CONFIG, type AppConfig } from '../../config/config';
import {
  bullConnection,
  VALIDATION_QUEUE,
  type ValidationJob,
  ValidationQueue,
} from './validation.queue';
import { ValidationService } from './validation.service';

/**
 * Consumer side, started only in the worker process (src/worker.ts), never in the HTTP API.
 * Also runs the sweeper that makes the queue's at-least-once delivery effectively reliable.
 */
@Injectable()
export class ValidationWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ValidationWorker.name);
  private worker?: Worker<ValidationJob>;
  private connection?: Redis;
  private sweepTimer?: NodeJS.Timeout;
  private sweeping = false;

  constructor(
    private readonly validation: ValidationService,
    private readonly queue: ValidationQueue,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.connection = bullConnection(this.config);
    this.connection.on('error', () => undefined);
    this.worker = new Worker<ValidationJob>(
      VALIDATION_QUEUE,
      async (job: Job<ValidationJob>) => {
        const attempts = job.opts.attempts ?? 1;
        const isFinal = job.attemptsMade + 1 >= attempts;
        await this.validation.process(job.data.versionId, isFinal);
      },
      { connection: this.connection, concurrency: 2, lockDuration: 120_000 },
    );
    this.worker.on('failed', (job, err) => {
      this.logger.warn(
        `validation job ${job?.id ?? '?'} attempt ${String(job?.attemptsMade ?? 0)} failed: ${err.message}`,
      );
    });
    this.sweepTimer = setInterval(() => void this.sweepOnce(), this.config.validation.sweepMs);
    void this.sweepOnce();
    this.logger.log(
      `validation worker started (sweep every ${String(this.config.validation.sweepMs)} ms)`,
    );
  }

  async sweepOnce(): Promise<{ reclaimed: number; enqueued: number } | null> {
    if (this.sweeping) return null;
    this.sweeping = true;
    try {
      const r = await this.validation.sweep((id) => this.queue.enqueue(id));
      if (r.reclaimed > 0)
        this.logger.warn(`reclaimed ${String(r.reclaimed)} validation(s) with expired leases`);
      return r;
    } catch (err) {
      this.logger.warn(`validation sweep failed: ${(err as Error).message}`);
      return null;
    } finally {
      this.sweeping = false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.sweepTimer);
    await this.worker?.close();
    this.connection?.disconnect();
  }
}

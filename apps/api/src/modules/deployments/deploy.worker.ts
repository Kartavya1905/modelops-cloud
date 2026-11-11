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
import { bullConnection } from '../validation/validation.queue';
import { DEPLOY_QUEUE, type DeployJob } from './deploy.queue';
import { DeployProcessor } from './deploy.processor';
import { OutboxRelay } from './outbox.relay';
import { Reconciler } from './reconciler';

/** Worker-process side of deployments: queue consumer + outbox relay loop + reconciler loop. */
@Injectable()
export class DeployWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DeployWorker.name);
  private worker?: Worker<DeployJob>;
  private connection?: Redis;
  private timers: NodeJS.Timeout[] = [];
  private busy = { relay: false, reconcile: false };

  constructor(
    private readonly processor: DeployProcessor,
    private readonly relay: OutboxRelay,
    private readonly reconciler: Reconciler,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.connection = bullConnection(this.config);
    this.connection.on('error', () => undefined);
    this.worker = new Worker<DeployJob>(
      DEPLOY_QUEUE,
      async (job: Job<DeployJob>) => {
        const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
        await this.processor.process(job.data.revisionId, { isFinalAttempt });
      },
      // The lock is renewed while a job runs (every lockMs / 2); a crashed worker's job is
      // redelivered once it expires and a live worker's stalled check sees it (M9 chaos test).
      {
        connection: this.connection,
        concurrency: 4,
        lockDuration: this.config.deploy.lockMs,
        stalledInterval: Math.min(30_000, this.config.deploy.lockMs),
      },
    );
    this.worker.on('failed', (job, err) => {
      this.logger.warn(`deploy job ${job?.id ?? '?'} failed: ${err.message}`);
    });
    this.every(this.config.deploy.relayMs, 'relay', () => this.relay.runOnce());
    this.every(this.config.deploy.reconcileMs, 'reconcile', () => this.reconciler.runOnce());
    this.logger.log(
      `deployment worker started (relay ${String(this.config.deploy.relayMs)} ms, reconcile ${String(this.config.deploy.reconcileMs)} ms)`,
    );
  }

  private every(ms: number, name: 'relay' | 'reconcile', fn: () => Promise<unknown>): void {
    const tick = async () => {
      if (this.busy[name]) return;
      this.busy[name] = true;
      try {
        await fn();
      } catch (err) {
        this.logger.warn(`${name} cycle failed: ${(err as Error).message}`);
      } finally {
        this.busy[name] = false;
      }
    };
    this.timers.push(setInterval(() => void tick(), ms));
    void tick();
  }

  async onModuleDestroy(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    await this.worker?.close();
    this.connection?.disconnect();
  }
}

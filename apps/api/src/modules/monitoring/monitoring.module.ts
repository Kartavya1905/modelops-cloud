import {
  Inject,
  Injectable,
  Logger,
  Module,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/config';
import { EvaluationController, EvaluationService } from '../evaluation/evaluation';
import { CaptureStore } from './capture-store';
import { EventsConsumer, EventsWorker } from './events.consumer';
import { MlWorkerClient } from './ml-worker.client';
import { MonitoringController } from './monitoring.controller';
import { MonitoringService } from './monitoring.service';

/** API side (M7): drift reports, measured performance, evaluations, the champion alias. */
@Module({
  controllers: [MonitoringController, EvaluationController],
  providers: [MonitoringService, CaptureStore, MlWorkerClient, EvaluationService],
})
export class MonitoringModule {}

/** Scheduled drift for endpoints with input capture on (every MO_DRIFT_INTERVAL_MS). */
@Injectable()
export class DriftScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DriftScheduler.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly monitoring: MonitoringService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      this.monitoring
        .scheduledDrift()
        .then((n) => n && this.logger.log(`scheduled drift: ${String(n)} report(s)`))
        .catch((err: unknown) => this.logger.warn(`scheduled drift failed: ${String(err)}`));
    }, this.config.monitoring.driftIntervalMs);
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }
}

/** Worker side (M7): the gateway event consumer, retention, scheduled drift. */
@Module({
  providers: [
    MonitoringService,
    CaptureStore,
    MlWorkerClient,
    EventsConsumer,
    EventsWorker,
    DriftScheduler,
  ],
  exports: [EventsConsumer, MonitoringService],
})
export class MonitoringWorkerModule {}

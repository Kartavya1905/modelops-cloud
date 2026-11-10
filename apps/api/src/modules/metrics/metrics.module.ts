import { Module } from '@nestjs/common';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';
import { PrometheusClient } from './prometheus';

/** M6: endpoint dashboards and the org overview, read from Prometheus via allow-listed queries. */
@Module({
  controllers: [MetricsController],
  providers: [MetricsService, PrometheusClient],
})
export class MetricsModule {}

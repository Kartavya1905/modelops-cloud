import { ApiProperty } from '@nestjs/swagger';

export class MetricPointValueDto {
  @ApiProperty({ description: 'Unix time in seconds' }) t!: number;
  @ApiProperty({ type: Number, nullable: true, description: 'null where there was no data' })
  v!: number | null;
}

export class MetricLineDto {
  @ApiProperty({ example: 'v4' }) name!: string;
  @ApiProperty({ type: [MetricPointValueDto] }) points!: MetricPointValueDto[];
}

export class MetricsSummaryDto {
  @ApiProperty({
    description: 'Exact requests in the range (counter difference, not extrapolated)',
  })
  requests!: number;
  @ApiProperty({ description: 'Requests answered 5xx in the range' }) serverErrors!: number;
  @ApiProperty({
    description: 'Requests answered 4xx in the range (bad inputs, rate limits, keys)',
  })
  clientErrors!: number;
  @ApiProperty({ description: 'Playground calls included in `requests`' }) playground!: number;
  @ApiProperty({ type: Number, nullable: true, description: 'Latest p95 latency (ms)' })
  p95Ms!: number | null;
  @ApiProperty({ description: 'Average requests per second over the range' }) avgRps!: number;
}

export class EndpointMetricsDto {
  @ApiProperty({ enum: ['15m', '1h', '6h', '24h'] }) range!: string;
  @ApiProperty({ description: 'Seconds between points' }) stepSeconds!: number;
  @ApiProperty() start!: number;
  @ApiProperty() end!: number;
  @ApiProperty({ type: MetricsSummaryDto }) summary!: MetricsSummaryDto;
  @ApiProperty({ type: [MetricLineDto], description: 'Requests/s by model version' })
  rps!: MetricLineDto[];
  @ApiProperty({ type: [MetricLineDto], description: 'p50 / p95 / p99 latency in ms' })
  latency!: MetricLineDto[];
  @ApiProperty({ type: [MetricLineDto], description: 'Share of requests answered 5xx (0-1)' })
  errorRate!: MetricLineDto[];
  @ApiProperty({ type: [MetricLineDto], description: 'Requests/s by HTTP status' })
  status!: MetricLineDto[];
}

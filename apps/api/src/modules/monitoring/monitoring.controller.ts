import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiProperty,
  ApiPropertyOptional,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { OrgAccessGuard, RequirePermission } from '../../common/authz/org-access.guard';
import { Errors } from '../../common/errors/app-error';
import { UuidParam } from '../../common/validation';
import { MonitoringService, PERFORMANCE_RANGES } from './monitoring.service';

export class RunDriftDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 168, description: 'Window to analyse; default 24' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(168)
  windowHours?: number;
}

class FeatureScoreDto {
  @ApiProperty() feature!: string;
  @ApiProperty({ enum: ['numerical', 'categorical'] }) kind!: string;
  @ApiProperty({ example: 'Wasserstein distance (normed)' }) method!: string;
  @ApiProperty() threshold!: number;
  @ApiProperty() score!: number;
  @ApiProperty() drifted!: boolean;
}

export class DriftReportDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) endpointId!: string;
  @ApiProperty({ format: 'uuid' }) modelVersionId!: string;
  @ApiProperty({ format: 'uuid' }) referenceDatasetVersionId!: string;
  @ApiProperty({ format: 'date-time' }) windowStart!: string;
  @ApiProperty({ format: 'date-time' }) windowEnd!: string;
  @ApiProperty() sampleCount!: number;
  @ApiProperty({ description: 'At least half the features drifted' }) datasetDrift!: boolean;
  @ApiProperty() driftShare!: number;
  @ApiProperty({ type: [FeatureScoreDto] }) features!: FeatureScoreDto[];
  @ApiProperty() evidentlyVersion!: string;
  @ApiProperty({ enum: ['manual', 'scheduled'] }) trigger!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

class PerformancePointDto {
  @ApiProperty() labelled!: number;
  @ApiProperty({ type: Number, nullable: true }) accuracy!: number | null;
  @ApiProperty({ type: Number, nullable: true }) f1!: number | null;
  @ApiProperty({ type: Number, nullable: true }) rocAuc!: number | null;
}
class PerformanceBucketDto extends PerformancePointDto {
  @ApiProperty({ format: 'date-time' }) start!: string;
}
export class PerformanceDto {
  @ApiProperty({ enum: ['24h', '7d'] }) range!: string;
  @ApiProperty() positiveClass!: string;
  @ApiProperty({ description: 'Predictions recorded in the range (labelled or not)' })
  predictions!: number;
  @ApiProperty({ type: PerformancePointDto }) summary!: PerformancePointDto;
  @ApiProperty({ type: [PerformanceBucketDto] }) buckets!: PerformanceBucketDto[];
}

@ApiTags('monitoring')
@ApiCookieAuth('session')
@UseGuards(OrgAccessGuard)
@Controller('orgs/:orgId/endpoints/:endpointId')
export class MonitoringController {
  constructor(private readonly monitoring: MonitoringService) {}

  @Get('drift-reports')
  @RequirePermission('monitoring:read')
  @ApiOkResponse({ type: [DriftReportDto], description: 'Newest first (up to 30)' })
  list(
    @Param('orgId', new UuidParam('Organization')) orgId: string,
    @Param('endpointId', new UuidParam('Endpoint')) endpointId: string,
  ) {
    return this.monitoring.listDrift(orgId, endpointId);
  }

  @Post('drift-reports')
  @RequirePermission('monitoring:run')
  @ApiCreatedResponse({ type: DriftReportDto, description: 'Evidently data drift, run now' })
  run(
    @Param('orgId', new UuidParam('Organization')) orgId: string,
    @Param('endpointId', new UuidParam('Endpoint')) endpointId: string,
    @Body() dto: RunDriftDto,
  ) {
    return this.monitoring.runDrift(orgId, endpointId, {
      trigger: 'manual',
      ...(dto.windowHours ? { windowHours: dto.windowHours } : {}),
    });
  }

  @Get('performance')
  @RequirePermission('monitoring:read')
  @ApiQuery({ name: 'range', required: false, enum: Object.keys(PERFORMANCE_RANGES) })
  @ApiOkResponse({ type: PerformanceDto })
  performance(
    @Param('orgId', new UuidParam('Organization')) orgId: string,
    @Param('endpointId', new UuidParam('Endpoint')) endpointId: string,
    @Query('range') range: string | undefined,
  ) {
    const r = range ?? '24h';
    if (!(r in PERFORMANCE_RANGES)) {
      throw Errors.validation([{ field: 'range', message: 'must be 24h or 7d' }]);
    }
    return this.monitoring.performance(orgId, endpointId, r as keyof typeof PERFORMANCE_RANGES);
  }
}

import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiExtraModels, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { OrgAccessGuard, RequirePermission } from '../../common/authz/org-access.guard';
import { UuidParam } from '../../common/validation';
import {
  CompareQuery,
  ExperimentDto,
  MetricPointDto,
  RunComparisonDto,
  RunDetailDto,
  RunPageDto,
  RunsQuery,
} from './experiments.dto';
import { ExperimentsService } from './experiments.service';

const OrgId = () => Param('orgId', new UuidParam('Organization'));
const ProjectId = () => Param('projectId', new UuidParam('Project'));

@ApiTags('experiments')
// MetricPointDto is only referenced by $ref inside RunDetailDto.series, so register it explicitly.
@ApiExtraModels(MetricPointDto)
@ApiCookieAuth('session')
@UseGuards(OrgAccessGuard)
@Controller('orgs/:orgId/projects/:projectId')
export class ExperimentsController {
  constructor(private readonly experiments: ExperimentsService) {}

  @Get('experiment')
  @RequirePermission('experiment:read')
  @ApiOkResponse({ type: ExperimentDto, description: 'Created in MLflow on first request.' })
  experiment(@OrgId() orgId: string, @ProjectId() projectId: string) {
    return this.experiments.describe(orgId, projectId);
  }

  @Get('runs')
  @RequirePermission('experiment:read')
  @ApiOkResponse({ type: RunPageDto })
  runs(@OrgId() orgId: string, @ProjectId() projectId: string, @Query() q: RunsQuery) {
    return this.experiments.listRuns(orgId, projectId, q);
  }

  // Declared before `runs/:runId` so "compare" is not captured as a run id.
  @Get('runs/compare')
  @RequirePermission('experiment:read')
  @ApiOkResponse({ type: RunComparisonDto })
  compare(@OrgId() orgId: string, @ProjectId() projectId: string, @Query() q: CompareQuery) {
    return this.experiments.compare(orgId, projectId, q.ids);
  }

  @Get('runs/:runId')
  @RequirePermission('experiment:read')
  @ApiOkResponse({ type: RunDetailDto })
  run(@OrgId() orgId: string, @ProjectId() projectId: string, @Param('runId') runId: string) {
    return this.experiments.getRun(orgId, projectId, runId);
  }
}

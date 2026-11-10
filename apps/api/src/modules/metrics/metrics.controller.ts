import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiProperty, ApiQuery, ApiTags } from '@nestjs/swagger';
import { OrgAccessGuard, RequirePermission } from '../../common/authz/org-access.guard';
import { Errors } from '../../common/errors/app-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import { UuidParam } from '../../common/validation';
import { REVISION_STATES } from '../deployments/deployments.dto';
import { EndpointMetricsDto } from './metrics.dto';
import { MetricsService } from './metrics.service';
import { RANGE_NAMES, SERIES_NAMES } from './series';

const OrgId = () => Param('orgId', new UuidParam('Organization'));

export class StateCountDto {
  @ApiProperty() state!: string;
  @ApiProperty() count!: number;
}

export class RecentDeploymentDto {
  @ApiProperty({ format: 'uuid' }) revisionId!: string;
  @ApiProperty() revisionNumber!: number;
  @ApiProperty({ enum: REVISION_STATES }) state!: (typeof REVISION_STATES)[number];
  @ApiProperty({ format: 'uuid' }) endpointId!: string;
  @ApiProperty() endpointName!: string;
  @ApiProperty() modelName!: string;
  @ApiProperty() modelVersion!: number;
  @ApiProperty({ type: String, nullable: true }) failureCode!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class OrgOverviewDto {
  @ApiProperty() projects!: number;
  @ApiProperty() models!: number;
  @ApiProperty({ type: [StateCountDto], description: 'Model versions by validation status' })
  versions!: StateCountDto[];
  @ApiProperty() endpoints!: number;
  @ApiProperty({ description: 'Endpoints whose stable revision is READY' })
  servingEndpoints!: number;
  @ApiProperty({ type: [StateCountDto], description: 'Revisions created in the last 7 days' })
  deployments7d!: StateCountDto[];
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Predict requests in the last 24 h across all endpoints (null: metrics unavailable)',
  })
  requests24h!: number | null;
  @ApiProperty({ type: [RecentDeploymentDto] }) recentDeployments!: RecentDeploymentDto[];
}

@ApiTags('metrics')
@ApiCookieAuth('session')
@UseGuards(OrgAccessGuard)
@Controller('orgs/:orgId')
export class MetricsController {
  constructor(
    private readonly metrics: MetricsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('endpoints/:endpointId/metrics')
  @RequirePermission('endpoint:read')
  @ApiQuery({ name: 'range', required: false, enum: RANGE_NAMES })
  @ApiQuery({
    name: 'series',
    required: false,
    description: `Comma-separated subset of: ${SERIES_NAMES.join(', ')}. No other parameters and no PromQL are accepted.`,
  })
  @ApiOkResponse({ type: EndpointMetricsDto })
  endpointMetrics(
    @OrgId() orgId: string,
    @Param('endpointId', new UuidParam('Endpoint')) endpointId: string,
    @Query() query: Record<string, unknown>,
  ) {
    return this.metrics.endpointMetrics(orgId, endpointId, query);
  }

  @Get('overview')
  @RequirePermission('org:read')
  @ApiOkResponse({ type: OrgOverviewDto })
  async overview(@OrgId() orgId: string): Promise<OrgOverviewDto> {
    const org = await this.prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) throw Errors.notFound('Organization');
    const since = new Date(Date.now() - 7 * 24 * 3600_000);
    const [projects, models, versions, endpoints, serving, deployments, recent] = await Promise.all(
      [
        this.prisma.project.count({ where: { orgId, archivedAt: null } }),
        this.prisma.registeredModel.count({ where: { orgId } }),
        this.prisma.modelVersion.groupBy({ by: ['status'], where: { orgId }, _count: true }),
        this.prisma.endpoint.findMany({ where: { orgId }, select: { id: true } }),
        this.prisma.endpoint.count({ where: { orgId, stableRevision: { state: 'READY' } } }),
        this.prisma.deploymentRevision.groupBy({
          by: ['state'],
          where: { orgId, createdAt: { gte: since } },
          _count: true,
        }),
        this.prisma.deploymentRevision.findMany({
          where: { orgId },
          orderBy: { createdAt: 'desc' },
          take: 8,
          include: {
            endpoint: { select: { name: true } },
            modelVersion: { select: { version: true, model: { select: { name: true } } } },
          },
        }),
      ],
    );
    let requests24h: number | null = 0;
    if (endpoints.length > 0) {
      requests24h = await this.metrics
        .count(
          endpoints.map((e) => e.id),
          24 * 3600,
          Math.floor(Date.now() / 1000),
        )
        .catch(() => null); // the overview still renders without Prometheus
    }
    return {
      projects,
      models,
      versions: versions.map((v) => ({ state: v.status, count: v._count })),
      endpoints: endpoints.length,
      servingEndpoints: serving,
      deployments7d: deployments.map((d) => ({ state: d.state, count: d._count })),
      requests24h,
      recentDeployments: recent.map((r) => ({
        revisionId: r.id,
        revisionNumber: r.revisionNumber,
        state: r.state,
        endpointId: r.endpointId,
        endpointName: r.endpoint.name,
        modelName: r.modelVersion.model.name,
        modelVersion: r.modelVersion.version,
        failureCode: r.failureCode,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  }
}

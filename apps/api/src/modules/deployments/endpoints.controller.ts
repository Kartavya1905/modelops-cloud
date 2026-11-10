import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { OrgAccessGuard, RequirePermission } from '../../common/authz/org-access.guard';
import {
  Actor,
  type ActorContext,
  CurrentMembership,
  type MembershipContext,
} from '../../common/request-context/request-context';
import { UuidParam } from '../../common/validation';
import {
  CreateEndpointDto,
  DeployDto,
  EndpointDetailDto,
  EndpointDto,
  RevisionDto,
  UpdateEndpointDto,
} from './deployments.dto';
import { EndpointsService } from './endpoints.service';

const OrgId = () => Param('orgId', new UuidParam('Organization'));

/**
 * The ETag versions the endpoint's *settings* (rowVersion) for `If-Match` on PATCH. It does not
 * cover the revisions embedded in the same body, so the response must never be revalidated with
 * `If-None-Match`: Express would answer 304 and a browser would keep showing the endpoint as it
 * was before a deploy. `no-store` keeps browsers from caching it at all; dropping the request's
 * `If-None-Match` keeps Express's freshness check from 304-ing other clients.
 */
function settingsEtag(req: Request, res: Response, rowVersion: number): void {
  delete req.headers['if-none-match'];
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('ETag', `W/"${String(rowVersion)}"`);
}

@ApiTags('deployments')
@ApiCookieAuth('session')
@UseGuards(OrgAccessGuard)
@Controller('orgs/:orgId')
export class EndpointsController {
  constructor(private readonly endpoints: EndpointsService) {}

  @Get('projects/:projectId/endpoints')
  @RequirePermission('endpoint:read')
  @ApiOkResponse({ type: [EndpointDto] })
  list(@OrgId() orgId: string, @Param('projectId', new UuidParam('Project')) projectId: string) {
    return this.endpoints.list(orgId, projectId);
  }

  @Post('projects/:projectId/endpoints')
  @RequirePermission('endpoint:create')
  @ApiCreatedResponse({ type: EndpointDto })
  create(
    @OrgId() orgId: string,
    @Param('projectId', new UuidParam('Project')) projectId: string,
    @Body() dto: CreateEndpointDto,
    @Actor() actor: ActorContext,
  ) {
    return this.endpoints.create(orgId, projectId, dto, actor);
  }

  @Get('endpoints/:endpointId')
  @RequirePermission('endpoint:read')
  @ApiOkResponse({ type: EndpointDetailDto })
  async get(
    @OrgId() orgId: string,
    @Param('endpointId', new UuidParam('Endpoint')) endpointId: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const e = await this.endpoints.get(orgId, endpointId);
    settingsEtag(req, res, e.rowVersion);
    return e;
  }

  @Patch('endpoints/:endpointId')
  @RequirePermission('endpoint:update')
  @ApiHeader({ name: 'If-Match', required: true, description: 'ETag from GET (W/"<rowVersion>")' })
  @ApiOkResponse({ type: EndpointDetailDto })
  async update(
    @OrgId() orgId: string,
    @Param('endpointId', new UuidParam('Endpoint')) endpointId: string,
    @Body() dto: UpdateEndpointDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Actor() actor: ActorContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    const e = await this.endpoints.update(orgId, endpointId, dto, ifMatch, actor);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('ETag', `W/"${String(e.rowVersion)}"`);
    return e;
  }

  @Post('endpoints/:endpointId/revisions')
  @RequirePermission('deployment:create')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      'Unique per deploy attempt (e.g. a UUID); a retry with the same key replays the answer',
  })
  @ApiAcceptedResponse({
    type: RevisionDto,
    description: 'Durably accepted (REQUESTED); poll the revision for progress',
  })
  async deploy(
    @OrgId() orgId: string,
    @Param('endpointId', new UuidParam('Endpoint')) endpointId: string,
    @Body() dto: DeployDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Actor() actor: ActorContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RevisionDto> {
    const out = await this.endpoints.deploy(orgId, endpointId, dto, idempotencyKey, actor);
    res.status(out.status);
    if (out.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return out.body;
  }

  @Get('revisions/:revisionId')
  @RequirePermission('endpoint:read')
  @ApiOkResponse({ type: RevisionDto, description: 'State, deadline and the full timeline' })
  revision(
    @OrgId() orgId: string,
    @Param('revisionId', new UuidParam('Revision')) revisionId: string,
  ) {
    return this.endpoints.getRevision(orgId, revisionId);
  }

  @Post('revisions/:revisionId/cancel')
  @HttpCode(200)
  @RequirePermission('deployment:cancel')
  @ApiOkResponse({ type: RevisionDto })
  cancel(
    @OrgId() orgId: string,
    @Param('revisionId', new UuidParam('Revision')) revisionId: string,
    @Actor() actor: ActorContext,
    @CurrentMembership() m: MembershipContext,
  ) {
    return this.endpoints.cancel(orgId, revisionId, actor, m.role);
  }
}

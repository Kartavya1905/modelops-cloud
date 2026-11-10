import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Injectable,
  Logger,
  Param,
  Post,
  Put,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiCookieAuth,
  ApiHeader,
  ApiOkResponse,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { OrgAccessGuard, RequirePermission } from '../../common/authz/org-access.guard';
import { Errors } from '../../common/errors/app-error';
import { PrismaService, type Tx } from '../../common/prisma/prisma.service';
import {
  Actor,
  type ActorContext,
  CurrentMembership,
  type MembershipContext,
} from '../../common/request-context/request-context';
import { UuidParam } from '../../common/validation';
import { APP_CONFIG, type AppConfig } from '../../config/config';
import { Prisma, type Endpoint, type Role } from '../../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import { expectedRowVersion, staleEtag } from './concurrency';
import { DataPlanePublisher } from './dataplane';
import {
  CanaryWeightDto,
  EndpointDetailDto,
  RevisionSummaryDto,
  RollbackDto,
} from './deployments.dto';
import { ADMIN_ROLES, EndpointsService } from './endpoints.service';
import { ModelServerProbe } from './probe';
import { revisionInclude, summary } from './revision-view';
import { transition } from './transition';

const OrgId = () => Param('orgId', new UuidParam('Organization'));

export const SYSTEM = { userId: null, requestId: undefined, ip: undefined } as const;
type Who = ActorContext | typeof SYSTEM;

export class RollbackResultDto {
  @ApiProperty({
    enum: ['fast', 'slow'],
    description:
      'fast: the target was still warm and took over the traffic in this request. ' +
      'slow: it was already retired, so a new revision of the same version is being deployed',
  })
  path!: 'fast' | 'slow';
  @ApiProperty({ type: RevisionSummaryDto }) revision!: RevisionSummaryDto;
}

/**
 * Releases (M8, docs/05 §6): canary weight, promote, abort and rollback. Every action is one
 * transaction that locks the endpoint row, checks the caller's ETag (If-Match), moves revisions
 * with compare-and-set, and bumps the endpoint version; then the full routing snapshot is
 * published, so the gateways switch within milliseconds (and the reconciler repairs a lost
 * message within 15 s).
 */
@Injectable()
export class ReleasesService {
  private readonly logger = new Logger(ReleasesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly dataplane: DataPlanePublisher,
    private readonly endpoints: EndpointsService,
    private readonly probe: ModelServerProbe,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Locks the endpoint and checks the ETag; `null` version skips the check (system actions). */
  private async lock(
    tx: Tx,
    orgId: string,
    endpointId: string,
    version: number | null,
    role: Role | null,
  ): Promise<Endpoint> {
    await tx.$queryRaw`SELECT id FROM endpoints WHERE id = ${endpointId}::uuid FOR UPDATE`;
    const e = await tx.endpoint.findFirst({ where: { id: endpointId, orgId } });
    if (!e) throw Errors.notFound('Endpoint');
    if (role && e.environment === 'PRODUCTION' && !ADMIN_ROLES.has(role)) {
      throw Errors.forbidden(
        'PRODUCTION_REQUIRES_ADMIN',
        'Only Owners and Admins can change traffic on a production endpoint.',
      );
    }
    if (version !== null && e.rowVersion !== version) throw staleEtag();
    return e;
  }

  private async canaryOf(tx: Tx, e: Endpoint) {
    if (!e.canaryRevisionId) {
      throw Errors.conflict('NO_CANARY', 'This endpoint has no canary right now.');
    }
    return tx.deploymentRevision.findUniqueOrThrow({ where: { id: e.canaryRevisionId } });
  }

  async setWeight(
    orgId: string,
    endpointId: string,
    dto: CanaryWeightDto,
    ifMatch: string | undefined,
    actor: ActorContext,
    role: Role,
  ): Promise<EndpointDetailDto> {
    const version = expectedRowVersion(ifMatch);
    await this.prisma.$transaction(async (tx) => {
      const e = await this.lock(tx, orgId, endpointId, version, role);
      const canary = await this.canaryOf(tx, e);
      await tx.endpoint.update({
        where: { id: e.id },
        data: {
          canaryWeight: dto.weight,
          // The analysis window starts when the canary first gets traffic, and restarts after 0.
          canaryStartedAt: dto.weight > 0 ? (e.canaryStartedAt ?? new Date()) : null,
          rowVersion: { increment: 1 },
        },
      });
      await tx.deploymentEvent.create({
        data: {
          orgId,
          revisionId: canary.id,
          fromState: canary.state,
          toState: canary.state,
          message: `Canary weight ${String(e.canaryWeight)}% -> ${String(dto.weight)}%`,
          metadata: { from: e.canaryWeight, to: dto.weight },
        },
      });
      await this.audit.record(tx, actor, {
        orgId,
        action: 'deployment.canary_weight_changed',
        targetType: 'deployment_revision',
        targetId: canary.id,
        metadata: { endpointId, from: e.canaryWeight, to: dto.weight },
      });
    });
    await this.dataplane.publishRouting(true);
    return this.endpoints.get(orgId, endpointId);
  }

  /** Canary -> stable. Only after a passing analysis: the evidence is the gate (docs/05 §6). */
  async promote(
    orgId: string,
    endpointId: string,
    ifMatch: string | undefined,
    actor: ActorContext,
    role: Role,
  ): Promise<EndpointDetailDto> {
    const version = expectedRowVersion(ifMatch);
    await this.prisma.$transaction(async (tx) => {
      const e = await this.lock(tx, orgId, endpointId, version, role);
      const canary = await this.canaryOf(tx, e);
      const latest = await tx.canaryCheck.findFirst({
        where: { revisionId: canary.id },
        orderBy: { createdAt: 'desc' },
      });
      if (latest?.verdict !== 'PASS' || canary.state !== 'READY') {
        throw Errors.conflict(
          'CANARY_NOT_ELIGIBLE',
          latest
            ? `The latest canary check is ${latest.verdict}. Promote needs a passing check.`
            : 'No canary check yet: wait for the analysis (or run one) before promoting.',
        );
      }
      const old = e.stableRevisionId
        ? await tx.deploymentRevision.findUnique({ where: { id: e.stableRevisionId } })
        : null;
      if (old && (old.state === 'READY' || old.state === 'DEGRADED')) {
        await transition(tx, old, 'DRAINING', {
          message: `Replaced by canary revision ${String(canary.revisionNumber)}; kept warm for rollback`,
          data: { drainUntil: new Date(Date.now() + this.config.deploy.drainGraceMs) },
        });
      }
      await tx.deploymentRevision.update({
        where: { id: canary.id },
        data: { stableAt: new Date() },
      });
      await tx.endpoint.update({
        where: { id: e.id },
        data: {
          stableRevisionId: canary.id,
          canaryRevisionId: null,
          canaryWeight: 0,
          canaryStartedAt: null,
          rowVersion: { increment: 1 },
        },
      });
      await tx.deploymentEvent.create({
        data: {
          orgId,
          revisionId: canary.id,
          fromState: 'READY',
          toState: 'READY',
          message: 'Promoted: now receiving all traffic',
          metadata: { checkId: latest.id },
        },
      });
      await this.audit.record(tx, actor, {
        orgId,
        action: 'deployment.promoted',
        targetType: 'deployment_revision',
        targetId: canary.id,
        metadata: { endpointId, replaced: old?.id ?? null, checkId: latest.id },
      });
    });
    await this.dataplane.publishRouting(true);
    return this.endpoints.get(orgId, endpointId);
  }

  /** Canary weight -> 0 and the canary drains (retired by the reconciler). */
  async abort(
    orgId: string,
    endpointId: string,
    who: Who,
    opts: { ifMatch?: string; role?: Role; reason: string; checkId?: string },
  ): Promise<EndpointDetailDto> {
    const version = who.userId === null ? null : expectedRowVersion(opts.ifMatch);
    await this.prisma.$transaction(async (tx) => {
      const e = await this.lock(tx, orgId, endpointId, version, opts.role ?? null);
      const canary = await this.canaryOf(tx, e);
      await this.abortInTx(tx, e, canary, who, opts.reason, opts.checkId);
    });
    await this.dataplane.publishRouting(true);
    return this.endpoints.get(orgId, endpointId);
  }

  private async abortInTx(
    tx: Tx,
    e: Endpoint,
    canary: Prisma.DeploymentRevisionGetPayload<object>,
    who: Who,
    reason: string,
    checkId?: string,
  ) {
    await tx.endpoint.update({
      where: { id: e.id },
      data: {
        canaryRevisionId: null,
        canaryWeight: 0,
        canaryStartedAt: null,
        rowVersion: { increment: 1 },
      },
    });
    if (canary.state === 'READY' || canary.state === 'DEGRADED') {
      // Nothing to roll back to on an aborted canary: it retires on the next reconcile.
      await transition(tx, canary, 'DRAINING', {
        message: `Canary aborted: ${reason}`,
        data: { drainUntil: new Date() },
        metadata: { reason, ...(checkId ? { checkId } : {}) },
      });
    }
    await this.audit.record(tx, who, {
      orgId: e.orgId,
      action: 'deployment.canary_aborted',
      targetType: 'deployment_revision',
      targetId: canary.id,
      metadata: { endpointId: e.id, reason, automatic: who.userId === null },
    });
  }

  /**
   * Back to an earlier revision (docs/05 §6). Fast path: it is still DRAINING and its container
   * answers, so one transaction swaps the pointers and traffic moves in this request. Slow path:
   * it was retired, so a new revision of the same (validated, previously approved) version goes
   * through the normal pipeline without a new approval. An active canary is aborted either way.
   */
  async rollback(
    orgId: string,
    endpointId: string,
    dto: RollbackDto,
    ifMatch: string | undefined,
    actor: ActorContext,
    role: Role,
  ): Promise<{ status: number; body: RollbackResultDto }> {
    const version = expectedRowVersion(ifMatch);
    const pre = await this.prisma.endpoint.findFirst({ where: { id: endpointId, orgId } });
    if (!pre) throw Errors.notFound('Endpoint');
    if (pre.environment === 'PRODUCTION' && !ADMIN_ROLES.has(role)) {
      throw Errors.forbidden(
        'PRODUCTION_REQUIRES_ADMIN',
        'Only Owners and Admins can change traffic on a production endpoint.',
      );
    }
    const target = await this.prisma.deploymentRevision.findFirst({
      where: {
        endpointId,
        // Only revisions that served as stable: an aborted canary is never a rollback target.
        stableAt: { not: null },
        state: { in: ['DRAINING', 'RETIRED'] },
        ...(dto.targetRevisionId ? { id: dto.targetRevisionId } : {}),
        NOT: { id: { in: [pre.stableRevisionId, pre.canaryRevisionId].filter((x) => x !== null) } },
      },
      orderBy: { stableAt: 'desc' },
    });
    if (!target) {
      throw Errors.conflict(
        'NO_ROLLBACK_TARGET',
        dto.targetRevisionId
          ? 'That revision cannot be rolled back to: it never served as the stable revision, or it is serving now.'
          : 'There is no earlier revision of this endpoint that served as the stable revision.',
      );
    }
    // Checked outside the transaction (a network call); re-checked by CAS inside it.
    const warm =
      target.state === 'DRAINING' && (await this.probe.ready(target.id).catch(() => false));

    let result: RollbackResultDto;
    try {
      result = await this.prisma.$transaction(async (tx) => {
        const e = await this.lock(tx, orgId, endpointId, version, role);
        const canary = e.canaryRevisionId
          ? await tx.deploymentRevision.findUnique({ where: { id: e.canaryRevisionId } })
          : null;
        if (canary) await this.abortInTx(tx, e, canary, actor, 'rollback requested');
        const current = e.stableRevisionId
          ? await tx.deploymentRevision.findUnique({ where: { id: e.stableRevisionId } })
          : null;
        const fresh = await tx.deploymentRevision.findUniqueOrThrow({ where: { id: target.id } });

        if (warm && fresh.state === 'DRAINING') {
          const back = await transition(tx, fresh, 'READY', {
            message: 'Rollback: serving again (it was still warm)',
            data: { drainUntil: null, stableAt: new Date() },
          });
          if (!back) throw Errors.conflict('INVALID_STATE_TRANSITION', 'Reload and try again.');
          if (current && (current.state === 'READY' || current.state === 'DEGRADED')) {
            await transition(tx, current, 'DRAINING', {
              message: `Rolled back to revision ${String(fresh.revisionNumber)}`,
              data: { drainUntil: new Date(Date.now() + this.config.deploy.drainGraceMs) },
            });
          }
          await tx.endpoint.update({
            where: { id: e.id },
            data: { stableRevisionId: fresh.id, rowVersion: { increment: 1 } },
          });
          await this.audit.record(tx, actor, {
            orgId,
            action: 'deployment.rolled_back',
            targetType: 'deployment_revision',
            targetId: fresh.id,
            metadata: { endpointId, from: current?.id ?? null, path: 'fast' },
          });
          const row = await tx.deploymentRevision.findUniqueOrThrow({
            where: { id: fresh.id },
            include: revisionInclude,
          });
          return { path: 'fast' as const, revision: summary(row) };
        }

        const rev = await this.endpoints.insertRevision(tx, {
          orgId,
          endpoint: e,
          modelVersionId: fresh.modelVersionId,
          strategy: 'IMMEDIATE',
          canaryWeight: null,
          rollbackOfId: fresh.id,
          actor,
        });
        await tx.endpoint.update({ where: { id: e.id }, data: { rowVersion: { increment: 1 } } });
        await this.audit.record(tx, actor, {
          orgId,
          action: 'deployment.rolled_back',
          targetType: 'deployment_revision',
          targetId: rev.id,
          metadata: { endpointId, from: current?.id ?? null, to: fresh.id, path: 'slow' },
        });
        const row = await tx.deploymentRevision.findUniqueOrThrow({
          where: { id: rev.id },
          include: revisionInclude,
        });
        return { path: 'slow' as const, revision: summary(row) };
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw Errors.conflict(
          'DEPLOYMENT_IN_PROGRESS',
          'A deployment is in progress on this endpoint. Cancel it, then roll back.',
        );
      }
      throw err;
    }
    await this.dataplane.publishRouting(true);
    this.logger.log(`endpoint ${endpointId} rolled back (${result.path})`);
    return { status: result.path === 'fast' ? 200 : 202, body: result };
  }
}

const IF_MATCH = {
  name: 'If-Match',
  required: true,
  description: 'ETag from GET /endpoints/{id} (W/"<rowVersion>"); a stale one is 412',
};

@ApiTags('releases')
@ApiCookieAuth('session')
@UseGuards(OrgAccessGuard)
@Controller('orgs/:orgId/endpoints/:endpointId')
export class ReleasesController {
  constructor(private readonly releases: ReleasesService) {}

  @Put('canary')
  @RequirePermission('release:manage')
  @ApiHeader(IF_MATCH)
  @ApiOkResponse({ type: EndpointDetailDto })
  async setWeight(
    @OrgId() orgId: string,
    @Param('endpointId', new UuidParam('Endpoint')) endpointId: string,
    @Body() dto: CanaryWeightDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Actor() actor: ActorContext,
    @CurrentMembership() m: MembershipContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    return etag(res, await this.releases.setWeight(orgId, endpointId, dto, ifMatch, actor, m.role));
  }

  @Post('canary/abort')
  @HttpCode(200)
  @RequirePermission('release:manage')
  @ApiHeader(IF_MATCH)
  @ApiOkResponse({ type: EndpointDetailDto })
  async abort(
    @OrgId() orgId: string,
    @Param('endpointId', new UuidParam('Endpoint')) endpointId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Actor() actor: ActorContext,
    @CurrentMembership() m: MembershipContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    return etag(
      res,
      await this.releases.abort(orgId, endpointId, actor, {
        ifMatch,
        role: m.role,
        reason: 'aborted by user',
      }),
    );
  }

  @Post('promote')
  @HttpCode(200)
  @RequirePermission('release:manage')
  @ApiHeader(IF_MATCH)
  @ApiOkResponse({ type: EndpointDetailDto })
  async promote(
    @OrgId() orgId: string,
    @Param('endpointId', new UuidParam('Endpoint')) endpointId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Actor() actor: ActorContext,
    @CurrentMembership() m: MembershipContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    return etag(res, await this.releases.promote(orgId, endpointId, ifMatch, actor, m.role));
  }

  @Post('rollback')
  @RequirePermission('release:manage')
  @ApiHeader(IF_MATCH)
  @ApiOkResponse({ type: RollbackResultDto, description: 'Fast rollback: traffic has moved' })
  @ApiAcceptedResponse({ type: RollbackResultDto, description: 'Slow rollback: redeploying' })
  async rollback(
    @OrgId() orgId: string,
    @Param('endpointId', new UuidParam('Endpoint')) endpointId: string,
    @Body() dto: RollbackDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Actor() actor: ActorContext,
    @CurrentMembership() m: MembershipContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RollbackResultDto> {
    const out = await this.releases.rollback(orgId, endpointId, dto, ifMatch, actor, m.role);
    res.status(out.status);
    res.setHeader('Cache-Control', 'no-store');
    return out.body;
  }
}

function etag(res: Response, e: EndpointDetailDto): EndpointDetailDto {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('ETag', `W/"${String(e.rowVersion)}"`);
  return e;
}

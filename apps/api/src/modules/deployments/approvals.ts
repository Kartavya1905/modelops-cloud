import {
  Body,
  Controller,
  Get,
  HttpCode,
  Injectable,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { OrgAccessGuard, RequirePermission } from '../../common/authz/org-access.guard';
import { Errors } from '../../common/errors/app-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  Actor,
  type ActorContext,
  CurrentMembership,
  type MembershipContext,
} from '../../common/request-context/request-context';
import { UuidParam } from '../../common/validation';
import type { ApprovalStatus, Prisma, Role } from '../../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import { APPROVAL_STATUSES, ApprovalDto, DecisionDto } from './deployments.dto';
import { ADMIN_ROLES } from './endpoints.service';
import { OUTBOX_DEPLOY } from './outbox.relay';
import { revisionInclude, summary } from './revision-view';
import { transition } from './transition';

const OrgId = () => Param('orgId', new UuidParam('Organization'));

const include = {
  revision: { include: revisionInclude },
  requestedBy: { select: { id: true, name: true } },
  decidedBy: { select: { id: true, name: true } },
} as const satisfies Prisma.ApprovalInclude;
type Row = Prisma.ApprovalGetPayload<{ include: typeof include }>;

/**
 * Four-eyes approvals for production deployments (FR-41, docs/05 §2). A production revision
 * waits in AWAITING_APPROVAL; a *different* Owner/Admin approves (-> QUEUED, outbox) or rejects
 * (-> CANCELLED). The same rule is a CHECK constraint, and a trigger refuses to queue a
 * production revision without an APPROVED row, so no code path can skip the second person.
 */
@Injectable()
export class ApprovalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async dto(r: Row, actor: ActorContext, role: Role): Promise<ApprovalDto> {
    const endpoint = await this.prisma.endpoint.findUniqueOrThrow({
      where: { id: r.revision.endpointId },
      select: { id: true, name: true, slug: true, projectId: true, environment: true },
    });
    return {
      id: r.id,
      status: r.status,
      revision: summary(r.revision),
      endpoint,
      requestedBy: r.requestedBy,
      decidedBy: r.decidedBy,
      reason: r.reason,
      expiresAt: r.expiresAt.toISOString(),
      decidedAt: r.decidedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      canDecide:
        r.status === 'PENDING' &&
        r.expiresAt > new Date() &&
        ADMIN_ROLES.has(role) &&
        r.requestedById !== actor.userId,
    };
  }

  async list(
    orgId: string,
    status: ApprovalStatus | undefined,
    actor: ActorContext,
    role: Role,
  ): Promise<ApprovalDto[]> {
    const rows = await this.prisma.approval.findMany({
      where: { orgId, ...(status ? { status } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include,
    });
    return Promise.all(rows.map((r) => this.dto(r, actor, role)));
  }

  async decide(
    orgId: string,
    approvalId: string,
    decision: 'APPROVED' | 'REJECTED',
    dto: DecisionDto,
    actor: ActorContext,
    role: Role,
  ): Promise<ApprovalDto> {
    if (decision === 'REJECTED' && !dto.reason) {
      throw Errors.validation([{ field: 'reason', message: 'say why the deployment is rejected' }]);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM approvals WHERE id = ${approvalId}::uuid FOR UPDATE`;
      const a = await tx.approval.findFirst({
        where: { id: approvalId, orgId },
        include: { revision: true },
      });
      if (!a) throw Errors.notFound('Approval');
      if (a.requestedById === actor.userId) {
        throw Errors.forbidden(
          'SELF_APPROVAL',
          'Another Owner or Admin has to decide on a deployment you requested.',
        );
      }
      if (a.status !== 'PENDING') {
        throw Errors.conflict('APPROVAL_DECIDED', `This approval is already ${a.status}.`);
      }
      if (a.expiresAt <= new Date() || a.revision.state !== 'AWAITING_APPROVAL') {
        throw Errors.conflict(
          'APPROVAL_EXPIRED',
          'This deployment is no longer waiting for approval.',
        );
      }
      await tx.approval.update({
        where: { id: a.id },
        data: {
          status: decision,
          decidedById: actor.userId,
          decidedAt: new Date(),
          reason: dto.reason ?? null,
        },
      });
      if (decision === 'APPROVED') {
        const moved = await transition(tx, a.revision, 'QUEUED', {
          message: `Approved${dto.reason ? `: ${dto.reason}` : ''}`,
          metadata: { approvalId: a.id },
        });
        if (!moved) throw Errors.conflict('APPROVAL_EXPIRED', 'The deployment changed; reload.');
        await tx.outboxMessage.create({
          data: {
            type: OUTBOX_DEPLOY,
            aggregateType: 'deployment_revision',
            aggregateId: a.revisionId,
            payload: { endpointId: a.revision.endpointId },
          },
        });
      } else {
        const moved = await transition(tx, a.revision, 'CANCELLED', {
          message: `Rejected: ${dto.reason ?? ''}`,
          data: { failureCode: 'APPROVAL_REJECTED', failureDetail: dto.reason ?? null },
        });
        if (!moved) throw Errors.conflict('APPROVAL_EXPIRED', 'The deployment changed; reload.');
      }
      await this.audit.record(tx, actor, {
        orgId,
        action: decision === 'APPROVED' ? 'deployment.approved' : 'deployment.rejected',
        targetType: 'deployment_revision',
        targetId: a.revisionId,
        metadata: { approvalId: a.id, requestedBy: a.requestedById },
      });
    });
    const row = await this.prisma.approval.findUniqueOrThrow({
      where: { id: approvalId },
      include,
    });
    return this.dto(row, actor, role);
  }
}

@ApiTags('approvals')
@ApiCookieAuth('session')
@UseGuards(OrgAccessGuard)
@Controller('orgs/:orgId/approvals')
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get()
  @RequirePermission('approval:read')
  @ApiQuery({ name: 'status', required: false, enum: APPROVAL_STATUSES })
  @ApiOkResponse({ type: [ApprovalDto], description: 'Newest first (up to 100)' })
  list(
    @OrgId() orgId: string,
    @Query('status') status: string | undefined,
    @Actor() actor: ActorContext,
    @CurrentMembership() m: MembershipContext,
  ) {
    if (status !== undefined && !(APPROVAL_STATUSES as readonly string[]).includes(status)) {
      throw Errors.validation([{ field: 'status', message: APPROVAL_STATUSES.join(', ') }]);
    }
    return this.approvals.list(orgId, status as ApprovalStatus | undefined, actor, m.role);
  }

  @Post(':approvalId/approve')
  @HttpCode(200)
  @RequirePermission('approval:decide')
  @ApiOkResponse({ type: ApprovalDto })
  approve(
    @OrgId() orgId: string,
    @Param('approvalId', new UuidParam('Approval')) approvalId: string,
    @Body() dto: DecisionDto,
    @Actor() actor: ActorContext,
    @CurrentMembership() m: MembershipContext,
  ) {
    return this.approvals.decide(orgId, approvalId, 'APPROVED', dto, actor, m.role);
  }

  @Post(':approvalId/reject')
  @HttpCode(200)
  @RequirePermission('approval:decide')
  @ApiOkResponse({ type: ApprovalDto })
  reject(
    @OrgId() orgId: string,
    @Param('approvalId', new UuidParam('Approval')) approvalId: string,
    @Body() dto: DecisionDto,
    @Actor() actor: ActorContext,
    @CurrentMembership() m: MembershipContext,
  ) {
    return this.approvals.decide(orgId, approvalId, 'REJECTED', dto, actor, m.role);
  }
}

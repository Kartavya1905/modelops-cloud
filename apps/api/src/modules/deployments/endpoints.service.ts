import { createHash } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { AppError, Errors } from '../../common/errors/app-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { ActorContext } from '../../common/request-context/request-context';
import { slugify } from '../../common/slug';
import { APP_CONFIG, type AppConfig } from '../../config/config';
import { Prisma, type Role } from '../../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import { DataPlanePublisher } from './dataplane';
import type {
  CreateEndpointDto,
  DeployDto,
  EndpointDetailDto,
  EndpointDto,
  RevisionDto,
  RevisionSummaryDto,
} from './deployments.dto';
import { OUTBOX_DEPLOY } from './outbox.relay';
import { CANCELLABLE, IN_PROGRESS } from './state-machine';
import { transition } from './transition';

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;

const revisionInclude = {
  modelVersion: {
    select: {
      id: true,
      version: true,
      framework: true,
      modelId: true,
      model: { select: { name: true } },
    },
  },
} as const satisfies Prisma.DeploymentRevisionInclude;
type RevisionRow = Prisma.DeploymentRevisionGetPayload<{ include: typeof revisionInclude }>;

function summary(r: RevisionRow): RevisionSummaryDto {
  return {
    id: r.id,
    endpointId: r.endpointId,
    revisionNumber: r.revisionNumber,
    state: r.state,
    modelVersion: {
      id: r.modelVersion.id,
      modelId: r.modelVersion.modelId,
      modelName: r.modelVersion.model.name,
      version: r.modelVersion.version,
      framework: r.modelVersion.framework,
    },
    failureCode: r.failureCode,
    failureDetail: r.failureDetail,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    readyAt: r.readyAt?.toISOString() ?? null,
  };
}

/** Thrown inside the deploy transaction to roll it back and replay the stored response. */
class IdempotentReplay extends Error {}

@Injectable()
export class EndpointsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly dataplane: DataPlanePublisher,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private invokeUrl(slug: string): string {
    return `${this.config.deploy.gatewayUrl}/v1/endpoints/${slug}/predict`;
  }

  private async toDto(e: Prisma.EndpointGetPayload<object>): Promise<EndpointDto> {
    const [stable, inProgress] = await Promise.all([
      e.stableRevisionId
        ? this.prisma.deploymentRevision.findUnique({
            where: { id: e.stableRevisionId },
            include: revisionInclude,
          })
        : null,
      this.prisma.deploymentRevision.findFirst({
        where: { endpointId: e.id, state: { in: [...IN_PROGRESS] } },
        include: revisionInclude,
      }),
    ]);
    return {
      id: e.id,
      projectId: e.projectId,
      slug: e.slug,
      name: e.name,
      description: e.description,
      environment: e.environment,
      rateLimitRps: e.rateLimitRps,
      invokeUrl: this.invokeUrl(e.slug),
      stableRevision: stable ? summary(stable) : null,
      inProgressRevision: inProgress ? summary(inProgress) : null,
      createdAt: e.createdAt.toISOString(),
    };
  }

  async create(
    orgId: string,
    projectId: string,
    dto: CreateEndpointDto,
    actor: ActorContext,
  ): Promise<EndpointDto> {
    const project = await this.prisma.project.findFirst({ where: { id: projectId, orgId } });
    if (!project) throw Errors.notFound('Project');
    if (project.archivedAt) throw Errors.conflict('PROJECT_ARCHIVED', 'This project is archived.');
    if (dto.environment === 'PRODUCTION') {
      throw new AppError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'PRODUCTION_REQUIRES_APPROVALS',
        'Production endpoints are not available yet',
        'Production deploys need four-eyes approvals, which arrive in Milestone 8. Use STAGING.',
      );
    }
    const slug = dto.slug ?? slugify(dto.name).slice(0, 40).replace(/-+$/, '');
    try {
      const e = await this.prisma.$transaction(async (tx) => {
        const created = await tx.endpoint.create({
          data: {
            orgId,
            projectId,
            slug,
            name: dto.name,
            description: dto.description ?? null,
            environment: 'STAGING',
            rateLimitRps: dto.rateLimitRps ?? 50,
            createdById: actor.userId,
          },
        });
        await this.audit.record(tx, actor, {
          orgId,
          action: 'endpoint.created',
          targetType: 'endpoint',
          targetId: created.id,
          metadata: { slug },
        });
        return created;
      });
      // The gateway learns the endpoint exists (503 until a revision is READY, not 404).
      await this.dataplane.publishRouting();
      return await this.toDto(e);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw Errors.conflict(
          'ENDPOINT_SLUG_TAKEN',
          `An endpoint named "${slug}" already exists in this project.`,
        );
      }
      throw err;
    }
  }

  async list(orgId: string, projectId: string): Promise<EndpointDto[]> {
    const project = await this.prisma.project.findFirst({ where: { id: projectId, orgId } });
    if (!project) throw Errors.notFound('Project');
    const rows = await this.prisma.endpoint.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });
    return Promise.all(rows.map((e) => this.toDto(e)));
  }

  async get(orgId: string, endpointId: string): Promise<EndpointDetailDto> {
    const e = await this.prisma.endpoint.findFirst({
      where: { id: endpointId, orgId },
      include: { project: { select: { id: true, name: true, slug: true } } },
    });
    if (!e) throw Errors.notFound('Endpoint');
    const revisions = await this.prisma.deploymentRevision.findMany({
      where: { endpointId },
      orderBy: { revisionNumber: 'desc' },
      take: 50,
      include: revisionInclude,
    });
    return { ...(await this.toDto(e)), project: e.project, revisions: revisions.map(summary) };
  }

  async getRevision(orgId: string, revisionId: string): Promise<RevisionDto> {
    const r = await this.prisma.deploymentRevision.findFirst({
      where: { id: revisionId, orgId },
      include: {
        ...revisionInclude,
        requestedBy: { select: { id: true, name: true } },
        events: { orderBy: { id: 'asc' } },
      },
    });
    if (!r) throw Errors.notFound('Revision');
    return {
      ...summary(r),
      stateDeadlineAt: r.stateDeadlineAt?.toISOString() ?? null,
      resources: r.resources as Record<string, number>,
      runtimeRef: r.runtimeRef,
      requestedBy: r.requestedBy,
      events: r.events.map((ev) => ({
        id: ev.id.toString(),
        fromState: ev.fromState,
        toState: ev.toState,
        message: ev.message,
        createdAt: ev.createdAt.toISOString(),
      })),
    };
  }

  /**
   * Deploy (docs/05 §1): 202 with a REQUESTED revision. One transaction holds the idempotency
   * record, the revision, its first event, the outbox row and the audit row, so the request is
   * durable the moment we answer and a retried request (same Idempotency-Key) replays the answer.
   */
  async deploy(
    orgId: string,
    endpointId: string,
    dto: DeployDto,
    idempotencyKey: string | undefined,
    actor: ActorContext,
  ): Promise<{ status: number; body: RevisionDto; replayed: boolean }> {
    if (!idempotencyKey || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
      throw Errors.validation([
        { field: 'Idempotency-Key', message: 'header is required (8-128 characters, e.g. a UUID)' },
      ]);
    }
    const requestHash = createHash('sha256')
      .update(`POST /endpoints/${endpointId}/revisions\n${JSON.stringify(dto)}`)
      .digest('hex');

    const replay = await this.replay(orgId, idempotencyKey, requestHash);
    if (replay) return replay;

    const endpoint = await this.prisma.endpoint.findFirst({
      where: { id: endpointId, orgId },
      include: { project: { select: { archivedAt: true } } },
    });
    if (!endpoint) throw Errors.notFound('Endpoint');
    if (endpoint.project.archivedAt) {
      throw Errors.conflict('PROJECT_ARCHIVED', 'This project is archived.');
    }
    const mv = await this.prisma.modelVersion.findFirst({
      where: { id: dto.modelVersionId, orgId },
      include: { model: { select: { projectId: true } } },
    });
    if (!mv || mv.model.projectId !== endpoint.projectId) throw Errors.notFound('Model version');
    if (mv.status !== 'VALIDATED') {
      throw new AppError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'MODEL_NOT_VALIDATED',
        'Model version is not validated',
        `Only VALIDATED versions can be deployed; this one is ${mv.status}.`,
      );
    }

    let revisionId: string;
    try {
      revisionId = await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.$executeRaw`
          INSERT INTO idempotency_keys (org_id, key, request_hash, status_code, response_body, expires_at)
          VALUES (${orgId}::uuid, ${idempotencyKey}, ${requestHash}, 202, '{}'::jsonb,
                  ${new Date(Date.now() + IDEMPOTENCY_TTL_MS)})
          ON CONFLICT (org_id, key) DO NOTHING`;
        // A concurrent request with the same key committed first (we waited on its row lock).
        if (claimed === 0) throw new IdempotentReplay();

        await tx.$queryRaw`SELECT id FROM endpoints WHERE id = ${endpointId}::uuid FOR UPDATE`;
        const last = await tx.deploymentRevision.aggregate({
          where: { endpointId },
          _max: { revisionNumber: true },
        });
        const rev = await tx.deploymentRevision.create({
          data: {
            orgId,
            endpointId,
            modelVersionId: mv.id,
            revisionNumber: (last._max.revisionNumber ?? 0) + 1,
            resources: {
              cpus: dto.resources?.cpus ?? 0.5,
              memoryMb: dto.resources?.memoryMb ?? 512,
            },
            stateDeadlineAt: new Date(Date.now() + 10 * 60_000),
            previousRevisionId: endpoint.stableRevisionId,
            requestedById: actor.userId,
          },
        });
        await tx.deploymentEvent.create({
          data: {
            orgId,
            revisionId: rev.id,
            fromState: null,
            toState: 'REQUESTED',
            message: `Deployment of ${mv.id.slice(0, 8)} requested`,
          },
        });
        await tx.outboxMessage.create({
          data: {
            type: OUTBOX_DEPLOY,
            aggregateType: 'deployment_revision',
            aggregateId: rev.id,
            payload: { endpointId },
          },
        });
        // The replay record commits with the revision: a retry can never see a half-done request.
        await tx.idempotencyKey.update({
          where: { orgId_key: { orgId, key: idempotencyKey } },
          data: { responseBody: { revisionId: rev.id } },
        });
        await this.audit.record(tx, actor, {
          orgId,
          action: 'deployment.requested',
          targetType: 'deployment_revision',
          targetId: rev.id,
          metadata: { endpointId, modelVersionId: mv.id, revision: rev.revisionNumber },
        });
        return rev.id;
      });
    } catch (err) {
      if (err instanceof IdempotentReplay) {
        const again = await this.replay(orgId, idempotencyKey, requestHash);
        if (again) return again;
      }
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw Errors.conflict(
          'DEPLOYMENT_IN_PROGRESS',
          'This endpoint already has a deployment in progress. Wait for it, or cancel it.',
        );
      }
      throw err;
    }
    return { status: 202, body: await this.getRevision(orgId, revisionId), replayed: false };
  }

  private async replay(
    orgId: string,
    key: string,
    requestHash: string,
  ): Promise<{ status: number; body: RevisionDto; replayed: boolean } | null> {
    const row = await this.prisma.idempotencyKey.findUnique({
      where: { orgId_key: { orgId, key } },
    });
    if (!row || row.expiresAt < new Date()) return null;
    if (row.requestHash !== requestHash) {
      throw Errors.conflict(
        'IDEMPOTENCY_KEY_REUSED',
        'This Idempotency-Key was already used for a different request.',
      );
    }
    // Always set: the row and the revision commit in the same transaction.
    const { revisionId } = row.responseBody as { revisionId?: string };
    if (!revisionId) return null;
    return {
      status: row.statusCode,
      body: await this.getRevision(orgId, revisionId),
      replayed: true,
    };
  }

  async cancel(
    orgId: string,
    revisionId: string,
    actor: ActorContext,
    role: Role,
  ): Promise<RevisionDto> {
    const rev = await this.prisma.deploymentRevision.findFirst({
      where: { id: revisionId, orgId },
    });
    if (!rev) throw Errors.notFound('Revision');
    // ML engineers may cancel their own deployments; Owners and Admins any (docs/04).
    if (role === 'ML_ENGINEER' && rev.requestedById !== actor.userId) {
      throw Errors.forbidden(
        'NOT_YOUR_DEPLOYMENT',
        'You can only cancel deployments you requested.',
      );
    }
    if (!(CANCELLABLE as readonly string[]).includes(rev.state)) {
      throw Errors.conflict(
        'INVALID_STATE_TRANSITION',
        `A ${rev.state} revision can no longer be cancelled.`,
      );
    }
    const moved = await this.prisma.$transaction(async (tx) => {
      const r = await transition(tx, rev, 'CANCELLED', {
        message: 'Cancelled by user',
        data: { failureCode: 'CANCELLED_BY_USER' },
      });
      if (r) {
        await this.audit.record(tx, actor, {
          orgId,
          action: 'deployment.cancelled',
          targetType: 'deployment_revision',
          targetId: rev.id,
        });
      }
      return r;
    });
    // Lost the race to the worker: report the state it is in now.
    if (!moved) {
      throw Errors.conflict('INVALID_STATE_TRANSITION', 'The revision changed state; reload it.');
    }
    // The worker (on its next step) or the reconciler removes the container.
    return this.getRevision(orgId, revisionId);
  }
}

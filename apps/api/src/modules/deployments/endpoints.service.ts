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
  UpdateEndpointDto,
} from './deployments.dto';
import { OUTBOX_DEPLOY } from './outbox.relay';
import { canaryCheckDto, revisionInclude, summary } from './revision-view';
import { CANCELLABLE, IN_PROGRESS } from './state-machine';
import { transition } from './transition';

/** Owners and Admins: the only roles that may touch PRODUCTION endpoints (docs/04, FR-41). */
export const ADMIN_ROLES: ReadonlySet<Role> = new Set<Role>(['OWNER', 'ADMIN']);
const APPROVAL_TTL_MS = 24 * 60 * 60_000;

interface SignatureJson {
  inputs: { features?: string[] }[];
}
export const featuresOf = (signature: unknown) =>
  ((signature as SignatureJson).inputs[0]?.features ?? []).join(',');

/** What a new revision needs; shared by deploy and the slow rollback path. */
export interface NewRevision {
  orgId: string;
  endpoint: { id: string; environment: 'STAGING' | 'PRODUCTION'; stableRevisionId: string | null };
  modelVersionId: string;
  resources?: { cpus?: number; memoryMb?: number };
  strategy: 'IMMEDIATE' | 'CANARY';
  canaryWeight: number | null;
  rollbackOfId?: string;
  actor: ActorContext;
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;

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

  /**
   * Reads that must see ONE snapshot. VERIFYING -> READY and the stable pointer commit together;
   * reading the endpoint row and then its revisions under READ COMMITTED could land between them
   * and show neither a stable nor an in-progress revision, so the UI stops polling on "Nothing
   * deployed yet" (seen in the parallel E2E run).
   */
  private snapshot<T>(fn: (db: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(fn, {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
  }

  private async toDto(
    e: Prisma.EndpointGetPayload<object>,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<EndpointDto> {
    // Sequential: inside a transaction both queries share one connection anyway.
    const stable = e.stableRevisionId
      ? await db.deploymentRevision.findUnique({
          where: { id: e.stableRevisionId },
          include: revisionInclude,
        })
      : null;
    const inProgress = await db.deploymentRevision.findFirst({
      where: { endpointId: e.id, state: { in: [...IN_PROGRESS] } },
      include: revisionInclude,
    });
    const canaryRev = e.canaryRevisionId
      ? await db.deploymentRevision.findUnique({
          where: { id: e.canaryRevisionId },
          include: revisionInclude,
        })
      : null;
    const latestCheck = canaryRev
      ? await db.canaryCheck.findFirst({
          where: { revisionId: canaryRev.id },
          orderBy: { createdAt: 'desc' },
        })
      : null;
    return {
      id: e.id,
      projectId: e.projectId,
      slug: e.slug,
      name: e.name,
      description: e.description,
      environment: e.environment,
      rateLimitRps: e.rateLimitRps,
      captureInputs: e.captureInputs,
      rowVersion: e.rowVersion,
      invokeUrl: this.invokeUrl(e.slug),
      stableRevision: stable ? summary(stable) : null,
      inProgressRevision: inProgress ? summary(inProgress) : null,
      canary: canaryRev
        ? {
            revision: summary(canaryRev),
            weight: e.canaryWeight,
            startedAt: e.canaryStartedAt?.toISOString() ?? null,
            latestCheck: latestCheck ? canaryCheckDto(latestCheck) : null,
            eligible: latestCheck?.verdict === 'PASS',
          }
        : null,
      createdAt: e.createdAt.toISOString(),
    };
  }

  async create(
    orgId: string,
    projectId: string,
    dto: CreateEndpointDto,
    actor: ActorContext,
    role: Role,
  ): Promise<EndpointDto> {
    const project = await this.prisma.project.findFirst({ where: { id: projectId, orgId } });
    if (!project) throw Errors.notFound('Project');
    if (project.archivedAt) throw Errors.conflict('PROJECT_ARCHIVED', 'This project is archived.');
    if (dto.environment === 'PRODUCTION' && !ADMIN_ROLES.has(role)) {
      throw Errors.forbidden(
        'PRODUCTION_REQUIRES_ADMIN',
        'Only Owners and Admins can create production endpoints.',
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
            environment: dto.environment ?? 'STAGING',
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
    return this.snapshot(async (db) => {
      const rows = await db.endpoint.findMany({
        where: { projectId },
        orderBy: { createdAt: 'desc' },
      });
      const out: EndpointDto[] = [];
      for (const e of rows) out.push(await this.toDto(e, db)); // one connection: sequential
      return out;
    });
  }

  /**
   * Settings change with optimistic locking: `If-Match` must carry the current version (ETag),
   * so two people editing at once can't silently overwrite each other (docs/04 "Concurrency").
   */
  async update(
    orgId: string,
    endpointId: string,
    dto: UpdateEndpointDto,
    ifMatch: string | undefined,
    actor: ActorContext,
  ): Promise<EndpointDetailDto> {
    const expected = /^W\/"(\d+)"$/.exec(ifMatch ?? '')?.[1];
    if (expected === undefined) {
      throw new AppError(
        HttpStatus.PRECONDITION_REQUIRED,
        'IF_MATCH_REQUIRED',
        'If-Match header required',
        'Send the ETag from GET /endpoints/{id} as If-Match.',
      );
    }
    const changed = await this.prisma.$transaction(async (tx) => {
      const res = await tx.endpoint.updateMany({
        where: { id: endpointId, orgId, rowVersion: Number(expected) },
        data: {
          ...(dto.captureInputs === undefined ? {} : { captureInputs: dto.captureInputs }),
          ...(dto.rateLimitRps === undefined ? {} : { rateLimitRps: dto.rateLimitRps }),
          rowVersion: { increment: 1 },
        },
      });
      if (res.count === 1) {
        await this.audit.record(tx, actor, {
          orgId,
          action: 'endpoint.updated',
          targetType: 'endpoint',
          targetId: endpointId,
          metadata: { ...dto },
        });
      }
      return res.count === 1;
    });
    if (!changed) {
      const exists = await this.prisma.endpoint.findFirst({ where: { id: endpointId, orgId } });
      if (!exists) throw Errors.notFound('Endpoint');
      throw new AppError(
        HttpStatus.PRECONDITION_FAILED,
        'ETAG_MISMATCH',
        'The endpoint changed meanwhile',
        'Reload it and apply your change again.',
      );
    }
    await this.dataplane.publishRouting(true); // the gateway starts/stops capturing right away
    return this.get(orgId, endpointId);
  }

  async get(orgId: string, endpointId: string): Promise<EndpointDetailDto> {
    return this.snapshot(async (db) => {
      const e = await db.endpoint.findFirst({
        where: { id: endpointId, orgId },
        include: { project: { select: { id: true, name: true, slug: true } } },
      });
      if (!e) throw Errors.notFound('Endpoint');
      const revisions = await db.deploymentRevision.findMany({
        where: { endpointId },
        orderBy: { revisionNumber: 'desc' },
        take: 50,
        include: revisionInclude,
      });
      const dto = await this.toDto(e, db);
      return { ...dto, project: e.project, revisions: revisions.map(summary) };
    });
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
    role: Role,
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
    if (endpoint.environment === 'PRODUCTION' && !ADMIN_ROLES.has(role)) {
      throw Errors.forbidden(
        'PRODUCTION_REQUIRES_ADMIN',
        'Only Owners and Admins can deploy to a production endpoint.',
      );
    }
    if (endpoint.canaryRevisionId) {
      throw Errors.conflict(
        'CANARY_IN_PROGRESS',
        'This endpoint is running a canary. Promote or abort it before deploying again.',
      );
    }
    const strategy = dto.strategy ?? 'IMMEDIATE';
    if (strategy === 'CANARY') {
      const stable = endpoint.stableRevisionId
        ? await this.prisma.deploymentRevision.findUnique({
            where: { id: endpoint.stableRevisionId },
            include: { modelVersion: { select: { signature: true } } },
          })
        : null;
      if (!stable) {
        throw Errors.conflict(
          'NO_STABLE_REVISION',
          'A canary is compared with the stable revision, and this endpoint has none yet. Deploy IMMEDIATE first.',
        );
      }
      // Clients send one input shape: a canary that expects other features would fail its share.
      if (featuresOf(stable.modelVersion.signature) !== featuresOf(mv.signature)) {
        throw Errors.conflict(
          'SIGNATURE_MISMATCH',
          'A canary must accept the same input features, in the same order, as the stable revision.',
        );
      }
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

        const rev = await this.insertRevision(tx, {
          orgId,
          endpoint,
          modelVersionId: mv.id,
          resources: dto.resources,
          strategy,
          canaryWeight: strategy === 'CANARY' ? (dto.canaryWeight ?? 10) : null,
          actor,
        });
        // The replay record commits with the revision: a retry can never see a half-done request.
        await tx.idempotencyKey.update({
          where: { orgId_key: { orgId, key: idempotencyKey } },
          data: { responseBody: { revisionId: rev.id } },
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

  /**
   * Inserts a REQUESTED revision with its first event and audit row, inside the caller's
   * transaction. STAGING (and a slow rollback, which redeploys an already approved version) goes
   * to the outbox at once; PRODUCTION waits in AWAITING_APPROVAL for a second Owner/Admin.
   */
  async insertRevision(tx: Prisma.TransactionClient, r: NewRevision) {
    await tx.$queryRaw`SELECT id FROM endpoints WHERE id = ${r.endpoint.id}::uuid FOR UPDATE`;
    const last = await tx.deploymentRevision.aggregate({
      where: { endpointId: r.endpoint.id },
      _max: { revisionNumber: true },
    });
    const rev = await tx.deploymentRevision.create({
      data: {
        orgId: r.orgId,
        endpointId: r.endpoint.id,
        modelVersionId: r.modelVersionId,
        revisionNumber: (last._max.revisionNumber ?? 0) + 1,
        resources: { cpus: r.resources?.cpus ?? 0.5, memoryMb: r.resources?.memoryMb ?? 512 },
        stateDeadlineAt: new Date(Date.now() + 10 * 60_000),
        previousRevisionId: r.endpoint.stableRevisionId,
        strategy: r.strategy,
        canaryWeight: r.canaryWeight,
        rollbackOfId: r.rollbackOfId ?? null,
        requestedById: r.actor.userId,
      },
    });
    await tx.deploymentEvent.create({
      data: {
        orgId: r.orgId,
        revisionId: rev.id,
        fromState: null,
        toState: 'REQUESTED',
        message: r.rollbackOfId
          ? `Rollback: redeploy of the version of an earlier revision requested`
          : r.strategy === 'CANARY'
            ? `Canary deployment (${String(r.canaryWeight)}% of traffic) requested`
            : `Deployment of ${r.modelVersionId.slice(0, 8)} requested`,
      },
    });
    const needsApproval = r.endpoint.environment === 'PRODUCTION' && !r.rollbackOfId;
    if (needsApproval) {
      await transition(tx, rev, 'AWAITING_APPROVAL', {
        message: 'Production deployment: waiting for a second Owner/Admin to approve',
      });
      await tx.approval.create({
        data: {
          orgId: r.orgId,
          revisionId: rev.id,
          requestedById: r.actor.userId,
          expiresAt: new Date(Date.now() + APPROVAL_TTL_MS),
        },
      });
    } else {
      await tx.outboxMessage.create({
        data: {
          type: OUTBOX_DEPLOY,
          aggregateType: 'deployment_revision',
          aggregateId: rev.id,
          payload: { endpointId: r.endpoint.id },
        },
      });
    }
    await this.audit.record(tx, r.actor, {
      orgId: r.orgId,
      action: needsApproval ? 'deployment.approval_requested' : 'deployment.requested',
      targetType: 'deployment_revision',
      targetId: rev.id,
      metadata: {
        endpointId: r.endpoint.id,
        modelVersionId: r.modelVersionId,
        revision: rev.revisionNumber,
        strategy: r.strategy,
        ...(r.rollbackOfId ? { rollbackOf: r.rollbackOfId } : {}),
      },
    });
    return rev;
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
      if (r && rev.state === 'AWAITING_APPROVAL') {
        // Withdrawn before anyone decided: the approval closes without a decision.
        await tx.approval.updateMany({
          where: { revisionId: rev.id, status: 'PENDING' },
          data: { status: 'EXPIRED', reason: 'Withdrawn: the deployment was cancelled' },
        });
      }
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

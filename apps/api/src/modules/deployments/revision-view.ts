import type { Prisma } from '../../generated/prisma/client';
import type { CanaryCheckDto, CanarySideDto, RevisionSummaryDto } from './deployments.dto';

/** Shared read shapes for revisions and canary checks (endpoints, releases, approvals). */
export const revisionInclude = {
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
export type RevisionRow = Prisma.DeploymentRevisionGetPayload<{ include: typeof revisionInclude }>;

export function summary(r: RevisionRow): RevisionSummaryDto {
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
    strategy: r.strategy,
    canaryWeight: r.canaryWeight,
    rollbackOfId: r.rollbackOfId,
    stableAt: r.stableAt?.toISOString() ?? null,
  };
}

/** What a canary analysis measured (stored as `canary_checks.metrics`). */
export interface CanaryMetrics {
  canary: CanarySideDto;
  stable: CanarySideDto;
  fallbacks: number;
  windowSeconds: number;
}

export function canaryCheckDto(c: Prisma.CanaryCheckGetPayload<object>): CanaryCheckDto {
  const m = c.metrics as unknown as CanaryMetrics;
  return {
    id: c.id,
    revisionId: c.revisionId,
    verdict: c.verdict,
    canary: m.canary,
    stable: m.stable,
    fallbacks: m.fallbacks,
    windowSeconds: m.windowSeconds,
    checks: c.checks as unknown as CanaryCheckDto['checks'],
    aborted: c.aborted,
    createdAt: c.createdAt.toISOString(),
  };
}

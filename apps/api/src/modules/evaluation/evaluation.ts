import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Injectable,
  Logger,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { IsOptional, IsUUID, Matches } from 'class-validator';
import { OrgAccessGuard, RequirePermission } from '../../common/authz/org-access.guard';
import { AppError, Errors } from '../../common/errors/app-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Actor, type ActorContext } from '../../common/request-context/request-context';
import { UuidParam } from '../../common/validation';
import type { Prisma } from '../../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import { MlflowClient } from '../mlflow/mlflow.client';
import { blobRef, MlWorkerClient, type ScoreMetrics } from '../monitoring/ml-worker.client';

export interface Policy {
  minRocAuc: number;
  maxRocAucDrop: number;
  maxLogLossIncrease: number;
}
export const DEFAULT_POLICY: Policy = {
  minRocAuc: 0.7,
  maxRocAucDrop: 0.01,
  maxLogLossIncrease: 0.02,
};

export interface GateCheck {
  rule: string;
  passed: boolean;
  detail: string;
}

/**
 * The evaluation gate (FR-32), as a pure function so every rule is unit-tested:
 *   1. the candidate is good enough on its own        (ROC-AUC >= minRocAuc)
 *   2. it is not worse than the current champion     (AUC drop <= maxRocAucDrop,
 *                                                      log-loss increase <= maxLogLossIncrease)
 * With no champion yet, only rule 1 applies.
 */
export function judge(
  policy: Policy,
  candidate: ScoreMetrics,
  baseline: ScoreMetrics | null,
): GateCheck[] {
  const f = (v: number) => v.toFixed(4);
  const checks: GateCheck[] = [
    {
      rule: 'minRocAuc',
      passed: candidate.rocAuc >= policy.minRocAuc,
      detail: `ROC-AUC ${f(candidate.rocAuc)} vs minimum ${f(policy.minRocAuc)}`,
    },
  ];
  if (baseline) {
    const drop = baseline.rocAuc - candidate.rocAuc;
    const increase = candidate.logLoss - baseline.logLoss;
    checks.push(
      {
        rule: 'maxRocAucDrop',
        passed: drop <= policy.maxRocAucDrop + 1e-12,
        detail: `ROC-AUC ${f(candidate.rocAuc)} vs champion ${f(baseline.rocAuc)} (drop ${f(Math.max(drop, 0))}, allowed ${f(policy.maxRocAucDrop)})`,
      },
      {
        rule: 'maxLogLossIncrease',
        passed: increase <= policy.maxLogLossIncrease + 1e-12,
        detail: `log loss ${f(candidate.logLoss)} vs champion ${f(baseline.logLoss)} (increase ${f(Math.max(increase, 0))}, allowed ${f(policy.maxLogLossIncrease)})`,
      },
    );
  }
  return checks;
}

export class RunEvaluationDto {
  @ApiProperty({ format: 'uuid', description: 'A VALIDATED version of this model' })
  @IsUUID()
  candidateVersionId!: string;

  @ApiProperty({ format: 'uuid', description: 'A stored, labelled dataset version of the project' })
  @IsUUID()
  datasetVersionId!: string;

  @ApiPropertyOptional({ description: 'Label column in the dataset (default: churned)' })
  @IsOptional()
  @Matches(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/)
  labelColumn?: string;
}

export class SetChampionDto {
  @ApiProperty({
    format: 'uuid',
    description: 'A PASSED evaluation run against the current champion',
  })
  @IsUUID()
  evaluationId!: string;
}

class VersionRefDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() version!: number;
}
class GateCheckDto {
  @ApiProperty() rule!: string;
  @ApiProperty() passed!: boolean;
  @ApiProperty() detail!: string;
}
class ScoreDto {
  @ApiProperty() rows!: number;
  @ApiProperty() accuracy!: number;
  @ApiProperty() f1!: number;
  @ApiProperty() rocAuc!: number;
  @ApiProperty() logLoss!: number;
}
class EvalMetricsDto {
  @ApiPropertyOptional({ type: ScoreDto }) candidate?: ScoreDto;
  @ApiPropertyOptional({ type: ScoreDto, nullable: true }) baseline?: ScoreDto | null;
}
export class EvaluationDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) modelId!: string;
  @ApiProperty({ type: VersionRefDto }) candidate!: VersionRefDto;
  @ApiProperty({ type: VersionRefDto, nullable: true }) baseline!: VersionRefDto | null;
  @ApiProperty({ format: 'uuid' }) datasetVersionId!: string;
  @ApiProperty() datasetLabel!: string;
  @ApiProperty({ enum: ['COMPLETED', 'FAILED'] }) status!: 'COMPLETED' | 'FAILED';
  @ApiProperty() passed!: boolean;
  @ApiProperty({ type: EvalMetricsDto }) metrics!: EvalMetricsDto;
  @ApiProperty({ type: [GateCheckDto] }) checks!: GateCheckDto[];
  @ApiProperty({ type: 'object', additionalProperties: { type: 'number' } })
  policy!: Record<string, number>;
  @ApiProperty({ type: String, nullable: true }) failureDetail!: string | null;
  @ApiProperty({ description: 'This evaluation can crown the candidate right now' })
  canPromote!: boolean;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

const include = {
  candidate: { select: { id: true, version: true } },
  baseline: { select: { id: true, version: true } },
  dataset: { select: { name: true, version: true } },
  model: { select: { championVersionId: true } },
} as const satisfies Prisma.EvaluationReportInclude;
type Row = Prisma.EvaluationReportGetPayload<{ include: typeof include }>;

function dto(r: Row): EvaluationDto {
  return {
    id: r.id,
    modelId: r.modelId,
    candidate: r.candidate,
    baseline: r.baseline,
    datasetVersionId: r.datasetVersionId,
    datasetLabel: `${r.dataset.name} ${r.dataset.version}`,
    status: r.status,
    passed: r.passed,
    metrics: r.metrics as unknown as EvalMetricsDto,
    checks: r.checks as unknown as GateCheckDto[],
    policy: r.policy as Record<string, number>,
    failureDetail: r.failureDetail,
    // Promotable while it still compares against the CURRENT champion (the DB trigger agrees).
    canPromote:
      r.passed &&
      r.candidateVersionId !== r.model.championVersionId &&
      r.baselineVersionId === r.model.championVersionId,
    createdAt: r.createdAt.toISOString(),
  };
}

interface Sig {
  inputs: { name: string; features?: string[] }[];
}

/**
 * Evaluations and the `champion` alias (M7). The evaluation runs synchronously in the request:
 * scoring a few thousand rows with two ONNX models takes about a second (bounded by a 2-minute
 * timeout), so a queue would add moving parts without benefit at this size.
 */
@Injectable()
export class EvaluationService {
  private readonly logger = new Logger(EvaluationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mlWorker: MlWorkerClient,
    private readonly audit: AuditService,
    private readonly mlflow: MlflowClient,
  ) {}

  async run(orgId: string, modelId: string, input: RunEvaluationDto, actor: ActorContext) {
    const model = await this.prisma.registeredModel.findFirst({
      where: { id: modelId, orgId },
      include: { project: { select: { evaluationPolicy: true } } },
    });
    if (!model) throw Errors.notFound('Model');
    const candidate = await this.prisma.modelVersion.findFirst({
      where: { id: input.candidateVersionId, modelId },
    });
    if (!candidate) throw Errors.notFound('Model version');
    if (candidate.status !== 'VALIDATED' || !candidate.artifactSha256) {
      throw new AppError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'MODEL_NOT_VALIDATED',
        'Only validated versions can be evaluated',
      );
    }
    const dataset = await this.prisma.datasetVersion.findFirst({
      where: { id: input.datasetVersionId, projectId: model.projectId },
    });
    if (!dataset) throw Errors.notFound('Dataset version');
    if (!dataset.storedAt) {
      throw Errors.conflict('DATASET_NOT_STORED', 'That dataset version has no stored data yet.');
    }
    const label = input.labelColumn ?? 'churned';
    const sig = candidate.signature as unknown as Sig;
    const features = sig.inputs[0]?.features ?? [];
    const missing = [...features, label].filter((c) => !dataset.columns.includes(c));
    if (missing.length) {
      throw new AppError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'DATASET_COLUMNS_MISSING',
        'The dataset does not match the model',
        `Missing columns: ${missing.join(', ')}`,
      );
    }
    const baseline =
      model.championVersionId && model.championVersionId !== candidate.id
        ? await this.prisma.modelVersion.findUniqueOrThrow({
            where: { id: model.championVersionId },
          })
        : null;
    const policy = { ...DEFAULT_POLICY, ...(model.project.evaluationPolicy as Partial<Policy>) };

    let metrics: Prisma.InputJsonObject = {};
    let checks: GateCheck[] = [];
    let failureDetail: string | null = null;
    try {
      const res = await this.mlWorker.evaluate({
        dataset: blobRef(dataset.sha256),
        features,
        label,
        inputName: sig.inputs[0]?.name ?? 'features',
        candidate: blobRef(candidate.artifactSha256),
        baseline: baseline?.artifactSha256 ? blobRef(baseline.artifactSha256) : null,
      });
      metrics = res as unknown as Prisma.InputJsonObject;
      checks = judge(policy, res.candidate, res.baseline);
    } catch (err) {
      // The data could not be scored (wrong columns, labels...): a FAILED report is evidence too.
      // Infrastructure errors (ML worker down) are not reports: they propagate as 503.
      if (!(err instanceof AppError) || err.code !== 'ML_WORKER_REJECTED') throw err;
      failureDetail = err.detail ?? 'rejected';
    }
    const passed = failureDetail === null && checks.every((c) => c.passed);
    const report = await this.prisma.$transaction(async (tx) => {
      const r = await tx.evaluationReport.create({
        data: {
          orgId,
          modelId,
          candidateVersionId: candidate.id,
          baselineVersionId: baseline?.id ?? null,
          datasetVersionId: dataset.id,
          status: failureDetail ? 'FAILED' : 'COMPLETED',
          metrics,
          policy: { ...policy },
          checks: checks as unknown as Prisma.InputJsonArray,
          passed,
          failureDetail,
          requestedById: actor.userId,
        },
        include,
      });
      await this.audit.record(tx, actor, {
        orgId,
        action: 'evaluation.completed',
        targetType: 'evaluation_report',
        targetId: r.id,
        metadata: { candidate: candidate.version, baseline: baseline?.version ?? null, passed },
      });
      return r;
    });
    return dto(report);
  }

  async list(orgId: string, modelId: string) {
    const model = await this.prisma.registeredModel.findFirst({ where: { id: modelId, orgId } });
    if (!model) throw Errors.notFound('Model');
    const rows = await this.prisma.evaluationReport.findMany({
      where: { modelId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include,
    });
    return rows.map(dto);
  }

  async get(orgId: string, evaluationId: string) {
    const r = await this.prisma.evaluationReport.findFirst({
      where: { id: evaluationId, orgId },
      include,
    });
    if (!r) throw Errors.notFound('Evaluation');
    return dto(r);
  }

  /** Crowns the candidate of a passed evaluation. The DB trigger re-checks every rule. */
  async setChampion(orgId: string, modelId: string, evaluationId: string, actor: ActorContext) {
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM registered_models WHERE id = ${modelId}::uuid FOR UPDATE`;
      const model = await tx.registeredModel.findFirst({ where: { id: modelId, orgId } });
      if (!model) throw Errors.notFound('Model');
      const ev = await tx.evaluationReport.findFirst({
        where: { id: evaluationId, modelId },
        include: { candidate: { select: { version: true } } },
      });
      if (!ev) throw Errors.notFound('Evaluation');
      if (!ev.passed) {
        throw new AppError(
          HttpStatus.UNPROCESSABLE_ENTITY,
          'EVALUATION_NOT_PASSED',
          'This evaluation did not pass the gate',
          'A version becomes champion only with a passed evaluation.',
        );
      }
      if (ev.candidateVersionId === model.championVersionId) {
        throw Errors.conflict('ALREADY_CHAMPION', 'That version is already the champion.');
      }
      if (ev.baselineVersionId !== model.championVersionId) {
        throw Errors.conflict(
          'EVALUATION_STALE',
          'The champion changed since this evaluation ran. Evaluate again against the current champion.',
        );
      }
      await tx.registeredModel.update({
        where: { id: modelId },
        data: {
          championVersionId: ev.candidateVersionId,
          championEvaluationId: ev.id,
          championSetAt: new Date(),
        },
      });
      await this.audit.record(tx, actor, {
        orgId,
        action: 'model.champion_set',
        targetType: 'registered_model',
        targetId: modelId,
        metadata: { version: ev.candidate.version, evaluationId: ev.id },
      });
      return { mlflowName: model.mlflowName, versionId: ev.candidateVersionId };
    });
    // Mirror to MLflow's `champion` alias (best effort; Postgres is the truth, docs/02).
    const v = await this.prisma.modelVersion.findUnique({ where: { id: result.versionId } });
    if (v?.mlflowVersion) {
      await this.mlflow
        .setModelAlias(result.mlflowName, 'champion', v.mlflowVersion)
        .catch((err: unknown) => this.logger.warn(`MLflow alias not set: ${String(err)}`));
    }
    return this.get(orgId, evaluationId);
  }
}

@ApiTags('evaluation')
@ApiCookieAuth('session')
@UseGuards(OrgAccessGuard)
@Controller('orgs/:orgId')
export class EvaluationController {
  constructor(private readonly evaluations: EvaluationService) {}

  @Post('models/:modelId/evaluations')
  @RequirePermission('evaluation:run')
  @ApiCreatedResponse({
    type: EvaluationDto,
    description: 'Scored and judged by the project policy',
  })
  run(
    @Param('orgId', new UuidParam('Organization')) orgId: string,
    @Param('modelId', new UuidParam('Model')) modelId: string,
    @Body() dto: RunEvaluationDto,
    @Actor() actor: ActorContext,
  ) {
    return this.evaluations.run(orgId, modelId, dto, actor);
  }

  @Get('models/:modelId/evaluations')
  @RequirePermission('model:read')
  @ApiOkResponse({ type: [EvaluationDto] })
  list(
    @Param('orgId', new UuidParam('Organization')) orgId: string,
    @Param('modelId', new UuidParam('Model')) modelId: string,
  ) {
    return this.evaluations.list(orgId, modelId);
  }

  @Get('evaluations/:evaluationId')
  @RequirePermission('model:read')
  @ApiOkResponse({ type: EvaluationDto })
  get(
    @Param('orgId', new UuidParam('Organization')) orgId: string,
    @Param('evaluationId', new UuidParam('Evaluation')) evaluationId: string,
  ) {
    return this.evaluations.get(orgId, evaluationId);
  }

  @Post('models/:modelId/champion')
  @HttpCode(200)
  @RequirePermission('model:promote')
  @ApiOkResponse({
    type: EvaluationDto,
    description: 'The evaluation that crowned the new champion',
  })
  setChampion(
    @Param('orgId', new UuidParam('Organization')) orgId: string,
    @Param('modelId', new UuidParam('Model')) modelId: string,
    @Body() dto: SetChampionDto,
    @Actor() actor: ActorContext,
  ) {
    return this.evaluations.setChampion(orgId, modelId, dto.evaluationId, actor);
  }
}

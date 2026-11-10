import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { AppError, Errors } from '../../common/errors/app-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import { APP_CONFIG, type AppConfig } from '../../config/config';
import type { DriftReport, Prisma } from '../../generated/prisma/client';
import { CaptureStore } from './capture-store';
import { blobRef, type FeatureScore, MlWorkerClient } from './ml-worker.client';

export const MAX_DRIFT_SAMPLES = 5000;

interface SignatureJson {
  inputs: { name: string; features?: string[] }[];
  outputs: { classes?: (number | string)[] }[];
}

export function driftDto(r: DriftReport) {
  return {
    id: r.id,
    endpointId: r.endpointId,
    modelVersionId: r.modelVersionId,
    referenceDatasetVersionId: r.referenceDatasetVersionId,
    windowStart: r.windowStart.toISOString(),
    windowEnd: r.windowEnd.toISOString(),
    sampleCount: r.sampleCount,
    datasetDrift: r.datasetDrift,
    driftShare: r.driftShare,
    features: r.featureScores as unknown as FeatureScore[],
    evidentlyVersion: r.evidentlyVersion,
    trigger: r.trigger,
    createdAt: r.createdAt.toISOString(),
  };
}

/** Rank-based ROC-AUC (Mann-Whitney U, ties averaged); null without both classes. */
export function rocAuc(pairs: readonly { score: number; positive: boolean }[]): number | null {
  const pos = pairs.filter((p) => p.positive).length;
  const neg = pairs.length - pos;
  if (pos === 0 || neg === 0) return null;
  const sorted = [...pairs].sort((a, b) => a.score - b.score);
  let rankSum = 0;
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1]?.score === sorted[i]?.score) j++;
    const avgRank = (i + j + 2) / 2; // 1-based ranks i+1..j+1
    for (let k = i; k <= j; k++) if (sorted[k]?.positive) rankSum += avgRank;
    i = j + 1;
  }
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}

export interface LabelledPrediction {
  createdAt: Date;
  predicted: string;
  truth: string;
  score: number;
}

/** Accuracy, F1 (positive class) and ROC-AUC for one set of labelled predictions. */
export function performanceOf(rows: readonly LabelledPrediction[], positive: string) {
  const n = rows.length;
  if (n === 0) return { labelled: 0, accuracy: null, f1: null, rocAuc: null };
  let correct = 0;
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const r of rows) {
    if (r.predicted === r.truth) correct++;
    if (r.predicted === positive && r.truth === positive) tp++;
    if (r.predicted === positive && r.truth !== positive) fp++;
    if (r.predicted !== positive && r.truth === positive) fn++;
  }
  const f1 = tp === 0 ? 0 : (2 * tp) / (2 * tp + fp + fn);
  const auc = rocAuc(rows.map((r) => ({ score: r.score, positive: r.truth === positive })));
  const round = (v: number) => Math.round(v * 10_000) / 10_000;
  return {
    labelled: n,
    accuracy: round(correct / n),
    f1: round(f1),
    rocAuc: auc === null ? null : round(auc),
  };
}

export const PERFORMANCE_RANGES = {
  '24h': { hours: 24, bucketHours: 1 },
  '7d': { hours: 168, bucketHours: 6 },
} as const;

/**
 * Monitoring (M7, FR-35/36): data drift (Evidently, captured inputs vs training data) and measured
 * performance (predictions joined with ground-truth feedback), kept as SEPARATE signals: inputs
 * can drift while accuracy holds, and accuracy can fall (concept drift) while inputs look normal.
 */
@Injectable()
export class MonitoringService {
  private readonly logger = new Logger(MonitoringService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly captures: CaptureStore,
    private readonly mlWorker: MlWorkerClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private async serving(orgId: string, endpointId: string) {
    const e = await this.prisma.endpoint.findFirst({
      where: { id: endpointId, orgId },
      include: {
        stableRevision: {
          include: { modelVersion: { include: { trainingDataset: true } } },
        },
      },
    });
    if (!e) throw Errors.notFound('Endpoint');
    return e;
  }

  async runDrift(
    orgId: string,
    endpointId: string,
    opts: { windowHours?: number; trigger: 'manual' | 'scheduled' },
  ) {
    const e = await this.serving(orgId, endpointId);
    const mv = e.stableRevision?.modelVersion;
    if (!mv) {
      throw Errors.conflict('NO_READY_REVISION', 'Drift needs a deployed model version.');
    }
    const ds = mv.trainingDataset;
    if (!ds?.storedAt) {
      throw Errors.conflict(
        'DRIFT_REFERENCE_UNAVAILABLE',
        'The serving version has no stored training dataset to compare against. Register it from an MLflow run, or upload the training CSV and link it when uploading the bundle.',
      );
    }
    const features = (mv.signature as unknown as SignatureJson).inputs[0]?.features ?? [];
    const windowEnd = new Date();
    const hours = opts.windowHours ?? this.config.monitoring.driftWindowHours;
    const windowStart = new Date(windowEnd.getTime() - hours * 3_600_000);
    // Rows from any version with the same input width (inputs don't depend on the model).
    const rows = (
      await this.captures.read(orgId, endpointId, windowStart.getTime(), windowEnd.getTime())
    )
      .filter((r) => r.x.length === features.length)
      .slice(0, MAX_DRIFT_SAMPLES);
    if (rows.length < this.config.monitoring.driftMinSamples) {
      throw new AppError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'NOT_ENOUGH_SAMPLES',
        'Not enough captured inputs',
        `${String(rows.length)} captured request(s) in the last ${String(hours)} h; at least ${String(this.config.monitoring.driftMinSamples)} are needed${e.captureInputs ? '' : ' (input capture is off for this endpoint)'}.`,
      );
    }
    const result = await this.mlWorker.drift({
      reference: blobRef(ds.sha256),
      features,
      current: rows.map((r) => r.x),
    });
    const report = await this.prisma.driftReport.create({
      data: {
        orgId,
        endpointId,
        modelVersionId: mv.id,
        referenceDatasetVersionId: ds.id,
        windowStart,
        windowEnd,
        sampleCount: result.currentRows,
        datasetDrift: result.datasetDrift,
        driftShare: result.driftShare,
        featureScores: result.features as unknown as Prisma.InputJsonValue,
        evidentlyVersion: result.evidentlyVersion,
        trigger: opts.trigger,
      },
    });
    return driftDto(report);
  }

  async listDrift(orgId: string, endpointId: string, limit = 30) {
    await this.serving(orgId, endpointId);
    const rows = await this.prisma.driftReport.findMany({
      where: { orgId, endpointId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map(driftDto);
  }

  async performance(orgId: string, endpointId: string, range: keyof typeof PERFORMANCE_RANGES) {
    const e = await this.serving(orgId, endpointId);
    const r = PERFORMANCE_RANGES[range];
    const now = Date.now();
    const since = new Date(now - r.hours * 3_600_000);
    const classes = (
      e.stableRevision?.modelVersion.signature as unknown as SignatureJson | undefined
    )?.outputs.find((o) => o.classes)?.classes ?? [0, 1];
    const positive = String(classes[classes.length - 1] ?? 1);
    const [predictions, labelled] = await Promise.all([
      this.prisma.predictionRecord.count({ where: { endpointId, createdAt: { gte: since } } }),
      this.prisma.$queryRaw<LabelledPrediction[]>`
        SELECT r.created_at AS "createdAt", r.label AS predicted, f.label AS truth, r.score
        FROM prediction_records r JOIN prediction_feedback f ON f.prediction_id = r.id
        WHERE r.endpoint_id = ${endpointId}::uuid AND r.created_at >= ${since}
        ORDER BY r.created_at
        LIMIT 100000`,
    ]);
    const bucketMs = r.bucketHours * 3_600_000;
    const start = Math.floor(since.getTime() / bucketMs) * bucketMs;
    const buckets = [];
    for (let t = start; t <= now; t += bucketMs) {
      const inBucket = labelled.filter((p) => {
        const ms = p.createdAt.getTime();
        return ms >= t && ms < t + bucketMs;
      });
      buckets.push({ start: new Date(t).toISOString(), ...performanceOf(inBucket, positive) });
    }
    return {
      range,
      positiveClass: positive,
      predictions,
      summary: performanceOf(labelled, positive),
      buckets,
    };
  }

  /** Scheduled drift (worker): every endpoint with capture on and a stored reference. */
  async scheduledDrift(): Promise<number> {
    const endpoints = await this.prisma.endpoint.findMany({
      where: { captureInputs: true, stableRevision: { state: 'READY' } },
      select: { id: true, orgId: true },
    });
    let done = 0;
    for (const e of endpoints) {
      try {
        await this.runDrift(e.orgId, e.id, { trigger: 'scheduled' });
        done++;
      } catch (err) {
        // Not enough samples / no reference is normal for quiet endpoints.
        this.logger.debug(`scheduled drift skipped for ${e.id}: ${(err as Error).message}`);
      }
    }
    return done;
  }
}

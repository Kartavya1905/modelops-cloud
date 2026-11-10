import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ArtifactStore } from '../../common/storage/artifact-store';
import { APP_CONFIG, type AppConfig } from '../../config/config';
import type { ModelVersion, Prisma, ValidationResult } from '../../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import { MlflowClient, MlflowError } from '../mlflow/mlflow.client';
import { DatasetsService } from '../registry/datasets';

export const MAX_MODEL_BYTES = 100 * 1024 * 1024;
export const MAX_JSON_BYTES = 1024 * 1024;
const SYSTEM = { userId: null, requestId: undefined, ip: undefined } as const;

export interface CheckDto {
  id: string;
  name: string;
  passed: boolean | null;
  detail: string;
}
export interface WorkerReport {
  result: 'PASSED' | 'FAILED';
  checks: CheckDto[];
  facts: Record<string, unknown>;
}

/** An infrastructure failure: worth retrying, says nothing about the model. */
export class RetryableError extends Error {
  override name = 'RetryableError';
}

const CHECK_NAMES: Record<string, string> = {
  V2: 'Size limits',
  V11: 'SHA-256 matches the stored artifact',
};

/**
 * Validation pipeline (docs/06, section 2.2-2.3), run by the worker process:
 *
 *   claim (CAS PENDING_VALIDATION -> VALIDATING, with a lease)
 *   -> ingest: copy the bundle from MLflow into content-addressed storage, hashing on the server
 *   -> validate: the ML worker runs checks V1-V11 in a sandbox
 *   -> finalize: report + VALIDATED | REJECTED + audit, in one transaction
 *
 * Every step is idempotent, so redelivered jobs and crashed workers are safe.
 */
@Injectable()
export class ValidationService {
  private readonly logger = new Logger(ValidationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: ArtifactStore,
    private readonly mlflow: MlflowClient,
    private readonly audit: AuditService,
    private readonly datasets: DatasetsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Processes one version. Returns false if it was not ours to process (already claimed or done).
   * Throws RetryableError after releasing the claim, so the queue retries later.
   */
  async process(versionId: string, isFinalAttempt: boolean): Promise<boolean> {
    const claimed = await this.prisma.modelVersion.updateMany({
      where: { id: versionId, status: 'PENDING_VALIDATION' },
      data: {
        status: 'VALIDATING',
        validationAttempts: { increment: 1 },
        validationLeaseUntil: new Date(Date.now() + this.config.validation.leaseMs),
      },
    });
    if (claimed.count === 0) return false;
    let version = await this.prisma.modelVersion.findUniqueOrThrow({ where: { id: versionId } });

    try {
      if (!version.artifactSha256) {
        const ingest = await this.ingest(version);
        if ('failure' in ingest) {
          await this.finalize(version, 'FAILED', [ingest.failure], {});
          return true;
        }
        version = ingest.version;
      }
      const report = await this.callWorker(version);
      await this.finalize(version, report.result, report.checks, report.facts);
      return true;
    } catch (err) {
      if (!(err instanceof RetryableError)) throw err;
      if (isFinalAttempt) {
        await this.finalize(version, 'ERROR', [], { error: err.message });
        return true;
      }
      await this.prisma.modelVersion.updateMany({
        where: { id: versionId, status: 'VALIDATING' },
        data: { status: 'PENDING_VALIDATION', validationLeaseUntil: null },
      });
      throw err;
    }
  }

  /** Copies the three bundle files from MLflow into content-addressed storage. */
  private async ingest(
    version: ModelVersion,
  ): Promise<{ version: ModelVersion } | { failure: CheckDto }> {
    const files = [
      { name: 'model.onnx', max: MAX_MODEL_BYTES, type: 'application/octet-stream' },
      { name: 'signature.json', max: MAX_JSON_BYTES, type: 'application/json' },
      { name: 'golden_examples.json', max: MAX_JSON_BYTES, type: 'application/json' },
    ];
    const stored: { sha256: string; size: number }[] = [];
    for (const f of files) {
      let bytes: Buffer;
      try {
        bytes = await this.mlflow.downloadArtifactBytes(version.sourceUri, f.name, f.max);
      } catch (err) {
        if (err instanceof MlflowError && err.status === 413) {
          return {
            failure: { id: 'V2', name: CHECK_NAMES.V2 ?? '', passed: false, detail: err.message },
          };
        }
        if (err instanceof MlflowError && err.isNotFound) {
          return {
            failure: {
              id: 'V2',
              name: CHECK_NAMES.V2 ?? '',
              passed: false,
              detail: `${f.name} is missing`,
            },
          };
        }
        throw new RetryableError(`artifact download failed: ${(err as Error).message}`);
      }
      try {
        const put = await this.store.putIfAbsent(bytes, f.type);
        stored.push({ sha256: put.sha256, size: bytes.length });
      } catch (err) {
        throw new RetryableError(`artifact storage failed: ${(err as Error).message}`);
      }
    }
    const [model, signature, golden] = stored as [
      { sha256: string; size: number },
      { sha256: string; size: number },
      { sha256: string; size: number },
    ];

    // The training run reported a hash; the bytes we received must match it.
    if (version.reportedSha256 && version.reportedSha256 !== model.sha256) {
      return {
        failure: {
          id: 'V11',
          name: CHECK_NAMES.V11 ?? '',
          passed: false,
          detail: `the run reported sha256 ${version.reportedSha256.slice(0, 12)}… but the artifact is ${model.sha256.slice(0, 12)}…`,
        },
      };
    }
    const updated = await this.prisma.modelVersion.update({
      where: { id: version.id },
      data: {
        artifactSha256: model.sha256,
        signatureSha256: signature.sha256,
        goldenSha256: golden.sha256,
        sizeBytes: model.size,
      },
    });
    // M7: also store the training data the run reported (verified by its SHA-256), so this
    // version can be drift-monitored once deployed. Best effort; never fails validation.
    if (updated.trainingDatasetVersionId && updated.mlflowRunId) {
      await this.datasets.ingestFromRun(updated.trainingDatasetVersionId, updated.mlflowRunId);
    }
    return { version: updated };
  }

  private async callWorker(v: ModelVersion): Promise<WorkerReport> {
    const blob = (sha: string | null) => {
      if (!sha) throw new Error('artifact not ingested');
      return { key: ArtifactStore.key(sha), sha256: sha };
    };
    let res: Response;
    try {
      res = await fetch(`${this.config.mlWorker.url}/v1/validate`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-modelops-token': this.config.mlWorker.token,
        },
        body: JSON.stringify({
          versionId: v.id,
          model: blob(v.artifactSha256),
          signature: blob(v.signatureSha256),
          golden: blob(v.goldenSha256),
        }),
        signal: AbortSignal.timeout(180_000),
      });
    } catch (err) {
      throw new RetryableError(`ML worker unreachable: ${(err as Error).message}`);
    }
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300);
      throw new RetryableError(`ML worker answered HTTP ${String(res.status)}: ${text}`);
    }
    const report = (await res.json()) as { result?: unknown; checks?: unknown };
    if (
      (report.result !== 'PASSED' && report.result !== 'FAILED') ||
      !Array.isArray(report.checks)
    ) {
      throw new RetryableError('ML worker returned an unexpected report');
    }
    return report as WorkerReport;
  }

  /** Report + final status + audit in one transaction (CAS on VALIDATING). */
  private async finalize(
    version: ModelVersion,
    result: ValidationResult,
    checks: CheckDto[],
    facts: Record<string, unknown>,
  ): Promise<void> {
    const status = result === 'PASSED' ? 'VALIDATED' : 'REJECTED';
    const failed = checks.filter((c) => c.passed === false).map((c) => c.id);
    const done = await this.prisma.$transaction(async (tx) => {
      const moved = await tx.modelVersion.updateMany({
        where: { id: version.id, status: 'VALIDATING' },
        data: { status, validationLeaseUntil: null, validatedAt: new Date() },
      });
      if (moved.count === 0) return false; // lost the lease to a newer attempt; drop this result
      const current = await tx.modelVersion.findUniqueOrThrow({ where: { id: version.id } });
      await tx.validationReport.create({
        data: {
          orgId: version.orgId,
          versionId: version.id,
          attempt: current.validationAttempts,
          result,
          checks: checks as unknown as Prisma.InputJsonValue,
          facts: facts as Prisma.InputJsonValue,
          validatorVersion:
            typeof facts.validatorVersion === 'string' ? facts.validatorVersion : 'platform',
        },
      });
      await this.audit.record(tx, SYSTEM, {
        orgId: version.orgId,
        action: status === 'VALIDATED' ? 'model_version.validated' : 'model_version.rejected',
        targetType: 'model_version',
        targetId: version.id,
        metadata: { result, failedChecks: failed, attempt: current.validationAttempts },
      });
      return true;
    });
    if (!done) return;
    this.logger.log(
      `model version ${version.id}: ${status} (${result}${failed.length ? `: ${failed.join(',')}` : ''})`,
    );
    await this.syncMlflowStatus(version.id, status);
  }

  private async syncMlflowStatus(versionId: string, status: string): Promise<void> {
    const v = await this.prisma.modelVersion.findUnique({
      where: { id: versionId },
      select: { mlflowVersion: true, model: { select: { mlflowName: true } } },
    });
    if (!v?.mlflowVersion) return;
    try {
      await this.mlflow.setModelVersionTag(
        v.model.mlflowName,
        v.mlflowVersion,
        'modelops.status',
        status,
      );
    } catch (err) {
      this.logger.warn(`MLflow status tag for ${versionId} not updated: ${(err as Error).message}`);
    }
  }

  /**
   * Crash recovery + safety net, run periodically by the worker:
   *  - VALIDATING with an expired lease -> PENDING_VALIDATION (the worker holding it died)
   *  - every PENDING_VALIDATION version -> enqueued (dedup by job id), covering lost jobs
   */
  async sweep(
    enqueue: (versionId: string) => Promise<boolean>,
  ): Promise<{ reclaimed: number; enqueued: number }> {
    const reclaimed = await this.prisma.modelVersion.updateMany({
      where: { status: 'VALIDATING', validationLeaseUntil: { lt: new Date() } },
      data: { status: 'PENDING_VALIDATION', validationLeaseUntil: null },
    });
    const pending = await this.prisma.modelVersion.findMany({
      where: { status: 'PENDING_VALIDATION' },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    let enqueued = 0;
    for (const p of pending) if (await enqueue(p.id)) enqueued++;
    return { reclaimed: reclaimed.count, enqueued };
  }
}

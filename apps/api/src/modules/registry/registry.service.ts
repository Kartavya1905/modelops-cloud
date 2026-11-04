import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AppError, Errors } from '../../common/errors/app-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ArtifactStore } from '../../common/storage/artifact-store';
import type { ActorContext } from '../../common/request-context/request-context';
import { slugify } from '../../common/slug';
import {
  type DatasetVersion,
  type ModelFramework,
  type ModelVersion,
  Prisma,
  type RegisteredModel,
} from '../../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import { ExperimentsService } from '../experiments/experiments.service';
import { MlflowClient, MlflowError, type MlflowRun } from '../mlflow/mlflow.client';
import type {
  CreateModelDto,
  DatasetVersionDto,
  ModelDetailDto,
  ModelDto,
  ModelVersionDto,
  ModelVersionSummaryDto,
} from './registry.dto';
import { parseSignature, type Signature } from './signature';
import { reportDto } from '../validation/validation.controller';
import { ValidationQueue } from '../validation/validation.queue';
import { MAX_JSON_BYTES, MAX_MODEL_BYTES } from '../validation/validation.service';

const BUNDLE_FILES = ['model.onnx', 'signature.json', 'golden_examples.json'] as const;
const FRAMEWORKS: readonly ModelFramework[] = ['SKLEARN_ONNX', 'PYTORCH_ONNX'];
const MAX_SIGNATURE_BYTES = 64 * 1024;
const tag = (run: MlflowRun, key: string) => run.data.tags?.find((t) => t.key === key)?.value;

const unprocessable = (
  code: string,
  detail: string,
  errors?: { field: string; message: string }[],
) =>
  new AppError(HttpStatus.UNPROCESSABLE_ENTITY, code, 'Cannot register this run', detail, errors);

function summary(v: ModelVersion): ModelVersionSummaryDto {
  return {
    id: v.id,
    version: v.version,
    framework: v.framework,
    status: v.status,
    source: v.source,
    mlflowRunId: v.mlflowRunId,
    mlflowVersion: v.mlflowVersion,
    metrics: v.metrics as Record<string, number>,
    createdAt: v.createdAt.toISOString(),
  };
}

function datasetDto(d: DatasetVersion): DatasetVersionDto {
  return {
    id: d.id,
    name: d.name,
    version: d.version,
    sha256: d.sha256,
    rowCount: d.rowCount,
    uri: d.uri,
    generatorParams: d.generatorParams as Record<string, string>,
    createdAt: d.createdAt.toISOString(),
  };
}

/**
 * Model registry. Postgres is the source of truth; the MLflow Model Registry is a mirror, so
 * data scientists see the same models in the MLflow UI. Every version starts as
 * PENDING_VALIDATION: nothing registered here can be deployed until M4's validator passes it.
 */
@Injectable()
export class RegistryService {
  private readonly logger = new Logger(RegistryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly mlflow: MlflowClient,
    private readonly experiments: ExperimentsService,
    private readonly store: ArtifactStore,
    private readonly validationQueue: ValidationQueue,
  ) {}

  // ------------------------------------------------------------------------------ models

  async createModel(
    orgId: string,
    projectId: string,
    dto: CreateModelDto,
    actor: ActorContext,
  ): Promise<ModelDto> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, orgId },
      include: { org: { select: { slug: true } } },
    });
    if (!project) throw Errors.notFound('Project');
    if (project.archivedAt) throw Errors.conflict('PROJECT_ARCHIVED', 'This project is archived.');

    const slug = slugify(dto.name);
    const mlflowName = `${project.org.slug}.${project.slug}.${slug}`;
    if (await this.prisma.registeredModel.findFirst({ where: { projectId, slug } })) {
      throw Errors.conflict(
        'MODEL_NAME_TAKEN',
        `A model named "${slug}" already exists in this project.`,
      );
    }

    // Mirror first: idempotent (a retry after a crash finds its own entry by tag), and if MLflow
    // is down nothing is half-created in Postgres.
    try {
      await this.mlflow.createRegisteredModel(
        mlflowName,
        [
          { key: 'modelops.org_id', value: orgId },
          { key: 'modelops.project_id', value: projectId },
        ],
        dto.description,
      );
    } catch (err) {
      if (!(err instanceof MlflowError && err.alreadyExists)) throw err;
      const existing = await this.mlflow.getRegisteredModel(mlflowName);
      if (!existing?.tags?.some((t) => t.key === 'modelops.project_id' && t.value === projectId)) {
        throw Errors.conflict(
          'MLFLOW_NAME_CONFLICT',
          `MLflow already has a model named ${mlflowName}.`,
        );
      }
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const model = await tx.registeredModel.create({
          data: {
            orgId,
            projectId,
            slug,
            name: dto.name,
            description: dto.description ?? null,
            mlflowName,
            createdById: actor.userId,
          },
        });
        await this.audit.record(tx, actor, {
          orgId,
          action: 'model.created',
          targetType: 'model',
          targetId: model.id,
          metadata: { slug, mlflowName },
        });
        return this.toModel(model, 0, null);
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw Errors.conflict(
          'MODEL_NAME_TAKEN',
          `A model named "${slug}" already exists in this project.`,
        );
      }
      throw err;
    }
  }

  private toModel(m: RegisteredModel, versionCount: number, latest: ModelVersion | null): ModelDto {
    return {
      id: m.id,
      projectId: m.projectId,
      slug: m.slug,
      name: m.name,
      description: m.description,
      taskType: m.taskType,
      mlflowName: m.mlflowName,
      versionCount,
      latestVersion: latest ? summary(latest) : null,
      createdAt: m.createdAt.toISOString(),
    };
  }

  async listModels(orgId: string, projectId: string): Promise<ModelDto[]> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, orgId },
      select: { id: true },
    });
    if (!project) throw Errors.notFound('Project');
    const models = await this.prisma.registeredModel.findMany({
      where: { orgId, projectId },
      orderBy: { createdAt: 'desc' },
      include: {
        versions: { orderBy: { version: 'desc' }, take: 1 },
        _count: { select: { versions: true } },
      },
    });
    return models.map((m) => this.toModel(m, m._count.versions, m.versions[0] ?? null));
  }

  async getModel(orgId: string, modelId: string): Promise<ModelDetailDto> {
    const m = await this.prisma.registeredModel.findFirst({
      where: { id: modelId, orgId },
      include: {
        versions: { orderBy: { version: 'desc' } },
        project: { select: { id: true, name: true, slug: true } },
      },
    });
    if (!m) throw Errors.notFound('Model');
    return {
      ...this.toModel(m, m.versions.length, m.versions[0] ?? null),
      project: m.project,
      versions: m.versions.map(summary),
    };
  }

  // ---------------------------------------------------------------------------- versions

  /** Reads and checks everything needed from the run *before* writing anything. */
  private async inspectRun(orgId: string, projectId: string, runId: string) {
    const e = await this.experiments.ensureExperiment(orgId, projectId);
    if (e.project.archivedAt)
      throw Errors.conflict('PROJECT_ARCHIVED', 'This project is archived.');
    const run = await this.experiments.requireRun(e, runId);
    if (run.info.status !== 'FINISHED') {
      throw Errors.conflict(
        'RUN_NOT_FINISHED',
        `The run is ${run.info.status}; only finished runs can be registered.`,
      );
    }

    const bundlePath = tag(run, 'modelops.bundle.path') ?? 'model';
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(bundlePath)) {
      throw unprocessable('BUNDLE_INCOMPLETE', 'The run’s bundle path tag is invalid.');
    }
    const files = await this.mlflow.listArtifacts(runId, bundlePath);
    const present = new Set(files.filter((f) => !f.is_dir).map((f) => f.path.split('/').pop()));
    const missing = BUNDLE_FILES.filter((f) => !present.has(f));
    if (missing.length > 0) {
      throw unprocessable(
        'BUNDLE_INCOMPLETE',
        `The run's "${bundlePath}/" artifacts are missing: ${missing.join(', ')}.`,
        missing.map((f) => ({ field: `${bundlePath}/${f}`, message: 'is missing' })),
      );
    }

    let signatureText: string;
    try {
      signatureText = await this.mlflow.downloadArtifactText(
        run.info.artifact_uri,
        `${bundlePath}/signature.json`,
        MAX_SIGNATURE_BYTES,
      );
    } catch (err) {
      if (err instanceof MlflowError && err.status === 413) {
        throw unprocessable('SIGNATURE_INVALID', 'signature.json is larger than 64 KB.');
      }
      throw err;
    }
    const parsed = parseSignature(signatureText);
    if (!parsed.ok) {
      throw unprocessable(
        'SIGNATURE_INVALID',
        'signature.json does not match the expected schema.',
        parsed.errors,
      );
    }

    const framework = tag(run, 'modelops.framework') as ModelFramework | undefined;
    if (!framework || !FRAMEWORKS.includes(framework)) {
      throw unprocessable(
        'UNSUPPORTED_FRAMEWORK',
        `The run's modelops.framework tag must be one of ${FRAMEWORKS.join(', ')}.`,
      );
    }
    const reportedSha = tag(run, 'modelops.bundle.sha256');
    return {
      run,
      bundlePath,
      signature: parsed.value,
      framework,
      reportedSha256: reportedSha && /^[0-9a-f]{64}$/.test(reportedSha) ? reportedSha : null,
    };
  }

  async importVersion(
    orgId: string,
    modelId: string,
    runId: string,
    actor: ActorContext,
  ): Promise<ModelVersionDto> {
    const model = await this.prisma.registeredModel.findFirst({ where: { id: modelId, orgId } });
    if (!model) throw Errors.notFound('Model');
    const info = await this.inspectRun(orgId, model.projectId, runId);
    const { run } = info;

    let created: ModelVersion;
    try {
      created = await this.prisma.$transaction(async (tx) => {
        // Serialize version numbering per model.
        await tx.$queryRaw`SELECT id FROM registered_models WHERE id = ${modelId}::uuid FOR UPDATE`;
        if (await tx.modelVersion.findFirst({ where: { modelId, mlflowRunId: runId } })) {
          throw Errors.conflict(
            'RUN_ALREADY_REGISTERED',
            'This run is already a version of this model.',
          );
        }

        const datasetSha = tag(run, 'modelops.dataset.sha256');
        let datasetId: string | null = null;
        if (datasetSha && /^[0-9a-f]{64}$/.test(datasetSha)) {
          const generatorParams = Object.fromEntries(
            (run.data.params ?? [])
              .filter((p) => p.key.startsWith('dataset.'))
              .map((p) => [p.key, p.value]),
          );
          const rows = Number(tag(run, 'modelops.dataset.rows'));
          const ds = await tx.datasetVersion.upsert({
            where: { projectId_sha256: { projectId: model.projectId, sha256: datasetSha } },
            update: {},
            create: {
              orgId,
              projectId: model.projectId,
              name: tag(run, 'modelops.dataset.name') ?? 'dataset',
              version: tag(run, 'modelops.dataset.version') ?? datasetSha.slice(0, 12),
              sha256: datasetSha,
              rowCount: Number.isInteger(rows) && rows > 0 ? rows : null,
              uri: `runs:/${runId}/dataset/train.csv`,
              generatorParams,
            },
          });
          datasetId = ds.id;
        }

        const last = await tx.modelVersion.aggregate({
          where: { modelId },
          _max: { version: true },
        });
        const version = (last._max.version ?? 0) + 1;
        const v = await tx.modelVersion.create({
          data: {
            orgId,
            modelId,
            version,
            framework: info.framework,
            mlflowRunId: runId,
            sourceUri: `${run.info.artifact_uri}/${info.bundlePath}`,
            reportedSha256: info.reportedSha256,
            signature: info.signature,
            metrics: Object.fromEntries((run.data.metrics ?? []).map((m) => [m.key, m.value])),
            trainingDatasetVersionId: datasetId,
            createdById: actor.userId,
          },
        });
        await this.audit.record(tx, actor, {
          orgId,
          action: 'model_version.registered',
          targetType: 'model_version',
          targetId: v.id,
          metadata: { model: model.slug, version, runId, framework: info.framework },
        });
        return v;
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw Errors.conflict(
          'RUN_ALREADY_REGISTERED',
          'This run is already a version of this model.',
        );
      }
      throw err;
    }

    // Mirror to the MLflow registry after commit. A failure here is reported, never hidden:
    // the version exists in the platform with mlflowVersion = null.
    let mlflowSyncError: string | null = null;
    try {
      const mlflowVersion = await this.mlflow.createModelVersion(
        model.mlflowName,
        created.sourceUri,
        runId,
        [
          { key: 'modelops.version_id', value: created.id },
          { key: 'modelops.status', value: created.status },
        ],
      );
      created = await this.prisma.modelVersion.update({
        where: { id: created.id },
        data: { mlflowVersion },
      });
    } catch (err) {
      mlflowSyncError = err instanceof Error ? err.message : 'MLflow mirror failed';
      this.logger.warn(`MLflow mirror for model version ${created.id} failed: ${mlflowSyncError}`);
    }
    await this.validationQueue.enqueue(created.id);
    return { ...(await this.getVersion(orgId, created.id)), mlflowSyncError };
  }

  /**
   * Registers an uploaded bundle (no MLflow run). The files are hashed on the server and stored
   * content-addressed *before* the version row exists, then validated like any other version.
   */
  async uploadVersion(
    orgId: string,
    modelId: string,
    upload: { framework: string; model: Buffer; signature: Buffer; golden: Buffer },
    actor: ActorContext,
  ): Promise<ModelVersionDto> {
    const model = await this.prisma.registeredModel.findFirst({
      where: { id: modelId, orgId },
      include: { project: { select: { archivedAt: true } } },
    });
    if (!model) throw Errors.notFound('Model');
    if (model.project.archivedAt)
      throw Errors.conflict('PROJECT_ARCHIVED', 'This project is archived.');
    if (!FRAMEWORKS.includes(upload.framework as ModelFramework)) {
      throw unprocessable(
        'UNSUPPORTED_FRAMEWORK',
        `framework must be one of ${FRAMEWORKS.join(', ')}.`,
      );
    }
    if (upload.model.length > MAX_MODEL_BYTES) {
      throw new AppError(
        HttpStatus.PAYLOAD_TOO_LARGE,
        'ARTIFACT_TOO_LARGE',
        'Artifact too large',
        `model.onnx is larger than ${String(MAX_MODEL_BYTES)} bytes.`,
      );
    }
    if (upload.signature.length > MAX_JSON_BYTES || upload.golden.length > MAX_JSON_BYTES) {
      throw new AppError(
        HttpStatus.PAYLOAD_TOO_LARGE,
        'ARTIFACT_TOO_LARGE',
        'Artifact too large',
        'signature.json and golden_examples.json must be at most 1 MB.',
      );
    }
    const parsed = parseSignature(upload.signature.toString('utf8'));
    if (!parsed.ok) {
      throw unprocessable(
        'SIGNATURE_INVALID',
        'signature.json does not match the expected schema.',
        parsed.errors,
      );
    }

    const [m, s, g] = await Promise.all([
      this.store.putIfAbsent(upload.model, 'application/octet-stream'),
      this.store.putIfAbsent(upload.signature, 'application/json'),
      this.store.putIfAbsent(upload.golden, 'application/json'),
    ]);
    const created = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM registered_models WHERE id = ${modelId}::uuid FOR UPDATE`;
      const last = await tx.modelVersion.aggregate({ where: { modelId }, _max: { version: true } });
      const version = (last._max.version ?? 0) + 1;
      const v = await tx.modelVersion.create({
        data: {
          orgId,
          modelId,
          version,
          framework: upload.framework as ModelFramework,
          source: 'UPLOAD',
          sourceUri: `s3://${this.store.bucket}/blobs/sha256/${m.sha256}`,
          signature: parsed.value,
          artifactSha256: m.sha256,
          signatureSha256: s.sha256,
          goldenSha256: g.sha256,
          sizeBytes: upload.model.length,
          createdById: actor.userId,
        },
      });
      await this.audit.record(tx, actor, {
        orgId,
        action: 'model_version.registered',
        targetType: 'model_version',
        targetId: v.id,
        metadata: {
          model: model.slug,
          version,
          framework: upload.framework,
          source: 'UPLOAD',
          sha256: m.sha256,
        },
      });
      return v;
    });

    let mlflowSyncError: string | null = null;
    try {
      const mlflowVersion = await this.mlflow.createModelVersion(
        model.mlflowName,
        created.sourceUri,
        null,
        [
          { key: 'modelops.version_id', value: created.id },
          { key: 'modelops.status', value: created.status },
        ],
      );
      await this.prisma.modelVersion.update({ where: { id: created.id }, data: { mlflowVersion } });
    } catch (err) {
      mlflowSyncError = err instanceof Error ? err.message : 'MLflow mirror failed';
    }
    await this.validationQueue.enqueue(created.id);
    return { ...(await this.getVersion(orgId, created.id)), mlflowSyncError };
  }

  async getVersion(orgId: string, versionId: string): Promise<ModelVersionDto> {
    const v = await this.prisma.modelVersion.findFirst({
      where: { id: versionId, orgId },
      include: {
        trainingDataset: true,
        validations: { orderBy: { createdAt: 'desc' }, take: 1 },
        model: {
          select: {
            id: true,
            name: true,
            mlflowName: true,
            project: { select: { id: true, name: true, slug: true } },
          },
        },
      },
    });
    if (!v) throw Errors.notFound('Model version');
    return {
      ...summary(v),
      model: v.model,
      sourceUri: v.sourceUri,
      reportedSha256: v.reportedSha256,
      signature: v.signature as Signature,
      trainingDataset: v.trainingDataset ? datasetDto(v.trainingDataset) : null,
      artifactSha256: v.artifactSha256,
      sizeBytes: v.sizeBytes,
      validationAttempts: v.validationAttempts,
      validatedAt: v.validatedAt?.toISOString() ?? null,
      latestValidation: v.validations[0] ? reportDto(v.validations[0]) : null,
      mlflowSyncError: null,
    };
  }

  async listDatasets(orgId: string, projectId: string): Promise<DatasetVersionDto[]> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, orgId },
      select: { id: true },
    });
    if (!project) throw Errors.notFound('Project');
    const rows = await this.prisma.datasetVersion.findMany({
      where: { orgId, projectId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(datasetDto);
  }
}

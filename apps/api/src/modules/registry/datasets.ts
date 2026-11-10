import { createHash } from 'node:crypto';
import {
  Body,
  Controller,
  HttpStatus,
  Injectable,
  Logger,
  Param,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiCookieAuth, ApiCreatedResponse, ApiTags } from '@nestjs/swagger';
import { OrgAccessGuard, RequirePermission } from '../../common/authz/org-access.guard';
import { AppError, Errors } from '../../common/errors/app-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Actor, type ActorContext } from '../../common/request-context/request-context';
import { ArtifactStore } from '../../common/storage/artifact-store';
import { UuidParam } from '../../common/validation';
import type { DatasetVersion } from '../../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import { MlflowClient } from '../mlflow/mlflow.client';
import { DatasetVersionDto } from './registry.dto';

export const MAX_DATASET_BYTES = 100 * 1024 * 1024;
const COLUMN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** Header + row count of a CSV, rejecting anything that isn't a plain, well-formed table. */
export function inspectCsv(bytes: Buffer): { columns: string[]; rows: number } {
  const text = bytes.toString('utf8');
  if (text.includes('�')) throw new Error('the file is not valid UTF-8');
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const header = lines[0];
  if (!header) throw new Error('the file is empty');
  const columns = header.split(',').map((c) => c.trim());
  const bad = columns.filter((c) => !COLUMN.test(c));
  if (bad.length) throw new Error(`invalid column names: ${bad.slice(0, 5).join(', ')}`);
  if (new Set(columns).size !== columns.length) throw new Error('duplicate column names');
  const ragged = lines.findIndex((l, i) => i > 0 && l.split(',').length !== columns.length);
  if (ragged > 0) throw new Error(`line ${String(ragged + 1)} has the wrong number of values`);
  if (lines.length < 2) throw new Error('the file has no rows');
  return { columns, rows: lines.length - 1 };
}

export function datasetDto(d: DatasetVersion): DatasetVersionDto {
  return {
    id: d.id,
    name: d.name,
    version: d.version,
    sha256: d.sha256,
    rowCount: d.rowCount,
    uri: d.uri,
    generatorParams: d.generatorParams as Record<string, string>,
    stored: d.storedAt !== null,
    columns: d.columns,
    createdAt: d.createdAt.toISOString(),
  };
}

/**
 * Dataset versions as bytes, not just lineage (M7): drift needs the training data as reference,
 * evaluations need held-out labelled data. Stored content-addressed like model artifacts, so the
 * SHA-256 that names a dataset version is also proof its bytes are unchanged.
 */
@Injectable()
export class DatasetsService {
  private readonly logger = new Logger(DatasetsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: ArtifactStore,
    private readonly audit: AuditService,
    private readonly mlflow: MlflowClient,
  ) {}

  async upload(
    orgId: string,
    projectId: string,
    file: Buffer,
    meta: { name: string; version: string },
    actor: ActorContext,
  ): Promise<DatasetVersionDto> {
    const project = await this.prisma.project.findFirst({ where: { id: projectId, orgId } });
    if (!project) throw Errors.notFound('Project');
    if (project.archivedAt) throw Errors.conflict('PROJECT_ARCHIVED', 'This project is archived.');
    let shape: { columns: string[]; rows: number };
    try {
      shape = inspectCsv(file);
    } catch (err) {
      throw new AppError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'INVALID_DATASET',
        'The file is not a usable CSV dataset',
        (err as Error).message,
      );
    }
    const { sha256 } = await this.store.putIfAbsent(file, 'text/csv');
    const d = await this.prisma.$transaction(async (tx) => {
      const row = await tx.datasetVersion.upsert({
        where: { projectId_sha256: { projectId, sha256 } },
        // Same bytes uploaded again: same dataset version (content addressing), now stored.
        update: { storedAt: new Date(), columns: shape.columns, rowCount: shape.rows },
        create: {
          orgId,
          projectId,
          name: meta.name,
          version: meta.version,
          sha256,
          rowCount: shape.rows,
          uri: `s3://${this.store.bucket}/${ArtifactStore.key(sha256)}`,
          storedAt: new Date(),
          columns: shape.columns,
        },
      });
      await this.audit.record(tx, actor, {
        orgId,
        action: 'dataset.uploaded',
        targetType: 'dataset_version',
        targetId: row.id,
        metadata: { sha256, rows: shape.rows },
      });
      return row;
    });
    return datasetDto(d);
  }

  /**
   * Copies an MLflow run's training CSV into storage, but only if its bytes hash to the dataset
   * version the run reported. Best effort: a version without stored training data can still be
   * validated and deployed; it just can't be drift-monitored until the data is there.
   */
  async ingestFromRun(datasetVersionId: string, runId: string): Promise<boolean> {
    const d = await this.prisma.datasetVersion.findUnique({ where: { id: datasetVersionId } });
    if (!d || d.storedAt) return d !== null;
    try {
      const run = await this.mlflow.getRun(runId);
      if (!run) return false;
      const bytes = await this.mlflow.downloadArtifactBytes(
        run.info.artifact_uri,
        'dataset/train.csv',
        MAX_DATASET_BYTES,
      );
      const actual = createHash('sha256').update(bytes).digest('hex');
      if (actual !== d.sha256) {
        this.logger.warn(
          `dataset ${d.id}: run ${runId} reported sha256 ${d.sha256.slice(0, 12)}… but the file is ${actual.slice(0, 12)}…; not stored`,
        );
        return false;
      }
      const shape = inspectCsv(bytes);
      await this.store.putIfAbsent(bytes, 'text/csv');
      await this.prisma.datasetVersion.update({
        where: { id: d.id },
        data: { storedAt: new Date(), columns: shape.columns, rowCount: shape.rows },
      });
      return true;
    } catch (err) {
      this.logger.warn(`dataset ${d.id} not ingested: ${(err as Error).message}`);
      return false;
    }
  }
}

@ApiTags('registry')
@ApiCookieAuth('session')
@UseGuards(OrgAccessGuard)
@Controller('orgs/:orgId/projects/:projectId/datasets')
export class DatasetsController {
  constructor(private readonly datasets: DatasetsService) {}

  @Post()
  @RequirePermission('dataset:create')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_DATASET_BYTES, files: 1, fields: 2 } }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'name', 'version'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'CSV with a header row (max 100 MB)',
        },
        name: { type: 'string', example: 'churn-holdout' },
        version: { type: 'string', example: 'seed11-n4000' },
      },
    },
  })
  @ApiCreatedResponse({
    type: DatasetVersionDto,
    description: 'Stored content-addressed; the same bytes always give the same dataset version',
  })
  upload(
    @Param('orgId', new UuidParam('Organization')) orgId: string,
    @Param('projectId', new UuidParam('Project')) projectId: string,
    @UploadedFile() file: { buffer: Buffer } | undefined,
    @Body('name') name: unknown,
    @Body('version') version: unknown,
    @Actor() actor: ActorContext,
  ) {
    const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    const errors = [
      ...(!file ? [{ field: 'file', message: 'is required' }] : []),
      ...(text(name).length < 2 || text(name).length > 80
        ? [{ field: 'name', message: 'must be 2-80 characters' }]
        : []),
      ...(text(version).length < 1 || text(version).length > 80
        ? [{ field: 'version', message: 'must be 1-80 characters' }]
        : []),
    ];
    if (errors.length || !file) throw Errors.validation(errors);
    return this.datasets.upload(
      orgId,
      projectId,
      file.buffer,
      { name: text(name), version: text(version) },
      actor,
    );
  }
}

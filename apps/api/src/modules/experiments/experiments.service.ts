import { HttpStatus, Injectable } from '@nestjs/common';
import { AppError, Errors } from '../../common/errors/app-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import { MlflowClient, MlflowError, type MlflowRun } from '../mlflow/mlflow.client';
import {
  type ExperimentDto,
  type MetricPointDto,
  RUN_ID,
  type RegisteredAsDto,
  type RunComparisonDto,
  type RunDetailDto,
  type RunDto,
} from './experiments.dto';

export interface ProjectExperiment {
  project: { id: string; orgId: string; slug: string; name: string; archivedAt: Date | null };
  orgSlug: string;
  experimentId: string;
  experimentName: string;
}

const tagValue = (run: MlflowRun, key: string) => run.data.tags?.find((t) => t.key === key)?.value;
const iso = (ms: number | undefined) => (ms ? new Date(ms).toISOString() : null);

/**
 * Read-only, project-scoped view of MLflow.
 * Tenant isolation: a project maps to exactly one MLflow experiment, and every run returned
 * (or looked up by id) must belong to that experiment, otherwise it is "not found".
 */
@Injectable()
export class ExperimentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mlflow: MlflowClient,
  ) {}

  static experimentName(orgSlug: string, projectSlug: string): string {
    return `modelops/${orgSlug}/${projectSlug}`;
  }

  /** Returns the project's experiment, creating it (and remembering its id) on first use. */
  async ensureExperiment(orgId: string, projectId: string): Promise<ProjectExperiment> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, orgId },
      select: {
        id: true,
        orgId: true,
        slug: true,
        name: true,
        archivedAt: true,
        mlflowExperimentId: true,
        org: { select: { slug: true } },
      },
    });
    if (!project) throw Errors.notFound('Project');
    const name = ExperimentsService.experimentName(project.org.slug, project.slug);
    const base = { project, orgSlug: project.org.slug, experimentName: name };
    if (project.mlflowExperimentId) return { ...base, experimentId: project.mlflowExperimentId };

    // The training script may have created it already (mlflow.set_experiment); adopt it.
    let experiment = await this.mlflow.getExperimentByName(name);
    let experimentId = experiment?.experiment_id;
    if (!experimentId) {
      try {
        experimentId = await this.mlflow.createExperiment(name, [
          { key: 'modelops.org_id', value: orgId },
          { key: 'modelops.project_id', value: projectId },
        ]);
      } catch (err) {
        if (!(err instanceof MlflowError && err.alreadyExists)) throw err;
        experiment = await this.mlflow.getExperimentByName(name); // lost a creation race
        experimentId = experiment?.experiment_id;
      }
    } else if (!experiment?.tags?.some((t) => t.key === 'modelops.project_id')) {
      await this.mlflow.setExperimentTag(experimentId, 'modelops.project_id', projectId);
    }
    if (!experimentId)
      throw new AppError(HttpStatus.BAD_GATEWAY, 'MLFLOW_UNAVAILABLE', 'MLflow unavailable');

    // Compare-and-set: concurrent first requests store the same id once.
    await this.prisma.project.updateMany({
      where: { id: projectId, mlflowExperimentId: null },
      data: { mlflowExperimentId: experimentId },
    });
    return { ...base, experimentId };
  }

  async describe(orgId: string, projectId: string): Promise<ExperimentDto> {
    const e = await this.ensureExperiment(orgId, projectId);
    return {
      experimentId: e.experimentId,
      name: e.experimentName,
      trainCommands: [
        `uv run --directory ml python -m modelops_ml.train_sklearn --experiment ${e.experimentName}`,
        `uv run --directory ml python -m modelops_ml.train_pytorch --experiment ${e.experimentName}`,
      ],
    };
  }

  /** The run, if (and only if) it belongs to this project's experiment and is not deleted. */
  async requireRun(e: ProjectExperiment, runId: string): Promise<MlflowRun> {
    if (!RUN_ID.test(runId)) throw Errors.notFound('Run');
    const run = await this.mlflow.getRun(runId);
    if (
      !run ||
      run.info.experiment_id !== e.experimentId ||
      run.info.lifecycle_stage !== 'active'
    ) {
      throw Errors.notFound('Run');
    }
    return run;
  }

  private async registeredAs(
    projectId: string,
    runIds: string[],
  ): Promise<Map<string, RegisteredAsDto[]>> {
    const versions = await this.prisma.modelVersion.findMany({
      where: { mlflowRunId: { in: runIds }, model: { projectId } },
      select: {
        id: true,
        version: true,
        mlflowRunId: true,
        model: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    const out = new Map<string, RegisteredAsDto[]>();
    for (const v of versions) {
      if (!v.mlflowRunId) continue;
      const list = out.get(v.mlflowRunId) ?? [];
      list.push({
        modelId: v.model.id,
        modelName: v.model.name,
        versionId: v.id,
        version: v.version,
      });
      out.set(v.mlflowRunId, list);
    }
    return out;
  }

  private toRun(run: MlflowRun, registered: RegisteredAsDto[]): RunDto {
    const datasetSha = tagValue(run, 'modelops.dataset.sha256');
    return {
      runId: run.info.run_id,
      name: run.info.run_name ?? tagValue(run, 'mlflow.runName') ?? run.info.run_id.slice(0, 8),
      status: run.info.status,
      startTime: iso(run.info.start_time),
      endTime: iso(run.info.end_time),
      durationMs:
        run.info.start_time && run.info.end_time ? run.info.end_time - run.info.start_time : null,
      framework: tagValue(run, 'modelops.framework') ?? null,
      dataset: datasetSha
        ? {
            name: tagValue(run, 'modelops.dataset.name') ?? 'unknown',
            version: tagValue(run, 'modelops.dataset.version') ?? 'unknown',
            sha256: datasetSha,
          }
        : null,
      metrics: Object.fromEntries((run.data.metrics ?? []).map((m) => [m.key, m.value])),
      params: Object.fromEntries((run.data.params ?? []).map((p) => [p.key, p.value])),
      registeredAs: registered,
    };
  }

  private async toDetail(run: MlflowRun, registered: RegisteredAsDto[]): Promise<RunDetailDto> {
    // MLflow's run payload only has each metric's latest value; fetch history for curve metrics.
    const curveKeys = (run.data.metrics ?? []).filter((m) => m.step > 0).map((m) => m.key);
    const series: Record<string, MetricPointDto[]> = {};
    await Promise.all(
      curveKeys.map(async (key) => {
        const history = await this.mlflow.metricHistory(run.info.run_id, key);
        series[key] = history.map((h) => ({ step: h.step, value: h.value }));
      }),
    );
    return {
      ...this.toRun(run, registered),
      tags: Object.fromEntries(
        (run.data.tags ?? [])
          .filter((t) => t.key.startsWith('modelops.'))
          .map((t) => [t.key, t.value]),
      ),
      series,
    };
  }

  async listRuns(
    orgId: string,
    projectId: string,
    q: { limit: number; cursor?: string | undefined },
  ): Promise<{ data: RunDto[]; nextCursor: string | null }> {
    const e = await this.ensureExperiment(orgId, projectId);
    const { runs, nextPageToken } = await this.mlflow
      .searchRuns(e.experimentId, {
        maxResults: q.limit,
        pageToken: q.cursor,
      })
      .catch((err: unknown) => {
        if (err instanceof MlflowError && err.status === 400) {
          throw Errors.validation([{ field: 'cursor', message: 'cursor is invalid' }]);
        }
        throw err;
      });
    const registered = await this.registeredAs(
      projectId,
      runs.map((r) => r.info.run_id),
    );
    return {
      data: runs.map((r) => this.toRun(r, registered.get(r.info.run_id) ?? [])),
      nextCursor: nextPageToken,
    };
  }

  async getRun(orgId: string, projectId: string, runId: string): Promise<RunDetailDto> {
    const e = await this.ensureExperiment(orgId, projectId);
    const run = await this.requireRun(e, runId);
    const registered = await this.registeredAs(projectId, [runId]);
    return this.toDetail(run, registered.get(runId) ?? []);
  }

  async compare(orgId: string, projectId: string, ids: string[]): Promise<RunComparisonDto> {
    const unique = [...new Set(ids)];
    if (unique.length < 2) {
      throw Errors.validation([
        { field: 'ids', message: 'compare needs at least 2 different runs' },
      ]);
    }
    const e = await this.ensureExperiment(orgId, projectId);
    const runs = await Promise.all(unique.map((id) => this.requireRun(e, id)));
    const registered = await this.registeredAs(projectId, unique);
    const details = await Promise.all(
      runs.map((r) => this.toDetail(r, registered.get(r.info.run_id) ?? [])),
    );

    const metricKeys = [...new Set(details.flatMap((d) => Object.keys(d.metrics)))].sort();
    const paramKeys = [...new Set(details.flatMap((d) => Object.keys(d.params)))].sort();
    const differingParams = paramKeys.filter(
      (k) => new Set(details.map((d) => d.params[k] ?? '∅')).size > 1,
    );
    return { runs: details, metricKeys, differingParams };
  }
}

import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { AppError } from '../../common/errors/app-error';
import { APP_CONFIG, type AppConfig } from '../../config/config';

// ---- MLflow REST shapes (only the fields we use) ---------------------------------------------
export interface MlflowTag {
  key: string;
  value: string;
}
export interface MlflowMetric {
  key: string;
  value: number;
  timestamp: number;
  step: number;
}
export interface MlflowRun {
  info: {
    run_id: string;
    run_name?: string;
    experiment_id: string;
    status: 'RUNNING' | 'SCHEDULED' | 'FINISHED' | 'FAILED' | 'KILLED';
    start_time?: number;
    end_time?: number;
    artifact_uri: string;
    lifecycle_stage: 'active' | 'deleted';
  };
  data: { metrics?: MlflowMetric[]; params?: MlflowTag[]; tags?: MlflowTag[] };
}
export interface MlflowExperiment {
  experiment_id: string;
  name: string;
  lifecycle_stage: string;
  tags?: MlflowTag[];
}
export interface MlflowFileInfo {
  path: string;
  is_dir: boolean;
  file_size?: number;
}

export class MlflowError extends Error {
  constructor(
    readonly status: number,
    readonly errorCode: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'MlflowError';
  }
  get isNotFound(): boolean {
    return this.status === 404 || this.errorCode === 'RESOURCE_DOES_NOT_EXIST';
  }
  get alreadyExists(): boolean {
    return this.errorCode === 'RESOURCE_ALREADY_EXISTS';
  }
}

export const mlflowUnavailable = (detail: string) =>
  new AppError(HttpStatus.BAD_GATEWAY, 'MLFLOW_UNAVAILABLE', 'MLflow unavailable', detail);

/**
 * Thin, typed client for the MLflow tracking server's REST API.
 * MLflow is an internal dependency: it is only reachable from the platform, and every lookup
 * made on behalf of a user is scoped to that user's project by the calling service.
 */
@Injectable()
export class MlflowClient {
  private readonly logger = new Logger(MlflowClient.name);

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  private async request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    opts: { query?: Record<string, string>; body?: unknown } = {},
  ): Promise<T> {
    const url = new URL(`${this.config.mlflowUrl}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: opts.body === undefined ? {} : { 'content-type': 'application/json' },
        body: opts.body === undefined ? null : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(this.config.mlflowTimeoutMs),
      });
    } catch (err) {
      this.logger.warn(`MLflow ${method} ${path} failed: ${(err as Error).message}`);
      throw mlflowUnavailable('The experiment tracking service did not respond.');
    }
    const text = await res.text();
    if (!res.ok) {
      let code: string | undefined;
      let message = text.slice(0, 300);
      try {
        const body = JSON.parse(text) as { error_code?: string; message?: string };
        code = body.error_code;
        message = body.message ?? message;
      } catch {
        // not JSON
      }
      if (res.status >= 500) {
        this.logger.warn(`MLflow ${method} ${path} -> ${String(res.status)}: ${message}`);
        throw mlflowUnavailable('The experiment tracking service returned an error.');
      }
      throw new MlflowError(res.status, code, message);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  // ---- experiments ---------------------------------------------------------------------------

  async getExperimentByName(name: string): Promise<MlflowExperiment | null> {
    try {
      const r = await this.request<{ experiment: MlflowExperiment }>(
        'GET',
        '/api/2.0/mlflow/experiments/get-by-name',
        { query: { experiment_name: name } },
      );
      return r.experiment;
    } catch (err) {
      if (err instanceof MlflowError && err.isNotFound) return null;
      throw err;
    }
  }

  async createExperiment(name: string, tags: MlflowTag[]): Promise<string> {
    const r = await this.request<{ experiment_id: string }>(
      'POST',
      '/api/2.0/mlflow/experiments/create',
      { body: { name, tags } },
    );
    return r.experiment_id;
  }

  async setExperimentTag(experimentId: string, key: string, value: string): Promise<void> {
    await this.request('POST', '/api/2.0/mlflow/experiments/set-experiment-tag', {
      body: { experiment_id: experimentId, key, value },
    });
  }

  // ---- runs ------------------------------------------------------------------------------------

  async searchRuns(
    experimentId: string,
    opts: { maxResults: number; pageToken?: string | undefined },
  ): Promise<{ runs: MlflowRun[]; nextPageToken: string | null }> {
    const r = await this.request<{ runs?: MlflowRun[]; next_page_token?: string }>(
      'POST',
      '/api/2.0/mlflow/runs/search',
      {
        body: {
          experiment_ids: [experimentId],
          max_results: opts.maxResults,
          order_by: ['attributes.start_time DESC'],
          run_view_type: 'ACTIVE_ONLY',
          ...(opts.pageToken && { page_token: opts.pageToken }),
        },
      },
    );
    return { runs: r.runs ?? [], nextPageToken: r.next_page_token ?? null };
  }

  async getRun(runId: string): Promise<MlflowRun | null> {
    if (!/^[0-9a-f]{32}$/.test(runId)) return null;
    try {
      const r = await this.request<{ run: MlflowRun }>('GET', '/api/2.0/mlflow/runs/get', {
        query: { run_id: runId },
      });
      return r.run;
    } catch (err) {
      if (err instanceof MlflowError && (err.isNotFound || err.status === 400)) return null;
      throw err;
    }
  }

  async metricHistory(runId: string, key: string): Promise<MlflowMetric[]> {
    const r = await this.request<{ metrics?: MlflowMetric[] }>(
      'GET',
      '/api/2.0/mlflow/metrics/get-history',
      { query: { run_id: runId, metric_key: key, max_results: '1000' } },
    );
    return (r.metrics ?? []).sort((a, b) => a.step - b.step);
  }

  async listArtifacts(runId: string, path: string): Promise<MlflowFileInfo[]> {
    const r = await this.request<{ files?: MlflowFileInfo[] }>(
      'GET',
      '/api/2.0/mlflow/artifacts/list',
      { query: { run_id: runId, path } },
    );
    return r.files ?? [];
  }

  /**
   * Downloads an artifact through MLflow's artifact proxy. `artifactUri` is a run artifact root
   * (`mlflow-artifacts:/<exp>/<run>/artifacts[/sub/dir]`).
   *
   * Streams with a hard byte limit: a file larger than `maxBytes` is never fully buffered, the
   * download is aborted as soon as the limit is crossed (MlflowError 413).
   */
  async downloadArtifactBytes(
    artifactUri: string,
    path: string,
    maxBytes: number,
  ): Promise<Buffer> {
    const prefix = 'mlflow-artifacts:/';
    if (!artifactUri.startsWith(prefix) || path.includes('..')) {
      throw new MlflowError(
        400,
        'UNSUPPORTED_ARTIFACT_URI',
        `unsupported artifact URI ${artifactUri}`,
      );
    }
    const proxied = `/api/2.0/mlflow-artifacts/artifacts/${artifactUri.slice(prefix.length)}/${path}`;
    const controller = new AbortController();
    const timer = setTimeout(
      () => {
        controller.abort();
      },
      Math.max(this.config.mlflowTimeoutMs, 60_000),
    );
    try {
      let res: Response;
      try {
        res = await fetch(`${this.config.mlflowUrl}${proxied}`, { signal: controller.signal });
      } catch {
        throw mlflowUnavailable('The experiment tracking service did not respond.');
      }
      if (res.status === 404)
        throw new MlflowError(404, 'RESOURCE_DOES_NOT_EXIST', `${path} not found`);
      if (!res.ok)
        throw mlflowUnavailable(`Artifact download failed (HTTP ${String(res.status)}).`);
      if (Number(res.headers.get('content-length') ?? '0') > maxBytes || !res.body) {
        controller.abort();
        throw new MlflowError(
          413,
          'ARTIFACT_TOO_LARGE',
          `${path} is larger than ${String(maxBytes)} bytes`,
        );
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          controller.abort();
          throw new MlflowError(
            413,
            'ARTIFACT_TOO_LARGE',
            `${path} is larger than ${String(maxBytes)} bytes`,
          );
        }
        chunks.push(value);
      }
      return Buffer.concat(chunks);
    } finally {
      clearTimeout(timer);
    }
  }

  async downloadArtifactText(artifactUri: string, path: string, maxBytes: number): Promise<string> {
    return (await this.downloadArtifactBytes(artifactUri, path, maxBytes)).toString('utf8');
  }

  // ---- model registry ------------------------------------------------------------------------

  async createRegisteredModel(
    name: string,
    tags: MlflowTag[],
    description?: string,
  ): Promise<void> {
    await this.request('POST', '/api/2.0/mlflow/registered-models/create', {
      body: { name, tags, ...(description && { description }) },
    });
  }

  async getRegisteredModel(name: string): Promise<{ name: string; tags?: MlflowTag[] } | null> {
    try {
      const r = await this.request<{ registered_model: { name: string; tags?: MlflowTag[] } }>(
        'GET',
        '/api/2.0/mlflow/registered-models/get',
        { query: { name } },
      );
      return r.registered_model;
    } catch (err) {
      if (err instanceof MlflowError && err.isNotFound) return null;
      throw err;
    }
  }

  async createModelVersion(
    name: string,
    source: string,
    runId: string | null,
    tags: MlflowTag[],
  ): Promise<string> {
    const r = await this.request<{ model_version: { version: string } }>(
      'POST',
      '/api/2.0/mlflow/model-versions/create',
      { body: { name, source, tags, ...(runId && { run_id: runId }) } },
    );
    return r.model_version.version;
  }

  async setModelVersionTag(
    name: string,
    version: string,
    key: string,
    value: string,
  ): Promise<void> {
    await this.request('POST', '/api/2.0/mlflow/model-versions/set-tag', {
      body: { name, version, key, value },
    });
  }
}

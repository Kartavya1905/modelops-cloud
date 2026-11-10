import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { AppError } from '../../common/errors/app-error';
import { ArtifactStore } from '../../common/storage/artifact-store';
import { APP_CONFIG, type AppConfig } from '../../config/config';

export const blobRef = (sha256: string) => ({ key: ArtifactStore.key(sha256), sha256 });

export interface FeatureScore {
  feature: string;
  kind: string;
  method: string;
  threshold: number;
  score: number;
  drifted: boolean;
}
export interface DriftResponse {
  datasetDrift: boolean;
  driftShare: number;
  driftedCount: number;
  features: FeatureScore[];
  referenceRows: number;
  currentRows: number;
  evidentlyVersion: string;
}
export interface ScoreMetrics {
  rows: number;
  accuracy: number;
  f1: number;
  rocAuc: number;
  logLoss: number;
}
export interface EvaluateResponse {
  candidate: ScoreMetrics;
  baseline: ScoreMetrics | null;
}

/** Calls to the ML worker's drift and evaluation endpoints (token-authenticated, internal). */
@Injectable()
export class MlWorkerClient {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  private async post<T>(path: string, body: unknown, timeoutMs: number): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.config.mlWorker.url}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-modelops-token': this.config.mlWorker.token,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new AppError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'ML_WORKER_UNAVAILABLE',
        'The ML worker is unavailable',
        (err as Error).message,
      );
    }
    if (res.status === 422) {
      const detail = ((await res.json().catch(() => ({}))) as { detail?: unknown }).detail;
      throw new AppError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'ML_WORKER_REJECTED',
        'The data could not be analysed',
        typeof detail === 'string' ? detail : 'invalid input',
      );
    }
    if (!res.ok) {
      throw new AppError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'ML_WORKER_UNAVAILABLE',
        'The ML worker failed',
        `HTTP ${String(res.status)}`,
      );
    }
    return (await res.json()) as T;
  }

  drift(body: { reference: object; features: string[]; current: number[][] }) {
    return this.post<DriftResponse>('/v1/drift', body, 120_000);
  }

  evaluate(body: {
    dataset: object;
    features: string[];
    label: string;
    inputName: string;
    candidate: object;
    baseline: object | null;
  }) {
    return this.post<EvaluateResponse>('/v1/evaluate', body, 120_000);
  }
}

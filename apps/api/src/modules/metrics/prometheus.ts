import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { AppError } from '../../common/errors/app-error';
import { APP_CONFIG, type AppConfig } from '../../config/config';

export interface PromSeries {
  metric: Record<string, string>;
  values: [number, string][];
}
interface PromResponse<T> {
  status: 'success' | 'error';
  data: { resultType: string; result: T };
  error?: string;
}

const unavailable = (detail: string) =>
  new AppError(
    HttpStatus.SERVICE_UNAVAILABLE,
    'METRICS_UNAVAILABLE',
    'Metrics are unavailable',
    detail,
  );

/**
 * Thin client for the Prometheus HTTP API. It is only ever called with queries built by
 * `series.ts` from constants plus validated UUIDs: no caller-supplied text reaches PromQL.
 */
@Injectable()
export class PrometheusClient {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  private async get<T>(path: string, params: Record<string, string>): Promise<T> {
    const url = `${this.config.prometheusUrl}${path}?${new URLSearchParams(params).toString()}`;
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    } catch (err) {
      throw unavailable(`Prometheus unreachable: ${(err as Error).message}`);
    }
    const body = (await res.json().catch(() => null)) as PromResponse<T> | null;
    if (!res.ok || body?.status !== 'success') {
      throw unavailable(`Prometheus answered HTTP ${String(res.status)}: ${body?.error ?? ''}`);
    }
    return body.data.result;
  }

  range(query: string, startS: number, endS: number, stepS: number): Promise<PromSeries[]> {
    return this.get<PromSeries[]>('/api/v1/query_range', {
      query,
      start: String(startS),
      end: String(endS),
      step: `${String(stepS)}s`,
    });
  }

  /** Instant query, summed to one number (0 when the series doesn't exist). */
  async scalar(query: string, atS: number): Promise<number> {
    const result = await this.get<{ value: [number, string] }[]>('/api/v1/query', {
      query,
      time: String(atS),
    });
    return result.reduce((sum, r) => sum + Number(r.value[1]), 0);
  }
}

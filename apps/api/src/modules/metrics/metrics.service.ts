import { Injectable } from '@nestjs/common';
import { Errors } from '../../common/errors/app-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { EndpointMetricsDto, MetricLineDto } from './metrics.dto';
import { PrometheusClient, type PromSeries } from './prometheus';
import {
  countQueries,
  RANGE_NAMES,
  RANGES,
  type RangeName,
  selector,
  SERIES_NAMES,
  type SeriesName,
  seriesQueries,
} from './series';

const ALLOWED_PARAMS = new Set(['range', 'series']);

/** Validates the query string against the allow-lists. Anything unexpected is a 400. */
export function parseMetricsQuery(q: Record<string, unknown>): {
  range: RangeName;
  series: SeriesName[];
} {
  const unknown = Object.keys(q).filter((k) => !ALLOWED_PARAMS.has(k));
  if (unknown.length) {
    throw Errors.validation(
      unknown.map((field) => ({ field, message: 'is not a supported parameter' })),
    );
  }
  const range = (q.range ?? '1h') as string;
  if (!(RANGE_NAMES as readonly string[]).includes(range)) {
    throw Errors.validation([
      { field: 'range', message: `must be one of ${RANGE_NAMES.join(', ')}` },
    ]);
  }
  const raw = q.series === undefined ? SERIES_NAMES.join(',') : q.series;
  if (typeof raw !== 'string') {
    throw Errors.validation([{ field: 'series', message: 'must be a comma-separated list' }]);
  }
  const names = raw.split(',').map((s) => s.trim());
  const bad = names.filter((n) => !(SERIES_NAMES as readonly string[]).includes(n));
  if (bad.length || names.length === 0) {
    throw Errors.validation([
      {
        field: 'series',
        message: `only these series exist: ${SERIES_NAMES.join(', ')} (no arbitrary queries)`,
      },
    ]);
  }
  return { range: range as RangeName, series: names as SeriesName[] };
}

const round = (v: number, digits: number) => Math.round(v * 10 ** digits) / 10 ** digits;

@Injectable()
export class MetricsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly prom: PrometheusClient,
  ) {}

  /** Exact count of requests in [now - rangeSeconds, now], optionally by status class. */
  async count(endpointIds: string[], rangeSeconds: number, nowS: number, codes?: string) {
    const q = countQueries(selector(endpointIds), rangeSeconds, codes);
    const [now, before] = await Promise.all([
      this.prom.scalar(q.now, nowS),
      this.prom.scalar(q.before, nowS),
    ]);
    return Math.max(0, Math.round(now - before));
  }

  async endpointMetrics(
    orgId: string,
    endpointId: string,
    query: Record<string, unknown>,
  ): Promise<EndpointMetricsDto> {
    const { range, series } = parseMetricsQuery(query);
    const endpoint = await this.prisma.endpoint.findFirst({
      where: { id: endpointId, orgId },
      select: { id: true },
    });
    if (!endpoint) throw Errors.notFound('Endpoint');

    const r = RANGES[range];
    const end = Math.floor(Date.now() / 1000);
    const start = end - r.seconds;
    const sel = selector([endpoint.id]);
    const grid = Array.from(
      { length: Math.floor(r.seconds / r.step) + 1 },
      (_, i) => start + i * r.step,
    );

    const toLines = (results: PromSeries[], legend: string | { label: string; prefix: string }) =>
      results.map((s): MetricLineDto => {
        const byT = new Map(s.values.map(([t, v]) => [Math.round(t), Number(v)]));
        return {
          name:
            typeof legend === 'string'
              ? legend
              : `${legend.prefix}${s.metric[legend.label] ?? '?'}`,
          // A fixed time grid with explicit gaps, so charts line up and gaps are honest.
          points: grid.map((t) => {
            const v = byT.get(t);
            return { t, v: v === undefined || !Number.isFinite(v) ? null : round(v, 4) };
          }),
        };
      });

    const lines: Record<SeriesName, MetricLineDto[]> = {
      rps: [],
      latency: [],
      errorRate: [],
      status: [],
    };
    await Promise.all(
      series.map(async (name) => {
        const parts = await Promise.all(
          seriesQueries(name, sel, r.window).map(async (sq) =>
            toLines(await this.prom.range(sq.query, start, end, r.step), sq.legend),
          ),
        );
        lines[name] = parts.flat().sort((a, b) => a.name.localeCompare(b.name));
      }),
    );

    const ids = [endpoint.id];
    const [requests, serverErrors, clientErrors, playground] = await Promise.all([
      this.count(ids, r.seconds, end),
      this.count(ids, r.seconds, end, '5..'),
      this.count(ids, r.seconds, end, '4..'),
      this.countPlayground(endpoint.id, r.seconds, end),
    ]);
    const p95 = lines.latency.find((l) => l.name === 'p95');
    const lastP95 = p95?.points.findLast((p) => p.v !== null)?.v ?? null;

    return {
      range,
      stepSeconds: r.step,
      start,
      end,
      summary: {
        requests,
        serverErrors,
        clientErrors,
        playground,
        p95Ms: lastP95 === null ? null : round(lastP95, 2),
        avgRps: round(requests / r.seconds, 3),
      },
      ...lines,
    };
  }

  private async countPlayground(endpointId: string, rangeSeconds: number, nowS: number) {
    const sel = `${selector([endpointId])},source="playground"`;
    const [now, before] = await Promise.all([
      this.prom.scalar(`sum(gateway_requests_total{${sel}})`, nowS),
      this.prom.scalar(`sum(gateway_requests_total{${sel}} offset ${String(rangeSeconds)}s)`, nowS),
    ]);
    return Math.max(0, Math.round(now - before));
  }
}

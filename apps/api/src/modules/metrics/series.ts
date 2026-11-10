/**
 * The ONLY metrics the API will ever ask Prometheus for (docs/04 §3, docs/06 SEC-15).
 * Callers choose by name and time range from fixed lists; every query below is a template filled
 * with an endpoint id that has already been validated as a UUID. There is no path for user text
 * to become PromQL, so "metrics?series=sum(up)" or any other expression is simply a 400.
 */
export const RANGES = {
  '15m': { seconds: 15 * 60, step: 15, window: '1m' },
  '1h': { seconds: 3600, step: 30, window: '2m' },
  '6h': { seconds: 6 * 3600, step: 120, window: '5m' },
  '24h': { seconds: 24 * 3600, step: 300, window: '10m' },
} as const;
export type RangeName = keyof typeof RANGES;
export const RANGE_NAMES = Object.keys(RANGES) as RangeName[];

export const SERIES_NAMES = ['rps', 'latency', 'errorRate', 'status'] as const;
export type SeriesName = (typeof SERIES_NAMES)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Label matcher for one or more endpoints. Throws on anything that isn't a UUID. */
export function selector(endpointIds: readonly string[]): string {
  if (endpointIds.length === 0 || !endpointIds.every((id) => UUID.test(id))) {
    throw new Error('selector() only accepts endpoint UUIDs');
  }
  return endpointIds.length === 1
    ? `endpoint_id="${endpointIds[0] ?? ''}"`
    : `endpoint_id=~"${endpointIds.join('|')}"`;
}

export interface SeriesQuery {
  /** legend name for each returned series: a fixed label, or a label key to read */
  legend: string | { label: string; prefix: string };
  query: string;
}

/** One chart = one or more queries. `w` is the rate window for the chosen range. */
export function seriesQueries(name: SeriesName, sel: string, w: string): SeriesQuery[] {
  const reqs = `gateway_requests_total{${sel}}`;
  const buckets = `gateway_request_duration_seconds_bucket{${sel}}`;
  switch (name) {
    case 'rps':
      // Traffic by model version: shows a switch-over (and, from M8, the canary split).
      return [
        {
          legend: { label: 'model_version', prefix: 'v' },
          query: `sum by (model_version) (rate(${reqs}[${w}]))`,
        },
      ];
    case 'latency':
      return (['0.5', '0.95', '0.99'] as const).map((q) => ({
        legend: `p${String(Number(q) * 100)}`,
        query: `histogram_quantile(${q}, sum by (le) (rate(${buckets}[${w}]))) * 1000`,
      }));
    case 'errorRate':
      // Server-side failures only (5xx). 4xx are the client's input problems, shown in `status`.
      // `or vector(0)`: no 5xx series exists until the first error, which must read as 0%, not
      // as "no data". The denominator still makes it empty when there is no traffic at all.
      return [
        {
          legend: 'errors',
          query: `(sum(rate(gateway_requests_total{${sel},code=~"5.."}[${w}])) or vector(0)) / sum(rate(${reqs}[${w}]))`,
        },
      ];
    case 'status':
      return [
        {
          legend: { label: 'code', prefix: 'HTTP ' },
          query: `sum by (code) (rate(${reqs}[${w}]))`,
        },
      ];
  }
}

/**
 * Exact request counts over a range: counter now minus counter `range` ago. (`increase()` is
 * extrapolated and would not match a load generator's count.) A counter that did not exist at the
 * start counts from 0. A gateway restart resets its counters, so counts can only be under, never over.
 */
export function countQueries(sel: string, rangeSeconds: number, codeMatcher?: string) {
  const m = codeMatcher ? `${sel},code=~"${codeMatcher}"` : sel;
  return {
    now: `sum(gateway_requests_total{${m}})`,
    before: `sum(gateway_requests_total{${m}} offset ${String(rangeSeconds)}s)`,
  };
}

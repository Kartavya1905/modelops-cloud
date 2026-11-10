'use client';

import type { EndpointMetrics, MetricLine } from '@modelops/api-contract';
import { useState } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ErrorState, TableSkeleton } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/primitives';
import { METRICS_RANGES, type MetricsRange, useEndpointMetrics } from './api';

const COLORS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
];
const axis = { stroke: 'var(--muted-foreground)', fontSize: 12 };
const tooltipStyle = {
  background: 'var(--popover)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  color: 'var(--popover-foreground)',
};

/** Lines (one per series) -> rows (one per timestamp), the shape Recharts wants. */
export function toRows(lines: readonly MetricLine[]): Record<string, number | null>[] {
  const first = lines[0];
  if (!first) return [];
  return first.points.map((p, i) => ({
    t: p.t,
    ...Object.fromEntries(lines.map((l) => [l.name, l.points[i]?.v ?? null])),
  }));
}

const clock = (t: number) =>
  new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** Human summary for screen readers and for the chart's accessible name. */
export function describe(m: EndpointMetrics): string {
  const s = m.summary;
  const errors = s.requests ? ((s.serverErrors / s.requests) * 100).toFixed(1) : '0.0';
  return `${s.requests.toLocaleString()} requests in the last ${m.range}, ${s.avgRps} per second on average, ${errors}% server errors, p95 latency ${s.p95Ms === null ? 'not available' : `${s.p95Ms.toFixed(1)} ms`}.`;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="grid gap-1 rounded-lg border p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-xl font-semibold tabular-nums" data-stat={label}>
        {value}
      </dd>
      {hint && <dd className="text-xs text-muted-foreground">{hint}</dd>}
    </div>
  );
}

function Chart({
  title,
  label,
  lines,
  kind,
  unit,
  domain,
}: {
  title: string;
  label: string;
  lines: readonly MetricLine[];
  kind: 'area' | 'line';
  unit: (v: number) => string;
  /** fixed y range, e.g. [0, 1] for a share; default starts at 0 */
  domain?: [number, number];
}) {
  const rows = toRows(lines);
  const hasData = lines.some((l) => l.points.some((p) => p.v !== null));
  const common = {
    data: rows,
    margin: { left: -10, right: 8 },
  };
  const children = [
    <CartesianGrid key="g" strokeDasharray="3 3" stroke="var(--border)" />,
    <XAxis key="x" dataKey="t" tickFormatter={clock} minTickGap={40} {...axis} />,
    <YAxis
      key="y"
      domain={domain ?? [0, 'auto']}
      tickFormatter={(v: number) => unit(v)}
      width={56}
      {...axis}
    />,
    <Tooltip
      key="tt"
      contentStyle={tooltipStyle}
      labelFormatter={(t) => clock(Number(t))}
      formatter={(v) => (typeof v === 'number' ? unit(v) : '—')}
    />,
    <Legend key="l" wrapperStyle={{ fontSize: 12 }} />,
  ];
  return (
    <div className="grid gap-2">
      <h3 className="text-sm font-medium">{title}</h3>
      {hasData ? (
        <div className="h-56" role="img" aria-label={label}>
          <ResponsiveContainer>
            {kind === 'area' ? (
              <AreaChart {...common}>
                {children}
                {lines.map((l, i) => (
                  <Area
                    key={l.name}
                    type="monotone"
                    dataKey={l.name}
                    stackId="1"
                    stroke={COLORS[i % COLORS.length]}
                    fill={COLORS[i % COLORS.length]}
                    fillOpacity={0.25}
                    isAnimationActive={false}
                    connectNulls={false}
                  />
                ))}
              </AreaChart>
            ) : (
              <LineChart {...common}>
                {children}
                {lines.map((l, i) => (
                  <Line
                    key={l.name}
                    type="monotone"
                    dataKey={l.name}
                    stroke={COLORS[i % COLORS.length]}
                    dot={false}
                    strokeWidth={2}
                    isAnimationActive={false}
                    connectNulls={false}
                  />
                ))}
              </LineChart>
            )}
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="grid h-24 place-items-center rounded-lg border border-dashed text-sm text-muted-foreground">
          No traffic in this range
        </p>
      )}
    </div>
  );
}

/** Operational dashboard for one endpoint (M6), from Prometheus via allow-listed queries. */
export function EndpointDashboard({ orgId, endpointId }: { orgId: string; endpointId: string }) {
  const [range, setRange] = useState<MetricsRange>('1h');
  const metrics = useEndpointMetrics(orgId, endpointId, range);
  const m = metrics.data;

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1.5">
          <CardTitle>Traffic</CardTitle>
          <CardDescription>
            Measured at the gateway, refreshed every 10 s. Counts are exact; rates are averaged over
            short windows.
          </CardDescription>
        </div>
        <div role="group" aria-label="Time range" className="flex gap-1">
          {METRICS_RANGES.map((r) => (
            <Button
              key={r}
              size="sm"
              variant={r === range ? 'default' : 'outline'}
              aria-pressed={r === range}
              onClick={() => setRange(r)}
            >
              {r}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="grid gap-6">
        {metrics.isPending ? (
          <TableSkeleton rows={3} />
        ) : metrics.isError || !m ? (
          <ErrorState error={metrics.error} onRetry={() => void metrics.refetch()} />
        ) : (
          <>
            <p className="sr-only" aria-live="polite">
              {describe(m)}
            </p>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              <Stat
                label="Requests"
                value={m.summary.requests.toLocaleString()}
                hint={
                  m.summary.playground
                    ? `${m.summary.playground.toLocaleString()} from the playground`
                    : undefined
                }
              />
              <Stat label="Average rate" value={`${m.summary.avgRps.toFixed(2)}/s`} />
              <Stat
                label="p95 latency"
                value={m.summary.p95Ms === null ? '—' : `${m.summary.p95Ms.toFixed(1)} ms`}
              />
              <Stat
                label="Server errors"
                value={m.summary.serverErrors.toLocaleString()}
                hint={
                  m.summary.requests
                    ? `${((m.summary.serverErrors / m.summary.requests) * 100).toFixed(2)}% of requests`
                    : undefined
                }
              />
              <Stat
                label="Client errors"
                value={m.summary.clientErrors.toLocaleString()}
                hint="Bad inputs, keys, rate limits"
              />
            </dl>
            <div className="grid gap-6 lg:grid-cols-2">
              <Chart
                title="Requests per second, by model version"
                label={`Stacked area chart of requests per second by model version. ${describe(m)}`}
                lines={m.rps}
                kind="area"
                unit={(v) => v.toFixed(2)}
              />
              <Chart
                title="Latency (p50 / p95 / p99)"
                label="Line chart of p50, p95 and p99 request latency in milliseconds"
                lines={m.latency}
                kind="line"
                unit={(v) => `${v.toFixed(1)} ms`}
              />
              <Chart
                title="Server error rate"
                label="Line chart of the share of requests answered with a 5xx error"
                lines={m.errorRate}
                kind="line"
                domain={[0, 1]}
                unit={(v) => `${(v * 100).toFixed(1)}%`}
              />
              <Chart
                title="Responses by status"
                label="Stacked area chart of responses per second by HTTP status"
                lines={m.status}
                kind="area"
                unit={(v) => v.toFixed(2)}
              />
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

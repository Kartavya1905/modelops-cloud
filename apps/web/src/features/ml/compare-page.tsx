'use client';

import type { RunComparison } from '@modelops/api-contract';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeftIcon, TrophyIcon } from 'lucide-react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ErrorState, PageHeader, TableSkeleton } from '@/components/common/states';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Table,
  TBody,
  Td,
  Th,
  THead,
  Tr,
} from '@/components/ui/primitives';
import { useOrgId } from '@/features/org/org-shell';
import { api, unwrap } from '@/lib/api/client';
import { qk } from '@/lib/query/keys';
import { cn } from '@/lib/utils';
import {
  formatMetric,
  FrameworkBadge,
  HEADLINE_METRICS,
  LOWER_IS_BETTER,
  metricLabel,
} from './labels';

const SERIES_COLORS = [
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

/** Index of the best run for a metric, or -1 if fewer than two runs report it. */
export function bestIndex(comparison: RunComparison, key: string): number {
  const values = comparison.runs.map((r) => r.metrics[key]);
  const present = values.filter((v): v is number => v !== undefined);
  if (present.length < 2) return -1;
  const target = LOWER_IS_BETTER.has(key) ? Math.min(...present) : Math.max(...present);
  return values.indexOf(target);
}

export function CompareView({ comparison }: { comparison: RunComparison }) {
  const runs = comparison.runs;
  const label = (i: number) => `${runs[i]?.name ?? ''} (${runs[i]?.runId.slice(0, 6) ?? ''})`;
  const headline = HEADLINE_METRICS.filter(
    (k) => k !== 'test_log_loss' && comparison.metricKeys.includes(k),
  );

  const barData = headline.map((key) => ({
    metric: metricLabel(key),
    ...Object.fromEntries(runs.map((r, i) => [label(i), r.metrics[key]])),
  }));

  const curveKeys = [...new Set(runs.flatMap((r) => Object.keys(r.series)))].sort();
  const maxSteps = Math.max(
    0,
    ...runs.flatMap((r) => Object.values(r.series).map((s) => s.length)),
  );

  return (
    <div className="grid gap-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Test metrics</CardTitle>
            <CardDescription>Higher is better.</CardDescription>
          </CardHeader>
          <CardContent>
            <div
              className="h-72"
              role="img"
              aria-label="Bar chart of test metrics per run (values in the table below)"
            >
              <ResponsiveContainer>
                <BarChart data={barData} margin={{ left: -10 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="metric" {...axis} />
                  <YAxis domain={[0, 1]} {...axis} />
                  <Tooltip
                    contentStyle={tooltipStyle}
                    formatter={(v) => (typeof v === 'number' ? v.toFixed(4) : String(v))}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  {runs.map((r, i) => (
                    <Bar
                      key={r.runId}
                      dataKey={label(i)}
                      fill={SERIES_COLORS[i]}
                      radius={[4, 4, 0, 0]}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Training curves</CardTitle>
            <CardDescription>
              {curveKeys.length > 0
                ? 'Loss per epoch (lower is better).'
                : 'None of these runs logged per-epoch metrics.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {curveKeys.length > 0 && (
              <div
                className="h-72"
                role="img"
                aria-label="Line chart of loss per epoch for each run"
              >
                <ResponsiveContainer>
                  <LineChart
                    data={Array.from({ length: maxSteps }, (_, step) => ({
                      step,
                      ...Object.fromEntries(
                        runs.flatMap((r, i) =>
                          curveKeys.map((k) => [
                            `${label(i)} · ${metricLabel(k)}`,
                            r.series[k]?.[step]?.value,
                          ]),
                        ),
                      ),
                    }))}
                    margin={{ left: -10 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis dataKey="step" {...axis} />
                    <YAxis {...axis} />
                    <Tooltip
                      contentStyle={tooltipStyle}
                      formatter={(v) => (typeof v === 'number' ? v.toFixed(4) : String(v))}
                    />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    {runs.flatMap((r, i) =>
                      curveKeys
                        .filter((k) => (r.series[k]?.length ?? 0) > 0)
                        .map((k) => (
                          <Line
                            key={`${r.runId}-${k}`}
                            type="monotone"
                            dataKey={`${label(i)} · ${metricLabel(k)}`}
                            stroke={SERIES_COLORS[i]}
                            strokeDasharray={k.startsWith('val') ? '5 4' : undefined}
                            dot={false}
                            strokeWidth={2}
                            connectNulls
                          />
                        )),
                    )}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>All metrics</CardTitle>
          <CardDescription>The best value in each row is marked.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <THead>
              <Tr>
                <Th>Metric</Th>
                {runs.map((r) => (
                  <Th key={r.runId}>
                    <div className="grid gap-1 py-1">
                      <span className="text-foreground">{r.name}</span>
                      <FrameworkBadge framework={r.framework} />
                    </div>
                  </Th>
                ))}
              </Tr>
            </THead>
            <TBody>
              {comparison.metricKeys.map((key) => {
                const best = bestIndex(comparison, key);
                return (
                  <Tr key={key}>
                    <Td className="font-medium">{metricLabel(key)}</Td>
                    {runs.map((r, i) => (
                      <Td
                        key={r.runId}
                        className={cn('tabular-nums', i === best && 'font-semibold text-success')}
                      >
                        {formatMetric(key, r.metrics[key])}
                        {i === best && (
                          <>
                            <TrophyIcon className="ml-1 inline size-3.5" aria-hidden />
                            <span className="sr-only"> (best)</span>
                          </>
                        )}
                      </Td>
                    ))}
                  </Tr>
                );
              })}
            </TBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Parameters that differ</CardTitle>
          <CardDescription>
            {comparison.differingParams.length === 0
              ? 'All parameters are identical.'
              : 'Only parameters whose value differs are shown.'}
          </CardDescription>
        </CardHeader>
        {comparison.differingParams.length > 0 && (
          <CardContent>
            <Table>
              <THead>
                <Tr>
                  <Th>Parameter</Th>
                  {runs.map((r) => (
                    <Th key={r.runId}>{r.name}</Th>
                  ))}
                </Tr>
              </THead>
              <TBody>
                {comparison.differingParams.map((p) => (
                  <Tr key={p}>
                    <Td className="font-mono text-xs">{p}</Td>
                    {runs.map((r) => (
                      <Td key={r.runId} className="font-mono text-xs">
                        {r.params[p] ?? '—'}
                      </Td>
                    ))}
                  </Tr>
                ))}
              </TBody>
            </Table>
          </CardContent>
        )}
      </Card>
    </div>
  );
}

export function ComparePage() {
  const orgId = useOrgId();
  const { projectId } = useParams<{ projectId: string }>();
  const ids = (useSearchParams().get('ids') ?? '').split(',').filter(Boolean);
  const query = useQuery({
    queryKey: qk.compare(orgId, projectId, ids),
    queryFn: () =>
      unwrap(
        api.GET('/api/v1/orgs/{orgId}/projects/{projectId}/runs/compare', {
          // Sent as repeated ?ids=…&ids=…; the API also accepts one comma-separated value.
          params: { path: { orgId, projectId }, query: { ids } },
        }),
      ),
  });

  return (
    <div className="grid gap-6">
      <Link
        href={`/orgs/${orgId}/projects/${projectId}`}
        className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeftIcon className="size-4" aria-hidden /> Back to project
      </Link>
      <PageHeader
        title="Compare runs"
        description={`${String(ids.length)} runs from this project’s MLflow experiment.`}
      />
      {query.isPending ? (
        <TableSkeleton rows={6} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <CompareView comparison={query.data} />
      )}
    </div>
  );
}

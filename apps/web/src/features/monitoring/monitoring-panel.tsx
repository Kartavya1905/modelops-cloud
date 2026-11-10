'use client';

import type { components, EndpointDetail } from '@modelops/api-contract';
import { ActivityIcon, CheckIcon, TriangleAlertIcon } from 'lucide-react';
import { useState } from 'react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { toast } from 'sonner';
import { ErrorState, PermissionGate, TableSkeleton } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import {
  Alert,
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/primitives';
import { ApiError, errorMessage } from '@/lib/api/client';
import { cn, formatDateTime } from '@/lib/utils';
import {
  PERFORMANCE_RANGES,
  type PerformanceRange,
  useDriftReports,
  usePerformance,
  useRunDrift,
  useSetCapture,
} from './api';

type DriftReport = components['schemas']['DriftReportDto'];
type Performance = components['schemas']['PerformanceDto'];

const axis = { stroke: 'var(--muted-foreground)', fontSize: 12 };
const tooltipStyle = {
  background: 'var(--popover)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  color: 'var(--popover-foreground)',
};

/** Features x reports, oldest -> newest (left to right), for the heatmap. */
export function heatmap(reports: readonly DriftReport[]) {
  const ordered = [...reports].reverse();
  const features = ordered[ordered.length - 1]?.features.map((f) => f.feature) ?? [];
  return {
    columns: ordered.map((r) => ({ id: r.id, at: r.createdAt, drift: r.datasetDrift })),
    rows: features.map((feature) => ({
      feature,
      cells: ordered.map((r) => r.features.find((f) => f.feature === feature) ?? null),
    })),
  };
}

function CaptureToggle({ orgId, endpoint }: { orgId: string; endpoint: EndpointDetail }) {
  const setCapture = useSetCapture(orgId, endpoint.id);
  return (
    <label className="flex w-fit items-center gap-2 text-sm">
      <input
        type="checkbox"
        className="size-4 accent-primary"
        checked={endpoint.captureInputs}
        disabled={setCapture.isPending}
        onChange={(e) =>
          setCapture.mutate(
            { captureInputs: e.target.checked, rowVersion: endpoint.rowVersion },
            {
              onSuccess: (r) =>
                toast.success(r.captureInputs ? 'Input capture on' : 'Input capture off'),
              onError: (err) => toast.error(errorMessage(err)),
            },
          )
        }
      />
      Capture inputs for drift detection
      <span className="text-muted-foreground">(kept 7 days; off by default)</span>
    </label>
  );
}

function DriftHeatmap({ reports }: { reports: readonly DriftReport[] }) {
  const h = heatmap(reports.slice(0, 10));
  return (
    <div
      className="overflow-x-auto"
      role="region"
      aria-label="Drift by feature and run"
      tabIndex={0}
    >
      <table className="w-full border-separate border-spacing-1 text-xs">
        <caption className="sr-only">
          Each column is one drift check (oldest left); each cell says whether that feature drifted.
        </caption>
        <thead>
          <tr>
            <th scope="col" className="text-left font-medium text-muted-foreground">
              Feature
            </th>
            {h.columns.map((c) => (
              <th key={c.id} scope="col" className="font-normal text-muted-foreground">
                {new Date(c.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {h.rows.map((row) => (
            <tr key={row.feature}>
              <th scope="row" className="pr-2 text-left font-mono font-normal">
                {row.feature}
              </th>
              {row.cells.map((cell, i) => (
                <td
                  key={h.columns[i]?.id ?? i}
                  data-drifted={cell?.drifted ? 'true' : 'false'}
                  title={
                    cell
                      ? `${cell.method}: ${cell.score.toFixed(4)} (threshold ${String(cell.threshold)})`
                      : ''
                  }
                  className={cn(
                    'rounded px-2 py-1 text-center',
                    cell?.drifted
                      ? 'bg-destructive/15 font-medium text-destructive'
                      : 'bg-success/10 text-success',
                  )}
                >
                  {cell ? (cell.drifted ? 'drift' : 'ok') : '—'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PerformanceChart({ perf }: { perf: Performance }) {
  const rows = perf.buckets.map((b) => ({
    t: new Date(b.start).getTime(),
    Accuracy: b.accuracy,
    F1: b.f1,
    'ROC-AUC': b.rocAuc,
  }));
  const label = (t: number) =>
    new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit' });
  return (
    <div
      className="h-56"
      role="img"
      aria-label="Line chart of accuracy, F1 and ROC-AUC over time, from feedback labels"
    >
      <ResponsiveContainer>
        <LineChart data={rows} margin={{ left: -10, right: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey="t" tickFormatter={label} minTickGap={40} {...axis} />
          <YAxis domain={[0, 1]} {...axis} />
          <Tooltip contentStyle={tooltipStyle} labelFormatter={(t) => label(Number(t))} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          {(['Accuracy', 'F1', 'ROC-AUC'] as const).map((k, i) => (
            <Line
              key={k}
              type="monotone"
              dataKey={k}
              stroke={`var(--chart-${String(i + 1)})`}
              // Buckets without labels are gaps (null), so an hour with labels between two empty
              // ones has no line segment: without a dot it would not be drawn at all.
              dot={{ r: 3, strokeWidth: 0, fill: `var(--chart-${String(i + 1)})` }}
              strokeWidth={2}
              isAnimationActive={false}
              connectNulls={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * Monitoring (M7): data drift and measured performance, deliberately SEPARATE. Inputs can drift
 * while the model still does fine, and the model can get worse (concept drift) while inputs look
 * normal; one combined "health" number would hide both stories.
 */
export function MonitoringPanel({ orgId, endpoint }: { orgId: string; endpoint: EndpointDetail }) {
  const drift = useDriftReports(orgId, endpoint.id);
  const runDrift = useRunDrift(orgId, endpoint.id);
  const [range, setRange] = useState<PerformanceRange>('24h');
  const perf = usePerformance(orgId, endpoint.id, range);
  const latest = drift.data?.[0];
  const runError = runDrift.error instanceof ApiError ? runDrift.error : null;

  return (
    <div className="grid gap-6 lg:grid-cols-2 *:min-w-0">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
          <div className="grid gap-1.5">
            <CardTitle>Data drift</CardTitle>
            <CardDescription>
              Captured inputs vs the training data of the serving version (Evidently).
            </CardDescription>
          </div>
          <PermissionGate orgId={orgId} permission="monitoring:run">
            <Button
              variant="outline"
              size="sm"
              disabled={runDrift.isPending}
              onClick={() =>
                runDrift.mutate(undefined, { onSuccess: () => toast.success('Drift check done') })
              }
            >
              <ActivityIcon aria-hidden /> {runDrift.isPending ? 'Checking…' : 'Run drift check'}
            </Button>
          </PermissionGate>
        </CardHeader>
        <CardContent className="grid gap-4">
          <PermissionGate orgId={orgId} permission="endpoint:update">
            <CaptureToggle orgId={orgId} endpoint={endpoint} />
          </PermissionGate>
          {runError && (
            <Alert variant="destructive">
              <span>{runError.problem.detail ?? runError.problem.title}</span>
            </Alert>
          )}
          {drift.isPending ? (
            <TableSkeleton rows={3} />
          ) : drift.isError ? (
            <ErrorState error={drift.error} />
          ) : !latest ? (
            <p className="text-sm text-muted-foreground">
              No drift checks yet. Turn on input capture, send traffic, then run a check (they also
              run hourly).
            </p>
          ) : (
            <>
              <div
                className="flex flex-wrap items-center gap-2 text-sm"
                role="status"
                data-testid="drift-latest"
              >
                {latest.datasetDrift ? (
                  <Badge variant="destructive">
                    <TriangleAlertIcon className="size-3" aria-hidden /> Dataset drift
                  </Badge>
                ) : (
                  <Badge variant="success">
                    <CheckIcon className="size-3" aria-hidden /> No dataset drift
                  </Badge>
                )}
                <span>
                  {latest.features.filter((f) => f.drifted).length} of {latest.features.length}{' '}
                  features drifted · {latest.sampleCount.toLocaleString()} requests ·{' '}
                  {formatDateTime(latest.createdAt)}
                </span>
              </div>
              <DriftHeatmap reports={drift.data} />
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
          <div className="grid gap-1.5">
            <CardTitle>Measured performance</CardTitle>
            <CardDescription>From ground-truth labels your application sends back.</CardDescription>
          </div>
          <div role="group" aria-label="Performance range" className="flex gap-1">
            {PERFORMANCE_RANGES.map((r) => (
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
        <CardContent className="grid gap-4">
          {perf.isPending ? (
            <TableSkeleton rows={3} />
          ) : perf.isError ? (
            <ErrorState error={perf.error} />
          ) : perf.data.summary.labelled === 0 ? (
            <p className="text-sm text-muted-foreground">
              No labelled predictions yet: send{' '}
              <code className="font-mono text-xs">POST /v1/endpoints/{endpoint.slug}/feedback</code>{' '}
              with the true outcomes.
            </p>
          ) : (
            <>
              <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {(
                  [
                    [
                      'Labelled',
                      `${perf.data.summary.labelled.toLocaleString()} / ${perf.data.predictions.toLocaleString()}`,
                    ],
                    ['Accuracy', perf.data.summary.accuracy?.toFixed(3) ?? '—'],
                    ['F1', perf.data.summary.f1?.toFixed(3) ?? '—'],
                    ['ROC-AUC', perf.data.summary.rocAuc?.toFixed(3) ?? '—'],
                  ] as const
                ).map(([label, value]) => (
                  <div key={label} className="grid gap-1 rounded-lg border p-3">
                    <dt className="text-xs text-muted-foreground">{label}</dt>
                    <dd className="text-lg font-semibold tabular-nums" data-perf={label}>
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
              <PerformanceChart perf={perf.data} />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

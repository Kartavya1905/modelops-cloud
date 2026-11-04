'use client';

import type { Run } from '@modelops/api-contract';
import { CheckIcon, CopyIcon, FlaskConicalIcon, GitCompareIcon, RefreshCwIcon } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorState, TableSkeleton } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import {
  Badge,
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
import { useCan } from '@/lib/auth/session';
import { formatRelative } from '@/lib/utils';
import { useExperiment, useModels, useRuns } from './api';
import { formatMetric, FrameworkBadge } from './labels';
import { RegisterDialog } from './register-dialog';

const MAX_COMPARE = 5;

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-md border bg-muted/50 p-2">
      <code className="min-w-0 flex-1 overflow-x-auto font-mono text-xs whitespace-nowrap">
        {command}
      </code>
      <Button
        variant="ghost"
        size="icon"
        className="size-7 shrink-0"
        aria-label="Copy command"
        onClick={() => void navigator.clipboard.writeText(command).then(() => setCopied(true))}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </div>
  );
}

/** Shown until the project has runs: the exact commands that train into this project. */
function TrainingInstructions({ orgId, projectId }: { orgId: string; projectId: string }) {
  const experiment = useExperiment(orgId, projectId);
  return (
    <div className="grid gap-3 rounded-xl border border-dashed p-6">
      <div className="flex items-center gap-2 font-medium">
        <FlaskConicalIcon className="size-5 text-primary" aria-hidden />
        No training runs yet
      </div>
      <p className="text-sm text-muted-foreground">
        Train the demo models into this project’s MLflow experiment
        {experiment.data && (
          <>
            {' '}
            <code className="font-mono text-xs">{experiment.data.name}</code>
          </>
        )}
        . Each run logs its metrics, dataset version and an ONNX bundle.
      </p>
      {experiment.data?.trainCommands.map((c) => (
        <CopyCommand key={c} command={c} />
      ))}
    </div>
  );
}

export function RunsSection({ orgId, projectId }: { orgId: string; projectId: string }) {
  const runs = useRuns(orgId, projectId);
  const models = useModels(orgId, projectId);
  const canRegister = useCan(orgId, 'model:register');
  const [selected, setSelected] = useState<string[]>([]);
  const [registering, setRegistering] = useState<Run | null>(null);

  const toggle = (id: string) => {
    setSelected((s) =>
      s.includes(id) ? s.filter((x) => x !== id) : s.length < MAX_COMPARE ? [...s, id] : s,
    );
  };
  const data = runs.data?.data ?? [];

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1.5">
          <CardTitle>Experiment runs</CardTitle>
          <CardDescription>
            From MLflow. Select 2–{MAX_COMPARE} runs to compare them side by side.
          </CardDescription>
        </div>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Refresh runs"
            onClick={() => void runs.refetch()}
          >
            <RefreshCwIcon className={runs.isFetching ? 'animate-spin' : ''} />
          </Button>
          {selected.length >= 2 ? (
            <Button asChild variant="outline">
              <Link href={`/orgs/${orgId}/projects/${projectId}/compare?ids=${selected.join(',')}`}>
                <GitCompareIcon aria-hidden />
                Compare ({selected.length})
              </Link>
            </Button>
          ) : (
            <Button variant="outline" disabled>
              <GitCompareIcon aria-hidden />
              Compare
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {runs.isPending ? (
          <TableSkeleton rows={3} />
        ) : runs.isError ? (
          <ErrorState error={runs.error} onRetry={() => void runs.refetch()} />
        ) : data.length === 0 ? (
          <TrainingInstructions orgId={orgId} projectId={projectId} />
        ) : (
          <Table>
            <THead>
              <Tr>
                <Th className="w-10">
                  <span className="sr-only">Select for comparison</span>
                </Th>
                <Th>Run</Th>
                <Th className="hidden md:table-cell">Framework</Th>
                <Th>ROC-AUC</Th>
                <Th className="hidden lg:table-cell">Accuracy</Th>
                <Th className="hidden lg:table-cell">Dataset</Th>
                <Th className="hidden sm:table-cell">Started</Th>
                <Th>Registry</Th>
              </Tr>
            </THead>
            <TBody>
              {data.map((r) => (
                <Tr key={r.runId}>
                  <Td>
                    <input
                      type="checkbox"
                      className="size-4 accent-primary"
                      aria-label={`Select ${r.name} for comparison`}
                      checked={selected.includes(r.runId)}
                      disabled={!selected.includes(r.runId) && selected.length >= MAX_COMPARE}
                      onChange={() => toggle(r.runId)}
                    />
                  </Td>
                  <Td>
                    <div className="font-medium">{r.name}</div>
                    <div className="font-mono text-xs text-muted-foreground">
                      {r.runId.slice(0, 8)}{' '}
                      {r.status !== 'FINISHED' && <Badge variant="outline">{r.status}</Badge>}
                    </div>
                  </Td>
                  <Td className="hidden md:table-cell">
                    <FrameworkBadge framework={r.framework} />
                  </Td>
                  <Td className="tabular-nums">
                    {formatMetric('test_roc_auc', r.metrics.test_roc_auc)}
                  </Td>
                  <Td className="hidden tabular-nums lg:table-cell">
                    {formatMetric('test_accuracy', r.metrics.test_accuracy)}
                  </Td>
                  <Td className="hidden lg:table-cell">
                    {r.dataset ? (
                      <span className="font-mono text-xs" title={`sha256 ${r.dataset.sha256}`}>
                        {r.dataset.version}
                      </span>
                    ) : (
                      '—'
                    )}
                  </Td>
                  <Td className="hidden text-muted-foreground sm:table-cell">
                    {r.startTime ? formatRelative(r.startTime) : '—'}
                  </Td>
                  <Td>
                    <div className="flex flex-wrap items-center gap-1">
                      {r.registeredAs.map((reg) => (
                        <Link
                          key={reg.versionId}
                          href={`/orgs/${orgId}/model-versions/${reg.versionId}`}
                        >
                          <Badge variant="default">
                            {reg.modelName} v{reg.version}
                          </Badge>
                        </Link>
                      ))}
                      {canRegister && r.status === 'FINISHED' && (
                        <Button variant="ghost" size="sm" onClick={() => setRegistering(r)}>
                          Register
                        </Button>
                      )}
                    </div>
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
      </CardContent>
      {registering && (
        <RegisterDialog
          key={registering.runId}
          orgId={orgId}
          projectId={projectId}
          open
          onOpenChange={(o) => !o && setRegistering(null)}
          runs={data}
          models={models.data ?? []}
          fixedRunId={registering.runId}
        />
      )}
    </Card>
  );
}

'use client';

import type { components, ModelDetail } from '@modelops/api-contract';
import { CheckIcon, CrownIcon, XIcon } from 'lucide-react';
import { useState } from 'react';
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
  Field,
} from '@/components/ui/primitives';
import { NativeSelect } from '@/components/ui/select';
import { ApiError, errorMessage } from '@/lib/api/client';
import { formatRelative } from '@/lib/utils';
import { useDatasets, useEvaluations, useRunEvaluation, useSetChampion } from './api';

type Evaluation = components['schemas']['EvaluationDto'];

export function ChampionBadge() {
  return (
    <Badge variant="default">
      <CrownIcon className="size-3" aria-hidden /> Champion
    </Badge>
  );
}

function EvaluationRow({ orgId, modelId, ev }: { orgId: string; modelId: string; ev: Evaluation }) {
  const crown = useSetChampion(orgId, modelId);
  const fmt = (v: number | undefined) => (v === undefined ? '—' : v.toFixed(4));
  return (
    <li className="grid gap-2 rounded-lg border p-3 text-sm" data-evaluation={ev.id}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">
          v{ev.candidate.version}
          {ev.baseline ? ` vs champion v${String(ev.baseline.version)}` : ' (no champion yet)'}
        </span>
        {ev.status === 'FAILED' ? (
          <Badge variant="destructive">Could not run</Badge>
        ) : ev.passed ? (
          <Badge variant="success">
            <CheckIcon className="size-3" aria-hidden /> Gate passed
          </Badge>
        ) : (
          <Badge variant="destructive">
            <XIcon className="size-3" aria-hidden /> Gate failed
          </Badge>
        )}
        <span className="text-xs text-muted-foreground">
          on {ev.datasetLabel} · {formatRelative(ev.createdAt)}
        </span>
        {ev.canPromote && (
          <PermissionGate orgId={orgId} permission="model:promote">
            <Button
              size="sm"
              className="ml-auto"
              disabled={crown.isPending}
              onClick={() =>
                crown.mutate(ev.id, {
                  onSuccess: () =>
                    toast.success(`v${String(ev.candidate.version)} is now the champion`),
                  onError: (err) => toast.error(errorMessage(err)),
                })
              }
            >
              <CrownIcon aria-hidden /> Make champion
            </Button>
          </PermissionGate>
        )}
      </div>
      {ev.failureDetail && <span className="text-destructive">{ev.failureDetail}</span>}
      {ev.metrics.candidate && (
        <span className="font-mono text-xs text-muted-foreground">
          ROC-AUC {fmt(ev.metrics.candidate.rocAuc)}
          {ev.metrics.baseline ? ` (champion ${fmt(ev.metrics.baseline.rocAuc)})` : ''} · log loss{' '}
          {fmt(ev.metrics.candidate.logLoss)} · accuracy {fmt(ev.metrics.candidate.accuracy)} ·{' '}
          {ev.metrics.candidate.rows.toLocaleString()} rows
        </span>
      )}
      <ul className="grid gap-1" aria-label="Gate checks">
        {ev.checks.map((c) => (
          <li key={c.rule} className="flex items-start gap-2 text-xs">
            {c.passed ? (
              <CheckIcon className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden />
            ) : (
              <XIcon className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden />
            )}
            <span>
              <span className="sr-only">{c.passed ? 'passed: ' : 'failed: '}</span>
              {c.detail}
            </span>
          </li>
        ))}
      </ul>
    </li>
  );
}

/**
 * Evaluation gate (M7, FR-32): candidate vs the current champion on a held-out dataset version.
 * Only a passed evaluation against the *current* champion can crown a new one (the database
 * enforces the same rule).
 */
export function EvaluationsCard({ orgId, model }: { orgId: string; model: ModelDetail }) {
  const evaluations = useEvaluations(orgId, model.id);
  const datasets = useDatasets(orgId, model.project.id);
  const run = useRunEvaluation(orgId, model.id);
  const validated = model.versions.filter((v) => v.status === 'VALIDATED');
  const usable = (datasets.data ?? []).filter((d) => d.stored && d.columns.length > 0);
  const [candidate, setCandidate] = useState('');
  const [dataset, setDataset] = useState('');
  const candidateId = candidate || validated[0]?.id || '';
  const datasetId = dataset || usable[0]?.id || '';
  const error = run.error instanceof ApiError ? run.error : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Evaluations</CardTitle>
        <CardDescription>
          Score a candidate against the champion on held-out data. Passing the project’s gate is the
          only way to become champion.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <PermissionGate orgId={orgId} permission="evaluation:run">
          <div className="grid items-end gap-3 sm:grid-cols-[1fr_1fr_auto]">
            <Field id="eval-candidate" label="Candidate version">
              <NativeSelect
                id="eval-candidate"
                value={candidateId}
                onChange={(e) => setCandidate(e.target.value)}
                disabled={validated.length === 0}
              >
                {validated.map((v) => (
                  <option key={v.id} value={v.id}>
                    v{v.version}
                    {v.id === model.championVersionId ? ' (champion)' : ''}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field id="eval-dataset" label="Held-out dataset">
              <NativeSelect
                id="eval-dataset"
                value={datasetId}
                onChange={(e) => setDataset(e.target.value)}
                disabled={usable.length === 0}
              >
                {usable.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} {d.version}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Button
              disabled={!candidateId || !datasetId || run.isPending}
              onClick={() =>
                run.mutate(
                  { candidateVersionId: candidateId, datasetVersionId: datasetId },
                  { onSuccess: (r) => toast.success(r.passed ? 'Gate passed' : 'Gate failed') },
                )
              }
            >
              {run.isPending ? 'Evaluating…' : 'Evaluate'}
            </Button>
          </div>
          {usable.length === 0 && (
            <p className="text-xs text-muted-foreground">
              Upload a labelled dataset in the project first (it must not be the training data).
            </p>
          )}
          {error && (
            <Alert variant="destructive">
              <span>{error.problem.detail ?? error.problem.title}</span>
            </Alert>
          )}
        </PermissionGate>
        {evaluations.isPending ? (
          <TableSkeleton rows={2} />
        ) : evaluations.isError ? (
          <ErrorState error={evaluations.error} />
        ) : evaluations.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">No evaluations yet.</p>
        ) : (
          <ul className="grid gap-3" aria-label="Evaluation reports">
            {evaluations.data.map((ev) => (
              <EvaluationRow key={ev.id} orgId={orgId} modelId={model.id} ev={ev} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

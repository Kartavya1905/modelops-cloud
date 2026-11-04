'use client';

import type { ModelVersion, ValidationCheck } from '@modelops/api-contract';
import {
  CheckCircle2Icon,
  CircleDashedIcon,
  LoaderIcon,
  MinusCircleIcon,
  RotateCwIcon,
  XCircleIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { PermissionGate } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import {
  Alert,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/primitives';
import { formatDateTime } from '@/lib/utils';
import { isInProgress, useRerunValidation } from './api';

/** Checks in the order the validator documents them (docs/06), even if V11 ran first. */
const byNumber = (a: ValidationCheck, b: ValidationCheck) =>
  Number(a.id.slice(1)) - Number(b.id.slice(1));

function CheckIcon({ passed }: { passed: boolean | null }) {
  if (passed === true)
    return <CheckCircle2Icon className="size-4 shrink-0 text-success" aria-hidden />;
  if (passed === false)
    return <XCircleIcon className="size-4 shrink-0 text-destructive" aria-hidden />;
  return <MinusCircleIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />;
}
const CHECK_STATE = { true: 'passed', false: 'failed', null: 'skipped' } as const;

const FACTS: { key: string; label: string; format: (v: number) => string }[] = [
  { key: 'loadMs', label: 'Load time', format: (v) => `${v.toFixed(0)} ms` },
  { key: 'latencyP50Ms', label: 'Latency p50', format: (v) => `${v.toFixed(2)} ms` },
  { key: 'latencyP95Ms', label: 'Latency p95', format: (v) => `${v.toFixed(2)} ms` },
  { key: 'goldenRows', label: 'Golden rows', format: (v) => String(v) },
  {
    key: 'goldenMaxAbsDiff',
    label: 'Golden max |Δ|',
    format: (v) => (v === 0 ? '0' : v.toExponential(1)),
  },
];

/**
 * The validation checklist for one version (V1-V11). Polls while validation is in progress
 * (the parent query does), and offers a re-run only when the last attempt could not run.
 */
export function ValidationCard({ orgId, version: v }: { orgId: string; version: ModelVersion }) {
  const rerun = useRerunValidation(orgId);
  const report = v.latestValidation;
  const running = isInProgress(v.status);
  const retryable = v.status === 'REJECTED' && report?.result === 'ERROR';
  const checks = [...(report?.checks ?? [])].sort(byNumber);
  const failed = checks.filter((c) => c.passed === false);
  const facts = FACTS.filter((f) => typeof report?.facts[f.key] === 'number');

  return (
    <Card aria-busy={running}>
      <CardHeader>
        <CardTitle>Validation</CardTitle>
        <CardDescription>
          Every version is checked in a sandbox before it can be deployed: format, size, ONNX
          checker, embedded weights, opsets, operator allow-list, signature, load budget, golden
          examples, latency and checksum.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div role="status" aria-live="polite" className="text-sm">
          {v.status === 'PENDING_VALIDATION' && (
            <span className="flex items-center gap-2">
              <CircleDashedIcon className="size-4" aria-hidden />
              Queued for validation
              {v.validationAttempts > 0 && ` (attempt ${String(v.validationAttempts + 1)})`}…
            </span>
          )}
          {v.status === 'VALIDATING' && (
            <span className="flex items-center gap-2">
              <LoaderIcon className="size-4 motion-safe:animate-spin" aria-hidden />
              Validating (attempt {v.validationAttempts})…
            </span>
          )}
          {v.status === 'VALIDATED' && (
            <span className="flex items-center gap-2 font-medium">
              <CheckCircle2Icon className="size-4 text-success" aria-hidden />
              Passed all checks
              {v.validatedAt && (
                <span className="font-normal text-muted-foreground">
                  {' '}
                  · {formatDateTime(v.validatedAt)}
                </span>
              )}
            </span>
          )}
          {v.status === 'REJECTED' && report?.result === 'FAILED' && (
            <span className="flex items-center gap-2 font-medium">
              <XCircleIcon className="size-4 text-destructive" aria-hidden />
              Rejected: {failed.map((c) => c.id).join(', ')} failed. Fix the bundle and register it
              as a new version.
            </span>
          )}
        </div>

        {retryable && (
          <Alert variant="destructive">
            <span className="font-medium">Validation could not run</span>
            <span>
              {typeof report.facts.error === 'string'
                ? report.facts.error
                : 'An infrastructure error stopped the validator.'}{' '}
              This says nothing about the model; it is safe to run again.
            </span>
            <PermissionGate orgId={orgId} permission="model:register">
              <div>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-2"
                  disabled={rerun.isPending}
                  onClick={() =>
                    rerun.mutate(
                      { versionId: v.id, modelId: v.model.id },
                      { onSuccess: () => toast.success('Validation queued again') },
                    )
                  }
                >
                  <RotateCwIcon aria-hidden />
                  {rerun.isPending ? 'Queuing…' : 'Re-run validation'}
                </Button>
              </div>
            </PermissionGate>
          </Alert>
        )}

        {checks.length > 0 && (
          <ul className="grid gap-2" aria-label="Validation checks">
            {checks.map((c) => (
              <li
                key={c.id}
                className="flex items-start gap-3 rounded-md border px-3 py-2 text-sm"
                data-check={c.id}
                data-state={CHECK_STATE[String(c.passed) as keyof typeof CHECK_STATE]}
              >
                <span className="mt-0.5">
                  <CheckIcon passed={c.passed} />
                </span>
                <span className="grid min-w-0 gap-0.5">
                  <span className="font-medium">
                    <span className="font-mono text-xs text-muted-foreground">{c.id}</span> {c.name}
                    <span className="sr-only">
                      : {CHECK_STATE[String(c.passed) as keyof typeof CHECK_STATE]}
                    </span>
                  </span>
                  <span className="text-xs break-words text-muted-foreground">{c.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        )}

        {facts.length > 0 && (
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-5">
            {facts.map((f) => (
              <div key={f.key} className="grid gap-1">
                <dt className="text-xs text-muted-foreground">{f.label}</dt>
                <dd className="font-semibold tabular-nums">
                  {f.format(report?.facts[f.key] as number)}
                </dd>
              </div>
            ))}
          </dl>
        )}
        {report && (
          <p className="text-xs text-muted-foreground">
            Attempt {report.attempt} · validator v{report.validatorVersion} ·{' '}
            {formatDateTime(report.createdAt)}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

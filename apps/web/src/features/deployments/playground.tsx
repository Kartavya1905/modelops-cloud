'use client';

import type { PlaygroundResult } from '@modelops/api-contract';
import { FlaskConicalIcon, SendIcon } from 'lucide-react';
import { type SubmitEvent, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Alert,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
} from '@/components/ui/primitives';
import { NativeSelect } from '@/components/ui/select';
import { ApiError } from '@/lib/api/client';
import { usePlaygroundInfo, usePlaygroundPredict } from './api';

/**
 * Turns the form's text values into one input row, in signature order. Every feature is required
 * and must be a finite number; the gateway checks the same rules again (it is the real gate).
 */
export function parseRow(
  features: readonly string[],
  values: Readonly<Record<string, string>>,
): { row: Record<string, number> } | { errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const row: Record<string, number> = {};
  for (const f of features) {
    const raw = (values[f] ?? '').trim();
    const n = raw === '' ? NaN : Number(raw);
    if (raw === '') errors[f] = 'Required';
    else if (!Number.isFinite(n)) errors[f] = 'Enter a number';
    else row[f] = n;
  }
  return Object.keys(errors).length ? { errors } : { row };
}

/** "inputs[0].tenure_months" (gateway field path) -> "tenure_months" */
const fieldOf = (path: string) => /^inputs\[0\]\.(.+)$/.exec(path)?.[1];

/**
 * Golden inputs are float32 values printed as float64 (82.55000305175781). Seven significant
 * digits show them as people wrote them and still round-trip to the same float32 (~7.2 digits).
 */
export const display = (v: number) => String(Number(v.toPrecision(7)));

const toText = (row: Record<string, number> | undefined, features: readonly string[]) =>
  Object.fromEntries(features.map((f) => [f, row?.[f] === undefined ? '' : display(row[f])]));

function Result({ result, classes }: { result: PlaygroundResult; classes: (string | number)[] }) {
  const out = result.outputs[0];
  if (!out) return null;
  return (
    <div className="grid gap-3 rounded-lg border p-4" role="status" aria-live="polite">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-sm text-muted-foreground">Prediction</span>
        <span className="text-2xl font-semibold" data-testid="playground-label">
          {String(out.label)}
        </span>
        <span className="text-xs text-muted-foreground">
          {result.model.name} v{result.model.version} · {result.latencyMs.toFixed(1)} ms · revision{' '}
          {result.revisionId.slice(0, 8)}
        </span>
      </div>
      <ul className="grid gap-2" aria-label="Class probabilities">
        {classes.map((c) => {
          const p = out.probabilities[String(c)] ?? 0;
          return (
            <li
              key={String(c)}
              className="grid grid-cols-[4rem_1fr_4rem] items-center gap-2 text-sm"
            >
              <span className="font-mono">class {String(c)}</span>
              <span className="h-2 overflow-hidden rounded-full bg-muted" aria-hidden>
                <span
                  className="block h-full rounded-full bg-primary"
                  style={{ width: `${(p * 100).toFixed(1)}%` }}
                />
              </span>
              <span className="text-right tabular-nums">{(p * 100).toFixed(1)}%</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Prediction playground (M6): a form generated from the serving model's signature, prefilled with
 * its golden examples. Calls go through the real gateway pipeline (validation, metrics).
 */
export function Playground({
  orgId,
  endpointId,
  revisionId,
}: {
  orgId: string;
  endpointId: string;
  revisionId: string | null;
}) {
  const info = usePlaygroundInfo(orgId, endpointId, revisionId);
  const predict = usePlaygroundPredict(orgId, endpointId);
  const features = info.data?.features ?? [];
  const examples = info.data?.examples ?? [];
  const [values, setValues] = useState<Record<string, string> | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const current = values ?? toText(info.data?.examples[0], features);

  function submit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    const parsed = parseRow(features, current);
    if ('errors' in parsed) {
      setErrors(parsed.errors);
      return;
    }
    setErrors({});
    predict.mutate([parsed.row], {
      onError: (err) => {
        if (!(err instanceof ApiError)) return;
        const fieldErrors: Record<string, string> = {};
        for (const fe of err.problem.errors ?? []) {
          const f = fieldOf(fe.field);
          if (f) fieldErrors[f] = fe.message;
        }
        setErrors(fieldErrors);
      },
    });
  }

  const apiError = predict.error instanceof ApiError ? predict.error : null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Playground</CardTitle>
        <CardDescription>
          Try the serving model with one input. The form follows its signature; calls go through the
          gateway like any client’s and appear on the dashboard as playground traffic.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!info.data ? null : !info.data.ready ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <FlaskConicalIcon className="size-4" aria-hidden /> Deploy a version to try it here.
          </p>
        ) : (
          <form className="grid gap-4" onSubmit={submit} noValidate aria-label="Playground">
            {info.data.examples.length > 0 && (
              <Field id="playground-example" label="Start from a golden example">
                <NativeSelect
                  id="playground-example"
                  defaultValue="0"
                  onChange={(e) => {
                    setErrors({});
                    setValues(toText(examples[Number(e.target.value)], features));
                  }}
                >
                  {info.data.examples.map((_, i) => (
                    <option key={i} value={String(i)}>
                      Example {i + 1}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            )}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {features.map((f) => (
                <Field key={f} id={`pg-${f}`} label={f} error={errors[f]}>
                  <Input
                    id={`pg-${f}`}
                    inputMode="decimal"
                    className="font-mono"
                    value={current[f] ?? ''}
                    aria-invalid={!!errors[f]}
                    aria-describedby={errors[f] ? `pg-${f}-error` : undefined}
                    onChange={(e) => setValues({ ...current, [f]: e.target.value })}
                  />
                </Field>
              ))}
            </div>
            {apiError && !apiError.problem.errors?.length && (
              <Alert variant="destructive">
                <span>{apiError.problem.detail ?? apiError.problem.title}</span>
              </Alert>
            )}
            <div>
              <Button type="submit" disabled={predict.isPending}>
                <SendIcon aria-hidden />
                {predict.isPending ? 'Predicting…' : 'Predict'}
              </Button>
            </div>
            {predict.data && <Result result={predict.data} classes={info.data.classes} />}
          </form>
        )}
      </CardContent>
    </Card>
  );
}

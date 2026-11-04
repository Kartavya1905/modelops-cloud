'use client';

import type { Model, Run } from '@modelops/api-contract';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Alert, Field } from '@/components/ui/primitives';
import { NativeSelect } from '@/components/ui/select';
import { ApiError } from '@/lib/api/client';
import { useImportVersion } from './api';

/**
 * Registers one MLflow run as the next version of a model. Opened either from a run (pick the
 * model) or from a model (pick the run): whichever side is fixed is passed in.
 */
export function RegisterDialog({
  orgId,
  projectId,
  open,
  onOpenChange,
  runs,
  models,
  fixedRunId,
  fixedModelId,
}: {
  orgId: string;
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  runs: Run[];
  models: Model[];
  fixedRunId?: string;
  fixedModelId?: string;
}) {
  const router = useRouter();
  const importVersion = useImportVersion(orgId);
  const finished = runs.filter((r) => r.status === 'FINISHED');
  const [modelId, setModelId] = useState(fixedModelId ?? models[0]?.id ?? '');
  const [runId, setRunId] = useState(fixedRunId ?? finished[0]?.runId ?? '');

  const run = runs.find((r) => r.runId === runId);
  const alreadyIn = new Set(run?.registeredAs.map((r) => r.modelId));

  function submit() {
    importVersion.mutate(
      { modelId, runId, projectId },
      {
        onSuccess: (v) => {
          toast.success(`Registered as ${v.model.name} v${String(v.version)}`);
          onOpenChange(false);
          router.push(`/orgs/${orgId}/model-versions/${v.id}`);
        },
      },
    );
  }

  const error = importVersion.error instanceof ApiError ? importVersion.error : null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Register a model version</DialogTitle>
          <DialogDescription>
            The run’s ONNX bundle becomes the next numbered version. It starts as “Awaiting
            validation” and cannot be deployed until it passes validation.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive">
            <span>{error.problem.detail ?? error.problem.title}</span>
            {error.problem.errors?.map((e) => (
              <span key={e.field} className="font-mono text-xs">
                {e.field}: {e.message}
              </span>
            ))}
          </Alert>
        )}
        {models.length === 0 ? (
          <p className="text-sm text-muted-foreground">Create a model in this project first.</p>
        ) : (
          <div className="grid gap-4">
            {!fixedModelId && (
              <Field id="register-model" label="Model">
                <NativeSelect
                  id="register-model"
                  value={modelId}
                  onChange={(e) => setModelId(e.target.value)}
                >
                  {models.map((m) => (
                    <option key={m.id} value={m.id} disabled={alreadyIn.has(m.id)}>
                      {m.name}
                      {alreadyIn.has(m.id)
                        ? ' (already registered)'
                        : ` (next: v${String(m.versionCount + 1)})`}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            )}
            {!fixedRunId && (
              <Field id="register-run" label="Run">
                <NativeSelect
                  id="register-run"
                  value={runId}
                  onChange={(e) => setRunId(e.target.value)}
                >
                  {finished.map((r) => (
                    <option key={r.runId} value={r.runId}>
                      {r.name} · {r.runId.slice(0, 8)}
                      {r.metrics.test_roc_auc !== undefined
                        ? ` · AUC ${r.metrics.test_roc_auc.toFixed(3)}`
                        : ''}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            )}
          </div>
        )}
        <DialogFooter>
          <Button
            disabled={!modelId || !runId || alreadyIn.has(modelId) || importVersion.isPending}
            onClick={submit}
          >
            {importVersion.isPending ? 'Registering…' : 'Register version'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

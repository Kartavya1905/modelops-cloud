'use client';

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
import { Alert, Field, Input } from '@/components/ui/primitives';
import { NativeSelect } from '@/components/ui/select';
import { ApiError } from '@/lib/api/client';
import { useDatasets } from '@/features/monitoring/api';
import { type BundleFiles, useUploadVersion } from './api';

const MB = 1024 * 1024;
const PARTS = [
  { key: 'model', label: 'model.onnx', accept: '.onnx', max: 100 * MB },
  { key: 'signature', label: 'signature.json', accept: '.json,application/json', max: MB },
  { key: 'golden', label: 'golden_examples.json', accept: '.json,application/json', max: MB },
] as const;
type PartKey = (typeof PARTS)[number]['key'];

/**
 * Uploads an ONNX bundle (no MLflow run) as the next version. Sizes are checked here for a quick
 * answer, and again by the API, which also hashes and validates everything itself.
 */
export function UploadDialog({
  orgId,
  projectId,
  modelId,
  modelName,
  nextVersion,
  open,
  onOpenChange,
}: {
  orgId: string;
  projectId: string;
  modelId: string;
  modelName: string;
  nextVersion: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const upload = useUploadVersion(orgId);
  const [framework, setFramework] = useState<BundleFiles['framework']>('SKLEARN_ONNX');
  const [files, setFiles] = useState<Partial<Record<PartKey, File>>>({});
  const datasets = useDatasets(orgId, projectId);
  const [trainedOn, setTrainedOn] = useState('');

  const tooBig = PARTS.filter((p) => (files[p.key]?.size ?? 0) > p.max);
  const complete = PARTS.every((p) => files[p.key]);

  function submit() {
    const { model, signature, golden } = files;
    if (!model || !signature || !golden) return;
    upload.mutate(
      {
        modelId,
        projectId,
        files: {
          framework,
          model,
          signature,
          golden,
          ...(trainedOn ? { trainingDatasetVersionId: trainedOn } : {}),
        },
      },
      {
        onSuccess: (v) => {
          toast.success(`Uploaded as ${v.model.name} v${String(v.version)}; validating`);
          onOpenChange(false);
          router.push(`/orgs/${orgId}/model-versions/${v.id}`);
        },
      },
    );
  }

  const error = upload.error instanceof ApiError ? upload.error : null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Upload a bundle</DialogTitle>
          <DialogDescription>
            Becomes {modelName} v{nextVersion}. The three files are hashed and stored as they
            arrive, then validated in a sandbox before the version can be deployed.
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
        <div className="grid gap-4">
          <Field id="upload-framework" label="Framework">
            <NativeSelect
              id="upload-framework"
              value={framework}
              onChange={(e) => setFramework(e.target.value as BundleFiles['framework'])}
            >
              <option value="SKLEARN_ONNX">scikit-learn → ONNX</option>
              <option value="PYTORCH_ONNX">PyTorch → ONNX</option>
            </NativeSelect>
          </Field>
          <Field
            id="upload-dataset"
            label="Trained on (optional)"
            hint="Its training dataset, if uploaded: needed to monitor this version for drift."
          >
            <NativeSelect
              id="upload-dataset"
              value={trainedOn}
              onChange={(e) => setTrainedOn(e.target.value)}
            >
              <option value="">Not recorded</option>
              {(datasets.data ?? [])
                .filter((d) => d.stored)
                .map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} {d.version}
                  </option>
                ))}
            </NativeSelect>
          </Field>
          {PARTS.map((p) => (
            <Field
              key={p.key}
              id={`upload-${p.key}`}
              label={p.label}
              error={tooBig.includes(p) ? `Larger than ${String(p.max / MB)} MB` : undefined}
            >
              <Input
                id={`upload-${p.key}`}
                type="file"
                accept={p.accept}
                className="h-auto py-1.5"
                aria-invalid={tooBig.includes(p) || undefined}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  setFiles((f) => ({ ...f, [p.key]: file }));
                }}
              />
            </Field>
          ))}
        </div>
        <DialogFooter>
          <Button disabled={!complete || tooBig.length > 0 || upload.isPending} onClick={submit}>
            {upload.isPending ? 'Uploading…' : 'Upload and validate'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

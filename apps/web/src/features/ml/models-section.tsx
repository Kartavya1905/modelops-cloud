'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BoxIcon, PlusIcon } from 'lucide-react';
import Link from 'next/link';
import { type SubmitEvent, useState } from 'react';
import { toast } from 'sonner';
import { ErrorState, PermissionGate, TableSkeleton } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
} from '@/components/ui/primitives';
import { api, ApiError, unwrap } from '@/lib/api/client';
import { qk } from '@/lib/query/keys';
import { useModels } from './api';
import { formatMetric, FrameworkBadge, VersionStatusBadge } from './labels';

function CreateModelDialog({ orgId, projectId }: { orgId: string; projectId: string }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string>();

  const create = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/api/v1/orgs/{orgId}/projects/{projectId}/models', {
          params: { path: { orgId, projectId } },
          body: { name },
        }),
      ),
    meta: { silentError: true },
    onSuccess: async (m) => {
      toast.success(`Model “${m.name}” created`);
      setOpen(false);
      setName('');
      await queryClient.invalidateQueries({ queryKey: qk.models(orgId, projectId) });
    },
    onError: (err) =>
      setError(
        err instanceof ApiError
          ? (err.fieldErrors().name ?? err.message)
          : 'Could not create the model.',
      ),
  });

  function submit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    if (name.trim().length < 2) {
      setError('Use at least 2 characters.');
      return;
    }
    setError(undefined);
    create.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <PlusIcon aria-hidden />
          New model
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form method="post" className="grid gap-4" onSubmit={submit} noValidate>
          <DialogHeader>
            <DialogTitle>New model</DialogTitle>
            <DialogDescription>
              A model collects numbered versions. It is also created in the MLflow Model Registry.
            </DialogDescription>
          </DialogHeader>
          <Field id="model-name" label="Name" error={error}>
            <Input
              id="model-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              placeholder="Churn classifier"
              aria-invalid={!!error}
            />
          </Field>
          <DialogFooter>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? 'Creating…' : 'Create model'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ModelsSection({ orgId, projectId }: { orgId: string; projectId: string }) {
  const models = useModels(orgId, projectId);
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1.5">
          <CardTitle>Models</CardTitle>
          <CardDescription>Registered models and their latest version.</CardDescription>
        </div>
        <PermissionGate orgId={orgId} permission="model:create">
          <CreateModelDialog orgId={orgId} projectId={projectId} />
        </PermissionGate>
      </CardHeader>
      <CardContent>
        {models.isPending ? (
          <TableSkeleton rows={2} />
        ) : models.isError ? (
          <ErrorState error={models.error} onRetry={() => void models.refetch()} />
        ) : models.data.length === 0 ? (
          <div className="flex items-center gap-3 rounded-xl border border-dashed p-6 text-sm text-muted-foreground">
            <BoxIcon className="size-5" aria-hidden />
            No models yet. Create one, then register a finished run as its first version.
          </div>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {models.data.map((m) => (
              <li key={m.id}>
                <Link
                  href={`/orgs/${orgId}/models/${m.id}`}
                  className="grid gap-2 rounded-lg border p-4 transition-colors hover:bg-accent"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{m.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {m.versionCount} version{m.versionCount === 1 ? '' : 's'}
                    </span>
                  </div>
                  {m.latestVersion ? (
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-mono">v{m.latestVersion.version}</span>
                      <VersionStatusBadge status={m.latestVersion.status} />
                      <FrameworkBadge framework={m.latestVersion.framework} />
                      <span className="text-muted-foreground tabular-nums">
                        AUC {formatMetric('test_roc_auc', m.latestVersion.metrics.test_roc_auc)}
                      </span>
                    </div>
                  ) : (
                    <span className="text-sm text-muted-foreground">No versions yet</span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

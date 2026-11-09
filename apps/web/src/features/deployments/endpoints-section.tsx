'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PlusIcon, ServerIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
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
import { useEndpoints } from './api';
import { RevisionStateBadge } from './labels';

function CreateEndpointDialog({ orgId, projectId }: { orgId: string; projectId: string }) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string>();

  const create = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/api/v1/orgs/{orgId}/projects/{projectId}/endpoints', {
          params: { path: { orgId, projectId } },
          body: { name },
        }),
      ),
    meta: { silentError: true },
    onSuccess: async (e) => {
      toast.success(`Endpoint “${e.name}” created`);
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: qk.endpoints(orgId, projectId) });
      router.push(`/orgs/${orgId}/endpoints/${e.id}`);
    },
    onError: (err) =>
      setError(
        err instanceof ApiError
          ? (err.fieldErrors().name ?? err.message)
          : 'Could not create the endpoint.',
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
          New endpoint
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form method="post" className="grid gap-4" onSubmit={submit} noValidate>
          <DialogHeader>
            <DialogTitle>New endpoint</DialogTitle>
            <DialogDescription>
              A stable inference URL. Deploy validated model versions to it; clients call it with an
              API key of this project. Staging only for now (production approvals arrive in M8).
            </DialogDescription>
          </DialogHeader>
          <Field id="endpoint-name" label="Name" error={error}>
            <Input
              id="endpoint-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
              placeholder="Churn staging"
              aria-invalid={!!error}
            />
          </Field>
          <DialogFooter>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? 'Creating…' : 'Create endpoint'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function EndpointsSection({ orgId, projectId }: { orgId: string; projectId: string }) {
  const endpoints = useEndpoints(orgId, projectId);
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1.5">
          <CardTitle>Endpoints</CardTitle>
          <CardDescription>Where validated models serve predictions.</CardDescription>
        </div>
        <PermissionGate orgId={orgId} permission="endpoint:create">
          <CreateEndpointDialog orgId={orgId} projectId={projectId} />
        </PermissionGate>
      </CardHeader>
      <CardContent>
        {endpoints.isPending ? (
          <TableSkeleton rows={2} />
        ) : endpoints.isError ? (
          <ErrorState error={endpoints.error} onRetry={() => void endpoints.refetch()} />
        ) : endpoints.data.length === 0 ? (
          <div className="flex items-center gap-3 rounded-xl border border-dashed p-6 text-sm text-muted-foreground">
            <ServerIcon className="size-5" aria-hidden />
            No endpoints yet. Create one, then deploy a validated model version to it.
          </div>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {endpoints.data.map((e) => (
              <li key={e.id}>
                <Link
                  href={`/orgs/${orgId}/endpoints/${e.id}`}
                  className="grid gap-2 rounded-lg border p-4 transition-colors hover:bg-accent"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{e.name}</span>
                    <code className="font-mono text-xs text-muted-foreground">{e.slug}</code>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    {e.stableRevision ? (
                      <>
                        <RevisionStateBadge state={e.stableRevision.state} />
                        <span>
                          {e.stableRevision.modelVersion.modelName} v
                          {e.stableRevision.modelVersion.version}
                        </span>
                      </>
                    ) : (
                      <span className="text-muted-foreground">Nothing deployed</span>
                    )}
                    {e.inProgressRevision && (
                      <RevisionStateBadge state={e.inProgressRevision.state} />
                    )}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

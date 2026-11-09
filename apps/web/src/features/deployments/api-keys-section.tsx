'use client';

import type { ApiKey, CreatedApiKey } from '@modelops/api-contract';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckIcon, CopyIcon, KeyRoundIcon, PlusIcon } from 'lucide-react';
import { type SubmitEvent, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
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
  Alert,
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Table,
  TBody,
  Td,
  Th,
  THead,
  Tr,
} from '@/components/ui/primitives';
import { api, ApiError, unwrap } from '@/lib/api/client';
import { qk } from '@/lib/query/keys';
import { formatRelative } from '@/lib/utils';
import { useApiKeys } from './api';

export function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-md border bg-muted/50 p-2">
      {/* Long values scroll sideways: focusable so keyboard users can scroll them too. */}
      <code
        tabIndex={0}
        role="region"
        aria-label={label.replace(/^Copy /, '')}
        className="min-w-0 flex-1 overflow-x-auto rounded-sm font-mono text-xs whitespace-pre outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {value}
      </code>
      <Button
        variant="ghost"
        size="icon"
        className="size-7 shrink-0"
        aria-label={label}
        onClick={() => void navigator.clipboard.writeText(value).then(() => setCopied(true))}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </div>
  );
}

function CreateKeyDialog({ orgId, projectId }: { orgId: string; projectId: string }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string>();
  const [created, setCreated] = useState<CreatedApiKey | null>(null);

  const create = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/api/v1/orgs/{orgId}/projects/{projectId}/api-keys', {
          params: { path: { orgId, projectId } },
          body: { name },
        }),
      ),
    meta: { silentError: true },
    onSuccess: async (k) => {
      setCreated(k);
      await queryClient.invalidateQueries({ queryKey: qk.apiKeys(orgId, projectId) });
    },
    onError: (err) =>
      setError(err instanceof ApiError ? (err.fieldErrors().name ?? err.message) : 'Failed.'),
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

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      // The secret only ever lives in this component's state: closing forgets it.
      setCreated(null);
      setName('');
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <PlusIcon aria-hidden />
          New API key
        </Button>
      </DialogTrigger>
      <DialogContent>
        {created ? (
          <div className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Copy your API key now</DialogTitle>
              <DialogDescription>
                This is the only time it is shown. ModelOps stores only a keyed hash of it.
              </DialogDescription>
            </DialogHeader>
            <CopyField value={created.key} label="Copy API key" />
            <Alert>
              <span>
                Send it as <code className="font-mono text-xs">Authorization: Bearer …</code> to any
                endpoint of this project. Revoke it here if it leaks.
              </span>
            </Alert>
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <form method="post" className="grid gap-4" onSubmit={submit} noValidate>
            <DialogHeader>
              <DialogTitle>New API key</DialogTitle>
              <DialogDescription>
                Inference keys belong to this project and can call any of its endpoints.
              </DialogDescription>
            </DialogHeader>
            <Field id="key-name" label="Name" error={error}>
              <Input
                id="key-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={60}
                placeholder="checkout service"
                aria-invalid={!!error}
              />
            </Field>
            <DialogFooter>
              <Button type="submit" disabled={create.isPending}>
                {create.isPending ? 'Creating…' : 'Create key'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function ApiKeysSection({ orgId, projectId }: { orgId: string; projectId: string }) {
  const queryClient = useQueryClient();
  const keys = useApiKeys(orgId, projectId);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  const revoke = useMutation({
    mutationFn: (keyId: string) =>
      unwrap(
        api.DELETE('/api/v1/orgs/{orgId}/api-keys/{keyId}', { params: { path: { orgId, keyId } } }),
      ),
    onSuccess: async () => {
      toast.success('Key revoked; the gateway stops accepting it within seconds');
      setRevoking(null);
      await queryClient.invalidateQueries({ queryKey: qk.apiKeys(orgId, projectId) });
    },
  });

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1.5">
          <CardTitle>API keys</CardTitle>
          <CardDescription>Credentials for calling this project’s endpoints.</CardDescription>
        </div>
        <PermissionGate orgId={orgId} permission="apikey:manage">
          <CreateKeyDialog orgId={orgId} projectId={projectId} />
        </PermissionGate>
      </CardHeader>
      <CardContent>
        {keys.isPending ? (
          <TableSkeleton rows={2} />
        ) : keys.isError ? (
          <ErrorState error={keys.error} onRetry={() => void keys.refetch()} />
        ) : keys.data.length === 0 ? (
          <div className="flex items-center gap-3 rounded-xl border border-dashed p-6 text-sm text-muted-foreground">
            <KeyRoundIcon className="size-5" aria-hidden />
            No API keys yet.
          </div>
        ) : (
          <Table>
            <THead>
              <Tr>
                <Th>Name</Th>
                <Th>Key</Th>
                <Th className="hidden sm:table-cell">Created</Th>
                <Th>Status</Th>
                <Th className="w-24">
                  <span className="sr-only">Actions</span>
                </Th>
              </Tr>
            </THead>
            <TBody>
              {keys.data.map((k) => (
                <Tr key={k.id}>
                  <Td className="font-medium">{k.name}</Td>
                  <Td className="font-mono text-xs">mo_{k.prefix}_…</Td>
                  <Td className="hidden text-muted-foreground sm:table-cell">
                    {formatRelative(k.createdAt)} by {k.createdByName}
                  </Td>
                  <Td>
                    {k.revokedAt ? (
                      <Badge variant="outline">Revoked</Badge>
                    ) : (
                      <Badge variant="success">Active</Badge>
                    )}
                  </Td>
                  <Td>
                    {!k.revokedAt && (
                      <PermissionGate orgId={orgId} permission="apikey:manage">
                        <Button variant="ghost" size="sm" onClick={() => setRevoking(k)}>
                          Revoke
                        </Button>
                      </PermissionGate>
                    )}
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
      </CardContent>
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(o) => !o && setRevoking(null)}
        title={`Revoke “${revoking?.name ?? ''}”?`}
        description="Clients using this key get 401 within seconds. This cannot be undone."
        confirmLabel="Revoke key"
        pending={revoke.isPending}
        onConfirm={() => revoking && revoke.mutate(revoking.id)}
      />
    </Card>
  );
}

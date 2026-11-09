'use client';

import type { Project } from '@modelops/api-contract';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArchiveIcon, ArrowLeftIcon } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { type SubmitEvent, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { ErrorState, PageHeader, PermissionGate, TableSkeleton } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Label,
  Textarea,
} from '@/components/ui/primitives';
import { ApiKeysSection } from '@/features/deployments/api-keys-section';
import { EndpointsSection } from '@/features/deployments/endpoints-section';
import { ModelsSection } from '@/features/ml/models-section';
import { RunsSection } from '@/features/ml/runs-section';
import { useOrgId } from '@/features/org/org-shell';
import { api, ApiError, unwrap } from '@/lib/api/client';
import { useCan } from '@/lib/auth/session';
import { qk } from '@/lib/query/keys';
import { formatDateTime } from '@/lib/utils';

function EditProjectForm({ orgId, project }: { orgId: string; project: Project }) {
  const queryClient = useQueryClient();
  const canEdit = useCan(orgId, 'project:update');
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? '');
  const [error, setError] = useState<string>();
  const key = qk.project(orgId, project.id);

  /**
   * Optimistic update: renaming is low-risk and instantly reversible, so the UI shows the new
   * name immediately and rolls back if the API refuses. (Deploy/rollback are never optimistic.)
   */
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.PATCH('/api/v1/orgs/{orgId}/projects/{projectId}', {
          params: { path: { orgId, projectId: project.id } },
          body: { name, description },
        }),
      ),
    meta: { silentError: true },
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<Project>(key);
      queryClient.setQueryData<Project>(key, (p) => (p ? { ...p, name, description } : p));
      return { previous };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(key, ctx.previous);
      setError(
        err instanceof ApiError ? (err.fieldErrors().name ?? err.message) : 'Could not save.',
      );
    },
    onSuccess: (saved) => {
      setError(undefined);
      queryClient.setQueryData(key, saved);
      toast.success('Project saved');
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: qk.projects(orgId) }),
  });

  function submit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    if (name.trim().length < 2) {
      setError('Use at least 2 characters.');
      return;
    }
    save.mutate();
  }

  const readOnly = !canEdit || !!project.archivedAt;
  const dirty = name !== project.name || description !== (project.description ?? '');
  return (
    <Card>
      <CardHeader>
        <CardTitle>Details</CardTitle>
        <CardDescription>
          The URL name (slug) never changes, so links and API paths stay valid.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid max-w-lg gap-4" onSubmit={submit} noValidate>
          <Field id="edit-name" label="Name" error={error}>
            <Input
              id="edit-name"
              value={name}
              disabled={readOnly}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              aria-invalid={!!error}
            />
          </Field>
          <div className="grid gap-2">
            <Label htmlFor="edit-description">Description</Label>
            <Textarea
              id="edit-description"
              value={description}
              disabled={readOnly}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={500}
            />
          </div>
          {!readOnly && (
            <Button
              type="submit"
              className="justify-self-start"
              disabled={!dirty || save.isPending}
            >
              {save.isPending ? 'Saving…' : 'Save changes'}
            </Button>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

export function ProjectDetailPage() {
  const orgId = useOrgId();
  const { projectId } = useParams<{ projectId: string }>();
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const query = useQuery({
    queryKey: qk.project(orgId, projectId),
    queryFn: () =>
      unwrap(
        api.GET('/api/v1/orgs/{orgId}/projects/{projectId}', {
          params: { path: { orgId, projectId } },
        }),
      ),
  });

  const archive = useMutation({
    mutationFn: () =>
      unwrap(
        api.DELETE('/api/v1/orgs/{orgId}/projects/{projectId}', {
          params: { path: { orgId, projectId } },
        }),
      ),
    onSuccess: async (p) => {
      setConfirmOpen(false);
      toast.success(`“${p.name}” archived`);
      queryClient.setQueryData(qk.project(orgId, projectId), p);
      await queryClient.invalidateQueries({ queryKey: qk.projects(orgId) });
    },
  });

  if (query.isPending) return <TableSkeleton rows={3} />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const project = query.data;

  return (
    <div className="grid gap-6">
      <Link
        href={`/orgs/${orgId}/projects`}
        className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeftIcon className="size-4" aria-hidden /> All projects
      </Link>
      <PageHeader
        title={project.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono">{project.slug}</span>
            <span aria-hidden>·</span>
            <span>created {formatDateTime(project.createdAt)}</span>
            {project.archivedAt && <Badge variant="outline">Archived</Badge>}
          </span>
        }
        actions={
          !project.archivedAt && (
            <PermissionGate orgId={orgId} permission="project:archive">
              <Button variant="outline" onClick={() => setConfirmOpen(true)}>
                <ArchiveIcon aria-hidden />
                Archive
              </Button>
            </PermissionGate>
          )
        }
      />
      <RunsSection orgId={orgId} projectId={project.id} />
      <ModelsSection orgId={orgId} projectId={project.id} />
      <EndpointsSection orgId={orgId} projectId={project.id} />
      <PermissionGate orgId={orgId} permission="apikey:read">
        <ApiKeysSection orgId={orgId} projectId={project.id} />
      </PermissionGate>
      <EditProjectForm key={project.updatedAt} orgId={orgId} project={project} />
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Archive “${project.name}”?`}
        description="It disappears from the project list. Its history and audit records are kept."
        confirmLabel="Archive project"
        pending={archive.isPending}
        onConfirm={() => archive.mutate()}
      />
    </div>
  );
}

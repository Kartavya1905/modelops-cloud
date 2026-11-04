'use client';

import type { Project } from '@modelops/api-contract';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { FolderKanbanIcon, PlusIcon } from 'lucide-react';
import Link from 'next/link';
import { type SubmitEvent, useState } from 'react';
import { toast } from 'sonner';
import {
  EmptyState,
  ErrorState,
  PageHeader,
  PermissionGate,
  TableSkeleton,
} from '@/components/common/states';
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
  Badge,
  Field,
  Input,
  Label,
  Table,
  TBody,
  Td,
  Textarea,
  Th,
  THead,
  Tr,
} from '@/components/ui/primitives';
import { useOrgId } from '@/features/org/org-shell';
import { api, ApiError, unwrap } from '@/lib/api/client';
import { qk } from '@/lib/query/keys';
import { formatRelative } from '@/lib/utils';

export function useProjects(orgId: string, includeArchived: boolean) {
  return useInfiniteQuery({
    queryKey: qk.projectList(orgId, includeArchived),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/api/v1/orgs/{orgId}/projects', {
          params: {
            path: { orgId },
            query: { limit: 20, includeArchived, ...(pageParam && { cursor: pageParam }) },
          },
        }),
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function CreateProjectDialog({ orgId }: { orgId: string }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const create = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/api/v1/orgs/{orgId}/projects', {
          params: { path: { orgId } },
          body: { name, ...(description.trim() && { description }) },
        }),
      ),
    meta: { silentError: true },
    onSuccess: async (project) => {
      toast.success(`Project “${project.name}” created`);
      setOpen(false);
      setName('');
      setDescription('');
      await queryClient.invalidateQueries({ queryKey: qk.projects(orgId) });
    },
    onError: (err) => {
      if (!(err instanceof ApiError)) {
        setErrors({ form: 'Could not create the project.' });
      } else if (err.problem.code === 'PROJECT_SLUG_TAKEN') {
        setErrors({ name: err.problem.detail ?? 'That name is already in use.' });
      } else {
        const fields = err.fieldErrors();
        setErrors(Object.keys(fields).length > 0 ? fields : { form: err.message });
      }
    },
  });

  function submit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    if (name.trim().length < 2) {
      setErrors({ name: 'Use at least 2 characters.' });
      return;
    }
    setErrors({});
    create.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <PlusIcon aria-hidden />
          New project
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form className="grid gap-4" onSubmit={submit} noValidate>
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
            <DialogDescription>
              A project groups the experiments, models and endpoints for one ML use case.
            </DialogDescription>
          </DialogHeader>
          {errors.form && (
            <p className="text-sm text-destructive" role="alert">
              {errors.form}
            </p>
          )}
          <Field id="project-name" label="Name" error={errors.name}>
            <Input
              id="project-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              aria-invalid={!!errors.name}
              placeholder="Customer churn"
            />
          </Field>
          <div className="grid gap-2">
            <Label htmlFor="project-description">Description (optional)</Label>
            <Textarea
              id="project-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={500}
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? 'Creating…' : 'Create project'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ProjectsPage() {
  const orgId = useOrgId();
  const [includeArchived, setIncludeArchived] = useState(false);
  const query = useProjects(orgId, includeArchived);
  const projects: Project[] = query.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Projects"
        description="Each project will hold the experiments, models and endpoints for one ML use case."
        actions={
          <PermissionGate orgId={orgId} permission="project:create">
            <CreateProjectDialog orgId={orgId} />
          </PermissionGate>
        }
      />

      <label className="flex w-fit items-center gap-2 text-sm text-muted-foreground">
        <input
          type="checkbox"
          className="size-4 accent-primary"
          checked={includeArchived}
          onChange={(e) => setIncludeArchived(e.target.checked)}
        />
        Show archived
      </label>

      {query.isPending ? (
        <TableSkeleton />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : projects.length === 0 ? (
        <EmptyState
          icon={FolderKanbanIcon}
          title="No projects yet"
          description="Create a project to start tracking experiments and deploying models."
        />
      ) : (
        <div className="rounded-xl border bg-card">
          <Table>
            <THead>
              <Tr>
                <Th>Name</Th>
                <Th className="hidden sm:table-cell">Slug</Th>
                <Th className="hidden md:table-cell">Created</Th>
                <Th>Status</Th>
              </Tr>
            </THead>
            <TBody>
              {projects.map((p) => (
                <Tr key={p.id}>
                  <Td>
                    <Link
                      href={`/orgs/${orgId}/projects/${p.id}`}
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      {p.name}
                    </Link>
                    {p.description && (
                      <p className="line-clamp-1 text-xs text-muted-foreground">{p.description}</p>
                    )}
                  </Td>
                  <Td className="hidden font-mono text-xs text-muted-foreground sm:table-cell">
                    {p.slug}
                  </Td>
                  <Td className="hidden text-muted-foreground md:table-cell">
                    <time dateTime={p.createdAt}>{formatRelative(p.createdAt)}</time>
                  </Td>
                  <Td>
                    {p.archivedAt ? (
                      <Badge variant="outline">Archived</Badge>
                    ) : (
                      <Badge variant="success">Active</Badge>
                    )}
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        </div>
      )}

      {query.hasNextPage && (
        <Button
          variant="outline"
          className="justify-self-center"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </Button>
      )}
    </div>
  );
}

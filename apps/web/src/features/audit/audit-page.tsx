'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { ScrollTextIcon } from 'lucide-react';
import { useState } from 'react';
import { EmptyState, ErrorState, PageHeader, TableSkeleton } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import { Badge, Table, TBody, Td, Th, THead, Tr } from '@/components/ui/primitives';
import { NativeSelect } from '@/components/ui/select';
import { useOrgId } from '@/features/org/org-shell';
import { api, unwrap } from '@/lib/api/client';
import { qk } from '@/lib/query/keys';
import { formatDateTime } from '@/lib/utils';

const ACTIONS = [
  'organization.created',
  'project.created',
  'project.updated',
  'project.archived',
  'invitation.created',
  'member.joined',
  'member.role_changed',
  'member.removed',
];

function summarize(metadata: unknown): string {
  if (typeof metadata !== 'object' || metadata === null) return '';
  return Object.entries(metadata as Record<string, unknown>)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`)
    .join(' · ');
}

export function AuditPage() {
  const orgId = useOrgId();
  const [action, setAction] = useState('');
  const query = useInfiniteQuery({
    queryKey: qk.audit(orgId, action),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/api/v1/orgs/{orgId}/audit-events', {
          params: {
            path: { orgId },
            query: {
              limit: 50,
              ...(action && { action }),
              ...(pageParam && { cursor: pageParam }),
            },
          },
        }),
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const events = query.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Audit log"
        description="An append-only record of who changed what. Entries can't be edited or deleted, even in the database."
        actions={
          <NativeSelect
            aria-label="Filter by action"
            value={action}
            onChange={(e) => setAction(e.target.value)}
          >
            <option value="">All actions</option>
            {ACTIONS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </NativeSelect>
        }
      />
      {query.isPending ? (
        <TableSkeleton rows={6} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : events.length === 0 ? (
        <EmptyState
          icon={ScrollTextIcon}
          title="No events"
          description="Nothing matches this filter yet."
        />
      ) : (
        <div className="rounded-xl border bg-card">
          <Table>
            <THead>
              <Tr>
                <Th>When</Th>
                <Th>Who</Th>
                <Th>Action</Th>
                <Th className="hidden lg:table-cell">Details</Th>
              </Tr>
            </THead>
            <TBody>
              {events.map((e) => (
                <Tr key={e.id}>
                  <Td className="whitespace-nowrap text-muted-foreground">
                    <time dateTime={e.createdAt}>{formatDateTime(e.createdAt)}</time>
                  </Td>
                  <Td>
                    {e.actor ? e.actor.name : <span className="text-muted-foreground">System</span>}
                  </Td>
                  <Td>
                    <Badge variant="secondary" className="font-mono">
                      {e.action}
                    </Badge>
                  </Td>
                  <Td className="hidden text-xs text-muted-foreground lg:table-cell">
                    {summarize(e.metadata)}
                    {e.requestId && (
                      <div className="font-mono opacity-70">req {e.requestId.slice(0, 8)}</div>
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
          {query.isFetchingNextPage ? 'Loading…' : 'Load older events'}
        </Button>
      )}
    </div>
  );
}

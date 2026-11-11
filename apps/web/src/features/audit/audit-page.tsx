'use client';

import { useInfiniteQuery, useMutation } from '@tanstack/react-query';
import { ScrollTextIcon, ShieldAlertIcon, ShieldCheckIcon } from 'lucide-react';
import { useState } from 'react';
import { EmptyState, ErrorState, PageHeader, TableSkeleton } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import { Alert, Badge, Table, TBody, Td, Th, THead, Tr } from '@/components/ui/primitives';
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

/**
 * M9: tamper evidence. Every entry's hash covers the one before it; the API recomputes the chain
 * in the database and reports the first entry that does not verify.
 */
function AuditIntegrity({ orgId }: { orgId: string }) {
  const verify = useMutation({
    mutationFn: () =>
      unwrap(api.GET('/api/v1/orgs/{orgId}/audit-events/verify', { params: { path: { orgId } } })),
  });
  const v = verify.data;
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm" data-testid="audit-integrity">
      <Button
        variant="outline"
        size="sm"
        disabled={verify.isPending}
        onClick={() => verify.mutate()}
      >
        <ShieldCheckIcon aria-hidden /> {verify.isPending ? 'Verifying…' : 'Verify integrity'}
      </Button>
      <span role="status" aria-live="polite" className="contents">
        {v?.intact && (
          <span className="flex items-center gap-2">
            <Badge variant="success">Intact</Badge>
            {v.checked.toLocaleString()} entries verified
            {v.head && (
              <code className="font-mono text-xs text-muted-foreground">
                head {v.head.slice(0, 12)}…
              </code>
            )}
          </span>
        )}
        {v && !v.intact && (
          <Alert variant="destructive" className="w-full">
            <span className="flex items-center gap-2 font-medium">
              <ShieldAlertIcon className="size-4" aria-hidden /> The audit log was changed
            </span>
            <span>
              Entry #{v.brokenAt}: {v.reason}. {v.checked.toLocaleString()} entries before it
              verify.
            </span>
          </Alert>
        )}
      </span>
    </div>
  );
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
        description="An append-only record of who changed what. The app can't edit or delete entries, and each entry is hash-chained to the one before it, so any change made directly in the database is detectable."
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
      <AuditIntegrity orgId={orgId} />
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

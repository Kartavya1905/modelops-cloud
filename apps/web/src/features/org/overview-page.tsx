'use client';

import {
  ActivityIcon,
  BoxesIcon,
  FolderKanbanIcon,
  RocketIcon,
  ServerIcon,
  ShieldCheckIcon,
} from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { ErrorState, PageHeader, TableSkeleton } from '@/components/common/states';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Table,
  TBody,
  Td,
  Th,
  THead,
  Tr,
} from '@/components/ui/primitives';
import { useOverview } from '@/features/deployments/api';
import { RevisionStateBadge } from '@/features/deployments/labels';
import { formatRelative } from '@/lib/utils';
import { useOrgId } from './org-shell';

function Tile({
  icon,
  label,
  value,
  detail,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <Card>
      <CardContent className="grid gap-1 pt-6">
        <span className="flex items-center gap-2 text-sm text-muted-foreground">
          {icon}
          {label}
        </span>
        <span className="text-2xl font-semibold tabular-nums" data-tile={label}>
          {value}
        </span>
        {detail && <span className="text-xs text-muted-foreground">{detail}</span>}
      </CardContent>
    </Card>
  );
}

/** Organization overview (M6): what exists, what is serving, and what happened recently. */
export function OverviewPage() {
  const orgId = useOrgId();
  const overview = useOverview(orgId);
  if (overview.isPending) return <TableSkeleton rows={4} />;
  if (overview.isError) {
    return <ErrorState error={overview.error} onRetry={() => void overview.refetch()} />;
  }
  const o = overview.data;
  const count = (list: { state: string; count: number }[], state: string) =>
    list.find((s) => s.state === state)?.count ?? 0;
  const versions = o.versions.reduce((n, v) => n + v.count, 0);
  const deploys = o.deployments7d.reduce((n, v) => n + v.count, 0);
  const failed = count(o.deployments7d, 'FAILED');

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Overview"
        description="Everything in this organization at a glance. Refreshed every 30 s."
      />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Tile
          icon={<FolderKanbanIcon className="size-4" aria-hidden />}
          label="Projects"
          value={String(o.projects)}
        />
        <Tile
          icon={<BoxesIcon className="size-4" aria-hidden />}
          label="Models"
          value={String(o.models)}
          detail={`${String(versions)} versions`}
        />
        <Tile
          icon={<ShieldCheckIcon className="size-4" aria-hidden />}
          label="Validated versions"
          value={String(count(o.versions, 'VALIDATED'))}
          detail={`${String(count(o.versions, 'REJECTED'))} rejected`}
        />
        <Tile
          icon={<ServerIcon className="size-4" aria-hidden />}
          label="Endpoints serving"
          value={`${String(o.servingEndpoints)} / ${String(o.endpoints)}`}
        />
        <Tile
          icon={<RocketIcon className="size-4" aria-hidden />}
          label="Deployments (7 days)"
          value={String(deploys)}
          detail={failed ? `${String(failed)} failed` : 'none failed'}
        />
        <Tile
          icon={<ActivityIcon className="size-4" aria-hidden />}
          label="Requests (24 h)"
          value={o.requests24h === null ? '—' : o.requests24h.toLocaleString()}
          detail={o.requests24h === null ? 'Metrics are unavailable right now' : 'All endpoints'}
        />
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Recent deployments</CardTitle>
          <CardDescription>The latest revisions across all endpoints.</CardDescription>
        </CardHeader>
        <CardContent>
          {o.recentDeployments.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No deployments yet. Create an endpoint in a project and deploy a validated version.
            </p>
          ) : (
            <Table>
              <THead>
                <Tr>
                  <Th>Endpoint</Th>
                  <Th>Model version</Th>
                  <Th>State</Th>
                  <Th className="hidden sm:table-cell">When</Th>
                </Tr>
              </THead>
              <TBody>
                {o.recentDeployments.map((d) => (
                  <Tr key={d.revisionId}>
                    <Td>
                      <Link
                        href={`/orgs/${orgId}/endpoints/${d.endpointId}`}
                        className="font-medium underline-offset-4 hover:underline"
                      >
                        {d.endpointName}
                      </Link>{' '}
                      <span className="text-xs text-muted-foreground">#{d.revisionNumber}</span>
                    </Td>
                    <Td>
                      {d.modelName} v{d.modelVersion}
                    </Td>
                    <Td>
                      <RevisionStateBadge state={d.state} />
                    </Td>
                    <Td className="hidden text-muted-foreground sm:table-cell">
                      {formatRelative(d.createdAt)}
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

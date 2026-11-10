'use client';

import type { Approval } from '@modelops/api-contract';
import { CheckIcon, ShieldCheckIcon, XIcon } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { EmptyState, ErrorState, PageHeader, TableSkeleton } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge, Card, CardContent, Field, Textarea } from '@/components/ui/primitives';
import { useOrgId } from '@/features/org/org-shell';
import { ApiError, errorMessage } from '@/lib/api/client';
import { formatDateTime, formatRelative } from '@/lib/utils';
import {
  APPROVAL_FILTERS,
  type ApprovalFilter,
  useApprovals,
  useDecideApproval,
} from './releases-api';

const STATUS = {
  PENDING: { label: 'Pending', variant: 'warning' },
  APPROVED: { label: 'Approved', variant: 'success' },
  REJECTED: { label: 'Rejected', variant: 'destructive' },
  EXPIRED: { label: 'Expired', variant: 'outline' },
} as const;

function RejectDialog({
  orgId,
  approval,
  onClose,
}: {
  orgId: string;
  approval: Approval;
  onClose: () => void;
}) {
  const decide = useDecideApproval(orgId);
  const [reason, setReason] = useState('');
  const error = decide.error instanceof ApiError ? decide.error : null;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reject this deployment?</DialogTitle>
          <DialogDescription>
            Revision {approval.revision.revisionNumber} of {approval.endpoint.name} is cancelled.
            {approval.requestedBy.name} sees your reason.
          </DialogDescription>
        </DialogHeader>
        <Field id="reject-reason" label="Reason" error={error?.fieldErrors().reason}>
          <Textarea
            id="reject-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            placeholder="e.g. the evaluation on last week's data is missing"
          />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Back
          </Button>
          <Button
            variant="destructive"
            disabled={reason.trim().length === 0 || decide.isPending}
            onClick={() =>
              decide.mutate(
                { approvalId: approval.id, decision: 'reject', reason: reason.trim() },
                {
                  onSuccess: () => {
                    toast.success('Deployment rejected');
                    onClose();
                  },
                  onError: (err) => toast.error(errorMessage(err)),
                },
              )
            }
          >
            <XIcon aria-hidden /> Reject
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ApprovalItem({ orgId, a }: { orgId: string; a: Approval }) {
  const decide = useDecideApproval(orgId);
  const [rejecting, setRejecting] = useState(false);
  const s = STATUS[a.status];
  return (
    <li className="grid gap-3 rounded-lg border p-4" data-approval={a.id}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={s.variant}>{s.label}</Badge>
        <span className="font-medium">
          <Link
            href={`/orgs/${orgId}/endpoints/${a.endpoint.id}`}
            className="underline-offset-4 hover:underline"
          >
            {a.endpoint.name}
          </Link>
          : revision {a.revision.revisionNumber}, {a.revision.modelVersion.modelName} v
          {a.revision.modelVersion.version}
          {a.revision.strategy === 'CANARY'
            ? ` as a ${String(a.revision.canaryWeight)}% canary`
            : ''}
        </span>
      </div>
      <p className="text-sm text-muted-foreground">
        Requested by {a.requestedBy.name} {formatRelative(a.createdAt)}
        {a.status === 'PENDING' ? ` · expires ${formatDateTime(a.expiresAt)}` : ''}
        {a.decidedBy ? ` · ${s.label.toLowerCase()} by ${a.decidedBy.name}` : ''}
        {a.reason ? ` · “${a.reason}”` : ''}
      </p>
      {a.status === 'PENDING' &&
        (a.canDecide ? (
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={decide.isPending}
              onClick={() =>
                decide.mutate(
                  { approvalId: a.id, decision: 'approve' },
                  {
                    onSuccess: () => toast.success('Approved: the deployment is queued'),
                    onError: (err) => toast.error(errorMessage(err)),
                  },
                )
              }
            >
              <CheckIcon aria-hidden /> Approve
            </Button>
            <Button variant="outline" onClick={() => setRejecting(true)}>
              <XIcon aria-hidden /> Reject
            </Button>
          </div>
        ) : (
          <p className="text-sm">
            Waiting for another Owner or Admin: nobody approves their own deployment, and only
            Owners and Admins decide.
          </p>
        ))}
      {rejecting && <RejectDialog orgId={orgId} approval={a} onClose={() => setRejecting(false)} />}
    </li>
  );
}

/** M8: four-eyes approvals for production deployments (FR-41). */
export function ApprovalsPage() {
  const orgId = useOrgId();
  const [filter, setFilter] = useState<ApprovalFilter>('PENDING');
  const approvals = useApprovals(orgId, filter);
  return (
    <div className="grid gap-6">
      <PageHeader
        title="Approvals"
        description="Production deployments wait here until a second Owner or Admin approves them."
        actions={
          <div role="group" aria-label="Show" className="flex gap-1">
            {APPROVAL_FILTERS.map((f) => (
              <Button
                key={f}
                size="sm"
                variant={f === filter ? 'default' : 'outline'}
                aria-pressed={f === filter}
                onClick={() => setFilter(f)}
              >
                {f === 'PENDING' ? 'Pending' : 'All'}
              </Button>
            ))}
          </div>
        }
      />
      {approvals.isPending ? (
        <TableSkeleton rows={3} />
      ) : approvals.isError ? (
        <ErrorState error={approvals.error} onRetry={() => void approvals.refetch()} />
      ) : approvals.data.length === 0 ? (
        <EmptyState
          icon={ShieldCheckIcon}
          title={filter === 'PENDING' ? 'Nothing to approve' : 'No approvals yet'}
          description="Deployments to production endpoints appear here for a second pair of eyes."
        />
      ) : (
        <Card>
          <CardContent className="pt-6">
            <ul className="grid gap-3" aria-label="Approvals">
              {approvals.data.map((a) => (
                <ApprovalItem key={a.id} orgId={orgId} a={a} />
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

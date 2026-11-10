'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, unwrap } from '@/lib/api/client';
import { qk } from '@/lib/query/keys';

/**
 * M8 release actions. Every one carries the endpoint's ETag (If-Match, from the rowVersion the
 * page shows), so a double click or a stale tab gets 412 instead of acting twice.
 */
const ifMatch = (rowVersion: number) => ({ 'If-Match': `W/"${String(rowVersion)}"` });

function useRefreshEndpoint(orgId: string, endpointId: string) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: qk.endpoint(orgId, endpointId) }),
      queryClient.invalidateQueries({ queryKey: ['orgs', orgId, 'projects'] }),
    ]);
}

export function useSetCanaryWeight(orgId: string, endpointId: string) {
  const refresh = useRefreshEndpoint(orgId, endpointId);
  return useMutation({
    mutationFn: ({ weight, rowVersion }: { weight: number; rowVersion: number }) =>
      unwrap(
        api.PUT('/api/v1/orgs/{orgId}/endpoints/{endpointId}/canary', {
          params: { path: { orgId, endpointId }, header: ifMatch(rowVersion) },
          body: { weight },
        }),
      ),
    onSettled: refresh,
  });
}

export function usePromote(orgId: string, endpointId: string) {
  const refresh = useRefreshEndpoint(orgId, endpointId);
  return useMutation({
    mutationFn: (rowVersion: number) =>
      unwrap(
        api.POST('/api/v1/orgs/{orgId}/endpoints/{endpointId}/promote', {
          params: { path: { orgId, endpointId }, header: ifMatch(rowVersion) },
        }),
      ),
    onSettled: refresh,
  });
}

export function useAbortCanary(orgId: string, endpointId: string) {
  const refresh = useRefreshEndpoint(orgId, endpointId);
  return useMutation({
    mutationFn: (rowVersion: number) =>
      unwrap(
        api.POST('/api/v1/orgs/{orgId}/endpoints/{endpointId}/canary/abort', {
          params: { path: { orgId, endpointId }, header: ifMatch(rowVersion) },
        }),
      ),
    onSettled: refresh,
  });
}

export function useRunCanaryCheck(orgId: string, endpointId: string) {
  const refresh = useRefreshEndpoint(orgId, endpointId);
  return useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/api/v1/orgs/{orgId}/endpoints/{endpointId}/canary/checks', {
          params: { path: { orgId, endpointId } },
        }),
      ),
    onSettled: refresh,
  });
}

export function useRollback(orgId: string, endpointId: string) {
  const refresh = useRefreshEndpoint(orgId, endpointId);
  return useMutation({
    mutationFn: ({
      rowVersion,
      targetRevisionId,
    }: {
      rowVersion: number;
      targetRevisionId?: string;
    }) =>
      unwrap(
        api.POST('/api/v1/orgs/{orgId}/endpoints/{endpointId}/rollback', {
          params: { path: { orgId, endpointId }, header: ifMatch(rowVersion) },
          body: targetRevisionId ? { targetRevisionId } : {},
        }),
      ),
    meta: { silentError: true },
    onSettled: refresh,
  });
}

export const APPROVAL_FILTERS = ['PENDING', 'ALL'] as const;
export type ApprovalFilter = (typeof APPROVAL_FILTERS)[number];

export function useApprovals(orgId: string, filter: ApprovalFilter) {
  return useQuery({
    queryKey: qk.approvals(orgId, filter),
    queryFn: () =>
      unwrap(
        api.GET('/api/v1/orgs/{orgId}/approvals', {
          params: { path: { orgId }, query: filter === 'PENDING' ? { status: 'PENDING' } : {} },
        }),
      ),
    refetchInterval: 15_000,
  });
}

export function useDecideApproval(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      approvalId,
      decision,
      reason,
    }: {
      approvalId: string;
      decision: 'approve' | 'reject';
      reason?: string;
    }) =>
      unwrap(
        decision === 'approve'
          ? api.POST('/api/v1/orgs/{orgId}/approvals/{approvalId}/approve', {
              params: { path: { orgId, approvalId } },
              body: reason ? { reason } : {},
            })
          : api.POST('/api/v1/orgs/{orgId}/approvals/{approvalId}/reject', {
              params: { path: { orgId, approvalId } },
              body: { reason },
            }),
      ),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['orgs', orgId, 'approvals'] }),
        queryClient.invalidateQueries({ queryKey: ['orgs', orgId, 'endpoints'] }),
      ]),
  });
}

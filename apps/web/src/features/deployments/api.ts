'use client';

import type { RevisionState } from '@modelops/api-contract';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, unwrap } from '@/lib/api/client';
import { qk } from '@/lib/query/keys';

const POLL_MS = 2000;
const CANARY_POLL_MS = 5000;
const SETTLED: ReadonlySet<RevisionState> = new Set([
  'READY',
  'FAILED',
  'CANCELLED',
  'RETIRED',
  'DRAINING',
]);
export const isSettled = (s: RevisionState) => SETTLED.has(s);

export function useEndpoints(orgId: string, projectId: string) {
  return useQuery({
    queryKey: qk.endpoints(orgId, projectId),
    queryFn: () =>
      unwrap(
        api.GET('/api/v1/orgs/{orgId}/projects/{projectId}/endpoints', {
          params: { path: { orgId, projectId } },
        }),
      ),
    refetchInterval: (q) => (q.state.data?.some((e) => e.inProgressRevision) ? POLL_MS : false),
    // Deploys finish on the endpoint page; the list must not show a stale state when revisited.
    refetchOnMount: 'always',
  });
}

/** Polls while a deployment is in progress (the API answers 202 and the worker does the rest). */
export function useEndpoint(orgId: string, endpointId: string) {
  return useQuery({
    queryKey: qk.endpoint(orgId, endpointId),
    queryFn: () =>
      unwrap(
        api.GET('/api/v1/orgs/{orgId}/endpoints/{endpointId}', {
          params: { path: { orgId, endpointId } },
        }),
      ),
    refetchInterval: (q) =>
      q.state.data?.inProgressRevision ||
      (q.state.data?.stableRevision && q.state.data.stableRevision.state !== 'READY')
        ? POLL_MS
        : // M8: a running canary is analysed every 15 s and may be aborted automatically.
          q.state.data?.canary
          ? CANARY_POLL_MS
          : false,
  });
}

export function useRevision(orgId: string, revisionId: string | undefined) {
  return useQuery({
    queryKey: qk.revision(orgId, revisionId ?? ''),
    enabled: !!revisionId,
    queryFn: () =>
      unwrap(
        api.GET('/api/v1/orgs/{orgId}/revisions/{revisionId}', {
          params: { path: { orgId, revisionId: revisionId ?? '' } },
        }),
      ),
    refetchInterval: (q) => (q.state.data && !isSettled(q.state.data.state) ? POLL_MS : false),
  });
}

export function useDeploy(orgId: string, endpointId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    /**
     * The Idempotency-Key is chosen once per dialog, not per click: a double click or a retry
     * after a network error replays the same request instead of deploying twice.
     */
    mutationFn: ({
      modelVersionId,
      key,
      strategy,
      canaryWeight,
    }: {
      modelVersionId: string;
      key: string;
      strategy?: 'IMMEDIATE' | 'CANARY';
      canaryWeight?: number;
    }) =>
      unwrap(
        api.POST('/api/v1/orgs/{orgId}/endpoints/{endpointId}/revisions', {
          params: { path: { orgId, endpointId }, header: { 'Idempotency-Key': key } },
          body: {
            modelVersionId,
            ...(strategy === 'CANARY' ? { strategy, canaryWeight } : {}),
          },
        }),
      ),
    meta: { silentError: true },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: qk.endpoint(orgId, endpointId) });
      // Project endpoint lists (any project) refetch too; the key prefix matches them all.
      await queryClient.invalidateQueries({ queryKey: ['orgs', orgId, 'projects'] });
    },
  });
}

export function useCancelRevision(orgId: string, endpointId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (revisionId: string) =>
      unwrap(
        api.POST('/api/v1/orgs/{orgId}/revisions/{revisionId}/cancel', {
          params: { path: { orgId, revisionId } },
        }),
      ),
    onSuccess: async (r) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.endpoint(orgId, endpointId) }),
        queryClient.invalidateQueries({ queryKey: qk.revision(orgId, r.id) }),
      ]);
    },
  });
}

/** Dashboard data; refreshed every 10 s (Prometheus scrapes the gateway every 5 s). */
export function useEndpointMetrics(orgId: string, endpointId: string, range: MetricsRange) {
  return useQuery({
    queryKey: qk.endpointMetrics(orgId, endpointId, range),
    queryFn: () =>
      unwrap(
        api.GET('/api/v1/orgs/{orgId}/endpoints/{endpointId}/metrics', {
          params: { path: { orgId, endpointId }, query: { range } },
        }),
      ),
    refetchInterval: 10_000,
    placeholderData: keepPreviousData,
    meta: { silentError: true },
  });
}
export const METRICS_RANGES = ['15m', '1h', '6h', '24h'] as const;
export type MetricsRange = (typeof METRICS_RANGES)[number];

export function usePlaygroundInfo(orgId: string, endpointId: string, revisionId: string | null) {
  return useQuery({
    // keyed by the serving revision: a new deploy brings new features/examples
    queryKey: [...qk.playground(orgId, endpointId), revisionId],
    queryFn: () =>
      unwrap(
        api.GET('/api/v1/orgs/{orgId}/endpoints/{endpointId}/playground', {
          params: { path: { orgId, endpointId } },
        }),
      ),
  });
}

export function usePlaygroundPredict(orgId: string, endpointId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (inputs: Record<string, number>[]) =>
      unwrap(
        api.POST('/api/v1/orgs/{orgId}/endpoints/{endpointId}/playground/predict', {
          params: { path: { orgId, endpointId } },
          body: { inputs },
        }),
      ),
    meta: { silentError: true },
    // the dashboard counts playground calls too
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ['orgs', orgId, 'endpoints', endpointId, 'metrics'],
      }),
  });
}

export function useOverview(orgId: string) {
  return useQuery({
    queryKey: qk.overview(orgId),
    queryFn: () =>
      unwrap(api.GET('/api/v1/orgs/{orgId}/overview', { params: { path: { orgId } } })),
    refetchInterval: 30_000,
  });
}

export function useApiKeys(orgId: string, projectId: string) {
  return useQuery({
    queryKey: qk.apiKeys(orgId, projectId),
    queryFn: () =>
      unwrap(
        api.GET('/api/v1/orgs/{orgId}/projects/{projectId}/api-keys', {
          params: { path: { orgId, projectId } },
        }),
      ),
  });
}

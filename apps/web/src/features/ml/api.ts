'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, unwrap } from '@/lib/api/client';
import { qk } from '@/lib/query/keys';

export function useExperiment(orgId: string, projectId: string) {
  return useQuery({
    queryKey: qk.experiment(orgId, projectId),
    queryFn: () =>
      unwrap(
        api.GET('/api/v1/orgs/{orgId}/projects/{projectId}/experiment', {
          params: { path: { orgId, projectId } },
        }),
      ),
    staleTime: 5 * 60_000,
  });
}

export function useRuns(orgId: string, projectId: string) {
  return useQuery({
    queryKey: qk.runs(orgId, projectId),
    queryFn: () =>
      unwrap(
        api.GET('/api/v1/orgs/{orgId}/projects/{projectId}/runs', {
          params: { path: { orgId, projectId }, query: { limit: 50 } },
        }),
      ),
  });
}

export function useModels(orgId: string, projectId: string) {
  return useQuery({
    queryKey: qk.models(orgId, projectId),
    queryFn: () =>
      unwrap(
        api.GET('/api/v1/orgs/{orgId}/projects/{projectId}/models', {
          params: { path: { orgId, projectId } },
        }),
      ),
  });
}

export function useModel(orgId: string, modelId: string) {
  return useQuery({
    queryKey: qk.model(orgId, modelId),
    queryFn: () =>
      unwrap(
        api.GET('/api/v1/orgs/{orgId}/models/{modelId}', { params: { path: { orgId, modelId } } }),
      ),
  });
}

/** Registers a run as the next version. Not optimistic: version numbers come from the server. */
export function useImportVersion(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ modelId, runId }: { modelId: string; runId: string; projectId: string }) =>
      unwrap(
        api.POST('/api/v1/orgs/{orgId}/models/{modelId}/versions/import', {
          params: { path: { orgId, modelId } },
          body: { runId },
        }),
      ),
    meta: { silentError: true },
    onSuccess: async (_v, { modelId, projectId }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.model(orgId, modelId) }),
        queryClient.invalidateQueries({ queryKey: qk.models(orgId, projectId) }),
        queryClient.invalidateQueries({ queryKey: qk.runs(orgId, projectId) }),
      ]);
    },
  });
}

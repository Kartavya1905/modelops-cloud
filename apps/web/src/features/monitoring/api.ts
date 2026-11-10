'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, unwrap } from '@/lib/api/client';

const key = {
  drift: (orgId: string, endpointId: string) => ['orgs', orgId, 'endpoints', endpointId, 'drift'],
  performance: (orgId: string, endpointId: string, range: string) => [
    'orgs',
    orgId,
    'endpoints',
    endpointId,
    'performance',
    range,
  ],
  evaluations: (orgId: string, modelId: string) => [
    'orgs',
    orgId,
    'models',
    modelId,
    'evaluations',
  ],
  datasets: (orgId: string, projectId: string) => [
    'orgs',
    orgId,
    'projects',
    projectId,
    'datasets',
  ],
};

export function useDriftReports(orgId: string, endpointId: string) {
  return useQuery({
    queryKey: key.drift(orgId, endpointId),
    queryFn: () =>
      unwrap(
        api.GET('/api/v1/orgs/{orgId}/endpoints/{endpointId}/drift-reports', {
          params: { path: { orgId, endpointId } },
        }),
      ),
  });
}

export function useRunDrift(orgId: string, endpointId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/api/v1/orgs/{orgId}/endpoints/{endpointId}/drift-reports', {
          params: { path: { orgId, endpointId } },
          body: {},
        }),
      ),
    meta: { silentError: true },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key.drift(orgId, endpointId) }),
  });
}

export const PERFORMANCE_RANGES = ['24h', '7d'] as const;
export type PerformanceRange = (typeof PERFORMANCE_RANGES)[number];

export function usePerformance(orgId: string, endpointId: string, range: PerformanceRange) {
  return useQuery({
    queryKey: key.performance(orgId, endpointId, range),
    queryFn: () =>
      unwrap(
        api.GET('/api/v1/orgs/{orgId}/endpoints/{endpointId}/performance', {
          params: { path: { orgId, endpointId }, query: { range } },
        }),
      ),
    refetchInterval: 30_000,
  });
}

/** Toggles input capture with the endpoint's ETag (If-Match), so concurrent edits can't clobber. */
export function useSetCapture(orgId: string, endpointId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      captureInputs,
      rowVersion,
    }: {
      captureInputs: boolean;
      rowVersion: number;
    }) =>
      unwrap(
        api.PATCH('/api/v1/orgs/{orgId}/endpoints/{endpointId}', {
          params: {
            path: { orgId, endpointId },
            header: { 'If-Match': `W/"${String(rowVersion)}"` },
          },
          body: { captureInputs },
        }),
      ),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ['orgs', orgId, 'endpoints', endpointId] }),
  });
}

export function useEvaluations(orgId: string, modelId: string) {
  return useQuery({
    queryKey: key.evaluations(orgId, modelId),
    queryFn: () =>
      unwrap(
        api.GET('/api/v1/orgs/{orgId}/models/{modelId}/evaluations', {
          params: { path: { orgId, modelId } },
        }),
      ),
  });
}

export function useRunEvaluation(orgId: string, modelId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { candidateVersionId: string; datasetVersionId: string }) =>
      unwrap(
        api.POST('/api/v1/orgs/{orgId}/models/{modelId}/evaluations', {
          params: { path: { orgId, modelId } },
          body,
        }),
      ),
    meta: { silentError: true },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key.evaluations(orgId, modelId) }),
  });
}

export function useSetChampion(orgId: string, modelId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (evaluationId: string) =>
      unwrap(
        api.POST('/api/v1/orgs/{orgId}/models/{modelId}/champion', {
          params: { path: { orgId, modelId } },
          body: { evaluationId },
        }),
      ),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: key.evaluations(orgId, modelId) }),
        queryClient.invalidateQueries({ queryKey: ['orgs', orgId, 'models', modelId] }),
      ]);
    },
  });
}

export function useDatasets(orgId: string, projectId: string) {
  return useQuery({
    queryKey: key.datasets(orgId, projectId),
    queryFn: () =>
      unwrap(
        api.GET('/api/v1/orgs/{orgId}/projects/{projectId}/datasets', {
          params: { path: { orgId, projectId } },
        }),
      ),
  });
}

export function useUploadDataset(orgId: string, projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ file, name, version }: { file: File; name: string; version: string }) => {
      const form = new FormData();
      form.set('name', name);
      form.set('version', version);
      form.set('file', file);
      return unwrap(
        api.POST('/api/v1/orgs/{orgId}/projects/{projectId}/datasets', {
          params: { path: { orgId, projectId } },
          body: form as never,
          bodySerializer: (b: unknown) => b as FormData,
        }),
      );
    },
    meta: { silentError: true },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key.datasets(orgId, projectId) }),
  });
}

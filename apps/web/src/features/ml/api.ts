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

/** Validation is asynchronous: while it runs, views poll until the status settles. */
export const POLL_MS = 2000;
const IN_PROGRESS = new Set(['PENDING_VALIDATION', 'VALIDATING']);
export const isInProgress = (status: string) => IN_PROGRESS.has(status);

export function useModel(orgId: string, modelId: string) {
  return useQuery({
    queryKey: qk.model(orgId, modelId),
    queryFn: () =>
      unwrap(
        api.GET('/api/v1/orgs/{orgId}/models/{modelId}', { params: { path: { orgId, modelId } } }),
      ),
    refetchInterval: (q) =>
      q.state.data?.versions.some((v) => isInProgress(v.status)) ? POLL_MS : false,
  });
}

export function useModelVersion(orgId: string, versionId: string) {
  return useQuery({
    queryKey: qk.modelVersion(orgId, versionId),
    queryFn: () =>
      unwrap(
        api.GET('/api/v1/orgs/{orgId}/model-versions/{versionId}', {
          params: { path: { orgId, versionId } },
        }),
      ),
    refetchInterval: (q) => (q.state.data && isInProgress(q.state.data.status) ? POLL_MS : false),
  });
}

/** Re-queues a validation whose last attempt could not run (result ERROR). */
export function useRerunValidation(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ versionId }: { versionId: string; modelId: string }) =>
      unwrap(
        api.POST('/api/v1/orgs/{orgId}/model-versions/{versionId}/validation/rerun', {
          params: { path: { orgId, versionId } },
        }),
      ),
    onSuccess: async (_h, { versionId, modelId }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.modelVersion(orgId, versionId) }),
        queryClient.invalidateQueries({ queryKey: qk.model(orgId, modelId) }),
      ]);
    },
  });
}

export interface BundleFiles {
  framework: 'SKLEARN_ONNX' | 'PYTORCH_ONNX';
  model: File;
  signature: File;
  golden: File;
  /** M7: the dataset version it was trained on (drift reference) */
  trainingDatasetVersionId?: string;
}

/** Uploads a bundle (multipart) as the next version of a model. */
export function useUploadVersion(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      modelId,
      files,
    }: {
      modelId: string;
      projectId: string;
      files: BundleFiles;
    }) => {
      const form = new FormData();
      form.set('framework', files.framework);
      form.set('model', files.model);
      form.set('signature', files.signature);
      form.set('golden', files.golden);
      if (files.trainingDatasetVersionId) {
        form.set('trainingDatasetVersionId', files.trainingDatasetVersionId);
      }
      return unwrap(
        api.POST('/api/v1/orgs/{orgId}/models/{modelId}/versions/upload', {
          params: { path: { orgId, modelId } },
          // The generated type describes the parts; the browser sends the FormData as-is.
          body: form as never,
          bodySerializer: (b: unknown) => b as FormData,
        }),
      );
    },
    meta: { silentError: true },
    onSuccess: async (_v, { modelId, projectId }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.model(orgId, modelId) }),
        queryClient.invalidateQueries({ queryKey: qk.models(orgId, projectId) }),
      ]);
    },
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

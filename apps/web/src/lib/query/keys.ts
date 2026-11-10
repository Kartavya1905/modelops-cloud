/**
 * Query-key factory: one place that defines the cache shape, so invalidation is precise
 * (e.g. creating a project invalidates exactly `projects(orgId)` and nothing else).
 */
export const qk = {
  session: ['session'] as const,
  orgs: ['orgs'] as const,
  org: (orgId: string) => ['orgs', orgId] as const,
  projects: (orgId: string) => ['orgs', orgId, 'projects'] as const,
  projectList: (orgId: string, includeArchived: boolean) =>
    ['orgs', orgId, 'projects', 'list', { includeArchived }] as const,
  project: (orgId: string, projectId: string) => ['orgs', orgId, 'projects', projectId] as const,
  members: (orgId: string) => ['orgs', orgId, 'members'] as const,
  invitations: (orgId: string) => ['orgs', orgId, 'invitations'] as const,
  audit: (orgId: string, action: string) => ['orgs', orgId, 'audit', { action }] as const,
  invitation: (token: string) => ['invitation', token] as const,
  // M3
  experiment: (orgId: string, projectId: string) =>
    ['orgs', orgId, 'projects', projectId, 'experiment'] as const,
  runs: (orgId: string, projectId: string) =>
    ['orgs', orgId, 'projects', projectId, 'runs'] as const,
  compare: (orgId: string, projectId: string, ids: string[]) =>
    ['orgs', orgId, 'projects', projectId, 'runs', 'compare', ids] as const,
  models: (orgId: string, projectId: string) =>
    ['orgs', orgId, 'projects', projectId, 'models'] as const,
  model: (orgId: string, modelId: string) => ['orgs', orgId, 'models', modelId] as const,
  modelVersion: (orgId: string, versionId: string) =>
    ['orgs', orgId, 'model-versions', versionId] as const,
  // M5
  endpoints: (orgId: string, projectId: string) =>
    ['orgs', orgId, 'projects', projectId, 'endpoints'] as const,
  endpoint: (orgId: string, endpointId: string) =>
    ['orgs', orgId, 'endpoints', endpointId] as const,
  revision: (orgId: string, revisionId: string) =>
    ['orgs', orgId, 'revisions', revisionId] as const,
  apiKeys: (orgId: string, projectId: string) =>
    ['orgs', orgId, 'projects', projectId, 'api-keys'] as const,
  // M6
  endpointMetrics: (orgId: string, endpointId: string, range: string) =>
    ['orgs', orgId, 'endpoints', endpointId, 'metrics', range] as const,
  playground: (orgId: string, endpointId: string) =>
    ['orgs', orgId, 'endpoints', endpointId, 'playground'] as const,
  overview: (orgId: string) => ['orgs', orgId, 'overview'] as const,
};

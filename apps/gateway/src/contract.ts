/**
 * Control plane -> data plane contract. Mirrors apps/api/src/modules/deployments/dataplane.ts
 * (the API publishes, the gateway reads). Integration tests exercise both sides together.
 */
export const DP = {
  routingKey: 'mo:routing:snapshot',
  routingChannel: 'mo:routing:changed',
  /** M7: prediction + feedback events, consumed by the worker */
  eventsStream: 'mo:events',
  apiKeyPrefix: 'mo:apikey:',
  apiKeyChannel: 'mo:apikeys:changed',
} as const;

export interface RoutedRevision {
  id: string;
  url: string;
  modelVersionId: string;
  modelName: string;
  modelVersion: number;
  framework: string;
  features: string[];
  classes: (number | string)[];
}

export interface RoutedEndpoint {
  endpointId: string;
  orgId: string;
  projectId: string;
  slug: string;
  rateLimitRps: number;
  /** M7: also record request inputs (opt-in) for drift detection */
  captureInputs: boolean;
  revision: RoutedRevision | null;
  /** M8: a READY canary taking `weight` percent (1-50) of requests; null when there is none. */
  canary: { revision: RoutedRevision; weight: number } | null;
}

export interface RoutingSnapshot {
  hash: string;
  generatedAt: string;
  endpoints: Record<string, RoutedEndpoint>;
}

export interface ApiKeyEntry {
  id: string;
  orgId: string;
  projectId: string;
  hash: string;
  scopes: string[];
  expiresAt: string | null;
  revoked: boolean;
}

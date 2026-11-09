/**
 * Control plane -> data plane contract. Mirrors apps/api/src/modules/deployments/dataplane.ts
 * (the API publishes, the gateway reads). Integration tests exercise both sides together.
 */
export const DP = {
  routingKey: 'mo:routing:snapshot',
  routingChannel: 'mo:routing:changed',
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
  revision: RoutedRevision | null;
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

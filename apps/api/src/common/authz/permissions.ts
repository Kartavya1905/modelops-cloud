import type { Role } from '../../generated/prisma/client';

/**
 * THE source of truth for "who may do what" inside an organization (docs/06-security.md, section 3).
 * Every org-scoped route declares exactly one permission with @RequirePermission; routes without
 * one are rejected by OrgAccessGuard (deny by default). The integration test suite generates its
 * role-by-route expectations from this table, so code, tests and docs cannot drift apart.
 *
 * Milestone 2 contains the identity/tenancy/project permissions; later milestones add
 * model, deployment and approval permissions here.
 */
const ALL = ['OWNER', 'ADMIN', 'ML_ENGINEER', 'VIEWER'] as const satisfies readonly Role[];
const WRITERS = ['OWNER', 'ADMIN', 'ML_ENGINEER'] as const satisfies readonly Role[];
const ADMINS = ['OWNER', 'ADMIN'] as const satisfies readonly Role[];

export const PERMISSIONS = {
  'org:read': ALL,
  'member:read': ALL,
  'member:manage': ADMINS,
  'invitation:create': ADMINS,
  'project:read': ALL,
  'project:create': WRITERS,
  'project:update': WRITERS,
  'project:archive': ADMINS,
  'audit:read': ADMINS,
  // M3: experiments (read-only mirror of MLflow) and the model registry
  'experiment:read': ALL,
  'model:read': ALL,
  'model:create': WRITERS,
  'model:register': WRITERS,
  // M5: endpoints, deployments (revisions) and inference API keys
  'endpoint:read': ALL,
  'endpoint:create': WRITERS,
  'deployment:create': WRITERS,
  'deployment:cancel': WRITERS,
  'apikey:read': ADMINS,
  'apikey:manage': ADMINS,
  // M7: monitoring (drift, performance), evaluation gates, champion alias
  'monitoring:read': ALL,
  'monitoring:run': WRITERS,
  'endpoint:update': WRITERS,
  'dataset:create': WRITERS,
  'evaluation:run': WRITERS,
  'model:promote': ADMINS,
  // M8: releases (staging: writers; production: the services also require Owner/Admin)
  'release:manage': WRITERS,
  'approval:read': ALL,
  'approval:decide': ADMINS,
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export function can(role: Role, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly Role[]).includes(role);
}

/** Sent to the web app in /auth/me so the UI can hide controls (enforcement stays server-side). */
export function permissionsFor(role: Role): Permission[] {
  return ALL_PERMISSIONS.filter((p) => can(role, p));
}

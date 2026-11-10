import { GUARDS_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { OrgAccessGuard, PERMISSION_KEY } from '../../src/common/authz/org-access.guard';
import { can, PERMISSIONS, permissionsFor } from '../../src/common/authz/permissions';
import { AuditController } from '../../src/modules/audit/audit.controller';
import { ExperimentsController } from '../../src/modules/experiments/experiments.controller';
import {
  MembersController,
  OrganizationsController,
  OrgInvitationsController,
} from '../../src/modules/organizations/organizations.controller';
import { ProjectsController } from '../../src/modules/projects/projects.controller';
import { RegistryController } from '../../src/modules/registry/registry.controller';
import { ValidationController } from '../../src/modules/validation/validation.controller';
import { EndpointsController } from '../../src/modules/deployments/endpoints.controller';
import { ApiKeysController } from '../../src/modules/api-keys/api-keys.controller';
import { PlaygroundController } from '../../src/modules/deployments/playground';
import { MetricsController } from '../../src/modules/metrics/metrics.controller';

describe('permission table', () => {
  it('Owner holds every permission; Viewer holds only read permissions', () => {
    expect(permissionsFor('OWNER')).toEqual(Object.keys(PERMISSIONS));
    expect(permissionsFor('VIEWER').every((p) => p.endsWith(':read'))).toBe(true);
  });

  it('roles are strictly nested: anything a lower role can do, every higher role can do', () => {
    const order = ['VIEWER', 'ML_ENGINEER', 'ADMIN', 'OWNER'] as const;
    for (let i = 0; i < order.length - 1; i++) {
      const lower = order[i];
      const higher = order[i + 1];
      if (!lower || !higher) continue;
      for (const p of permissionsFor(lower))
        expect(can(higher, p), `${higher} ⊇ ${lower}: ${p}`).toBe(true);
    }
  });

  it('only Owners and Admins can read the audit log or manage members', () => {
    expect(PERMISSIONS['audit:read']).toEqual(['OWNER', 'ADMIN']);
    expect(PERMISSIONS['member:manage']).toEqual(['OWNER', 'ADMIN']);
  });
});

/**
 * Deny by default, checked statically: every handler guarded by OrgAccessGuard must declare a
 * permission. (At runtime the guard would also refuse it, but this catches it before any request.)
 */
describe('every org-scoped route declares a permission', () => {
  const controllers = [
    OrganizationsController,
    MembersController,
    OrgInvitationsController,
    ProjectsController,
    AuditController,
    ExperimentsController,
    RegistryController,
    ValidationController,
    EndpointsController,
    ApiKeysController,
    PlaygroundController,
    MetricsController,
  ];

  const guarded = (target: object): boolean => {
    const guards = (Reflect.getMetadata(GUARDS_METADATA, target) ?? []) as unknown[];
    return guards.includes(OrgAccessGuard);
  };

  for (const controller of controllers) {
    const proto = controller.prototype as unknown as Record<string, unknown>;
    const handlers = Object.getOwnPropertyNames(proto).filter(
      (k) => k !== 'constructor' && typeof proto[k] === 'function',
    );
    for (const name of handlers) {
      const handler = proto[name] as object;
      if (!guarded(controller) && !guarded(handler)) continue;
      it(`${controller.name}.${name}`, () => {
        expect(Reflect.getMetadata(PERMISSION_KEY, handler)).toBeDefined();
      });
    }
  }
});

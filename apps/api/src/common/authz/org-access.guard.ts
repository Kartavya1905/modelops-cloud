import { type CanActivate, type ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { Errors } from '../errors/app-error';
import { PrismaService } from '../prisma/prisma.service';
import { isUuid } from '../validation';
import { can, type Permission } from './permissions';

export const PERMISSION_KEY = 'modelops:permission';

/** Declares the single permission an org-scoped route requires. */
export const RequirePermission = (permission: Permission) =>
  SetMetadata(PERMISSION_KEY, permission);

/**
 * Tenant isolation + RBAC for every `/orgs/:orgId/...` route:
 *  1. `:orgId` must be a UUID of an organization the caller belongs to, otherwise **404**
 *     (never 403, so callers cannot discover which organization ids exist).
 *  2. The route must declare a permission (deny by default), and the caller's role must grant it,
 *     otherwise **403 FORBIDDEN_ROLE**.
 * On success the membership is attached to the request for services to use.
 */
@Injectable()
export class OrgAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    if (!req.auth) throw Errors.unauthenticated();

    const orgId = req.params.orgId;
    if (!isUuid(orgId)) throw Errors.notFound('Organization');

    const membership = await this.prisma.membership.findUnique({
      where: { orgId_userId: { orgId, userId: req.auth.user.id } },
      select: { role: true },
    });
    if (!membership) throw Errors.notFound('Organization');

    const permission = this.reflector.getAllAndOverride<Permission | undefined>(PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!permission) {
      throw Errors.forbidden(
        'PERMISSION_NOT_DECLARED',
        'This route does not declare a permission.',
      );
    }
    if (!can(membership.role, permission)) throw Errors.forbiddenRole(permission);

    req.membership = { orgId, role: membership.role };
    return true;
  }
}

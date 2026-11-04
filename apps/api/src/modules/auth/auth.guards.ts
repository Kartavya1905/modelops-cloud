import { type CanActivate, type ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { safeEqual } from '../../common/crypto';
import { Errors } from '../../common/errors/app-error';
import { SESSION_COOKIE, SessionService } from './session.service';

const IS_PUBLIC = 'modelops:public';

/** Marks a route as reachable without a session (register, login, health). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

function isPublic(reflector: Reflector, ctx: ExecutionContext): boolean {
  return (
    reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, [
      ctx.getHandler(),
      ctx.getClass(),
    ]) === true
  );
}

/**
 * Global guard #1: every route requires a valid session unless it is @Public().
 * A valid cookie is still read on public routes, so e.g. /auth/me-like behaviour can be optional.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const cookies = req.cookies as Record<string, unknown> | undefined;
    const token = cookies?.[SESSION_COOKIE];
    if (typeof token === 'string' && token.length > 0) {
      const auth = await this.sessions.validate(token);
      if (auth) req.auth = auth;
    }
    if (isPublic(this.reflector, ctx)) return true;
    if (!req.auth) throw Errors.unauthenticated();
    return true;
  }
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Global guard #2: state-changing requests made with a session cookie must carry the
 * session's CSRF token in `X-CSRF-Token`. A cross-site form or fetch cannot read that token,
 * so it cannot forge the header (SameSite=Lax is the second layer). docs/06, SEC-12.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (!UNSAFE_METHODS.has(req.method) || isPublic(this.reflector, ctx) || !req.auth) return true;
    const header = req.header('x-csrf-token');
    if (!header || !safeEqual(header, req.auth.csrfToken)) throw Errors.csrf();
    return true;
  }
}

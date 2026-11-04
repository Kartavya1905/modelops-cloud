import { randomUUID } from 'node:crypto';
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import type { Role } from '../../generated/prisma/client';

/** The signed-in user, attached by SessionGuard. */
export interface AuthContext {
  sessionId: string;
  csrfToken: string;
  user: { id: string; email: string; name: string };
}

/** The caller's membership in the organization named in the route, attached by OrgAccessGuard. */
export interface MembershipContext {
  orgId: string;
  role: Role;
}

// Express merges the global `Express.Request` interface into every request type.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId?: string;
      auth?: AuthContext;
      membership?: MembershipContext;
    }
  }
}

const REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

/**
 * Accepts a well-formed incoming `X-Request-Id` (so traces can span services) or generates one,
 * and echoes it on every response. The same id is stored on audit events and in error bodies.
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  req.requestId = incoming && REQUEST_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  next();
}

/** Who did something, and from which request, for audit records. */
export interface ActorContext {
  userId: string;
  requestId: string | undefined;
  ip: string | undefined;
}

export const Actor = createParamDecorator((_: unknown, ctx: ExecutionContext): ActorContext => {
  const req = ctx.switchToHttp().getRequest<Request>();
  if (!req.auth) throw new Error('@Actor() used on a route without an authenticated session');
  return { userId: req.auth.user.id, requestId: req.requestId, ip: req.ip };
});

export const CurrentAuth = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest<Request>();
  if (!req.auth) throw new Error('@CurrentAuth() used on a route without an authenticated session');
  return req.auth;
});

export const CurrentMembership = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest<Request>();
  if (!req.membership) throw new Error('@CurrentMembership() requires OrgAccessGuard');
  return req.membership;
});

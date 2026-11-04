import { Injectable } from '@nestjs/common';
import { permissionsFor } from '../../common/authz/permissions';
import { Errors } from '../../common/errors/app-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RateLimiterService } from '../../common/rate-limit/rate-limiter.service';
import { uniqueSlug } from '../../common/slug';
import { Prisma } from '../../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import type { LoginDto, RegisterDto, SessionDto } from './auth.dto';
import { PasswordService } from './password.service';
import { SessionService } from './session.service';

export interface RequestMeta {
  requestId: string | undefined;
  ip: string | undefined;
  userAgent: string | undefined;
}

export const LOGIN_FAILURE_LIMIT = 5;
export const LOGIN_WINDOW_SECONDS = 60;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly limiter: RateLimiterService,
  ) {}

  /**
   * Creates the user, a personal organization they own, and a session, in one transaction.
   * Note: answering 409 for a taken email reveals that the account exists. This is an accepted,
   * common trade-off for sign-up UX; login itself never reveals whether an email is registered.
   */
  async register(dto: RegisterDto, meta: RequestMeta) {
    const passwordHash = await this.passwords.hash(dto.password);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: { email: dto.email, name: dto.name, passwordHash },
          select: { id: true, email: true, name: true },
        });
        const orgName = `${dto.name.split(' ')[0] ?? dto.name}'s workspace`;
        const org = await tx.organization.create({
          data: {
            name: orgName,
            slug: uniqueSlug(orgName),
            memberships: { create: { userId: user.id, role: 'OWNER' } },
          },
          select: { id: true },
        });
        const actor = { userId: user.id, requestId: meta.requestId, ip: meta.ip };
        await this.audit.record(tx, actor, {
          orgId: null,
          action: 'user.registered',
          targetType: 'user',
          targetId: user.id,
        });
        await this.audit.record(tx, actor, {
          orgId: org.id,
          action: 'organization.created',
          targetType: 'organization',
          targetId: org.id,
        });
        const session = await this.sessions.create(tx, user.id, {
          ipHash: this.audit.hashIp(meta.ip),
          userAgent: meta.userAgent,
        });
        return { session, userId: user.id };
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw Errors.conflict('EMAIL_TAKEN', 'An account with this email already exists.');
      }
      throw err;
    }
  }

  /**
   * Same response and similar timing for "unknown email" and "wrong password".
   * Failed attempts are counted per (IP, email) and blocked after 5 per minute.
   */
  async login(dto: LoginDto, meta: RequestMeta) {
    // Keyed hash: neither the email nor the IP is readable from Redis.
    const limitKey = `rl:login:${this.audit.hashIp(`${meta.ip ?? '-'}|${dto.email}`) ?? '-'}`;
    const state = await this.limiter.check(limitKey, LOGIN_FAILURE_LIMIT);
    if (state.blocked) throw Errors.rateLimited(state.retryAfterSeconds);

    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      select: { id: true, passwordHash: true },
    });
    const ok = await this.passwords.verify(user?.passwordHash ?? null, dto.password);

    if (!user || !ok) {
      await this.limiter.recordFailure(limitKey, LOGIN_WINDOW_SECONDS);
      await this.prisma.$transaction((tx) =>
        this.audit.record(
          tx,
          { userId: user?.id ?? null, requestId: meta.requestId, ip: meta.ip },
          {
            orgId: null,
            action: 'auth.login_failed',
            metadata: { reason: user ? 'bad_password' : 'unknown_email' },
          },
        ),
      );
      throw Errors.invalidCredentials();
    }

    await this.limiter.reset(limitKey);
    return this.prisma.$transaction(async (tx) => {
      const session = await this.sessions.create(tx, user.id, {
        ipHash: this.audit.hashIp(meta.ip),
        userAgent: meta.userAgent,
      });
      await this.audit.record(
        tx,
        { userId: user.id, requestId: meta.requestId, ip: meta.ip },
        {
          orgId: null,
          action: 'auth.login_succeeded',
          targetType: 'session',
          targetId: session.sessionId,
        },
      );
      return { session, userId: user.id };
    });
  }

  async logout(sessionId: string, userId: string, meta: RequestMeta): Promise<void> {
    await this.sessions.revoke(sessionId);
    await this.prisma.$transaction((tx) =>
      this.audit.record(
        tx,
        { userId, requestId: meta.requestId, ip: meta.ip },
        { orgId: null, action: 'auth.logout', targetType: 'session', targetId: sessionId },
      ),
    );
  }

  async describeSession(userId: string, csrfToken: string): Promise<SessionDto> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        memberships: {
          select: { role: true, org: { select: { id: true, name: true, slug: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    return {
      user: { id: user.id, email: user.email, name: user.name },
      memberships: user.memberships.map((m) => ({
        orgId: m.org.id,
        orgName: m.org.name,
        orgSlug: m.org.slug,
        role: m.role,
        permissions: permissionsFor(m.role),
      })),
      csrfToken,
    };
  }
}

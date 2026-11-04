import { Inject, Injectable } from '@nestjs/common';
import type { CookieOptions, Response } from 'express';
import { hmacBase64Url, randomToken, sha256Bytes } from '../../common/crypto';
import type { Tx } from '../../common/prisma/prisma.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthContext } from '../../common/request-context/request-context';
import { APP_CONFIG, type AppConfig } from '../../config/config';

export const SESSION_COOKIE = 'mo_session';
const DAY_MS = 24 * 60 * 60 * 1000;
export const SLIDING_TTL_MS = 7 * DAY_MS;
export const ABSOLUTE_TTL_MS = 30 * DAY_MS;
/** Extend the sliding expiry at most this often, to avoid a DB write on every request. */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Server-side sessions (ADR-0006).
 *  - The browser holds a 256-bit random token in an HttpOnly, SameSite=Lax cookie.
 *  - The database stores only SHA-256(token), so a leaked database cannot be used to log in.
 *  - The CSRF token is derived as HMAC(pepper, sessionId): nothing extra to store, and it
 *    changes whenever the session does.
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  csrfTokenFor(sessionId: string): string {
    return hmacBase64Url(this.config.sessionPepper, `csrf:${sessionId}`);
  }

  async create(
    tx: Tx,
    userId: string,
    meta: { ipHash: string | null; userAgent: string | undefined },
  ): Promise<{ token: string; sessionId: string; csrfToken: string }> {
    const token = randomToken(32);
    const now = Date.now();
    const session = await tx.session.create({
      data: {
        userId,
        tokenHash: sha256Bytes(token),
        expiresAt: new Date(now + SLIDING_TTL_MS),
        absoluteExpiresAt: new Date(now + ABSOLUTE_TTL_MS),
        ipHash: meta.ipHash,
        userAgent: meta.userAgent?.slice(0, 256) ?? null,
      },
      select: { id: true },
    });
    return { token, sessionId: session.id, csrfToken: this.csrfTokenFor(session.id) };
  }

  /** Returns the auth context for a valid, unexpired, unrevoked session token, else null. */
  async validate(token: string): Promise<AuthContext | null> {
    if (token.length < 20 || token.length > 100) return null;
    const now = new Date();
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: sha256Bytes(token) },
      include: { user: { select: { id: true, email: true, name: true } } },
    });
    if (
      !session ||
      session.revokedAt !== null ||
      session.expiresAt <= now ||
      session.absoluteExpiresAt <= now
    ) {
      return null;
    }

    if (now.getTime() - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      const sliding = new Date(
        Math.min(now.getTime() + SLIDING_TTL_MS, session.absoluteExpiresAt.getTime()),
      );
      await this.prisma.session.update({
        where: { id: session.id },
        data: { lastSeenAt: now, expiresAt: sliding },
      });
    }

    return {
      sessionId: session.id,
      csrfToken: this.csrfTokenFor(session.id),
      user: session.user,
    };
  }

  async revoke(sessionId: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private cookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.config.cookieSecure,
      path: '/',
    };
  }

  setCookie(res: Response, token: string): void {
    res.cookie(SESSION_COOKIE, token, { ...this.cookieOptions(), maxAge: ABSOLUTE_TTL_MS });
  }

  clearCookie(res: Response): void {
    res.clearCookie(SESSION_COOKIE, this.cookieOptions());
  }
}

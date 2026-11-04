import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { RateLimiterService } from '../../common/rate-limit/rate-limiter.service';
import { AuthController } from './auth.controller';
import { CsrfGuard, SessionGuard } from './auth.guards';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { SessionService } from './session.service';

/**
 * Registers SessionGuard and CsrfGuard as global guards (they run, in this order, before every
 * route). Routes opt out of authentication with @Public().
 */
@Global()
@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    SessionService,
    RateLimiterService,
    { provide: APP_GUARD, useClass: SessionGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
  ],
  exports: [SessionService, PasswordService],
})
export class AuthModule {}

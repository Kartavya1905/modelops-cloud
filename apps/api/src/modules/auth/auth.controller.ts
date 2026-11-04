import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { CurrentAuth, type AuthContext } from '../../common/request-context/request-context';
import { LoginDto, RegisterDto, SessionDto } from './auth.dto';
import { Public } from './auth.guards';
import { AuthService, type RequestMeta } from './auth.service';
import { SessionService } from './session.service';

function metaOf(req: Request): RequestMeta {
  return { requestId: req.requestId, ip: req.ip, userAgent: req.header('user-agent') };
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
  ) {}

  @Public()
  @Post('register')
  @ApiCreatedResponse({ type: SessionDto, description: 'Sets the `mo_session` cookie.' })
  async register(
    @Body() dto: RegisterDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionDto> {
    const { session, userId } = await this.auth.register(dto, metaOf(req));
    this.sessions.setCookie(res, session.token);
    return this.auth.describeSession(userId, session.csrfToken);
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: SessionDto, description: 'Sets the `mo_session` cookie.' })
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionDto> {
    const { session, userId } = await this.auth.login(dto, metaOf(req));
    this.sessions.setCookie(res, session.token);
    return this.auth.describeSession(userId, session.csrfToken);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiCookieAuth('session')
  @ApiNoContentResponse({ description: 'Session revoked and cookie cleared.' })
  async logout(
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.logout(auth.sessionId, auth.user.id, metaOf(req));
    this.sessions.clearCookie(res);
  }

  @Get('me')
  @ApiCookieAuth('session')
  @ApiOkResponse({ type: SessionDto })
  me(@CurrentAuth() auth: AuthContext): Promise<SessionDto> {
    return this.auth.describeSession(auth.user.id, auth.csrfToken);
  }
}

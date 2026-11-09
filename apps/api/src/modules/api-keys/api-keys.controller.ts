import { Body, Controller, Delete, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { OrgAccessGuard, RequirePermission } from '../../common/authz/org-access.guard';
import { Actor, type ActorContext } from '../../common/request-context/request-context';
import { UuidParam } from '../../common/validation';
import { ApiKeyDto, ApiKeysService, CreateApiKeyDto, CreatedApiKeyDto } from './api-keys.service';

const OrgId = () => Param('orgId', new UuidParam('Organization'));

@ApiTags('api-keys')
@ApiCookieAuth('session')
@UseGuards(OrgAccessGuard)
@Controller('orgs/:orgId')
export class ApiKeysController {
  constructor(private readonly keys: ApiKeysService) {}

  @Get('projects/:projectId/api-keys')
  @RequirePermission('apikey:read')
  @ApiOkResponse({ type: [ApiKeyDto], description: 'Prefixes only; secrets are never returned' })
  list(@OrgId() orgId: string, @Param('projectId', new UuidParam('Project')) projectId: string) {
    return this.keys.list(orgId, projectId);
  }

  @Post('projects/:projectId/api-keys')
  @RequirePermission('apikey:manage')
  @ApiCreatedResponse({ type: CreatedApiKeyDto })
  create(
    @OrgId() orgId: string,
    @Param('projectId', new UuidParam('Project')) projectId: string,
    @Body() dto: CreateApiKeyDto,
    @Actor() actor: ActorContext,
  ) {
    return this.keys.create(orgId, projectId, dto, actor);
  }

  @Delete('api-keys/:keyId')
  @HttpCode(204)
  @RequirePermission('apikey:manage')
  @ApiNoContentResponse({ description: 'Revoked; the gateway stops accepting it within seconds' })
  revoke(
    @OrgId() orgId: string,
    @Param('keyId', new UuidParam('API key')) keyId: string,
    @Actor() actor: ActorContext,
  ) {
    return this.keys.revoke(orgId, keyId, actor);
  }
}

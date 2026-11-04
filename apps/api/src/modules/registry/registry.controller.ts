import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { OrgAccessGuard, RequirePermission } from '../../common/authz/org-access.guard';
import { Actor, type ActorContext } from '../../common/request-context/request-context';
import { UuidParam } from '../../common/validation';
import {
  CreateModelDto,
  DatasetVersionDto,
  ImportVersionDto,
  ModelDetailDto,
  ModelDto,
  ModelVersionDto,
} from './registry.dto';
import { RegistryService } from './registry.service';

const OrgId = () => Param('orgId', new UuidParam('Organization'));

@ApiTags('registry')
@ApiCookieAuth('session')
@UseGuards(OrgAccessGuard)
@Controller('orgs/:orgId')
export class RegistryController {
  constructor(private readonly registry: RegistryService) {}

  @Get('projects/:projectId/models')
  @RequirePermission('model:read')
  @ApiOkResponse({ type: [ModelDto] })
  listModels(
    @OrgId() orgId: string,
    @Param('projectId', new UuidParam('Project')) projectId: string,
  ) {
    return this.registry.listModels(orgId, projectId);
  }

  @Post('projects/:projectId/models')
  @RequirePermission('model:create')
  @ApiCreatedResponse({ type: ModelDto, description: 'Also created in the MLflow Model Registry.' })
  createModel(
    @OrgId() orgId: string,
    @Param('projectId', new UuidParam('Project')) projectId: string,
    @Body() dto: CreateModelDto,
    @Actor() actor: ActorContext,
  ) {
    return this.registry.createModel(orgId, projectId, dto, actor);
  }

  @Get('projects/:projectId/datasets')
  @RequirePermission('model:read')
  @ApiOkResponse({ type: [DatasetVersionDto] })
  datasets(
    @OrgId() orgId: string,
    @Param('projectId', new UuidParam('Project')) projectId: string,
  ) {
    return this.registry.listDatasets(orgId, projectId);
  }

  @Get('models/:modelId')
  @RequirePermission('model:read')
  @ApiOkResponse({ type: ModelDetailDto })
  getModel(@OrgId() orgId: string, @Param('modelId', new UuidParam('Model')) modelId: string) {
    return this.registry.getModel(orgId, modelId);
  }

  @Post('models/:modelId/versions/import')
  @RequirePermission('model:register')
  @ApiCreatedResponse({
    type: ModelVersionDto,
    description:
      'Registers a finished MLflow run of this project as the next version (PENDING_VALIDATION).',
  })
  importVersion(
    @OrgId() orgId: string,
    @Param('modelId', new UuidParam('Model')) modelId: string,
    @Body() dto: ImportVersionDto,
    @Actor() actor: ActorContext,
  ) {
    return this.registry.importVersion(orgId, modelId, dto.runId, actor);
  }

  @Get('model-versions/:versionId')
  @RequirePermission('model:read')
  @ApiOkResponse({ type: ModelVersionDto })
  getVersion(
    @OrgId() orgId: string,
    @Param('versionId', new UuidParam('Model version')) versionId: string,
  ) {
    return this.registry.getVersion(orgId, versionId);
  }
}

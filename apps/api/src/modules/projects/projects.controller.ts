import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { OrgAccessGuard, RequirePermission } from '../../common/authz/org-access.guard';
import { Actor, type ActorContext } from '../../common/request-context/request-context';
import { UuidParam } from '../../common/validation';
import {
  CreateProjectDto,
  ListProjectsQuery,
  ProjectDto,
  ProjectPageDto,
  UpdateProjectDto,
} from './projects.dto';
import { ProjectsService } from './projects.service';

const OrgId = () => Param('orgId', new UuidParam('Organization'));
const ProjectId = () => Param('projectId', new UuidParam('Project'));

@ApiTags('projects')
@ApiCookieAuth('session')
@UseGuards(OrgAccessGuard)
@Controller('orgs/:orgId/projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  @RequirePermission('project:read')
  @ApiOkResponse({ type: ProjectPageDto })
  list(@OrgId() orgId: string, @Query() q: ListProjectsQuery) {
    return this.projects.list(orgId, q);
  }

  @Post()
  @RequirePermission('project:create')
  @ApiCreatedResponse({ type: ProjectDto })
  create(@OrgId() orgId: string, @Body() dto: CreateProjectDto, @Actor() actor: ActorContext) {
    return this.projects.create(orgId, dto, actor);
  }

  @Get(':projectId')
  @RequirePermission('project:read')
  @ApiOkResponse({ type: ProjectDto })
  get(@OrgId() orgId: string, @ProjectId() projectId: string) {
    return this.projects.get(orgId, projectId);
  }

  @Patch(':projectId')
  @RequirePermission('project:update')
  @ApiOkResponse({ type: ProjectDto })
  update(
    @OrgId() orgId: string,
    @ProjectId() projectId: string,
    @Body() dto: UpdateProjectDto,
    @Actor() actor: ActorContext,
  ) {
    return this.projects.update(orgId, projectId, dto, actor);
  }

  @Delete(':projectId')
  @RequirePermission('project:archive')
  @ApiOkResponse({ type: ProjectDto, description: 'Archives (soft-deletes) the project.' })
  archive(@OrgId() orgId: string, @ProjectId() projectId: string, @Actor() actor: ActorContext) {
    return this.projects.archive(orgId, projectId, actor);
  }
}

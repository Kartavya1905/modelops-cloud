import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { OrgAccessGuard, RequirePermission } from '../../common/authz/org-access.guard';
import {
  Actor,
  type ActorContext,
  CurrentAuth,
  type AuthContext,
  CurrentMembership,
  type MembershipContext,
} from '../../common/request-context/request-context';
import { UuidParam } from '../../common/validation';
import {
  AcceptedInvitationDto,
  ChangeRoleDto,
  CreatedInvitationDto,
  CreateInvitationDto,
  CreateOrgDto,
  InvitationDto,
  InvitationPreviewDto,
  MemberDto,
  OrgDto,
} from './organizations.dto';
import { OrganizationsService } from './organizations.service';

const OrgId = () => Param('orgId', new UuidParam('Organization'));

@ApiTags('organizations')
@ApiCookieAuth('session')
@Controller('orgs')
export class OrganizationsController {
  constructor(private readonly orgs: OrganizationsService) {}

  @Get()
  @ApiOkResponse({ type: [OrgDto], description: 'Organizations you belong to.' })
  listMine(@CurrentAuth() auth: AuthContext): Promise<OrgDto[]> {
    return this.orgs.listMine(auth.user.id);
  }

  @Post()
  @ApiCreatedResponse({ type: OrgDto, description: 'You become its Owner.' })
  create(@Body() dto: CreateOrgDto, @Actor() actor: ActorContext): Promise<OrgDto> {
    return this.orgs.create(dto.name, actor);
  }

  @Get(':orgId')
  @UseGuards(OrgAccessGuard)
  @RequirePermission('org:read')
  @ApiOkResponse({ type: OrgDto })
  get(@OrgId() _orgId: string, @CurrentMembership() m: MembershipContext): Promise<OrgDto> {
    return this.orgs.get(m);
  }
}

@ApiTags('organizations')
@ApiCookieAuth('session')
@UseGuards(OrgAccessGuard)
@Controller('orgs/:orgId/members')
export class MembersController {
  constructor(private readonly orgs: OrganizationsService) {}

  @Get()
  @RequirePermission('member:read')
  @ApiOkResponse({ type: [MemberDto] })
  list(@OrgId() orgId: string): Promise<MemberDto[]> {
    return this.orgs.listMembers(orgId);
  }

  @Patch(':userId')
  @RequirePermission('member:manage')
  @ApiOkResponse({ type: MemberDto })
  changeRole(
    @OrgId() _orgId: string,
    @Param('userId', new UuidParam('Member')) userId: string,
    @Body() dto: ChangeRoleDto,
    @CurrentMembership() m: MembershipContext,
    @Actor() actor: ActorContext,
  ): Promise<MemberDto> {
    return this.orgs.changeRole(m, userId, dto.role, actor);
  }

  @Delete(':userId')
  @RequirePermission('member:manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  remove(
    @OrgId() _orgId: string,
    @Param('userId', new UuidParam('Member')) userId: string,
    @CurrentMembership() m: MembershipContext,
    @Actor() actor: ActorContext,
  ): Promise<void> {
    return this.orgs.removeMember(m, userId, actor);
  }
}

@ApiTags('organizations')
@ApiCookieAuth('session')
@UseGuards(OrgAccessGuard)
@Controller('orgs/:orgId/invitations')
export class OrgInvitationsController {
  constructor(private readonly orgs: OrganizationsService) {}

  @Get()
  @RequirePermission('member:manage')
  @ApiOkResponse({
    type: [InvitationDto],
    description: 'Pending (unaccepted, unexpired) invitations.',
  })
  list(@OrgId() orgId: string): Promise<InvitationDto[]> {
    return this.orgs.listPendingInvitations(orgId);
  }

  @Post()
  @RequirePermission('invitation:create')
  @ApiCreatedResponse({ type: CreatedInvitationDto })
  create(
    @OrgId() _orgId: string,
    @Body() dto: CreateInvitationDto,
    @CurrentMembership() m: MembershipContext,
    @Actor() actor: ActorContext,
  ): Promise<CreatedInvitationDto> {
    return this.orgs.createInvitation(m, dto.email, dto.role, actor);
  }
}

/** Invitation links are opened by people who are not members yet, so these are not org-scoped. */
@ApiTags('organizations')
@ApiCookieAuth('session')
@Controller('invitations')
export class InvitationsController {
  constructor(private readonly orgs: OrganizationsService) {}

  @Get(':token')
  @ApiOkResponse({ type: InvitationPreviewDto })
  preview(@Param('token') token: string): Promise<InvitationPreviewDto> {
    return this.orgs.previewInvitation(token);
  }

  @Post(':token/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: AcceptedInvitationDto })
  accept(
    @Param('token') token: string,
    @CurrentAuth() auth: AuthContext,
    @Actor() actor: ActorContext,
  ): Promise<AcceptedInvitationDto> {
    return this.orgs.acceptInvitation(token, auth, actor);
  }
}

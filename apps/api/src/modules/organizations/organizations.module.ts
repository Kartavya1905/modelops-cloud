import { Module } from '@nestjs/common';
import {
  InvitationsController,
  MembersController,
  OrganizationsController,
  OrgInvitationsController,
} from './organizations.controller';
import { OrganizationsService } from './organizations.service';

@Module({
  controllers: [
    OrganizationsController,
    MembersController,
    OrgInvitationsController,
    InvitationsController,
  ],
  providers: [OrganizationsService],
})
export class OrganizationsModule {}

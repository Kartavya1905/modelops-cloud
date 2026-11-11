import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { IsOptional, IsString, Matches } from 'class-validator';
import { OrgAccessGuard, RequirePermission } from '../../common/authz/org-access.guard';
import { PageQuery } from '../../common/pagination';
import { UuidParam } from '../../common/validation';
import { AuditService } from './audit.service';

class AuditQuery extends PageQuery {
  @ApiPropertyOptional({ example: 'project.created' })
  @IsOptional()
  @IsString()
  @Matches(/^[a-z_]+\.[a-z_]+$/)
  action?: string;
}

class AuditActorDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() email!: string;
}

class AuditEventDto {
  @ApiProperty({ description: 'Monotonic id (string, because it is a 64-bit integer)' })
  id!: string;
  @ApiProperty({ enum: ['USER', 'API_KEY', 'SYSTEM'] }) actorType!: 'USER' | 'API_KEY' | 'SYSTEM';
  @ApiProperty({ type: AuditActorDto, nullable: true }) actor!: AuditActorDto | null;
  @ApiProperty({ example: 'project.created' }) action!: string;
  @ApiProperty({ type: String, nullable: true }) targetType!: string | null;
  @ApiProperty({ type: String, nullable: true }) targetId!: string | null;
  @ApiProperty({ type: 'object', additionalProperties: true }) metadata!: unknown;
  @ApiProperty({ type: String, nullable: true }) requestId!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

class AuditVerificationDto {
  @ApiProperty({ description: 'Every event verified against its predecessor' }) intact!: boolean;
  @ApiProperty({ description: 'Events verified (up to the first break)' }) checked!: number;
  @ApiProperty({ type: Number, nullable: true, description: 'Chain position of the first break' })
  brokenAt!: number | null;
  @ApiProperty({ type: String, nullable: true }) reason!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'Hash of the latest event (hex)' })
  head!: string | null;
}

class AuditPageDto {
  @ApiProperty({ type: [AuditEventDto] }) data!: AuditEventDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}

@ApiTags('audit')
@ApiCookieAuth('session')
@UseGuards(OrgAccessGuard)
@Controller('orgs/:orgId/audit-events')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequirePermission('audit:read')
  @ApiOkResponse({ type: AuditPageDto })
  list(@Param('orgId', new UuidParam('Organization')) orgId: string, @Query() q: AuditQuery) {
    return this.audit.list(orgId, q);
  }

  /** M9: tamper evidence. Recomputes the hash chain of this organization's audit log. */
  @Get('verify')
  @RequirePermission('audit:read')
  @ApiOkResponse({ type: AuditVerificationDto })
  verify(@Param('orgId', new UuidParam('Organization')) orgId: string) {
    return this.audit.verify(orgId);
  }
}

import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsIn, IsString, MaxLength, MinLength } from 'class-validator';

export const ROLE_VALUES = ['OWNER', 'ADMIN', 'ML_ENGINEER', 'VIEWER'] as const;
export type RoleValue = (typeof ROLE_VALUES)[number];

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateOrgDto {
  @ApiProperty({ example: 'Acme ML', minLength: 2, maxLength: 80 })
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name!: string;
}

export class OrgDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
  @ApiProperty({ enum: ROLE_VALUES, description: 'Your role in this organization.' })
  role!: RoleValue;
  @ApiProperty() memberCount!: number;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class MemberDto {
  @ApiProperty({ format: 'uuid' }) userId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() email!: string;
  @ApiProperty({ enum: ROLE_VALUES }) role!: RoleValue;
  @ApiProperty({ format: 'date-time' }) joinedAt!: string;
}

export class ChangeRoleDto {
  @ApiProperty({ enum: ROLE_VALUES })
  @IsIn(ROLE_VALUES)
  role!: RoleValue;
}

export class CreateInvitationDto {
  @ApiProperty({ example: 'grace@example.com' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({ enum: ROLE_VALUES })
  @IsIn(ROLE_VALUES)
  role!: RoleValue;
}

export class InvitationDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() email!: string;
  @ApiProperty({ enum: ROLE_VALUES }) role!: RoleValue;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class CreatedInvitationDto extends InvitationDto {
  @ApiProperty({
    description: 'One-time token. Shown only in this response; only its hash is stored.',
  })
  token!: string;
  @ApiProperty({
    example: '/invite/abc123',
    description: 'Path on the web app to accept the invite.',
  })
  acceptPath!: string;
}

export class InvitationPreviewDto {
  @ApiProperty() orgName!: string;
  @ApiProperty() email!: string;
  @ApiProperty({ enum: ROLE_VALUES }) role!: RoleValue;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
}

export class AcceptedInvitationDto {
  @ApiProperty({ format: 'uuid' }) orgId!: string;
}

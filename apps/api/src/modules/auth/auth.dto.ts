import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import { ALL_PERMISSIONS, type Permission } from '../../common/authz/permissions';

const normalizeEmail = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class RegisterDto {
  @ApiProperty({ example: 'ada@example.com', maxLength: 254 })
  @Transform(normalizeEmail)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({ example: 'Ada Lovelace', minLength: 1, maxLength: 100 })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @ApiProperty({ minLength: 12, maxLength: 128, description: 'At least 12 characters.' })
  @IsString()
  @MinLength(12)
  @MaxLength(128)
  password!: string;
}

export class LoginDto {
  @ApiProperty({ example: 'ada@example.com' })
  @Transform(normalizeEmail)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password!: string;
}

export class UserDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() email!: string;
  @ApiProperty() name!: string;
}

export class MembershipSummaryDto {
  @ApiProperty({ format: 'uuid' }) orgId!: string;
  @ApiProperty() orgName!: string;
  @ApiProperty() orgSlug!: string;
  @ApiProperty({ enum: ['OWNER', 'ADMIN', 'ML_ENGINEER', 'VIEWER'] })
  role!: 'OWNER' | 'ADMIN' | 'ML_ENGINEER' | 'VIEWER';
  @ApiProperty({ enum: ALL_PERMISSIONS, isArray: true, description: 'For UI hints only.' })
  permissions!: Permission[];
}

export class SessionDto {
  @ApiProperty({ type: UserDto }) user!: UserDto;
  @ApiProperty({ type: [MembershipSummaryDto] }) memberships!: MembershipSummaryDto[];
  @ApiProperty({ description: 'Send as X-CSRF-Token on POST/PUT/PATCH/DELETE.' })
  csrfToken!: string;
}

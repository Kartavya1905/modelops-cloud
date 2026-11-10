import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ProjectRefDto } from '../registry/registry.dto';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
export const ENDPOINT_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
export const REVISION_STATES = [
  'REQUESTED',
  'AWAITING_APPROVAL',
  'QUEUED',
  'PROVISIONING',
  'LOADING',
  'VERIFYING',
  'READY',
  'DEGRADED',
  'DRAINING',
  'RETIRED',
  'FAILED',
  'CANCELLED',
] as const;
type State = (typeof REVISION_STATES)[number];

export class CreateEndpointDto {
  @ApiProperty({ example: 'Churn staging', minLength: 2, maxLength: 60 })
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  name!: string;

  @ApiPropertyOptional({
    example: 'churn-staging',
    description: 'URL name (`/v1/endpoints/<slug>/predict`); derived from the name if omitted',
  })
  @IsOptional()
  @Matches(ENDPOINT_SLUG, { message: 'slug must be 1-40 lowercase letters, digits or dashes' })
  slug?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({
    enum: ['STAGING', 'PRODUCTION'],
    description: 'Default STAGING. PRODUCTION needs four-eyes approvals, which arrive in M8',
  })
  @IsOptional()
  @IsIn(['STAGING', 'PRODUCTION'])
  environment?: 'STAGING' | 'PRODUCTION';

  @ApiPropertyOptional({ minimum: 1, maximum: 1000, description: 'Default 50' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  rateLimitRps?: number;
}

export class ResourcesDto {
  @ApiPropertyOptional({ minimum: 0.25, maximum: 2, description: 'Default 0.5' })
  @IsOptional()
  @IsNumber()
  @Min(0.25)
  @Max(2)
  cpus?: number;

  @ApiPropertyOptional({ minimum: 256, maximum: 2048, description: 'Default 512' })
  @IsOptional()
  @IsInt()
  @Min(256)
  @Max(2048)
  memoryMb?: number;
}

export class DeployDto {
  @ApiProperty({
    format: 'uuid',
    description: 'A VALIDATED version of a model in the same project',
  })
  @IsUUID()
  modelVersionId!: string;

  @ApiPropertyOptional({ type: ResourcesDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ResourcesDto)
  resources?: ResourcesDto;
}

export class RevisionModelDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) modelId!: string;
  @ApiProperty() modelName!: string;
  @ApiProperty() version!: number;
  @ApiProperty({ enum: ['SKLEARN_ONNX', 'PYTORCH_ONNX'] }) framework!: string;
}

export class RevisionSummaryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) endpointId!: string;
  @ApiProperty() revisionNumber!: number;
  @ApiProperty({ enum: REVISION_STATES }) state!: State;
  @ApiProperty({ type: RevisionModelDto }) modelVersion!: RevisionModelDto;
  @ApiProperty({ type: String, nullable: true }) failureCode!: string | null;
  @ApiProperty({ type: String, nullable: true }) failureDetail!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) readyAt!: string | null;
}

export class DeploymentEventDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: REVISION_STATES, nullable: true, type: String }) fromState!: State | null;
  @ApiProperty({ enum: REVISION_STATES }) toState!: State;
  @ApiProperty() message!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class UserRefDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
}

export class RevisionDto extends RevisionSummaryDto {
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  stateDeadlineAt!: string | null;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'number' } })
  resources!: Record<string, number>;
  @ApiProperty({ type: String, nullable: true, description: 'Container name' })
  runtimeRef!: string | null;
  @ApiProperty({ type: UserRefDto }) requestedBy!: UserRefDto;
  @ApiProperty({ type: [DeploymentEventDto] }) events!: DeploymentEventDto[];
}

export class EndpointDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) projectId!: string;
  @ApiProperty() slug!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, nullable: true }) description!: string | null;
  @ApiProperty({ enum: ['STAGING', 'PRODUCTION'] }) environment!: 'STAGING' | 'PRODUCTION';
  @ApiProperty() rateLimitRps!: number;
  @ApiProperty({ description: 'POST here with an API key of this project' }) invokeUrl!: string;
  @ApiProperty({ type: RevisionSummaryDto, nullable: true })
  stableRevision!: RevisionSummaryDto | null;
  @ApiProperty({ type: RevisionSummaryDto, nullable: true })
  inProgressRevision!: RevisionSummaryDto | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class EndpointDetailDto extends EndpointDto {
  @ApiProperty({ type: ProjectRefDto }) project!: ProjectRefDto;
  @ApiProperty({ type: [RevisionSummaryDto], description: 'Newest first (up to 50)' })
  revisions!: RevisionSummaryDto[];
}

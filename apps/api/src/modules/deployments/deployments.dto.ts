import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
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
export const ROLLOUT_STRATEGIES = ['IMMEDIATE', 'CANARY'] as const;
export type RolloutStrategyName = (typeof ROLLOUT_STRATEGIES)[number];
export const APPROVAL_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED'] as const;
export const CANARY_VERDICTS = ['PASS', 'FAIL', 'INCONCLUSIVE'] as const;

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
    description:
      'Default STAGING. PRODUCTION (Owners/Admins only): every deployment needs a second ' +
      "Owner/Admin's approval, and release actions are Owner/Admin only",
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

/** M7: endpoint settings. Sent with `If-Match: <ETag from GET>` (lost-update protection). */
export class UpdateEndpointDto {
  @ApiPropertyOptional({
    description: 'Record request inputs (7 days) for drift detection. Off by default (privacy).',
  })
  @IsOptional()
  @IsBoolean()
  captureInputs?: boolean;

  @ApiPropertyOptional({ minimum: 1, maximum: 1000 })
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

  @ApiPropertyOptional({
    enum: ROLLOUT_STRATEGIES,
    description:
      'IMMEDIATE (default): takes all traffic once READY, the previous revision stays warm. ' +
      'CANARY: starts next to the stable revision with `canaryWeight` percent of the traffic',
  })
  @IsOptional()
  @IsIn(ROLLOUT_STRATEGIES)
  strategy?: RolloutStrategyName;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 50,
    description: 'CANARY only: initial share in percent (default 10)',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(50)
  canaryWeight?: number;
}

/** M8: `PUT /endpoints/{id}/canary` with `If-Match`. */
export class CanaryWeightDto {
  @ApiProperty({ minimum: 0, maximum: 50, description: 'Percent of requests; 0 keeps it warm' })
  @IsInt()
  @Min(0)
  @Max(50)
  weight!: number;
}

export class RollbackDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'An earlier revision of this endpoint; defaults to the last one that served',
  })
  @IsOptional()
  @IsUUID()
  targetRevisionId?: string;
}

export class DecisionDto {
  @ApiPropertyOptional({
    maxLength: 500,
    description: 'Shown to the requester (required to reject)',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  reason?: string;
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
  @ApiProperty({ enum: ROLLOUT_STRATEGIES }) strategy!: RolloutStrategyName;
  @ApiProperty({ type: Number, nullable: true, description: 'CANARY: requested share' })
  canaryWeight!: number | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true, description: 'Slow rollback of' })
  rollbackOfId!: string | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Last time it became the stable revision; rollback targets have one',
  })
  stableAt!: string | null;
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
  @ApiProperty({ description: 'Inputs are recorded for drift detection (opt-in)' })
  captureInputs!: boolean;
  @ApiProperty({ description: 'Optimistic-lock version; also sent as the ETag header' })
  rowVersion!: number;
  @ApiProperty({ description: 'POST here with an API key of this project' }) invokeUrl!: string;
  @ApiProperty({ type: RevisionSummaryDto, nullable: true })
  stableRevision!: RevisionSummaryDto | null;
  @ApiProperty({ type: RevisionSummaryDto, nullable: true })
  inProgressRevision!: RevisionSummaryDto | null;
  @ApiProperty({ type: () => CanaryDto, nullable: true, description: 'M8: the current canary' })
  canary!: CanaryDto | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class CanaryCheckRuleDto {
  @ApiProperty() rule!: string;
  @ApiProperty() passed!: boolean;
  @ApiProperty() detail!: string;
}

export class CanarySideDto {
  @ApiProperty() requests!: number;
  @ApiProperty({ description: '5xx answers (and, for the canary, fallbacks to stable)' })
  errors!: number;
  @ApiProperty({ type: Number, nullable: true }) errorRate!: number | null;
  @ApiProperty({ type: Number, nullable: true }) p95Ms!: number | null;
}

export class CanaryCheckDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) revisionId!: string;
  @ApiProperty({ enum: CANARY_VERDICTS }) verdict!: (typeof CANARY_VERDICTS)[number];
  @ApiProperty({ type: CanarySideDto }) canary!: CanarySideDto;
  @ApiProperty({ type: CanarySideDto }) stable!: CanarySideDto;
  @ApiProperty({ description: 'Requests the gateway sent to stable because the canary failed' })
  fallbacks!: number;
  @ApiProperty() windowSeconds!: number;
  @ApiProperty({ type: [CanaryCheckRuleDto] }) checks!: CanaryCheckRuleDto[];
  @ApiProperty({ description: 'This check aborted the canary' }) aborted!: boolean;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class CanaryDto {
  @ApiProperty({ type: RevisionSummaryDto }) revision!: RevisionSummaryDto;
  @ApiProperty({ description: 'Percent of requests' }) weight!: number;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) startedAt!: string | null;
  @ApiProperty({ type: CanaryCheckDto, nullable: true }) latestCheck!: CanaryCheckDto | null;
  @ApiProperty({ description: 'The latest check passed: Promote is allowed' })
  eligible!: boolean;
}

export class EndpointRefDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
  @ApiProperty({ format: 'uuid' }) projectId!: string;
  @ApiProperty({ enum: ['STAGING', 'PRODUCTION'] }) environment!: 'STAGING' | 'PRODUCTION';
}

export class ApprovalDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: APPROVAL_STATUSES }) status!: (typeof APPROVAL_STATUSES)[number];
  @ApiProperty({ type: RevisionSummaryDto }) revision!: RevisionSummaryDto;
  @ApiProperty({ type: EndpointRefDto }) endpoint!: EndpointRefDto;
  @ApiProperty({ type: UserRefDto }) requestedBy!: UserRefDto;
  @ApiProperty({ type: UserRefDto, nullable: true }) decidedBy!: UserRefDto | null;
  @ApiProperty({ type: String, nullable: true }) reason!: string | null;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) decidedAt!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({
    description: 'The caller may approve or reject it (an Owner/Admin, not the requester)',
  })
  canDecide!: boolean;
}

export class EndpointDetailDto extends EndpointDto {
  @ApiProperty({ type: ProjectRefDto }) project!: ProjectRefDto;
  @ApiProperty({ type: [RevisionSummaryDto], description: 'Newest first (up to 50)' })
  revisions!: RevisionSummaryDto[];
}

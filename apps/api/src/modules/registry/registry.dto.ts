import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { RUN_ID } from '../experiments/experiments.dto';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateModelDto {
  @ApiProperty({ example: 'Churn classifier', minLength: 2, maxLength: 80 })
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name!: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class ImportVersionDto {
  @ApiProperty({ description: 'MLflow run id in this project’s experiment' })
  @Matches(RUN_ID, { message: 'runId must be a 32-character MLflow run id' })
  runId!: string;
}

const FRAMEWORKS = ['SKLEARN_ONNX', 'PYTORCH_ONNX'] as const;
const STATUSES = ['PENDING_VALIDATION', 'VALIDATING', 'VALIDATED', 'REJECTED'] as const;

export class ModelVersionSummaryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() version!: number;
  @ApiProperty({ enum: FRAMEWORKS }) framework!: (typeof FRAMEWORKS)[number];
  @ApiProperty({ enum: STATUSES }) status!: (typeof STATUSES)[number];
  @ApiProperty() mlflowRunId!: string;
  @ApiProperty({ type: String, nullable: true, description: 'Null until mirrored to MLflow' })
  mlflowVersion!: string | null;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'number' } })
  metrics!: Record<string, number>;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class ModelDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) projectId!: string;
  @ApiProperty() slug!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, nullable: true }) description!: string | null;
  @ApiProperty({ enum: ['BINARY_CLASSIFICATION'] }) taskType!: 'BINARY_CLASSIFICATION';
  @ApiProperty({ description: 'Name in the MLflow Model Registry' }) mlflowName!: string;
  @ApiProperty() versionCount!: number;
  @ApiProperty({ type: ModelVersionSummaryDto, nullable: true })
  latestVersion!: ModelVersionSummaryDto | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class ProjectRefDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
}

export class ModelDetailDto extends ModelDto {
  @ApiProperty({ type: ProjectRefDto }) project!: ProjectRefDto;
  @ApiProperty({ type: [ModelVersionSummaryDto] }) versions!: ModelVersionSummaryDto[];
}

export class DatasetVersionDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() version!: string;
  @ApiProperty() sha256!: string;
  @ApiProperty({ type: Number, nullable: true }) rowCount!: number | null;
  @ApiProperty() uri!: string;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } })
  generatorParams!: Record<string, string>;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class TensorSpecDto {
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ['float32', 'float64', 'int32', 'int64', 'bool'] }) dtype!: string;
  @ApiProperty({ type: [Number] }) shape!: number[];
  @ApiPropertyOptional({ type: [String] }) features?: string[];
  @ApiPropertyOptional({
    type: 'array',
    items: { oneOf: [{ type: 'number' }, { type: 'string' }] },
  })
  classes?: (number | string)[];
}

export class SignatureDto {
  @ApiProperty() signatureVersion!: number;
  @ApiProperty({ enum: ['binary_classification'] }) task!: string;
  @ApiProperty({ type: [TensorSpecDto] }) inputs!: TensorSpecDto[];
  @ApiProperty({ type: [TensorSpecDto] }) outputs!: TensorSpecDto[];
}

export class ModelRefDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() mlflowName!: string;
  @ApiProperty({ type: ProjectRefDto }) project!: ProjectRefDto;
}

export class ModelVersionDto extends ModelVersionSummaryDto {
  @ApiProperty({ type: ModelRefDto }) model!: ModelRefDto;
  @ApiProperty() sourceUri!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Reported by training; verified in M4',
  })
  reportedSha256!: string | null;
  @ApiProperty({ type: SignatureDto }) signature!: SignatureDto;
  @ApiProperty({ type: DatasetVersionDto, nullable: true })
  trainingDataset!: DatasetVersionDto | null;
  @ApiProperty({ type: String, nullable: true, description: 'Set when the MLflow mirror failed' })
  mlflowSyncError!: string | null;
}

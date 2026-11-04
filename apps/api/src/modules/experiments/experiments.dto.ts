import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export const RUN_ID = /^[0-9a-f]{32}$/;

export class ExperimentDto {
  @ApiProperty({ description: 'MLflow experiment id' }) experimentId!: string;
  @ApiProperty({ example: 'modelops/acme-1a2b3c/customer-churn' }) name!: string;
  @ApiProperty({ type: [String], description: 'Commands that train into this experiment' })
  trainCommands!: string[];
}

export class RunsQuery {
  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 100, default: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 25;

  @ApiPropertyOptional({ description: 'Opaque cursor from a previous page’s `nextCursor`.' })
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  cursor?: string;
}

export class CompareQuery {
  @ApiProperty({ description: 'Comma-separated MLflow run ids (2–5)', example: 'a1…,b2…' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : value,
  )
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(5)
  @Matches(RUN_ID, { each: true, message: 'each id must be a 32-character MLflow run id' })
  ids!: string[];
}

export class DatasetRefDto {
  @ApiProperty() name!: string;
  @ApiProperty() version!: string;
  @ApiProperty() sha256!: string;
}

export class RegisteredAsDto {
  @ApiProperty({ format: 'uuid' }) modelId!: string;
  @ApiProperty() modelName!: string;
  @ApiProperty({ format: 'uuid' }) versionId!: string;
  @ApiProperty() version!: number;
}

export class RunDto {
  @ApiProperty() runId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ['RUNNING', 'SCHEDULED', 'FINISHED', 'FAILED', 'KILLED'] })
  status!: 'RUNNING' | 'SCHEDULED' | 'FINISHED' | 'FAILED' | 'KILLED';
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) startTime!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) endTime!: string | null;
  @ApiProperty({ type: Number, nullable: true }) durationMs!: number | null;
  @ApiProperty({ type: String, nullable: true, enum: ['SKLEARN_ONNX', 'PYTORCH_ONNX'] })
  framework!: string | null;
  @ApiProperty({ type: DatasetRefDto, nullable: true }) dataset!: DatasetRefDto | null;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'number' } })
  metrics!: Record<string, number>;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } })
  params!: Record<string, string>;
  @ApiProperty({ type: [RegisteredAsDto] }) registeredAs!: RegisteredAsDto[];
}

export class MetricPointDto {
  @ApiProperty() step!: number;
  @ApiProperty() value!: number;
}

export class RunDetailDto extends RunDto {
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'modelops.* tags',
  })
  tags!: Record<string, string>;
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'array', items: { $ref: '#/components/schemas/MetricPointDto' } },
    description: 'Per-step history for metrics logged more than once (e.g. train_loss)',
  })
  series!: Record<string, MetricPointDto[]>;
}

export class RunPageDto {
  @ApiProperty({ type: [RunDto] }) data!: RunDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}

export class RunComparisonDto {
  @ApiProperty({ type: [RunDetailDto] }) runs!: RunDetailDto[];
  @ApiProperty({ type: [String], description: 'Union of metric keys, sorted' })
  metricKeys!: string[];
  @ApiProperty({ type: [String], description: 'Params whose value differs between runs' })
  differingParams!: string[];
}

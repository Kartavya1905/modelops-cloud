import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { PageQuery } from '../../common/pagination';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateProjectDto {
  @ApiProperty({ example: 'Customer churn', minLength: 2, maxLength: 80 })
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

/** Only name and description are editable; the slug is stable so URLs and API paths never break. */
export class UpdateProjectDto {
  @ApiPropertyOptional({ minLength: 2, maxLength: 80 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name?: string;

  @ApiPropertyOptional({ maxLength: 500, nullable: true })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class ListProjectsQuery extends PageQuery {
  @ApiPropertyOptional({ type: Boolean, default: false })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => value === 'true' || value === true)
  @IsBoolean()
  includeArchived: boolean = false;
}

export class ProjectDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) orgId!: string;
  @ApiProperty({ example: 'customer-churn' }) slug!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, nullable: true }) description!: string | null;
  @ApiProperty({ format: 'uuid' }) createdById!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) archivedAt!: string | null;
}

export class ProjectPageDto {
  @ApiProperty({ type: [ProjectDto] }) data!: ProjectDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}

import { ApiProperty } from '@nestjs/swagger';

export class ValidationCheckDto {
  @ApiProperty({ example: 'V6' }) id!: string;
  @ApiProperty({ example: 'Only allow-listed operator domains' }) name!: string;
  @ApiProperty({ type: Boolean, nullable: true, description: 'null = skipped' }) passed!:
    boolean | null;
  @ApiProperty() detail!: string;
}

export class ValidationReportDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() attempt!: number;
  @ApiProperty({
    enum: ['PASSED', 'FAILED', 'ERROR'],
    description: 'ERROR = could not run (infrastructure)',
  })
  result!: 'PASSED' | 'FAILED' | 'ERROR';
  @ApiProperty({ type: [ValidationCheckDto] }) checks!: ValidationCheckDto[];
  @ApiProperty({ type: 'object', additionalProperties: true }) facts!: Record<string, unknown>;
  @ApiProperty() validatorVersion!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class ValidationHistoryDto {
  @ApiProperty({ enum: ['PENDING_VALIDATION', 'VALIDATING', 'VALIDATED', 'REJECTED'] })
  status!: string;
  @ApiProperty() attempts!: number;
  @ApiProperty({ type: ValidationReportDto, nullable: true }) latest!: ValidationReportDto | null;
  @ApiProperty({ type: [ValidationReportDto] }) history!: ValidationReportDto[];
  @ApiProperty({ description: 'True if the last attempt could not run and may be retried' })
  retryable!: boolean;
}

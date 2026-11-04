import { Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { OrgAccessGuard, RequirePermission } from '../../common/authz/org-access.guard';
import { Errors } from '../../common/errors/app-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Actor, type ActorContext } from '../../common/request-context/request-context';
import { UuidParam } from '../../common/validation';
import type { ValidationReport } from '../../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import { ValidationHistoryDto, type ValidationReportDto } from './validation.dto';
import { ValidationQueue } from './validation.queue';

export function reportDto(r: ValidationReport): ValidationReportDto {
  return {
    id: r.id,
    attempt: r.attempt,
    result: r.result,
    checks: r.checks as unknown as ValidationReportDto['checks'],
    facts: r.facts as Record<string, unknown>,
    validatorVersion: r.validatorVersion,
    createdAt: r.createdAt.toISOString(),
  };
}

async function loadVersion(prisma: PrismaService, orgId: string, versionId: string) {
  const v = await prisma.modelVersion.findFirst({
    where: { id: versionId, orgId },
    include: { validations: { orderBy: { createdAt: 'desc' }, take: 20 } },
  });
  if (!v) throw Errors.notFound('Model version');
  return v;
}

@ApiTags('validation')
@ApiCookieAuth('session')
@UseGuards(OrgAccessGuard)
@Controller('orgs/:orgId/model-versions/:versionId/validation')
export class ValidationController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: ValidationQueue,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermission('model:read')
  @ApiOkResponse({ type: ValidationHistoryDto })
  async history(
    @Param('orgId', new UuidParam('Organization')) orgId: string,
    @Param('versionId', new UuidParam('Model version')) versionId: string,
  ): Promise<ValidationHistoryDto> {
    const v = await loadVersion(this.prisma, orgId, versionId);
    const latest = v.validations[0];
    return {
      status: v.status,
      attempts: v.validationAttempts,
      latest: latest ? reportDto(latest) : null,
      history: v.validations.map(reportDto),
      retryable: v.status === 'REJECTED' && latest?.result === 'ERROR',
    };
  }

  /**
   * Re-runs validation, only when the last attempt could not run (result ERROR). A model that
   * FAILED a check fails again deterministically: register a fixed bundle as a new version instead.
   */
  @Post('rerun')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission('model:register')
  @ApiOkResponse({ type: ValidationHistoryDto })
  async rerun(
    @Param('orgId', new UuidParam('Organization')) orgId: string,
    @Param('versionId', new UuidParam('Model version')) versionId: string,
    @Actor() actor: ActorContext,
  ): Promise<ValidationHistoryDto> {
    const v = await loadVersion(this.prisma, orgId, versionId);
    if (v.status !== 'REJECTED' || v.validations[0]?.result !== 'ERROR') {
      throw Errors.conflict(
        'VALIDATION_NOT_RETRYABLE',
        'Only a validation that could not run (an infrastructure error) can be re-run.',
      );
    }
    await this.prisma.$transaction(async (tx) => {
      const moved = await tx.modelVersion.updateMany({
        where: { id: versionId, status: 'REJECTED' },
        data: { status: 'PENDING_VALIDATION', validatedAt: null },
      });
      if (moved.count === 0)
        throw Errors.conflict('VALIDATION_NOT_RETRYABLE', 'The version changed.');
      await this.audit.record(tx, actor, {
        orgId,
        action: 'model_version.validation_rerun',
        targetType: 'model_version',
        targetId: versionId,
      });
    });
    await this.queue.enqueue(versionId);
    return this.history(orgId, versionId);
  }
}

import { createHmac, randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { Errors } from '../../common/errors/app-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { ActorContext } from '../../common/request-context/request-context';
import { APP_CONFIG, type AppConfig } from '../../config/config';
import { AuditService } from '../audit/audit.service';
import { DataPlanePublisher, entryOf } from '../deployments/dataplane';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateApiKeyDto {
  @ApiProperty({ example: 'checkout service', minLength: 2, maxLength: 60 })
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  name!: string;
}

export class ApiKeyDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ description: 'Public part, shown as `mo_<prefix>_…`' }) prefix!: string;
  @ApiProperty({ type: [String] }) scopes!: string[];
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) revokedAt!: string | null;
  @ApiProperty() createdByName!: string;
}

export class CreatedApiKeyDto extends ApiKeyDto {
  @ApiProperty({ description: 'The full key. Shown ONCE; only its HMAC is stored.' }) key!: string;
}

// Crockford-ish base32 without ambiguous characters; no "_" so the key splits unambiguously.
const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
function randomPrefix(): string {
  const bytes = randomBytes(10);
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
}

export const hmacSecret = (pepper: string, secret: string) =>
  createHmac('sha256', pepper).update(secret).digest();

@Injectable()
export class ApiKeysService {
  private readonly logger = new Logger(ApiKeysService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly dataplane: DataPlanePublisher,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async list(orgId: string, projectId: string): Promise<ApiKeyDto[]> {
    const project = await this.prisma.project.findFirst({ where: { id: projectId, orgId } });
    if (!project) throw Errors.notFound('Project');
    const keys = await this.prisma.apiKey.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      include: { createdBy: { select: { name: true } } },
    });
    return keys.map((k) => ({
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      scopes: k.scopes,
      createdAt: k.createdAt.toISOString(),
      revokedAt: k.revokedAt?.toISOString() ?? null,
      createdByName: k.createdBy.name,
    }));
  }

  async create(
    orgId: string,
    projectId: string,
    dto: CreateApiKeyDto,
    actor: ActorContext,
  ): Promise<CreatedApiKeyDto> {
    const project = await this.prisma.project.findFirst({ where: { id: projectId, orgId } });
    if (!project) throw Errors.notFound('Project');
    if (project.archivedAt) throw Errors.conflict('PROJECT_ARCHIVED', 'This project is archived.');
    const prefix = randomPrefix();
    const secret = randomBytes(32).toString('base64url');
    const key = await this.prisma.$transaction(async (tx) => {
      const k = await tx.apiKey.create({
        data: {
          orgId,
          projectId,
          name: dto.name,
          prefix,
          secretHash: hmacSecret(this.config.apiKeyPepper, secret),
          createdById: actor.userId,
        },
        include: { createdBy: { select: { name: true } } },
      });
      await this.audit.record(tx, actor, {
        orgId,
        action: 'api_key.created',
        targetType: 'api_key',
        targetId: k.id,
        metadata: { prefix, projectId }, // never the secret
      });
      return k;
    });
    await this.publish(key);
    return {
      id: key.id,
      name: key.name,
      prefix,
      scopes: key.scopes,
      createdAt: key.createdAt.toISOString(),
      revokedAt: null,
      createdByName: key.createdBy.name,
      key: `mo_${prefix}_${secret}`,
    };
  }

  async revoke(orgId: string, keyId: string, actor: ActorContext): Promise<void> {
    const key = await this.prisma.apiKey.findFirst({ where: { id: keyId, orgId } });
    if (!key) throw Errors.notFound('API key');
    if (key.revokedAt) return; // idempotent
    const revoked = await this.prisma.$transaction(async (tx) => {
      const k = await tx.apiKey.update({ where: { id: keyId }, data: { revokedAt: new Date() } });
      await this.audit.record(tx, actor, {
        orgId,
        action: 'api_key.revoked',
        targetType: 'api_key',
        targetId: keyId,
        metadata: { prefix: key.prefix },
      });
      return k;
    });
    await this.publish(revoked);
  }

  /** Best effort: if Redis is down, the reconciler's full sync applies it within 15 s. */
  private async publish(k: Parameters<typeof entryOf>[0] & { prefix: string }): Promise<void> {
    try {
      await this.dataplane.publishApiKey(k.prefix, entryOf(k));
    } catch (err) {
      this.logger.warn(`key directory update for ${k.prefix} deferred: ${(err as Error).message}`);
    }
  }
}

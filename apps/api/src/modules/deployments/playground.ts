import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Injectable,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiProperty, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsObject } from 'class-validator';
import { OrgAccessGuard, RequirePermission } from '../../common/authz/org-access.guard';
import { AppError, Errors } from '../../common/errors/app-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Actor, type ActorContext } from '../../common/request-context/request-context';
import { ArtifactStore } from '../../common/storage/artifact-store';
import { UuidParam } from '../../common/validation';
import { APP_CONFIG, type AppConfig } from '../../config/config';

export class PlaygroundInfoDto {
  @ApiProperty({ description: 'false until a revision is READY' }) ready!: boolean;
  @ApiProperty({ type: [String], description: 'Input fields, in signature order' })
  features!: string[];
  @ApiProperty({ type: 'array', items: { oneOf: [{ type: 'number' }, { type: 'string' }] } })
  classes!: (number | string)[];
  @ApiProperty({
    type: 'array',
    items: { type: 'object', additionalProperties: { type: 'number' } },
    description: 'Up to 5 golden examples of the serving version, ready to send',
  })
  examples!: Record<string, number>[];
  @ApiProperty({ type: String, nullable: true }) modelName!: string | null;
  @ApiProperty({ type: Number, nullable: true }) modelVersion!: number | null;
  @ApiProperty({ type: String, nullable: true }) revisionId!: string | null;
}

export class PlaygroundPredictDto {
  @ApiProperty({
    type: 'array',
    items: { type: 'object', additionalProperties: { type: 'number' } },
    minItems: 1,
    maxItems: 20,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsObject({ each: true })
  inputs!: Record<string, unknown>[];
}

export class PlaygroundOutputDto {
  @ApiProperty({ oneOf: [{ type: 'number' }, { type: 'string' }] }) label!: number | string;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'number' } })
  probabilities!: Record<string, number>;
}

export class PlaygroundModelDto {
  @ApiProperty() name!: string;
  @ApiProperty() version!: number;
  @ApiProperty({ enum: ['SKLEARN_ONNX', 'PYTORCH_ONNX'] }) framework!: string;
}

export class PlaygroundResultDto {
  @ApiProperty({ type: [String] }) predictionIds!: string[];
  @ApiProperty({ type: PlaygroundModelDto }) model!: PlaygroundModelDto;
  @ApiProperty() revisionId!: string;
  @ApiProperty({ type: [PlaygroundOutputDto] }) outputs!: PlaygroundOutputDto[];
  @ApiProperty() latencyMs!: number;
}

interface Signature {
  inputs: { features?: string[] }[];
  outputs: { classes?: (number | string)[] }[];
}

/**
 * The UI playground (docs/04 §3): signed-in users try a deployed model without an API key.
 * The API forwards to the gateway's internal route, so the request goes through exactly the same
 * signature validation, routing, metrics (`source="playground"`) and a low per-user rate limit.
 */
@Injectable()
export class PlaygroundService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: ArtifactStore,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async info(orgId: string, endpointId: string): Promise<PlaygroundInfoDto> {
    const e = await this.prisma.endpoint.findFirst({
      where: { id: endpointId, orgId },
      include: {
        stableRevision: {
          include: { modelVersion: { include: { model: { select: { name: true } } } } },
        },
      },
    });
    if (!e) throw Errors.notFound('Endpoint');
    const rev = e.stableRevision?.state === 'READY' ? e.stableRevision : null;
    if (!rev) {
      return {
        ready: false,
        features: [],
        classes: [],
        examples: [],
        modelName: null,
        modelVersion: null,
        revisionId: null,
      };
    }
    const sig = rev.modelVersion.signature as unknown as Signature;
    const features = sig.inputs[0]?.features ?? [];
    let examples: Record<string, number>[] = [];
    const sha = rev.modelVersion.goldenSha256;
    const bytes = sha ? await this.store.get(sha).catch(() => null) : null;
    if (bytes) {
      const golden = JSON.parse(Buffer.from(bytes).toString('utf8')) as { inputs: number[][] };
      examples = golden.inputs
        .slice(0, 5)
        .map((row) => Object.fromEntries(features.map((f, i) => [f, row[i] ?? 0])));
    }
    return {
      ready: true,
      features,
      classes: sig.outputs.find((o) => o.classes)?.classes ?? [0, 1],
      examples,
      modelName: rev.modelVersion.model.name,
      modelVersion: rev.modelVersion.version,
      revisionId: rev.id,
    };
  }

  async predict(
    orgId: string,
    endpointId: string,
    dto: PlaygroundPredictDto,
    actor: ActorContext,
  ): Promise<PlaygroundResultDto> {
    const e = await this.prisma.endpoint.findFirst({ where: { id: endpointId, orgId } });
    if (!e) throw Errors.notFound('Endpoint');
    let res: Response;
    try {
      res = await fetch(
        `${this.config.deploy.gatewayAdminUrl}/internal/endpoints/${endpointId}/predict`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-modelops-token': this.config.deploy.gatewayToken,
            'x-playground-actor': actor.userId,
            ...(actor.requestId ? { 'x-request-id': actor.requestId } : {}),
          },
          body: JSON.stringify({ inputs: dto.inputs }),
          signal: AbortSignal.timeout(10_000),
        },
      );
    } catch {
      throw new AppError(
        HttpStatus.BAD_GATEWAY,
        'GATEWAY_UNAVAILABLE',
        'Inference gateway unreachable',
      );
    }
    const body = (await res.json().catch(() => null)) as
      | (PlaygroundResultDto & {
          code?: string;
          title?: string;
          detail?: string;
          errors?: { field: string; message: string }[];
        })
      | null;
    if (!res.ok || !body) {
      // Pass the gateway's problem through (same codes as the public API), never its internals.
      throw new AppError(
        res.status,
        body?.code ?? 'UPSTREAM_ERROR',
        body?.title ?? 'Prediction failed',
        body?.detail,
        body?.errors,
      );
    }
    return body;
  }
}

@ApiTags('playground')
@ApiCookieAuth('session')
@UseGuards(OrgAccessGuard)
@Controller('orgs/:orgId/endpoints/:endpointId/playground')
export class PlaygroundController {
  constructor(private readonly playground: PlaygroundService) {}

  @Get()
  @RequirePermission('endpoint:read')
  @ApiOkResponse({ type: PlaygroundInfoDto })
  info(
    @Param('orgId', new UuidParam('Organization')) orgId: string,
    @Param('endpointId', new UuidParam('Endpoint')) endpointId: string,
  ) {
    return this.playground.info(orgId, endpointId);
  }

  @Post('predict')
  @HttpCode(200)
  @RequirePermission('endpoint:read')
  @ApiOkResponse({ type: PlaygroundResultDto })
  predict(
    @Param('orgId', new UuidParam('Organization')) orgId: string,
    @Param('endpointId', new UuidParam('Endpoint')) endpointId: string,
    @Body() dto: PlaygroundPredictDto,
    @Actor() actor: ActorContext,
  ) {
    return this.playground.predict(orgId, endpointId, dto, actor);
  }
}

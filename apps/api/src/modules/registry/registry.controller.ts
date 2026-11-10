import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import {
  ApiBody,
  ApiConsumes,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Errors } from '../../common/errors/app-error';
import { OrgAccessGuard, RequirePermission } from '../../common/authz/org-access.guard';
import { Actor, type ActorContext } from '../../common/request-context/request-context';
import { isUuid, UuidParam } from '../../common/validation';
import {
  CreateModelDto,
  DatasetVersionDto,
  ImportVersionDto,
  ModelDetailDto,
  ModelDto,
  ModelVersionDto,
} from './registry.dto';
import { RegistryService } from './registry.service';

const OrgId = () => Param('orgId', new UuidParam('Organization'));
type BundlePart = 'model' | 'signature' | 'golden';
/** The part of a multer file this route uses (memory storage keeps the bytes in `buffer`). */
type UploadedPart = { buffer: Buffer };

@ApiTags('registry')
@ApiCookieAuth('session')
@UseGuards(OrgAccessGuard)
@Controller('orgs/:orgId')
export class RegistryController {
  constructor(private readonly registry: RegistryService) {}

  @Get('projects/:projectId/models')
  @RequirePermission('model:read')
  @ApiOkResponse({ type: [ModelDto] })
  listModels(
    @OrgId() orgId: string,
    @Param('projectId', new UuidParam('Project')) projectId: string,
  ) {
    return this.registry.listModels(orgId, projectId);
  }

  @Post('projects/:projectId/models')
  @RequirePermission('model:create')
  @ApiCreatedResponse({ type: ModelDto, description: 'Also created in the MLflow Model Registry.' })
  createModel(
    @OrgId() orgId: string,
    @Param('projectId', new UuidParam('Project')) projectId: string,
    @Body() dto: CreateModelDto,
    @Actor() actor: ActorContext,
  ) {
    return this.registry.createModel(orgId, projectId, dto, actor);
  }

  @Get('projects/:projectId/datasets')
  @RequirePermission('model:read')
  @ApiOkResponse({ type: [DatasetVersionDto] })
  datasets(
    @OrgId() orgId: string,
    @Param('projectId', new UuidParam('Project')) projectId: string,
  ) {
    return this.registry.listDatasets(orgId, projectId);
  }

  @Get('models/:modelId')
  @RequirePermission('model:read')
  @ApiOkResponse({ type: ModelDetailDto })
  getModel(@OrgId() orgId: string, @Param('modelId', new UuidParam('Model')) modelId: string) {
    return this.registry.getModel(orgId, modelId);
  }

  @Post('models/:modelId/versions/import')
  @RequirePermission('model:register')
  @ApiCreatedResponse({
    type: ModelVersionDto,
    description:
      'Registers a finished MLflow run of this project as the next version (PENDING_VALIDATION).',
  })
  importVersion(
    @OrgId() orgId: string,
    @Param('modelId', new UuidParam('Model')) modelId: string,
    @Body() dto: ImportVersionDto,
    @Actor() actor: ActorContext,
  ) {
    return this.registry.importVersion(orgId, modelId, dto.runId, actor);
  }

  @Post('models/:modelId/versions/upload')
  @RequirePermission('model:register')
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'model', maxCount: 1 },
        { name: 'signature', maxCount: 1 },
        { name: 'golden', maxCount: 1 },
      ],
      // In-memory (Nest's default) with hard limits enforced while the request streams in:
      // a larger part aborts the upload with 413.
      {
        limits: { fileSize: 100 * 1024 * 1024, files: 3, fields: 3, parts: 6 },
      },
    ),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['framework', 'model', 'signature', 'golden'],
      properties: {
        framework: { type: 'string', enum: ['SKLEARN_ONNX', 'PYTORCH_ONNX'] },
        model: { type: 'string', format: 'binary', description: 'model.onnx (max 100 MB)' },
        signature: { type: 'string', format: 'binary', description: 'signature.json (max 1 MB)' },
        golden: {
          type: 'string',
          format: 'binary',
          description: 'golden_examples.json (max 1 MB)',
        },
        trainingDatasetVersionId: {
          type: 'string',
          format: 'uuid',
          description: 'Optional: the dataset version it was trained on (enables drift monitoring)',
        },
      },
    },
  })
  @ApiCreatedResponse({
    type: ModelVersionDto,
    description: 'Stored content-addressed, then validated asynchronously.',
  })
  uploadVersion(
    @OrgId() orgId: string,
    @Param('modelId', new UuidParam('Model')) modelId: string,
    @Body('framework') framework: unknown,
    @Body('trainingDatasetVersionId') trainingDatasetVersionId: unknown,
    @UploadedFiles()
    files: Partial<Record<BundlePart, UploadedPart[]>> | undefined,
    @Actor() actor: ActorContext,
  ) {
    const one = (k: BundlePart) => files?.[k]?.[0]?.buffer;
    const model = one('model');
    const signature = one('signature');
    const golden = one('golden');
    if (!model || !signature || !golden || typeof framework !== 'string') {
      throw Errors.validation(
        (['framework', 'model', 'signature', 'golden'] as const)
          .filter((k) => (k === 'framework' ? typeof framework !== 'string' : !one(k)))
          .map((field) => ({ field, message: 'is required' })),
      );
    }
    return this.registry.uploadVersion(
      orgId,
      modelId,
      {
        framework,
        model,
        signature,
        golden,
        ...(typeof trainingDatasetVersionId === 'string' && isUuid(trainingDatasetVersionId)
          ? { trainingDatasetVersionId }
          : {}),
      },
      actor,
    );
  }

  @Get('model-versions/:versionId')
  @RequirePermission('model:read')
  @ApiOkResponse({ type: ModelVersionDto })
  getVersion(
    @OrgId() orgId: string,
    @Param('versionId', new UuidParam('Model version')) versionId: string,
  ) {
    return this.registry.getVersion(orgId, versionId);
  }
}

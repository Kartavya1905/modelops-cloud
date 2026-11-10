import { Module } from '@nestjs/common';
import { ApiKeysController } from '../api-keys/api-keys.controller';
import { ApiKeysService } from '../api-keys/api-keys.service';
import { DataPlanePublisher } from './dataplane';
import { DeployProcessor } from './deploy.processor';
import { DeployQueue } from './deploy.queue';
import { DeployWorker } from './deploy.worker';
import { EndpointsController } from './endpoints.controller';
import { EndpointsService } from './endpoints.service';
import { OutboxRelay } from './outbox.relay';
import { PlaygroundController, PlaygroundService } from './playground';
import { ArtifactUrlSigner, ModelServerProbe } from './probe';
import { Reconciler } from './reconciler';
import { DockerDriver } from './runtime/docker.driver';
import { RUNTIME_DRIVER } from './runtime/runtime-driver';

/**
 * API side: endpoints, deploy requests (outbox), API keys. It never touches Docker or the queue;
 * the worker does (ADR-0001: same codebase, separate processes).
 */
@Module({
  controllers: [EndpointsController, ApiKeysController, PlaygroundController],
  providers: [EndpointsService, ApiKeysService, DataPlanePublisher, PlaygroundService],
  exports: [EndpointsService, DataPlanePublisher],
})
export class DeploymentsModule {}

/** Worker side: outbox relay, deploy processor, reconciler and the runtime driver. */
@Module({
  providers: [
    DataPlanePublisher,
    DeployQueue,
    DeployProcessor,
    OutboxRelay,
    Reconciler,
    ModelServerProbe,
    ArtifactUrlSigner,
    { provide: RUNTIME_DRIVER, useClass: DockerDriver },
    DeployWorker,
  ],
  exports: [
    DeployProcessor,
    Reconciler,
    OutboxRelay,
    DeployQueue,
    DataPlanePublisher,
    RUNTIME_DRIVER,
  ],
})
export class DeploymentsWorkerModule {}

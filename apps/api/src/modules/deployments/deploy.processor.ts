import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ArtifactStore } from '../../common/storage/artifact-store';
import { APP_CONFIG, type AppConfig } from '../../config/config';
import type { DeploymentRevision, Prisma } from '../../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import { DataPlanePublisher } from './dataplane';
import { ArtifactUrlSigner, compareGolden, type Golden, ModelServerProbe } from './probe';
import {
  RUNTIME_DRIVER,
  type RuntimeDriver,
  type RuntimeStatus,
  TransientError,
} from './runtime/runtime-driver';
import { type FailureCode, failureForExitCode, TERMINAL } from './state-machine';
import { transition } from './transition';

const SYSTEM = { userId: null, requestId: undefined, ip: undefined } as const;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The orchestrator (docs/05 §1): drives one revision QUEUED -> PROVISIONING -> LOADING ->
 * VERIFYING -> READY. It is re-entrant: every call looks at the revision's *current* state and
 * continues from there, so a redelivered job (worker crash, stalled lock, reconciler re-enqueue)
 * resumes instead of starting over, and every runtime action is idempotent (`ensure`).
 *
 * Throws TransientError to let the queue retry with backoff; everything else ends in FAILED.
 */
@Injectable()
export class DeployProcessor {
  private readonly logger = new Logger(DeployProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly store: ArtifactStore,
    private readonly signer: ArtifactUrlSigner,
    private readonly probe: ModelServerProbe,
    private readonly dataplane: DataPlanePublisher,
    @Inject(RUNTIME_DRIVER) private readonly driver: RuntimeDriver,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Runs as far as possible. `stopAfter` exists for tests that simulate a crash mid-deploy. */
  async process(revisionId: string, opts: { isFinalAttempt?: boolean; stopAfter?: string } = {}) {
    try {
      for (;;) {
        const rev = await this.prisma.deploymentRevision.findUnique({ where: { id: revisionId } });
        if (!rev) return;
        if (TERMINAL.has(rev.state)) {
          await this.cleanup(rev); // e.g. cancelled while provisioning
          return;
        }
        if (opts.stopAfter === rev.state) return;
        const next = await this.step(rev);
        if (!next) return; // READY, lost a CAS, or nothing to do
      }
    } catch (err) {
      if (err instanceof TransientError && !opts.isFinalAttempt) throw err;
      const rev = await this.prisma.deploymentRevision.findUnique({ where: { id: revisionId } });
      if (rev && !TERMINAL.has(rev.state) && rev.state !== 'READY') {
        await this.fail(rev, 'RUNTIME_START_FAILED', (err as Error).message);
      }
    }
  }

  /** One transition. Returns true if the caller should look again. */
  private async step(rev: DeploymentRevision): Promise<boolean> {
    switch (rev.state) {
      case 'QUEUED':
        return this.startProvisioning(rev);
      case 'PROVISIONING':
        return this.provision(rev);
      case 'LOADING':
        return this.waitUntilLoaded(rev);
      case 'VERIFYING':
        return this.verify(rev);
      default:
        return false;
    }
  }

  private async startProvisioning(rev: DeploymentRevision): Promise<boolean> {
    // Re-check at the last responsible moment (the API and a DB trigger checked it too).
    const mv = await this.prisma.modelVersion.findUniqueOrThrow({
      where: { id: rev.modelVersionId },
      select: { status: true },
    });
    if (mv.status !== 'VALIDATED') {
      await this.fail(rev, 'MODEL_NOT_VALIDATED', `model version is ${mv.status}`);
      return false;
    }
    const moved = await this.prisma.$transaction((tx) =>
      transition(tx, rev, 'PROVISIONING', { message: 'Worker picked up the deployment' }),
    );
    return moved !== null;
  }

  private async provision(rev: DeploymentRevision): Promise<boolean> {
    const mv = await this.prisma.modelVersion.findUniqueOrThrow({
      where: { id: rev.modelVersionId },
      select: { id: true, artifactSha256: true, signature: true },
    });
    if (!mv.artifactSha256) {
      await this.fail(rev, 'MODEL_NOT_VALIDATED', 'model version has no stored artifact');
      return false;
    }
    const status = await this.ensureContainer(rev, mv.artifactSha256, mv.signature);
    if (status.state === 'exited' || status.state === 'dead') {
      await this.failFromContainer(rev, status);
      return false;
    }
    if (status.state !== 'running') throw new TransientError(`container is ${status.state}`);
    const moved = await this.prisma.$transaction((tx) =>
      transition(tx, rev, 'LOADING', {
        message: 'Container running; downloading and verifying the artifact',
        data: { runtimeRef: status.name },
        metadata: { container: status.name },
      }),
    );
    return moved !== null;
  }

  async ensureContainer(
    rev: Pick<DeploymentRevision, 'id' | 'orgId' | 'endpointId' | 'modelVersionId' | 'resources'>,
    sha256: string,
    signature: Prisma.JsonValue,
  ): Promise<RuntimeStatus> {
    const resources = rev.resources as { cpus?: number; memoryMb?: number };
    return this.driver.ensure({
      revisionId: rev.id,
      orgId: rev.orgId,
      endpointId: rev.endpointId,
      image: this.config.deploy.modelServerImage,
      cpus: resources.cpus ?? 0.5,
      memoryMb: resources.memoryMb ?? 512,
      env: {
        MO_ARTIFACT_URL: await this.signer.signModel(sha256),
        MO_ARTIFACT_SHA256: sha256,
        MO_SIGNATURE: JSON.stringify(signature),
        MO_REVISION_ID: rev.id,
        MO_MODEL_VERSION_ID: rev.modelVersionId,
      },
    });
  }

  private async waitUntilLoaded(rev: DeploymentRevision): Promise<boolean> {
    const deadline = rev.stateDeadlineAt?.getTime() ?? Date.now() + 120_000;
    let delay = 250;
    while (Date.now() < deadline) {
      const status = await this.driver.inspect(rev.id);
      if (!status || status.state === 'exited' || status.state === 'dead') {
        await this.failFromContainer(rev, status);
        return false;
      }
      if (status.state === 'running' && (await this.probe.ready(rev.id))) {
        const moved = await this.prisma.$transaction((tx) =>
          transition(tx, rev, 'VERIFYING', {
            message: 'Artifact checksum verified and model loaded; running golden examples',
          }),
        );
        return moved !== null;
      }
      await sleep(delay);
      delay = Math.min(delay * 2, 2000);
    }
    await this.fail(rev, 'TIMEOUT', 'model server did not become ready before the deadline');
    return false;
  }

  private async verify(rev: DeploymentRevision): Promise<boolean> {
    const mv = await this.prisma.modelVersion.findUniqueOrThrow({
      where: { id: rev.modelVersionId },
      select: { goldenSha256: true },
    });
    if (!mv.goldenSha256) {
      await this.fail(rev, 'FUNCTIONAL_CHECK_FAILED', 'no golden examples stored');
      return false;
    }
    let bytes: Uint8Array | null;
    try {
      bytes = await this.store.get(mv.goldenSha256);
    } catch (err) {
      throw new TransientError(`golden examples unavailable: ${(err as Error).message}`);
    }
    if (!bytes) {
      await this.fail(rev, 'FUNCTIONAL_CHECK_FAILED', 'golden examples missing from storage');
      return false;
    }
    const golden = JSON.parse(Buffer.from(bytes).toString('utf8')) as Golden;
    const res = await this.probe.predict(rev.id, golden.inputs);
    const mismatch = compareGolden(golden, res.outputs);
    if (mismatch) {
      await this.fail(rev, 'FUNCTIONAL_CHECK_FAILED', mismatch);
      return false;
    }
    await this.markReady(rev, golden.inputs.length);
    return false;
  }

  /**
   * VERIFYING -> READY and the traffic switch in ONE transaction. IMMEDIATE (M5): the new revision
   * replaces the stable one only after it has proved itself; the old one drains, still warm.
   * CANARY (M8): it starts next to the stable one with its requested share, and the canary
   * analysis decides whether it may be promoted. With no healthy stable to compare with (it
   * failed meanwhile), a canary simply becomes the stable revision.
   */
  private async markReady(rev: DeploymentRevision, goldenRows: number): Promise<void> {
    const ready = await this.prisma.$transaction(async (tx) => {
      const moved = await transition(tx, rev, 'READY', {
        message: `Golden examples reproduced (${String(goldenRows)} rows); serving traffic`,
        data: { readyAt: new Date() },
        metadata: { goldenRows },
      });
      if (!moved) return null;
      await tx.$queryRaw`SELECT id FROM endpoints WHERE id = ${rev.endpointId}::uuid FOR UPDATE`;
      const endpoint = await tx.endpoint.findUniqueOrThrow({ where: { id: rev.endpointId } });
      const stable = endpoint.stableRevisionId
        ? await tx.deploymentRevision.findUnique({ where: { id: endpoint.stableRevisionId } })
        : null;
      if (
        rev.strategy === 'CANARY' &&
        stable?.state === 'READY' &&
        !endpoint.canaryRevisionId &&
        stable.id !== rev.id
      ) {
        const weight = rev.canaryWeight ?? 0;
        await tx.endpoint.update({
          where: { id: rev.endpointId },
          data: {
            canaryRevisionId: rev.id,
            canaryWeight: weight,
            canaryStartedAt: weight > 0 ? new Date() : null,
            rowVersion: { increment: 1 },
          },
        });
        await tx.deploymentEvent.create({
          data: {
            orgId: rev.orgId,
            revisionId: rev.id,
            fromState: 'READY',
            toState: 'READY',
            message: `Canary: receiving ${String(weight)}% of traffic next to revision ${String(stable.revisionNumber)}`,
            metadata: { canaryWeight: weight },
          },
        });
        await this.audit.record(tx, SYSTEM, {
          orgId: rev.orgId,
          action: 'deployment.canary_started',
          targetType: 'deployment_revision',
          targetId: rev.id,
          metadata: { endpointId: rev.endpointId, revision: rev.revisionNumber, weight },
        });
        return moved;
      }
      let replaced: string | null = null;
      if (endpoint.stableRevisionId && endpoint.stableRevisionId !== rev.id) {
        const old = await tx.deploymentRevision.findUniqueOrThrow({
          where: { id: endpoint.stableRevisionId },
        });
        if (old.state === 'READY' || old.state === 'DEGRADED') {
          await transition(tx, old, 'DRAINING', {
            message: `Replaced by revision ${String(rev.revisionNumber)}; kept warm for rollback`,
            data: { drainUntil: new Date(Date.now() + this.config.deploy.drainGraceMs) },
          });
          replaced = old.id;
        }
      }
      await tx.endpoint.update({
        where: { id: rev.endpointId },
        data: { stableRevisionId: rev.id, rowVersion: { increment: 1 } },
      });
      await tx.deploymentRevision.update({ where: { id: rev.id }, data: { stableAt: new Date() } });
      await this.audit.record(tx, SYSTEM, {
        orgId: rev.orgId,
        action: 'deployment.ready',
        targetType: 'deployment_revision',
        targetId: rev.id,
        metadata: { endpointId: rev.endpointId, revision: rev.revisionNumber, replaced },
      });
      return moved;
    });
    if (ready) {
      this.logger.log(`revision ${rev.id} READY`);
      await this.dataplane.publishRouting(true);
    }
  }

  private async failFromContainer(rev: DeploymentRevision, status: RuntimeStatus | null) {
    if (!status) {
      await this.fail(rev, 'RUNTIME_START_FAILED', 'container disappeared');
      return;
    }
    const tail = await this.driver.logs(rev.id, 20).catch(() => '');
    const line = tail
      .split('\n')
      .reverse()
      .find((l) => l.includes('startup.failed'));
    let detail = `model server exited with code ${String(status.exitCode)}`;
    if (line) {
      try {
        detail = (JSON.parse(line) as { detail?: string }).detail ?? detail;
      } catch {
        // not JSON: keep the generic detail
      }
    }
    await this.fail(rev, failureForExitCode(status.exitCode ?? -1), detail);
  }

  /** Any non-terminal state -> FAILED with a code, then clean up the container. */
  async fail(rev: DeploymentRevision, code: FailureCode, detail: string): Promise<void> {
    const failed = await this.prisma.$transaction(async (tx) => {
      const moved = await transition(tx, rev, 'FAILED', {
        message: `Failed: ${code}`,
        data: { failureCode: code, failureDetail: detail.slice(0, 1000) },
        metadata: { failureCode: code },
      });
      if (!moved) return null;
      // A failed revision never stays the stable one (it only can be via DEGRADED).
      await tx.endpoint.updateMany({
        where: { id: rev.endpointId, stableRevisionId: rev.id },
        data: { stableRevisionId: null, rowVersion: { increment: 1 } },
      });
      // ...nor the canary (docs/05: a failed canary's weight goes to 0).
      await tx.endpoint.updateMany({
        where: { id: rev.endpointId, canaryRevisionId: rev.id },
        data: {
          canaryRevisionId: null,
          canaryWeight: 0,
          canaryStartedAt: null,
          rowVersion: { increment: 1 },
        },
      });
      await this.audit.record(tx, SYSTEM, {
        orgId: rev.orgId,
        action: 'deployment.failed',
        targetType: 'deployment_revision',
        targetId: rev.id,
        metadata: { failureCode: code },
      });
      return moved;
    });
    if (!failed) return;
    this.logger.warn(`revision ${rev.id} FAILED (${code}): ${detail}`);
    await this.cleanup(failed);
    if (rev.state === 'DEGRADED') await this.dataplane.publishRouting(true);
  }

  private async cleanup(rev: DeploymentRevision): Promise<void> {
    try {
      await this.driver.remove(rev.id);
    } catch (err) {
      // The reconciler removes orphans every cycle; nothing is lost by failing here.
      this.logger.warn(`cleanup of ${rev.id} deferred: ${(err as Error).message}`);
    }
  }
}

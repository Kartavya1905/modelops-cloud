import type { Tx } from '../../common/prisma/prisma.service';
import type { DeploymentRevision, Prisma, RevisionState } from '../../generated/prisma/client';
import { canTransition, STATE_DEADLINE_MS } from './state-machine';

export class IllegalTransitionError extends Error {
  override name = 'IllegalTransitionError';
}

export interface TransitionOptions {
  message: string;
  metadata?: Prisma.InputJsonObject;
  /** Extra columns to set in the same UPDATE (failure code, runtime ref, ready_at, ...). */
  data?: Omit<Prisma.DeploymentRevisionUpdateManyMutationInput, 'state' | 'stateVersion'>;
}

/**
 * Compare-and-set state change (docs/05 §2): moves `rev` from its *current* state to `to` only if
 * nobody else moved it first, and writes the timeline event in the same transaction.
 *
 * Returns the updated revision, or null when the CAS lost (the caller stops: someone else is
 * handling it). Never retries in a loop. Illegal transitions are programming errors and throw.
 */
export async function transition(
  tx: Tx,
  rev: Pick<DeploymentRevision, 'id' | 'orgId' | 'state' | 'stateVersion'>,
  to: RevisionState,
  opts: TransitionOptions,
): Promise<DeploymentRevision | null> {
  if (!canTransition(rev.state, to)) {
    throw new IllegalTransitionError(`illegal revision transition ${rev.state} -> ${to}`);
  }
  const deadlineMs = STATE_DEADLINE_MS[to];
  const moved = await tx.deploymentRevision.updateMany({
    where: { id: rev.id, state: rev.state, stateVersion: rev.stateVersion },
    data: {
      ...opts.data,
      state: to,
      stateVersion: { increment: 1 },
      stateDeadlineAt: deadlineMs === undefined ? null : new Date(Date.now() + deadlineMs),
      ...(to === 'RETIRED' ? { retiredAt: new Date() } : {}),
    },
  });
  if (moved.count === 0) return null;
  await tx.deploymentEvent.create({
    data: {
      orgId: rev.orgId,
      revisionId: rev.id,
      fromState: rev.state,
      toState: to,
      message: opts.message,
      metadata: opts.metadata ?? {},
    },
  });
  return tx.deploymentRevision.findUniqueOrThrow({ where: { id: rev.id } });
}

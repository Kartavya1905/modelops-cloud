import type { RevisionState } from '../../generated/prisma/client';

/**
 * Revision state machine (docs/05 §2). This table is the only definition of legal transitions:
 * the CAS helper refuses anything not listed here, and the unit tests walk every pair.
 * AWAITING_APPROVAL exists in the schema for M8 (production approvals) and is not used yet.
 */
export const TRANSITIONS: Record<RevisionState, readonly RevisionState[]> = {
  REQUESTED: ['QUEUED', 'AWAITING_APPROVAL', 'CANCELLED', 'FAILED'],
  AWAITING_APPROVAL: ['QUEUED', 'CANCELLED'],
  QUEUED: ['PROVISIONING', 'CANCELLED', 'FAILED'],
  PROVISIONING: ['LOADING', 'FAILED', 'CANCELLED'],
  LOADING: ['VERIFYING', 'FAILED', 'CANCELLED'],
  VERIFYING: ['READY', 'FAILED'],
  READY: ['DEGRADED', 'DRAINING'],
  DEGRADED: ['READY', 'FAILED', 'DRAINING'],
  DRAINING: ['RETIRED', 'READY'],
  RETIRED: [],
  FAILED: [],
  CANCELLED: [],
};

export const TERMINAL: ReadonlySet<RevisionState> = new Set(['FAILED', 'CANCELLED', 'RETIRED']);

/** Matches the partial unique index `deployment_revisions_one_in_progress`. */
export const IN_PROGRESS: readonly RevisionState[] = [
  'REQUESTED',
  'AWAITING_APPROVAL',
  'QUEUED',
  'PROVISIONING',
  'LOADING',
  'VERIFYING',
];

/** States whose container is (or should be) running. */
export const RUNNING: readonly RevisionState[] = [
  'PROVISIONING',
  'LOADING',
  'VERIFYING',
  'READY',
  'DEGRADED',
  'DRAINING',
];

/** A user may cancel before the revision serves traffic (VERIFYING is too late: it's seconds away). */
export const CANCELLABLE: readonly RevisionState[] = [
  'REQUESTED',
  'QUEUED',
  'PROVISIONING',
  'LOADING',
];

/** Liveness: every in-progress state has a deadline; the reconciler fails anything past it. */
export const STATE_DEADLINE_MS: Partial<Record<RevisionState, number>> = {
  REQUESTED: 10 * 60_000, // the relay normally takes < 1 s; this only catches a stuck outbox
  QUEUED: 10 * 60_000,
  PROVISIONING: 120_000,
  LOADING: 120_000,
  VERIFYING: 60_000,
};

export function canTransition(from: RevisionState, to: RevisionState): boolean {
  return TRANSITIONS[from].includes(to);
}

export const FAILURE_CODES = [
  'ARTIFACT_CHECKSUM_MISMATCH',
  'MODEL_LOAD_ERROR',
  'MODEL_NOT_VALIDATED',
  'FUNCTIONAL_CHECK_FAILED',
  'RUNTIME_START_FAILED',
  'TIMEOUT',
  'RESTART_BUDGET_EXHAUSTED',
  'CANCELLED_BY_USER',
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

/** Model-server exit codes (services/model-server/model_server/loader.py) -> failure codes. */
export function failureForExitCode(exitCode: number): FailureCode {
  if (exitCode === 3) return 'ARTIFACT_CHECKSUM_MISMATCH';
  if (exitCode === 4) return 'MODEL_LOAD_ERROR';
  return 'RUNTIME_START_FAILED';
}

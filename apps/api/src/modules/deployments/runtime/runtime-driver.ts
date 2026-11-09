/**
 * Narrow runtime interface (ADR-0005). The orchestrator and reconciler only ever talk to this,
 * so the same lifecycle tests can run against Docker now and Kubernetes (kind) in M10.
 * Every method is idempotent.
 */
export interface RevisionRuntimeSpec {
  revisionId: string;
  orgId: string;
  endpointId: string;
  image: string;
  env: Record<string, string>;
  cpus: number;
  memoryMb: number;
}

export type RuntimeState = 'created' | 'running' | 'exited' | 'restarting' | 'dead' | 'missing';

export interface RuntimeStatus {
  revisionId: string;
  /** Deterministic name `mo-rev-<revisionId>`, also its DNS name on the inference network. */
  name: string;
  state: RuntimeState;
  exitCode: number | null;
}

export interface RuntimeDriver {
  /** Create-or-get and start. Safe to call any number of times for the same revision. */
  ensure(spec: RevisionRuntimeSpec): Promise<RuntimeStatus>;
  inspect(revisionId: string): Promise<RuntimeStatus | null>;
  /** Removes the container if it exists (missing is success). */
  remove(revisionId: string): Promise<void>;
  /** Every container this platform instance manages (labels `modelops.managed`, `modelops.instance`). */
  list(): Promise<RuntimeStatus[]>;
  /** Last log lines, for failure details (never contains request data: the server logs none). */
  logs(revisionId: string, tail: number): Promise<string>;
}

export const RUNTIME_DRIVER = Symbol('RUNTIME_DRIVER');

export const containerName = (revisionId: string) => `mo-rev-${revisionId}`;

/** An infrastructure hiccup (Docker API timeout, storage 5xx): retry with backoff. */
export class TransientError extends Error {
  override name = 'TransientError';
}

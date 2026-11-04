/** A dependency the API needs in order to serve traffic (Postgres, Redis, ...). */
export interface DependencyCheck {
  readonly name: string;
  /** Resolves when the dependency is usable; rejects otherwise. */
  check(): Promise<void>;
}

export const DEPENDENCY_CHECKS = Symbol('DEPENDENCY_CHECKS');

export interface CheckResult {
  status: 'up' | 'down';
  latencyMs: number;
  error?: string;
}

export interface ReadinessReport {
  status: 'ok' | 'error';
  checks: Record<string, CheckResult>;
}

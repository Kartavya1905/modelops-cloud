/** Shape returned by GET /api/v1/health/ready (see apps/api/src/health/health.types.ts). */
export interface CheckResult {
  status: 'up' | 'down';
  latencyMs: number;
  error?: string;
}

export interface ReadinessReport {
  status: 'ok' | 'error';
  checks: Record<string, CheckResult>;
}

export type PlatformState =
  | { kind: 'loading' }
  | { kind: 'ready'; report: ReadinessReport }
  | { kind: 'degraded'; report: ReadinessReport }
  | { kind: 'unreachable'; message: string };

function isCheckResult(value: unknown): value is CheckResult {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (v.status === 'up' || v.status === 'down') && typeof v.latencyMs === 'number';
}

/** Validates an untrusted JSON body instead of casting it blindly. */
export function parseReadiness(body: unknown): ReadinessReport | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  if (b.status !== 'ok' && b.status !== 'error') return null;
  if (typeof b.checks !== 'object' || b.checks === null) return null;
  const checks: Record<string, CheckResult> = {};
  for (const [name, result] of Object.entries(b.checks)) {
    if (!isCheckResult(result)) return null;
    checks[name] = result;
  }
  return { status: b.status, checks };
}

/**
 * Turns an HTTP outcome into a UI state.
 * 200 -> ready, 503 with a valid report -> degraded, anything else -> unreachable.
 */
export function toPlatformState(httpStatus: number, body: unknown): PlatformState {
  const report = parseReadiness(body);
  if (httpStatus === 200 && report?.status === 'ok') return { kind: 'ready', report };
  if (httpStatus === 503 && report) return { kind: 'degraded', report };
  return {
    kind: 'unreachable',
    message:
      httpStatus >= 500
        ? `The API is not reachable (HTTP ${httpStatus}). Is \`pnpm dev\` running?`
        : `Unexpected response from the API (HTTP ${httpStatus}).`,
  };
}

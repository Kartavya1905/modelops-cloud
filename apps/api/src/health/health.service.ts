import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config';
import {
  DEPENDENCY_CHECKS,
  type CheckResult,
  type DependencyCheck,
  type ReadinessReport,
} from './health.types';

export class TimeoutError extends Error {
  override name = 'TimeoutError';
}

/** Rejects with TimeoutError if `promise` does not settle within `ms`. */
export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new TimeoutError(`timed out after ${ms}ms`));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Runs one check and converts any outcome (success, error, hang) into a CheckResult. */
export async function runCheck(check: DependencyCheck, timeoutMs: number): Promise<CheckResult> {
  const started = performance.now();
  try {
    await withTimeout(check.check(), timeoutMs);
    return { status: 'up', latencyMs: Math.round(performance.now() - started) };
  } catch (err) {
    return {
      status: 'down',
      latencyMs: Math.round(performance.now() - started),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function summarize(results: Record<string, CheckResult>): ReadinessReport {
  const allUp = Object.values(results).every((r) => r.status === 'up');
  return { status: allUp ? 'ok' : 'error', checks: results };
}

@Injectable()
export class HealthService {
  private readonly startedAt = Date.now();

  constructor(
    @Inject(DEPENDENCY_CHECKS) private readonly checks: DependencyCheck[],
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  liveness(): { status: 'ok'; uptimeSeconds: number } {
    return { status: 'ok', uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000) };
  }

  /** Checks run in parallel, so readiness takes at most one timeout, not one per dependency. */
  async readiness(): Promise<ReadinessReport> {
    const entries = await Promise.all(
      this.checks.map(
        async (c) => [c.name, await runCheck(c, this.config.healthCheckTimeoutMs)] as const,
      ),
    );
    return summarize(Object.fromEntries(entries));
  }
}

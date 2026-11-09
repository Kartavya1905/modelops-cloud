/** Request validation, rate limiting and circuit breaking for the predict path. */

export interface FieldError {
  field: string;
  message: string;
}

/**
 * Validates `{ inputs: [{ <feature>: number, ... }] }` against the model signature and returns the
 * tensor rows in signature order. Exactly the signature's features: unknown or missing fields,
 * non-numbers, NaN/Infinity, or a batch over the limit are rejected before any model sees them.
 */
export function toMatrix(
  body: unknown,
  features: string[],
  maxBatch: number,
): { rows: number[][] } | { errors: FieldError[] } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { errors: [{ field: 'body', message: 'must be a JSON object' }] };
  }
  const extra = Object.keys(body).filter((k) => k !== 'inputs');
  if (extra.length) return { errors: extra.map((k) => ({ field: k, message: 'is not allowed' })) };
  const inputs = (body as { inputs?: unknown }).inputs;
  if (!Array.isArray(inputs) || inputs.length === 0) {
    return { errors: [{ field: 'inputs', message: 'must be a non-empty array' }] };
  }
  if (inputs.length > maxBatch) {
    return {
      errors: [{ field: 'inputs', message: `batch size is limited to ${String(maxBatch)}` }],
    };
  }
  const allowed = new Set(features);
  const errors: FieldError[] = [];
  const rows: number[][] = [];
  inputs.forEach((item: unknown, i) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      errors.push({
        field: `inputs[${String(i)}]`,
        message: 'must be an object of feature values',
      });
      return;
    }
    const rec = item as Record<string, unknown>;
    for (const k of Object.keys(rec)) {
      if (!allowed.has(k))
        errors.push({ field: `inputs[${String(i)}].${k}`, message: 'unknown feature' });
    }
    const row: number[] = [];
    for (const f of features) {
      const v = rec[f];
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        errors.push({
          field: `inputs[${String(i)}].${f}`,
          message: v === undefined ? 'is required' : 'must be a finite number',
        });
      } else row.push(v);
    }
    rows.push(row);
  });
  return errors.length ? { errors: errors.slice(0, 20) } : { rows };
}

export interface Counter {
  /** Atomically increments `key` (expiring after ttlMs) and returns the new value. */
  incr(key: string, ttlMs: number): Promise<number>;
}

/**
 * Per (endpoint, API key) fixed one-second window in Redis, shared by every gateway replica.
 * Fails OPEN if Redis is unreachable: availability over strictness, counted in a metric.
 */
export class RateLimiter {
  constructor(
    private readonly counter: Counter,
    private readonly onError: () => void = () => undefined,
  ) {}

  async allow(endpointId: string, keyId: string, limitRps: number): Promise<boolean> {
    const second = Math.floor(Date.now() / 1000);
    try {
      const n = await this.counter.incr(`mo:rl:${endpointId}:${keyId}:${String(second)}`, 2000);
      return n <= limitRps;
    } catch {
      this.onError();
      return true;
    }
  }
}

/**
 * Per-revision circuit breaker: after `threshold` consecutive upstream failures, requests fail fast
 * (503) for `openMs`, then one trial request is let through (half-open).
 */
export class CircuitBreaker {
  private readonly state = new Map<string, { failures: number; openUntil: number }>();

  constructor(
    private readonly threshold = 5,
    private readonly openMs = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  canPass(revisionId: string): boolean {
    const s = this.state.get(revisionId);
    if (!s || s.failures < this.threshold) return true;
    if (this.now() >= s.openUntil) {
      s.openUntil = this.now() + this.openMs; // half-open: one trial, re-open on failure
      return true;
    }
    return false;
  }

  success(revisionId: string): void {
    this.state.delete(revisionId);
  }

  failure(revisionId: string): void {
    const s = this.state.get(revisionId) ?? { failures: 0, openUntil: 0 };
    s.failures++;
    if (s.failures >= this.threshold) s.openUntil = this.now() + this.openMs;
    this.state.set(revisionId, s);
  }
}

import { describe, expect, it } from 'vitest';
import { runCheck, summarize, TimeoutError, withTimeout } from '../../src/health/health.service';
import type { DependencyCheck } from '../../src/health/health.types';

const ok: DependencyCheck = { name: 'ok', check: () => Promise.resolve() };
const failing: DependencyCheck = {
  name: 'failing',
  check: () => Promise.reject(new Error('connect ECONNREFUSED')),
};
const hanging: DependencyCheck = { name: 'hanging', check: () => new Promise(() => undefined) };

describe('withTimeout', () => {
  it('resolves with the value when the promise settles in time', async () => {
    await expect(withTimeout(Promise.resolve(42), 50)).resolves.toBe(42);
  });

  it('rejects with TimeoutError when the promise never settles', async () => {
    await expect(withTimeout(new Promise(() => undefined), 20)).rejects.toBeInstanceOf(
      TimeoutError,
    );
  });
});

describe('runCheck', () => {
  it('reports a healthy dependency as up', async () => {
    const r = await runCheck(ok, 100);
    expect(r.status).toBe('up');
    expect(r.error).toBeUndefined();
  });

  it('reports a failing dependency as down with the error message', async () => {
    const r = await runCheck(failing, 100);
    expect(r).toMatchObject({ status: 'down', error: 'connect ECONNREFUSED' });
  });

  it('reports a hanging dependency as down instead of hanging the probe', async () => {
    const r = await runCheck(hanging, 30);
    expect(r.status).toBe('down');
    expect(r.error).toMatch(/timed out after 30ms/);
    expect(r.latencyMs).toBeLessThan(1000);
  });
});

describe('summarize', () => {
  it('is ok only when every check is up', () => {
    expect(summarize({ a: { status: 'up', latencyMs: 1 } }).status).toBe('ok');
    expect(
      summarize({
        a: { status: 'up', latencyMs: 1 },
        b: { status: 'down', latencyMs: 1, error: 'x' },
      }).status,
    ).toBe('error');
  });
});

import { describe, expect, it } from 'vitest';
import { DEFAULT_CANARY_POLICY, judgeCanary } from '../../src/modules/deployments/canary-analysis';
import type { CanaryMetrics } from '../../src/modules/deployments/revision-view';

const side = (requests: number, errors: number, p95Ms: number | null = 10) => ({
  requests,
  errors,
  errorRate: requests > 0 ? errors / requests : null,
  p95Ms,
});
const metrics = (over: Partial<CanaryMetrics>): CanaryMetrics => ({
  canary: side(300, 0),
  stable: side(3000, 3),
  fallbacks: 0,
  windowSeconds: 600,
  ...over,
});
const rules = (r: ReturnType<typeof judgeCanary>) =>
  Object.fromEntries(r.checks.map((c) => [c.rule, c.passed]));

describe('canary verdict (docs/05 §6)', () => {
  it('passes a healthy canary with enough traffic and history', () => {
    const r = judgeCanary(DEFAULT_CANARY_POLICY, metrics({}));
    expect(r.verdict).toBe('PASS');
    expect(Object.values(rules(r)).every(Boolean)).toBe(true);
  });

  it('bad news acts fast: a breach fails as soon as there are enough requests', () => {
    const r = judgeCanary(
      DEFAULT_CANARY_POLICY,
      metrics({ canary: side(250, 125), windowSeconds: 40 }),
    );
    expect(r.verdict).toBe('FAIL');
    expect(rules(r)).toMatchObject({ minDurationSeconds: false, maxErrorRateIncrease: false });
  });

  it('good news needs patience: healthy but young is inconclusive', () => {
    expect(judgeCanary(DEFAULT_CANARY_POLICY, metrics({ windowSeconds: 120 })).verdict).toBe(
      'INCONCLUSIVE',
    );
  });

  it('too few requests decide nothing, not even a breach', () => {
    expect(judgeCanary(DEFAULT_CANARY_POLICY, metrics({ canary: side(50, 40) })).verdict).toBe(
      'INCONCLUSIVE',
    );
  });

  it.each([
    ['stable 0.1% + 1 pp allowed: 1.0% passes', side(1000, 10), true],
    ['1.2% fails', side(1000, 12), false],
  ])('error budget relative to stable: %s', (_n, canary, ok) => {
    const r = judgeCanary(DEFAULT_CANARY_POLICY, metrics({ canary }));
    expect(rules(r).maxErrorRateIncrease).toBe(ok);
  });

  it('latency: p95 at most 1.25 x stable; no stable latency yet is not a failure', () => {
    expect(judgeCanary(DEFAULT_CANARY_POLICY, metrics({ canary: side(300, 0, 13) })).verdict).toBe(
      'FAIL',
    );
    expect(
      judgeCanary(DEFAULT_CANARY_POLICY, metrics({ canary: side(300, 0, 12.4) })).verdict,
    ).toBe('PASS');
    const r = judgeCanary(DEFAULT_CANARY_POLICY, metrics({ stable: side(3000, 3, null) }));
    expect(r.verdict).toBe('PASS');
    expect(r.checks.find((c) => c.rule === 'maxLatencyRatio')?.detail).toContain('not enough data');
  });

  it('explains fallbacks to stable in the error rule', () => {
    const r = judgeCanary(
      DEFAULT_CANARY_POLICY,
      metrics({ canary: side(300, 120), fallbacks: 90 }),
    );
    expect(r.verdict).toBe('FAIL');
    expect(r.checks.find((c) => c.rule === 'maxErrorRateIncrease')?.detail).toContain(
      '90 fallbacks to stable',
    );
  });
});

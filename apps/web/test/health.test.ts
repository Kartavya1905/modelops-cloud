import { describe, expect, it } from 'vitest';
import { parseReadiness, toPlatformState } from '../src/lib/health';

const okBody = { status: 'ok', checks: { postgres: { status: 'up', latencyMs: 2 } } };
const degradedBody = {
  status: 'error',
  checks: {
    postgres: { status: 'up', latencyMs: 2 },
    redis: { status: 'down', latencyMs: 2000, error: 'timeout' },
  },
};

describe('parseReadiness', () => {
  it('accepts a well-formed report', () => {
    expect(parseReadiness(okBody)).toEqual(okBody);
  });

  it.each([
    null,
    'text',
    { status: 'weird', checks: {} },
    { status: 'ok', checks: { a: { status: 'up' } } },
  ])('rejects malformed body %j', (body) => {
    expect(parseReadiness(body)).toBeNull();
  });
});

describe('toPlatformState', () => {
  it('200 + ok report -> ready', () => {
    expect(toPlatformState(200, okBody).kind).toBe('ready');
  });

  it('503 + valid report -> degraded (shows which dependency is down)', () => {
    const s = toPlatformState(503, degradedBody);
    expect(s.kind).toBe('degraded');
  });

  it('500 from the Next.js proxy (API process not running) -> unreachable', () => {
    const s = toPlatformState(500, 'Internal Server Error');
    expect(s).toMatchObject({ kind: 'unreachable' });
  });

  it('404 -> unreachable with an unexpected-response message', () => {
    const s = toPlatformState(404, null);
    expect(s.kind === 'unreachable' && s.message).toMatch(/Unexpected response/);
  });
});

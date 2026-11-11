import { describe, expect, it } from 'vitest';
import { isDatabaseUnavailable } from '../../src/common/prisma/prisma.service';

describe('isDatabaseUnavailable (M9: outages are retried, never blamed on the work)', () => {
  it.each([
    ['an expired interactive transaction (paused Postgres)', { code: 'P2028', message: 'x' }],
    ['a pool timeout', { code: 'P2024', message: 'x' }],
    ['an unreachable server', { code: 'P1001', message: 'x' }],
    ['a dropped connection', new Error('Connection terminated unexpectedly')],
    [
      'a transaction that could not start',
      new Error('Transaction API error: Unable to start a transaction in the given time.'),
    ],
    [
      'an init failure',
      Object.assign(new Error('boom'), { name: 'PrismaClientInitializationError' }),
    ],
  ])('yes: %s', (_n, err) => {
    expect(isDatabaseUnavailable(err)).toBe(true);
  });

  it.each([
    ['a unique violation', { code: 'P2002', message: 'Unique constraint failed' }],
    ['a trigger refusal', new Error('deployment_revisions: model version x is not VALIDATED')],
    ['a plain bug', new TypeError('cannot read properties of undefined')],
    ['not an error', 'nope'],
  ])('no: %s', (_n, err) => {
    expect(isDatabaseUnavailable(err)).toBe(false);
  });
});

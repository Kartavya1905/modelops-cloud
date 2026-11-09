import { describe, expect, it } from 'vitest';
import type { RevisionState } from '../../src/generated/prisma/client';
import { compareGolden } from '../../src/modules/deployments/probe';
import {
  CANCELLABLE,
  canTransition,
  failureForExitCode,
  IN_PROGRESS,
  STATE_DEADLINE_MS,
  TERMINAL,
  TRANSITIONS,
} from '../../src/modules/deployments/state-machine';

const STATES = Object.keys(TRANSITIONS) as RevisionState[];

/** docs/05 §2, written out independently of the implementation's table. */
const LEGAL = new Set([
  'REQUESTED>QUEUED',
  'REQUESTED>AWAITING_APPROVAL',
  'REQUESTED>CANCELLED',
  'REQUESTED>FAILED',
  'AWAITING_APPROVAL>QUEUED',
  'AWAITING_APPROVAL>CANCELLED',
  'QUEUED>PROVISIONING',
  'QUEUED>CANCELLED',
  'QUEUED>FAILED',
  'PROVISIONING>LOADING',
  'PROVISIONING>FAILED',
  'PROVISIONING>CANCELLED',
  'LOADING>VERIFYING',
  'LOADING>FAILED',
  'LOADING>CANCELLED',
  'VERIFYING>READY',
  'VERIFYING>FAILED',
  'READY>DEGRADED',
  'READY>DRAINING',
  'DEGRADED>READY',
  'DEGRADED>FAILED',
  'DEGRADED>DRAINING',
  'DRAINING>RETIRED',
  'DRAINING>READY',
]);

describe('revision state machine', () => {
  it.each(STATES.flatMap((from) => STATES.map((to) => [from, to] as const)))(
    '%s -> %s',
    (from, to) => {
      expect(canTransition(from, to)).toBe(LEGAL.has(`${from}>${to}`));
    },
  );

  it('terminal states have no way out; every in-progress state has a deadline', () => {
    for (const t of TERMINAL) expect(TRANSITIONS[t]).toEqual([]);
    for (const s of IN_PROGRESS.filter((s) => s !== 'AWAITING_APPROVAL')) {
      expect(STATE_DEADLINE_MS[s]).toBeGreaterThan(0);
    }
    for (const s of CANCELLABLE) expect(canTransition(s, 'CANCELLED')).toBe(true);
  });

  it('maps model-server exit codes to failure codes', () => {
    expect(failureForExitCode(3)).toBe('ARTIFACT_CHECKSUM_MISMATCH');
    expect(failureForExitCode(4)).toBe('MODEL_LOAD_ERROR');
    expect(failureForExitCode(137)).toBe('RUNTIME_START_FAILED');
  });
});

describe('golden functional check', () => {
  const golden = {
    inputs: [[0], [1]],
    outputs: {
      label: [0, 1],
      probabilities: [
        [0.9, 0.1],
        [0.2, 0.8],
      ],
    },
  };
  it('accepts identical outputs and float noise within 1e-4', () => {
    expect(compareGolden(golden, golden.outputs)).toBeNull();
    expect(
      compareGolden(golden, {
        label: [0, 1],
        probabilities: [
          [0.90005, 0.1],
          [0.2, 0.8],
        ],
      }),
    ).toBeNull();
  });
  it('rejects a flipped label, drift above 1e-4, wrong shape, and never loosens the tolerance', () => {
    expect(
      compareGolden(golden, { label: [1, 1], probabilities: golden.outputs.probabilities }),
    ).toMatch(/label/);
    expect(
      compareGolden(golden, {
        label: [0, 1],
        probabilities: [
          [0.9002, 0.1],
          [0.2, 0.8],
        ],
      }),
    ).toMatch(/probabilities/);
    expect(compareGolden(golden, { label: [0], probabilities: [] })).toMatch(/rows/);
    expect(
      compareGolden(
        { ...golden, tolerance: { probabilities: 0.5 } },
        {
          label: [0, 1],
          probabilities: [
            [0.91, 0.1],
            [0.2, 0.8],
          ],
        },
      ),
    ).toMatch(/tolerance 1e-4/);
  });
});

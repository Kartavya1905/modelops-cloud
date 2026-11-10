import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, judge } from '../../src/modules/evaluation/evaluation';
import { streamEntries } from '../../src/modules/monitoring/events.consumer';
import { performanceOf, rocAuc } from '../../src/modules/monitoring/monitoring.service';
import { inspectCsv } from '../../src/modules/registry/datasets';

const m = (rocAucValue: number, logLoss: number) => ({
  rows: 1000,
  accuracy: 0.8,
  f1: 0.6,
  rocAuc: rocAucValue,
  logLoss,
});

describe('evaluation gate (FR-32)', () => {
  it('first model: only the absolute floor applies', () => {
    expect(judge(DEFAULT_POLICY, m(0.71, 0.5), null).map((c) => [c.rule, c.passed])).toEqual([
      ['minRocAuc', true],
    ]);
    expect(judge(DEFAULT_POLICY, m(0.69, 0.5), null)[0]?.passed).toBe(false);
  });

  it.each([
    ['better on both', m(0.86, 0.36), true],
    ['slightly worse, within tolerance', m(0.851, 0.375), true],
    ['AUC drops too much', m(0.83, 0.36), false],
    ['log loss rises too much', m(0.86, 0.39), false],
  ])('against a champion (AUC 0.86, log loss 0.36): %s', (_name, candidate, passes) => {
    const checks = judge(DEFAULT_POLICY, candidate, m(0.86, 0.36));
    expect(checks.map((c) => c.rule)).toEqual(['minRocAuc', 'maxRocAucDrop', 'maxLogLossIncrease']);
    expect(checks.every((c) => c.passed)).toBe(passes);
  });

  it('explains every rule with numbers', () => {
    const [, drop] = judge(DEFAULT_POLICY, m(0.83, 0.36), m(0.86, 0.36));
    expect(drop?.detail).toBe('ROC-AUC 0.8300 vs champion 0.8600 (drop 0.0300, allowed 0.0100)');
  });
});

describe('measured performance (FR-36)', () => {
  it('ROC-AUC matches hand-computed values, with ties averaged', () => {
    const pairs = (xs: [number, boolean][]) => xs.map(([score, positive]) => ({ score, positive }));
    expect(
      rocAuc(
        pairs([
          [0.9, true],
          [0.8, true],
          [0.2, false],
          [0.1, false],
        ]),
      ),
    ).toBe(1);
    expect(
      rocAuc(
        pairs([
          [0.1, true],
          [0.9, false],
        ]),
      ),
    ).toBe(0);
    expect(
      rocAuc(
        pairs([
          [0.5, true],
          [0.5, false],
        ]),
      ),
    ).toBe(0.5);
    // 3 positives, 2 negatives; pairs won: (0.8>0.3,0.8>0.6, 0.7>0.3,0.7>0.6, 0.4>0.3) = 5 of 6
    expect(
      rocAuc(
        pairs([
          [0.8, true],
          [0.7, true],
          [0.4, true],
          [0.6, false],
          [0.3, false],
        ]),
      ),
    ).toBeCloseTo(5 / 6);
    expect(rocAuc(pairs([[0.9, true]]))).toBeNull();
  });

  it('accuracy and F1 for the positive class', () => {
    const at = new Date();
    const rows = [
      { createdAt: at, predicted: '1', truth: '1', score: 0.9 }, // tp
      { createdAt: at, predicted: '1', truth: '0', score: 0.6 }, // fp
      { createdAt: at, predicted: '0', truth: '1', score: 0.4 }, // fn
      { createdAt: at, predicted: '0', truth: '0', score: 0.1 }, // tn
    ];
    expect(performanceOf(rows, '1')).toEqual({ labelled: 4, accuracy: 0.5, f1: 0.5, rocAuc: 0.75 });
    expect(performanceOf([], '1')).toEqual({ labelled: 0, accuracy: null, f1: null, rocAuc: null });
  });
});

describe('dataset CSV checks', () => {
  const csv = (text: string) => Buffer.from(text, 'utf8');
  it('reads the header and counts rows', () => {
    expect(inspectCsv(csv('a,b,churned\n1,2,0\n3,4,1\n'))).toEqual({
      columns: ['a', 'b', 'churned'],
      rows: 2,
    });
  });
  it.each([
    ['empty', ''],
    ['header only', 'a,b\n'],
    ['bad column name', 'a,b c\n1,2\n'],
    ['duplicate columns', 'a,a\n1,2\n'],
    ['ragged row', 'a,b\n1,2\n3\n'],
  ])('rejects %s', (_name, text) => {
    expect(() => inspectCsv(csv(text))).toThrow();
  });
});

describe('event stream replies (XREADGROUP)', () => {
  const entries = [
    ['1-0', ['type', 'prediction', 'id', 'a']],
    ['1-1', ['type', 'feedback', 'id', 'a']],
  ];
  it('reads the RESP2 shape: a list of [stream, entries] pairs', () => {
    expect(streamEntries([['mo:events', entries]])).toEqual(entries);
  });
  it('reads the RESP3 shape: one [stream, entries] pair', () => {
    expect(streamEntries(['mo:events', entries])).toEqual(entries);
  });
  it('treats "nothing new" as no entries', () => {
    expect(streamEntries(null)).toEqual([]);
    expect(streamEntries([])).toEqual([]);
    expect(streamEntries([['mo:events', []]])).toEqual([]);
  });
});

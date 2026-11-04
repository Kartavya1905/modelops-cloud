import type { RunComparison } from '@modelops/api-contract';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { bestIndex, CompareView } from '@/features/ml/compare-page';
import { renderWithClient } from './utils';

function run(id: string, metrics: Record<string, number>, params: Record<string, string> = {}) {
  return {
    runId: id.padEnd(32, '0'),
    name: `run-${id}`,
    status: 'FINISHED' as const,
    startTime: null,
    endTime: null,
    durationMs: null,
    framework: 'SKLEARN_ONNX' as const,
    dataset: null,
    metrics,
    params,
    registeredAs: [],
    tags: {},
    series: {},
  };
}

const comparison: RunComparison = {
  runs: [
    run('a', { test_roc_auc: 0.81, test_log_loss: 0.4 }, { lr: '0.1', model: 'GBM' }),
    run('b', { test_roc_auc: 0.86, test_log_loss: 0.35 }, { lr: '0.05', model: 'GBM' }),
  ],
  metricKeys: ['test_log_loss', 'test_roc_auc'],
  differingParams: ['lr'],
};

describe('bestIndex', () => {
  it('picks the highest value for higher-is-better metrics', () => {
    expect(bestIndex(comparison, 'test_roc_auc')).toBe(1);
  });
  it('picks the lowest value for loss-like metrics', () => {
    expect(bestIndex(comparison, 'test_log_loss')).toBe(1);
  });
  it('returns -1 when fewer than two runs report the metric', () => {
    expect(bestIndex(comparison, 'test_f1')).toBe(-1);
  });
});

describe('CompareView', () => {
  it('marks the best value per metric for screen readers too, and lists only differing params', () => {
    renderWithClient(<CompareView comparison={comparison} />);
    const aucRow = screen.getByRole('row', { name: /ROC-AUC/ });
    expect(within(aucRow).getByText('0.8600').parentElement).toHaveTextContent('(best)');
    expect(within(aucRow).getByText('0.8100')).not.toHaveTextContent('(best)');
    expect(screen.getByRole('row', { name: /^lr/ })).toBeInTheDocument();
    expect(screen.queryByRole('row', { name: /^model/ })).not.toBeInTheDocument();
  });

  it('says so when no run logged per-epoch curves', () => {
    renderWithClient(<CompareView comparison={comparison} />);
    expect(screen.getByText('None of these runs logged per-epoch metrics.')).toBeInTheDocument();
  });
});

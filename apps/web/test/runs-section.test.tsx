import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RunsSection } from '@/features/ml/runs-section';
import { json, mockFetch, ORG_ID, renderWithClient, sessionAs } from './utils';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const PROJECT = '00000000-0000-4000-8000-0000000000aa';
const run = (n: number, registered = false) => ({
  runId: String(n).repeat(32).slice(0, 32),
  name: `run-${String(n)}`,
  status: 'FINISHED',
  startTime: new Date().toISOString(),
  endTime: null,
  durationMs: null,
  framework: n % 2 ? 'SKLEARN_ONNX' : 'PYTORCH_ONNX',
  dataset: { name: 'churn', version: 'seed7-n3000', sha256: 'ab'.repeat(32) },
  metrics: { test_roc_auc: 0.8 + n / 100 },
  params: {},
  registeredAs: registered
    ? [{ modelId: 'm1', modelName: 'Churn', versionId: 'v1', version: 1 }]
    : [],
});

function api(runs: unknown[]) {
  return mockFetch((req) => {
    const path = new URL(req.url).pathname;
    if (path.endsWith('/experiment')) {
      return json(200, {
        experimentId: '7',
        name: 'modelops/acme/churn',
        trainCommands: [
          'uv run --directory ml python -m modelops_ml.train_sklearn --experiment modelops/acme/churn',
        ],
      });
    }
    if (path.endsWith('/runs')) return json(200, { data: runs, nextCursor: null });
    return json(200, []);
  });
}

describe('RunsSection', () => {
  it('with no runs, shows the exact command that trains into this project', async () => {
    api([]);
    renderWithClient(<RunsSection orgId={ORG_ID} projectId={PROJECT} />, {
      session: sessionAs('ML_ENGINEER'),
    });
    expect(await screen.findByText('No training runs yet')).toBeInTheDocument();
    expect(await screen.findByText(/--experiment modelops\/acme\/churn/)).toBeInTheDocument();
  });

  it('lists runs with framework, AUC and registry badges; Viewers get no Register button', async () => {
    api([run(1, true), run(2)]);
    renderWithClient(<RunsSection orgId={ORG_ID} projectId={PROJECT} />, {
      session: sessionAs('VIEWER'),
    });
    expect(await screen.findByText('run-1')).toBeInTheDocument();
    expect(screen.getByText('Churn v1')).toBeInTheDocument();
    expect(screen.getByText('0.8100')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Register' })).not.toBeInTheDocument();
  });

  it('enables Compare only with 2+ runs selected and links to them', async () => {
    api([run(1), run(2), run(3)]);
    renderWithClient(<RunsSection orgId={ORG_ID} projectId={PROJECT} />, {
      session: sessionAs('ML_ENGINEER'),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('checkbox', { name: 'Select run-1 for comparison' }));
    expect(screen.getByRole('button', { name: 'Compare' })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'Select run-3 for comparison' }));
    await waitFor(() => {
      const link = screen.getByRole('link', { name: 'Compare (2)' });
      expect(link.getAttribute('href')).toBe(
        `/orgs/${ORG_ID}/projects/${PROJECT}/compare?ids=${run(1).runId},${run(3).runId}`,
      );
    });
    expect(screen.getAllByRole('button', { name: 'Register' })).toHaveLength(3);
  });
});

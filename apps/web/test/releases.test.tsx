import type { EndpointDetail, RevisionSummary } from '@modelops/api-contract';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ReleasePanel, rollbackTargets, TrafficSplit } from '@/features/deployments/releases';
import { json, mockFetch, ORG_ID, renderWithClient, sessionAs } from './utils';

const rev = (
  n: number,
  state: RevisionSummary['state'],
  readyAt: string | null,
): RevisionSummary => ({
  id: `00000000-0000-4000-8000-00000000000${String(n)}`,
  endpointId: 'ep',
  revisionNumber: n,
  state,
  modelVersion: {
    id: `mv${String(n)}`,
    modelId: 'm',
    modelName: 'Churn',
    version: n,
    framework: 'SKLEARN_ONNX',
  },
  failureCode: null,
  failureDetail: null,
  createdAt: '2026-11-10T10:00:00Z',
  updatedAt: '2026-11-10T10:00:00Z',
  readyAt,
  strategy: 'IMMEDIATE',
  canaryWeight: null,
  rollbackOfId: null,
  stableAt: readyAt,
});

const stable = rev(3, 'READY', '2026-11-10T10:03:00Z');
const canary = rev(4, 'READY', '2026-11-10T10:04:00Z');
function endpoint(over: Partial<EndpointDetail> = {}): EndpointDetail {
  return {
    id: '00000000-0000-4000-8000-0000000000e1',
    projectId: 'p',
    slug: 'churn',
    name: 'Churn',
    description: null,
    environment: 'STAGING',
    rateLimitRps: 50,
    captureInputs: false,
    rowVersion: 7,
    invokeUrl: 'http://127.0.0.1:18088/v1/endpoints/churn/predict',
    stableRevision: stable,
    inProgressRevision: null,
    canary: { revision: canary, weight: 10, startedAt: null, latestCheck: null, eligible: false },
    createdAt: '2026-11-10T09:00:00Z',
    project: { id: 'p', name: 'Churn', slug: 'churn' },
    revisions: [
      canary,
      stable,
      rev(2, 'DRAINING', '2026-11-10T10:02:00Z'),
      rev(1, 'RETIRED', '2026-11-10T10:01:00Z'),
      rev(5, 'FAILED', null),
    ],
    ...over,
  };
}

describe('rollbackTargets', () => {
  it('offers earlier revisions that served, newest first, never the stable or the canary', () => {
    expect(rollbackTargets(endpoint()).map((r) => r.revisionNumber)).toEqual([2, 1]);
  });

  it('never offers an aborted canary (it was never the stable revision)', () => {
    const aborted = { ...rev(6, 'DRAINING', '2026-11-10T10:06:00Z'), stableAt: null };
    const e = endpoint({
      canary: null,
      revisions: [aborted, stable, rev(2, 'DRAINING', '2026-11-10T10:02:00Z')],
    });
    expect(rollbackTargets(e).map((r) => r.revisionNumber)).toEqual([2]);
  });
});

describe('TrafficSplit', () => {
  it('says the split in words, not only colours', () => {
    renderWithClient(<TrafficSplit endpoint={endpoint()} />);
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe(
      'Traffic split: 90% to stable revision 3 · Churn v3, 10% to canary revision 4 · Churn v4',
    );
    expect(screen.getByTestId('traffic-split').textContent).toContain('Canary 10%');
  });
});

describe('ReleasePanel', () => {
  it('promote waits for a passing check; actions send the endpoint ETag', async () => {
    const fetchSpy = mockFetch(() => json(200, endpoint()));
    renderWithClient(<ReleasePanel orgId={ORG_ID} endpoint={endpoint()} />, {
      session: sessionAs('ML_ENGINEER'),
    });
    expect(screen.getByRole('button', { name: 'Promote' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Abort canary' }));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const req = fetchSpy.mock.calls[0]?.[0] as Request;
    expect(req.url).toContain('/canary/abort');
    expect(req.headers.get('if-match')).toBe('W/"7"');
  });

  it('enables promote after a passing check', () => {
    const check = {
      id: 'c',
      revisionId: canary.id,
      verdict: 'PASS' as const,
      canary: { requests: 300, errors: 0, errorRate: 0, p95Ms: 4 },
      stable: { requests: 2700, errors: 0, errorRate: 0, p95Ms: 4.2 },
      fallbacks: 0,
      windowSeconds: 600,
      checks: [{ rule: 'minRequests', passed: true, detail: '300 canary requests (need 200)' }],
      aborted: false,
      createdAt: '2026-11-10T10:10:00Z',
    };
    renderWithClient(
      <ReleasePanel
        orgId={ORG_ID}
        endpoint={endpoint({
          canary: {
            revision: canary,
            weight: 10,
            startedAt: null,
            latestCheck: check,
            eligible: true,
          },
        })}
      />,
      { session: sessionAs('ADMIN') },
    );
    expect(screen.getByRole('button', { name: 'Promote' })).toBeEnabled();
    expect(screen.getByText('Healthy: eligible to promote')).toBeInTheDocument();
    expect(screen.getByText('300 canary requests (need 200)')).toBeInTheDocument();
  });

  it('rollback asks first, and says whether the target is warm', async () => {
    renderWithClient(<ReleasePanel orgId={ORG_ID} endpoint={endpoint()} />, {
      session: sessionAs('OWNER'),
    });
    await userEvent.click(screen.getByRole('button', { name: 'Roll back' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('traffic moves to it in seconds');
    expect(dialog.textContent).toContain('The running canary is aborted');
  });

  it('on production, engineers see the split but no release actions', () => {
    renderWithClient(
      <ReleasePanel orgId={ORG_ID} endpoint={endpoint({ environment: 'PRODUCTION' })} />,
      { session: sessionAs('ML_ENGINEER') },
    );
    expect(screen.getByRole('img')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Roll back' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Promote' })).toBeNull();
  });
});

import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { describe as describeMetrics, toRows } from '@/features/deployments/dashboard';
import { display, parseRow, Playground } from '@/features/deployments/playground';
import { json, mockFetch, ORG_ID, problem, renderWithClient } from './utils';

const ENDPOINT = '00000000-0000-4000-8000-0000000000e1';
const FEATURES = ['tenure_months', 'monthly_charges', 'usage_hours'];
const info = {
  ready: true,
  features: FEATURES,
  classes: [0, 1],
  examples: [
    { tenure_months: 14, monthly_charges: 72.5, usage_hours: 41.2 },
    { tenure_months: 3, monthly_charges: 99, usage_hours: 5 },
  ],
  modelName: 'Churn',
  modelVersion: 4,
  revisionId: '8e1c0000-0000-4000-8000-000000000001',
};
const result = {
  predictionIds: ['p1'],
  model: { name: 'Churn', version: 4, framework: 'PYTORCH_ONNX' },
  revisionId: info.revisionId,
  outputs: [{ label: 1, probabilities: { '0': 0.21, '1': 0.79 } }],
  latencyMs: 6.4,
};

describe('parseRow (signature-driven form validation)', () => {
  it('builds one row in signature order', () => {
    expect(
      parseRow(FEATURES, { usage_hours: '1.5', tenure_months: '2', monthly_charges: '-3' }),
    ).toEqual({
      row: { tenure_months: 2, monthly_charges: -3, usage_hours: 1.5 },
    });
  });
  it('requires every feature and a finite number', () => {
    expect(
      parseRow(FEATURES, { tenure_months: '', monthly_charges: 'abc', usage_hours: 'Infinity' }),
    ).toEqual({
      errors: {
        tenure_months: 'Required',
        monthly_charges: 'Enter a number',
        usage_hours: 'Enter a number',
      },
    });
  });
});

describe('display', () => {
  it('hides float32 noise but keeps the float32 value', () => {
    expect(display(82.55000305175781)).toBe('82.55');
    expect(Math.fround(Number(display(29.899999618530273)))).toBe(Math.fround(29.899999618530273));
    expect(display(14)).toBe('14');
  });
});

describe('Playground', () => {
  it('renders one field per feature, prefilled from a golden example, and shows the prediction', async () => {
    const sent: unknown[] = [];
    mockFetch(async (req) => {
      if (req.method === 'POST') {
        sent.push(await req.json());
        return json(200, result);
      }
      return json(200, info);
    });
    renderWithClient(
      <Playground orgId={ORG_ID} endpointId={ENDPOINT} revisionId={info.revisionId} />,
    );

    const tenure = await screen.findByLabelText('tenure_months');
    expect(tenure).toHaveValue('14');
    await userEvent.selectOptions(screen.getByLabelText('Start from a golden example'), '1');
    expect(tenure).toHaveValue('3');
    await userEvent.clear(tenure);
    await userEvent.type(tenure, '7');
    await userEvent.click(screen.getByRole('button', { name: 'Predict' }));

    expect(await screen.findByTestId('playground-label')).toHaveTextContent('1');
    expect(screen.getByText('79.0%')).toBeInTheDocument();
    expect(sent).toEqual([{ inputs: [{ tenure_months: 7, monthly_charges: 99, usage_hours: 5 }] }]);
  });

  it('blocks invalid input in the browser and maps the gateway’s field errors back to fields', async () => {
    let posts = 0;
    mockFetch((req) => {
      if (req.method === 'POST') {
        posts++;
        return problem(400, 'VALIDATION_FAILED', 'Inputs do not match the model signature', {
          errors: [{ field: 'inputs[0].usage_hours', message: 'must be a finite number' }],
        });
      }
      return json(200, info);
    });
    renderWithClient(
      <Playground orgId={ORG_ID} endpointId={ENDPOINT} revisionId={info.revisionId} />,
    );
    const charges = await screen.findByLabelText('monthly_charges');
    await userEvent.clear(charges);
    await userEvent.click(screen.getByRole('button', { name: 'Predict' }));
    expect(await screen.findByText('Required')).toBeInTheDocument();
    expect(posts).toBe(0); // never sent

    await userEvent.type(charges, '50');
    await userEvent.click(screen.getByRole('button', { name: 'Predict' }));
    expect(await screen.findByText('must be a finite number')).toBeInTheDocument();
    expect(screen.getByLabelText('usage_hours')).toHaveAttribute('aria-invalid', 'true');
  });

  it('explains what to do when nothing is deployed', async () => {
    mockFetch(() => json(200, { ...info, ready: false, features: [], examples: [] }));
    renderWithClient(<Playground orgId={ORG_ID} endpointId={ENDPOINT} revisionId={null} />);
    expect(await screen.findByText(/Deploy a version to try it/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Predict' })).toBeNull());
  });
});

describe('dashboard helpers', () => {
  const line = (name: string, vs: (number | null)[]) => ({
    name,
    points: vs.map((v, i) => ({ t: 100 + i * 30, v })),
  });
  it('pivots series into chart rows and keeps gaps as null', () => {
    expect(toRows([line('v1', [1, null]), line('v2', [0.5, 2])])).toEqual([
      { t: 100, v1: 1, v2: 0.5 },
      { t: 130, v1: null, v2: 2 },
    ]);
  });
  it('summarizes for screen readers', () => {
    const text = describeMetrics({
      range: '1h',
      stepSeconds: 30,
      start: 0,
      end: 3600,
      summary: {
        requests: 1200,
        serverErrors: 12,
        clientErrors: 3,
        playground: 0,
        p95Ms: 8.25,
        avgRps: 0.333,
      },
      rps: [],
      latency: [],
      errorRate: [],
      status: [],
    });
    expect(text).toBe(
      '1,200 requests in the last 1h, 0.333 per second on average, 1.0% server errors, p95 latency 8.3 ms.',
    );
  });
});

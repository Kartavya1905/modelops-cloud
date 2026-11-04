/**
 * Creates real runs in the real MLflow server (through its REST API and artifact proxy), shaped
 * like the ones ml/modelops_ml produces, plus deliberately broken variants for negative tests.
 */
const mlflowUrl = () => process.env.MO_MLFLOW_URL ?? 'http://127.0.0.1:15000';

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${mlflowUrl()}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? null : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`MLflow ${method} ${path} -> ${String(res.status)} ${text}`);
  return (text ? JSON.parse(text) : {}) as T;
}

export const VALID_SIGNATURE = {
  signatureVersion: 1,
  task: 'binary_classification',
  inputs: [
    {
      name: 'features',
      dtype: 'float32',
      shape: [-1, 6],
      features: [
        'tenure_months',
        'monthly_charges',
        'support_tickets',
        'contract_type',
        'late_payments',
        'usage_hours',
      ],
    },
  ],
  outputs: [
    { name: 'label', dtype: 'int64', shape: [-1] },
    { name: 'probabilities', dtype: 'float32', shape: [-1, 2], classes: [0, 1] },
  ],
};

export const DATASET_SHA = 'ab'.repeat(32);

export interface RunSpec {
  name?: string;
  status?: 'FINISHED' | 'RUNNING';
  framework?: string | null;
  datasetSha?: string;
  metrics?: Record<string, number>;
  params?: Record<string, string>;
  series?: Record<string, number[]>;
  /** bundle files under model/; `null` omits a file */
  files?: Partial<Record<'model.onnx' | 'signature.json' | 'golden_examples.json', string | null>>;
}

export async function createRun(experimentId: string, spec: RunSpec = {}): Promise<string> {
  const now = Date.now();
  const tags = [
    { key: 'mlflow.runName', value: spec.name ?? 'test-run' },
    { key: 'modelops.bundle.path', value: 'model' },
    { key: 'modelops.dataset.name', value: 'churn' },
    { key: 'modelops.dataset.version', value: 'seed7-n1000' },
    { key: 'modelops.dataset.sha256', value: spec.datasetSha ?? DATASET_SHA },
    { key: 'modelops.dataset.rows', value: '1000' },
    ...(spec.framework === null
      ? []
      : [{ key: 'modelops.framework', value: spec.framework ?? 'SKLEARN_ONNX' }]),
  ];
  const { run } = await call<{ run: { info: { run_id: string; artifact_uri: string } } }>(
    'POST',
    '/api/2.0/mlflow/runs/create',
    { experiment_id: experimentId, start_time: now, run_name: spec.name ?? 'test-run', tags },
  );
  const runId = run.info.run_id;

  const metrics = Object.entries(spec.metrics ?? { test_roc_auc: 0.85, test_accuracy: 0.82 }).map(
    ([key, value]) => ({ key, value, timestamp: now, step: 0 }),
  );
  for (const [key, values] of Object.entries(spec.series ?? {})) {
    values.forEach((value, step) => metrics.push({ key, value, timestamp: now + step, step }));
  }
  const params = Object.entries(
    spec.params ?? { model: 'GradientBoostingClassifier', 'dataset.seed': '7' },
  ).map(([key, value]) => ({ key, value }));
  await call('POST', '/api/2.0/mlflow/runs/log-batch', { run_id: runId, metrics, params });

  const files = {
    'model.onnx': 'not-a-real-onnx-graph (validated in M4)',
    'signature.json': JSON.stringify(VALID_SIGNATURE),
    'golden_examples.json': JSON.stringify({ inputs: [[1, 2, 3, 0, 0, 40]], outputs: {} }),
    ...spec.files,
  };
  const artifactRoot = run.info.artifact_uri.replace('mlflow-artifacts:/', '');
  for (const [name, content] of Object.entries(files)) {
    if (content === null) continue;
    const res = await fetch(
      `${mlflowUrl()}/api/2.0/mlflow-artifacts/artifacts/${artifactRoot}/model/${name}`,
      {
        method: 'PUT',
        body: content,
      },
    );
    if (!res.ok) throw new Error(`artifact upload failed: ${String(res.status)}`);
  }

  if ((spec.status ?? 'FINISHED') === 'FINISHED') {
    await call('POST', '/api/2.0/mlflow/runs/update', {
      run_id: runId,
      status: 'FINISHED',
      end_time: now + 1000,
    });
  }
  return runId;
}

export async function deleteRun(runId: string): Promise<void> {
  await call('POST', '/api/2.0/mlflow/runs/delete', { run_id: runId });
}

export async function getRegisteredModel(name: string) {
  return call<{
    registered_model: {
      name: string;
      tags?: { key: string; value: string }[];
      latest_versions?: { version: string; run_id: string }[];
    };
  }>('GET', `/api/2.0/mlflow/registered-models/get?name=${encodeURIComponent(name)}`);
}

export async function getExperiment(id: string) {
  return call<{ experiment: { name: string; tags?: { key: string; value: string }[] } }>(
    'GET',
    `/api/2.0/mlflow/experiments/get?experiment_id=${id}`,
  );
}

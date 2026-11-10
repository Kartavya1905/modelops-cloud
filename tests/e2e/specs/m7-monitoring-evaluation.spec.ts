import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { expectNoSeriousA11yViolations } from '../support/a11y';

/**
 * Milestone 7 slice in the browser: datasets -> a version with training lineage -> evaluation gate
 * -> champion -> deploy with input capture -> shifted traffic + feedback (J3 demo script) -> drift
 * heatmap and measured performance on the endpoint page.
 */
const ROOT = join(import.meta.dirname, '..', '..', '..');
const BUNDLES = join(ROOT, 'tests', 'fixtures', 'bundles');
const TMP = mkdtempSync(join(tmpdir(), 'mo-e2e-m7-'));
const PASSWORD = 'correct horse battery staple';

function csv(name: string, args: string[]): string {
  const out = join(TMP, `${name}.csv`);
  execFileSync(
    'uv',
    [
      'run',
      '--directory',
      join(ROOT, 'ml'),
      'python',
      '-m',
      'modelops_ml.datasets',
      ...args,
      '--out',
      out,
    ],
    { stdio: 'pipe', timeout: 180_000 },
  );
  return out;
}

async function uploadDataset(page: Page, file: string, name: string, version: string) {
  await page.getByRole('button', { name: 'Upload dataset' }).click();
  const dialog = page.getByRole('dialog', { name: 'Upload a dataset' });
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByLabel('Version').fill(version);
  await dialog.getByLabel('CSV file').setInputFiles(file);
  await dialog.getByRole('button', { name: 'Upload' }).click();
  await expect(
    page.getByRole('row', { name: new RegExp(`${name}.*${version}.*Stored`) }),
  ).toBeVisible();
}

test('evaluation gate crowns a champion; drift and measured performance show separately', async ({
  page,
}) => {
  test.setTimeout(420_000);
  await page.goto('/register');
  await page.getByLabel('Name').fill('Mo Nitor');
  await page.getByLabel('Email').fill(`mo-${randomUUID().slice(0, 8)}@example.com`);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('button', { name: 'New project' }).first().click();
  const projectName = `Watchful ${randomUUID().slice(0, 6)}`;
  await page.getByRole('dialog').getByLabel('Name').fill(projectName);
  await page.getByRole('dialog').getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('link', { name: projectName }).click();
  await expect(page.getByRole('heading', { name: projectName })).toBeVisible();
  const projectUrl = page.url();

  // ---- datasets: the fixture's training data (seed 3) and a held-out set (seed 11) --------------
  await uploadDataset(
    page,
    csv('train', ['--rows', '1500', '--seed', '3']),
    'churn',
    'seed3-n1500',
  );
  await uploadDataset(
    page,
    csv('holdout', ['--rows', '2000', '--seed', '11']),
    'churn-holdout',
    'seed11-n2000',
  );
  await expectNoSeriousA11yViolations(page);

  // ---- a validated version that records what it was trained on -----------------------------
  await page.getByRole('button', { name: 'New model' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('Churn');
  await page.getByRole('dialog').getByRole('button', { name: 'Create model' }).click();
  await page.getByRole('link', { name: /Churn/ }).first().click();
  await expect(page.getByRole('heading', { name: 'Churn', exact: true })).toBeVisible();
  const modelUrl = page.url();
  await page.getByRole('button', { name: 'Upload bundle' }).click();
  const up = page.getByRole('dialog', { name: 'Upload a bundle' });
  await up.getByLabel('Trained on (optional)').selectOption({ label: 'churn seed3-n1500' });
  await up.getByLabel('model.onnx').setInputFiles(join(BUNDLES, 'sklearn', 'model.onnx'));
  await up.getByLabel('signature.json').setInputFiles(join(BUNDLES, 'sklearn', 'signature.json'));
  await up
    .getByLabel('golden_examples.json')
    .setInputFiles(join(BUNDLES, 'sklearn', 'golden_examples.json'));
  await up.getByRole('button', { name: 'Upload and validate' }).click();
  await expect(page.getByText('Passed all checks')).toBeVisible({ timeout: 90_000 });

  // ---- evaluation gate -> champion -----------------------------------------------------------
  await page.goto(modelUrl);
  await page.getByLabel('Held-out dataset').selectOption({ label: 'churn-holdout seed11-n2000' });
  await page.getByRole('button', { name: 'Evaluate' }).click();
  const report = page
    .getByRole('list', { name: 'Evaluation reports' })
    .getByRole('listitem')
    .first();
  await expect(report.getByText('Gate passed')).toBeVisible({ timeout: 60_000 });
  await expect(report.getByText(/ROC-AUC 0\.\d{4} vs minimum 0\.7000/)).toBeVisible();
  await report.getByRole('button', { name: 'Make champion' }).click();
  await expect(page.getByRole('row', { name: /v1.*Champion/ })).toBeVisible();
  await expect(report.getByRole('button', { name: 'Make champion' })).toHaveCount(0);
  await expectNoSeriousA11yViolations(page);

  // ---- deploy with input capture, then shifted traffic + feedback ----------------------------
  await page.goto(projectUrl);
  await page.getByRole('button', { name: 'New endpoint' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('Watched churn');
  await page.getByRole('dialog').getByRole('button', { name: 'Create endpoint' }).click();
  await expect(page.getByRole('heading', { name: 'Watched churn' })).toBeVisible();
  const endpointUrl = page.url();
  await page.getByRole('button', { name: 'Deploy' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Deploy' }).click();
  await expect(page.locator('[data-step="READY"]')).toHaveAttribute('data-state', 'done', {
    timeout: 120_000,
  });
  // A controlled checkbox: it flips when the PATCH (with If-Match) has been accepted.
  await page.getByLabel('Capture inputs for drift detection').click();
  await expect(page.getByLabel('Capture inputs for drift detection')).toBeChecked();

  await page.goto(projectUrl);
  await page.getByRole('button', { name: 'New API key' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('drift demo');
  await page.getByRole('dialog').getByRole('button', { name: 'Create key' }).click();
  const key = (await page.getByRole('dialog').locator('code').first().textContent()) ?? '';
  await page.getByRole('dialog').getByRole('button', { name: 'Done' }).click();
  execFileSync(
    process.execPath,
    [
      join(ROOT, 'scripts', 'demo-drift.mjs'),
      '--endpoint',
      'watched-churn',
      '--key',
      key,
      '--phase',
      'data',
      '--rows',
      '300',
    ],
    { stdio: 'pipe', timeout: 180_000 },
  );

  // ---- the endpoint page: drift heatmap and measured performance -----------------------------
  await page.goto(endpointUrl);
  const labelled = page.locator('[data-perf="Labelled"]');
  await expect(async () => {
    await page.reload();
    await expect(labelled).toHaveText('300 / 300', { timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Run drift check' }).click();
  await expect(page.getByTestId('drift-latest')).toContainText('300 requests', {
    timeout: 120_000,
  });
  const heat = page.getByRole('region', { name: 'Drift by feature and run' });
  await expect(
    heat
      .getByRole('row', { name: /monthly_charges/ })
      .locator('td')
      .first(),
  ).toHaveAttribute('data-drifted', 'true');
  await expect(
    heat
      .getByRole('row', { name: /tenure_months/ })
      .locator('td')
      .first(),
  ).toHaveAttribute('data-drifted', 'false');
  await expectNoSeriousA11yViolations(page);
});

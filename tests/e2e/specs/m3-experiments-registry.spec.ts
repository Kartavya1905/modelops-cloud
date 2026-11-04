import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { expectNoSeriousA11yViolations } from '../support/a11y';

/**
 * Milestone 3 vertical slice with REAL training:
 *   create project -> UI shows the experiment's training command -> run the actual training
 *   scripts (uv) into MLflow -> runs appear -> compare them -> create a model -> register a run
 *   as v1 -> version page shows status, signature and dataset lineage.
 */
const ML_DIR = join(import.meta.dirname, '..', '..', '..', 'ml');
const PASSWORD = 'correct horse battery staple';

function train(
  script: 'train_sklearn' | 'train_pytorch',
  experiment: string,
  extra: string[],
): void {
  execFileSync(
    'uv',
    [
      'run',
      '--directory',
      ML_DIR,
      'python',
      '-m',
      `modelops_ml.${script}`,
      '--experiment',
      experiment,
      '--rows',
      '3000',
      ...extra,
    ],
    { stdio: 'pipe', timeout: 180_000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } },
  );
}

test('train two models, compare their runs, register a version and inspect its lineage', async ({
  page,
}) => {
  test.setTimeout(240_000);

  // ---- account + project ---------------------------------------------------------------
  await page.goto('/register');
  await page.getByLabel('Name').fill('Mia Data');
  await page.getByLabel('Email').fill(`mia-${randomUUID().slice(0, 8)}@example.com`);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'New project' }).first().click();
  const projectName = `Churn ${randomUUID().slice(0, 6)}`;
  await page.getByRole('dialog').getByLabel('Name').fill(projectName);
  await page.getByRole('dialog').getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('link', { name: projectName }).click();

  // ---- the UI tells us how to train into this project ------------------------------------
  await expect(page.getByText('No training runs yet')).toBeVisible();
  const command = await page.locator('code').filter({ hasText: 'train_sklearn' }).textContent();
  const experiment = /--experiment (\S+)/.exec(command ?? '')?.[1];
  expect(experiment).toMatch(/^modelops\/[a-z0-9-]+\/churn-[a-z0-9]+$/);
  await expectNoSeriousA11yViolations(page);

  // ---- real training: scikit-learn GBM + PyTorch MLP -> ONNX -> MLflow ---------------------
  train('train_sklearn', experiment ?? '', ['--n-estimators', '40']);
  train('train_pytorch', experiment ?? '', ['--epochs', '5']);

  await page.getByRole('button', { name: 'Refresh runs' }).click();
  const runRows = page.getByRole('row').filter({ has: page.getByRole('checkbox') });
  await expect(runRows).toHaveCount(2);
  await expect(page.getByText('scikit-learn → ONNX').first()).toBeVisible();
  await expect(page.getByText('PyTorch → ONNX').first()).toBeVisible();

  // ---- compare --------------------------------------------------------------------------
  for (const box of await page.getByRole('checkbox', { name: /Select .* for comparison/ }).all())
    await box.check();
  await page.getByRole('link', { name: 'Compare (2)' }).click();
  await expect(page.getByRole('heading', { name: 'Compare runs' })).toBeVisible();
  await expect(page.getByRole('row', { name: /ROC-AUC/ })).toBeVisible();
  await expect(page.getByRole('img', { name: /Line chart of loss per epoch/ })).toBeVisible();
  await expect(
    page.getByRole('img', { name: /Line chart/ }).locator('.recharts-line'),
  ).not.toHaveCount(0);
  await expect(page.getByText('(best)').first()).toBeAttached();
  await expectNoSeriousA11yViolations(page);
  await page.getByRole('link', { name: 'Back to project' }).click();

  // ---- model + register a version ------------------------------------------------------------
  await page.getByRole('button', { name: 'New model' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('Churn classifier');
  await page.getByRole('dialog').getByRole('button', { name: 'Create model' }).click();
  await expect(page.getByRole('link', { name: /Churn classifier/ })).toBeVisible();

  await runRows
    .filter({ hasText: 'sklearn-gbm' })
    .getByRole('button', { name: 'Register' })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Register a model version' });
  await expect(dialog.getByLabel('Model')).toContainText('Churn classifier (next: v1)');
  await dialog.getByRole('button', { name: 'Register version' }).click();

  // ---- version page: status, lineage, signature --------------------------------------------
  await expect(page.getByRole('heading', { name: 'Churn classifier v1' })).toBeVisible();
  await expect(page.getByText('Awaiting validation').first()).toBeVisible();
  await expect(page.getByText('seed7-n3000')).toBeVisible();
  for (const feature of ['tenure_months', 'monthly_charges', 'usage_hours']) {
    await expect(page.getByRole('cell', { name: feature, exact: true })).toBeVisible();
  }
  await expect(page.getByText('MLflow version 1')).toBeVisible();
  await expectNoSeriousA11yViolations(page);

  // registering the same run again is not offered (and the API would refuse it)
  await page.getByRole('link', { name: 'Churn classifier' }).click();
  await expect(page.getByRole('link', { name: 'v1', exact: true })).toBeVisible();
});

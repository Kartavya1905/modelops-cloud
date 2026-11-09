import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { expectNoSeriousA11yViolations } from '../support/a11y';

/**
 * Milestone 5 acceptance: click Deploy -> READY -> a request with an API key returns the correct
 * prediction tagged with the model version. Real everything: the worker starts a model-server
 * container through the Docker socket proxy; the request goes through the real gateway.
 */
const BUNDLES = join(import.meta.dirname, '..', '..', 'fixtures', 'bundles');
const PASSWORD = 'correct horse battery staple';
const GATEWAY = process.env.E2E_GATEWAY_URL ?? 'http://127.0.0.1:18088';

test('deploy a validated model and call it with an API key', async ({ page }) => {
  test.setTimeout(240_000);

  await page.goto('/register');
  await page.getByLabel('Name').fill('Dee Ploy');
  await page.getByLabel('Email').fill(`dee-${randomUUID().slice(0, 8)}@example.com`);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'New project' }).first().click();
  const projectName = `Serving ${randomUUID().slice(0, 6)}`;
  await page.getByRole('dialog').getByLabel('Name').fill(projectName);
  await page.getByRole('dialog').getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('link', { name: projectName }).click();
  await expect(page.getByRole('heading', { name: projectName })).toBeVisible();
  const projectUrl = page.url();

  // ---- a validated version (M4) ------------------------------------------------------------
  await page.getByRole('button', { name: 'New model' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('Churn');
  await page.getByRole('dialog').getByRole('button', { name: 'Create model' }).click();
  await page.getByRole('link', { name: /Churn/ }).first().click();
  await page.getByRole('button', { name: 'Upload bundle' }).click();
  const upload = page.getByRole('dialog', { name: 'Upload a bundle' });
  await upload.getByLabel('Framework').selectOption({ label: 'PyTorch → ONNX' });
  await upload.getByLabel('model.onnx').setInputFiles(join(BUNDLES, 'pytorch', 'model.onnx'));
  await upload
    .getByLabel('signature.json')
    .setInputFiles(join(BUNDLES, 'pytorch', 'signature.json'));
  await upload
    .getByLabel('golden_examples.json')
    .setInputFiles(join(BUNDLES, 'pytorch', 'golden_examples.json'));
  await upload.getByRole('button', { name: 'Upload and validate' }).click();
  await expect(page.getByText('Passed all checks')).toBeVisible({ timeout: 90_000 });

  // ---- endpoint + deploy -------------------------------------------------------------------
  await page.goto(projectUrl);
  await page.getByRole('button', { name: 'New endpoint' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('Churn staging');
  await page.getByRole('dialog').getByRole('button', { name: 'Create endpoint' }).click();
  await expect(page.getByRole('heading', { name: 'Churn staging' })).toBeVisible();
  await expect(page.getByText('Nothing deployed yet')).toBeVisible();
  await expectNoSeriousA11yViolations(page);

  await page.getByRole('button', { name: 'Deploy' }).click();
  const dialog = page.getByRole('dialog', { name: /Deploy to/ });
  await expect(dialog.getByLabel('Version')).toContainText('v1 · PyTorch');
  await expectNoSeriousA11yViolations(page);
  await dialog.getByRole('button', { name: 'Deploy' }).click();

  const steps = page.getByRole('list', { name: 'Deployment progress' }).getByRole('listitem');
  await expect(steps.and(page.locator('[data-step="READY"]'))).toHaveAttribute(
    'data-state',
    'done',
    { timeout: 120_000 },
  );
  for (const step of ['REQUESTED', 'QUEUED', 'PROVISIONING', 'LOADING', 'VERIFYING']) {
    await expect(page.locator(`[data-step="${step}"]`)).toHaveAttribute('data-state', 'done');
  }
  await expect(page.getByText(/Golden examples reproduced/)).toBeVisible();
  await expect(page.getByText(/Revision 1: Churn v1/)).toBeVisible();
  await expect(page.getByText('curl -X POST')).toBeVisible();
  await expectNoSeriousA11yViolations(page);

  // ---- API key, shown once -----------------------------------------------------------------
  await page.goto(projectUrl);
  await page.getByRole('button', { name: 'New API key' }).click();
  const keyDialog = page.getByRole('dialog');
  await keyDialog.getByLabel('Name').fill('e2e client');
  await keyDialog.getByRole('button', { name: 'Create key' }).click();
  await expect(keyDialog.getByText('Copy your API key now')).toBeVisible();
  const key = (await keyDialog.locator('code').first().textContent()) ?? '';
  expect(key).toMatch(/^mo_[A-Z2-9]{10}_/);
  await expectNoSeriousA11yViolations(page);
  await keyDialog.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('cell', { name: /^mo_[A-Z2-9]{10}_…$/ })).toBeVisible();

  // ---- the client's view: a real HTTP call to the gateway ----------------------------------
  const signature = JSON.parse(
    readFileSync(join(BUNDLES, 'pytorch', 'signature.json'), 'utf8'),
  ) as {
    inputs: { features: string[] }[];
  };
  const golden = JSON.parse(
    readFileSync(join(BUNDLES, 'pytorch', 'golden_examples.json'), 'utf8'),
  ) as {
    inputs: number[][];
    outputs: { label: number[] };
  };
  const features = signature.inputs[0]?.features ?? [];
  const rows = golden.inputs
    .slice(0, 3)
    .map((r) => Object.fromEntries(features.map((f, i) => [f, r[i] ?? 0])));
  const res = await page.request.post(`${GATEWAY}/v1/endpoints/churn-staging/predict`, {
    headers: { authorization: `Bearer ${key}` },
    data: { inputs: rows },
  });
  expect(res.status()).toBe(200);
  expect(res.headers()['x-model-version']).toBe('1');
  const body = (await res.json()) as { outputs: { label: number }[]; model: { name: string } };
  expect(body.model.name).toBe('Churn');
  expect(body.outputs.map((o) => o.label)).toEqual(golden.outputs.label.slice(0, 3));

  const denied = await page.request.post(`${GATEWAY}/v1/endpoints/churn-staging/predict`, {
    headers: { authorization: 'Bearer mo_AAAAAAAAAA_' + 'x'.repeat(43) },
    data: { inputs: rows },
  });
  expect(denied.status()).toBe(401);
});

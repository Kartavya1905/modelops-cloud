import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { expectNoSeriousA11yViolations } from '../support/a11y';

/**
 * Milestone 4 vertical slice: upload real ONNX bundles through the UI and watch the sandboxed
 * validator decide. A real PyTorch bundle passes V1-V11; a pickle disguised as model.onnx is
 * rejected at V1 without ever being loaded. Needs the worker (`pnpm dev` runs it) and ml-worker.
 */
const BUNDLES = join(import.meta.dirname, '..', '..', 'fixtures', 'bundles');
const PASSWORD = 'correct horse battery staple';
const CHECKS = ['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8', 'V9', 'V10', 'V11'];

async function uploadBundle(
  page: Page,
  framework: 'scikit-learn → ONNX' | 'PyTorch → ONNX',
  dir: 'sklearn' | 'pytorch',
  model?: { name: string; mimeType: string; buffer: Buffer },
): Promise<void> {
  await page.getByRole('button', { name: 'Upload bundle' }).click();
  const dialog = page.getByRole('dialog', { name: 'Upload a bundle' });
  await dialog.getByLabel('Framework').selectOption({ label: framework });
  await dialog.getByLabel('model.onnx').setInputFiles(model ?? join(BUNDLES, dir, 'model.onnx'));
  await dialog.getByLabel('signature.json').setInputFiles(join(BUNDLES, dir, 'signature.json'));
  await dialog
    .getByLabel('golden_examples.json')
    .setInputFiles(join(BUNDLES, dir, 'golden_examples.json'));
  await expectNoSeriousA11yViolations(page);
  await dialog.getByRole('button', { name: 'Upload and validate' }).click();
}

test('uploaded bundles are validated in a sandbox: a real model passes, a pickle is rejected', async ({
  page,
}) => {
  test.setTimeout(180_000);

  await page.goto('/register');
  await page.getByLabel('Name').fill('Val Idator');
  await page.getByLabel('Email').fill(`val-${randomUUID().slice(0, 8)}@example.com`);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'New project' }).first().click();
  const projectName = `Uploads ${randomUUID().slice(0, 6)}`;
  await page.getByRole('dialog').getByLabel('Name').fill(projectName);
  await page.getByRole('dialog').getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('link', { name: projectName }).click();
  await page.getByRole('button', { name: 'New model' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('Uploaded churn');
  await page.getByRole('dialog').getByRole('button', { name: 'Create model' }).click();
  await page.getByRole('link', { name: /Uploaded churn/ }).click();
  await expect(page.getByRole('heading', { name: 'Uploaded churn' })).toBeVisible();

  // ---- a real PyTorch -> ONNX bundle passes every check ------------------------------------
  await uploadBundle(page, 'PyTorch → ONNX', 'pytorch');
  await expect(page.getByRole('heading', { name: 'Uploaded churn v1' })).toBeVisible();
  await expect(page.getByText('Passed all checks')).toBeVisible({ timeout: 90_000 });
  const checks = page.getByRole('list', { name: 'Validation checks' }).getByRole('listitem');
  await expect(checks).toHaveCount(CHECKS.length);
  for (const id of CHECKS) {
    await expect(checks.and(page.locator(`[data-check="${id}"]`))).toHaveAttribute(
      'data-state',
      'passed',
    );
  }
  await expect(page.getByText('Latency p95')).toBeVisible();
  await expect(page.getByText('Uploaded bundle', { exact: true })).toBeVisible();
  await expect(page.getByText(/stored sha256 cb545fae/)).toBeVisible();
  await expectNoSeriousA11yViolations(page);

  // ---- a pickle renamed to model.onnx is rejected at V1, never unpickled --------------------
  await page.getByRole('link', { name: 'Uploaded churn' }).click();
  await uploadBundle(page, 'scikit-learn → ONNX', 'sklearn', {
    name: 'model.onnx',
    mimeType: 'application/octet-stream',
    buffer: Buffer.concat([
      Buffer.from([0x80, 0x04, 0x95]),
      Buffer.from("cos\nsystem\n(S'touch /tmp/pwned'\ntR.", 'latin1'),
    ]),
  });
  await expect(page.getByRole('heading', { name: 'Uploaded churn v2' })).toBeVisible();
  await expect(page.getByText('Rejected: V1 failed')).toBeVisible({ timeout: 90_000 });
  await expect(page.locator('[data-check="V1"]')).toHaveAttribute('data-state', 'failed');
  await expect(page.locator('[data-check="V1"]')).toContainText('pickle');
  await expect(page.getByRole('button', { name: 'Re-run validation' })).toHaveCount(0);
  await expectNoSeriousA11yViolations(page);

  // ---- the model page shows both outcomes ---------------------------------------------------
  await page.getByRole('link', { name: 'Uploaded churn' }).click();
  await expect(page.getByRole('row', { name: /v1.*Validated/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /v2.*Rejected/ })).toBeVisible();
});

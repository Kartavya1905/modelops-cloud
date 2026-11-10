import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { expectNoSeriousA11yViolations } from '../support/a11y';

/**
 * Milestone 6 slice: login -> deploy -> playground predict -> real load (k6) -> the dashboard and
 * the org overview show the same request count k6 reports.
 */
const ROOT = join(import.meta.dirname, '..', '..', '..');
const BUNDLES = join(ROOT, 'tests', 'fixtures', 'bundles');
const PASSWORD = 'correct horse battery staple';

test('playground prediction, then k6 traffic shows up on the dashboard and overview', async ({
  page,
}) => {
  test.setTimeout(300_000);

  await page.goto('/register');
  await page.getByLabel('Name').fill('Obi Serve');
  await page.getByLabel('Email').fill(`obi-${randomUUID().slice(0, 8)}@example.com`);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  // M6: the org root is now the overview
  await page.getByRole('link', { name: 'Projects' }).click();
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'New project' }).first().click();
  const projectName = `Watch ${randomUUID().slice(0, 6)}`;
  await page.getByRole('dialog').getByLabel('Name').fill(projectName);
  await page.getByRole('dialog').getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('link', { name: projectName }).click();
  await expect(page.getByRole('heading', { name: projectName })).toBeVisible();
  const projectUrl = page.url();

  // ---- validated version + endpoint + deploy (M4/M5) ---------------------------------------
  await page.getByRole('button', { name: 'New model' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('Churn');
  await page.getByRole('dialog').getByRole('button', { name: 'Create model' }).click();
  await page.getByRole('link', { name: /Churn/ }).first().click();
  await page.getByRole('button', { name: 'Upload bundle' }).click();
  const upload = page.getByRole('dialog', { name: 'Upload a bundle' });
  await upload.getByLabel('model.onnx').setInputFiles(join(BUNDLES, 'sklearn', 'model.onnx'));
  await upload
    .getByLabel('signature.json')
    .setInputFiles(join(BUNDLES, 'sklearn', 'signature.json'));
  await upload
    .getByLabel('golden_examples.json')
    .setInputFiles(join(BUNDLES, 'sklearn', 'golden_examples.json'));
  await upload.getByRole('button', { name: 'Upload and validate' }).click();
  await expect(page.getByText('Passed all checks')).toBeVisible({ timeout: 90_000 });

  await page.goto(projectUrl);
  await page.getByRole('button', { name: 'New endpoint' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('Watched churn');
  await page.getByRole('dialog').getByRole('button', { name: 'Create endpoint' }).click();
  await expect(page.getByRole('heading', { name: 'Watched churn' })).toBeVisible();
  await page.getByRole('button', { name: 'Deploy' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Deploy' }).click();
  await expect(page.locator('[data-step="READY"]')).toHaveAttribute('data-state', 'done', {
    timeout: 120_000,
  });

  // ---- playground: form from the signature, prefilled with a golden example -----------------
  const golden = JSON.parse(
    readFileSync(join(BUNDLES, 'sklearn', 'golden_examples.json'), 'utf8'),
  ) as { inputs: number[][]; outputs: { label: number[] } };
  const form = page.getByRole('form', { name: 'Playground' });
  await expect(form.getByLabel('tenure_months')).toHaveValue(String(golden.inputs[0]?.[0]));
  await form.getByRole('button', { name: 'Predict' }).click();
  await expect(page.getByTestId('playground-label')).toHaveText(String(golden.outputs.label[0]));
  await expectNoSeriousA11yViolations(page);

  // invalid input never leaves the browser
  await form.getByLabel('usage_hours').fill('lots');
  await form.getByRole('button', { name: 'Predict' }).click();
  await expect(form.getByText('Enter a number')).toBeVisible();

  // ---- real load through the dev gateway ------------------------------------------------------
  await page.goto(projectUrl);
  await page.getByRole('button', { name: 'New API key' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('k6');
  await page.getByRole('dialog').getByRole('button', { name: 'Create key' }).click();
  const key = (await page.getByRole('dialog').locator('code').first().textContent()) ?? '';
  await page.getByRole('dialog').getByRole('button', { name: 'Done' }).click();
  const k6 = JSON.parse(
    execFileSync(
      process.execPath,
      [
        join(ROOT, 'scripts', 'demo-traffic.mjs'),
        '--endpoint',
        'watched-churn',
        '--key',
        key,
        '--rps',
        '10',
        '--duration',
        '5s',
        '--json',
      ],
      { encoding: 'utf8', timeout: 120_000 },
    ).trim(),
  ) as { requests: number; failed: number };
  expect(k6.failed).toBe(0);

  await page.getByRole('link', { name: 'Watched churn' }).click();
  const requests = page.locator('[data-stat="Requests"]');
  // 1 playground call + the k6 requests (the invalid one never reached the gateway)
  const expected = (k6.requests + 1).toLocaleString('en-US');
  await expect(async () => {
    await page.getByRole('button', { name: '15m', exact: true }).click();
    await expect(requests).toHaveText(expected, { timeout: 2_000 });
  }).toPass({ timeout: 45_000 });
  await expect(page.getByText('1 from the playground')).toBeVisible();
  await expect(
    page.getByRole('img', { name: /requests per second by model version/ }),
  ).toBeVisible();
  await expectNoSeriousA11yViolations(page);

  // ---- overview ----------------------------------------------------------------------------
  await page.getByRole('link', { name: 'Overview' }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expect(page.locator('[data-tile="Endpoints serving"]')).toHaveText('1 / 1');
  await expect(page.locator('[data-tile="Requests (24 h)"]')).toHaveText(expected);
  await expect(page.getByRole('link', { name: 'Watched churn' })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
});

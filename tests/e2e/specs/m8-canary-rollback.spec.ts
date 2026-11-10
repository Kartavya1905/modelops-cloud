import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { expectNoSeriousA11yViolations } from '../support/a11y';

/**
 * Milestone 8 in the browser: blue/green redeploy -> rollback through the confirm dialog ->
 * a deliberately broken canary (tests/fixtures/bundles/latent-nan) on 50 % of real traffic ->
 * the canary analysis aborts it -> stable serves everything again, and the aborted canary is
 * not offered as a rollback target.
 */
const ROOT = join(import.meta.dirname, '..', '..', '..');
const BUNDLES = join(ROOT, 'tests', 'fixtures', 'bundles');
const GATEWAY = process.env.MO_GATEWAY_URL ?? 'http://127.0.0.1:18088';
const PASSWORD = 'correct horse battery staple';

async function upload(page: Page, bundle: string) {
  await page.getByRole('button', { name: 'Upload bundle' }).click();
  const up = page.getByRole('dialog', { name: 'Upload a bundle' });
  await up.getByLabel('model.onnx').setInputFiles(join(BUNDLES, bundle, 'model.onnx'));
  await up.getByLabel('signature.json').setInputFiles(join(BUNDLES, bundle, 'signature.json'));
  await up
    .getByLabel('golden_examples.json')
    .setInputFiles(join(BUNDLES, bundle, 'golden_examples.json'));
  await up.getByRole('button', { name: 'Upload and validate' }).click();
  await expect(page.getByText('Passed all checks')).toBeVisible({ timeout: 90_000 });
}

async function deploy(page: Page, version: string, canaryShare?: string) {
  await page.getByRole('button', { name: 'Deploy', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: /Deploy to/ });
  await dialog.getByLabel('Version').selectOption({ label: version });
  if (canaryShare) {
    await dialog.getByLabel('Rollout').selectOption({ label: 'Canary: a share of traffic first' });
    await dialog.getByLabel('Canary share (%)').fill(canaryShare);
  }
  await dialog.getByRole('button', { name: 'Deploy' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('[data-step="READY"]')).toHaveAttribute('data-state', 'done', {
    timeout: 120_000,
  });
}

test('rollback in one click; a broken canary is aborted by its analysis', async ({ page }) => {
  test.setTimeout(420_000);
  await page.goto('/register');
  await page.getByLabel('Name').fill('Ray Lease');
  await page.getByLabel('Email').fill(`ray-${randomUUID().slice(0, 8)}@example.com`);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('button', { name: 'New project' }).first().click();
  const projectName = `Released ${randomUUID().slice(0, 6)}`;
  await page.getByRole('dialog').getByLabel('Name').fill(projectName);
  await page.getByRole('dialog').getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('link', { name: projectName }).click();
  await expect(page.getByRole('heading', { name: projectName })).toBeVisible();
  const projectUrl = page.url();

  // ---- two validated versions: a good one, and one with a latent NaN bug ---------------------
  await page.getByRole('button', { name: 'New model' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('Churn');
  await page.getByRole('dialog').getByRole('button', { name: 'Create model' }).click();
  await page.getByRole('link', { name: /Churn/ }).first().click();
  await expect(page.getByRole('heading', { name: 'Churn', exact: true })).toBeVisible();
  const modelUrl = page.url();
  await upload(page, 'sklearn');
  await page.goto(modelUrl);
  await upload(page, 'latent-nan'); // passes every check: the bug is not in its golden examples

  // ---- blue/green twice, then roll back through the confirm dialog -------------------------
  await page.goto(projectUrl);
  await page.getByRole('button', { name: 'New endpoint' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('Released churn');
  await page.getByRole('dialog').getByRole('button', { name: 'Create endpoint' }).click();
  await expect(page.getByRole('heading', { name: 'Released churn' })).toBeVisible();
  const endpointUrl = page.url();
  await deploy(page, 'v1 · scikit-learn');
  await deploy(page, 'v1 · scikit-learn');
  const split = page.getByTestId('traffic-split');
  await expect(split).toContainText('Stable 100% revision 2');
  await page.getByRole('button', { name: 'Roll back' }).click();
  const confirm = page.getByRole('dialog', { name: 'Roll back Released churn?' });
  await expect(confirm).toContainText('traffic moves to it in seconds');
  await expectNoSeriousA11yViolations(page);
  await confirm.getByRole('button', { name: 'Roll back' }).click();
  await expect(confirm).toBeHidden();
  await expect(split).toContainText('Stable 100% revision 1');

  // ---- the broken version as a 50 % canary, real traffic through the gateway ---------------
  await deploy(page, 'v2 · scikit-learn', '50');
  await expect(split).toContainText('Canary 50% revision 3');
  await page.goto(projectUrl);
  await page.getByRole('button', { name: 'New API key' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('canary traffic');
  await page.getByRole('dialog').getByRole('button', { name: 'Create key' }).click();
  const key = (await page.getByRole('dialog').locator('code').first().textContent()) ?? '';
  await page.getByRole('dialog').getByRole('button', { name: 'Done' }).click();

  const golden = (
    JSON.parse(readFileSync(join(BUNDLES, 'sklearn', 'golden_examples.json'), 'utf8')) as {
      inputs: number[][];
    }
  ).inputs;
  const features =
    (
      JSON.parse(readFileSync(join(BUNDLES, 'sklearn', 'signature.json'), 'utf8')) as {
        inputs: { features: string[] }[];
      }
    ).inputs[0]?.features ?? [];
  const statuses: number[] = [];
  for (let batch = 0; batch < 40; batch++) {
    const replies = await Promise.all(
      Array.from({ length: 20 }, async (_, j) => {
        const i = batch * 20 + j;
        const row = golden[i % golden.length] ?? [];
        const res = await fetch(`${GATEWAY}/v1/endpoints/released-churn/predict`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${key}`,
            'content-type': 'application/json',
            'x-routing-key': `customer-${String(i)}`,
          },
          body: JSON.stringify({
            inputs: [Object.fromEntries(features.map((f, k) => [f, row[k]]))],
          }),
        });
        await res.arrayBuffer();
        return res.status;
      }),
    );
    statuses.push(...replies);
  }
  const errors = statuses.filter((s) => s >= 500).length;
  expect(errors).toBeLessThanOrEqual(statuses.length * 0.5); // never beyond the canary's share

  // ---- the analysis fails it and aborts it (the worker also checks every 15 s) -------------
  await page.goto(endpointUrl);
  const canary = page.getByRole('region', { name: 'Canary' });
  await expect(async () => {
    if (await canary.isVisible()) {
      await canary.getByRole('button', { name: 'Run check' }).click();
    }
    await expect(split).toContainText('Stable 100% revision 1', { timeout: 3_000 });
  }).toPass({ timeout: 90_000 });
  await expect(canary).toBeHidden();
  await expect(page.getByRole('row', { name: /^3 .*Draining/ })).toBeVisible();

  // The aborted canary never served as stable, so it is not something to roll back to.
  await page.getByRole('button', { name: 'Roll back' }).click();
  const targets = page.getByRole('dialog').getByLabel('Roll back to');
  await expect(targets.locator('option')).toHaveText(['revision 2 · Churn v1 (warm)']);
  await page.getByRole('dialog').getByRole('button', { name: 'Keep current' }).click();
  await expectNoSeriousA11yViolations(page);

  // ---- the approvals queue (production endpoints only; none here) --------------------------
  await page.getByRole('link', { name: 'Approvals' }).click();
  await expect(page.getByText('Nothing to approve')).toBeVisible();
  await expectNoSeriousA11yViolations(page);
});

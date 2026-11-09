// Captures README/demo screenshots (M2-M5) from a running stack, in light and dark mode.
//   pnpm --filter @modelops/e2e screenshots      (writes docs/images/m*.png)
// Uses a fresh throwaway account each run; nothing here is a real credential.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3300';
const OUT = join(import.meta.dirname, '..', '..', 'docs', 'images');
const ML_DIR = join(import.meta.dirname, '..', '..', 'ml');
const BUNDLES = join(import.meta.dirname, '..', 'fixtures', 'bundles');
const password = `demo-${randomUUID()}`;

/** Toasts are transient: wait until none is on screen so they never cover the shot. */
async function noToasts(page: Page): Promise<void> {
  await page.locator('[data-sonner-toast]').first().waitFor({ state: 'detached', timeout: 10_000 });
}

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForLoadState('networkidle');
  // dialogs fade/zoom in: capture the settled frame, not a translucent one
  await page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== 'running'),
  );
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: false });
  console.log(`screenshot: docs/images/${name}.png`);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  for (const scheme of ['light', 'dark'] as const) {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 800 },
      colorScheme: scheme,
    });
    const suffix = scheme === 'dark' ? '-dark' : '';

    await page.goto(`${BASE}/login`);
    await shot(page, `m2-login${suffix}`);

    await page.goto(`${BASE}/register`);
    await page.getByLabel('Name').fill('Ada Lovelace');
    await page.getByLabel('Email').fill(`ada-${randomUUID().slice(0, 8)}@example.com`);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByRole('heading', { name: 'Projects', exact: true }).waitFor();

    for (const [name, description] of [
      ['Customer churn', 'Predict which customers are likely to cancel next month'],
      ['Fraud detection', 'Score card transactions in real time'],
    ] as const) {
      await page.getByRole('button', { name: 'New project' }).first().click();
      const dialog = page.getByRole('dialog', { name: 'New project' });
      await dialog.getByLabel('Name').fill(name);
      await dialog.getByLabel('Description (optional)').fill(description);
      if (name === 'Fraud detection') await shot(page, `m2-create-project${suffix}`);
      await dialog.getByRole('button', { name: 'Create project' }).click();
      await dialog.waitFor({ state: 'hidden' });
    }
    await page.getByRole('link', { name: 'Fraud detection' }).waitFor();
    await shot(page, `m2-projects${suffix}`);

    await page.getByRole('link', { name: 'Members' }).click();
    await page.getByRole('button', { name: 'Invite member' }).click();
    const invite = page.getByRole('dialog', { name: 'Invite a member' });
    await invite.getByLabel('Email').fill('grace@example.com');
    await invite.getByLabel('Role', { exact: true }).selectOption('ML_ENGINEER');
    await invite.getByRole('button', { name: 'Create invitation link' }).click();
    await page.getByLabel('Invitation link').waitFor();
    await shot(page, `m2-invite${suffix}`);
    await page.getByRole('button', { name: 'Done' }).click();
    await shot(page, `m2-members${suffix}`);

    await page.getByRole('link', { name: 'Audit log' }).click();
    await page.getByRole('cell', { name: 'project.created' }).first().waitFor();
    await shot(page, `m2-audit${suffix}`);

    // ---- M3: real training into the project's experiment, compare, register ------------
    await page.getByRole('link', { name: 'Projects' }).click();
    await page.getByRole('link', { name: 'Customer churn' }).click();
    await page.getByText('No training runs yet').waitFor();
    const command = await page.locator('code').filter({ hasText: 'train_sklearn' }).textContent();
    const experiment = /--experiment (\S+)/.exec(command ?? '')?.[1] ?? '';
    for (const [script, extra] of [
      ['train_sklearn', ['--n-estimators', '150']],
      ['train_pytorch', ['--epochs', '20']],
    ] as const) {
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
          '8000',
          ...extra,
        ],
        { stdio: 'pipe' },
      );
    }
    await page.getByRole('button', { name: 'New model' }).click();
    await page.getByRole('dialog').getByLabel('Name').fill('Churn classifier');
    await page.getByRole('dialog').getByRole('button', { name: 'Create model' }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Refresh runs' }).click();
    const rows = page.getByRole('row').filter({ has: page.getByRole('checkbox') });
    await rows.nth(1).waitFor();
    for (const box of await page.getByRole('checkbox', { name: /for comparison/ }).all())
      await box.check();
    await shot(page, `m3-project${suffix}`);
    await page.getByRole('link', { name: 'Compare (2)' }).click();
    await page.locator('.recharts-line').first().waitFor();
    await page.waitForTimeout(600); // let chart animations finish
    await page.screenshot({ path: join(OUT, `m3-compare${suffix}.png`), fullPage: true });
    console.log(`screenshot: docs/images/m3-compare${suffix}.png`);
    await page.getByRole('link', { name: 'Back to project' }).click();
    await rows.filter({ hasText: 'pytorch-mlp' }).getByRole('button', { name: 'Register' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Register version' }).click();
    await page.getByRole('heading', { name: 'Churn classifier v1' }).waitFor();

    // ---- M4: the worker validates it; then a hostile upload is rejected ----------------
    await page.getByText('Passed all checks').waitFor({ timeout: 90_000 });
    await noToasts(page);
    await page.screenshot({ path: join(OUT, `m4-validated${suffix}.png`), fullPage: true });
    console.log(`screenshot: docs/images/m4-validated${suffix}.png`);
    await page.getByRole('link', { name: 'Churn classifier' }).click();
    await page.getByRole('button', { name: 'Upload bundle' }).click();
    const upload = page.getByRole('dialog', { name: 'Upload a bundle' });
    await upload.getByLabel('model.onnx').setInputFiles({
      name: 'model.onnx',
      mimeType: 'application/octet-stream',
      // a pickle that would run a shell command if anything ever unpickled it
      buffer: Buffer.concat([
        Buffer.from([0x80, 0x04, 0x95]),
        Buffer.from("cos\nsystem\n(S'touch /tmp/pwned'\ntR.", 'latin1'),
      ]),
    });
    await upload
      .getByLabel('signature.json')
      .setInputFiles(join(BUNDLES, 'sklearn', 'signature.json'));
    await upload
      .getByLabel('golden_examples.json')
      .setInputFiles(join(BUNDLES, 'sklearn', 'golden_examples.json'));
    await shot(page, `m4-upload${suffix}`);
    await upload.getByRole('button', { name: 'Upload and validate' }).click();
    await page.getByText('Rejected: V1 failed').waitFor({ timeout: 90_000 });
    await noToasts(page);
    await page.screenshot({ path: join(OUT, `m4-rejected${suffix}.png`), fullPage: true });
    console.log(`screenshot: docs/images/m4-rejected${suffix}.png`);

    // ---- M5: endpoint, deploy the validated v1, API key ---------------------------------
    await page.getByRole('link', { name: 'Churn classifier' }).click();
    await page.getByRole('link', { name: 'Customer churn' }).click();
    await page.getByRole('button', { name: 'New endpoint' }).click();
    await page.getByRole('dialog').getByLabel('Name').fill('Churn staging');
    await page.getByRole('dialog').getByRole('button', { name: 'Create endpoint' }).click();
    await page.getByRole('heading', { name: 'Churn staging' }).waitFor();
    await page.getByRole('button', { name: 'Deploy' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Deploy' }).click();
    await page.locator('[data-step="READY"][data-state="done"]').waitFor({ timeout: 120_000 });
    await noToasts(page);
    await page.screenshot({ path: join(OUT, `m5-endpoint${suffix}.png`), fullPage: true });
    console.log(`screenshot: docs/images/m5-endpoint${suffix}.png`);
    await page.getByRole('link', { name: 'Customer churn' }).click();
    await page.getByRole('button', { name: 'New API key' }).click();
    await page.getByRole('dialog').getByLabel('Name').fill('checkout service');
    await page.getByRole('dialog').getByRole('button', { name: 'Create key' }).click();
    await page.getByText('Copy your API key now').waitFor();
    await shot(page, `m5-api-key${suffix}`);
    await page.close();
  }
  await browser.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

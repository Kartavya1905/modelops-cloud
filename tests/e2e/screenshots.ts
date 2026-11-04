// Captures README/demo screenshots of the M2 UI from a running stack.
//   pnpm --filter @modelops/e2e screenshots      (writes docs/images/m2-*.png)
// Uses a fresh throwaway account each run; nothing here is a real credential.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3300';
const OUT = join(import.meta.dirname, '..', '..', 'docs', 'images');
const ML_DIR = join(import.meta.dirname, '..', '..', 'ml');
const password = `demo-${randomUUID()}`;

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForLoadState('networkidle');
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
    await page.screenshot({ path: join(OUT, `m3-version${suffix}.png`), fullPage: true });
    console.log(`screenshot: docs/images/m3-version${suffix}.png`);
    await page.close();
  }
  await browser.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

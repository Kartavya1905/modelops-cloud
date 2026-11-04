// Captures README/demo screenshots of the M2 UI from a running stack.
//   pnpm --filter @modelops/e2e screenshots      (writes docs/images/m2-*.png)
// Uses a fresh throwaway account each run; nothing here is a real credential.
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3300';
const OUT = join(import.meta.dirname, '..', '..', 'docs', 'images');
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
    await page.close();
  }
  await browser.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

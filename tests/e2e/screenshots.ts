// Captures README/demo screenshots (M2-M8) from a running stack, in light and dark mode.
//   pnpm --filter @modelops/e2e screenshots      (writes docs/images/m*.png)
// Uses a fresh throwaway account each run; nothing here is a real credential.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Page } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3300';
const OUT = join(import.meta.dirname, '..', '..', 'docs', 'images');
const ML_DIR = join(import.meta.dirname, '..', '..', 'ml');
const BUNDLES = join(import.meta.dirname, '..', 'fixtures', 'bundles');
const password = `demo-${randomUUID()}`;
const TMP = mkdtempSync(join(tmpdir(), 'mo-shots-'));

/** Seeded churn rows from the platform's generator (ml/modelops_ml/datasets.py). */
function churnRows(args: string[]): void {
  execFileSync(
    'uv',
    ['run', '--directory', ML_DIR, 'python', '-m', 'modelops_ml.datasets', ...args],
    {
      stdio: 'pipe',
    },
  );
}

/** Journey J3: 400 predictions of one kind plus their true labels (scripts/demo-drift.mjs). */
function demoDrift(key: string, phase: string, seed: string): void {
  execFileSync(
    process.execPath,
    [
      join(import.meta.dirname, '..', '..', 'scripts', 'demo-drift.mjs'),
      ...['--endpoint', 'churn-staging', '--key', key, '--phase', phase, '--seed', seed],
    ],
    { stdio: 'pipe' },
  );
}

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

    // ---- M6: real traffic (k6), playground, dashboard, overview -------------------------
    const key = (await page.getByRole('dialog').locator('code').first().textContent()) ?? '';
    await page.getByRole('dialog').getByRole('button', { name: 'Done' }).click();
    execFileSync(
      process.execPath,
      [
        join(import.meta.dirname, '..', '..', 'scripts', 'demo-traffic.mjs'),
        '--endpoint',
        'churn-staging',
        '--key',
        key,
        '--rps',
        '15',
        '--duration',
        '40s',
      ],
      { stdio: 'pipe' },
    );
    await page.getByRole('link', { name: 'Churn staging' }).click();
    await page
      .getByRole('form', { name: 'Playground' })
      .getByRole('button', { name: 'Predict' })
      .click();
    await page.getByTestId('playground-label').waitFor();
    await page.getByRole('button', { name: '15m', exact: true }).click();
    await page
      .getByRole('img', { name: /requests per second by model version/ })
      .waitFor({ timeout: 60_000 });
    await page.waitForTimeout(11_000); // one more dashboard refresh after the last scrape
    await noToasts(page);
    await page.screenshot({ path: join(OUT, `m6-endpoint${suffix}.png`), fullPage: true });
    console.log(`screenshot: docs/images/m6-endpoint${suffix}.png`);
    await page.getByRole('link', { name: 'Overview' }).click();
    await page.getByRole('heading', { name: 'Overview' }).waitFor();
    await shot(page, `m6-overview${suffix}`);

    // ---- M7: held-out data, evaluation gate, input capture, drift + measured performance --
    await page.getByRole('link', { name: 'Projects' }).click();
    await page.getByRole('link', { name: 'Customer churn' }).click();
    const holdout = join(TMP, `holdout${suffix}.csv`);
    churnRows(['--rows', '2000', '--seed', '11', '--out', holdout]);
    await page.getByRole('button', { name: 'Upload dataset' }).click();
    const ds = page.getByRole('dialog', { name: 'Upload a dataset' });
    await ds.getByLabel('Name').fill('churn-holdout');
    await ds.getByLabel('Version').fill('seed11-n2000');
    await ds.getByLabel('CSV file').setInputFiles(holdout);
    await ds.getByRole('button', { name: 'Upload' }).click();
    await page.getByRole('row', { name: /churn-holdout.*Stored/ }).waitFor();
    await noToasts(page);
    await page.getByRole('heading', { name: 'Datasets' }).scrollIntoViewIfNeeded();
    await shot(page, `m7-datasets${suffix}`);

    // (the runs table above also links "Churn classifier v1", to the version page)
    await page.getByRole('link', { name: 'Churn classifier v1', exact: true }).first().click();
    await page.getByRole('link', { name: 'Churn classifier', exact: true }).click();
    await page.getByRole('heading', { name: 'Churn classifier', exact: true }).waitFor();
    await page.getByLabel('Held-out dataset').selectOption({ label: 'churn-holdout seed11-n2000' });
    await page.getByRole('button', { name: 'Evaluate' }).click();
    const report = page.getByRole('list', { name: 'Evaluation reports' }).getByRole('listitem');
    await report
      .getByText(/Gate (passed|failed)/)
      .first()
      .waitFor({ timeout: 60_000 });
    // Whatever the real model scores: crown it only if it actually passed the gate.
    const crown = report.first().getByRole('button', { name: 'Make champion' });
    if (await crown.count()) {
      await crown.click();
      await page.getByRole('row', { name: /v1.*Champion/ }).waitFor();
    }
    await noToasts(page);
    await page.getByRole('heading', { name: 'Evaluations' }).scrollIntoViewIfNeeded();
    await shot(page, `m7-evaluation${suffix}`);

    await page.getByRole('link', { name: 'Customer churn' }).click();
    await page.getByRole('link', { name: 'Churn staging' }).click();
    await page.getByLabel('Capture inputs for drift detection').click();
    await page
      .getByLabel('Capture inputs for drift detection')
      .and(page.locator(':checked'))
      .waitFor();
    // The worker stores captures a moment after the gateway answers: retry the check until the
    // report covers every captured request so far (400, then 800).
    const checkDrift = async (requests: number) => {
      for (let attempt = 0; attempt < 20; attempt++) {
        await page.waitForTimeout(3_000);
        const answer = page.waitForResponse(
          (r) => r.url().endsWith('/drift-reports') && r.request().method() === 'POST',
          { timeout: 120_000 },
        );
        await page.getByRole('button', { name: 'Run drift check' }).click();
        const r = await answer;
        if (r.ok() && ((await r.json()) as { sampleCount: number }).sampleCount >= requests) break;
      }
      await noToasts(page);
    };
    demoDrift(key, 'normal', '13');
    await checkDrift(400);
    demoDrift(key, 'data', '14');
    await checkDrift(800);
    demoDrift(key, 'concept', '15'); // same inputs, flipped labels: performance drops, not drift
    // Wait until the worker has stored all 3 x 400 labels, then capture the whole panel.
    const labelled = page.locator('[data-perf="Labelled"]');
    for (let attempt = 0; attempt < 30; attempt++) {
      await page.reload();
      await labelled.waitFor();
      if ((await labelled.textContent())?.startsWith('1,200')) break;
      await page.waitForTimeout(2_000);
    }
    await page.waitForLoadState('networkidle');
    await noToasts(page);
    await page
      .getByRole('heading', { name: 'Data drift' })
      .locator('xpath=ancestor::div[contains(@class, "lg:grid-cols-2")][1]')
      .screenshot({ path: join(OUT, `m7-monitoring${suffix}.png`) });
    console.log(`screenshot: docs/images/m7-monitoring${suffix}.png`);

    // ---- M8: a healthy canary with its evidence, a broken one aborted, an approval --------
    const traffic = (rps: string, duration: string) =>
      execFileSync(
        process.execPath,
        [
          join(import.meta.dirname, '..', '..', 'scripts', 'demo-traffic.mjs'),
          ...['--endpoint', 'churn-staging', '--key', key, '--rps', rps, '--duration', duration],
        ],
        { stdio: 'pipe' },
      );
    const deployVersion = async (label: string, canaryShare: string) => {
      await page.getByRole('button', { name: 'Deploy', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: /Deploy to/ });
      await dialog.getByLabel('Version').selectOption({ label });
      await dialog
        .getByLabel('Rollout')
        .selectOption({ label: 'Canary: a share of traffic first' });
      await dialog.getByLabel('Canary share (%)').fill(canaryShare);
      await dialog.getByRole('button', { name: 'Deploy' }).click();
      await dialog.waitFor({ state: 'hidden' });
      await page.getByRole('region', { name: 'Canary' }).waitFor({ timeout: 120_000 });
    };
    await page.getByRole('link', { name: 'Customer churn' }).click();
    await page.getByRole('link', { name: 'Churn classifier v1', exact: true }).first().click();
    await page.getByRole('link', { name: 'Churn classifier', exact: true }).click();
    for (const bundle of ['sklearn', 'latent-nan']) {
      await page.getByRole('button', { name: 'Upload bundle' }).click();
      const up = page.getByRole('dialog', { name: 'Upload a bundle' });
      await up.getByLabel('model.onnx').setInputFiles(join(BUNDLES, bundle, 'model.onnx'));
      await up.getByLabel('signature.json').setInputFiles(join(BUNDLES, bundle, 'signature.json'));
      await up
        .getByLabel('golden_examples.json')
        .setInputFiles(join(BUNDLES, bundle, 'golden_examples.json'));
      await up.getByRole('button', { name: 'Upload and validate' }).click();
      await page.getByText('Passed all checks').waitFor({ timeout: 90_000 });
      await page.getByRole('link', { name: 'Churn classifier', exact: true }).click();
    }
    await page.getByRole('link', { name: 'Customer churn' }).click();
    await page.getByRole('link', { name: 'Churn staging' }).click();

    // A healthy canary (v3) on 20 %: the analysis shows its evidence next to stable.
    await deployVersion('v3 · scikit-learn', '20');
    traffic('20', '30s');
    const canaryPanel = page.getByRole('region', { name: 'Canary' });
    for (let attempt = 0; attempt < 10; attempt++) {
      await canaryPanel.getByRole('button', { name: 'Run check' }).click();
      await page.waitForTimeout(3_000);
      if (((await canaryPanel.locator('[data-canary="requests"]').textContent()) ?? '0') !== '0') {
        break;
      }
    }
    await noToasts(page);
    await page.getByRole('heading', { name: 'Release' }).scrollIntoViewIfNeeded();
    await shot(page, `m8-canary${suffix}`);
    if (await canaryPanel.isVisible()) {
      await canaryPanel.getByRole('button', { name: 'Abort canary' }).click();
      await canaryPanel.waitFor({ state: 'hidden' });
    }

    // The broken one (v4: NaN probabilities when late_payments is 0) on 30 %: the worker's own
    // analysis (every 15 s) aborts it while the traffic runs.
    await deployVersion('v4 · scikit-learn', '30');
    traffic('30', '40s');
    await canaryPanel.waitFor({ state: 'hidden', timeout: 120_000 });
    await page.reload();
    await page
      .getByText(/Canary aborted: automatic/)
      .first()
      .waitFor();
    await page.getByRole('button', { name: '15m', exact: true }).click();
    await page.waitForTimeout(11_000); // one dashboard refresh after the last scrape
    await noToasts(page);
    await page.screenshot({ path: join(OUT, `m8-aborted${suffix}.png`), fullPage: true });
    console.log(`screenshot: docs/images/m8-aborted${suffix}.png`);

    // Production: the deployment waits for a second Owner/Admin.
    await page.getByRole('link', { name: 'Customer churn' }).click();
    await page.getByRole('button', { name: 'New endpoint' }).click();
    const create = page.getByRole('dialog');
    await create.getByLabel('Name').fill('Churn production');
    await create.getByLabel('Environment').selectOption('PRODUCTION');
    await create.getByRole('button', { name: 'Create endpoint' }).click();
    await page.getByRole('heading', { name: 'Churn production' }).waitFor();
    await page.getByRole('button', { name: 'Deploy', exact: true }).click();
    const prodDeploy = page.getByRole('dialog', { name: /Deploy to/ });
    // The version that serves staging (v1), not the newest one (the broken v4).
    const v1 = await prodDeploy
      .getByLabel('Version')
      .locator('option', { hasText: /^v1 ·/ })
      .getAttribute('value');
    await prodDeploy.getByLabel('Version').selectOption(v1 ?? '');
    await prodDeploy.getByRole('button', { name: 'Deploy' }).click();
    await page.locator('[data-step="AWAITING_APPROVAL"]').waitFor();
    await page.getByRole('link', { name: 'Approvals' }).click();
    await page.getByRole('list', { name: 'Approvals' }).waitFor();
    await noToasts(page);
    await shot(page, `m8-approvals${suffix}`);
    await page.close();
  }
  await browser.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

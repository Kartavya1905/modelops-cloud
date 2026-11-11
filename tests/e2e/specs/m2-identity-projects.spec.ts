import { randomUUID } from 'node:crypto';
import { type Browser, expect, type Page, test } from '@playwright/test';
import { expectNoSeriousA11yViolations } from '../support/a11y';

/**
 * Milestone 2 vertical slice, driven exactly like a user would:
 *   1. Ada registers -> lands on her organization's empty project list
 *   2. creates a project, renames it, sees both changes in the audit log
 *   3. invites Grace as a Viewer -> Grace registers via the invite link and joins
 *   4. Grace can read the project but gets no "New project" button (and the API would refuse)
 *   5. Eve, a stranger, opens Ada's organization URL -> "Not found"
 */
const PASSWORD = 'correct horse battery staple';
const uid = () => randomUUID().slice(0, 8);

async function register(page: Page, name: string, email: string, path = '/register') {
  await page.goto(path);
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
}

async function newUserPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  return context.newPage();
}

test('register, create a project, invite a viewer, and keep strangers out', async ({ browser }) => {
  // ---- 1. Ada registers ------------------------------------------------------------
  const ada = await newUserPage(browser);
  const adaEmail = `ada-${uid()}@example.com`;
  await register(ada, 'Ada Lovelace', adaEmail);
  await expect(ada).toHaveURL(/\/orgs\/[0-9a-f-]{36}\/projects$/);
  await expect(ada.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
  await expect(ada.getByText('No projects yet')).toBeVisible();
  const orgUrl = ada.url().replace(/\/projects$/, '');

  // ---- 2. create + rename a project -----------------------------------------------
  const projectName = `Churn model ${uid()}`;
  await ada.getByRole('button', { name: 'New project' }).first().click();
  const dialog = ada.getByRole('dialog', { name: 'New project' });
  await dialog.getByLabel('Name').fill(projectName);
  await dialog.getByLabel('Description (optional)').fill('Predict which customers will leave');
  await dialog.getByRole('button', { name: 'Create project' }).click();
  await expect(dialog).toBeHidden();
  await ada.getByRole('link', { name: projectName }).click();

  await expect(ada.getByRole('heading', { name: projectName })).toBeVisible();
  const renamed = `${projectName} v2`;
  await ada.getByLabel('Name').fill(renamed);
  await ada.getByRole('button', { name: 'Save changes' }).click();
  await expect(ada.getByRole('heading', { name: renamed })).toBeVisible();
  const projectUrl = ada.url();

  await ada.getByRole('link', { name: 'Audit log' }).click();
  await expect(ada.getByRole('cell', { name: 'project.created' })).toBeVisible();
  await expect(ada.getByRole('cell', { name: 'project.updated' })).toBeVisible();
  // M9: the hash chain verifies (tampering is covered by the integration tests).
  await ada.getByRole('button', { name: 'Verify integrity' }).click();
  await expect(ada.getByTestId('audit-integrity')).toContainText('Intact');

  // ---- 3. invite Grace as a Viewer ----------------------------------------------
  await ada.getByRole('link', { name: 'Members' }).click();
  await ada.getByRole('button', { name: 'Invite member' }).click();
  const invite = ada.getByRole('dialog', { name: 'Invite a member' });
  const graceEmail = `grace-${uid()}@example.com`;
  await invite.getByLabel('Email').fill(graceEmail);
  await invite.getByLabel('Role').selectOption('VIEWER');
  await invite.getByRole('button', { name: 'Create invitation link' }).click();
  const link = await ada.getByLabel('Invitation link').inputValue();
  expect(link).toMatch(/\/invite\/[A-Za-z0-9_-]{40,}$/);
  await ada.getByRole('button', { name: 'Done' }).click();

  const grace = await newUserPage(browser);
  await grace.goto(link); // signed out -> redirected to /login?next=/invite/...
  await expect(grace).toHaveURL(/\/login\?next=/);
  await grace.getByRole('link', { name: 'Create one' }).click();
  await expect(grace).toHaveURL(/\/register\?next=%2Finvite%2F/); // invite survives sign-up
  await register(grace, 'Grace Hopper', graceEmail, grace.url());
  await expect(grace.getByRole('heading', { name: /Join .*workspace/ })).toBeVisible();
  await grace.getByRole('button', { name: 'Accept invitation' }).click();

  // ---- 4. Grace reads, but cannot create ----------------------------------------
  await expect(grace).toHaveURL(`${orgUrl}/projects`);
  await expect(grace.getByRole('link', { name: renamed })).toBeVisible();
  await expect(grace.getByRole('button', { name: 'New project' })).toHaveCount(0);
  await expect(grace.getByRole('link', { name: 'Audit log' })).toHaveCount(0);

  // Ada now sees Grace as a Viewer
  await ada.reload();
  await expect(ada.getByRole('row', { name: /Grace Hopper/ })).toContainText('Viewer');

  // ---- 5. a stranger is told the organization does not exist ---------------------
  const eve = await newUserPage(browser);
  await register(eve, 'Eve', `eve-${uid()}@example.com`);
  await expect(eve).toHaveURL(/\/projects$/);
  await eve.goto(projectUrl);
  await expect(eve.getByRole('heading', { name: 'Not found' })).toBeVisible();
});

test('signed-out visitors are sent to sign-in, then back where they were going', async ({
  page,
}) => {
  await page.goto('/orgs/00000000-0000-4000-8000-000000000000/members');
  await expect(page).toHaveURL(/\/login\?next=%2Forgs%2F/);
  await expect(page.getByRole('heading', { name: 'Sign in to ModelOps Cloud' })).toBeVisible();
});

test('wrong password shows a generic error', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(`nobody-${uid()}@example.com`);
  await page.getByLabel('Password').fill('not-the-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'The email or password is incorrect.' }),
  ).toBeVisible();
});

test('key pages have no serious accessibility violations (axe)', async ({ page }) => {
  const check = () => expectNoSeriousA11yViolations(page);
  await page.goto('/login');
  await check();
  await register(page, 'Axe Tester', `axe-${uid()}@example.com`);
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
  await check();
});

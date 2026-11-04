import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/**
 * Runs axe (WCAG 2.1 A/AA) on the page *after* CSS animations and transitions have finished,
 * so contrast is measured on what people actually see, not on a toast halfway through fading out.
 */
export async function expectNoSeriousA11yViolations(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    document.getAnimations().every((a) => !a.pending && a.playState !== 'running'),
  );
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  const serious = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  expect(
    serious.map(
      (v) =>
        `${v.id}: ${v.help} -> ${v.nodes.map((n) => `${n.target.join(' ')} ${n.failureSummary ?? ''}`).join(' | ')}`,
    ),
  ).toEqual([]);
}

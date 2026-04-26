import { AxeBuilder } from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

async function expectNoBlockingViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const blocking = results.violations.filter((violation) =>
    ['serious', 'critical'].includes(violation.impact ?? ''),
  );

  expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
}

test('homepage and completed proof have no serious or critical axe violations', async ({
  page,
}) => {
  await page.goto('/');
  await expectNoBlockingViolations(page);

  await page.getByRole('button', { name: 'Prove Selected Claim' }).click();
  await expect(page.getByText(/proof generated in a worker and verified locally/i)).toBeVisible();
  await page.getByRole('button', { name: '15', exact: true }).click();
  await expectNoBlockingViolations(page);
});

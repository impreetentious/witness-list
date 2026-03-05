import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test('homepage has no serious or critical axe violations', async ({ page }) => {
  await page.goto('/');

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .disableRules(['color-contrast'])
    .analyze();
  const blocking = results.violations.filter((violation) =>
    ['serious', 'critical'].includes(violation.impact ?? ''),
  );

  expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
});

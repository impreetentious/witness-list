import { expect, test } from '@playwright/test';

test('homepage renders the workshop shell', async ({ page }) => {
  await page.goto('/');

  await expect(
    page.getByRole('heading', { level: 1, name: /write a claim, prove it, try to cheat/i }),
  ).toBeVisible();
  await expect(page.getByLabel('Claim and proving controls')).toBeVisible();
  await expect(page.getByLabel('Workshop workbench')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pythagorean', exact: true })).toBeVisible();
});

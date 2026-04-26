import { expect, test } from '@playwright/test';

test('homepage hydrates and proves in a worker under the deployed path', async ({ page }) => {
  const pageErrors: string[] = [];
  const failedResponses: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('response', (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`);
  });

  const response = await page.goto('/');
  expect(response?.headers()['content-security-policy']).toContain("worker-src 'self'");

  await expect(
    page.getByRole('heading', { level: 1, name: /write a claim, prove it, try to cheat/i }),
  ).toBeVisible();
  await expect(page.getByLabel('Claim and proving controls')).toBeVisible();
  await expect(page.getByLabel('Workshop workbench')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pythagorean', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Prove Selected Claim' }).click();
  await expect(page.getByText(/proof generated in a worker and verified locally/i)).toBeVisible();
  await page.getByRole('button', { name: '15', exact: true }).click();
  await expect(page.getByText(/^pass —/)).toHaveCount(7);

  expect(pageErrors).toEqual([]);
  expect(failedResponses).toEqual([]);
});

import { expect, test } from '@playwright/test';

test('homepage browser performance stays inside budget', async ({ page }) => {
  await page.goto('/', { waitUntil: 'load' });
  await page.getByRole('heading', { level: 1 }).waitFor();

  const metrics = await page.evaluate(() => {
    const navigation = performance.getEntriesByType('navigation')[0] as
      | PerformanceNavigationTiming
      | undefined;
    return {
      domContentLoadedMs: navigation
        ? navigation.domContentLoadedEventEnd - navigation.startTime
        : 0,
      loadMs: navigation ? navigation.loadEventEnd - navigation.startTime : 0,
      nodeCount: document.querySelectorAll('*').length,
    };
  });

  expect(metrics.domContentLoadedMs).toBeLessThan(5000);
  expect(metrics.loadMs).toBeLessThan(8000);
  expect(metrics.nodeCount).toBeLessThan(2500);
});

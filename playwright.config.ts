import { defineConfig, devices } from '@playwright/test';

const PORT = 3011;
const BASE_PATH = (process.env.BASE_PATH ?? '').replace(/\/$/, '');
const BASE_URL = `http://127.0.0.1:${PORT}${BASE_PATH}`;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: `${BASE_URL}/`,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // The built export under the deployed BASE_PATH, not `next dev` at the root:
    // the worker script URL and every asset path are base-path sensitive, and a
    // dev server at `/` cannot fail on any of it. Requires `npm run build` first;
    // both CI files build immediately before this runs.
    command: 'node scripts/serve-static.mjs out',
    env: { BASE_PATH },
    url: `${BASE_URL}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});

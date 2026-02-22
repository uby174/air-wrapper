import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E configuration
 * Requires: web on :3000, api on :8787, postgres on :5432, redis on :6379
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: 'list',
  timeout: 30_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: process.env.WEB_URL ?? 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    // API base for direct HTTP tests
    extraHTTPHeaders: {
      Accept: 'application/json'
    }
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
  ],

  // Do not start servers automatically — they must be running externally
  // webServer is intentionally omitted; start with `pnpm dev` before running
});

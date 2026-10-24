// SPDX-License-Identifier: AGPL-3.0-only
// The install page in site/, served as plain files the way a static host serves it.
import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_SITE_PORT ?? 7361);
const chromium = process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {};

export default defineConfig({
  testDir: 'e2e-site',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: { baseURL: `http://127.0.0.1:${port}`, launchOptions: chromium },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, launchOptions: chromium },
    },
    {
      name: 'phone',
      use: { ...devices['Pixel 7'], viewport: { width: 360, height: 780 }, launchOptions: chromium },
    },
  ],
  webServer: {
    command: `node ../../scripts/serve-dir.mjs ../../site ${port}`,
    url: `http://127.0.0.1:${port}/index.html`,
    reuseExistingServer: false,
  },
});

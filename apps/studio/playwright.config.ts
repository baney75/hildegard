// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_PORT ?? 7351);
const data = mkdtempSync(join(tmpdir(), 'hildegard-e2e-'));
// The server gets its own home folder, so linking AI apps in tests never touches this computer's real config. Cursor
// is "installed" there, so there's something to link.
const home = mkdtempSync(join(tmpdir(), 'hildegard-e2e-home-'));
mkdirSync(join(home, '.cursor'));
const chromium = process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {};

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: chromium,
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, launchOptions: chromium },
      testIgnore: /phone\.spec/,
    },
    { name: 'phone', use: { ...devices['Pixel 7'], launchOptions: chromium }, testMatch: /phone\.spec/ },
  ],
  webServer: {
    command: `node ../server/src/main.ts --fake-gpu --port ${port} --data ${JSON.stringify(data)} --ui dist`,
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    env: {
      HILDEGARD_FAKE_TICK_MS: '40',
      HILDEGARD_SECRETS: 'file',
      HILDEGARD_E2E_HOME: home,
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, 'AppData'),
      XDG_CONFIG_HOME: join(home, '.config'),
    },
  },
});

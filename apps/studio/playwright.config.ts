// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_PORT ?? 7351);
// A second Hildegard, with its own stand-in GPU, for the Studio to pair with in Settings › Devices.
const nodePort = Number(process.env.E2E_NODE_PORT ?? port + 1);
process.env.E2E_NODE_PORT = String(nodePort);
// The listener Tailscale Serve would forward to: the Studio as someone on another device sees it, signing in.
const hostPort = Number(process.env.E2E_HOST_PORT ?? port + 2);
process.env.E2E_HOST_PORT = String(hostPort);
const data = mkdtempSync(join(tmpdir(), 'hildegard-e2e-'));
const nodeData = mkdtempSync(join(tmpdir(), 'hildegard-e2e-node-'));
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
  webServer: [
    {
      command: `node ../server/src/main.ts --fake-gpu --port ${port} --host-port ${hostPort} --data ${JSON.stringify(data)} --ui dist`,
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
    {
      command: `node ../server/src/main.ts --fake-gpu --port ${nodePort} --data ${JSON.stringify(nodeData)}`,
      url: `http://127.0.0.1:${nodePort}/api/health`,
      reuseExistingServer: false,
      env: { HILDEGARD_FAKE_TICK_MS: '40', HILDEGARD_SECRETS: 'file', HOME: home, USERPROFILE: home },
    },
  ],
});

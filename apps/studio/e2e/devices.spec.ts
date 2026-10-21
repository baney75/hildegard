// SPDX-License-Identifier: AGPL-3.0-only
import { type APIRequestContext, expect, test } from '@playwright/test';
import { expectAccessible, expectCurlyQuotes, watchErrors } from './helpers.ts';

const H = { 'x-hildegard': '1' };
const node = `http://127.0.0.1:${process.env.E2E_NODE_PORT}`;

/** A join code from the second Hildegard, as its owner would get from Share this GPU. */
async function inviteFromNode(request: APIRequestContext) {
  const res = await request.post(`${node}/api/choir/invite`, { headers: H, data: { url: node } });
  expect(res.status()).toBe(200);
  const { code } = (await res.json()) as { code: string };
  const name = JSON.parse(Buffer.from(code.slice(5), 'base64url').toString('utf8')).n as string;
  return { code, name };
}

// One server for the whole run: leave it rendering here, paired with nothing, and sharing nothing.
test.afterEach(async ({ request }) => {
  await request.post('/api/choir/use', { headers: H, data: { name: 'local' } });
  const s = (await (await request.get('/api/snapshot')).json()) as { choir: { devices: { name: string }[] } };
  for (const d of s.choir.devices)
    await request.post('/api/choir/leave', { headers: H, data: { name: d.name } });
  await request.post('/api/choir/revoke', { headers: H });
  await request.post(`${node}/api/choir/revoke`, { headers: H });
});

test('adds a device by its code, renders there, and removes it', async ({ page, request }) => {
  const errors = watchErrors(page);
  await page.goto('/#/settings/devices');
  await expect(page.getByRole('heading', { name: 'Devices' })).toBeVisible();
  const use = page.getByRole('radiogroup', { name: 'Use for renders' });
  await expect(use.getByRole('radio', { name: 'Use this computer for renders' })).toBeChecked();
  await expectAccessible(page, 'devices');
  await expectCurlyQuotes(page, 'devices');

  const { code, name } = await inviteFromNode(request);
  await page.getByLabel('Join code').fill(code);
  await page.getByRole('button', { name: 'Add device' }).click();
  await expect(use.getByText('Online')).toBeVisible();
  await expect(use.getByText(/Stand-in/)).toBeVisible();

  await use.getByRole('radio', { name: `Use ${name} for renders` }).click();
  await expect(use.getByRole('radio', { name: `Use ${name} for renders` })).toBeChecked();
  await expectAccessible(page, 'devices, paired');
  await expectCurlyQuotes(page, 'devices, paired');

  await page.goto('/#/queue');
  await expect(page.getByText(`Rendering on ${name} · Stand-in`)).toBeVisible();

  await page.goto('/#/settings/devices');
  await use.getByRole('radio', { name: 'Use this computer for renders' }).click();
  await expect(use.getByRole('radio', { name: 'Use this computer for renders' })).toBeChecked();
  await use.getByRole('button', { name: `Remove ${name}` }).click();
  await expect(use.getByRole('radio', { name: `Use ${name} for renders` })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('shares this GPU with a code to copy, and stops sharing', async ({ page, context }) => {
  const errors = watchErrors(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  // Whether this computer is on a tailnet decides what the section asks for, so wait until it knows.
  const tailnet = page.waitForResponse((r) => r.url().endsWith('/api/choir/tailnet'));
  await page.goto('/#/settings/devices');
  await tailnet;
  const share = page.getByRole('button', { name: 'Share this GPU' });
  await expect(share).toBeVisible();
  // Without Tailscale here, it asks where other devices reach this computer.
  const address = page.getByLabel(/Tailscale isn’t running here/);
  if (await address.isVisible()) {
    await expect(share).toBeDisabled();
    await address.fill(new URL(page.url()).origin);
  }
  await share.click();
  const code = page.getByRole('region', { name: 'Join code' });
  await expect(code).toHaveText(/^hgc1_[A-Za-z0-9_-]+$/);
  await page.getByRole('button', { name: 'Copy' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/^hgc1_/);
  await expectAccessible(page, 'sharing');
  await expectCurlyQuotes(page, 'sharing');

  await page.getByRole('button', { name: 'Stop sharing' }).click();
  await expect(code).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Share this GPU' })).toBeVisible();
  expect(errors).toEqual([]);
});

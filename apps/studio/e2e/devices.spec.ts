// SPDX-License-Identifier: AGPL-3.0-only
import { type APIRequestContext, expect, test } from '@playwright/test';
import { expectAccessible, expectCurlyQuotes, watchErrors } from './helpers.ts';

const H = { 'x-hildegard': '1' };
const node = `http://127.0.0.1:${process.env.E2E_NODE_PORT}`;

/** A join code from the second Hildegard, as its owner would get from Share this GPU. */
async function inviteFromNode(request: APIRequestContext) {
  const res = await request.post(`${node}/api/choir/invite`, {
    headers: H,
    data: { url: node, long: true },
  });
  expect(res.status()).toBe(200);
  const { code } = (await res.json()) as { code: string };
  const name = JSON.parse(Buffer.from(code.slice(5), 'base64url').toString('utf8')).n as string;
  return { code, name };
}

// One server for the whole run: leave it rendering here, paired with nothing, and sharing nothing.
test.afterEach(async ({ request }) => {
  await request.post('/api/choir/use', { headers: H, data: { name: 'local' } });
  await request.post('/api/choir/primary', { headers: H, data: { name: 'local' } });
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
  await expect(page.getByLabel('Join code')).toHaveAttribute('type', 'password');
  await page.getByRole('button', { name: 'Add device' }).click();
  await expect(use.getByText('Online')).toBeVisible();
  await expect(use.getByText(/Stand-in/)).toBeVisible();

  // What each device says it can do for Talk, this computer included.
  await expect(use.getByText(/^Hears with whisper-small · Answers with hildegard-echo/)).toHaveCount(2);

  // The primary for Talk is its own choice, apart from where takes render.
  await expect(use.getByText('Primary', { exact: true })).toHaveCount(1);
  await use.getByRole('button', { name: `Make primary for Talk: ${name}` }).click();
  await expect(use.getByRole('button', { name: 'Make primary for Talk: this computer' })).toBeVisible();
  await expect(use.getByRole('button', { name: `Make primary for Talk: ${name}` })).toHaveCount(0);
  await page.goto('/#/talk');
  await expect(page.getByLabel('Hear and answer on')).toHaveValue(name);
  await expect(page.getByLabel('Hear and answer on').locator('option:checked')).toHaveText(
    `${name} (primary)`,
  );
  await page.goto('/#/settings/devices');
  await use.getByRole('button', { name: 'Make primary for Talk: this computer' }).click();
  await expect(use.getByRole('button', { name: `Make primary for Talk: ${name}` })).toBeVisible();

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
  // A short code to type, large, with a countdown; the long one only on request.
  const short = page.getByRole('group', { name: 'Short join code' });
  await expect(short.getByTestId('one-time-code')).toHaveText(
    /^HG-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/,
  );
  await expect(page.getByRole('timer')).toHaveText(/Works once, for (9|10):\d\d more\./);
  await short.getByRole('button', { name: 'Copy' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/^HG-/);
  // The long one is made only on request.
  await expect(page.getByRole('region', { name: 'Join code' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Show long code' }).click();
  const code = page.getByRole('region', { name: 'Join code' });
  await expect(code).toHaveText(/^hgc1_[A-Za-z0-9_-]+$/);
  await page.getByRole('button', { name: 'Copy long code' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/^hgc1_/);
  // The countdown moves.
  const first = await page.getByRole('timer').textContent();
  await expect.poll(async () => page.getByRole('timer').textContent(), { timeout: 5000 }).not.toBe(first);
  await expectAccessible(page, 'sharing');
  await expectCurlyQuotes(page, 'sharing');

  await page.getByRole('button', { name: 'Stop sharing' }).click();
  await expect(code).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Share this GPU' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('adds a device by typing its short code and address', async ({ page, request }) => {
  const errors = watchErrors(page);
  const res = await request.post(`${node}/api/choir/invite`, { headers: H, data: { url: node } });
  const inv = (await res.json()) as { short: { code: string } };
  await page.goto('/#/settings/devices');
  await page.getByLabel('Join code').fill(inv.short.code.toLowerCase());
  await page.getByLabel(/Its address, as the invite shows it/).fill(node);
  await page.getByRole('button', { name: 'Add device' }).click();
  await expect(page.getByRole('radiogroup', { name: 'Use for renders' }).getByText('Online')).toBeVisible();
  // Used: the same code does nothing the second time.
  const again = await request.post(`${node}/api/choir/redeem`, {
    headers: H,
    data: { code: inv.short.code },
  });
  expect(again.status()).toBe(403);
  expect(errors).toEqual([]);
});

test('shows a paired device’s render in this computer’s queue, by the name it sent', async ({
  page,
  request,
  baseURL,
}) => {
  const errors = watchErrors(page);
  // This computer shares its GPU, and the second Hildegard renders here.
  const res = await request.post('/api/choir/invite', { headers: H, data: { url: baseURL, long: true } });
  expect(res.status()).toBe(200);
  const { code } = (await res.json()) as { code: string };
  const here = JSON.parse(Buffer.from(code.slice(5), 'base64url').toString('utf8')).n as string;
  try {
    expect((await request.post(`${node}/api/choir/join`, { headers: H, data: { code } })).status()).toBe(201);
    await request.post(`${node}/api/choir/use`, { headers: H, data: { name: here } });
    await request.post('/api/engine/pause', { headers: H });
    const shot = await request.post(`${node}/api/shots`, {
      headers: H,
      data: {
        request: {
          prompt: 'A heron waits in the reeds',
          rig: { body: 'vintage-16mm', lens: 'clean', focal: 35, aperture: 2.8 },
          format: { quality: 'draft', seconds: 3 },
        },
      },
    });
    expect(shot.status()).toBe(201);

    await page.goto('/#/queue');
    const row = page.locator('[data-guest]');
    await expect(row).toContainText(/^From \S+/);
    await expect(row).toContainText('Waiting');
    await expect(row).toContainText('A draft sent from another of your devices');
    // Its prompt stays on the device that sent it.
    await expect(page.getByText('A heron waits in the reeds')).toHaveCount(0);
    await expectAccessible(page, 'queue, paired render');
    await expectCurlyQuotes(page, 'queue, paired render');

    await request.post('/api/engine/resume', { headers: H });
    await expect(row).toContainText('Rendering');
    await expect(row).toHaveCount(0, { timeout: 30_000 });
  } finally {
    await request.post('/api/engine/resume', { headers: H });
    await request.post(`${node}/api/choir/use`, { headers: H, data: { name: 'local' } });
    await request.post(`${node}/api/choir/leave`, { headers: H, data: { name: here } });
  }
  expect(errors).toEqual([]);
});

// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from 'node:child_process';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { expectAccessible, expectCurlyQuotes, watchErrors } from './helpers.ts';

// Go live, in the Studio. A stream key goes into a password box and never comes out; with FFmpeg here, the test
// pattern goes out to a recording and Stop ends it. The video card is never probed: the encoder is set to software.
const H = { 'x-hildegard': '1' };
const KEY = 'live_8675309_e2eKeyThatMustNeverComeBack0123';
const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const put = (request: APIRequestContext, data: Record<string, unknown>) =>
  request.put('/api/stream/settings', { headers: H, data });

test.beforeEach(async ({ request }) => {
  await request.post('/api/stream/stop', { headers: H });
  await put(request, {
    encoder: 'software',
    record: false,
    scene: 'starting',
    sources: { screen: null, camera: null, mic: null },
    destinations: { youtube: { enabled: false }, twitch: { enabled: false }, custom: { enabled: false } },
  });
});
test.afterEach(async ({ request }) => {
  await request.post('/api/stream/stop', { headers: H });
  for (const id of ['youtube', 'twitch', 'custom'])
    await request.delete(`/api/stream/keys/${id}`, { headers: H });
});

test('saves a stream key to the keychain and never shows it again', async ({ page, request }) => {
  const errors = watchErrors(page);
  await page.goto('/#/live');
  await expect(page.locator('.cs-crumb .t')).toHaveText('Go live');
  await expect(page.getByRole('heading', { name: 'Where to' })).toBeVisible();
  await expectAccessible(page, 'go live');
  await expectCurlyQuotes(page, 'go live');

  const youtube = page.locator('.lv-dest', { hasText: 'YouTube Live' });
  await expect(youtube.getByText('No stream key yet')).toBeVisible();
  await youtube.getByRole('button', { name: 'Add stream key' }).click();
  const box = youtube.getByLabel('Stream key');
  await expect(box).toHaveAttribute('type', 'password');
  await box.fill(KEY);
  await youtube.getByRole('button', { name: 'Save key' }).click();
  await expect(youtube.getByText('Stream key saved')).toBeVisible();
  await expect(youtube.getByLabel('Stream key')).toHaveCount(0);

  // Not in the page, not in anything it was sent.
  expect(await page.content()).not.toContain(KEY);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain(KEY);
  for (const path of ['/api/stream', '/api/stream/devices', '/api/stream/log', '/api/snapshot'])
    expect(await (await request.get(path)).text(), path).not.toContain(KEY);
  expect(errors).toEqual([]);

  // It can be taken out again.
  await youtube.getByRole('button', { name: 'Remove key' }).click();
  await expect(youtube.getByText('No stream key yet')).toBeVisible();
});

test('turns a destination on and checks everything before going live, saying what is missing', async ({
  page,
}) => {
  await page.goto('/#/live');
  const twitch = page.locator('.lv-dest', { hasText: 'Twitch' });
  await twitch.getByRole('switch', { name: 'Stream to Twitch' }).click();
  await expect(twitch.getByLabel('Stream key')).toBeVisible();
  await page.getByRole('button', { name: 'Go live' }).click();
  // Nothing starts: the check lists what to fix.
  await expect(page.getByRole('heading', { name: 'Before you go live' })).toBeVisible();
  await expect(page.locator('.lv-checks .hg-status--error').first()).toBeVisible();
  await expect(page.getByText(/^Not live/).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop the stream' })).toHaveCount(0);
});

test('goes live with the test pattern, keeps a copy, switches scenes, and Stop ends it', async ({
  page,
  request,
}) => {
  test.skip(!hasFfmpeg, 'needs FFmpeg');
  test.setTimeout(90_000);
  const errors = watchErrors(page);
  await put(request, {
    record: true,
    scene: 'screen',
    sources: { screen: 'test', camera: 'test', mic: 'test' },
    quality: '720p30',
  });
  await page.goto('/#/live');
  await page.getByRole('button', { name: 'Go live' }).click();
  await expect(page.getByRole('timer')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('timer')).toHaveCount(0);
  await expect(page.getByText(/^Not live/).first()).toBeVisible();

  await page.getByRole('button', { name: 'Go live' }).click();
  await expect(page.locator('.lv-badge')).toBeVisible({ timeout: 30_000 });
  // The picture is the one FFmpeg composes, and the scene can change while live.
  const pic = page.getByRole('img', { name: 'What viewers will see' });
  await expect(pic).toBeVisible();
  await expect
    .poll(() => pic.evaluate((i: HTMLImageElement) => i.naturalWidth), { timeout: 20_000 })
    .toBeGreaterThan(100);
  await page.getByRole('radiogroup', { name: 'Scene' }).getByRole('radio', { name: 'Be right back' }).click();
  await expect(
    page.getByRole('radiogroup', { name: 'Scene' }).getByRole('radio', { name: 'Be right back' }),
  ).toBeChecked();
  // The settings that move the picture are locked while live.
  await expect(page.locator('select.hg-select').first()).toBeDisabled();
  await expectAccessible(page, 'live');
  await expect(page.locator('.lv-stats')).toBeVisible();

  const t0 = Date.now();
  await page.getByRole('button', { name: 'Stop the stream' }).click();
  await expect(page.locator('.lv-badge')).toHaveCount(0);
  expect(Date.now() - t0).toBeLessThan(5000);
  // The badge goes as soon as Stop is pressed; the process group is gone within two seconds after it.
  await expect
    .poll(async () => ((await (await request.get('/api/stream')).json()) as { phase: string }).phase, {
      timeout: 5000,
    })
    .toBe('idle');
  expect(errors.filter((e) => !/preview\.mjpg/.test(e))).toEqual([]);
});

// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { watchErrors } from './helpers.ts';

// A tech demo's clean backdrop: the shared window sits on it in the recording itself, padded, at the chosen shape.
// Nothing about the desktop changes; the backdrop is only in the file.
test('records a shared window on a clean backdrop, at 1:1, and the padding is the backdrop’s color', async ({
  page,
  request,
}) => {
  const errors = watchErrors(page);
  await page.context().grantPermissions(['microphone', 'camera']);
  await page.addInitScript(() => {
    localStorage.setItem('hildegard.record.mode', 'record');
    localStorage.setItem('hildegard.record.source', 'screen');
  });
  await page.goto('/#/record');
  await page.getByRole('switch', { name: 'Clean backdrop' }).click();
  await page.getByRole('radio', { name: 'Ink' }).click();
  await page.getByRole('radio', { name: '1:1' }).click();
  await page.getByRole('button', { name: 'Start recording' }).click();
  await page.getByRole('button', { name: /Start now/ }).click();
  await expect(page.getByRole('status').filter({ hasText: /^Recording/ })).toBeVisible();
  await page.waitForTimeout(2500);
  await page.getByRole('button', { name: 'Stop recording' }).click();
  await expect(page.getByLabel('Your video')).toBeVisible();
  await page.getByRole('button', { name: 'Keep' }).click();
  await expect(page.getByText('Kept with your recordings')).toBeVisible();
  const list = (await (await request.get('/api/record')).json()) as { recordings: { url: string }[] };
  const url = list.recordings[0]!.url;
  // A frame from the file: square, and the corner (inside the padding) is the Ink backdrop, #0a0e13.
  const got = await page.evaluate(async (u) => {
    const v = document.createElement('video');
    v.muted = true;
    v.src = u;
    await new Promise((r) => v.addEventListener('loadeddata', r, { once: true }));
    v.currentTime = 1;
    await new Promise((r) => v.addEventListener('seeked', r, { once: true }));
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    const g = c.getContext('2d')!;
    g.drawImage(v, 0, 0);
    return { w: v.videoWidth, h: v.videoHeight, corner: [...g.getImageData(8, 8, 1, 1).data].slice(0, 3) };
  }, url);
  expect(got.w).toBe(1080);
  expect(got.h).toBe(1080);
  for (const [i, want] of [0x0a, 0x0e, 0x13].entries())
    expect(Math.abs(got.corner[i]! - want)).toBeLessThanOrEqual(12);
  expect(errors).toEqual([]);
});

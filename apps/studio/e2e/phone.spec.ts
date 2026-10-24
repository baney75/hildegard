// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { asFirstRun, createShot, expectAccessible, freshFilm, watchErrors } from './helpers.ts';

test.afterEach(async ({ request }) => {
  await request.post('/api/engine/resume', { headers: { 'x-hildegard': '1' } });
});

test('phone: tab bar, bottom sheets, and a shot end to end', async ({ page, request }) => {
  const errors = watchErrors(page);
  await freshFilm(page, request);
  await expect(page.locator('.hg-tabbar')).toBeVisible();
  await expect(page.locator('.hg-app__nav')).toBeHidden();
  await createShot(page, 'Phone shot of the river at dawn');
  const shot = page.getByRole('region', { name: /Phone shot of the river/ });
  await expect(shot.locator('.cs-card.is-running, .cs-card.is-queued')).toHaveCount(0, { timeout: 15_000 });
  await shot.getByRole('button', { name: /^Open Draft 1,/ }).click();
  const sheet = page.locator('dialog.hg-modal--bottom');
  await expect(sheet).toBeVisible();
  const box = await sheet.boundingBox();
  const vp = page.viewportSize()!;
  expect(Math.round(box!.y + box!.height)).toBeGreaterThanOrEqual(vp.height - 2);
  await expectAccessible(page, 'phone inspector');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^Camera motion/ }).click();
  await expect(page.locator('dialog.hg-modal--bottom')).toBeVisible();
  await page.keyboard.press('Escape');
  // Every shot setting is on screen: none hidden past the edge of the row.
  const pills = page.getByRole('group', { name: 'Shot settings' }).getByRole('button');
  for (const pill of await pills.all()) {
    const b = (await pill.boundingBox())!;
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(vp.width);
  }
  // Nothing scrolls sideways.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.getByRole('link', { name: /Queue/ }).click();
  await expect(page).toHaveURL(/#\/queue/);
  await page.getByRole('link', { name: /Settings/ }).click();
  await page.getByRole('link', { name: /Hugging Face/ }).click();
  await expect(page.getByRole('heading', { name: 'Link Hugging Face' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('phone: the first-run welcome fits the screen', async ({ page, request }) => {
  const errors = watchErrors(page);
  await asFirstRun(page, request);
  await page.goto('/');
  const go = page.getByRole('button', { name: /Set up this computer/ });
  await expect(go).toBeInViewport();
  const vp = page.viewportSize()!;
  const box = await go.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(vp.width);
  await expectAccessible(page, 'phone welcome');
  await go.click();
  // Each model's button sits below its words, not on top of them.
  const row = page.locator('.hg-model', { hasText: 'Wan 2.2 5B' });
  const words = await row.getByText(/no usage limits/).boundingBox();
  const get = await row.getByRole('button', { name: /^Get/ }).boundingBox();
  expect(get!.y).toBeGreaterThanOrEqual(words!.y + words!.height);
  expect(get!.x + get!.width).toBeLessThanOrEqual(vp.width);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});

test('phone: queue filters stay on one line and the badge sits in the tab bar', async ({ page, request }) => {
  const errors = watchErrors(page);
  await freshFilm(page, request);
  await request.post('/api/engine/pause', { headers: { 'x-hildegard': '1' } });
  await createShot(page, 'Rain on a slate roof');
  await page.getByRole('link', { name: /Queue/ }).click();
  const filters = page.getByRole('radiogroup', { name: 'Show' }).getByRole('radio');
  await expect(filters).toHaveCount(4);
  for (const f of await filters.all()) {
    const lines = await f.evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
    });
    expect(lines).toBe(1);
  }
  const bar = await page.locator('.hg-tabbar').boundingBox();
  const badge = await page.locator('.hg-tabbar .hg-nav-item__badge').boundingBox();
  expect(badge!.y).toBeGreaterThanOrEqual(bar!.y);
  expect(errors).toEqual([]);
});

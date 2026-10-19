// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { createShot, expectAccessible, freshFilm, watchErrors } from './helpers.ts';

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

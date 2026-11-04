// SPDX-License-Identifier: AGPL-3.0-only
import { expect, type Page, test } from '@playwright/test';
import { expectAccessible, expectCurlyQuotes, watchErrors } from './helpers.ts';

/** Make images from words and wait for every one of them to finish. */
async function makeImages(page: Page, words: string, count: number) {
  await page.getByLabel('Describe the image').fill(words);
  await page.getByRole('radio', { name: String(count), exact: true }).click();
  await page.getByRole('button', { name: /^Make \d image/ }).click();
  const ours = page.locator('.im-card').filter({ hasText: words });
  await expect(ours).toHaveCount(count);
  await expect(ours.and(page.locator('[data-status="done"]'))).toHaveCount(count, { timeout: 20_000 });
  return ours;
}

test('makes two images from words, edits one with a reference, and the edit needs the box checked', async ({
  page,
}) => {
  const errors = watchErrors(page);
  const run = Date.now() % 100000;
  await page.goto('/#/images');
  await expect(page.getByRole('link', { name: 'Images' }).first()).toHaveAttribute('aria-current', 'page');

  const words = `A fishing boat at dawn, mist on the water ${run}`;
  const first = await makeImages(page, words, 2);
  await expectAccessible(page, 'images');
  await expectCurlyQuotes(page, 'images');

  // The lightbox shows the prompt, the seed and the size.
  await first
    .first()
    .getByRole('button', { name: /^Open\./ })
    .click();
  const box = page.getByRole('dialog', { name: 'Image' });
  await expect(box).toBeVisible();
  await expect(box.getByText(words)).toBeVisible();
  await expect(box.getByText('Seed', { exact: true })).toBeVisible();
  await expect(box.getByText(/^\d+ × \d+$/)).toBeVisible();
  await expect(box.getByRole('img')).toHaveAttribute('src', /^\/media\/stills\/.+\.png$/);
  await expectAccessible(page, 'image lightbox');

  // Edit adds it to the references and closes the lightbox.
  await box.getByRole('button', { name: 'Edit' }).click();
  await expect(box).toBeHidden();
  await expect(page.getByText('References · 1 of 4')).toBeVisible();
  await expect(page.getByRole('img', { name: 'Reference 1' })).toBeVisible();

  // The box has to be checked before the edit can be made.
  const change = `Same boat, lit by lanterns ${run}`;
  await page.getByLabel('Describe the image').fill(change);
  await page.getByRole('radio', { name: '1', exact: true }).click();
  const make = page.getByRole('button', { name: 'Make 1 image' });
  await expect(make).toBeDisabled();
  await expect(page.getByText('Check the box above to use the references.')).toBeVisible();
  await page.getByLabel(/^This image shows no real person/).check();
  await expect(make).toBeEnabled();
  await expectAccessible(page, 'images with a reference');
  await make.click();
  const edited = page.locator('.im-card').filter({ hasText: change });
  await expect(edited).toHaveCount(1);
  await expect(edited).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
  // The server drew it from the reference.
  await edited.getByRole('button', { name: /^Open\./ }).click();
  await expect(page.getByRole('dialog', { name: 'Image' }).getByText('1 reference image')).toBeVisible();
  await page.keyboard.press('Escape');

  // A new image in the set needs the box checked again: the attestation covers only the images it was given for.
  await expect(make).toBeEnabled();
  await first
    .nth(1)
    .getByRole('button', { name: /^Open\./ })
    .click();
  await page.getByRole('dialog', { name: 'Image' }).getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByText('References · 2 of 4')).toBeVisible();
  await expect(make).toBeDisabled();
  await expect(page.getByLabel(/^This image shows no real person/)).not.toBeChecked();
  expect(errors).toEqual([]);
});

test('shows the server’s error beside the part it names', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/#/images');
  await page.getByLabel('Describe the image').fill('A lighthouse in a storm');
  await page.route('**/api/images', (route) =>
    route.fulfill({
      status: 422,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'That seed is not one Hildegard can use.', field: 'seed' }),
    }),
  );
  await page.getByRole('switch', { name: 'Lock the seed' }).click();
  await page.getByRole('button', { name: /^Make \d image/ }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'That seed is not one' })).toBeVisible();
  await expect(page.getByLabel('Seed', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  // A missing model also shows the banner that leads to Settings.
  await page.unroute('**/api/images');
  await page.route('**/api/images', (route) =>
    route.fulfill({
      status: 422,
      contentType: 'application/json',
      body: JSON.stringify({
        error: 'Images are drawn with FLUX.2 [klein] 4B.',
        field: 'model',
        code: 'missing_model',
      }),
    }),
  );
  await page.getByRole('button', { name: /^Make \d image/ }).click();
  await expect(page.getByRole('link', { name: 'Settings › Models' })).toHaveAttribute(
    'href',
    '#/settings/models',
  );
  // The two refusals above are the only failed requests.
  expect(errors.filter((e) => !/http 422: POST \/api\/images/.test(e) && !/status of 422/.test(e))).toEqual(
    [],
  );
});

test('sends an image to Cinema as its start frame', async ({ page }) => {
  const errors = watchErrors(page);
  const words = `A harbor wall at noon ${Date.now() % 100000}`;
  await page.goto('/#/images');
  const ours = await makeImages(page, words, 1);
  await ours.getByRole('button', { name: 'Use as start frame' }).click();
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.getByRole('button', { name: 'Replace the start frame' })).toBeVisible();
  expect(errors).toEqual([]);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('fits in 390 pixels without scrolling sideways', async ({ page }) => {
    const errors = watchErrors(page);
    const overflow = () =>
      page.evaluate(() => {
        const wide = [...document.querySelectorAll<HTMLElement>('body *')]
          .filter((el) => el.checkVisibility() && el.getBoundingClientRect().right > window.innerWidth + 1)
          .map((el) => `${el.tagName.toLowerCase()}.${el.className}`.slice(0, 80));
        return { scroll: document.documentElement.scrollWidth - document.documentElement.clientWidth, wide };
      });
    await page.goto('/#/images');
    await expect(page.getByRole('heading', { name: 'Make an image' })).toBeVisible();
    expect(await overflow()).toEqual({ scroll: 0, wide: [] });

    await makeImages(page, `A tall door in a wall ${Date.now() % 100000}`, 2);
    await page.getByRole('button', { name: /Camera and look/ }).click();
    await page.getByRole('radio', { name: '9:16' }).click();
    await page.getByRole('switch', { name: 'Lock the seed' }).click();
    expect(await overflow()).toEqual({ scroll: 0, wide: [] });
    await expectAccessible(page, 'images on a phone');

    await page
      .locator('.im-card')
      .first()
      .getByRole('button', { name: /^Open\./ })
      .click();
    await expect(page.getByRole('dialog', { name: 'Image' })).toBeVisible();
    expect(await overflow()).toEqual({ scroll: 0, wide: [] });
    expect(errors).toEqual([]);
  });
});

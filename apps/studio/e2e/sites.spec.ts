// SPDX-License-Identifier: AGPL-3.0-only
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { expectAccessible, watchErrors } from './helpers.ts';

test('sites: start from a template, inspect it on the canvas, change its words and a token', async ({
  page,
}) => {
  const errors = watchErrors(page);
  await page.goto('/#/sites');
  await expect(page.getByRole('heading', { name: 'Start from a template' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Use this template: Hearth' })).toBeVisible();
  await expectAccessible(page, 'sites');

  await page.getByRole('button', { name: 'Use this template: Hearth' }).click();
  await expect(page).toHaveURL(/#\/sites\/[a-f0-9]{12}$/);
  const phone = page.frameLocator('iframe[title="index.html at phone width"]');
  await expect(page.locator('iframe[title="index.html at desktop width"]')).toBeVisible();
  const h1 = phone.locator('h1');
  await expect(h1).toBeVisible();
  const before = (await h1.innerText()).replace(/\s+/g, ' ').trim();

  // A click in the frame shows the element in the inspector.
  await h1.click();
  await expect(page.locator('.sc-el__tag code')).toHaveText(/^h1/);
  const words = page.getByLabel('Words');
  await expect(words).toHaveValue(before);
  await words.fill('Bread worth crossing the river for.');
  await page.getByRole('button', { name: 'Save words' }).click();
  await expect(phone.locator('h1')).toHaveText('Bread worth crossing the river for.');
  await expect(page.locator('iframe[title="index.html at desktop width"]')).toBeVisible();

  // A token changes in every frame at once, and is saved to the stylesheet.
  await page.getByRole('radio', { name: 'Tokens' }).click();
  const first = page.locator('.sc-token label input').first();
  const name = (await page.locator('.sc-token__n').first().innerText()).trim();
  await first.fill('#ff00aa');
  await first.press('Enter');
  await expect
    .poll(() =>
      phone.locator('html').evaluate((el, n) => getComputedStyle(el).getPropertyValue(n).trim(), name),
    )
    .toBe('#ff00aa');
  const site = page.url().split('/').pop()!;
  await expect
    .poll(async () => {
      const r = await page.request.get(`/api/sites/${site}/tokens`);
      const { tokens } = (await r.json()) as {
        tokens: Array<{ name: string; value: string; dark: boolean }>;
      };
      return tokens.find((t) => t.name === name && !t.dark)?.value;
    })
    .toBe('#ff00aa');

  await page.getByRole('radio', { name: 'Site' }).click();
  await expect(page.getByRole('heading', { name: 'Hand it to an AI app' })).toBeVisible();
  // The frames hold the site itself, which its own checks judge (and a token was just set to magenta).
  const r = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .exclude('iframe')
    .analyze();
  expect(
    r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id),
  ).toEqual([]);
  expect(errors).toEqual([]);
});

// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { expectAccessible, watchErrors } from './helpers.ts';

const PRESETS = ['Hildegard', 'Vellum', 'Nocturne', 'Verdant', 'Silver'];

test('a theme preset and an accent are picked in Settings and kept on reload', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/#/settings/appearance');
  const html = page.locator('html');
  const theme = (name: string) => page.getByRole('button', { name: new RegExp(`^${name}`) });
  await expect(theme('Hildegard')).toHaveAttribute('aria-pressed', 'true');
  await expect(html).toHaveAttribute('data-preset', 'hildegard');

  // By keyboard: the swatches are plain buttons in the tab order.
  await theme('Nocturne').focus();
  await page.keyboard.press('Enter');
  await expect(theme('Nocturne')).toHaveAttribute('aria-pressed', 'true');
  await expect(theme('Hildegard')).toHaveAttribute('aria-pressed', 'false');
  await expect(html).toHaveAttribute('data-preset', 'nocturne');
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#070a14');
  // Instantly, with no reload: the page itself is now the preset's ground.
  expect(await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--canvas').trim())).toBe(
    '#070a14',
  );

  // Typing a color one key at a time is not an error until the box is left or holds more than a color can.
  const hex = page.getByRole('textbox', { name: 'Accent color', exact: true });
  await hex.pressSequentially('#3a7bd');
  await expect(hex).toHaveAttribute('aria-invalid', 'false');
  expect(await page.evaluate(() => localStorage.getItem('hildegard.accent'))).toBeNull();
  await hex.pressSequentially('5');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('hildegard.accent'))).toBe('#3a7bd5');
  await expect(hex).toHaveAttribute('aria-invalid', 'false');

  // A paste with spaces, or the digits without the #, is a color too.
  await hex.fill(' #FFEE00 ');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('hildegard.accent'))).toBe('#ffee00');
  await hex.fill('3a7bd5');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('hildegard.accent'))).toBe('#3a7bd5');

  // A bad one is refused once the box is left, or at once when it is too long, and keeps the last good accent.
  await hex.fill('#ffee0');
  await expect(hex).toHaveAttribute('aria-invalid', 'false');
  await hex.blur();
  await expect(hex).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByRole('status').filter({ hasText: 'six digits' })).toBeVisible();
  await hex.fill('#ffee00ff');
  await expect(hex).toHaveAttribute('aria-invalid', 'true');
  expect(await page.evaluate(() => localStorage.getItem('hildegard.accent'))).toBe('#3a7bd5');

  // Bright yellow can't carry button text on this theme, so it is nudged, and the page says so.
  await hex.fill('#ffee00');
  await hex.blur();
  await expect(hex).toHaveValue('#ffee00');
  const note = page.getByRole('status').filter({ hasText: 'needed a nudge' });
  await expect(note).toContainText('Buttons use a darker #');
  const brand = await page.evaluate(() => document.documentElement.style.getPropertyValue('--brand'));
  expect(brand).toMatch(/^#[0-9a-f]{6}$/);
  expect(brand).not.toBe('#ffee00');

  await expect(page.locator('.hg-seg').first()).toBeVisible();
  await expectAccessible(page, 'nocturne with a nudged accent');

  await page.reload();
  await expect(html).toHaveAttribute('data-preset', 'nocturne');
  await expect(theme('Nocturne')).toHaveAttribute('aria-pressed', 'true');
  await expect(hex).toHaveValue('#ffee00');
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#070a14');
  expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--brand'))).toBe(brand);
  expect(await page.evaluate(() => localStorage.getItem('hildegard.themePreset'))).toBe('nocturne');

  // The theme is back by itself.
  await page.getByRole('button', { name: 'Use the theme’s own' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Each theme brings its own accent.' }),
  ).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('hildegard.accent'))).toBeNull();
  expect(errors).toEqual([]);
});

test('the look is on the page before the Studio’s own script runs, so nothing flashes', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('hildegard.theme', 'light');
    localStorage.setItem('hildegard.themePreset', 'verdant');
    localStorage.setItem('hildegard.accent', '#3a7bd5');
    // The page as it stands when parsing ends, before any module script has had its turn.
    document.addEventListener('DOMContentLoaded', () => {
      const h = document.documentElement;
      (window as unknown as { atParsed: unknown }).atParsed = {
        theme: h.dataset.theme,
        preset: h.dataset.preset,
        canvas: h.style.getPropertyValue('--canvas'),
        bar: document.querySelector('meta[name="theme-color"]')?.getAttribute('content'),
      };
    });
  });
  // Nothing of the app can load, built or from the dev server, so only index.html and /theme-init.js can have set it.
  await page.route(/\/(assets|src|@vite|@react-refresh|node_modules)\//, (r) => r.abort());
  await page.goto('/');
  await page.waitForFunction(() => 'atParsed' in window);
  expect(await page.evaluate(() => (window as unknown as { atParsed: unknown }).atParsed)).toEqual({
    theme: 'light',
    preset: 'verdant',
    canvas: '#e6edd8',
    bar: '#e6edd8',
  });
  await expect(page.locator('#root')).toBeEmpty();
});

test('every preset is readable in dark and light', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/#/settings/appearance');
  const mode = page.getByRole('radiogroup', { name: 'Appearance' });
  for (const m of ['Dark', 'Light']) {
    await mode.getByRole('radio', { name: m }).click();
    for (const name of PRESETS) {
      await page.getByRole('button', { name: new RegExp(`^${name}`) }).click();
      await expectAccessible(page, `${name} ${m} settings`);
    }
  }
  expect(errors).toEqual([]);
});

test('settings: find one by what it does, switch the layout, and read every shortcut', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/#/settings');
  const find = page.getByRole('searchbox', { name: 'Find a setting' });
  const nav = page.getByRole('navigation', { name: 'Settings sections' });
  await find.fill('token');
  await expect(nav.getByRole('link')).toHaveText(['Hugging Face']);
  await find.press('Enter');
  await expect(page).toHaveURL(/#\/settings\/huggingface$/);
  await expect(find).toHaveValue('');
  await find.fill('theme');
  await expect(nav.getByRole('link')).toHaveText(['Appearance']);
  await find.fill('qwertyuiop');
  await expect(nav.getByRole('status')).toHaveText('No setting matches “qwertyuiop”.');
  await find.fill('');
  // The layout switch takes effect at once and is kept for this device.
  await page.goto('/#/settings/appearance');
  const layout = page.getByRole('radiogroup', { name: 'Layout' });
  await expect(layout.getByRole('radio', { name: 'Auto' })).toHaveAttribute('aria-checked', 'true');
  await layout.getByRole('radio', { name: 'Phone' }).click();
  await expect(page.locator('.hg-app')).toHaveAttribute('data-wc', 'compact');
  await page.reload();
  await expect(page.locator('.hg-app')).toHaveAttribute('data-wc', 'compact');
  await page.getByRole('radiogroup', { name: 'Layout' }).getByRole('radio', { name: 'Auto' }).click();
  await expect(page.locator('.hg-app')).toHaveAttribute('data-wc', 'wide');
  await expectAccessible(page, 'appearance');
  await page.goto('/#/settings/shortcuts');
  await expect(page.getByRole('heading', { name: 'Keyboard shortcuts' })).toBeVisible();
  await expect(page.getByText('Jump to the prompt, from anywhere in the Studio')).toBeVisible();
  await expectAccessible(page, 'shortcuts');
  expect(errors).toEqual([]);
});

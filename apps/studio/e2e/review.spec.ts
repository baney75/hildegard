// SPDX-License-Identifier: AGPL-3.0-only
import { expect, type Page, test } from '@playwright/test';
import {
  asFirstRun,
  createShot,
  expectAccessible,
  expectCurlyQuotes,
  freshFilm,
  watchErrors,
} from './helpers.ts';

test.afterEach(async ({ request }) => {
  await request.post('/api/engine/resume', { headers: { 'x-hildegard': '1' } });
});

/** Relative luminance of an element's text colour, 0 (black) to 1 (white). */
const textLuminance = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((el) => {
      const c = document.createElement('canvas').getContext('2d')!;
      c.fillStyle = getComputedStyle(el).color;
      c.fillRect(0, 0, 1, 1);
      const [r, g, b] = [...c.getImageData(0, 0, 1, 1).data].slice(0, 3).map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    });

test('first run: the welcome fits the window, with nothing hidden below it', async ({ page, request }) => {
  const errors = watchErrors(page);
  await asFirstRun(page, request);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome to Hildegard.' })).toBeVisible();
  // The quote at the foot of the side panel sits inside the window, and the page has nothing to scroll.
  const quote = await page.locator('.hg-welcome__quote').boundingBox();
  expect(quote!.y + quote!.height).toBeLessThanOrEqual(900);
  const scroll = await page.locator('.hg-welcome').evaluate((el) => el.scrollHeight - el.clientHeight);
  expect(scroll).toBeLessThanOrEqual(0);
  await expectAccessible(page, 'welcome');
  await expectCurlyQuotes(page, 'welcome');
  await page.getByRole('button', { name: /Set up this computer/ }).click();
  await expect(page.getByRole('heading', { name: 'Pick a video model.' })).toBeVisible();
  await expectAccessible(page, 'welcome models');
  await expectCurlyQuotes(page, 'welcome models');
  expect(errors).toEqual([]);
});

test('light theme: chosen in Settings, kept on reload, and readable everywhere', async ({
  page,
  request,
}) => {
  const errors = watchErrors(page);
  await page.goto('/#/settings/computer');
  const appearance = page.getByRole('radiogroup', { name: 'Appearance' });
  await expect(appearance.getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true');
  await appearance.getByRole('radio', { name: 'Light' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  // The mark is green on vellum; the vellum one would vanish.
  await expect(page.locator('.hg-app__brand img')).toHaveAttribute('src', /mark-green/);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('meta[name="color-scheme"]')).toHaveAttribute('content', 'light');
  await expectAccessible(page, 'light settings');

  await freshFilm(page, request);
  await expectAccessible(page, 'light empty film');
  await createShot(page, 'A candle gutters in a draughty chapel [fail:oom]');
  const shot = page.getByRole('region', { name: /A candle gutters/ });
  await expect(shot.locator('.cs-card.is-failed').first()).toBeVisible({ timeout: 15_000 });
  await expect(shot.locator('.cs-card.is-running, .cs-card.is-queued')).toHaveCount(0, { timeout: 15_000 });
  // A stopped take's words sit on its last frame dimmed almost to black, so they stay light.
  expect(await textLuminance(page, '.cs-card.is-failed .cs-qmeta b')).toBeGreaterThan(0.5);
  expect(await textLuminance(page, '.cs-card.is-failed .hg-status')).toBeGreaterThan(0.3);
  await expectAccessible(page, 'light board');
  await page.goto('/#/queue');
  await expectAccessible(page, 'light queue');
  await page.goto('/#/agents');
  await page
    .getByRole('button', { name: /Link an app/ })
    .first()
    .click();
  await expect(page.getByRole('dialog', { name: 'Link an app' })).toBeVisible();
  await expectAccessible(page, 'light link an app');
  await page.keyboard.press('Escape');

  await page.goto('/#/settings/computer');
  await page.getByRole('radiogroup', { name: 'Appearance' }).getByRole('radio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('.hg-app__brand img')).toHaveAttribute('src', /mark-vellum/);
  expect(errors).toEqual([]);
});

test('light theme: the first-run welcome stays readable', async ({ page, request }) => {
  await page.addInitScript(() => localStorage.setItem('hildegard.theme', 'light'));
  await asFirstRun(page, request);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome to Hildegard.' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Hildegard' })).toHaveAttribute('src', /wordmark-green/);
  await expectAccessible(page, 'light welcome');
});

test('hovered buttons keep their contrast', async ({ page, request }) => {
  await page.goto('/#/settings/models');
  await page.locator('.hg-model', { hasText: 'Wan 2.2 5B' }).getByRole('button', { name: /^Get/ }).hover();
  await expectAccessible(page, 'hovered primary button');
  await freshFilm(page, request);
  await page.locator('.cs-create').hover();
  await expectAccessible(page, 'hovered create button');
});

test('an error toast keeps its icon small beside the words', async ({ page, request }) => {
  await freshFilm(page, request);
  await page.route('**/api/projects', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ status: 500, json: { error: 'The disk is full.' } })
      : route.continue(),
  );
  await page.getByRole('button', { name: /^Films:/ }).click();
  await page.getByRole('menuitem', { name: 'Start a new film' }).click();
  const toast = page.locator('.hg-toast', { hasText: 'The disk is full.' });
  await expect(toast).toBeVisible();
  const icon = await toast.locator('.i').first().boundingBox();
  expect(icon!.width).toBeLessThanOrEqual(24);
  const words = await toast.getByText('The disk is full.').boundingBox();
  expect(words!.x - (icon!.x + icon!.width)).toBeLessThanOrEqual(16);
});

test('queue: stopped takes are counted, dimmed and never drawn as running', async ({ page, request }) => {
  const errors = watchErrors(page);
  await freshFilm(page, request);
  await createShot(page, 'Bells ring out over a flooded valley [fail:oom]');
  const shot = page.getByRole('region', { name: /Bells ring out/ });
  await expect(shot.locator('.cs-card.is-failed')).toHaveCount(2, { timeout: 15_000 });
  await page.goto('/#/queue');
  const row = page.locator('.st-job', { hasText: 'Bells ring out' }).first();
  await expect(row).toContainText('Your GPU ran out of memory.');
  // Gold means rendering; a stopped take's bar says it stopped.
  const bar = await row.locator('.st-bar i').evaluate((el) => getComputedStyle(el).backgroundColor);
  const gold = await page.evaluate(() => {
    const d = document.createElement('i');
    d.style.color = 'var(--gold)';
    document.body.append(d);
    const c = getComputedStyle(d).color;
    d.remove();
    return c;
  });
  expect(bar).not.toBe(gold);
  await expect(row.locator('img')).toHaveClass(/dim/);
  // The Done today filter counts every row it shows, stopped ones included.
  const done = page.getByRole('radio', { name: /^Done today · \d+$/ });
  const count = Number((await done.textContent())!.match(/\d+$/)![0]);
  await done.click();
  await expect(page.locator('.st-job')).toHaveCount(count);
  await expect(page.getByText(/\d+ stopped/)).toBeVisible();
  await expectAccessible(page, 'queue with stopped takes');
  expect(errors).toEqual([]);
});

test('look sheet: option cards line their names up', async ({ page, request }) => {
  await freshFilm(page, request);
  await page.getByRole('button', { name: /^(Look|Set a look)/ }).click();
  const lighting = page.getByRole('radiogroup', { name: 'Lighting' });
  const tops = await lighting.locator('.cs-opt b').evaluateAll((els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect();
      return {
        top: Math.round(r.top),
        row: Math.round((e.parentElement as HTMLElement).getBoundingClientRect().top),
      };
    }),
  );
  for (const t of tops)
    expect(Math.abs(t.top - t.row - (tops[0]!.top - tops[0]!.row))).toBeLessThanOrEqual(1);
});

test('every screen writes curly quotes and apostrophes', async ({ page, request }) => {
  const errors = watchErrors(page);
  await freshFilm(page, request);
  await expectCurlyQuotes(page, 'empty film');
  for (const name of [/^Model:/, /^(Look|Set a look)/, /^Camera rig/, /^Camera motion/, /^Format:/]) {
    await page.getByRole('button', { name }).click();
    await expect(page.locator('dialog[open]')).toBeVisible();
    await expectCurlyQuotes(page, `sheet ${name}`);
    await page.keyboard.press('Escape');
  }
  for (const r of ['models', 'huggingface', 'computer', 'privacy', 'about']) {
    await page.goto(`/#/settings/${r}`);
    await expect(page.locator('.hg-section h2')).toBeVisible();
    await expectCurlyQuotes(page, `settings ${r}`);
  }
  await page.goto('/#/settings/models');
  await page
    .locator('.hg-model', { hasText: 'LTX-2 distilled' })
    .getByRole('button', { name: /^Get/ })
    .click();
  await expect(page.getByRole('dialog', { name: /comes under/ })).toBeVisible();
  await expectCurlyQuotes(page, 'license');
  await page.keyboard.press('Escape');
  await page.goto('/#/agents');
  await expectCurlyQuotes(page, 'agents');
  expect(errors).toEqual([]);
});

test('a finished take’s button reads its name and length, without the badge text run together', async ({
  page,
  request,
}) => {
  await freshFilm(page, request);
  await createShot(page, 'Swallows dive under a stone bridge');
  const shot = page.getByRole('region', { name: /Swallows dive/ });
  await expect(shot.locator('.cs-card.is-running, .cs-card.is-queued')).toHaveCount(0, { timeout: 15_000 });
  await expect(shot.getByRole('button', { name: 'Open Draft 1, 0:05', exact: true })).toBeVisible();
});

test('appearance can follow this device', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/#/settings/computer');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page
    .getByRole('radiogroup', { name: 'Appearance' })
    .getByRole('radio', { name: 'Match this device' })
    .click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('.hg-app__brand img')).toHaveAttribute('src', /mark-vellum/);
});

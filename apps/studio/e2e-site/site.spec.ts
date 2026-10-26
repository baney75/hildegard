// SPDX-License-Identifier: AGPL-3.0-only
// The install page (site/): both themes, desktop and phone, no sideways scroll, working OS tabs and copy buttons.
// Set SITE_SHOTS to a folder to save a full-page screenshot of each.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { expectAccessible, expectCurlyQuotes, watchErrors } from '../e2e/helpers.ts';

const shots = process.env.SITE_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });

async function noSidewaysScroll(page: Page) {
  const { scroll, client } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(scroll, 'page is wider than the window').toBeLessThanOrEqual(client);
  // Nothing inside sticks out past the window either, even where overflow is hidden.
  const wide = await page.evaluate(() => {
    const w = document.documentElement.clientWidth;
    return [...document.querySelectorAll('main *, header *, footer *')]
      .filter((el) => {
        if (!(el instanceof HTMLElement) || !el.checkVisibility()) return false;
        if (el.closest('.hero__glow, .reel__bloom, .sprite')) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && (r.right > w + 0.5 || r.left < -0.5);
      })
      .map((el) => `${el.tagName.toLowerCase()}.${el.className}`)
      .slice(0, 5);
  });
  expect(wide, 'elements past the edge').toEqual([]);
}

for (const scheme of ['dark', 'light'] as const) {
  test.describe(`${scheme} theme`, () => {
    test.use({ colorScheme: scheme });

    test('loads cleanly, fits the window and reads well', async ({ page }, info) => {
      const errors = watchErrors(page);
      await page.goto('/index.html');
      await page.evaluate(() => document.fonts.ready);
      await expect(page.getByRole('heading', { level: 1 })).toContainText('Your own AI studio');
      await noSidewaysScroll(page);
      await expectCurlyQuotes(page, scheme);
      await expectAccessible(page, `${scheme} ${info.project.name}`);
      // No em-dashes anywhere a person reads.
      expect(await page.locator('body').innerText()).not.toMatch(/—/);
      if (shots) {
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.screenshot({ path: join(shots, `${info.project.name}-${scheme}.png`), fullPage: true });
        await page.screenshot({ path: join(shots, `${info.project.name}-${scheme}-top.png`) });
      }
      expect(errors).toEqual([]);
    });
  });
}

test('the OS tabs switch the commands, by click and by keyboard, everywhere at once', async ({
  page,
}, info) => {
  await page.goto('/index.html#windows');
  const tabs = page.getByRole('tablist', { name: 'Your computer' });
  await expect(tabs.getByRole('tab', { name: 'Windows' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#panel-windows')).toContainText(
    'irm https://dbaney.com/hildegard/install.ps1 | iex',
  );
  await expect(page.locator('#panel-windows [data-desktop]')).toHaveAttribute(
    'href',
    'https://github.com/baney75/hildegard/releases/latest/download/Hildegard_x64-setup.exe',
  );

  await tabs.getByRole('tab', { name: 'macOS' }).click();
  await expect(page.locator('#panel-mac')).toBeVisible();
  await expect(page.locator('#panel-windows')).toBeHidden();
  await expect(page.locator('#panel-mac')).toContainText(
    'curl -fsSL https://dbaney.com/hildegard/install.sh | sh',
  );
  await expect(page.locator('#panel-mac [data-desktop]')).toHaveAttribute('href', /Hildegard_aarch64\.dmg$/);
  // The checks and removal further down follow along, once their folds are open.
  await page.locator('#verify summary').click();
  await page.locator('#remove summary').click();
  await expect(page.locator('#vpanel-mac')).toBeVisible();
  await expect(page.locator('#rpanel-mac')).toBeVisible();
  // The hero leads with the desktop app for the computer picked; a phone is sent to the install section.
  await expect(page.locator('.hero [data-desktop]')).toHaveAttribute(
    'href',
    info.project.name === 'phone' ? '#install' : /Hildegard_aarch64\.dmg$/,
  );

  // Arrow keys move between tabs, as the ARIA tabs pattern has it.
  await tabs.getByRole('tab', { name: 'macOS' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(tabs.getByRole('tab', { name: 'Linux' })).toBeFocused();
  await expect(tabs.getByRole('tab', { name: 'Linux' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#panel-linux [data-desktop]')).toHaveAttribute(
    'href',
    /Hildegard_amd64\.AppImage$/,
  );
  await page.keyboard.press('End');
  await expect(tabs.getByRole('tab', { name: 'Omarchy' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#panel-omarchy')).toContainText(
    'omarchy plugin add https://github.com/baney75/omarchy-hildegard --enable',
  );
  // Omarchy uses the Linux checks.
  await expect(page.locator('#vpanel-linux')).toBeVisible();
  await expect(page.locator('#rpanel-omarchy')).toContainText('omarchy plugin remove');
});

test('copy buttons are there and copy the command', async ({ page, context, browserName }, info) => {
  test.skip(browserName !== 'chromium');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/index.html#linux');
  const panel = page.locator('#panel-linux');
  const copies = page.locator('button.copy:visible');
  // The checksum and removal commands sit in closed folds, so they don't count here.
  expect(await copies.count()).toBeGreaterThanOrEqual(10);
  await panel.getByRole('button', { name: 'Copy the terminal install line' }).click();
  await expect(panel.getByRole('button', { name: 'Copy the terminal install line' })).toContainText(
    info.project.name === 'phone' ? '' : 'Copied',
  );
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    'curl -fsSL https://dbaney.com/hildegard/install.sh | sh',
  );
  await page.getByRole('button', { name: 'Copy prompt for your agent' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('INSTALL-FOR-AGENTS.md');
});

test('the work shows real stills with their captions, and opens larger', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/index.html');
  // The hero frame carries its caption: the prompt, the model, the GPU and the render time.
  const hero = page.locator('.reel');
  await expect(hero.locator('.reel__prompt')).toContainText('a quill pen paints');
  await expect(hero.locator('.reel__meta')).toContainText('Wan 2.2 5B');
  await expect(hero.locator('.reel__meta')).toContainText('12 min 10 s');
  // The gallery holds the other five, each with its prompt, rig and render time.
  const stills = page.locator('[data-gallery] .still');
  await expect(stills).toHaveCount(5);
  for (const s of await stills.all()) {
    await expect(s.locator('.still__prompt')).not.toBeEmpty();
    await expect(s.locator('.still__rig')).not.toBeEmpty();
    await expect(s.locator('.still__meta')).toContainText('min');
  }
  await page.getByRole('button', { name: 'See Neon Rain, shot II larger' }).click();
  const box = page.locator('[data-lightbox]');
  await expect(box).toBeVisible();
  await expect(box).toContainText('A woman in a red raincoat');
  // The take itself plays there, with its controls and the still as its poster.
  await expect(box.locator('video')).toHaveAttribute('src', 'video/work/neon-raincoat.mp4');
  await expect(box.locator('video')).toHaveAttribute('poster', 'img/work/neon-raincoat.webp');
  await page.keyboard.press('Escape');
  await expect(box).toBeHidden();
  expect(errors).toEqual([]);
});

test('the takes move only for visitors who welcome motion, and the reel can be paused', async ({ page }) => {
  await page.goto('/index.html');
  const toggle = page.getByRole('button', { name: 'Pause the reel' });
  await expect(toggle).toBeVisible();
  await expect(page.locator('.reel video')).toHaveAttribute('src', 'video/reel.mp4');
  await expect(page.locator('[data-gallery] video')).toHaveCount(5);
  await toggle.click();
  await expect(page.getByRole('button', { name: 'Play the reel' })).toBeVisible();
  expect(await page.locator('.reel video').evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  await expect(page.locator('video')).toHaveCount(0);
  await expect(page.locator('[data-reel-toggle]')).toBeHidden();
});

test('search engines read the same answers people do', async ({ page }) => {
  await page.goto('/index.html');
  const graph = JSON.parse((await page.locator('script[type="application/ld+json"]').textContent()) ?? '')[
    '@graph'
  ];
  const app = graph.find((n: { '@type': string }) => n['@type'] === 'SoftwareApplication');
  expect(app.offers.price).toBe('0');
  const faq = graph.find((n: { '@type': string }) => n['@type'] === 'FAQPage');
  const asked = await page.locator('#faq summary .fold__t').allTextContents();
  expect(faq.mainEntity.map((q: { name: string }) => q.name)).toEqual(asked);
  const answers = await page.locator('#faq .fold__body').allTextContents();
  expect(faq.mainEntity.map((q: { acceptedAnswer: { text: string } }) => q.acceptedAnswer.text)).toEqual(
    answers.map((a) => a.trim()),
  );
  // Six rooms, each saying plainly whether it's ready.
  await expect(page.locator('.room')).toHaveCount(6);
  for (const state of await page.locator('.room__state').allTextContents())
    expect(['Ready', 'With your AI app', 'Coming']).toContain(state);
});

// A broken link preview fails silently on X and everywhere else, so the share tags are checked here.
test('has a full link preview for X and Open Graph', async ({ page }) => {
  await page.goto('/index.html');
  const meta = (key: string) =>
    page.locator(`meta[property="${key}"], meta[name="${key}"]`).first().getAttribute('content');
  expect(await meta('twitter:card')).toBe('summary_large_image');
  const image = (await meta('og:image'))!;
  expect(await meta('twitter:image')).toBe(image);
  expect(image).toMatch(/^https:\/\/dbaney\.com\/hildegard\/img\/og\.jpg\?v=\d+$/);
  for (const key of ['og:title', 'og:description', 'og:image:alt', 'twitter:title', 'twitter:description'])
    expect((await meta(key))?.length, key).toBeGreaterThan(20);
  expect((await meta('twitter:title'))!.length).toBeLessThanOrEqual(70);
  expect((await meta('twitter:description'))!.length).toBeLessThanOrEqual(200);
  // The card itself: the size the tags promise, and small enough for every site that fetches it.
  const res = await page.request.get('/img/og.jpg');
  expect(res.headers()['content-type']).toContain('image/jpeg');
  const body = await res.body();
  expect(body.length).toBeLessThan(300_000);
  const size = await page.evaluate(async () => {
    const img = new Image();
    img.src = 'img/og.jpg';
    await img.decode();
    return [img.naturalWidth, img.naturalHeight];
  });
  expect(size).toEqual([Number(await meta('og:image:width')), Number(await meta('og:image:height'))]);
});

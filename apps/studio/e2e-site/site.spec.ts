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
        if (el.closest('.hero__glow, .frame__shot, .sprite')) return false;
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
      await expect(page.getByRole('heading', { level: 1 })).toContainText('Your own film studio');
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
    'https://github.com/baney75/hildegard/releases/latest/download/Hildegard_x64.msi',
  );

  await tabs.getByRole('tab', { name: 'macOS' }).click();
  await expect(page.locator('#panel-mac')).toBeVisible();
  await expect(page.locator('#panel-windows')).toBeHidden();
  await expect(page.locator('#panel-mac')).toContainText(
    'curl -fsSL https://dbaney.com/hildegard/install.sh | sh',
  );
  await expect(page.locator('#panel-mac [data-desktop]')).toHaveAttribute('href', /Hildegard_aarch64\.dmg$/);
  // The checks and removal further down follow along.
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

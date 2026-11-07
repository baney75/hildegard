// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { expectAccessible, expectCurlyQuotes, watchErrors } from './helpers.ts';

// Settings › Writing: your own voice, on this computer, where you are the owner.
test.describe.configure({ mode: 'serial' });

test('adds a sample, removes it, and keeps voice notes', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/#/settings/writing');
  await expect(page.getByRole('heading', { name: 'Writing' })).toBeVisible();
  await expect(page.getByText('No samples yet.')).toBeVisible();
  await expectAccessible(page, 'writing, empty');
  await expectCurlyQuotes(page, 'writing, empty');

  // A sample is added from pasted words…
  await page.getByLabel('Title').fill('Letter to the parish');
  await page.getByLabel('Your writing').fill('Dear all, the roof is done. Come see it on Sunday.');
  await page.getByRole('button', { name: 'Add sample' }).click();
  const list = page.getByRole('list', { name: 'Your samples' });
  await expect(list.getByText('Letter to the parish')).toBeVisible();
  await expect(list.getByText(/11 words · pasted/)).toBeVisible();

  // …or from a file read in the browser.
  await page.locator('input[type="file"]').setInputFiles({
    name: 'sermon.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# Sermon\n\nPlain words, said once.\n'),
  });
  await expect(page.getByLabel('Title')).toHaveValue('sermon');
  await page.getByRole('button', { name: 'Add sample' }).click();
  await expect(list.getByText('sermon.md', { exact: false })).toBeVisible();
  await expectAccessible(page, 'writing, with samples');

  await page.getByRole('button', { name: 'Remove sermon' }).click();
  await expect(list.getByText(/sermon\.md/)).toBeHidden();

  // The voice notes save, and the next save keeps the one before.
  const notes = page.getByLabel('Voice notes');
  await notes.fill('Short sentences. Say it plain.');
  await page.getByRole('button', { name: 'Save voice notes' }).click();
  await expect(page.getByText('Last saved')).toBeVisible();
  await notes.fill('Short sentences. Say it plain. Never “delve”.');
  await page.getByRole('button', { name: 'Save voice notes' }).click();
  await expect(page.getByText('1 earlier version is kept.')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Voice notes')).toHaveValue('Short sentences. Say it plain. Never “delve”.');
  await expectCurlyQuotes(page, 'writing, with notes');

  await page.getByRole('button', { name: 'Remove Letter to the parish' }).click();
  await expect(page.getByText('No samples yet.')).toBeVisible();
  expect(errors).toEqual([]);
});

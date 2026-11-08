// SPDX-License-Identifier: AGPL-3.0-only
// Post: from a finished export to a checklist, on the stand-in GPU. Nothing here posts, and nothing reaches a platform:
// any request to one is answered by a stand-in before it leaves the browser.
import { expect, test } from '@playwright/test';
import { createShot, expectAccessible, freshFilm, watchErrors } from './helpers.ts';

test.setTimeout(240_000);

test('post: prepares a file and words per platform, and takes you to the site without posting', async ({
  page,
  request,
  context,
}) => {
  const errors = watchErrors(page);
  const reached: string[] = [];
  await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => {
    reached.push(route.request().url());
    // A stand-in page: the request is answered here and goes no further.
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<title>stand-in</title>' });
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);

  await freshFilm(page, request);
  await createShot(page, 'A heron lifts off the river at first light');
  const shot = page.getByRole('region', { name: /A heron lifts off/ });
  await expect(shot.locator('.cs-card.is-running, .cs-card.is-queued')).toHaveCount(0, { timeout: 15_000 });
  await page.getByRole('button', { name: 'Export film' }).click();
  const exportDlg = page.getByRole('dialog', { name: 'Export film' });
  await exportDlg.getByRole('button', { name: 'Export' }).click();
  await expect(exportDlg.locator('video')).toBeVisible({ timeout: 30_000 });
  await exportDlg.getByRole('button', { name: 'Post…' }).click();

  const dlg = page.getByRole('dialog', { name: 'Post' });
  await expect(dlg.getByText('You press Post, on the site.')).toBeVisible();
  await dlg.getByRole('textbox', { name: 'Title', exact: true }).fill('Heron at first light');
  await dlg.getByLabel(/About it, in your words/).fill('A heron lifts off the river as the mist burns away.');
  await dlg.getByLabel(/Your hashtags/).fill('heron #river');
  await dlg.getByRole('checkbox', { name: 'TikTok' }).check();
  await dlg.getByRole('checkbox', { name: 'X', exact: true }).check();
  // YouTube posts as a video, so it is offered for a film and not for an image.
  await expect(dlg.getByRole('checkbox', { name: 'YouTube', exact: true })).toBeEnabled();
  await expectAccessible(page, 'post sheet');
  await dlg.getByRole('button', { name: 'Prepare 2 files' }).click();

  const tiktok = dlg.getByRole('listitem').filter({ hasText: 'TikTok' });
  await expect(tiktok.getByText(/1080 × 1920/)).toBeVisible({ timeout: 120_000 });
  const x = dlg.getByRole('listitem').filter({ hasText: /^X/ });
  await expect(x.getByText(/1920 × 1080/)).toBeVisible({ timeout: 120_000 });
  await expect(tiktok.getByRole('textbox')).toHaveValue(
    /Heron at first light[\s\S]*#heron #river #AIGenerated/,
  );
  await expect(x.getByText(/of 280 characters/)).toBeVisible();
  await expectAccessible(page, 'post checklist');

  // Open X: the caption is copied, and the link goes to X's own page for posting, in a tab of its own.
  const popup = context.waitForEvent('page');
  await x.getByRole('link', { name: 'Open X' }).click();
  expect((await popup).url()).toBe('https://x.com/compose/post');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/^Heron at first light/);

  await x.getByRole('checkbox', { name: 'Posted' }).click();
  await expect(x.getByRole('checkbox', { name: 'Posted' })).toBeChecked();
  await expect(dlg.getByText('1 of 2 posted')).toBeVisible();
  await dlg.getByRole('button', { name: 'Done' }).click();
  await expect(dlg).toHaveCount(0);

  // The checklist is kept: opening Post again finds it where it was left.
  await exportDlg.getByRole('button', { name: 'Post…' }).click();
  await expect(page.getByRole('dialog', { name: 'Post' }).getByText('1 of 2 posted')).toBeVisible();

  // The only thing that tried to reach a platform was the person's own click on Open X, in a tab, never a request
  // from Hildegard's pages.
  expect(reached.filter((u) => !u.startsWith('https://x.com/compose/post'))).toEqual([]);
  expect(errors).toEqual([]);
});

test('sites: lists where you post, adds a site and takes it off again', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/#/browse');
  await expect(page.getByRole('heading', { name: 'Sites', level: 2 })).toBeVisible();
  for (const name of ['X', 'YouTube', 'Instagram', 'TikTok', 'Facebook', 'Threads', 'Reddit', 'LinkedIn'])
    await expect(page.getByRole('link', { name, exact: true })).toBeVisible();
  await expect(page.getByText(/Google doesn’t allow signing in inside an app/)).toBeVisible();
  await page.getByLabel('Name').fill('Bluesky');
  await page.getByLabel('Address').fill('http://bsky.app');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText(/Give the site’s address, starting with https/)).toBeVisible();
  await page.getByLabel('Address').fill('https://bsky.app');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Bluesky' })).toBeVisible();
  await expectAccessible(page, 'sites');
  await page.getByRole('button', { name: 'Remove Bluesky' }).click();
  await expect(page.getByRole('link', { name: 'Bluesky' })).toHaveCount(0);
  // The refused address answers 400, which the browser logs; nothing else may be wrong.
  expect(errors.filter((e) => !/\b400\b/.test(e))).toEqual([]);
});

// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { expectAccessible, expectCurlyQuotes, watchErrors } from './helpers.ts';

// The link only exists when Hildegard is shared over https, which the test server isn't; the server's own tests
// cover the link routes. Here the phone page is shown its answers, to check what the speaker sees and does.
const TOKEN = 'a'.repeat(32);

test('phone: the speaker reads the consent line on their own phone, and that’s all the page can do', async ({
  page,
}) => {
  const errors = watchErrors(page);
  let posted = 0;
  await page.route(`**/api/consent/${TOKEN}`, (r) =>
    r.fulfill({
      json: {
        speaker: 'Anna',
        line: 'My name is Anna. I agree that Hildegard may make a copy of my voice. amber violin meadow comet.',
        expiresAt: new Date(Date.now() + 9 * 60_000).toISOString(),
        recorded: false,
      },
    }),
  );
  await page.route(`**/api/consent/${TOKEN}/recording`, (r) => {
    posted++;
    return r.fulfill({ json: { recorded: true } });
  });
  await page.context().grantPermissions(['microphone']);
  await page.goto(`/#/consent/${TOKEN}`);
  await expect(page.getByText('Hello, Anna. Read this aloud, once.')).toBeVisible();
  await expect(page.locator('.st-prompter')).toContainText('amber violin meadow comet');
  // No Studio: no navigation, no films, nothing of the owner's.
  await expect(page.locator('.hg-app__nav, .hg-tabbar')).toHaveCount(0);
  await expectAccessible(page, 'phone consent');
  await expectCurlyQuotes(page, 'phone consent');
  await page.getByRole('button', { name: 'Record your consent' }).click();
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'Stop recording' }).click();
  await expect(page.getByRole('heading', { name: 'Thank you, Anna' })).toBeVisible();
  expect(posted).toBe(1);
  expect(errors).toEqual([]);
});

test('phone: an expired consent link says so', async ({ page }) => {
  await page.route(`**/api/consent/${TOKEN}`, (r) =>
    r.fulfill({ status: 410, json: { error: 'This consent link has expired. Ask for a new one.' } }),
  );
  await page.goto(`/#/consent/${TOKEN}`);
  await expect(page.getByRole('heading', { name: 'This link doesn’t work' })).toBeVisible();
  await expect(page.getByText('This consent link has expired. Ask for a new one.')).toBeVisible();
});

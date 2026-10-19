// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { createShot, expectAccessible, freshFilm, watchErrors } from './helpers.ts';

// One server for the whole run: leave the queue running for the next test, whatever happened in this one.
test.afterEach(async ({ request }) => {
  await request.post('/api/engine/resume', { headers: { 'x-hildegard': '1' } });
});

test('opens fast with no errors and an accessible empty state', async ({ page, request }) => {
  const errors = watchErrors(page);
  const t0 = Date.now();
  await freshFilm(page, request);
  await expect(page.getByRole('heading', { name: /Every film begins/ })).toBeVisible();
  expect(Date.now() - t0).toBeLessThan(3000);
  const timing = await page.evaluate(() => {
    const n = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
    return {
      dcl: n.domContentLoadedEventEnd,
      bytes: performance
        .getEntriesByType('resource')
        .reduce((s, r) => s + ((r as PerformanceResourceTiming).transferSize || 0), 0),
    };
  });
  expect(timing.dcl).toBeLessThan(1500);
  await expectAccessible(page, 'empty');
  expect(errors).toEqual([]);
});

test('directs a shot: drafts render with progress, then finalize', async ({ page, request }) => {
  const errors = watchErrors(page);
  await freshFilm(page, request);
  await createShot(page, 'A beekeeper lifts the lid of a hive as the first bees rise into the backlight');
  const shot = page.getByRole('region', { name: /A beekeeper lifts the lid/ });
  await expect(shot).toBeVisible();
  await expect(shot.getByText(/Rendering|Starting/).first()).toBeVisible();
  await expect(shot.getByRole('button', { name: /^Open Draft 1,/ })).toBeVisible();
  await expect(shot.locator('.cs-card.is-running, .cs-card.is-queued')).toHaveCount(0, { timeout: 15_000 });
  // On a wide window the first take of a new shot is already open in the inspector.
  await expect(shot.getByRole('button', { name: /^Open Draft 1,/ })).toHaveAttribute('aria-pressed', 'true');
  const insp = page.locator('.cs-insp');
  await expect(insp.getByText('Done', { exact: true })).toBeVisible();
  await expect(insp.getByRole('link', { name: /Download/ })).toHaveAttribute('href', /\/media\/\w+\.mp4$/);
  await expectAccessible(page, 'board with inspector');
  await insp.getByRole('button', { name: 'Finalize' }).click();
  await expect(shot.getByRole('button', { name: /^Open Take 3,/ })).toBeVisible();
  await expect(shot.locator('.cs-card.is-running, .cs-card.is-queued')).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator('.cs-insp .cs-meta1')).toContainText('1088p');
  // Play the finished take.
  await page.locator('.cs-insp').getByRole('button', { name: /^Play/ }).click();
  await expect(page.locator('.cs-insp video')).toBeVisible();
  expect(errors).toEqual([]);
});

test('rig, motion, look and format sheets change the next shot', async ({ page, request }) => {
  const errors = watchErrors(page);
  await freshFilm(page, request);
  await page.getByRole('button', { name: /^Camera rig/ }).click();
  const rig = page.getByRole('dialog', { name: 'Camera rig' });
  await expect(rig).toBeVisible();
  await expectAccessible(page, 'rig sheet');
  await rig.getByRole('radio', { name: /Vintage 16mm/ }).click();
  await rig.getByRole('radio', { name: /Vintage anamorphic/ }).click();
  await rig.getByRole('radio', { name: /^50/ }).click();
  await expect(rig.getByText('Frame changes to 2.39:1')).toBeVisible();
  await rig.getByRole('button', { name: 'Use this rig' }).click();
  await expect(rig).toBeHidden();
  await expect(page.getByRole('button', { name: /^Format: 2.39:1/ })).toBeVisible();

  await page.getByRole('button', { name: /^Camera motion/ }).click();
  const motion = page.getByRole('dialog', { name: 'Camera motion' });
  await motion.getByRole('checkbox', { name: /Dolly in/ }).click();
  await motion.getByRole('checkbox', { name: /Crane up/ }).click();
  await motion.getByRole('checkbox', { name: /Orbit 360/ }).click();
  // Only two at once: the oldest falls away.
  await expect(motion.getByRole('checkbox', { checked: true })).toHaveCount(2);
  await expectAccessible(page, 'motion sheet');
  await motion.getByRole('button', { name: 'Use motion' }).click();
  await expect(page.getByRole('button', { name: 'Camera motion: Crane up + Orbit 360' })).toBeVisible();

  await page.getByRole('button', { name: /^(Look|Set a look)/ }).click();
  const look = page.getByRole('dialog', { name: 'Look' });
  await look.getByRole('radio', { name: /Golden hour/ }).click();
  await look.getByRole('radio', { name: /Honey and moss/ }).click();
  await expectAccessible(page, 'look sheet');
  await look.getByRole('button', { name: 'Use this look' }).click();
  await expect(page.getByRole('button', { name: /Look: Golden hour · Honey and moss/ })).toBeVisible();

  await page.getByRole('button', { name: /^Format/ }).click();
  const fmt = page.getByRole('dialog', { name: 'Format' });
  await fmt.getByRole('radio', { name: '16:9' }).click();
  await fmt.getByRole('button', { name: 'Fewer takes' }).click();
  await fmt.getByRole('button', { name: 'Lock a seed' }).click();
  await fmt.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('button', { name: /Seed \d+, locked/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Create 1 draft/ })).toBeVisible();

  // Escape closes a sheet without applying it.
  await page.getByRole('button', { name: /^Camera rig/ }).click();
  await page
    .getByRole('dialog', { name: 'Camera rig' })
    .getByRole('radio', { name: /Super 8/ })
    .click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: /^Camera rig: Vintage 16mm/ })).toBeVisible();

  await createShot(page, 'Mara walks the rows at dusk');
  const shot = page.getByRole('region', { name: /Mara walks the rows/ });
  await expect(shot.locator('.cs-card')).toHaveCount(1);
  await shot.getByRole('button', { name: /Open Draft/ }).click();
  await page.locator('.cs-insp summary', { hasText: 'Settings' }).click();
  await expect(page.locator('.cs-insp')).toContainText('Vintage 16mm · Vintage anamorphic · 50mm');
  await expect(page.locator('.cs-insp .hg-kv__prompt')).toContainText('cranes up');
  expect(errors).toEqual([]);
});

test('Force now confirms, says what it stops, and jumps the queue', async ({ page, request }) => {
  const errors = watchErrors(page);
  await freshFilm(page, request);
  await request.post('/api/engine/pause', { headers: { 'x-hildegard': '1' } });
  await createShot(page, 'Storm clouds roll over the vineyard');
  const shot = page.getByRole('region', { name: /Storm clouds/ });
  await expect(shot.getByText('Paused').first()).toBeVisible();
  await shot.getByRole('button', { name: 'Force now' }).last().click();
  const dlg = page.getByRole('dialog', { name: /^Force .* now\?/ });
  await expect(dlg.getByText('Resumes rendering')).toBeVisible();
  await expectAccessible(page, 'force dialog');
  await dlg.getByRole('button', { name: 'Force now' }).click();
  await expect(dlg).toBeHidden();
  await expect(shot.locator('.cs-card.is-running, .cs-card.is-queued')).toHaveCount(0, { timeout: 15_000 });
  expect(errors).toEqual([]);
});

test('a GPU failure explains itself and retries', async ({ page, request }) => {
  const errors = watchErrors(page);
  await freshFilm(page, request);
  await page.getByRole('button', { name: /^Format/ }).click();
  await page.getByRole('dialog', { name: 'Format' }).getByRole('button', { name: 'Lock a seed' }).click();
  await page.getByRole('dialog', { name: 'Format' }).getByRole('button', { name: 'Done' }).click();
  await createShot(page, 'A lantern swings in the dark [fail:oom]');
  const shot = page.getByRole('region', { name: /A lantern swings/ });
  await expect(shot.getByText('Your GPU ran out of memory.').first()).toBeVisible({ timeout: 15_000 });
  await shot.getByRole('button', { name: /^Open Draft 1,/ }).click();
  const insp = page.locator('.cs-insp');
  await expect(insp).toContainText('Try Draft quality or a shorter take');
  await expect(insp).toContainText('nothing was spent');
  await insp.getByRole('button', { name: /^Retry/ }).click();
  await expect(shot.getByText('Your GPU ran out of memory.').first()).toBeVisible({ timeout: 15_000 });
  expect(errors).toEqual([]);
});

test('queue lists work and pauses and resumes', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/#/queue');
  await expect(
    page
      .getByRole('heading', { name: 'Done today' })
      .or(page.getByText('Done today', { exact: true }))
      .first(),
  ).toBeVisible();
  await expectAccessible(page, 'queue');
  await page.getByRole('button', { name: 'Pause all' }).click();
  await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible();
  await page.getByRole('button', { name: 'Resume' }).click();
  await page
    .getByRole('button', { name: /A beekeeper lifts the lid.*Draft 1/ })
    .first()
    .click();
  await expect(page).toHaveURL(/#\/film\/\w+\/take\/\w+/);
  await expect(page.locator('.cs-insp')).toContainText('Draft 1');
  expect(errors).toEqual([]);
});

test('settings: models and Hugging Face linking', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/#/settings/models');
  await expect(page.getByRole('heading', { name: 'Models' })).toBeVisible();
  await expect(page.locator('.hg-model__name', { hasText: 'LTX-2.5 distilled' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Link Hugging Face' })).toBeVisible();
  await expectAccessible(page, 'models');
  // A model's license comes before its first download, in plain words, with the full text a click away.
  const wan = page.locator('.hg-model', { hasText: 'Wan 2.2 5B' });
  await wan.getByRole('button', { name: /^Get/ }).click();
  const license = page.getByRole('dialog', { name: 'Wan 2.2 5B comes under the Apache-2.0' });
  await expect(license.getByText('commercial work included')).toBeVisible();
  await expect(license.getByRole('link', { name: 'Read the full Apache-2.0' })).toHaveAttribute(
    'href',
    /Wan2\.2/,
  );
  await expectAccessible(page, 'license');
  await license.getByRole('button', { name: 'Not now' }).click();
  await expect(license).toBeHidden();
  await expect(wan.getByRole('button', { name: /^Get/ })).toBeVisible();
  await page.getByRole('button', { name: 'Link Hugging Face' }).click();
  await expect(page.getByRole('heading', { name: 'Link Hugging Face' })).toBeVisible();
  await page.getByLabel('Hugging Face token').fill('not-a-token');
  await page.getByRole('button', { name: 'Link this token' }).click();
  await expect(page.getByRole('alert')).toContainText('start with hf_');
  await expectAccessible(page, 'hugging face');
  // Typing a token never echoes it.
  await expect(page.getByLabel('Hugging Face token')).toHaveAttribute('type', 'password');
  expect(errors).toEqual([]);
});

test('about: version, the source for this build, and the notices', async ({ page, request }) => {
  const errors = watchErrors(page);
  await page.goto('/#/settings/about');
  await expect(page.getByRole('heading', { name: 'About Hildegard' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Source code for this version' })).toHaveAttribute(
    'href',
    /^https:\/\/github\.com\/baney75\/hildegard(\/tree\/[0-9a-f]{40})?$/,
  );
  const notices = await request.get('/THIRD_PARTY_NOTICES.txt');
  expect(notices.headers()['content-type']).toContain('text/plain');
  const text = await notices.text();
  expect(text).toContain('SIL Open Font License');
  expect(text).toContain('## react ');
  await expectAccessible(page, 'about');
  expect(errors).toEqual([]);
});

test('keyboard: Ctrl-K focuses the prompt, F forces, Escape closes', async ({ page, request }) => {
  await freshFilm(page, request);
  await page.locator('body').click();
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.locator('#hg-prompt')).toBeFocused();
  await request.post('/api/engine/pause', { headers: { 'x-hildegard': '1' } });
  await createShot(page, 'Keyboard only shot');
  const shot = page.getByRole('region', { name: /Keyboard only shot/ });
  await shot.getByRole('button', { name: /^Open Draft 1,/ }).click();
  await page.keyboard.press('Escape');
  await shot.getByRole('button', { name: /^Open Draft 1,/ }).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('f');
  await expect(page.getByRole('dialog', { name: /^Force/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: /^Force/ })).toBeHidden();
  await request.post('/api/engine/resume', { headers: { 'x-hildegard': '1' } });
});

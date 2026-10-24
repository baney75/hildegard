// SPDX-License-Identifier: AGPL-3.0-only
import type { Character, Take } from '@hildegard/presets';
import { expect, type Page, test } from '@playwright/test';
import { expectAccessible, expectCurlyQuotes, freshFilm, watchErrors } from './helpers.ts';

test.afterEach(async ({ request }) => {
  await request.post('/api/engine/resume', { headers: { 'x-hildegard': '1' } });
});

/** A camera for a headless browser: a canvas that changes every frame, so each photo differs as a real one would. */
async function fakeCamera(page: Page) {
  await page.addInitScript(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 480;
    const g = canvas.getContext('2d')!;
    let n = 0;
    const draw = () => {
      n++;
      g.fillStyle = `hsl(${(n * 7) % 360} 40% 50%)`;
      g.fillRect(0, 0, 640, 480);
      g.fillStyle = '#fff';
      g.font = '48px sans-serif';
      g.fillText(String(n), 40, 80);
      requestAnimationFrame(draw);
    };
    draw();
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: async () => canvas.captureStream(30) },
    });
  });
}

test('makes a character, keeps a face, draws a sheet, and casts them with @', async ({ page, request }) => {
  const errors = watchErrors(page);
  const name = `Mara ${Date.now() % 100000}`;
  await page.goto('/#/characters');
  await page.getByRole('button', { name: 'New character' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New character' });
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByLabel('Description').fill('Early thirties, auburn side braid, light freckles');
  await dialog.getByLabel('Outfit · optional').fill('an undyed linen shirt');
  await expectAccessible(page, 'new character');
  await dialog.getByRole('button', { name: 'Create and draw portraits' }).click();

  const panel = page.getByRole('region', { name: `Edit ${name}` });
  await expect(panel).toBeVisible();
  // Four portraits to pick a face from.
  await expect(panel.locator('.cs-still')).toHaveCount(4);
  await expect(panel.getByRole('button', { name: 'Keep' })).toHaveCount(4, { timeout: 15_000 });
  await panel.getByRole('button', { name: 'Keep' }).first().click();
  await expect(panel.getByText('References · 1 of 8')).toBeVisible();
  await expect(panel.getByText('Face', { exact: true })).toBeVisible();

  // Then the other angles, drawn from that face.
  await panel.getByRole('button', { name: 'Draw the other angles' }).click();
  await expect(panel.getByRole('button', { name: 'Keep' })).toHaveCount(6, { timeout: 15_000 });
  await expectAccessible(page, 'character panel');
  await expectCurlyQuotes(page, 'character panel');
  const card = page.getByRole('button', { name: new RegExp(`^${name}`) });
  await expect(card).toBeVisible();

  // Cast them in a shot by typing @.
  await freshFilm(page, request);
  const prompt = page.locator('#hg-prompt');
  await prompt.fill('Wide shot at dusk, @');
  await prompt.pressSequentially(name.slice(0, 3));
  const pop = page.getByRole('dialog', { name: /Characters matching/ });
  await expect(pop.getByRole('option', { name: new RegExp(name) })).toBeVisible();
  await expectAccessible(page, '@ picker');
  // Several characters may share the start of the name across runs: pick ours.
  while (!(await pop.getByRole('option', { name: new RegExp(name), selected: true }).count()))
    await prompt.press('ArrowDown');
  await prompt.press('Enter');
  await expect(prompt).toHaveValue(`Wide shot at dusk, ${name}`);
  await prompt.pressSequentially(' walks the terrace wall');
  await expect(page.getByRole('button', { name: `Cast: ${name}`, exact: true })).toBeVisible();
  await prompt.press('ControlOrMeta+Enter');
  await expect(prompt).toHaveValue('');

  const characters = (await (await request.get('/api/snapshot')).json()).characters as Character[];
  const mara = characters.find((c) => c.name === name)!;
  const takes = (await (await request.get('/api/snapshot')).json()).takes as Take[];
  const ours = takes.filter((t) => t.request.characters?.includes(mara.id));
  expect(ours.length).toBeGreaterThan(0);
  expect(ours[0]!.request.startFrame).toBeUndefined();
  await expect(page.locator('.cs-card.is-running, .cs-card.is-queued')).toHaveCount(0, { timeout: 15_000 });
  expect(errors).toEqual([]);
});

test('draws a real person only after they consent with their own photos, and stops when they take it back', async ({
  page,
  browser,
}) => {
  const errors = watchErrors(page);
  const name = `Anna ${Date.now() % 100000}`;
  await page.goto('/#/characters');
  await page.getByRole('button', { name: 'New character' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New character' });
  await dialog.getByRole('radio', { name: 'A real person' }).click();
  await expect(dialog.getByText(/take three photos of themselves/)).toBeVisible();
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();

  const panel = page.getByRole('region', { name: `Edit ${name}` });
  await expect(panel.getByText(`${name} hasn’t consented yet`)).toBeVisible();
  // No uploads for a real person: their photos come only from them.
  await expect(panel.getByRole('button', { name: 'Add a reference image' })).toHaveCount(0);
  await panel.getByLabel('Your name, as they’ll see it').fill('Sam');
  await panel.getByRole('button', { name: 'Make a consent link' }).click();
  const url = await panel.getByRole('region', { name: `Consent link for ${name}` }).innerText();
  expect(url).toMatch(/#\/likeness\/[\w-]{43}$/);

  // The person opens it on their own phone.
  const phone = await browser.newContext({ viewport: { width: 402, height: 874 }, hasTouch: true });
  const them = await phone.newPage();
  const theirErrors = watchErrors(them);
  await fakeCamera(them);
  await them.goto(url);
  await expect(
    them.getByRole('heading', { name: 'Sam would like to make a character from your likeness.' }),
  ).toBeVisible();
  await expectAccessible(them, 'consent page');
  await expectCurlyQuotes(them, 'consent page');
  await expect(them.getByRole('button', { name: 'I agree' })).toBeDisabled();
  await them.getByRole('button', { name: 'Open the camera' }).click();
  for (const n of [1, 2, 3]) {
    await them.getByRole('button', { name: `Take photo ${n} of 3` }).click();
    await them.waitForTimeout(150);
  }
  await expect(them.getByText('Your photos · 3 of 3')).toBeVisible();
  await them.getByLabel('Your name').fill('Anna Weiss');
  await expect(them.locator('blockquote')).toContainText('I’m Anna Weiss.');
  await them.getByRole('button', { name: 'I agree' }).click();
  await expect(them.getByRole('heading', { name: 'Thank you, Anna Weiss' })).toBeVisible();
  const revoke = await them.getByRole('region', { name: 'Your link to take it back' }).innerText();
  expect(revoke).toMatch(/#\/likeness\/revoke\/[\w-]{43}$/);
  // The link worked once.
  await them.goto(url);
  await them.reload();
  await expect(them.getByRole('heading', { name: 'This link doesn’t work anymore' })).toBeVisible();

  // The maker sees the consent and the three photos.
  await expect(panel.getByText('Anna Weiss consented')).toBeVisible();
  await expect(panel.getByText('References · 3 of 8')).toBeVisible();
  await expect(panel.getByRole('link', { name: 'Signed record' })).toHaveAttribute('href', /\/consent$/);

  // They take it back with their own link: the character stops and the photos go.
  await them.goto(revoke);
  await them.reload();
  await them.getByRole('button', { name: 'Take it back' }).click();
  await expect(them.getByRole('heading', { name: 'Your consent is taken back' })).toBeVisible();
  await expect(panel.getByText(/Anna Weiss took back their consent/)).toBeVisible();
  await expect(panel.getByText('References · 0 of 8')).toBeVisible();
  await phone.close();
  // The used link answers 410 once, by design; nothing else may fail.
  expect(
    theirErrors.filter((e) => !/http 410: GET \/api\/likeness\//.test(e) && !/status of 410/.test(e)),
  ).toEqual([]);
  expect(errors).toEqual([]);
});

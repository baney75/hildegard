// SPDX-License-Identifier: AGPL-3.0-only
import { expect, type Page, test } from '@playwright/test';
import { expectAccessible, expectCurlyQuotes, watchErrors } from './helpers.ts';

/** A WAV of `seconds` of tone, as a recording someone already has. */
function wav(seconds: number, f = 180): Buffer {
  const sr = 24000;
  const n = Math.round(seconds * sr);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24);
  b.writeUInt32LE(sr * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++)
    b.writeInt16LE(Math.round(6000 * Math.sin((2 * Math.PI * f * i) / sr)), 44 + i * 2);
  return b;
}

async function openVoice(page: Page, route = '/voice') {
  // Each test starts from an empty script, once: a reload keeps what was typed.
  await page.addInitScript(() => {
    if (sessionStorage.getItem('e2e.fresh')) return;
    sessionStorage.setItem('e2e.fresh', '1');
    for (const k of Object.keys(localStorage))
      if (k.startsWith('hildegard.voice.')) localStorage.removeItem(k);
  });
  await page.goto(`/#${route}`);
}

test('speaks a script with a tag from the tag menu, and keeps it in history', async ({ page }) => {
  const errors = watchErrors(page);
  await openVoice(page);
  await expect(page.getByRole('heading', { name: 'Voices' })).toBeVisible();
  const para = page.getByRole('textbox', { name: 'Paragraph 1', exact: true });
  await para.click();
  await page.keyboard.type('They said the hill was too steep. [whi');
  const tags = page.getByRole('dialog', { name: 'Audio tags' });
  await expect(tags.getByRole('option', { name: /whispers/ })).toBeVisible();
  await expectAccessible(page, 'speak with the tag menu');
  await page.keyboard.press('Enter');
  await expect(tags).toBeHidden();
  await page.keyboard.type('She built one anyway.');
  await expect(para).toHaveValue('They said the hill was too steep. [whispers] She built one anyway.');
  // Enter starts a new paragraph, with its own direction.
  await page.keyboard.press('Enter');
  await page.keyboard.type('By autumn the walls were up.');
  await page.getByRole('textbox', { name: /Direction for paragraph 2/ }).fill('warm, unhurried');
  // Kokoro only honours speed: the other sliders say so, and which model does.
  await expect(page.getByText('Kokoro doesn’t support this. Chatterbox does.').first()).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Expressiveness' })).toBeDisabled();
  await expect(page.getByRole('slider', { name: 'Speed' })).toBeEnabled();
  const gen = page.getByRole('group', { name: 'Generate' });
  await expect(gen).toContainText('2 paragraphs');
  await gen.getByRole('button', { name: /Generate speech/ }).click();
  await expect(gen.getByRole('link', { name: 'Download' })).toHaveAttribute(
    'href',
    /^\/media\/voice\/\w+\.wav$/,
    {
      timeout: 15_000,
    },
  );
  await gen.getByRole('button', { name: 'Play the speech' }).click();
  await expect(gen.getByRole('button', { name: 'Pause the speech' })).toBeVisible();
  await gen.getByRole('button', { name: 'Pause the speech' }).click();
  await page.getByRole('tab', { name: /History/ }).click();
  await expect(page.getByRole('tabpanel', { name: 'History' })).toContainText(
    'They said the hill was too steep',
  );
  await expectCurlyQuotes(page, 'speak');
  // The script is still there after a reload.
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Paragraph 2', exact: true })).toHaveValue(
    'By autumn the walls were up.',
  );
  expect(errors).toEqual([]);
});

test('the library previews a voice and opens it in Speak', async ({ page }) => {
  const errors = watchErrors(page);
  await openVoice(page, '/voice/voices');
  const grid = page.getByRole('list', { name: 'Voices' });
  const card = grid.getByRole('listitem').filter({ hasText: 'Fable' });
  await card.getByRole('button', { name: 'Play a sample of Fable' }).click();
  await expect(card.getByRole('button', { name: 'Pause a sample of Fable' })).toBeVisible({
    timeout: 15_000,
  });
  await card.getByRole('button', { name: 'Pause a sample of Fable' }).click();
  await page.getByRole('radio', { name: 'Clones' }).click();
  await expect(page.getByText('No voices of your own yet')).toBeVisible();
  await page.getByRole('radio', { name: 'All' }).click();
  await expectAccessible(page, 'library');
  await card.getByRole('button', { name: 'Use voice Fable' }).click();
  await expect(page).toHaveURL(/#\/voice\/speak\/kokoro-fable$/);
  await expect(page.getByRole('option', { name: /Fable/ })).toHaveAttribute('aria-selected', 'true');
  expect(errors).toEqual([]);
});

test('designs three voices from words and keeps one', async ({ page }) => {
  const errors = watchErrors(page);
  await openVoice(page, '/voice/design');
  await page
    .getByRole('textbox', { name: 'Describe the voice' })
    .fill('A weathered old monk with a low, gravelly voice and a gentle Rhineland accent.');
  await page.getByRole('button', { name: /Design 3 voices/ }).click();
  const cands = page.getByRole('list', { name: 'Candidates' }).getByRole('listitem');
  await expect(cands).toHaveCount(3, { timeout: 15_000 });
  await cands.nth(1).getByRole('button', { name: 'Discard' }).click();
  await expect(cands).toHaveCount(2);
  await cands.first().getByRole('button', { name: 'Keep' }).click();
  const dlg = page.getByRole('dialog', { name: 'Keep this voice' });
  await dlg.getByRole('textbox', { name: 'Name' }).fill('Brother Konrad');
  await dlg.getByRole('button', { name: 'Keep voice' }).click();
  await expect(cands.first()).toContainText('Brother Konrad');
  await expect(cands.first()).toContainText('Kept');
  await expectAccessible(page, 'design');
  await cands.first().getByRole('button', { name: 'Use voice' }).click();
  await expect(page.getByRole('option', { name: /Brother Konrad/ })).toHaveAttribute('aria-selected', 'true');
  expect(errors).toEqual([]);
});

test('clones a voice only with living consent, then revokes it', async ({ page }) => {
  const errors = watchErrors(page);
  await openVoice(page, '/voice/voices');
  await page.getByRole('button', { name: 'Clone a voice' }).click();
  await expect(page.getByRole('heading', { name: 'Whose voice is this?' })).toBeVisible();
  await expectAccessible(page, 'whose voice');
  await page.getByRole('textbox', { name: /Your name/ }).fill('Ada');
  await page.getByRole('button', { name: 'Continue' }).click();
  // A fresh line with the speaker's name and four random words.
  const line = page.locator('.st-prompter');
  await expect(line).toContainText(
    /My name is Ada\. I agree that Hildegard may make a copy of my voice\. \w+ \w+ \w+ \w+\./,
  );
  await expectAccessible(page, 'consent');
  await page.getByRole('button', { name: 'Record your consent' }).click();
  await expect(page.getByRole('button', { name: 'Stop recording' })).toBeVisible();
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: 'Stop recording' }).click();
  // Samples: one recorded, one they already had.
  await expect(page.getByRole('button', { name: 'Record a sample' })).toBeVisible({ timeout: 10_000 });
  await page.getByLabel('Add recordings you already have').setInputFiles({
    name: 'ada-reading.wav',
    mimeType: 'audio/wav',
    buffer: wav(12),
  });
  const clips = page.getByRole('list', { name: 'Clips' });
  await expect(clips.getByText('Clip 1')).toBeVisible();
  await expect(page.getByText('Enough')).toBeVisible();
  await expectAccessible(page, 'record samples');
  await page.getByRole('button', { name: 'Check and continue' }).click();
  await expect(page.getByRole('heading', { name: 'Ada’s consent checks out' })).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole('button', { name: 'Make the voice' }).click();
  await expect(page.getByText(/Clone · made on/)).toBeVisible();
  await expect(page.locator('.st-steps .cur')).toContainText('Ready');
  await expectAccessible(page, 'ready');
  await expectCurlyQuotes(page, 'ready');
  // Its page: the consent, a certificate anyone can check, and every use.
  await page.getByRole('button', { name: 'Consent and uses' }).click();
  await expect(page.getByText('Consent active')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Consent certificate' })).toHaveAttribute(
    'href',
    /\/api\/voice\/voices\/[\w-]+\/certificate$/,
  );
  await expectAccessible(page, 'rights');
  await page.getByRole('button', { name: 'Revoke consent' }).click();
  await page
    .getByRole('dialog', { name: /Revoke your consent/ })
    .getByRole('button', { name: 'Revoke consent' })
    .click();
  await expect(page.getByText('Consent revoked')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Use voice' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('someone who agreed records here when there’s no link, and checking waits for enough speech', async ({
  page,
  request,
}) => {
  const errors = watchErrors(page);
  const start = await request.post('/api/voice/consent', {
    headers: { 'x-hildegard': '1' },
    data: { speaker: 'Bea', relation: 'agreed' },
  });
  const s = (await start.json()) as { id: string };
  await openVoice(page, `/voice/clone/${s.id}`);
  await expect(page.locator('.st-prompter')).toContainText('My name is Bea.');
  // Not shared, so no link: Bea records here.
  await expect(page.getByRole('button', { name: 'Record Bea’s consent' })).toBeVisible();
  await page.getByLabel('Or upload a recording of the line made just now').setInputFiles({
    name: 'bea-consent.wav',
    mimeType: 'audio/wav',
    buffer: wav(4, 200),
  });
  await expect(page.getByRole('button', { name: 'Record a sample' })).toBeVisible({ timeout: 10_000 });
  // Too little speech yet: checking waits.
  await expect(page.getByRole('button', { name: 'Check and continue' })).toBeDisabled();
  expect(errors).toEqual([]);
});

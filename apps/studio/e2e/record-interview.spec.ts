// SPDX-License-Identifier: AGPL-3.0-only
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { expectAccessible, expectCurlyQuotes, watchErrors } from './helpers.ts';

// The full recorder, with Chromium's stand-in microphone, camera and screen (the config's fake media flags pick a
// screen without a picker): the device lists, the screen with the camera in a bubble, the teleprompter, and an
// interview whose answers reach Hildegard on Next while an agent adds a follow-up.
const H = { 'x-hildegard': '1' };
type Rec = {
  id: string;
  kind: 'voice' | 'video';
  bytes: number | null;
  status: string;
  url: string | null;
  chapters?: { at: number; title: string }[];
};
const recordings = async (request: APIRequestContext) =>
  ((await (await request.get('/api/record')).json()) as { recordings: Rec[] }).recordings;

async function begin(page: Page) {
  await page.getByRole('button', { name: 'Start recording' }).click();
  await page.getByRole('button', { name: /Start now/ }).click();
  await expect(page.getByRole('status').filter({ hasText: /^Recording/ })).toBeVisible();
}

test('lists the microphones and cameras by name once allowed, and remembers the one picked', async ({
  page,
}) => {
  const errors = watchErrors(page);
  await page.context().grantPermissions(['microphone', 'camera']);
  await page.goto('/#/record');
  await expect(page.getByRole('heading', { name: 'Your recordings' })).toBeVisible();
  await expectAccessible(page, 'record page');
  await expectCurlyQuotes(page, 'record page');
  // Test plays three seconds back, and the names come with the permission.
  await page.getByRole('button', { name: 'Test' }).click();
  const mic = page.getByLabel('Microphone', { exact: true });
  await expect.poll(async () => (await mic.locator('option').allTextContents()).join('|')).toMatch(/fake/i);
  await page.getByRole('radio', { name: 'Camera' }).click();
  const cam = page.getByLabel('Camera', { exact: true });
  await expect.poll(async () => (await cam.locator('option').allTextContents()).join('|')).toMatch(/fake/i);
  const second = await mic.locator('option').nth(1).getAttribute('value');
  await mic.selectOption(second!);
  await page.reload();
  await expect(page.getByLabel('Microphone', { exact: true })).toHaveValue(second!);
  expect(errors).toEqual([]);
});

test('records the screen with the camera in a bubble to a webm with a picture, and keeps it', async ({
  page,
  request,
}) => {
  const errors = watchErrors(page);
  const before = await recordings(request);
  await page.context().grantPermissions(['microphone', 'camera']);
  await page.goto('/#/record');
  await page.getByRole('radio', { name: 'Screen and camera' }).click();
  await page.getByRole('radio', { name: 'Top left' }).click();
  await page.getByRole('radio', { name: 'L', exact: true }).click();
  await begin(page);
  await expect(page.getByLabel('What is being recorded')).toBeVisible();
  await page.waitForTimeout(2500);
  // Space pauses and resumes; the clock holds while paused.
  await page.keyboard.press('Space');
  await expect(page.getByRole('status').filter({ hasText: /^Paused/ })).toBeVisible();
  await page.keyboard.press('Space');
  await expect(page.getByRole('status').filter({ hasText: /^Recording/ })).toBeVisible();
  await page.waitForTimeout(500);
  // Esc stops.
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('Your video')).toBeVisible();
  // Every track was let go.
  await page.getByRole('button', { name: 'Keep' }).click();
  await expect(page.getByText('Kept with your recordings')).toBeVisible();
  const after = await recordings(request);
  expect(after).toHaveLength(before.length + 1);
  const mine = after[0]!;
  expect(mine).toMatchObject({ kind: 'video', status: 'received' });
  expect(mine.url).toMatch(/\.webm$/);
  const bytes = new Uint8Array(await (await request.get(mine.url!)).body());
  expect(bytes.length).toBeGreaterThan(10_000);
  expect([...bytes.slice(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
  // The browser shows a picture in it: the video has a size once its metadata loads.
  const size = await page.evaluate(async (u) => {
    const v = document.createElement('video');
    v.muted = true;
    v.src = u;
    await new Promise((r) => v.addEventListener('loadedmetadata', r, { once: true }));
    return [v.videoWidth, v.videoHeight];
  }, mine.url!);
  expect(size[0]).toBeGreaterThan(0);
  expect(size[1]).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('the teleprompter starts when the countdown ends, scrolls, and holds while paused', async ({ page }) => {
  const errors = watchErrors(page);
  await page.context().grantPermissions(['microphone']);
  await page.goto('/#/record');
  await page.getByRole('radio', { name: 'Voice only' }).click();
  await page.getByRole('button', { name: /Add a script|Edit script/ }).click();
  const words = Array.from({ length: 60 }, (_, i) => `Line ${i + 1} of the script, read slowly and clearly.`);
  await page.getByLabel('Script').fill(words.join('\n\n'));
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByLabel('Scroll speed').fill('120');
  const prompter = page.getByTestId('prompter');
  await expect(prompter).toBeVisible();
  const top = () => prompter.evaluate((el) => el.scrollTop);

  await page.getByRole('button', { name: 'Start recording' }).click();
  // The countdown: nothing moves yet.
  await expect(page.getByRole('button', { name: /Start now/ })).toBeVisible();
  await page.waitForTimeout(800);
  expect(await top()).toBe(0);
  await page.getByRole('button', { name: /Start now/ }).click();
  await expect.poll(top).toBeGreaterThan(40);
  await page.getByRole('button', { name: 'Pause' }).click();
  const held = await top();
  await page.waitForTimeout(800);
  expect(await top()).toBe(held);
  await page.getByRole('button', { name: 'Resume' }).click();
  await expect.poll(top).toBeGreaterThan(held + 20);
  await page.getByRole('button', { name: 'Stop recording' }).click();
  await expect(page.getByLabel('Your recording')).toBeVisible();
  // The script is kept on this computer for the next time.
  await page.reload();
  await expect(page.getByTestId('prompter')).toContainText('Line 1 of the script');
  expect(errors).toEqual([]);
});

test('an interview: each answer reaches Hildegard on Next, a follow-up appears, and the recording keeps chapters', async ({
  page,
  request,
}) => {
  const errors = watchErrors(page);
  const res = await request.post('/api/record/links', {
    headers: H,
    data: {
      sources: ['camera'],
      purpose: 'A short interview about your film',
      questions: ['What is your film about?', 'Who made it with you?'],
    },
  });
  expect(res.status()).toBe(201);
  const link = (await res.json()) as { id: string; url: string; token: string };
  const status = async () =>
    (await (await request.get(`/api/record/${link.id}/interview`)).json()) as {
      answers: { index: number; mediaId: string; url: string | null }[];
      current: { index: number; question: string } | null;
      chapters: { at: number; title: string }[];
      status: string;
    };
  await page.context().grantPermissions(['microphone', 'camera']);
  await page.goto(link.url);
  await expect(page.getByText('An interview')).toBeVisible();
  await expect(
    page.getByText('Each answer goes to Hildegard when you tap Next, so the interviewer can hear it.'),
  ).toBeVisible();
  await expectAccessible(page, 'interview page');
  await expectCurlyQuotes(page, 'interview page');

  await begin(page);
  await expect(page.getByText('Question 1 of 2')).toBeVisible();
  await expect(page.getByText('What is your film about?')).toBeVisible();
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText('Question 2 of 2')).toBeVisible();
  // The first answer arrived on its own, as sound the interviewer can play.
  await expect.poll(async () => (await status()).answers.length).toBe(1);
  const first = (await status()).answers[0]!;
  expect((await request.get(first.url!)).status()).toBe(200);

  // The interviewer asks a follow-up while the person is on question 2; the page picks it up.
  const ask = await request.post(`/api/record/${link.id}/ask`, {
    headers: H,
    data: { question: 'What surprised you most?' },
  });
  expect(ask.status()).toBe(200);
  await expect(page.getByText('Question 2 of 3')).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(1000);
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText('What surprised you most?')).toBeVisible();
  await page.waitForTimeout(1000);
  await page.getByRole('button', { name: 'Done with this one' }).click();
  await expect(page.getByText(/That was the last question/)).toBeVisible();
  await page.getByRole('button', { name: 'Stop recording' }).click();

  await expect(page.getByLabel('Your video')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Chapters' }).getByRole('listitem')).toHaveCount(3);
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('heading', { name: 'Sent' })).toBeVisible();

  await expect.poll(async () => (await status()).status).toBe('received');
  const done = await status();
  expect(done.answers.map((a) => a.index)).toEqual([0, 1, 2]);
  expect(done.chapters.map((c) => c.title)).toEqual([
    'What is your film about?',
    'Who made it with you?',
    'What surprised you most?',
  ]);
  expect(done.chapters[0]!.at).toBe(0);
  expect(done.chapters[1]!.at).toBeGreaterThan(1);
  // The recording lists its chapters too, and a chapter seeks the player there.
  const rec = (await (await request.get(`/api/record/${link.id}`)).json()) as Rec;
  expect(rec.chapters).toHaveLength(3);
  await page.goto('/#/record');
  const card = page.getByRole('article').first();
  await expect(card.getByRole('list', { name: 'Chapters' })).toBeVisible();
  await card.getByRole('button', { name: /Who made it with you\?/ }).click();
  await expect
    .poll(() => card.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime))
    .toBeGreaterThan(done.chapters[1]!.at - 0.5);
  expect(errors).toEqual([]);
});

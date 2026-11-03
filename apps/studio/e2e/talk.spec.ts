// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { expectAccessible, expectCurlyQuotes, watchErrors } from './helpers.ts';

/** A WAV of a second of tone, as a recording someone already has. */
function wav(seconds = 1, f = 180): Buffer {
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

// The stand-in voice engine hears this in any recording nothing is marked on, and the stand-in model echoes it.
const HEARD = 'Hello Hildegard, can you hear me?';

test('records a turn, and shows what was heard and the answer, with audio to play', async ({ page }) => {
  const errors = watchErrors(page);
  const voiceCalls: string[] = [];
  page.on('request', (r) => {
    if (new URL(r.url()).pathname.startsWith('/api/voice')) voiceCalls.push(r.url());
  });
  await page.goto('/#/talk');
  await expect(page.getByRole('heading', { name: 'Say something' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Talk' }).first()).toHaveAttribute('aria-current', 'page');
  // This computer's claim, in a quiet line.
  await expect(page.getByText(/hears with whisper-small, answers with hildegard-echo/)).toBeVisible();
  await expectAccessible(page, 'talk');

  await page.getByRole('button', { name: 'Record what you want to say' }).click();
  await expect(page.getByRole('button', { name: 'Stop recording' })).toBeVisible();
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: 'Stop recording' }).click();

  const turn = page.getByRole('region', { name: 'Latest turn' });
  await expect(turn.getByTestId('talk-transcript')).toHaveText(HEARD, { timeout: 15_000 });
  await expect(turn.getByTestId('talk-reply')).toHaveText(`You said: “${HEARD}”`);
  await expect(turn.getByRole('button', { name: /Hildegard’s answer/ })).toBeVisible();
  await expectCurlyQuotes(page, 'talk');
  // Talk goes through /api/talk only.
  expect(voiceCalls).toEqual([]);
  expect(errors).toEqual([]);
});

test('takes an uploaded recording when the microphone can’t be used', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/#/talk');
  await page.getByLabel('Or upload a recording').setInputFiles({
    name: 'question.wav',
    mimeType: 'audio/wav',
    buffer: wav(),
  });
  const turn = page.getByRole('region', { name: 'Latest turn' });
  await expect(turn.getByTestId('talk-transcript')).toHaveText(HEARD, { timeout: 15_000 });
  await expect(turn.getByTestId('talk-reply')).toContainText('You said:');
  expect(errors).toEqual([]);
});

test('offers a joined device that can hear, answer and speak, and sends the turn there', async ({ page }) => {
  const errors = watchErrors(page);
  const caps = {
    mic: true,
    speaker: true,
    stt: ['whisper-small'],
    tts: ['kokoro-82m'],
    llm: [{ runtime: 'stub', model: 'hildegard-echo', vramGb: null }],
    gpu: null,
    compute: 'interactive',
  };
  await page.route('**/api/choir', async (route) => {
    const res = await route.fetch();
    const choir = await res.json();
    const device = (name: string, online: boolean, tts = caps.tts) => ({
      name,
      url: 'http://100.64.0.9:7342',
      online,
      gpu: null,
      version: null,
      models: [],
      fit: {},
      fitWhy: {},
      problem: null,
      update: null,
      opportunistic: null,
      busy: null,
      queue: null,
      capabilities: { ...caps, tts },
    });
    await route.fulfill({
      response: res,
      json: {
        ...choir,
        devices: [device('desk', true), device('attic', false), device('porch', true, ['chatterbox'])],
      },
    });
  });
  let sent: string | null = null;
  await page.route('**/api/talk/turn', async (route) => {
    sent =
      /name="device"\r\n\r\n([^\r]*)/.exec(route.request().postDataBuffer()?.toString('latin1') ?? '')?.[1] ??
      '';
    await route.fulfill({
      json: {
        transcript: HEARD,
        replyText: `You said: “${HEARD}”`,
        audio: { contentType: 'audio/wav', data: wav(0.2).toString('base64') },
        route: { stt: 'remote', llm: 'remote', tts: 'remote' },
      },
    });
  });
  await page.goto('/#/talk');
  const where = page.getByLabel('Hear and answer on');
  // Only the device that is online and says it can do all three in Kokoro's voice.
  await expect(where.locator('option')).toHaveText(['This computer', 'desk']);
  await where.selectOption('desk');
  await page
    .getByLabel('Or upload a recording')
    .setInputFiles({ name: 'q.wav', mimeType: 'audio/wav', buffer: wav() });
  await expect(page.getByRole('region', { name: 'Latest turn' }).getByTestId('talk-transcript')).toHaveText(
    HEARD,
  );
  expect(sent).toBe('desk');
  expect(errors).toEqual([]);
});

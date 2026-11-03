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
  // How long each step took, without betting on the numbers.
  await expect(turn.getByTestId('talk-timing')).toHaveText(
    /^Heard in [\d.]+ s · Answered in [\d.]+ s · Spoke in [\d.]+ s · [\d.]+ s in all, on this computer$/,
  );
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
        ms: { stt: 400, llm: 1200, tts: 600, total: 2300 },
        device: sent || 'local',
      },
    });
  });
  await page.goto('/#/talk');
  const where = page.getByLabel('Hear and answer on');
  // Only the device that is online and says it can do all three in Kokoro's voice.
  await expect(where.locator('option')).toHaveText(['This computer (primary)', 'desk']);
  await where.selectOption('desk');
  await page
    .getByLabel('Or upload a recording')
    .setInputFiles({ name: 'q.wav', mimeType: 'audio/wav', buffer: wav() });
  await expect(page.getByRole('region', { name: 'Latest turn' }).getByTestId('talk-transcript')).toHaveText(
    HEARD,
  );
  expect(sent).toBe('desk');
  await expect(page.getByTestId('talk-timing')).toHaveText(
    'Heard in 0.4 s · Answered in 1.2 s · Spoke in 0.6 s · 2.3 s in all, on desk',
  );
  expect(errors).toEqual([]);
});

test('starts on the primary device, and says when the primary can’t answer', async ({ page }) => {
  const errors = watchErrors(page);
  let primary = 'desk';
  let online = true;
  await page.route('**/api/choir', async (route) => {
    const res = await route.fetch();
    const choir = await res.json();
    const here = choir.capabilities ?? {
      mic: true,
      speaker: true,
      stt: ['whisper-small'],
      tts: ['kokoro-82m'],
      llm: [{ runtime: 'stub', model: 'hildegard-echo', vramGb: null }],
      gpu: null,
      compute: 'interactive',
    };
    await route.fulfill({
      response: res,
      json: {
        ...choir,
        primary,
        devices: [
          {
            name: 'desk',
            url: 'http://100.64.0.9:7342',
            online,
            gpu: null,
            version: null,
            models: [],
            fit: {},
            fitWhy: {},
            problem: online ? null : 'It isn’t answering.',
            update: null,
            opportunistic: null,
            busy: null,
            queue: null,
            capabilities: here,
          },
        ],
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
        replyText: 'Yes.',
        audio: { contentType: 'audio/wav', data: wav(0.2).toString('base64') },
        route: { stt: 'remote', llm: 'remote', tts: 'remote' },
        ms: { stt: 1, llm: 1, tts: 1, total: 3 },
        device: sent,
      },
    });
  });
  await page.goto('/#/talk');
  await expect(page.getByLabel('Hear and answer on')).toHaveValue('desk');
  await page
    .getByLabel('Or upload a recording')
    .setInputFiles({ name: 'q.wav', mimeType: 'audio/wav', buffer: wav() });
  await expect(page.getByTestId('talk-timing')).toContainText('on desk');
  expect(sent).toBe('desk');

  // The primary went quiet: the turn runs here, and the page says why.
  online = false;
  primary = 'desk';
  await page.reload();
  await expect(page.getByText(/desk is your primary, but it can’t hear and answer right now/)).toBeVisible();
  await page
    .getByLabel('Or upload a recording')
    .setInputFiles({ name: 'q.wav', mimeType: 'audio/wav', buffer: wav() });
  await expect(page.getByTestId('talk-timing').first()).toContainText('on this computer');
  expect(sent).toBe('local');
  expect(errors).toEqual([]);
});

test('steps through the demo script, invented lines only', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/#/talk');
  await page.getByRole('link', { name: 'demo script' }).click();
  await expect(page.getByRole('heading', { name: /^Beat 1 of \d+$/ })).toBeVisible();
  await expect(page.getByTestId('script-line')).toHaveCount(0);
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByTestId('script-line')).toHaveText('Plan a short film about a lighthouse keeper.');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('heading', { name: /^Beat 3 of/ })).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('heading', { name: /^Beat 2 of/ })).toBeVisible();
  await expectAccessible(page, 'talk script');
  await expectCurlyQuotes(page, 'talk script');
  expect(errors).toEqual([]);
});

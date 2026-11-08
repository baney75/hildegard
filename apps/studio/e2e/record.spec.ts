// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { expectAccessible, expectCurlyQuotes, watchErrors } from './helpers.ts';

// A link a chat showed: the page opens from the token alone, the browser's stand-in microphone and camera (Chromium's
// fake media stream) are used only after a tap, and what is sent is what the status then says arrived.
const H = { 'x-hildegard': '1' };
type Link = { id: string; url: string; token: string };
type Status = { status: string; kind: string; seconds: number | null; bytes: number | null };

async function makeLink(
  request: import('@playwright/test').APIRequestContext,
  kind: 'voice' | 'video',
  purpose: string,
): Promise<Link> {
  const res = await request.post('/api/record/links', { headers: H, data: { kind, purpose } });
  expect(res.status()).toBe(201);
  return (await res.json()) as Link;
}
/** Press Record, then skip the 3-2-1 by tapping the number. */
async function begin(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Start recording' }).click();
  await page.getByRole('button', { name: /Start now/ }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Recording' })).toBeVisible();
}
const status = async (request: import('@playwright/test').APIRequestContext, id: string) =>
  (await (await request.get(`/api/record/${id}`)).json()) as Status;

test('records a voice for two seconds, plays it back, sends it, and the status turns received', async ({
  page,
  request,
}) => {
  const errors = watchErrors(page);
  const link = await makeLink(request, 'voice', 'Read the first line of the narration');
  expect((await status(request, link.id)).status).toBe('pending');
  await page.context().grantPermissions(['microphone']);
  // Nothing asks for the microphone until a tap.
  await page.addInitScript(() => {
    const md = navigator.mediaDevices;
    const real = md.getUserMedia.bind(md);
    (window as unknown as { asked: number }).asked = 0;
    md.getUserMedia = (c) => {
      (window as unknown as { asked: number }).asked++;
      (window as unknown as { constraints: unknown }).constraints = c;
      return real(c);
    };
  });
  await page.goto(link.url);
  await expect(page.getByText('Read the first line of the narration')).toBeVisible();
  await expect(page.getByText('Record your voice')).toBeVisible();
  // No Studio: no navigation, no films, nothing of the owner's.
  await expect(page.locator('.hg-app__nav, .hg-tabbar')).toHaveCount(0);
  await expectAccessible(page, 'record page');
  await expectCurlyQuotes(page, 'record page');
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as unknown as { asked: number }).asked)).toBe(0);

  await begin(page);
  await expect(page.getByRole('button', { name: 'Stop recording' })).toBeVisible();
  await page.waitForTimeout(2000);
  await page.getByRole('button', { name: 'Stop recording' }).click();

  // The take, to listen to before sending; the browser's noise suppression was on for it.
  await expect(page.getByLabel('Your recording')).toBeVisible();
  const asked = await page.evaluate(() => {
    const w = window as unknown as { asked: number; constraints: MediaStreamConstraints };
    return { asked: w.asked, constraints: w.constraints };
  });
  expect(asked.asked).toBe(1);
  expect(asked.constraints.audio).toMatchObject({ noiseSuppression: true, echoCancellation: true });
  expect(asked.constraints.video).toBe(false);
  expect((await status(request, link.id)).status).toBe('pending');

  // Record again throws that one away and starts over, then send the second.
  await page.getByRole('button', { name: 'Record again' }).click();
  await expect(page.getByRole('button', { name: 'Start recording' })).toBeVisible();
  await begin(page);
  await page.waitForTimeout(2000);
  await page.getByRole('button', { name: 'Stop recording' }).click();
  await expect(page.getByLabel('Your recording')).toBeVisible();
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('heading', { name: 'Sent' })).toBeVisible();

  await expect.poll(async () => (await status(request, link.id)).status).toBe('received');
  const got = await status(request, link.id);
  expect(got.kind).toBe('voice');
  expect(got.bytes).toBeGreaterThan(1000);
  // About the two seconds that were recorded (when this computer's Python could read it).
  if (got.seconds !== null) {
    expect(got.seconds).toBeGreaterThan(1.4);
    expect(got.seconds).toBeLessThan(4);
  }
  // The link works once: a reload says it was sent, and a second send is refused.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Sent' })).toBeVisible();
  const again = await request.post(`/api/record/${link.token}`, {
    headers: H,
    data: Buffer.from('RIFF....WAVEfmt '),
  });
  expect(again.status()).toBe(409);
  expect(errors.filter((e) => !e.includes('http 409'))).toEqual([]);
});

test('records a video with sound, with the camera, and sends it', async ({ page, request }) => {
  const errors = watchErrors(page);
  const link = await makeLink(request, 'video', 'Say hello to the camera');
  await page.context().grantPermissions(['microphone', 'camera']);
  await page.goto(link.url);
  await expect(page.getByText('Record a video')).toBeVisible();
  await begin(page);
  await expect(page.getByLabel('Your camera')).toBeVisible();
  await page.waitForTimeout(2000);
  await page.getByRole('button', { name: 'Stop recording' }).click();
  await expect(page.getByLabel('Your video')).toBeVisible();
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('heading', { name: 'Sent' })).toBeVisible();
  await expect.poll(async () => (await status(request, link.id)).status).toBe('received');
  expect((await status(request, link.id)).kind).toBe('video');
  expect(errors).toEqual([]);
});

test('a link nobody made says so', async ({ page }) => {
  const res = await page.goto(`/record/${'Z'.repeat(43)}`);
  expect(res?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'This link doesn’t work' })).toBeVisible();
});

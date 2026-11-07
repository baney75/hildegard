// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { createShot, expectAccessible, expectCurlyQuotes, freshFilm, watchErrors } from './helpers.ts';

// Recording inside the Studio, with nothing to set up: Chromium's fake microphone and camera stand in for the real
// ones. What is kept lands with the person's other recordings, where a record link's would.
type Rec = { id: string; kind: 'voice' | 'video'; bytes: number | null; status: string; url: string | null };
const recordings = async (request: import('@playwright/test').APIRequestContext) =>
  ((await (await request.get('/api/record')).json()) as { recordings: Rec[] }).recordings;

test('records a voice from the Voice page with noise suppression on, listens back, records again and keeps it', async ({
  page,
  request,
}) => {
  const errors = watchErrors(page);
  const before = await recordings(request);
  await page.context().grantPermissions(['microphone']);
  await page.addInitScript(() => {
    const md = navigator.mediaDevices;
    const real = md.getUserMedia.bind(md);
    const w = window as unknown as { asked: number; constraints: MediaStreamConstraints[] };
    w.asked = 0;
    w.constraints = [];
    md.getUserMedia = (c) => {
      w.asked++;
      w.constraints.push(c as MediaStreamConstraints);
      return real(c);
    };
  });
  await page.goto('/#/voice');
  await page.getByRole('banner').getByRole('button', { name: 'Record', exact: true }).click();
  const dlg = page.getByRole('dialog', { name: 'Record' });
  await expect(dlg).toBeVisible();
  await expectAccessible(page, 'record dialog');
  await expectCurlyQuotes(page, 'record dialog');
  // Nothing asks for the microphone until the tap.
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => (window as unknown as { asked: number }).asked)).toBe(0);

  await dlg.getByRole('button', { name: 'Start recording' }).click();
  await expect(dlg.getByRole('button', { name: 'Stop recording' })).toBeVisible();
  await page.waitForTimeout(1500);
  await dlg.getByRole('button', { name: 'Stop recording' }).click();
  await expect(dlg.getByLabel('Your recording')).toBeVisible();
  const first = await page.evaluate(
    () => (window as unknown as { constraints: MediaStreamConstraints[] }).constraints[0],
  );
  expect(first?.audio).toMatchObject({ noiseSuppression: true, echoCancellation: true });
  expect(first?.video).toBe(false);
  // Listening back keeps nothing yet.
  expect(await recordings(request)).toHaveLength(before.length);

  // Record again throws that take away; the second is the one kept.
  await dlg.getByRole('button', { name: 'Record again' }).click();
  await dlg.getByRole('button', { name: 'Start recording' }).click();
  await page.waitForTimeout(2000);
  await dlg.getByRole('button', { name: 'Stop recording' }).click();
  await dlg.getByRole('button', { name: 'Keep' }).click();
  await expect(dlg.getByRole('heading', { name: 'Kept' })).toBeVisible();

  const after = await recordings(request);
  expect(after).toHaveLength(before.length + 1);
  const mine = after[0]!;
  expect(mine).toMatchObject({ kind: 'voice', status: 'received' });
  expect(mine.bytes).toBeGreaterThan(1000);
  expect(mine.url).toMatch(/^\/media\/recordings\/local\/rec_[0-9a-f]{16}\.(webm|ogg|m4a)$/);
  // The file is served to this computer, and is the recording.
  expect((await request.get(mine.url!)).status()).toBe(200);

  await dlg.getByRole('button', { name: 'Done' }).click();
  await expect(dlg).toHaveCount(0);
  // It shows with the Voice page's recordings.
  await page.getByRole('radio', { name: 'Recordings' }).click();
  await expect(page.getByRole('heading', { name: 'Recorded in Hildegard' })).toBeVisible();
  await expect(page.getByRole('article', { name: /^Voice · / }).first()).toBeVisible();
  expect(errors.filter((e) => !/decode|AudioContext/i.test(e))).toEqual([]);
});

test('records a video with sound from the Record button in the sidebar, and keeps it', async ({
  page,
  request,
}) => {
  const errors = watchErrors(page);
  const before = await recordings(request);
  await page.context().grantPermissions(['microphone', 'camera']);
  await page.goto('/#/queue');
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('button', { name: 'Record', exact: true })
    .click();
  const dlg = page.getByRole('dialog', { name: 'Record' });
  await dlg.getByRole('radio', { name: 'Video with sound' }).click();
  await dlg.getByRole('button', { name: 'Start recording' }).click();
  await expect(dlg.getByLabel('Your camera')).toBeVisible();
  await page.waitForTimeout(2000);
  await dlg.getByRole('button', { name: 'Stop recording' }).click();
  await expect(dlg.getByLabel('Your video')).toBeVisible();
  await dlg.getByRole('button', { name: 'Keep' }).click();
  await expect(dlg.getByRole('heading', { name: 'Kept' })).toBeVisible();
  const after = await recordings(request);
  expect(after).toHaveLength(before.length + 1);
  expect(after[0]).toMatchObject({ kind: 'video', status: 'received' });
  expect(errors).toEqual([]);
});

test('a film’s voice-over: record one in the export dialog and export with it', async ({ page, request }) => {
  const errors = watchErrors(page);
  await page.context().grantPermissions(['microphone']);
  await freshFilm(page, request);
  await createShot(page, 'Fog rolls over the harbor at dawn');
  const shot = page.getByRole('region', { name: /Fog rolls over the harbor/ });
  await expect(shot.locator('.cs-card.is-running, .cs-card.is-queued')).toHaveCount(0, { timeout: 15_000 });

  await page.getByRole('button', { name: 'Export film' }).click();
  const exportDlg = page.getByRole('dialog', { name: 'Export film' });
  await expect(exportDlg.getByLabel('Voice-over')).toHaveValue('');
  await exportDlg.getByRole('button', { name: 'Record' }).click();
  const rec = page.getByRole('dialog', { name: 'Record' });
  // A voice-over is a voice: there is no video choice.
  await expect(rec.getByRole('radio', { name: 'Video with sound' })).toHaveCount(0);
  await rec.getByRole('button', { name: 'Start recording' }).click();
  await page.waitForTimeout(1500);
  await rec.getByRole('button', { name: 'Stop recording' }).click();
  await rec.getByRole('button', { name: 'Keep' }).click();
  await expect(rec.getByRole('heading', { name: 'Kept' })).toBeVisible();
  await rec.getByRole('button', { name: 'Done' }).click();

  // The kept recording is chosen for the film.
  const picked = await exportDlg.getByLabel('Voice-over').inputValue();
  expect(picked).toMatch(/^rec_[0-9a-f]{16}$/);
  const [req] = await Promise.all([
    page.waitForRequest((r) => /\/api\/projects\/[^/]+\/export$/.test(r.url()) && r.method() === 'POST'),
    exportDlg.getByRole('button', { name: 'Export', exact: true }).click(),
  ]);
  expect(req.postDataJSON()).toEqual({ voiceover: { mediaId: picked } });
  await expect(exportDlg.locator('video')).toBeVisible({ timeout: 30_000 });
  expect(errors).toEqual([]);
});

test('Record on your phone asks before turning a link on, then shows a QR code and waits for the recording', async ({
  page,
}) => {
  const errors = watchErrors(page);
  // The real link is the computer's to change, so the answers are stood in for here; the server side is tested on
  // its own. What this checks is that nothing is turned on before the yes.
  let linkOn = 0;
  let linkMade = 0;
  let polls = 0;
  const url = `https://studio.example.ts.net/record/${'Q'.repeat(43)}`;
  await page.route('**/api/tunnel', (route) =>
    route.fulfill({
      json: { tailscale: { state: 'ready' }, cloudflare: { installed: false, state: 'missing' } },
    }),
  );
  await page.route('**/api/record/links', (route) => {
    linkMade++;
    return linkOn
      ? route.fulfill({
          status: 201,
          json: {
            id: 'rec_0123456789abcdef',
            url,
            secure: true,
            where: 'phone',
            expiresAt: new Date(Date.now() + 1.8e6).toISOString(),
          },
        })
      : route.fulfill({
          json: {
            needsLink: true,
            where: 'phone',
            ask: 'To record on your phone, Hildegard needs a private link to this computer. Turn one on?',
          },
        });
  });
  await page.route('**/api/link/on', (route) => {
    linkOn++;
    return route.fulfill({
      json: {
        status: 'on',
        via: 'tailscale',
        url: 'https://studio.example.ts.net',
        private: true,
        temporary: false,
        message:
          'Hildegard’s link is on: https://studio.example.ts.net. This link is private: only devices signed in to your Tailscale account can reach it.',
        steps: [],
      },
    });
  });
  await page.route('**/api/record/rec_0123456789abcdef', (route) => {
    polls++;
    return route.fulfill({
      json: {
        id: 'rec_0123456789abcdef',
        kind: 'voice',
        status: polls < 2 ? 'pending' : 'received',
        seconds: 7,
        bytes: 9000,
        url: '/media/recordings/local/rec_0123456789abcdef.webm',
        receivedAt: new Date().toISOString(),
        purpose: null,
        from: null,
        clean: null,
      },
    });
  });

  await page.goto('/#/voice');
  await page.getByRole('banner').getByRole('button', { name: 'Record', exact: true }).click();
  const dlg = page.getByRole('dialog', { name: 'Record' });
  await dlg.getByRole('button', { name: 'Record on your phone' }).click();
  await expect(dlg.getByRole('heading', { name: 'Turn on a link to this computer?' })).toBeVisible();
  await expect(dlg.getByText(/Only devices signed in to your Tailscale account/)).toBeVisible();
  await expectAccessible(page, 'turn on a link');
  await expectCurlyQuotes(page, 'turn on a link');
  // Not now: nothing was turned on.
  await dlg.getByRole('button', { name: 'Not now' }).click();
  expect(linkOn).toBe(0);
  expect(linkMade).toBe(1);

  await dlg.getByRole('button', { name: 'Record on your phone' }).click();
  await dlg.getByRole('button', { name: 'Turn on' }).click();
  await expect(dlg.getByRole('img', { name: /QR code/ })).toBeVisible();
  expect(linkOn).toBe(1);
  await expect(dlg.getByText(/This link is private/)).toBeVisible();
  await expectAccessible(page, 'phone QR');
  await expect(dlg.getByRole('heading', { name: 'It arrived' })).toBeVisible({ timeout: 10_000 });
  expect(errors.filter((e) => !e.includes('/api/record/links'))).toEqual([]);
});

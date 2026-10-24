// SPDX-License-Identifier: AGPL-3.0-only
import { type APIRequestContext, type Browser, expect, type Page, test } from '@playwright/test';
import { expectAccessible, expectCurlyQuotes, watchErrors } from './helpers.ts';

// Host mode, as people on other devices meet it. The server's second listener is the one Tailscale Serve forwards
// to: everything that arrives there signs in, as it would through the link.
const hosted = `http://127.0.0.1:${process.env.E2E_HOST_PORT}`;
const OWNER = { name: 'Donovan', passphrase: 'a feather on the breath' };
/** The owner's passphrase after they change it, partway through. */
const NEW_PASSPHRASE = 'o virtus sapientiae';
const DIRECTOR = { name: 'Ada', passphrase: 'symphonia harmoniae' };
// The tests build on each other: the owner, then an invite, then what the director may do, then removing them.
test.describe.configure({ mode: 'serial' });

/** A fresh browser, as on another device: no cookies, nothing shared with the owner's tab. */
async function elsewhere(browser: Browser) {
  const context = await browser.newContext({ baseURL: hosted, viewport: { width: 1440, height: 900 } });
  return { context, page: await context.newPage() };
}

async function signIn(page: Page, who: { name: string; passphrase: string }) {
  await page.goto(`${hosted}/`);
  await page.getByLabel('Name').fill(who.name);
  await page.getByLabel('Passphrase').fill(who.passphrase);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' }).first()).toBeVisible();
}

const H = { 'x-hildegard': '1' };
/** Ada's takes that are waiting or rendering, as this computer sees them. */
async function waiting(request: APIRequestContext) {
  const snap = (await (await request.get('/api/snapshot')).json()) as {
    takes: Array<{ status: string; by?: { name: string } }>;
  };
  return snap.takes.filter(
    (t) => t.by?.name === DIRECTOR.name && (t.status === 'queued' || t.status === 'running'),
  ).length;
}

/** Only the refusals a test asked for: a wrong passphrase, or a session that has just been ended. */
const unexpected = (errors: string[]) =>
  errors.filter((e) => !/401/.test(e) || !/(signin|auth|api\/)/.test(e));

test('the owner makes their account here, and signs in elsewhere', async ({ page, browser }) => {
  const errors = watchErrors(page);
  await page.goto('/#/settings/sharing');
  await expect(page.getByRole('heading', { name: 'Sharing' })).toBeVisible();
  const form = page.locator('form', { hasText: 'Make the owner account' });
  await expect(form).toBeVisible();
  await expectAccessible(page, 'sharing, no owner');
  await expectCurlyQuotes(page, 'sharing, no owner');
  await form.getByLabel('Your name').fill(OWNER.name);
  await form.getByLabel('Passphrase', { exact: true }).fill(OWNER.passphrase);
  await form.getByLabel('The same passphrase again').fill(OWNER.passphrase);
  await form.getByRole('button', { name: 'Make the owner account' }).click();
  await expect(form).toBeHidden();
  // This computer itself never signs in.
  await page.goto('/#/settings/people');
  await expect(page.getByRole('list', { name: 'People' }).getByText(OWNER.name)).toBeVisible();
  await expectAccessible(page, 'people');
  await expectCurlyQuotes(page, 'people');
  expect(errors).toEqual([]);

  const other = await elsewhere(browser);
  const theirErrors = watchErrors(other.page);
  await other.page.goto('/');
  await expect(other.page.getByRole('heading', { name: 'Sign in to Hildegard.' })).toBeVisible();
  await expect(other.page).toHaveTitle('Sign in · Hildegard');
  await expectAccessible(other.page, 'sign in');
  await expectCurlyQuotes(other.page, 'sign in');
  await other.page.getByLabel('Name').fill(OWNER.name);
  await other.page.getByLabel('Passphrase').fill('not the passphrase');
  await other.page.getByRole('button', { name: 'Sign in' }).click();
  await expect(other.page.getByRole('alert')).toHaveText('That name and passphrase don’t match.');
  await other.page.getByLabel('Passphrase').fill(OWNER.passphrase);
  await other.page.getByRole('button', { name: 'Sign in' }).click();
  await expect(other.page.getByRole('link', { name: 'Agents' }).first()).toBeVisible();
  await other.page.goto(`${hosted}/#/settings/account`);
  await expect(other.page.getByText('An owner: films, models, devices, people and settings.')).toBeVisible();
  // The cookie is the server's alone.
  const cookies = await other.context.cookies();
  expect(cookies.find((c) => c.name === 'hildegard_session')).toMatchObject({
    httpOnly: true,
    sameSite: 'Strict',
  });
  expect(unexpected(theirErrors)).toEqual([]);
  await other.context.close();
});

test('invites a director, who joins with the link once and sees only their own films', async ({
  browser,
  page,
}) => {
  const owner = await elsewhere(browser);
  await signIn(owner.page, OWNER);
  await owner.page.goto(`${hosted}/#/settings/people`);
  await owner.page.getByRole('radio', { name: 'Director' }).click();
  await owner.page.getByRole('button', { name: 'Make an invite link' }).click();
  const link = (await owner.page.getByRole('region', { name: 'Invite link' }).textContent())!;
  expect(link).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#\/invite\/[A-Za-z0-9_-]{43}$/);
  await expect(owner.page.getByText('Invite for a director')).toBeVisible();
  await expectAccessible(owner.page, 'people, invite made');
  await expectCurlyQuotes(owner.page, 'people, invite made');

  const ada = await elsewhere(browser);
  const errors = watchErrors(ada.page);
  await ada.page.goto(link);
  await expect(ada.page.getByRole('heading', { name: 'Join this Hildegard.' })).toBeVisible();
  await expectAccessible(ada.page, 'invite');
  await expectCurlyQuotes(ada.page, 'invite');
  await ada.page.getByLabel('Your name').fill(DIRECTOR.name);
  await ada.page.getByLabel('Passphrase, at least 10 characters').fill(DIRECTOR.passphrase);
  await ada.page.getByLabel('The same passphrase again').fill('not the same at all');
  await ada.page.getByRole('button', { name: 'Join' }).click();
  await expect(ada.page.getByRole('alert')).toHaveText('The two passphrases don’t match.');
  await ada.page.getByLabel('The same passphrase again').fill(DIRECTOR.passphrase);
  await ada.page.getByRole('button', { name: 'Join' }).click();
  await expect(ada.page.locator('#hg-prompt')).toBeVisible();
  // Models, devices, sharing, people and linked apps are the owner's.
  await expect(ada.page.getByRole('link', { name: 'Agents' })).toHaveCount(0);
  await ada.page.goto(`${hosted}/#/settings`);
  const sections = ada.page.getByRole('navigation', { name: 'Settings sections' });
  await expect(sections.getByRole('link', { name: 'Your account' })).toBeVisible();
  for (const name of ['Models', 'Hugging Face', 'Devices', 'Sharing', 'People'])
    await expect(sections.getByRole('link', { name })).toHaveCount(0);
  await expectCurlyQuotes(ada.page, 'director settings');

  // A shot of her own, which the owner's queue names as hers.
  await ada.page.goto(`${hosted}/`);
  await ada.page.locator('#hg-prompt').fill('A heron lifts off the marsh at first light');
  await ada.page.keyboard.press('ControlOrMeta+Enter');
  await expect(ada.page.getByRole('region', { name: /A heron lifts off/ })).toBeVisible();
  await page.goto('/#/queue');
  await expect(page.getByText(/· by Ada/).first()).toBeVisible();
  await expectCurlyQuotes(page, 'queue with people');
  // Nothing of the owner's shows in hers.
  await ada.page.goto(`${hosted}/#/queue`);
  await expect(ada.page.getByText(/· by /)).toHaveCount(0);
  expect(errors).toEqual([]);

  // The link worked once.
  const late = await elsewhere(browser);
  await late.page.goto(link);
  await expect(late.page.getByRole('heading', { name: 'This invite can’t be used.' })).toBeVisible();
  await expectCurlyQuotes(late.page, 'used invite');
  await Promise.all([owner.context.close(), ada.context.close(), late.context.close()]);
});

test('the owner limits a director’s waiting takes, and she is told when she reaches it', async ({
  browser,
  request,
}) => {
  const owner = await elsewhere(browser);
  await signIn(owner.page, OWNER);
  await owner.page.goto(`${hosted}/#/settings/people`);
  const form = owner.page.locator('form', { hasText: 'Takes waiting, per director' });
  const field = form.getByLabel('Takes each director may have waiting');
  await expect(field).toHaveValue('3');
  await expect(form.getByRole('button', { name: 'Save' })).toBeDisabled();
  await field.fill('0');
  await expect(form.getByText('A whole number from 1 to 100.')).toBeVisible();
  await expect(form.getByRole('button', { name: 'Save' })).toBeDisabled();
  await field.fill('2');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(owner.page.getByText('Each director may have 2 takes waiting')).toBeVisible();
  await expectAccessible(owner.page, 'people, queue limit');
  await expectCurlyQuotes(owner.page, 'people, queue limit');

  const ada = await elsewhere(browser);
  const errors = watchErrors(ada.page);
  await signIn(ada.page, DIRECTOR);
  // Her first take has finished; with nothing rendering, what she asks for next waits. The Studio asks for two drafts.
  await expect.poll(() => waiting(request), { timeout: 30_000 }).toBe(0);
  await request.post('/api/engine/pause', { headers: H });
  try {
    await ada.page.locator('#hg-prompt').fill('Reeds bend under the first wind of evening');
    await ada.page.keyboard.press('ControlOrMeta+Enter');
    await expect(ada.page.getByRole('region', { name: /Reeds bend/ })).toBeVisible();
    await ada.page.locator('#hg-prompt').fill('A second shot, one too many for now');
    await ada.page.keyboard.press('ControlOrMeta+Enter');
    await expect(
      ada.page.getByText(
        'You can have 2 takes waiting at once here, and you have 2. Wait for one to finish, or cancel one.',
      ),
    ).toBeVisible();
    // Her words stay, to send when there's room.
    await expect(ada.page.locator('#hg-prompt')).toHaveValue('A second shot, one too many for now');
    await expectCurlyQuotes(ada.page, 'queue limit reached');
    expect(unexpected(errors).filter((e) => !/429/.test(e))).toEqual([]);
  } finally {
    await request.patch('/api/people/settings', { headers: H, data: { directorQueue: 3 } });
    await request.post('/api/engine/resume', { headers: H });
  }
  await Promise.all([owner.context.close(), ada.context.close()]);
});

test('the owner changes their passphrase, and every other device is signed out', async ({ browser }) => {
  const phone = await elsewhere(browser);
  await signIn(phone.page, OWNER);
  const laptop = await elsewhere(browser);
  const errors = watchErrors(laptop.page);
  await signIn(laptop.page, OWNER);
  await laptop.page.goto(`${hosted}/#/settings/account`);
  const form = laptop.page.locator('form', { hasText: 'Change your passphrase' });
  await expect(form).toBeVisible();
  await expectAccessible(laptop.page, 'account, change passphrase');
  await expectCurlyQuotes(laptop.page, 'account, change passphrase');

  await form.getByLabel('Current passphrase').fill('not the passphrase');
  await form.getByLabel('New passphrase', { exact: true }).fill(NEW_PASSPHRASE);
  await form.getByLabel('The new passphrase again').fill(NEW_PASSPHRASE);
  await form.getByRole('button', { name: 'Change passphrase' }).click();
  await expect(form.getByRole('alert')).toHaveText('That isn’t your current passphrase.');
  await form.getByLabel('Current passphrase').fill(OWNER.passphrase);
  await form.getByLabel('The new passphrase again').fill('something else entirely');
  await form.getByRole('button', { name: 'Change passphrase' }).click();
  await expect(form.getByRole('alert')).toHaveText('The two new passphrases don’t match.');
  await form.getByLabel('The new passphrase again').fill(NEW_PASSPHRASE);
  await form.getByRole('button', { name: 'Change passphrase' }).click();
  await expect(laptop.page.getByText('Passphrase changed. You’re signed out everywhere else.')).toBeVisible();
  await expect(form.getByLabel('Current passphrase')).toHaveValue('');
  OWNER.passphrase = NEW_PASSPHRASE;

  // The phone notices without a reload; this laptop stays signed in.
  await expect(phone.page.getByRole('heading', { name: 'Sign in to Hildegard.' })).toBeVisible({
    timeout: 15_000,
  });
  await laptop.page.reload();
  await expect(laptop.page.getByRole('heading', { name: 'Your account' })).toBeVisible();
  await signIn(phone.page, OWNER);
  expect(unexpected(errors).filter((e) => !/403/.test(e))).toEqual([]);
  await Promise.all([phone.context.close(), laptop.context.close()]);
});

test('the owner removes a director, who is signed out at once', async ({ browser }) => {
  const ada = await elsewhere(browser);
  await signIn(ada.page, DIRECTOR);
  const owner = await elsewhere(browser);
  await signIn(owner.page, OWNER);
  await owner.page.goto(`${hosted}/#/settings/people`);
  await owner.page.getByRole('button', { name: `Remove ${DIRECTOR.name}` }).click();
  const dialog = owner.page.getByRole('dialog', { name: `Remove ${DIRECTOR.name}?` });
  await expect(dialog).toBeVisible();
  await expectAccessible(owner.page, 'remove someone');
  await expectCurlyQuotes(owner.page, 'remove someone');
  await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(owner.page.getByRole('list', { name: 'People' }).getByText(DIRECTOR.name)).toHaveCount(0);
  // Her open Studio notices without a reload.
  await expect(ada.page.getByRole('heading', { name: 'Sign in to Hildegard.' })).toBeVisible({
    timeout: 15_000,
  });
  await Promise.all([owner.context.close(), ada.context.close()]);
});

test('signing out ends the session on this device', async ({ browser }) => {
  const owner = await elsewhere(browser);
  await signIn(owner.page, OWNER);
  await owner.page.goto(`${hosted}/#/settings/account`);
  await expectAccessible(owner.page, 'account');
  await expectCurlyQuotes(owner.page, 'account');
  await owner.page.getByRole('button', { name: 'Sign out' }).click();
  await expect(owner.page.getByRole('heading', { name: 'Sign in to Hildegard.' })).toBeVisible();
  await owner.page.reload();
  await expect(owner.page.getByRole('heading', { name: 'Sign in to Hildegard.' })).toBeVisible();
  expect(await owner.context.cookies()).toEqual([]);
  await owner.context.close();
});

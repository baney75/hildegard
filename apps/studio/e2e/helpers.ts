// SPDX-License-Identifier: AGPL-3.0-only
import AxeBuilder from '@axe-core/playwright';
import { type APIRequestContext, expect, type Page } from '@playwright/test';

/** Fail on any page error or console error: a perfect UI logs nothing. */
export function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()} ${m.location().url}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 400)
      errors.push(`http ${r.status()}: ${r.request().method()} ${new URL(r.url()).pathname}`);
  });
  return errors;
}

export async function expectAccessible(page: Page, what: string) {
  // Let open animations settle, or axe measures colours mid-fade.
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Number.POSITIVE_INFINITY,
      ),
  );
  const r = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(
    bad.map(
      (v) =>
        `${what}: ${v.id} (${v.impact}) ${v.nodes
          .map((n) => `${n.target.join(' ')} [${n.failureSummary?.replace(/\s+/g, ' ')}]`)
          .slice(0, 3)
          .join(' | ')}`,
    ),
  ).toEqual([]);
}

export async function createShot(page: Page, prompt: string) {
  await page.locator('#hg-prompt').fill(prompt);
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.locator('#hg-prompt')).toHaveValue('');
}

/** Open a new, empty film, so a test sees only its own shots however many runs share the server. */
export async function freshFilm(page: Page, request: APIRequestContext) {
  const res = await request.post('/api/projects', { headers: { 'x-hildegard': '1' }, data: {} });
  const { id } = (await res.json()) as { id: string };
  await page.goto(`/#/film/${id}`);
  return id;
}

/** UI text uses curly quotes and apostrophes. Code, commands and what people typed are left out. */
export async function expectCurlyQuotes(page: Page, what: string) {
  const straight = await page.evaluate(() => {
    const out: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || el.closest('code, pre, kbd, script, style, textarea, .num, .cs-folio__t, .hg-linkbtn'))
        continue;
      if (!el.checkVisibility()) continue;
      if (/['"]/.test(n.textContent ?? '')) out.push(n.textContent!.trim().slice(0, 80));
    }
    return out;
  });
  expect(straight, `${what}: straight quotes`).toEqual([]);
}

/**
 * Show the first-run welcome: the test server runs the stand-in GPU, which skips it, so the snapshot the page
 * receives says this is a real computer with nothing made yet.
 */
export async function asFirstRun(page: Page, request: APIRequestContext) {
  const snapshot = await (await request.get('/api/snapshot')).json();
  const first = {
    ...snapshot,
    projects: [],
    shots: [],
    takes: [],
    engine: { ...snapshot.engine, fake: false },
  };
  await page.route('**/api/events', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
      body: `retry: 600000\nevent: hello\ndata: ${JSON.stringify({ snapshot: first })}\n\n`,
    }),
  );
}

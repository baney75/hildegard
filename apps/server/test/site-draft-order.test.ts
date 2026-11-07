// SPDX-License-Identifier: AGPL-3.0-only
// A draft is never public, not even for an instant: writePost records the slug as a draft before it writes the page,
// so a failure or a crash between the two steps leaves a withheld page, never a public one.
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writePost } from '../src/posts.ts';
import { publicSiteRoutes } from '../src/public-sites.ts';
import { Sites } from '../src/sites.ts';

let dir: string;
let sites: Sites;
let id: string;

const input = (over: Record<string, unknown>) => ({
  title: 'Held Back',
  body_md: 'Words that must not be public yet.',
  byline: 'By Jane Doe',
  date: '2026-11-07',
  ...over,
});
const opts = { base: null };

/** Whether the public route serves blog/<slug>/ from a copy of the site as the disk is right now. */
const servedNow = async (slug: string) => {
  const snap = mkdtempSync(join(tmpdir(), 'hg-order-snap-'));
  try {
    cpSync(join(dir, id), join(snap, id), { recursive: true });
    const app = new Hono().route('/s', publicSiteRoutes(new Sites(snap)));
    const res = await app.request(`/s/${id}/blog/${slug}/`);
    return res.status === 200 ? await res.text() : null;
  } finally {
    rmSync(snap, { recursive: true, force: true });
  }
};

/** A Sites that runs `after` once each write to a blog page has landed and before the next step runs. */
const watched = (after: (path: string) => void) =>
  new Proxy(sites, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== 'write') return typeof value === 'function' ? value.bind(target) : value;
      return (...args: Parameters<Sites['write']>) => {
        const out = target.write(...args);
        after(args[1]);
        return out;
      };
    },
  });

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'hg-order-'));
  sites = new Sites(dir);
  id = sites.create({
    title: 'Order',
    source: 'empty',
    files: [['index.html', '<!doctype html><title>Order</title><p>Home']],
  }).id;
  sites.setPublished(id, true);
  writePost(sites, id, input({ title: 'Already Public', body_md: 'Public words.' }), opts);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('a draft is withheld at every step of writing it', () => {
  it('for a new draft on a published site', async () => {
    // The page is on the disk the moment `write` returns; look at the disk then, from the public route's side.
    const looks: Promise<string | null>[] = [];
    const probe = watched((path) => {
      if (path === 'blog/held-back/index.html') looks.push(servedNow('held-back'));
    });
    writePost(probe, id, input({ draft: true }), opts);
    const seen = await Promise.all(looks);
    expect(seen.length).toBeGreaterThan(0);
    for (const html of seen) expect(html).toBeNull();
    expect(await servedNow('held-back')).toBeNull();
  });

  it('for a published post turned back into a draft, so its new words are never public', async () => {
    const looks: Promise<string | null>[] = [];
    const probe = watched((path) => {
      if (path === 'blog/already-public/index.html') looks.push(servedNow('already-public'));
    });
    expect(await servedNow('already-public')).toContain('Public words.');
    writePost(
      probe,
      id,
      input({ title: 'Already Public', body_md: 'Rewritten as a draft.', draft: true }),
      opts,
    );
    const seen = await Promise.all(looks);
    expect(seen.length).toBeGreaterThan(0);
    for (const html of seen) expect(html).toBeNull();
    expect(await servedNow('already-public')).toBeNull();
  });

  it('and when recording the draft fails, no page is written', () => {
    const failing = new Proxy(sites, {
      get(target, prop, receiver) {
        if (prop === 'setPosts')
          return () => {
            throw new Error('disk full');
          };
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    expect(() => writePost(failing, id, input({ title: 'Never Lands', draft: true }), opts)).toThrow(
      'disk full',
    );
    expect(existsSync(join(dir, id, 'files', 'blog', 'never-lands', 'index.html'))).toBe(false);
  });

  it('while a draft that is published still goes live', async () => {
    writePost(sites, id, input({ draft: false, body_md: 'Now ready.' }), opts);
    expect(await servedNow('held-back')).toContain('Now ready.');
  });
});

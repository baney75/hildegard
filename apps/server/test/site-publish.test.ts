// SPDX-License-Identifier: AGPL-3.0-only
// Publishing: /s/<id>/ shows a site the owner published to anyone, on both listeners, and shows nothing else.
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { open } from '../src/access.ts';
import { insideSite, publicCsp, withheld } from '../src/public-sites.ts';
import { boot, type Harness, raw, textOf } from './harness.ts';

let h: Harness;
/** The server's clock, so a session can come due for rotation. */
const clock = { t: Date.now() };
let id: string;
let folder: string;
const SECRET = 'TOPSECRET-do-not-serve';

const get = (base: string, path: string, headers: Record<string, string> = {}) =>
  raw(base, path, { headers });
const put = (path: string, c = true) =>
  h.local(`/api/sites/${id}${path}`, 'PUT', c ? { published: true } : undefined);

beforeAll(async () => {
  h = await boot('publish', { now: () => clock.t });
  const made = await h.local('/api/sites', 'POST', {
    from: 'template',
    template: 'journal',
    title: 'Low Water',
  });
  id = ((await made.json()) as { id: string }).id;
  folder = join(h.dir, 'sites', id, 'files');
  // A published post, a draft, notes, and files that must never be reachable.
  await h.local(`/api/sites/${id}/posts`, 'POST', {
    title: 'Public Post',
    body_md: 'Words anyone may read.',
    byline: 'By Jane Doe, with Hildegard',
    date: '2026-11-01',
    notes_md: `Interview. ${SECRET}`,
  });
  await h.local(`/api/sites/${id}/posts`, 'POST', {
    title: 'Hidden Draft',
    body_md: `A draft. ${SECRET}`,
    byline: 'By Jane Doe',
    date: '2026-11-02',
    draft: true,
  });
  await h.local(`/api/sites/${id}/files/site.json`, 'PUT');
  writeFileSync(join(folder, 'site.json'), `{"secret":"${SECRET}"}`);
  writeFileSync(join(folder, '.env'), SECRET);
  mkdirSync(join(folder, '.private'), { recursive: true });
  writeFileSync(join(folder, '.private', 'x.txt'), SECRET);
  writeFileSync(join(folder, 'a.hg-tmp'), SECRET);
  writeFileSync(join(h.dir, 'outside.txt'), SECRET);
  writeFileSync(join(h.dir, 'sites', id, 'secret.txt'), SECRET);
}, 30_000);
afterAll(() => h.close());

describe('before it is published', () => {
  it('answers 404 for every path, whether or not the site exists, on both listeners', async () => {
    for (const base of [h.srv.url, h.remote])
      for (const path of [
        `/s/${id}/`,
        `/s/${id}`,
        `/s/${id}/styles.css`,
        `/s/${id}/blog/public-post/`,
        `/s/000000000000/`,
      ]) {
        const r = await get(base, path);
        expect(r.status, `${base} ${path}`).toBe(404);
        expect(r.body).not.toContain('Low Water');
      }
  });
});

describe('who may publish', () => {
  it('is the owner only: a director can’t, over REST or over their agent', async () => {
    const ada = await h.director('Ada');
    expect((await h.as(ada.cookie, `/api/sites/${id}/publish`, 'PUT', { published: true })).status).toBe(403);
    expect((await h.as(undefined, `/api/sites/${id}/publish`, 'PUT', { published: true })).status).toBe(401);
    const agent = await h.mcpFor('Ada');
    const r = (await agent.callTool({
      name: 'site_publish',
      arguments: { site_id: id, published: true },
    })) as CallToolResult;
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('Only the owner');
    expect((await get(h.remote, `/s/${id}/`)).status).toBe(404);
  });

  it('is the owner’s: this computer, the owner signed in elsewhere, or the owner’s agent', async () => {
    const view = (await (await put('/publish')).json()) as { published: boolean; path: string };
    expect(view).toMatchObject({ published: true, path: `/s/${id}/` });
    expect((await h.as(h.owner.cookie, `/api/sites/${id}/publish`, 'PUT', { published: false })).status).toBe(
      200,
    );
    expect((await get(h.srv.url, `/s/${id}/`)).status).toBe(404);
    const agent = await h.mcpFor('Alex');
    const r = (await agent.callTool({
      name: 'site_publish',
      arguments: { site_id: id, published: true },
    })) as CallToolResult;
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain('is published at');
  });
});

describe('a published site', () => {
  it('is served to anyone, with no sign-in, on the Studio listener and the hosted one', async () => {
    for (const base of [h.srv.url, h.remote]) {
      const home = await get(base, `/s/${id}/`);
      expect(home.status, base).toBe(200);
      expect(home.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(home.body).toContain('The Tide Keepers');
      const css = await get(base, `/s/${id}/styles.css`);
      expect(css.status).toBe(200);
      expect(css.headers['content-type']).toBe('text/css; charset=utf-8');
      const post = await get(base, `/s/${id}/blog/public-post/`);
      expect(post.status).toBe(200);
      expect(post.body).toContain('Words anyone may read.');
      expect((await get(base, `/s/${id}/feed.xml`)).headers['content-type']).toContain('xml');
      expect((await get(base, `/s/${id}/art/tide.svg`)).headers['content-type']).toBe('image/svg+xml');
    }
  });

  it('answers HEAD, and redirects a folder to its slash so relative links work', async () => {
    const head = await raw(h.remote, `/s/${id}/styles.css`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
    expect(Number(head.headers['content-length'])).toBeGreaterThan(100);
    const dir = await get(h.remote, `/s/${id}/blog/public-post`);
    expect(dir.status).toBe(308);
    expect(dir.headers.location).toBe(`/s/${id}/blog/public-post/`);
    expect((await get(h.remote, `/s/${id}`)).headers.location).toBe(`/s/${id}/`);
    expect((await get(h.remote, `/s/${id}/nothing.html`)).status).toBe(404);
  });

  it('refuses everything but GET and HEAD', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      for (const headers of [{}, { 'x-hildegard': '1' }] as Record<string, string>[]) {
        const r = await raw(h.remote, `/s/${id}/styles.css`, { method, headers });
        expect([403, 405], `${method} ${JSON.stringify(headers)}`).toContain(r.status);
      }
    }
    expect((await get(h.srv.url, `/s/${id}/styles.css`)).status).toBe(200);
  });

  it('sends the headers that keep a public page in its own sandbox', async () => {
    const r = await get(h.remote, `/s/${id}/`);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    const csp = String(r.headers['content-security-policy']);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toMatch(/^sandbox /);
    expect(csp).not.toContain('allow-same-origin');
    expect(csp).not.toContain('allow-scripts');
    expect(csp).not.toContain('script-src');
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['cross-origin-resource-policy']).toBe('cross-origin');
    for (const path of [`/s/${id}/styles.css`, `/s/${id}/art/tide.svg`, `/s/${id}/blog/`])
      expect((await get(h.remote, path)).headers['content-security-policy'], path).toMatch(/^sandbox /);
  });

  it('allows scripts only when the site has scripts of its own, and then only its own', async () => {
    expect(publicCsp(false)).not.toContain('script');
    expect(publicCsp(true)).toContain("script-src 'self'");
    expect(publicCsp(true)).toContain('allow-scripts');
    expect(publicCsp(true)).not.toContain('allow-same-origin');
    expect(publicCsp(true)).not.toContain("'unsafe-inline'; script");
    await h.local(`/api/sites/${id}/files/app.js`, 'PUT');
    writeFileSync(join(folder, 'app.js'), 'console.log(1)');
    const r = await get(h.remote, `/s/${id}/`);
    const csp = String(r.headers['content-security-policy']);
    expect(csp).toContain('allow-scripts');
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(csp).not.toContain('allow-same-origin');
    expect((await get(h.remote, `/s/${id}/app.js`)).headers['content-type']).toContain('javascript');
  });

  it('sends and reads no cookie, even for someone signed in', async () => {
    for (const cookie of [h.owner.cookie, 'hildegard_session=garbage', '__Host-hildegard=garbage']) {
      for (const base of [h.srv.url, h.remote]) {
        const r = await get(base, `/s/${id}/`, { cookie });
        expect(r.status).toBe(200);
        expect(r.headers['set-cookie'], `${base} ${cookie.slice(0, 20)}`).toBeUndefined();
      }
    }
    // And a bad cookie is not a reason to refuse: nothing here reads it.
    expect((await get(h.remote, `/s/${id}/styles.css`, { cookie: 'hildegard_session=garbage' })).status).toBe(
      200,
    );
  });

  it('does not rotate a session that is due, which would set a cookie', async () => {
    const eve = await h.director('Eve');
    await put('/publish');
    // The control: anywhere else a session this old gets a new cookie…
    clock.t += 2 * 3600_000;
    const elsewhere = await get(h.remote, '/api/auth/me', { cookie: eve.cookie });
    expect(elsewhere.headers['set-cookie'], 'the session was due for rotation').toBeDefined();
    // …and on a published site it gets nothing.
    const fay = await h.director('Fay');
    clock.t += 2 * 3600_000;
    for (const base of [h.srv.url, h.remote]) {
      const r = await get(base, `/s/${id}/`, { cookie: fay.cookie });
      expect(r.status).toBe(200);
      expect(r.headers['set-cookie'], base).toBeUndefined();
    }
    const control = await get(h.remote, '/api/auth/me', { cookie: fay.cookie });
    expect(control.headers['set-cookie']).toBeDefined();
  });

  it('keeps the Host check: an unknown name gets 421', async () => {
    const r = await get(h.remote, `/s/${id}/`, { host: 'evil.example' });
    expect(r.status).toBe(421);
    expect(r.body).not.toContain('Low Water');
  });
});

describe('what counts as inside the site folder', () => {
  const win = { api: win32, fold: true };
  it('is the segments under the folder, and nothing for another drive, a sibling or a parent (Windows paths)', () => {
    const root = 'C:\\Sites\\a1\\files';
    expect(insideSite(root, root, win)).toEqual([]);
    expect(insideSite(root, 'C:\\Sites\\a1\\files\\blog\\x.html', win)).toEqual(['blog', 'x.html']);
    // A junction or symlink to another drive: path.relative answers with an absolute path, which isn't inside.
    expect(win32.isAbsolute(win32.relative(root, 'D:\\private\\secret.txt'))).toBe(true);
    expect(insideSite(root, 'D:\\private\\secret.txt', win)).toBeNull();
    expect(insideSite(root, 'D:\\Sites\\a1\\files\\x.txt', win)).toBeNull();
    expect(insideSite(root, '\\\\nas\\share\\x.txt', win)).toBeNull();
    // A sibling that starts with the same letters, and the parent.
    expect(insideSite(root, 'C:\\Sites\\a1\\files2\\x.txt', win)).toBeNull();
    expect(insideSite(root, 'C:\\Sites\\a1', win)).toBeNull();
    // Windows spells a folder in any case, and the spelling kept is the one on disk.
    expect(insideSite(root, 'c:\\SITES\\A1\\FILES\\Notes\\x.md', win)).toEqual(['Notes', 'x.md']);
  });

  it('is the same on POSIX paths, and case matters there', () => {
    const p = { api: posix, fold: false };
    expect(insideSite('/data/sites/a1/files', '/data/sites/a1/files', p)).toEqual([]);
    expect(insideSite('/data/sites/a1/files', '/data/sites/a1/files/blog/x.html', p)).toEqual([
      'blog',
      'x.html',
    ]);
    expect(insideSite('/data/sites/a1/files', '/data/sites/a1/files2/x', p)).toBeNull();
    expect(insideSite('/data/sites/a1/files', '/data/sites/A1/files/x', p)).toBeNull();
    expect(insideSite('/data/sites/a1/files', '/etc/passwd', p)).toBeNull();
    expect(insideSite('/', '/etc/passwd', p)).toEqual(['etc', 'passwd']);
  });

  it('refuses a real symlink to a folder outside, and allows one inside', () => {
    const base = mkdtempSync(join(tmpdir(), 'hg-inside-'));
    const root = join(base, 'files');
    const out = join(base, 'private');
    mkdirSync(join(root, 'real'), { recursive: true });
    mkdirSync(out);
    writeFileSync(join(out, 'secret.txt'), SECRET);
    writeFileSync(join(root, 'real', 'ok.txt'), 'ok');
    try {
      symlinkSync(out, join(root, 'door'));
      symlinkSync(join(root, 'real'), join(root, 'alias'));
    } catch {
      return;
    }
    const r = realpathSync.native(root);
    expect(insideSite(r, realpathSync.native(join(root, 'door', 'secret.txt')))).toBeNull();
    expect(insideSite(r, realpathSync.native(join(root, 'alias', 'ok.txt')))).toEqual(['real', 'ok.txt']);
  });
});

describe('what is withheld, decided on the real spelling', () => {
  const drafts = ['hidden-draft', 'kestrel-post'];
  it('ignores case and Unicode look-alikes, which a case-insensitive disk treats as the same name', () => {
    for (const parts of [
      ['notes', 'public-post.md'],
      ['NOTES', 'public-post.md'],
      ['Notes', 'public-post.md'],
      ['note\u017f', 'public-post.md'], // ſ folds to s
      ['NOTE\u017f'],
      ['blog', 'Hidden-Draft', 'index.html'],
      ['blog', 'HIDDEN-DRAFT'],
      ['blog', 'ke\u017ftrel-po\u017ft', 'index.html'],
      ['blog', '\u212aestrel-post'], // Kelvin sign folds to k
      ['SITE.JSON'],
      ['\u017fite.json'],
      ['sub', 'Site.Json'],
      ['x.HG-TMP'],
      ['\uff0eenv'], // a full-width dot
      ['a', '.private', 'x'],
    ])
      expect(withheld(parts, drafts), parts.join('/')).toBe(true);
  });
  it('lets ordinary files and published posts through', () => {
    for (const parts of [
      ['index.html'],
      ['styles.css'],
      ['blog', 'public-post', 'index.html'],
      ['blog', 'index.html'],
      ['assets', 'notes.txt'],
      ['notes-from-the-road', 'index.html'],
    ])
      expect(withheld(parts, drafts), parts.join('/')).toBe(false);
  });
});

describe('what is never served', () => {
  const never = async (path: string, why = path) => {
    for (const base of [h.srv.url, h.remote]) {
      const r = await get(base, path);
      expect(r.status, `${why} ${base}`).not.toBe(200);
      expect(r.body, `${why} ${base}`).not.toContain(SECRET);
    }
  };

  it('notes, drafts, site.json, dotfiles and half-written files', async () => {
    await never(`/s/${id}/notes/public-post.md`);
    await never(`/s/${id}/NOTES/public-post.md`, 'notes in capitals');
    await never(`/s/${id}/notes/`);
    await never(`/s/${id}/blog/hidden-draft/`);
    await never(`/s/${id}/blog/hidden-draft/index.html`);
    await never(`/s/${id}/Blog/Hidden-Draft/index.html`, 'draft in capitals');
    await never(`/s/${id}/site.json`);
    await never(`/s/${id}/SITE.JSON`);
    await never(`/s/${id}/.env`);
    await never(`/s/${id}/.private/x.txt`);
    await never(`/s/${id}/a.hg-tmp`);
    // The files really are there, so a 404 is the route's doing.
    expect((await get(h.remote, `/s/${id}/blog/hidden-draft/`)).status).toBe(404);
    // The published post and the draft's page both exist on disk.
    expect((await h.local(`/api/sites/${id}/files/blog/hidden-draft/index.html`)).status).toBe(200);
    expect((await h.local(`/api/sites/${id}/files/notes/public-post.md`)).status).toBe(200);
  });

  it('a name that a case-insensitive disk would read as notes, a draft or site.json', async () => {
    const draft = await h.local(`/api/sites/${id}/posts`, 'POST', {
      title: 'Kestrel Post',
      body_md: 'Draft words.',
      byline: 'By Jane Doe',
      date: '2026-11-03',
      draft: true,
    });
    expect(draft.status).toBe(201);
    // On a computer that tells ſ from s these are folders of their own; they are withheld all the same,
    // because on APFS and NTFS the same request opens the real notes/ and the real draft.
    for (const [dir, file] of [
      ['note\u017f', 'x.md'],
      ['blog/ke\u017ftrel-po\u017ft', 'index.html'],
    ] as const) {
      mkdirSync(join(folder, dir), { recursive: true });
      writeFileSync(join(folder, dir, file), SECRET);
    }
    writeFileSync(join(folder, '\u017fite.json'), SECRET);
    await never(`/s/${id}/note%C5%BF/x.md`, 'notes with a long s');
    await never(`/s/${id}/Note%C5%BF/x.md`, 'notes with a long s and a capital');
    await never(`/s/${id}/Notes/public-post.md`, 'Notes');
    await never(`/s/${id}/NOTES/public-post.md`, 'NOTES');
    await never(`/s/${id}/blog/ke%C5%BFtrel-po%C5%BFt/index.html`, 'a draft with long s');
    await never(`/s/${id}/blog/KESTREL-POST/index.html`, 'a draft in capitals');
    await never(`/s/${id}/blog/%E2%84%AAestrel-post/`, 'a draft with the Kelvin sign');
    await never(`/s/${id}/%C5%BFite.json`, 'site.json with a long s');
    await never(`/s/${id}/SITE.JSON`);
    // What Windows ignores: a trailing dot or space, a stream name, an 8.3 short name.
    await never(`/s/${id}/notes./public-post.md`, 'trailing dot');
    await never(`/s/${id}/notes%20/public-post.md`, 'trailing space');
    await never(`/s/${id}/blog/hidden-draft./`, 'draft with a trailing dot');
    await never(`/s/${id}/site.json::$DATA`, 'a stream');
    await never(`/s/${id}/site.json:x`, 'a stream name');
    await never(`/s/${id}/HIDDEN~1/index.html`, 'a short name');
    await never(`/s/${id}/NOTES~1/public-post.md`, 'a short name');
  });

  it('anything outside the site folder, by ../ or by encoding', async () => {
    const tries = [
      `/s/${id}/../secret.txt`,
      `/s/${id}/../../outside.txt`,
      `/s/${id}/..%2fsecret.txt`,
      `/s/${id}/..%2f..%2foutside.txt`,
      `/s/${id}/%2e%2e/secret.txt`,
      `/s/${id}/%2e%2e%2fsecret.txt`,
      `/s/${id}/%2E%2E%2F%2E%2E%2Foutside.txt`,
      `/s/${id}/%252e%252e%252fsecret.txt`,
      `/s/${id}/..%5csecret.txt`,
      `/s/${id}/%2e%2e%5csecret.txt`,
      `/s/${id}/blog/../../secret.txt`,
      `/s/${id}/blog/%2e%2e/%2e%2e/secret.txt`,
      `/s/${id}/..;/secret.txt`,
      `/s/${id}//..//secret.txt`,
      `/s/${id}/%00`,
      `/s/${id}/styles.css%00.png`,
      `/s/${id}/%c0%ae%c0%ae/secret.txt`,
      `/s/${id}/..%2f..%2f..%2f..%2f..%2fetc%2fpasswd`,
      `/s/${id}/%2e%2e%2f%2e%2e%2f%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd`,
    ];
    for (const path of tries) {
      for (const base of [h.srv.url, h.remote]) {
        const r = await get(base, path);
        expect(r.status, `${base} ${path}`).not.toBe(200);
        expect(r.body, `${base} ${path}`).not.toContain(SECRET);
        expect(r.body, `${base} ${path}`).not.toContain('root:');
      }
    }
  });

  it('a symlink that leaves the folder, to a file or to a folder', async () => {
    try {
      symlinkSync(join(h.dir, 'outside.txt'), join(folder, 'leak.txt'));
      symlinkSync(h.dir, join(folder, 'leakdir'));
      symlinkSync(join(h.dir, 'sites', id, 'site.json'), join(folder, 'leak.json'));
    } catch {
      return; // A computer that won't make symlinks has nothing to follow.
    }
    await never(`/s/${id}/leak.txt`);
    await never(`/s/${id}/leakdir/outside.txt`);
    await never(`/s/${id}/leakdir/`);
    await never(`/s/${id}/leak.json`);
    // A link to a place inside the folder that is itself withheld (notes, a draft) is refused too.
    symlinkSync(join(folder, 'notes'), join(folder, 'innocent'));
    symlinkSync(join(folder, 'blog', 'hidden-draft'), join(folder, 'alias'));
    await never(`/s/${id}/innocent/public-post.md`);
    await never(`/s/${id}/alias/`);
    // One that stays inside and is allowed is served.
    symlinkSync(join(folder, 'styles.css'), join(folder, 'alias.css'));
    expect((await get(h.remote, `/s/${id}/alias.css`)).status).toBe(200);
  });

  it('the notes stay out of the feed and sitemap too', async () => {
    for (const f of ['feed.xml', 'sitemap.xml', 'blog/']) {
      const r = await get(h.remote, `/s/${id}/${f}`);
      expect(r.body).not.toContain('notes/');
      expect(r.body).not.toContain('hidden-draft');
      expect(r.body).not.toContain(SECRET);
    }
  });
});

describe('taking it back', () => {
  it('answers 404 again the moment it is unpublished, and the access rule is narrow', async () => {
    expect((await h.local(`/api/sites/${id}/publish`, 'PUT', { published: false })).status).toBe(200);
    for (const base of [h.srv.url, h.remote]) expect((await get(base, `/s/${id}/`)).status).toBe(404);
    expect(open('GET', `/s/${id}/`)).toBe(true);
    expect(open('HEAD', `/s/${id}/styles.css`)).toBe(true);
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(open(m, `/s/${id}/`), m).toBe(false);
    expect(open('GET', `/api/sites/${id}`)).toBe(false);
    expect(open('GET', `/preview/${id}/key/`)).toBe(true); // already so: the key is the check
  });
});

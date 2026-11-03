// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSafety } from '@hildegard/presets';
import { describe, expect, it } from 'vitest';
import { FileFetcher, gitBlobId } from '../src/fetcher.ts';
import { fakeFetch } from './helpers.ts';

const CONFIG = Buffer.from('{"dim": 512}\n');

/** A small file Hugging Face keeps in git: no x-linked-etag, and its etag is the git object id. */
function setup(body: Buffer, head?: () => Response) {
  const fetch = fakeFetch([
    [
      'HEAD /org/voice/resolve/',
      head ??
        (() =>
          new Response(null, {
            status: 200,
            headers: {
              'x-repo-commit': 'c'.repeat(40),
              etag: `"${gitBlobId(CONFIG)}"`,
              'content-length': String(CONFIG.length),
            },
          })),
    ],
    ['GET /org/voice/resolve/', () => new Response(body, { status: 200 })],
  ]);
  const root = mkdtempSync(join(tmpdir(), 'hg-fetch-'));
  const f = new FileFetcher({
    recordFile: join(root, 'models.json'),
    lock: { version: 1, files: {} },
    tokens: { accessToken: async () => null },
    safety: loadSafety(),
    fetch,
  });
  const job = {
    abort: new AbortController(),
    done: 0,
    total: CONFIG.length,
    file: 'config.json',
    bytesPerSec: 0,
  };
  return {
    f,
    fetch,
    root,
    job,
    dest: join(root, 'config.json'),
    file: { repo: 'org/voice', path: 'config.json' },
  };
}

describe('FileFetcher', () => {
  it('git ids are git’s own', () => {
    // `printf 'hello\n' | git hash-object --stdin`
    expect(gitBlobId(Buffer.from('hello\n'))).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });

  it('verifies a small file kept in git by its git object id, then pins its SHA-256', async () => {
    const { f, root, job, dest, file } = setup(CONFIG);
    await f.fetchFile(file, dest, job);
    expect(readFileSync(dest)).toEqual(CONFIG);
    const rec = JSON.parse(readFileSync(join(root, 'models.json'), 'utf8'));
    expect(rec['org/voice/config.json']).toEqual({
      revision: 'c'.repeat(40),
      sha256: createHash('sha256').update(CONFIG).digest('hex'),
      size: CONFIG.length,
    });
    expect(f.isInstalled(file, dest)).toBe(true);
  });

  it('deletes a small file that doesn’t match its git object id', async () => {
    const { f, job, dest, file } = setup(Buffer.from('{"dim": 999}\n'));
    await expect(f.fetchFile(file, dest, job)).rejects.toMatchObject({ code: 'corrupt' });
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(`${dest}.part`)).toBe(false);
  });

  it('uses the first answer’s size and git id when a git file redirects to resolve-cache', async () => {
    const { f, fetch, job, dest, file } = setup(
      CONFIG,
      () =>
        new Response(null, {
          status: 307,
          headers: {
            location: '/api/resolve-cache/models/org/voice/abc/config.json',
            'x-repo-commit': 'c'.repeat(40),
            'x-linked-etag': `"${gitBlobId(CONFIG)}"`,
            'x-linked-size': String(CONFIG.length),
          },
        }),
    );
    await f.fetchFile(file, dest, job);
    expect(readFileSync(dest)).toEqual(CONFIG);
    expect(fetch.calls.some((c) => c.url.includes('/api/resolve-cache/'))).toBe(false);
    const downloads = fetch.calls.filter((c) => c.method === 'GET' && !c.url.includes('/api/'));
    expect(downloads.length).toBe(1);
    expect(downloads[0]!.url).toContain('/org/voice/resolve/');
  });

  it('still refuses a resolve-cache git file whose bytes don’t match', async () => {
    const { f, job, dest, file } = setup(
      Buffer.from('{"dim": 999}\n'),
      () =>
        new Response(null, {
          status: 307,
          headers: {
            location: '/api/resolve-cache/models/org/voice/abc/config.json',
            'x-repo-commit': 'c'.repeat(40),
            'x-linked-etag': `"${gitBlobId(CONFIG)}"`,
            'x-linked-size': String(CONFIG.length),
          },
        }),
    );
    await expect(f.fetchFile(file, dest, job)).rejects.toMatchObject({ code: 'corrupt' });
    expect(existsSync(dest)).toBe(false);
  });

  it('pins the SHA-256 of an LFS file from a 302 without following it', async () => {
    const sha = createHash('sha256').update(CONFIG).digest('hex');
    const { f, fetch, root, job, dest, file } = setup(
      CONFIG,
      () =>
        new Response(null, {
          status: 302,
          headers: {
            location: 'https://cdn.example/lfs/abc',
            'x-repo-commit': 'c'.repeat(40),
            'x-linked-etag': `"${sha}"`,
            'x-linked-size': String(CONFIG.length),
          },
        }),
    );
    await f.fetchFile(file, dest, job);
    const rec = JSON.parse(readFileSync(join(root, 'models.json'), 'utf8'));
    expect(rec['org/voice/config.json'].sha256).toBe(sha);
    expect(fetch.calls.some((c) => c.url.includes('cdn.example'))).toBe(false);
  });

  it('follows a repo rename to the new name and downloads from there', async () => {
    const fetch = fakeFetch([
      [
        'HEAD /org/old/resolve/',
        () => new Response(null, { status: 307, headers: { location: '/org/new/resolve/main/config.json' } }),
      ],
      [
        'HEAD /org/new/resolve/',
        () =>
          new Response(null, {
            status: 200,
            headers: {
              'x-repo-commit': 'c'.repeat(40),
              etag: `"${gitBlobId(CONFIG)}"`,
              'content-length': String(CONFIG.length),
            },
          }),
      ],
      ['GET /org/new/resolve/', () => new Response(CONFIG, { status: 200 })],
    ]);
    const root = mkdtempSync(join(tmpdir(), 'hg-fetch-'));
    const f = new FileFetcher({
      recordFile: join(root, 'models.json'),
      lock: { version: 1, files: {} },
      tokens: { accessToken: async () => null },
      safety: loadSafety(),
      fetch,
    });
    const job = {
      abort: new AbortController(),
      done: 0,
      total: CONFIG.length,
      file: 'config.json',
      bytesPerSec: 0,
    };
    const dest = join(root, 'config.json');
    await f.fetchFile({ repo: 'org/old', path: 'config.json' }, dest, job);
    expect(readFileSync(dest)).toEqual(CONFIG);
  });
});

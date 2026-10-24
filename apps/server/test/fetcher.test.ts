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
function setup(body: Buffer) {
  const fetch = fakeFetch([
    [
      'HEAD /org/voice/resolve/',
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
  return { f, root, job, dest: join(root, 'config.json'), file: { repo: 'org/voice', path: 'config.json' } };
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
});

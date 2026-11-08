// SPDX-License-Identifier: AGPL-3.0-only
// tools/edit_video.py and tools/hgedit on their own, with clips made here: the edit list contract, editing by words, the
// pause gate, captions, grouped rendering, the output gate and its planted-secret self-test, reframing and ducking. The
// cases live in tools/test_video_edit.py (one unittest each, so a failure names the case); this runs that file where the
// rest of the tests run, on Linux, macOS and Windows. The OCR half needs tesseract and says so when it is missing.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { exportPython } from '../src/export.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const py = exportPython(mkdtempSync(join(tmpdir(), 'hg-py-')));

describe('video editing tools', () => {
  it('pass their own suite', { timeout: 900_000 }, () => {
    const r = spawnSync(py, ['-I', join(root, 'tools', 'test_video_edit.py')], {
      encoding: 'utf8',
      env: { ...process.env, HG_EDIT_ENCODER: 'libx264', PYTHONIOENCODING: 'utf-8' },
      maxBuffer: 64 * 1024 * 1024,
    });
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out.slice(-6000)).toBe(0);
    expect(out).toMatch(/\nOK(?: \(skipped=\d+\))?\s*$/);
    // Say plainly when the planted-key proof could not run.
    if (/skipped=\d+/.test(out))
      console.warn('video-edit: tesseract is not installed here; the OCR proof was skipped.');
  });

  it('are carried, byte for byte, by the hildegard-video-edit skill', () => {
    expect(() =>
      execFileSync(process.execPath, [join(root, 'scripts', 'sync-skill-shared.mjs'), '--check'], {
        encoding: 'utf8',
        stdio: 'pipe',
      }),
    ).not.toThrow();
  });
});

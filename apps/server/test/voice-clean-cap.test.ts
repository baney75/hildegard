// SPDX-License-Identifier: AGPL-3.0-only
// tools/voice_clean.py refuses a recording too long to hold in memory, by its probed length and by what it decodes.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { make, py, voiceCleanScript } from './audio.ts';

const dir = mkdtempSync(join(tmpdir(), 'hg-clean-cap-'));
const f = (name: string) => join(dir, name);

/** clean_file with a low cap, and optionally a probe that lies about the length. */
function clean(src: string, out: string, lie: boolean) {
  const code = [
    'import json, sys',
    'sys.path.insert(0, sys.argv[1])',
    'import voice_clean as v',
    'v.MAX_SECONDS = 2',
    ...(lie ? ["v.probe = lambda p: {'seconds': 0.5, 'audio': True, 'video': False}"] : []),
    'try:',
    '    print(json.dumps({"ok": True, **v.clean_file(sys.argv[2], sys.argv[3])}))',
    'except v.CleanError as e:',
    '    print(json.dumps({"ok": False, "error": str(e)}))',
  ].join('\n');
  const stdout = execFileSync(py, ['-I', '-c', code, dirname(voiceCleanScript), src, out], {
    encoding: 'utf8',
  });
  return JSON.parse(stdout.trim().split('\n').at(-1)!) as { ok: boolean; error?: string };
}

describe('voice_clean.py length cap', () => {
  it('refuses a recording whose probed length is over the cap', () => {
    make('speech', f('long.wav'), '4', '1');
    expect(clean(f('long.wav'), f('long-out.wav'), false)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/too long/),
    });
    expect(existsSync(f('long-out.wav'))).toBe(false);
  }, 60_000);

  it('refuses while decoding when the container lied about its length', () => {
    make('speech', f('lying.wav'), '4', '1');
    expect(clean(f('lying.wav'), f('lying-out.wav'), true)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/too long/),
    });
    expect(existsSync(f('lying-out.wav'))).toBe(false);
  }, 60_000);
});

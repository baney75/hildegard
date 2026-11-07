// SPDX-License-Identifier: AGPL-3.0-only
// hildegard-sound's duck_mix.py and Recipe B never cut a voice that runs past --total: they refuse, with the seconds over.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const python = process.env.HILDEGARD_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const root = resolve(import.meta.dirname, '../../..');
const script = join(root, 'skills/hildegard-sound/scripts/duck_mix.py'); // the video-edit copy is held equal by the sync check
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
let dir: string;

const tone = (name: string, hz: number, seconds: number) => {
  const out = join(dir, name);
  const src = `sine=frequency=${hz}:duration=${seconds}:sample_rate=44100`;
  execFileSync('ffmpeg', `-hide_banner -loglevel error -y -f lavfi -i ${src} -ac 1 ${out}`.split(' '));
  return out;
};
const length = (path: string) => {
  const args = `-v error -show_entries format=duration -of csv=p=0 ${path}`.split(' ');
  return Number(execFileSync('ffprobe', args, { encoding: 'utf8' }));
};
const run = (cmd: string, args: string[], env: Record<string, string> = {}) =>
  spawnSync(cmd, args, { encoding: 'utf8', env: { ...process.env, ...env } });

describe.skipIf(!hasFfmpeg)('music under a voice that runs past --total', () => {
  let voice: string;
  let music: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'duck-'));
    voice = tone('voice.wav', 300, 6); // with --voice-start 4 it speaks until 10 s
    music = tone('music.wav', 220, 5);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('duck_mix.py refuses to cut the voice, and --allow-overrun grows the total', () => {
    const out = join(dir, 'out.wav');
    const refused = run(python, ['-I', script, voice, music, out, '--total', '8']);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toMatch(/\d+\.\d\d s over.*--total of at least/);
    expect(existsSync(out)).toBe(false);
    const grown = run(python, ['-I', script, voice, music, out, '--total', '8', '--allow-overrun']);
    expect(grown.status, grown.stderr).toBe(0);
    expect(length(out)).toBeGreaterThan(10);
  });

  it('Recipe B in SKILL.md does the same', () => {
    const md = readFileSync(join(root, 'skills/hildegard-sound/SKILL.md'), 'utf8');
    const sh = join(dir, 'recipe-b.sh');
    writeFileSync(sh, md.split('### Recipe B')[1]?.match(/```bash\n([\s\S]*?)```/)?.[1] ?? '');
    const env = (OUT: string, extra = {}) => ({ VOICE: voice, MUSIC: music, TOTAL: '8', OUT, ...extra });
    const refused = run('bash', [sh], env(join(dir, 'b-over.wav')));
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toMatch(/\d+\.\d\d s over/);
    const grown = run('bash', [sh], env(join(dir, 'b-grown.wav'), { ALLOW_OVERRUN: '1' }));
    expect(grown.status, grown.stderr).toBe(0);
    expect(length(join(dir, 'b-grown.wav'))).toBeGreaterThan(10);
  });
});

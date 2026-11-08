// SPDX-License-Identifier: AGPL-3.0-only
// The hildegard-motion skill: skills/hildegard-motion/scripts/motion.py draws video from a spec. These tests run the real
// script: every template checks clean and renders an MP4 of the right size, rate and length; --check catches what weak
// models get wrong; a render is repeatable frame for frame.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const python = process.env.HILDEGARD_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const root = resolve(import.meta.dirname, '../../..');
const skill = join(root, 'skills/hildegard-motion');
const script = join(skill, 'scripts/motion.py');
const templates = readdirSync(join(skill, 'templates'))
  .filter((f) => f.endsWith('.json'))
  .sort();
const dir = mkdtempSync(join(tmpdir(), 'motion-'));
// Fonts download once per machine and are then read from the cache, so the cache outlives the test run.
const env = { ...process.env, HILDEGARD_MOTION_FONTS: join(tmpdir(), 'hildegard-motion-test-fonts') };
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const tryRun = (cmd: string, args: string[]) => spawnSync(cmd, args, { encoding: 'utf8' });
const hasLibs = tryRun(python, ['-c', 'import numpy, PIL']).status === 0;
const hasFfmpeg = tryRun('ffmpeg', ['-version']).status === 0;
const hasFfprobe = tryRun('ffprobe', ['-version']).status === 0;
const hasAv = tryRun(python, ['-c', 'import av']).status === 0;
const canRender = hasLibs && (hasFfmpeg || hasAv);

function motion(args: string[], extraEnv: Record<string, string> = {}) {
  const r = spawnSync(python, [script, ...args], {
    encoding: 'utf8',
    env: { ...env, ...extraEnv },
    maxBuffer: 1 << 26,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

interface Probe {
  width: number;
  height: number;
  fps: number;
  frames: number;
  duration: number;
  audio: boolean;
}

function probe(file: string): Probe {
  if (hasFfprobe) {
    const r = tryRun('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'stream=codec_type,width,height,avg_frame_rate,nb_frames,duration',
      '-of',
      'json',
      file,
    ]);
    const streams = JSON.parse(r.stdout).streams as Array<Record<string, string>>;
    const v = streams.find((s) => s.codec_type === 'video')!;
    const [n, d] = v.avg_frame_rate!.split('/').map(Number);
    return {
      width: Number(v.width),
      height: Number(v.height),
      fps: n! / d!,
      frames: Number(v.nb_frames),
      duration: Number(v.duration),
      audio: streams.some((s) => s.codec_type === 'audio'),
    };
  }
  const code = [
    'import av, json, sys',
    'c = av.open(sys.argv[1]); s = c.streams.video[0]',
    'print(json.dumps({"width": s.codec_context.width, "height": s.codec_context.height, "fps": float(s.average_rate),',
    '"frames": s.frames, "duration": float(c.duration) / 1e6, "audio": len(c.streams.audio) > 0}))',
  ].join('\n');
  return JSON.parse(tryRun(python, ['-c', code, file]).stdout);
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** A one-scene 1280x720 spec with the given layers, for the --check cases. */
function write(
  name: string,
  layers: unknown[],
  more: Record<string, unknown> = {},
  scene: Record<string, unknown> = {},
) {
  const spec = {
    canvas: { width: 1280, height: 720, fps: 30, background: '#0b1020' },
    scenes: [{ duration: 4, layers, ...scene }],
    ...more,
  };
  const file = join(dir, `${name}.json`);
  writeFileSync(file, JSON.stringify(spec));
  return file;
}

const text = (t: string, more: Record<string, unknown> = {}) => ({
  type: 'text',
  text: t,
  size: 6,
  x: 0.5,
  y: 0.5,
  ...more,
});

describe.skipIf(!hasLibs)('hildegard-motion: --check catches what weak models get wrong', () => {
  it('passes a plain spec', () => {
    const r = motion(['--check', write('ok', [text('Hello there', { enter: { type: 'fade' } })])]);
    expect(r.out).toContain('result: clean');
    expect(r.status).toBe(0);
  });

  it('refuses a text box that cannot hold its longest word', () => {
    const r = motion([
      '--check',
      write('box', [text('Supercalifragilisticexpialidocious', { size: 8, box: 0.2 })]),
    ]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/wider than its box/);
  });

  it('refuses text that runs off the frame, and says to wrap it', () => {
    const r = motion([
      '--check',
      write('off', [text('This headline is much too long to fit on one line of the frame', { size: 9 })]),
    ]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/runs off the edge of the frame/);
    expect(r.out).toMatch(/"box"/);
  });

  it('refuses text inside the 5% safe margin', () => {
    const r = motion([
      '--check',
      write('margin', [text('Edge', { x: 0.02, anchor: 'left', align: 'left' })]),
    ]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/safe margin/);
  });

  it('refuses text on screen too briefly to read', () => {
    const r = motion([
      '--check',
      write('brief', [text('one two three four five six seven eight', { end: 1.5, size: 4 })]),
    ]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/fully on screen for 1\.5 s but 8 words need 2\.0 s/);
  });

  it('refuses text whose contrast is under 4.5:1', () => {
    const r = motion([
      '--check',
      write('contrast', [text('Faint words', { size: 4, color: '#cccccc' })], {}, { background: '#ffffff' }),
    ]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/contrast 1\.\d:1/);
    expect(r.out).toMatch(/needs 4\.5:1/);
  });

  it('treats an empty backing as on, so the documented contrast fix works', () => {
    const faint = { size: 4, color: '#cccccc' };
    const bad = motion([
      '--check',
      write('backing-off', [text('Faint words', faint)], {}, { background: '#ffffff' }),
    ]);
    expect(bad.out).toMatch(/contrast 1\.\d:1/);
    expect(bad.out).toContain('"backing": {"color": "#00000099"}');
    const fixed = motion([
      '--check',
      write('backing-empty', [text('Faint words', { ...faint, backing: {} })], {}, { background: '#ffffff' }),
    ]);
    expect(fixed.out).toContain('result: clean');
    expect(fixed.status).toBe(0);
  });

  it('measures contrast for the color a layer animates to, not only its base color', () => {
    const r = motion([
      '--check',
      write('color-anim', [
        text('Fades to dark', {
          color: '#ffffff',
          animate: [{ prop: 'color', to: '#1a1a1a', at: 0.5, duration: 0.5 }],
        }),
      ]),
    ]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/contrast \d\.\d:1/);
    expect(r.out).toContain('text #1a1a1a');
  });

  it('refuses enter and exit fields the preset does not read', () => {
    const shape = { type: 'shape', shape: 'rect', x: 0.5, y: 0.5, w: 0.3, h: 0.2, fill: '#ff0000' };
    const cases: Array<[string, unknown, RegExp]> = [
      ['split on a shape', { ...shape, enter: { type: 'fade', split: 'word', stagger: 0.2 } }, /"split"/],
      ['stagger on a shape', { ...shape, enter: { type: 'fade', stagger: 0.2 } }, /"stagger"/],
      ['distance on a fade', text('Hello there', { enter: { type: 'fade', distance: 0.2 } }), /"distance"/],
      [
        'direction on a fade exit',
        text('Hello there', { exit: { type: 'fade', direction: 'left' } }),
        /"direction"/,
      ],
      ['split on a wipe', text('Hello there', { enter: { type: 'wipe', split: 'word' } }), /"split"/],
      ['stagger without split', text('Hello there', { enter: { type: 'fade', stagger: 0.2 } }), /"stagger"/],
      [
        'direction on a circle grow',
        { ...shape, shape: 'circle', enter: { type: 'grow', direction: 'up' } },
        /"direction"/,
      ],
      [
        'two different directions',
        text('Hello there', {
          enter: { type: 'wipe', direction: 'left' },
          exit: { type: 'wipe', direction: 'up' },
        }),
        /different directions/,
      ],
    ];
    for (const [name, layer, expected] of cases) {
      const r = motion(['--check', write(`unused-${name.replace(/\W+/g, '-')}`, [layer])]);
      expect(r.status, name).toBe(1);
      expect(r.out, name).toMatch(expected);
    }
    // the same fields on a preset that reads them stay clean
    const ok = motion([
      '--check',
      write('unused-ok', [
        text('Hello there', { enter: { type: 'rise', split: 'word', stagger: 0.1, distance: 0.1 } }),
      ]),
    ]);
    expect(ok.out).toContain('result: clean');
  }, 60_000);

  it('warns when a camera keeps moving through the last second', () => {
    const photo = { type: 'image', file: 'sample:dusk' };
    const spec = (camera: unknown) =>
      writeSpec(`last-camera-${camera ? 'on' : 'off'}`, {
        scenes: [{ duration: 4, layers: [photo], ...(camera ? { camera } : {}) }],
      });
    const moving = motion(['--check', spec({ preset: 'push-in' })]);
    expect(moving.status).toBe(0);
    expect(moving.out).toMatch(/warning ending: the camera on the last scene moves until the video ends/);
    expect(motion(['--check', spec(undefined)]).out).toContain('result: clean');
  });

  it('measures contrast on the pixels behind the text, not on the background color alone', () => {
    // dark text over a dark shape that sits on a light page: fails; a light backing on the text fixes it
    const dark = { type: 'shape', shape: 'rect', x: 0.5, y: 0.5, w: 0.8, h: 0.4, fill: '#222222' };
    const bad = motion([
      '--check',
      write('behind-bad', [dark, text('Hidden', { color: '#333333' })], {}, { background: '#ffffff' }),
    ]);
    expect(bad.out).toMatch(/contrast/);
    const good = motion([
      '--check',
      write('behind-good', [dark, text('Seen', { color: '#ffffff' })], {}, { background: '#ffffff' }),
    ]);
    expect(good.out).toContain('result: clean');
  });

  it('refuses a layer that is off the frame entirely, an animation longer than its scene, and a text overlapping text', () => {
    const r1 = motion([
      '--check',
      write('gone', [{ type: 'shape', shape: 'rect', x: 3, y: 0.5, w: 0.2, h: 0.2, fill: '#ff0000' }]),
    ]);
    expect(r1.out).toMatch(/completely outside the frame/);
    const r2 = motion(['--check', write('slow', [text('Late', { enter: { type: 'fade', delay: 5 } })])]);
    expect(r2.out).toMatch(/never finishes/);
    const r3 = motion([
      '--check',
      write('overlap', [text('First line', { y: 0.5 }), text('Second line', { y: 0.52 })]),
    ]);
    expect(r3.out).toMatch(/overlaps/);
  });

  it('refuses a layer drawn over text', () => {
    const r = motion([
      '--check',
      write('covered', [
        text('Under'),
        { type: 'shape', shape: 'rect', x: 0.5, y: 0.5, w: 0.5, h: 0.3, fill: '#ff0000' },
      ]),
    ]);
    expect(r.out).toMatch(/is covered by/);
  });

  it('names unknown fields, with a suggestion, and wrong values', () => {
    const r = motion(['--check', write('unknown', [text('Hi', { colour: '#ffffff', size: 'big' })])]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/unknown field "colour" \(did you mean "color"\?\)/);
    expect(r.out).toMatch(/\.size: must be a number/);
  });

  it('reports a missing font, a missing image and a duration that does not match', () => {
    const r = motion([
      '--check',
      write('missing', [text('Hi', { font: 'mine' }), { type: 'image', file: 'nope.jpg' }], {
        fonts: { mine: { path: 'missing.ttf' } },
        duration: 99,
      }),
    ]);
    expect(r.out).toMatch(/font "mine": is missing/);
    expect(r.out).toMatch(/image file "nope\.jpg" does not exist/);
    expect(r.out).toMatch(/duration: says 99 s but the scenes add up to 4 s/);
  });

  it('says a font is missing when it is not cached and the network is off', () => {
    const r = motion(['--check', write('offline', [text('Hi')])], {
      HILDEGARD_MOTION_OFFLINE: '1',
      HILDEGARD_MOTION_FONTS: join(dir, 'empty-cache'),
    });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/font "Inter": is missing/);
  });

  it('refuses to render a failing spec unless forced', () => {
    const spec = write('refuse', [text('Supercalifragilisticexpialidocious', { size: 8, box: 0.2 })]);
    const out = join(dir, 'refuse.mp4');
    const r = motion([spec, out, '--scale', '0.25', '--fps', '5', '--quiet']);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/Not rendering/);
    expect(existsSync(out)).toBe(false);
    if (canRender) {
      const f = motion([spec, out, '--scale', '0.25', '--fps', '5', '--quiet', '--force']);
      expect(f.status).toBe(0);
      expect(existsSync(out)).toBe(true);
    }
  });

  it('keeps the schema, the font pins and the docs in step', () => {
    const schema = JSON.parse(readFileSync(join(skill, 'references/spec.schema.json'), 'utf8'));
    expect(schema.required).toEqual(['canvas', 'scenes']);
    const pins = JSON.parse(motion(['--fonts', 'json']).out) as Array<{
      family: string;
      license: string;
      url: string;
      sha256: string;
      commit: string;
    }>;
    expect(pins.length).toBeGreaterThanOrEqual(10);
    for (const p of pins) {
      expect(p.license).toBe('OFL-1.1');
      expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(p.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(p.url).toMatch(
        new RegExp(`^https://raw\\.githubusercontent\\.com/google/fonts/${p.commit}/ofl/`),
      );
    }
    const spec = readFileSync(join(skill, 'references/spec.md'), 'utf8');
    for (const name of ['sample:dusk', 'easeOutCubic', 'slide-from-left', 'letter_spacing', 'bars'])
      expect(spec).toContain(name);
  });
});

/** Writes a whole spec (several scenes, a camera, captions) for the cases `write` cannot shape. */
function writeSpec(name: string, spec: Record<string, unknown>) {
  const file = join(dir, `${name}.json`);
  writeFileSync(
    file,
    JSON.stringify({ canvas: { width: 1280, height: 720, fps: 30, background: '#0b1020' }, ...spec }),
  );
  return file;
}

/** Runs packages/craft/test/motion_probe.py, which draws frames with the real script and prints JSON. */
function runProbe(kind: string) {
  const r = spawnSync(python, [join(import.meta.dirname, 'motion_probe.py'), skill, kind], {
    encoding: 'utf8',
    env,
    maxBuffer: 1 << 26,
  });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout);
}

describe.skipIf(!hasLibs)('hildegard-motion: --check names every field a preset ignores', () => {
  it('draws or refuses each field inside enter and exit, on every layer type', () => {
    const r = runProbe('nested');
    expect(r.unexplained).toEqual([]);
    expect(r.refused).toBeGreaterThan(100);
  }, 300_000);
});

describe.skipIf(!hasLibs)('hildegard-motion: a wipe covers the backing and the shadow', () => {
  it('leaves nothing of the padding visible at reveal 0, entering or leaving, in every direction', () => {
    const worst = runProbe('wipepad') as Record<string, number>;
    expect(Object.keys(worst)).toHaveLength(16);
    for (const [k, v] of Object.entries(worst)) expect(v, k).toBeLessThanOrEqual(1);
  });
});

describe.skipIf(!hasLibs)('hildegard-motion: an option present as {} is on, never dropped as falsy', () => {
  it('draws an empty backing, outline, shadow and stroke', () => {
    expect(runProbe('empty')).toEqual([]);
  });
});

describe.skipIf(!hasLibs || process.platform === 'win32')(
  'hildegard-motion: the prerequisite line in SKILL.md',
  () => {
    const line = readFileSync(join(skill, 'SKILL.md'), 'utf8')
      .split('\n')
      .find((l) => l.startsWith('python3 -c "import numpy, PIL'))!;
    /** Runs the line with a PATH that holds only python3 (which refuses `import av` when noAv) and, if asked, an ffmpeg. */
    function prereq(opts: { ffmpeg: boolean; noAv: boolean }) {
      const bin = mkdtempSync(join(dir, 'bin-'));
      const real = tryRun('sh', ['-c', 'command -v ' + python]).stdout.trim();
      writeFileSync(
        join(bin, 'python3'),
        `#!/bin/sh\n${opts.noAv ? 'case "$*" in *"import av"*) exit 1;; esac\n' : ''}exec "${real}" "$@"\n`,
        { mode: 0o755 },
      );
      symlinkSync(tryRun('sh', ['-c', 'command -v head']).stdout.trim(), join(bin, 'head'));
      if (opts.ffmpeg) writeFileSync(join(bin, 'ffmpeg'), '#!/bin/sh\necho ffmpeg stub\n', { mode: 0o755 });
      return spawnSync('/bin/sh', ['-c', line], { encoding: 'utf8', env: { ...env, PATH: bin } });
    }

    it('is found', () => expect(line).toBeTruthy());
    it('fails with neither ffmpeg nor PyAV', () =>
      expect(prereq({ ffmpeg: false, noAv: true }).status).not.toBe(0));
    it('passes with ffmpeg alone', () => expect(prereq({ ffmpeg: true, noAv: true }).status).toBe(0));
  },
);

describe.skipIf(!hasLibs)(
  'hildegard-motion: a name that is not in the list is a problem, never a traceback',
  () => {
    const fade = { type: 'fade' };
    const two = (second: Record<string, unknown>) => ({
      scenes: [
        { duration: 4, layers: [text('First scene')] },
        { duration: 4, layers: [text('Second scene')], ...second },
      ],
    });
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      [
        'an enter ease "easeOut"',
        { scenes: [{ duration: 4, layers: [text('Hi there', { enter: { ...fade, ease: 'easeOut' } })] }] },
        /enter\.ease: must be one of: .*did you mean "easeOut\w+"/,
      ],
      [
        'an enter ease "ease-out"',
        { scenes: [{ duration: 4, layers: [text('Hi there', { enter: { ...fade, ease: 'ease-out' } })] }] },
        /enter\.ease: .*did you mean "easeOut\w+"/,
      ],
      [
        'an exit ease "easeIn"',
        { scenes: [{ duration: 4, layers: [text('Hi there', { exit: { ...fade, ease: 'easeIn' } })] }] },
        /exit\.ease: .*did you mean "easeIn\w+"/,
      ],
      [
        'an animate ease',
        {
          scenes: [
            {
              duration: 4,
              layers: [text('Hi there', { animate: [{ prop: 'y', to: 0.4, ease: 'easeOut' }] })],
            },
          ],
        },
        /animate\[0\]\.ease: .*did you mean "easeOut\w+"/,
      ],
      [
        'a count ease',
        { scenes: [{ duration: 4, layers: [text('{n} riders', { count: { to: 5, ease: 'easeOut' } })] }] },
        /count\.ease: .*did you mean "easeOut\w+"/,
      ],
      [
        'a bars grow ease',
        {
          scenes: [
            {
              duration: 4,
              layers: [{ type: 'bars', data: [{ label: 'A', value: 2 }], grow: { ease: 'easeOut' } }],
            },
          ],
        },
        /grow\.ease: .*did you mean "easeOut\w+"/,
      ],
      [
        'a camera ease "ease-out"',
        {
          scenes: [
            { duration: 4, camera: { preset: 'push-in', ease: 'ease-out' }, layers: [text('Hi there')] },
          ],
        },
        /camera\.ease: .*did you mean "easeOut\w+"/,
      ],
      [
        'a camera preset "pushin"',
        { scenes: [{ duration: 4, camera: { preset: 'pushin' }, layers: [text('Hi there')] }] },
        /camera\.preset: .*did you mean "push-in"/,
      ],
      [
        'a transition "cross-fade"',
        two({ transition: { type: 'cross-fade' } }),
        /transition\.type: .*did you mean "crossfade"/,
      ],
      [
        'an enter type "fadein"',
        { scenes: [{ duration: 4, layers: [text('Hi there', { enter: { type: 'fadein' } })] }] },
        /enter\.type: .*did you mean "fade"/,
      ],
      [
        'an exit type "fadeout"',
        { scenes: [{ duration: 4, layers: [text('Hi there', { exit: { type: 'fadeout' } })] }] },
        /exit\.type: .*did you mean "fade"/,
      ],
      [
        'an enter that names a split "words"',
        { scenes: [{ duration: 4, layers: [text('Hi there', { enter: { ...fade, split: 'words' } })] }] },
        /split: .*did you mean "word"/,
      ],
      [
        'a reveal style "typewriter"',
        { scenes: [{ duration: 4, layers: [text('Hi there', { reveal_style: 'typewriter' })] }] },
        /reveal_style: .*did you mean "type"/,
      ],
    ];
    it.each(cases)('says what to write for %s', (name, spec, expected) => {
      const file = writeSpec(`name-${name.replace(/\W+/g, '-')}`, spec);
      const r = motion(['--check', file]);
      expect(r.out).not.toMatch(/Traceback|KeyError/);
      expect(r.status).toBe(1);
      expect(r.out).toMatch(expected);
      const j = motion(['--check', '--json', file]);
      expect(() => JSON.parse(j.out), j.out).not.toThrow();
      expect(JSON.parse(j.out).ok).toBe(false);
    });

    it('still reports the other problems in the same spec', () => {
      const file = write('name-and-more', [
        text('This headline is much too long to fit on one line of the frame', {
          size: 9,
          enter: { type: 'fade', ease: 'easeOut' },
        }),
      ]);
      const r = motion(['--check', file]);
      expect(r.out).not.toMatch(/Traceback/);
      expect(r.out).toMatch(/did you mean "easeOut\w+"/);
      expect(r.out).toMatch(/runs off the edge of the frame/);
    });

    it.skipIf(!canRender)(
      'does not crash a --force draft that names an easing wrongly',
      () => {
        const file = write('name-force', [text('Hi there', { enter: { type: 'fade', ease: 'easeOut' } })]);
        const out = join(dir, 'name-force.mp4');
        const r = motion([file, out, '--scale', '0.25', '--fps', '5', '--quiet', '--force']);
        expect(r.out).not.toMatch(/Traceback/);
        expect(r.status).toBe(0);
        expect(existsSync(out)).toBe(true);
      },
      120_000,
    );
  },
);

describe.skipIf(!hasLibs)(
  'hildegard-motion: a layer type does what its fields say or --check says it does not',
  () => {
    const bars = (more: Record<string, unknown> = {}) => ({
      type: 'bars',
      x: 0.5,
      y: 0.5,
      w: 0.6,
      h: 0.5,
      data: [{ label: 'A', value: 3 }],
      ...more,
    });

    it('draws or refuses every field the schema lets each layer type take', () => {
      const r = runProbe('fields');
      expect(r.unexplained).toEqual([]);
      expect(r.refused_ok).toContain('bars.enter');
    }, 240_000);

    it.each([
      ['enter', { enter: { type: 'fade' } }, /bars/],
      ['animate', { animate: [{ prop: 'x', to: 0.6 }] }, /bars/],
      ['opacity', { opacity: 0.5 }, /bars/],
      ['scale', { scale: 1.2 }, /bars/],
    ])('says a chart does not use "%s"', (field, more, expected) => {
      const r = motion(['--check', write(`bars-${field}`, [bars(more)])]);
      expect(r.status).toBe(1);
      expect(r.out).toMatch(new RegExp(`"${field}"`));
      expect(r.out).toMatch(expected);
      expect(r.out).toMatch(/does nothing on a bars chart/);
    });

    it('keeps "id", "safe" and "camera" on a chart, because they reach its parts', () => {
      const edge = motion(['--check', write('bars-edge', [bars({ id: 'sales', x: 0.97, w: 0.1 })])]);
      expect(edge.out).toMatch(/"sales"/);
      expect(edge.out).toMatch(/safe margin/);
      const ok = motion([
        '--check',
        write('bars-edge-ok', [bars({ id: 'sales', x: 0.97, w: 0.1, safe: false })]),
      ]);
      expect(ok.out).not.toMatch(/safe margin/);
    });

    it.each([
      [
        'a rect with points',
        {
          type: 'shape',
          shape: 'rect',
          w: 0.2,
          h: 0.2,
          points: [
            [0, 0],
            [1, 0],
            [1, 1],
          ],
        },
        '"points"',
      ],
      ['a circle with h', { type: 'shape', shape: 'circle', w: 0.2, h: 0.2 }, '"h"'],
      ['a rect with radius', { type: 'shape', shape: 'rect', w: 0.2, h: 0.2, radius: 2 }, '"radius"'],
      [
        'a line with fill',
        { type: 'shape', shape: 'line', from: [0.2, 0.5], to: [0.8, 0.5], fill: '#ff0000' },
        '"fill"',
      ],
      [
        'a shape with reveal_style',
        { type: 'shape', shape: 'rect', w: 0.2, h: 0.2, reveal_style: 'wipe' },
        '"reveal_style"',
      ],
      [
        'an image with reveal_style',
        { type: 'image', file: 'sample:dusk', reveal_style: 'wipe' },
        '"reveal_style"',
      ],
    ])('refuses %s, which would be ignored', (_name, layer, field) => {
      const r = motion(['--check', write(`ignored-${_name.replace(/\W+/g, '-')}`, [layer])]);
      expect(r.status).toBe(1);
      expect(r.out).toContain(field);
    });
  },
);

describe.skipIf(!hasLibs)('hildegard-motion: the check measures what the layer settles at', () => {
  it('counts a see-through line as readable, and still fails one that is too faint', () => {
    const ok = motion(['--check', write('soft', [text('Soft words', { opacity: 0.8 })])]);
    expect(ok.out).toContain('result: clean');
    expect(ok.status).toBe(0);
    const faint = motion(['--check', write('faint', [text('Faint words', { opacity: 0.15 })])]);
    expect(faint.status).toBe(1);
    expect(faint.out).toMatch(/contrast \d\.\d:1/);
    expect(faint.out).not.toMatch(/fully on screen for 0\.0 s/);
  });

  it('counts text that animates to 0.8 opacity, and text that is only part revealed on purpose', () => {
    const anim = motion([
      '--check',
      write('anim-soft', [
        text('Soft words', { animate: [{ prop: 'opacity', from: 0, to: 0.8, at: 0, duration: 0.5 }] }),
      ]),
    ]);
    expect(anim.out).toContain('result: clean');
    const part = motion(['--check', write('part', [text('Half there', { reveal: 0.6 })])]);
    expect(part.out).not.toMatch(/fully on screen for 0\.0 s/);
  });

  it('still waits for a fade-in to finish, and for the fade-out not to have started', () => {
    const r = motion([
      '--check',
      write('fade-short', [
        text('one two three four five six', { size: 4, end: 2.2, enter: { type: 'fade', duration: 1.0 } }),
      ]),
    ]);
    expect(r.out).toMatch(/fully on screen for 1\.\d s but 6 words need 1\.5 s/);
  });

  it('counts a split by line from the lines the box really makes', () => {
    const r = runProbe('units');
    expect(r.lines).toBeGreaterThan(5); // more than the old guess of newlines + 3
    expect(r.anim_end).toBeCloseTo(r.expected, 6);
  });

  it('does not say a two-line quote never finishes when it does', () => {
    const layer = text('First line\nSecond line', {
      size: 6,
      box: 0.8,
      enter: { type: 'rise', duration: 1.0, delay: 0.8, split: 'line', stagger: 0.7 },
    });
    const r = motion(['--check', write('quote', [layer], {}, { duration: 4.5 })]);
    expect(r.out).not.toMatch(/never finishes/);
    expect(r.out).toContain('result: clean');
  });
});

describe.skipIf(!hasLibs)('hildegard-motion: the exits spec.md lists', () => {
  it.skipIf(!canRender)(
    'moves every layer type for every exit',
    () => {
      expect(runProbe('exits')).toEqual([]);
    },
    240_000,
  );

  it.skipIf(!canRender)(
    'wipes text out with an edge, the way a wipe enter wipes it in',
    () => {
      const r = runProbe('wipe');
      expect(r.errors).toEqual([]);
      expect(r.reveal).toBeGreaterThan(0.05);
      expect(r.reveal).toBeLessThan(0.95);
      expect(r.wipe).toBe(true);
      expect(r.type).toBe(false);
    },
    120_000,
  );
});

describe('hildegard-motion: the install line', () => {
  const lines = (file: string) =>
    [...readFileSync(file, 'utf8').matchAll(/python3 -m pip install ((?:"[^"]+"|[^`'")\n])+)/g)].map((m) =>
      m[1]!.trim(),
    );
  const reqs = (line: string) => [...line.matchAll(/"([^"]+)"|(\S+)/g)].map((m) => m[1] ?? m[2]!);

  it('uses ranges that resolve on Python 3.10 through 3.13, not a pin only newer Pythons have', () => {
    const all = [...lines(join(skill, 'SKILL.md')), ...lines(script)];
    expect(all.length).toBeGreaterThanOrEqual(3);
    const seen = new Map<string, Set<string>>();
    for (const line of all) {
      for (const r of reqs(line)) {
        // numpy 2.5 and PyAV 19 need Python 3.12, so an exact pin of any of them fails on 3.10 and 3.11
        expect(r).not.toMatch(/==/);
        const name = r.split(/[<>=]/)[0]!;
        expect(r).toMatch(/>=/);
        seen.set(name, (seen.get(name) ?? new Set()).add(r));
      }
    }
    expect([...seen.keys()].sort()).toEqual(['av', 'numpy', 'pillow']);
    for (const set of seen.values()) expect(set.size).toBe(1);
  });
});

describe.skipIf(!hasLibs)('hildegard-motion: the templates', () => {
  it('ships the six the skill promises', () => {
    expect(templates).toEqual([
      'data-reveal.json',
      'kinetic.json',
      'promo.json',
      'quote-card.json',
      'slideshow.json',
      'title-card.json',
    ]);
  });

  for (const name of templates) {
    it(`${name} passes --check with no problems and no warnings`, () => {
      const r = motion(['--check', join(skill, 'templates', name)]);
      expect(r.out).toContain('result: clean');
      expect(r.status).toBe(0);
    }, 180_000);

    it.skipIf(!canRender)(
      `${name} renders an MP4 of the right size, rate and length`,
      () => {
        const file = join(skill, 'templates', name);
        const report = JSON.parse(motion(['--check', '--json', file]).out) as {
          ok: boolean;
          duration: number;
        };
        expect(report.ok).toBe(true);
        const out = join(dir, `${name}.mp4`);
        const r = motion([file, out, '--scale', '0.25', '--fps', '10', '--quiet']);
        expect(r.status).toBe(0);
        const spec = JSON.parse(readFileSync(file, 'utf8'));
        const p = probe(out);
        expect(p.width).toBe(even(spec.canvas.width * 0.25));
        expect(p.height).toBe(even(spec.canvas.height * 0.25));
        expect(p.fps).toBeCloseTo(10, 3);
        expect(p.frames).toBe(Math.round(report.duration * 10));
        expect(Math.abs(p.duration - report.duration)).toBeLessThan(0.15);
      },
      240_000,
    );
  }

  it.skipIf(!canRender)(
    'the title card renders at its full 1920x1080',
    () => {
      const out = join(dir, 'title-full.mp4');
      const r = motion([join(skill, 'templates/title-card.json'), out, '--fps', '10', '--quiet']);
      expect(r.status).toBe(0);
      const p = probe(out);
      expect([p.width, p.height]).toEqual([1920, 1080]);
      expect(p.frames).toBe(94);
    },
    240_000,
  );
});

describe.skipIf(!canRender)('hildegard-motion: rendering', () => {
  it('honors the canvas fps and duration exactly', () => {
    const file = write(
      'native',
      [text('Hello', { size: 8, enter: { type: 'fade', duration: 0.4 } })],
      {},
      { duration: 2 },
    );
    const spec = JSON.parse(readFileSync(file, 'utf8'));
    spec.canvas = { width: 320, height: 180, fps: 24, background: '#102030' };
    writeFileSync(file, JSON.stringify(spec));
    const out = join(dir, 'native.mp4');
    expect(motion([file, out, '--quiet']).status).toBe(0);
    const p = probe(out);
    expect([p.width, p.height, p.fps, p.frames]).toEqual([320, 180, 24, 48]);
  }, 120_000);

  it('is deterministic: the same spec gives the same frame hashes, and another spec does not', () => {
    const file = join(skill, 'templates/title-card.json');
    const hashes = (spec: string, tag: string) => {
      const h = join(dir, `${tag}.hashes`);
      expect(
        motion([spec, join(dir, `${tag}.mp4`), '--scale', '0.2', '--fps', '8', '--quiet', '--hashes', h])
          .status,
      ).toBe(0);
      return readFileSync(h, 'utf8');
    };
    const a = hashes(file, 'det-a');
    expect(hashes(file, 'det-b')).toBe(a);
    const changed = JSON.parse(readFileSync(file, 'utf8'));
    changed.scenes[0].layers[1].text = 'Another Title';
    const f2 = join(dir, 'changed.json');
    writeFileSync(f2, JSON.stringify(changed));
    expect(hashes(f2, 'det-c')).not.toBe(a);
  }, 240_000);

  it('draws bar heights in proportion to the numbers in the spec', () => {
    const file = write(
      'bars',
      [
        {
          type: 'bars',
          x: 0.5,
          y: 0.5,
          w: 0.8,
          h: 0.7,
          color: '#ff0000',
          data: [
            { label: 'A', value: 10 },
            { label: 'B', value: 20 },
            { label: 'C', value: 40 },
          ],
          grow: { at: 0, duration: 0.5, stagger: 0.1 },
        },
      ],
      {},
      { duration: 3 },
    );
    const code = [
      'import sys, json',
      `sys.path.insert(0, ${JSON.stringify(join(skill, 'scripts'))})`,
      'import motion',
      'm, p = motion.compile_spec(sys.argv[1])',
      'R = motion.Renderer(m, 1.0)',
      'f = R.to_uint8(R.render_frame(2.5))',
      'red = (f[..., 0] > 200) & (f[..., 1] < 60) & (f[..., 2] < 60)',
      'cols = red.sum(axis=0)',
      'W = f.shape[1]',
      'out = []',
      'for c in (0.2, 0.5, 0.8):',
      '    x = int(W * (0.1 + 0.8 * c))',
      '    out.append(int(cols[x - 4 : x + 5].max()))',
      'print(json.dumps(out))',
    ].join('\n');
    const r = spawnSync(python, ['-c', code, file], { encoding: 'utf8', env });
    expect(r.status, r.stderr).toBe(0);
    const [a, b, c] = JSON.parse(r.stdout) as [number, number, number];
    expect(c).toBeGreaterThan(150);
    expect(Math.abs(b / c - 0.5)).toBeLessThan(0.03);
    expect(Math.abs(a / c - 0.25)).toBeLessThan(0.03);
  }, 120_000);

  it.skipIf(!hasAv)(
    'encodes with PyAV when ffmpeg is not used',
    () => {
      const file = join(skill, 'templates/quote-card.json');
      const out = join(dir, 'av.mp4');
      const r = motion([file, out, '--scale', '0.2', '--fps', '8', '--quiet'], {
        HILDEGARD_MOTION_ENCODER: 'av',
      });
      expect(r.status, r.out).toBe(0);
      const p = probe(out);
      expect([p.width, p.height, p.frames]).toEqual([even(384), even(216), 80]);
    },
    240_000,
  );

  it.skipIf(!hasFfmpeg)(
    'mixes audio under the picture and draws captions from an SRT',
    () => {
      const wav = join(dir, 'tone.wav');
      expect(
        tryRun('ffmpeg', [
          '-v',
          'error',
          '-y',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=220:duration=6',
          '-c:a',
          'pcm_s16le',
          wav,
        ]).status,
      ).toBe(0);
      writeFileSync(
        join(dir, 'c.srt'),
        '1\n00:00:00,500 --> 00:00:02,500\nA first line\n\n2\n00:00:03,000 --> 00:00:05,000\nA second line\n',
      );
      const file = write(
        'audio',
        [text('Sound on', { enter: { type: 'fade' } })],
        { captions: { srt: 'c.srt' }, audio: { file: 'tone.wav', fade_in: 0.5, fade_out: 1 } },
        { duration: 6 },
      );
      const check = motion(['--check', file]);
      expect(check.status, check.out).toBe(0);
      const out = join(dir, 'audio.mp4');
      expect(motion([file, out, '--scale', '0.25', '--fps', '10', '--quiet']).status).toBe(0);
      const p = probe(out);
      expect(p.audio).toBe(true);
      expect(p.frames).toBe(60);
    },
    240_000,
  );
});

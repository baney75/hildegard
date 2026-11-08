// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Go live, what this computer can capture and encode with. FFmpeg lists its own devices on macOS (avfoundation) and
 * Windows (dshow); Linux has them in /sys and PulseAudio (PipeWire answers the same calls). Nothing here opens a
 * camera or microphone: listing a device is not using it.
 */
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import type { StreamDevice, StreamDevices } from '@hildegard/presets';
import { ENCODER_NAMES, type EncoderId, encoderArgs, encoderCandidates, TEST_SOURCE } from './stream-plan.ts';

export type Run = (
  file: string,
  args: string[],
  opts?: { timeout?: number },
) => Promise<{ code: number; out: string; err: string }>;

/** Runs a program to the end, never throwing: the code, and what it wrote. */
export const run: Run = (file, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: opts.timeout ?? 8000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (e, out, err) => {
        const code = e
          ? typeof (e as { code?: unknown }).code === 'number'
            ? (e as { code: number }).code
            : 1
          : 0;
        resolve({ code, out: String(out), err: String(err) });
      },
    );
  });

const TEST: StreamDevice = { id: TEST_SOURCE, label: 'Test pattern' };

/** Parses `ffmpeg -f avfoundation -list_devices true -i ""` (macOS). */
export function parseAvfoundation(text: string): { video: StreamDevice[]; audio: StreamDevice[] } {
  const video: StreamDevice[] = [];
  const audio: StreamDevice[] = [];
  let into: StreamDevice[] | null = null;
  for (const line of text.split('\n')) {
    if (/AVFoundation video devices/i.test(line)) into = video;
    else if (/AVFoundation audio devices/i.test(line)) into = audio;
    else {
      const m = /\[(\d+)\]\s+(.+?)\s*$/.exec(line);
      if (m && into) into.push({ id: `avf:${m[1]}`, label: m[2]! });
    }
  }
  return { video, audio };
}

/** Parses `ffmpeg -list_devices true -f dshow -i dummy` (Windows), in both its layouts. */
export function parseDshow(text: string): { video: StreamDevice[]; audio: StreamDevice[] } {
  const video: StreamDevice[] = [];
  const audio: StreamDevice[] = [];
  let into: StreamDevice[] | null = null;
  for (const line of text.split('\n')) {
    const typed = /"([^"]+)"\s+\((video|audio)\)/.exec(line);
    if (typed) {
      (typed[2] === 'video' ? video : audio).push({ id: `dshow:${typed[1]}`, label: typed[1]! });
      continue;
    }
    if (/DirectShow video devices/i.test(line)) into = video;
    else if (/DirectShow audio devices/i.test(line)) into = audio;
    else {
      const m = /"([^"]+)"\s*$/.exec(line);
      if (m && into && !/Alternative name/i.test(line)) into.push({ id: `dshow:${m[1]}`, label: m[1]! });
    }
  }
  return { video, audio };
}

/** `pactl list short sources`: the microphones (not what plays out of the speakers). */
export function parsePactl(text: string): StreamDevice[] {
  const out: StreamDevice[] = [];
  for (const line of text.split('\n')) {
    const [, name] = line.split('\t');
    if (name && !name.endsWith('.monitor'))
      out.push({ id: name, label: name.replace(/^alsa_input\./, '').replace(/[._]/g, ' ') });
  }
  return out;
}

export interface DevicesDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  ffmpeg: string;
  run?: Run;
  /** Where /sys/class/video4linux is; tests give a fake. */
  sys?: string;
}

export async function listDevices(d: DevicesDeps): Promise<StreamDevices> {
  const platform = d.platform ?? process.platform;
  const env = d.env ?? process.env;
  const go = d.run ?? run;
  const notes: string[] = [];
  const screens: StreamDevice[] = [];
  const cameras: StreamDevice[] = [];
  const mics: StreamDevice[] = [];
  if (platform === 'linux') {
    const sys = d.sys ?? '/sys/class/video4linux';
    try {
      for (const v of readdirSync(sys)
        .filter((n) => /^video\d+$/.test(n))
        .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))) {
        const index = readFileSync(`${sys}/${v}/index`, 'utf8').trim();
        if (index !== '0' || !existsSync(`/dev/${v}`)) continue;
        const name = readFileSync(`${sys}/${v}/name`, 'utf8').trim();
        cameras.push({ id: `/dev/${v}`, label: name || v });
      }
    } catch {}
    const pa = await go('pactl', ['list', 'short', 'sources']);
    const found = pa.code === 0 ? parsePactl(pa.out) : [];
    mics.push({ id: 'default', label: 'Default microphone' }, ...found);
    if (env.DISPLAY) screens.push({ id: 'x11', label: 'Whole screen' });
    if (env.WAYLAND_DISPLAY) {
      notes.push(
        env.DISPLAY
          ? 'This is a Wayland session. Screen capture here sees only windows of apps running through X11. For a whole-screen capture, sign in with an X11 session, or stream from OBS with “Use OBS”.'
          : 'This is a Wayland session with no X11 display, so Hildegard can’t capture the screen itself. Sign in with an X11 session, or stream from OBS with “Use OBS”.',
      );
    }
    if (!cameras.length)
      notes.push('No camera found. If one is plugged in, check that your user is in the “video” group.');
  } else if (platform === 'darwin') {
    const r = await go(d.ffmpeg, ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''], {
      timeout: 8000,
    });
    const { video, audio } = parseAvfoundation(r.err);
    for (const v of video) (/^Capture screen/i.test(v.label) ? screens : cameras).push(v);
    mics.push(...audio);
    notes.push(
      'macOS asks once for Camera, Microphone and Screen Recording. If you said no, turn Hildegard on in System Settings, Privacy & Security, then quit and reopen it.',
    );
  } else if (platform === 'win32') {
    const r = await go(d.ffmpeg, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], {
      timeout: 8000,
    });
    const { video, audio } = parseDshow(r.err);
    cameras.push(...video);
    mics.push(...audio);
    screens.push({ id: 'desktop', label: 'Whole desktop' });
    notes.push(
      'If the camera or microphone is missing, check Settings, Privacy & security, and let desktop apps use them.',
    );
  }
  return {
    platform,
    screens: [...screens, TEST],
    cameras: [...cameras, TEST],
    mics: [...mics, TEST],
    notes,
  };
}

// ── Encoders ───────────────────────────────────────────────────────────────────────────────────────────────────

/** The encoders this computer's FFmpeg has built in. */
export async function builtInEncoders(ffmpeg: string, go: Run = run): Promise<Set<string>> {
  const r = await go(ffmpeg, ['-hide_banner', '-encoders']);
  const have = new Set<string>();
  for (const line of r.out.split('\n')) {
    const m = /^\s*V\S*\s+(\S+)/.exec(line);
    if (m) have.add(m[1]!);
  }
  return have;
}

/**
 * The encoders that work here, best first, always ending with software. A hardware encoder counts only if it encodes a
 * few frames, since FFmpeg builds list NVENC on computers with no NVIDIA card.
 */
export async function workingEncoders(
  ffmpeg: string,
  platform: NodeJS.Platform = process.platform,
  go: Run = run,
): Promise<EncoderId[]> {
  const have = await builtInEncoders(ffmpeg, go);
  const out: EncoderId[] = [];
  for (const id of encoderCandidates(platform)) {
    if (id === 'libx264') continue;
    if (!have.has(id)) continue;
    const e = encoderArgs(id, 2000, 30);
    const r = await go(
      ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        ...e.init,
        '-f',
        'lavfi',
        '-i',
        'color=c=black:s=640x360:r=30',
        '-frames:v',
        '8',
        '-vf',
        e.filter ?? 'format=yuv420p',
        ...e.codec,
        '-f',
        'null',
        '-',
      ],
      { timeout: 10_000 },
    );
    if (r.code === 0) out.push(id);
  }
  out.push('libx264');
  return out;
}

export const encoderName = (id: string) => ENCODER_NAMES[id as EncoderId] ?? id;

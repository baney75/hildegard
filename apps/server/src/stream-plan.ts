// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Go live, the plan: the FFmpeg command for a stream, built from the person's settings. Pure: it reads nothing from
 * the computer and holds no secrets. The ingest URLs it is given are the local relay's (stream-relay.ts), whose paths
 * carry a stand-in for the stream key, so nothing here can leak one.
 *
 * One FFmpeg process captures the sources, composes every scene in one filter graph (switching between them live with
 * `streamselect`, which takes commands on FFmpeg's stdin), encodes once, and writes the same encoded stream to every
 * destination and, when asked, to a local recording through the tee muxer. A small preview of the composed picture
 * comes out on stdout.
 */
import {
  STREAM_DESTINATIONS,
  STREAM_QUALITY,
  type StreamQuality,
  type StreamScene,
  type StreamSettings,
} from '@hildegard/presets';

export type SourceKind = 'screen' | 'camera' | 'mic';

/**
 * A device name or id that is safe to hand to FFmpeg: printable, no leading dash, no shell or filter syntax. Names as
 * Windows gives them pass: "Microphone Array (Intel® Smart Sound Technology)", "Ana’s iPhone Camera", "A & B [2]".
 * It is one argument of its own (no shell), so these characters are only text.
 */
export const DEVICE_RE = /^[\p{L}\p{M}\p{N}\p{So} ._:/@+()#,&'’![\]-]{1,200}$/u;
export const isDevice = (s: string) => DEVICE_RE.test(s) && !s.startsWith('-');

/** The built-in test source id: a pattern and a tone. */
export const TEST_SOURCE = 'test';

export interface InputContext {
  platform: NodeJS.Platform;
  width: number;
  height: number;
  fps: number;
  env?: { DISPLAY?: string };
}

/**
 * FFmpeg's input arguments (ending in `-i <x>`) for one source, or null when none is chosen. Live devices get
 * wall-clock timestamps, so sound and picture from different devices stay together; the test source is paced by `-re`.
 */
export function inputArgs(kind: SourceKind, device: string | null, ctx: InputContext): string[] | null {
  if (!device) return null;
  if (device === TEST_SOURCE) {
    const { width: w, height: h, fps } = ctx;
    if (kind === 'screen') return ['-re', '-f', 'lavfi', '-i', `testsrc2=size=${w}x${h}:rate=${fps}`];
    if (kind === 'camera') return ['-re', '-f', 'lavfi', '-i', `smptehdbars=size=${w}x${h}:rate=${fps}`];
    return ['-re', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:beep_factor=4'];
  }
  if (!isDevice(device)) throw new Error('That device name isn’t one FFmpeg can take.');
  const { platform, fps } = ctx;
  const wall = ['-use_wallclock_as_timestamps', '1', '-thread_queue_size', '512'];
  const size = `${ctx.width}x${ctx.height}`;
  if (platform === 'linux') {
    if (kind === 'screen') {
      const display = device === 'x11' ? (ctx.env?.DISPLAY ?? ':0') : device.replace(/^x11:/, '');
      return [
        '-thread_queue_size',
        '512',
        '-f',
        'x11grab',
        '-framerate',
        String(fps),
        '-draw_mouse',
        '1',
        '-i',
        display,
      ];
    }
    if (kind === 'camera')
      return [
        ...wall,
        '-f',
        'v4l2',
        '-input_format',
        'mjpeg',
        '-framerate',
        String(fps),
        '-video_size',
        size,
        '-i',
        device,
      ];
    return [...wall, '-f', 'pulse', '-i', device === 'default' ? 'default' : device];
  }
  if (platform === 'darwin') {
    const idx = device.replace(/^avf:/, '');
    if (kind === 'screen')
      return [
        '-thread_queue_size',
        '512',
        '-f',
        'avfoundation',
        '-framerate',
        String(fps),
        '-capture_cursor',
        '1',
        '-pixel_format',
        'uyvy422',
        '-i',
        `${idx}:none`,
      ];
    if (kind === 'camera')
      return [
        ...wall,
        '-f',
        'avfoundation',
        '-framerate',
        String(fps),
        '-video_size',
        size,
        '-i',
        `${idx}:none`,
      ];
    return [...wall, '-f', 'avfoundation', '-i', `none:${idx}`];
  }
  if (platform === 'win32') {
    const name = device.replace(/^dshow:/, '');
    if (kind === 'screen')
      return [
        '-thread_queue_size',
        '512',
        '-f',
        'gdigrab',
        '-framerate',
        String(fps),
        '-draw_mouse',
        '1',
        '-i',
        'desktop',
      ];
    if (kind === 'camera')
      return [...wall, '-f', 'dshow', '-video_size', size, '-framerate', String(fps), '-i', `video=${name}`];
    return [...wall, '-f', 'dshow', '-i', `audio=${name}`];
  }
  throw new Error(`Hildegard can’t capture on ${platform} yet.`);
}

// ── Encoders ───────────────────────────────────────────────────────────────────────────────────────────────────

export type EncoderId =
  | 'libx264'
  | 'h264_nvenc'
  | 'h264_videotoolbox'
  | 'h264_qsv'
  | 'h264_vaapi'
  | 'h264_amf';
export const ENCODER_NAMES: Record<EncoderId, string> = {
  libx264: 'Software (x264)',
  h264_nvenc: 'NVIDIA NVENC',
  h264_videotoolbox: 'Apple VideoToolbox',
  h264_qsv: 'Intel Quick Sync',
  h264_vaapi: 'VA-API',
  h264_amf: 'AMD AMF',
};

/** The order hardware encoders are tried in, per platform; software is always the last. */
export function encoderCandidates(platform: NodeJS.Platform): EncoderId[] {
  if (platform === 'darwin') return ['h264_videotoolbox', 'libx264'];
  if (platform === 'win32') return ['h264_nvenc', 'h264_qsv', 'h264_amf', 'libx264'];
  return ['h264_nvenc', 'h264_vaapi', 'h264_qsv', 'libx264'];
}

export interface EncoderArgs {
  /** Before the inputs: a device the encoder needs. */
  init: string[];
  /** Appended to the video filter chain feeding the encoder (hardware upload). */
  filter: string | null;
  codec: string[];
}

/**
 * Constant bit rate H.264 with a keyframe every two seconds, which every service here asks for. x264 pads to the
 * target (`nal-hrd=cbr`), so what leaves the computer is what the service was promised.
 */
export function encoderArgs(
  id: EncoderId,
  kbps: number,
  fps: number,
  vaapiDevice = '/dev/dri/renderD128',
): EncoderArgs {
  const gop = String(fps * 2);
  const rate = [
    '-b:v',
    `${kbps}k`,
    '-minrate',
    `${kbps}k`,
    '-maxrate',
    `${kbps}k`,
    '-bufsize',
    `${kbps * 2}k`,
  ];
  switch (id) {
    case 'h264_nvenc':
      return {
        init: [],
        filter: null,
        codec: [
          '-c:v',
          'h264_nvenc',
          '-preset',
          'p5',
          '-tune',
          'll',
          '-rc',
          'cbr',
          ...rate,
          '-profile:v',
          'high',
          '-bf',
          '2',
          '-g',
          gop,
          '-forced-idr',
          '1',
          '-no-scenecut',
          '1',
        ],
      };
    case 'h264_videotoolbox':
      return {
        init: [],
        filter: null,
        codec: [
          '-c:v',
          'h264_videotoolbox',
          '-b:v',
          `${kbps}k`,
          '-maxrate',
          `${kbps}k`,
          '-profile:v',
          'high',
          '-realtime',
          '1',
          '-allow_sw',
          '1',
          '-g',
          gop,
        ],
      };
    case 'h264_qsv':
      return {
        init: [],
        filter: null,
        codec: [
          '-c:v',
          'h264_qsv',
          '-preset',
          'veryfast',
          '-look_ahead',
          '0',
          ...rate,
          '-profile:v',
          'high',
          '-g',
          gop,
        ],
      };
    case 'h264_vaapi':
      return {
        init: ['-vaapi_device', vaapiDevice],
        filter: 'format=nv12,hwupload',
        codec: [
          '-c:v',
          'h264_vaapi',
          '-rc_mode',
          'CBR',
          '-b:v',
          `${kbps}k`,
          '-maxrate',
          `${kbps}k`,
          '-bufsize',
          `${kbps * 2}k`,
          '-profile:v',
          'high',
          '-g',
          gop,
        ],
      };
    case 'h264_amf':
      return {
        init: [],
        filter: null,
        codec: [
          '-c:v',
          'h264_amf',
          '-usage',
          'lowlatency',
          '-rc',
          'cbr',
          ...rate,
          '-profile:v',
          'high',
          '-g',
          gop,
        ],
      };
    default:
      return {
        init: [],
        filter: null,
        codec: [
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          ...rate,
          '-profile:v',
          'high',
          '-g',
          gop,
          '-keyint_min',
          gop,
          '-sc_threshold',
          '0',
          '-x264-params',
          `nal-hrd=cbr:force-cfr=1:keyint=${gop}:min-keyint=${gop}:scenecut=0`,
        ],
      };
  }
}

/** The bit rate the stream runs at: the quality's own, held under every chosen destination's limit. */
export function streamKbps(quality: StreamQuality, destinations: string[], override?: number): number {
  const caps = destinations.map((d) => STREAM_DESTINATIONS.find((p) => p.id === d)?.maxKbps ?? 6000);
  const want = override ?? STREAM_QUALITY[quality].kbps;
  // The service's own advice is a better aim than its ceiling, whatever the picture size.
  const advice = destinations.map((d) => STREAM_DESTINATIONS.find((p) => p.id === d)?.adviceKbps ?? 6000);
  const ceiling = Math.min(...caps, Number.POSITIVE_INFINITY);
  const aim =
    override !== undefined || quality === '1080p60'
      ? want
      : Math.min(want, ...advice, Number.POSITIVE_INFINITY);
  return Math.max(500, Math.min(aim, ceiling));
}

// ── Filter graph ───────────────────────────────────────────────────────────────────────────────────────────────

/** Escapes a value for an FFmpeg filter option inside a filtergraph string (two levels of escaping). */
export function filterValue(v: string): string {
  return v.replace(/[\\':]/g, '\\$&').replace(/[\\',;[\]]/g, '\\$&');
}

/** Escapes a path for a tee muxer slave. */
export const teePath = (p: string) => p.replace(/[\\'|[\]]/g, '\\$&');

export interface PlanInput {
  settings: StreamSettings;
  platform: NodeJS.Platform;
  env?: { DISPLAY?: string };
  encoder: EncoderId;
  /** Overrides the bit rate (tests aim at a small one). */
  kbps?: number;
  /** One per destination: the relay's URL (with the key's stand-in in it) and the id to report on. */
  rtmp: { id: string; url: string }[];
  recordFile: string | null;
  /** Where the live text files are (name, title, caption); created by the caller. */
  textDir: string;
  /** A font file for text, or null where the computer has none (text overlays are then left out). */
  font: string | null;
  /** A port the progress report goes to. */
  progressPort: number;
  /** A small picture on stdout for the Studio's preview. */
  preview: boolean;
  /** Where the VA-API device is. */
  vaapiDevice?: string;
}

export interface Plan {
  args: string[];
  /** The scenes the graph can switch between, in the order `streamselect` numbers them. */
  scenes: StreamScene[];
  kbps: number;
  width: number;
  height: number;
  fps: number;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** Which scenes the chosen sources allow. The two cards need no source. */
export function availableScenes(s: StreamSettings): StreamScene[] {
  const out: StreamScene[] = [];
  if (s.sources.screen) out.push('screen');
  if (s.sources.camera) out.push('camera');
  if (s.sources.screen && s.sources.camera) out.push('pip');
  out.push('starting', 'brb');
  return out;
}

export function textFiles(dir: string) {
  return { name: `${dir}/name.txt`, title: `${dir}/title.txt`, caption: `${dir}/caption.txt` };
}

export function buildPlan(p: PlanInput): Plan {
  const s = p.settings;
  const q = STREAM_QUALITY[s.quality];
  const { width: W, height: H, fps: F } = q;
  const scenes = availableScenes(s);
  if (!scenes.includes(s.scene)) {
    const need = s.scene === 'pip' ? 'a screen and a camera' : s.scene === 'screen' ? 'a screen' : 'a camera';
    throw new Error(
      `The “${s.scene}” scene needs ${need}. Pick ${s.scene === 'pip' ? 'both' : 'one'} first, or choose another scene.`,
    );
  }
  const ctx: InputContext = { platform: p.platform, width: W, height: H, fps: F, env: p.env };
  const kbps = streamKbps(
    s.quality,
    p.rtmp.map((r) => r.id),
    p.kbps,
  );
  const enc = encoderArgs(p.encoder, kbps, F, p.vaapiDevice);
  const outputs = p.rtmp.length + (p.recordFile ? 1 : 0);
  if (outputs === 0 && !p.preview) throw new Error('Nothing to send the stream to.');
  // A preview alone has no sound: it never opens the microphone.
  const withAudio = outputs > 0;

  const args: string[] = [
    '-hide_banner',
    '-nostats',
    '-loglevel',
    'info',
    '-progress',
    `tcp://127.0.0.1:${p.progressPort}`,
    '-stats_period',
    '1',
    ...enc.init,
  ];

  // Inputs, in order: screen, camera, mic, logo.
  const idx: Partial<Record<SourceKind | 'logo', number>> = {};
  const live: Partial<Record<SourceKind, boolean>> = {};
  let n = 0;
  for (const kind of ['screen', 'camera', 'mic'] as const) {
    const dev = kind === 'mic' && !withAudio ? null : s.sources[kind];
    const a = inputArgs(kind, dev, ctx);
    if (!a) continue;
    args.push(...a);
    idx[kind] = n++;
    live[kind] = dev !== TEST_SOURCE;
  }
  const logo = s.logo && /\.(png|jpe?g)$/i.test(s.logo) ? s.logo : null;
  if (logo) {
    args.push('-loop', '1', '-framerate', String(F), '-i', logo);
    idx.logo = n++;
  }

  // Text needs a font; without one the overlays are left out rather than failing the stream.
  const font = p.font ? `fontfile=${filterValue(p.font)}:` : '';
  const canText = !!p.font;
  const tf = textFiles(p.textDir);
  const text = (file: string, size: number, color: string, x: string, y: string, extra = '', name = '') =>
    `drawtext${name ? `@${name}` : ''}=${font}textfile=${filterValue(file)}:reload=1:expansion=none:fontsize=${size}:fontcolor=${color}:x=${x}:y=${y}${extra ? `:${extra}` : ''}`;

  const chains: string[] = [];
  const rtc = (v: boolean | undefined, audio = false) =>
    v ? `${audio ? 'asetpts' : 'setpts'}=(RTCTIME-RTCSTART)/(TB*1000000),` : '';
  const frame = (mode: 'fit' | 'fill') =>
    mode === 'fit'
      ? `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black`
      : `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`;

  const sceneLabel: Record<StreamScene, string> = {
    screen: 'scr',
    camera: 'cam',
    pip: 'pip',
    starting: 'st',
    brb: 'brb',
  };

  if (idx.screen !== undefined) {
    // A screen that feeds two scenes is split.
    const twice = scenes.includes('pip');
    chains.push(
      `[${idx.screen}:v]${rtc(live.screen)}fps=${F},${frame('fit')},setsar=1,format=yuv420p[${twice ? 'scr0' : 'scr'}]`,
    );
    if (twice) chains.push(`[scr0]split=2[scr][scrp]`);
  }
  if (idx.camera !== undefined) {
    const both = scenes.includes('pip');
    chains.push(`[${idx.camera}:v]${rtc(live.camera)}fps=${F},setsar=1[camraw]`);
    if (both) chains.push(`[camraw]split=2[camsrc][campsrc]`);
    else chains.push(`[camraw]null[camsrc]`);
    chains.push(`[camsrc]${frame('fill')},setsar=1,format=yuv420p[cam]`);
    if (both) {
      const pw = even((W * s.pip.size) / 100);
      const m = even(W * 0.025);
      const pos = {
        tl: `x=${m}:y=${m}`,
        tr: `x=W-w-${m}:y=${m}`,
        bl: `x=${m}:y=H-h-${m}`,
        br: `x=W-w-${m}:y=H-h-${m}`,
      }[s.pip.corner];
      chains.push(`[campsrc]scale=${pw}:-2,format=yuv420p[camsmall]`);
      chains.push(`[scrp][camsmall]overlay=${pos}:format=auto,format=yuv420p[pip]`);
    }
  }
  const card = (label: string, tint: string) => {
    const base = `color=c=${tint}:s=${W}x${H}:r=${F},format=yuv420p`;
    const stripe = `drawbox=x=${even(W * 0.08)}:y=${even(H * 0.54)}:w=${even(W * 0.1)}:h=${even(H * 0.006)}:color=0xd9c27a:t=fill`;
    const t = canText
      ? `,${text(`${p.textDir}/${label}.txt`, even(H * 0.1), 'white', `${even(W * 0.08)}`, `${even(H * 0.4)}`)}`
      : '';
    chains.push(`${base},${stripe}${t}[${label}]`);
  };
  card('st', '0x10261d');
  card('brb', '0x261d10');

  // The scene switch.
  const order = scenes.map((sc) => `[${sceneLabel[sc]}]`).join('');
  const first = Math.max(0, scenes.indexOf(s.scene));
  const paced = idx.screen !== undefined || idx.camera !== undefined;
  // Cards alone would run as fast as the computer can draw them; hold them to the clock.
  chains.push(
    `${order}streamselect@scene=inputs=${scenes.length}:map=${first}${paced ? '' : ',realtime'}[sel]`,
  );

  // Overlays that stay on whatever scene is showing.
  let cur = 'sel';
  const step = (name: string, f: string) => {
    chains.push(`[${cur}]${f}[${name}]`);
    cur = name;
  };
  if (idx.logo !== undefined) {
    const lh = even(H * 0.09);
    const m = even(W * 0.025);
    chains.push(`[${idx.logo}:v]scale=-2:${lh},format=rgba[logo]`);
    chains.push(`[${cur}][logo]overlay=W-w-${m}:${m}:format=auto,format=yuv420p[withlogo]`);
    cur = 'withlogo';
  }
  if (canText) {
    const m = even(W * 0.04);
    const lt = s.lowerThird.on ? '1' : '0';
    step(
      'lt0',
      `drawbox@ltbox=x=${m - 12}:y=${H - even(H * 0.2) - 10}:w=${even(W * 0.38)}:h=${even(H * 0.115)}:color=black@0.55:t=fill:enable=${lt},drawbox@ltbar=x=${m - 12}:y=${H - even(H * 0.2) - 10}:w=6:h=${even(H * 0.115)}:color=0xd9c27a:t=fill:enable=${lt}`,
    );
    step(
      'lt1',
      text(tf.name, even(H * 0.05), 'white', `${m}`, `${H - even(H * 0.2)}`, `enable=${lt}`, 'ltname'),
    );
    step(
      'lt2',
      text(
        tf.title,
        even(H * 0.034),
        '0xe8e0c8',
        `${m}`,
        `${H - even(H * 0.2) + even(H * 0.064)}`,
        `enable=${lt}`,
        'lttitle',
      ),
    );
    const cap = s.caption.on ? '1' : '0';
    step(
      'cap',
      text(
        tf.caption,
        even(H * 0.04),
        'white',
        `(w-text_w)/2`,
        `h-${even(H * 0.085)}`,
        `box=1:boxcolor=black@0.6:boxborderw=14:enable=${cap}`,
        'caption',
      ),
    );
  }
  // The end of the picture chain: to the encoder, and (small) to the preview.
  const hw = enc.filter ?? 'null';
  if (outputs > 0 && p.preview) {
    chains.push(`[${cur}]split=2[vmain][vp0]`);
    chains.push(`[vmain]${hw}[venc]`);
    chains.push(`[vp0]fps=5,scale=480:-2:out_range=full,format=yuv420p[vprev]`);
  } else if (outputs > 0) {
    chains.push(`[${cur}]${hw}[venc]`);
  } else {
    chains.push(`[${cur}]fps=5,scale=480:-2:out_range=full,format=yuv420p[vprev]`);
  }

  // Sound: the microphone, or silence, as 48 kHz stereo; mute is a volume command away.
  if (withAudio) {
    if (idx.mic !== undefined) {
      chains.push(
        `[${idx.mic}:a]${rtc(live.mic, true)}aresample=48000:async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,volume@mic=${s.mute ? '0' : '1'}[aout]`,
      );
    } else {
      chains.push(`anullsrc=r=48000:cl=stereo,volume@mic=${s.mute ? '0' : '1'}[aout]`);
    }
  }

  args.push('-filter_complex', chains.join(';'));

  // The encoded stream, to every destination and the recording.
  const slaves: string[] = [];
  const several = p.rtmp.length + (p.recordFile ? 1 : 0) > 1;
  for (const r of p.rtmp)
    slaves.push(`[f=flv:flvflags=no_duration_filesize:onfail=${several ? 'ignore' : 'abort'}]${r.url}`);
  if (p.recordFile) slaves.push(`[f=matroska:onfail=ignore]${teePath(p.recordFile)}`);
  if (slaves.length > 0) {
    args.push(
      '-map',
      '[venc]',
      '-map',
      '[aout]',
      ...enc.codec,
      ...(p.encoder === 'h264_vaapi' ? [] : ['-pix_fmt', 'yuv420p']),
      '-r',
      String(F),
      '-flags',
      '+global_header',
      '-c:a',
      'aac',
      '-b:a',
      '160k',
      '-ar',
      '48000',
      '-ac',
      '2',
      '-metadata',
      'comment=hildegard-stream',
      '-f',
      'tee',
      slaves.join('|'),
    );
  }
  if (p.preview)
    args.push(
      '-map',
      '[vprev]',
      '-an',
      '-metadata',
      'comment=hildegard-stream',
      '-c:v',
      'mjpeg',
      '-strict',
      'unofficial',
      '-q:v',
      '7',
      '-f',
      'image2pipe',
      'pipe:1',
    );
  return { args, scenes, kbps, width: W, height: H, fps: F };
}

/** The interactive command that switches the scene live: FFmpeg reads it on stdin. */
export const sceneCommand = (scenes: StreamScene[], to: StreamScene): string | null => {
  const i = scenes.indexOf(to);
  return i < 0 ? null : `cstreamselect@scene -1 map ${i}\n`;
};

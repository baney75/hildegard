// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Go live. One FFmpeg process per stream (stream-plan.ts builds its command), a keyholder relay per destination
 * (stream-relay.ts), and this: the settings, the preview, the countdown, the supervisor that reconnects, the
 * statistics, and a Stop that always works.
 *
 * Starting is the person's, at this computer: nothing in here is reachable from the MCP, and the routes that call
 * `goLive` refuse every other caller. Stream keys are read from the keychain at the moment a stream starts, held in
 * a relay's memory, and never returned from any method.
 */
import { type ChildProcess, execFile, spawn as nodeSpawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  DEFAULT_STREAM_SETTINGS,
  IngestServer,
  STREAM_DESTINATIONS,
  STREAM_QUALITY,
  type StreamDestinationId,
  type StreamDestinationState,
  type StreamDestinationView,
  type StreamDevices,
  type StreamPreflight,
  StreamSettings,
  type StreamState,
  type StreamStats,
} from '@hildegard/presets';
import type { SecretStore } from './hf.ts';
import { listDevices, type Run, run, workingEncoders } from './stream-devices.ts';
import {
  availableScenes,
  buildPlan,
  ENCODER_NAMES,
  type EncoderId,
  inputArgs,
  isDevice,
  type Plan,
  sceneCommand,
  TEST_SOURCE,
} from './stream-plan.ts';
import { KEY_RE, KeyRelay, type RelayEvent } from './stream-relay.ts';

export class StreamError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** The environment FFmpeg gets: where things are on this desktop, and none of the rest. */
const ENV_KEEP = [
  'PATH',
  'HOME',
  'USER',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SYSTEMROOT',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'DISPLAY',
  'XAUTHORITY',
  'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
  'PULSE_SERVER',
  'PULSE_RUNTIME_PATH',
  'LIBVA_DRIVER_NAME',
  'LD_LIBRARY_PATH',
];
export function ffmpegEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of ENV_KEEP) if (env[k] !== undefined) out[k] = env[k];
  return out;
}

const FONTS: Partial<Record<NodeJS.Platform, string[]>> = {
  linux: [
    '/usr/share/fonts/liberation/LiberationSans-Bold.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
    '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/noto/NotoSans-Bold.ttf',
    '/usr/share/fonts/google-noto/NotoSans-Bold.ttf',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc',
  ],
  darwin: [
    '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
    '/System/Library/Fonts/Helvetica.ttc',
    '/Library/Fonts/Arial Bold.ttf',
  ],
  win32: ['C:/Windows/Fonts/arialbd.ttf', 'C:/Windows/Fonts/segoeuib.ttf', 'C:/Windows/Fonts/arial.ttf'],
};
export const findFont = (platform: NodeJS.Platform = process.platform): string | null =>
  FONTS[platform]?.find((f) => existsSync(f)) ?? null;

// ── The preview picture ────────────────────────────────────────────────────────────────────────────────────────

/** Cuts a stream of concatenated JPEGs into frames. */
export class JpegSplitter {
  private buf: Buffer = Buffer.alloc(0);
  push(chunk: Buffer): Buffer[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const frames: Buffer[] = [];
    for (;;) {
      const a = this.buf.indexOf(Buffer.from([0xff, 0xd8]));
      if (a < 0) {
        this.buf = Buffer.alloc(0);
        break;
      }
      const b = this.buf.indexOf(Buffer.from([0xff, 0xd9]), a + 2);
      if (b < 0) {
        this.buf = this.buf.subarray(a);
        break;
      }
      frames.push(this.buf.subarray(a, b + 2));
      this.buf = this.buf.subarray(b + 2);
    }
    if (this.buf.length > 4 * 1024 * 1024) this.buf = Buffer.alloc(0);
    return frames;
  }
}

/** FFmpeg's `-progress` report: blocks of key=value lines, each ending with `progress=`. */
export function parseProgress(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/** What went wrong, from the last lines FFmpeg wrote, in words for a person. */
export function explainFfmpeg(tail: string, platform: NodeJS.Platform = process.platform): string {
  const t = tail.toLowerCase();
  if (t.includes('ffmpeg: not found'))
    return platform === 'darwin'
      ? 'FFmpeg isn’t installed. In Terminal: brew install ffmpeg'
      : platform === 'win32'
        ? 'FFmpeg isn’t installed. In a terminal: winget install Gyan.FFmpeg'
        : 'FFmpeg isn’t installed. Install the ffmpeg package from your distribution.';
  if (/permission denied|not authorized|operation not permitted/.test(t))
    return platform === 'darwin'
      ? 'macOS didn’t let Hildegard use the camera, microphone or screen. Allow it in System Settings, Privacy & Security, then try again.'
      : platform === 'win32'
        ? 'Windows didn’t let Hildegard use the camera or microphone. Allow desktop apps in Settings, Privacy & security.'
        : 'This computer didn’t let Hildegard open a device. For a camera, your user needs to be in the “video” group.';
  if (/device or resource busy|resource busy/.test(t))
    return 'Another app is using the camera or microphone. Close it and try again.';
  if (/cannot open display|can't open display|unable to open display/.test(t))
    return 'Hildegard can’t see the screen. On Linux it captures through X11; on Wayland, use “Use OBS”.';
  if (/no such file or directory/.test(t) && /(video|audio|dev)/.test(t))
    return 'A camera or microphone you picked isn’t there any more. Pick it again.';
  if (/unrecognized option|option not found|unknown encoder|encoder .* not found/.test(t))
    return 'This FFmpeg doesn’t have a feature Hildegard needs. Update FFmpeg, or choose Software in the encoder setting.';
  if (/no such filter/.test(t))
    return 'This FFmpeg is missing a filter Hildegard needs. Install a full build of FFmpeg.';
  if (/error while opening encoder|cannot load|nvenc/.test(t))
    return 'The video card’s encoder didn’t start. Choose Software in the encoder setting, or update your graphics driver.';
  return 'FFmpeg stopped. The details are in “Show details”.';
}

// ── The streamer ───────────────────────────────────────────────────────────────────────────────────────────────

export interface StreamerDeps {
  dataDir: string;
  /** The keychain (or the 0600 fallback): where stream keys live. */
  secrets: (account: string) => SecretStore;
  onChange?: (s: StreamState) => void;
  ffmpeg?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  spawn?: typeof nodeSpawn;
  run?: Run;
  /** The encoders that work here, best first; probed on first use unless given. */
  encoders?: () => Promise<EncoderId[]>;
  devices?: () => Promise<StreamDevices>;
  /** One frame from a source, to tell whether it can be opened. */
  probeSource?: (kind: 'screen' | 'camera' | 'mic', device: string) => Promise<string | null>;
  /** Upload speed in megabits a second, or null if it can't be measured. */
  speedTest?: () => Promise<number | null>;
  /** How long a connection to this host takes, in milliseconds, or null if it can't be made. */
  reach?: (host: string, port: number) => Promise<number | null>;
  /** Twitch's own pick of ingest server for this person, or null for the default. */
  twitchIngest?: () => Promise<string | null>;
  /** Tests connect relays to a local server without TLS. */
  relayConnect?: (host: string, port: number, secure: boolean) => net.Socket;
  font?: string | null;
  countdownSeconds?: number;
  /** Waits before each reconnect, in milliseconds. */
  backoff?: number[];
  maxAttempts?: number;
  watchdogMs?: number;
  /** A bit rate to aim at instead of the quality's own (tests). */
  kbps?: number;
  now?: () => number;
}

interface Run1 {
  child: ChildProcess;
  mode: 'preview' | 'live';
  relays: Map<StreamDestinationId, KeyRelay>;
  progress: net.Server;
  plan: Plan;
  encoder: EncoderId;
  startedAt: number;
  lastProgress: number;
  exited: Promise<void>;
  tail: string[];
  /** Set when the run is being stopped on purpose. */
  ending: boolean;
  lastSent: number;
  lastSentAt: number;
  cpuTimer: ReturnType<typeof setInterval> | null;
  recordFile: string | null;
  sources: StreamSettings['sources'];
}

const EMPTY_STATS: StreamStats = { kbps: null, fps: null, dropped: 0, cpu: null, gpu: null, speed: null };
const DEFAULT_BACKOFF = [2000, 4000, 8000, 15000, 30000];

export class Streamer {
  readonly deps: StreamerDeps;
  readonly dir: string;
  private cfg: StreamSettings;
  private phase: StreamState['phase'] = 'idle';
  private message: string | null = null;
  private countdown: number | null = null;
  private countdownTimer: ReturnType<typeof setInterval> | null = null;
  private runState: Run1 | null = null;
  private stats: StreamStats = { ...EMPTY_STATS };
  private dest = new Map<StreamDestinationId, { state: StreamDestinationState; detail: string | null }>();
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private liveSince: number | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private workers: EncoderId[] | null = null;
  private frame: Buffer | null = null;
  private frameFns = new Set<(f: Buffer) => void>();
  private busy: Promise<unknown> = Promise.resolve();
  private chosen: EncoderId | null = null;
  private exitHook = false;
  private lastLog: string[] = [];
  /** Bumped by every Stop, so a start that was in flight sees it and gives up. */
  private gen = 0;

  constructor(deps: StreamerDeps) {
    this.deps = deps;
    this.dir = join(deps.dataDir, 'stream');
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.cfg = this.load();
    this.reapOrphan();
  }

  private get ffmpeg() {
    return this.deps.ffmpeg ?? process.env.HILDEGARD_FFMPEG ?? 'ffmpeg';
  }
  private get platform() {
    return this.deps.platform ?? process.platform;
  }
  private get now() {
    return (this.deps.now ?? Date.now)();
  }
  private get go(): Run {
    return this.deps.run ?? run;
  }

  // ── Settings ─────────────────────────────────────────────────────────────────────────────────────────────────

  private settingsFile = () => join(this.dir, 'settings.json');
  private load(): StreamSettings {
    try {
      return StreamSettings.parse(JSON.parse(readFileSync(this.settingsFile(), 'utf8')));
    } catch {
      return DEFAULT_STREAM_SETTINGS;
    }
  }
  private save() {
    const f = this.settingsFile();
    writeFileSync(`${f}.tmp`, JSON.stringify(this.cfg, null, 2), { mode: 0o600 });
    renameSync(`${f}.tmp`, f);
  }

  settings(): StreamSettings {
    return this.cfg;
  }

  /**
   * Changes settings. While a stream is on, only what can change without restarting the picture is accepted: the
   * scene, the microphone, the lower third and the caption.
   */
  async update(patch: unknown): Promise<StreamState> {
    const p = (patch ?? {}) as Record<string, unknown>;
    const merged = { ...this.cfg, ...p } as Record<string, unknown>;
    for (const k of ['pip', 'sources', 'lowerThird', 'caption'] as const) {
      if (p[k] && typeof p[k] === 'object') merged[k] = { ...(this.cfg[k] as object), ...(p[k] as object) };
    }
    if (p.destinations && typeof p.destinations === 'object') {
      const d: Record<string, unknown> = { ...this.cfg.destinations };
      for (const [id, v] of Object.entries(p.destinations as Record<string, object>))
        d[id] = { ...(d[id] as object), ...v };
      merged.destinations = d;
    }
    const parsed = StreamSettings.safeParse(merged);
    if (!parsed.success) {
      const i = parsed.error.issues[0];
      throw new StreamError(400, 'settings', i?.message ?? 'Those settings aren’t right.');
    }
    const next = parsed.data;
    if (next.logo && !/\.(png|jpe?g)$/i.test(next.logo))
      throw new StreamError(400, 'logo', 'The logo needs to be a PNG or JPEG file.');
    if (next.logo && next.logo !== this.cfg.logo && !existsSync(next.logo))
      throw new StreamError(
        400,
        'logo',
        'There’s no file at that path. Check it, or drag the logo into a terminal to get its path.',
      );
    for (const kind of ['screen', 'camera', 'mic'] as const) {
      const d = next.sources[kind];
      if (d && d !== TEST_SOURCE && !isDevice(d))
        throw new StreamError(400, 'device', 'That device name isn’t one Hildegard can use.');
    }
    const live =
      this.phase === 'live' ||
      this.phase === 'countdown' ||
      this.phase === 'reconnecting' ||
      this.phase === 'stopping';
    if (live) {
      const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
      const fixed = ['pip', 'sources', 'quality', 'encoder', 'destinations', 'logo', 'record'] as const;
      if (fixed.some((k) => !same(this.cfg[k], next[k])))
        throw new StreamError(
          409,
          'live',
          'Stop the stream to change that. The scene, the microphone, the lower third and the caption can change while you’re live.',
        );
      if (!availableScenes(next).includes(next.scene))
        throw new StreamError(400, 'scene', 'That scene needs a source that isn’t on.');
    }
    const before = this.cfg;
    this.cfg = next;
    this.save();
    this.writeTexts();
    await this.apply(before, next);
    this.changed();
    return this.state();
  }

  /** Pushes a change to FFmpeg without restarting it, or restarts the preview when the picture itself changed. */
  private async apply(before: StreamSettings, now: StreamSettings) {
    const r = this.runState;
    if (!r) return;
    const j = (a: unknown) => JSON.stringify(a);
    if (
      r.mode === 'preview' &&
      ['pip', 'sources', 'quality', 'logo', 'encoder'].some(
        (k) => j(before[k as keyof StreamSettings]) !== j(now[k as keyof StreamSettings]),
      )
    ) {
      // In the queue, so a restart can't race a start or leave a second FFmpeg running.
      await this.serial(() => this.restartPreview());
      return;
    }
    if (before.scene !== now.scene) this.command(sceneCommand(r.plan.scenes, now.scene));
    if (before.mute !== now.mute) this.command(`cvolume@mic -1 volume ${now.mute ? 0 : 1}\n`);
    if (before.lowerThird.on !== now.lowerThird.on) {
      const v = now.lowerThird.on ? 1 : 0;
      for (const f of ['drawbox@ltbox', 'drawbox@ltbar', 'drawtext@ltname', 'drawtext@lttitle'])
        this.command(`c${f} -1 enable ${v}\n`);
    }
    if (before.caption.on !== now.caption.on)
      this.command(`cdrawtext@caption -1 enable ${now.caption.on ? 1 : 0}\n`);
  }

  private command(line: string | null) {
    if (!line) return;
    try {
      this.runState?.child.stdin?.write(line);
    } catch {}
  }

  /** The files FFmpeg reads text from, written whole so it never reads half. */
  private writeTexts() {
    const dir = join(this.dir, 'text');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const put = (name: string, text: string) => {
      const f = join(dir, name);
      if (existsSync(f) && readFileSync(f, 'utf8') === text) return;
      writeFileSync(`${f}.tmp`, text);
      renameSync(`${f}.tmp`, f);
    };
    put('name.txt', this.cfg.lowerThird.name);
    put('title.txt', this.cfg.lowerThird.title);
    put('caption.txt', this.cfg.caption.text);
    put('st.txt', 'Starting soon');
    put('brb.txt', 'Be right back');
  }

  // ── Keys ─────────────────────────────────────────────────────────────────────────────────────────────────────

  private store = (id: StreamDestinationId) => this.deps.secrets(`stream-${id}`);
  /** Whether a key is saved. Read once and remembered, so the Studio’s polling doesn’t knock on the keychain. */
  private keyed = new Map<StreamDestinationId, boolean>();
  keySet = (id: StreamDestinationId): boolean => {
    let has = this.keyed.get(id);
    if (has === undefined) {
      try {
        has = !!this.store(id).get();
      } catch {
        has = false;
      }
      this.keyed.set(id, has);
    }
    return has;
  };

  /** Saves a stream key to the keychain. It is not returned, logged or written anywhere else. */
  setKey(id: StreamDestinationId, key: string) {
    const k = key.trim();
    if (!KEY_RE.test(k))
      throw new StreamError(
        400,
        'key',
        'That doesn’t look like a stream key. Copy it again from your service, with no spaces.',
      );
    if (this.runState) throw new StreamError(409, 'live', 'Stop the stream before changing a key.');
    this.store(id).set(k);
    this.keyed.set(id, true);
    this.changed();
  }
  clearKey(id: StreamDestinationId) {
    if (this.runState) throw new StreamError(409, 'live', 'Stop the stream before removing a key.');
    this.store(id).delete();
    this.keyed.set(id, false);
    this.changed();
  }

  /** Points OBS at a saved destination. The key goes from the keychain to OBS and is not returned. */
  async useInObs(
    obs: { useService(server: string, key: string): Promise<unknown> },
    id: StreamDestinationId,
  ) {
    const preset = STREAM_DESTINATIONS.find((d) => d.id === id)!;
    const key = this.store(id).get();
    if (!key) throw new StreamError(400, 'key', `Add your ${preset.name} stream key first.`);
    await obs.useService(id === 'twitch' ? await this.twitchServer() : this.serverFor(id), key);
  }

  // ── State ────────────────────────────────────────────────────────────────────────────────────────────────────

  private serverFor(id: StreamDestinationId): string {
    const preset = STREAM_DESTINATIONS.find((d) => d.id === id)!;
    return this.cfg.destinations[id]?.server ?? preset.server;
  }

  state(canStart = true): StreamState {
    const destinations: StreamDestinationView[] = STREAM_DESTINATIONS.map((p) => {
      const enabled = this.cfg.destinations[p.id]?.enabled ?? false;
      const d = this.dest.get(p.id);
      return {
        id: p.id,
        name: p.name,
        keySet: this.keySet(p.id),
        enabled,
        server: this.serverFor(p.id),
        serverFromAccount: p.serverFromAccount,
        keyHelp: p.keyHelp,
        state: enabled ? (d?.state ?? 'off') : 'off',
        detail: enabled ? (d?.detail ?? null) : null,
      };
    });
    return {
      phase: this.phase,
      scene: this.cfg.scene,
      countdown: this.countdown,
      seconds: this.liveSince !== null ? Math.max(0, Math.floor((this.now - this.liveSince) / 1000)) : null,
      encoder: this.chosen ? ENCODER_NAMES[this.chosen] : null,
      quality: this.cfg.quality,
      kbps: this.runState?.plan.kbps ?? null,
      destinations,
      stats: this.stats,
      attempt: this.attempt,
      message: this.message,
      recording: !!this.runState?.recordFile,
      settings: this.cfg,
      canStart,
    };
  }

  private changed() {
    this.deps.onChange?.(this.state());
  }

  // ── Preview ──────────────────────────────────────────────────────────────────────────────────────────────────

  /** FFmpeg's process id while one runs (tests look at its command line). */
  pid(): number | null {
    return this.runState?.child.pid ?? null;
  }

  /** FFmpeg's last lines, for “Show details”. The key was never in its command line, so it is not in these. */
  log(): string[] {
    return this.runState ? this.runState.tail.slice(-40) : this.lastLog;
  }

  latestFrame(): Buffer | null {
    return this.frame;
  }
  onFrame(fn: (f: Buffer) => void): () => void {
    this.frameFns.add(fn);
    return () => this.frameFns.delete(fn);
  }

  /** Starts the picture without sending it anywhere, so the person can set the scene up. */
  startPreview(): Promise<StreamState> {
    const gen = this.gen;
    return this.serial(async () => {
      if (gen !== this.gen || this.runState || this.phase !== 'idle') return this.state();
      await this.launch('preview', gen);
      this.phase = 'preview';
      this.message = null;
      this.changed();
      return this.state();
    });
  }
  stopPreview(): Promise<StreamState> {
    return this.serial(async () => {
      if (this.runState?.mode === 'preview') await this.end('idle');
      return this.state();
    });
  }
  private async restartPreview() {
    if (this.runState?.mode !== 'preview' || this.phase !== 'preview') return;
    const gen = this.gen;
    await this.end('idle');
    if (gen !== this.gen) return;
    try {
      await this.launch('preview', gen);
      this.phase = 'preview';
    } catch (e) {
      this.message = (e as Error).message;
    }
  }

  // ── Going live ───────────────────────────────────────────────────────────────────────────────────────────────

  /** Counts down, then streams. Every checkable thing is checked first, so a count never ends in a surprise. */
  goLive(): Promise<StreamState> {
    // This start's generation: Stop or Cancel bumps it, and begin and launch check it after every wait.
    const gen = this.gen;
    return this.serial(async () => {
      if (gen !== this.gen) return this.state();
      if (this.phase === 'live' || this.phase === 'countdown' || this.phase === 'reconnecting')
        throw new StreamError(409, 'live', 'You’re already live.');
      const picked = STREAM_DESTINATIONS.filter((d) => this.cfg.destinations[d.id]?.enabled);
      if (!picked.length && !this.cfg.record)
        throw new StreamError(400, 'destination', 'Pick where to stream, or turn on recording.');
      for (const d of picked) {
        if (!this.keySet(d.id)) throw new StreamError(400, 'key', `Add your ${d.name} stream key first.`);
        if (!this.serverFor(d.id))
          throw new StreamError(400, 'server', `Add your ${d.name} server address first.`);
      }
      if (!availableScenes(this.cfg).includes(this.cfg.scene))
        throw new StreamError(400, 'scene', 'The scene you picked needs a source that isn’t on.');
      this.message = null;
      this.phase = 'countdown';
      this.countdown = this.deps.countdownSeconds ?? 5;
      this.changed();
      // The countdown ticks outside the queue so Cancel can interrupt it.
      this.countdownTimer = setInterval(() => {
        if (this.countdown === null) return;
        this.countdown -= 1;
        if (this.countdown <= 0) {
          this.clearCountdown();
          void this.serial(() => this.begin(gen));
        } else this.changed();
      }, 1000);
      if (this.countdown <= 0) {
        this.clearCountdown();
        await this.begin(gen);
      }
      return this.state();
    });
  }

  private clearCountdown() {
    if (this.countdownTimer) clearInterval(this.countdownTimer);
    this.countdownTimer = null;
    this.countdown = null;
  }

  /** Cancels the countdown, back to the preview. */
  cancelCountdown(): Promise<StreamState> {
    // At once, not queued: a count that just ended may be closing the preview, and must not go on to start.
    if (this.phase === 'countdown') this.gen++;
    return this.serial(async () => {
      if (this.phase !== 'countdown') return this.state();
      this.clearCountdown();
      this.phase = this.runState ? 'preview' : 'idle';
      this.changed();
      return this.state();
    });
  }

  private async begin(gen: number) {
    const going = () => gen === this.gen && (this.phase === 'countdown' || this.phase === 'reconnecting');
    if (!going()) return;
    try {
      const again = this.phase === 'reconnecting';
      const prev = this.runState;
      // The preview holds the camera until its FFmpeg is gone.
      if (prev) await this.end('countdown').then(() => Promise.race([prev.exited, sleep(3000)]));
      // Stop or Cancel pressed while the preview closed: no stream.
      if (!going()) return;
      this.attempt = again ? this.attempt : 0;
      await this.launch('live', gen);
    } catch (e) {
      // A Stop already set where things stand.
      if (gen !== this.gen) return;
      this.phase = 'idle';
      this.message = e instanceof Error ? e.message : String(e);
      this.runState = null;
      this.changed();
    }
  }

  /** Stops everything, now. It always returns, and the process group is gone within two seconds. */
  async stop(): Promise<StreamState> {
    // Not queued behind a start: a Stop that waits is not a Stop.
    this.gen++;
    this.clearCountdown();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.runState) await this.end('idle');
    else {
      this.phase = 'idle';
      this.liveSince = null;
      this.attempt = 0;
      this.stats = { ...EMPTY_STATS };
      this.dest.clear();
      this.changed();
    }
    return this.state();
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.busy.then(fn, fn);
    this.busy = next.catch(() => {});
    return next;
  }

  // ── The process ──────────────────────────────────────────────────────────────────────────────────────────────

  private async encoderFor(): Promise<EncoderId> {
    if (this.cfg.encoder === 'software') return 'libx264';
    this.workers ??= await (
      this.deps.encoders ?? (() => workingEncoders(this.ffmpeg, this.platform, this.go))
    )();
    return this.workers[0] ?? 'libx264';
  }

  private async twitchServer(): Promise<string> {
    const set = this.cfg.destinations.twitch?.server;
    if (set) return set;
    const pick = await (this.deps.twitchIngest ?? twitchIngest)().catch(() => null);
    return pick && IngestServer.safeParse(pick).success
      ? pick
      : STREAM_DESTINATIONS.find((d) => d.id === 'twitch')!.server;
  }

  private async launch(mode: 'preview' | 'live', gen = this.gen) {
    if (this.runState) throw new StreamError(409, 'busy', 'Something is already running. Stop it first.');
    const stopped = () => {
      if (gen !== this.gen) throw new StreamError(409, 'stopped', 'Stopped.');
    };
    stopped();
    this.writeTexts();
    const dests =
      mode === 'live' ? STREAM_DESTINATIONS.filter((d) => this.cfg.destinations[d.id]?.enabled) : [];
    const relays = new Map<StreamDestinationId, KeyRelay>();
    const urls: { id: StreamDestinationId; url: string }[] = [];
    const keys: string[] = [];
    try {
      this.dest.clear();
      for (const d of dests) {
        const key = this.store(d.id).get();
        if (!key) throw new StreamError(400, 'key', `Add your ${d.name} stream key first.`);
        keys.push(key);
        const server = d.id === 'twitch' ? await this.twitchServer() : this.serverFor(d.id);
        stopped();
        const relay = new KeyRelay({
          server,
          key,
          connect: this.deps.relayConnect,
          onEvent: (e) => this.relayEvent(d.id, e),
        });
        relays.set(d.id, relay);
        const { url } = await relay.listen();
        stopped();
        urls.push({ id: d.id, url });
        this.dest.set(d.id, { state: 'connecting', detail: null });
      }
      const encoder = await this.encoderFor();
      stopped();
      this.chosen = encoder;
      const progress = net.createServer();
      await new Promise<void>((res, rej) => {
        progress.once('error', rej);
        progress.listen(0, '127.0.0.1', res);
      });
      const port = (progress.address() as net.AddressInfo).port;
      if (gen !== this.gen) {
        progress.close();
        throw new StreamError(409, 'stopped', 'Stopped.');
      }
      const recordFile =
        mode === 'live' && this.cfg.record
          ? join(this.dir, 'recordings', `hildegard-${stamp(this.now)}.mkv`)
          : null;
      if (recordFile) mkdirSync(join(this.dir, 'recordings'), { recursive: true, mode: 0o700 });
      let plan: Plan;
      try {
        plan = buildPlan({
          settings: this.cfg,
          platform: this.platform,
          env: this.deps.env ?? process.env,
          encoder,
          kbps: this.deps.kbps,
          rtmp: urls,
          recordFile,
          textDir: join(this.dir, 'text'),
          font: this.deps.font === undefined ? findFont(this.platform) : this.deps.font,
          progressPort: port,
          preview: true,
        });
      } catch (e) {
        progress.close();
        throw new StreamError(400, 'plan', (e as Error).message);
      }
      const spawnFn = this.deps.spawn ?? nodeSpawn;
      const child = spawnFn(this.ffmpeg, plan.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        // Its own process group, so Stop takes the whole of it.
        detached: this.platform !== 'win32',
        windowsHide: true,
        env: ffmpegEnv(this.deps.env ?? process.env),
      });
      const r: Run1 = {
        child,
        mode,
        relays,
        progress,
        plan,
        encoder,
        startedAt: this.now,
        lastProgress: this.now,
        exited: Promise.resolve(),
        tail: [],
        ending: false,
        lastSent: 0,
        lastSentAt: this.now,
        cpuTimer: null,
        recordFile,
        sources: { ...this.cfg.sources },
      };
      r.exited = new Promise<void>((resolve) => {
        child.once('exit', (code, signal) => {
          resolve();
          void this.onExit(r, code, signal);
        });
        child.once('error', (e) => {
          r.tail.push(`${(e as NodeJS.ErrnoException).code === 'ENOENT' ? 'ffmpeg: not found' : e.message}`);
          resolve();
          void this.onExit(r, 1, null);
        });
      });
      this.runState = r;
      this.hook();
      this.writePid(child.pid);
      const split = new JpegSplitter();
      child.stdout?.on('data', (d: Buffer) => {
        for (const f of split.push(d)) {
          this.frame = f;
          for (const fn of this.frameFns) fn(f);
        }
      });
      let err = '';
      child.stderr?.on('data', (d: Buffer) => {
        err += d.toString('utf8');
        const lines = err.split('\n');
        err = lines.pop() ?? '';
        for (const line of lines) {
          // The relays keep the key from FFmpeg; this is the second lock, on what the log keeps.
          const l = keys.reduce((t, k) => t.split(k).join('[stream key]'), line);
          r.tail.push(l);
          if (r.tail.length > 60) r.tail.shift();
        }
      });
      child.stdin?.on('error', () => {});
      progress.on('connection', (s) => {
        let acc = '';
        s.on('data', (d) => {
          acc += d.toString('utf8');
          for (let i = acc.indexOf('progress='); i >= 0; i = acc.indexOf('progress=')) {
            const nl = acc.indexOf('\n', i);
            if (nl < 0) break;
            this.onProgress(r, parseProgress(acc.slice(0, nl)));
            acc = acc.slice(nl + 1);
          }
        });
        s.on('error', () => {});
      });
      if (mode === 'live') {
        this.liveSince = this.now;
        this.stats = { ...EMPTY_STATS };
        this.phase = 'live';
        this.message = null;
        this.startWatchdog();
        r.cpuTimer = setInterval(() => void this.sample(r), 2000);
        r.cpuTimer.unref?.();
      }
      this.changed();
    } catch (e) {
      for (const rl of relays.values()) rl.stop();
      throw e;
    }
  }

  private relayEvent(id: StreamDestinationId, e: RelayEvent) {
    if (e.type === 'connecting') this.dest.set(id, { state: 'connecting', detail: null });
    else if (e.type === 'live') this.dest.set(id, { state: 'live', detail: null });
    else
      this.dest.set(id, {
        state: this.runState?.ending ? 'off' : 'failed',
        detail: this.runState?.ending ? null : e.reason,
      });
    const r = this.runState;
    if (r && !r.ending && e.type === 'closed' && r.mode === 'live') {
      // When every destination is gone there is nothing left to stream to: start over.
      const alive = [...r.relays.entries()].some(([k]) => this.dest.get(k)?.state !== 'failed');
      if (r.relays.size > 0 && !alive) void this.killRun(r, true);
    }
    this.changed();
  }

  private onProgress(r: Run1, p: Record<string, string>) {
    if (r !== this.runState) return;
    r.lastProgress = this.now;
    const speed = Number.parseFloat((p.speed ?? '').replace('x', ''));
    const fps = Number.parseFloat(p.fps ?? '');
    let kbps: number | null = null;
    if (r.mode === 'live') {
      let sent = 0;
      for (const rl of r.relays.values()) sent += rl.sent;
      const dt = (this.now - r.lastSentAt) / 1000;
      if (r.relays.size && dt >= 0.5) {
        kbps = Math.round(((sent - r.lastSent) * 8) / dt / 1000 / r.relays.size);
        r.lastSent = sent;
        r.lastSentAt = this.now;
      }
    }
    if (kbps === null) {
      const b = Number.parseFloat((p.bitrate ?? '').replace('kbits/s', ''));
      kbps = Number.isFinite(b) ? Math.round(b) : this.stats.kbps;
    }
    this.stats = {
      ...this.stats,
      kbps,
      fps: Number.isFinite(fps) ? fps : this.stats.fps,
      dropped: Number.parseInt(p.drop_frames ?? '0', 10) || 0,
      speed: Number.isFinite(speed) ? speed : this.stats.speed,
    };
    this.changed();
  }

  private async sample(r: Run1) {
    const pid = r.child.pid;
    if (!pid || r !== this.runState) return;
    if (this.platform !== 'win32') {
      const out = await this.go('ps', ['-o', '%cpu=', '-p', String(pid)], { timeout: 2000 });
      const cpu = Number.parseFloat(out.out);
      if (out.code === 0 && Number.isFinite(cpu)) this.stats = { ...this.stats, cpu };
    }
    if (r.encoder === 'h264_nvenc') {
      const g = await this.go(
        'nvidia-smi',
        ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'],
        { timeout: 3000 },
      );
      const gpu = Number.parseFloat(g.out);
      if (g.code === 0 && Number.isFinite(gpu)) this.stats = { ...this.stats, gpu };
    }
    this.changed();
  }

  private startWatchdog() {
    if (this.watchdog) clearInterval(this.watchdog);
    const limit = this.deps.watchdogMs ?? 12000;
    this.watchdog = setInterval(() => {
      const r = this.runState;
      if (!r || r.ending || r.mode !== 'live') return;
      if (this.now - r.lastProgress > limit) {
        r.tail.push('Hildegard: FFmpeg stopped reporting, so it was ended.');
        void this.killRun(r, true);
      }
    }, 1000);
    this.watchdog.unref?.();
  }

  /** The process exited: on purpose, or not. */
  private async onExit(r: Run1, code: number | null, signal: NodeJS.Signals | null) {
    this.lastLog = r.tail.slice(-40);
    r.progress.close();
    if (r.cpuTimer) clearInterval(r.cpuTimer);
    for (const rl of r.relays.values()) rl.stop();
    this.clearPid();
    if (r !== this.runState) return;
    this.runState = null;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    if (r.ending) return;
    const tail = r.tail.join('\n');
    if (r.mode === 'preview') {
      this.phase = 'idle';
      this.message = explainFfmpeg(tail, this.platform);
      this.changed();
      return;
    }
    // A live stream ended on its own: try again, with waits between.
    const long = this.liveSince !== null && this.now - this.liveSince > 60_000;
    if (long) this.attempt = 0;
    this.liveSince = null;
    const waits = this.deps.backoff ?? DEFAULT_BACKOFF;
    const max = this.deps.maxAttempts ?? 8;
    if (
      this.attempt >= max ||
      (code === 1 &&
        /unrecognized option|no such filter|not found|permission denied|cannot open display/i.test(tail) &&
        this.attempt >= 1)
    ) {
      this.phase = 'idle';
      this.message = `Couldn’t keep the stream going. ${explainFfmpeg(tail, this.platform)}`;
      this.changed();
      return;
    }
    const wait = waits[Math.min(this.attempt, waits.length - 1)]!;
    this.attempt += 1;
    this.phase = 'reconnecting';
    this.message = `Lost the connection${signal ? '' : ''}. Trying again in ${Math.round(wait / 1000)} seconds (try ${this.attempt}).`;
    this.changed();
    const gen = this.gen;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.serial(() => this.begin(gen));
    }, wait);
  }

  /** Ends the current run on purpose and waits for it. `to` is what the streamer is afterwards. */
  private async end(to: 'idle' | 'countdown') {
    const r = this.runState;
    if (!r) return;
    this.phase = to === 'idle' ? 'stopping' : this.phase;
    this.changed();
    await this.killRun(r);
    if (this.runState === r) this.runState = null;
    if (to === 'idle') {
      this.phase = 'idle';
      this.liveSince = null;
      this.stats = { ...EMPTY_STATS };
      this.dest.clear();
      this.attempt = 0;
      if (this.watchdog) clearInterval(this.watchdog);
      this.watchdog = null;
    }
    this.changed();
  }

  /** Ends FFmpeg and everything it started: ask it to finish, then the process group, then no more asking. */
  private async killRun(r: Run1, restart = false) {
    // A restart (the watchdog, every destination lost) leaves `ending` off so onExit starts over; a stop sets it.
    if (!restart) r.ending = true;
    for (const rl of r.relays.values()) rl.stop();
    try {
      r.child.stdin?.write('q\n');
    } catch {}
    const t0 = Date.now();
    this.signal(r.child, 'SIGTERM');
    const hard = setTimeout(() => this.signal(r.child, 'SIGKILL'), 900);
    const give = new Promise<void>((res) => setTimeout(res, 1800));
    await Promise.race([r.exited, give]);
    // FFmpeg leaving isn't the end: anything it started that ignored the ask is still in its group.
    while (this.groupAlive(r.child) && Date.now() - t0 < 900) await sleep(50);
    clearTimeout(hard);
    this.signal(r.child, 'SIGKILL');
    while (this.groupAlive(r.child) && Date.now() - t0 < 1900) await sleep(25);
  }

  /** Signals FFmpeg's whole process group (its tree on Windows), even after FFmpeg itself has exited. */
  private signal(child: ChildProcess, sig: NodeJS.Signals) {
    const pid = child.pid;
    if (!pid) return;
    if (this.platform === 'win32') {
      // The tree is found through FFmpeg, so it has to be asked while FFmpeg is there.
      if (child.exitCode === null && child.signalCode === null)
        execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
      return;
    }
    try {
      process.kill(-pid, sig);
    } catch {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        child.kill(sig);
      } catch {}
    }
  }

  /** Whether anything in FFmpeg's process group is still running (POSIX; on Windows, FFmpeg itself). */
  private groupAlive(child: ChildProcess): boolean {
    const pid = child.pid;
    if (!pid) return false;
    if (this.platform === 'win32') return child.exitCode === null && child.signalCode === null;
    try {
      process.kill(-pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
  }

  /** The server going away takes FFmpeg with it. */
  private hook() {
    if (this.exitHook) return;
    this.exitHook = true;
    process.once('exit', () => {
      const r = this.runState;
      if (r?.child.pid && this.platform !== 'win32') {
        try {
          process.kill(-r.child.pid, 'SIGKILL');
        } catch {}
      }
    });
  }

  async dispose() {
    this.gen++;
    this.clearCountdown();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.runState) await this.end('idle');
  }

  // A stream that outlived the server (it was killed hard) is found by its pid file and ended at the next start.
  private pidFile = () => join(this.dir, 'ffmpeg.pid');
  private writePid(pid: number | undefined) {
    if (!pid) return;
    try {
      writeFileSync(this.pidFile(), String(pid), { mode: 0o600 });
      chmodSync(this.pidFile(), 0o600);
    } catch {}
  }
  private clearPid() {
    rmSync(this.pidFile(), { force: true });
  }
  private reapOrphan() {
    if (this.platform === 'win32') return;
    try {
      const pid = Number.parseInt(readFileSync(this.pidFile(), 'utf8'), 10);
      if (!Number.isInteger(pid) || pid <= 1) return;
      // Only a process that is still our kind of FFmpeg: the marker is in its command line.
      execFile('ps', ['-o', 'command=', '-p', String(pid)], (e, out) => {
        if (!e && /ffmpeg/.test(out) && out.includes('hildegard-stream')) {
          try {
            process.kill(-pid, 'SIGKILL');
          } catch {
            try {
              process.kill(pid, 'SIGKILL');
            } catch {}
          }
        }
        this.clearPid();
      });
    } catch {}
  }

  // ── Preflight ────────────────────────────────────────────────────────────────────────────────────────────────

  devices(): Promise<StreamDevices> {
    return (
      this.deps.devices?.() ??
      listDevices({ platform: this.platform, env: this.deps.env, ffmpeg: this.ffmpeg, run: this.go })
    );
  }

  async preflight(): Promise<StreamPreflight> {
    const checks: StreamPreflight['checks'] = [];
    const add = (id: string, label: string, status: 'pass' | 'warn' | 'fail', detail: string) =>
      checks.push({ id, label, status, detail });
    const v = await this.go(this.ffmpeg, ['-version']);
    const version = /ffmpeg version (\S+)/.exec(v.out)?.[1];
    if (v.code !== 0 || !version) {
      add(
        'ffmpeg',
        'FFmpeg',
        'fail',
        this.platform === 'darwin'
          ? 'FFmpeg isn’t installed. In Terminal: brew install ffmpeg'
          : this.platform === 'win32'
            ? 'FFmpeg isn’t installed. In a terminal: winget install Gyan.FFmpeg'
            : 'FFmpeg isn’t installed. Install the ffmpeg package from your distribution.',
      );
      return { ok: false, checks, encoder: null, uploadMbps: null };
    }
    add('ffmpeg', 'FFmpeg', 'pass', `Version ${version}.`);

    let encoder: EncoderId = 'libx264';
    try {
      encoder = await this.encoderFor();
      this.chosen = encoder;
      add(
        'encoder',
        'Video encoder',
        'pass',
        `${ENCODER_NAMES[encoder]}.${encoder === 'libx264' ? ' It uses your processor; a video card’s encoder is easier on the computer when there is one.' : ''}`,
      );
    } catch (e) {
      add('encoder', 'Video encoder', 'fail', (e as Error).message);
    }

    const dev = await this.devices().catch(() => null);
    const s = this.cfg;
    const need: ('screen' | 'camera' | 'mic')[] = [];
    if (s.scene === 'screen' || s.scene === 'pip') need.push('screen');
    if (s.scene === 'camera' || s.scene === 'pip') need.push('camera');
    if (s.sources.mic) need.push('mic');
    if (!s.sources.mic)
      add('mic', 'Microphone', 'warn', 'No microphone is on, so the stream will be silent.');
    for (const kind of need) {
      const name = { screen: 'Screen', camera: 'Camera', mic: 'Microphone' }[kind];
      const chosen = s.sources[kind];
      if (!chosen) {
        add(kind, name, 'fail', `Pick a ${name.toLowerCase()} for this scene.`);
        continue;
      }
      const list = dev?.[kind === 'screen' ? 'screens' : kind === 'camera' ? 'cameras' : 'mics'] ?? [];
      if (dev && !list.some((d) => d.id === chosen)) {
        add(kind, name, 'fail', `The ${name.toLowerCase()} you picked isn’t here any more. Pick it again.`);
        continue;
      }
      if (chosen === TEST_SOURCE) {
        add(kind, name, 'pass', 'The test pattern.');
        continue;
      }
      // A camera or screen the preview has open can't be opened twice (v4l2, dshow), and the preview shows it works.
      if (kind !== 'mic' && this.runState?.mode === 'preview' && this.runState.sources[kind] === chosen) {
        add(kind, name, 'pass', `${list.find((d) => d.id === chosen)?.label ?? chosen}, in the preview.`);
        continue;
      }
      const why = await (this.deps.probeSource ?? ((k, d) => this.probeSource(k, d)))(kind, chosen);
      if (why) add(kind, name, 'fail', why);
      else add(kind, name, 'pass', list.find((d) => d.id === chosen)?.label ?? chosen);
    }
    for (const n of dev?.notes ?? []) add('note', 'Note', 'warn', n);
    if (!(this.deps.font === undefined ? findFont(this.platform) : this.deps.font))
      add(
        'font',
        'Text',
        'warn',
        'No font was found for FFmpeg to draw text with, so the lower third, caption and cards show no words.',
      );

    const picked = STREAM_DESTINATIONS.filter((d) => s.destinations[d.id]?.enabled);
    if (!picked.length && !s.record)
      add('destination', 'Where to', 'fail', 'Pick where to stream, or turn on recording.');
    let anyNetwork = false;
    for (const d of picked) {
      if (!this.keySet(d.id)) {
        add(`dest-${d.id}`, d.name, 'fail', 'No stream key yet.');
        continue;
      }
      let url: URL;
      try {
        url = new URL(this.serverFor(d.id));
      } catch {
        add(`dest-${d.id}`, d.name, 'fail', 'The server address isn’t one Hildegard can use.');
        continue;
      }
      anyNetwork = true;
      const port = Number(url.port || (url.protocol === 'rtmps:' ? 443 : 1935));
      const ms = await (this.deps.reach ?? reach)(url.hostname, port);
      if (ms === null)
        add(
          `dest-${d.id}`,
          d.name,
          'fail',
          `Couldn’t reach ${url.hostname}. Check your connection and the server address.`,
        );
      else add(`dest-${d.id}`, d.name, 'pass', `${url.hostname} answers in ${ms} ms. The key is saved.`);
    }
    let uploadMbps: number | null = null;
    if (anyNetwork) {
      const kbps = this.deps.kbps ?? this.planKbps(picked.map((d) => d.id));
      uploadMbps = await (this.deps.speedTest ?? speedTest)();
      if (uploadMbps === null)
        add(
          'upload',
          'Upload speed',
          'warn',
          'Couldn’t measure your upload speed. The stream will still try.',
        );
      else {
        const need = (kbps / 1000) * picked.length * 1.0;
        const room = uploadMbps / Math.max(0.1, need);
        const sizes = `${uploadMbps.toFixed(1)} Mbps up; the stream needs ${need.toFixed(1)}.`;
        if (room >= 1.5) add('upload', 'Upload speed', 'pass', sizes);
        else if (room >= 1.1)
          add('upload', 'Upload speed', 'warn', `${sizes} That’s tight. Lower the quality if it stutters.`);
        else
          add(
            'upload',
            'Upload speed',
            'fail',
            `${sizes} That isn’t enough. Lower the quality, or stream to fewer places.`,
          );
      }
    }
    if (s.record) add('record', 'Recording', 'pass', 'A copy of the stream will be saved on this computer.');
    return { ok: !checks.some((c) => c.status === 'fail'), checks, encoder, uploadMbps };
  }

  private planKbps(ids: string[]): number {
    return Math.min(
      STREAM_QUALITY[this.cfg.quality].kbps,
      ...ids.map((i) => STREAM_DESTINATIONS.find((d) => d.id === i)?.adviceKbps ?? 6000),
    );
  }

  /** Opens a source for one frame, to find out whether the computer lets Hildegard have it. */
  private async probeSource(kind: 'screen' | 'camera' | 'mic', device: string): Promise<string | null> {
    const q = STREAM_QUALITY[this.cfg.quality];
    let a: string[] | null;
    try {
      a = inputArgs(kind, device, {
        platform: this.platform,
        width: q.width,
        height: q.height,
        fps: q.fps,
        env: this.deps.env ?? process.env,
      });
    } catch (e) {
      return (e as Error).message;
    }
    if (!a) return null;
    const out = kind === 'mic' ? ['-t', '0.3', '-f', 'null', '-'] : ['-frames:v', '1', '-f', 'null', '-'];
    const r = await this.go(this.ffmpeg, ['-hide_banner', '-loglevel', 'error', ...a, ...out], {
      timeout: 9000,
    });
    return r.code === 0 ? null : explainFfmpeg(r.err, this.platform);
  }
}

const stamp = (ms: number) =>
  new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');

/**
 * Twitch's own list of ingest servers (public, no account), and the nearest of its first few by how fast each answers.
 * Null when Twitch can't be asked, and the default stands.
 */
export async function twitchIngest(
  fetchFn: typeof fetch = fetch,
  ping: (host: string, port: number) => Promise<number | null> = reach,
): Promise<string | null> {
  try {
    const res = await fetchFn('https://ingest.twitch.tv/ingests', { signal: AbortSignal.timeout(3500) });
    if (!res.ok) return null;
    const list =
      ((await res.json()) as { ingests?: { availability?: number; url_template_secure?: string }[] })
        .ingests ?? [];
    const servers = list
      .filter((i) => (i.availability ?? 1) > 0 && typeof i.url_template_secure === 'string')
      .map((i) =>
        i
          .url_template_secure!.replace(/\/\{stream_key\}.*$/, '')
          .replace(/^(rtmps:\/\/[^/:]+)(\/)/, '$1:443$2'),
      )
      // Never pick an unencrypted address on the person's behalf: the key would cross the internet in the clear.
      .filter((u) => u.startsWith('rtmps://') && IngestServer.safeParse(u).success)
      .slice(0, 4);
    const timed = await Promise.all(
      servers.map(async (u) => ({ u, ms: await ping(new URL(u).hostname, Number(new URL(u).port || 443)) })),
    );
    const best = timed.filter((t) => t.ms !== null).sort((a, b) => a.ms! - b.ms!)[0];
    return best?.u ?? null;
  } catch {
    return null;
  }
}

/** How long a TCP connection takes, or null. */
export function reach(host: string, port: number, timeout = 4000): Promise<number | null> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const s = net.connect({ host, port });
    const done = (v: number | null) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(timeout, () => done(null));
    s.once('connect', () => done(Date.now() - t0));
    s.once('error', () => done(null));
  });
}

/**
 * Upload speed to a public speed test (Cloudflare's): 6 MB of zeros. The person asks for it by pressing Check, and
 * it carries nothing of theirs.
 */
export async function speedTest(
  fetchFn: typeof fetch = fetch,
  bytes = 6 * 1024 * 1024,
): Promise<number | null> {
  try {
    const body = new Uint8Array(bytes);
    const t0 = performance.now();
    const res = await fetchFn('https://speed.cloudflare.com/__up', {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/octet-stream' },
      signal: AbortSignal.timeout(15_000),
    });
    await res.arrayBuffer();
    const sec = (performance.now() - t0) / 1000;
    return res.ok && sec > 0 ? (bytes * 8) / sec / 1e6 : null;
  } catch {
    return null;
  }
}

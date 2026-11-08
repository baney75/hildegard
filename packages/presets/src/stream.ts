// SPDX-License-Identifier: Apache-2.0
/**
 * Go live: where a stream can go, how it is composed, and what the Studio, the MCP and the CLI may know of it. The
 * destinations' stream keys are not here and never travel through any of these types: the server keeps them in the
 * keychain and only says whether one is set.
 */
import { z } from 'zod';

export const StreamDestinationId = z.enum(['youtube', 'x', 'twitch', 'kick', 'custom']);
export type StreamDestinationId = z.infer<typeof StreamDestinationId>;

export interface StreamDestinationPreset {
  id: StreamDestinationId;
  name: string;
  /** The ingest server, without the key. Where it can differ per account, the person can change it. */
  server: string;
  /** Whether the person must say which server (their dashboard shows it), or this one is right for everyone. */
  serverFromAccount: boolean;
  /** The most the service takes, kilobits a second; the stream never goes above the lowest of its destinations. */
  maxKbps: number;
  /** The service's own advice, kilobits a second, for 1080p at 30 frames. */
  adviceKbps: number;
  /** Where the person finds the key. */
  keyHelp: string;
  /** Services that take only H.264 (every one here does; Hildegard sends nothing else). */
  h264Only: boolean;
}

export const STREAM_DESTINATIONS: readonly StreamDestinationPreset[] = [
  {
    id: 'youtube',
    name: 'YouTube Live',
    server: 'rtmps://a.rtmps.youtube.com:443/live2',
    serverFromAccount: false,
    maxKbps: 9000,
    adviceKbps: 6000,
    keyHelp: 'YouTube Studio, Create, Go live, Stream. Copy the stream key.',
    h264Only: true,
  },
  {
    id: 'x',
    name: 'X',
    server: 'rtmps://va.pscp.tv:443/x',
    serverFromAccount: true,
    maxKbps: 8000,
    adviceKbps: 6000,
    keyHelp: 'X Live Studio (studio.x.com), Create broadcast, Source. Copy the URL and the key it shows.',
    h264Only: true,
  },
  {
    id: 'twitch',
    name: 'Twitch',
    server: 'rtmps://ingest.global-contribute.live-video.net:443/app',
    serverFromAccount: false,
    maxKbps: 6000,
    adviceKbps: 6000,
    keyHelp: 'Twitch Creator Dashboard, Settings, Stream. Copy the primary stream key.',
    h264Only: true,
  },
  {
    id: 'kick',
    name: 'Kick',
    server: 'rtmps://fa723fc1b171.global-contribute.live-video.net:443/app',
    serverFromAccount: true,
    maxKbps: 8000,
    adviceKbps: 6000,
    keyHelp: 'Kick Creator Dashboard, Stream. Copy the stream URL and the stream key.',
    h264Only: true,
  },
  {
    id: 'custom',
    name: 'Custom RTMP',
    server: '',
    serverFromAccount: true,
    maxKbps: 12000,
    adviceKbps: 6000,
    keyHelp: 'The server address and stream key your service gives you.',
    h264Only: true,
  },
];

export const StreamScene = z.enum(['screen', 'camera', 'pip', 'starting', 'brb']);
export type StreamScene = z.infer<typeof StreamScene>;
export const STREAM_SCENES: { id: StreamScene; name: string }[] = [
  { id: 'screen', name: 'Screen' },
  { id: 'camera', name: 'Camera' },
  { id: 'pip', name: 'Camera over screen' },
  { id: 'starting', name: 'Starting soon' },
  { id: 'brb', name: 'Be right back' },
];

export const StreamQuality = z.enum(['720p30', '1080p30', '1080p60']);
export type StreamQuality = z.infer<typeof StreamQuality>;
export const STREAM_QUALITY: Record<
  StreamQuality,
  { width: number; height: number; fps: number; kbps: number }
> = {
  '720p30': { width: 1280, height: 720, fps: 30, kbps: 4000 },
  '1080p30': { width: 1920, height: 1080, fps: 30, kbps: 6000 },
  '1080p60': { width: 1920, height: 1080, fps: 60, kbps: 9000 },
};

/** `test` is a built-in pattern and tone: it checks a stream key or an ingest without showing anything of yours. */
const Device = z.string().max(300);
const Text = z.string().max(120);

/** A server address for a destination: RTMP or RTMPS, no login or key in it, only a plain path. */
export const IngestServer = z
  .string()
  .max(300)
  .refine((s) => {
    try {
      const u = new URL(s);
      return (
        (u.protocol === 'rtmp:' || u.protocol === 'rtmps:') &&
        !u.username &&
        !u.password &&
        !u.search &&
        !u.hash &&
        u.hostname !== '' &&
        /^\/[A-Za-z0-9._~-]+$/.test(u.pathname) &&
        !/^\/\.\.?$/.test(u.pathname)
      );
    } catch {
      return false;
    }
  }, 'An rtmp:// or rtmps:// address with one application name, like rtmps://host/live. The stream key goes in its own box.');

export const StreamSettings = z
  .object({
    scene: StreamScene.default('screen'),
    pip: z
      .object({
        corner: z.enum(['tl', 'tr', 'bl', 'br']).default('br'),
        /** The camera's width as a percentage of the picture. */
        size: z.number().int().min(10).max(50).default(24),
      })
      .default({ corner: 'br', size: 24 }),
    sources: z
      .object({
        screen: Device.nullable().default(null),
        camera: Device.nullable().default(null),
        mic: Device.nullable().default(null),
      })
      .default({ screen: null, camera: null, mic: null }),
    quality: StreamQuality.default('1080p30'),
    /** `auto` picks the computer's hardware encoder when it works, else software. */
    encoder: z.enum(['auto', 'software']).default('auto'),
    destinations: z
      .partialRecord(
        StreamDestinationId,
        z.object({ enabled: z.boolean().default(false), server: IngestServer.nullable().default(null) }),
      )
      .default({}),
    lowerThird: z
      .object({ on: z.boolean().default(false), name: Text.default(''), title: Text.default('') })
      .default({ on: false, name: '', title: '' }),
    caption: z
      .object({ on: z.boolean().default(false), text: Text.default('') })
      .default({ on: false, text: '' }),
    /** A PNG or JPEG on this computer, shown in the top right corner. */
    logo: z.string().max(500).nullable().default(null),
    record: z.boolean().default(false),
    mute: z.boolean().default(false),
  })
  .strict();
export type StreamSettings = z.infer<typeof StreamSettings>;
export const DEFAULT_STREAM_SETTINGS: StreamSettings = StreamSettings.parse({});

export type StreamPhase = 'idle' | 'preview' | 'countdown' | 'live' | 'reconnecting' | 'stopping';
export type StreamDestinationState = 'off' | 'connecting' | 'live' | 'failed';

export interface StreamDestinationView {
  id: StreamDestinationId;
  name: string;
  /** Whether a key is saved. The key itself is never sent anywhere. */
  keySet: boolean;
  enabled: boolean;
  /** The server it goes to (no key), so the person can see and change it. */
  server: string;
  serverFromAccount: boolean;
  keyHelp: string;
  state: StreamDestinationState;
  /** In words, when something is wrong. */
  detail: string | null;
}

export interface StreamStats {
  kbps: number | null;
  fps: number | null;
  /** Frames the encoder could not keep up with, since going live. */
  dropped: number;
  /** The encoder's share of one CPU core, in percent. */
  cpu: number | null;
  gpu: number | null;
  /** 1 is real time; under 1 means the computer can’t keep up. */
  speed: number | null;
}

export interface StreamState {
  phase: StreamPhase;
  scene: StreamScene;
  /** Seconds left in the countdown. */
  countdown: number | null;
  /** Seconds since the stream began; null when not live. */
  seconds: number | null;
  encoder: string | null;
  quality: StreamQuality;
  kbps: number | null;
  destinations: StreamDestinationView[];
  stats: StreamStats;
  /** Reconnect attempt number, while trying again. */
  attempt: number;
  /** What is happening or went wrong, in a sentence. */
  message: string | null;
  /** Where the local recording is, for the person on this computer; true when one is being made. */
  recording: boolean;
  settings: StreamSettings;
  /** Whether this request may start a stream: only the person at this computer, in the Studio. */
  canStart: boolean;
}

export interface StreamCheck {
  id: string;
  label: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
}
export interface StreamPreflight {
  ok: boolean;
  checks: StreamCheck[];
  encoder: string | null;
  /** Measured upload, megabits a second; null when not measured. */
  uploadMbps: number | null;
}

export interface StreamDevice {
  id: string;
  label: string;
}
export interface StreamDevices {
  platform: string;
  screens: StreamDevice[];
  cameras: StreamDevice[];
  mics: StreamDevice[];
  /** What to do when something isn't there, such as a permission or Wayland. */
  notes: string[];
}

export interface ObsState {
  /** OBS Studio answers on its WebSocket port. */
  found: boolean;
  /** The person's password is needed (or wrong). */
  needsPassword: boolean;
  connected: boolean;
  scenes: string[];
  currentScene: string | null;
  streaming: boolean;
  version: string | null;
  detail: string | null;
}

// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The few facts about streaming the Studio needs from packages/presets/src/stream.ts, without bundling its schema
 * library. test/stream.test.ts holds the two copies equal.
 */
import type { StreamQuality, StreamScene } from '@hildegard/presets';

export const STREAM_QUALITY: Record<
  StreamQuality,
  { width: number; height: number; fps: number; kbps: number }
> = {
  '720p30': { width: 1280, height: 720, fps: 30, kbps: 4000 },
  '1080p30': { width: 1920, height: 1080, fps: 30, kbps: 6000 },
  '1080p60': { width: 1920, height: 1080, fps: 60, kbps: 9000 },
};

export const STREAM_SCENES: { id: StreamScene; name: string }[] = [
  { id: 'screen', name: 'Screen' },
  { id: 'camera', name: 'Camera' },
  { id: 'pip', name: 'Camera over screen' },
  { id: 'starting', name: 'Starting soon' },
  { id: 'brb', name: 'Be right back' },
];

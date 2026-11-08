// SPDX-License-Identifier: AGPL-3.0-only
// Go live asks macOS for the camera, the microphone and the screen. The words it shows are in Info.plist, and the
// hardened runtime needs the matching entitlements; Tauri bundles both from what the config names.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const tauri = join(dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri');
const read = (f: string) => readFileSync(join(tauri, f), 'utf8');
const conf = JSON.parse(read('tauri.conf.json')) as {
  bundle: { macOS: { entitlements?: string }; linux: { deb: { recommends: string[] } } };
};

describe('what macOS shows when Go live asks for a device', () => {
  const plist = read('Info.plist');
  const string = (key: string) =>
    new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`).exec(plist)?.[1];

  it('says in a sentence why the camera, the microphone and the screen are wanted', () => {
    for (const key of [
      'NSCameraUsageDescription',
      'NSMicrophoneUsageDescription',
      'NSScreenCaptureUsageDescription',
    ]) {
      const words = string(key);
      expect(words, key).toBeTruthy();
      expect(words!.length, key).toBeGreaterThan(40);
      // Plain, second person, and no straight quotes.
      expect(words, key).not.toMatch(/["']/);
      expect(words, key).toMatch(/^Hildegard /);
    }
  });

  it('is a plist that can be merged: one dict, no stray keys', () => {
    expect(plist.match(/<dict>/g)).toHaveLength(1);
    expect([...plist.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1])).toEqual([
      'NSCameraUsageDescription',
      'NSMicrophoneUsageDescription',
      'NSScreenCaptureUsageDescription',
    ]);
  });

  it('is backed by entitlements the bundle names, for the camera and the microphone and nothing else', () => {
    const name = conf.bundle.macOS.entitlements;
    expect(name).toBe('Entitlements.plist');
    expect(existsSync(join(tauri, name!))).toBe(true);
    const keys = [...read(name!).matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]);
    expect(keys).toEqual(['com.apple.security.device.camera', 'com.apple.security.device.audio-input']);
  });

  it('recommends FFmpeg on Linux, where a package can', () => {
    expect(conf.bundle.linux.deb.recommends).toContain('ffmpeg');
  });
});

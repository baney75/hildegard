// SPDX-License-Identifier: AGPL-3.0-only
// The Studio in the app's window can record (Record in the Studio needs the camera and microphone), on each system, and
// the app's own start-up page still can't do more than before.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const tauri = join(import.meta.dirname, '..', 'src-tauri');
// A Windows checkout turns line endings into CRLF; these files are read for their text, not their line endings.
const read = (f: string) => readFileSync(join(tauri, f), 'utf8').replace(/\r\n/g, '\n');
/** The string value under a key in a plist. */
const plistString = (plist: string, key: string) =>
  new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`).exec(plist)?.[1];
const plistTrue = (plist: string, key: string) => new RegExp(`<key>${key}</key>\\s*<true/>`).test(plist);

describe('camera and microphone in the app', () => {
  it('macOS: the usage strings the system shows when asking, in Info.plist, which the bundler merges', () => {
    const info = read('Info.plist');
    for (const key of ['NSMicrophoneUsageDescription', 'NSCameraUsageDescription']) {
      const text = plistString(info, key);
      expect(text, key).toBeTruthy();
      expect(text!.length, key).toBeGreaterThan(40);
      // When it is used, and that recordings stay on this computer.
      expect(text, key).toMatch(/only when you tap Record/);
      expect(text, key).toMatch(/stay on this computer/);
    }
  });

  it('macOS: the signed app is entitled to the microphone and camera, and the config points at the entitlements', () => {
    const ent = read('Entitlements.plist');
    expect(plistTrue(ent, 'com.apple.security.device.audio-input')).toBe(true);
    expect(plistTrue(ent, 'com.apple.security.device.camera')).toBe(true);
    const conf = JSON.parse(read('tauri.conf.json')) as { bundle: { macOS: { entitlements?: string } } };
    expect(conf.bundle.macOS.entitlements).toBe('Entitlements.plist');
  });

  it('every system: the window allows the camera and microphone for the Studio only, and refuses them elsewhere', () => {
    const lib = read('src/lib.rs');
    expect(lib).toMatch(/\.on_permission_request\(/);
    expect(lib).toMatch(
      /PermissionKind::Microphone \| PermissionKind::Camera \| PermissionKind::DisplayCapture/,
    );
    expect(lib).toMatch(/media::may_capture\(&url, None, studio_port\.load/);
    // Not the Studio (or no address to judge by): refused, never allowed by default.
    expect(lib).toMatch(/_ => PermissionResponse::Deny/);
    expect(lib).not.toMatch(/PermissionResponse::Allow,\s*_ => PermissionResponse::Allow/);
  });

  it('the screen: shared from the Studio only, and the Studio hides Screen where the window can’t share it', () => {
    // WebKitGTK asks as DisplayCapture, judged like the camera (above); the notes say what each system does.
    const media = read('src/media.rs');
    expect(media).toMatch(/Linux, WebKitGTK: .*DisplayCapture/);
    expect(media).toMatch(/Windows, WebView2: `getDisplayMedia` works/);
    expect(media).toMatch(/macOS, WKWebView: WebKit gives an app's web view no `getDisplayMedia`/);
    // The Studio looks for getDisplayMedia itself and gives a one-line reason in place of failing.
    const capture = readFileSync(join(tauri, '..', '..', 'studio', 'src', 'lib', 'capture.ts'), 'utf8');
    expect(capture).toMatch(/typeof navigator\.mediaDevices\?\.getDisplayMedia !== 'function'/);
    expect(capture).toMatch(/This window can’t share the screen\./);
    // Nothing else is granted the screen: no default allow for it.
    expect(read('src/lib.rs')).not.toMatch(/DisplayCapture\s*=>\s*PermissionResponse::Allow/);
  });

  it('Linux: MediaStream is switched on in WebKitGTK, with the same crate version Tauri uses', () => {
    expect(read('src/media.rs')).toContain('set_enable_media_stream(true)');
    const cargo = read('Cargo.toml');
    const dep =
      /\[target\.'cfg\(target_os = "linux"\)'\.dependencies\]\s*webkit2gtk = \{ version = "=([\d.]+)"/.exec(
        cargo,
      );
    expect(dep).not.toBeNull();
    const lock = read('Cargo.lock');
    expect(lock).toContain(`name = "webkit2gtk"\nversion = "${dep![1]}"`);
    // The packaged app carries GStreamer's codecs MediaRecorder needs.
    const conf = JSON.parse(read('tauri.conf.json')) as {
      bundle: { linux: { deb: { recommends: string[] }; appimage: { bundleMediaFramework: boolean } } };
    };
    expect(conf.bundle.linux.appimage.bundleMediaFramework).toBe(true);
    expect(conf.bundle.linux.deb.recommends).toEqual(
      expect.arrayContaining(['gstreamer1.0-plugins-good', 'gstreamer1.0-plugins-bad']),
    );
  });

  it('Windows: WebView2 asks through the same handler; the app grants the Studio no commands with it', () => {
    // The Studio is loaded from http://127.0.0.1 and the only capability is the start-up page's own commands.
    const main = JSON.parse(read('capabilities/main.json')) as { permissions: string[]; remote?: unknown };
    expect(main.remote).toBeUndefined();
    expect(main.permissions.sort()).toEqual(['allow-install', 'allow-launch', 'allow-open-logs']);
    const conf = JSON.parse(read('tauri.conf.json')) as {
      app: { security: { csp: Record<string, string> } };
    };
    // The start-up page's policy didn't widen to let it load anything new.
    expect(conf.app.security.csp['connect-src']).toBe('ipc: http://ipc.localhost');
    expect(conf.app.security.csp['frame-src']).toBe("'none'");
  });
});

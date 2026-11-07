// SPDX-License-Identifier: AGPL-3.0-only
// Test-side audio: runs test/fixtures/audio_check.py, which makes noisy speech and films and measures files without
// using tools/voice_clean.py, so the cleaner is never graded by its own meter.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { exportPython } from '../src/export.ts';

// Absolute, so a test can empty PATH and still start it.
const found = exportPython('/nonexistent');
export const py = execFileSync(found, ['-c', 'import sys; print(sys.executable)'], {
  encoding: 'utf8',
}).trim();
export const voiceCleanScript = fileURLToPath(new URL('../../../tools/voice_clean.py', import.meta.url));
export const exportScript = fileURLToPath(new URL('../../../tools/export_film.py', import.meta.url));
const checker = fileURLToPath(new URL('./fixtures/audio_check.py', import.meta.url));

export const check = <T = Record<string, number>>(...args: string[]): T =>
  JSON.parse(
    execFileSync(py, ['-I', checker, ...args], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .at(-1)!,
  ) as T;
/** Writes a file with the helper (speech, video, film). */
export const make = (...args: string[]) =>
  void execFileSync(py, ['-I', checker, ...args], { encoding: 'utf8' });
export const measure = (file: string) =>
  check<{ lufs: number; true_peak: number; seconds: number }>('measure', file);
export const info = (file: string) =>
  check<{ types: string[]; seconds: number | null; audio_seconds: number; channels: number }>('info', file);

/** Runs a Hildegard Python tool on a spec file; returns its last JSON line (success or failure). */
export function runTool(script: string, spec: string, env: NodeJS.ProcessEnv = {}) {
  try {
    const out = execFileSync(py, ['-I', script, spec], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return JSON.parse(out.trim().split('\n').at(-1)!) as Record<string, unknown>;
  } catch (e) {
    const out = (e as { stdout?: string }).stdout ?? '';
    return JSON.parse(out.trim().split('\n').at(-1)!) as Record<string, unknown>;
  }
}

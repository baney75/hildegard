// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Technical review of finished media with tools/review_media.py, on the Python that ComfyUI runs on (PyAV, numpy and
 * Pillow come with it). The checks are the measurable half of the quality gate; the rubric is the other half.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface Check {
  id: string;
  status: 'pass' | 'warn' | 'fail';
  value: unknown;
  limit: unknown;
  detail: string;
}

export interface Review {
  kind: 'video' | 'image' | 'audio' | 'mesh' | 'web';
  info: Record<string, unknown>;
  checks: Check[];
  /** No check failed. */
  passed: boolean;
}

export interface ReviewSpec {
  /** The file to check. */
  path: string;
  /** Where to write a contact sheet (JPEG) to look at, if wanted. */
  sheet?: string;
  /** Hold it to the bar for a final render, not a draft. */
  final?: boolean;
  /** The length the brief asked for, in seconds. */
  seconds?: number;
  /** Whether the brief asked for sound. */
  audio?: boolean;
  /** A film of several shots, with cuts, rather than one shot. */
  film?: boolean;
}

/** A 3D model to check with tools/review_mesh.py. */
export interface MeshSpec {
  /** A GLB, glTF (embedded buffers), STL, OBJ or PLY file. */
  path: string;
  /** Where to write the turntable sheet (JPEG): eight views around it, one above or below, and silhouettes. */
  sheet?: string;
  /** Hold it to the bar for a 3D print: watertight, millimetres, fits the bed, a base, few overhangs. */
  print?: boolean;
  /** The size the brief asked for, in millimetres (any order). */
  size_mm?: [number, number, number];
  /** The printer's build volume, in millimetres; 256 × 256 × 256 unless given. */
  bed_mm?: [number, number, number];
  /** More triangles than this is a warning. */
  max_triangles?: number;
  /** Which axis is up in the file. By default y for GLB and glTF (as their specification says), z for STL and PLY, and for OBJ z when printing, y otherwise. */
  up?: 'y' | 'z';
}

export class ReviewError extends Error {}

/** Runs the review. `python` must have PyAV, numpy and Pillow; `script` is tools/review_media.py. */
export function reviewMedia(
  python: string,
  script: string,
  spec: ReviewSpec,
  timeoutMs = 120_000,
): Promise<Review> {
  return runReview(python, script, spec, timeoutMs);
}

/** Checks a 3D model. `python` must have numpy and Pillow; `script` is tools/review_mesh.py. */
export function reviewMesh(
  python: string,
  script: string,
  spec: MeshSpec,
  timeoutMs = 180_000,
): Promise<Review> {
  return runReview(python, script, spec, timeoutMs);
}

function runReview(python: string, script: string, spec: object, timeoutMs: number): Promise<Review> {
  const dir = mkdtempSync(join(tmpdir(), 'hg-review-'));
  const specPath = join(dir, 'spec.json');
  writeFileSync(specPath, JSON.stringify(spec));
  return new Promise<Review>((resolve, reject) => {
    const child = spawn(python, ['-I', script, specPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      err += d.toString();
    });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.once('error', (e) => {
      clearTimeout(timer);
      reject(new ReviewError(`Could not run the media check with ${python}: ${e.message}`));
    });
    child.once('close', () => {
      clearTimeout(timer);
      const line = out.trim().split('\n').at(-1) ?? '';
      let r: { ok: boolean; error?: string; kind: Review['kind']; info: Review['info']; checks: Check[] };
      try {
        r = JSON.parse(line);
      } catch {
        reject(
          new ReviewError(
            `The media check stopped without an answer. ${err.trim().split('\n').at(-1) ?? ''}`.trim(),
          ),
        );
        return;
      }
      if (!r.ok) {
        reject(new ReviewError(r.error ?? 'The media check failed.'));
        return;
      }
      resolve({
        kind: r.kind,
        info: r.info,
        checks: r.checks,
        passed: !r.checks.some((c) => c.status === 'fail'),
      });
    });
  }).finally(() => rmSync(dir, { recursive: true, force: true }));
}

/** One line per check that didn't pass, for a person or a model to act on. */
export function describeReview(r: Review): string {
  const bad = r.checks.filter((c) => c.status !== 'pass');
  const head = r.passed
    ? bad.length
      ? `Technical checks passed, with ${bad.length} to judge:`
      : 'Technical checks passed.'
    : `Technical checks failed (${bad.filter((c) => c.status === 'fail').length}):`;
  return [
    head,
    ...bad.map(
      (c) =>
        `- ${c.status === 'fail' ? 'FAIL' : 'warn'} ${c.id} = ${JSON.stringify(c.value)} (limit ${JSON.stringify(c.limit)}). ${c.detail}`,
    ),
  ].join('\n');
}

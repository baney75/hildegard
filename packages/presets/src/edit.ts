// SPDX-License-Identifier: Apache-2.0
/**
 * Video edits as the API and the Studio see them. The edit list itself (`edl.json`) is described by the JSON Schema in
 * tools/hgedit/edl.schema.json; here it stays an open object, because the script that renders it is what checks it.
 */

export interface EditCheckProblem {
  /** The field, as a person would find it: `keep[2].end`. Empty for the list as a whole. */
  path: string;
  message: string;
}

export interface EditCheck {
  ok: boolean;
  errors: EditCheckProblem[];
  warnings: EditCheckProblem[];
  /** What the list makes: length, frames, size, pieces, hidden stretches. Null when it couldn't be read. */
  summary: {
    seconds: number;
    frames: number;
    fps: number;
    segments: number;
    width: number;
    height: number;
    cues: number;
    titles: number;
    blur: number;
    chapters: number;
    pauses_cut: number;
    pauses_kept: number;
    target: string;
    music: boolean;
  } | null;
}

export interface EditJobView {
  kind: 'check' | 'plan' | 'render' | 'verify';
  status: 'running' | 'done' | 'failed';
  stage: string | null;
  done: number | null;
  total: number | null;
  error: string | null;
}

export interface EditRenderView {
  /** The finished video, `/media/edits/<owner>/<id>/out.mp4`. */
  url: string;
  /** Where the video is on this computer, for this computer itself; null for anyone else. */
  file: string | null;
  /** The contact sheet of the cut, with its joins. */
  sheetUrl: string | null;
  sheet: boolean;
  seconds: number;
  frames: number;
  width: number;
  height: number;
  fps: number;
  encoder: string;
  lufs: number | null;
  truePeak: number | null;
  audioTracks: number;
  chaptersEmbedded: boolean;
  warnings: EditCheckProblem[];
  at: string;
}

export interface EditVerifyCheck {
  id: string;
  status: 'pass' | 'fail' | 'warn' | 'skip';
  detail: string;
  unproven?: boolean;
}

export interface EditVerifyView {
  /** True only when no check failed. `unproven` lists checks that could not run (OCR without tesseract). */
  ok: boolean;
  checks: EditVerifyCheck[];
  unproven: string[];
  error: string | null;
  at: string;
}

export interface EditView {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** The edit list. Footage is named `recording:<id>`, `export:<id>` or `edit:<id>`. */
  edl: Record<string, unknown>;
  check: EditCheck | null;
  job: EditJobView | null;
  render: EditRenderView | null;
  verify: EditVerifyView | null;
  /** What the last plan did: cuts by kind, notes, lengths. */
  plan: Record<string, unknown> | null;
}

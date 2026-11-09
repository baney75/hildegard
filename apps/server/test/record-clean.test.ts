// SPDX-License-Identifier: AGPL-3.0-only
// CleanJobs: an identical request joins the job already waiting, and nobody can queue cleanups without limit.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Entry, RecordError, type RecordStore } from '../src/record.ts';
import {
  CleanJobs,
  type CleanResult,
  type CleanSpec,
  MAX_PENDING_CLEANS,
  MAX_PENDING_CLEANS_PER_OWNER,
} from '../src/record-clean.ts';

const SETTINGS = { targetLufs: -16, peak: -1.5 };
const entry = (id: string, owner = 'hilde') => ({ id, owner, state: 'received', kind: 'voice' }) as Entry;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'hg-clean-jobs-'));
  let n = 0;
  const store = {
    path: (e: Entry) => join(dir, `${e.id}.wav`),
    exists: () => true,
    newId: () => `rec_${++n}`,
    dir: () => dir,
    addCleaned: (e: Entry) => e,
    view: (e: Entry) => e,
  } as unknown as RecordStore;
  const runs: Array<{ spec: CleanSpec; finish: () => void }> = [];
  const run = (spec: CleanSpec) =>
    new Promise<CleanResult>((resolve) => {
      runs.push({
        spec,
        finish: () => {
          writeFileSync(spec.out, 'x');
          resolve({ lufs: -16, true_peak: -2, seconds: 1, backend: 'test' });
        },
      });
    });
  return { jobs: new CleanJobs({ dataDir: dir, store, run }), runs };
}
const flush = () => new Promise((r) => setTimeout(r, 5));

describe('CleanJobs', () => {
  it('gives a repeated request the job already pending, and does the work once', async () => {
    const { jobs, runs } = setup();
    const a = jobs.start(entry('rec_a'), SETTINGS);
    const b = jobs.start(entry('rec_a'), { ...SETTINGS });
    expect(b.id).toBe(a.id);
    await flush();
    expect(runs).toHaveLength(1);
  });

  it('treats other settings or another recording as new work', () => {
    const { jobs } = setup();
    const a = jobs.start(entry('rec_a'), SETTINGS);
    expect(jobs.start(entry('rec_a'), { targetLufs: -23, peak: -1.5 }).id).not.toBe(a.id);
    expect(jobs.start(entry('rec_b'), SETTINGS).id).not.toBe(a.id);
  });

  it('starts fresh once the identical job has finished, and a finished job no longer counts', async () => {
    const { jobs, runs } = setup();
    for (let i = 0; i < MAX_PENDING_CLEANS_PER_OWNER; i++) jobs.start(entry(`rec_${i}`), SETTINGS);
    const first = jobs.get(jobs.start(entry('rec_0'), SETTINGS).id)!;
    await flush();
    runs[0]!.finish();
    await flush();
    expect(first.status).toBe('done');
    expect(jobs.start(entry('rec_0'), SETTINGS).id).not.toBe(first.id);
  });

  it('caps what one person can have pending, with a plain answer, and leaves others alone', () => {
    const { jobs } = setup();
    for (let i = 0; i < MAX_PENDING_CLEANS_PER_OWNER; i++) jobs.start(entry(`rec_${i}`), SETTINGS);
    let refused: unknown;
    try {
      jobs.start(entry('rec_over'), SETTINGS);
    } catch (e) {
      refused = e;
    }
    expect(refused).toBeInstanceOf(RecordError);
    expect(refused).toMatchObject({ status: 429, code: 'queue' });
    expect(() => jobs.start(entry('rec_other', 'otto'), SETTINGS)).not.toThrow();
  });

  it('caps what everyone together can have pending', () => {
    const { jobs } = setup();
    for (let i = 0; i < MAX_PENDING_CLEANS; i++) jobs.start(entry(`rec_${i}`, `person_${i}`), SETTINGS);
    expect(() => jobs.start(entry('rec_over', 'someone_new'), SETTINGS)).toThrow(RecordError);
  });
});

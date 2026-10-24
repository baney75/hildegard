// SPDX-License-Identifier: AGPL-3.0-only
import type { Catalog, ShotRequest } from '@hildegard/presets';
import { useSyncExternalStore } from 'react';

/** What the composer holds between visits: the next shot as the person is directing it. */
export interface Draft {
  prompt: string;
  startFrame: { name: string; url: string } | null;
  /** Characters cast in the shot, by id: their references draw its start frame. */
  cast: string[];
  rig: { body: string; lens: string; focal: number; aperture: number };
  motion: Array<{ id: string; strength: number }>;
  look: { lighting?: string; palette?: string; genre?: string; era?: string };
  format: { aspect: string; seconds: number; quality: 'draft' | 'final' };
  model: string | null;
  /** A number when the seed is locked; null for a fresh seed each time. */
  seed: number | null;
  takes: number;
}

const KEY = 'hildegard.draft';
export const DEFAULT_DRAFT: Draft = {
  prompt: '',
  startFrame: null,
  cast: [],
  rig: { body: 'full-frame', lens: 'clean', focal: 35, aperture: 2.8 },
  motion: [],
  look: {},
  format: { aspect: '16:9', seconds: 5, quality: 'draft' },
  model: null,
  seed: null,
  takes: 2,
};

function load(): Draft {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_DRAFT, ...(JSON.parse(raw) as Partial<Draft>) };
  } catch {}
  return DEFAULT_DRAFT;
}

let draft = load();
const listeners = new Set<() => void>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

export function setDraft(patch: Partial<Draft> | ((d: Draft) => Partial<Draft>)) {
  draft = { ...draft, ...(typeof patch === 'function' ? patch(draft) : patch) };
  for (const l of listeners) l();
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(draft));
    } catch {}
  }, 200);
}

export const getDraft = () => draft;

export function useDraft(): Draft {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => draft,
  );
}

/** Drop choices the catalog no longer has (a preset renamed between versions), so a stale draft never fails. */
export function reconcile(c: Catalog) {
  const d = draft;
  const has = <T extends { id: string }>(list: T[], id: string | undefined) =>
    !id || list.some((x) => x.id === id);
  const fix: Partial<Draft> = {};
  if (!has(c.bodies, d.rig.body) || !has(c.lenses, d.rig.lens) || !c.focals.some((f) => f.mm === d.rig.focal))
    fix.rig = DEFAULT_DRAFT.rig;
  const motion = d.motion.filter((m) => has(c.motions, m.id));
  if (motion.length !== d.motion.length) fix.motion = motion;
  const look = { ...d.look };
  if (!has(c.lightings, look.lighting)) delete look.lighting;
  if (!has(c.palettes, look.palette)) delete look.palette;
  if (!has(c.genres, look.genre)) delete look.genre;
  if (!has(c.eras, look.era)) delete look.era;
  fix.look = look;
  if (!c.aspects.some((a) => a.id === d.format.aspect)) fix.format = { ...d.format, aspect: '16:9' };
  if (d.model && !c.models.some((m) => m.id === d.model)) fix.model = null;
  setDraft(fix);
}

export function toRequest(d: Draft, model: string | null): ShotRequest {
  return {
    prompt: d.prompt.trim(),
    rig: d.rig,
    motion: d.motion,
    look: d.look,
    format: d.format,
    model: model ?? undefined,
    seed: d.seed ?? undefined,
    takes: d.takes,
    // A cast draws the start frame, so it takes the place of one.
    startFrame: d.cast.length ? undefined : d.startFrame?.name,
    characters: d.cast,
  } as ShotRequest;
}

/** Load a take's settings back into the composer ("Reuse settings"). */
export function fromRequest(r: ShotRequest, seed?: number): Partial<Draft> {
  return {
    prompt: r.prompt,
    rig: r.rig,
    motion: r.motion,
    look: r.look,
    format: r.format,
    model: r.model ?? null,
    seed: seed ?? r.seed ?? null,
    takes: r.takes,
    startFrame: r.startFrame ? { name: r.startFrame, url: `/media/uploads/${r.startFrame}` } : null,
    cast: r.characters ?? [],
  };
}

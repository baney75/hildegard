// SPDX-License-Identifier: AGPL-3.0-only
import type { Catalog, HfState, ModelState } from '@hildegard/presets';
import { videoModels } from './format.ts';

type Model = Catalog['models'][number];

/** The first video model to offer someone setting up, and why it's the one. */
export interface FirstPick {
  model: Model;
  state: ModelState | undefined;
  /** One short line on why this model, for the card. */
  why: string;
  /** It needs Hugging Face linked before it can download. */
  needsLink: boolean;
}

/**
 * The video model to start with: one already on its way, else the first in the catalog's order (newest first) that
 * fits this computer and can download now, else one that fits but needs Hugging Face. When the GPU is unknown, the
 * smallest that downloads now. Null when no video model runs here: the computer renders on another device instead.
 */
export function firstPick(catalog: Catalog, models: ModelState[], hf: HfState | null): FirstPick | null {
  const all = videoModels(catalog).map((model) => ({ model, state: models.find((s) => s.id === model.id) }));
  const linked = !!hf?.linked;
  const open = (m: (typeof all)[number]) => !(m.state?.gated ?? m.model.gated) || linked;
  const make = (m: (typeof all)[number], why: string): FirstPick => ({ ...m, why, needsLink: !open(m) });

  const going = all.find((m) => m.state?.installed || m.state?.downloading);
  if (going) return make(going, going.state?.installed ? 'Installed on this computer' : 'Downloading now');

  const runs = all.filter((m) => m.state?.fit !== 'no' && m.state?.fitWhy !== 'apple-gpu');
  if (!runs.length) return null;
  const fits = runs.filter((m) => m.state?.fit === 'fits');
  const fitsOpen = fits.find(open);
  if (fitsOpen) return make(fitsOpen, 'Fits this computer’s GPU');
  if (fits[0]) return make(fits[0], 'Fits this computer’s GPU');
  const tight = runs.find((m) => m.state?.fit === 'tight' && open(m));
  if (tight) return make(tight, 'Runs on this GPU, a little slowly');
  // The GPU is unknown: the smallest that downloads now is the safe start.
  const small = [...runs].sort((a, b) => a.model.minVramGb - b.model.minVramGb);
  const pick = small.find(open) ?? small[0]!;
  return make(pick, `Runs on a ${pick.model.minVramGb} GB GPU or more`);
}

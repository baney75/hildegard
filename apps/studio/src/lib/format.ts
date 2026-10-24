// SPDX-License-Identifier: AGPL-3.0-only
import type { Catalog, EngineState, GuestTake, Take } from '@hildegard/presets';

const ROMAN: Array<[number, string]> = [
  [1000, 'M'],
  [900, 'CM'],
  [500, 'D'],
  [400, 'CD'],
  [100, 'C'],
  [90, 'XC'],
  [50, 'L'],
  [40, 'XL'],
  [10, 'X'],
  [9, 'IX'],
  [5, 'V'],
  [4, 'IV'],
  [1, 'I'],
];
/** Shots are numbered like the folios of a manuscript. */
export function roman(n: number): string {
  let out = '';
  for (const [v, s] of ROMAN)
    while (n >= v) {
      out += s;
      n -= v;
    }
  return out;
}

export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]!);
}

/** "0:06" */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** "2 min 41 s", "38 s", "1 h 4 min" */
export function duration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** Rough, for estimates: "~40 s", "~3 min". */
export function about(ms: number): string {
  const s = ms / 1000;
  if (s < 50) return `~${Math.max(5, Math.round(s / 5) * 5)} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `~${m} min` : `~${Math.round(m / 6) / 10} h`;
}

export function bytes(n: number): string {
  if (n < 1024 ** 2) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 ** 3) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${(n / 1024 ** 3).toFixed(n < 10 * 1024 ** 3 ? 1 : 0)} GB`;
}

export function resolution(t: { width: number; height: number }): string {
  return `${Math.min(t.width, t.height)}p`;
}

export function modelName(catalog: Catalog | null, id: string): string {
  return catalog?.models.find((m) => m.id === id)?.name ?? id;
}

/** Work units for a take: frames × pixels. Render time grows roughly with this. */
const units = (t: { width: number; height: number; seconds: number; fps: number }) =>
  t.width * t.height * t.seconds * t.fps;

/**
 * Estimate how long a take will take on this computer, from the takes it has already rendered with the same model
 * and quality. Null until there is something to go on: a made-up number is worse than none.
 */
export function estimateMs(
  done: Iterable<Take>,
  shape: {
    model: string;
    quality: 'draft' | 'final';
    width: number;
    height: number;
    seconds: number;
    fps: number;
  },
): number | null {
  let ms = 0;
  let u = 0;
  for (const t of done) {
    if (t.status !== 'done' || !t.renderMs || t.model !== shape.model || t.quality !== shape.quality)
      continue;
    ms += t.renderMs;
    u += units(t);
  }
  return u ? (ms / u) * units(shape) : null;
}

/** Time left on a running take: from its own pace once it is under way, before that from past renders. */
export function leftMs(t: Take, history: number | null, now = Date.now()): number | null {
  if (t.status !== 'running' || !t.startedAt) return null;
  const elapsed = Math.max(0, now - Date.parse(t.startedAt));
  const v = t.progress?.value ?? 0;
  // Sampling is done; decoding and saving report nothing, so there's no honest time left to show.
  if (v >= 1) return null;
  if (v >= 0.15) return (elapsed * (1 - v)) / v;
  return history === null ? null : Math.max(0, history - elapsed);
}

/** Who sent a paired device's render here: "From rectory1", or just another device when it didn't say. */
export function guestFrom(g: GuestTake): string {
  return g.from ? `From ${g.from}` : 'From another device';
}

/** A paired device's render, in a line: "From rectory1 · rendering · 42%", "From rectory1 · waiting · up next". */
export function guestLine(g: GuestTake): string {
  if (g.status === 'running')
    return `${guestFrom(g)} · rendering${g.progress === null ? '' : g.progress >= 1 ? ' · finishing' : ` · ${Math.round(g.progress * 100)}%`}`;
  const place = g.queuePosition && g.queuePosition > 1 ? `${ordinal(g.queuePosition)} in line` : 'up next';
  return `${guestFrom(g)} · waiting · ${place}`;
}

/** Which device takes render on, for people: "parish1 · RTX 4080 Laptop", "Stand-in GPU", "This computer". */
export function deviceLabel(engine: EngineState | null): string {
  if (engine?.comfy === 'remote') return engine.device;
  return engine?.fake ? 'Stand-in GPU' : (engine?.device ?? 'This computer');
}

/** What to say while ComfyUI isn't answering: a short label and a sentence with what to do. */
export function comfyDown(engine: EngineState | null): { short: string; long: string } {
  const where = engine?.url ? ` at ${engine.url}` : '';
  switch (engine?.comfy) {
    case 'remote': {
      const name = engine.device.split(' · ')[0];
      return {
        short: `${name} isn’t answering`,
        long: `${engine.problem ?? `Hildegard can’t reach ${name}.`} Takes wait here and start on their own once it answers.`,
      };
    }
    case 'not-installed':
      return {
        short: 'ComfyUI isn’t installed',
        long: 'ComfyUI isn’t installed yet. Run `hildegard install` in a terminal; takes wait here until it’s ready.',
      };
    case 'managed':
      return engine.problem === 'ComfyUI is starting.' || !engine.problem
        ? { short: 'ComfyUI is starting', long: 'ComfyUI is starting. Takes begin as soon as it’s ready.' }
        : { short: 'ComfyUI stopped', long: `${engine.problem} Hildegard is restarting it.` };
    default:
      return {
        short: 'ComfyUI is not running',
        long: `Hildegard can’t reach ComfyUI${where}. Takes wait here and start on their own once it answers.`,
      };
  }
}

/** Models that make shots. The stills model draws characters and a cast shot's start frame, never a shot. */
export const videoModels = (c: Catalog) => c.models.filter((m) => m.kind !== 'image');

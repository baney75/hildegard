import type { Catalog, Take } from '@hildegard/presets';

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
  if (v >= 0.15 && v < 1) return (elapsed * (1 - v)) / v;
  return history === null ? null : Math.max(0, history - elapsed);
}

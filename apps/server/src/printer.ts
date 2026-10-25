// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The owner's 3D printer, as Hildegard remembers it for every agent: its build volume and nozzle, the filament and
 * what it costs, and the clearance each kind of fit needs on this printer (measured with the fit coupon, or the usual
 * starting points until then). A print loop checks against it, and slices with the slicer on this computer, so a part
 * comes back with what it will cost in time and money, beside what the thing costs to buy.
 *
 * Fits, clearances and the coupon follow print3d by mfranzon (https://github.com/mfranzon/print3d, MIT; see
 * THIRD_PARTY_NOTICES.md). Hildegard slices with PrusaSlicer (or SuperSlicer) with no setup, and with OrcaSlicer or
 * Bambu Studio once the owner points it at their printer's profiles. Nothing here talks to a printer.
 */
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, platform, tmpdir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import { z } from 'zod';
import { readZip } from './zip.ts';

export const FIT_KINDS = ['press', 'snug', 'slide', 'free'] as const;
export type FitKind = (typeof FIT_KINDS)[number];
/** Per side, in millimetres: the usual starting points for a 0.4 mm nozzle in PLA. */
export const DEFAULT_CLEARANCE: Record<FitKind, number> = { press: 0.05, snug: 0.1, slide: 0.2, free: 0.35 };

/** Grams per cubic centimetre, for working out weight when a slicer doesn't. */
const DENSITY: Record<string, number> = {
  PLA: 1.24,
  PETG: 1.27,
  ABS: 1.04,
  ASA: 1.07,
  TPU: 1.21,
  PA: 1.14,
  PC: 1.2,
};

const Mm = z.number().positive().max(10_000);
export const PrinterInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    bedMm: z.tuple([Mm, Mm, Mm]),
    nozzleMm: z.number().min(0.1).max(2),
    layerMm: z.number().min(0.04).max(1),
    material: z.string().trim().min(2).max(20),
    filamentMm: z.union([z.literal(1.75), z.literal(2.85)]),
    pricePerKg: z.number().min(0).max(10_000),
    currency: z
      .string()
      .trim()
      .regex(/^[A-Z]{3}$/, 'A currency is three capital letters, such as USD or EUR.'),
    clearanceMm: z
      .object(
        Object.fromEntries(FIT_KINDS.map((k) => [k, z.number().min(0).max(1)])) as Record<
          FitKind,
          z.ZodNumber
        >,
      )
      .partial(),
    /** A slicer to use instead of the one Hildegard finds. */
    slicer: z.string().trim().max(500).nullable(),
    /** Profiles for the slicer: a PrusaSlicer .ini, or OrcaSlicer and Bambu Studio's machine, process and filament .json. */
    profiles: z.array(z.string().trim().min(1).max(500)).max(3),
  })
  .partial();
export type PrinterInput = z.infer<typeof PrinterInput>;

export interface Printer {
  name: string;
  bedMm: [number, number, number];
  nozzleMm: number;
  layerMm: number;
  material: string;
  filamentMm: 1.75 | 2.85;
  pricePerKg: number;
  currency: string;
  clearanceMm: Record<FitKind, number>;
  /** The fits measured on this printer (with the coupon), as opposed to the defaults. */
  calibrated: FitKind[];
  calibratedAt: string | null;
  slicer: string | null;
  profiles: string[];
}

const DEFAULTS: Printer = {
  name: 'My printer',
  bedMm: [256, 256, 256],
  nozzleMm: 0.4,
  layerMm: 0.2,
  material: 'PLA',
  filamentMm: 1.75,
  pricePerKg: 25,
  currency: 'USD',
  clearanceMm: { ...DEFAULT_CLEARANCE },
  calibrated: [],
  calibratedAt: null,
  slicer: null,
  profiles: [],
};

export class PrinterError extends Error {
  readonly status: 404 | 409 | 422 | 501;
  constructor(status: PrinterError['status'], message: string) {
    super(message);
    this.status = status;
  }
}

/** The printer profile, kept in the data folder. */
export class PrinterProfile {
  private readonly file: string;
  constructor(dataDir: string) {
    this.file = join(dataDir, 'printer.json');
  }

  get(): Printer {
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Printer>;
      return { ...DEFAULTS, ...saved, clearanceMm: { ...DEFAULT_CLEARANCE, ...saved.clearanceMm } };
    } catch {
      return { ...DEFAULTS, clearanceMm: { ...DEFAULT_CLEARANCE } };
    }
  }

  set(input: PrinterInput, now = new Date()): Printer {
    const cur = this.get();
    const next: Printer = {
      ...cur,
      ...input,
      clearanceMm: { ...cur.clearanceMm, ...input.clearanceMm },
    } as Printer;
    if (input.clearanceMm && Object.keys(input.clearanceMm).length) {
      const order = FIT_KINDS.map((k) => next.clearanceMm[k]);
      if (order.some((v, i) => i > 0 && v < order[i - 1]!))
        throw new PrinterError(
          422,
          `Fits loosen in the order press, snug, slide, free; these don’t: ${FIT_KINDS.map((k) => `${k} ${next.clearanceMm[k]}`).join(', ')}.`,
        );
      next.calibrated = [...new Set([...cur.calibrated, ...(Object.keys(input.clearanceMm) as FitKind[])])];
      next.calibratedAt = now.toISOString().slice(0, 10);
    }
    for (const p of next.profiles)
      if (!existsSync(p)) throw new PrinterError(422, `There’s no profile at ${p}.`);
    if (next.slicer && !existsSync(next.slicer))
      throw new PrinterError(422, `There’s no slicer at ${next.slicer}.`);
    mkdirSync(join(this.file, '..'), { recursive: true });
    writeFileSync(`${this.file}.tmp`, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(`${this.file}.tmp`, this.file);
    return next;
  }
}

// ── Slicers ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type SlicerKind = 'prusa' | 'orca';
export interface Slicer {
  path: string;
  kind: SlicerKind;
  name: string;
  /** Arguments that come before the slicer's own (a script run by an interpreter). */
  args?: string[];
}

const NAMES: [string, SlicerKind, string][] = [
  ['prusa-slicer', 'prusa', 'PrusaSlicer'],
  ['PrusaSlicer', 'prusa', 'PrusaSlicer'],
  ['superslicer', 'prusa', 'SuperSlicer'],
  ['SuperSlicer', 'prusa', 'SuperSlicer'],
  ['orca-slicer', 'orca', 'OrcaSlicer'],
  ['OrcaSlicer', 'orca', 'OrcaSlicer'],
  ['bambu-studio', 'orca', 'Bambu Studio'],
];

/** What kind of slicer a program is, by its name. */
export function slicerKind(path: string): Slicer {
  const n = basename(path).toLowerCase();
  if (/orca/.test(n)) return { path, kind: 'orca', name: 'OrcaSlicer' };
  if (/bambu/.test(n)) return { path, kind: 'orca', name: 'Bambu Studio' };
  if (/super/.test(n)) return { path, kind: 'prusa', name: 'SuperSlicer' };
  return { path, kind: 'prusa', name: 'PrusaSlicer' };
}

/** A slicer on this computer: the profile's, HILDEGARD_SLICER, then the usual places. PrusaSlicer first. */
export function findSlicer(
  printer?: Pick<Printer, 'slicer'>,
  env: NodeJS.ProcessEnv = process.env,
  os: NodeJS.Platform = platform(),
): Slicer | null {
  const given = printer?.slicer || env.HILDEGARD_SLICER;
  if (given) return existsSync(given) ? slicerKind(given) : null;
  const found: string[] = [];
  if (os === 'darwin') {
    for (const root of ['/Applications', join(homedir(), 'Applications')])
      found.push(
        join(root, 'Original Prusa Drivers', 'PrusaSlicer.app', 'Contents', 'MacOS', 'PrusaSlicer'),
        join(root, 'PrusaSlicer.app', 'Contents', 'MacOS', 'PrusaSlicer'),
        join(root, 'SuperSlicer.app', 'Contents', 'MacOS', 'SuperSlicer'),
        join(root, 'OrcaSlicer.app', 'Contents', 'MacOS', 'OrcaSlicer'),
        join(root, 'BambuStudio.app', 'Contents', 'MacOS', 'BambuStudio'),
      );
  } else if (os === 'win32') {
    for (const root of [env.PROGRAMFILES, env['PROGRAMFILES(X86)']].filter(Boolean) as string[])
      found.push(
        join(root, 'Prusa3D', 'PrusaSlicer', 'prusa-slicer-console.exe'),
        join(root, 'SuperSlicer', 'superslicer_console.exe'),
        join(root, 'OrcaSlicer', 'orca-slicer.exe'),
        join(root, 'Bambu Studio', 'bambu-studio.exe'),
      );
  } else {
    for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean))
      found.push(...NAMES.map(([n]) => join(dir, n)));
  }
  const hit = found.find((p) => existsSync(p));
  return hit ? slicerKind(hit) : null;
}

export interface SliceResult {
  slicer: string;
  /** Minutes, as the slicer estimates them. */
  minutes: number | null;
  time: string | null;
  grams: number | null;
  layers: number | null;
  cost: number | null;
  currency: string;
  /** The G-code, kept beside the round. */
  gcode: string | null;
}

export class SliceError extends Error {}

/** "1h 2m 3s" or "1d 2h 3m" → minutes. */
export function minutes(s: string | null): number | null {
  if (!s) return null;
  let total = 0;
  for (const [, n, u] of s.matchAll(/(\d+(?:\.\d+)?)\s*([dhms])/g))
    total += Number(n) * { d: 1440, h: 60, m: 1, s: 1 / 60 }[u as 'd' | 'h' | 'm' | 's'];
  return total ? Math.round(total * 10) / 10 : null;
}

/** What a slicer wrote at the end of its G-code: time, grams, layers and cost. Both dialects. */
export function readGcode(text: string): Omit<SliceResult, 'slicer' | 'currency' | 'gcode'> {
  const pick = (re: RegExp) => re.exec(text)?.[1]?.trim() ?? null;
  const time =
    pick(/^;.*total estimated time:\s*([^;\n]+)/m) ??
    pick(/^;\s*estimated printing time \(normal mode\)\s*=\s*(.+)$/m);
  const grams =
    pick(/^;\s*total filament (?:used|weight) \[g\]\s*[:=]\s*([\d.]+)/m) ??
    pick(/^;\s*filament used \[g\]\s*=\s*([\d.]+)/m);
  const cost =
    pick(/^;\s*total filament cost\s*[:=]\s*([\d.]+)/m) ?? pick(/^;\s*filament cost\s*=\s*([\d.]+)/m);
  const layers = pick(/^;\s*total layer(?:s)? (?:number|count)\s*[:=]\s*(\d+)/m);
  const counted = (text.match(/^;LAYER_CHANGE/gm) ?? []).length;
  return {
    minutes: minutes(time),
    time,
    grams: grams !== null ? Number(grams) : null,
    layers: layers !== null ? Number(layers) : counted || null,
    cost: cost !== null ? Number(cost) : null,
  };
}

function run(
  slicer: Slicer,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number; out: string }> {
  const cmd = slicer.path;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...(slicer.args ?? []), ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    const keep = (d: Buffer) => {
      out = (out + d.toString()).slice(-8000);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.once('error', (e) => {
      clearTimeout(timer);
      reject(new SliceError(`Could not run ${cmd}: ${e.message}`));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, out });
    });
  });
}

/** The last line of a slicer's output that says what went wrong. */
const why = (out: string) =>
  out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^\d+ => /.test(l))
    .filter((l) => /error|fail|could not|outside|empty|not fit|invalid/i.test(l))
    .at(-1) ??
  out.trim().split('\n').at(-1) ??
  'it stopped';

/**
 * Slices the parts (binary STL files, each standing on the bed) into one plate, and reads what it will take. The
 * G-code is moved to `keep` when given.
 */
export async function slice(
  slicer: Slicer,
  printer: Printer,
  files: string[],
  keep?: string,
  timeoutMs = 300_000,
): Promise<SliceResult> {
  const dir = mkdtempSync(join(tmpdir(), 'hg-slice-'));
  try {
    let text: string;
    if (slicer.kind === 'prusa') {
      const [x, y, z] = printer.bedMm;
      const out = join(dir, 'plate.gcode');
      const settings = printer.profiles.length
        ? printer.profiles.flatMap((p) => ['--load', p])
        : [
            '--bed-shape',
            `0x0,${x}x0,${x}x${y},0x${y}`,
            '--max-print-height',
            String(z),
            '--nozzle-diameter',
            String(printer.nozzleMm),
            '--layer-height',
            String(printer.layerMm),
            '--first-layer-height',
            String(Math.max(printer.layerMm, 0.2)),
            '--filament-diameter',
            String(printer.filamentMm),
            '--filament-type',
            printer.material,
          ];
      const r = await run(
        slicer,
        [
          '--export-gcode',
          '--merge',
          ...settings,
          '--filament-density',
          String(DENSITY[printer.material.toUpperCase()] ?? 1.24),
          '--filament-cost',
          String(printer.pricePerKg),
          '--output',
          out,
          ...files,
        ],
        dir,
        timeoutMs,
      );
      if (r.code !== 0 || !existsSync(out))
        throw new SliceError(`${slicer.name} couldn’t slice it: ${why(r.out)}`);
      text = readFileSync(out, 'utf8');
      if (keep) renameSync(out, keep);
    } else {
      if (!printer.profiles.length)
        throw new SliceError(
          `${slicer.name} needs your printer’s profiles to slice: export the machine, process and filament presets as .json and set them with printer_profile (profiles). Or install PrusaSlicer, which slices with no setup.`,
        );
      const json = printer.profiles.filter((p) => p.endsWith('.json'));
      const filament = json.find((p) => /filament/i.test(p));
      const r = await run(
        slicer,
        [
          '--arrange',
          '1',
          '--slice',
          '0',
          '--load-settings',
          json.filter((p) => p !== filament).join(';'),
          ...(filament ? ['--load-filaments', filament] : []),
          '--outputdir',
          dir,
          '--export-3mf',
          'plate.gcode.3mf',
          ...files,
        ],
        dir,
        timeoutMs,
      );
      const gcode = readdirSync(dir).find((f) => f.endsWith('.gcode'));
      if (gcode) text = readFileSync(join(dir, gcode), 'utf8');
      else if (existsSync(join(dir, 'plate.gcode.3mf'))) {
        const inside = readZip(readFileSync(join(dir, 'plate.gcode.3mf'))).find((e) =>
          /plate_\d+\.gcode$/.test(e.name),
        );
        if (!inside) throw new SliceError(`${slicer.name} couldn’t slice it: ${why(r.out)}`);
        text = inside.data.toString('utf8');
      } else throw new SliceError(`${slicer.name} couldn’t slice it: ${why(r.out)}`);
      if (keep) writeFileSync(keep, text);
    }
    const stats = readGcode(text);
    return {
      slicer: slicer.name,
      ...stats,
      cost: stats.cost ?? (stats.grams !== null ? Math.round(stats.grams * printer.pricePerKg) / 1000 : null),
      currency: printer.currency,
      gcode: keep ?? null,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

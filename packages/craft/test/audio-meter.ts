// SPDX-License-Identifier: AGPL-3.0-only
// An independent audio meter for the hildegard-music tests: ITU-R BS.1770-4 loudness (time-domain K-weighting biquads),
// a 4x oversampled true peak, and a tone finder (windowed FFT with a parabolic fit). It shares no code with the Python
// scripts it checks, so an agreement between the two means something.
import { readFileSync } from 'node:fs';
import { expect } from 'vitest';

export interface Wav {
  rate: number;
  ch: Float64Array[];
}

export function readWav(path: string): Wav {
  const b = readFileSync(path);
  expect(b.toString('latin1', 0, 4)).toBe('RIFF');
  let p = 12;
  let rate = 0;
  let nch = 0;
  let bits = 0;
  while (p + 8 <= b.length) {
    const id = b.toString('latin1', p, p + 4);
    const size = b.readUInt32LE(p + 4);
    if (id === 'fmt ') {
      nch = b.readUInt16LE(p + 10);
      rate = b.readUInt32LE(p + 12);
      bits = b.readUInt16LE(p + 22);
    } else if (id === 'data') {
      const bytes = bits / 8;
      const n = Math.floor(size / (bytes * nch));
      const ch = Array.from({ length: nch }, () => new Float64Array(n));
      for (let i = 0; i < n; i++)
        for (let c = 0; c < nch; c++) {
          const o = p + 8 + (i * nch + c) * bytes;
          ch[c]![i] = bits === 16 ? b.readInt16LE(o) / 32768 : b.readIntLE(o, 3) / 8388608;
        }
      return { rate, ch };
    }
    p += 8 + size + (size % 2);
  }
  throw new Error('no data chunk');
}

function biquad(x: Float64Array, b: number[], a: number[]): Float64Array {
  const y = new Float64Array(x.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b[0]! * x[i]! + b[1]! * x1 + b[2]! * x2 - a[1]! * y1 - a[2]! * y2;
    x2 = x1;
    x1 = x[i]!;
    y2 = y1;
    y1 = v;
    y[i] = v;
  }
  return y;
}

function kWeight(x: Float64Array, fs: number): Float64Array {
  let f0 = 1681.974450955533;
  let Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / fs);
  const Vh = 10 ** (3.999843853973347 / 20);
  const Vb = Vh ** 0.4996667741545416;
  let a0 = 1 + K / Q + K * K;
  const y = biquad(
    x,
    [(Vh + (Vb * K) / Q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0],
    [1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0],
  );
  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / fs);
  a0 = 1 + K / Q + K * K;
  return biquad(y, [1, -2, 1], [1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0]);
}

/** Integrated loudness. A clip shorter than one 400 ms block is measured whole (the script documents the same rule). */
export function lufs(w: Wav): number {
  const n = w.ch[0]!.length;
  const sq = w.ch.map((c) => {
    const y = kWeight(c, w.rate);
    return y.map((v) => v * v);
  });
  const blk = Math.round(0.4 * w.rate);
  const hop = Math.round(0.1 * w.rate);
  const meanSq = (s: number, e: number) =>
    sq.reduce((t, c) => t + c.subarray(s, e).reduce((u, v) => u + v, 0) / (e - s), 0);
  if (n < blk) return -0.691 + 10 * Math.log10(Math.max(meanSq(0, n), 1e-20));
  const z: number[] = [];
  for (let s = 0; s + blk <= n; s += hop) z.push(meanSq(s, s + blk));
  const l = (v: number) => -0.691 + 10 * Math.log10(Math.max(v, 1e-20));
  const abs = z.filter((v) => l(v) > -70);
  if (!abs.length) return Number.NEGATIVE_INFINITY;
  const rel = l(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const kept = z.filter((v) => l(v) > Math.max(rel, -70));
  return l(kept.reduce((a, b) => a + b, 0) / kept.length);
}

/** Peak of the 4x oversampled signal (windowed sinc, 32 taps per phase side), in dBTP. */
export function truePeakDb(w: Wav): number {
  const half = 16;
  const phases = [0.25, 0.5, 0.75].map((f) => {
    const h = new Float64Array(2 * half);
    for (let k = -half + 1; k <= half; k++) {
      const t = k - f;
      const win = 0.5 + 0.5 * Math.cos((Math.PI * t) / (half + 1));
      h[k + half - 1] = (t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t)) * win;
    }
    return h;
  });
  let peak = 0;
  for (const c of w.ch) {
    for (let i = 0; i < c.length; i++) peak = Math.max(peak, Math.abs(c[i]!));
    for (const h of phases)
      for (let i = half; i < c.length - half; i++) {
        let s = 0;
        for (let k = 0; k < 2 * half; k++) s += h[k]! * c[i - half + 1 + k]!;
        peak = Math.max(peak, Math.abs(s));
      }
  }
  return 20 * Math.log10(peak);
}

export function measure(path: string) {
  const w = readWav(path);
  const n = w.ch[0]!.length;
  let peak = 0;
  let clipped = 0;
  let ss = 0;
  for (const c of w.ch)
    for (let i = 0; i < n; i++) {
      const v = Math.abs(c[i]!);
      peak = Math.max(peak, v);
      if (v >= 32767 / 32768) clipped++;
      ss += v * v;
    }
  return {
    seconds: n / w.rate,
    rate: w.rate,
    channels: w.ch.length,
    peak,
    clipped,
    dc: Math.max(...w.ch.map((c) => Math.abs(c.reduce((t, v) => t + v, 0) / n))),
    rmsDb: 10 * Math.log10(ss / (n * w.ch.length) + 1e-20),
    lufs: lufs(w),
    truePeak: truePeakDb(w),
  };
}

/** In-place radix-2 FFT of a power-of-two length. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b]! * cr - im[b]! * ci;
        const ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

/** The frequency of the strongest tone between lo and hi Hz in one channel, around centerS, over spanS seconds. */
export function toneHz(
  w: Wav,
  channel: number,
  centerS: number,
  spanS: number,
  lo: number,
  hi: number,
): number {
  const x = w.ch[channel]!;
  const n = Math.floor(spanS * w.rate);
  const start = Math.max(0, Math.floor(centerS * w.rate) - (n >> 1));
  let size = 1;
  while (size < n * 4) size <<= 1;
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let i = 0; i < n; i++)
    re[i] = (x[start + i] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
  fft(re, im);
  const df = w.rate / size;
  const mag = (k: number) => Math.hypot(re[k]!, im[k]!);
  let best = Math.ceil(lo / df);
  for (let k = best; k <= Math.floor(hi / df); k++) if (mag(k) > mag(best)) best = k;
  const a = Math.log(mag(best - 1) + 1e-20);
  const b = Math.log(mag(best) + 1e-20);
  const c = Math.log(mag(best + 1) + 1e-20);
  const off = (0.5 * (a - c)) / (a - 2 * b + c);
  return (best + off) * df;
}

/** Fraction of the largest jump between neighbouring samples at the given positions to a typical jump (the median). */
export function joinJumpRatio(w: Wav, positions: number[]): number {
  const x = w.ch[0]!;
  const jumps: number[] = [];
  for (let i = 1; i < x.length; i += 97) jumps.push(Math.abs(x[i]! - x[i - 1]!));
  jumps.sort((p, q) => p - q);
  const median = jumps[jumps.length >> 1]! || 1e-9;
  let worst = 0;
  for (const p of positions) worst = Math.max(worst, Math.abs(x[p]! - x[p - 1]!));
  return worst / median;
}

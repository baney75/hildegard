// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Voice in the Studio: one shared player (only one clip plays at a time), waveforms read from the clips themselves,
 * the microphone, and the small rules the Studio needs from presets/voice.ts without bundling its schema library.
 */
import type { Voice, VoiceControl, VoiceModel, VoiceTag } from '@hildegard/presets';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

// ── One player ──────────────────────────────────────────────────────────────────────────────────────────────────

interface PlayerState {
  url: string | null;
  playing: boolean;
  time: number;
  duration: number;
}
let player: PlayerState = { url: null, playing: false, time: 0, duration: 0 };
let audio: HTMLAudioElement | null = null;
const playerListeners = new Set<() => void>();
const setPlayer = (p: Partial<PlayerState>) => {
  player = { ...player, ...p };
  for (const l of playerListeners) l();
};

function element(): HTMLAudioElement {
  if (audio) return audio;
  audio = new Audio();
  audio.preload = 'auto';
  audio.addEventListener('play', () => setPlayer({ playing: true }));
  audio.addEventListener('pause', () => setPlayer({ playing: false }));
  audio.addEventListener('ended', () => setPlayer({ playing: false, time: 0 }));
  audio.addEventListener('timeupdate', () => setPlayer({ time: audio!.currentTime }));
  audio.addEventListener('loadedmetadata', () =>
    setPlayer({ duration: Number.isFinite(audio!.duration) ? audio!.duration : 0 }),
  );
  return audio;
}

/** Play a clip, or pause it if it's the one playing. */
export function toggle(url: string) {
  const a = element();
  if (player.url === url) {
    if (a.paused) void a.play().catch(() => {});
    else a.pause();
    return;
  }
  a.src = url;
  setPlayer({ url, time: 0, duration: 0 });
  void a.play().catch(() => setPlayer({ playing: false }));
}

export function stopPlayback() {
  audio?.pause();
}

export function seek(seconds: number) {
  if (audio) audio.currentTime = seconds;
}

export function usePlayer(): PlayerState {
  return useSyncExternalStore(
    (l) => {
      playerListeners.add(l);
      return () => playerListeners.delete(l);
    },
    () => player,
  );
}

// ── Waveforms ───────────────────────────────────────────────────────────────────────────────────────────────────

const peaksCache = new Map<string, Promise<number[]>>();
let ctx: AudioContext | null = null;

/** The loudness of `bars` stretches of a clip, 0 to 1, read from the file. */
export function peaks(url: string, bars: number): Promise<number[]> {
  const key = `${url}#${bars}`;
  let p = peaksCache.get(key);
  if (!p) {
    p = (async () => {
      const buf = await (await fetch(url)).arrayBuffer();
      ctx ??= new (
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      )();
      const data = (await ctx.decodeAudioData(buf)).getChannelData(0);
      const step = Math.max(1, Math.floor(data.length / bars));
      const out: number[] = [];
      for (let b = 0; b < bars; b++) {
        let sum = 0;
        for (let i = b * step; i < Math.min(data.length, (b + 1) * step); i++) sum += data[i]! * data[i]!;
        out.push(Math.sqrt(sum / step));
      }
      const max = Math.max(...out, 1e-6);
      return out.map((v) => Math.min(1, v / max));
    })();
    p.catch(() => peaksCache.delete(key));
    peaksCache.set(key, p);
  }
  return p;
}

export function usePeaks(url: string | null, bars: number): number[] | null {
  const [v, setV] = useState<number[] | null>(null);
  useEffect(() => {
    setV(null);
    if (!url) return;
    let live = true;
    peaks(url, bars)
      .then((p) => live && setV(p))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [url, bars]);
  return v;
}

// ── The microphone ──────────────────────────────────────────────────────────────────────────────────────────────

export type MicState = 'idle' | 'asking' | 'recording' | 'denied' | 'unsupported';

/** Record from the microphone: the clip as a Blob when stopped, and a live level for the meter while recording. */
export function useRecorder(onDone: (clip: Blob, seconds: number) => void) {
  const [state, setState] = useState<MicState>(() =>
    typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia ? 'unsupported' : 'idle',
  );
  const [level, setLevel] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const rec = useRef<{ mr: MediaRecorder; stream: MediaStream; raf: number; t0: number } | null>(null);
  const done = useRef(onDone);
  done.current = onDone;

  const stopAll = () => {
    const r = rec.current;
    if (!r) return;
    cancelAnimationFrame(r.raf);
    for (const t of r.stream.getTracks()) t.stop();
    rec.current = null;
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: lets go of the microphone when the page closes.
  useEffect(() => stopAll, []);

  const start = async () => {
    if (rec.current) return;
    setState('asking');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch {
      setState('denied');
      return;
    }
    const type = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find((t) =>
      MediaRecorder.isTypeSupported(t),
    );
    const mr = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const chunks: Blob[] = [];
    mr.addEventListener('dataavailable', (e) => e.data.size && chunks.push(e.data));
    const t0 = performance.now();
    mr.addEventListener('stop', () => {
      const secs = (performance.now() - t0) / 1000;
      stopAll();
      setState('idle');
      setLevel(0);
      done.current(new Blob(chunks, { type: mr.mimeType || 'audio/webm' }), secs);
    });
    ctx ??= new AudioContext();
    const an = ctx.createAnalyser();
    an.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Float32Array(an.fftSize);
    const tick = () => {
      an.getFloatTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v));
      setLevel(peak);
      setSeconds((performance.now() - t0) / 1000);
      if (rec.current) rec.current.raf = requestAnimationFrame(tick);
    };
    rec.current = { mr, stream, raf: requestAnimationFrame(tick), t0 };
    setSeconds(0);
    mr.start(250);
    setState('recording');
  };
  const stop = () => {
    if (rec.current?.mr.state === 'recording') rec.current.mr.stop();
  };
  return { state, level, seconds, start, stop };
}

// ── Scripts ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Words and `[tags]` in a paragraph, for drawing tags as chips. The server's parseScript decides what they mean. */
export function tokens(text: string): Array<{ tag: boolean; text: string }> {
  const out: Array<{ tag: boolean; text: string }> = [];
  const re = /\[\[|\[([^[\]\n]{1,40})\]/g;
  let at = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0] === '[[') continue;
    if (m.index > at) out.push({ tag: false, text: text.slice(at, m.index) });
    out.push({ tag: true, text: m[0] });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ tag: false, text: text.slice(at) });
  return out;
}

/** What a paragraph says aloud, without tags. */
export const spoken = (text: string) =>
  text
    .replace(/\[\[/g, '[')
    .replace(/\[[^[\]\n]{1,40}\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** About how long words take to say, in seconds. */
export const sayingSeconds = (text: string) =>
  Math.max(0, spoken(text).split(/\s+/).filter(Boolean).length / 2.6);

/** The tag being typed at the caret: `[ex` gives "ex". */
export function typingTag(text: string, caret: number): { start: number; query: string } | null {
  const m = /\[([a-z ]{0,30})$/i.exec(text.slice(0, caret));
  if (!m || text[m.index - 1] === '[') return null;
  return { start: m.index, query: m[1]!.toLowerCase() };
}

export const PAUSES = ['pause 0.3s', 'pause 0.5s', 'pause 1s', 'pause 2s'];

export const CONTROL_NAMES: Record<VoiceControl, string> = {
  speed: 'Speed',
  expressiveness: 'Expressiveness',
  stability: 'Similarity',
  variety: 'Variety',
  direction: 'Acting direction',
};

/** Whether a model honours a control, and when it doesn't, which model does. */
export function controlState(
  model: VoiceModel,
  control: VoiceControl,
  others: readonly VoiceModel[],
): { enabled: boolean; why: string | null } {
  if (model.controls.includes(control)) return { enabled: true, why: null };
  const alt = others.find(
    (m) => m.id !== model.id && m.controls.includes(control) && m.can.some((c) => c !== 'transcribe'),
  );
  return { enabled: false, why: `${model.name} doesn’t support this.${alt ? ` ${alt.name} does.` : ''}` };
}

// ── Voices ──────────────────────────────────────────────────────────────────────────────────────────────────────

export const KIND_LABEL = { builtin: 'Built-in', designed: 'Designed', clone: 'Clone' } as const;

export function voiceLine(v: Voice): string {
  const lang = LANGS[v.language] ?? v.language.toUpperCase();
  return [lang, v.accent].filter(Boolean).join(' · ');
}

export const LANGS: Record<string, string> = {
  en: 'English',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  it: 'Italian',
  pt: 'Portuguese',
  nl: 'Dutch',
  pl: 'Polish',
  ru: 'Russian',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Chinese',
  hi: 'Hindi',
  ar: 'Arabic',
  tr: 'Turkish',
  sv: 'Swedish',
  da: 'Danish',
  fi: 'Finnish',
  no: 'Norwegian',
  el: 'Greek',
  he: 'Hebrew',
  ms: 'Malay',
  sw: 'Swahili',
};

export const langName = (code: string) => LANGS[code] ?? code.toUpperCase();

export const tagGroups = (tags: readonly VoiceTag[]) => ({
  emotion: tags.filter((t) => t.group === 'emotion'),
  delivery: tags.filter((t) => t.group === 'delivery'),
  sound: tags.filter((t) => t.group === 'sound'),
});

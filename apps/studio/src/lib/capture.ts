// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The recorder behind Record: the camera, the screen (with its own sound when the browser offers it), the screen with
 * the camera in a bubble, or the voice alone, from the microphone and camera the person picks. A 3-2-1 countdown,
 * pause and resume, chapters, and an interview's answers cut out as sound of their own on Next.
 *
 * Nothing asks for a device or the screen until `start()` (or `testMic()`), which a click calls. Stopping lets go of
 * every track. If the person stops sharing from the browser's own bar, the recording stops as if they had pressed
 * Stop. `useCapture` in record.ts stays for the simple Record buttons; this is the full recorder.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export type Source = 'camera' | 'screen' | 'screen+camera' | 'voice';
export type Phase =
  | 'idle'
  | 'asking'
  | 'countdown'
  | 'recording'
  | 'paused'
  | 'review'
  | 'denied'
  | 'unsupported';
export type Corner = 'tl' | 'tr' | 'bl' | 'br';
export type BubbleSize = 'S' | 'M' | 'L';
export interface Bubble {
  corner: Corner;
  size: BubbleSize;
  shape: 'round' | 'rounded';
}
export interface Chapter {
  at: number;
  title: string;
}
export interface Clip {
  blob: Blob;
  url: string;
  seconds: number;
  chapters: Chapter[];
}

export const SOURCE_LABEL: Record<Source, string> = {
  camera: 'Camera',
  screen: 'Screen',
  'screen+camera': 'Screen and camera',
  voice: 'Voice only',
};
export const hasPicture = (s: Source) => s !== 'voice';
const usesScreen = (s: Source) => s === 'screen' || s === 'screen+camera';
const usesCamera = (s: Source) => s === 'camera' || s === 'screen+camera';

const VOICE_TYPES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'];
const VIDEO_TYPES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
const pick = (types: string[]) => types.find((t) => MediaRecorder.isTypeSupported(t));
const FPS = 30;
/** The bubble's diameter as a share of the frame's height. */
const BUBBLE: Record<BubbleSize, number> = { S: 0.2, M: 0.28, L: 0.38 };

/** Whether this window can share the screen, and if not, the one line that says why. */
export function screenSupport(): { ok: true } | { ok: false; reason: string } {
  if (typeof navigator === 'undefined' || typeof navigator.mediaDevices?.getDisplayMedia !== 'function')
    return {
      ok: false,
      reason: /Mobi|Android|iPhone|iPad/.test(navigator?.userAgent ?? '')
        ? 'This device can’t share its screen from a web page.'
        : 'This window can’t share the screen. Open the Studio in Chrome, Edge, Firefox or Safari to record it.',
    };
  return { ok: true };
}

/** Read and write a remembered choice; a private window or blocked storage just forgets. */
export function remembered(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function remember(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {}
}

export interface DeviceChoice {
  id: string;
  label: string;
}

/** The microphones and cameras, by name once the person has allowed them, refreshed when one is plugged in. */
export function useDevices() {
  const [mics, setMics] = useState<DeviceChoice[]>([]);
  const [cams, setCams] = useState<DeviceChoice[]>([]);
  const refresh = useCallback(async () => {
    const md = navigator.mediaDevices;
    if (!md?.enumerateDevices) return;
    const all = await md.enumerateDevices().catch(() => []);
    const of = (kind: MediaDeviceKind, word: string) =>
      all
        .filter((d) => d.kind === kind && d.deviceId)
        .map((d, i) => ({ id: d.deviceId, label: d.label || `${word} ${i + 1}` }));
    setMics(of('audioinput', 'Microphone'));
    setCams(of('videoinput', 'Camera'));
  }, []);
  useEffect(() => {
    void refresh();
    const md = navigator.mediaDevices;
    md?.addEventListener?.('devicechange', refresh);
    return () => md?.removeEventListener?.('devicechange', refresh);
  }, [refresh]);
  return { mics, cams, refresh };
}

type Live = {
  tracks: MediaStreamTrack[];
  mr: MediaRecorder;
  /** The interview's answer: sound only, cut on Next. */
  seg: MediaRecorder | null;
  segChunks: Blob[];
  audio: MediaStream;
  raf: number;
  worker: Worker | null;
  ac: AudioContext;
  /** Recording time so far, not counting pauses. */
  base: number;
  since: number | null;
};

let shared: AudioContext | null = null;
const audioCtx = () => {
  shared ??= new AudioContext();
  if (shared.state === 'suspended') void shared.resume();
  return shared;
};

export function useStudioRecorder(o: { sources: Source[]; storage?: string | null }) {
  const key = o.storage === undefined ? 'hildegard.record' : o.storage;
  const supported = typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  const screen = screenSupport();
  const offered = o.sources.filter((s) => screen.ok || !usesScreen(s));
  const first = (() => {
    const saved = key ? (remembered(`${key}.source`) as Source | null) : null;
    return saved && offered.includes(saved) ? saved : (offered[0] ?? 'voice');
  })();
  const [source, setSourceState] = useState<Source>(first);
  const [phase, setPhase] = useState<Phase>(supported && offered.length ? 'idle' : 'unsupported');
  const [problem, setProblem] = useState<string | null>(null);
  const devices = useDevices();
  const [mic, setMicState] = useState<string | null>(() => (key ? remembered(`${key}.mic`) : null));
  const [cam, setCamState] = useState<string | null>(() => (key ? remembered(`${key}.cam`) : null));
  const [bubble, setBubbleState] = useState<Bubble>(() => {
    try {
      const b = JSON.parse((key && remembered(`${key}.bubble`)) || 'null') as Bubble | null;
      if (b && ['tl', 'tr', 'bl', 'br'].includes(b.corner) && ['S', 'M', 'L'].includes(b.size)) return b;
    } catch {}
    return { corner: 'br', size: 'M', shape: 'round' };
  });
  const [level, setLevel] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [count, setCount] = useState(0);
  const [preview, setPreview] = useState<MediaStream | null>(null);
  const [clip, setClip] = useState<Clip | null>(null);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [testing, setTesting] = useState<'listening' | 'playing' | null>(null);
  const live = useRef<Live | null>(null);
  const url = useRef<string | null>(null);
  const bubbleRef = useRef(bubble);
  bubbleRef.current = bubble;
  const chaptersRef = useRef<Chapter[]>([]);
  const countTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const startNow = useRef<(() => void) | null>(null);

  const setSource = (s: Source) => {
    setSourceState(s);
    if (key) remember(`${key}.source`, s);
  };
  const setMic = (id: string | null) => {
    setMicState(id);
    if (key) remember(`${key}.mic`, id);
  };
  const setCam = (id: string | null) => {
    setCamState(id);
    if (key) remember(`${key}.cam`, id);
  };
  const setBubble = (b: Partial<Bubble>) => {
    const next = { ...bubbleRef.current, ...b };
    setBubbleState(next);
    if (key) remember(`${key}.bubble`, JSON.stringify(next));
  };

  const elapsed = () => {
    const l = live.current;
    if (!l) return 0;
    return l.base + (l.since === null ? 0 : (performance.now() - l.since) / 1000);
  };

  const release = useCallback(() => {
    const l = live.current;
    if (countTimer.current) clearInterval(countTimer.current);
    countTimer.current = null;
    startNow.current = null;
    if (!l) return;
    cancelAnimationFrame(l.raf);
    l.worker?.postMessage('stop');
    l.worker?.terminate();
    for (const t of l.tracks) t.stop();
    for (const t of l.audio.getTracks()) t.stop();
    live.current = null;
    setPreview(null);
    setLevel(0);
  }, []);
  const forget = () => {
    if (url.current) URL.revokeObjectURL(url.current);
    url.current = null;
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: lets go of every device when the page closes.
  useEffect(
    () => () => {
      release();
      forget();
    },
    [],
  );

  const audioConstraints = (): MediaTrackConstraints => ({
    deviceId: mic ? { exact: mic } : undefined,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: false,
  });

  /** Asks for what the source needs: the screen first (its picker needs the click), then the microphone and camera. */
  const acquire = async (s: Source) => {
    const got: MediaStreamTrack[] = [];
    let display: MediaStream | null = null;
    try {
      if (usesScreen(s)) {
        display = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: { ideal: FPS } },
          // The screen's own sound, when the browser offers it (a tab, or the whole screen on some systems).
          audio: true,
          // @ts-expect-error: newer hints, ignored where unknown.
          systemAudio: 'include',
          selfBrowserSurface: 'exclude',
        });
        got.push(...display.getTracks());
      }
      const user = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints(),
        video: usesCamera(s)
          ? {
              deviceId: cam ? { exact: cam } : undefined,
              width: { ideal: 1280 },
              height: { ideal: 720 },
              facingMode: cam ? undefined : 'user',
            }
          : false,
      });
      got.push(...user.getTracks());
      return { display, user, tracks: got };
    } catch (e) {
      for (const t of got) t.stop();
      throw e;
    }
  };

  const keep = (blob: Blob, secs: number, marks: Chapter[]) => {
    forget();
    url.current = URL.createObjectURL(blob);
    setClip({ blob, url: url.current, seconds: secs, chapters: marks });
    setPhase('review');
  };

  /** Draws the screen full frame and the camera in its bubble, at a steady 30 frames a second. */
  const composite = (screenTrack: MediaStreamTrack, camTrack: MediaStreamTrack | null) => {
    const sv = document.createElement('video');
    sv.muted = true;
    sv.playsInline = true;
    sv.srcObject = new MediaStream([screenTrack]);
    void sv.play().catch(() => {});
    let cv: HTMLVideoElement | null = null;
    if (camTrack) {
      cv = document.createElement('video');
      cv.muted = true;
      cv.playsInline = true;
      cv.srcObject = new MediaStream([camTrack]);
      void cv.play().catch(() => {});
    }
    const st = screenTrack.getSettings();
    const scale = Math.min(1, 1920 / (st.width || 1920));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round((st.width || 1920) * scale) & ~1;
    canvas.height = Math.round((st.height || 1080) * scale) & ~1;
    const g = canvas.getContext('2d')!;
    const draw = () => {
      const W = canvas.width;
      const H = canvas.height;
      if (sv.videoWidth && (sv.videoWidth !== W / scale || sv.videoHeight !== H / scale)) {
        // The shared window was resized: follow it, within 1920 wide.
        const k = Math.min(1, 1920 / sv.videoWidth);
        canvas.width = Math.round(sv.videoWidth * k) & ~1;
        canvas.height = Math.round(sv.videoHeight * k) & ~1;
      }
      g.fillStyle = '#000';
      g.fillRect(0, 0, canvas.width, canvas.height);
      if (sv.readyState >= 2) g.drawImage(sv, 0, 0, canvas.width, canvas.height);
      if (cv && cv.readyState >= 2 && cv.videoWidth) {
        const b = bubbleRef.current;
        const d = Math.round(canvas.height * BUBBLE[b.size]);
        const m = Math.round(canvas.height * 0.04);
        const x = b.corner.endsWith('l') ? m : canvas.width - d - m;
        const y = b.corner.startsWith('t') ? m : canvas.height - d - m;
        g.save();
        g.beginPath();
        if (b.shape === 'round') g.arc(x + d / 2, y + d / 2, d / 2, 0, Math.PI * 2);
        else g.roundRect(x, y, d, d, d * 0.18);
        g.clip();
        // The camera's middle, square, mirrored as people expect to see themselves.
        const side = Math.min(cv.videoWidth, cv.videoHeight);
        g.translate(x + d, y);
        g.scale(-1, 1);
        g.drawImage(cv, (cv.videoWidth - side) / 2, (cv.videoHeight - side) / 2, side, side, 0, 0, d, d);
        g.restore();
        g.save();
        g.lineWidth = Math.max(2, Math.round(d * 0.02));
        g.strokeStyle = 'rgba(255,255,255,0.85)';
        g.beginPath();
        if (b.shape === 'round') g.arc(x + d / 2, y + d / 2, d / 2, 0, Math.PI * 2);
        else g.roundRect(x, y, d, d, d * 0.18);
        g.stroke();
        g.restore();
      }
    };
    let worker: Worker | null = null;
    try {
      worker = new Worker(new URL('./tick-worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = draw;
      worker.postMessage({ fps: FPS });
    } catch {
      worker = null;
    }
    const stream = canvas.captureStream(FPS);
    const stop = () => {
      sv.srcObject = null;
      if (cv) cv.srcObject = null;
    };
    return { stream, worker, draw, stop };
  };

  const begin = async (opts: { countdown: boolean }) => {
    if (live.current || phase === 'asking') return;
    setProblem(null);
    setPhase('asking');
    let got: Awaited<ReturnType<typeof acquire>>;
    try {
      got = await acquire(source);
    } catch (e) {
      const name = (e as DOMException)?.name;
      // Closing the screen picker isn't a refusal of the camera: it is a change of mind.
      if (usesScreen(source) && (name === 'NotAllowedError' || name === 'AbortError')) {
        setPhase('idle');
        setProblem('Screen sharing was cancelled. Press Record to choose a screen or window again.');
        return;
      }
      if (name === 'OverconstrainedError' || name === 'NotFoundError') {
        // The chosen device is gone (unplugged): forget it and say so.
        setMic(null);
        setCam(null);
        setPhase('idle');
        setProblem('That microphone or camera isn’t connected now. Pick another and press Record.');
        void devices.refresh();
        return;
      }
      setPhase('denied');
      return;
    }
    // Names come with the permission: show them now.
    void devices.refresh();
    const ac = audioCtx();
    const dest = ac.createMediaStreamDestination();
    const micTrack = got.user.getAudioTracks()[0] ?? null;
    const an = ac.createAnalyser();
    an.fftSize = 1024;
    if (micTrack) {
      const src = ac.createMediaStreamSource(new MediaStream([micTrack]));
      src.connect(an);
      src.connect(dest);
    }
    const sys = got.display?.getAudioTracks()[0];
    if (sys) ac.createMediaStreamSource(new MediaStream([sys])).connect(dest);
    const mixed = dest.stream.getAudioTracks()[0]!;

    let video: MediaStreamTrack | null = null;
    let worker: Worker | null = null;
    let shown: MediaStream | null = null;
    const screenTrack = got.display?.getVideoTracks()[0] ?? null;
    const camTrack = got.user.getVideoTracks()[0] ?? null;
    let stopComposite = () => {};
    if (source === 'screen+camera' && screenTrack) {
      const c = composite(screenTrack, camTrack);
      video = c.stream.getVideoTracks()[0]!;
      worker = c.worker;
      shown = c.stream;
      stopComposite = c.stop;
    } else if (source === 'screen' && screenTrack) {
      video = screenTrack;
      shown = new MediaStream([screenTrack]);
    } else if (camTrack) {
      video = camTrack;
      shown = new MediaStream([camTrack]);
    }
    const rec = new MediaStream(video ? [video, mixed] : [mixed]);
    const type = pick(video ? VIDEO_TYPES : VOICE_TYPES);
    const mr = new MediaRecorder(rec, type ? { mimeType: type } : undefined);
    const chunks: Blob[] = [];
    mr.addEventListener('dataavailable', (e) => e.data.size && chunks.push(e.data));
    mr.addEventListener('stop', () => {
      const secs = elapsed();
      const marks = chaptersRef.current;
      stopComposite();
      release();
      keep(new Blob(chunks, { type: mr.mimeType || (video ? 'video/webm' : 'audio/webm') }), secs, marks);
    });
    const buf = new Float32Array(an.fftSize);
    const tick = () => {
      if (!live.current) return;
      an.getFloatTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v));
      setLevel(peak);
      setSeconds(elapsed());
      live.current.raf = requestAnimationFrame(tick);
    };
    live.current = {
      tracks: [...got.tracks, ...(video && video !== screenTrack && video !== camTrack ? [video] : [])],
      mr,
      seg: null,
      segChunks: [],
      audio: dest.stream,
      raf: 0,
      worker,
      ac,
      base: 0,
      since: null,
    };
    live.current.raf = requestAnimationFrame(tick);
    setPreview(shown);
    // Stopping the share from the browser's own bar ends the recording cleanly.
    screenTrack?.addEventListener('ended', () => stop());
    chaptersRef.current = [];
    setChapters([]);
    setSeconds(0);
    const go = () => {
      startNow.current = null;
      if (countTimer.current) clearInterval(countTimer.current);
      countTimer.current = null;
      const l = live.current;
      if (l?.mr.state !== 'inactive') return;
      setCount(0);
      l.mr.start(250);
      l.since = performance.now();
      startSegment();
      setPhase('recording');
    };
    if (!opts.countdown) return go();
    startNow.current = go;
    setCount(3);
    setPhase('countdown');
    let n = 3;
    countTimer.current = setInterval(() => {
      n--;
      if (n <= 0) go();
      else setCount(n);
    }, 1000);
  };

  /** A new answer's sound, from now. */
  const startSegment = () => {
    const l = live.current;
    if (!l) return;
    const type = pick(VOICE_TYPES);
    const seg = new MediaRecorder(
      new MediaStream(l.audio.getAudioTracks()),
      type ? { mimeType: type } : undefined,
    );
    l.segChunks = [];
    const chunks = l.segChunks;
    seg.addEventListener('dataavailable', (e) => e.data.size && chunks.push(e.data));
    seg.start(250);
    l.seg = seg;
  };

  /**
   * The sound since the last cut, as its own recording, and a new one starts if the recording goes on. For an
   * interview's Next and its last answer at Stop.
   */
  const cut = (more = true): Promise<Blob | null> =>
    new Promise((resolve) => {
      const l = live.current;
      const seg = l?.seg;
      if (!l || !seg || seg.state === 'inactive') return resolve(null);
      const chunks = l.segChunks;
      seg.addEventListener(
        'stop',
        () => resolve(chunks.length ? new Blob(chunks, { type: seg.mimeType || 'audio/webm' }) : null),
        { once: true },
      );
      seg.stop();
      l.seg = null;
      if (more && live.current) {
        startSegment();
        const next = live.current?.seg as MediaRecorder | null | undefined;
        if (l.mr.state === 'paused') next?.pause();
      }
    });

  /** A chapter here, now. */
  const mark = (title: string) => {
    const at = Math.round(elapsed() * 100) / 100;
    chaptersRef.current = [...chaptersRef.current, { at, title }];
    setChapters(chaptersRef.current);
    return at;
  };

  const pause = () => {
    const l = live.current;
    if (l?.mr.state !== 'recording') return;
    l.mr.pause();
    if (l.seg?.state === 'recording') l.seg.pause();
    l.base = elapsed();
    l.since = null;
    setPhase('paused');
  };
  const resume = () => {
    const l = live.current;
    if (l?.mr.state !== 'paused') return;
    l.mr.resume();
    if (l.seg?.state === 'paused') l.seg.resume();
    l.since = performance.now();
    setPhase('recording');
  };
  const stop = () => {
    const l = live.current;
    if (!l) return;
    if (l.mr.state === 'inactive') {
      // Stopped during the countdown: nothing was recorded.
      release();
      setPhase('idle');
      return;
    }
    if (l.seg && l.seg.state !== 'inactive') l.seg.stop();
    l.mr.stop();
  };
  /** Stop, but first take the answer in progress, for an interview. */
  const finish = async (): Promise<Blob | null> => {
    const last = await cut(false);
    stop();
    return last;
  };
  const skipCountdown = () => startNow.current?.();
  const again = () => {
    forget();
    setClip(null);
    setSeconds(0);
    chaptersRef.current = [];
    setChapters([]);
    setProblem(null);
    setPhase(supported && offered.length ? 'idle' : 'unsupported');
  };
  const choose = (file: File) => keep(file, 0, []);

  /** Three seconds from the chosen microphone, played straight back, so the person hears how they sound. */
  const testMic = async () => {
    if (live.current || testing) return;
    let s: MediaStream;
    try {
      s = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints() });
    } catch {
      setProblem('The microphone is blocked. Allow it for this page and try again.');
      return;
    }
    void devices.refresh();
    setTesting('listening');
    const type = pick(VOICE_TYPES);
    const mr = new MediaRecorder(s, type ? { mimeType: type } : undefined);
    const chunks: Blob[] = [];
    mr.addEventListener('dataavailable', (e) => e.data.size && chunks.push(e.data));
    const ac = audioCtx();
    const an = ac.createAnalyser();
    an.fftSize = 1024;
    ac.createMediaStreamSource(s).connect(an);
    const buf = new Float32Array(an.fftSize);
    let raf = 0;
    const tick = () => {
      an.getFloatTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v));
      setLevel(peak);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    mr.addEventListener('stop', () => {
      cancelAnimationFrame(raf);
      setLevel(0);
      for (const t of s.getTracks()) t.stop();
      const u = URL.createObjectURL(new Blob(chunks, { type: mr.mimeType || 'audio/webm' }));
      const a = new Audio(u);
      setTesting('playing');
      const done = () => {
        URL.revokeObjectURL(u);
        setTesting(null);
      };
      a.addEventListener('ended', done);
      a.addEventListener('error', done);
      void a.play().catch(done);
    });
    mr.start();
    setTimeout(() => mr.state !== 'inactive' && mr.stop(), 3000);
  };

  // Space pauses and resumes, Esc stops, never while typing in a field.
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reads the latest state through refs.
  useEffect(() => {
    const typing = (t: EventTarget | null) =>
      t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    const down = (e: KeyboardEvent) => {
      const p = phaseRef.current;
      if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === ' ' && (p === 'recording' || p === 'paused')) {
        e.preventDefault();
        if (p === 'recording') pause();
        else resume();
      } else if (e.key === 'Escape' && (p === 'recording' || p === 'paused' || p === 'countdown')) {
        e.preventDefault();
        e.stopPropagation();
        stopKey.current();
      }
    };
    // A focused button would also take the space as a click when it comes up.
    const up = (e: KeyboardEvent) => {
      const p = phaseRef.current;
      if (e.key === ' ' && !typing(e.target) && (p === 'recording' || p === 'paused')) e.preventDefault();
    };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
    };
  }, []);
  /** What Esc does: the caller can make it finish an interview's answer first. */
  const stopKey = useRef<() => void>(() => stop());

  return {
    offered,
    screen,
    source,
    setSource,
    phase,
    problem,
    devices,
    mic,
    setMic,
    cam,
    setCam,
    bubble,
    setBubble,
    level,
    seconds,
    count,
    preview,
    clip,
    chapters,
    testing,
    start: begin,
    skipCountdown,
    pause,
    resume,
    stop,
    finish,
    cut,
    mark,
    elapsed,
    again,
    choose,
    testMic,
    stopKey,
  };
}
export type StudioRecorder = ReturnType<typeof useStudioRecorder>;

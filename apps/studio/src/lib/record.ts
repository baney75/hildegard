// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from 'react';

export type CaptureState = 'idle' | 'asking' | 'recording' | 'review' | 'denied' | 'unsupported';

const VOICE_TYPES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'];
const VIDEO_TYPES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];

let ctx: AudioContext | null = null;

/**
 * Record from the microphone, or the camera and microphone, for a voice-over or a video. Unlike the Studio's voice
 * recorder, which turns every filter off because a clone should hear the raw voice, this keeps the browser's noise
 * suppression and echo cancellation on: a voice-over is cleaned anyway, and room noise is what spoils it. Capture
 * starts only from `start()`, which a tap calls; nothing here asks for a device on its own.
 */
export function useCapture(kind: 'voice' | 'video') {
  const [state, setState] = useState<CaptureState>(() =>
    typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia ? 'unsupported' : 'idle',
  );
  const [level, setLevel] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [clip, setClip] = useState<{ blob: Blob; url: string; seconds: number } | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const rec = useRef<{ mr: MediaRecorder; stream: MediaStream; raf: number } | null>(null);
  const url = useRef<string | null>(null);

  const release = () => {
    const r = rec.current;
    if (!r) return;
    cancelAnimationFrame(r.raf);
    for (const t of r.stream.getTracks()) t.stop();
    rec.current = null;
    setStream(null);
  };
  const forget = () => {
    if (url.current) URL.revokeObjectURL(url.current);
    url.current = null;
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: lets go of the devices when the page closes.
  useEffect(
    () => () => {
      release();
      forget();
    },
    [],
  );

  const keep = (blob: Blob, secs: number) => {
    forget();
    url.current = URL.createObjectURL(blob);
    setClip({ blob, url: url.current, seconds: secs });
    setState('review');
  };

  const start = async () => {
    if (rec.current) return;
    setState('asking');
    let s: MediaStream;
    try {
      s = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false },
        video:
          kind === 'video' ? { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } } : false,
      });
    } catch {
      setState('denied');
      return;
    }
    const type = (kind === 'video' ? VIDEO_TYPES : VOICE_TYPES).find((t) => MediaRecorder.isTypeSupported(t));
    const mr = new MediaRecorder(s, type ? { mimeType: type } : undefined);
    const chunks: Blob[] = [];
    mr.addEventListener('dataavailable', (e) => e.data.size && chunks.push(e.data));
    const t0 = performance.now();
    mr.addEventListener('stop', () => {
      const secs = (performance.now() - t0) / 1000;
      release();
      setLevel(0);
      keep(new Blob(chunks, { type: mr.mimeType || (kind === 'video' ? 'video/webm' : 'audio/webm') }), secs);
    });
    ctx ??= new AudioContext();
    const an = ctx.createAnalyser();
    an.fftSize = 1024;
    ctx.createMediaStreamSource(s).connect(an);
    const buf = new Float32Array(an.fftSize);
    const tick = () => {
      an.getFloatTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v));
      setLevel(peak);
      setSeconds((performance.now() - t0) / 1000);
      if (rec.current) rec.current.raf = requestAnimationFrame(tick);
    };
    rec.current = { mr, stream: s, raf: requestAnimationFrame(tick) };
    setStream(s);
    setSeconds(0);
    mr.start(250);
    setState('recording');
  };
  const stop = () => {
    if (rec.current?.mr.state === 'recording') rec.current.mr.stop();
  };
  /** Throw this take away to make another. */
  const again = () => {
    forget();
    setClip(null);
    setSeconds(0);
    setState('idle');
  };
  /** A file the person chose instead (their camera app, a voice memo), when this browser can't record here. */
  const choose = (file: File) => keep(file, 0);
  return { state, level, seconds, clip, stream, start, stop, again, choose };
}

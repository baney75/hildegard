// SPDX-License-Identifier: AGPL-3.0-only
// useCapture: a dialog closed while the browser still asks for the microphone must never start recording later.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { cleanups } = vi.hoisted(() => ({ cleanups: [] as Array<() => void> }));
vi.mock('react', () => ({
  useState: (v: unknown) => [typeof v === 'function' ? (v as () => unknown)() : v, () => {}],
  useRef: (v: unknown) => ({ current: v }),
  useEffect: (f: () => () => void) => void cleanups.push(f()),
}));

import { useCapture } from '../src/lib/record.ts';

let recorders = 0;
let grant: (s: MediaStream) => void;
let refuse: (e: Error) => void;
const track = { stop: vi.fn() };
const stream = { getTracks: () => [track] } as unknown as MediaStream;

beforeEach(() => {
  recorders = 0;
  track.stop.mockClear();
  cleanups.length = 0;
  vi.stubGlobal(
    'MediaRecorder',
    class {
      static isTypeSupported = () => true;
      state = 'inactive';
      mimeType = 'audio/webm';
      constructor() {
        recorders += 1;
      }
      addEventListener() {}
      start() {
        this.state = 'recording';
      }
    },
  );
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: () =>
        new Promise<MediaStream>((resolve, reject) => {
          grant = resolve;
          refuse = reject;
        }),
    },
  });
  vi.stubGlobal(
    'AudioContext',
    class {
      createAnalyser = () => ({ fftSize: 0, getFloatTimeDomainData() {} });
      createMediaStreamSource = () => ({ connect() {} });
    },
  );
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
});
afterEach(() => vi.unstubAllGlobals());

describe('useCapture', () => {
  it('records once permission arrives while the dialog is open', async () => {
    const cap = useCapture('voice');
    const going = cap.start();
    grant(stream);
    await going;
    expect(recorders).toBe(1);
    expect(track.stop).not.toHaveBeenCalled();
  });

  it('stops the devices and never records when permission arrives after the dialog closed', async () => {
    const cap = useCapture('voice');
    const going = cap.start();
    for (const close of cleanups) close();
    grant(stream);
    await going;
    expect(recorders).toBe(0);
    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it('stays quiet when permission is refused after the dialog closed', async () => {
    const cap = useCapture('voice');
    const going = cap.start();
    for (const close of cleanups) close();
    refuse(new Error('denied'));
    await expect(going).resolves.toBeUndefined();
    expect(recorders).toBe(0);
  });
});

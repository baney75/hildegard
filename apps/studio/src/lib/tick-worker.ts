// SPDX-License-Identifier: AGPL-3.0-only
// A steady clock for drawing the screen and camera together. A page in the background gets its timers and animation
// frames slowed to one a second or stopped, which would freeze the recording while the person shares another window;
// a worker's timer keeps its pace.
let timer: ReturnType<typeof setInterval> | null = null;
self.onmessage = (e: MessageEvent<{ fps: number } | 'stop'>) => {
  if (timer) clearInterval(timer);
  timer = null;
  if (e.data !== 'stop') timer = setInterval(() => self.postMessage(0), 1000 / e.data.fps);
};

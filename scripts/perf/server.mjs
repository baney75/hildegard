// SPDX-License-Identifier: AGPL-3.0-only
// Server bench: cold start to the first /api/health, the calls the Studio makes on load (p50/p95), the event stream's
// first event, and memory at idle. Starts its own fake-GPU server; never touches an installed Hildegard.
import { median, now, pct, round, scratch, seedLargeState, sleep, startServer } from './lib.mjs';

/** What the Studio asks for when it opens, then the owner pages' own calls. */
export const ENDPOINTS = [
  '/api/health',
  '/api/auth/me',
  '/api/catalog',
  '/api/snapshot',
  '/api/hf',
  '/api/choir',
  '/api/host',
  '/api/llm',
  '/api/tunnel',
  '/api/agents',
  '/api/people',
];

async function firstEventMs(url) {
  const t0 = now();
  const ctl = new AbortController();
  const res = await fetch(`${url}/api/events`, { signal: ctl.signal });
  const reader = res.body.getReader();
  let text = '';
  const dec = new TextDecoder();
  while (!text.includes('\n\n')) {
    const { value, done } = await reader.read();
    if (done) break;
    text += dec.decode(value);
  }
  const ms = now() - t0;
  ctl.abort();
  return { ms, bytes: text.length };
}

export async function benchServer({ port, calls = 50, colds = 5, seeded = false, log = () => {} } = {}) {
  const result = { coldStartMs: null, coldStartRuns: [], endpoints: {}, eventStream: null, idleRssMb: null };
  // Cold start: a fresh data folder each time, so nothing is cached by the OS for us but the code on disk.
  for (let i = 0; i < colds; i++) {
    const s = scratch();
    const srv = await startServer({ port, data: s.data, home: s.home });
    result.coldStartRuns.push(srv.coldMs);
    await srv.stop();
    log(`cold start ${i + 1}/${colds}: ${round(srv.coldMs)} ms`);
  }
  result.coldStartMs = round(median(result.coldStartRuns));

  const s = scratch();
  if (seeded) seedLargeState(s.data);
  const srv = await startServer({ port, data: s.data, home: s.home });
  try {
    for (const path of ENDPOINTS) {
      const times = [];
      let status = 0;
      let bytes = 0;
      for (let i = 0; i < calls; i++) {
        const t0 = now();
        const r = await fetch(srv.url + path);
        const body = await r.arrayBuffer();
        times.push(now() - t0);
        status = r.status;
        bytes = body.byteLength;
      }
      result.endpoints[path] = {
        status,
        bytes,
        first: round(times[0]),
        p50: round(pct(times, 50), 2),
        p95: round(pct(times, 95), 2),
      };
      log(`${path}: p50 ${result.endpoints[path].p50} ms, p95 ${result.endpoints[path].p95} ms`);
    }
    const events = [];
    for (let i = 0; i < 10; i++) events.push((await firstEventMs(srv.url)).ms);
    result.eventStream = { p50: round(median(events), 2), p95: round(pct(events, 95), 2) };
    await sleep(1500);
    result.idleRssMb = round(srv.rssMb());
    log(`event stream first event p50 ${result.eventStream.p50} ms; idle RSS ${result.idleRssMb} MB`);
  } finally {
    await srv.stop();
  }
  return result;
}

if (import.meta.main) {
  const port = Number(process.env.PERF_PORT ?? 7540);
  const r = await benchServer({ port, log: (m) => console.error(m) });
  console.log(JSON.stringify(r, null, 2));
}

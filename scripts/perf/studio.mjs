// SPDX-License-Identifier: AGPL-3.0-only
// Studio bench, in headless Playwright Chromium (its own, never the owner's browser): JS and CSS bytes per route,
// first contentful paint, largest contentful paint, an estimate of time to interactive, layout shift, long tasks and
// route-switch time, cold (empty cache) and warm (reloaded), then scroll smoothness and memory with 500 takes and 500 images.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileSizes, median, ROOT, round, scratch, seedLargeState, startServer } from './lib.mjs';

const require = createRequire(join(ROOT, 'apps/studio/package.json'));

export const ROUTES = [
  ['Cinema', '/'],
  ['Images', '/images'],
  ['Queue', '/queue'],
  ['Settings', '/settings'],
  ['Sites', '/sites'],
  ['Voice', '/voice'],
  ['Talk', '/talk'],
];

/** Installed before any page script runs: collects paint, layout shift and long tasks, and when the app first rendered. */
const COLLECTOR = `
(() => {
  const p = (window.__perf = { fcp: null, lcp: null, cls: 0, longTasks: [], appAt: null, lastMutation: 0 });
  const obs = (type, fn) => {
    try { new PerformanceObserver((l) => l.getEntries().forEach(fn)).observe({ type, buffered: true }); } catch {}
  };
  obs('paint', (e) => { if (e.name === 'first-contentful-paint') p.fcp = e.startTime; });
  obs('largest-contentful-paint', (e) => { p.lcp = e.startTime; });
  obs('layout-shift', (e) => { if (!e.hadRecentInput) p.cls += e.value; });
  obs('longtask', (e) => { p.longTasks.push([e.startTime, e.duration]); });
  new MutationObserver(() => {
    p.lastMutation = performance.now();
    if (p.appAt === null && document.querySelector('.hg-app') && !document.querySelector('.hg-boot')) p.appAt = p.lastMutation;
  }).observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
  /** Change the route and say how long until the page stopped changing (the quiet 150 ms is not counted). */
  window.__switch = (hash) => new Promise((resolve) => {
    const t0 = performance.now();
    const before = p.longTasks.length;
    let last = t0;
    const mo = new MutationObserver(() => { last = performance.now(); });
    mo.observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
    location.hash = hash;
    const tick = () => {
      if (performance.now() - last > 150 && performance.now() - t0 > 160) {
        mo.disconnect();
        requestAnimationFrame(() => resolve({
          ms: last - t0,
          longTasks: p.longTasks.length - before,
          longMs: p.longTasks.slice(before).reduce((a, t) => a + t[1], 0),
        }));
      } else setTimeout(tick, 20);
    };
    setTimeout(tick, 20);
  });
})();
`;

const ASSET = /\.(js|mjs|css)$/;

async function loadRoute(context, base, route, { throttle, warm }) {
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  if (throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  const responses = new Map();
  page.on('requestfinished', async (req) => {
    try {
      const res = await req.response();
      const sizes = await req.sizes();
      responses.set(req.url(), {
        status: res?.status(),
        wire: sizes.responseBodySize + sizes.responseHeadersSize,
      });
    } catch {}
  });
  await page.addInitScript(COLLECTOR);
  const url = `${base}/#${route}`;
  if (warm) {
    // Warm: the page has been open once, then it is reloaded with the HTTP cache full.
    await page.goto(url);
    await page.waitForFunction(() => window.__perf?.appAt !== null);
    await page.waitForTimeout(800);
    responses.clear();
    await page.reload();
  } else await page.goto(url);
  await page.waitForFunction(() => window.__perf?.appAt !== null, null, { timeout: 30000 });
  // Quiet time, so the last long task and the largest paint have happened.
  await page.waitForTimeout(1500);
  const m = await page.evaluate(() => {
    const p = window.__perf;
    const nav = performance.getEntriesByType('navigation')[0];
    const lastLong = p.longTasks.reduce((a, [s, d]) => Math.max(a, s + d), 0);
    return {
      fcp: p.fcp,
      lcp: p.lcp,
      appReady: p.appAt,
      // Time to interactive, estimated: the later of first paint and the end of the last long task, since the main
      // thread is free after that. (Lighthouse's own needs a 5 s quiet window; this is the same idea, shorter.)
      tti: Math.max(p.fcp ?? 0, lastLong),
      cls: p.cls,
      longTasks: p.longTasks.length,
      longMs: p.longTasks.reduce((a, t) => a + t[1], 0),
      dcl: nav?.domContentLoadedEventEnd ?? null,
      load: nav?.loadEventEnd ?? null,
    };
  });
  const files = [...responses.entries()].filter(([u]) => ASSET.test(new URL(u).pathname));
  const totals = {
    js: { files: 0, raw: 0, gzip: 0, brotli: 0 },
    css: { files: 0, raw: 0, gzip: 0, brotli: 0 },
  };
  for (const [u] of files) {
    const rel = new URL(u).pathname.slice(1);
    let s;
    try {
      s = fileSizes(rel);
    } catch {
      continue;
    }
    const t = rel.endsWith('.css') ? totals.css : totals.js;
    t.files++;
    t.raw += s.raw;
    t.gzip += s.gzip;
    t.brotli += s.brotli;
  }
  const out = {
    requests: responses.size,
    wireBytes: [...responses.values()].reduce((a, r) => a + (r.wire ?? 0), 0),
    js: totals.js,
    css: totals.css,
    fcp: round(m.fcp),
    lcp: round(m.lcp),
    tti: round(m.tti),
    appReady: round(m.appReady),
    cls: round(m.cls, 4),
    longTasks: m.longTasks,
    longMs: round(m.longMs),
  };
  await page.close();
  return out;
}

/** Click through every route in one open Studio, as a person would, and time each switch. */
async function routeSwitches(context, base, { throttle }) {
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  if (throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  await page.addInitScript(COLLECTOR);
  await page.goto(`${base}/#/`);
  await page.waitForFunction(() => window.__perf?.appAt !== null);
  await page.waitForTimeout(1000);
  const out = {};
  // First visit to each route (a lazy route fetches its code now), then a second visit (cached).
  for (const pass of ['first', 'again']) {
    for (const [name, route] of [...ROUTES.slice(1), ROUTES[0]]) {
      const r = await page.evaluate((h) => window.__switch(h), `#${route}`);
      out[name] ??= {};
      out[name][pass] = { ms: round(r.ms), longTasks: r.longTasks, longMs: round(r.longMs) };
      await page.waitForTimeout(300);
    }
  }
  await page.close();
  return out;
}

/** Scroll the busiest list top to bottom a fixed distance each frame, and count frames and heap. */
async function scrollGrid(context, base, route, { throttle }) {
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  if (throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  await cdp.send('Performance.enable');
  await page.addInitScript(COLLECTOR);
  const t0 = Date.now();
  await page.goto(`${base}/#${route}`);
  await page.waitForFunction(() => window.__perf?.appAt !== null, null, { timeout: 30000 });
  await page.waitForTimeout(1500);
  const loadMs = Date.now() - t0;
  const heap = async () => {
    const { metrics } = await cdp.send('Performance.getMetrics');
    const get = (n) => metrics.find((x) => x.name === n)?.value ?? 0;
    return {
      heapMb: get('JSHeapUsedSize') / 1048576,
      nodes: get('Nodes'),
      listeners: get('JSEventListeners'),
    };
  };
  const before = await heap();
  const scroll = await page.evaluate(async () => {
    // The element that scrolls: the tallest scrollable one on the page.
    let best = document.scrollingElement;
    let bestH = best.scrollHeight - best.clientHeight;
    for (const el of document.querySelectorAll('*')) {
      const o = getComputedStyle(el).overflowY;
      if ((o === 'auto' || o === 'scroll') && el.scrollHeight - el.clientHeight > bestH) {
        best = el;
        bestH = el.scrollHeight - el.clientHeight;
      }
    }
    const total = bestH;
    const step = Math.max(24, Math.round(best.clientHeight / 12));
    const frames = [];
    let last = performance.now();
    const start = last;
    // At the bottom, a grid that draws more as it nears the end gets half a second to grow before the scroll is over.
    let idle = 0;
    await new Promise((resolve) => {
      const tick = () => {
        const t = performance.now();
        frames.push(t - last);
        last = t;
        best.scrollTop += step;
        const atEnd = best.scrollTop + best.clientHeight >= best.scrollHeight - 2;
        if (t - start > 12000) resolve();
        else if (!atEnd) {
          idle = 0;
          requestAnimationFrame(tick);
        } else if (++idle > 30) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const elapsed = performance.now() - start;
    frames.shift();
    frames.sort((a, b) => a - b);
    return {
      scrollable: total,
      frames: frames.length,
      elapsed,
      fps: (frames.length / elapsed) * 1000,
      p95: frames[Math.floor(frames.length * 0.95)] ?? 0,
      worst: frames.at(-1) ?? 0,
      slow: frames.filter((f) => f > 20).length,
    };
  });
  const after = await heap();
  const images = await page.evaluate(() => document.images.length);
  const out = {
    loadMs,
    domNodesAtLoad: Math.round(before.nodes),
    domNodes: Math.round(after.nodes),
    images,
    scrollPx: Math.round(scroll.scrollable),
    fps: round(scroll.fps),
    frameP95Ms: round(scroll.p95),
    worstFrameMs: round(scroll.worst),
    framesOver20ms: scroll.slow,
    heapMbBefore: round(before.heapMb),
    heapMbAfter: round(after.heapMb),
  };
  await page.close();
  return out;
}

export async function benchStudio({
  port,
  throttle = 4,
  repeats = 3,
  parts = ['routes', 'switches', 'grid'],
  log = () => {},
} = {}) {
  const { chromium } = require('@playwright/test');
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM || undefined;
  const result = { throttle, routes: {}, switches: {}, grid: {} };
  const s = scratch();
  const srv = await startServer({ port, data: s.data, home: s.home });
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    for (const [name, route] of parts.includes('routes') ? ROUTES : []) {
      result.routes[name] = {};
      for (const mode of ['cold', 'warm']) {
        const runs = [];
        for (let i = 0; i < repeats; i++) {
          const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
          runs.push(await loadRoute(context, srv.url, route, { throttle, warm: mode === 'warm' }));
          await context.close();
        }
        // Bytes are the same every run; times are the median of the runs.
        const pick = (k) =>
          round(median(runs.map((r) => r[k]).filter((v) => v !== null)), k === 'cls' ? 4 : 1);
        result.routes[name][mode] = {
          requests: runs[0].requests,
          wireBytes: runs[0].wireBytes,
          js: runs[0].js,
          css: runs[0].css,
          fcp: pick('fcp'),
          lcp: pick('lcp'),
          tti: pick('tti'),
          appReady: pick('appReady'),
          cls: pick('cls'),
          longTasks: pick('longTasks'),
          longMs: pick('longMs'),
        };
        const r = result.routes[name][mode];
        log(
          `${name} ${mode}: js ${(r.js.brotli / 1024).toFixed(0)} KB br, FCP ${r.fcp} ms, LCP ${r.lcp} ms, TTI ${r.tti} ms, long ${r.longTasks}x${r.longMs} ms`,
        );
      }
    }
    if (parts.includes('switches')) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      result.switches = await routeSwitches(context, srv.url, { throttle });
      await context.close();
      log(
        `route switches (first visit): ${Object.entries(result.switches)
          .map(([n, v]) => `${n} ${v.first.ms}`)
          .join(', ')} ms`,
      );
    }
  } finally {
    await srv.stop();
  }
  // The big grids, on a server whose history holds 500 takes and 500 images.
  const g = scratch();
  seedLargeState(g.data);
  const big = await startServer({ port, data: g.data, home: g.home });
  try {
    for (const [name, route] of parts.includes('grid')
      ? [
          ['Queue (500 takes)', '/queue'],
          ['Images (500 stills)', '/images'],
        ]
      : []) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      result.grid[name] = await scrollGrid(context, big.url, route, { throttle });
      await context.close();
      const r = result.grid[name];
      log(
        `${name}: ${r.domNodes} nodes, ${r.images} images, ${r.fps} fps, p95 frame ${r.frameP95Ms} ms, heap ${r.heapMbAfter} MB`,
      );
    }
  } finally {
    await big.stop();
    await browser.close();
  }
  return result;
}

if (import.meta.main) {
  const r = await benchStudio({
    port: Number(process.env.PERF_PORT ?? 7544),
    throttle: Number(process.env.PERF_THROTTLE ?? 4),
    repeats: Number(process.env.PERF_REPEATS ?? 3),
    parts: (process.env.PERF_PARTS ?? 'routes,switches,grid').split(','),
    log: (m) => console.error(m),
  });
  console.log(JSON.stringify(r, null, 2));
}

// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `hildegard demo browser`: record a site or an unpacked extension in a browser of its own, on a clean backdrop, driven
 * by a step script or by you in the window. It lands with your recordings. The browser is Playwright's Chromium with a
 * throwaway profile; if it isn't here, this says the command to install it and stops.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { api, type Ctx, ensureRunning } from './commands.ts';
import { type Result, result } from './output.ts';

interface Job {
  id: string;
  status: 'starting' | 'recording' | 'rendering' | 'done' | 'failed' | 'stopped';
  stage: string | null;
  log: string[];
  error: string | null;
  recording: { id: string; url: string | null; file?: string | null; seconds: number | null } | null;
}

export const DEMO_HELP = `hildegard demo browser --url <address> [--extension <folder>] [--steps <file.json>]
       [--size 1280x800] [--backdrop viridian|dusk|vellum|ember|ink|paper|none|#rrggbb]
       [--aspect 16:9|1:1|9:16] [--zoom]
  Without --steps, a window opens for you to drive; press Ctrl+C here to stop and keep it.`;

export async function demo(ctx: Ctx, args: string[]): Promise<Result> {
  if (args[0] !== 'browser')
    return result([], `Try: ${DEMO_HELP}`, { ok: args[0] === undefined || args[0] === 'help' });
  const url = ctx.opts.get('url');
  if (!url) return result([], `Give the address to open. ${DEMO_HELP}`, { ok: false });
  const size = ctx.opts.get('size') ?? '1280x800';
  const m = /^(\d{3,4})x(\d{3,4})$/.exec(size);
  if (!m) return result([], 'Give the size as width x height, like 1280x800.', { ok: false });
  let steps: unknown;
  const file = ctx.opts.get('steps');
  if (file) {
    try {
      steps = JSON.parse(readFileSync(resolve(file), 'utf8'));
    } catch (e) {
      return result([], `Couldn’t read the steps in ${file}: ${(e as Error).message}`, { ok: false });
    }
  }
  const pre = await ensureRunning(ctx);
  if (pre?.status === 'failed') return result([pre], 'Hildegard isn’t running.');
  // A file address is a file in this project: the folder you run this in.
  const root = process.cwd();
  const address = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : pathToFileURL(resolve(url)).toString();
  const ext = ctx.opts.get('extension');
  let job: Job;
  try {
    job = await api<Job>(ctx.config, '/api/demos', {
      method: 'POST',
      body: {
        url: address,
        extension: ext ? resolve(ext) : undefined,
        steps,
        width: Number(m[1]),
        height: Number(m[2]),
        backdrop: ctx.opts.get('backdrop'),
        aspect: ctx.opts.get('aspect'),
        zoom: ctx.flags.has('zoom'),
        root,
      },
    });
  } catch (e) {
    const message = (e as Error).message;
    return result([{ id: 'demo', title: 'Browser demo', status: 'failed', detail: message }], message, {
      ok: false,
    });
  }
  const live = steps === undefined;
  if (live && !ctx.json)
    console.log('Recording. Use the window, then press Ctrl+C here to stop and keep it.');
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void api(ctx.config, `/api/demos/${job.id}/stop`, { method: 'POST', body: {} }).catch(() => {});
  };
  if (live) process.once('SIGINT', stop);
  let said = 0;
  for (;;) {
    job = await api<Job>(ctx.config, `/api/demos/${job.id}`);
    if (!ctx.json) for (; said < job.log.length; said++) console.log(`  ${job.log[said]}`);
    if (job.status === 'done' || job.status === 'failed' || job.status === 'stopped') break;
    await new Promise((r) => setTimeout(r, 500));
  }
  process.off('SIGINT', stop);
  if (job.status === 'failed' || !job.recording)
    return result(
      [{ id: 'demo', title: 'Browser demo', status: 'failed', detail: job.error ?? 'It stopped.' }],
      job.error ?? 'The demo stopped.',
      { ok: false },
    );
  const r = job.recording;
  return result(
    [
      {
        id: 'demo',
        title: 'Browser demo',
        status: 'done',
        detail: `Media id ${r.id}${r.seconds ? `, ${r.seconds.toFixed(1)} seconds` : ''}${r.file ? `: ${r.file}` : ''}.`,
      },
    ],
    'The demo is with your recordings, in the Studio’s Record page.',
  );
}

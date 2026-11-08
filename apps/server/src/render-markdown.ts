// SPDX-License-Identifier: AGPL-3.0-only
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { SiteError } from './sites.ts';

const TOO_COMPLEX = 'This post is too complex to render. Split long runs of `, *, [ or ( and try again.';

/**
 * Renders a post's Markdown in a worker thread and stops the worker after `ms`, so text built to make the renderer
 * crawl costs a second of one thread and the server's own loop never runs the patterns. Past the budget the post is
 * refused with a 422. In the release the worker is its own file beside hildegard.mjs.
 */
export function renderMarkdown(src: string, ms = 1000): Promise<string> {
  const res = process.env.HILDEGARD_RESOURCES;
  const file = res ? join(res, 'markdown-worker.mjs') : new URL('./markdown-worker.ts', import.meta.url);
  return new Promise((resolve, reject) => {
    const w = new Worker(file, { workerData: src });
    const end = (settle: () => void) => {
      clearTimeout(timer);
      void w.terminate();
      settle();
    };
    const timer = setTimeout(() => end(() => reject(new SiteError(422, 'body_md', TOO_COMPLEX))), ms);
    w.once('message', (html: string) => end(() => resolve(html)));
    w.once('error', (e) => end(() => reject(e)));
    w.once('exit', () => end(() => reject(new Error('The Markdown worker stopped without an answer.'))));
  });
}

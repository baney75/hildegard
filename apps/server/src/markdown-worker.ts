// SPDX-License-Identifier: AGPL-3.0-only
// Runs the Markdown renderer in its own thread; render-markdown.ts starts it and stops it if it takes too long.
import { parentPort, workerData } from 'node:worker_threads';
import { markdown } from './markdown.ts';

parentPort?.postMessage(markdown(workerData as string));

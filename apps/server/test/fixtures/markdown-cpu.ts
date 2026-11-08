// SPDX-License-Identifier: AGPL-3.0-only
// Renders one hostile post from markdown-cases.ts and prints the least CPU time of three runs, in ms. The test runs
// this in a child process with a timeout, so a renderer that backtracks is killed and fails instead of freezing the suite.
import { markdown } from '../../src/markdown.ts';
import { CASES } from './markdown-cases.ts';

const name = process.argv[2] ?? '';
const make = CASES[name];
if (!make) throw new Error(`No case called “${name}”.`);
const src = make();
let best = Number.POSITIVE_INFINITY;
let length = 0;
for (let i = 0; i < 3; i++) {
  const t = process.cpuUsage();
  length = markdown(src).length;
  const d = process.cpuUsage(t);
  best = Math.min(best, (d.user + d.system) / 1000);
}
console.log(JSON.stringify({ ms: best, length, input: src.length }));

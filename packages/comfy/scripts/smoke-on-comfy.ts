// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Renders a real video through comfy-api-proxy and ComfyUI with the same engine the server uses: upload a start
 * frame, queue, stream progress, download the MP4. The graph needs no model weights (a still, repeated, through the
 * film look), so it runs on a CPU in seconds.
 *
 *   node packages/comfy/scripts/smoke-on-comfy.ts [proxy-url]
 *
 * ComfyUI must have the hildegard_look node in custom_nodes.
 */
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeShot, loadCatalog, ShotRequest } from '@hildegard/presets';
import { ComfySdkEngine } from '../src/engine.ts';
import { GraphBuilder, out } from '../src/graph.ts';

const url = process.argv[2] ?? 'http://127.0.0.1:8189';
const { catalog } = loadCatalog();
const shot = composeShot(
  catalog,
  ShotRequest.parse({
    prompt: 'smoke test',
    rig: { body: catalog.bodies[0]!.id, lens: catalog.lenses[0]!.id, focal: 35, aperture: 2.8 },
    format: { aspect: '16:9', seconds: 2, quality: 'draft' },
  }),
);

const g = new GraphBuilder();
const still = g.add('LoadImage', { image: 'placeholder.png' }, 'Start frame');
const scaled = g.add('ImageScale', {
  image: out(still),
  upscale_method: 'bilinear',
  width: 128,
  height: 72,
  crop: 'center',
});
const frames = g.add('RepeatImageBatch', { image: out(scaled), amount: 12 });
const look = g.add('HildegardLook', { images: out(frames), seed: 7, ...shot.post }, 'Film look');
const vid = g.add('CreateVideo', { images: out(look), fps: 12 });
const save = g.add('SaveVideo', { video: out(vid), filename_prefix: 'hildegard-smoke/x', format: 'mp4' });

const dir = mkdtempSync(join(tmpdir(), 'hg-smoke-'));
const frame = join(dir, 'frame.png');
// An 8×8 gradient PNG, so the look has something to grade.
writeFileSync(
  frame,
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAGUlEQVR42mNkYGhQYGDARCwMCgxYweCUAABobwJednxjlwAAAABJRU5ErkJggg==',
    'base64',
  ),
);
const dest = join(dir, 'out.mp4');
const engine = new ComfySdkEngine(url);
if (!(await engine.ping())) {
  console.error(`No comfy-api-proxy answers at ${url}`);
  process.exit(1);
}

let progress = 0;
const t0 = Date.now();
await engine.render(
  { graph: g.graph, outputNode: save, startFrameNode: still },
  {
    startFrame: frame,
    dest,
    handlers: {
      onRunning: () => console.log('running'),
      onProgress: () => progress++,
    },
  },
);
const size = statSync(dest).size;
const isMp4 = readFileSync(dest).subarray(4, 8).toString() === 'ftyp';
console.log(`rendered ${size} bytes in ${Date.now() - t0} ms, ${progress} progress events, mp4=${isMp4}`);
process.exit(size > 0 && isMp4 ? 0 : 1);

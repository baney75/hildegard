// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Checks every graph Hildegard can build against a real ComfyUI: node names, input names, types and ranges, and the
 * model file names its loaders expect. ComfyUI validates a prompt before it runs anything, so this needs no GPU and no
 * weights, only empty stand-in files with the right names.
 *
 *   node packages/comfy/scripts/validate-on-comfy.ts --prepare <comfyui-dir>   before starting ComfyUI
 *   node packages/comfy/scripts/validate-on-comfy.ts <comfyui-dir> [comfyui-url]
 *
 * ComfyUI lists model files when it starts, so prepare first. The ComfyUI at the URL must run from <comfyui-dir>,
 * with the hildegard_look and hildegard_guard nodes in custom_nodes.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { composeShot, loadCatalog, ShotRequest } from '@hildegard/presets';
import { buildGraph } from '../src/graph.ts';

const args = process.argv.slice(2);
const prepare = args[0] === '--prepare';
const [comfyDir, url = 'http://127.0.0.1:8188'] = prepare ? args.slice(1) : args;
if (!comfyDir) {
  console.error('usage: validate-on-comfy.ts <comfyui-dir> [comfyui-url]');
  process.exit(2);
}

const { catalog } = loadCatalog();

// Stand-ins for every model file, so loaders accept the names.
for (const f of [
  catalog.safety.classifier,
  ...catalog.models.flatMap((m) => [...m.files, ...Object.values(m.loras)]),
]) {
  const dir = join(comfyDir, 'models', f.dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, basename(f.path)), '');
}
// A start frame: a 1×1 PNG.
mkdirSync(join(comfyDir, 'input'), { recursive: true });
writeFileSync(
  join(comfyDir, 'input', 'hildegard-check.png'),
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    'base64',
  ),
);

if (prepare) {
  console.log(`Stand-in model files and a start frame are in ${comfyDir}`);
  process.exit(0);
}

const cases = catalog.models.flatMap((m) =>
  (['draft', 'final'] as const).flatMap((quality) => [false, true].map((frame) => ({ m, quality, frame }))),
);

let failed = 0;
for (const { m, quality, frame } of cases) {
  const motion = Object.keys(m.loras).length
    ? [{ id: catalog.motions.find((x) => x.impl[m.id]?.kind === 'lora')?.id ?? catalog.motions[0]!.id }]
    : [{ id: catalog.motions[0]!.id }];
  const shot = composeShot(
    catalog,
    ShotRequest.parse({
      prompt: 'A lighthouse keeper climbs the spiral stairs at dusk',
      rig: { body: catalog.bodies[0]!.id, lens: catalog.lenses[0]!.id, focal: 35, aperture: 2.8 },
      motion,
      format: { aspect: '16:9', seconds: 5, quality },
      model: m.id,
    }),
  );
  const { graph } = buildGraph({
    shot,
    seed: 1,
    prefix: 'hildegard-check/x',
    startFrame: frame ? 'hildegard-check.png' : undefined,
  });
  const res = await fetch(`${url}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: graph, client_id: 'hildegard-check' }),
  });
  const body = (await res.json()) as { error?: { message: string }; node_errors?: Record<string, unknown> };
  const name = `${m.id} · ${quality}${frame ? ' · start frame' : ''}`;
  if (res.ok) console.log(`ok    ${name}`);
  else {
    failed++;
    console.log(`FAIL  ${name}: ${body.error?.message}\n${JSON.stringify(body.node_errors, null, 2)}`);
  }
}

// Valid prompts were queued; nothing should actually run.
await fetch(`${url}/interrupt`, { method: 'POST' });
await fetch(`${url}/queue`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ clear: true }),
});

console.log(`${cases.length - failed} of ${cases.length} graphs valid on ComfyUI`);
process.exit(failed ? 1 : 0);

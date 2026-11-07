// SPDX-License-Identifier: AGPL-3.0-only
// ops_seed.mjs <data dir> <model id,model id,...>
// Makes the listed models "installed" in a fake world without downloading anything: a sparse file of exactly the pinned size
// for each of the model's files (the safety classifier included), and the license acceptance the owner would have given.
// Prints {"files": [{"model","path","size"}], ...} so the harness knows where everything is.
import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { loadCatalog } = await import(join(here, '../../packages/presets/src/index.ts'));
const { lockKey } = await import(join(here, '../../packages/presets/src/index.ts'));

const [dataDir, list = ''] = process.argv.slice(2);
const ids = list.split(',').filter(Boolean);
const { catalog, lock } = loadCatalog(join(here, '../../presets'));
const modelsDir = join(resolve(dataDir), 'comfyui', 'models');
const out = { modelsDir, files: [], safety: null };
const accepted = {};
const lic = join(resolve(dataDir), 'licenses.json');
if (existsSync(lic)) Object.assign(accepted, JSON.parse(readFileSync(lic, 'utf8')));

const put = (f, model) => {
  const path = join(modelsDir, f.dir, basename(f.path));
  const size = lock.files[lockKey(f)]?.size ?? f.size;
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'w');
  ftruncateSync(fd, size);
  closeSync(fd);
  out.files.push({ model, path, size });
};

for (const id of ids) {
  const m = catalog.models.find((x) => x.id === id);
  if (!m) throw new Error(`no model ${id}`);
  for (const f of [...m.files, ...Object.values(m.loras)]) put(f, id);
  accepted[id] = { license: m.license, licenseUrl: m.licenseUrl, acceptedAt: '2026-11-01T12:00:00.000Z' };
}
if (ids.length) {
  put(catalog.safety.classifier, 'safety');
  writeFileSync(lic, JSON.stringify(accepted, null, 2));
}
console.log(JSON.stringify(out));

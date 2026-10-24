// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'smol-toml';
import { loadSafety, type SafetyCheck } from './safety.ts';
import { Catalog, lockKey, ModelLock } from './schema.ts';

/** The repo's `presets/` folder. Overridable so packaged builds can ship it elsewhere. */
export const defaultPresetsDir = (): string =>
  process.env.HILDEGARD_PRESETS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '../../../presets');

export interface LoadedCatalog {
  catalog: Catalog;
  lock: ModelLock;
}

/** Parse and cross-check the catalog. Throws one error listing every problem, so a bad preset never half-loads. */
export function parseCatalog(
  cinemaToml: string,
  modelsToml: string,
  lockJson: string,
  safety?: SafetyCheck,
): LoadedCatalog {
  const raw = { ...parse(cinemaToml), ...parse(modelsToml) };
  const catalog = Catalog.parse(raw);
  const lock = ModelLock.parse(JSON.parse(lockJson));
  const problems = checkCatalog(catalog, lock, safety);
  if (problems.length)
    throw new Error(`Preset catalog has ${problems.length} problem(s):\n- ${problems.join('\n- ')}`);
  return { catalog, lock };
}

export function loadCatalog(dir = defaultPresetsDir()): LoadedCatalog {
  const read = (f: string) => readFileSync(join(dir, f), 'utf8');
  return parseCatalog(read('cinema.toml'), read('models.toml'), read('models.lock.json'), loadSafety(dir));
}

export function checkCatalog(c: Catalog, lock: ModelLock, safety?: SafetyCheck): string[] {
  const problems: string[] = [];
  const unique = (what: string, ids: Array<string | number>) => {
    const seen = new Set<string | number>();
    for (const id of ids) {
      if (seen.has(id)) problems.push(`${what} "${id}" is defined twice`);
      seen.add(id);
    }
  };
  unique(
    'body',
    c.bodies.map((x) => x.id),
  );
  unique(
    'lens',
    c.lenses.map((x) => x.id),
  );
  unique(
    'focal length',
    c.focals.map((x) => x.mm),
  );
  unique(
    'motion',
    c.motions.map((x) => x.id),
  );
  unique(
    'lighting',
    c.lightings.map((x) => x.id),
  );
  unique(
    'palette',
    c.palettes.map((x) => x.id),
  );
  unique(
    'genre',
    c.genres.map((x) => x.id),
  );
  unique(
    'era',
    c.eras.map((x) => x.id),
  );
  unique(
    'aspect',
    c.aspects.map((x) => x.id),
  );
  unique(
    'model',
    c.models.map((x) => x.id),
  );

  const aspects = new Set(c.aspects.map((a) => a.id));
  for (const l of c.lenses) {
    if (l.aspect && !aspects.has(l.aspect)) problems.push(`lens "${l.id}" uses unknown aspect ${l.aspect}`);
  }
  const models = new Map(c.models.map((m) => [m.id, m]));
  for (const m of c.motions) {
    for (const [modelId, impl] of Object.entries(m.impl)) {
      const model = models.get(modelId);
      if (!model) problems.push(`motion "${m.id}" has a recipe for unknown model "${modelId}"`);
      else if (impl.kind === 'lora' && !model.loras[impl.lora])
        problems.push(`motion "${m.id}" needs LoRA "${impl.lora}", which model "${modelId}" doesn't list`);
    }
  }
  for (const m of c.models) {
    for (const f of [...m.files, ...Object.values(m.loras)]) {
      const pin = lock.files[lockKey(f)];
      if (pin && Math.abs(pin.size - f.size) / pin.size > 0.25)
        problems.push(`${lockKey(f)}: size in models.toml is far from the locked size; update it`);
      // Nothing sexual gets into the catalog, by name, card or hash, however the presets folder was changed.
      const why = safety?.model({
        repo: f.repo,
        name: m.name,
        description: m.blurb,
        files: [{ name: f.path, sha256: pin?.sha256 }],
      });
      if (why?.length) problems.push(`${lockKey(f)} is refused: ${why.join('; ')}`);
    }
  }
  const guard = c.safety.classifier;
  if (guard.dir !== 'safety') problems.push('the safety classifier belongs in the safety folder');
  if (safety && !safety.trusted(guard.repo))
    problems.push(`the safety classifier ${guard.repo} isn’t one of safety.toml’s trusted repos`);
  if (safety?.blockedHash(lock.files[lockKey(guard)]?.sha256))
    problems.push('the safety classifier’s file is on the blocklist');
  return problems;
}

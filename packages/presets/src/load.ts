import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'smol-toml';
import { Catalog, ModelLock, lockKey } from './schema.ts';

/** The repo's `presets/` folder. Overridable so packaged builds can ship it elsewhere. */
export const defaultPresetsDir = (): string =>
  process.env.HILDEGARD_PRESETS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '../../../presets');

export interface LoadedCatalog {
  catalog: Catalog;
  lock: ModelLock;
}

/** Parse and cross-check the catalog. Throws one error listing every problem, so a bad preset never half-loads. */
export function parseCatalog(cinemaToml: string, modelsToml: string, lockJson: string): LoadedCatalog {
  const raw = { ...parse(cinemaToml), ...parse(modelsToml) };
  const catalog = Catalog.parse(raw);
  const lock = ModelLock.parse(JSON.parse(lockJson));
  const problems = checkCatalog(catalog, lock);
  if (problems.length) throw new Error(`Preset catalog has ${problems.length} problem(s):\n- ${problems.join('\n- ')}`);
  return { catalog, lock };
}

export function loadCatalog(dir = defaultPresetsDir()): LoadedCatalog {
  const read = (f: string) => readFileSync(join(dir, f), 'utf8');
  return parseCatalog(read('cinema.toml'), read('models.toml'), read('models.lock.json'));
}

export function checkCatalog(c: Catalog, lock: ModelLock): string[] {
  const problems: string[] = [];
  const unique = (what: string, ids: Array<string | number>) => {
    const seen = new Set<string | number>();
    for (const id of ids) {
      if (seen.has(id)) problems.push(`${what} "${id}" is defined twice`);
      seen.add(id);
    }
  };
  unique('body', c.bodies.map((x) => x.id));
  unique('lens', c.lenses.map((x) => x.id));
  unique('focal length', c.focals.map((x) => x.mm));
  unique('motion', c.motions.map((x) => x.id));
  unique('lighting', c.lightings.map((x) => x.id));
  unique('palette', c.palettes.map((x) => x.id));
  unique('genre', c.genres.map((x) => x.id));
  unique('era', c.eras.map((x) => x.id));
  unique('aspect', c.aspects.map((x) => x.id));
  unique('model', c.models.map((x) => x.id));

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
    }
  }
  return problems;
}

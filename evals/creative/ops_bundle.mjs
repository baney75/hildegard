// SPDX-License-Identifier: AGPL-3.0-only
// ops_bundle.mjs <out dir>: Hildegard's CLI and server as one file, the way a release carries them (scripts/build-release.mjs), with
// only the files a fake-GPU server reads (presets, fixtures). A world runs this file instead of the checkout, so a responder that
// looks at its wrapper or at `ps` finds an installed app and not this repository, its tests or its eval.
import { cpSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = resolve(process.argv[2]);
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
mkdirSync(out, { recursive: true });
await build({
  entryPoints: [join(root, 'apps', 'cli', 'src', 'main.ts')],
  outfile: join(out, 'hildegard.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['@napi-rs/keyring'],
  legalComments: 'none',
  minifySyntax: true,
  banner: {
    js: [
      `// Hildegard ${version}`,
      "import { createRequire as __hgRequire } from 'node:module';",
      "import { fileURLToPath as __hgPath } from 'node:url';",
      "import { dirname as __hgDir, join as __hgJoin } from 'node:path';",
      'const require = __hgRequire(import.meta.url);',
      'process.env.HILDEGARD_ENTRY ??= __hgPath(import.meta.url);',
      'process.env.HILDEGARD_RESOURCES = __hgDir(__hgPath(import.meta.url));',
      "process.env.HILDEGARD_PRESETS_DIR = __hgJoin(process.env.HILDEGARD_RESOURCES, 'presets');",
    ].join('\n'),
  },
  logLevel: 'warning',
});
cpSync(join(root, 'presets'), join(out, 'presets'), { recursive: true });
cpSync(join(root, 'packages', 'comfy', 'fixtures'), join(out, 'fixtures'), { recursive: true });
console.log(join(out, 'hildegard.mjs'));

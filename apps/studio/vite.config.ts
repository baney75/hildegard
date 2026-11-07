// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import react from '@vitejs/plugin-react';
import { build, defineConfig, type Plugin, type Rollup } from 'vite';

/** The first segment of the address, and the page file that shows it (src/lib/pages.ts has the same table). */
const ROUTE_PAGES: Record<string, string> = {
  '': 'Cinema',
  film: 'Cinema',
  images: 'Images',
  queue: 'Queue',
  characters: 'Characters',
  agents: 'Agents',
  sites: 'Sites',
  voice: 'Voice',
  talk: 'Talk',
  settings: 'Settings',
};

/**
 * Code for the same head script: it starts the download of the page this address opens (and the chunks it shares)
 * while the entry script is still loading, instead of after it has run. Without it a split page waits for React to
 * boot before its own code is even asked for.
 */
function routePreload(chunks: Rollup.OutputBundle): string {
  const pages = new Map<string, Rollup.OutputChunk>();
  for (const c of Object.values(chunks)) {
    const m =
      c.type === 'chunk' && c.isDynamicEntry ? /\/pages\/(\w+)\.tsx$/.exec(c.facadeModuleId ?? '') : null;
    if (m && c.type === 'chunk') pages.set(m[1]!, c);
  }
  const needs = (c: Rollup.OutputChunk, seen = new Set<string>()): string[] => {
    if (seen.has(c.fileName)) return [];
    seen.add(c.fileName);
    const own = c.isEntry ? [] : [c.fileName];
    return [
      ...own,
      ...c.imports.flatMap((i) =>
        chunks[i]?.type === 'chunk' ? needs(chunks[i] as Rollup.OutputChunk, seen) : [],
      ),
    ];
  };
  const map: Record<string, string[]> = {};
  for (const [route, page] of Object.entries(ROUTE_PAGES)) {
    const chunk = pages.get(page);
    if (chunk) map[route] = needs(chunk);
  }
  return `;(function(){try{var m=${JSON.stringify(map)};var f=m[location.hash.replace(/^#\\/?/,'').split('/')[0]||''];if(!f)return;for(var i=0;i<f.length;i++){var l=document.createElement('link');l.rel='modulepreload';l.href='/'+f[i];document.head.appendChild(l)}}catch(e){}})();`;
}

/**
 * The look the person chose, applied in <head> before the first paint. It is a classic script (a module would wait
 * for the page), so it is bundled on its own from src/theme-init.ts and served as /theme-init.js, in dev and in the build.
 */
function themeInit(): Plugin {
  const entry = join(import.meta.dirname, 'src/theme-init.ts');
  // Vite's own build, so no bundler of ours to declare: one entry, no config file, kept in memory.
  const bundle = async () => {
    const out = (await build({
      configFile: false,
      logLevel: 'silent',
      publicDir: false,
      build: {
        write: false,
        minify: true,
        target: 'es2022',
        lib: { entry, formats: ['iife'], name: 'hildegardThemeInit' },
      },
    })) as Rollup.RollupOutput | Rollup.RollupOutput[];
    const chunk = (Array.isArray(out) ? out[0]! : out).output.find((o) => o.type === 'chunk');
    return chunk && 'code' in chunk ? chunk.code : '';
  };
  return {
    name: 'hildegard-theme-init',
    transformIndexHtml: () => [
      { tag: 'script', attrs: { src: '/theme-init.js' }, injectTo: 'head-prepend' as const },
    ],
    configureServer(dev) {
      dev.middlewares.use('/theme-init.js', (_req, res) => {
        bundle().then(
          (code) => {
            res.setHeader('content-type', 'text/javascript');
            res.end(code);
          },
          () => {
            res.statusCode = 500;
            res.end();
          },
        );
      });
    },
    async generateBundle(_options, chunks) {
      this.emitFile({
        type: 'asset',
        fileName: 'theme-init.js',
        source: (await bundle()) + routePreload(chunks),
      });
    },
  };
}

// `pnpm dev`'s server: its own port and data folder (.dev-data), never an installed Hildegard's 7341.
const server = process.env.HILDEGARD_URL ?? 'http://127.0.0.1:7361';

/** Write .br and .gz next to every text asset, so the server sends them without compressing on each request. */
function precompress(): Plugin {
  let outDir = 'dist';
  return {
    name: 'hildegard-precompress',
    apply: 'build',
    configResolved(c) {
      outDir = c.build.outDir;
    },
    closeBundle() {
      const walk = (dir: string): string[] =>
        readdirSync(dir).flatMap((f) => {
          const p = join(dir, f);
          return statSync(p).isDirectory() ? walk(p) : [p];
        });
      for (const file of walk(outDir)) {
        if (!/\.(js|css|html|svg|json|webmanifest)$/.test(file)) continue;
        const buf = readFileSync(file);
        if (buf.length < 1024) continue;
        writeFileSync(
          `${file}.br`,
          brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }),
        );
        writeFileSync(`${file}.gz`, gzipSync(buf, { level: 9 }));
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), themeInit(), precompress()],
  build: {
    target: 'es2022',
    cssMinify: 'lightningcss',
    assetsInlineLimit: 0,
    reportCompressedSize: false,
    // Which chunks each page needs: scripts/perf reads it to hold every route to its size budget.
    manifest: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: server, headers: { host: '127.0.0.1' } },
      '/media': { target: server, headers: { host: '127.0.0.1' } },
      '/preview': { target: server, headers: { host: '127.0.0.1' } },
    },
  },
});

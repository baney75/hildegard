// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import react from '@vitejs/plugin-react';
import { build, defineConfig, type Plugin, type Rollup } from 'vite';

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
      { tag: 'script', attrs: { src: '/theme-init.js' }, injectTo: 'head' as const },
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
    async generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'theme-init.js', source: await bundle() });
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

// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const server = process.env.HILDEGARD_URL ?? 'http://127.0.0.1:7341';

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
  plugins: [react(), precompress()],
  build: { target: 'es2022', cssMinify: 'lightningcss', assetsInlineLimit: 0, reportCompressedSize: false },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': { target: server, headers: { host: '127.0.0.1' } },
      '/media': { target: server, headers: { host: '127.0.0.1' } },
      '/preview': { target: server, headers: { host: '127.0.0.1' } },
    },
  },
});

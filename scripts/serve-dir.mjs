// SPDX-License-Identifier: AGPL-3.0-only
// Serves a folder on loopback, for testing the install scripts against a release built in CI, and the install page.
//   node scripts/serve-dir.mjs <dir> [port]
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const [dir = '.', port = '8765'] = process.argv.slice(2);
createServer((req, res) => {
  let file = join(
    dir,
    normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\]|\.\.)+/, ''),
  );
  try {
    if (statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!statSync(file).isFile()) throw new Error();
    const type = TYPES[extname(file).toLowerCase()];
    res.writeHead(200, type ? { 'content-type': type } : {});
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404).end();
  }
}).listen(Number(port), '127.0.0.1', () => console.log(`serving ${dir} on ${port}`));

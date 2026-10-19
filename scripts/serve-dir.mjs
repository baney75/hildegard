// SPDX-License-Identifier: AGPL-3.0-only
// Serves a folder on loopback, for testing the install scripts against a release built in CI.
//   node scripts/serve-dir.mjs <dir> [port]
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, normalize } from 'node:path';

const [dir = '.', port = '8765'] = process.argv.slice(2);
createServer((req, res) => {
  const file = join(
    dir,
    normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\]|\.\.)+/, ''),
  );
  try {
    if (!statSync(file).isFile()) throw new Error();
    res.writeHead(200);
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404).end();
  }
}).listen(Number(port), '127.0.0.1', () => console.log(`serving ${dir} on ${port}`));

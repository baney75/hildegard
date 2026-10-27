// SPDX-License-Identifier: AGPL-3.0-only
// Checks <file>.minisig against the key built into Hildegard (UPDATE_KEY), and that it was made for this file's name.
// The release runs it on every file it signs for other apps, so a signature that wouldn't verify never ships.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { verifySigned } from '../apps/server/src/update.ts';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/verify-minisig.mjs <file>');
  process.exit(2);
}
const sig = readFileSync(`${file}.minisig`).toString('base64');
const trusted = verifySigned(readFileSync(file), sig);
if (!trusted.split('\t').includes(`file:${basename(file)}`)) {
  console.error(`${file}.minisig was made for another file: ${trusted}`);
  process.exit(1);
}
console.log(`${basename(file)}: signed with Hildegard's key`);

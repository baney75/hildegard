// The video editing tools live once, in tools/, and the hildegard-video-edit skill carries a byte-for-byte copy so it works
// alone (a skill is uploaded to a chat, or copied to a computer, without the rest of the repository). This copies them:
//   node scripts/sync-video-edit-skill.mjs          write the copies
//   node scripts/sync-video-edit-skill.mjs --check  exit 1 if a copy differs (the tests run this)
// If skills/SHARED.json exists (the shared-files manifest from the weak-model-craft work), add these entries there
// instead and delete this script: tools/edit_video.py, tools/hgedit/*.py and *.json, and tools/voice_clean.py, each to
// the skill's scripts folder.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const to = join(root, 'skills', 'hildegard-video-edit', 'scripts');
const files = [
  ['tools/edit_video.py', 'edit_video.py'],
  ['tools/voice_clean.py', 'voice_clean.py'],
];
for (const name of readdirSync(join(root, 'tools', 'hgedit'))) {
  if (/\.(py|json)$/.test(name)) files.push([`tools/hgedit/${name}`, `hgedit/${name}`]);
}
const check = process.argv.includes('--check');
const wrong = [];
for (const [from, rel] of files) {
  const src = join(root, from);
  const dst = join(to, rel);
  if (check) {
    if (!existsSync(dst) || !readFileSync(src).equals(readFileSync(dst)))
      wrong.push(`skills/hildegard-video-edit/scripts/${rel}`);
  } else {
    mkdirSync(join(dst, '..'), { recursive: true });
    cpSync(src, dst);
  }
}
if (check) {
  // A file left in the skill's copy that tools/ no longer has.
  const keep = new Set(files.map(([, rel]) => rel));
  const stray = existsSync(join(to, 'hgedit'))
    ? readdirSync(join(to, 'hgedit')).filter((n) => /\.(py|json)$/.test(n) && !keep.has(`hgedit/${n}`))
    : [];
  for (const n of stray)
    wrong.push(`skills/hildegard-video-edit/scripts/hgedit/${n} (not in tools/hgedit any more)`);
  if (wrong.length) {
    console.error(
      `The skill's copy of the video editing tools is out of date:\n  ${wrong.join('\n  ')}\nRun: node scripts/sync-video-edit-skill.mjs`,
    );
    process.exit(1);
  }
} else {
  for (const n of existsSync(join(to, 'hgedit')) ? readdirSync(join(to, 'hgedit')) : []) {
    if (/\.(py|json)$/.test(n) && !files.some(([, rel]) => rel === `hgedit/${n}`))
      rmSync(join(to, 'hgedit', n));
  }
}

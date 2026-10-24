// SPDX-License-Identifier: AGPL-3.0-only
// Waits until the Hildegard at the given port says its ComfyUI is online, then prints ComfyUI's (proxy's) URL.
//   node scripts/wait-for-comfy.mjs 7341 [seconds]
const [port = '7341', seconds = '300'] = process.argv.slice(2);
const until = Date.now() + Number(seconds) * 1000;
let last = '';
while (Date.now() < until) {
  try {
    const snap = await (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).json();
    if (snap.engine.online) {
      console.log(snap.engine.url);
      process.exit(0);
    }
    const now = `${snap.engine.comfy}: ${snap.engine.problem ?? 'waiting'}`;
    if (now !== last) console.error(now);
    last = now;
  } catch (e) {
    if (last !== 'down') console.error('Hildegard is not answering:', e.message);
    last = 'down';
  }
  await new Promise((r) => setTimeout(r, 2000));
}
console.error(`ComfyUI didn't come online within ${seconds}s`);
process.exit(1);

// SPDX-License-Identifier: AGPL-3.0-only
// A solid magenta square in the page's top left corner: easy to find in a frame of the recording.
const b = document.createElement('div');
b.id = 'hg-test-badge';
b.textContent = 'EXT';
b.style.cssText =
  'position:fixed;left:0;top:0;width:160px;height:160px;background:#ff00aa;color:#fff;font:700 32px/160px sans-serif;text-align:center;z-index:2147483646';
document.documentElement.appendChild(b);

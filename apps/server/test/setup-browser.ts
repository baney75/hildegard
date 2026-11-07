// SPDX-License-Identifier: AGPL-3.0-only
// Tests drive a browser with a throwaway profile. On a computer where `google-chrome` on PATH is a launcher for the
// owner's own browser, the first match would be that browser: prefer the Chromium Playwright downloaded, when there
// is one, unless HILDEGARD_CHROME already says which.
import { platform } from 'node:os';
import { playwrightChromium } from '../src/browser.ts';

if (!process.env.HILDEGARD_CHROME) {
  const own = playwrightChromium(process.env, platform());
  if (own) process.env.HILDEGARD_CHROME = own;
}

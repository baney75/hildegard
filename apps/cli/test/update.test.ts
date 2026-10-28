// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { installerFailure, signedInstaller } from '../src/update.ts';

// The server's fixtures: installers for 9.9.9, signed with a throwaway key.
const dir = fileURLToPath(new URL('../../server/test/fixtures/update/', import.meta.url));
const read = (f: string) => readFileSync(join(dir, f));
const KEY = read('test.key.pub').toString('utf8');

/** GitHub, serving a release's files: each name maps to the file served for it. */
function github(files: Record<string, string>) {
  const asked: string[] = [];
  const f = (async (url: string) => {
    asked.push(url);
    const name = Object.keys(files).find((n) => url.endsWith(`/download/v9.9.9/${n}`));
    return name ? new Response(read(files[name]!)) : new Response('', { status: 404 });
  }) as unknown as typeof fetch;
  return { f, asked };
}

describe('a failed update', () => {
  it('says why setup stopped and what runs now', () => {
    const out = '{"ok":false,"needsOwner":false,"steps":[],"message":"PyTorch’s download timed out."}\n';
    const err =
      'Going back to Hildegard 0.1.9.\nHildegard 0.1.9 is running again.\nhildegard: setting up 0.1.10 failed (exit 1), so 0.1.9 runs again. To try 0.1.10 again, run: hildegard update\n';
    expect(installerFailure('0.1.10', out, err)).toBe(
      'The 0.1.10 installer stopped: PyTorch’s download timed out. hildegard: setting up 0.1.10 failed (exit 1), so 0.1.9 runs again. To try 0.1.10 again, run: hildegard update',
    );
    expect(installerFailure('0.1.10', '', '')).toMatch(/installer stopped\. .* is still installed\./);
    expect(installerFailure('0.1.10', 'not json', 'hildegard: couldn’t download it.')).toBe(
      'The 0.1.10 installer stopped: hildegard: couldn’t download it.',
    );
  });
});

describe('signedInstaller', () => {
  it('returns the release’s installer when its signature checks out', async () => {
    const sh = github({ 'install.sh': 'install.sh', 'install.sh.sig': 'install.sh.sig' });
    expect(await signedInstaller('9.9.9', false, sh.f, KEY)).toEqual(read('install.sh'));
    expect(sh.asked[0]).toBe('https://github.com/baney75/hildegard/releases/download/v9.9.9/install.sh');
    const ps = github({ 'install.ps1': 'install.ps1', 'install.ps1.sig': 'install.ps1.sig' });
    expect(await signedInstaller('9.9.9', true, ps.f, KEY)).toEqual(read('install.ps1'));
  });

  it('refuses another file’s signature, a missing one, and an installer for another version', async () => {
    const swapped = github({ 'install.sh': 'install.ps1', 'install.sh.sig': 'install.ps1.sig' });
    await expect(signedInstaller('9.9.9', false, swapped.f, KEY)).rejects.toThrow(/another file/);
    const unsigned = github({ 'install.sh': 'install.sh' });
    await expect(signedInstaller('9.9.9', false, unsigned.f, KEY)).rejects.toThrow(/404/);
    // Served as 9.9.10, but the signed file installs 9.9.9: an old release passed off as new.
    const old = (async (url: string) =>
      new Response(read(url.endsWith('.sig') ? 'install.sh.sig' : 'install.sh'))) as unknown as typeof fetch;
    await expect(signedInstaller('9.9.10', false, old, KEY)).rejects.toThrow(/doesn’t install 9\.9\.10/);
  });

  it('refuses a file signed with any key but Hildegard’s', async () => {
    const sh = github({ 'install.sh': 'install.sh', 'install.sh.sig': 'install.sh.sig' });
    await expect(signedInstaller('9.9.9', false, sh.f)).rejects.toThrow(/another key/);
  });
});

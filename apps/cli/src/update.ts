// SPDX-License-Identifier: AGPL-3.0-only
// `hildegard update`: to the newest release, with its own installer. The installer is signed with Hildegard's update
// key and refused unless the signature matches; it then checks every file it downloads against the SHA-256 written in
// it, lays the release down next to this one (this one stays, for going back) and restarts Hildegard.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { UpdateState } from '@hildegard/presets';
import { latestVersion, newer, RELEASES, VERSION, verifySigned } from '@hildegard/server';
import { api, type Ctx, running, stop } from './commands.ts';
import { type Result, result } from './output.ts';

const title = 'Update Hildegard';

/** While an update restarts Hildegard: the desktop app waits instead of saying Hildegard stopped. */
export const updatingFile = (dataDir: string) => join(dataDir, 'updating');

/** Where this install lives: the folder its `hildegard` command names, or the one around its script. */
function installHome(): string | null {
  if (process.env.HILDEGARD_HOME) return process.env.HILDEGARD_HOME;
  const e = process.env.HILDEGARD_ENTRY;
  return e ? resolve(dirname(e), '..') : null;
}

/** The installer for `version`, once its signature checks out. */
export async function signedInstaller(
  version: string,
  windows: boolean,
  fetchFn: typeof fetch = fetch,
  key?: string,
): Promise<Buffer> {
  const name = windows ? 'install.ps1' : 'install.sh';
  const get = async (file: string) => {
    const res = await fetchFn(`${RELEASES}/download/v${version}/${file}`, {
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${file}.`);
    return Buffer.from(await res.arrayBuffer());
  };
  const [script, sig] = await Promise.all([get(name), get(`${name}.sig`)]);
  const trusted = verifySigned(script, sig.toString('utf8'), key);
  if (!trusted.split('\t').includes(`file:${name}`))
    throw new Error(`The signature is for another file, not ${name}.`);
  // The signature covers the file, and the file says which release it installs: an older one, signed in its day, is
  // refused here.
  const marker = windows ? `$Version = '${version}'` : `VERSION=${version}\n`;
  if (!script.includes(marker)) throw new Error(`${name} doesn’t install ${version}.`);
  return script;
}

export async function update(ctx: Ctx): Promise<Result> {
  let latest: string;
  try {
    latest = await latestVersion();
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return result(
      [{ id: 'update', title, status: 'failed', detail: `Couldn’t reach GitHub: ${why}` }],
      'Hildegard couldn’t check for an update.',
    );
  }
  if (!newer(latest, VERSION))
    return result(
      [{ id: 'update', title, status: 'skipped', detail: `${VERSION} is the newest release.` }],
      `Hildegard ${VERSION} is up to date.`,
      { current: VERSION, latest },
    );
  if (ctx.flags.has('check'))
    return result(
      [{ id: 'update', title, status: 'skipped', detail: `${latest} is out; this is ${VERSION}.` }],
      `Hildegard ${latest} is out. Run \`hildegard update\` to update.`,
      { current: VERSION, latest },
    );
  const home = installHome();
  if (!home)
    return result(
      [
        {
          id: 'update',
          title,
          status: 'failed',
          detail: 'This Hildegard runs from its source code. Update it with git.',
        },
      ],
      'Hildegard wasn’t updated.',
    );
  const windows = process.platform === 'win32';
  let script: Buffer;
  try {
    script = await signedInstaller(latest, windows);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return result(
      [{ id: 'update', title, status: 'failed', detail: `${why} Nothing was changed.` }],
      'Hildegard wasn’t updated.',
    );
  }
  const c = ctx.config;
  const dir = mkdtempSync(join(tmpdir(), 'hildegard-update-'));
  const file = join(dir, windows ? 'install.ps1' : 'install.sh');
  writeFileSync(file, script);
  writeFileSync(updatingFile(c.dataDir), `${latest}\n`);
  const env: NodeJS.ProcessEnv = { ...process.env, HILDEGARD_HOME: home };
  delete env.HILDEGARD_ENTRY;

  if (windows) {
    // Windows won't replace a program that's running, Node.js included, so Hildegard stops first and the installer
    // runs on its own after this command ends. It starts the new version when it's done.
    if (await running(c)) await stop(ctx);
    const logs = join(c.dataDir, 'logs');
    mkdirSync(logs, { recursive: true });
    const log = join(logs, 'update.log');
    const fd = openSync(log, 'a');
    spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], {
      detached: true,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      env,
    }).unref();
    closeSync(fd);
    return result(
      [{ id: 'update', title, status: 'done', detail: `Installing ${latest}. Progress is in ${log}.` }],
      `Hildegard is updating to ${latest} and starts again when it's done. \`hildegard status\` shows the version.`,
      { current: VERSION, latest, log },
    );
  }

  // The installer restarts Hildegard as the new version, with the same port and folder.
  const r = spawnSync('sh', [file, ...(ctx.json ? ['--json'] : [])], {
    stdio: ctx.json ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env,
    encoding: 'utf8',
  });
  rmSync(dir, { recursive: true, force: true });
  rmSync(updatingFile(c.dataDir), { force: true });
  if (r.status !== 0)
    return result(
      [
        {
          id: 'update',
          title,
          status: 'failed',
          detail: `The ${latest} installer stopped${r.stderr ? `: ${r.stderr.trim().split('\n').at(-1)}` : '.'} ${VERSION} is still installed.`,
        },
      ],
      'Hildegard wasn’t updated.',
      { current: VERSION, latest },
    );
  return result(
    [{ id: 'update', title, status: 'done', detail: `Updated from ${VERSION}.` }],
    `Hildegard ${latest} is installed and running.`,
    { current: latest, previous: VERSION },
  );
}

/** `hildegard update auto on|off`: whether Hildegard updates itself once nothing is rendering. */
export async function autoUpdate(ctx: Ctx, value: string | undefined): Promise<Result> {
  const t = 'Automatic updates';
  if (value !== 'on' && value !== 'off')
    return result(
      [{ id: 'auto', title: t, status: 'failed', detail: 'Say on or off.' }],
      'Usage: hildegard update auto on|off',
    );
  if (!(await running(ctx.config)))
    return result(
      [
        {
          id: 'auto',
          title: t,
          status: 'failed',
          detail: 'Hildegard isn’t running. Start it with `hildegard start`.',
        },
      ],
      'Nothing was changed.',
    );
  const s = await api<UpdateState>(ctx.config, '/api/update', {
    method: 'PUT',
    body: { auto: value === 'on' },
  });
  return result(
    [{ id: 'auto', title: t, status: 'done', detail: s.auto ? 'On.' : 'Off.' }],
    s.auto
      ? 'Hildegard updates itself when a release is out and nothing is rendering.'
      : 'Hildegard tells you when a release is out, and updates when you run `hildegard update`.',
  );
}

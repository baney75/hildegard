// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Keeping Hildegard up to date. Each release publishes latest.json, which names it, and signs every file an update
 * runs with Hildegard's update key: the desktop app's updater checks the same key. The server notices a newer
 * release, says so in the Studio, and (unless that's turned off) updates itself while nothing is rendering, through
 * `hildegard update`, which checks the signature before it runs anything.
 */
import { spawn } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UpdateState } from '@hildegard/presets';

/** The update key's public half, as the desktop app's tauri.conf.json has it. */
export const UPDATE_KEY =
  'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEM3MUY1NjVEODE4QjRFNkUKUldSdVRvdUJYVllmeCs0RytuWEdkeTFGSlo4N0o1YXZqdy9sSERBRVM2WW5tdW1Ya3BLN3kwRlYK';

export const RELEASES = 'https://github.com/baney75/hildegard/releases';

/** Whether version `a` comes after `b`, comparing their numbers (0.1.10 after 0.1.9). */
export function newer(a: string, b: string): boolean {
  const n = (v: string) => v.split('.').map((x) => Number.parseInt(x, 10) || 0);
  const [x, y] = [n(a), n(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

/** The newest release's version, from its latest.json. */
export async function latestVersion(fetchFn: typeof fetch = fetch): Promise<string> {
  const res = await fetchFn(`${RELEASES}/latest/download/latest.json`, {
    signal: AbortSignal.timeout(20_000),
  });
  // A release without the update key's signatures publishes no latest.json, so it offers no update.
  if (res.status === 404) throw new Error('The newest release doesn’t offer updates yet.');
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for the newest release.`);
  const { version } = (await res.json()) as { version?: unknown };
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version))
    throw new Error('The latest release names no version.');
  return version;
}

/**
 * Checks a minisign signature, as `tauri signer sign` writes it (base64 of the signature file), against a public key
 * (base64 of the key file). Returns the signature's trusted comment, which the signature covers too. Throws if
 * anything doesn't match.
 */
export function verifySigned(data: Buffer, signature: string, key: string = UPDATE_KEY): string {
  const lines = Buffer.from(signature.trim(), 'base64').toString('utf8').split('\n');
  const keyLine = Buffer.from(key.trim(), 'base64').toString('utf8').split('\n')[1] ?? '';
  const pk = Buffer.from(keyLine, 'base64');
  const sig = Buffer.from(lines[1] ?? '', 'base64');
  const trusted = (lines[2] ?? '').startsWith('trusted comment: ')
    ? lines[2]!.slice('trusted comment: '.length)
    : null;
  const global = Buffer.from(lines[3] ?? '', 'base64');
  if (pk.length !== 42 || pk.subarray(0, 2).toString() !== 'Ed')
    throw new Error('The update key is not a key.');
  if (sig.length !== 74 || trusted === null || global.length !== 64)
    throw new Error('The signature is malformed.');
  if (!sig.subarray(2, 10).equals(pk.subarray(2, 10))) throw new Error('It was signed with another key.');
  const alg = sig.subarray(0, 2).toString();
  if (alg !== 'ED' && alg !== 'Ed') throw new Error('The signature is malformed.');
  const pub = createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: pk.subarray(10).toString('base64url') },
    format: 'jwk',
  });
  const signed = alg === 'ED' ? createHash('blake2b512').update(data).digest() : data;
  if (!verify(null, signed, pub, sig.subarray(10))) throw new Error('The signature doesn’t match the file.');
  if (!verify(null, Buffer.concat([sig.subarray(10), Buffer.from(trusted)]), pub, global))
    throw new Error('The signature’s comment was changed.');
  return trusted;
}

interface UpdatesOptions {
  dataDir: string;
  version: string;
  /** Whether this install can update itself: a release with its `hildegard` command, not a checkout. */
  updatable: boolean;
  /** Something is rendering or downloading, so an automatic update waits. */
  busy: () => boolean;
  /** Starts `hildegard update`, which outlives this server. */
  run: () => void;
  onChange: (s: UpdateState) => void;
  fetch?: typeof fetch;
  /** How long after starting the first check waits, and how often an available update looks for a quiet moment. */
  firstMs?: number;
  idleMs?: number;
}

const SIX_HOURS = 6 * 60 * 60 * 1000;

/**
 * Watches for a newer release. With automatic updates on, it starts one once nothing is rendering; the update stops
 * this server and starts the new version.
 */
export class Updates {
  private available: string | null = null;
  private auto: boolean;
  private applying = false;
  /** Asked for while something rendered: updates once nothing is, whatever `auto` says. */
  private waiting = false;
  private error: string | null = null;
  private checkedAt: string | null = null;
  private timers: NodeJS.Timeout[] = [];
  private readonly file: string;
  private readonly opts: UpdatesOptions;

  constructor(opts: UpdatesOptions) {
    this.opts = opts;
    this.file = join(opts.dataDir, 'update.json');
    try {
      this.auto = (JSON.parse(readFileSync(this.file, 'utf8')) as { auto?: boolean }).auto !== false;
    } catch {
      this.auto = true;
    }
  }

  state(): UpdateState {
    return {
      current: this.opts.version,
      available: this.available,
      auto: this.auto,
      applying: this.applying,
      waiting: this.waiting,
      updatable: this.opts.updatable,
      error: this.error,
      checkedAt: this.checkedAt,
    };
  }

  start() {
    this.timers.push(setTimeout(() => void this.check(), this.opts.firstMs ?? 60_000));
    this.timers.push(setInterval(() => void this.check(), SIX_HOURS));
    this.timers.push(setInterval(() => this.maybeApply(), this.opts.idleMs ?? 60_000));
    for (const t of this.timers) t.unref();
  }

  stop() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  async check(): Promise<UpdateState> {
    try {
      const v = await latestVersion(this.opts.fetch);
      this.available = newer(v, this.opts.version) ? v : null;
      this.error = null;
    } catch (e) {
      // Offline, or GitHub didn't answer: the next check tries again.
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.checkedAt = new Date().toISOString();
    this.changed();
    this.maybeApply();
    return this.state();
  }

  setAuto(on: boolean) {
    this.auto = on;
    mkdirSync(this.opts.dataDir, { recursive: true });
    writeFileSync(this.file, `${JSON.stringify({ auto: on })}\n`);
    this.changed();
    this.maybeApply();
  }

  /** Update now, looking for the newest release first when the last check found none. Returns why not. */
  async now(): Promise<string | null> {
    if (this.opts.updatable && !this.available && !this.applying) await this.check();
    if (this.applying) return null;
    if (!this.available && this.error) return this.error;
    return this.apply();
  }

  /** Update now. Returns why not, when it can't. */
  apply(): string | null {
    if (!this.opts.updatable) return 'This Hildegard runs from its source code. Update it with git.';
    if (!this.available) return 'Hildegard is up to date.';
    if (this.applying) return null;
    this.applying = true;
    this.waiting = false;
    this.changed();
    try {
      this.opts.run();
    } catch (e) {
      this.applying = false;
      this.error = e instanceof Error ? e.message : String(e);
      this.changed();
      return this.error;
    }
    return null;
  }

  /**
   * Update for another of the owner's devices, which asked over the paired link: checks first if it hasn't yet, and
   * waits for anything rendering here to finish rather than cutting it off. Returns why not, when it can't.
   */
  async request(): Promise<string | null> {
    if (!this.opts.updatable) return 'It runs from its source code. Update it there with git.';
    if (!this.available && !this.applying) await this.check();
    if (!this.available) return this.error ?? `It’s up to date: ${this.opts.version} is the newest release.`;
    if (this.applying) return null;
    if (this.opts.busy()) {
      this.waiting = true;
      this.changed();
      return null;
    }
    return this.apply();
  }

  private maybeApply() {
    if (
      (this.auto || this.waiting) &&
      this.available &&
      !this.applying &&
      this.opts.updatable &&
      !this.opts.busy()
    )
      this.apply();
  }

  private changed() {
    this.opts.onChange(this.state());
  }
}

/** The environment without what this version's bundle set about its own files, which a newer version must not use. */
export function withoutBundleEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const v of ['HILDEGARD_ENTRY', 'HILDEGARD_RESOURCES', 'HILDEGARD_PRESETS_DIR', 'HILDEGARD_COMMIT'])
    delete out[v];
  return out;
}

/** Starts `hildegard update` on its own, so it carries on when it stops this server. Its output goes to the log. */
export function runUpdate(
  entry: string,
  args: string[],
  logFile: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const fd = openSync(logFile, 'a');
  const child = spawn(process.execPath, [entry, 'update', '--yes', ...args], {
    detached: true,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
    // The update command runs from this version's bundle, which sets the rest itself.
    env: { ...withoutBundleEnv(env), HILDEGARD_ENTRY: entry },
  });
  closeSync(fd);
  child.unref();
}

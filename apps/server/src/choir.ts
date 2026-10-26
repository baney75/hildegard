// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Choir, first slice: render on another of your own devices. A device with a GPU shares it ("invite"), which makes a
 * one-line join code holding its address and a fresh key; the device without one joins with that code and sends its
 * takes there. Keys are 256 random bits, kept hashed on the sharing device and in the keychain on the joined one.
 * Addresses must be private: Tailscale (WireGuard encrypts the link), loopback, or https.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { EngineError } from '@hildegard/comfy';
import type { ChoirDevice, ChoirState } from '@hildegard/presets';
import type { SecretStore } from './hf.ts';
import { type NodeInfo, REFUSED, RemoteEngine, shortGpu } from './remote-engine.ts';

export class ChoirError extends Error {
  readonly status: 400 | 403 | 404 | 409 | 502;
  constructor(status: ChoirError['status'], message: string) {
    super(message);
    this.name = 'ChoirError';
    this.status = status;
  }
}

// ── Keys ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A fresh key: 32 random bytes, base64url (43 characters). */
export const newToken = () => randomBytes(32).toString('base64url');
export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** Keys are random, so one SHA-256 is enough: there is nothing to guess that a slow hash would protect. */
export const hashToken = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

/**
 * Whether `presented` is one of the keys behind `hashes`. Hashing first gives equal lengths, every hash is compared,
 * and the comparison itself is constant time, so timing says nothing about how close a guess was.
 */
export function tokenMatches(presented: string, hashes: readonly string[]): boolean {
  const h = createHash('sha256').update(presented, 'utf8').digest();
  let ok = false;
  for (const x of hashes) {
    const b = Buffer.from(x, 'hex');
    if (b.length === h.length && timingSafeEqual(b, h)) ok = true;
  }
  return ok;
}

// ── Join codes ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface JoinCode {
  /** The sharing device's name, as the joined one shows it. */
  name: string;
  /** Its origin, such as http://100.101.102.103:7341. */
  url: string;
  token: string;
}

const CODE_PREFIX = 'hgc1_';
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/i;

/** Lowercase letters, digits and dashes, from a host name: what a device is called in a Choir. */
export function deviceName(raw: string): string {
  const n = raw
    .toLowerCase()
    .replace(/\..*$/, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  return n && n !== 'local' ? n : 'gpu';
}

export function encodeJoinCode(c: JoinCode): string {
  return CODE_PREFIX + Buffer.from(JSON.stringify({ n: c.name, u: c.url, t: c.token })).toString('base64url');
}

/**
 * Whether a link to `url` keeps the key and prompts private: https anywhere; plain http only on loopback or inside
 * a tailnet (100.64.0.0/10, fd7a:115c:a1e0::/48 or a *.ts.net name), where WireGuard encrypts it.
 */
export function privateLink(url: URL): boolean {
  if (url.protocol === 'https:') return true;
  if (url.protocol !== 'http:') return false;
  const h = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h)) return true;
  if (h.endsWith('.ts.net')) return true;
  const v4 = /^100\.(\d+)\.\d+\.\d+$/.exec(h);
  if (v4 && Number(v4[1]) >= 64 && Number(v4[1]) <= 127) return true;
  return /^fd7a:115c:a1e0:/.test(h);
}

/** Check an address someone typed or pasted: an http(s) origin on a private link, nothing else. */
export function checkUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ChoirError(400, 'That address isn’t a URL, like http://100.101.102.103:7341.');
  }
  if (u.username || u.password || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash)
    throw new ChoirError(400, 'Give just the address and port, like http://100.101.102.103:7341.');
  if (!privateLink(u))
    throw new ChoirError(
      400,
      'Hildegard pairs devices only over Tailscale, this computer, or https, so your prompts and key stay private. Use the device’s Tailscale address.',
    );
  return u.origin;
}

/** Read a pasted join code. Throws a ChoirError with a sentence for anything that isn’t one. */
export function parseJoinCode(raw: string): JoinCode {
  const s = raw.replace(/\s+/g, '');
  const bad = () =>
    new ChoirError(400, 'That isn’t a join code. On the device with the GPU, run `hildegard choir invite`.');
  if (!s.startsWith(CODE_PREFIX) || s.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(s.slice(CODE_PREFIX.length)))
    throw bad();
  let o: { n?: unknown; u?: unknown; t?: unknown };
  try {
    o = JSON.parse(Buffer.from(s.slice(CODE_PREFIX.length), 'base64url').toString('utf8'));
  } catch {
    throw bad();
  }
  if (
    typeof o?.n !== 'string' ||
    typeof o.u !== 'string' ||
    typeof o.t !== 'string' ||
    !NAME_RE.test(o.n) ||
    o.n.toLowerCase() === 'local' ||
    !TOKEN_RE.test(o.t)
  )
    throw bad();
  return { name: o.n.toLowerCase(), url: checkUrl(o.u), token: o.t };
}

// ── Tailscale ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface TailscaleSelf {
  ip: string;
  name: string;
}

type Run = (cmd: string, args: string[]) => string | null;
const run: Run = (cmd, args) => {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
  } catch {
    return null;
  }
};

/** This device on its tailnet, from `tailscale status --json`, or null when Tailscale isn't up here. */
export function tailscaleSelf(exec: Run = run): TailscaleSelf | null {
  const cmds =
    process.platform === 'darwin'
      ? ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']
      : ['tailscale'];
  for (const cmd of cmds) {
    const out = exec(cmd, ['status', '--json']);
    if (!out) continue;
    try {
      const j = JSON.parse(out) as {
        BackendState?: string;
        Self?: { HostName?: string; DNSName?: string; TailscaleIPs?: string[] };
      };
      const ip = j.Self?.TailscaleIPs?.find((x) => /^100\./.test(x)) ?? j.Self?.TailscaleIPs?.[0];
      if (j.BackendState !== 'Running' || !ip) return null;
      return { ip, name: deviceName(j.Self?.DNSName || j.Self?.HostName || hostname()) };
    } catch {
      return null;
    }
  }
  return null;
}

// ── Choir ───────────────────────────────────────────────────────────────────────────────────────────────────────

interface SharingFile {
  name: string;
  url: string;
  keys: Array<{ hash: string; createdAt: string }>;
}
interface DevicesFile {
  use: string;
  devices: Array<{ name: string; url: string; joinedAt: string }>;
}

/** Save JSON only the owner can read, atomically. */
function save(path: string, data: unknown) {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
function load<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/**
 * Both halves of a Choir on one device: the devices it joined (and which one renders), and whether it shares its own
 * GPU. Kept under <data>/choir; joined devices' keys go to the keychain through `secrets`.
 */
export class Choir {
  /** Stable and random, so a device can tell its own join code from another's. */
  readonly id: string;
  private readonly dir: string;
  private sharing: SharingFile | null;
  private joined: DevicesFile;
  private readonly info = new Map<string, NodeInfo>();
  private readonly problems = new Map<string, string>();
  private engine: RemoteEngine | null = null;
  private readonly secrets: (account: string) => SecretStore;
  private readonly onChange: (s: ChoirState) => void;
  private readonly fetchFn: typeof fetch;
  sharingProblem: string | null = null;

  constructor(opts: {
    dataDir: string;
    secrets: (account: string) => SecretStore;
    onChange: (s: ChoirState) => void;
    fetch?: typeof fetch;
  }) {
    this.dir = join(opts.dataDir, 'choir');
    this.secrets = opts.secrets;
    this.onChange = opts.onChange;
    this.fetchFn = opts.fetch ?? fetch;
    const idFile = join(this.dir, 'id');
    if (existsSync(idFile)) this.id = readFileSync(idFile, 'utf8').trim();
    else {
      this.id = randomBytes(16).toString('hex');
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      writeFileSync(idFile, this.id, { mode: 0o600 });
    }
    const sharing = load<SharingFile | null>(join(this.dir, 'sharing.json'), null);
    this.sharing = sharing?.keys?.length ? sharing : null;
    this.joined = load<DevicesFile>(join(this.dir, 'devices.json'), { use: 'local', devices: [] });
    if (this.joined.use !== 'local' && !this.joined.devices.some((d) => d.name === this.joined.use))
      this.joined.use = 'local';
  }

  state(): ChoirState {
    return {
      use: this.joined.use,
      devices: this.joined.devices.map((d) => this.device(d.name, d.url)),
      sharing: {
        on: !!this.sharing,
        url: this.sharing?.url ?? null,
        paired: this.sharing?.keys.length ?? 0,
        problem: this.sharing ? this.sharingProblem : null,
      },
    };
  }

  private device(name: string, url: string): ChoirDevice {
    const i = this.info.get(name);
    const problem = this.problems.get(name) ?? null;
    return {
      name,
      url,
      online: !!i && !problem,
      gpu: i?.gpu ? `${shortGpu(i.gpu.name)}${i.gpu.vramGb ? `, ${i.gpu.vramGb} GB` : ''}` : null,
      version: i?.version ?? null,
      models: i?.models ?? [],
      fit: i?.fit ?? {},
      fitWhy: i?.fitWhy ?? {},
      problem,
      update: i?.update ?? null,
    };
  }

  emit() {
    this.onChange(this.state());
  }

  // ── Sharing this GPU ──────────────────────────────────────────────────────────────────────────────────────────

  /** Where the sharing device listens for paired devices, or null when it isn't sharing. */
  listen(): URL | null {
    return this.sharing ? new URL(this.sharing.url) : null;
  }

  /** Paired devices' keys, hashed. */
  accepts(token: string): boolean {
    return (
      !!this.sharing &&
      tokenMatches(
        token,
        this.sharing.keys.map((k) => k.hash),
      )
    );
  }

  sharingName(): string {
    return this.sharing?.name ?? deviceName(hostname());
  }

  /**
   * Turn sharing on (or add a device to it): a fresh key, kept hashed, in a code for the other device. `key` is one the
   * other device made itself and handed over privately, as `hildegard cloud runpod` does when it starts a rented GPU:
   * that device then builds the same code without this one having to send it anything.
   */
  invite(url: string, name: string, key?: string): { code: string; url: string } {
    const origin = checkUrl(url);
    if (key !== undefined && !TOKEN_RE.test(key))
      throw new ChoirError(400, 'A key is 32 random bytes in base64url: 43 letters, digits, - and _.');
    const token = key ?? newToken();
    const keys = this.sharing?.url === origin ? this.sharing.keys : [];
    this.sharing = {
      name: deviceName(name),
      url: origin,
      keys: [...keys, { hash: hashToken(token), createdAt: new Date().toISOString() }],
    };
    save(join(this.dir, 'sharing.json'), this.sharing);
    this.sharingProblem = null;
    this.emit();
    return { code: encodeJoinCode({ name: this.sharing.name, url: origin, token }), url: origin };
  }

  /** Stop sharing: every key goes, so no paired device can render here until it joins again. */
  revoke() {
    this.sharing = null;
    save(join(this.dir, 'sharing.json'), { name: '', url: '', keys: [] });
    this.emit();
  }

  // ── Devices this one joined ───────────────────────────────────────────────────────────────────────────────────

  private secret(name: string) {
    return this.secrets(`choir-${name}`);
  }

  /**
   * Join a device from its code. Its key is checked with it first, so a mistyped or revoked code never gets kept.
   * `autoUse` sends renders there right away (when this computer has no GPU of its own to use).
   */
  async join(code: string, opts: { name?: string; autoUse?: boolean } = {}): Promise<ChoirDevice> {
    const c = parseJoinCode(code);
    const name = opts.name ? opts.name.toLowerCase() : c.name;
    if (!NAME_RE.test(name) || name === 'local')
      throw new ChoirError(400, 'Name it with letters, digits and dashes.');
    const engine = new RemoteEngine({ name, url: c.url, token: () => c.token, fetch: this.fetchFn });
    let info: NodeInfo;
    try {
      info = await engine.info();
    } catch (e) {
      // At join, a refused key means the code was never good (mistyped, or revoked before use), not that a pairing
      // ended.
      const refused = e instanceof EngineError && e.detail === REFUSED;
      throw new ChoirError(
        refused ? 403 : 502,
        refused
          ? `${c.name} doesn’t accept that code. On ${c.name}, open Settings › Devices and share its GPU for a new one.`
          : (e as Error).message,
      );
    }
    if (info.id === this.id)
      throw new ChoirError(409, 'That’s this computer’s own code. Paste it on your other device.');
    this.secret(name).set(c.token);
    const devices = this.joined.devices.filter((d) => d.name !== name);
    devices.push({ name, url: c.url, joinedAt: new Date().toISOString() });
    this.joined = { use: opts.autoUse ? name : this.joined.use, devices };
    if (this.engine?.name === name) this.engine = null;
    this.info.set(name, info);
    this.problems.delete(name);
    save(join(this.dir, 'devices.json'), this.joined);
    this.emit();
    return this.device(name, c.url);
  }

  leave(name: string) {
    if (!this.joined.devices.some((d) => d.name === name))
      throw new ChoirError(404, `This computer hasn’t joined a device called ${name}.`);
    this.secret(name).delete();
    this.joined = {
      use: this.joined.use === name ? 'local' : this.joined.use,
      devices: this.joined.devices.filter((d) => d.name !== name),
    };
    if (this.engine?.name === name) this.engine = null;
    this.info.delete(name);
    this.problems.delete(name);
    save(join(this.dir, 'devices.json'), this.joined);
    this.emit();
  }

  /** Render on a joined device, or on this computer ("local"). */
  use(name: string) {
    if (name !== 'local' && !this.joined.devices.some((d) => d.name === name))
      throw new ChoirError(404, `This computer hasn’t joined a device called ${name}.`);
    this.joined = { ...this.joined, use: name };
    save(join(this.dir, 'devices.json'), this.joined);
    this.emit();
  }

  /** The device renders go to, when it isn't this computer. */
  active(): ChoirDevice | null {
    const d = this.joined.devices.find((x) => x.name === this.joined.use);
    return d ? this.device(d.name, d.url) : null;
  }

  /** The engine for the device in use; the same object while it stays in use, so its state carries over. */
  activeEngine(): RemoteEngine | null {
    const d = this.joined.devices.find((x) => x.name === this.joined.use);
    if (!d) return null;
    if (this.engine?.name !== d.name || this.engine.url !== d.url) {
      const secret = this.secret(d.name);
      this.engine = new RemoteEngine({
        name: d.name,
        url: d.url,
        token: () => secret.get(),
        fetch: this.fetchFn,
        onInfo: (info, problem) => this.record(d.name, info, problem),
        from: () => this.sharingName(),
      });
      const known = this.info.get(d.name);
      if (known) this.engine.known(known);
    }
    return this.engine;
  }

  private record(name: string, info: NodeInfo | null, problem: string | null) {
    const before = JSON.stringify(this.device(name, ''));
    if (info) this.info.set(name, info);
    if (problem) this.problems.set(name, problem);
    else this.problems.delete(name);
    if (JSON.stringify(this.device(name, '')) !== before) this.emit();
  }

  /** Update a joined device to the newest release; it restarts as the new version, or once its renders finish. */
  async update(name: string): Promise<ChoirDevice> {
    const d = this.joined.devices.find((x) => x.name === name);
    if (!d) throw new ChoirError(404, `This computer hasn’t joined a device called ${name}.`);
    const secret = this.secret(d.name);
    const e = new RemoteEngine({ name: d.name, url: d.url, token: () => secret.get(), fetch: this.fetchFn });
    try {
      const update = await e.update();
      const known = this.info.get(name);
      if (known) this.record(name, { ...known, update }, null);
    } catch (err) {
      const x = err as EngineError;
      throw new ChoirError(
        x.code === 'engine_offline' ? 502 : 409,
        [x.message, x.hint].filter(Boolean).join(' '),
      );
    }
    return this.device(d.name, d.url);
  }

  /** Ask every joined device how it is, for lists (the scheduler also watches the one in use). */
  async refresh(): Promise<ChoirState> {
    await Promise.all(
      this.joined.devices.map(async (d) => {
        const secret = this.secret(d.name);
        const e = new RemoteEngine({
          name: d.name,
          url: d.url,
          token: () => secret.get(),
          fetch: this.fetchFn,
        });
        try {
          this.record(d.name, await e.info(), null);
        } catch (err) {
          this.record(d.name, null, (err as Error).message);
        }
      }),
    );
    return this.state();
  }
}

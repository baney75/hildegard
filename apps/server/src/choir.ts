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
import type { ChoirDevice, ChoirState, DeviceCapabilities, ModelState, Priority } from '@hildegard/presets';
import type { BusyCheck } from './busy.ts';
import { CODE_LIMITS, CodeBook, looksLikeCode, normalizeCode } from './codes.ts';
import type { SecretStore } from './hf.ts';
import { Limiter } from './people.ts';
import { type NodeInfo, REFUSED, RemoteEngine, shortGpu } from './remote-engine.ts';

/** Said on a refusal after the sharing device answered 200: it has taken the code by then. */
const USED_UP = ' The short code was used up; ask for a new one with `hildegard choir invite`.';

export class ChoirError extends Error {
  readonly status: 400 | 403 | 404 | 409 | 429 | 502;
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
  /** Its origin, such as http://100.64.0.1:7341. */
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
  return n && n !== 'local' && n !== 'auto' ? n : 'gpu';
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
    throw new ChoirError(400, 'That address isn’t a URL, like http://100.64.0.1:7341.');
  }
  if (u.username || u.password || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash)
    throw new ChoirError(400, 'Give just the address and port, like http://100.64.0.1:7341.');
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
    ['local', 'auto'].includes(o.n.toLowerCase()) ||
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

// ── Placing work across devices ─────────────────────────────────────────────────────────────────────────────────

/** One job to place: every model its graph needs (none when any device will do), and whether the owner forced it. */
export interface Job {
  /** The video or stills model, and for a take with characters and no start frame, the stills model its keyframe needs. */
  models: string[];
  priority: Priority;
  /** A paired device's render: it came to this computer's GPU and renders nowhere else. */
  guest: boolean;
}

/** A device a job could go to, as far as this computer knows: "local" is this computer. */
export interface Candidate {
  name: string;
  /**
   * It answers, its ComfyUI does, and it takes work. A device that places its own takes too ("auto") never counts:
   * two of them could each hold a take waiting on the other's GPU, with the other's render queued behind it.
   */
  ready: boolean;
  /** It shares its GPU only while it's free. */
  opportunistic: boolean;
  /** Why it's busy for paired devices now (opportunistic, and in use), or null. */
  busy: string | null;
  has(model: string): boolean;
  fit(model: string): 'fits' | 'tight' | 'no' | null;
  queue: number;
}

/**
 * Where a job goes when takes render on "auto". Only devices that are ready and have its model, fitting their GPU,
 * are free for it, and a busy one isn't free (another device's render waits there until it's free again, forced or
 * not). Among those: one that's always shared before an opportunistic one, a comfortable fit before a tight one, the
 * shorter queue, then this computer (nothing to send). With none free, it renders here if it can, since this
 * computer's own work never waits for it to be free; else where it could run, and waits there.
 */
export function place(job: Job, local: Candidate | null, devices: Candidate[]): string {
  if (job.guest) return 'local';
  const all = local ? [local, ...devices] : devices;
  const runs = (c: Candidate) => c.ready && job.models.every((m) => c.has(m) && c.fit(m) !== 'no');
  const fitRank = (c: Candidate) => (job.models.some((m) => c.fit(m) === 'tight') ? 1 : 0);
  const best = all
    .filter((c) => runs(c) && !c.busy)
    .sort(
      (a, b) =>
        Number(a.opportunistic) - Number(b.opportunistic) ||
        fitRank(a) - fitRank(b) ||
        a.queue - b.queue ||
        Number(b.name === 'local') - Number(a.name === 'local'),
    )[0];
  // Nothing free: a device that can run it, then this computer, then any ready device. Never one that isn't ready
  // (offline, or on "auto" itself, which could leave two devices each waiting on the other).
  return (
    (best ?? (local && runs(local) ? local : null) ?? all.find(runs) ?? local ?? devices.find((c) => c.ready))
      ?.name ?? 'local'
  );
}

// ── Choir ───────────────────────────────────────────────────────────────────────────────────────────────────────

interface SharingFile {
  name: string;
  url: string;
  /** `for` is the device a short code was redeemed by, as it named itself. */
  keys: Array<{ hash: string; createdAt: string; for?: string }>;
}
/** What a short join code stands for: nothing but itself. The address and name are the sharing record's, as they are when it is redeemed. */
type ShortJoin = Record<string, never>;
/** How this computer shares its GPU; kept apart from the keys, so it outlasts revoking and inviting. */
interface SettingsFile {
  /** Paired devices' renders go behind this computer's own work and wait while it's busy. */
  opportunistic: boolean;
  /** Where Talk runs by default: "local" or a joined device's name (ChoirState.primary). */
  primary: string;
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
  private settings: SettingsFile;
  private readonly info = new Map<string, NodeInfo>();
  private readonly problems = new Map<string, string>();
  private engine: RemoteEngine | null = null;
  /** With "auto": the device the current job goes to. */
  private picked = 'local';
  private readonly secrets: (account: string) => SecretStore;
  private readonly onChange: (s: ChoirState) => void;
  private readonly fetchFn: typeof fetch;
  private readonly clock: () => number;
  /** Short join codes made by `invite`, until they are used, expire, or sharing stops. */
  private readonly shortCodes: CodeBook<ShortJoin>;
  /** Wrong short codes, per source and across all of them. */
  private readonly wrongBySource: Limiter;
  private readonly wrongAnywhere: Limiter;
  sharingProblem: string | null = null;
  /** This computer's own capabilities, which the server looks up now and then; null until it has. */
  capabilities: DeviceCapabilities | null = null;

  constructor(opts: {
    dataDir: string;
    secrets: (account: string) => SecretStore;
    onChange: (s: ChoirState) => void;
    fetch?: typeof fetch;
    now?: () => number;
  }) {
    this.dir = join(opts.dataDir, 'choir');
    this.secrets = opts.secrets;
    this.onChange = opts.onChange;
    this.fetchFn = opts.fetch ?? fetch;
    const now = opts.now ?? Date.now;
    this.clock = now;
    this.shortCodes = new CodeBook<ShortJoin>({ file: join(this.dir, 'codes.json'), now });
    this.wrongBySource = new Limiter(CODE_LIMITS.perSource, CODE_LIMITS.windowMs, now);
    this.wrongAnywhere = new Limiter(CODE_LIMITS.global, CODE_LIMITS.windowMs, now);
    const idFile = join(this.dir, 'id');
    if (existsSync(idFile)) this.id = readFileSync(idFile, 'utf8').trim();
    else {
      this.id = randomBytes(16).toString('hex');
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      writeFileSync(idFile, this.id, { mode: 0o600 });
    }
    const sharing = load<SharingFile | null>(join(this.dir, 'sharing.json'), null);
    this.sharing = sharing?.url && Array.isArray(sharing.keys) ? sharing : null;
    this.joined = load<DevicesFile>(join(this.dir, 'devices.json'), { use: 'local', devices: [] });
    const settings = load<Partial<SettingsFile>>(join(this.dir, 'settings.json'), {});
    this.settings = {
      opportunistic: settings.opportunistic === true,
      primary:
        typeof settings.primary === 'string' && this.joined.devices.some((d) => d.name === settings.primary)
          ? settings.primary
          : 'local',
    };
    if (
      this.joined.use !== 'local' &&
      this.joined.use !== 'auto' &&
      !this.joined.devices.some((d) => d.name === this.joined.use)
    )
      this.joined.use = 'local';
  }

  /** The device takes go to now: the one in use, or with "auto" the one the current job was placed on. */
  private target(): string {
    if (this.joined.use !== 'auto') return this.joined.use;
    return this.joined.devices.some((d) => d.name === this.picked) ? this.picked : 'local';
  }

  state(): ChoirState {
    return {
      use: this.joined.use,
      rendering: this.target(),
      primary: this.settings.primary,
      devices: this.joined.devices.map((d) => this.device(d.name, d.url)),
      capabilities: this.capabilities,
      sharing: {
        on: this.sharingOn(),
        url: this.sharingOn() ? this.sharing!.url : null,
        paired: this.sharing?.keys.length ?? 0,
        problem: this.sharingOn() ? this.sharingProblem : null,
        opportunistic: this.settings.opportunistic,
        busyCheck: this.busyCheck,
        busy: this.settings.opportunistic ? this.busy : null,
        seesOwner: this.seesOwner,
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
      opportunistic: i?.opportunistic ?? null,
      busy: i?.busy ?? null,
      queue: i?.queue ?? null,
      capabilities: i?.capabilities ?? null,
    };
  }

  /** Joined devices as places a job could go, from what each said last. */
  candidates(): Candidate[] {
    return this.joined.devices.map((d) => {
      const i = this.info.get(d.name);
      return {
        name: d.name,
        ready: this.ready(d.name),
        opportunistic: i?.opportunistic === true,
        busy: i?.busy ?? null,
        has: (m) => !!i && (i.fake || i.models.includes(m)),
        fit: (m) => i?.fit?.[m] ?? null,
        queue: i?.queue ?? 0,
      };
    });
  }

  /** Whether a joined device takes work placed on it now: online, accepting, and not on "auto" itself. */
  private ready(name: string): boolean {
    const i = this.info.get(name);
    return !!i && !this.problems.has(name) && i.online && i.accepting && !i.auto;
  }

  /** With "auto": send the next job to this device ("local" for this computer). Says whether it changed. */
  pick(name: string): boolean {
    if (this.joined.use !== 'auto' || name === this.picked) return false;
    this.picked = name;
    this.emit();
    return true;
  }

  emit() {
    this.onChange(this.state());
  }

  // ── Sharing this GPU ──────────────────────────────────────────────────────────────────────────────────────────

  /** Where the sharing device listens for paired devices, or null when it isn't sharing. */
  listen(): URL | null {
    return this.sharingOn() ? new URL(this.sharing!.url) : null;
  }

  /**
   * Whether sharing counts as on: an address with a paired device, or with a short code still live. An invite nobody
   * used leaves a record with no keys; once its codes lapse that is off, so the listener closes and the Studio says so.
   */
  sharingOn(): boolean {
    return !!this.sharing && (this.sharing.keys.length > 0 || this.shortCodes.size() > 0);
  }

  /** Milliseconds until sharing lapses for want of a live code (see `sharingOn`); null when it isn't waiting on one. */
  lapsesIn(): number | null {
    if (!this.sharing || this.sharing.keys.length > 0) return null;
    const at = this.shortCodes.lastExpiry();
    return at === null ? null : Math.max(0, at - this.clock()) + 50;
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
  invite(url: string, name: string, key?: string, label?: string): { code: string; url: string } {
    const origin = checkUrl(url);
    if (key !== undefined && !TOKEN_RE.test(key))
      throw new ChoirError(400, 'A key is 32 random bytes in base64url: 43 letters, digits, - and _.');
    this.shareAt(origin, name);
    const j = this.addKey(label, key);
    return { code: encodeJoinCode(j), url: origin };
  }

  /** Sharing on at `origin` under `name`, keeping the keys already paired when the address is the same. No key is made. */
  private shareAt(origin: string, name: string) {
    const keys = this.sharing?.url === origin ? this.sharing.keys : [];
    this.sharing = { name: deviceName(name), url: origin, keys };
    save(join(this.dir, 'sharing.json'), this.sharing);
    this.sharingProblem = null;
    this.emit();
  }

  /**
   * Add a key to the sharing record as it is now, without touching its address or name, and return what a long code
   * holds. `key` is one the other device made itself.
   */
  private addKey(label?: string, key?: string): JoinCode {
    const sharing = this.sharing;
    if (!sharing) throw new ChoirError(409, 'This computer isn’t sharing its GPU.');
    const token = key ?? newToken();
    this.sharing = {
      ...sharing,
      keys: [
        ...sharing.keys,
        { hash: hashToken(token), createdAt: new Date().toISOString(), ...(label ? { for: label } : {}) },
      ],
    };
    save(join(this.dir, 'sharing.json'), this.sharing);
    this.emit();
    return { name: sharing.name, url: sharing.url, token };
  }

  /**
   * Turn sharing on and make a short code (`HG-XXXX-XXXX`) for typing. It makes no key: the key is made only when the
   * code is redeemed, so a code nobody uses leaves none behind. The long `hgc1_` code is made only when asked for
   * (`long`), and that one does leave a key.
   */
  shortInvite(
    url: string,
    name: string,
    opts: { long?: boolean; short?: boolean } = {},
  ): {
    code: string | null;
    url: string;
    short: { code: string; expiresAt: string } | null;
    name: string;
  } {
    const origin = checkUrl(url);
    this.shareAt(origin, name);
    const long = opts.long ? encodeJoinCode(this.addKey()) : null;
    // `short: false` is for asking for the long code alone, which mints no short code to leave live.
    const short = opts.short === false && opts.long ? null : this.shortCodes.mint({});
    return {
      code: long,
      url: origin,
      name: this.sharing!.name,
      short: short ? { code: short.code, expiresAt: new Date(short.expiresAt).toISOString() } : null,
    };
  }

  /**
   * A joining device presents a short code. A wrong one counts against its source and against all sources. Past its
   * source's limit nothing is tried, so the code isn't even looked at. Past the all-sources limit no code is looked at, right
   * or wrong, until the window clears (checking right ones there would leave guessing unbounded); a long hgc1_ code
   * still joins meanwhile. The live check reads memory only; taking the code is one synchronous step, so of two at once
   * exactly one gets a key. Returns what a long code holds, from the sharing record as it is now.
   */
  redeem(code: unknown, source: string, joiner?: string): JoinCode {
    const key = `src:${source}`;
    const tooMany = (wait: number) =>
      new ChoirError(
        429,
        `Too many wrong codes. Wait ${wait > 90 ? `${Math.ceil(wait / 60)} minutes` : `${wait} seconds`}, then ask for a new one.`,
      );
    const mine = this.wrongBySource.wait(key);
    if (mine) throw tooMany(mine);
    // Past the cap across every source, no code is looked at, right or wrong, until the window clears; checking them
    // would leave guessing unbounded. A long code still joins meanwhile.
    const all = this.wrongAnywhere.wait('all');
    if (all) throw tooMany(all);
    const norm = normalizeCode(code);
    const rec = this.sharingOn() && this.shortCodes.live(norm) ? this.shortCodes.take(norm) : null;
    if (!rec || !this.sharing) {
      this.wrongBySource.fail(key);
      this.wrongAnywhere.fail('all');
      throw new ChoirError(
        403,
        'That code isn’t good: it was mistyped, used already, or has expired. Ask for a new one with `hildegard choir invite`.',
      );
    }
    const label = typeof joiner === 'string' && NAME_RE.test(joiner) ? joiner.toLowerCase() : undefined;
    return this.addKey(label);
  }

  /** Whether paired devices' renders yield to this computer's own work (see Scheduler.setOpportunistic). */
  get opportunistic(): boolean {
    return this.settings.opportunistic;
  }

  setOpportunistic(on: boolean) {
    if (on === this.settings.opportunistic) return;
    const next = { ...this.settings, opportunistic: on };
    // Saved first: if it can't be, nothing changes and the caller hears why.
    save(join(this.dir, 'settings.json'), next);
    this.settings = next;
    this.emit();
  }

  /** Where Talk hears, answers and speaks by default: this computer ("local") or a joined device. */
  get primary(): string {
    return this.settings.primary;
  }

  setPrimary(name: string) {
    if (name !== 'local' && !this.joined.devices.some((d) => d.name === name))
      throw new ChoirError(404, `This computer hasn’t joined a device called ${name}.`);
    if (name === this.settings.primary) return;
    const next = { ...this.settings, primary: name };
    save(join(this.dir, 'settings.json'), next);
    this.settings = next;
    this.emit();
  }

  /** What opportunistic sharing can tell about this computer being busy; set once the server has looked. */
  busyCheck: BusyCheck | null = null;
  /** Why this computer is busy for paired devices now, as the server last saw it; shown only while opportunistic. */
  busy: string | null = null;
  /** Whether this computer can tell when someone uses it; set once the server has looked. */
  seesOwner: boolean | null = null;

  /** Stop sharing: every key goes, so no paired device can render here until it joins again. */
  revoke() {
    this.sharing = null;
    this.shortCodes.clear();
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
  async join(
    code: string,
    opts: { name?: string; autoUse?: boolean; url?: string } = {},
  ): Promise<ChoirDevice> {
    const short = looksLikeCode(code);
    const badName = (n: string) => !NAME_RE.test(n) || n === 'local' || n === 'auto';
    const nameError = new ChoirError(400, 'Name it with letters, digits and dashes.');
    // Everything that can be checked before a short code is spent is checked first.
    if (short) {
      if (opts.name && badName(opts.name.toLowerCase())) throw nameError;
      if (opts.url && this.sharing && this.sharing.url === checkUrl(opts.url))
        throw new ChoirError(409, 'That’s this computer’s own address. Run this on your other device.');
    }
    const c = short ? await this.redeemRemote(code, opts.url) : parseJoinCode(code);
    const spent = (e: ChoirError) =>
      short
        ? new ChoirError(
            e.status,
            `${e.message} The short code was used up, so ask ${c.name} for a new one with \`hildegard choir invite\`.`,
          )
        : e;
    const name = opts.name ? opts.name.toLowerCase() : c.name;
    if (badName(name)) throw spent(nameError);
    const engine = new RemoteEngine({ name, url: c.url, token: () => c.token, fetch: this.fetchFn });
    let info: NodeInfo;
    try {
      info = await engine.info();
    } catch (e) {
      // At join, a refused key means the code was never good (mistyped, or revoked before use), not that a pairing
      // ended.
      const refused = e instanceof EngineError && e.detail === REFUSED;
      throw spent(
        new ChoirError(
          refused ? 403 : 502,
          refused
            ? `${c.name} doesn’t accept that code. On ${c.name}, open Settings › Devices and share its GPU for a new one.`
            : (e as Error).message,
        ),
      );
    }
    if (info.id === this.id)
      throw spent(new ChoirError(409, 'That’s this computer’s own code. Paste it on your other device.'));
    this.secret(name).set(c.token);
    const devices = this.joined.devices.filter((d) => d.name !== name);
    devices.push({ name, url: c.url, joinedAt: new Date().toISOString() });
    this.joined = { use: opts.autoUse && this.joined.use !== 'auto' ? name : this.joined.use, devices };
    if (this.engine?.name === name) this.engine = null;
    this.info.set(name, info);
    this.problems.delete(name);
    save(join(this.dir, 'devices.json'), this.joined);
    this.emit();
    return this.device(name, c.url);
  }

  /**
   * Trade a short code for a long one at the sharing device, at `url` and nowhere else: a short code is a secret, so it
   * is sent to the one address the person gave, never to devices found on the network. What comes back must say it is
   * that same address.
   */
  private async redeemRemote(code: string, url?: string): Promise<JoinCode> {
    if (!url)
      throw new ChoirError(
        400,
        'A short code needs the sharing device’s address: `hildegard choir join HG-XXXX-XXXX --url http://<address>:7341`. The sharing device prints the whole command.',
      );
    const origin = checkUrl(url);
    const me = deviceName(hostname());
    let res: Response;
    try {
      res = await this.fetchFn(`${origin}/api/choir/redeem`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-hildegard': '1' },
        body: JSON.stringify({ code, name: me }),
        // A redirect would forward the code to wherever it points, so any 3xx fails without a second request.
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      throw new ChoirError(502, `Couldn’t reach ${origin}: ${(e as Error).message}`);
    }
    if (res.status === 429) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      throw new ChoirError(429, j.error ?? 'Too many wrong codes there. Wait, then ask for a new one.');
    }
    if (res.status === 403)
      throw new ChoirError(
        403,
        'That device didn’t accept the code: it was mistyped, used already, or has expired. Ask for a new one with `hildegard choir invite`.',
      );
    if (!res.ok) throw new ChoirError(404, `Nothing at ${origin} took that code.`);
    const j = (await res.json().catch(() => null)) as {
      name?: unknown;
      url?: unknown;
      token?: unknown;
    } | null;
    if (typeof j?.name !== 'string' || typeof j.url !== 'string' || typeof j.token !== 'string')
      throw new ChoirError(502, `${origin} answered, but not as a Hildegard sharing its GPU.${USED_UP}`);
    let answered: string;
    try {
      answered = new URL(j.url).origin;
    } catch {
      answered = '';
    }
    if (answered !== origin)
      throw new ChoirError(
        502,
        `${origin} answered with a different address (${j.url}), so Hildegard didn’t keep it.${USED_UP}`,
      );
    return parseJoinCode(encodeJoinCode({ name: j.name, url: j.url, token: j.token }));
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
    if (this.settings.primary === name) {
      this.settings = { ...this.settings, primary: 'local' };
      save(join(this.dir, 'settings.json'), this.settings);
    }
    this.info.delete(name);
    this.problems.delete(name);
    save(join(this.dir, 'devices.json'), this.joined);
    this.emit();
  }

  /** Render on a joined device, on this computer ("local"), or on whichever is free for each take ("auto"). */
  use(name: string) {
    if (name !== 'local' && name !== 'auto' && !this.joined.devices.some((d) => d.name === name))
      throw new ChoirError(404, `This computer hasn’t joined a device called ${name}.`);
    this.joined = { ...this.joined, use: name };
    save(join(this.dir, 'devices.json'), this.joined);
    this.emit();
  }

  /** A joined device by name, with how to reach it, for work other than renders (Talk); null when not joined. */
  peer(name: string): { device: ChoirDevice; url: string; token: () => string | null } | null {
    const d = this.joined.devices.find((x) => x.name === name);
    if (!d) return null;
    const secret = this.secret(d.name);
    return { device: this.device(d.name, d.url), url: d.url, token: () => secret.get() };
  }

  /** The device renders go to, when it isn't this computer. */
  active(): ChoirDevice | null {
    const name = this.target();
    const d = this.joined.devices.find((x) => x.name === name);
    return d ? this.device(d.name, d.url) : null;
  }

  /** The engine for the device in use; the same object while it stays in use, so its state carries over. */
  activeEngine(): RemoteEngine | null {
    const name = this.target();
    const d = this.joined.devices.find((x) => x.name === name);
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
    // Placement eligibility counts too: the models the Studio can use follow which devices are ready.
    const look = () => JSON.stringify([this.device(name, ''), this.ready(name)]);
    const before = look();
    if (info) this.info.set(name, info);
    if (problem) this.problems.set(name, problem);
    else this.problems.delete(name);
    if (look() !== before) this.emit();
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

/**
 * With "auto": this computer's model states, with a model counted installed when a device a take could go to has it
 * and can run it. A model installed here but unable to run here (an Apple GPU it can't use, say) still renders there.
 */
export function withRemoteFit(
  states: ModelState[],
  devices: Pick<ChoirDevice, 'models' | 'fit'>[],
): ModelState[] {
  return states.map((m) => {
    const there = devices.filter((x) => x.models.includes(m.id) && x.fit[m.id] !== 'no');
    if ((m.installed && m.fit !== 'no') || !there.length) return m;
    const fit = there.some((x) => x.fit[m.id] === 'fits') ? 'fits' : (there[0]!.fit[m.id] ?? null);
    return { ...m, installed: true, missingBytes: 0, licenseAccepted: true, fit, fitWhy: null, error: null };
  });
}

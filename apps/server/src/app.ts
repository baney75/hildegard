// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { copyFile, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describeReview, type Review, ReviewError, type ReviewSpec } from '@hildegard/craft';
import type { Diagnostics } from '@hildegard/mcp';
import { findSkills, HildegardClient, readSkills, SkillScanError } from '@hildegard/mcp';
import {
  type AgentsResponse,
  type AuthState,
  type Catalog,
  type Character,
  type CharacterRef,
  CreateCharacter,
  type CreateShotBody,
  characterText,
  composeCharacterStill,
  composeShot,
  EditCharacter,
  type GrantsResponse,
  loadSafety,
  MAX_CHARACTER_REFS,
  type ModelState,
  type NewInvite,
  type NewKey,
  type PeopleResponse,
  PresetError,
  type Priority,
  type Project,
  type SafetyCheck,
  type ServerEvent,
  ShotRequest,
  type Snapshot,
  type Still,
  StillRequest,
  type Take,
  takeSeeds,
  usable,
} from '@hildegard/presets';
import {
  connectAgent,
  disconnectAgent,
  findAgent,
  listAgents,
  mcpCommand,
  snippet,
} from '@hildegard/runtime';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import {
  COOKIE,
  type Ctx as Context,
  clientKey,
  directorMay,
  eventFilter,
  fromThisComputer,
  type HgEnv,
  open,
  ownAuth,
  secureRequest,
  seesCharacter,
  seesProject,
  snapshotFor,
  type Who,
} from './access.ts';
import { type Choir, ChoirError } from './choir.ts';
import type { Config } from './config.ts';
import { ExportError, type Exporter } from './export.ts';
import { GrantError, type Grants } from './grants.ts';
import type { HfLink, SecretStore } from './hf.ts';
import { type Host, HostError } from './host.ts';
import { CONSENT_PHOTOS, type Likeness, LikenessError, MAX_CONSENT_PHOTO, statement } from './likeness.ts';
import { directWithLocal, LlmError, type LocalModels, llmProxyRoutes } from './llm.ts';
import type { Loops } from './loop.ts';
import { loopRoutes } from './loop-routes.ts';
import type { ModelManager } from './models.ts';
import { type FetchMetadata, oauthRoutes } from './oauth.ts';
import { type OpenScad, usesManifold } from './openscad.ts';
import { DIRECTOR_QUEUE, INVITE_HOURS, Limiter, type People, PeopleError, SESSION } from './people.ts';
import {
  findSlicer,
  type Printer,
  PrinterError,
  PrinterInput,
  type PrinterProfile,
  type Slicer,
} from './printer.ts';
import { type MediaSigner, remoteMcpRoutes } from './remote-mcp.ts';
import { baseFacts, knownHere, logTail, osLabel, ReportError, Reports } from './report.ts';
import type { Scheduler } from './scheduler.ts';
import { previewRoutes, type SiteRouteDeps, siteRoutes } from './site-routes.ts';
import type { Sites } from './sites.ts';
import type { Store } from './store.ts';
import type { Updates } from './update.ts';
import type { VoiceStudio } from './voice.ts';
import type { VoiceModels } from './voice-models.ts';
import { consentLinkRoutes, voiceRoutes } from './voice-routes.ts';

export const VERSION = '0.1.9';

/**
 * Where users of this server can get its source (AGPL-3.0 §13). A modified build should set HILDEGARD_SOURCE_URL to
 * its own repository. The commit comes from the build (HILDEGARD_COMMIT) or, in a checkout, from git.
 */
export const SOURCE = {
  url: process.env.HILDEGARD_SOURCE_URL ?? 'https://github.com/baney75/hildegard',
  commit: process.env.HILDEGARD_COMMIT ?? gitCommit(),
};

function gitCommit(): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: dirname(fileURLToPath(import.meta.url)),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
    return /^[0-9a-f]{40}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

export interface AppDeps {
  config: Config;
  store: Store;
  scheduler: Scheduler;
  catalog: Catalog;
  models: ModelManager;
  hf: HfLink;
  mediaDir: string;
  exporter: Exporter;
  /** Stops the whole server: `hildegard stop` asks for this. */
  onStop?: () => void;
  /** The base URL people and agents reach this server at. */
  url?: string;
  /** This data folder's id (`homeId`), so a client can tell this server from another Hildegard's. */
  home?: string;
  choir: Choir;
  /** Looks again at what opportunistic sharing can see of this computer being busy (up to 3.5 s). */
  lookBusy?: () => Promise<void>;
  /** Models as the Studio should see them: this computer's, or those on the device renders go to. */
  modelStates: () => ModelState[];
  /** /api/node/*, for devices paired with this one. */
  node?: Hono;
  /**
   * Share this computer's GPU: a join code for another device. `url` overrides the Tailscale address; `key` is one
   * the other device made (a rented GPU it started), instead of a fresh one.
   */
  invite: (url?: string, key?: string) => Promise<{ code: string; url: string }>;
  /** Where other devices would reach this one on its tailnet, if Tailscale is up here. */
  tailnet: () => string | null;
  /** Who may sign in from other devices. */
  people: People;
  /** Host mode: this Hildegard at a link. */
  host: Host;
  /** Sign-in attempts allowed per account and per address, in 15 minutes; tests lower them. */
  limits?: { perName: number; perClient: number };
  /** Keys and chatbots that use the MCP from other devices. */
  grants: Grants;
  /** Signs the media links MCP results give apps on other devices. */
  signer: MediaSigner;
  /** Reads an OAuth app's metadata document; tests give a stand-in. */
  fetchMetadata?: FetchMetadata;
  /** The language models running on this computer, which can direct. */
  llm: LocalModels;
  /** Technical checks on a finished file (tools/review_media.py); absent where that can't run. */
  review?: (spec: ReviewSpec) => Promise<Review>;
  /** What may render; presets/safety.toml unless a test says otherwise. */
  safety?: SafetyCheck;
  /** Newer releases, and updating to them. */
  updates: Updates;
  /** The voice studio: speech, voices, consent. */
  voice?: { studio: VoiceStudio; models: VoiceModels; publicKey: string };
  /** Consent from real people that characters are based on. */
  likeness: Likeness;
  /** Generate, render, critique, refine: agents iterating on 3D models and other media. */
  loops?: Loops;
  /** The owner's 3D printer, which print loops check and slice against. */
  printer?: PrinterProfile;
  /** The slicer for this printer; Hildegard looks for one when left out. */
  slicer?: (p: Printer) => Slicer | null;
  /** Bug reports and ideas agents draft for Hildegard's makers; in the data folder unless a test says otherwise. */
  reports?: Reports;
  /** This computer's GPU, as people name it, for reports. */
  gpu?: string | null;
  /** OpenSCAD on this computer, and the libraries it renders with. */
  openscad?: () => {
    found: OpenScad | null;
    libraryDirs: string[];
    libraries: string[];
    sandbox: 'sandbox-exec' | 'bwrap' | null;
  };
  /** The owner's websites: templates, imports, files and previews. */
  sites?: {
    store: Sites;
    secrets: (account: string) => SecretStore;
    importUrl?: SiteRouteDeps['importUrl'];
    figmaFetch?: SiteRouteDeps['figmaFetch'];
  };
}

/** A loop's round or sheet, which an MCP result may link to like media. */
const LOOP_FILE = /^\/api\/loops\/[a-f0-9]{16}\/files\/[\w.-]+$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const MAX_UPLOAD = 20 * 1024 * 1024;
/** A character's reference image, at most, so four of them travel to a paired device in one render. */
const MAX_REFERENCE = 10 * 1024 * 1024;

const id = () => randomUUID().replace(/-/g, '').slice(0, 16);
const now = () => new Date().toISOString();

/** A short title from the first words of a prompt. */
export function titleFrom(prompt: string): string {
  const clean = prompt
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.;:,!?].*$/, '');
  const words = clean.split(' ').slice(0, 6).join(' ');
  return words.length < clean.length ? `${words}…` : words || 'Untitled shot';
}

/** Recognise an image upload by its first bytes, never by its name. */
export function sniffImage(b: Uint8Array): 'png' | 'jpg' | 'webp' | null {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45)
    return 'webp';
  return null;
}

const CreateShot = z.object({
  projectId: z.string().max(64).optional(),
  shotId: z.string().max(64).optional(),
  title: z.string().trim().min(1).max(120).optional(),
  request: z.unknown(),
  priority: z.enum(['forced', 'interactive', 'agent']).optional(),
  agent: z.string().trim().min(1).max(60).optional(),
});

export function createApp(deps: AppDeps) {
  const { config, store, scheduler, catalog, mediaDir, people, host } = deps;
  const safety = deps.safety ?? loadSafety();
  mkdirSync(join(mediaDir, 'uploads'), { recursive: true });
  const app = new Hono<HgEnv>();
  // The address it is bound to is allowed too (a Tailscale IP, say); names must be listed with --allow-host.
  const bound = ['0.0.0.0', '::'].includes(config.host)
    ? []
    : [config.host.includes(':') ? `[${config.host}]` : config.host];
  const fixedHosts = new Set([...LOOPBACK, ...bound, ...config.allowedHosts].map((h) => h.toLowerCase()));
  // Host mode adds its link's name, and the Tailscale address it answers on, while it is on.
  const allowed = (h: string) => {
    if (fixedHosts.has(h)) return true;
    const cur = host.current();
    if (!cur.on) return false;
    const addr = cur.address?.includes(':') ? `[${cur.address}]` : cur.address;
    return cur.names.includes(h) || h === addr;
  };

  // ── Security: DNS-rebinding and cross-site request protection ─────────────────────────────────────────────
  app.use('*', async (c, next) => {
    // The server calling itself for an MCP call: no browser is involved, and the person was checked on the way in.
    if (c.env?.as) return next();
    const hostName = (c.req.header('host') ?? '').toLowerCase().replace(/:\d+$/, '');
    if (!allowed(hostName)) return c.text('Unknown host', 421);
    const method = c.req.method;
    // OAuth is called by AI apps, cross-site by design, with no cookie; its sign-in page checks its own origin.
    if (c.req.path.startsWith('/oauth/')) {
      await next();
      c.header('x-content-type-options', 'nosniff');
      c.header('referrer-policy', 'no-referrer');
      c.header('x-frame-options', 'DENY');
      return;
    }
    // Paired devices authenticate with a bearer key, which a browser never sends on its own.
    const paired = c.req.path.startsWith('/api/node/');
    // Behind the link there is the Studio and nothing else: never the paired-device API.
    if (paired && c.env?.hosted) return c.body(null, 404);
    if (!paired && method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      // Browsers cannot add this header cross-site without a CORS preflight, which this server never grants. MCP
      // apps don't send it; /mcp takes only JSON, which a browser can't send cross-site without that preflight either.
      if (c.req.header('x-hildegard') !== '1' && c.req.path !== '/mcp' && !c.req.path.startsWith('/v1/'))
        return c.json({ error: 'Missing x-hildegard header' }, 403);
      const origin = c.req.header('origin');
      if (origin) {
        try {
          const o = new URL(origin);
          if (!allowed(o.hostname.toLowerCase()) && !allowed(`[${o.hostname}]`))
            return c.json({ error: 'Cross-site request refused' }, 403);
        } catch {
          return c.json({ error: 'Bad origin' }, 403);
        }
      }
    }
    await next();
    c.header('x-content-type-options', 'nosniff');
    c.header('referrer-policy', 'no-referrer');
    // A site's preview is framed by the Studio's canvas, and its page (sandboxed, so of no origin) loads its own files.
    const preview = c.req.path.startsWith('/preview/');
    c.header('x-frame-options', preview ? 'SAMEORIGIN' : 'DENY');
    c.header('cross-origin-opener-policy', 'same-origin');
    c.header('cross-origin-resource-policy', preview ? 'cross-origin' : 'same-origin');
  });

  // ── Who is asking: this computer, someone signed in, or nobody yet ──────────────────────────────────────────
  const cookieOf = (c: Context) => getCookie(c, COOKIE.secure) ?? getCookie(c, COOKIE.plain);
  const sendCookie = (c: Context, token: string) =>
    setCookie(c, secureRequest(c) ? COOKIE.secure : COOKIE.plain, token, {
      httpOnly: true,
      secure: secureRequest(c),
      sameSite: 'Strict',
      path: '/',
      maxAge: Math.floor(SESSION.maxMs / 1000),
    });
  const dropCookie = (c: Context) => {
    deleteCookie(c, COOKIE.plain, { path: '/' });
    if (secureRequest(c)) deleteCookie(c, COOKIE.secure, { path: '/', secure: true });
  };
  app.use('*', async (c, next) => {
    const path = c.req.path;
    // Paired devices bring their own key, checked by the node API.
    if (path.startsWith('/api/node/')) return next();
    // MCP and OAuth check their own bearer tokens and passphrases; a cookie means nothing to them.
    if (ownAuth(path) && !c.env?.as) {
      c.set('who', fromThisComputer(c) ? { kind: 'local' } : null);
      return next();
    }
    // A link from an MCP result: one file, until it expires, without signing in.
    if (
      (c.req.method === 'GET' || c.req.method === 'HEAD') &&
      (path.startsWith('/media/') || LOOP_FILE.test(path)) &&
      deps.signer.verify(path, c.req.query('exp'), c.req.query('sig'))
    ) {
      c.set('who', fromThisComputer(c) ? { kind: 'local' } : null);
      c.set('signedMedia', true);
      return next();
    }
    let who: Who | null = null;
    let rotated: string | null = null;
    if (c.env?.as) who = c.env.as;
    else if (fromThisComputer(c)) who = { kind: 'local' };
    else {
      const token = cookieOf(c);
      const signed = token ? people.authenticate(token) : null;
      if (signed) {
        who = { kind: 'person', person: signed.person, session: signed.session };
        rotated = signed.rotated;
      }
    }
    c.set('who', who);
    if (!who && !open(c.req.method, path))
      return c.json({ error: 'Sign in to Hildegard first.', code: 'signin' }, 401);
    if (who?.kind === 'person' && who.person.role === 'director' && !directorMay(c.req.method, path))
      return c.json({ error: 'Only the owner can do that here.', code: 'owner' }, 403);
    await next();
    // After the handler, so the new token rides on whatever it returned, a streamed video or file included.
    if (rotated) sendCookie(c, rotated);
  });
  const whoOf = (c: Context) => c.get('who');
  /** The owner, here or signed in from elsewhere. */
  const isOwner = (c: Context) => {
    const w = whoOf(c);
    return w?.kind === 'local' || (w?.kind === 'person' && w.person.role === 'owner');
  };
  const personOf = (c: Context) => {
    const w = whoOf(c);
    return w?.kind === 'person' ? w.person : null;
  };
  const sees = (c: Context, projectId: string) => seesProject(whoOf(c), store.projects.get(projectId));
  /** A director's takes waiting or rendering may not pass the owner's limit; owners and this computer have none. */
  const queueFull = (c: Context, adding: number) => {
    const w = whoOf(c);
    if (w?.kind !== 'person' || w.person.role !== 'director') return null;
    const limit = people.directorQueue();
    let mine = 0;
    for (const t of [...store.takes.values(), ...store.stills.values()])
      if (t.by?.id === w.person.id && (t.status === 'queued' || t.status === 'running')) mine++;
    if (mine + adding <= limit) return null;
    const each = limit === 1 ? '1 take' : `${limit} takes`;
    const room = limit - mine;
    const error =
      mine === 0
        ? `You can have ${each} waiting at once here. Ask for ${limit === 1 ? 'one take' : `up to ${limit}`} at a time.`
        : room > 0
          ? `You can have ${each} waiting at once here, and you have ${mine}. Ask for ${room === 1 ? 'one more take' : `up to ${room} more`}, or wait for one to finish.`
          : `You can have ${each} waiting at once here, and you have ${mine}. Wait for one to finish, or cancel one.`;
    return c.json({ error, code: 'queue' }, 429);
  };

  const snapshot = (): Snapshot => ({
    version: VERSION,
    source: SOURCE,
    projects: [...store.projects.values()],
    shots: [...store.shots.values()],
    takes: [...store.takes.values()],
    engine: scheduler.engineState(),
    models: deps.modelStates(),
    hf: deps.hf.state(),
    exports: deps.exporter.list(),
    choir: deps.choir.state(),
    guests: scheduler.guestTakes(),
    update: deps.updates.state(),
    characters: [...store.characters.values()],
    stills: [...store.stills.values()],
  });

  app.get('/api/health', (c) => c.json({ ok: true, version: VERSION, home: deps.home }));
  if (deps.node) app.route('/api/node', deps.node);

  // ── This computer: stopping, and linking AI apps. Only from this computer itself, never over the network. ─────
  const local = (c: Context) => whoOf(c)?.kind === 'local';
  app.post('/api/system/stop', (c) => {
    if (!local(c)) return c.json({ error: 'Only this computer can stop Hildegard.' }, 403);
    if (!deps.onStop) return c.json({ error: 'This server can’t stop itself.' }, 501);
    setTimeout(deps.onStop, 50);
    return c.json({ ok: true });
  });

  // ── Updates: the owner updates now, or turns automatic updates on or off ──────────────────────────────────────
  app.post('/api/update/check', async (c) => {
    if (!isOwner(c)) return c.json({ error: 'Only the owner can do that here.', code: 'owner' }, 403);
    return c.json(await deps.updates.check());
  });
  app.post('/api/update', (c) => {
    if (!isOwner(c)) return c.json({ error: 'Only the owner can do that here.', code: 'owner' }, 403);
    const why = deps.updates.apply();
    return why ? c.json({ error: why }, 409) : c.json(deps.updates.state());
  });
  app.put('/api/update', async (c) => {
    if (!isOwner(c)) return c.json({ error: 'Only the owner can do that here.', code: 'owner' }, 403);
    const body = (await c.req.json().catch(() => null)) as { auto?: unknown } | null;
    if (typeof body?.auto !== 'boolean')
      return c.json({ error: 'Send { "auto": true } or { "auto": false }.' }, 400);
    deps.updates.setAuto(body.auto);
    return c.json(deps.updates.state());
  });

  app.get('/api/agents', (c) =>
    c.json({
      agents: listAgents(),
      snippet: snippet('mcpServers', mcpCommand({ url: deps.url })),
      local: local(c),
    } satisfies AgentsResponse),
  );
  app.post('/api/agents/:id/:action{connect|disconnect}', (c) => {
    if (!local(c)) return c.json({ error: 'Link apps from the computer Hildegard runs on.' }, 403);
    const { id: agentId, action } = c.req.param();
    if (!findAgent(agentId)) return c.json({ error: `No app called ${agentId}` }, 404);
    const step =
      action === 'connect' ? connectAgent(agentId, mcpCommand({ url: deps.url })) : disconnectAgent(agentId);
    return c.json({ step, agents: listAgents() }, step.status === 'failed' ? 500 : 200);
  });
  app.get('/api/snapshot', (c) => c.json(snapshotFor(whoOf(c), snapshot())));
  app.get('/api/catalog', (c) => {
    c.header('cache-control', 'no-cache');
    return c.json(catalog);
  });

  app.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      let who = whoOf(c);
      const queue: ServerEvent[] = [];
      let wake: (() => void) | null = null;
      const off = store.on((e) => {
        // Coalesce: only the newest state of each take matters.
        if (e.type === 'take') {
          const i = queue.findIndex((q) => q.type === 'take' && q.take.id === e.take.id);
          if (i >= 0) queue.splice(i, 1);
        }
        if (e.type === 'still') {
          const i = queue.findIndex((q) => q.type === 'still' && q.still.id === e.still.id);
          if (i >= 0) queue.splice(i, 1);
        }
        // Each list of paired devices' renders replaces the last.
        if (e.type === 'guests') {
          const i = queue.findIndex((q) => q.type === 'guests');
          if (i >= 0) queue.splice(i, 1);
        }
        queue.push(e);
        wake?.();
      });
      // Someone removed, signed out or given another role: look again at once.
      let recheck = false;
      const offPeople = people.on(() => {
        recheck = true;
        wake?.();
      });
      stream.onAbort(() => {
        off();
        offPeople();
        wake?.();
      });
      // The snapshot is taken in the same tick as the subscription, so no change can fall between the two.
      const first = snapshotFor(who, snapshot());
      const sent = new Set<string>([
        ...first.projects.map((p) => p.id),
        ...first.shots.map((x) => x.id),
        ...first.takes.map((t) => t.id),
        ...first.exports.map((x) => x.id),
        ...first.characters.map((x) => x.id),
        ...first.stills.map((x) => x.id),
      ]);
      const filter = eventFilter(
        (id) => store.projects.get(id),
        sent,
        (id) => store.characters.get(id),
      );
      await stream.writeSSE({ event: 'hello', data: JSON.stringify({ version: VERSION, snapshot: first }) });
      while (!stream.aborted) {
        if (!queue.length && !recheck) {
          await Promise.race([new Promise<void>((r) => (wake = r)), stream.sleep(15_000)]);
          wake = null;
        }
        if (who?.kind === 'person') {
          recheck = false;
          const person = people.session(who.session);
          // Signed out or removed: the stream ends, and the Studio asks them to sign in.
          if (!person) break;
          who = { ...who, person };
        }
        if (!queue.length) {
          await stream.writeSSE({ event: 'ping', data: '{}' });
          continue;
        }
        const batch = queue
          .splice(0)
          .map((e) => filter(who, e))
          .filter((e): e is ServerEvent => e !== null);
        if (batch.length) await stream.writeSSE({ event: 'batch', data: JSON.stringify(batch) });
      }
      off();
      offPeople();
    }),
  );

  // ── Projects ────────────────────────────────────────────────────────────────────────────────────────────────
  /** A new film: the person who asked for it owns it, or nobody when it is this computer's own. */
  const newProject = (owner: string | undefined, title = 'Untitled film'): Project => {
    const p: Project = { id: id(), title, createdAt: now(), updatedAt: now(), shotIds: [] };
    if (owner) p.owner = owner;
    store.putProject(p);
    return p;
  };

  app.post('/api/projects', async (c) => {
    const body = z
      .object({ title: z.string().trim().min(1).max(120).optional() })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: 'Give the film a title of up to 120 characters' }, 400);
    return c.json(newProject(personOf(c)?.id, body.data.title), 201);
  });

  app.patch('/api/projects/:id', async (c) => {
    const p = store.projects.get(c.req.param('id'));
    if (!p || !sees(c, p.id)) return c.json({ error: 'No such film' }, 404);
    const body = z
      .object({ title: z.string().trim().min(1).max(120) })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Give the film a title of up to 120 characters' }, 400);
    p.title = body.data.title;
    store.putProject(p);
    return c.json(p);
  });

  // ── Export film ─────────────────────────────────────────────────────────────────────────────────────────────
  app.post('/api/projects/:id/export', (c) => {
    if (!sees(c, c.req.param('id'))) return c.json({ error: 'No such film' }, 404);
    try {
      return c.json(deps.exporter.start(c.req.param('id')), 202);
    } catch (e) {
      if (e instanceof ExportError) return c.json({ error: e.message }, e.status);
      throw e;
    }
  });
  app.get('/api/exports/:id', (c) => {
    const e = deps.exporter.get(c.req.param('id'));
    if (!e || !sees(c, e.projectId)) return c.json({ error: 'No such export' }, 404);
    // Where the file is on this computer, for agents running here.
    return c.json({ ...e, file: e.status === 'done' && local(c) ? deps.exporter.file(e) : null });
  });

  /**
   * The stills model must render where renders go: refused before the queue when this computer's own ComfyUI renders
   * and it isn't installed here, or when it won't run on this Mac.
   */
  const stillModelRefused = (c: Context, modelId: string, field: string) => {
    const st = deps.modelStates().find((m) => m.id === modelId);
    const name = catalog.models.find((m) => m.id === modelId)?.name ?? modelId;
    if (st?.fitWhy === 'apple-gpu')
      return c.json(
        {
          error: `${name} doesn’t render on this Mac yet. Pair a device with an NVIDIA or AMD GPU and render there.`,
          field,
          code: 'no_local_render',
        },
        422,
      );
    if (scheduler.engineState().comfy === 'managed' && !st?.installed)
      return c.json(
        {
          error: `Characters are drawn with ${name}, which isn’t installed on this computer. Install it in Settings › Models.`,
          field,
          code: 'missing_model',
        },
        422,
      );
    return null;
  };

  // ── Shots and takes ─────────────────────────────────────────────────────────────────────────────────────────
  app.post('/api/shots', async (c) => {
    const parsed = CreateShot.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Malformed request' }, 400);
    const body = parsed.data as CreateShotBody & { agent?: string };
    const req = ShotRequest.safeParse(body.request);
    if (!req.success) {
      const issue = req.error.issues[0]!;
      return c.json({ error: issue.message, field: issue.path.join('.') }, 422);
    }
    const request = req.data;
    // Refused before it queues, for people and agents alike; the queue and the GPU check it again.
    for (const [field, text] of [
      ['prompt', request.prompt],
      ['title', body.title ?? ''],
    ] as const) {
      const v = safety.text(text);
      if (!v.ok) return c.json({ error: v.message, field, code: 'content_blocked' }, 422);
    }
    if (request.startFrame && !existsSync(join(mediaDir, 'uploads', request.startFrame)))
      return c.json({ error: 'That start frame is gone; add it again', field: 'startFrame' }, 422);
    const cast: Character[] = [];
    for (const cid of request.characters) {
      const ch = store.characters.get(cid);
      if (!ch || !seesCharacter(whoOf(c), ch))
        return c.json({ error: 'Unknown character', field: 'characters' }, 422);
      const ok = usable(ch);
      if (!ok.ok) return c.json({ error: ok.why, field: 'characters', code: 'character' }, 422);
      if (!ch.references.length)
        return c.json(
          {
            error: `${ch.name} has no reference images yet. Make a portrait of them first.`,
            field: 'characters',
            code: 'character',
          },
          422,
        );
      cast.push(ch);
    }
    let composed: ReturnType<typeof composeShot>;
    try {
      composed = composeShot(catalog, request, cast);
    } catch (e) {
      if (e instanceof PresetError) return c.json({ error: e.message, field: e.field }, 422);
      throw e;
    }
    const stillsRefused = composed.cast
      ? stillModelRefused(c, composed.cast.keyframe.model.id, 'characters')
      : null;
    if (stillsRefused) return stillsRefused;
    // Apple's GPU renders some models wrong, slowly: refuse them before the queue, wherever their files are.
    const state = deps.modelStates().find((m) => m.id === composed.model.id);
    if (state?.fitWhy === 'apple-gpu')
      return c.json(
        {
          error: `${composed.model.name} doesn’t render on this Mac yet. Pair a device with an NVIDIA or AMD GPU and render there.`,
          field: 'model',
          code: 'no_local_render',
        },
        422,
      );
    // Here, Hildegard's own ComfyUI renders, so the model's files must be here too; say so now, not after the queue.
    if (
      deps.scheduler.engineState().comfy === 'managed' &&
      !deps.modelStates().find((m) => m.id === composed.model.id)?.installed
    )
      return c.json(
        {
          error: `${composed.model.name} isn’t installed on this computer. Install it in Settings › Models, or render on a paired device.`,
          field: 'model',
          code: 'missing_model',
        },
        422,
      );

    let shot = body.shotId ? store.shots.get(body.shotId) : undefined;
    if (body.shotId && (!shot || !sees(c, shot.projectId))) return c.json({ error: 'No such shot' }, 404);
    let project = store.projects.get(shot?.projectId ?? body.projectId ?? '');
    if (body.projectId && (!project || !sees(c, project.id))) return c.json({ error: 'No such film' }, 404);
    const person = personOf(c);
    const refused = queueFull(c, request.takes);
    if (refused) return refused;
    project ??= newProject(person?.id);
    if (!shot) {
      shot = {
        id: id(),
        projectId: project.id,
        title: body.title ?? titleFrom(request.prompt),
        prompt: request.prompt,
        createdAt: now(),
        takeIds: [],
      };
      project.shotIds.push(shot.id);
      store.putProject(project);
    }

    const priority: Priority = body.priority ?? (body.agent ? 'agent' : 'interactive');
    const takes: Take[] = takeSeeds(request.takes, request.seed)
      .map(
        (seed) =>
          ({
            id: id(),
            shotId: shot.id,
            projectId: project.id,
            number: shot.takeIds.length + 1,
            status: 'queued',
            priority,
            source: body.agent ? { kind: 'agent', name: body.agent } : { kind: 'studio' },
            ...(person ? { by: { id: person.id, name: person.name } } : {}),
            request,
            seed,
            model: composed.model.id,
            summary: composed.summary,
            prompt: composed.prompt,
            width: composed.width,
            height: composed.height,
            seconds: composed.seconds,
            fps: composed.fps,
            quality: composed.quality,
            queuePosition: null,
            progress: null,
            previewVersion: 0,
            createdAt: now(),
            startedAt: null,
            finishedAt: null,
            renderMs: null,
            error: null,
            kept: false,
            video: null,
            poster: null,
            bytes: null,
          }) satisfies Take,
      )
      .map((t) => {
        shot.takeIds.push(t.id);
        t.number = shot.takeIds.length;
        return t;
      });
    shot.prompt = request.prompt;
    store.putShot(shot);
    for (const t of takes) scheduler.enqueue(t);
    return c.json({ project, shot, takes }, 201);
  });

  /** One shot with its takes and its film. Finished takes include the video's path on this computer, for local agents. */
  app.get('/api/shots/:id', (c) => {
    const shot = store.shots.get(c.req.param('id'));
    if (!shot || !sees(c, shot.projectId)) return c.json({ error: 'No such shot' }, 404);
    const takes = shot.takeIds.map((t) => store.takes.get(t)).filter((t): t is Take => !!t);
    // Paths on this computer mean nothing elsewhere, and say more than they should.
    const files = local(c)
      ? Object.fromEntries(takes.filter((t) => t.video).map((t) => [t.id, join(mediaDir, `${t.id}.mp4`)]))
      : {};
    const film = store.projects.get(shot.projectId);
    return c.json({
      shot,
      takes,
      files,
      project: { id: shot.projectId, title: film?.title ?? 'Untitled film' },
    });
  });

  app.patch('/api/shots/:id', async (c) => {
    const s = store.shots.get(c.req.param('id'));
    if (!s || !sees(c, s.projectId)) return c.json({ error: 'No such shot' }, 404);
    const body = z
      .object({ title: z.string().trim().min(1).max(120) })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Give the shot a title of up to 120 characters' }, 400);
    s.title = body.data.title;
    store.putShot(s);
    return c.json(s);
  });

  const deleteTakeFiles = async (t: Take) => {
    await rm(join(mediaDir, `${t.id}.mp4`), { force: true });
    await rm(join(mediaDir, `${t.id}.jpg`), { force: true });
    await rm(join(mediaDir, `${t.id}.sheet.jpg`), { force: true });
  };

  app.delete('/api/shots/:id', async (c) => {
    const s = store.shots.get(c.req.param('id'));
    if (!s || !sees(c, s.projectId)) return c.json({ error: 'No such shot' }, 404);
    for (const tid of s.takeIds) {
      scheduler.cancel(tid);
      const t = store.takes.get(tid);
      if (t) await deleteTakeFiles(t);
      store.remove('take', tid);
    }
    const p = store.projects.get(s.projectId);
    if (p) {
      p.shotIds = p.shotIds.filter((x) => x !== s.id);
      store.putProject(p);
    }
    store.remove('shot', s.id);
    return c.body(null, 204);
  });

  const takeAction = (fn: (t: Take, c: Context) => Promise<Response> | Response) => async (c: Context) => {
    const t = store.takes.get(c.req.param('id') ?? '');
    if (!t || !sees(c, t.projectId)) return c.json({ error: 'No such take' }, 404);
    return fn(t, c);
  };

  app.post(
    '/api/takes/:id/cancel',
    takeAction((t, c) =>
      scheduler.cancel(t.id) ? c.json(t) : c.json({ error: 'This take has already finished' }, 409),
    ),
  );
  app.post(
    '/api/takes/:id/force',
    takeAction(async (t, c) => {
      // A director may stop only their own render to make room, never someone else's.
      const running = scheduler.runningTake();
      const interrupt =
        (await c.req.json().catch(() => ({})))?.interrupt !== false &&
        (isOwner(c) || (!!running && sees(c, running.projectId)));
      return scheduler.force(t.id, interrupt)
        ? c.json(t)
        : c.json({ error: 'Only a waiting take can be forced' }, 409);
    }),
  );
  app.post(
    '/api/takes/:id/retry',
    takeAction((t, c) => {
      if (t.error?.code === 'content_blocked')
        return c.json(
          { error: 'Hildegard refused this take, so it can’t be retried.', code: 'content_blocked' },
          409,
        );
      if (t.status === 'failed' || t.status === 'canceled') {
        const refused = queueFull(c, 1);
        if (refused) return refused;
      }
      const r = scheduler.retry(t.id);
      return r ? c.json(r) : c.json({ error: 'Only a failed or canceled take can be retried' }, 409);
    }),
  );
  app.post(
    '/api/takes/:id/keep',
    takeAction(async (t, c) => {
      const kept = (await c.req.json().catch(() => ({})))?.kept !== false;
      t.kept = kept;
      store.putTake(t);
      return c.json(t);
    }),
  );
  app.delete(
    '/api/takes/:id',
    takeAction(async (t, c) => {
      scheduler.cancel(t.id);
      await deleteTakeFiles(t);
      const s = store.shots.get(t.shotId);
      if (s) {
        s.takeIds = s.takeIds.filter((x) => x !== t.id);
        store.putShot(s);
      }
      store.remove('take', t.id);
      return c.body(null, 204);
    }),
  );

  app.get('/api/takes/:id/preview', (c) => {
    const id = c.req.param('id');
    const take = store.takes.get(id);
    if (!take || !sees(c, take.projectId)) return c.body(null, 404);
    const p = scheduler.previews.get(id);
    if (!p) {
      // The take finished between the event and this request: its last preview is now the poster.
      if (/^\w+$/.test(id) && existsSync(join(mediaDir, `${id}.jpg`)))
        return c.redirect(`/media/${id}.jpg`, 307);
      return c.body(null, 404);
    }
    c.header('cache-control', 'no-store');
    return c.body(Buffer.from(p.bytes), 200, { 'content-type': p.type });
  });

  /**
   * The technical half of the quality gate for a finished take: exposure, frozen and flickering frames, pushed colour,
   * clipped or badly levelled sound, held to the bar for its quality and checked against the length and sound its shot
   * asked for. Writes a contact sheet to look at (`/api/takes/:id/sheet`). Results are kept, since a take never changes.
   */
  const reviews = new Map<string, Promise<Review>>();
  app.get('/api/takes/:id/review', async (c) => {
    const t = store.takes.get(c.req.param('id'));
    if (!t || !sees(c, t.projectId)) return c.json({ error: 'No such take' }, 404);
    if (t.status !== 'done' || !t.video)
      return c.json(
        { error: 'This take hasn’t finished, so there is nothing to check yet', code: 'unfinished' },
        409,
      );
    if (!deps.review)
      return c.json({ error: 'Media checks can’t run on this computer: it has no Python with PyAV' }, 501);
    const file = join(mediaDir, `${t.id}.mp4`);
    if (!existsSync(file)) return c.json({ error: 'This take’s video is missing from this computer' }, 410);
    const model = catalog.models.find((m) => m.id === t.model);
    let pending = reviews.get(t.id);
    if (!pending) {
      pending = deps.review({
        path: file,
        sheet: join(mediaDir, `${t.id}.sheet.jpg`),
        final: t.quality === 'final',
        seconds: t.seconds,
        audio: model?.audio ?? false,
      });
      reviews.set(t.id, pending);
      pending.catch(() => reviews.delete(t.id));
    }
    try {
      const r = await pending;
      return c.json({
        take: t.id,
        ...r,
        summary: describeReview(r),
        sheet: r.info.sheet ? `/api/takes/${t.id}/sheet` : null,
      });
    } catch (e) {
      return c.json({ error: e instanceof ReviewError ? e.message : 'The media check failed' }, 500);
    }
  });
  app.get('/api/takes/:id/sheet', (c) => {
    const t = store.takes.get(c.req.param('id'));
    if (!t || !sees(c, t.projectId)) return c.body(null, 404);
    const file = join(mediaDir, `${t.id}.sheet.jpg`);
    if (!/^\w+$/.test(t.id) || !existsSync(file)) return c.body(null, 404);
    return sendFile(c, file, 'image/jpeg', 'private, max-age=31536000, immutable');
  });

  // ── Engine ──────────────────────────────────────────────────────────────────────────────────────────────────
  // ── Characters ──────────────────────────────────────────────────────────────────────────────────────────────
  const charOf = (c: Context) => {
    const ch = store.characters.get(c.req.param('id') ?? '');
    return ch && seesCharacter(whoOf(c), ch) ? ch : null;
  };
  const noCharacter = (c: Context) => c.json({ error: 'No such character' }, 404);
  /** A voice from the Voice studio, for a character's voice: its name, and whether it may speak now. */
  const voiceFor = (id: string): { name: string; usable: boolean } | null => {
    const v = deps.voice?.studio.list().find((x) => x.id === id);
    return v ? { name: v.name, usable: v.kind !== 'clone' || v.consent?.status === 'active' } : null;
  };
  const zodFail = (c: Context, e: z.ZodError) => {
    const issue = e.issues[0]!;
    return c.json({ error: issue.message, field: issue.path.join('.') }, 422);
  };
  /** The words a character carries, refused before anything is kept when they ask for sexual content. */
  const wordsRefused = (c: Context, ch: Pick<Character, 'name' | 'description' | 'wardrobe'>) => {
    const v = safety.text(characterText(ch));
    return v.ok ? null : c.json({ error: v.message, code: 'content_blocked' }, 422);
  };
  /** Files a character's references are, in the uploads folder. */
  const uploadPath = (file: string) => join(mediaDir, 'uploads', file);
  const deleteStillFiles = async (st: Still) => rm(join(mediaDir, 'stills', `${st.id}.png`), { force: true });

  /** Consent taken back, by the person or the maker: the character stops, and the person's photos go. */
  const revoked = async (ch: Character) => {
    const record = deps.likeness.record(ch.id);
    ch.consent = {
      status: 'revoked',
      person: ch.consent?.person ?? record?.record.person ?? null,
      expiresAt: null,
      givenAt: ch.consent?.givenAt ?? null,
      revokedAt: record?.revokedAt ?? now(),
      certificate: ch.consent?.certificate ?? null,
    };
    // Everything drawn of them goes: their photos, and the stills made from them.
    for (const st of [...store.stills.values()].filter((x) => x.characterId === ch.id)) {
      scheduler.cancel(st.id);
      await deleteStillFiles(st);
      store.remove('still', st.id);
    }
    const files = ch.references.map((r) => r.file);
    ch.references = [];
    ch.cover = null;
    store.putCharacter(ch);
    const used = new Set([...store.characters.values()].flatMap((x) => x.references.map((r) => r.file)));
    await Promise.all(files.filter((f) => !used.has(f)).map((f) => rm(uploadPath(f), { force: true })));
  };

  app.post('/api/characters', async (c) => {
    const body = CreateCharacter.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return zodFail(c, body.error);
    const refused = wordsRefused(c, body.data);
    if (refused) return refused;
    const person = personOf(c);
    const ch: Character = {
      id: id(),
      name: body.data.name,
      description: body.data.description,
      wardrobe: body.data.wardrobe,
      references: [],
      cover: null,
      voice: null,
      likeness: body.data.likeness,
      consent:
        body.data.likeness === 'real'
          ? {
              status: 'waiting',
              person: null,
              expiresAt: null,
              givenAt: null,
              revokedAt: null,
              certificate: null,
            }
          : null,
      createdAt: now(),
      updatedAt: now(),
    };
    if (person) ch.owner = person.id;
    store.putCharacter(ch);
    return c.json(ch, 201);
  });

  app.patch('/api/characters/:id', async (c) => {
    const ch = charOf(c);
    if (!ch) return noCharacter(c);
    const body = EditCharacter.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return zodFail(c, body.error);
    const next = {
      ...ch,
      ...Object.fromEntries(Object.entries(body.data).filter(([, v]) => v !== undefined)),
    };
    const refused = wordsRefused(c, next);
    if (refused) return refused;
    if (body.data.voice) {
      const v = voiceFor(body.data.voice);
      if (!v) return c.json({ error: 'No such voice', field: 'voice' }, 422);
      if (!v.usable)
        return c.json(
          { error: `${v.name} can’t speak anymore: its consent was taken back.`, field: 'voice' },
          422,
        );
    }
    if (body.data.cover && !ch.references.some((r) => r.file === body.data.cover))
      return c.json({ error: 'Pick the cover from their references', field: 'cover' }, 422);
    Object.assign(ch, next);
    store.putCharacter(ch);
    return c.json(ch);
  });

  app.delete('/api/characters/:id', async (c) => {
    const ch = charOf(c);
    if (!ch) return noCharacter(c);
    for (const st of [...store.stills.values()].filter((x) => x.characterId === ch.id)) {
      scheduler.cancel(st.id);
      await deleteStillFiles(st);
      store.remove('still', st.id);
    }
    if (ch.likeness === 'real') {
      deps.likeness.forget(ch.id);
      // A real person's photos are theirs: they go with the character.
      const others = new Set(
        [...store.characters.values()]
          .filter((x) => x.id !== ch.id)
          .flatMap((x) => x.references.map((r) => r.file)),
      );
      await Promise.all(
        ch.references.filter((r) => !others.has(r.file)).map((r) => rm(uploadPath(r.file), { force: true })),
      );
    }
    store.remove('character', ch.id);
    return c.body(null, 204);
  });

  /** Add an image to an invented character's references: an upload, which the person says shows no real person. */
  app.post('/api/characters/:id/references', async (c) => {
    const ch = charOf(c);
    if (!ch) return noCharacter(c);
    const body = z
      .object({
        file: z.string().regex(/^[a-f0-9]{64}\.(png|jpg|webp)$/),
        view: z.enum(['portrait', 'three-quarter', 'profile', 'full-body']).nullable().default(null),
        /** The person adding it says it shows no real person, or only artwork they have the rights to. */
        noRealPerson: z.literal(true),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success)
      return c.json(
        {
          error:
            'Say that the image shows no real person, or add a real person through their own consent instead.',
          field: 'noRealPerson',
        },
        422,
      );
    if (ch.likeness === 'real')
      return c.json(
        {
          error: `Images of ${ch.name} come only from the photos they take themselves when they give consent.`,
          code: 'consent',
        },
        409,
      );
    const path = uploadPath(body.data.file);
    if (!existsSync(path)) return c.json({ error: 'That image is gone; add it again', field: 'file' }, 422);
    if (statSync(path).size > MAX_REFERENCE)
      return c.json({ error: 'Reference images up to 10 MB', field: 'file' }, 413);
    if (ch.references.some((r) => r.file === body.data.file)) return c.json(ch);
    if (ch.references.length >= MAX_CHARACTER_REFS)
      return c.json(
        { error: `A character keeps up to ${MAX_CHARACTER_REFS} references. Remove one first.` },
        409,
      );
    ch.references.push({ file: body.data.file, view: body.data.view, source: 'upload', addedAt: now() });
    ch.cover ??= body.data.file;
    store.putCharacter(ch);
    return c.json(ch, 201);
  });

  app.delete('/api/characters/:id/references/:file', (c) => {
    const ch = charOf(c);
    if (!ch) return noCharacter(c);
    const file = c.req.param('file');
    const ref = ch.references.find((r) => r.file === file);
    if (!ref) return c.json({ error: 'No such reference' }, 404);
    if (ref.source === 'consent')
      return c.json(
        { error: `${ch.name}’s own consent photos stay while their consent does. Revoke it to remove them.` },
        409,
      );
    ch.references = ch.references.filter((r) => r !== ref);
    if (ch.cover === file) ch.cover = ch.references[0]?.file ?? null;
    store.putCharacter(ch);
    return c.json(ch);
  });

  /** Portraits to pick a face from, or the other views of a sheet: each a still on the queue. */
  app.post('/api/characters/:id/stills', async (c) => {
    const ch = charOf(c);
    if (!ch) return noCharacter(c);
    const parsed = z
      .object({ agent: z.string().trim().min(1).max(60).optional() })
      .passthrough()
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'Malformed request' }, 400);
    const { agent, ...rest } = parsed.data;
    const body = StillRequest.safeParse(rest);
    if (!body.success) return zodFail(c, body.error);
    const ok = usable(ch);
    if (!ok.ok) return c.json({ error: ok.why, code: 'character' }, 409);
    if (ch.likeness === 'real' && !ch.references.length)
      return c.json({ error: `${ch.name} has no photos yet.`, code: 'character' }, 409);
    const refused = wordsRefused(c, ch);
    if (refused) return refused;
    const v = safety.text(body.data.note);
    if (!v.ok) return c.json({ error: v.message, field: 'note', code: 'content_blocked' }, 422);
    let still: ReturnType<typeof composeCharacterStill>;
    try {
      still = composeCharacterStill(catalog, ch, body.data.view, { note: body.data.note });
    } catch (e) {
      if (e instanceof PresetError) return c.json({ error: e.message, field: e.field }, 422);
      throw e;
    }
    const modelRefused = stillModelRefused(c, still.model.id, 'view');
    if (modelRefused) return modelRefused;
    const full = queueFull(c, body.data.count);
    if (full) return full;
    const person = personOf(c);
    const priority: Priority = body.data.priority ?? (agent ? 'agent' : 'interactive');
    const stills = takeSeeds(body.data.count, body.data.seed).map((seed) => {
      const st: Still = {
        id: id(),
        characterId: ch.id,
        view: body.data.view,
        status: 'queued',
        priority,
        source: agent ? { kind: 'agent', name: agent } : { kind: 'studio' },
        ...(person ? { by: { id: person.id, name: person.name } } : {}),
        seed,
        model: still.model.id,
        prompt: still.prompt,
        references: still.references,
        width: still.width,
        height: still.height,
        queuePosition: null,
        progress: null,
        previewVersion: 0,
        createdAt: now(),
        startedAt: null,
        finishedAt: null,
        renderMs: null,
        error: null,
        image: null,
      };
      scheduler.enqueueStill(st);
      return st;
    });
    return c.json({ character: ch, stills }, 201);
  });

  const stillAction =
    (fn: (st: Still, ch: Character, c: Context) => Promise<Response> | Response) => async (c: Context) => {
      const st = store.stills.get(c.req.param('id') ?? '');
      const ch = st ? store.characters.get(st.characterId) : undefined;
      if (!st || !ch || !seesCharacter(whoOf(c), ch)) return c.json({ error: 'No such still' }, 404);
      return fn(st, ch, c);
    };
  app.post(
    '/api/stills/:id/cancel',
    stillAction((st, _ch, c) =>
      scheduler.cancel(st.id) ? c.json(st) : c.json({ error: 'This still has already finished' }, 409),
    ),
  );
  app.post(
    '/api/stills/:id/force',
    stillAction((st, _ch, c) =>
      scheduler.force(st.id, isOwner(c))
        ? c.json(st)
        : c.json({ error: 'Only a waiting still can be forced' }, 409),
    ),
  );
  app.post(
    '/api/stills/:id/retry',
    stillAction((st, _ch, c) => {
      if (st.error?.code === 'content_blocked')
        return c.json(
          { error: 'Hildegard refused this still, so it can’t be retried.', code: 'content_blocked' },
          409,
        );
      const full = queueFull(c, 1);
      if (full) return full;
      return scheduler.retry(st.id)
        ? c.json(st)
        : c.json({ error: 'Only a failed or canceled still can be retried' }, 409);
    }),
  );
  /** Keep a finished still as one of the character's references: copied into uploads under its own SHA-256. */
  app.post(
    '/api/stills/:id/keep',
    stillAction(async (st, ch, c) => {
      if (st.status !== 'done') return c.json({ error: 'Only a finished still can be kept' }, 409);
      const ok = usable(ch);
      if (!ok.ok) return c.json({ error: ok.why, code: 'character' }, 409);
      const src = join(mediaDir, 'stills', `${st.id}.png`);
      const bytes = await readFile(src).catch(() => null);
      if (!bytes) return c.json({ error: 'That still is gone' }, 410);
      const kind = sniffImage(bytes) ?? 'png';
      const file = `${createHash('sha256').update(bytes).digest('hex')}.${kind}`;
      if (!existsSync(uploadPath(file))) await copyFile(src, uploadPath(file));
      if (!ch.references.some((r) => r.file === file)) {
        if (ch.references.length >= MAX_CHARACTER_REFS)
          return c.json(
            { error: `A character keeps up to ${MAX_CHARACTER_REFS} references. Remove one first.` },
            409,
          );
        const ref: CharacterRef = { file, view: st.view, source: 'still', addedAt: now() };
        ch.references.push(ref);
      }
      // The first portrait kept is their face from now on.
      if (
        !ch.cover ||
        (st.view === 'portrait' && !ch.references.some((r) => r.file === ch.cover && r.view === 'portrait'))
      )
        ch.cover = file;
      store.putCharacter(ch);
      st.kept = file;
      store.putStill(st);
      return c.json(ch);
    }),
  );
  app.delete(
    '/api/stills/:id',
    stillAction(async (st, _ch, c) => {
      scheduler.cancel(st.id);
      await deleteStillFiles(st);
      store.remove('still', st.id);
      return c.body(null, 204);
    }),
  );
  app.get('/api/stills/:id/preview', (c) => {
    const st = store.stills.get(c.req.param('id'));
    if (!st || !seesCharacter(whoOf(c), store.characters.get(st.characterId))) return c.body(null, 404);
    const p = scheduler.previews.get(st.id);
    if (!p) return st.image ? c.redirect(st.image, 307) : c.body(null, 404);
    c.header('cache-control', 'no-store');
    return c.body(Buffer.from(p.bytes), 200, { 'content-type': p.type });
  });

  // ── Consent from real people ────────────────────────────────────────────────────────────────────────────────
  /** A one-time link for the real person a character is based on. The link is the secret: shown once. */
  app.post('/api/characters/:id/consent', async (c) => {
    const ch = charOf(c);
    if (!ch) return noCharacter(c);
    if (ch.likeness !== 'real')
      return c.json({ error: `${ch.name} is invented: nobody needs to consent.` }, 409);
    if (ch.consent?.status === 'active')
      return c.json(
        { error: `${ch.consent.person ?? 'They'} already consented. Revoke it first to ask again.` },
        409,
      );
    const body = z
      .object({ maker: z.string().trim().min(1).max(80).optional() })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: 'Your name, up to 80 characters', field: 'maker' }, 422);
    const maker = body.data.maker ?? personOf(c)?.name;
    if (!maker) return c.json({ error: 'Say who is asking: they’ll see your name', field: 'maker' }, 422);
    const { token, expiresAt } = deps.likeness.start({ characterId: ch.id, character: ch.name, maker });
    ch.consent = {
      status: 'waiting',
      person: null,
      expiresAt,
      givenAt: null,
      revokedAt: null,
      certificate: null,
    };
    store.putCharacter(ch);
    // The link goes where people reach this Hildegard: its host link, or the address this page came from.
    const base = host.state().url ?? (local(c) ? null : new URL(c.req.url).origin);
    c.header('cache-control', 'no-store');
    return c.json(
      {
        character: ch,
        url: `${base ?? deps.url ?? ''}/#/likeness/${token}`,
        // Only this computer can open it until Hildegard is at a link.
        local: !host.state().url,
      },
      201,
    );
  });
  app.get('/api/characters/:id/consent', (c) => {
    const ch = charOf(c);
    if (!ch) return noCharacter(c);
    const record = deps.likeness.record(ch.id);
    if (!record) return c.json({ error: `Nobody has consented to ${ch.name} yet` }, 404);
    c.header('content-disposition', `attachment; filename="consent-${record.record.id}.json"`);
    return c.json(record);
  });
  app.post('/api/characters/:id/consent/revoke', async (c) => {
    const ch = charOf(c);
    if (!ch) return noCharacter(c);
    if (ch.likeness !== 'real') return c.json({ error: `${ch.name} is invented` }, 409);
    deps.likeness.revoke({ characterId: ch.id });
    await revoked(ch);
    return c.json(ch);
  });

  /** What the person is asked, for the page their link opens. Anyone holding the link may read it. */
  app.get('/api/likeness/:token', (c) => {
    const ask = deps.likeness.lookup(c.req.param('token'));
    c.header('cache-control', 'no-store');
    if (!ask) return c.json({ error: 'This link has expired or was already used.' }, 410);
    return c.json({
      character: ask.character,
      maker: ask.maker,
      expiresAt: ask.expiresAt,
      photos: CONSENT_PHOTOS,
      // With their name in place of the blank, this is what they agree to.
      statement: statement({ person: '…', maker: ask.maker, character: ask.character }),
    });
  });
  app.post('/api/likeness/:token/decline', (c) => {
    try {
      const cid = deps.likeness.decline(c.req.param('token'));
      const ch = store.characters.get(cid);
      if (ch?.consent?.status === 'waiting') {
        ch.consent = { ...ch.consent, status: 'declined', expiresAt: null };
        store.putCharacter(ch);
      }
      return c.json({ ok: true });
    } catch (e) {
      if (e instanceof LikenessError) return c.json({ error: e.message }, e.status);
      throw e;
    }
  });
  app.post('/api/likeness/:token', async (c) => {
    const token = c.req.param('token');
    const ask = deps.likeness.lookup(token);
    if (!ask) return c.json({ error: 'This link has expired or was already used.' }, 410);
    const ch = store.characters.get(ask.characterId);
    if (ch?.likeness !== 'real') return c.json({ error: 'This character is gone.' }, 410);
    const len = Number(c.req.header('content-length') ?? 0);
    if (len > CONSENT_PHOTOS.length * MAX_CONSENT_PHOTO * 1.4)
      return c.json({ error: 'The photos are too big.' }, 413);
    const body = z
      .object({
        person: z.string().trim().min(1).max(80),
        agree: z.literal(true),
        photos: z.array(z.string().max(Math.ceil(MAX_CONSENT_PHOTO * 1.37))).length(CONSENT_PHOTOS.length),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success)
      return c.json({ error: `Type your name, agree, and take all ${CONSENT_PHOTOS.length} photos.` }, 422);
    const photos = body.data.photos.map((b64) =>
      Buffer.from(b64.replace(/^data:image\/\w+;base64,/, ''), 'base64'),
    );
    const kinds = photos.map((b) => sniffImage(b));
    if (kinds.some((k) => !k) || photos.some((b) => b.length > MAX_CONSENT_PHOTO))
      return c.json({ error: 'Each photo must be a camera picture of up to 10 MB.' }, 422);
    try {
      const { consent, revokeToken } = deps.likeness.give(token, body.data.person, photos);
      const refs: CharacterRef[] = [];
      for (const [i, b] of photos.entries()) {
        const file = `${consent.record.photos[i]}.${kinds[i]}`;
        if (!existsSync(uploadPath(file))) await writeFile(uploadPath(file), b);
        refs.push({ file, view: CONSENT_PHOTOS[i]!, source: 'consent', addedAt: now() });
      }
      ch.references = refs;
      ch.cover = refs[0]!.file;
      ch.consent = {
        status: 'active',
        person: consent.record.person,
        expiresAt: null,
        givenAt: consent.record.givenAt,
        revokedAt: null,
        certificate: consent.record.id,
      };
      store.putCharacter(ch);
      const base = host.state().url ?? new URL(c.req.url).origin;
      c.header('cache-control', 'no-store');
      return c.json(
        { ok: true, revokeUrl: `${base}/#/likeness/revoke/${revokeToken}`, record: consent.record },
        201,
      );
    } catch (e) {
      if (e instanceof LikenessError) return c.json({ error: e.message }, e.status);
      throw e;
    }
  });
  app.post('/api/likeness/revoke/:token', async (c) => {
    const cid = deps.likeness.revoke({ token: c.req.param('token') });
    if (!cid) return c.json({ error: 'That link doesn’t take anything back.' }, 404);
    const ch = store.characters.get(cid);
    if (ch && ch.consent?.status !== 'revoked') await revoked(ch);
    return c.json({ ok: true, character: ch?.name ?? null });
  });

  app.post('/api/engine/pause', (c) => {
    scheduler.setPaused(true);
    return c.json(scheduler.engineState());
  });
  app.post('/api/engine/resume', (c) => {
    scheduler.setPaused(false);
    return c.json(scheduler.engineState());
  });

  // ── Choir: rendering on your other devices ──────────────────────────────────────────────────────────────────
  const choirFail = (c: Context, e: unknown) => {
    if (e instanceof ChoirError) return c.json({ error: e.message }, e.status);
    throw e;
  };
  const pairLocal = (c: Context) =>
    local(c) ? null : c.json({ error: 'Pair devices from the computer Hildegard runs on.' }, 403);
  app.get('/api/choir', async (c) => c.json(await deps.choir.refresh()));
  app.get('/api/choir/tailnet', (c) => c.json({ url: deps.tailnet() }));
  app.post('/api/choir/invite', async (c) => {
    const refused = pairLocal(c);
    if (refused) return refused;
    const body = z
      .object({ url: z.string().max(200).optional(), key: z.string().max(100).optional() })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: 'Give an address like http://100.101.102.103:7341.' }, 400);
    try {
      c.header('cache-control', 'no-store');
      return c.json(await deps.invite(body.data.url, body.data.key));
    } catch (e) {
      return choirFail(c, e);
    }
  });
  app.post('/api/choir/revoke', (c) => {
    const refused = pairLocal(c);
    if (refused) return refused;
    deps.choir.revoke();
    return c.json(deps.choir.state());
  });
  app.post('/api/choir/opportunistic', async (c) => {
    // How this computer queues its own work against your other devices': the owner's choice, from anywhere.
    if (!isOwner(c)) return c.json({ error: 'Only the owner can do that here.', code: 'owner' }, 403);
    const body = z.object({ on: z.boolean() }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Say on or off.' }, 400);
    const turningOn = body.data.on && !deps.choir.opportunistic;
    deps.choir.setOpportunistic(body.data.on);
    // Answer with what it can see now, not what it saw at start: the driver may have stopped answering since.
    if (turningOn) await deps.lookBusy?.();
    return c.json(deps.choir.state());
  });
  app.post('/api/choir/join', async (c) => {
    const refused = pairLocal(c);
    if (refused) return refused;
    const body = z
      .object({ code: z.string().max(2048), name: z.string().max(63).optional() })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Paste the join code from the other device.' }, 400);
    try {
      // With no ComfyUI of its own, this computer renders on the device it joins straight away.
      const device = await deps.choir.join(body.data.code, {
        name: body.data.name,
        autoUse: scheduler.engineState().comfy === 'not-installed',
      });
      return c.json({ device, choir: deps.choir.state() }, 201);
    } catch (e) {
      return choirFail(c, e);
    }
  });
  app.post('/api/choir/leave', async (c) => {
    const refused = pairLocal(c);
    if (refused) return refused;
    const body = z.object({ name: z.string().max(63) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Say which device.' }, 400);
    try {
      deps.choir.leave(body.data.name);
      return c.json(deps.choir.state());
    } catch (e) {
      return choirFail(c, e);
    }
  });
  app.post('/api/choir/update', async (c) => {
    if (!isOwner(c)) return c.json({ error: 'Only the owner can do that here.', code: 'owner' }, 403);
    const body = z.object({ name: z.string().max(63) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Say which device.' }, 400);
    try {
      return c.json({ device: await deps.choir.update(body.data.name), choir: deps.choir.state() });
    } catch (e) {
      return choirFail(c, e);
    }
  });
  app.post('/api/choir/use', async (c) => {
    const body = z.object({ name: z.string().max(63) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Say which device, or “local”.' }, 400);
    try {
      deps.choir.use(body.data.name);
      return c.json(deps.choir.state());
    } catch (e) {
      return choirFail(c, e);
    }
  });

  // ── Models ──────────────────────────────────────────────────────────────────────────────────────────────────
  app.post('/api/models/:id/install', async (c) => {
    const id = c.req.param('id');
    const model = catalog.models.find((m) => m.id === id);
    if (!model) return c.json({ error: 'No such model' }, 404);
    const remote = deps.choir.active();
    if (remote)
      return c.json(
        {
          error: `Takes render on ${remote.name}, so models go there. On ${remote.name}, run \`hildegard models install ${id}\`.`,
          code: 'remote',
        },
        409,
      );
    const body = (await c.req.json().catch(() => ({}))) as { acceptLicense?: unknown };
    if (body.acceptLicense === true) deps.models.acceptLicense(id);
    if (!deps.models.licenseAccepted(id))
      return c.json(
        {
          error: `Accept the ${model.license} first.`,
          code: 'license',
          license: model.license,
          licenseUrl: model.licenseUrl,
          terms: model.terms,
        },
        409,
      );
    if (model.gated && !deps.hf.state().linked)
      return c.json(
        {
          error: `${model.name} downloads from Hugging Face, which wants your account. Link it in Settings › Hugging Face, or run \`hildegard hf login\`.`,
          code: 'hf',
        },
        409,
      );
    void deps.models.install(id).catch(() => {});
    return c.json(deps.models.states(), 202);
  });
  app.post('/api/models/:id/cancel', (c) =>
    deps.models.cancel(c.req.param('id'))
      ? c.json(deps.models.states())
      : c.json({ error: 'Nothing is downloading' }, 409),
  );

  // ── Hugging Face account ───────────────────────────────────────────────────────────────────────────────────
  const hfFail = (c: Context, e: unknown) => c.json({ error: (e as Error).message }, 400);
  app.get('/api/hf', (c) => c.json(deps.hf.state()));
  app.post('/api/hf/token', async (c) => {
    const body = z.object({ token: z.string().max(400) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Paste a token' }, 400);
    try {
      return c.json(await deps.hf.setToken(body.data.token));
    } catch (e) {
      return hfFail(c, e);
    }
  });
  app.post('/api/hf/unlink', (c) => c.json(deps.hf.unlink()));
  // Reads a file in the owner's home, so only from this computer.
  app.post('/api/hf/import', async (c) => {
    if (!local(c)) return c.json({ error: 'Link Hugging Face from the computer Hildegard runs on' }, 403);
    try {
      return c.json(await deps.hf.useHubToken());
    } catch (e) {
      return hfFail(c, e);
    }
  });
  app.post('/api/hf/oauth/start', (c) => {
    // Hugging Face accepts any port on a loopback redirect, so browser sign-in works only from this computer.
    const u = new URL(c.req.url);
    if (!LOOPBACK.has(u.hostname) || !local(c))
      return c.json({ error: 'Sign in from this computer, or use a code from another device' }, 409);
    try {
      return c.json({ url: deps.hf.beginOAuth(`${u.protocol}//${u.host}/api/hf/callback`) });
    } catch (e) {
      return hfFail(c, e);
    }
  });
  app.get('/api/hf/callback', async (c) => {
    const code = c.req.query('code');
    const state = c.req.query('state');
    let message = 'Hugging Face is linked. You can close this tab.';
    let ok = true;
    if (c.req.query('error') || !code || !state) {
      ok = false;
      message = 'Sign-in was canceled. Nothing changed.';
    } else {
      try {
        const s = await deps.hf.finishOAuth(state, code);
        message = `Linked as ${s.user}. You can close this tab.`;
      } catch (e) {
        ok = false;
        message = (e as Error).message;
      }
    }
    c.header(
      'content-security-policy',
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    );
    c.header('cache-control', 'no-store');
    const esc = message.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
    return c.html(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Hildegard</title><style>body{font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;background:#14110f;color:#f3ede4}main{max-width:28rem;padding:2rem;text-align:center}a{color:#e8b86a}</style><main><p>${esc}</p><p><a href="/#/settings/huggingface">Back to Hildegard</a></p></main>`,
      ok ? 200 : 400,
    );
  });
  app.post('/api/hf/device', async (c) => {
    try {
      return c.json(await deps.hf.beginDevice());
    } catch (e) {
      return hfFail(c, e);
    }
  });

  // ── Signing in, from other devices ─────────────────────────────────────────────────────────────────────────
  const perName = new Limiter(deps.limits?.perName ?? 10, 15 * 60_000);
  const perClient = new Limiter(deps.limits?.perClient ?? 30, 15 * 60_000);
  /** Too many wrong tries: from this address, or at this account from anywhere. */
  const limited = (c: Context, keys: string[]) => {
    const wait = Math.max(...keys.map((k) => (k.startsWith('name:') ? perName : perClient).wait(k)));
    if (!wait) return null;
    c.header('retry-after', String(wait));
    return c.json(
      {
        error: `Too many tries. Wait ${wait > 90 ? `${Math.ceil(wait / 60)} minutes` : `${wait} seconds`}, then try again.`,
      },
      429,
    );
  };
  const failed = (keys: string[]) => {
    for (const k of keys) (k.startsWith('name:') ? perName : perClient).fail(k);
  };
  const authState = (c: Context): AuthState => ({
    local: local(c),
    person: personOf(c),
    owner: people.hasOwner(),
  });
  const peopleFail = (c: Context, e: unknown) => {
    if (e instanceof PeopleError) return c.json({ error: e.message }, e.status);
    throw e;
  };
  const Credentials = z.object({ name: z.string().max(200), passphrase: z.string().max(1024) });

  app.get('/api/auth/me', (c) => {
    c.header('cache-control', 'no-store');
    return c.json(authState(c));
  });
  app.post('/api/auth/signin', async (c) => {
    c.header('cache-control', 'no-store');
    const body = Credentials.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Give your name and passphrase.' }, 400);
    const keys = [`client:${clientKey(c)}`, `name:${body.data.name.trim().toLocaleLowerCase()}`];
    const refused = limited(c, keys);
    if (refused) return refused;
    const r = await people.signIn(body.data.name, body.data.passphrase);
    if (!r) {
      failed(keys);
      return c.json({ error: 'That name and passphrase don’t match.' }, 401);
    }
    perName.clear(keys[1]!);
    sendCookie(c, r.token);
    return c.json({ local: local(c), person: r.person, owner: true } satisfies AuthState);
  });
  app.post('/api/auth/signout', (c) => {
    const token = cookieOf(c);
    if (token) people.signOut(token);
    dropCookie(c);
    return c.json({ local: local(c), person: null, owner: people.hasOwner() } satisfies AuthState);
  });
  app.post('/api/auth/passphrase', async (c) => {
    c.header('cache-control', 'no-store');
    const w = whoOf(c);
    if (!w) return c.json({ error: 'Sign in to Hildegard first.', code: 'signin' }, 401);
    if (w.kind !== 'person')
      return c.json(
        { error: 'This computer has no passphrase of its own. Set the owner’s with `hildegard host owner`.' },
        409,
      );
    const body = z
      .object({ current: z.string().max(1024), next: z.string().max(1024) })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Give your current passphrase and a new one.' }, 400);
    const keys = [`client:${clientKey(c)}`, `name:${w.person.name.toLocaleLowerCase()}`];
    const limitedNow = limited(c, keys);
    if (limitedNow) return limitedNow;
    try {
      if (!(await people.changePassphrase(w.person.id, body.data.current, body.data.next, w.session))) {
        failed(keys);
        return c.json({ error: 'That isn’t your current passphrase.' }, 403);
      }
      return c.json(authState(c));
    } catch (e) {
      return peopleFail(c, e);
    }
  });
  app.get('/api/auth/invite/:token', (c) => {
    c.header('cache-control', 'no-store');
    const keys = [`client:${clientKey(c)}`];
    const refused = limited(c, keys);
    if (refused) return refused;
    const invite = people.checkInvite(c.req.param('token'));
    if (!invite) {
      failed(keys);
      return c.json({ error: 'This invite has been used or has expired. Ask for a new one.' }, 404);
    }
    return c.json({ role: invite.role, expiresAt: invite.expiresAt });
  });
  app.post('/api/auth/invite/:token/accept', async (c) => {
    c.header('cache-control', 'no-store');
    const keys = [`client:${clientKey(c)}`];
    const refused = limited(c, keys);
    if (refused) return refused;
    const body = Credentials.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Choose a name and a passphrase.' }, 400);
    try {
      const r = await people.acceptInvite(c.req.param('token'), body.data.name, body.data.passphrase);
      sendCookie(c, r.token);
      return c.json({ local: local(c), person: r.person, owner: true } satisfies AuthState, 201);
    } catch (e) {
      if (e instanceof PeopleError && e.status === 404) failed(keys);
      return peopleFail(c, e);
    }
  });

  // ── People: the owner invites, changes roles and removes ────────────────────────────────────────────────────
  const ownerOnly = (c: Context) =>
    isOwner(c) ? null : c.json({ error: 'Only the owner can do that here.', code: 'owner' }, 403);
  const peopleList = (): PeopleResponse => ({
    people: people.list(),
    invites: people.invites(),
    directorQueue: people.directorQueue(),
  });
  app.get('/api/people', (c) => ownerOnly(c) ?? c.json(peopleList()));
  app.post('/api/people/owner', async (c) => {
    if (!local(c)) return c.json({ error: 'Make the owner account on the computer Hildegard runs on.' }, 403);
    const body = Credentials.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Give a name and a passphrase.' }, 400);
    try {
      const owner = await people.setOwner(body.data.name, body.data.passphrase);
      store.emit({ type: 'host', host: host.state() });
      return c.json({ owner, ...peopleList() }, owner.created ? 201 : 200);
    } catch (e) {
      return peopleFail(c, e);
    }
  });
  app.post('/api/people/invites', async (c) => {
    const refused = ownerOnly(c);
    if (refused) return refused;
    const body = z
      .object({ role: z.enum(['owner', 'director']).default('director'), hours: z.number().optional() })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: 'Choose director or owner.' }, 400);
    try {
      const { invite, token } = people.invite(body.data.role, body.data.hours ?? INVITE_HOURS.default);
      // The link goes where people reach this Hildegard: its host link, or the address this page came from.
      const base = host.state().url ?? (local(c) ? null : new URL(c.req.url).origin);
      c.header('cache-control', 'no-store');
      return c.json({ invite, url: `${base ?? deps.url ?? ''}/#/invite/${token}` } satisfies NewInvite, 201);
    } catch (e) {
      return peopleFail(c, e);
    }
  });
  app.patch('/api/people/settings', async (c) => {
    const refused = ownerOnly(c);
    if (refused) return refused;
    const body = z.object({ directorQueue: z.number() }).safeParse(await c.req.json().catch(() => null));
    if (!body.success)
      return c.json(
        { error: `Give a number of takes from ${DIRECTOR_QUEUE.min} to ${DIRECTOR_QUEUE.max}.` },
        400,
      );
    try {
      people.setDirectorQueue(body.data.directorQueue);
      return c.json(peopleList());
    } catch (e) {
      return peopleFail(c, e);
    }
  });
  app.delete('/api/people/invites/:id', (c) => {
    const refused = ownerOnly(c);
    if (refused) return refused;
    try {
      people.cancelInvite(c.req.param('id'));
      return c.json(peopleList());
    } catch (e) {
      return peopleFail(c, e);
    }
  });
  app.patch('/api/people/:id', async (c) => {
    const refused = ownerOnly(c);
    if (refused) return refused;
    const body = z
      .object({ role: z.enum(['owner', 'director']) })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Choose director or owner.' }, 400);
    try {
      people.setRole(c.req.param('id'), body.data.role, personOf(c)?.id ?? null);
      return c.json(peopleList());
    } catch (e) {
      return peopleFail(c, e);
    }
  });
  app.delete('/api/people/:id', (c) => {
    const refused = ownerOnly(c);
    if (refused) return refused;
    try {
      people.revoke(c.req.param('id'), personOf(c)?.id ?? null);
      return c.json(peopleList());
    } catch (e) {
      return peopleFail(c, e);
    }
  });

  // ── Keys and chatbots: what AI apps on other devices use the MCP with ───────────────────────────────────────
  const { grants } = deps;
  people.onPassphrase((personId) => grants.endChatbots(personId));
  const mcpUrl = () => {
    const u = host.state().url;
    return u ? `${u.replace(/\/$/, '')}/mcp` : null;
  };
  const grantFail = (c: Context, e: unknown) => {
    if (e instanceof GrantError) return c.json({ error: e.message }, e.status);
    throw e;
  };
  /** Everyone's for the owner and this computer; one's own for a director. */
  app.get('/api/auth/grants', (c) => {
    c.header('cache-control', 'no-store');
    const w = whoOf(c);
    if (!w) return c.json({ error: 'Sign in to Hildegard first.', code: 'signin' }, 401);
    return c.json({
      grants: grants.list(isOwner(c) ? null : (personOf(c)?.id ?? null)),
      mcpUrl: mcpUrl(),
    } satisfies GrantsResponse);
  });
  app.post('/api/auth/keys', async (c) => {
    c.header('cache-control', 'no-store');
    const w = whoOf(c);
    if (!w) return c.json({ error: 'Sign in to Hildegard first.', code: 'signin' }, 401);
    const body = z
      .object({
        name: z.string().max(200),
        person: z.string().max(200).optional(),
        days: z.number().optional(),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Name the key for the app and device it’s for.' }, 400);
    // On this computer a key may be for anyone here (the owner by default); signed in, only for oneself.
    let personId: string | undefined;
    if (w.kind === 'person') {
      if (body.data.person && people.find(body.data.person)?.id !== w.person.id)
        return c.json({ error: 'You can make keys for yourself only.' }, 403);
      personId = w.person.id;
    } else {
      const found = body.data.person
        ? people.find(body.data.person)
        : people.list().find((p) => p.role === 'owner');
      if (!found)
        return c.json(
          {
            error: body.data.person
              ? `There’s no one called ${body.data.person} here.`
              : 'Make the owner account first: a key acts as someone, and nobody is here yet.',
            ...(body.data.person ? {} : { fix: 'hildegard host owner' }),
          },
          body.data.person ? 404 : 409,
        );
      personId = found.id;
    }
    try {
      const { grant, key } = grants.newKey(personId, body.data.name, body.data.days ?? null);
      return c.json({ grant, key, mcpUrl: mcpUrl() } satisfies NewKey, 201);
    } catch (e) {
      return grantFail(c, e);
    }
  });
  app.delete('/api/auth/grants/:id', (c) => {
    const w = whoOf(c);
    if (!w) return c.json({ error: 'Sign in to Hildegard first.', code: 'signin' }, 401);
    const g = grants.get(c.req.param('id'));
    if (!g || (!isOwner(c) && g.person.id !== personOf(c)?.id))
      return c.json({ error: 'That key or chatbot is gone already.' }, 404);
    try {
      grants.revoke(g.id);
      return c.json({ grants: grants.list(isOwner(c) ? null : (personOf(c)?.id ?? null)), mcpUrl: mcpUrl() });
    } catch (e) {
      return grantFail(c, e);
    }
  });

  // ── Reports: bugs and ideas for Hildegard's makers, drafted by agents and filed only once the person said yes ──
  const reports = deps.reports ?? new Reports({ dir: join(deps.config.dataDir, 'reports') });
  const ReportBody = z.object({
    kind: z.enum(['bug', 'idea', 'skill']),
    title: z.string().trim().min(4).max(120),
    skill: z.string().max(60).optional(),
    model: z.string().max(80).optional(),
    change: z.string().max(8000).optional(),
    what: z.string().trim().min(1).max(6000),
    now: z.string().max(4000).optional(),
    more: z.string().max(4000).optional(),
    how: z
      .enum([
        'The desktop app',
        'The one-line installer',
        'Hildegard at a link',
        'An AI app over MCP',
        'Built from source',
      ])
      .optional(),
    logs: z.boolean().optional(),
    agent: z.string().max(60).optional(),
  });
  app.post('/api/report/draft', async (c) => {
    const body = ReportBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success)
      return c.json(
        {
          error: body.error.issues[0]?.message ?? 'Bad report.',
          field: body.error.issues[0]?.path.join('.'),
        },
        400,
      );
    const { logs, ...input } = body.data;
    if (input.kind === 'skill') {
      const names = readSkills(findSkills()).map((s) => s.name);
      if (!input.skill || !names.includes(input.skill))
        return c.json(
          {
            error: `Name the skill: one of ${names.join(', ') || 'the skills list_skills gives'}.`,
            field: 'skill',
          },
          400,
        );
    }
    const owner = isOwner(c);
    const snap = snapshot();
    const facts = baseFacts(VERSION, SOURCE.commit);
    // A director sees only what Hildegard shows them anyway: the version. This computer's insides are the owner's,
    // and a skill suggestion needs only the version it was read in.
    const diag: Diagnostics =
      input.kind === 'skill'
        ? { facts: { Hildegard: facts.Hildegard } }
        : owner
          ? {
              os: osLabel(),
              facts: {
                ...facts,
                ...(deps.gpu ? { GPU: deps.gpu } : {}),
                Engine: `${snap.engine.comfy}${snap.engine.online ? ', online' : ', offline'}${snap.engine.paused ? ', paused' : ''}${snap.engine.problem ? `: ${snap.engine.problem}` : ''}`,
                Models:
                  snap.models
                    .filter((m) => m.installed)
                    .map((m) => m.id)
                    .join(', ') || 'none installed',
                Devices: `${snap.choir.devices.length} paired${snap.choir.use !== 'local' ? ', rendering on another' : ''}`,
                Takes: `${snap.takes.filter((t) => t.status === 'failed').length} failed of ${snap.takes.length}`,
              },
              log: logs === false ? [] : logTail(join(deps.config.dataDir, 'logs')),
            }
          : { facts: { Hildegard: facts.Hildegard! } };
    const names = [
      ...snap.choir.devices.map((d) => d.name),
      ...(owner ? people.list().map((p) => p.name) : []),
      ...(personOf(c) ? [personOf(c)!.name] : []),
    ];
    try {
      const draft = await reports.draft(input, diag, knownHere(names));
      return c.json({ draft, filer: owner ? await reports.filer() : null });
    } catch (e) {
      if (e instanceof SkillScanError) return c.json({ error: e.message, findings: e.findings }, 422);
      throw e;
    }
  });
  app.post('/api/report/file', async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      id?: unknown;
      confirm?: unknown;
      on?: unknown;
    } | null;
    if (typeof body?.id !== 'string')
      return c.json({ error: 'Send { "id": "<draft>", "confirm": true }.' }, 400);
    const draft = reports.get(body.id);
    if (!isOwner(c))
      return c.json(
        {
          error: 'Only the owner’s GitHub account files from here. Send it yourself from the form.',
          code: 'owner',
          url: draft?.url,
        },
        403,
      );
    if (body.confirm !== true)
      return c.json(
        { error: 'Show the person the draft and ask first; then send confirm: true.', url: draft?.url },
        400,
      );
    const on = body.on === undefined ? undefined : Number(body.on);
    if (on !== undefined && !(Number.isInteger(on) && on > 0))
      return c.json({ error: 'on is an issue number.' }, 400);
    try {
      return c.json({ draft: await reports.file(body.id, on) });
    } catch (e) {
      if (e instanceof ReportError) return c.json({ error: e.message, url: e.url ?? null }, e.status as 400);
      throw e;
    }
  });

  // ── Local language models: found on this computer, or the owner's own; one can direct ───────────────────────
  const llmFail = (c: Context, e: unknown) => {
    if (e instanceof LlmError) return c.json({ error: e.message }, e.status);
    throw e;
  };
  app.get('/api/llm', async (c) => {
    const refused = ownerOnly(c);
    if (refused) return refused;
    return c.json(await deps.llm.state(c.req.query('fresh') !== undefined));
  });
  app.post('/api/llm/use', async (c) => {
    const refused = ownerOnly(c);
    if (refused) return refused;
    const body = z
      .object({ endpoint: z.string().max(80), model: z.string().max(300).optional() })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Say which endpoint, and optionally which model.' }, 400);
    try {
      await deps.llm.use(body.data.endpoint, body.data.model);
      return c.json(await deps.llm.state());
    } catch (e) {
      return llmFail(c, e);
    }
  });
  // Adding an address makes this computer call it: only from this computer.
  app.post('/api/llm/endpoints', async (c) => {
    if (!local(c)) return c.json({ error: 'Add model endpoints on the computer Hildegard runs on.' }, 403);
    const body = z
      .object({ name: z.string().max(200), url: z.string().max(2000), key: z.string().max(4096).optional() })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Give a name and an address.' }, 400);
    try {
      return c.json(await deps.llm.add(body.data.name, body.data.url, body.data.key || undefined), 201);
    } catch (e) {
      return llmFail(c, e);
    }
  });
  app.delete('/api/llm/endpoints/:id', async (c) => {
    if (!local(c)) return c.json({ error: 'Remove model endpoints on the computer Hildegard runs on.' }, 403);
    try {
      deps.llm.remove(c.req.param('id'));
      return c.json(await deps.llm.state());
    } catch (e) {
      return llmFail(c, e);
    }
  });
  app.post('/api/llm/direct', async (c) => {
    const refused = ownerOnly(c);
    if (refused) return refused;
    const body = z
      .object({
        idea: z.string().trim().min(1).max(4000),
        film: z.string().max(120).optional(),
        endpoint: z.string().max(80).optional(),
        model: z.string().max(300).optional(),
        mode: z.enum(['auto', 'tools', 'plan']).optional(),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Give the idea to direct.' }, 400);
    const as = whoOf(c)!;
    const client = new HildegardClient(deps.url ?? 'http://127.0.0.1', ((
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const u = new URL(String(input instanceof Request ? input.url : input));
      return app.fetch(new Request(`http://127.0.0.1${u.pathname}${u.search}`, init), { as });
    }) as typeof fetch);
    try {
      return c.json(await directWithLocal({ llm: deps.llm, client, ...body.data }));
    } catch (e) {
      return llmFail(c, e);
    }
  });

  // ── MCP over HTTP, and the OAuth that lets chatbots sign in to it ───────────────────────────────────────────
  oauthRoutes(app, { grants, people, limited, failed, perName, fetchMetadata: deps.fetchMetadata });
  remoteMcpRoutes(app, { grants, signer: deps.signer, fetch: (r, env) => app.fetch(r, env) });
  llmProxyRoutes(app, { llm: deps.llm, grants });

  // ── Host mode: the link. Turning it on or off changes this computer, so only this computer may. ───────────
  const hostFail = (c: Context, e: unknown) => {
    if (e instanceof HostError) return c.json({ error: e.message, fix: e.fix }, e.status);
    throw e;
  };
  app.get('/api/host', async (c) => {
    const refused = ownerOnly(c);
    if (refused) return refused;
    await host.tailscale();
    return c.json(host.state());
  });
  app.post('/api/host', async (c) => {
    if (!local(c))
      return c.json({ error: 'Turn the link on or off from the computer Hildegard runs on.' }, 403);
    const body = z
      .object({
        via: z.enum(['tailscale', 'funnel', 'address']).optional(),
        address: z.string().max(64).optional(),
      })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: 'Choose tailscale, funnel or address.' }, 400);
    try {
      return c.json(await host.on(body.data));
    } catch (e) {
      return hostFail(c, e);
    }
  });
  app.post('/api/host/off', async (c) => {
    if (!local(c))
      return c.json({ error: 'Turn the link on or off from the computer Hildegard runs on.' }, 403);
    return c.json(await host.off());
  });

  // ── Voice ───────────────────────────────────────────────────────────────────────────────────────────────────
  if (deps.voice) {
    const v = deps.voice;
    app.route(
      '/api/voice',
      voiceRoutes({
        studio: v.studio,
        models: v.models,
        publicKey: v.publicKey,
        ownerOnly,
        // The speaker's phone records best over the https link; over Tailscale it can still send a recording.
        linkBase: () => host.state().url ?? deps.tailnet(),
      }),
    );
    app.route('/api/consent', consentLinkRoutes(v.studio));
  }

  // ── Loops ───────────────────────────────────────────────────────────────────────────────────────────────────
  if (deps.loops)
    app.route(
      '/api/loops',
      loopRoutes({
        loops: deps.loops,
        ownerOnly,
        sendFile: (c, file, type) => sendFile(c, file, type, 'private, max-age=31536000, immutable'),
      }),
    );

  // ── Sites ───────────────────────────────────────────────────────────────────────────────────────────────────
  if (deps.sites) {
    app.route(
      '/api/sites',
      siteRoutes({
        sites: deps.sites.store,
        ownerOnly,
        secrets: deps.sites.secrets,
        importUrl: deps.sites.importUrl,
        figmaFetch: deps.sites.figmaFetch,
      }),
    );
    app.route('/preview', previewRoutes(deps.sites.store));
  }

  // ── The printer ─────────────────────────────────────────────────────────────────────────────────────────────
  if (deps.printer) {
    const printer = deps.printer;
    const view = () => {
      const p = printer.get();
      const s = (deps.slicer ?? findSlicer)(p);
      return {
        ...p,
        slicerFound: s
          ? { name: s.name, path: s.path, ready: s.kind === 'prusa' || p.profiles.length > 0 }
          : null,
      };
    };
    app.get('/api/printer', (c) => ownerOnly(c) ?? c.json(view()));
    app.put('/api/printer', async (c) => {
      const refused = ownerOnly(c);
      if (refused) return refused;
      const body = PrinterInput.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return zodFail(c, body.error);
      // Paths to programs and profiles are this computer's; only someone at it may point Hildegard at them.
      if ((body.data.slicer || body.data.profiles?.length) && !local(c))
        return c.json(
          { error: 'Choose the slicer and its profiles on the computer Hildegard runs on.' },
          403,
        );
      try {
        printer.set(body.data);
        return c.json(view());
      } catch (e) {
        if (e instanceof PrinterError) return c.json({ error: e.message }, e.status);
        throw e;
      }
    });
  }

  // ── OpenSCAD ────────────────────────────────────────────────────────────────────────────────────────────────
  if (deps.openscad) {
    const info = deps.openscad;
    app.get('/api/openscad', (c) => {
      const refused = ownerOnly(c);
      if (refused) return refused;
      const o = info();
      return c.json({
        installed: !!o.found,
        version: o.found?.version ?? null,
        manifold: o.found ? usesManifold(o.found) : false,
        // Paths are this computer's: only someone at it sees them.
        path: local(c) ? (o.found?.path ?? null) : null,
        libraryDirs: local(c) ? o.libraryDirs : [],
        libraries: o.libraries,
        sandbox: o.sandbox,
      });
    });
  }

  // ── Uploads (start frames) ─────────────────────────────────────────────────────────────────────────────────
  app.post('/api/uploads', async (c) => {
    const len = Number(c.req.header('content-length') ?? 0);
    if (len > MAX_UPLOAD) return c.json({ error: 'Images up to 20 MB' }, 413);
    const buf = new Uint8Array(await c.req.arrayBuffer());
    if (buf.length > MAX_UPLOAD) return c.json({ error: 'Images up to 20 MB' }, 413);
    const kind = sniffImage(buf);
    if (!kind) return c.json({ error: 'Use a PNG, JPEG or WebP image' }, 415);
    const name = `${createHash('sha256').update(buf).digest('hex')}.${kind}`;
    const path = join(mediaDir, 'uploads', name);
    if (!existsSync(path)) await writeFile(path, buf);
    return c.json({ name, url: `/media/uploads/${name}` }, 201);
  });

  // ── Media with byte ranges, so videos seek ─────────────────────────────────────────────────────────────────
  const TYPES: Record<string, string> = {
    '.mp4': 'video/mp4',
    '.jpg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.ogg': 'audio/ogg',
    '.flac': 'audio/flac',
    '.webm': 'audio/webm',
  };
  app.get('/media/*', (c) => {
    const rel = c.req.path.slice('/media/'.length);
    if (!/^((uploads|exports|voice|stills)\/)?[A-Za-z0-9._-]+$/.test(rel) || rel.includes('..'))
      return c.body(null, 404);
    // Voice is the owner's alone: clips, uploads and consent recordings.
    if (rel.startsWith('voice/') && !isOwner(c) && !c.get('signedMedia')) return c.body(null, 404);
    const file = resolve(mediaDir, rel);
    if (!file.startsWith(resolve(mediaDir) + sep)) return c.body(null, 404);
    // A take's video and poster, or a film's export, only for those who may see the film. Start frames are named
    // by their own SHA-256, so only someone who has the image can ask for it.
    if (!isOwner(c) && !c.get('signedMedia') && rel.startsWith('stills/')) {
      const st = store.stills.get(rel.slice('stills/'.length).replace(/\.png$/, ''));
      if (!st || !seesCharacter(whoOf(c), store.characters.get(st.characterId))) return c.body(null, 404);
    } else if (!isOwner(c) && !c.get('signedMedia') && !rel.startsWith('uploads/')) {
      const name = rel.replace(/^exports\//, '').replace(/\.[a-z0-9]+$/, '');
      const projectId = rel.startsWith('exports/')
        ? deps.exporter.get(name)?.projectId
        : store.takes.get(name)?.projectId;
      if (!projectId || !sees(c, projectId)) return c.body(null, 404);
    }
    const res = sendFile(
      c,
      file,
      TYPES[extname(file)] ?? 'application/octet-stream',
      'private, max-age=31536000, immutable',
    );
    // ?download saves an exported film under its title instead of playing it.
    const exported = rel.startsWith('exports/') ? deps.exporter.get(rel.slice(8, -4)) : undefined;
    if (exported && c.req.query('download') !== undefined && res.ok) {
      const name =
        exported.title
          .replace(/[^\p{L}\p{N} ._-]+/gu, '')
          .replace(/\s+/g, ' ')
          .trim() || 'Hildegard film';
      res.headers.set(
        'content-disposition',
        `attachment; filename="${name.replace(/[^ -~]/g, '_')}.mp4"; filename*=UTF-8''${encodeURIComponent(name)}.mp4`,
      );
    }
    return res;
  });

  // ── The Studio UI ───────────────────────────────────────────────────────────────────────────────────────────
  if (config.uiDir) {
    const ui = resolve(config.uiDir);
    const UI_TYPES: Record<string, string> = {
      ...TYPES,
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.woff2': 'font/woff2',
      '.json': 'application/json',
      '.webmanifest': 'application/manifest+json',
      '.ico': 'image/x-icon',
      '.txt': 'text/plain; charset=utf-8',
    };
    app.get('*', (c) => {
      const p = decodeURIComponent(c.req.path);
      let file = resolve(ui, `.${p}`);
      if (!file.startsWith(ui + sep) || !existsSync(file) || statSync(file).isDirectory())
        file = join(ui, 'index.html');
      const hashed = file.includes(`${sep}assets${sep}`);
      c.header(
        'content-security-policy',
        "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      );
      return sendFile(
        c,
        file,
        UI_TYPES[extname(file)] ?? 'application/octet-stream',
        hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
      );
    });
  }

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: 'Something went wrong on this computer. The log has the details.' }, 500);
  });

  return app;
}

/** Serve a file with Range support and precompressed .br/.gz siblings when the client accepts them. */
function sendFile(c: Context, file: string, type: string, cache: string): Response {
  if (!existsSync(file)) return c.body(null, 404);
  const accept = c.req.header('accept-encoding') ?? '';
  if (!type.startsWith('video/') && !type.startsWith('image/') && !type.startsWith('audio/')) {
    for (const [enc, ext] of [
      ['br', '.br'],
      ['gzip', '.gz'],
    ] as const) {
      if (accept.includes(enc) && existsSync(file + ext)) {
        const size = statSync(file + ext).size;
        return new Response(Readable.toWeb(createReadStream(file + ext)) as ReadableStream, {
          headers: {
            'content-type': type,
            'content-encoding': enc,
            'content-length': String(size),
            'cache-control': cache,
            vary: 'accept-encoding',
          },
        });
      }
    }
  }
  const size = statSync(file).size;
  const range = c.req.header('range');
  const headers: Record<string, string> = {
    'content-type': type,
    'accept-ranges': 'bytes',
    'cache-control': cache,
  };
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
    let start = m[1] ? Number(m[1]) : size - Number(m[2]);
    let end = m[1] && m[2] ? Number(m[2]) : size - 1;
    if (!m[1]) end = size - 1;
    start = Math.max(0, start);
    end = Math.min(end, size - 1);
    if (start > end)
      return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
    return new Response(Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream, {
      status: 206,
      headers: {
        ...headers,
        'content-range': `bytes ${start}-${end}/${size}`,
        'content-length': String(end - start + 1),
      },
    });
  }
  return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, {
    headers: { ...headers, 'content-length': String(size) },
  });
}

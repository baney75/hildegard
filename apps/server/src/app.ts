// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describeReview, type Review, ReviewError, type ReviewSpec } from '@hildegard/craft';
import {
  type AgentsResponse,
  type AuthState,
  type Catalog,
  type CreateShotBody,
  composeShot,
  type ModelState,
  type NewInvite,
  type PeopleResponse,
  PresetError,
  type Priority,
  type Project,
  type ServerEvent,
  ShotRequest,
  type Snapshot,
  type Take,
  takeSeeds,
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
  secureRequest,
  seesProject,
  snapshotFor,
  type Who,
} from './access.ts';
import { type Choir, ChoirError } from './choir.ts';
import type { Config } from './config.ts';
import { ExportError, type Exporter } from './export.ts';
import type { HfLink } from './hf.ts';
import { type Host, HostError } from './host.ts';
import type { ModelManager } from './models.ts';
import { DIRECTOR_QUEUE, INVITE_HOURS, Limiter, type People, PeopleError, SESSION } from './people.ts';
import type { Scheduler } from './scheduler.ts';
import type { Store } from './store.ts';

export const VERSION = '0.1.0';

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
  choir: Choir;
  /** Models as the Studio should see them: this computer's, or those on the device renders go to. */
  modelStates: () => ModelState[];
  /** /api/node/*, for devices paired with this one. */
  node?: Hono;
  /** Share this computer's GPU: a join code for another device. `url` overrides the Tailscale address. */
  invite: (url?: string) => Promise<{ code: string; url: string }>;
  /** Where other devices would reach this one on its tailnet, if Tailscale is up here. */
  tailnet: () => string | null;
  /** Who may sign in from other devices. */
  people: People;
  /** Host mode: this Hildegard at a link. */
  host: Host;
  /** Sign-in attempts allowed per account and per address, in 15 minutes; tests lower them. */
  limits?: { perName: number; perClient: number };
  /** Technical checks on a finished file (tools/review_media.py); absent where that can't run. */
  review?: (spec: ReviewSpec) => Promise<Review>;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const MAX_UPLOAD = 20 * 1024 * 1024;

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
    const hostName = (c.req.header('host') ?? '').toLowerCase().replace(/:\d+$/, '');
    if (!allowed(hostName)) return c.text('Unknown host', 421);
    const method = c.req.method;
    // Paired devices authenticate with a bearer key, which a browser never sends on its own.
    const paired = c.req.path.startsWith('/api/node/');
    // Behind the link there is the Studio and nothing else: never the paired-device API.
    if (paired && c.env?.hosted) return c.body(null, 404);
    if (!paired && method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      // Browsers cannot add this header cross-site without a CORS preflight, which this server never grants.
      if (c.req.header('x-hildegard') !== '1') return c.json({ error: 'Missing x-hildegard header' }, 403);
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
    c.header('x-frame-options', 'DENY');
    c.header('cross-origin-opener-policy', 'same-origin');
    c.header('cross-origin-resource-policy', 'same-origin');
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
    let who: Who | null = null;
    let rotated: string | null = null;
    if (fromThisComputer(c)) who = { kind: 'local' };
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
    for (const t of store.takes.values())
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
  });

  app.get('/api/health', (c) => c.json({ ok: true, version: VERSION }));
  if (deps.node) app.route('/api/node', deps.node);

  // ── This computer: stopping, and linking AI apps. Only from this computer itself, never over the network. ─────
  const local = (c: Context) => whoOf(c)?.kind === 'local';
  app.post('/api/system/stop', (c) => {
    if (!local(c)) return c.json({ error: 'Only this computer can stop Hildegard.' }, 403);
    if (!deps.onStop) return c.json({ error: 'This server can’t stop itself.' }, 501);
    setTimeout(deps.onStop, 50);
    return c.json({ ok: true });
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
      ]);
      const filter = eventFilter((id) => store.projects.get(id), sent);
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
    if (request.startFrame && !existsSync(join(mediaDir, 'uploads', request.startFrame)))
      return c.json({ error: 'That start frame is gone; add it again', field: 'startFrame' }, 422);
    let composed: ReturnType<typeof composeShot>;
    try {
      composed = composeShot(catalog, request);
    } catch (e) {
      if (e instanceof PresetError) return c.json({ error: e.message, field: e.field }, 422);
      throw e;
    }
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
      .object({ url: z.string().max(200).optional() })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: 'Give an address like http://100.101.102.103:7341.' }, 400);
    try {
      c.header('cache-control', 'no-store');
      return c.json(await deps.invite(body.data.url));
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
  };
  app.get('/media/*', (c) => {
    const rel = c.req.path.slice('/media/'.length);
    if (!/^((uploads|exports)\/)?[A-Za-z0-9._-]+$/.test(rel) || rel.includes('..')) return c.body(null, 404);
    const file = resolve(mediaDir, rel);
    if (!file.startsWith(resolve(mediaDir) + sep)) return c.body(null, 404);
    // A take's video and poster, or a film's export, only for those who may see the film. Start frames are named
    // by their own SHA-256, so only someone who has the image can ask for it.
    if (!isOwner(c) && !rel.startsWith('uploads/')) {
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
  if (!type.startsWith('video/') && !type.startsWith('image/')) {
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

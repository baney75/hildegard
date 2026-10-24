// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Who a request comes from. This computer itself (a loopback connection, straight to Hildegard, not through any
 * proxy) is trusted as it always was. Everything else signs in: the owner, who may do everything this computer may
 * except change the computer itself, or a director, who makes films of their own and nothing else.
 */
import type { IncomingMessage } from 'node:http';
import type {
  ChoirState,
  EngineState,
  ExportState,
  GuestTake,
  HfState,
  Project,
  Role,
  ServerEvent,
  Shot,
  Snapshot,
  Take,
} from '@hildegard/presets';
import type { Context } from 'hono';

export type Who =
  | { kind: 'local' }
  | { kind: 'person'; person: { id: string; name: string; role: Role }; session: string };

export interface HgEnv {
  Bindings: {
    incoming?: IncomingMessage;
    /** The listener Tailscale Serve and Funnel forward to: nothing that arrives there is this computer. */
    hosted?: boolean;
    /**
     * A request the server makes to itself for an MCP call over HTTP, as the person whose token it carried. Only
     * code in this process can set it: nothing from the network reaches the bindings.
     */
    as?: Who;
  };
  Variables: { who: Who | null; signedMedia?: boolean };
}
export type Ctx = Context<HgEnv>;

const LOOPBACK_ADDR = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/;
/** Headers a proxy adds. A request carrying one came from somewhere else, whatever socket it arrived on. */
const FORWARDED = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'tailscale-user-login'];

/** Whether the request comes from this computer itself: a loopback socket, no proxy, not the hosted listener. */
export function fromThisComputer(c: Ctx): boolean {
  if (c.env?.hosted) return false;
  const addr = c.env?.incoming?.socket?.remoteAddress;
  if (!addr || !LOOPBACK_ADDR.test(addr)) return false;
  return !FORWARDED.some((h) => c.req.header(h) !== undefined);
}

/** Who to count sign-in attempts against: the address Tailscale says the request came from, or the socket's. */
export function clientKey(c: Ctx): string {
  if (c.env?.hosted) {
    const fwd = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    if (fwd) return fwd;
  }
  return c.env?.incoming?.socket?.remoteAddress ?? 'unknown';
}

/** Session cookies: `__Host-` on HTTPS, so no subdomain or plain-HTTP page can set or read them. */
export const COOKIE = { secure: '__Host-hildegard', plain: 'hildegard_session' };
export const secureRequest = (c: Ctx) => !!c.env?.hosted && c.req.header('x-forwarded-proto') === 'https';

/** The address this request reached Hildegard at, as its sender sees it: the link's https name, or this computer. */
export const originOf = (c: Ctx) =>
  `${secureRequest(c) ? 'https' : 'http'}://${c.req.header('host') ?? '127.0.0.1'}`;

/**
 * Paths that check who is asking themselves, with no cookie: the MCP endpoint and the local models' OpenAI-compatible
 * API (bearer tokens), and OAuth (the sign-in page, and calls an AI app makes on its own).
 */
export const ownAuth = (path: string) =>
  path === '/mcp' ||
  path.startsWith('/v1/') ||
  path.startsWith('/oauth/') ||
  path.startsWith('/.well-known/oauth-');

/**
 * What a director may ask for, by method and path: their films, shots, takes and exports, start frames, and their
 * own account. Models, devices, settings, people and the computer are the owner's.
 */
const DIRECTOR: Record<string, RegExp[]> = {
  GET: [
    /^\/api\/(health|catalog|snapshot|events)$/,
    /^\/api\/auth\//,
    /^\/api\/shots\/[^/]+$/,
    /^\/api\/exports\/[^/]+$/,
    /^\/api\/takes\/[^/]+\/(preview|review|sheet)$/,
    /^\/media\//,
  ],
  POST: [
    /^\/api\/projects$/,
    /^\/api\/projects\/[^/]+\/export$/,
    /^\/api\/shots$/,
    /^\/api\/takes\/[^/]+\/(cancel|force|retry|keep)$/,
    /^\/api\/uploads$/,
    /^\/api\/auth\//,
  ],
  PATCH: [/^\/api\/projects\/[^/]+$/, /^\/api\/shots\/[^/]+$/],
  DELETE: [/^\/api\/shots\/[^/]+$/, /^\/api\/takes\/[^/]+$/, /^\/api\/auth\/grants\/[^/]+$/],
};
export function directorMay(method: string, path: string): boolean {
  if (method === 'GET' || method === 'HEAD') {
    if (!path.startsWith('/api/') && !path.startsWith('/media/')) return true;
    return DIRECTOR.GET!.some((r) => r.test(path));
  }
  return (DIRECTOR[method] ?? []).some((r) => r.test(path));
}

/** Paths anyone may reach before signing in: the Studio's own files, health, and signing in. */
export function open(method: string, path: string): boolean {
  if (path === '/api/health') return true;
  if (ownAuth(path)) return true;
  if (path.startsWith('/api/auth/')) return true;
  if ((method === 'GET' || method === 'HEAD') && !path.startsWith('/api/') && !path.startsWith('/media/'))
    return true;
  return false;
}

// ── What each person sees ───────────────────────────────────────────────────────────────────────────────────────

/** A film a person may see: the owner and this computer see all of them; a director sees their own. */
export function seesProject(who: Who | null, p: Project | undefined): boolean {
  if (!who || !p) return false;
  if (who.kind === 'local' || who.person.role === 'owner') return true;
  return p.owner === who.person.id;
}

/** ComfyUI's address is this computer's business; the engine's state is everyone's. */
const engineFor = (who: Who | null, e: EngineState): EngineState =>
  who?.kind === 'local' ? e : { ...e, url: '' };

/** A director sees that renders go elsewhere, not where or how to reach them. */
function choirFor(who: Who | null, s: ChoirState): ChoirState {
  if (who?.kind === 'local' || (who?.kind === 'person' && who.person.role === 'owner')) return s;
  return {
    use: s.use,
    devices: s.devices.filter((d) => d.name === s.use).map((d) => ({ ...d, url: '' })),
    sharing: { on: false, url: null, paired: 0, problem: null },
  };
}
const hfFor = (who: Who | null, s: HfState): HfState =>
  who?.kind === 'person' && who.person.role === 'director' ? { ...s, user: null } : s;

/** Everyone sees that the GPU is busy with another device's render; only the owner sees which device sent it. */
const guestsFor = (who: Who | null, g: GuestTake[]): GuestTake[] =>
  who?.kind === 'local' || (who?.kind === 'person' && who.person.role === 'owner')
    ? g
    : g.map((x) => ({ ...x, from: null }));

export function snapshotFor(who: Who | null, s: Snapshot): Snapshot {
  const films = new Set(s.projects.filter((p) => seesProject(who, p)).map((p) => p.id));
  return {
    ...s,
    projects: s.projects.filter((p) => films.has(p.id)),
    shots: s.shots.filter((x) => films.has(x.projectId)),
    takes: s.takes.filter((t) => films.has(t.projectId)),
    exports: s.exports.filter((x) => films.has(x.projectId)),
    engine: engineFor(who, s.engine),
    hf: hfFor(who, s.hf),
    choir: choirFor(who, s.choir),
    guests: guestsFor(who, s.guests),
  };
}

/**
 * Filter one event stream for one person. `projects` looks a film up as it is now; `sent` holds the ids this stream
 * has shown, from its first snapshot on, so a removal reaches only those who saw the thing removed.
 */
export function eventFilter(projects: (id: string) => Project | undefined, sent: Set<string>) {
  return (who: Who | null, e: ServerEvent): ServerEvent | null => {
    const see = (projectId: string, id: string) => {
      if (!seesProject(who, projects(projectId))) return false;
      sent.add(id);
      return true;
    };
    switch (e.type) {
      case 'take':
        return see((e.take as Take).projectId, e.take.id) ? e : null;
      case 'shot':
        return see((e.shot as Shot).projectId, e.shot.id) ? e : null;
      case 'project':
        return see(e.project.id, e.project.id) ? e : null;
      case 'export':
        return see((e.export as ExportState).projectId, e.export.id) ? e : null;
      case 'removed':
        return who?.kind === 'local' ||
          (who?.kind === 'person' && who.person.role === 'owner') ||
          sent.has(e.id)
          ? e
          : null;
      case 'engine':
        return { ...e, engine: engineFor(who, e.engine) };
      case 'hf':
        return { ...e, hf: hfFor(who, e.hf) };
      case 'choir':
        return { ...e, choir: choirFor(who, e.choir) };
      case 'guests':
        return { ...e, guests: guestsFor(who, e.guests) };
      case 'host':
        return who?.kind === 'local' || (who?.kind === 'person' && who.person.role === 'owner') ? e : null;
      default:
        return e;
    }
  };
}

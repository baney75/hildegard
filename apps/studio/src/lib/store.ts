// SPDX-License-Identifier: AGPL-3.0-only
import type {
  AuthState,
  Catalog,
  Character,
  ChoirState,
  EngineState,
  ExportState,
  GuestTake,
  HfState,
  HostState,
  ModelState,
  Project,
  ServerEvent,
  Shot,
  Snapshot,
  Still,
  Take,
  UpdateState,
} from '@hildegard/presets';
import { useSyncExternalStore } from 'react';
import { api, SIGNED_OUT } from './api.ts';

export interface State {
  /** First snapshot and catalog have arrived. */
  ready: boolean;
  /** Live: events are flowing. Down: the server stopped answering (we keep retrying). */
  conn: 'connecting' | 'live' | 'down';
  loadError: string | null;
  version: string;
  source: Snapshot['source'] | null;
  catalog: Catalog | null;
  projects: Map<string, Project>;
  shots: Map<string, Shot>;
  takes: Map<string, Take>;
  /** Reusable people, and the stills drawn of them. */
  characters: Map<string, Character>;
  stills: Map<string, Still>;
  engine: EngineState | null;
  models: ModelState[];
  hf: HfState | null;
  /** The newest export of each film, by film id. */
  exports: Map<string, ExportState>;
  choir: ChoirState | null;
  /** Renders paired devices sent to this computer, rendering or waiting, in queue order. */
  guests: GuestTake[];
  /** Who this browser is: this computer, someone signed in, or nobody yet (then the Studio asks them to sign in). */
  auth: AuthState | null;
  /** Host mode, for the owner: from the first look at Settings › Sharing, then kept live. */
  host: HostState | null;
  /** Newer releases, and whether Hildegard updates itself. */
  update: UpdateState | null;
}

let state: State = {
  ready: false,
  conn: 'connecting',
  loadError: null,
  version: '',
  source: null,
  catalog: null,
  projects: new Map(),
  shots: new Map(),
  takes: new Map(),
  characters: new Map(),
  stills: new Map(),
  engine: null,
  models: [],
  hf: null,
  exports: new Map(),
  choir: null,
  guests: [],
  auth: null,
  host: null,
  update: null,
};
const listeners = new Set<() => void>();

function set(next: Partial<State>) {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

export const getState = () => state;

export function useStore<T>(select: (s: State) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => select(state),
  );
}

function fromSnapshot(s: Snapshot): Partial<State> {
  return {
    version: s.version,
    source: s.source,
    projects: new Map(s.projects.map((p) => [p.id, p])),
    shots: new Map(s.shots.map((x) => [x.id, x])),
    takes: new Map(s.takes.map((t) => [t.id, t])),
    characters: new Map((s.characters ?? []).map((c) => [c.id, c])),
    stills: new Map((s.stills ?? []).map((x) => [x.id, x])),
    engine: s.engine,
    models: s.models,
    hf: s.hf,
    exports: new Map((s.exports ?? []).map((x) => [x.projectId, x])),
    choir: s.choir ?? null,
    guests: s.guests ?? [],
    update: s.update ?? null,
  };
}

/** Apply a batch of server events in one update, so a burst of progress costs one render. */
export function apply(events: ServerEvent[]) {
  let { projects, shots, takes, characters, stills } = state;
  const next: Partial<State> = {};
  for (const e of events) {
    switch (e.type) {
      case 'take':
        if (takes === state.takes) takes = new Map(takes);
        takes.set(e.take.id, e.take);
        break;
      case 'shot':
        if (shots === state.shots) shots = new Map(shots);
        shots.set(e.shot.id, e.shot);
        break;
      case 'character':
        if (characters === state.characters) characters = new Map(characters);
        characters.set(e.character.id, e.character);
        break;
      case 'still':
        if (stills === state.stills) stills = new Map(stills);
        stills.set(e.still.id, e.still);
        break;
      case 'project':
        if (projects === state.projects) projects = new Map(projects);
        projects.set(e.project.id, e.project);
        break;
      case 'removed': {
        if (e.kind === 'take') {
          if (takes === state.takes) takes = new Map(takes);
          takes.delete(e.id);
        } else if (e.kind === 'character') {
          if (characters === state.characters) characters = new Map(characters);
          characters.delete(e.id);
        } else if (e.kind === 'still') {
          if (stills === state.stills) stills = new Map(stills);
          stills.delete(e.id);
        } else if (e.kind === 'shot') {
          if (shots === state.shots) shots = new Map(shots);
          shots.delete(e.id);
        } else {
          if (projects === state.projects) projects = new Map(projects);
          projects.delete(e.id);
        }
        break;
      }
      case 'engine':
        next.engine = e.engine;
        break;
      case 'models':
        next.models = e.models;
        break;
      case 'hf':
        next.hf = e.hf;
        break;
      case 'choir':
        next.choir = e.choir;
        break;
      case 'guests':
        next.guests = e.guests;
        break;
      case 'export':
        next.exports = new Map(next.exports ?? state.exports).set(e.export.projectId, e.export);
        break;
      case 'host':
        next.host = e.host;
        break;
      case 'update':
        next.update = e.update;
        break;
    }
  }
  set({ ...next, projects, shots, takes, characters, stills });
}

/** Optimistic local update for something the server just returned. */
export function upsert(e: ServerEvent | ServerEvent[]) {
  apply(Array.isArray(e) ? e : [e]);
}

let source: EventSource | null = null;

/** Signed in from another device, or on this computer: either way the Studio may load. */
export const allowedIn = (a: AuthState | null) => !!a && (a.local || !!a.person);
/** The owner, here or signed in from elsewhere: models, devices, people and settings are theirs. */
export const isOwner = (a: AuthState | null) => !!a && (a.local || a.person?.role === 'owner');

/** Back to the sign-in page, forgetting everything this browser was shown. */
function signedOut() {
  source?.close();
  source = null;
  const auth = getState().auth;
  set({
    ready: false,
    conn: 'connecting',
    auth: auth ? { ...auth, person: null } : null,
    projects: new Map(),
    shots: new Map(),
    takes: new Map(),
    characters: new Map(),
    stills: new Map(),
    exports: new Map(),
    guests: [],
    host: null,
  });
}
if (typeof window !== 'undefined')
  window.addEventListener(SIGNED_OUT, () => {
    if (!getState().auth?.local) signedOut();
  });

export function setHost(host: HostState) {
  set({ host });
}

export async function signOut() {
  await api.signOut().catch(() => {});
  signedOut();
}

export async function connect() {
  // Who this is comes first: someone who hasn't signed in sees the sign-in page, and nothing else is asked for.
  try {
    const auth = await api.me();
    set({ auth, loadError: null });
    if (!allowedIn(auth)) {
      signedOut();
      return;
    }
  } catch (e) {
    set({ loadError: (e as Error).message, conn: 'down' });
    setTimeout(connect, 2000);
    return;
  }
  if (!getState().catalog) {
    try {
      set({ catalog: await api.catalog(), loadError: null });
    } catch (e) {
      set({ loadError: (e as Error).message, conn: 'down' });
      setTimeout(connect, 2000);
      return;
    }
  }
  source?.close();
  source = new EventSource('/api/events');
  // Every hello, first or after a reconnect, carries a snapshot taken as the stream began, so nothing is missed.
  source.addEventListener('hello', (ev) => {
    const { snapshot } = JSON.parse((ev as MessageEvent<string>).data) as { snapshot: Snapshot };
    set({ ...fromSnapshot(snapshot), ready: true, loadError: null, conn: 'live' });
  });
  source.addEventListener('batch', (ev) =>
    apply(JSON.parse((ev as MessageEvent<string>).data) as ServerEvent[]),
  );
  source.addEventListener('error', () => {
    set({ conn: 'down' });
    // A stream the server ended for good (signed out elsewhere, or removed) doesn't come back on its own.
    if (source?.readyState === EventSource.CLOSED)
      setTimeout(() => {
        if (source?.readyState === EventSource.CLOSED) void connect();
      }, 2000);
  });
}

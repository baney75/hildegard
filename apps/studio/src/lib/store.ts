import type {
  Catalog,
  EngineState,
  HfState,
  ModelState,
  Project,
  ServerEvent,
  Shot,
  Snapshot,
  Take,
} from '@hildegard/presets';
import { useSyncExternalStore } from 'react';
import { api } from './api.ts';

export interface State {
  /** First snapshot and catalog have arrived. */
  ready: boolean;
  /** Live: events are flowing. Down: the server stopped answering (we keep retrying). */
  conn: 'connecting' | 'live' | 'down';
  loadError: string | null;
  version: string;
  catalog: Catalog | null;
  projects: Map<string, Project>;
  shots: Map<string, Shot>;
  takes: Map<string, Take>;
  engine: EngineState | null;
  models: ModelState[];
  hf: HfState | null;
}

let state: State = {
  ready: false,
  conn: 'connecting',
  loadError: null,
  version: '',
  catalog: null,
  projects: new Map(),
  shots: new Map(),
  takes: new Map(),
  engine: null,
  models: [],
  hf: null,
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
    projects: new Map(s.projects.map((p) => [p.id, p])),
    shots: new Map(s.shots.map((x) => [x.id, x])),
    takes: new Map(s.takes.map((t) => [t.id, t])),
    engine: s.engine,
    models: s.models,
    hf: s.hf,
  };
}

/** Apply a batch of server events in one update, so a burst of progress costs one render. */
export function apply(events: ServerEvent[]) {
  let { projects, shots, takes } = state;
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
      case 'project':
        if (projects === state.projects) projects = new Map(projects);
        projects.set(e.project.id, e.project);
        break;
      case 'removed': {
        if (e.kind === 'take') {
          if (takes === state.takes) takes = new Map(takes);
          takes.delete(e.id);
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
    }
  }
  set({ ...next, projects, shots, takes });
}

/** Optimistic local update for something the server just returned. */
export function upsert(e: ServerEvent | ServerEvent[]) {
  apply(Array.isArray(e) ? e : [e]);
}

let source: EventSource | null = null;

export async function connect() {
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
  source.addEventListener('error', () => set({ conn: 'down' }));
}

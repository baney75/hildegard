import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Project, ServerEvent, Shot, Take } from '@hildegard/presets';

interface StateFile {
  version: 1;
  projects: Project[];
  shots: Shot[];
  takes: Take[];
}

type Listener = (e: ServerEvent) => void;

/**
 * Projects, shots and takes, kept in memory and saved to one JSON file. Writes are atomic (temp file + rename) and
 * coalesced, so a burst of progress updates costs one write.
 */
export class Store {
  readonly projects = new Map<string, Project>();
  readonly shots = new Map<string, Shot>();
  readonly takes = new Map<string, Take>();
  private readonly file: string;
  private readonly listeners = new Set<Listener>();
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'state.json');
    this.load();
  }

  private load() {
    let data: StateFile;
    try {
      data = JSON.parse(readFileSync(this.file, 'utf8')) as StateFile;
    } catch {
      return;
    }
    for (const p of data.projects ?? []) this.projects.set(p.id, p);
    for (const s of data.shots ?? []) this.shots.set(s.id, s);
    for (const t of data.takes ?? []) {
      // A take that was rendering when Hildegard stopped goes back in the queue.
      if (t.status === 'running') {
        t.status = 'queued';
        t.progress = null;
        t.startedAt = null;
      }
      this.takes.set(t.id, t);
    }
  }

  on(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  emit(e: ServerEvent) {
    for (const l of this.listeners) l(e);
  }

  /** Save soon. `progressOnly` changes are frequent and cheap to lose, so they wait longer. */
  save(progressOnly = false) {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), progressOnly ? 2000 : 150);
  }

  flush() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const data: StateFile = {
      version: 1,
      projects: [...this.projects.values()],
      shots: [...this.shots.values()],
      takes: [...this.takes.values()],
    };
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, this.file);
  }

  putProject(p: Project) {
    p.updatedAt = new Date().toISOString();
    this.projects.set(p.id, p);
    this.emit({ type: 'project', project: p });
    this.save();
  }

  putShot(s: Shot) {
    this.shots.set(s.id, s);
    this.emit({ type: 'shot', shot: s });
    this.save();
  }

  putTake(t: Take, progressOnly = false) {
    this.takes.set(t.id, t);
    this.emit({ type: 'take', take: t });
    this.save(progressOnly);
  }

  remove(kind: 'take' | 'shot' | 'project', id: string) {
    const map = kind === 'take' ? this.takes : kind === 'shot' ? this.shots : this.projects;
    if (!map.delete(id)) return;
    this.emit({ type: 'removed', kind, id });
    this.save();
  }
}

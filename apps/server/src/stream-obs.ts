// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Go live, with OBS Studio instead. If OBS is running with its WebSocket server on (Tools, WebSocket Server Settings;
 * port 4455 unless changed), Hildegard can list its scenes, switch them, start and stop its stream, and set its stream
 * service to one of the destinations saved here. OBS is detected, never required. Its password, if it has one, is kept
 * like a stream key: in the keychain, never returned. Speaks obs-websocket 5 (OBS 28 and later).
 */
import { createHash, randomUUID } from 'node:crypto';
import net from 'node:net';
import type { ObsState } from '@hildegard/presets';
import type { SecretStore } from './hf.ts';

interface Socket {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onclose: ((e: { code?: number }) => void) | null;
}
type WebSocketCtor = new (url: string) => Socket;

const sha = (s: string) => createHash('sha256').update(s).digest('base64');

export class ObsError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface ObsDeps {
  secret: SecretStore;
  host?: string;
  port?: number;
  /** Tests give a socket class that talks to a stand-in OBS. */
  WebSocket?: WebSocketCtor;
  timeoutMs?: number;
}

/** One connection to OBS: identify, send some requests, close. */
class Session {
  private ws: Socket;
  private pending = new Map<string, { ok: (d: unknown) => void; fail: (e: Error) => void }>();
  private ready: Promise<void>;
  private end: (e: Error) => void = () => {};
  private password: string | null;
  private timeoutMs: number;

  constructor(Ctor: WebSocketCtor, url: string, password: string | null, timeoutMs: number) {
    this.password = password;
    this.timeoutMs = timeoutMs;
    this.ws = new Ctor(url);
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new ObsError(504, 'obs', 'OBS didn’t answer.')), this.timeoutMs);
      this.end = (e) => {
        clearTimeout(timer);
        reject(e);
        for (const p of this.pending.values()) p.fail(e);
        this.pending.clear();
      };
      this.ws.onerror = () => this.end(new ObsError(502, 'obs', 'Couldn’t reach OBS.'));
      this.ws.onclose = (e) =>
        this.end(
          e.code === 4009
            ? new ObsError(401, 'obs-password', 'OBS didn’t accept that password.')
            : new ObsError(502, 'obs', 'OBS closed the connection.'),
        );
      this.ws.onmessage = (e) => {
        let m: { op: number; d: Record<string, unknown> };
        try {
          m = JSON.parse(String(e.data)) as typeof m;
        } catch {
          return;
        }
        if (m.op === 0) {
          const auth = m.d.authentication as { challenge: string; salt: string } | undefined;
          const d: Record<string, unknown> = { rpcVersion: 1 };
          if (auth) {
            if (!this.password) return this.end(new ObsError(401, 'obs-password', 'OBS wants a password.'));
            d.authentication = sha(sha(this.password + auth.salt) + auth.challenge);
          }
          this.ws.send(JSON.stringify({ op: 1, d }));
        } else if (m.op === 2) {
          clearTimeout(timer);
          resolve();
        } else if (m.op === 7) {
          const id = String(m.d.requestId);
          const p = this.pending.get(id);
          if (!p) return;
          this.pending.delete(id);
          const st = m.d.requestStatus as { result: boolean; comment?: string };
          if (st.result) p.ok(m.d.responseData ?? {});
          else p.fail(new ObsError(502, 'obs', st.comment ? `OBS said: ${st.comment}` : 'OBS refused that.'));
        }
      };
    });
    // Rejections nobody awaits yet (a request not made) must not crash the server.
    this.ready.catch(() => {});
  }

  async request<T = Record<string, unknown>>(type: string, data?: Record<string, unknown>): Promise<T> {
    await this.ready;
    const id = randomUUID();
    return new Promise<T>((ok, fail) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        fail(new ObsError(504, 'obs', 'OBS didn’t answer.'));
      }, this.timeoutMs);
      this.pending.set(id, {
        ok: (d) => {
          clearTimeout(timer);
          ok(d as T);
        },
        fail: (e) => {
          clearTimeout(timer);
          fail(e);
        },
      });
      this.ws.send(JSON.stringify({ op: 6, d: { requestType: type, requestId: id, requestData: data } }));
    });
  }

  close() {
    this.ws.onclose = null;
    this.ws.onerror = null;
    try {
      this.ws.close();
    } catch {}
  }
}

export class Obs {
  readonly deps: ObsDeps;
  constructor(deps: ObsDeps) {
    this.deps = deps;
  }
  private get host() {
    return this.deps.host ?? '127.0.0.1';
  }
  private get port() {
    return this.deps.port ?? 4455;
  }

  hasPassword = () => !!this.deps.secret.get();
  setPassword(p: string) {
    if (p.length < 1 || p.length > 200)
      throw new ObsError(400, 'obs-password', 'Give the password you set in OBS.');
    this.deps.secret.set(p);
  }
  clearPassword() {
    this.deps.secret.delete();
  }

  /** Whether anything listens where OBS does. */
  private listening(): Promise<boolean> {
    return new Promise((resolve) => {
      const s = net.connect({ host: this.host, port: this.port });
      const done = (v: boolean) => {
        s.destroy();
        resolve(v);
      };
      s.setTimeout(500, () => done(false));
      s.once('connect', () => done(true));
      s.once('error', () => done(false));
    });
  }

  private async session<T>(fn: (s: Session) => Promise<T>): Promise<T> {
    const Ctor = this.deps.WebSocket ?? (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
    if (!Ctor) throw new ObsError(501, 'obs', 'This version of Node can’t talk to OBS. Update Hildegard.');
    const s = new Session(
      Ctor,
      `ws://${this.host}:${this.port}`,
      this.deps.secret.get(),
      this.deps.timeoutMs ?? 4000,
    );
    try {
      return await fn(s);
    } finally {
      s.close();
    }
  }

  /** What OBS is doing, or that it isn't there. */
  async status(): Promise<ObsState> {
    const base: ObsState = {
      found: false,
      needsPassword: false,
      connected: false,
      scenes: [],
      currentScene: null,
      streaming: false,
      version: null,
      detail: null,
    };
    if (!this.deps.WebSocket && !(await this.listening())) return base;
    try {
      return await this.session(async (s) => {
        const v = await s.request<{ obsVersion?: string }>('GetVersion');
        const sc = await s.request<{ scenes?: { sceneName: string }[]; currentProgramSceneName?: string }>(
          'GetSceneList',
        );
        const st = await s.request<{ outputActive?: boolean }>('GetStreamStatus');
        return {
          found: true,
          needsPassword: false,
          connected: true,
          scenes: [...(sc.scenes ?? [])].reverse().map((x) => x.sceneName),
          currentScene: sc.currentProgramSceneName ?? null,
          streaming: !!st.outputActive,
          version: v.obsVersion ?? null,
          detail: null,
        };
      });
    } catch (e) {
      if (e instanceof ObsError && e.code === 'obs-password')
        return {
          ...base,
          found: true,
          needsPassword: true,
          detail: this.hasPassword()
            ? 'OBS didn’t accept the saved password.'
            : 'OBS has a password on. Add it here.',
        };
      return { ...base, found: !this.deps.WebSocket, detail: (e as Error).message };
    }
  }

  setScene(name: string) {
    return this.session((s) => s.request('SetCurrentProgramScene', { sceneName: name }));
  }
  start() {
    return this.session((s) => s.request('StartStream'));
  }
  stop() {
    return this.session((s) => s.request('StopStream'));
  }
  /** Points OBS at one destination. The key goes to OBS and nowhere else. */
  useService(server: string, key: string) {
    return this.session((s) =>
      s.request('SetStreamServiceSettings', {
        streamServiceType: 'rtmp_custom',
        streamServiceSettings: { server, key, use_auth: false },
      }),
    );
  }
}

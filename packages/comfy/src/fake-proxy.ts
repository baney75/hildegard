/**
 * A stand-in for comfy-api-proxy + ComfyUI that speaks the Comfy API v2 the SDK uses, with no GPU and no models.
 * It walks each job through queued → running (progress and preview frames) → succeeded, and serves a small sample
 * clip as the output. Tests and UI development run against it; a real render never does.
 *
 * Put `[fail:oom]` or `[fail:node]` in a prompt to make that job fail the way a real one would.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '../fixtures');

type Status = 'queued' | 'running' | 'succeeded' | 'canceling' | 'canceled' | 'failed' | 'expired';

interface FakeJob {
  id: string;
  status: Status;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  workflow: Record<string, { class_type: string; inputs: Record<string, unknown> }>;
  step: number;
  steps: number;
  outputs: unknown[];
  error: { code: string; message: string; node_id?: string; class_type?: string } | null;
  listeners: Set<(event: string, data: unknown) => void>;
  failAt?: { step: number; code: string; message: string; node?: string };
}

export interface FakeProxyOptions {
  /** Milliseconds per sampler step. */
  tickMs?: number;
  port?: number;
}

export interface FakeProxy {
  url: string;
  server: Server;
  jobs: Map<string, FakeJob>;
  close(): Promise<void>;
}

const now = () => new Date().toISOString();

export async function startFakeProxy(opts: FakeProxyOptions = {}): Promise<FakeProxy> {
  const tickMs = opts.tickMs ?? 120;
  const video = readFileSync(join(fixtures, 'sample.mp4'));
  const preview = readFileSync(join(fixtures, 'preview.jpg'));
  const jobs = new Map<string, FakeJob>();
  const assets = new Map<string, { bytes: Buffer; type: string; name: string; job?: string }>();
  let origin = '';

  const assetModel = (id: string) => {
    const a = assets.get(id)!;
    return {
      id,
      hash: null,
      size_bytes: a.bytes.length,
      content_type: a.type,
      file_path: a.name,
      created_at: now(),
      url: `${origin}/api/v2/assets/${id}/content`,
      url_expires_at: new Date(Date.now() + 3600_000).toISOString(),
      job_id: a.job ?? null,
    };
  };

  const progress = (j: FakeJob) =>
    j.status === 'running' || j.status === 'succeeded'
      ? {
          value: j.steps ? j.step / j.steps : 0,
          nodes_done: j.step,
          nodes_total: j.steps,
          current_node: null,
          current_node_class: 'SamplerCustomAdvanced',
          step: j.step,
          steps: j.steps,
          message: null,
        }
      : null;

  const queuePosition = (j: FakeJob) => {
    if (j.status !== 'queued') return null;
    let n = 0;
    for (const other of jobs.values()) {
      if (other === j) break;
      if (other.status === 'queued' || other.status === 'running') n++;
    }
    return n;
  };

  const jobModel = (j: FakeJob) => ({
    id: j.id,
    status: j.status,
    created_at: j.created_at,
    started_at: j.started_at,
    completed_at: j.completed_at,
    expires_at: new Date(Date.now() + 86400_000).toISOString(),
    queue_position: queuePosition(j),
    progress: progress(j),
    outputs: j.outputs,
    error: j.error,
    urls: {
      self: `/api/v2/jobs/${j.id}`,
      events: `/api/v2/jobs/${j.id}/events`,
      cancel: `/api/v2/jobs/${j.id}/cancel`,
    },
  });

  const emit = (j: FakeJob, event: string, data: unknown) => {
    for (const l of j.listeners) l(event, data);
  };
  const setStatus = (j: FakeJob, status: Status) => {
    j.status = status;
    if (status === 'running') j.started_at = now();
    if (['succeeded', 'failed', 'canceled'].includes(status)) j.completed_at = now();
    emit(j, 'status', { status, queue_position: queuePosition(j) });
  };

  let running: FakeJob | undefined;
  const pump = () => {
    if (running) return;
    running = [...jobs.values()].find((j) => j.status === 'queued');
    if (!running) return;
    const j = running;
    setStatus(j, 'running');
    const timer = setInterval(() => {
      if (j.status !== 'running') {
        clearInterval(timer);
        if (j.status === 'canceling') setStatus(j, 'canceled');
        running = undefined;
        pump();
        return;
      }
      j.step++;
      if (j.failAt && j.step >= j.failAt.step) {
        clearInterval(timer);
        j.error = { code: j.failAt.code, message: j.failAt.message, node_id: j.failAt.node ?? null, class_type: 'SamplerCustomAdvanced' } as FakeJob['error'];
        setStatus(j, 'failed');
        running = undefined;
        pump();
        return;
      }
      emit(j, 'progress', progress(j));
      emit(j, 'preview', { node_id: '', content_type: 'image/jpeg', data_base64: preview.toString('base64') });
      if (j.step >= j.steps) {
        clearInterval(timer);
        const saveNode = Object.entries(j.workflow).find(([, n]) => n.class_type === 'SaveVideo')?.[0] ?? '';
        const id = randomUUID();
        assets.set(id, { bytes: video, type: 'video/mp4', name: 'hildegard_00001_.mp4', job: j.id });
        const output = { ...assetModel(id), node_id: saveNode, name: 'hildegard_00001_.mp4', type: 'image' }; // as comfy-api-proxy 0.1.6 labels it
        j.outputs.push(output);
        emit(j, 'output', output);
        setStatus(j, 'succeeded');
        running = undefined;
        pump();
      }
    }, tickMs);
  };

  const send = (res: ServerResponse, status: number, body?: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };
  const error = (res: ServerResponse, status: number, code: string, message: string) =>
    send(res, status, { error: { code, message } });

  const readBody = async (req: IncomingMessage): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', origin);
    const path = url.pathname;
    try {
      if (req.method === 'POST' && path === '/api/v2/jobs') {
        const body = JSON.parse((await readBody(req)).toString('utf8'));
        const wf = body?.workflow;
        if (!wf || typeof wf !== 'object' || Object.values(wf).some((n) => typeof (n as { class_type?: unknown })?.class_type !== 'string'))
          return error(res, 422, 'invalid_workflow', 'workflow must be an API-format graph');
        const text = JSON.stringify(wf);
        const twoStage = text.includes('LTXVLatentUpsampler');
        const steps = twoStage ? 11 : 8;
        const j: FakeJob = {
          id: randomUUID(),
          status: 'queued',
          created_at: now(),
          started_at: null,
          completed_at: null,
          workflow: wf,
          step: 0,
          steps,
          outputs: [],
          error: null,
          listeners: new Set(),
        };
        if (text.includes('[fail:oom]'))
          j.failAt = { step: 2, code: 'out_of_memory', message: 'Allocation on device failed: CUDA out of memory.' };
        if (text.includes('[fail:node]'))
          j.failAt = { step: 1, code: 'execution_error', message: 'Error while running node', node: '5' };
        jobs.set(j.id, j);
        setImmediate(pump);
        return send(res, 201, jobModel(j));
      }
      const m = path.match(/^\/api\/v2\/jobs\/([\w-]+)(\/events|\/cancel|\/workflow)?$/);
      if (m) {
        const j = jobs.get(m[1]!);
        if (!j) return error(res, 404, 'not_found', 'no such job');
        if (!m[2] && req.method === 'GET') return send(res, 200, jobModel(j));
        if (m[2] === '/workflow') return send(res, 200, { workflow: j.workflow, format: 'api' });
        if (m[2] === '/cancel' && req.method === 'POST') {
          if (j.status === 'queued') setStatus(j, 'canceled');
          else if (j.status === 'running') setStatus(j, 'canceling');
          return send(res, 202, jobModel(j));
        }
        if (m[2] === '/events') {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
          const write = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          write('status', { status: j.status, queue_position: queuePosition(j) });
          if (['succeeded', 'failed', 'canceled', 'expired'].includes(j.status)) return res.end();
          const listener = (event: string, data: unknown) => {
            write(event, data);
            if (event === 'status' && ['succeeded', 'failed', 'canceled'].includes((data as { status: string }).status)) {
              j.listeners.delete(listener);
              res.end();
            }
          };
          j.listeners.add(listener);
          req.on('close', () => j.listeners.delete(listener));
          return;
        }
      }
      if (req.method === 'HEAD' && path.startsWith('/api/v2/assets/by-hash/')) {
        res.writeHead(404).end();
        return;
      }
      if (req.method === 'POST' && path === '/api/v2/assets') {
        const form = await new Request(origin, {
          method: 'POST',
          headers: req.headers as Record<string, string>,
          body: await readBody(req),
        }).formData();
        const file = form.get('file');
        if (!(file instanceof Blob)) return error(res, 422, 'invalid_request', 'file is required');
        const id = randomUUID();
        assets.set(id, {
          bytes: Buffer.from(await file.arrayBuffer()),
          type: String(form.get('content_type') ?? file.type),
          name: String(form.get('file_path') ?? 'upload'),
        });
        return send(res, 201, { ...assetModel(id), created_new: true });
      }
      const a = path.match(/^\/api\/v2\/assets\/([\w-]+)(\/content)?$/);
      if (a && req.method === 'GET') {
        const asset = assets.get(a[1]!);
        if (!asset) return error(res, 404, 'not_found', 'no such asset');
        if (!a[2]) return send(res, 200, assetModel(a[1]!));
        res.writeHead(200, { 'content-type': asset.type, 'content-length': asset.bytes.length });
        res.end(asset.bytes);
        return;
      }
      error(res, 404, 'not_found', `${req.method} ${path}`);
    } catch (e) {
      error(res, 500, 'internal', String(e));
    }
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: origin,
    server,
    jobs,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

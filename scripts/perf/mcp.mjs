// SPDX-License-Identifier: AGPL-3.0-only
// MCP bench: `hildegard mcp` on stdio against a fake-GPU server: time to answer initialize, tools/list and a few
// tool calls.
import { spawn } from 'node:child_process';
import { CLI_MAIN, isolatedEnv, median, now, round, scratch, startServer } from './lib.mjs';

class Rpc {
  constructor(proc) {
    this.proc = proc;
    this.id = 0;
    this.pending = new Map();
    let buf = '';
    proc.stdout.on('data', (d) => {
      buf += d;
      for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        this.pending.get(msg.id)?.(msg);
        this.pending.delete(msg.id);
      }
    });
  }
  call(method, params = {}) {
    const id = ++this.id;
    const t0 = now();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 60000);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve({ ms: now() - t0, msg });
      });
      this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  notify(method) {
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  }
}

export async function benchMcp({ port, runs = 5, log = () => {} } = {}) {
  const s = scratch();
  const srv = await startServer({ port, data: s.data, home: s.home });
  const env = isolatedEnv(s.home, { HILDEGARD_URL: srv.url });
  const result = { spawnToInitializeMs: null, toolsListMs: null, tools: 0, calls: {} };
  try {
    const boots = [];
    const lists = [];
    const calls = { hildegard_status: [], list_presets: [], list_skills: [], list_voices: [] };
    for (let i = 0; i < runs; i++) {
      const t0 = now();
      const proc = spawn(process.execPath, [CLI_MAIN, 'mcp', '--port', String(port)], {
        env,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      const rpc = new Rpc(proc);
      await rpc.call('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'perf-bench', version: '1' },
      });
      boots.push(now() - t0);
      rpc.notify('notifications/initialized');
      const list = await rpc.call('tools/list');
      lists.push(list.ms);
      result.tools = list.msg.result?.tools?.length ?? 0;
      for (const name of Object.keys(calls)) {
        const r = await rpc.call('tools/call', { name, arguments: {} });
        calls[name].push(r.ms);
      }
      proc.kill('SIGKILL');
    }
    result.spawnToInitializeMs = round(median(boots));
    result.toolsListMs = round(median(lists), 2);
    for (const [name, v] of Object.entries(calls)) result.calls[name] = round(median(v), 2);
    log(
      `mcp: initialize ${result.spawnToInitializeMs} ms, tools/list ${result.toolsListMs} ms (${result.tools} tools)`,
    );
  } finally {
    await srv.stop();
  }
  return result;
}

if (import.meta.main) {
  const r = await benchMcp({ port: Number(process.env.PERF_PORT ?? 7543), log: (m) => console.error(m) });
  console.log(JSON.stringify(r, null, 2));
}

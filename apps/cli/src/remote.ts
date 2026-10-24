// SPDX-License-Identifier: AGPL-3.0-only
/**
 * AI apps on this computer using a Hildegard on another device: `hildegard connect <app> --remote <link>` keeps that
 * Hildegard's key in this computer's keychain and links the app to `hildegard mcp --remote <link>`, which carries the
 * app's MCP messages to `<link>/mcp`. The key never goes into the app's config, a command line or a log.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { connectAgent, findAgent, listAgents, mcpCommand, type Step } from '@hildegard/runtime';
import { type SecretStore, secretStores } from '@hildegard/server';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { askSecret, type Ctx, readStdin } from './commands.ts';
import { type Result, result } from './output.ts';

/** `https://parish1.tail1234.ts.net/` → `https://parish1.tail1234.ts.net`. Only http(s), no path or credentials. */
export function remoteBase(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    throw new Error(`“${raw}” isn’t a link. Give the one \`hildegard host status\` shows on that device.`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Give an https:// link.');
  if (u.username || u.password) throw new Error('Leave any name or password out of the link.');
  return `${u.protocol}//${u.host}`;
}

/** The keychain entry for one remote Hildegard: `mcp-` and its address, readable and unique. */
export function remoteAccount(base: string): string {
  const slug = base
    .replace(/^https?:\/\//, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const hash = createHash('sha256').update(base).digest('hex').slice(0, 8);
  return `mcp-${slug.slice(0, 60)}-${hash}`;
}

export const remoteSecret = async (ctx: Ctx, base: string): Promise<SecretStore> =>
  (await secretStores(join(ctx.config.dataDir, 'secrets')))(remoteAccount(base));

/** Ask the remote Hildegard's MCP who we are, with this key: an initialize, then the tool list. */
export async function checkRemote(base: string, key: string): Promise<{ tools: number } | { error: string }> {
  const post = (body: unknown) =>
    fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  try {
    const init = await post({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'hildegard', version: '1' },
      },
    });
    if (init.status === 401)
      return { error: 'That Hildegard refused the key: it was revoked, or is for another link.' };
    if (!init.ok) return { error: `That Hildegard answered ${init.status}.` };
    await init.body?.cancel();
    const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const text = await list.text();
    // A JSON body, or one SSE event carrying it.
    const json = text.trimStart().startsWith('{') ? text : (/^data: (.*)$/m.exec(text)?.[1] ?? '{}');
    const tools = (JSON.parse(json) as { result?: { tools?: unknown[] } }).result?.tools?.length ?? 0;
    return tools ? { tools } : { error: 'That Hildegard answered, but listed no tools.' };
  } catch (e) {
    return {
      error: `Hildegard isn’t answering at ${base} (${(e as Error).message}). Is that device on, and on your tailnet?`,
    };
  }
}

/** `hildegard connect <app>… --remote <link> [--key-stdin]`. */
export async function connectRemote(ctx: Ctx, ids: string[]): Promise<Result> {
  let base: string;
  try {
    base = remoteBase(ctx.opts.get('remote') ?? '');
  } catch (e) {
    return result([], (e as Error).message, { ok: false });
  }
  const secret = await remoteSecret(ctx, base);
  let key = '';
  if (ctx.flags.has('key-stdin')) key = await readStdin();
  else if (process.stdin.isTTY && !ctx.json)
    key = await askSecret('Key from that Hildegard (it won’t show): ');
  key = key.trim() || (secret.get() ?? '');
  if (!key)
    return result(
      [
        {
          id: 'key',
          title: 'A key from that Hildegard',
          status: 'needs-owner',
          detail: `On the device at ${base}, run \`hildegard host key "<this app and computer>"\`, then pipe its key in here. It's a secret: never put it on a command line.`,
          command: `hildegard connect ${ids.join(' ') || '<app>'} --remote ${base} --key-stdin`,
        },
      ],
      'Waiting on a key.',
    );
  if (!/^hgk_[A-Za-z0-9_-]{43}$/.test(key))
    return result([], 'That isn’t a Hildegard key. Keys start with hgk_.', { ok: false });
  const check = await checkRemote(base, key);
  const steps: Step[] = [];
  if ('error' in check) {
    steps.push({ id: 'remote', title: `Reach Hildegard at ${base}`, status: 'failed', detail: check.error });
    return result(steps, check.error);
  }
  secret.set(key);
  steps.push({
    id: 'remote',
    title: `Reach Hildegard at ${base}`,
    status: 'done',
    detail: `It answers with ${check.tools} tools. The key is in ${secret.kind === 'keychain' ? 'this computer’s keychain' : 'a file only you can read'}.`,
  });
  const cmd = mcpCommand({ remote: base });
  const targets = ctx.flags.has('all')
    ? listAgents()
        .filter((a) => a.installed)
        .map((a) => a.id)
    : ids;
  for (const id of targets)
    steps.push(
      findAgent(id)
        ? connectAgent(id, cmd)
        : { id: `connect-${id}`, title: id, status: 'failed', detail: `No app called ${id}.` },
    );
  return result(
    steps,
    targets.length
      ? `Those apps now use the Hildegard at ${base}.`
      : `Key saved. Link an app with \`hildegard connect <app> --remote ${base}\`.`,
    { remote: base, command: cmd },
  );
}

/**
 * `hildegard mcp --remote <link>`: stdio on one side, for the app; Streamable HTTP to `<link>/mcp` on the other, with
 * the key from the keychain. Each message goes through as it is.
 */
export async function runRemoteStdio(ctx: Ctx, raw: string) {
  const base = remoteBase(raw);
  const key = (await remoteSecret(ctx, base)).get();
  const down = new StdioServerTransport();
  const fail = (id: unknown, message: string) =>
    void down.send({ jsonrpc: '2.0', id: id as string | number, error: { code: -32000, message } });
  if (!key) {
    // Still speak MCP, so the app shows the reason rather than "server disconnected".
    down.onmessage = (m) => {
      if ('id' in m && 'method' in m)
        fail(m.id, `No key for ${base} on this computer. Run \`hildegard connect <app> --remote ${base}\`.`);
    };
    await down.start();
    return;
  }
  const up = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${key}` } },
  });
  up.onmessage = (m) => {
    // The version the two sides agreed on rides on every later request, as the spec asks.
    const v = (m as { result?: { protocolVersion?: unknown } }).result?.protocolVersion;
    if (typeof v === 'string') up.setProtocolVersion(v);
    void down.send(m);
  };
  up.onerror = (e) => console.error(`Hildegard at ${base}: ${e.message}`);
  down.onmessage = (m: JSONRPCMessage) => {
    up.send(m).catch((e: Error & { code?: number }) => {
      if ('id' in m && 'method' in m)
        fail(
          m.id,
          e.code === 401
            ? `The Hildegard at ${base} refused this computer’s key. Make a new one there with \`hildegard host key\`, then \`hildegard connect <app> --remote ${base} --key-stdin\`.`
            : `Hildegard at ${base} isn’t answering: ${e.message}`,
        );
    });
  };
  down.onclose = () => void up.close();
  await up.start();
  await down.start();
  console.error(`Hildegard MCP on stdio, carried to ${base}.`);
}

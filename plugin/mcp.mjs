#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The Hildegard plugin's MCP server, for Claude Code (and any app that installs the repository as a plugin): it runs
 * `hildegard mcp` from the Hildegard installed on this computer, so the app's tools reach the user's own GPUs. When
 * Hildegard isn't installed yet, it answers as a small MCP server of its own with one tool, `hildegard_install`, that
 * says how to install it, so an agent can set Hildegard up for its owner and the plugin works on the next start.
 *
 * Plain Node with no dependencies: the plugin is the repository as cloned, with nothing built or installed.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const win = process.platform === 'win32';

/** Where the installers put the `hildegard` command, after HILDEGARD_BIN and PATH. */
export function findHildegard(env = process.env, home = homedir(), exists = existsSync) {
  if (env.HILDEGARD_BIN && exists(env.HILDEGARD_BIN)) return env.HILDEGARD_BIN;
  const names = win ? ['hildegard.cmd', 'hildegard.exe'] : ['hildegard'];
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean))
    for (const n of names) if (exists(join(dir, n))) return join(dir, n);
  const known = win
    ? [
        join(
          env.HILDEGARD_HOME ?? join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Hildegard'),
          'bin',
          'hildegard.cmd',
        ),
      ]
    : [join(env.XDG_BIN_HOME ?? join(home, '.local', 'bin'), 'hildegard')];
  return known.find((p) => exists(p)) ?? null;
}

export const INSTALL = {
  unix: 'curl -fsSL https://dbaney.com/hildegard/install.sh | sh',
  windows: 'irm https://dbaney.com/hildegard/install.ps1 | iex',
};

/** What `hildegard_install` says: how to install Hildegard here, for an agent to run with its owner's go-ahead. */
export function installText(platform = process.platform) {
  const line = platform === 'win32' ? `PowerShell: ${INSTALL.windows}` : INSTALL.unix;
  return [
    'Hildegard isn’t installed on this computer yet, so its tools aren’t here. Hildegard is the user’s own studio: it runs image, video, voice, music and 3D work on their own GPUs.',
    '',
    `To install it, with your user’s go-ahead, run: ${line}`,
    'The installer checks the free space, installs Hildegard in the user’s home folder and sets it up for their GPU. It never accepts a model license for the user: when a model needs one, Hildegard asks them.',
    '',
    'Then restart this app (or run /mcp and reconnect hildegard): the plugin finds Hildegard and its tools appear. If Hildegard is installed somewhere unusual, set HILDEGARD_BIN to its `hildegard` command.',
    'The craft skills (hildegard, hildegard-3d, hildegard-loop and others) already work without it.',
  ].join('\n');
}

const TOOL = {
  name: 'hildegard_install',
  title: 'Install Hildegard',
  description:
    'Hildegard isn’t installed on this computer yet. Call this to learn how to install it, so the user’s own GPUs become tools here.',
  inputSchema: { type: 'object', properties: {} },
  annotations: { readOnlyHint: true },
};

/** One answer of the stand-in server, or null for a notification. */
export function answer(msg, platform = process.platform) {
  if (msg.id === undefined || msg.id === null) return null;
  const ok = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  switch (msg.method) {
    case 'initialize':
      return ok({
        protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'hildegard', version: 'install' },
        instructions:
          'Hildegard isn’t installed here yet. Call hildegard_install to learn how to install it.',
      });
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: [TOOL] });
    case 'tools/call':
      return msg.params?.name === TOOL.name
        ? ok({ content: [{ type: 'text', text: installText(platform) }] })
        : ok({ content: [{ type: 'text', text: installText(platform) }], isError: true });
    case 'prompts/list':
      return ok({ prompts: [] });
    case 'resources/list':
      return ok({ resources: [] });
    default:
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `No method ${msg.method}` } };
  }
}

function standIn() {
  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`,
      );
      return;
    }
    const out = answer(msg);
    if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const bin = findHildegard();
  if (!bin) standIn();
  else {
    // A .cmd needs a shell on Windows; the path is ours (found above), never the app's or a model's.
    const cmd = win && /\.cmd$/i.test(bin);
    const child = spawn(cmd ? `"${bin}"` : bin, ['mcp'], { stdio: 'inherit', shell: cmd });
    child.on('exit', (code) => process.exit(code ?? 0));
    child.on('error', () => standIn());
  }
}

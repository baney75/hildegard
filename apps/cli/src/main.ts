#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
import { parseArgs, VERSION } from '@hildegard/server';
import {
  type Ctx,
  connect,
  install,
  models,
  open,
  running,
  serveForeground,
  setup,
  start,
  status,
  stop,
} from './commands.ts';
import { bold, dim, printResult, type Result } from './output.ts';

const HELP = `${bold('hildegard')} ${VERSION}: your own film studio, on your own GPU.

  hildegard install          Install ComfyUI and PyTorch for this GPU, then start Hildegard
  hildegard setup            Pick a model that fits and link your AI apps
  hildegard start | stop     Run Hildegard in the background, or stop it
  hildegard status           What's installed and running
  hildegard open             Open the Studio in your browser
  hildegard models           Models, and whether they fit this GPU
  hildegard models install <id> [--accept-license]
  hildegard connect [<app>…] Let an AI app use Hildegard: ${dim('claude-code, claude-desktop, codex, cursor,')}
                             ${dim('opencode, vscode, windsurf, lm-studio')}. --all links every app found
  hildegard disconnect <app>
  hildegard mcp              The MCP server, on stdio (AI apps run this)

  --json      Machine-readable output, for agents: { ok, needsOwner, steps[], message }
  --yes       Don't ask; say yes to linking apps (never to licenses: pass --accept-license)
  --port N    Hildegard's port (default 7341)    --data DIR   Where Hildegard keeps everything
  --cpu       Install the CPU build of PyTorch    --verbose    Show the installer's output

Agents: see INSTALL-FOR-AGENTS.md. Everything stays on this computer.`;

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--') && !a.includes('=')).map((a) => a.slice(2)));
const valued = new Set(['port', 'data', 'model', 'host', 'comfy', 'comfy-dir', 'ui']);
const opts = new Map<string, string>();
const positional: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=', 2) as [string, string | undefined];
    if (v !== undefined) opts.set(k, v);
    else if (valued.has(k) && argv[i + 1] !== undefined) opts.set(k, argv[++i]!);
  } else positional.push(a);
}
const [command = 'help', ...rest] = positional;
const config = parseArgs(argv);
const ctx: Ctx = { config, json: flags.has('json'), yes: flags.has('yes'), flags, opts };

async function main(): Promise<Result | null> {
  if (flags.has('version') || command === 'version') {
    console.log(VERSION);
    return null;
  }
  switch (command) {
    case 'install':
      return install(ctx);
    case 'setup':
      return setup(ctx);
    case 'start':
      if (flags.has('foreground')) return serveForeground(config);
      return start(ctx);
    case 'stop':
      return stop(ctx);
    case 'restart':
      await stop(ctx);
      return start(ctx);
    case 'status':
      return status(ctx);
    case 'open':
      if (!(await running(config))) await start(ctx);
      return open(ctx);
    case 'models':
      return models(ctx, rest);
    case 'connect':
      return connect(ctx, rest);
    case 'disconnect':
      return connect(ctx, rest, true);
    case 'mcp': {
      const { runStdio } = await import('./mcp.ts');
      await runStdio(`http://127.0.0.1:${config.port}`);
      return null;
    }
    case 'help':
    case '--help':
      console.log(HELP);
      return null;
    default:
      console.error(`Unknown command “${command}”.\n`);
      console.log(HELP);
      process.exitCode = 2;
      return null;
  }
}

try {
  const r = await main();
  if (r) {
    printResult(r, ctx.json, typeof r.printed === 'number' ? r.printed : 0);
    if (!r.ok) process.exitCode = 1;
  }
} catch (e) {
  const message = (e as Error).message;
  if (ctx.json) console.log(JSON.stringify({ ok: false, needsOwner: false, steps: [], message }, null, 2));
  else console.error(message);
  process.exitCode = 1;
}

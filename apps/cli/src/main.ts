#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
import { parseArgs, VERSION } from '@hildegard/server';
import {
  type Ctx,
  choir,
  connect,
  hf,
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
import { doctor } from './doctor.ts';
import { host } from './host.ts';
import { bold, dim, printResult, type Result } from './output.ts';

const HELP = `${bold('hildegard')} ${VERSION}: your own film studio, on your own GPU.

  hildegard install          Install ComfyUI and PyTorch for this GPU, then start Hildegard
  hildegard setup            Pick a model that fits and link your AI apps
  hildegard start | stop     Run Hildegard in the background, or stop it
  hildegard status           What's installed and running
  hildegard doctor           Check every part, and print the command that fixes each problem
  hildegard open             Open the Studio in your browser
  hildegard models           Models, and whether they fit this GPU
  hildegard models install <id> [--accept-license]
  hildegard setup --model <id> --accept-license <id> [--hf-token-stdin] --yes --json
                             Without questions, for agents: the license only when the owner said yes
  hildegard connect [<app>…] Let an AI app use Hildegard: ${dim('claude-code, claude-desktop, codex, cursor,')}
                             ${dim('opencode, vscode, windsurf, lm-studio')}. --all links every app found
  hildegard disconnect <app>
  hildegard hf login         Link your Hugging Face account (hf status, hf logout). The token goes to
                             your system keychain; pipe one in with --token-stdin
  hildegard choir invite     Share this GPU with your other devices over Tailscale: prints a join code
                             (--url to give the address yourself; choir revoke stops sharing)
  hildegard choir join       On a computer without a big GPU: paste that code, and takes render there
  hildegard choir list       Devices, and which one renders (choir use <device|local>, choir leave <device>)
  hildegard host             Put this Hildegard at a link for your other devices and people you invite,
                             with sign-in: HTTPS on your tailnet (--funnel: the public internet)
  hildegard host owner       Make the owner account (host off | status | invite | people | revoke <name>
                             | limit <n>: takes each director may have waiting, 3 unless you change it)
  hildegard mcp              The MCP server, on stdio (AI apps run this)

  --json      Machine-readable output, for agents: { ok, needsOwner, steps[], message }
  --yes       Don't ask; say yes to linking apps (never to licenses: pass --accept-license)
  --port N    Hildegard's port (last used, or 7341)    --data DIR   Where Hildegard keeps everything
  --cpu       Install the CPU build of PyTorch    --verbose    Show the installer's output

Agents: see docs/agents.md. Everything stays on your own devices.`;

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--') && !a.includes('=')).map((a) => a.slice(2)));
const valued = new Set([
  'port',
  'data',
  'model',
  'host',
  'allow-host',
  'comfy',
  'comfy-dir',
  'ui',
  'url',
  'name',
  'role',
  'hours',
  'address',
  'host-port',
  'accept-license',
]);
/** Flags that take a value only when one follows: `--accept-license` alone still means the model named before it. */
const optional = new Set(['accept-license']);
const opts = new Map<string, string>();
const positional: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=', 2) as [string, string | undefined];
    if (v !== undefined) opts.set(k, v);
    else if (valued.has(k) && argv[i + 1] !== undefined && !(optional.has(k) && argv[i + 1]!.startsWith('-')))
      opts.set(k, argv[++i]!);
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
    case 'doctor':
      return doctor(ctx);
    case 'host':
      return host(ctx, rest);
    case 'open':
      if (!(await running(config))) await start(ctx);
      return open(ctx);
    case 'models':
      return models(ctx, rest);
    case 'hf':
      return hf(ctx, rest);
    case 'choir':
      return choir(ctx, rest);
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

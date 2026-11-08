#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
import { parseArgs, VERSION } from '@hildegard/server';
import { agents, review, skills } from './agents.ts';
import { cloud } from './cloud.ts';
import {
  type Ctx,
  choir,
  connect,
  ForegroundStartError,
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
import { loop } from './loop.ts';
import { bold, dim, printResult, type Result } from './output.ts';
import { tunnel } from './tunnel.ts';

const HELP = `${bold('hildegard')} ${VERSION}: your own film studio, on your own GPU.

  hildegard install          Install ComfyUI and PyTorch for this GPU, then start Hildegard
                             (--server: for a computer that serves your other devices: speech and transcription
                             too, and a service that starts it when you sign in: user systemd, or a LaunchAgent)
  hildegard setup            Pick a model that fits and link your AI apps
  hildegard start | stop     Run Hildegard in the background, or stop it
  hildegard status           What's installed and running
  hildegard update           Update to the newest release, signed and checked (--check: only look).
                             Hildegard also updates itself when nothing is rendering: update auto on|off
  hildegard update <device>  Update another of your devices from here; \`update all\` updates every one, this one last
  hildegard doctor           Check every part, and print the command that fixes each problem
  hildegard open             Open the Studio in your browser
  hildegard models           Models, and whether they fit this GPU
  hildegard models install <id> [--accept-license]
  hildegard models remove <id> [--with-unused] [--dry-run]
                             Delete a model's own files. Shared files (text encoders, VAEs) stay and are listed
                             as unused once no installed model needs them; --with-unused deletes those too
  hildegard voice install    Set up speech, cloning and voice design for this GPU (--env speech,chatterbox,qwen;
                             hildegard voice: what's set up)
  hildegard setup --model <id> --accept-license <id> [--hf-token-stdin] --yes --json
                             Without questions, for agents: the license only when the owner said yes
  hildegard connect [<app>…] Let an AI app use Hildegard: ${dim('claude-code, claude-desktop, codex, omp, pi,')}
                             ${dim('gemini, opencode, cursor, vscode, windsurf, lm-studio')}. --all links every app
                             found, with its skills (--no-skills to skip) and how to sign it in within its terms
  hildegard connect <app> --remote <link> --key-stdin
                             Let an app here use the Hildegard on another device, with a key from it
  hildegard disconnect <app>
  hildegard hf login         Link your Hugging Face account (hf status, hf logout). The token goes to
                             your system keychain; pipe one in with --token-stdin
  hildegard choir invite     Share this GPU with your other devices over Tailscale: prints a short code (HG-XXXX-XXXX)
                             (--url to give the address yourself, --long for the long code too; choir revoke stops sharing)
  hildegard choir pair <ssh-host>
                             On the computer without the GPU: join the GPU on <ssh-host> in one step. The code
                             goes from one process to the next and is never shown (--to <ssh-host>: the other
                             way, this computer has the GPU). Scripts and agents use this, never invite + join
  hildegard choir invite --code-only
                             Only the long code, for a pipe: \`… invite --code-only | ssh <host> hildegard choir
                             join --code-stdin\`. Refuses on a terminal, so a code is never on a screen
  hildegard choir join       On a computer without a big GPU: give that code (join HG-XXXX-XXXX --url <address>; the invite prints the whole command), and takes render there
  hildegard choir list       Devices, and which one renders (choir use <device|local|auto>, choir leave <device>);
                             use auto sends each take to the device free for it, this one included
  hildegard choir primary    Where Talk hears and answers by default: choir primary <device|local>
  hildegard choir opportunistic on|off
                             On: your other devices’ renders here yield to this computer’s own work and wait
                             while it’s busy: in use, or another program on the GPU. Off (the default): they
                             render when their turn comes
  hildegard choir presence away|back
                             For idle hooks (hypridle): say you left or came back (--minutes it holds, a day)
  hildegard host             Put this Hildegard at a link for your other devices and people you invite,
                             with sign-in: HTTPS on your tailnet (--funnel: the public internet;
                             --public-url https://<name>: your own HTTPS front door, such as a Cloudflare tunnel)
  hildegard tunnel           Reach Hildegard from your other devices through an account you own: where Tailscale
                             and Cloudflare stand here, and what each still needs (--signup: their free-account page)
  hildegard tunnel auto      The best link this computer can make, in one step: Tailscale if signed in, else a
                             temporary quick tunnel if cloudflared is here, else what is missing
  hildegard tunnel tailscale Your own devices only (Tailscale Serve); --funnel for the public internet
  hildegard tunnel cloudflare --hostname <name>
                             A Cloudflare named tunnel on your domain, at a name that stays (--login signs in;
                             --quick: a temporary trycloudflare.com name, no account). tunnel install cloudflare
                             fetches cloudflared; tunnel off turns the link off and reads it back
  hildegard host owner       Make the owner account (host off | status | invite | people | revoke <name>
                             | limit <n>: takes each director may have waiting, 3 unless you change it)
  hildegard host code        A one-time code (HG-XXXX-XXXX, 10 minutes) to approve claude.ai or ChatGPT
                             on Hildegard's page instead of typing your name and passphrase
  hildegard host key <name>  A key for an AI app on another device (host keys: keys and chatbots;
                             host keys revoke <id|name>). Chatbots sign in at the link's /mcp themselves
  hildegard llm              Local models running here (Ollama, LM Studio, llama.cpp, vLLM, MLX, Jan, Local AI),
                             and yours: llm add <name> <address> [--key-stdin] | remove | use <endpoint> [<model>]
  hildegard llm direct "<idea>"  Let a local model direct shots with Hildegard's tools (--film, --model, --plan)
  hildegard sites            Websites made here (sites templates; sites new [<template>] [--figma <link> |
                             --url <address>] [--name <name>]). Open them on the Studio's canvas
  hildegard sites publish <id>  Show a site to anyone at /s/<id>/ (--off takes it down; --address
                             <https://example.com/> says where its front page is for feeds and sitemaps)
  hildegard figma token      Link Figma for imports (--token-stdin; figma status | unlink)
  hildegard mcp              The MCP server, on stdio (AI apps run this). It's also at /mcp, over HTTP
  hildegard skills install   Put Hildegard's skills where Claude Code, Codex, OMP, Pi, Gemini CLI and OpenCode look
                             (--agent claude-code|codex|omp|pi|gemini|opencode, --project DIR; skills list | remove)
  hildegard agents           Which coding agents are here, and how Hildegard may run each under
                             its provider's terms (agents key <provider> --key-stdin, share-keys on|off)
  hildegard agents run <claude-code|codex|omp|pi> "<task>"
                             Run one for you: its own sign-in, or --use key (your API key; needed
                             with --unattended), or --use local --model ollama/<model> for OMP and Pi.
                             Pi has no sandbox and runs only with --unsandboxed, started by you
  hildegard cloud            Rented GPUs: Runpod, Hugging Face Jobs, Colab, with what each costs and sees
  hildegard cloud runpod up  Rent a Runpod GPU that joins your fleet and stops itself when idle
                             (cloud runpod key --key-stdin | status | down [--delete])
  hildegard review <file>    Check a video, image or sound for the marks of slop (--final, --seconds N,
                             --audio, --film, --sheet out.jpg for a contact sheet)
  hildegard loop run <codex|claude-code|omp> "<what to make>"
                             A coding agent makes it in rounds: generate, render, critique, refine
                             (--kind model|web|image|video|audio, --print, --size 40x40x120, --rounds N)
  hildegard loop             Loops and their rounds (loop show <id>; loop submit <id> <file> --note;
                             loop critique <id> <round> --stdin; loop finish <id> <round> --note)

  hildegard lint <file...>   Check writing for the tells that make it read as machine-made (a blog post, an email,
                             a page): each one with where it is and what to do. A file of - reads standard input.
                             For everyday prose, fix every fail, fix each warn unless it is your voice, and lint
                             again; for poems, fiction, scripts and papers every finding is a warning. Exits 1 when
                             any file fails, 2 for bad usage or a file it can't read (--json: the lint itself;
                             --max N: places shown for each, 1 or more; --strict: for writing that must carry no
                             tells, the em dash and the other warnings fail too)

  hildegard report bug "<what broke>" --what "<what you did, expected, got>"
  hildegard report idea "<what you want>" --what "<the work you want to make>"
  hildegard report skill "<what to change>" --skill <name> [--model <model>] --what "<what happened>"
                             [--change-file <file>]: suggest a change to a skill, checked for attacks first"
                             Draft a report for Hildegard's makers, with doctor and the log, keys, paths and names
                             taken out, and the issues like it. Nothing is sent until report file [<id>] [--on <issue>]
                             (files through the GitHub CLI, as you); report show [<id>] prints a draft again

  --json      Machine-readable output, for agents: { ok, needsOwner, steps[], message }
  --yes       Don't ask; say yes to linking apps (never to licenses: pass --accept-license)
  --port N    Hildegard's port (last used, or 7341)    --data DIR   Where Hildegard keeps everything
  --cpu       Install the CPU build of PyTorch    --verbose    Show the installer's output
  --events    With install: each step as a line of JSON while it runs, then the result (the Hildegard app)

Agents: see docs/agents.md. Everything stays on your own devices.`;

const argv = process.argv.slice(2);
// Filled with the options below: a token taken as an option's value (`--workspace --unsandboxed`) is never a flag too.
const flags = new Set<string>();
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
  'public-url',
  'host-port',
  'accept-license',
  'remote',
  'person',
  'as',
  'days',
  'film',
  'endpoint',
  'use',
  'provider',
  'workspace',
  'add-dir',
  'budget',
  'agent',
  'project',
  'sheet',
  'seconds',
  'gpu',
  'env',
  'idle-minutes',
  'minutes',
  'disk',
  'volume',
  'wait-minutes',
  'kind',
  'size',
  'rounds',
  'note',
  'what',
  'now',
  'more',
  'on',
  'how',
  'skill',
  'change',
  'change-file',
  'figma',
  'max',
  'from',
  'to',
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
    else {
      flags.add(k);
      if (valued.has(k) && argv[i + 1] !== undefined && !(optional.has(k) && argv[i + 1]!.startsWith('-')))
        opts.set(k, argv[++i]!);
    }
  } else positional.push(a);
}
const [command = 'help', ...rest] = positional;
const config = parseArgs(argv);
// --events is --json with each install step printed as it happens, for the Hildegard app.
const ctx: Ctx = {
  config,
  json: flags.has('json') || flags.has('events'),
  yes: flags.has('yes'),
  flags,
  opts,
};

async function main(): Promise<Result | null> {
  if (flags.has('version') || command === 'version') {
    console.log(VERSION);
    return null;
  }
  // `<command> --help` (or -h) asks what a command does: it must never run it. `stop --help` once stopped Hildegard.
  if (flags.has('help') || argv.includes('-h')) {
    console.log(HELP);
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
    case 'update': {
      const u = await import('./update.ts');
      if (rest[0] === 'auto') return u.autoUpdate(ctx, rest[1]);
      return rest[0] ? u.updateDevices(ctx, rest[0]) : u.update(ctx);
    }
    case 'doctor':
      return doctor(ctx);
    case 'host':
      return host(ctx, rest);
    case 'tunnel':
      return tunnel(ctx, rest);
    case 'llm':
      return (await import('./llm.ts')).llm(ctx, rest);
    case 'open':
      if (!(await running(config))) await start(ctx);
      return open(ctx);
    case 'models':
      return models(ctx, rest);
    case 'voice':
      return (await import('./voice.ts')).voice(ctx, rest);
    case 'hf':
      return hf(ctx, rest);
    case 'choir':
      return choir(ctx, rest);
    case 'connect':
      if (opts.has('remote')) return (await import('./remote.ts')).connectRemote(ctx, rest);
      return connect(ctx, rest);
    case 'agents':
      return agents(ctx, rest);
    case 'skills':
      return skills(ctx, rest);
    case 'review':
      return review(ctx, rest);
    case 'lint':
      await (await import('./lint.ts')).lint(ctx, rest);
      return null;
    case 'loop':
      return loop(ctx, rest);
    case 'cloud':
      return cloud(ctx, rest);
    case 'report':
      return (await import('./report.ts')).report(ctx, rest);
    case 'sites':
    case 'site':
      return (await import('./sites.ts')).sites(ctx, rest);
    case 'figma':
      return (await import('./sites.ts')).figma(ctx, rest);
    case 'disconnect':
      return connect(ctx, rest, true);
    case 'mcp': {
      if (opts.has('remote')) {
        await (await import('./remote.ts')).runRemoteStdio(ctx, opts.get('remote')!);
        return null;
      }
      const { runStdio } = await import('./mcp.ts');
      await runStdio(`http://127.0.0.1:${config.port}`);
      return null;
    }
    case 'help':
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
  // A command can pick its own status: `lint` uses 2 for bad usage, so 1 stays for a failing lint.
  process.exitCode = (e as { exitCode?: number }).exitCode ?? 1;
  if (e instanceof ForegroundStartError) process.exit(1);
}

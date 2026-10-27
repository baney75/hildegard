// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Runs a coding agent for its owner the way each vendor documents for scripts: `claude -p`, `codex exec`, `omp -p`, `pi -p`,
 * the unmodified programs the owner installed. Hildegard decides first (policy.ts), gives the agent a workspace with
 * Hildegard's MCP server and skills in it, and passes an API key only through the environment variable the vendor
 * documents. It never reads, copies or forwards anyone's sign-in.
 */
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { McpCommand } from '@hildegard/runtime';
import { COMMANDS, type Detected, KEY_ENV, LOCAL_PROVIDERS, providerOf, type Sys, system } from './detect.ts';

import {
  type AgentId,
  type Auth,
  decide,
  isPiFamily,
  type PaceState,
  type PolicyOptions,
  pace,
  type Trigger,
  type Verdict,
} from './policy.ts';

const NAMES_SHORT: Record<AgentId, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  omp: 'OMP',
  pi: 'Pi',
};

export interface LaunchInput {
  agent: AgentId;
  /** What the owner asked for, in their words. */
  task: string;
  trigger: Trigger;
  /**
   * `own-sign-in`: however the agent itself is signed in (a plan, or a key it already has).
   * `key`: the owner's API key that Hildegard holds in the keychain, for `provider`.
   * `local`: a model on the owner's own computers (OMP and Pi only).
   */
  use: 'own-sign-in' | 'key' | 'local';
  /** For `key`: anthropic, openai, openrouter, … Defaults to the agent’s own provider. */
  provider?: string;
  /** For `key`: the key itself. Goes only into the documented environment variable, never argv, logs or files. */
  key?: string;
  /** The model: Claude Code and Codex take their own names; OMP and Pi take `provider/model`. */
  model?: string;
  /** The run’s own folder: Hildegard’s MCP config and skills go here, and the agent works here. */
  workspace: string;
  /** How the agent starts Hildegard’s MCP server. */
  mcp: McpCommand;
  /** Where Hildegard's skills are (the repo's or release's `skills/`). */
  skillsDir?: string;
  /** Folders of the owner's the agent may also read and write (their footage, say). */
  addDirs?: string[];
  /** With an API key: stop past this many US dollars (Claude Code enforces it). */
  budgetUsd?: number;
  /** Tools a headless Claude Code may also use without asking, such as `Bash(blender:*)` for a modeling loop. */
  extraTools?: string[];
}

export interface Plan {
  agent: AgentId;
  verdict: Verdict;
  auth: Auth;
  cmd: string;
  args: string[];
  /** Changes to the environment: a value sets, null removes. */
  env: Record<string, string | null>;
  /** What goes to the agent on stdin: the task, so it never shows in a process list. */
  stdin: string | null;
  /**
   * Only these variables of Hildegard's own environment reach the agent (exact names, or a prefix ending in `*`),
   * before `env` applies. Absent: the whole environment, minus what `env` removes.
   */
  inherit?: string[];
}

/** The tools a headless Claude Code may use without asking: Hildegard's, files in its workspace, and media tools. */
export const CLAUDE_TOOLS = [
  'mcp__hildegard',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'Skill',
  'Bash(ffmpeg:*)',
  'Bash(ffprobe:*)',
  'Bash(magick:*)',
  'Bash(hildegard review:*)',
];

/** Sign-ins OMP or Pi could otherwise pick up from the environment, which must never reach it. */
const BORROWED = [
  'ANTHROPIC_OAUTH_TOKEN',
  'XAI_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OMP_AUTH_BROKER_URL',
];

/**
 * What Pi may read from Hildegard's environment: enough to start, find programs and use a temp folder, and nothing
 * that could hold a sign-in or a key other than the one Hildegard sets. Windows needs its system variables to start
 * Node at all.
 */
export const PI_ENV = [
  'PATH',
  'HOME',
  'LANG',
  'LC_*',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SystemRoot',
  'SYSTEMROOT',
  'windir',
  'PATHEXT',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'ComSpec',
];

/**
 * Pi's built-in tools Hildegard allows, and Hildegard's own over MCP. Pi has no way to allow a shell for some programs
 * only (as Claude Code's `Bash(ffmpeg:*)` does), so it gets no shell: media work goes through Hildegard's tools.
 */
export const PI_TOOLS = ['read', 'edit', 'write', 'grep', 'find', 'ls', 'mcp__hildegard__*'];

/** The fixed prompt Pi gets in argv; the owner's task comes before it on stdin, which Pi puts first. */
export const PI_PROMPT = 'Do the task above.';

/** A model selector Pi takes as one plain argument everywhere, Windows' shell included. */
const MODEL_RE = /^[A-Za-z0-9._:@/+-]+$/;

const DEFAULT_PROVIDER: Record<AgentId, string> = {
  'claude-code': 'anthropic',
  codex: 'openai',
  omp: 'openrouter',
  pi: 'openrouter',
};

/** The folder next to the run’s workspace that holds OMP’s own profile. */
const OMP_PROFILE = 'omp-profile';

/** Pi's profile for one run: inside the run's workspace, made empty for every run. */
export const piProfile = (workspace: string) => join(workspace, '.pi-profile');

/** TOML basic string for `codex -c key=value`. JSON escapes are valid TOML escapes for these characters. */
const toml = (s: string) => JSON.stringify(s);

/**
 * The provider a run uses. OMP and Pi take it from the model selector alone, since that is where they send the task;
 * a `provider` that names another is refused in `plan`.
 */
function providerFor(input: LaunchInput): string {
  if (isPiFamily(input.agent))
    return input.model
      ? providerOf(input.model)
      : (input.provider?.toLowerCase() ?? DEFAULT_PROVIDER[input.agent]);
  return input.provider ?? DEFAULT_PROVIDER[input.agent];
}

function authFor(input: LaunchInput, detected: Detected): Auth {
  const provider = providerFor(input);
  if (input.use === 'key') return input.key ? { kind: 'api-key', provider } : { kind: 'none' };
  if (input.use === 'local') {
    if (!isPiFamily(input.agent) || !LOCAL_PROVIDERS.has(provider)) return { kind: 'none' };
    return { kind: 'local', provider };
  }
  // Their own sign-ins would be a Claude or ChatGPT login borrowed into another tool.
  if (isPiFamily(input.agent)) return { kind: 'borrowed-login', provider };
  return detected.auth;
}

/** Decides, then says exactly what would run. Pure: nothing starts and nothing is written. */
export function plan(input: LaunchInput, detected: Detected, opts: PolicyOptions = {}): Plan {
  const auth = authFor(input, detected);
  let verdict = decide(input.agent, auth, input.trigger, opts);
  if (!detected.installed)
    verdict = {
      allowed: false,
      reason: `${detected.name} isn’t installed on this computer.`,
      fix: detected.detail,
    };
  const short = input.agent === 'pi' ? 'Pi' : 'OMP';
  if (isPiFamily(input.agent) && !input.model)
    verdict = {
      allowed: false,
      reason: `${short} needs a model, as provider/model (such as ollama/qwen3-coder).`,
    };
  else if (
    isPiFamily(input.agent) &&
    input.provider !== undefined &&
    input.provider.toLowerCase() !== providerOf(input.model!)
  )
    verdict = {
      allowed: false,
      reason: `${short} sends the task to the provider its model names (${providerOf(input.model!)}), not ${input.provider}. Leave out --provider, or pick a ${input.provider} model.`,
    };
  else if (input.agent === 'pi' && !MODEL_RE.test(input.model!))
    verdict = {
      allowed: false,
      reason:
        'A Pi model is provider/model in letters, digits and . _ : @ / + - only, such as ollama/qwen3-coder.',
    };
  if (input.budgetUsd && input.agent !== 'claude-code')
    verdict = {
      allowed: false,
      reason: `${NAMES_SHORT[input.agent]} can’t hold a run to a budget. Set a spending limit with your provider, or run without --budget.`,
    };
  if (input.agent === 'pi' && input.extraTools?.length)
    verdict = {
      allowed: false,
      reason: `Pi runs here without a shell, so it can’t use ${input.extraTools.join(', ')}. Use Claude Code or Codex for this.`,
    };
  const env: Record<string, string | null> = {};
  const ws = input.workspace;
  let args: string[];
  let stdin: string | null = input.task;

  if (input.agent === 'claude-code') {
    args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--mcp-config',
      join(ws, '.mcp.json'),
      '--strict-mcp-config',
      '--permission-mode',
      'acceptEdits',
      '--allowedTools',
      [...CLAUDE_TOOLS, ...(input.extraTools ?? [])].join(','),
      ...(input.model ? ['--model', input.model] : []),
      ...(input.addDirs ?? []).flatMap((d) => ['--add-dir', d]),
    ];
    if (auth.kind === 'api-key') {
      env.ANTHROPIC_API_KEY = input.key!;
      // A sign-in in the environment would take the run off the key the owner chose.
      env.CLAUDE_CODE_OAUTH_TOKEN = null;
      env.ANTHROPIC_AUTH_TOKEN = null;
      if (input.budgetUsd) args.push('--max-budget-usd', String(input.budgetUsd));
    }
  } else if (input.agent === 'codex') {
    args = [
      'exec',
      '--json',
      '--sandbox',
      'workspace-write',
      '--skip-git-repo-check',
      '-C',
      ws,
      '-c',
      `mcp_servers.hildegard.command=${toml(input.mcp.command)}`,
      '-c',
      `mcp_servers.hildegard.args=[${input.mcp.args.map(toml).join(', ')}]`,
      ...Object.entries(input.mcp.env ?? {}).flatMap(([k, v]) => [
        '-c',
        `mcp_servers.hildegard.env.${k}=${toml(v)}`,
      ]),
      ...(input.model ? ['-m', input.model] : []),
      ...(input.addDirs ?? []).flatMap((d) => ['--add-dir', d]),
      '-',
    ];
    if (auth.kind === 'api-key') env.CODEX_API_KEY = input.key!;
  } else {
    let inherit: string[] | undefined;
    if (input.agent === 'pi') {
      // A profile of its own for this run: no stored logins, no auth.json, only what Hildegard puts there. It starts
      // with only the variables it needs, so no sign-in or other key in Hildegard's environment reaches it.
      inherit = PI_ENV;
      env.PI_CODING_AGENT_DIR = piProfile(ws);
      env.PI_SKIP_VERSION_CHECK = '1';
      env.PI_TELEMETRY = '0';
      // The task goes on stdin, which Pi puts before the prompt, so it never shows in a process list or a shell.
      args = [
        '--print',
        '--no-session',
        '--no-approve',
        '--tools',
        PI_TOOLS.join(','),
        '--model',
        input.model ?? '',
        '--',
        PI_PROMPT,
      ];
    } else {
      // A profile of its own: stored logins (a Claude or ChatGPT one included) don't exist there.
      env.PI_CODING_AGENT_DIR = join(dirname(ws), OMP_PROFILE);
      env.CLAUDE_CONFIG_DIR = join(ws, '.claude-home');
      for (const k of BORROWED) env[k] = null;
      args = ['-p', '--no-session', '--model', input.model ?? '', input.task];
      stdin = null;
    }
    if (auth.kind === 'api-key') {
      const name = KEY_ENV[auth.provider];
      if (!name)
        verdict = {
          allowed: false,
          reason: `Hildegard doesn’t know where ${short} reads a ${auth.provider} key. Use one of: ${Object.keys(KEY_ENV).join(', ')}.`,
        };
      else env[name] = input.key!;
    }
    return { agent: input.agent, verdict, auth, cmd: COMMANDS[input.agent], args, env, stdin, inherit };
  }
  return { agent: input.agent, verdict, auth, cmd: COMMANDS[input.agent], args, env, stdin };
}

/** Writes the run's workspace: Hildegard's MCP server for each agent's config format, and the skills. */
export function prepareWorkspace(input: LaunchInput) {
  const ws = input.workspace;
  mkdirSync(ws, { recursive: true, mode: 0o700 });
  const server = {
    command: input.mcp.command,
    args: input.mcp.args,
    ...(input.mcp.env ? { env: input.mcp.env } : {}),
  };
  writeFileSync(join(ws, '.mcp.json'), `${JSON.stringify({ mcpServers: { hildegard: server } }, null, 2)}\n`);
  if (input.agent === 'pi') {
    // Pi reads MCP servers and skills from its agent directory. Each run's starts empty, so nothing (a login Pi saved,
    // an old skill) carries over from an earlier run.
    const profile = piProfile(ws);
    rmSync(profile, { recursive: true, force: true });
    mkdirSync(profile, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(profile, 'mcp.json'),
      `${JSON.stringify({ mcpServers: { hildegard: server } }, null, 2)}\n`,
    );
    if (input.skillsDir && existsSync(input.skillsDir))
      cpSync(input.skillsDir, join(profile, 'skills'), { recursive: true });
  }
  if (input.agent === 'omp') {
    mkdirSync(join(ws, '.claude-home'), { recursive: true });
    writeFileSync(
      join(ws, '.claude-home', '.claude.json'),
      `${JSON.stringify({ mcpServers: { hildegard: server } }, null, 2)}\n`,
    );
    mkdirSync(join(dirname(ws), OMP_PROFILE), { recursive: true, mode: 0o700 });
  }
  if (input.skillsDir && existsSync(input.skillsDir)) {
    // Claude Code and OMP read .claude/skills; Codex and Pi read .agents/skills.
    for (const dir of ['.claude/skills', '.agents/skills'])
      cpSync(input.skillsDir, join(ws, dir), { recursive: true });
  }
}

// ── Pacing subscription runs ─────────────────────────────────────────────────────────────────────────────────────

export class Pacer {
  private readonly file: string;
  constructor(file: string) {
    this.file = file;
  }
  private read(): PaceState {
    try {
      return { running: false, ...JSON.parse(readFileSync(this.file, 'utf8')) };
    } catch {
      return { starts: [], running: false };
    }
  }
  private write(s: PaceState) {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileSync(this.file, JSON.stringify(s), { mode: 0o600 });
  }
  /** Claims a slot, or says why not. A claim that crashed is forgotten after an hour. */
  claim(now = Date.now()): ReturnType<typeof pace> {
    const s = this.read();
    const lastStart = Date.parse(s.starts.at(-1) ?? '') || 0;
    if (s.running && now - lastStart > 3_600_000) s.running = false;
    const r = pace(s, now);
    if (r.ok)
      this.write({
        running: true,
        starts: [...s.starts.filter((t) => now - Date.parse(t) < 86_400_000), new Date(now).toISOString()],
      });
    return r;
  }
  release() {
    this.write({ ...this.read(), running: false });
  }
}

// ── Running ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface RunEvent {
  /** `text`: something the agent said; `tool`: a tool it used; `cost`: what the run cost, when the agent says. */
  kind: 'text' | 'tool' | 'cost';
  text: string;
}

export interface RunResult {
  ok: boolean;
  /** The agent's last message. */
  final: string;
  exitCode: number | null;
  costUsd?: number;
}

/** Reads the agent's JSON lines into events; anything else is the agent talking. */
export function parseLine(agent: AgentId, line: string): RunEvent[] {
  if (agent === 'omp' || agent === 'pi') return line.trim() ? [{ kind: 'text', text: line }] : [];
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(line);
  } catch {
    return [];
  }
  if (agent === 'claude-code') {
    if (m.type === 'assistant') {
      const content = ((m.message as { content?: Array<Record<string, unknown>> })?.content ?? []) as Array<
        Record<string, unknown>
      >;
      return content.flatMap((c): RunEvent[] =>
        c.type === 'text'
          ? [{ kind: 'text', text: String(c.text) }]
          : c.type === 'tool_use'
            ? [{ kind: 'tool', text: String(c.name) }]
            : [],
      );
    }
    if (m.type === 'result') {
      const out: RunEvent[] = [];
      if (typeof m.total_cost_usd === 'number') out.push({ kind: 'cost', text: String(m.total_cost_usd) });
      return out;
    }
    return [];
  }
  // Codex: thread, turn and item events.
  if (m.type === 'item.completed') {
    const item = m.item as Record<string, unknown>;
    if (item?.type === 'agent_message') return [{ kind: 'text', text: String(item.text ?? '') }];
    if (item?.type === 'mcp_tool_call')
      return [{ kind: 'tool', text: `${String(item.server)}.${String(item.tool)}` }];
    if (item?.type === 'command_execution')
      return [{ kind: 'tool', text: String(item.command ?? 'command') }];
  }
  return [];
}

/** The variables of `from` that `names` allows: exact names, or prefixes ending in `*`. */
export function inherited(from: NodeJS.ProcessEnv, names: readonly string[]): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(from))
    if (v !== undefined && names.some((n) => (n.endsWith('*') ? k.startsWith(n.slice(0, -1)) : k === n)))
      out[k] = v;
  return out;
}

const quoteWin = (a: string) =>
  /^[\w.:\\/=,@+-]+$/.test(a) ? a : `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;

/** Starts the planned run and streams what the agent does. Refuses a plan the policy refused. */
export async function run(
  p: Plan,
  cwd: string,
  onEvent: (e: RunEvent) => void = () => {},
  opts: { timeoutMs?: number; sys?: Sys; signal?: AbortSignal } = {},
): Promise<RunResult> {
  if (!p.verdict.allowed) throw new Error(p.verdict.reason);
  const sys = opts.sys ?? system();
  const env: NodeJS.ProcessEnv = p.inherit ? inherited(sys.env, p.inherit) : { ...sys.env };
  for (const [k, v] of Object.entries(p.env)) {
    if (v === null) delete env[k];
    else env[k] = v;
  }
  const win = sys.platform === 'win32';
  // npm puts .cmd shims on Windows, which only start through the shell; quote each argument for it.
  const child = win
    ? spawn([p.cmd, ...p.args].map(quoteWin).join(' '), {
        cwd,
        env,
        shell: true,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    : spawn(p.cmd, p.args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const agent = p.agent;
  let final = '';
  let costUsd: number | undefined;
  const lines = createInterface({ input: child.stdout! });
  lines.on('line', (line) => {
    for (const e of parseLine(agent, line)) {
      if (e.kind === 'text')
        final = agent === 'omp' || agent === 'pi' ? `${final}${final ? '\n' : ''}${e.text}` : e.text;
      if (e.kind === 'cost') costUsd = Number(e.text);
      onEvent(e);
    }
  });
  let err = '';
  child.stderr!.on('data', (d: Buffer) => {
    err = (err + d.toString()).slice(-4000);
  });
  child.stdin!.end(p.stdin ?? '');
  const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? 60 * 60_000);
  opts.signal?.addEventListener('abort', () => child.kill());
  const exitCode = await new Promise<number | null>((resolve) => {
    child.once('error', () => resolve(null));
    child.once('close', (code) => resolve(code));
  });
  clearTimeout(timer);
  if (exitCode !== 0 && !final) final = err.trim().split('\n').slice(-3).join('\n');
  return { ok: exitCode === 0, final, exitCode, costUsd };
}

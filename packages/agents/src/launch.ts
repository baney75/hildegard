// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Runs a coding agent for its owner the way each vendor documents for scripts: `claude -p`, `codex exec`, `omp -p`,
 * the unmodified programs the owner installed. Hildegard decides first (policy.ts), gives the agent a workspace with
 * Hildegard's MCP server and skills in it, and passes an API key only through the environment variable the vendor
 * documents. It never reads, copies or forwards anyone's sign-in.
 */
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { McpCommand } from '@hildegard/runtime';
import { COMMANDS, type Detected, KEY_ENV, LOCAL_PROVIDERS, providerOf, type Sys, system } from './detect.ts';
import {
  type AgentId,
  type Auth,
  decide,
  type PaceState,
  type PolicyOptions,
  pace,
  type Trigger,
  type Verdict,
} from './policy.ts';

export interface LaunchInput {
  agent: AgentId;
  /** What the owner asked for, in their words. */
  task: string;
  trigger: Trigger;
  /**
   * `own-sign-in`: however the agent itself is signed in (a plan, or a key it already has).
   * `key`: the owner's API key that Hildegard holds in the keychain, for `provider`.
   * `local`: a model on the owner's own computers (OMP only).
   */
  use: 'own-sign-in' | 'key' | 'local';
  /** For `key`: anthropic, openai, openrouter, … Defaults to the agent’s own provider. */
  provider?: string;
  /** For `key`: the key itself. Goes only into the documented environment variable, never argv, logs or files. */
  key?: string;
  /** The model: Claude Code and Codex take their own names; OMP takes `provider/model`. */
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

/** Sign-ins OMP could otherwise pick up from the environment, which must never reach it. */
const OMP_BORROWED = [
  'ANTHROPIC_OAUTH_TOKEN',
  'XAI_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OMP_AUTH_BROKER_URL',
];

const DEFAULT_PROVIDER: Record<AgentId, string> = {
  'claude-code': 'anthropic',
  codex: 'openai',
  omp: 'openrouter',
};

/** TOML basic string for `codex -c key=value`. JSON escapes are valid TOML escapes for these characters. */
const toml = (s: string) => JSON.stringify(s);

function authFor(input: LaunchInput, detected: Detected): Auth {
  const provider =
    input.provider ??
    (input.model && input.agent === 'omp' ? providerOf(input.model) : DEFAULT_PROVIDER[input.agent]);
  if (input.use === 'key') return input.key ? { kind: 'api-key', provider } : { kind: 'none' };
  if (input.use === 'local') {
    if (input.agent !== 'omp' || !LOCAL_PROVIDERS.has(provider)) return { kind: 'none' };
    return { kind: 'local', provider };
  }
  // OMP's own sign-in would be a Claude or ChatGPT login borrowed into another tool.
  if (input.agent === 'omp') return { kind: 'borrowed-login', provider };
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
  if (input.agent === 'omp' && !input.model)
    verdict = {
      allowed: false,
      reason: 'OMP needs a model, as provider/model (such as ollama/qwen3-coder).',
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
    // A profile of its own: OMP's stored logins (a Claude or ChatGPT one included) don't exist there.
    env.PI_CODING_AGENT_DIR = join(dirname(ws), 'omp-profile');
    env.CLAUDE_CONFIG_DIR = join(ws, '.claude-home');
    for (const k of OMP_BORROWED) env[k] = null;
    if (auth.kind === 'api-key') {
      const name = KEY_ENV[auth.provider];
      if (!name)
        verdict = {
          allowed: false,
          reason: `Hildegard doesn’t know where OMP reads a ${auth.provider} key. Use one of: ${Object.keys(KEY_ENV).join(', ')}.`,
        };
      else env[name] = input.key!;
    }
    args = ['-p', '--no-session', '--model', input.model ?? '', input.task];
    stdin = null;
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
  if (input.agent === 'omp') {
    mkdirSync(join(ws, '.claude-home'), { recursive: true });
    writeFileSync(
      join(ws, '.claude-home', '.claude.json'),
      `${JSON.stringify({ mcpServers: { hildegard: server } }, null, 2)}\n`,
    );
    mkdirSync(join(dirname(ws), 'omp-profile'), { recursive: true, mode: 0o700 });
  }
  if (input.skillsDir && existsSync(input.skillsDir)) {
    // Claude Code and OMP read .claude/skills; Codex reads .agents/skills.
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
  if (agent === 'omp') return line.trim() ? [{ kind: 'text', text: line }] : [];
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
  const env: NodeJS.ProcessEnv = { ...sys.env };
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
      if (e.kind === 'text') final = agent === 'omp' ? `${final}${final ? '\n' : ''}${e.text}` : e.text;
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

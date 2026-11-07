// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Which coding agents are installed, and how each is signed in, asked of the agents themselves (`claude auth status`,
 * `codex login status`). Hildegard never opens their credential files: it only needs to know the kind of sign-in.
 */
import { execFile, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onPath } from '@hildegard/runtime';
import { inherited, PI_ENV } from './env.ts';
import type { AgentId, Auth } from './policy.ts';

/** What detection needs from the computer; tests give their own. */
export interface Sys {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** Whether a program is on PATH. */
  has(cmd: string): boolean;
  /** Runs a program and gives back its exit status, everything it printed, and its standard output alone. */
  run(
    cmd: string,
    args: string[],
    env?: NodeJS.ProcessEnv,
  ): { status: number | null; out: string; stdout?: string };
  /** Like `run`, without holding the process: agents are asked together. Detection falls back to `run` without it. */
  runAsync?(
    cmd: string,
    args: string[],
    env?: NodeJS.ProcessEnv,
  ): Promise<{ status: number | null; out: string; stdout?: string }>;
}

export const system = (): Sys => ({
  env: process.env,
  platform: process.platform,
  has: (cmd) => onPath(cmd),
  run(cmd, args, env) {
    const r = spawnSync(cmd, args, {
      ...(env ? { env } : {}),
      encoding: 'utf8',
      timeout: 20_000,
      windowsHide: true,
      // Windows finds npm-installed CLIs (claude.cmd, codex.cmd) only through the shell.
      shell: process.platform === 'win32',
    });
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, stdout: r.stdout ?? '' };
  },
  runAsync(cmd, args, env) {
    return new Promise((resolve) => {
      execFile(
        cmd,
        args,
        {
          ...(env ? { env } : {}),
          encoding: 'utf8',
          timeout: 20_000,
          windowsHide: true,
          shell: process.platform === 'win32',
        },
        (err, stdout, stderr) => {
          const code = (err as { code?: unknown } | null)?.code;
          resolve({
            status: !err ? 0 : typeof code === 'number' ? code : null,
            out: `${stdout ?? ''}${stderr ?? ''}`,
            stdout: stdout ?? '',
          });
        },
      );
    });
  },
});

export interface Detected {
  agent: AgentId;
  name: string;
  installed: boolean;
  /** How the agent itself is signed in, before Hildegard adds a key of its own. */
  auth: Auth;
  /** What the agent said, for the owner; never credentials. */
  detail: string;
}

export const NAMES: Record<AgentId, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  omp: 'OMP (oh my pi)',
  pi: 'Pi',
};
export const COMMANDS: Record<AgentId, string> = {
  'claude-code': 'claude',
  codex: 'codex',
  omp: 'omp',
  pi: 'pi',
};

/** Providers OMP and Pi reach on the owner's own computers. */
export const LOCAL_PROVIDERS = new Set([
  'ollama',
  'llama.cpp',
  'llamacpp',
  'lm-studio',
  'lmstudio',
  'vllm',
  'hildegard',
]);

/** The environment variable each API provider's key goes in, for OMP and Pi; Claude Code and Codex have their own. */
export const KEY_ENV: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  google: 'GEMINI_API_KEY',
  groq: 'GROQ_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  xai: 'XAI_API_KEY',
  mistral: 'MISTRAL_API_KEY',
};

type Ran = ReturnType<Sys['run']>;

/** Claude Code's cloud-provider settings are in the environment: nothing to ask it. */
function claudeCloud(e: Sys): { auth: Auth; detail: string } | null {
  if (e.env.CLAUDE_CODE_USE_BEDROCK)
    return { auth: { kind: 'cloud', provider: 'bedrock' }, detail: 'Amazon Bedrock' };
  if (e.env.CLAUDE_CODE_USE_VERTEX)
    return { auth: { kind: 'cloud', provider: 'vertex' }, detail: 'Google Vertex AI' };
  if (e.env.CLAUDE_CODE_USE_FOUNDRY)
    return { auth: { kind: 'cloud', provider: 'foundry' }, detail: 'Microsoft Foundry' };
  return null;
}

/** What `claude auth status --json` said (null when it couldn't be run), as a sign-in. */
function claudeFrom(r: Ran | null): { auth: Auth; detail: string } {
  let s: { loggedIn?: boolean; authMethod?: string; apiProvider?: string };
  try {
    if (!r) throw new Error('not run');
    s = JSON.parse(r.out.slice(r.out.indexOf('{')));
  } catch {
    return {
      auth: { kind: 'none' },
      detail: 'Claude Code didn’t say how it’s signed in. Run `claude auth status`.',
    };
  }
  const provider = (s.apiProvider ?? 'firstParty').toLowerCase();
  if (provider.includes('bedrock'))
    return { auth: { kind: 'cloud', provider: 'bedrock' }, detail: 'Amazon Bedrock' };
  if (provider.includes('vertex'))
    return { auth: { kind: 'cloud', provider: 'vertex' }, detail: 'Google Vertex AI' };
  if (provider.includes('foundry'))
    return { auth: { kind: 'cloud', provider: 'foundry' }, detail: 'Microsoft Foundry' };
  if (!s.loggedIn) return { auth: { kind: 'none' }, detail: 'Claude Code isn’t signed in.' };
  const method = (s.authMethod ?? '').toLowerCase();
  // Only a key is a key; anything else (claude.ai, an OAuth token, something new) is treated as the subscription.
  if (method.includes('api_key') || method.includes('apikey'))
    return {
      auth: { kind: 'api-key', provider: 'anthropic' },
      detail: 'Signed in with an Anthropic API key.',
    };
  return { auth: { kind: 'subscription', plan: 'claude' }, detail: 'Signed in with a Claude plan.' };
}

function claudeAuth(e: Sys): { auth: Auth; detail: string } {
  const cloud = claudeCloud(e);
  if (cloud) return cloud;
  let r: Ran | null = null;
  try {
    r = e.run('claude', ['auth', 'status', '--json']);
  } catch {}
  return claudeFrom(r);
}

/** What `codex login status` said, as a sign-in. */
function codexFrom({ status, out }: Ran): { auth: Auth; detail: string } {
  if (/not logged in/i.test(out) || (status !== 0 && !/logged in/i.test(out)))
    return {
      auth: { kind: 'none' },
      detail: 'Codex isn’t signed in, or didn’t say. Run `codex login status`.',
    };
  if (/api key/i.test(out))
    return { auth: { kind: 'api-key', provider: 'openai' }, detail: 'Signed in with an OpenAI API key.' };
  if (/chatgpt/i.test(out))
    return { auth: { kind: 'subscription', plan: 'chatgpt' }, detail: 'Signed in with a ChatGPT plan.' };
  return { auth: { kind: 'subscription', plan: 'chatgpt' }, detail: 'Signed in; treated as a ChatGPT plan.' };
}

function codexAuth(e: Sys): { auth: Auth; detail: string } {
  return codexFrom(e.run('codex', ['login', 'status']));
}

/**
 * Every agent and its sign-in. OMP and Pi have no sign-in of their own here: Hildegard runs them with a fresh profile, so their own
 * logins (including any Claude or ChatGPT one) never apply, and only the key or local model Hildegard gives it counts.
 */
export function detectAgents(e: Sys = system()): Detected[] {
  return (['claude-code', 'codex', 'omp', 'pi'] as const).map((agent) => detectAgent(agent, e));
}

/** One agent and its sign-in, asking only that agent: a Claude Code run never starts whatever `pi` is. */
export function detectAgent(agent: AgentId, e: Sys = system()): Detected {
  const name = NAMES[agent];
  const installed = e.has(COMMANDS[agent]);
  if (installed && agent === 'pi' && !isPiAgent(e))
    return {
      agent,
      name,
      installed: false,
      auth: { kind: 'none' },
      detail:
        'A program called `pi` is on your PATH, but it isn’t the Pi coding agent (`pi --version` didn’t answer with a version).',
    };
  if (!installed)
    return { agent, name, installed, auth: { kind: 'none' }, detail: `${name} isn’t installed.` };
  const { auth, detail } =
    agent === 'claude-code'
      ? claudeAuth(e)
      : agent === 'codex'
        ? codexAuth(e)
        : {
            auth: { kind: 'none' } as Auth,
            detail: 'Runs with a key or local model that Hildegard gives it.',
          };
  return { agent, name, installed, auth, detail };
}

/**
 * Every agent and its sign-in, asked together: Claude Code and Codex each take a few hundred milliseconds to say how
 * they are signed in, so the answer takes as long as the slowest one, not all of them.
 */
export function detectAgentsAsync(e: Sys = system()): Promise<Detected[]> {
  return Promise.all(
    (['claude-code', 'codex', 'omp', 'pi'] as const).map((agent) => detectAgentAsync(agent, e)),
  );
}

/** `detectAgent`, without holding the process while the agent answers. */
export async function detectAgentAsync(agent: AgentId, e: Sys = system()): Promise<Detected> {
  const name = NAMES[agent];
  const installed = e.has(COMMANDS[agent]);
  if (installed && agent === 'pi' && !(await isPiAgentAsync(e)))
    return {
      agent,
      name,
      installed: false,
      auth: { kind: 'none' },
      detail:
        'A program called `pi` is on your PATH, but it isn’t the Pi coding agent (`pi --version` didn’t answer with a version).',
    };
  if (!installed)
    return { agent, name, installed, auth: { kind: 'none' }, detail: `${name} isn’t installed.` };
  const run = runAsync(e);
  const { auth, detail } =
    agent === 'claude-code'
      ? (claudeCloud(e) ?? claudeFrom(await run('claude', ['auth', 'status', '--json']).catch(() => null)))
      : agent === 'codex'
        ? codexFrom(await run('codex', ['login', 'status']))
        : {
            auth: { kind: 'none' } as Auth,
            detail: 'Runs with a key or local model that Hildegard gives it.',
          };
  return { agent, name, installed, auth, detail };
}

/**
 * Whether `pi` on PATH is the Pi coding agent, not another program of that name (Debian's `pi` prints digits of π):
 * the coding agent answers `pi --version` with its version number alone.
 */
export function isPiAgent(e: Sys): boolean {
  return withPiProbe(e, (env) => piFrom(e.run('pi', ['--version'], env)));
}

/** The same question, asked without holding the process. */
async function isPiAgentAsync(e: Sys): Promise<boolean> {
  const probe = piProbeDir();
  try {
    return piFrom(await runAsync(e)('pi', ['--version'], piProbeEnv(e, probe)));
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

// Asked with the same short environment a run gets: an unknown `pi` sees no sign-in or key of the owner's, and an
// empty agent folder of its own that no one else could have put anything in.
const piProbeDir = () => mkdtempSync(join(tmpdir(), 'hildegard-pi-probe-'));
const piProbeEnv = (e: Sys, probe: string): NodeJS.ProcessEnv => ({
  ...inherited(e.env, PI_ENV, e.platform === 'win32'),
  PI_SKIP_VERSION_CHECK: '1',
  PI_TELEMETRY: '0',
  PI_CODING_AGENT_DIR: probe,
});

function withPiProbe<T>(e: Sys, f: (env: NodeJS.ProcessEnv) => T): T {
  const probe = piProbeDir();
  try {
    return f(piProbeEnv(e, probe));
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

function piFrom({ status, out, stdout }: Ran): boolean {
  // Node may warn on stderr (a deprecation, say); the version is the first line Pi prints on stdout.
  const first = (stdout ?? out).split('\n').find((l) => l.trim()) ?? '';
  return status === 0 && /^v?\d+\.\d+\.\d+(?:[-+][\w.]+)?$/.test(first.trim());
}

const runAsync = (e: Sys): NonNullable<Sys['runAsync']> =>
  e.runAsync ?? ((cmd, args, env) => Promise.resolve(e.run(cmd, args, env)));

/** The provider of an OMP or Pi model selector such as `openrouter/qwen/qwen3-coder` or `ollama/llama3.3`. */
export function providerOf(model: string): string {
  return model.split('/')[0]!.toLowerCase();
}

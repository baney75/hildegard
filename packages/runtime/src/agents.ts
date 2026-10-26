// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Links Hildegard's MCP server into the AI apps on this computer, by adding one entry to each app's own MCP config
 * and touching nothing else in it. Every change can be undone with `hildegard disconnect`.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { resource, type Step } from './install.ts';

export interface McpCommand {
  command: string;
  args: string[];
  /** Only when Hildegard isn't on its default address. */
  env?: Record<string, string>;
}

/**
 * How an app starts Hildegard's MCP server: this Node and the `hildegard` entry script, by absolute path, so it works
 * from apps that don't see the shell's PATH (Claude Desktop on macOS, anything on Windows).
 */
export function mcpCommand(opts: { entry?: string; url?: string; remote?: string } = {}): McpCommand {
  const entry = opts.entry ?? process.env.HILDEGARD_ENTRY ?? resource(join('apps', 'cli', 'src', 'main.ts'));
  // A Hildegard on another device: `hildegard mcp --remote` carries the app's messages there, with the key kept in
  // this computer's keychain, never in the app's config.
  if (opts.remote) return { command: process.execPath, args: [entry, 'mcp', '--remote', opts.remote] };
  const url = opts.url?.replace(/\/$/, '');
  return {
    command: process.execPath,
    args: [entry, 'mcp'],
    ...(url && url !== 'http://127.0.0.1:7341' ? { env: { HILDEGARD_URL: url } } : {}),
  };
}

export interface AgentEnv {
  home: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** Whether a program is on PATH. */
  has(cmd: string): boolean;
  /** Runs a program; throws on failure. */
  exec(cmd: string, args: string[]): string;
}

export const systemAgentEnv = (): AgentEnv => ({
  home: homedir(),
  platform: process.platform,
  env: process.env,
  has(cmd) {
    try {
      execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  },
  exec(cmd, args) {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
  },
});

type Format = 'mcpServers' | 'vscode' | 'opencode' | 'codex';

interface AgentDef {
  id: string;
  name: string;
  format: Format;
  /** The config file Hildegard edits. */
  file(e: AgentEnv): string;
  /** Whether the app looks installed. */
  present(e: AgentEnv): boolean;
  /** Use the app's own CLI instead of editing its file, when it has one. */
  cli?: { cmd: string; add(m: McpCommand): string[]; remove: string[] };
  /** Said after linking: what the owner does so the app picks it up. */
  after: string;
  /**
   * How this app may sign in to a model without breaking anyone's terms (docs/agent-terms.md). A Claude or ChatGPT
   * plan belongs only in its own app; every other app needs an API key or a local model.
   */
  signIn: string;
}

const PLAN_OWN = (plan: string) =>
  `Your ${plan} plan is fine here: this is its own app. Hildegard’s tools add nothing to what it bills.`;
const KEY_ONLY =
  'Sign it in with an API key or point it at a local model. A Claude or ChatGPT plan’s login in this app breaks those plans’ terms and can get the account banned.';
const OWN_ACCOUNT = (who: string) =>
  `It uses your own ${who} account, under its terms. Hildegard’s tools add nothing to what it bills.`;

const appData = (e: AgentEnv) => e.env.APPDATA ?? join(e.home, 'AppData', 'Roaming');
const xdgConfig = (e: AgentEnv) => e.env.XDG_CONFIG_HOME ?? join(e.home, '.config');
/** Where desktop apps keep settings: Application Support, %APPDATA% or ~/.config. */
const appConfig = (e: AgentEnv, ...rest: string[]) =>
  e.platform === 'darwin'
    ? join(e.home, 'Library', 'Application Support', ...rest)
    : e.platform === 'win32'
      ? join(appData(e), ...rest)
      : join(xdgConfig(e), ...rest);

export const AGENTS: AgentDef[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    format: 'mcpServers',
    file: (e) => join(e.home, '.claude.json'),
    present: (e) => e.has('claude') || existsSync(join(e.home, '.claude.json')),
    cli: {
      cmd: 'claude',
      add: (m) => [
        'mcp',
        'add',
        '--scope',
        'user',
        ...Object.entries(m.env ?? {}).flatMap(([k, v]) => ['--env', `${k}=${v}`]),
        'hildegard',
        '--',
        m.command,
        ...m.args,
      ],
      remove: ['mcp', 'remove', '--scope', 'user', 'hildegard'],
    },
    after: 'Start a new Claude Code session to use it.',
    signIn: PLAN_OWN('Claude'),
  },
  {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    format: 'mcpServers',
    file: (e) => appConfig(e, 'Claude', 'claude_desktop_config.json'),
    present: (e) => existsSync(appConfig(e, 'Claude')),
    after: 'Quit and reopen Claude Desktop to use it.',
    signIn: PLAN_OWN('Claude'),
  },
  {
    id: 'codex',
    name: 'Codex',
    format: 'codex',
    file: (e) => join(e.env.CODEX_HOME ?? join(e.home, '.codex'), 'config.toml'),
    present: (e) => e.has('codex') || existsSync(e.env.CODEX_HOME ?? join(e.home, '.codex')),
    after: 'Start a new Codex session to use it.',
    signIn: PLAN_OWN('ChatGPT'),
  },
  {
    id: 'cursor',
    name: 'Cursor',
    format: 'mcpServers',
    file: (e) => join(e.home, '.cursor', 'mcp.json'),
    present: (e) => existsSync(join(e.home, '.cursor')),
    after: 'Cursor picks it up on its own; check Settings, MCP if it doesn’t.',
    signIn: OWN_ACCOUNT('Cursor'),
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    format: 'opencode',
    file: (e) => join(xdgConfig(e), 'opencode', 'opencode.json'),
    present: (e) => e.has('opencode') || existsSync(join(xdgConfig(e), 'opencode')),
    after: 'Start a new OpenCode session to use it.',
    signIn: KEY_ONLY,
  },
  {
    id: 'omp',
    name: 'OMP',
    format: 'mcpServers',
    file: (e) => join(e.home, '.omp', 'agent', 'mcp.json'),
    present: (e) => e.has('omp') || existsSync(join(e.home, '.omp')),
    after: 'Start a new OMP session, or run /mcp reload in one.',
    signIn: KEY_ONLY,
  },
  {
    id: 'pi',
    name: 'Pi',
    format: 'mcpServers',
    // Pi 0.99 and later read MCP servers from here natively, as does pi-mcp-adapter.
    file: (e) => join(e.env.PI_CODING_AGENT_DIR ?? join(e.home, '.pi', 'agent'), 'mcp.json'),
    present: (e) => e.has('pi') || existsSync(e.env.PI_CODING_AGENT_DIR ?? join(e.home, '.pi', 'agent')),
    after: 'Start a new Pi session to use it (Pi 0.99 or later, or with pi-mcp-adapter).',
    signIn: KEY_ONLY,
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    format: 'mcpServers',
    file: (e) => join(e.home, '.gemini', 'settings.json'),
    present: (e) => e.has('gemini') || existsSync(join(e.home, '.gemini')),
    after: 'Start a new Gemini CLI session; /mcp lists Hildegard’s tools.',
    signIn: OWN_ACCOUNT('Google'),
  },
  {
    id: 'vscode',
    name: 'VS Code',
    format: 'vscode',
    file: (e) => appConfig(e, 'Code', 'User', 'mcp.json'),
    present: (e) => existsSync(appConfig(e, 'Code', 'User')),
    after: 'In VS Code, start it from the MCP Servers list or the chat’s tools menu.',
    signIn: OWN_ACCOUNT('GitHub Copilot'),
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    format: 'mcpServers',
    file: (e) => join(e.home, '.codeium', 'windsurf', 'mcp_config.json'),
    present: (e) => existsSync(join(e.home, '.codeium', 'windsurf')),
    after: 'Refresh the MCP list in Windsurf’s Cascade panel to use it.',
    signIn: OWN_ACCOUNT('Windsurf'),
  },
  {
    id: 'lm-studio',
    name: 'LM Studio',
    format: 'mcpServers',
    file: (e) => join(e.home, '.lmstudio', 'mcp.json'),
    present: (e) => existsSync(join(e.home, '.lmstudio')),
    after: 'LM Studio loads it on its own; local models can then use Hildegard’s tools.',
    signIn: 'Local models, on your own computer: no account and no terms to break.',
  },
];

export interface AgentStatus {
  id: string;
  name: string;
  installed: boolean;
  connected: boolean;
  file: string;
  signIn: string;
}

export function listAgents(e: AgentEnv = systemAgentEnv()): AgentStatus[] {
  return AGENTS.map((a) => ({
    id: a.id,
    name: a.name,
    installed: a.present(e),
    connected: isConnected(a, e),
    file: a.file(e),
    signIn: a.signIn,
  }));
}

export function findAgent(id: string): AgentDef | undefined {
  const k = id.toLowerCase().replace(/[\s_]+/g, '-');
  const alias: Record<string, string> = {
    'oh-my-pi': 'omp',
    'gemini-cli': 'gemini',
    'pi-coding-agent': 'pi',
  };
  return AGENTS.find((a) => a.id === (alias[k] ?? k) || a.name.toLowerCase() === id.toLowerCase());
}

function isConnected(a: AgentDef, e: AgentEnv): boolean {
  const text = read(a.file(e));
  if (text === null) return false;
  if (a.format === 'codex') return /^\[mcp_servers\.hildegard\]/m.test(text);
  try {
    const j = JSON.parse(text) as Record<string, Record<string, unknown> | undefined>;
    const key = a.format === 'vscode' ? 'servers' : a.format === 'opencode' ? 'mcp' : 'mcpServers';
    return Boolean(j[key]?.hildegard);
  } catch {
    return false;
  }
}

/** The config entry, as each format wants it: for showing to people who'd rather paste it themselves. */
export function snippet(format: Format, m: McpCommand): string {
  switch (format) {
    case 'codex':
      return tomlBlock(m);
    case 'opencode':
      return JSON.stringify(
        {
          mcp: {
            hildegard: {
              type: 'local',
              command: [m.command, ...m.args],
              enabled: true,
              ...envOf(m, 'environment'),
            },
          },
        },
        null,
        2,
      );
    case 'vscode':
      return JSON.stringify({ servers: { hildegard: { type: 'stdio', ...entry(m) } } }, null, 2);
    default:
      return JSON.stringify({ mcpServers: { hildegard: entry(m) } }, null, 2);
  }
}

const envOf = (m: McpCommand, key = 'env') => (m.env && Object.keys(m.env).length ? { [key]: m.env } : {});
const entry = (m: McpCommand) => ({ command: m.command, args: m.args, ...envOf(m) });

function tomlBlock(m: McpCommand): string {
  const s = (v: string) => JSON.stringify(v);
  const lines = [
    '[mcp_servers.hildegard]',
    `command = ${s(m.command)}`,
    `args = [${m.args.map(s).join(', ')}]`,
  ];
  if (m.env && Object.keys(m.env).length)
    lines.push(
      `env = { ${Object.entries(m.env)
        .map(([k, v]) => `${k} = ${s(v)}`)
        .join(', ')} }`,
    );
  return `${lines.join('\n')}\n`;
}

/** Removes `[mcp_servers.hildegard]` and its sub-tables from a TOML file's text. */
function dropTomlBlock(text: string): string {
  const out: string[] = [];
  let skipping = false;
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[\[?([^\]]+)\]\]?\s*(#.*)?$/.exec(line);
    if (header) skipping = /^mcp_servers\.(hildegard|"hildegard")(\.|$)/.test(header[1]!.trim());
    if (!skipping) out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * Whether Claude Code has the Hildegard plugin on (`/plugin install hildegard@hildegard`). The plugin starts this
 * computer's Hildegard itself, so a second entry would only list every tool twice.
 */
export function claudePluginEnabled(e: AgentEnv): boolean {
  const file = join(e.env.CLAUDE_CONFIG_DIR ?? join(e.home, '.claude'), 'settings.json');
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as { enabledPlugins?: Record<string, unknown> };
    return j.enabledPlugins?.['hildegard@hildegard'] === true;
  } catch {
    return false;
  }
}

export function connectAgent(id: string, m: McpCommand, e: AgentEnv = systemAgentEnv()): Step {
  const a = findAgent(id);
  if (!a)
    return {
      id: `connect-${id}`,
      title: `Link ${id}`,
      status: 'failed',
      detail: `Hildegard doesn’t know an app called “${id}”. It can link: ${AGENTS.map((x) => x.id).join(', ')}.`,
    };
  const base = { id: `connect-${a.id}`, title: `Link ${a.name}` };
  // Only this computer's Hildegard, on its own address: the plugin can't reach one elsewhere.
  if (a.id === 'claude-code' && !m.env && !m.args.includes('--remote') && claudePluginEnabled(e)) {
    if (a.cli && e.has(a.cli.cmd))
      try {
        e.exec(a.cli.cmd, a.cli.remove);
      } catch {}
    return {
      ...base,
      status: 'skipped',
      detail: 'The Hildegard plugin already links Claude Code to Hildegard, with its skills.',
    };
  }
  if (a.cli && e.has(a.cli.cmd)) {
    try {
      try {
        e.exec(a.cli.cmd, a.cli.remove);
      } catch {}
      e.exec(a.cli.cmd, a.cli.add(m));
      return { ...base, status: 'done', detail: `Added Hildegard to ${a.name}. ${a.after}` };
    } catch {
      // Fall through to editing the file, which is what the CLI does.
    }
  }
  return editConfig(
    a,
    e,
    (text) => {
      if (a.format === 'codex') {
        const kept = dropTomlBlock(text ?? '').trimEnd();
        return `${kept ? `${kept}\n\n` : ''}${tomlBlock(m)}`;
      }
      const j = text?.trim() ? (JSON.parse(text) as Record<string, unknown>) : {};
      if (a.format === 'opencode') {
        j.$schema ??= 'https://opencode.ai/config.json';
        j.mcp = {
          ...(j.mcp as object),
          hildegard: {
            type: 'local',
            command: [m.command, ...m.args],
            enabled: true,
            ...envOf(m, 'environment'),
          },
        };
      } else if (a.format === 'vscode')
        j.servers = { ...(j.servers as object), hildegard: { type: 'stdio', ...entry(m) } };
      else j.mcpServers = { ...(j.mcpServers as object), hildegard: entry(m) };
      return `${JSON.stringify(j, null, 2)}\n`;
    },
    `Added Hildegard to ${a.name}. ${a.after}`,
    snippet(a.format, m),
  );
}

export function disconnectAgent(id: string, e: AgentEnv = systemAgentEnv()): Step {
  const a = findAgent(id);
  if (!a)
    return {
      id: `disconnect-${id}`,
      title: `Unlink ${id}`,
      status: 'failed',
      detail: `No app called “${id}”.`,
    };
  const base = { id: `disconnect-${a.id}`, title: `Unlink ${a.name}` };
  if (!isConnected(a, e) && !(a.cli && e.has(a.cli.cmd)))
    return { ...base, status: 'skipped', detail: `${a.name} wasn’t linked.` };
  if (a.cli && e.has(a.cli.cmd)) {
    try {
      e.exec(a.cli.cmd, a.cli.remove);
      return { ...base, status: 'done', detail: `Removed Hildegard from ${a.name}.` };
    } catch {
      if (!isConnected(a, e)) return { ...base, status: 'skipped', detail: `${a.name} wasn’t linked.` };
    }
  }
  return editConfig(
    a,
    e,
    (text) => {
      if (a.format === 'codex') return `${dropTomlBlock(text ?? '').trimEnd()}\n`;
      const j = JSON.parse(text ?? '{}') as Record<string, Record<string, unknown> | undefined>;
      const key = a.format === 'vscode' ? 'servers' : a.format === 'opencode' ? 'mcp' : 'mcpServers';
      if (j[key]) delete j[key].hildegard;
      return `${JSON.stringify(j, null, 2)}\n`;
    },
    `Removed Hildegard from ${a.name}.`,
  );
}

function editConfig(
  a: AgentDef,
  e: AgentEnv,
  change: (text: string | null) => string,
  done: string,
  paste?: string,
): Step {
  const unlink = paste === undefined;
  const base = unlink
    ? { id: `disconnect-${a.id}`, title: `Unlink ${a.name}` }
    : { id: `connect-${a.id}`, title: `Link ${a.name}` };
  const file = a.file(e);
  const text = read(file);
  let next: string;
  try {
    next = change(text);
  } catch {
    // The file isn't plain JSON (comments, a half-finished edit): leave it alone and show what to paste.
    return {
      ...base,
      status: 'needs-owner',
      detail: unlink
        ? `${file} has something Hildegard can’t safely edit, so it left it alone. Remove the “hildegard” entry from it.`
        : `${file} has something Hildegard can’t safely edit, so it left it alone. Add this to it:\n${paste}`,
    };
  }
  mkdirSync(dirname(file), { recursive: true });
  // One backup, of the file as it was before Hildegard ever touched it.
  if (text !== null && !existsSync(`${file}.before-hildegard`))
    copyFileSync(file, `${file}.before-hildegard`);
  const tmp = `${file}.hildegard-${process.pid}`;
  writeFileSync(tmp, next, { mode: 0o600 });
  renameSync(tmp, file);
  return { ...base, status: 'done', detail: done };
}

function read(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

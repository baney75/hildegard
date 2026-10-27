// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `hildegard agents`, `hildegard skills` and `hildegard review`: coding agents run only in the ways their providers
 * allow (packages/agents), Hildegard's skills installed where they look, and the media checks from a terminal.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  type AgentId,
  COMMANDS,
  decide,
  detectAgents,
  installSkills,
  isPiFamily,
  KEY_ENV,
  type LaunchInput,
  listSkills,
  NAMES,
  Pacer,
  PI_TOOLS,
  plan,
  prepareWorkspace,
  providerOf,
  removeSkills,
  run,
  type SkillTarget,
  skillRoots,
  type Trigger,
} from '@hildegard/agents';
import { describeReview, reviewMedia } from '@hildegard/craft';
import { listAgents, mcpCommand, resource, type Step } from '@hildegard/runtime';
import { secretStores, VERSION } from '@hildegard/server';
import type { Ctx } from './commands.ts';
import { readStdin } from './commands.ts';
import { dim, type Result, result } from './output.ts';

const AGENT_IDS: AgentId[] = ['claude-code', 'codex', 'omp', 'pi'];
const ALIASES: Record<string, AgentId> = {
  claude: 'claude-code',
  'claude-code': 'claude-code',
  codex: 'codex',
  omp: 'omp',
  'oh-my-pi': 'omp',
  pi: 'pi',
};

const settingsFile = (ctx: Ctx) => join(ctx.config.dataDir, 'agents', 'settings.json');
function settings(ctx: Ctx): { shareKeysWithDirectors: boolean } {
  try {
    return { shareKeysWithDirectors: false, ...JSON.parse(readFileSync(settingsFile(ctx), 'utf8')) };
  } catch {
    return { shareKeysWithDirectors: false };
  }
}
const keys = async (ctx: Ctx) => await secretStores(join(ctx.config.dataDir, 'secrets'));
const keyAccount = (provider: string) => `agent-key-${provider}`;

export function skillsDir(): string | null {
  try {
    return resource('skills');
  } catch {
    return null;
  }
}

/**
 * `hildegard agents [check|key|run|share-keys]`. Every run is decided first by the providers' terms; a run they don't
 * allow never starts, and the result says why and what would make it allowed.
 */
export async function agents(ctx: Ctx, args: string[]): Promise<Result> {
  const action = args[0] ?? 'check';
  if (action === 'check') return check(ctx);
  if (action === 'key') return key(ctx, args.slice(1));
  if (action === 'share-keys') return shareKeys(ctx, args[1]);
  if (action === 'run') return runAgent(ctx, args.slice(1));
  return result(
    [
      {
        id: 'agents',
        title: 'Agents',
        status: 'failed',
        detail: `Unknown action “${action}”. Use check, key, run or share-keys.`,
      },
    ],
    'Nothing changed.',
  );
}

async function check(ctx: Ctx): Promise<Result> {
  const detected = detectAgents();
  const store = await keys(ctx);
  const held = Object.keys(KEY_ENV).filter((p) => !!store(keyAccount(p)).get());
  const opts = settings(ctx);
  const steps: Step[] = detected.map((d) => {
    if (!d.installed)
      // Detection says why: not on PATH, or a `pi` that isn't the coding agent.
      return {
        id: d.agent,
        title: d.name,
        status: 'skipped',
        detail: d.detail || `${d.name} isn’t installed.`,
      };
    const lines: string[] = [d.detail];
    if (!isPiFamily(d.agent)) {
      const own = (t: Trigger) => decide(d.agent, d.auth, t, opts);
      lines.push(
        `Runs you start: ${own('owner-here').allowed ? 'yes' : 'no'}, with its own sign-in. Scheduled runs: ${own('schedule').allowed ? 'yes' : 'no'}.`,
      );
      if (!own('schedule').allowed && d.auth.kind === 'subscription') lines.push(own('schedule').reason);
    } else
      lines.push(
        `${d.agent === 'omp' ? 'OMP' : d.name} runs only with an API key or a local model, never with a Claude or ChatGPT login.`,
        ...(d.agent === 'pi'
          ? [
              'Pi has no sandbox: its file tools reach anything your account can. Hildegard runs it only when you start it with --unsandboxed, never on a schedule.',
              `It gets ${PI_TOOLS.filter((t) => !t.startsWith('mcp__')).join(', ')} and Hildegard’s tools, in a fresh profile, with no shell.`,
            ]
          : []),
      );
    const keyFor = d.agent === 'claude-code' ? 'anthropic' : d.agent === 'codex' ? 'openai' : null;
    if (keyFor)
      lines.push(
        held.includes(keyFor)
          ? `Your ${keyFor} key is in the keychain, for scheduled runs.`
          : `No ${keyFor} key held.`,
      );
    return { id: d.agent, title: d.name, status: 'done', detail: lines.join('\n') };
  });
  return result(
    steps,
    'Hildegard runs these agents only in the ways their providers allow. docs/agent-terms.md explains each.',
    {
      agents: detected.map((d) => ({
        id: d.agent,
        installed: d.installed,
        auth: d.auth,
        startedByYou:
          d.installed &&
          (isPiFamily(d.agent) ? held.length > 0 : decide(d.agent, d.auth, 'owner-here', opts).allowed),
        scheduled: d.installed && !isPiFamily(d.agent) && decide(d.agent, d.auth, 'schedule', opts).allowed,
        // Pi runs only when the owner passes --unsandboxed themselves.
        ...(d.agent === 'pi' ? { needs: '--unsandboxed' } : {}),
      })),
      keys: held,
      shareKeysWithDirectors: opts.shareKeysWithDirectors,
    },
  );
}

async function key(ctx: Ctx, args: string[]): Promise<Result> {
  const provider = args[0];
  if (!provider || !KEY_ENV[provider])
    return result(
      [
        {
          id: 'key',
          title: 'API key',
          status: 'failed',
          detail: `Name the provider: ${Object.keys(KEY_ENV).join(', ')}.`,
        },
      ],
      'Nothing changed.',
    );
  const store = (await keys(ctx))(keyAccount(provider));
  if (ctx.flags.has('remove')) {
    store.delete();
    return result(
      [
        {
          id: 'key',
          title: `Forget the ${provider} key`,
          status: 'done',
          detail: 'Removed from the keychain.',
        },
      ],
      'Done.',
    );
  }
  if (!ctx.flags.has('key-stdin'))
    return result(
      [
        {
          id: 'key',
          title: `Add your ${provider} API key`,
          status: 'needs-owner',
          detail:
            'Keys never go on the command line, where they land in shell history. Pipe it in; it goes to your system keychain.',
          command: `printf %s "$KEY" | hildegard agents key ${provider} --key-stdin --json`,
        },
      ],
      'Waiting for the key.',
    );
  const value = await readStdin();
  if (!/^\S{16,}$/.test(value))
    return result(
      [{ id: 'key', title: 'API key', status: 'failed', detail: 'That doesn’t look like an API key.' }],
      'Nothing changed.',
    );
  store.set(value);
  return result(
    [
      {
        id: 'key',
        title: `Keep your ${provider} API key`,
        status: 'done',
        detail: `Kept in ${store.kind === 'keychain' ? 'your system keychain' : 'a file only you can read'}. Usage is billed to your ${provider} account.`,
      },
    ],
    'Done.',
  );
}

function shareKeys(ctx: Ctx, value: string | undefined): Promise<Result> | Result {
  if (value !== 'on' && value !== 'off')
    return result(
      [
        {
          id: 'share-keys',
          title: 'Share keys',
          status: 'done',
          detail: `People you invite ${settings(ctx).shareKeysWithDirectors ? 'may' : 'may not'} use your API keys, never an Anthropic one (Anthropic requires their own). \`on\` or \`off\` changes it.`,
        },
      ],
      '',
    );
  mkdirSync(join(ctx.config.dataDir, 'agents'), { recursive: true, mode: 0o700 });
  writeFileSync(
    settingsFile(ctx),
    JSON.stringify({ ...settings(ctx), shareKeysWithDirectors: value === 'on' }),
    { mode: 0o600 },
  );
  return result(
    [
      {
        id: 'share-keys',
        title: 'Share keys',
        status: 'done',
        detail:
          value === 'on'
            ? 'People you invite may run agents on your API keys, billed to you. Never charge them for it. Subscriptions are never shared.'
            : 'Only you can run agents on your keys.',
      },
    ],
    'Done.',
  );
}

async function runAgent(ctx: Ctx, args: string[]): Promise<Result> {
  const task = ctx.flags.has('task-stdin') ? await readStdin() : args.slice(1).join(' ').trim();
  return runAgentTask(ctx, args[0] ?? '', task);
}

/**
 * Runs one coding agent on one task, if the provider's terms allow it. `extraTools` are tools a headless Claude Code
 * may use beyond the usual ones (a loop's modeling programs, say); Codex and OMP work inside their own sandboxes, and
 * Pi gets only file tools and Hildegard's, with no shell.
 */
export async function runAgentTask(
  ctx: Ctx,
  name: string,
  task: string,
  extraTools: string[] = [],
): Promise<Result> {
  const agent = ALIASES[name];
  if (!agent)
    return result(
      [
        {
          id: 'run',
          title: 'Run an agent',
          status: 'failed',
          detail: `Name the agent: ${AGENT_IDS.join(', ')}.`,
        },
      ],
      'Nothing ran.',
    );
  if (!task)
    return result(
      [
        {
          id: 'run',
          title: 'Run an agent',
          status: 'failed',
          detail: 'Say what it should do, or pipe it in with --task-stdin.',
        },
      ],
      'Nothing ran.',
    );
  const use = (ctx.opts.get('use') ?? (isPiFamily(agent) ? 'key' : 'own-sign-in')) as LaunchInput['use'];
  const model = ctx.opts.get('model');
  // OMP and Pi send the task to the provider their model names, so that's where their key comes from; a --provider
  // that names another is refused when the run is planned.
  const provider = isPiFamily(agent)
    ? ctx.opts.get('provider')
    : (ctx.opts.get('provider') ?? (agent === 'codex' ? 'openai' : 'anthropic'));
  const keyProvider = isPiFamily(agent) && model ? providerOf(model) : provider;
  const trigger: Trigger = ctx.flags.has('unattended') ? 'schedule' : 'owner-here';
  const id = randomUUID().slice(0, 8);
  const workspace = resolve(ctx.opts.get('workspace') ?? join(ctx.config.dataDir, 'agents', 'runs', id));
  const input: LaunchInput = {
    agent,
    task,
    trigger,
    use,
    provider,
    key:
      use === 'key' && keyProvider
        ? ((await keys(ctx))(keyAccount(keyProvider)).get() ?? undefined)
        : undefined,
    model,
    workspace,
    mcp: mcpCommand({ url: `http://127.0.0.1:${ctx.config.port}` }),
    skillsDir: skillsDir() ?? undefined,
    addDirs: ctx.opts.get('add-dir') ? [resolve(ctx.opts.get('add-dir')!)] : undefined,
    // Any --budget is checked when the run is planned: a non-number or 0 is refused, never dropped.
    // A --budget with no value after it lands in flags: Number.NaN, so the plan refuses it rather than dropping it.
    budgetUsd:
      ctx.opts.get('budget') !== undefined
        ? Number(ctx.opts.get('budget'))
        : ctx.flags.has('budget')
          ? Number.NaN
          : undefined,
    extraTools,
    unsandboxed: ctx.flags.has('unsandboxed'),
    piProfile: join(ctx.config.dataDir, 'agents', 'pi-profiles', id),
  };
  const detected = detectAgents().find((d) => d.agent === agent)!;
  const p = plan(input, detected, settings(ctx));
  const said = (s: Step['status'], detail: string, command?: string): Step => ({
    id: 'run',
    title: `Run ${NAMES[agent]}`,
    status: s,
    detail,
    command,
  });
  if (!p.verdict.allowed) {
    const fix = p.verdict.fix ? `\n${p.verdict.fix}` : '';
    const src = p.verdict.source ? `\nSource: ${p.verdict.source}` : '';
    return result(
      [said('needs-owner', `${p.verdict.reason}${fix}${src}`)],
      'Nothing ran: the provider’s terms don’t allow this run.',
      { policy: p.verdict },
    );
  }
  const pacer =
    p.auth.kind === 'subscription' ? new Pacer(join(ctx.config.dataDir, 'agents', 'pace.json')) : null;
  if (pacer) {
    const slot = pacer.claim();
    if (!slot.ok)
      return result([said('needs-owner', slot.reason)], 'Nothing ran yet.', {
        retryAt: slot.retryAt ? new Date(slot.retryAt).toISOString() : null,
      });
  }
  try {
    prepareWorkspace(input);
    if (!ctx.json) console.log(dim(`${NAMES[agent]} is working in ${workspace}. ${p.verdict.reason}`));
    const r = await run(p, workspace, (e) => {
      if (ctx.json) return;
      if (e.kind === 'tool') console.log(dim(`  · ${e.text}`));
    });
    return result(
      [
        said(
          r.ok ? 'done' : 'failed',
          r.final || (r.ok ? 'Finished.' : `${COMMANDS[agent]} stopped with code ${r.exitCode}.`),
        ),
      ],
      r.ok ? `${NAMES[agent]} finished.` : `${NAMES[agent]} didn’t finish.`,
      { workspace, costUsd: r.costUsd ?? null, policy: p.verdict },
    );
  } finally {
    pacer?.release();
    // A Pi profile is for one run: nothing it saved stays behind.
    if (agent === 'pi')
      rmSync(join(ctx.config.dataDir, 'agents', 'pi-profiles', id), { recursive: true, force: true });
  }
}

/** `hildegard skills [list|install|remove] [--agent claude-code|codex|omp|pi|all] [--project DIR]`. */
export function skills(ctx: Ctx, args: string[]): Result {
  const dir = skillsDir();
  if (!dir)
    return result(
      [
        {
          id: 'skills',
          title: 'Skills',
          status: 'failed',
          detail: 'This Hildegard has no skills folder. Reinstall it.',
        },
      ],
      '',
    );
  const action = args[0] ?? 'list';
  const all = listSkills(dir);
  if (action === 'list')
    return result(
      all.map((s) => ({ id: s.name, title: s.name, status: 'done' as const, detail: s.description })),
      '`hildegard skills install` puts them where Claude Code, Codex, OMP and Pi look.',
      { skills: all.map(({ name, description }) => ({ name, description })) },
    );
  const which = ctx.opts.get('agent') ?? 'all';
  const targets: SkillTarget[] =
    which === 'all'
      ? [
          'claude-code',
          'codex',
          ...(listAgents().find((a) => a.id === 'pi')?.installed ? (['pi'] as const) : []),
        ]
      : [ALIASES[which] ?? (which as SkillTarget)];
  const project = ctx.opts.get('project') ? resolve(ctx.opts.get('project')!) : undefined;
  const roots = [...new Set(targets.flatMap((t) => skillRoots(t, project)))];
  const outcomes = action === 'remove' ? removeSkills(dir, roots) : installSkills(dir, roots, VERSION);
  const steps: Step[] = outcomes.map((o) => ({
    id: o.skill,
    title: `${o.skill} → ${o.path}`,
    status: o.status === 'kept-yours' ? 'skipped' : 'done',
    detail:
      o.status === 'kept-yours'
        ? 'A skill of yours already has this name; left as it is.'
        : { installed: 'Installed.', updated: 'Updated.', removed: 'Removed.' }[o.status],
  }));
  return result(
    steps,
    action === 'remove'
      ? 'Removed Hildegard’s skills.'
      : 'Start a new session of your agent to pick them up.',
  );
}

/** The skills folder each linked app reads; apps not listed read the skills over MCP (list_skills, read_skill). */
const SKILL_FOLDER: Record<string, SkillTarget> = {
  'claude-code': 'claude-code',
  codex: 'codex',
  opencode: 'opencode',
  omp: 'omp',
  pi: 'pi',
  gemini: 'gemini',
};

/** After `hildegard connect`: Hildegard's skills where the apps just linked look for them. One step, or none. */
export function installSkillsFor(appIds: string[]): Step | null {
  const dir = skillsDir();
  const targets = [...new Set(appIds.map((id) => SKILL_FOLDER[id]).filter((t): t is SkillTarget => !!t))];
  if (!dir || !targets.length) return null;
  const roots = [...new Set(targets.flatMap((t) => skillRoots(t)))];
  const outcomes = installSkills(dir, roots, VERSION);
  const names = [...new Set(outcomes.filter((o) => o.status !== 'kept-yours').map((o) => o.skill))];
  const kept = [...new Set(outcomes.filter((o) => o.status === 'kept-yours').map((o) => o.skill))];
  return {
    id: 'skills',
    title: `Teach them Hildegard’s ${names.length} skills`,
    status: 'done',
    detail: `${names.join(', ')}, in ${roots.join(' and ')}.${kept.length ? ` Kept your own ${kept.join(', ')}.` : ''} Every other app reads them over MCP.`,
  };
}

/** `hildegard review <file> [--final] [--seconds N] [--audio] [--film] [--sheet out.jpg]`: the media checks. */
export async function review(ctx: Ctx, args: string[]): Promise<Result> {
  const file = args[0] ? resolve(args[0]) : '';
  if (!file || !existsSync(file))
    return result(
      [
        {
          id: 'review',
          title: 'Review',
          status: 'failed',
          detail: 'Give the path of a video, image or sound file.',
        },
      ],
      '',
    );
  const own = join(
    ctx.config.dataDir,
    'python',
    process.platform === 'win32' ? join('Scripts', 'python.exe') : join('bin', 'python'),
  );
  const python = existsSync(own)
    ? own
    : (process.env.HILDEGARD_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'));
  const sheet = ctx.opts.get('sheet') ? resolve(ctx.opts.get('sheet')!) : undefined;
  const r = await reviewMedia(python, resource(join('tools', 'review_media.py')), {
    path: file,
    sheet,
    final: ctx.flags.has('final'),
    seconds: ctx.opts.get('seconds') ? Number(ctx.opts.get('seconds')) : undefined,
    audio: ctx.flags.has('audio'),
    film: ctx.flags.has('film'),
  });
  const steps: Step[] = r.checks.map((c) => ({
    id: c.id,
    title: `${c.id}: ${JSON.stringify(c.value)}`,
    status: c.status === 'fail' ? 'failed' : c.status === 'warn' ? 'needs-owner' : 'done',
    detail: c.detail,
  }));
  return {
    ...result(steps, describeReview(r).split('\n')[0]!, { review: r, sheet: sheet ?? null }),
    ok: r.passed,
    needsOwner: false,
  };
}

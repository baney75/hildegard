// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type AgentId,
  type Auth,
  type Detected,
  decide,
  detectAgent,
  detectAgents,
  inherited,
  installSkills,
  isPiAgent,
  type LaunchInput,
  listSkills,
  ollamaBase,
  PACE,
  Pacer,
  PI_PROMPT,
  PI_TOOLS,
  parseLine,
  piProfile,
  plan,
  prepareWorkspace,
  removeSkills,
  run,
  type Sys,
  skillRoots,
  sweepProfiles,
  type Trigger,
} from '../src/index.ts';

const TRIGGERS: Trigger[] = ['owner-here', 'owner-remote', 'director', 'peer', 'schedule'];
const claudePlan: Auth = { kind: 'subscription', plan: 'claude' };
const chatgptPlan: Auth = { kind: 'subscription', plan: 'chatgpt' };
const allowedFor = (agent: AgentId, auth: Auth, opts = {}) =>
  TRIGGERS.filter((t) => decide(agent, auth, t, opts).allowed);

describe('policy: what each provider allows', () => {
  it('runs a subscription only in its own app, only for its owner, only when they asked just now', () => {
    expect(allowedFor('claude-code', claudePlan)).toEqual(['owner-here', 'owner-remote']);
    expect(allowedFor('codex', chatgptPlan)).toEqual(['owner-here', 'owner-remote']);
    // A plan never travels to another app.
    expect(allowedFor('codex', claudePlan)).toEqual([]);
    expect(allowedFor('claude-code', chatgptPlan)).toEqual([]);
    expect(allowedFor('omp', claudePlan)).toEqual([]);
    const shared = decide('claude-code', claudePlan, 'director');
    expect(shared.reason).toMatch(/sharing the account/);
    const looped = decide('codex', chatgptPlan, 'schedule');
    expect(looped.reason).toMatch(/ordinary, individual use/);
    expect(looped.fix).toMatch(/API key/);
    expect(decide('claude-code', claudePlan, 'owner-here').source).toBe(
      'https://code.claude.com/docs/en/legal-and-compliance',
    );
  });

  it('never uses a subscription login borrowed into another tool', () => {
    for (const provider of ['anthropic', 'openai', 'xai'])
      expect(allowedFor('omp', { kind: 'borrowed-login', provider })).toEqual([]);
    expect(decide('omp', { kind: 'borrowed-login', provider: 'anthropic' }, 'owner-here').reason).toMatch(
      /banned/,
    );
  });

  it('lets the owner’s own keys run anything for the owner, and others’ runs only on non-Anthropic keys when turned on', () => {
    const key: Auth = { kind: 'api-key', provider: 'anthropic' };
    expect(allowedFor('claude-code', key)).toEqual(['owner-here', 'owner-remote', 'schedule']);
    // Anthropic requires every user of Claude to bring their own credentials: sharing never covers it.
    expect(allowedFor('claude-code', key, { shareKeysWithDirectors: true })).toEqual([
      'owner-here',
      'owner-remote',
      'schedule',
    ]);
    expect(allowedFor('omp', key, { shareKeysWithDirectors: true })).not.toContain('director');
    expect(
      allowedFor('claude-code', { kind: 'cloud', provider: 'bedrock' }, { shareKeysWithDirectors: true }),
    ).not.toContain('director');
    const openai: Auth = { kind: 'api-key', provider: 'openai' };
    expect(allowedFor('codex', openai, { shareKeysWithDirectors: true })).toContain('director');
    expect(decide('codex', openai, 'director').fix).toMatch(/Never charge them/);
    expect(allowedFor('claude-code', { kind: 'cloud', provider: 'bedrock' })).toEqual([
      'owner-here',
      'owner-remote',
      'schedule',
    ]);
  });

  it('lets local models run for anyone a person started, and nothing run for fleet peers or without a sign-in', () => {
    expect(allowedFor('omp', { kind: 'local', provider: 'ollama' })).toEqual([
      'owner-here',
      'owner-remote',
      'director',
      'schedule',
    ]);
    for (const auth of [
      claudePlan,
      { kind: 'api-key', provider: 'openai' } as Auth,
      { kind: 'local', provider: 'ollama' } as Auth,
    ])
      expect(decide('codex', auth, 'peer').allowed).toBe(false);
    expect(allowedFor('claude-code', { kind: 'none' })).toEqual([]);
  });
});

describe('pacing subscription runs', () => {
  it('allows one at a time, with a gap, up to a daily ceiling', () => {
    const p = new Pacer(join(mkdtempSync(join(tmpdir(), 'hg-pace-')), 'pace.json'));
    const t0 = Date.parse('2026-10-24T10:00:00Z');
    expect(p.claim(t0).ok).toBe(true);
    expect(p.claim(t0 + 60_000)).toMatchObject({ ok: false, reason: expect.stringMatching(/One at a time/) });
    p.release();
    expect(p.claim(t0 + 1000)).toMatchObject({ ok: false, retryAt: t0 + PACE.gapMs });
    let t = t0;
    for (let i = 1; i < PACE.perDay; i++) {
      t += PACE.gapMs;
      expect(p.claim(t).ok).toBe(true);
      p.release();
    }
    expect(p.claim(t + PACE.gapMs)).toMatchObject({ ok: false, reason: expect.stringMatching(/API key/) });
    expect(p.claim(t0 + 86_400_001 + PACE.gapMs).ok).toBe(true);
  });

  it('forgets a claim left by a run that crashed', () => {
    const p = new Pacer(join(mkdtempSync(join(tmpdir(), 'hg-pace-')), 'pace.json'));
    const t0 = Date.parse('2026-10-24T10:00:00Z');
    p.claim(t0);
    expect(p.claim(t0 + 3_600_001).ok).toBe(true);
  });
});

const fakeSys = (
  over: Partial<Sys> & { outputs?: Record<string, { status: number; out: string }> } = {},
): Sys => ({
  env: {},
  platform: 'linux',
  has: () => true,
  run: (cmd, args) => over.outputs?.[`${cmd} ${args.join(' ')}`] ?? { status: 1, out: '' },
  ...over,
});

describe('detecting sign-ins, by asking the agents', () => {
  it('reads Claude Code and Codex status without opening their credential files', () => {
    const d = detectAgents(
      fakeSys({
        outputs: {
          'claude auth status --json': {
            status: 0,
            out: '{"loggedIn":true,"authMethod":"oauth_token","apiProvider":"firstParty"}',
          },
          'codex login status': { status: 0, out: 'Logged in using an API key - sk-proj-***ABCD\n' },
        },
      }),
    );
    expect(d.map((x) => [x.agent, x.auth])).toEqual([
      ['claude-code', claudePlan],
      ['codex', { kind: 'api-key', provider: 'openai' }],
      ['omp', { kind: 'none' }],
      ['pi', { kind: 'none' }],
    ]);
  });

  it('counts `pi` as Pi only when it answers --version with a version, not Debian’s digits of π', () => {
    const real = fakeSys({ outputs: { 'pi --version': { status: 0, out: '1.4.0\n' } } });
    expect(isPiAgent(real)).toBe(true);
    expect(detectAgents(real)[3]).toMatchObject({ agent: 'pi', installed: true });
    const debian = fakeSys({ outputs: { 'pi --version': { status: 0, out: '3.14159265358979323846\n' } } });
    expect(isPiAgent(debian)).toBe(false);
    const d = detectAgents(debian)[3]!;
    expect(d.installed).toBe(false);
    expect(d.detail).toMatch(/isn’t the Pi coding agent/);
    expect(isPiAgent(fakeSys())).toBe(false);
    // A Node warning on stderr doesn't hide the version on stdout.
    const warned = fakeSys({
      run: () => ({ status: 0, out: '1.4.0\n(node:1) [DEP0040] DeprecationWarning: x\n', stdout: '1.4.0\n' }),
    });
    expect(isPiAgent(warned)).toBe(true);
    // The probe sees the same short environment as a run: no sign-in or key of the owner's.
    let seen: NodeJS.ProcessEnv | undefined;
    const probe = fakeSys({
      env: { PATH: '/bin', ANTHROPIC_OAUTH_TOKEN: 'x', OPENAI_API_KEY: 'y' },
      run: (_c, _a, env) => {
        seen = env;
        return { status: 0, out: '1.4.0\n', stdout: '1.4.0\n' };
      },
    });
    expect(isPiAgent(probe)).toBe(true);
    expect(seen).toMatchObject({ PATH: '/bin', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' });
    expect(seen?.ANTHROPIC_OAUTH_TOKEN).toBeUndefined();
    expect(seen?.OPENAI_API_KEY).toBeUndefined();
    // Asking about Claude Code never runs `pi`.
    let ranPi = false;
    detectAgent(
      'claude-code',
      fakeSys({
        run: (c) => {
          if (c === 'pi') ranPi = true;
          return { status: 1, out: '' };
        },
      }),
    );
    expect(ranPi).toBe(false);
  });

  it('treats an unknown sign-in as a subscription, the stricter case', () => {
    const d = detectAgents(
      fakeSys({
        outputs: {
          'claude auth status --json': { status: 0, out: '{"loggedIn":true,"authMethod":"something_new"}' },
          'codex login status': { status: 0, out: 'Logged in using ChatGPT\n' },
        },
      }),
    );
    expect(d[0]!.auth).toEqual(claudePlan);
    expect(d[1]!.auth).toEqual(chatgptPlan);
  });

  it('sees cloud accounts, missing sign-ins and missing programs', () => {
    const d = detectAgents(
      fakeSys({
        env: { CLAUDE_CODE_USE_BEDROCK: '1' },
        has: (c) => c !== 'omp' && c !== 'pi',
        outputs: { 'codex login status': { status: 1, out: 'Not logged in\n' } },
      }),
    );
    expect(d[0]!.auth).toEqual({ kind: 'cloud', provider: 'bedrock' });
    expect(d[1]!.auth).toEqual({ kind: 'none' });
    expect(d[2]!.installed).toBe(false);
    expect(d[3]!.installed).toBe(false);
  });
});

const detected = (agent: AgentId, auth: Auth): Detected => ({
  agent,
  name: agent,
  installed: true,
  auth,
  detail: '',
});
const input = (over: Partial<LaunchInput>): LaunchInput => ({
  agent: 'claude-code',
  task: 'Direct a three-shot scene of a baker opening at dawn.',
  trigger: 'owner-here',
  use: 'own-sign-in',
  workspace: '/tmp/hg/agents/run1',
  mcp: { command: '/usr/bin/node', args: ['/opt/hildegard/main.ts', 'mcp'] },
  ...over,
});
// A stand-in, not shaped like a real key, so secret scanners don't flag it.
const SECRET = 'test-anthropic-key';

describe('launch plans', () => {
  it('runs Claude Code headless with Hildegard’s MCP only, the task on stdin, and a key only in its variable', () => {
    const p = plan(input({ use: 'key', key: SECRET, budgetUsd: 5 }), detected('claude-code', claudePlan));
    expect(p.verdict.allowed).toBe(true);
    expect(p.cmd).toBe('claude');
    expect(p.args.slice(0, 5)).toEqual(['-p', '--output-format', 'stream-json', '--verbose', '--mcp-config']);
    expect(p.args).toContain('--strict-mcp-config');
    expect(p.args.join(' ')).toContain('--max-budget-usd 5');
    expect(p.stdin).toBe(input({}).task);
    expect(p.env).toMatchObject({
      ANTHROPIC_API_KEY: SECRET,
      CLAUDE_CODE_OAUTH_TOKEN: null,
      ANTHROPIC_AUTH_TOKEN: null,
    });
    expect(p.args.join(' ')).not.toContain(SECRET);
  });

  it('runs Claude Code on the owner’s plan untouched, and refuses it for invited people and schedules', () => {
    const own = plan(input({}), detected('claude-code', claudePlan));
    expect(own.verdict.allowed).toBe(true);
    expect(own.env).toEqual({});
    expect(own.args).not.toContain('--max-budget-usd');
    expect(plan(input({ trigger: 'director' }), detected('claude-code', claudePlan)).verdict.allowed).toBe(
      false,
    );
    expect(plan(input({ trigger: 'schedule' }), detected('claude-code', claudePlan)).verdict.allowed).toBe(
      false,
    );
    expect(
      plan(input({ trigger: 'schedule', use: 'key', key: SECRET }), detected('claude-code', claudePlan))
        .verdict.allowed,
    ).toBe(true);
    expect(plan(input({ use: 'key' }), detected('claude-code', claudePlan)).verdict.allowed).toBe(false);
  });

  it('runs codex exec with the MCP server as config overrides and the key in CODEX_API_KEY', () => {
    const p = plan(
      input({ agent: 'codex', use: 'key', key: 'sk-proj-X', model: 'gpt-6.1' }),
      detected('codex', chatgptPlan),
    );
    expect(p.cmd).toBe('codex');
    expect(p.args.slice(0, 4)).toEqual(['exec', '--json', '--sandbox', 'workspace-write']);
    expect(p.args).toContain('mcp_servers.hildegard.command="/usr/bin/node"');
    expect(p.args).toContain('mcp_servers.hildegard.args=["/opt/hildegard/main.ts", "mcp"]');
    expect(p.args.at(-1)).toBe('-');
    expect(p.env).toEqual({ CODEX_API_KEY: 'sk-proj-X' });
  });

  it('runs OMP only on a key or a local model, in a profile of its own with borrowed sign-ins removed', () => {
    const own = plan(
      input({ agent: 'omp', model: 'anthropic/claude-sonnet-5-5' }),
      detected('omp', { kind: 'none' }),
    );
    expect(own.verdict.allowed).toBe(false);
    expect(own.verdict.reason).toMatch(/banned/);
    const local = plan(
      input({ agent: 'omp', use: 'local', model: 'ollama/qwen3-coder' }),
      detected('omp', { kind: 'none' }),
    );
    expect(local.verdict.allowed).toBe(true);
    expect(local.env).toMatchObject({
      PI_CODING_AGENT_DIR: join('/tmp/hg/agents', 'omp-profile'),
      ANTHROPIC_OAUTH_TOKEN: null,
      XAI_OAUTH_TOKEN: null,
      CLAUDE_CODE_OAUTH_TOKEN: null,
      OMP_AUTH_BROKER_URL: null,
    });
    const keyed = plan(
      input({ agent: 'omp', use: 'key', key: 'sk-or-X', model: 'openrouter/qwen/qwen3-coder' }),
      detected('omp', { kind: 'none' }),
    );
    expect(keyed.verdict.allowed).toBe(true);
    expect(keyed.env.OPENROUTER_API_KEY).toBe('sk-or-X');
    expect(
      plan(input({ agent: 'omp', use: 'local', model: 'openrouter/x' }), detected('omp', { kind: 'none' }))
        .verdict.allowed,
    ).toBe(false);
    expect(
      plan(input({ agent: 'omp', use: 'local' }), detected('omp', { kind: 'none' })).verdict.reason,
    ).toMatch(/needs a model/);
  });

  it('runs Pi only when its owner accepts it has no sandbox, and never for anyone else or on a schedule', () => {
    const none = detected('pi', { kind: 'none' });
    const p = (over: Partial<LaunchInput>) =>
      plan(input({ agent: 'pi', use: 'local', model: 'ollama/qwen3-coder', ...over }), none);
    expect(p({}).verdict.allowed).toBe(false);
    expect(p({}).verdict.reason).toMatch(/Pi has no sandbox.*--unsandboxed/);
    expect(p({ unsandboxed: true }).verdict.allowed).toBe(true);
    expect(p({ unsandboxed: true, trigger: 'owner-remote' }).verdict.allowed).toBe(true);
    for (const trigger of ['schedule', 'director', 'peer'] as const)
      expect(p({ unsandboxed: true, trigger }).verdict.allowed).toBe(false);
  });

  it('runs Pi only on a key or a local model, in a profile of its own with borrowed sign-ins removed', () => {
    const none = detected('pi', { kind: 'none' });
    const pi = (over: Partial<LaunchInput>) => input({ agent: 'pi', unsandboxed: true, ...over });
    const own = plan(pi({ model: 'anthropic/claude-sonnet-5-5' }), none);
    expect(own.verdict.allowed).toBe(false);
    expect(own.verdict.reason).toMatch(/banned/);
    const local = plan(pi({ use: 'local', model: 'ollama/qwen3-coder' }), none);
    expect(local.verdict.allowed).toBe(true);
    expect(local.cmd).toBe('pi');
    // The task never goes in argv: only fixed words and the owner's checked model name do.
    expect(local.args).toEqual([
      '--print',
      '--no-session',
      '--no-approve',
      '--no-extensions',
      '--extension',
      'builtin:mcp',
      '--tools',
      'read,edit,write,grep,find,ls,mcp__hildegard__*',
      '--model',
      'ollama/qwen3-coder',
      '--',
      PI_PROMPT,
    ]);
    expect(local.args.join(' ')).not.toContain('baker');
    expect(local.stdin).toBe(input({}).task);
    expect(PI_TOOLS).not.toContain('bash');
    expect(local.env).toMatchObject({ PI_CODING_AGENT_DIR: piProfile({ workspace: '/tmp/hg/agents/run1' }) });
    // Pi starts from a short allow-list, so sign-ins and other keys in Hildegard's environment never reach it.
    expect(local.inherit).toContain('PATH');
    expect(local.inherit).not.toContain('ANTHROPIC_OAUTH_TOKEN');
    const keyed = plan(pi({ use: 'key', key: 'sk-or-X', model: 'openrouter/qwen/qwen3-coder' }), none);
    expect(keyed.verdict.allowed).toBe(true);
    expect(keyed.env.OPENROUTER_API_KEY).toBe('sk-or-X');
    expect(plan(pi({ use: 'local', model: 'openrouter/x' }), none).verdict.allowed).toBe(false);
    expect(plan(pi({ use: 'local' }), none).verdict.reason).toMatch(/Pi needs a model/);
    expect(allowedFor('pi', { kind: 'borrowed-login', provider: 'openai' })).toEqual([]);
  });

  it('takes OMP’s and Pi’s provider from the model, and refuses a --provider that names another', () => {
    for (const agent of ['pi', 'omp'] as const) {
      const none = detected(agent, { kind: 'none' });
      // A local provider can't vouch for a model that goes to Anthropic.
      const sneaky = plan(
        input({
          agent,
          use: 'local',
          provider: 'ollama',
          model: 'anthropic/claude-sonnet-5-5',
          unsandboxed: true,
        }),
        none,
      );
      expect(sneaky.verdict.allowed).toBe(false);
      expect(sneaky.verdict.reason).toMatch(/provider its model names \(anthropic\)/);
      // Case doesn't matter, on either side.
      const mixed = plan(
        input({ agent, use: 'local', provider: 'OLLAMA', model: 'Ollama/qwen3-coder', unsandboxed: true }),
        none,
      );
      expect(mixed.verdict.allowed).toBe(true);
      expect(mixed.auth).toEqual({ kind: 'local', provider: 'ollama' });
    }
  });

  it('refuses a budget the agent can’t keep, and Pi models that aren’t one plain word', () => {
    for (const agent of ['codex', 'omp', 'pi'] as const) {
      const p = plan(
        input({
          agent,
          use: 'key',
          key: SECRET,
          model: 'openrouter/qwen/qwen3-coder',
          budgetUsd: 5,
          unsandboxed: true,
        }),
        detected(agent, { kind: 'none' }),
      );
      expect(p.verdict.allowed).toBe(false);
      expect(p.verdict.reason).toMatch(/can’t hold a run to a budget/);
    }
    const claude = plan(
      input({ use: 'key', key: SECRET, budgetUsd: 5 }),
      detected('claude-code', claudePlan),
    );
    expect(claude.verdict.allowed).toBe(true);
    expect(claude.args).toContain('--max-budget-usd');
    // A budget that isn't a positive number is refused, never dropped.
    for (const budgetUsd of [0, -5, Number.NaN]) {
      const bad = plan(input({ use: 'key', key: SECRET, budgetUsd }), detected('claude-code', claudePlan));
      expect(bad.verdict.reason).toMatch(/number of US dollars above 0/);
    }
    const none = detected('pi', { kind: 'none' });
    expect(
      plan(input({ agent: 'pi', use: 'local', model: 'ollama/x" & calc', unsandboxed: true }), none).verdict
        .allowed,
    ).toBe(false);
    expect(
      plan(
        input({
          agent: 'pi',
          use: 'local',
          model: 'ollama/x',
          extraTools: ['Bash(blender:*)'],
          unsandboxed: true,
        }),
        none,
      ).verdict.reason,
    ).toMatch(/without a shell/);
    expect(
      plan(input({ agent: 'pi', use: 'local', model: 'hildegard/x', unsandboxed: true }), none).verdict
        .reason,
    ).toMatch(/doesn’t know where hildegard listens/);
  });

  it('refuses an agent that isn’t installed', () => {
    const p = plan(input({}), {
      ...detected('claude-code', claudePlan),
      installed: false,
      detail: 'Install it.',
    });
    expect(p.verdict.allowed).toBe(false);
  });
});

describe('workspace and running', () => {
  it('writes the MCP config and skills where each agent reads them', () => {
    const root = mkdtempSync(join(tmpdir(), 'hg-ws-'));
    const skills = join(root, 'skills');
    mkdirSync(join(skills, 'hildegard-film'), { recursive: true });
    writeFileSync(
      join(skills, 'hildegard-film', 'SKILL.md'),
      '---\nname: hildegard-film\ndescription: Films.\n---\n# Film\n',
    );
    const ws = join(root, 'agents', 'run1');
    prepareWorkspace(input({ agent: 'omp', workspace: ws, skillsDir: skills }));
    expect(JSON.parse(readFileSync(join(ws, '.mcp.json'), 'utf8')).mcpServers.hildegard.args).toEqual([
      '/opt/hildegard/main.ts',
      'mcp',
    ]);
    expect(existsSync(join(ws, '.claude', 'skills', 'hildegard-film', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(ws, '.agents', 'skills', 'hildegard-film', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(ws, '.claude-home', '.claude.json'))).toBe(true);
    expect(existsSync(join(root, 'agents', 'omp-profile'))).toBe(true);
  });

  it('gives Pi its own profile, outside its workspace, with Hildegard’s MCP server and skills in it', () => {
    const root = mkdtempSync(join(tmpdir(), 'hg-pi-'));
    const skills = join(root, 'skills');
    mkdirSync(join(skills, 'hildegard-film'), { recursive: true });
    writeFileSync(
      join(skills, 'hildegard-film', 'SKILL.md'),
      '---\nname: hildegard-film\ndescription: Films.\n---\n# Film\n',
    );
    const ws = join(root, 'agents', 'run1');
    prepareWorkspace(input({ agent: 'pi', workspace: ws, skillsDir: skills }));
    const profile = piProfile({ workspace: ws });
    // Never inside the folder Pi works in, where its file tools could rewrite its own MCP config.
    expect(profile.startsWith(join(ws, 'x').slice(0, -1))).toBe(false);
    expect(piProfile({ workspace: ws, piProfile: '/data/pi/1' })).toBe('/data/pi/1');
    expect(JSON.parse(readFileSync(join(profile, 'mcp.json'), 'utf8')).mcpServers.hildegard.args).toEqual([
      '/opt/hildegard/main.ts',
      'mcp',
    ]);
    expect(existsSync(join(profile, 'skills', 'hildegard-film', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(ws, '.agents', 'skills', 'hildegard-film', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(root, 'agents', 'omp-profile'))).toBe(false);
    expect(parseLine('pi', 'Done.')).toEqual([{ kind: 'text', text: 'Done.' }]);
  });

  it('starts every Pi run in an empty profile: nothing Pi saved in one run reaches the next, nor another run', () => {
    const root = mkdtempSync(join(tmpdir(), 'hg-pi-'));
    const a = join(root, 'agents', 'runs', 'a');
    const b = join(root, 'agents', 'runs', 'b');
    const pa = piProfile({ workspace: a });
    const pb = piProfile({ workspace: b });
    prepareWorkspace(input({ agent: 'pi', workspace: a }));
    // Pi saved a login during run a.
    writeFileSync(join(pa, 'auth.json'), '{}');
    prepareWorkspace(input({ agent: 'pi', workspace: b }));
    expect(pa).not.toBe(pb);
    expect(existsSync(join(pb, 'auth.json'))).toBe(false);
    // Run a again, in the same workspace: its profile starts over.
    prepareWorkspace(input({ agent: 'pi', workspace: a }));
    expect(existsSync(join(pa, 'auth.json'))).toBe(false);
    expect(existsSync(join(pa, 'mcp.json'))).toBe(true);
  });

  it('tells Pi where a local model server is, and nothing for a hosted provider', () => {
    const root = mkdtempSync(join(tmpdir(), 'hg-pi-'));
    const ws = join(root, 'run');
    const profile = piProfile({ workspace: ws });
    prepareWorkspace(input({ agent: 'pi', use: 'local', model: 'ollama/qwen3-coder:7b', workspace: ws }), {
      OLLAMA_HOST: '0.0.0.0:11500',
    });
    const models = JSON.parse(readFileSync(join(profile, 'models.json'), 'utf8'));
    expect(models.providers.ollama).toMatchObject({
      baseUrl: 'http://127.0.0.1:11500/v1',
      api: 'openai-completions',
      models: [{ id: 'qwen3-coder:7b' }],
    });
    prepareWorkspace(
      input({ agent: 'pi', use: 'key', key: SECRET, model: 'openrouter/qwen/q', workspace: ws }),
    );
    expect(existsSync(join(profile, 'models.json'))).toBe(false);
    expect(ollamaBase(undefined)).toBe('http://127.0.0.1:11434/v1');
    expect(ollamaBase('gpu-box')).toBe('http://gpu-box:11434/v1');
    expect(ollamaBase('https://ollama.example')).toBe('https://ollama.example/v1');
  });

  it('gives Pi the provider in lowercase, as policy saw it, and refuses folders it can’t be limited to', () => {
    const none = detected('pi', { kind: 'none' });
    const p = plan(
      input({ agent: 'pi', use: 'local', model: 'Ollama/Qwen3-Coder', unsandboxed: true }),
      none,
    );
    expect(p.verdict.allowed).toBe(true);
    expect(p.args[p.args.indexOf('--model') + 1]).toBe('ollama/Qwen3-Coder');
    expect(
      plan(
        input({ agent: 'pi', use: 'local', model: 'ollama/x', addDirs: ['/footage'], unsandboxed: true }),
        none,
      ).verdict.reason,
    ).toMatch(/Leave out --add-dir/);
    expect(() => ollamaBase(':11434')).toThrow(/OLLAMA_HOST \(:11434\) isn’t an address/);
  });

  it('hands OMP and Pi the provider policy saw, needs provider/model, and says why a scheduled Pi run can’t be', () => {
    for (const agent of ['omp', 'pi'] as const) {
      const none = detected(agent, { kind: 'none' });
      const p = plan(input({ agent, use: 'local', model: 'Ollama/qwen3-coder', unsandboxed: true }), none);
      expect(p.verdict.allowed).toBe(true);
      expect(p.args[p.args.indexOf('--model') + 1]).toBe('ollama/qwen3-coder');
      // A bare provider is not a model: no '--model ollamaa'.
      const bare = plan(input({ agent, use: 'local', model: 'ollama', unsandboxed: true }), none);
      expect(bare.verdict.reason).toMatch(/needs a model, as provider\/model/);
    }
    const sched = plan(
      input({ agent: 'pi', use: 'local', model: 'ollama/x', trigger: 'schedule' }),
      detected('pi', { kind: 'none' }),
    );
    expect(sched.verdict.reason).toMatch(/never on a schedule/);
  });

  it('refuses a budget Claude Code won’t get, on a plan or a cloud account', () => {
    for (const auth of [claudePlan, { kind: 'cloud', provider: 'bedrock' } as Auth]) {
      const p = plan(input({ budgetUsd: 5 }), detected('claude-code', auth));
      expect(p.verdict.allowed).toBe(false);
      expect(p.verdict.reason).toMatch(/only on an API key/);
    }
  });

  it('sweeps Pi profiles that a killed run left behind, and keeps fresh ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hg-profiles-'));
    mkdirSync(join(dir, 'old'));
    mkdirSync(join(dir, 'new'));
    const old = new Date(Date.now() - 3 * 3_600_000);
    utimesSync(join(dir, 'old'), old, old);
    sweepProfiles(dir);
    expect(existsSync(join(dir, 'old'))).toBe(false);
    expect(existsSync(join(dir, 'new'))).toBe(true);
  });

  it('never sweeps a folder derived from a caller’s profile path, only Hildegard’s own', () => {
    const root = mkdtempSync(join(tmpdir(), 'hg-sweep-'));
    const theirs = join(root, 'projects');
    mkdirSync(join(theirs, 'old-film'), { recursive: true });
    const old = new Date(Date.now() - 3 * 3_600_000);
    utimesSync(join(theirs, 'old-film'), old, old);
    prepareWorkspace(input({ agent: 'pi', workspace: join(root, 'run'), piProfile: join(theirs, 'pi-1') }));
    expect(existsSync(join(theirs, 'old-film'))).toBe(true);
    const ours = join(root, 'pi-profiles');
    mkdirSync(join(ours, 'left'), { recursive: true });
    utimesSync(join(ours, 'left'), old, old);
    prepareWorkspace(
      input({
        agent: 'pi',
        workspace: join(root, 'run'),
        piProfile: join(ours, 'new'),
        piProfilesRoot: ours,
      }),
    );
    expect(existsSync(join(ours, 'left'))).toBe(false);
  });

  it('keeps an Ollama path, and won’t copy a user and password into Pi’s profile', () => {
    expect(ollamaBase('https://gpu.example/ollama/')).toBe('https://gpu.example/ollama/v1');
    expect(() => ollamaBase('https://u:pw@gpu.example')).toThrow(/user and password/);
  });

  it('keeps the first refusal’s reason: a wrong `pi` is reported as that, not as a missing model', () => {
    const notPi = {
      ...detected('pi', { kind: 'none' }),
      installed: false,
      detail: 'isn’t the Pi coding agent',
    };
    const p = plan(input({ agent: 'pi', use: 'local' }), notPi);
    expect(p.verdict.reason).toMatch(/isn’t installed/);
    expect(p.verdict.fix).toMatch(/isn’t the Pi coding agent/);
  });

  it('keeps Windows’ Path whatever its case', () => {
    expect(inherited({ Path: 'C:\\Windows', SECRET_X: 's' }, ['PATH'], true)).toEqual({
      Path: 'C:\\Windows',
    });
    expect(inherited({ Path: 'x' }, ['PATH'])).toEqual({});
  });

  it('passes Pi only the variables it needs, with the task on stdin', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hg-run-'));
    const fake = join(dir, 'fake-pi.mjs');
    writeFileSync(
      fake,
      `let input = ''; process.stdin.on('data', (d) => (input += d)); process.stdin.on('end', () => {
  const e = process.env;
  console.log(['path=' + (e.PATH ? 'set' : 'unset'), 'oauth=' + (e.ANTHROPIC_OAUTH_TOKEN ? 'set' : 'unset'), 'other=' + (e.OPENAI_API_KEY ? 'set' : 'unset'), 'key=' + (e.OPENROUTER_API_KEY ? 'set' : 'unset'), 'lc=' + (e.LC_ALL ?? ''), 'proxy=' + (e.HTTPS_PROXY ?? ''), 'task=' + input].join(' '));
});`,
    );
    const p = {
      ...plan(
        input({
          agent: 'pi',
          use: 'key',
          key: SECRET,
          model: 'openrouter/qwen/qwen3-coder',
          workspace: dir,
          unsandboxed: true,
        }),
        detected('pi', { kind: 'none' }),
      ),
      cmd: process.execPath,
      args: [fake],
    };
    const r = await run(p, dir, () => {}, {
      sys: fakeSys({
        env: {
          ...process.env,
          LC_ALL: 'C',
          HTTPS_PROXY: 'http://proxy:3128',
          ANTHROPIC_OAUTH_TOKEN: 'x',
          OPENAI_API_KEY: 'y',
        },
      }),
    });
    expect(r.final).toBe(
      `path=set oauth=unset other=unset key=set lc=C proxy=http://proxy:3128 task=${input({}).task}`,
    );
    expect(inherited({ PATH: '/bin', LC_ALL: 'C', SECRET_X: 's' }, ['PATH', 'LC_*'])).toEqual({
      PATH: '/bin',
      LC_ALL: 'C',
    });
  });

  it('reads each agent’s JSON lines', () => {
    expect(
      parseLine(
        'claude-code',
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'Done.' },
              { type: 'tool_use', name: 'mcp__hildegard__direct_shot' },
            ],
          },
        }),
      ),
    ).toEqual([
      { kind: 'text', text: 'Done.' },
      { kind: 'tool', text: 'mcp__hildegard__direct_shot' },
    ]);
    expect(parseLine('claude-code', JSON.stringify({ type: 'result', total_cost_usd: 0.42 }))).toEqual([
      { kind: 'cost', text: '0.42' },
    ]);
    expect(
      parseLine(
        'codex',
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Shot queued.' } }),
      ),
    ).toEqual([{ kind: 'text', text: 'Shot queued.' }]);
    expect(parseLine('codex', 'not json')).toEqual([]);
  });

  it('runs the planned program with the planned environment, and refuses a refused plan', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hg-run-'));
    const fake = join(dir, 'fake-agent.mjs');
    writeFileSync(
      fake,
      `let input = ''; process.stdin.on('data', (d) => (input += d)); process.stdin.on('end', () => {
  console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'key=' + (process.env.ANTHROPIC_API_KEY ? 'set' : 'unset') + ' oauth=' + (process.env.CLAUDE_CODE_OAUTH_TOKEN ? 'set' : 'unset') + ' task=' + input }] } }));
  console.log(JSON.stringify({ type: 'result', total_cost_usd: 0.01 }));
});`,
    );
    const p = {
      ...plan(input({ use: 'key', key: SECRET }), detected('claude-code', claudePlan)),
      cmd: process.execPath,
      args: [fake],
    };
    const events: string[] = [];
    const r = await run(p, dir, (e) => events.push(e.kind), {
      sys: fakeSys({ env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: 'x' } }),
    });
    expect(r).toMatchObject({ ok: true, exitCode: 0, costUsd: 0.01 });
    expect(r.final).toBe(`key=set oauth=unset task=${input({}).task}`);
    expect(events).toEqual(['text', 'cost']);
    const refused = plan(input({ trigger: 'director' }), detected('claude-code', claudePlan));
    await expect(run(refused, dir)).rejects.toThrow(/sharing the account/);
  });
});

describe('skills', () => {
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), 'hg-skills-'));
    const src = join(root, 'src');
    for (const n of ['hildegard-film', 'hildegard-photo']) {
      mkdirSync(join(src, n), { recursive: true });
      writeFileSync(join(src, n, 'SKILL.md'), `---\nname: ${n}\ndescription: "About ${n}."\n---\n`);
    }
    return { root, src };
  };

  it('lists skills with their frontmatter', () => {
    const { src } = setup();
    expect(listSkills(src).map((s) => [s.name, s.description])).toEqual([
      ['hildegard-film', 'About hildegard-film.'],
      ['hildegard-photo', 'About hildegard-photo.'],
    ]);
  });

  it('installs, updates and removes only its own folders', () => {
    const { root, src } = setup();
    const dest = join(root, 'home', '.claude', 'skills');
    mkdirSync(join(dest, 'hildegard-photo'), { recursive: true });
    writeFileSync(join(dest, 'hildegard-photo', 'SKILL.md'), 'mine');
    expect(installSkills(src, [dest], '0.1.0').map((o) => o.status)).toEqual(['installed', 'kept-yours']);
    expect(readFileSync(join(dest, 'hildegard-photo', 'SKILL.md'), 'utf8')).toBe('mine');
    expect(installSkills(src, [dest], '0.1.1').map((o) => o.status)).toEqual(['updated', 'kept-yours']);
    expect(removeSkills(src, [dest]).map((o) => o.skill)).toEqual(['hildegard-film']);
    expect(existsSync(join(dest, 'hildegard-photo', 'SKILL.md'))).toBe(true);
  });

  it('puts skills where each agent reads them', () => {
    expect(skillRoots('claude-code', undefined, {}, '/home/d')).toEqual([
      join('/home/d', '.claude', 'skills'),
    ]);
    expect(skillRoots('codex', undefined, {}, '/home/d')).toEqual([join('/home/d', '.agents', 'skills')]);
    expect(skillRoots('omp', undefined, { CLAUDE_CONFIG_DIR: '/cfg' }, '/home/d')).toEqual([
      join('/cfg', 'skills'),
    ]);
    expect(skillRoots('codex', '/p')).toEqual([join('/p', '.agents', 'skills')]);
    expect(skillRoots('gemini', undefined, {}, '/home/d')).toEqual([join('/home/d', '.agents', 'skills')]);
    expect(skillRoots('opencode', undefined, {}, '/home/d')).toEqual([join('/home/d', '.agents', 'skills')]);
    expect(skillRoots('pi', undefined, {}, '/home/d')).toEqual([join('/home/d', '.pi', 'agent', 'skills')]);
    expect(skillRoots('pi', undefined, { PI_CODING_AGENT_DIR: '/pi' }, '/home/d')).toEqual([
      join('/pi', 'skills'),
    ]);
    expect(skillRoots('pi', '/p')).toEqual([join('/p', '.pi', 'skills')]);
  });
});

describe('the skills Hildegard ships', () => {
  const dir = join(import.meta.dirname, '..', '..', '..', 'skills');
  it('each has a name matching its folder, a description agents can match, and working links', () => {
    const all = listSkills(dir);
    expect(all.map((s) => s.name)).toEqual(
      expect.arrayContaining([
        'hildegard-craft',
        'hildegard-film',
        'hildegard-video-edit',
        'hildegard-photo-edit',
        'hildegard-art',
        'hildegard-sound',
        'hildegard-setup',
      ]),
    );
    for (const s of all) {
      expect(s.dir.endsWith(s.name)).toBe(true);
      expect(s.name).toMatch(/^[a-z0-9-]{1,64}$/);
      // Codex and Claude Code both cap descriptions; a colon and space would break plain YAML.
      expect(s.description.length).toBeGreaterThan(80);
      expect(s.description.length).toBeLessThanOrEqual(1024);
      expect(s.description).not.toMatch(/: /);
      const md = readFileSync(join(s.dir, 'SKILL.md'), 'utf8');
      expect(md.split('\n').length).toBeLessThan(500);
      for (const [, link] of md.matchAll(/\]\(((?!https?:)[^)#]+)\)/g))
        expect(existsSync(join(s.dir, link!))).toBe(true);
    }
  });
});

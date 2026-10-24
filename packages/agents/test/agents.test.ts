// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type AgentId,
  type Auth,
  type Detected,
  decide,
  detectAgents,
  installSkills,
  type LaunchInput,
  listSkills,
  PACE,
  Pacer,
  parseLine,
  plan,
  prepareWorkspace,
  removeSkills,
  run,
  type Sys,
  skillRoots,
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

  it('lets the owner’s own keys run anything for the owner, and for invited people only when turned on', () => {
    const key: Auth = { kind: 'api-key', provider: 'anthropic' };
    expect(allowedFor('claude-code', key)).toEqual(['owner-here', 'owner-remote', 'schedule']);
    expect(allowedFor('claude-code', key, { shareKeysWithDirectors: true })).toEqual([
      'owner-here',
      'owner-remote',
      'director',
      'schedule',
    ]);
    expect(decide('omp', key, 'director').fix).toMatch(/Never charge them/);
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
    ]);
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
        has: (c) => c !== 'omp',
        outputs: { 'codex login status': { status: 1, out: 'Not logged in\n' } },
      }),
    );
    expect(d[0]!.auth).toEqual({ kind: 'cloud', provider: 'bedrock' });
    expect(d[1]!.auth).toEqual({ kind: 'none' });
    expect(d[2]!.installed).toBe(false);
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
      PI_CODING_AGENT_DIR: '/tmp/hg/agents/omp-profile',
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
    expect(skillRoots('claude-code', undefined, {}, '/home/d')).toEqual(['/home/d/.claude/skills']);
    expect(skillRoots('codex', undefined, {}, '/home/d')).toEqual(['/home/d/.agents/skills']);
    expect(skillRoots('omp', undefined, { CLAUDE_CONFIG_DIR: '/cfg' }, '/home/d')).toEqual(['/cfg/skills']);
    expect(skillRoots('codex', '/p')).toEqual(['/p/.agents/skills']);
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

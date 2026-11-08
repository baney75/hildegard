// SPDX-License-Identifier: AGPL-3.0-only
// Draft every brief in corpus/ai/briefs.json with several models and no skill, for the prose lint's AI corpus.
//   node packages/craft/bench/gen-ai.mjs [--only haiku,sonnet] [--jobs 4]
// Subscriptions only: ANTHROPIC_API_KEY and OPENAI_API_KEY are removed from the environment, and the run stops if a
// quota or billing message appears. The Claude runs load no settings, no MCP and no CLAUDE.md, run from an empty
// temporary directory with the default system prompt replaced, and `--tools ''`. Claude Code still puts the signed-in
// account's email address in the model's context (there is no flag to drop it without a different sign-in), and
// an early run signed drafts with the owner's name from it. So the system prompt says the model does not know who is
// asking, and a draft that carries the owner's name or email is thrown away and drafted again (tests/corpus check
// that none is committed). The Codex run gets an empty CODEX_HOME that links only to the sign-in, so the owner's
// global AGENTS.md is not read.
// Each brief is drafted twice: with the writer's facts (<id>.md) and with the topic alone (<id>-generic.md), the way
// most people prompt. Output: corpus/ai/<model>/ (skipped when it exists).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const here = import.meta.dirname;
const args = process.argv.slice(2);
const opt = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
const only = opt('--only', 'haiku,sonnet,opus,luna').split(',');
const jobs = Number(opt('--jobs', '4'));
const briefs = JSON.parse(readFileSync(join(here, 'corpus/ai/briefs.json'), 'utf8'));
const claude = process.env.CLAUDE_BIN ?? 'claude';
const cwd = mkdtempSync(join(tmpdir(), 'prose-gen-'));
const codexHome = mkdtempSync(join(tmpdir(), 'prose-codex-'));
symlinkSync(join(homedir(), '.codex/auth.json'), join(codexHome, 'auth.json'));

const env = { ...process.env, CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' };
delete env.ANTHROPIC_API_KEY;
delete env.OPENAI_API_KEY;

const ASK = '\n\nWrite the finished piece, ready to publish. Print only the piece itself.';
const RUNNERS = {
  haiku: (p) => ({ cmd: claude, argv: ['-p', '--model', 'haiku', ...CLAUDE_FLAGS], input: p }),
  sonnet: (p) => ({ cmd: claude, argv: ['-p', '--model', 'sonnet', ...CLAUDE_FLAGS], input: p }),
  opus: (p) => ({ cmd: claude, argv: ['-p', '--model', 'opus', ...CLAUDE_FLAGS], input: p }),
  luna: (p) => ({
    cmd: 'codex',
    argv: [
      'exec',
      '-m',
      'gpt-6-luna',
      '-s',
      'read-only',
      '--skip-git-repo-check',
      '--ephemeral',
      '-c',
      'model_reasoning_effort=low',
      '-',
    ],
    input: p,
    env: { CODEX_HOME: codexHome },
  }),
};
const SYSTEM =
  'You are a writing assistant. You are not told who the person asking is: never guess a name or email from anything in your context, and sign a piece only with a name the request gives.';
/** What a draft must not contain: the owner's name or email, which Claude Code gives the model with the sign-in. */
const LEAK = /baney|donovan|dbaney/i;
const CLAUDE_FLAGS = [
  '--setting-sources',
  '',
  '--strict-mcp-config',
  '--mcp-config',
  '{"mcpServers":{}}',
  '--no-session-persistence',
  '--tools',
  '',
  '--system-prompt',
  SYSTEM,
];
const STOP = /quota|billing|usage limit|rate limit|upgrade your plan|credit balance/i;

const queue = [];
for (const model of only)
  for (const b of briefs)
    for (const kind of ['', '-generic']) {
      const out = join(here, 'corpus/ai', model, `${b.id}${kind}.md`);
      if (!existsSync(out))
        queue.push({ model, b: { id: b.id + kind, brief: kind ? b.generic : b.brief }, out });
    }

let stopped = false;
function run({ model, b, out }, attempt = 1) {
  return new Promise((done) => {
    if (stopped) return done();
    const r = RUNNERS[model](b.brief + ASK);
    const p = spawn(r.cmd, r.argv, { cwd, env: { ...env, ...r.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.stdin.end(r.input);
    const timer = setTimeout(() => p.kill(), 600_000);
    p.on('close', (code) => {
      clearTimeout(timer);
      if (STOP.test(stderr) || (code !== 0 && STOP.test(stdout))) {
        stopped = true;
        console.error(
          `STOP: ${model}/${b.id} hit a quota or billing message. Nothing more will run.\n${stderr.slice(0, 300)}`,
        );
        return done();
      }
      // codex prints the transcript on stderr and the final message on stdout.
      const text = stdout.trim();
      if (code !== 0 || !text)
        console.error(`FAILED ${model}/${b.id} (exit ${code}): ${stderr.slice(0, 200)}`);
      else if (LEAK.test(text)) {
        console.error(
          `LEAK ${model}/${b.id}: the draft names the owner (attempt ${attempt}); ${attempt < 3 ? 'drafting again' : 'not saved'}`,
        );
        if (attempt < 3) return run({ model, b, out }, attempt + 1).then(done);
      } else {
        mkdirSync(join(here, 'corpus/ai', model), { recursive: true });
        writeFileSync(out, `${text}\n`);
        console.log(`ok ${model}/${b.id} ${text.split(/\s+/).length} words`);
      }
      done();
    });
  });
}

const pending = [...queue];
await Promise.all(
  Array.from({ length: jobs }, async () => {
    for (let t = pending.shift(); t && !stopped; t = pending.shift()) await run(t);
  }),
);
console.log(stopped ? 'stopped early' : `done, ${queue.length} drafts attempted`);

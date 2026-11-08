// SPDX-License-Identifier: AGPL-3.0-only
// Pairing two devices without anyone seeing the join code. The code is a key: whoever reads it can render on the
// GPU. An agent that prints it (`choir invite --json`) and types it into the next command (`printf %s "<code>" |`)
// has put it in its transcript and in a process list. So the code only ever travels from one process's stdout to the
// next process's stdin:
//
//   hildegard choir invite --code-only     prints the code, and only when stdout is a pipe or a socket
//   hildegard choir pair <ssh-host>        runs that over ssh and pipes it into this computer's `choir join`
//
// `pair` never holds the code in a variable, an argument or a file: it connects one process's stdout to the other's
// stdin, and prints only what the join says back, with anything shaped like a code taken out.
import { type ChildProcess, spawn } from 'node:child_process';
import { Socket } from 'node:net';
import type { Readable } from 'node:stream';
import type { ChoirInvite } from '@hildegard/presets';
import type { Step } from '@hildegard/runtime';
import { api, type Ctx, ensureRunning, entry } from './commands.ts';
import { type Result, result } from './output.ts';

/** Words for the one thing every pairing path must never do. */
export const NEVER_SHOW =
  'Scripts and AI agents: never print, echo, printf or paste a join code. Use `hildegard choir pair <ssh-host>`, or pipe it: `ssh <host> hildegard choir invite --code-only | hildegard choir join --code-stdin`.';

/**
 * What stdout is. Node makes a terminal a tty stream and a pipe or socket a `net.Socket` (from libuv's handle check,
 * which knows Windows pipes; `fstat` doesn't), and a file anything else.
 */
export const stdoutKind = (out: NodeJS.WriteStream): 'tty' | 'pipe' | 'file' =>
  out.isTTY ? 'tty' : out instanceof Socket ? 'pipe' : 'file';

/** Why `--code-only` won't print here, or null when stdout is a pipe or a socket (a shell `|`, or ssh). */
export function codeOnlyRefusal(kind: 'tty' | 'pipe' | 'file'): string | null {
  if (kind === 'pipe') return null;
  const where = kind === 'tty' ? 'show the join code on your screen' : 'write the join code to a file';
  return `This would ${where}, and a code anyone can read is a key anyone can use. Pipe it into the other device instead: \`hildegard choir invite --code-only | ssh <host> hildegard choir join --code-stdin\`, or run \`hildegard choir pair <ssh-host>\` there.`;
}

/** Anything shaped like a join code (long or short), so a message can't carry one even by accident. */
export const scrub = (text: string) =>
  text
    .replace(/hgc1_[A-Za-z0-9_-]+/g, '[code hidden]')
    .replace(/HG-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}/gi, '[code hidden]');

/** `scrub` on every string in a value, keys included, so no field of a join's answer can carry a code. */
export const scrubAll = <T>(value: T): T =>
  (typeof value === 'string'
    ? scrub(value)
    : Array.isArray(value)
      ? value.map(scrubAll)
      : value && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).map(([k, v]) => [scrub(k), scrubAll(v)]))
        : value) as T;

const stop = (message: string, code = 1): null => {
  console.error(message);
  process.exitCode = code;
  return null;
};

/**
 * `choir invite --code-only`: the long join code on stdout and nothing else (no JSON, no sentences), only when stdout
 * is not a terminal. Problems go to stderr with a status that says which: 1 failed, 2 Tailscale needs the owner.
 */
export async function inviteCodeOnly(ctx: Ctx): Promise<null> {
  const refused = codeOnlyRefusal(stdoutKind(process.stdout));
  if (refused) return stop(refused);
  const pre = await ensureRunning(ctx);
  if (pre?.status === 'failed') return stop('Hildegard isn’t running here.');
  try {
    const r = await api<ChoirInvite>(ctx.config, '/api/choir/invite', {
      method: 'POST',
      body: { url: ctx.opts.get('url'), long: true, short: false },
    });
    if (!r.code) return stop('Hildegard made no long code to hand over. Nothing was printed.');
    process.stdout.write(`${r.code}\n`);
    return null;
  } catch (e) {
    const message = scrub((e as Error).message);
    if ((e as { status?: number }).status === 409)
      return stop(`${message} Sign in to Tailscale on this computer (\`tailscale up\`), then try again.`, 2);
    return stop(message);
  }
}

/** One word for a POSIX shell: single-quoted, so a host or an address can't add a command. */
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * What runs on the other device: find `hildegard` (ssh gives a command the account's minimal PATH, so the installer's
 * folder is tried too), then run it with the rest. Exit 127 means it isn't there.
 */
const FIND = [
  'h=$(command -v hildegard 2>/dev/null)',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell syntax, not a template
  '[ -n "$h" ] || for d in "${XDG_BIN_HOME:-$HOME/.local/bin}" "$HOME/.local/bin" /usr/local/bin /opt/homebrew/bin "$HOME/.hildegard/bin"; do [ -x "$d/hildegard" ] && h="$d/hildegard" && break; done',
  '[ -n "$h" ] || { echo "Hildegard isn’t installed on this account, or isn’t on its PATH." >&2; exit 127; }',
  'exec "$h" "$@"',
].join('\n');

const remoteCommand = (args: string[]) => ['sh', '-c', shq(FIND), 'hildegard', ...args.map(shq)].join(' ');

/** A host is a name or an address for `ssh`, never something it could read as an option. */
const validHost = (h: string) => /^[A-Za-z0-9_][A-Za-z0-9_.@:%[\]-]*$/.test(h);

const collect = (s: Readable | null, max = 16_000) => {
  let text = '';
  s?.setEncoding('utf8');
  s?.on('data', (d: string) => {
    if (text.length < max) text += d;
  });
  return () => text;
};

const finished = (p: ChildProcess) =>
  new Promise<number>((resolve) => {
    p.once('error', () => resolve(-1));
    p.once('close', (code) => resolve(code ?? -1));
  });

/** This same `hildegard`, on this computer's server. */
const self = (ctx: Ctx, args: string[], stdio: ['ignore' | 'pipe', 'pipe', 'pipe']) =>
  spawn(
    process.execPath,
    [entry(), ...args, '--port', String(ctx.config.port), '--data', ctx.config.dataDir],
    { stdio },
  );

/** The ssh on the other end; HILDEGARD_SSH names another program, for a wrapper or a test. */
const ssh = (host: string, args: string[], stdin: 'ignore' | 'pipe') =>
  spawn(
    process.env.HILDEGARD_SSH ?? 'ssh',
    ['-T', '-o', 'ConnectTimeout=15', '--', host, remoteCommand(args)],
    { stdio: [stdin, 'pipe', 'pipe'] },
  );

interface Joined {
  ok?: boolean;
  steps?: Step[];
  message?: string;
  device?: { name: string; models?: string[] };
  choir?: unknown;
}

/**
 * `choir pair <ssh-host>` (or `--from <host>`): the other device has the GPU. Its `choir invite --code-only` is piped
 * over ssh into this computer's `choir join --code-stdin`. `choir pair --to <host>` is the reverse: this computer
 * has the GPU and the other joins it. `--url` is the sharing device's address (else Tailscale's), `--name` what the
 * joining device calls the other.
 */
export async function pair(ctx: Ctx, args: string[]): Promise<Result> {
  const from = ctx.opts.get('from') ?? args[0];
  const to = ctx.opts.get('to');
  const host = to ?? from;
  const fail = (detail: string, status: Step['status'] = 'failed', command?: string) =>
    result(
      [{ id: 'pair', title: 'Pair devices', status, detail: scrub(detail), ...(command ? { command } : {}) }],
      status === 'needs-owner' ? 'Waiting on you.' : scrub(detail),
    );
  if (!host || (from && to && ctx.opts.has('from')))
    return fail(
      'Say which device: `hildegard choir pair <ssh-host>` when that device has the GPU, or `hildegard choir pair --to <ssh-host>` when this one does.',
    );
  if (!validHost(host)) return fail(`“${host}” isn’t a host name ssh can use.`);

  const url = ctx.opts.get('url');
  const name = ctx.opts.get('name');
  const invite = ['choir', 'invite', '--code-only', ...(url ? ['--url', url] : [])];
  const join = ['choir', 'join', '--code-stdin', '--json', ...(name ? ['--name', name] : [])];
  // The producer's stdout goes to the consumer's stdin, and nowhere else.
  const producer = to ? self(ctx, invite, ['ignore', 'pipe', 'pipe']) : ssh(host, invite, 'ignore');
  const consumer = to ? ssh(host, join, 'pipe') : self(ctx, join, ['pipe', 'pipe', 'pipe']);
  producer.stdout?.pipe(consumer.stdin!);
  consumer.stdin?.on('error', () => {});
  const sent = collect(producer.stderr);
  const said = collect(consumer.stdout);
  const complained = collect(consumer.stderr);
  const timer = setTimeout(() => {
    producer.kill();
    consumer.kill();
  }, 180_000);
  const [sentCode, joinCode] = await Promise.all([finished(producer), finished(consumer)]);
  clearTimeout(timer);

  const giver = to ? 'this computer' : host;
  const getter = to ? host : 'this computer';
  if (sentCode !== 0) {
    const why = scrub(sent().trim());
    if (sentCode === 255 || sentCode === -1)
      return fail(
        `Couldn’t reach ${to ? host : giver} over ssh. Check that \`ssh ${host}\` works on its own, without a password prompt.${why ? ` ${why}` : ''}`,
      );
    if (sentCode === 127)
      return fail(
        `Hildegard isn’t installed on ${giver}, or isn’t on its PATH or in ~/.local/bin. Install it there first.${why ? ` ${why}` : ''}`,
      );
    if (sentCode === 2)
      return fail(
        `${giver === 'this computer' ? 'This computer' : giver} needs Tailscale before it can share its GPU. Signing in is the owner’s step.${why ? ` ${why}` : ''}`,
        'needs-owner',
        to ? 'tailscale up' : `ssh -t ${host} tailscale up`,
      );
    return fail(`${giver} couldn’t make a code. ${why || 'Run `hildegard doctor` there.'}`);
  }
  let r: Joined | null = null;
  try {
    r = scrubAll(JSON.parse(said()) as Joined);
  } catch {}
  if (!r) {
    const why = scrub(complained().trim());
    if (joinCode === 255)
      return fail(
        `Couldn’t reach ${host} over ssh. Check that \`ssh ${host}\` works on its own.${why ? ` ${why}` : ''}`,
      );
    return fail(`${getter} gave no answer to the join.${why ? ` ${why}` : ' Run `hildegard doctor` there.'}`);
  }
  const asked: Step = {
    id: 'invite',
    title: `Ask ${giver} for a one-time code`,
    status: 'done',
    detail: `The code went straight from ${giver} into the join on ${getter}. It was never shown, saved or typed.`,
  };
  const steps = r.steps ?? [];
  return result([asked, ...steps], r.message ?? (r.ok ? `Joined ${giver}.` : 'The join failed.'), {
    ok: r.ok !== false && !steps.some((s) => s.status === 'failed'),
    ...(r.device ? { device: r.device, models: r.device.models ?? [] } : {}),
    ...(r.choir ? { choir: r.choir } : {}),
  });
}

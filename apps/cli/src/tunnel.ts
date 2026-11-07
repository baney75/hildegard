// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `hildegard tunnel`: reach this Hildegard from your other devices through a tunnel on an account you own.
 *
 *   tunnel [status]                   where Tailscale and Cloudflare stand here, and the next step for each
 *   tunnel tailscale [--funnel]       Tailscale Serve: your own devices only. --funnel: the public internet
 *   tunnel cloudflare --hostname <n>  a Cloudflare named tunnel on a domain in your account, at a name that stays
 *   tunnel cloudflare --quick         a quick tunnel: no account, a trycloudflare.com name that changes each start
 *   tunnel cloudflare --login         sign this computer in to your Cloudflare account
 *   tunnel install cloudflare         fetch the pinned cloudflared into Hildegard's own folder
 *   tunnel auto                       turn on the best link this computer can: Tailscale Serve if signed in, else a
 *                                     quick tunnel if cloudflared is here, else say what is missing
 *   tunnel off                        turn the link off, and read back that nothing forwards here
 *
 * `--signup` with either provider opens its own page for a free account. Hildegard never makes an account, never
 * installs anything you didn't ask for, and never puts a token in a link or a log.
 */
import { createInterface } from 'node:readline/promises';
import type { HostState, TunnelReport } from '@hildegard/presets';
import type { Step } from '@hildegard/runtime';
import { api, type Ctx, ensureRunning, openInBrowser } from './commands.ts';
import { FUNNEL_WARNING, host, hostOn } from './host.ts';
import { type Result, result } from './output.ts';

export const CLOUDFLARE_WARNING =
  'A Cloudflare tunnel puts this Hildegard on the public internet: anyone who finds the name can reach its sign-in page and try passphrases (Hildegard slows them down). Only the people you invite can get in. Turn it off with `hildegard tunnel off`; the tunnel and its DNS record stay in your Cloudflare account, for next time.';

export const QUICK_WARNING =
  'A quick tunnel is temporary: it has no account, its trycloudflare.com name changes every time Hildegard starts, and Cloudflare may stop it at any time. Anyone who finds the name can reach the sign-in page. Cloudflare doesn’t pass the Studio’s live updates through a quick tunnel, so reload the page to see new takes, and chatbot connectors may not work. For a name that stays, use a named tunnel: `hildegard tunnel cloudflare --hostname hildegard.<your domain>`.';

type Report = TunnelReport;
type Provider = 'tailscale' | 'cloudflare';
const TITLE: Record<Provider, string> = { tailscale: 'Tailscale', cloudflare: 'Cloudflare' };

/**
 * One provider as a step. `chosen` is the provider being set up: what it still needs is the owner's to do. In a plain
 * status read, a provider that isn't set up is just there to pick, not something owed.
 */
export function providerStep(name: Provider, r: Report, chosen = false): Step {
  const p = r[name];
  const id = name;
  const title = TITLE[name];
  const owed = chosen ? 'needs-owner' : 'skipped';
  const noAccount = `No account? Make a free one on ${title}’s page: ${p.signup}${name === 'cloudflare' ? ' (a named tunnel also needs a domain in it)' : ''}.`;
  switch (p.state) {
    case 'on': {
      const url = r.host.url ?? '';
      const how =
        name === 'tailscale'
          ? r.tailscale.funnel
            ? 'the public internet, through Funnel'
            : 'your own tailnet only, through Serve'
          : r.cloudflare.temporary
            ? 'a temporary quick tunnel: its name changes each time Hildegard starts'
            : `the named tunnel ${r.cloudflare.tunnel?.name ?? ''} in your Cloudflare account`.trim();
      return { id, title, status: 'done', detail: `Your link runs through it: ${url}, on ${how}.` };
    }
    case 'problem':
      return {
        id,
        title,
        status: p.fix ? 'needs-owner' : 'failed',
        detail: p.problem ?? 'It isn’t working.',
        ...(p.fix ? { command: p.fix } : {}),
      };
    case 'missing':
      return {
        id,
        title,
        status: owed,
        detail: `${p.problem} ${p.install ? `Install it with \`${p.install}\`, or from ${p.download}.` : `Install it from ${p.download}.`} ${noAccount}`,
        command: p.install ?? p.download,
      };
    case 'signed-out':
      return {
        id,
        title,
        status: owed,
        detail: `${p.problem} Already have an account? ${p.signIn.startsWith('Open ') ? `${p.signIn}.` : `Sign in with \`${p.signIn}\`.`} ${noAccount}`,
        command: p.signIn,
      };
    default:
      return {
        id,
        title,
        status: 'skipped',
        detail:
          name === 'tailscale'
            ? `Signed in${r.tailscale.name ? ` as ${r.tailscale.name}` : ''}. Turn it on for your own devices with \`hildegard tunnel tailscale\`, or for the public internet with \`--funnel\`.`
            : `Signed in${r.cloudflare.tunnel ? `, with the tunnel ${r.cloudflare.tunnel.name}` : ''}. Turn it on with \`hildegard tunnel cloudflare --hostname ${r.cloudflare.hostname ?? 'hildegard.<your domain>'}\`.`,
        command:
          name === 'tailscale'
            ? 'hildegard tunnel tailscale'
            : `hildegard tunnel cloudflare --hostname ${r.cloudflare.hostname ?? 'hildegard.<your domain>'}`,
      };
  }
}

const report = (ctx: Ctx) => api<Report>(ctx.config, '/api/tunnel');

/** The next sentence for a status read: the one thing to do. */
function nextMove(r: Report): string {
  if (r.host.on && r.host.url) return `Open ${r.host.url} on your other devices and sign in.`;
  if (r.host.on) return r.host.problem ?? 'The link is on but not working yet.';
  if (r.tailscale.state === 'ready')
    return 'Tailscale is ready: `hildegard tunnel tailscale` puts Hildegard on your own devices.';
  if (r.cloudflare.state === 'ready')
    return 'Cloudflare is ready: `hildegard tunnel cloudflare --hostname hildegard.<your domain>`.';
  return 'Pick one: `hildegard tunnel tailscale` (your own devices) or `hildegard tunnel cloudflare` (a public name). Each says what it still needs.';
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** The provider's account page: opened at a terminal, given as a step either way. Hildegard never makes the account. */
function signup(ctx: Ctx, name: Provider, r: Report): Result {
  const url = r[name].signup;
  if (!ctx.json && process.stdout.isTTY) openInBrowser(url);
  const then =
    name === 'cloudflare'
      ? 'Add a domain to it (a named tunnel needs one), then run `hildegard tunnel cloudflare --login`. No domain? `hildegard tunnel cloudflare --quick` works without one, for now.'
      : `Then install Tailscale on this computer and your others, and sign in on each with the same account.`;
  return result(
    [
      {
        id: `${name}-account`,
        title: `Make a free ${TITLE[name]} account`,
        status: 'needs-owner',
        detail: `Make it yourself on ${TITLE[name]}’s own page: ${url}. ${then}`,
        command: url,
      },
    ],
    `The account is yours: Hildegard never makes one or signs in to it for you.`,
    { url },
  );
}

/** Sign this computer in to Cloudflare: the page goes to the owner; at a terminal, wait for them to finish. */
async function cloudflareLogin(ctx: Ctx): Promise<{ done: boolean; result?: Result }> {
  let r: { done: boolean; url: string | null; opened?: boolean };
  try {
    r = await api(ctx.config, '/api/tunnel/login', {
      method: 'POST',
      body: { provider: 'cloudflare' },
      timeoutMs: 30_000,
    });
  } catch (e) {
    const err = e as Error & { data?: { fix?: string | null } };
    return {
      done: false,
      result: result(
        [
          {
            id: 'cloudflare-login',
            title: 'Sign in to Cloudflare',
            status: err.data?.fix ? 'needs-owner' : 'failed',
            detail: err.message,
            ...(err.data?.fix ? { command: err.data.fix } : {}),
          },
        ],
        err.message,
      ),
    };
  }
  if (r.done) return { done: true };
  const step: Step = {
    id: 'cloudflare-login',
    title: 'Sign in to Cloudflare',
    status: 'needs-owner',
    detail: `Open this page, sign in to your Cloudflare account, and pick the domain for Hildegard: ${r.url}. Only open it for a sign-in you started.`,
    ...(r.url ? { command: r.url } : {}),
  };
  if (ctx.json || !process.stdin.isTTY)
    return {
      done: false,
      result: result([step], 'Waiting on you to sign in on that page; then run this again.', { url: r.url }),
    };
  console.log(`Open this page, sign in to Cloudflare and pick the domain for Hildegard:\n\n  ${r.url}\n`);
  if (r.url && !r.opened) openInBrowser(r.url);
  console.log('Waiting for you to finish there…');
  const end = Date.now() + 10 * 60_000;
  while (Date.now() < end) {
    await new Promise((res) => setTimeout(res, 2000));
    const now = await report(ctx).catch(() => null);
    if (now?.cloudflare.signedIn) return { done: true };
    if (now && !now.cloudflare.signingIn) break;
  }
  return {
    done: false,
    result: result([step], 'The sign-in didn’t finish. Run `hildegard tunnel cloudflare --login` again.'),
  };
}

/**
 * A public link is the person's own to turn on: at a terminal they confirm it here, in a script they say `--yes-public`.
 * Without either it changes nothing. (An AI app that runs this command in a pipe has neither.)
 */
async function confirmPublic(ctx: Ctx, what: string): Promise<{ ok: true } | { ok: false; result: Result }> {
  if (ctx.flags.has('yes-public')) return { ok: true };
  if (!ctx.json && process.stdin.isTTY) {
    console.log(`This link would be public. ${what}\n`);
    if (/^y(es)?$/i.test(await ask('Turn on a public link? [y/N] '))) return { ok: true };
    return { ok: false, result: result([], 'Nothing was turned on.') };
  }
  return {
    ok: false,
    result: result(
      [
        {
          id: 'public',
          title: 'Confirm the public link',
          status: 'needs-owner',
          detail: `This link would be public. ${what} Run the command at a terminal and confirm, or add --yes-public if you mean it.`,
          command: 'hildegard tunnel cloudflare --quick --yes-public',
        },
      ],
      'A public link is yours to confirm; nothing was turned on.',
    ),
  };
}

async function tunnelCloudflare(ctx: Ctx, r: Report): Promise<Result> {
  const quick = ctx.flags.has('quick');
  let hostname = ctx.opts.get('hostname');
  if (quick && hostname)
    return result(
      [],
      '`--quick` makes its own temporary name: leave out `--hostname`, or leave out `--quick`.',
      {
        ok: false,
      },
    );

  if (!r.cloudflare.installed) {
    const step = providerStep('cloudflare', r, true);
    if (r.cloudflare.canFetch && !ctx.json && process.stdin.isTTY && !ctx.flags.has('login')) {
      const yes = /^y(es)?$/i.test(
        await ask(
          'cloudflared isn’t installed. Fetch Cloudflare’s cloudflared into Hildegard’s own folder now? [y/N] ',
        ),
      );
      if (!yes) return result([step], 'Nothing was installed.');
      const got = await install(ctx, 'cloudflare');
      if (!got.ok) return got;
      r = await report(ctx);
    } else return result([step], 'Install cloudflared first. Hildegard installs nothing unless you ask.');
  }

  if (quick) {
    const yes = await confirmPublic(ctx, QUICK_WARNING);
    if (!yes.ok) return yes.result;
    return hostOn(ctx, { via: 'quick' }, QUICK_WARNING);
  }

  if (!r.cloudflare.signedIn) {
    if (!ctx.flags.has('login') && (ctx.json || !process.stdin.isTTY))
      return result(
        [providerStep('cloudflare', r, true)],
        'Sign this computer in to your Cloudflare account first: `hildegard tunnel cloudflare --login`.',
      );
    const login = await cloudflareLogin(ctx);
    if (!login.done) return login.result!;
    r = await report(ctx);
  } else if (ctx.flags.has('login') && !hostname) {
    return result(
      [
        {
          id: 'cloudflare-login',
          title: 'Sign in to Cloudflare',
          status: 'done',
          detail: 'This computer is already signed in to a Cloudflare account.',
        },
      ],
      `Next: \`hildegard tunnel cloudflare --hostname ${r.cloudflare.hostname ?? 'hildegard.<your domain>'}\`.`,
    );
  }

  hostname ??= r.cloudflare.hostname ?? undefined;
  if (!hostname && !ctx.json && process.stdin.isTTY)
    hostname = await ask(
      'The name people will open, on a domain in your Cloudflare account (like hildegard.example.com): ',
    );
  if (!hostname)
    return result(
      [
        {
          id: 'cloudflare-hostname',
          title: 'Name the link',
          status: 'needs-owner',
          detail:
            'Say the name people will open, on a domain in your Cloudflare account. Hildegard makes its DNS record, and never replaces one that is already there.',
          command: 'hildegard tunnel cloudflare --hostname hildegard.<your domain>',
        },
      ],
      'Say the name: `hildegard tunnel cloudflare --hostname hildegard.<your domain>`.',
    );
  return hostOn(ctx, { via: 'cloudflare', hostname }, CLOUDFLARE_WARNING);
}

async function install(ctx: Ctx, what: string | undefined): Promise<Result> {
  if (what === 'tailscale') {
    const r = await report(ctx);
    return result(
      [
        {
          id: 'tailscale',
          title: 'Install Tailscale',
          status: r.tailscale.installed ? 'done' : 'needs-owner',
          detail: r.tailscale.installed
            ? `Tailscale ${r.tailscale.version ?? ''} is installed.`.replace('  ', ' ')
            : `Tailscale runs as a system service, so you install it yourself${r.tailscale.install ? `: \`${r.tailscale.install}\`` : ''}, or from ${r.tailscale.download}.`,
          ...(r.tailscale.installed ? {} : { command: r.tailscale.install ?? r.tailscale.download }),
        },
      ],
      '',
    );
  }
  if (what !== 'cloudflare')
    return result([], 'Say which: `hildegard tunnel install cloudflare` (or tailscale).', { ok: false });
  if (!ctx.json)
    console.log('Fetching cloudflared from Cloudflare’s releases, checked against its pinned hash…');
  try {
    const r = await api<{ version: string }>(ctx.config, '/api/tunnel/install', {
      method: 'POST',
      body: { provider: 'cloudflare' },
      timeoutMs: 5 * 60_000,
    });
    return result(
      [
        {
          id: 'cloudflared',
          title: 'Install cloudflared',
          status: 'done',
          detail: `cloudflared ${r.version} is in Hildegard’s own tools folder. Nothing else on this computer changed.`,
        },
      ],
      'Next: `hildegard tunnel cloudflare --login`, or `--quick` for a temporary link with no account.',
      { version: r.version },
    );
  } catch (e) {
    const err = e as Error & { data?: { fix?: string | null } };
    return result(
      [
        {
          id: 'cloudflared',
          title: 'Install cloudflared',
          status: err.data?.fix ? 'needs-owner' : 'failed',
          detail: err.message,
          ...(err.data?.fix ? { command: err.data.fix } : {}),
        },
      ],
      err.message,
    );
  }
}

/** The same type the server's link-on.ts answers with; the CLI only reads it. */
interface LinkOnAnswer {
  status: 'on' | 'needs-owner' | 'confirm' | 'failed';
  already?: boolean;
  via?: string;
  url?: string;
  private?: boolean;
  temporary?: boolean;
  message: string;
  plan?: { route: string; public: boolean; id: string; ask: string };
  steps: { id: string; title: string; detail: string; command?: string }[];
}

/**
 * `tunnel auto`: the best link available, in one step. The server decides the route once and says which; a private
 * one (Tailscale) is turned on, since you typed the command, and a public one only after you confirm it (here, or
 * `--yes-public`). It never picks Funnel.
 */
async function auto(ctx: Ctx): Promise<Result> {
  const ask = (plan?: string, acceptPublic?: boolean) =>
    api<LinkOnAnswer>(ctx.config, '/api/link/on', {
      method: 'POST',
      body: { ...(plan ? { plan } : {}), ...(acceptPublic ? { acceptPublic } : {}) },
      timeoutMs: 120_000,
    });
  // Asks for the plan, then does exactly that plan: the question and the action are one answer of the server's.
  const settle = async (): Promise<{ answer: LinkOnAnswer } | { stop: Result }> => {
    let a = await ask();
    if (a.status === 'confirm' && a.plan) a = await ask(a.plan.id);
    else if (a.status === 'needs-owner' && a.plan?.public) {
      const yes = await confirmPublic(ctx, a.plan.ask);
      if (!yes.ok) return { stop: yes.result };
      a = await ask(a.plan.id, true);
      // The computer changed since it was asked (Tailscale came up): that is a new question, so ask it.
      if (a.status === 'confirm' && a.plan && !a.plan.public) a = await ask(a.plan.id);
      else if (a.status === 'confirm' || (a.status === 'needs-owner' && a.plan?.public))
        return {
          stop: result(
            [],
            'The computer changed while you were confirming. Run `hildegard tunnel auto` again.',
            {
              ok: false,
            },
          ),
        };
    }
    return { answer: a };
  };
  let a: LinkOnAnswer;
  try {
    const first = await settle();
    if ('stop' in first) return first.stop;
    a = first.answer;
  } catch (e) {
    const err = e as Error;
    return result(
      [{ id: 'link', title: 'Host at a link', status: 'failed', detail: err.message }],
      err.message,
    );
  }
  // At a terminal the owner account can be made right here; their passphrase is theirs to type.
  if (a.status === 'needs-owner' && a.steps[0]?.id === 'owner' && process.stdin.isTTY && !ctx.json) {
    const made = await host(ctx, ['owner']);
    if (!made.ok || made.needsOwner) return made;
    try {
      const again = await settle();
      if ('stop' in again) return again.stop;
      a = again.answer;
    } catch (e) {
      a = { status: 'failed', message: (e as Error).message, steps: [] };
    }
  }
  if (a.status === 'on')
    return result(
      [{ id: 'link', title: 'Host at a link', status: 'done', detail: a.message }],
      `Open ${a.url} on your phone and sign in.${a.temporary ? ' It is temporary: turn it off with `hildegard tunnel off` when you are done.' : ''}`,
      { url: a.url, via: a.via, private: a.private, temporary: a.temporary, already: a.already },
    );
  return result(
    a.steps.length
      ? a.steps.map((st) => ({
          id: st.id,
          title: st.title,
          status: a.status === 'failed' ? ('failed' as const) : ('needs-owner' as const),
          detail: st.detail,
          ...(st.command ? { command: st.command } : {}),
        }))
      : [{ id: 'link', title: 'Host at a link', status: 'failed', detail: a.message }],
    a.message,
  );
}

export async function tunnel(ctx: Ctx, args: string[]): Promise<Result> {
  const pre = await ensureRunning(ctx);
  if (pre?.status === 'failed') return result([pre], 'Hildegard isn’t running.');
  const action = args[0] ?? 'status';

  if (action === 'install') return install(ctx, args[1]);
  if (action === 'auto') return auto(ctx);

  if (action === 'off') {
    const before = await report(ctx);
    await api<HostState>(ctx.config, '/api/host/off', { method: 'POST', timeoutMs: 30_000 });
    // Read the real state back: off means nothing forwards here, not that the command ran.
    const r = await report(ctx);
    // Tailscale's own word, not Hildegard's: a route it refused to turn off still forwards here.
    const still = (['tailscale', 'cloudflare'] as const).filter(
      (p) => r[p].state === 'on' || (p === 'tailscale' && r.tailscale.forwarding),
    );
    const ok = !r.host.on && still.length === 0;
    return result(
      [
        {
          id: 'host',
          title: 'Host at a link',
          status: ok ? 'done' : 'failed',
          detail: ok
            ? 'Off. Nothing forwards to this Hildegard now; only this computer can use it.'
            : `Still on through ${still.map((p) => TITLE[p]).join(' and ') || 'the link'}. ${r.tailscale.forwarding ? (r.tailscale.problem ?? '') : (r.host.problem ?? '')}`.trim(),
          ...(r.tailscale.forwarding && r.tailscale.fix ? { command: r.tailscale.fix } : {}),
        },
      ],
      ok
        ? before.cloudflare.tunnel
          ? `The tunnel ${before.cloudflare.tunnel.name} and its DNS record stay in your Cloudflare account, for next time.`
          : 'People and their films stay, for the next time.'
        : 'The link didn’t turn off. `hildegard doctor` says why.',
      { report: r },
    );
  }

  const r = await report(ctx);
  if (action === 'status')
    return result([providerStep('tailscale', r), providerStep('cloudflare', r)], nextMove(r), { report: r });

  if (action !== 'tailscale' && action !== 'cloudflare')
    return result(
      [],
      'Use `hildegard tunnel`, `tunnel auto`, `tunnel tailscale [--funnel]`, `tunnel cloudflare [--hostname <name> | --quick [--yes-public] | --login]`, `tunnel install cloudflare`, `tunnel off`, or --signup with a provider.',
      { ok: false },
    );
  if (ctx.flags.has('signup')) return signup(ctx, action, r);
  if (action === 'cloudflare') return tunnelCloudflare(ctx, r);

  // Tailscale: Serve for your own devices; Funnel only when asked for by name.
  if (r.tailscale.state === 'missing' || r.tailscale.state === 'signed-out')
    return result(
      [providerStep('tailscale', r, true)],
      r.tailscale.state === 'missing'
        ? 'Install Tailscale first.'
        : 'Sign this computer in to Tailscale first.',
    );
  const funnel = ctx.flags.has('funnel');
  return hostOn(ctx, { via: funnel ? 'funnel' : 'tailscale' }, funnel ? FUNNEL_WARNING : null);
}

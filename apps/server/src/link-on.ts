// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The link, turned on in one step: `link_on` (MCP), `hildegard tunnel auto` (CLI) and the Studio's "Record on your
 * phone" all come here. The route is decided ONCE, as a plan (`planLink`), in this order:
 *
 *  1. Tailscale Serve, when Tailscale is signed in: private to the person's own tailnet.
 *  2. A Cloudflare quick tunnel, when cloudflared is here: temporary, and its sign-in page is public.
 *  3. Otherwise nothing is changed: it says what the owner can do (one click or one command), and why.
 *
 * The question and the action always match: the plan carries a short id, whoever confirms sends that id back, and
 * `linkOn` turns on only that plan's route, or answers `confirm` with the new plan when it changed since. It never moves
 * to another route after a yes.
 *
 * A public route (the quick tunnel) is turned on only when the caller says `acceptPublic`, and only the person's own
 * click (the Studio's dialog) or command (the CLI's confirm, or `--yes-public`) does that. The MCP never does: `confirmed`
 * is the AI app's own word, and text it read can make it say yes. Funnel is never chosen here. The owner account comes
 * first, because the link signs people in; Hildegard never picks a passphrase. Nothing is installed here either:
 * `hildegard tunnel install cloudflare` is the owner's to run.
 */
import { createHash } from 'node:crypto';
import type { HostState } from '@hildegard/presets';
import { type Host, HostError } from './host.ts';
import {
  CLOUDFLARE_PAGES,
  type Cloudflared,
  canFetchCloudflared,
  cloudflaredInstall,
  TAILSCALE_PAGES,
  tailscaleInfo,
  tailscaleInstall,
} from './tunnel.ts';

/** One thing for the owner to do, in the same words the CLI's steps use. */
export interface LinkStep {
  id: string;
  title: string;
  detail: string;
  /** The command to run, or the page to open. */
  command?: string;
}

export type LinkOnResult =
  | {
      status: 'on';
      /** The link was already on; nothing was changed. */
      already: boolean;
      via: 'tailscale' | 'quick' | 'funnel' | 'address' | 'cloudflare' | 'custom';
      url: string;
      /** Only this person's own devices can open it (Tailscale), so the sign-in page is not on the internet. */
      private: boolean;
      /** The name changes when Hildegard restarts, and Cloudflare may stop it. */
      temporary: boolean;
      /** What to tell the person, in plain words. */
      message: string;
      steps: LinkStep[];
    }
  | { status: 'needs-owner'; message: string; steps: LinkStep[]; plan?: LinkPlan }
  /** Nothing was changed: this is what would happen. Send `plan.id` back to do it. */
  | { status: 'confirm'; message: string; steps: LinkStep[]; plan: LinkPlan }
  | { status: 'failed'; message: string; steps: LinkStep[] };

/** What turning the link on would do, decided once. */
export interface LinkPlan {
  route: 'tailscale' | 'quick' | 'none';
  /** The sign-in page would be on the internet. */
  public: boolean;
  /** Names this plan; a confirm must send it back, and a changed plan has another id. */
  id: string;
  /** The question for the person, worded for this route. */
  ask: string;
}

export const QUICK_NOTE =
  'This is a temporary link through Cloudflare: it has no account, its name changes every time Hildegard restarts, and anyone who finds the name can reach Hildegard’s sign-in page (only people you invite can get in). Turn it off when you’re done.';
export const TAILSCALE_NOTE =
  'This link is private: only devices signed in to your Tailscale account can reach it. Your phone needs the Tailscale app, signed in to the same account.';

export const ASK_PRIVATE =
  'Hildegard will turn on a private link to this computer through Tailscale. Only devices signed in to your Tailscale account can open it, so your phone needs Tailscale too. Turn it on?';
export const ASK_PUBLIC =
  'Hildegard will turn on a PUBLIC link to this computer through Cloudflare. It is temporary (a trycloudflare.com name that changes whenever Hildegard restarts), and anyone who has the link can reach Hildegard’s sign-in page; only people you invite can get in. Turn it on?';
/** What an AI app tells the person when a phone link could only be public: it can't turn that on itself. */
export const PUBLIC_REFUSED =
  'A phone link here would be public: Hildegard would make a temporary trycloudflare.com name, and anyone who has the link can reach Hildegard’s sign-in page. An AI app can’t turn that on. You can: tap “Record on your phone” in the Hildegard Studio and confirm, or run `hildegard tunnel cloudflare --quick` (or `hildegard tunnel auto`) in a terminal.';
const NOTHING_ASK =
  'Hildegard has no way to make a link on this computer yet. Tailscale (private to your devices) or cloudflared (a temporary public link) would do it.';

export interface LinkOnDeps {
  host: Host;
  cloudflared?: Cloudflared;
  /** Whether the owner account exists. */
  owner: () => boolean;
}

/** How a state's link is reached: Funnel, a tunnel and a custom front door are the internet's. */
export function viaOf(h: Pick<HostState, 'via' | 'tunnel'>): string {
  return h.via === 'custom' ? (h.tunnel ?? 'custom') : (h.via ?? 'custom');
}
/** Only Tailscale Serve (or an address on the tailnet) keeps the sign-in page off the internet. */
export const isPrivateLink = (h: Pick<HostState, 'via' | 'tunnel'>): boolean => {
  const via = viaOf(h);
  return via === 'tailscale' || via === 'address';
};

/** How the link a state describes is reached, for the answer. */
function describe(h: HostState, already: boolean): Extract<LinkOnResult, { status: 'on' }> {
  const url = h.url ?? '';
  const via = viaOf(h) as Extract<LinkOnResult, { status: 'on' }>['via'];
  const priv = isPrivateLink(h);
  const temporary = via === 'quick';
  const note = priv
    ? TAILSCALE_NOTE
    : temporary
      ? QUICK_NOTE
      : via === 'funnel'
        ? 'This link is on the public internet through Tailscale Funnel: anyone who finds the name can reach Hildegard’s sign-in page.'
        : 'This link is reachable from the internet: anyone who finds the name can reach Hildegard’s sign-in page.';
  return {
    status: 'on',
    already,
    via,
    url,
    private: priv,
    temporary,
    message: `${already ? 'Hildegard’s link was already on' : 'Hildegard’s link is on'}: ${url}. ${note}`,
    steps: [],
  };
}

const ownerStep = (): LinkStep => ({
  id: 'owner',
  title: 'Make the owner account',
  detail:
    'The link signs people in, so it needs the owner account first. Make it in the Studio (Settings › Sharing), or run the command. You choose the passphrase; Hildegard never does.',
  command: 'hildegard host owner',
});

function hostProblem(e: unknown): LinkOnResult {
  if (!(e instanceof HostError)) throw e;
  const step: LinkStep = {
    id: 'link',
    title: 'Turn on Hildegard’s link',
    detail: e.message,
    ...(e.fix ? { command: e.fix } : {}),
  };
  // A refusal with a way out is the owner's to do; one without (Tailscale or Cloudflare failed) is a failure.
  return e.fix
    ? { status: 'needs-owner', message: e.message, steps: [step] }
    : { status: 'failed', message: e.message, steps: [step] };
}

const planId = (route: string, now: HostState) =>
  createHash('sha256')
    .update(`${route}|${now.on ? viaOf(now) : ''}|${now.on ? (now.url ?? '') : ''}`)
    .digest('hex')
    .slice(0, 8);

/**
 * What turning the link on would do right now, decided once and changing nothing. Tailscale Serve when it is signed
 * in here (even if it then can't serve: that is told, not swapped for a public route), else a quick tunnel when
 * cloudflared is here, else nothing. A link that is already on doesn't count as a route: the plan is for a new one.
 */
export async function planLink(d: LinkOnDeps): Promise<LinkPlan> {
  const now = d.host.state();
  const make = (route: LinkPlan['route'], ask: string): LinkPlan => ({
    route,
    public: route === 'quick',
    id: planId(route, now),
    ask,
  });
  if (await d.host.tailscale(true)) return make('tailscale', ASK_PRIVATE);
  if (d.cloudflared && (await d.cloudflared.find(true))) return make('quick', ASK_PUBLIC);
  return make('none', NOTHING_ASK);
}

/** Nothing to use. One click or one command each, and Hildegard installs neither. */
async function missing(d: LinkOnDeps, plan: LinkPlan): Promise<LinkOnResult> {
  const info = await tailscaleInfo(d.host.run);
  const steps: LinkStep[] = [];
  if (d.cloudflared) {
    const cmd = cloudflaredInstall();
    steps.push({
      id: 'cloudflared',
      title: 'Install cloudflared',
      detail: canFetchCloudflared()
        ? 'Hildegard can fetch Cloudflare’s cloudflared into its own folder (checked against a pinned hash), for a temporary link with no account. Settings › Sharing has the button; the command does the same.'
        : `Install cloudflared for a temporary link with no account: ${cmd ?? CLOUDFLARE_PAGES.download}.`,
      command: cmd ?? CLOUDFLARE_PAGES.download,
    });
  }
  steps.push(
    info.installed
      ? {
          id: 'tailscale',
          title: 'Sign in to Tailscale',
          detail:
            'Tailscale is installed but not signed in. Signed in, it gives a private link that only your own devices can open.',
          command:
            process.platform === 'darwin' || process.platform === 'win32'
              ? 'Open the Tailscale app and sign in'
              : 'tailscale up',
        }
      : {
          id: 'tailscale',
          title: 'Install Tailscale',
          detail: `A private link that only your own devices can open. Install it on this computer and on your phone, and sign in to the same free account (${TAILSCALE_PAGES.signup}).`,
          command: tailscaleInstall() ?? TAILSCALE_PAGES.download,
        },
  );
  return { status: 'needs-owner', message: plan.ask, steps, plan };
}

/** What the caller sends: the plan it asked the person about, and whether the person themselves accepted a public one. */
export interface LinkOnRequest {
  /** `plan.id` of the plan the person confirmed. Without it nothing is changed. */
  plan?: string;
  /** The person (the Studio's dialog, the CLI's confirm) accepted a public route. An AI app never sends it. */
  acceptPublic?: boolean;
}

/** Turns on the link the plan names, and no other. Callers check that the request is from this computer. */
export async function linkOn(d: LinkOnDeps, req: LinkOnRequest = {}): Promise<LinkOnResult> {
  const now = d.host.state();
  const live = now.on && !!now.url && !now.problem;
  // A private link that is on is the answer. A public one is too, unless a plan is being confirmed (below).
  if (live && (isPrivateLink(now) || req.plan === undefined)) return describe(now, true);

  if (!d.owner())
    return {
      status: 'needs-owner',
      message: 'Make the owner account first, so people can sign in on the link.',
      steps: [ownerStep()],
    };

  const plan = await planLink(d);
  // A public link already on stays unless there is a private route to move it to.
  if (live && plan.route !== 'tailscale') return describe(now, true);
  if (plan.route === 'none') return missing(d, plan);

  // A public route is the person's own to accept; the answer tells them how, and nothing starts.
  if (plan.public && req.acceptPublic !== true)
    return {
      status: 'needs-owner',
      message: PUBLIC_REFUSED,
      plan,
      steps: [
        {
          id: 'studio',
          title: 'In the Studio',
          detail: 'Tap “Record on your phone” and confirm the public link in the dialog.',
        },
        {
          id: 'terminal',
          title: 'In a terminal',
          detail: 'It asks you to confirm before it turns on a public link.',
          command: 'hildegard tunnel cloudflare --quick',
        },
      ],
    };

  // The yes was to a plan; if the computer changed since (Tailscale came up or went down), ask again for the new one.
  if (req.plan !== plan.id)
    return {
      status: 'confirm',
      message: plan.ask,
      steps: [],
      plan,
    };

  try {
    return describe(await d.host.on({ via: plan.route }), false);
  } catch (e) {
    return hostProblem(e);
  }
}

// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The link, turned on in one step: `link_on` (MCP), `hildegard tunnel auto` (CLI) and the Studio's "Record on your
 * phone" all come here. It picks the best route this computer has, in this order, and never anything public that the
 * person didn't get told about:
 *
 *  1. Tailscale Serve, when Tailscale is signed in: private to the person's own tailnet.
 *  2. A Cloudflare quick tunnel, when cloudflared is here: temporary, and its sign-in page is public. The answer says so.
 *  3. Otherwise nothing is changed: it says what the owner can do (one click or one command), and why.
 *
 * Funnel is never chosen here. The owner account comes first, because the link signs people in; Hildegard never picks
 * a passphrase. Nothing is installed here either: `hildegard tunnel install cloudflare` is the owner's to run.
 */
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
  | { status: 'needs-owner'; message: string; steps: LinkStep[] }
  | { status: 'failed'; message: string; steps: LinkStep[] };

export const QUICK_NOTE =
  'This is a temporary link through Cloudflare: it has no account, its name changes every time Hildegard restarts, and anyone who finds the name can reach Hildegard’s sign-in page (only people you invite can get in). Turn it off when you’re done.';
export const TAILSCALE_NOTE =
  'This link is private: only devices signed in to your Tailscale account can reach it. Your phone needs the Tailscale app, signed in to the same account.';

export interface LinkOnDeps {
  host: Host;
  cloudflared?: Cloudflared;
  /** Whether the owner account exists. */
  owner: () => boolean;
}

/** How the link a state describes is reached, for the answer. */
function describe(h: HostState, already: boolean): Extract<LinkOnResult, { status: 'on' }> {
  const url = h.url ?? '';
  const via = h.via === 'custom' ? (h.tunnel ?? 'custom') : (h.via ?? 'custom');
  const priv = via === 'tailscale' || via === 'address';
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

/** Turns on the best available link. Callers check that the request is from this computer. */
export async function linkOn(d: LinkOnDeps): Promise<LinkOnResult> {
  const now = d.host.state();
  if (now.on && now.url && !now.problem) return describe(now, true);

  if (!d.owner())
    return {
      status: 'needs-owner',
      message: 'Make the owner account first, so people can sign in on the link.',
      steps: [ownerStep()],
    };

  // 1. Tailscale Serve, when it is signed in here. If it is signed in but can't serve (HTTPS not turned on for the
  // tailnet, say), say so rather than quietly choosing a public route in its place.
  const ts = await d.host.tailscale(true);
  if (ts) {
    try {
      return describe(await d.host.on({ via: 'tailscale' }), false);
    } catch (e) {
      return hostProblem(e);
    }
  }

  // 2. A quick tunnel, when cloudflared is already here.
  if (d.cloudflared && (await d.cloudflared.find(true))) {
    try {
      return describe(await d.host.on({ via: 'quick' }), false);
    } catch (e) {
      return hostProblem(e);
    }
  }

  // 3. Nothing to use. One click or one command each, and Hildegard installs neither.
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
  return {
    status: 'needs-owner',
    message:
      'Hildegard has no way to make a link yet. Tailscale (private to your devices) or cloudflared (a temporary public link) would do it.',
    steps,
  };
}

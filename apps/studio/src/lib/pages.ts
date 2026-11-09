// SPDX-License-Identifier: AGPL-3.0-only
import { type ComponentType, createElement } from 'react';

/**
 * Each page is its own chunk, fetched when its route is first opened, so the first paint carries the shell and one
 * page, not all of them. `preloadRoute` starts that fetch from the address alone, before React renders, so it runs
 * beside the sign-in and snapshot requests instead of after them.
 */
const loaders = {
  agents: () => import('./../pages/Agents.tsx').then((m) => ({ default: m.Agents })),
  characters: () => import('./../pages/Characters.tsx').then((m) => ({ default: m.Characters })),
  cinema: () => import('./../pages/Cinema.tsx').then((m) => ({ default: m.Cinema })),
  images: () => import('./../pages/Images.tsx').then((m) => ({ default: m.Images })),
  likeness: () => import('./../pages/Likeness.tsx').then((m) => ({ default: m.Likeness })),
  likenessRevoke: () => import('./../pages/Likeness.tsx').then((m) => ({ default: m.LikenessRevoke })),
  queue: () => import('./../pages/Queue.tsx').then((m) => ({ default: m.Queue })),
  settings: () => import('./../pages/Settings.tsx').then((m) => ({ default: m.Settings })),
  signIn: () => import('./../pages/SignIn.tsx').then((m) => ({ default: m.SignIn })),
  acceptInvite: () => import('./../pages/SignIn.tsx').then((m) => ({ default: m.AcceptInvite })),
  sites: () => import('./../pages/Sites.tsx').then((m) => ({ default: m.Sites })),
  talk: () => import('./../pages/Talk.tsx').then((m) => ({ default: m.Talk })),
  talkScript: () => import('./../pages/TalkScript.tsx').then((m) => ({ default: m.TalkScript })),
  voice: () => import('./../pages/Voice.tsx').then((m) => ({ default: m.Voice })),
  consentPhone: () => import('./../pages/voice/ConsentPhone.tsx').then((m) => ({ default: m.ConsentPhone })),
  welcome: () => import('./../pages/Welcome.tsx').then((m) => ({ default: m.Welcome })),
};

type Loader<P> = () => Promise<{ default: ComponentType<P> }>;
interface Entry {
  promise: Promise<unknown>;
  component?: ComponentType<never>;
  error?: unknown;
}
// biome-ignore lint/suspicious/noExplicitAny: keyed by loaders of any page's props
const loaded = new Map<Loader<any>, Entry>();

// biome-ignore lint/suspicious/noExplicitAny: a loader of any page's props
function start(load: Loader<any>): Entry {
  let entry = loaded.get(load);
  if (!entry) {
    const e: Entry = { promise: Promise.resolve() };
    e.promise = load().then(
      (m) => {
        e.component = m.default as ComponentType<never>;
      },
      (err) => {
        e.error = err;
      },
    );
    loaded.set(load, e);
    entry = e;
  }
  return entry;
}

/**
 * Like React.lazy, but a page whose code arrived before it was first drawn (the usual case, since the fetch starts
 * with the address) is drawn at once, without a pass that suspends and shows a placeholder first.
 */
export function page<P extends object>(load: Loader<P>): ComponentType<P> {
  return function Page(props: P) {
    const entry = start(load);
    // A failed load stays failed, so every render throws the same error and PageGate (App.tsx) shows it; the
    // person's Reload starts the page afresh. Clearing it here would let React's retry suspend on a new import.
    if (entry.error) throw entry.error;
    if (!entry.component) throw entry.promise;
    return createElement(entry.component as ComponentType<P>, props);
  };
}

export const Agents = page(loaders.agents);
export const Characters = page(loaders.characters);
export const Cinema = page(loaders.cinema);
export const Images = page(loaders.images);
export const Likeness = page(loaders.likeness);
export const LikenessRevoke = page(loaders.likenessRevoke);
export const Queue = page(loaders.queue);
export const Settings = page(loaders.settings);
export const SignIn = page(loaders.signIn);
export const AcceptInvite = page(loaders.acceptInvite);
export const Sites = page(loaders.sites);
export const Talk = page(loaders.talk);
export const TalkScript = page(loaders.talkScript);
export const Voice = page(loaders.voice);
export const ConsentPhone = page(loaders.consentPhone);
export const Welcome = page(loaders.welcome);

/** Start fetching the page a route will show. Safe to call any number of times: a module loads once. */
export function preloadRoute(route: string): void {
  const first = route.split('/').filter(Boolean)[0];
  const load =
    first === 'consent'
      ? loaders.consentPhone
      : first === 'likeness'
        ? loaders.likeness
        : first === 'invite'
          ? loaders.acceptInvite
          : first === 'images'
            ? loaders.images
            : first === 'queue'
              ? loaders.queue
              : first === 'characters'
                ? loaders.characters
                : first === 'agents'
                  ? loaders.agents
                  : first === 'sites'
                    ? loaders.sites
                    : first === 'voice'
                      ? loaders.voice
                      : first === 'talk'
                        ? loaders.talk
                        : first === 'settings'
                          ? loaders.settings
                          : loaders.cinema;
  void start(load);
}

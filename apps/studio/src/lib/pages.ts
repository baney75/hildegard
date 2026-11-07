// SPDX-License-Identifier: AGPL-3.0-only
import { lazy } from 'react';

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

export const Agents = lazy(loaders.agents);
export const Characters = lazy(loaders.characters);
export const Cinema = lazy(loaders.cinema);
export const Images = lazy(loaders.images);
export const Likeness = lazy(loaders.likeness);
export const LikenessRevoke = lazy(loaders.likenessRevoke);
export const Queue = lazy(loaders.queue);
export const Settings = lazy(loaders.settings);
export const SignIn = lazy(loaders.signIn);
export const AcceptInvite = lazy(loaders.acceptInvite);
export const Sites = lazy(loaders.sites);
export const Talk = lazy(loaders.talk);
export const TalkScript = lazy(loaders.talkScript);
export const Voice = lazy(loaders.voice);
export const ConsentPhone = lazy(loaders.consentPhone);
export const Welcome = lazy(loaders.welcome);

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
  void load();
}

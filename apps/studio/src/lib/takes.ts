// SPDX-License-Identifier: AGPL-3.0-only
import type { Take } from '@hildegard/presets';
import { api } from './api.ts';
import { upsert } from './store.ts';

/**
 * One more take of a take's shot with the same settings: a new seed unless one is given, and draft quality unless
 * final is asked for (a draft's seed at final quality finalizes it). Resolves to the new take's id.
 */
export async function takeAgain(t: Take, over: { seed?: number; quality?: 'draft' | 'final' } = {}) {
  const r = await api.createShot({
    shotId: t.shotId,
    request: {
      ...t.request,
      takes: 1,
      seed: over.seed,
      // Another take is a draft unless asked for final: after a Finalize, the shot's last take is a final one.
      format: { ...t.request.format, quality: over.quality ?? 'draft' },
    },
  });
  upsert([{ type: 'shot', shot: r.shot }, ...r.takes.map((take) => ({ type: 'take' as const, take }))]);
  return r.takes[0]?.id ?? null;
}

/** Keep a take, or let it go. */
export async function toggleKeep(t: Take) {
  upsert({ type: 'take', take: await api.keep(t.id, !t.kept) });
}

/** Whether a stopped take can simply run again: a refused one can't, since the same prompt is refused again. */
export const canRetry = (t: Take) =>
  (t.status === 'failed' || t.status === 'canceled') && t.error?.code !== 'content_blocked';

// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useState } from 'react';
import { api, type RecordingInfo } from './api.ts';

/** The recordings that have arrived for this person, newest first; `refresh` looks again (after one is kept). */
export function useRecordings(kind?: 'voice' | 'video') {
  const [list, setList] = useState<RecordingInfo[] | null>(null);
  const refresh = useCallback(() => {
    api
      .recordings()
      .then((all) => setList(kind ? all.filter((r) => r.kind === kind) : all))
      .catch(() => setList((l) => l ?? []));
  }, [kind]);
  useEffect(() => refresh(), [refresh]);
  return { list, refresh };
}

/** "Voice, 0:12 · Nov 7, 5:04 PM", for a recording in a list. */
export function recordingLabel(r: RecordingInfo): string {
  const when = r.receivedAt
    ? new Date(r.receivedAt).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : '';
  const len = r.seconds
    ? `${Math.floor(r.seconds / 60)}:${String(Math.round(r.seconds % 60)).padStart(2, '0')}`
    : '';
  return [r.kind === 'voice' ? 'Voice' : 'Video', len, when, r.clean ? 'cleaned' : '']
    .filter(Boolean)
    .join(' · ');
}

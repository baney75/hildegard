// SPDX-License-Identifier: AGPL-3.0-only
import type { Project, Take } from '@hildegard/presets';
import { useId, useMemo, useState } from 'react';
import { api } from '../lib/api.ts';
import { bytes, clock, roman } from '../lib/format.ts';
import { useStore } from '../lib/store.ts';
import { takeLabel } from './TakeCard.tsx';
import { Button, Icon, Modal, Status, toastError } from './ui.tsx';

/**
 * A line for when a film mixes final takes with drafts: drafts are sized up to match and look soft beside them.
 * Empty when the qualities match.
 */
export function draftNote(chosen: { no: number; take: Pick<Take, 'quality'> }[]): string {
  const drafts = chosen.filter((c) => c.take.quality === 'draft').map((c) => roman(c.no));
  if (!drafts.length || drafts.length === chosen.length) return '';
  const list = drafts.length === 1 ? `Shot ${drafts[0]} is a draft` : `Shots ${drafts.join(', ')} are drafts`;
  return `${list}, so ${drafts.length === 1 ? 'it' : 'they'}’ll look softer than the rest. Render ${drafts.length === 1 ? 'it' : 'them'} at Final to match. `;
}

/** What Export film joins: each shot's newest kept take that finished, or else its newest that finished. */
export function useChosenTakes(project: Project | null) {
  const shots = useStore((s) => s.shots);
  const takes = useStore((s) => s.takes);
  return useMemo(() => {
    if (!project) return [];
    return project.shotIds.flatMap((shotId, i) => {
      const shot = shots.get(shotId);
      const done = (shot?.takeIds ?? [])
        .map((id) => takes.get(id))
        .filter((t): t is Take => !!t && t.status === 'done' && !!t.video);
      const take = done.findLast((t) => t.kept) ?? done.at(-1);
      return take && shot ? [{ no: i + 1, shot, take }] : [];
    });
  }, [project, shots, takes]);
}

export function ExportDialog({
  project,
  compact,
  onClose,
}: {
  project: Project;
  compact: boolean;
  onClose: () => void;
}) {
  const id = useId();
  const chosen = useChosenTakes(project);
  const job = useStore((s) => s.exports.get(project.id));
  const [starting, setStarting] = useState(false);
  const total = chosen.reduce((n, c) => n + c.take.seconds, 0);
  const skipped = project.shotIds.length - chosen.length;
  // An export of other takes than these is out of date.
  const current =
    job && job.takeIds.length === chosen.length && job.takeIds.every((t, i) => t === chosen[i]?.take.id);
  const running = job?.status === 'running';
  const ready = job?.status === 'done' && current && job.url;

  const start = async () => {
    setStarting(true);
    try {
      await api.exportFilm(project.id);
    } catch (e) {
      toastError(e);
    } finally {
      setStarting(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      labelledBy={id}
      variant={compact ? 'bottom' : 'dialog'}
      className="st-dialog hg-exportdlg"
    >
      <div className="st-dialog__h">
        <div style={{ flex: 1 }}>
          <h2 id={id}>Export film</h2>
          <p>
            {chosen.length} {chosen.length === 1 ? 'shot' : 'shots'} ·{' '}
            {clock(ready && job.seconds != null ? job.seconds : total)}, joined in order into one MP4.
          </p>
        </div>
      </div>
      <div className="st-dialog__b">
        {ready ? (
          // biome-ignore lint/a11y/useMediaCaption: generated films have no dialogue track to caption.
          <video
            className="hg-export__video"
            src={job.url!}
            poster={chosen[0]?.take.poster ?? undefined}
            controls
            playsInline
            preload="metadata"
          />
        ) : (
          <ol className="hg-export__list">
            {chosen.map(({ no, shot, take }, i) => (
              <li key={shot.id} data-done={running && job && i < job.done ? '' : undefined}>
                <span className="hg-export__no" aria-hidden="true">
                  {roman(no)}
                </span>
                <span className="hg-export__thumb" aria-hidden="true">
                  {take.poster ? <img src={take.poster} alt="" loading="lazy" decoding="async" /> : null}
                </span>
                <span className="hg-export__t">
                  <b>
                    <span className="sr">Shot {no}: </span>
                    {shot.title}
                  </b>
                  <small className="body-sm muted">
                    {takeLabel(take)} · {clock(take.seconds)}
                  </small>
                </span>
                {running && job && i < job.done ? <Icon name="check" size={16} /> : null}
              </li>
            ))}
          </ol>
        )}
        {running && job ? (
          <div className="hg-export__progress" role="status">
            <div className="st-meter" aria-hidden="true">
              <i style={{ width: `${Math.max(4, (job.done / job.total) * 100)}%` }} />
            </div>
            <span className="body-sm sec-text">
              Joining take {Math.min(job.done + 1, job.total)} of {job.total}…
            </span>
          </div>
        ) : null}
        {job?.status === 'failed' && current ? (
          <p className="body-sm hg-err" role="alert">
            <Icon name="alert" size={16} /> {job.error}
          </p>
        ) : null}
        <p className="body-sm muted">
          {skipped > 0
            ? `${skipped} ${skipped === 1 ? 'shot has' : 'shots have'} no finished take yet and ${skipped === 1 ? 'is' : 'are'} left out. `
            : ''}
          {draftNote(chosen)}
          Each shot uses its kept take, or its newest. The file says it is AI-generated, as the model licenses
          ask.
        </p>
      </div>
      <div className="st-dialog__f">
        {ready ? (
          <>
            <span className="st-cost">
              {job.seconds != null ? clock(job.seconds) : ''} · {job.bytes != null ? bytes(job.bytes) : ''}
            </span>
            <Button kind="ghost" onClick={onClose}>
              Done
            </Button>
            <a className="hg-btn hg-btn--primary" href={`${job.url}?download`} download data-autofocus="">
              <Icon name="download" size={18} />
              Download
            </a>
          </>
        ) : (
          <>
            {running ? <Status kind="running">Exporting</Status> : null}
            <span style={{ flex: 1 }} />
            <Button kind="ghost" onClick={onClose}>
              {running ? 'Close' : 'Cancel'}
            </Button>
            <Button
              kind="primary"
              icon="film"
              busy={starting || running}
              disabled={!chosen.length}
              onClick={start}
              data-autofocus=""
            >
              {job?.status === 'failed' && current ? 'Try again' : 'Export'}
            </Button>
          </>
        )}
      </div>
    </Modal>
  );
}

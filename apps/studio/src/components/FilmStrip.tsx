// SPDX-License-Identifier: AGPL-3.0-only
import type { Project, Take } from '@hildegard/presets';
import { useEffect, useId, useRef, useState } from 'react';
import { clock, roman } from '../lib/format.ts';
import { useStore } from '../lib/store.ts';
import { useChosenTakes } from './ExportDialog.tsx';
import { Button, Icon, Modal } from './ui.tsx';

/**
 * The film as it stands: each shot's chosen take (its kept one, or else its newest), in order, as Export film joins
 * them. A shot with nothing finished yet holds its place. Play film runs them back to back.
 */
export function FilmStrip({
  project,
  selected,
  onSelect,
}: {
  project: Project;
  selected: string | null;
  onSelect: (takeId: string) => void;
}) {
  const shots = useStore((s) => s.shots);
  const chosen = useChosenTakes(project);
  const [playing, setPlaying] = useState(false);
  const total = chosen.reduce((n, c) => n + c.take.seconds, 0);
  if (!chosen.length) return null;
  const byShot = new Map(chosen.map((c) => [c.shot.id, c]));
  return (
    <section className="cs-film" aria-label="The film">
      <Button kind="primary" icon="play" onClick={() => setPlaying(true)} className="cs-film__play">
        Play film
      </Button>
      <span className="cs-film__m hg-num">
        {chosen.length} of {project.shotIds.length} {project.shotIds.length === 1 ? 'shot' : 'shots'} ·{' '}
        {clock(total)}
      </span>
      <ol className="cs-film__strip">
        {project.shotIds.map((id, i) => {
          const c = byShot.get(id);
          const title = shots.get(id)?.title ?? 'Untitled shot';
          return (
            <li key={id}>
              {c ? (
                <button
                  type="button"
                  className="cs-film__shot"
                  aria-pressed={c.take.id === selected}
                  aria-label={`Shot ${i + 1}: ${title}, ${c.take.kept ? 'kept take' : 'newest take'}`}
                  onClick={() => onSelect(c.take.id)}
                >
                  {c.take.poster ? <img src={c.take.poster} alt="" loading="lazy" decoding="async" /> : null}
                  <span className="cs-film__no" aria-hidden="true">
                    {roman(i + 1)}
                  </span>
                  {c.take.kept ? <Icon name="keep" size={14} className="cs-film__kept" /> : null}
                </button>
              ) : (
                <span className="cs-film__shot is-empty" title={`Shot ${i + 1}: nothing finished yet`}>
                  <span className="cs-film__no">{roman(i + 1)}</span>
                  <span className="sr">Shot {i + 1}: nothing finished yet</span>
                </span>
              )}
            </li>
          );
        })}
      </ol>
      {playing ? (
        <FilmPlayer
          reel={chosen.map((c) => ({ no: c.no, take: c.take }))}
          onClose={() => setPlaying(false)}
        />
      ) : null}
    </section>
  );
}

/** The chosen takes back to back, with a mark for each shot to jump to. */
function FilmPlayer({ reel, onClose }: { reel: { no: number; take: Take }[]; onClose: () => void }) {
  const id = useId();
  const [at, setAt] = useState(0);
  const video = useRef<HTMLVideoElement>(null);
  const now = reel[at]!;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new shot starts playing as soon as it loads
  useEffect(() => {
    void video.current?.play().catch(() => {});
  }, [at]);
  return (
    <Modal open onClose={onClose} labelledBy={id} variant="center" className="cs-player">
      <div className="cs-player__h">
        <h2 id={id}>
          Shot {roman(now.no)}{' '}
          <span className="muted">
            · {at + 1} of {reel.length}
          </span>
        </h2>
        <Button kind="ghost" icon="close" aria-label="Close the film" onClick={onClose} data-autofocus="" />
      </div>
      {/* biome-ignore lint/a11y/useMediaCaption: generated takes have no dialogue track to caption. */}
      <video
        ref={video}
        key={now.take.id}
        className="cs-player__v"
        src={now.take.video ?? undefined}
        poster={now.take.poster ?? undefined}
        controls
        playsInline
        onEnded={() => (at + 1 < reel.length ? setAt(at + 1) : undefined)}
      />
      <ol className="cs-player__marks" aria-label="Shots">
        {reel.map((r, i) => (
          <li key={r.take.id} style={{ flexGrow: r.take.seconds }}>
            <button
              type="button"
              aria-current={i === at ? 'true' : undefined}
              aria-label={`Play from shot ${roman(r.no)}`}
              className={i < at ? 'is-past' : undefined}
              onClick={() => setAt(i)}
            >
              <span aria-hidden="true">{roman(r.no)}</span>
            </button>
          </li>
        ))}
      </ol>
    </Modal>
  );
}

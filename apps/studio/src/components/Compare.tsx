// SPDX-License-Identifier: AGPL-3.0-only
import type { Take } from '@hildegard/presets';
import { useId, useRef, useState } from 'react';
import { api } from '../lib/api.ts';
import { roman } from '../lib/format.ts';
import { upsert } from '../lib/store.ts';
import { takeLabel } from './TakeCard.tsx';
import { Button, Icon, Modal, toastError } from './ui.tsx';

/** A shot's finished takes side by side, playing together from the start, to keep the one the film should use. */
export function Compare({
  shotNo,
  title,
  takes,
  onClose,
}: {
  shotNo: number;
  title: string;
  takes: Take[];
  onClose: () => void;
}) {
  const id = useId();
  const grid = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const all = () => [...(grid.current?.querySelectorAll('video') ?? [])];
  const playAll = () => {
    for (const v of all()) {
      v.currentTime = 0;
      void v.play().catch(() => {});
    }
  };
  const keep = async (t: Take) => {
    setBusy(t.id);
    try {
      upsert({ type: 'take', take: await api.keep(t.id, !t.kept) });
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  };
  return (
    <Modal open onClose={onClose} labelledBy={id} variant="center" className="cs-compare">
      <div className="cs-compare__h">
        <div>
          <h2 id={id}>Compare the takes of shot {roman(shotNo)}</h2>
          <p className="body-sm sec-text">{title}</p>
        </div>
        <Button icon="play" onClick={playAll} data-autofocus="">
          Play together
        </Button>
        <Button kind="ghost" icon="close" aria-label="Close" onClick={onClose} />
      </div>
      <div className="cs-compare__grid" ref={grid} data-n={Math.min(takes.length, 4)}>
        {takes.map((t) => (
          <figure key={t.id} className="cs-compare__take">
            <video
              src={t.video ?? undefined}
              poster={t.poster ?? undefined}
              muted
              playsInline
              loop
              controls
              aria-label={takeLabel(t)}
            />
            <figcaption>
              <span>
                <b>{takeLabel(t)}</b>
                <span className="body-sm muted hg-num">seed {t.seed}</span>
              </span>
              <Button
                size="sm"
                kind={t.kept ? 'primary' : undefined}
                aria-pressed={t.kept}
                busy={busy === t.id}
                onClick={() => keep(t)}
              >
                <Icon name="keep" size={16} />
                {t.kept ? 'Kept' : 'Keep'}
              </Button>
            </figcaption>
          </figure>
        ))}
      </div>
      <p className="body-sm muted cs-compare__f">
        The film uses each shot’s newest kept take, or its newest when none is kept.
      </p>
    </Modal>
  );
}
